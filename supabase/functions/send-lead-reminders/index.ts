import { createClient } from "npm:@supabase/supabase-js@2";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c] ?? c));

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("LEADPILOT_FROM_EMAIL");
  if (!supabaseUrl || !serviceKey || !resendKey || !fromEmail) {
    console.error("Missing server configuration: Supabase, RESEND_API_KEY or LEADPILOT_FROM_EMAIL");
    return new Response(JSON.stringify({ error: "Email service is not configured" }), { status: 503, headers });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: configRows, error: configError } = await admin.rpc("get_leadpilot_push_config");
  const config = Array.isArray(configRows) ? configRows[0] : null;
  if (configError || !config?.cron_secret) {
    console.error("Cron configuration unavailable", configError?.message);
    return new Response(JSON.stringify({ error: "Scheduler is not configured" }), { status: 503, headers });
  }
  const suppliedSecret = req.headers.get("x-cron-secret") ?? "";
  if (suppliedSecret.length !== config.cron_secret.length || suppliedSecret !== config.cron_secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  const now = new Date().toISOString();
  const { data: leads, error: leadsError } = await admin.from("leads")
    .select("id,agency_id,full_name,follow_up_at,status,assigned_to,created_by")
    .lte("follow_up_at", now)
    .not("status", "in", '("Gagné","Perdue")')
    .limit(500);
  if (leadsError) {
    console.error("Unable to load due leads", leadsError.message);
    return new Response(JSON.stringify({ error: "Unable to load reminders" }), { status: 500, headers });
  }

  const dueLeads = leads ?? [];
  const recipientIds = [...new Set(dueLeads.map((lead: any) => lead.assigned_to || lead.created_by).filter(Boolean))];
  if (!recipientIds.length) return new Response(JSON.stringify({ ok: true, due: dueLeads.length, sent: 0, skipped: dueLeads.length }), { status: 200, headers });

  const agencyIds = [...new Set(dueLeads.map((lead: any) => lead.agency_id).filter(Boolean))];
  const [{ data: memberships, error: membershipError }, { data: preferences, error: preferencesError }] = await Promise.all([
    admin.from("agency_members").select("agency_id,user_id").in("agency_id", agencyIds).in("user_id", recipientIds),
    admin.from("user_notification_settings").select("user_id,notification_email,preferred_channel,contact_consent").in("user_id", recipientIds),
  ]);
  if (membershipError || preferencesError) {
    console.error("Unable to load email recipients", membershipError?.message, preferencesError?.message);
    return new Response(JSON.stringify({ error: "Unable to validate recipients" }), { status: 500, headers });
  }
  const validRecipients = new Set((memberships ?? []).map((m: any) => m.agency_id + ":" + m.user_id));
  const preferenceByUser = new Map((preferences ?? []).map((p: any) => [p.user_id, p]));
  const emails = new Map<string, string>();
  for (const id of recipientIds) {
    const pref: any = preferenceByUser.get(id);
    if (pref?.preferred_channel !== "email" || pref?.contact_consent !== true) continue;
    if (pref.notification_email) { emails.set(id, pref.notification_email); continue; }
    const { data } = await admin.auth.admin.getUserById(id);
    if (data?.user?.email) emails.set(id, data.user.email);
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const lead of dueLeads) {
    const recipientId = lead.assigned_to || lead.created_by;
    if (!validRecipients.has(lead.agency_id + ":" + recipientId)) { skipped++; continue; }
    const recipientEmail = emails.get(recipientId);
    if (!recipientEmail) { skipped++; continue; }

    const { data: alreadySent, error: logReadError } = await admin.from("notification_log")
      .select("id").eq("lead_id", lead.id).eq("recipient_id", recipientId)
      .eq("notification_type", "follow_up_email").eq("scheduled_for", lead.follow_up_at).limit(1);
    if (logReadError) { console.error("Email log lookup failed", logReadError.message); failed++; continue; }
    if (alreadySent?.length) { skipped++; continue; }

    const name = lead.full_name || "un prospect";
    const leadUrl = "https://enzolopez1509-dev.github.io/leadpilot/?lead=" + encodeURIComponent(lead.id);
    const subject = "VisiBien · Relance à effectuer : " + name;
    const html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#203442"><h2>Relance à effectuer</h2><p>Bonjour,</p><p>Une relance est arrivée à échéance pour <strong>' + escapeHtml(name) + '</strong>.</p><p>Statut : ' + escapeHtml(lead.status || "Nouveau") + '</p><p><a href="' + leadUrl + '" style="display:inline-block;background:#203f50;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Ouvrir la fiche dans VisiBien</a></p><p style="font-size:12px;color:#77838b">Vous recevez cet e-mail car les rappels par e-mail sont activés dans VisiBien.</p></div>';
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromEmail, to: [recipientEmail], subject, html }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("Resend delivery failed", response.status, result);
        failed++;
        continue;
      }
      const { error: logError } = await admin.from("notification_log").insert({
        lead_id: lead.id, recipient_id: recipientId,
        notification_type: "follow_up_email", scheduled_for: lead.follow_up_at,
      });
      if (logError) { console.error("Email sent but log insert failed", logError.message); failed++; }
      else sent++;
    } catch (error) {
      console.error("Email request failed", String(error));
      failed++;
    }
  }

  return new Response(JSON.stringify({ ok: true, due: dueLeads.length, sent, skipped, failed }), { status: 200, headers });
});
