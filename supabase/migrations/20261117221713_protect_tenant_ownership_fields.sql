-- Prevent agency and creator ownership from being reassigned after a record is created.
-- This complements the row-level security policies for multi-agency isolation.

create or replace function private.prevent_tenant_ownership_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.agency_id is distinct from old.agency_id
     or new.created_by is distinct from old.created_by then
    raise exception 'Agency and creator ownership cannot be changed after creation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists leads_prevent_tenant_ownership_change on public.leads;
create trigger leads_prevent_tenant_ownership_change
before update of agency_id, created_by on public.leads
for each row execute function private.prevent_tenant_ownership_change();

drop trigger if exists properties_prevent_tenant_ownership_change on public.properties;
create trigger properties_prevent_tenant_ownership_change
before update of agency_id, created_by on public.properties
for each row execute function private.prevent_tenant_ownership_change();
