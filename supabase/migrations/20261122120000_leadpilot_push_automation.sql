-- LeadPilot v31: agency dashboard data + scheduled push delivery
-- Secret values are deliberately not stored in Git. Configure private.leadpilot_push_config
-- and create the Vault secret leadpilot_auto_push_cron_secret separately per environment.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.leadpilot_push_config (
  singleton boolean primary key default true check (singleton),
  vapid_public text not null,
  vapid_private text not null,
  cron_secret text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.leadpilot_push_config from public, anon, authenticated, service_role;

create or replace function public.get_leadpilot_push_config()
returns table(vapid_public text, vapid_private text, cron_secret text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'not authorized';
  end if;
  return query
    select c.vapid_public, c.vapid_private, c.cron_secret
    from private.leadpilot_push_config c
    where c.singleton = true;
end;
$$;
revoke all on function public.get_leadpilot_push_config() from public, anon, authenticated;
grant execute on function public.get_leadpilot_push_config() to service_role;

create unique index if not exists notification_log_dedupe_idx
on public.notification_log(lead_id, recipient_id, notification_type, scheduled_for);

-- Run once after storing the cron secret in Supabase Vault:
-- select cron.schedule('leadpilot-auto-reminders','*/15 * * * *',
--   $job$ select net.http_post(
--     url := 'https://YOUR_PROJECT.supabase.co/functions/v1/send-lead-reminders',
--     headers := jsonb_build_object(
--       'Content-Type','application/json',
--       'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets
--                        where name='leadpilot_auto_push_cron_secret')
--     ),
--     body := jsonb_build_object('triggered_at',now())
--   ); $job$
-- );

-- Member labels are served by the JWT-protected agency-director-members Edge Function.
-- It verifies the caller's owner/admin membership before reading Auth email addresses.
