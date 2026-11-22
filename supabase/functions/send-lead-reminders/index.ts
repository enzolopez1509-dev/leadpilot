import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Server configuration incomplete" }), { status: 500, headers: corsHeaders });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: configRows, error: configError } = await admin.rpc("get_leadpilot_push_config");
  const config = Array.isArray(configRows) ? configRows[0] : null;
  if (configError || !config?.cron_secret || !config?.vapid_public || !config?.vapid_private) {
    console.error("Push config unavailable", configError?.message);
    return new Response(JSON.stringify({ error: "Push service is not configured" }), { status: 503, headers: corsHeaders });
  }

  const suppliedSecret = req.headers.get("x-cron-secret") ?? "";
  if (suppliedSecret.length !== config.cron_secret.length || suppliedSecret !== config.cron_secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  webpush.setVapidDetails(
    "https://enzolopez1509-dev.github.io/leadpilot/",
    config.vapid_public,
    config.vapid_private,
  );

  const now = new Date().toISOString();
  const { data: dueLeads, error: leadsError } = await admin
    .from("leads")
    .select("id,agency_id,full_name,follow_up_at,status,assigned_to,created_by")
    .lte("follow_up_at", now)
    .not("status", "in", '("Gagné","Perdue")')
    .limit(500);

  if (leadsError) {
    console.error("Unable to load due leads", leadsError.message);
    return new Response(JSON.stringify({ error: "Unable to load reminders" }), { status: 500, headers: corsHeaders });
  }

  const leads = dueLeads ?? [];
  const recipientIds = [...new Set(leads.map((lead: any) => lead.assigned_to || lead.created_by).filter(Boolean))];
  if (!recipientIds.length) {
    return new Response(JSON.stringify({ ok: true, due: leads.length, sent: 0, skipped: leads.length }), { status: 200, headers: corsHeaders });
  }

  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("push_subscriptions")
    .select("id,user_id,endpoint,p256dh,auth")
    .in("user_id", recipientIds);

  if (subscriptionsError) {
    console.error("Unable to load push subscriptions", subscriptionsError.message);
    return new Response(JSON.stringify({ error: "Unable to load subscriptions" }), { status: 500, headers: corsHeaders });
  }

  const agencyIds = [...new Set(leads.map((lead: any) => lead.agency_id).filter(Boolean))];
  const { data: memberships, error: membershipsError } = await admin
    .from("agency_members")
    .select("agency_id,user_id")
    .in("agency_id", agencyIds)
    .in("user_id", recipientIds);
  if (membershipsError) {
    console.error("Unable to validate reminder recipients", membershipsError.message);
    return new Response(JSON.stringify({ error: "Unable to validate recipients" }), { status: 500, headers: corsHeaders });
  }
  const validRecipients = new Set((memberships ?? []).map((row: any) => row.agency_id + ":" + row.user_id));

  const byUser = new Map<string, any[]>();
  for (const sub of subscriptions ?? []) {
    const bucket = byUser.get(sub.user_id) ?? [];
    bucket.push(sub);
    byUser.set(sub.user_id, bucket);
  }

  let sent = 0;
  let skipped = 0;
  let expired = 0;

  for (const lead of leads) {
    const recipientId = lead.assigned_to || lead.created_by;
    if (!validRecipients.has(lead.agency_id + ":" + recipientId)) {
      skipped++;
      continue;
    }
    const targets = byUser.get(recipientId) ?? [];
    if (!targets.length) {
      skipped++;
      continue;
    }

    const { data: alreadySent, error: logReadError } = await admin
      .from("notification_log")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("recipient_id", recipientId)
      .eq("notification_type", "follow_up")
      .eq("scheduled_for", lead.follow_up_at)
      .limit(1);

    if (logReadError) {
      console.error("Notification log lookup failed", logReadError.message);
      skipped++;
      continue;
    }
    if (alreadySent?.length) {
      skipped++;
      continue;
    }

    const payload = JSON.stringify({
      title: "LeadPilot · Relance à traiter",
      body: "Relance prévue pour " + (lead.full_name || "un prospect") + ". Ouvrez LeadPilot pour consulter sa fiche.",
      url: "./?lead=" + encodeURIComponent(lead.id),
      leadId: lead.id,
    });

    let delivered = false;
    for (const sub of targets) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        }, payload, { TTL: 3600 });
        delivered = true;
      } catch (error) {
        const statusCode = (error as any)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
          expired++;
        } else {
          console.error("Push delivery failed", statusCode ?? "unknown", String(error));
        }
      }
    }

    if (delivered) {
      const { error: logError } = await admin.from("notification_log").insert({
        lead_id: lead.id,
        recipient_id: recipientId,
        notification_type: "follow_up",
        scheduled_for: lead.follow_up_at,
      });
      if (!logError) sent++;
      else console.error("Notification log insert failed", logError.message);
    } else {
      skipped++;
    }
  }

  return new Response(JSON.stringify({ ok: true, due: leads.length, sent, skipped, expired }), {
    status: 200,
    headers: corsHeaders,
  });
});
