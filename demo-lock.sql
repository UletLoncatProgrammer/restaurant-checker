-- ============================================================
-- v7 (part B, lockdown): the browser (anon key) can no longer read or write room data directly.
-- Apply ONLY after the v7 page (which uses the functions from part A) is live, or the v6 page stops working.
-- Everything now goes through the SECURITY DEFINER functions, which check the staff token.
-- ============================================================
alter table demo_sessions enable row level security;
alter table demo_orders enable row level security;
alter table demo_order_items enable row level security;
alter table demo_payments enable row level security;

drop policy if exists "demo_sessions_public" on demo_sessions;
drop policy if exists "demo_orders_public" on demo_orders;
drop policy if exists "demo_order_items_public" on demo_order_items;
drop policy if exists "demo_payments_public" on demo_payments;
drop policy if exists "demo_payments_read" on demo_payments;

revoke all on demo_sessions from anon, authenticated;
revoke all on demo_orders from anon, authenticated;
revoke all on demo_order_items from anon, authenticated;
revoke all on demo_payments from anon, authenticated;

-- no more realtime row broadcasts for these tables (devices poll demo_room_rev instead)
do $$ begin alter publication supabase_realtime drop table demo_sessions; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime drop table demo_orders; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime drop table demo_order_items; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime drop table demo_payments; exception when others then null; end $$;

-- ============================================================
-- ROLLBACK (only if something breaks and you need the old open behaviour back):
-- create policy "demo_sessions_public" on demo_sessions for all using (true) with check (true);
-- create policy "demo_orders_public" on demo_orders for all using (true) with check (true);
-- create policy "demo_order_items_public" on demo_order_items for all using (true) with check (true);
-- create policy "demo_payments_read" on demo_payments for select using (true);
-- grant select, insert, update, delete on demo_sessions, demo_orders, demo_order_items to anon, authenticated;
-- grant select on demo_payments to anon, authenticated;
-- ============================================================
