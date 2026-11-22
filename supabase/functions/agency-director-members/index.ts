import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!supabaseUrl || !serviceKey || !token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders }); }
  const agencyId = String(body?.agency_id ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agencyId)) {
    return new Response(JSON.stringify({ error: "Invalid agency id" }), { status: 400, headers: corsHeaders });
  }

  const { data: membership, error: membershipError } = await admin
    .from("agency_members")
    .select("role")
    .eq("agency_id", agencyId)
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (membershipError || !membership || !["owner", "admin"].includes(membership.role)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: corsHeaders });
  }

  const { data: members, error: membersError } = await admin
    .from("agency_members")
    .select("user_id,role")
    .eq("agency_id", agencyId)
    .order("created_at");
  if (membersError) return new Response(JSON.stringify({ error: "Unable to load members" }), { status: 500, headers: corsHeaders });

  const labels = await Promise.all((members ?? []).map(async (member: any) => {
    const { data } = await admin.auth.admin.getUserById(member.user_id);
    return { user_id: member.user_id, email: data?.user?.email ?? "Membre de l’agence", role: member.role };
  }));

  return new Response(JSON.stringify({ members: labels }), { status: 200, headers: corsHeaders });
});
