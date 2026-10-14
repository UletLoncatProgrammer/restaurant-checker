-- ============================================================
-- v9 (additive; run once in the Supabase SQL Editor):
--   * the owner can delete ANY role except OWNER, including the built-in ones
--     (a role that staff still hold is still refused: move them first)
--   * "Restore default roles" puts back any built-in role that was deleted (existing roles are left untouched)
-- ============================================================
create or replace function demo_role_delete(p_token text, p_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s demo_staff; k text := upper(trim(coalesce(p_key, ''))); r demo_roles; n int;
begin
  s := demo_require_owner(p_token);
  if k = 'OWNER' then raise exception 'The owner role cannot be deleted'; end if;
  select * into r from demo_roles where key = k;
  if r.key is null then raise exception 'Role not found'; end if;
  select count(*) into n from demo_staff where role = k;
  if n > 0 then raise exception '% staff still use this role - move them to another role first', n; end if;
  delete from demo_roles where key = k;
  return jsonb_build_object('ok', true);
end $$;

create or replace function demo_roles_restore_defaults(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s demo_staff; n int;
begin
  s := demo_require_owner(p_token);
  insert into demo_roles (key, label, views, can_void, can_pay, can_export, builtin) values
    ('WAITER',      'Waiter',             '{order,pos}',                false, true,  false, true),
    ('KITCHEN',     'Kitchen',            '{kitchen}',                  false, false, false, true),
    ('COLD_KITCHEN','Cold Kitchen',       '{cold}',                     false, false, false, true),
    ('BAR',         'Bar',                '{bar}',                      false, false, false, true),
    ('COORDINATOR', 'Coordinator',        '{dashboard}',                false, false, true,  true),
    ('SUPERVISOR',  'Supervisor',         '{dashboard,history}',        true,  false, false, true),
    ('KITCHEN_SUP', 'Kitchen Supervisor', '{kitchen,cold,bar,history}', true,  false, false, true),
    ('FLOOR_SUP',   'Floor Supervisor',   '{order,pos,history}',        true,  true,  false, true)
  on conflict (key) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'restored', n);
end $$;
