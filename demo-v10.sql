-- ============================================================
-- Demo v10 (run once in the Supabase SQL Editor, BEFORE uploading the new index.html):
--   * billing settings: restaurant tax (PBJT, shown as "PB1"), service charge, tax on service yes/no
--   * member list: found by phone at the POS; member discount comes off the food first
--   * bill = food - member discount + service charge + tax (each rounded to whole rupiah),
--     calculated by the database at payment time; the payment keeps the rates used
-- Safe to run twice.
-- ============================================================

-- ---- settings (one row for the whole demo) ----
create table if not exists demo_billing (
  id int primary key default 1 check (id = 1),
  tax_label text not null default 'PB1' check (length(tax_label) between 1 and 20),
  tax_rate numeric(5,4) not null default 0.10 check (tax_rate >= 0 and tax_rate <= 0.25),
  service_rate numeric(5,4) not null default 0.05 check (service_rate >= 0 and service_rate <= 0.25),
  tax_on_service boolean not null default true
);
insert into demo_billing (id) values (1) on conflict (id) do nothing;
alter table demo_billing enable row level security;
revoke all on demo_billing from anon, authenticated;

-- ---- members ----
create table if not exists demo_members (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 60),
  phone text not null check (length(phone) <= 30),
  phone_key text not null unique check (phone_key ~ '^[0-9]{6,15}$'),
  discount_rate numeric(5,4) not null check (discount_rate > 0 and discount_rate <= 1),
  note text check (coalesce(length(note), 0) <= 200),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table demo_members enable row level security;
revoke all on demo_members from anon, authenticated;

-- ---- payments keep the numbers and rates used ----
alter table demo_payments add column if not exists discount numeric(12,2) not null default 0;
alter table demo_payments add column if not exists service numeric(12,2) not null default 0;
alter table demo_payments add column if not exists member_id uuid references demo_members(id) on delete set null;
alter table demo_payments add column if not exists member_name text;
alter table demo_payments add column if not exists discount_rate numeric(5,4);
alter table demo_payments add column if not exists service_rate numeric(5,4);
alter table demo_payments add column if not exists tax_rate numeric(5,4);
alter table demo_payments add column if not exists tax_label text;
alter table demo_payments drop constraint if exists demo_payments_total_matches;
alter table demo_payments add constraint demo_payments_total_matches check (total = subtotal - discount + service + tax);

-- "+62 812-3456" / "0812 3456" / "812 3456" -> "08123456"
create or replace function demo_phone_key(p text) returns text language sql immutable as $$
  select case
    when d like '62%' then '0' || substr(d, 3)
    when d like '8%' then '0' || d
    else d end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;

-- ---- billing settings: anyone signed in can read (the POS shows them); the owner changes them ----
create or replace function demo_billing_get(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s demo_staff; b demo_billing;
begin
  s := demo_require_staff(p_token);
  select * into b from demo_billing where id = 1;
  return jsonb_build_object('tax_label', b.tax_label, 'tax_percent', round(b.tax_rate * 100, 2),
                            'service_percent', round(b.service_rate * 100, 2), 'tax_on_service', b.tax_on_service);
end $$;

create or replace function demo_billing_set(p_token text, p_tax_label text, p_tax_percent numeric, p_service_percent numeric, p_tax_on_service boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s demo_staff; lb text := trim(coalesce(p_tax_label, ''));
begin
  s := demo_require_owner(p_token);
  if length(lb) < 1 or length(lb) > 20 then raise exception 'Tax name must be 1 to 20 characters'; end if;
  if p_tax_percent is null or p_tax_percent < 0 or p_tax_percent > 25 then raise exception 'Tax must be a percentage from 0 to 25'; end if;
  if p_service_percent is null or p_service_percent < 0 or p_service_percent > 25 then raise exception 'Service charge must be a percentage from 0 to 25'; end if;
  update demo_billing set tax_label = lb, tax_rate = round(p_tax_percent, 2) / 100, service_rate = round(p_service_percent, 2) / 100,
         tax_on_service = coalesce(p_tax_on_service, true) where id = 1;
  return demo_billing_get(p_token);
end $$;

-- ---- members: the owner keeps the list; a cashier (can_pay) looks a member up by phone ----
create or replace function demo_members_list(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s demo_staff;
begin
  s := demo_require_owner(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'discount_percent', round(discount_rate * 100, 2),
                                                        'note', coalesce(note, ''), 'active', active) order by active desc, lower(name))
                     from demo_members), '[]'::jsonb);
end $$;

-- p_id null = new member. Members are switched off, never deleted (old receipts point at them).
create or replace function demo_member_save(p_token text, p_id uuid, p_name text, p_phone text, p_discount_percent numeric, p_note text, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s demo_staff; nm text := trim(coalesce(p_name, '')); ph text := trim(coalesce(p_phone, '')); k text := demo_phone_key(p_phone); m demo_members;
begin
  s := demo_require_owner(p_token);
  if length(nm) < 2 or length(nm) > 60 then raise exception 'Name must be 2 to 60 characters'; end if;
  if length(ph) > 30 or k !~ '^[0-9]{6,15}$' then raise exception 'Phone number: 6 to 15 digits'; end if;
  if p_discount_percent is null or p_discount_percent <= 0 or p_discount_percent > 100 then raise exception 'Discount must be a percentage above 0 and at most 100'; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'Note must be 200 characters or fewer'; end if;
  begin
    if p_id is null then
      insert into demo_members (name, phone, phone_key, discount_rate, note)
      values (nm, ph, k, round(p_discount_percent, 2) / 100, nullif(trim(coalesce(p_note, '')), '')) returning * into m;
    else
      update demo_members set name = nm, phone = ph, phone_key = k, discount_rate = round(p_discount_percent, 2) / 100,
             note = nullif(trim(coalesce(p_note, '')), ''), active = coalesce(p_active, active)
       where id = p_id returning * into m;
      if m.id is null then raise exception 'Member not found'; end if;
    end if;
  exception when unique_violation then raise exception 'A member with that phone number already exists';
  end;
  return jsonb_build_object('id', m.id, 'name', m.name);
end $$;

create or replace function demo_member_lookup(p_token text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s demo_staff; m demo_members; k text := demo_phone_key(p_phone);
begin
  s := demo_require_staff(p_token);
  if not coalesce((select can_pay from demo_roles where key = s.role), false) then raise exception 'Not allowed: your role cannot take payment'; end if;
  if k !~ '^[0-9]{6,15}$' then raise exception 'Type the member''s phone number (6 to 15 digits)'; end if;
  select * into m from demo_members where phone_key = k and active;
  if m.id is null then raise exception 'No active member with that phone number'; end if;
  return jsonb_build_object('id', m.id, 'name', m.name, 'discount_percent', round(m.discount_rate * 100, 2));
end $$;

-- ---- paying: the database works out the whole bill ----
create or replace function demo_pay_order(p_order_id uuid, p_method text, p_tendered numeric, p_token text, p_member uuid)
returns demo_payments language plpgsql security definer set search_path = public, extensions as $$
declare
  s demo_staff; o demo_orders; b demo_billing; m demo_members; live int; undelivered int;
  sub numeric; disc numeric; after_disc numeric; svc numeric; tx numeric; tot numeric; dr numeric := 0; pay demo_payments;
begin
  s := demo_require_staff(p_token);
  if not coalesce((select can_pay from demo_roles where key = s.role), false) then raise exception 'Not allowed: your role cannot take payment'; end if;
  perform set_config('demo.allow', '1', true);
  select * into o from demo_orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'CLOSED' then raise exception 'This order has already been paid'; end if;
  if o.status <> 'OPEN' then raise exception 'Order is %', o.status; end if;
  if p_method not in ('CASH','CARD','QRIS','OTHER') then raise exception 'Invalid payment method'; end if;
  if p_member is not null then
    select * into m from demo_members where id = p_member and active;
    if m.id is null then raise exception 'Member not found (or switched off)'; end if;
    dr := m.discount_rate;
  end if;
  select * into b from demo_billing where id = 1;

  select count(*) filter (where status <> 'CANCELLED'),
         count(*) filter (where status not in ('DELIVERED','CANCELLED')),
         coalesce(sum(qty * unit_price) filter (where status <> 'CANCELLED'), 0)
    into live, undelivered, sub
    from demo_order_items where order_id = p_order_id;
  if live = 0 then raise exception 'Nothing to charge - every item was voided'; end if;
  if undelivered > 0 then raise exception 'Not all items are delivered yet'; end if;

  disc := round(sub * dr, 0);
  after_disc := sub - disc;
  svc := round(after_disc * b.service_rate, 0);
  tx := round((after_disc + case when b.tax_on_service then svc else 0 end) * b.tax_rate, 0);
  tot := after_disc + svc + tx;
  if p_method = 'CASH' and (p_tendered is null or p_tendered < tot) then
    raise exception 'Cash received is less than the total';
  end if;

  insert into demo_payments (session_id, order_id, table_name, customer_name, subtotal, discount, service, tax, total, method,
                             amount_tendered, change_given, paid_by, member_id, member_name, discount_rate, service_rate, tax_rate, tax_label)
  values (o.session_id, o.id, o.table_name, o.customer_name, sub, disc, svc, tx, tot, p_method,
          case when p_method = 'CASH' then p_tendered end,
          case when p_method = 'CASH' then p_tendered - tot end, s.name,
          m.id, m.name, dr, b.service_rate, b.tax_rate, b.tax_label)
  returning * into pay;
  update demo_orders set status = 'CLOSED', closed_at = now() where id = p_order_id;
  return pay;
end $$;

-- the older 4-argument version (used by the previous page) now follows the same rules, without a member
create or replace function demo_pay_order(p_order_id uuid, p_method text, p_tendered numeric, p_token text)
returns demo_payments language sql security definer set search_path = public, extensions as $$
  select demo_pay_order(p_order_id, p_method, p_tendered, p_token, null::uuid);
$$;
