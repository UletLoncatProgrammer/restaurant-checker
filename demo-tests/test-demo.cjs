// Runs the demo page (index.html) in three simulated browsers (waiter, kitchen, dashboard)
// against an in-memory fake of Supabase, to check the UI logic end to end:
// sounds, POS, voids, transactions, Excel contents.
// The fake's rpc() mirrors the SQL functions (which are tested separately, against the real database).
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require(path.join(process.env.JSDOM_DIR, "jsdom"));
const vc = new VirtualConsole(); vc.on("jsdomError", (e) => console.error("[jsdomError]", e.message)); vc.on("error", (...a) => console.error("[page error]", ...a));

const FILE = process.argv[2];
const html = fs.readFileSync(FILE, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake Supabase (shared by all windows) ----------
let idc = 0;
const uid = () => "id-" + ++idc;
const db = { demo_sessions: [], demo_orders: [], demo_order_items: [], demo_payments: [] };
const staff = [{ id: "s-owner", name: "Owner", role: "OWNER", pass: "ownerpass12345", must: false, active: true, reset: false, failed: 0 }];
const roles = {
  OWNER: { label: "Owner", views: ["order", "kitchen", "cold", "bar", "pos", "history", "dashboard", "owner"], void: true, pay: true, export: true, builtin: true },
  WAITER: { label: "Waiter", views: ["order", "pos"], void: false, pay: true, export: false, builtin: true },
  KITCHEN: { label: "Kitchen", views: ["kitchen"], void: false, pay: false, export: false, builtin: true },
  COLD_KITCHEN: { label: "Cold Kitchen", views: ["cold"], void: false, pay: false, export: false, builtin: true },
  BAR: { label: "Bar", views: ["bar"], void: false, pay: false, export: false, builtin: true },
  COORDINATOR: { label: "Coordinator", views: ["dashboard", "history"], void: false, pay: false, export: true, builtin: true },
  SUPERVISOR: { label: "Supervisor", views: ["dashboard", "history"], void: true, pay: false, export: false, builtin: true },
  KITCHEN_SUP: { label: "Kitchen Supervisor", views: ["kitchen", "cold", "bar", "history"], void: true, pay: false, export: false, builtin: true },
  FLOOR_SUP: { label: "Floor Supervisor", views: ["order", "pos", "history"], void: true, pay: true, export: false, builtin: true },
};
const DEFAULT_ROLES = JSON.parse(JSON.stringify(roles)); delete DEFAULT_ROLES.OWNER;
const permsOf = (r) => { const x = roles[r]; return { label: x.label, views: x.views.slice(), void: x.void, pay: x.pay, export: x.export }; };
const u7 = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
let menuSeq = 100;
const menuDb = { categories: [
  { id: u7(1), name: "Mains", station: "KITCHEN", note: "Special request, e.g. chicken breast, no onion", items: [{ id: u7(11), name: "Sample Fried Rice", price: 47000, spicy: true, track: false }, { id: u7(12), name: "Sample Chicken Noodle", price: 35000, spicy: true, track: false }, { id: u7(13), name: "Sample Grilled Skewers", price: 40000, spicy: true, track: false }] },
  { id: u7(2), name: "Drinks", station: "BAR", note: "Sugar & ice level, e.g. less sugar, less ice", items: [{ id: u7(21), name: "Sample Iced Tea", price: 10000, spicy: false, track: true }, { id: u7(22), name: "Sample Iced Coffee", price: 18000, spicy: false, track: true }, { id: u7(23), name: "Sample Lemon Tea", price: 12000, spicy: false, track: true }] },
] };
const tokens = {}; let tokSeq = 0;
const sByTok = (t) => { const s = staff.find((x) => x.id === tokens[t]); return s && s.active ? s : null; };
const tokenOf = (name) => Object.keys(tokens).find((t) => (staff.find((x) => x.id === tokens[t]) || {}).name === name);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,29}$/;
let otpRequests = [];
const rpcLog = [];
const clients = [];
let receiptSeq = 0;
let clock = Date.now();
const now = () => new Date((clock += 1000)).toISOString();
let globalRev = 0;
const directTableCalls = [];
const changed = () => globalRev++, changedOld = () => clients.forEach((c) => c.channels.forEach((ch) => ch.handlers.forEach((h) => setTimeout(h, 0))));

function makeClient() {
  const client = { channels: [], verified: false };
  clients.push(client);
  function builder(table) {
    const st = { table, filters: [], op: "select", payload: null, single: false, maybe: false, order: null, chain: false };
    const b = {
      select() { st.chain = st.op !== "select"; return b; },
      insert(p) { st.op = "insert"; st.payload = p; return b; },
      update(p) { st.op = "update"; st.payload = p; return b; },
      delete() { st.op = "delete"; return b; },
      eq(c, v) { st.filters.push([c, v]); return b; },
      order(c, o) { st.order = [c, o]; return b; },
      single() { st.single = true; return b; },
      maybeSingle() { st.maybe = true; return b; },
      then(res, rej) { return Promise.resolve().then(() => run(st)).then(res, rej); },
    };
    return b;
  }
  function run(st) {
    directTableCalls.push(st.table + ":" + st.op);
    return { data: null, error: { message: "permission denied for table " + st.table } };
  }
  function runUnused(st) {
    const rows = db[st.table];
    const match = (r) => st.filters.every(([c, v]) => r[c] === v);
    if (st.op === "insert") {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => {
        const r = Object.assign({ id: uid(), created_at: now() }, p);
        if (st.table === "demo_orders") r.status = r.status || "OPEN";
        if (st.table === "demo_sessions") { r.kitchen_mode = r.kitchen_mode || "ONE"; r.table_count = r.table_count || 40; }
        if (st.table === "demo_order_items") { r.unit_price = r.unit_price || 0; r.tax_rate = r.tax_rate == null ? 0.1 : r.tax_rate; r.status = r.status || "PENDING"; }
        rows.push(r);
        return r;
      });
      changed();
      return { data: st.single ? list[0] : st.chain ? list : null, error: null };
    }
    if (st.op === "update") { rows.filter(match).forEach((r) => Object.assign(r, st.payload, st.table === "demo_order_items" ? { updated_at: now() } : {})); changed(); return { data: null, error: null }; }
    if (st.op === "delete") { db[st.table] = rows.filter((r) => !match(r)); changed(); return { data: null, error: null }; }
    let out = rows.filter(match).map((r) => Object.assign({}, r));
    if (st.table === "demo_orders") out = out.map((o) => Object.assign(o, { demo_order_items: db.demo_order_items.filter((i) => i.order_id === o.id).map((i) => Object.assign({}, i)) }));
    if (st.order) { const [c, o] = st.order; out.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (o && o.ascending === false ? -1 : 1)); }
    if (st.single || st.maybe) return { data: out[0] || null, error: null };
    return { data: out, error: null };
  }
  const E = (m) => ({ data: null, error: { message: m } });
  function rpc(name, a) {
    a = a || {};
    return Promise.resolve().then(() => {
      rpcLog.push(name + ":" + (a.p_role || ""));
      const ownerOnly = () => { const me = sByTok(a.p_token); if (!me) return [E("Please sign in again")]; if (me.role !== "OWNER" || me.must) return [E("Owner sign-in required")]; return [null, me]; };
      if (name === "demo_login") {
        const u = staff.find((x) => x.name.toLowerCase() === String(a.p_name || "").trim().toLowerCase());
        if (!u || !u.active) return { data: { ok: false, error: "Wrong name or password" }, error: null };
        if (u.lockedUntil && u.lockedUntil > Date.now()) return { data: { ok: false, error: "Too many wrong attempts. Try again in a few minutes." }, error: null };
        if (u.pass !== a.p_pass) { u.failed++; if (u.failed >= 5) { u.failed = 0; u.lockedUntil = Date.now() + 300000; } return { data: { ok: false, error: "Wrong name or password" }, error: null }; }
        u.failed = 0; u.last = now(); const tok = "tok-" + ++tokSeq; tokens[tok] = u.id;
        return { data: { ok: true, token: tok, name: u.name, role: u.role, must_change: u.must, perms: permsOf(u.role) }, error: null };
      }
      if (name === "demo_logout") { delete tokens[a.p_token]; return { data: true, error: null }; }
      if (name === "demo_whoami") { const u = sByTok(a.p_token); return { data: u ? { ok: true, name: u.name, role: u.role, must_change: u.must, perms: permsOf(u.role) } : { ok: false }, error: null }; }
      if (name === "demo_set_password") {
        const u = sByTok(a.p_token); if (!u) return E("Please sign in again");
        const min = u.role === "OWNER" ? 12 : 8; if (String(a.p_new || "").length < min) return E("Password must be at least " + min + " characters");
        if (!u.must) { if (u.role !== "OWNER") return E("Ask the owner to reset your password"); if (u.pass !== a.p_current) return E("Current password is wrong"); }
        u.pass = a.p_new; u.must = false; u.reset = false;
        Object.keys(tokens).forEach((t) => { if (tokens[t] === u.id && t !== a.p_token) delete tokens[t]; });
        return { data: { ok: true }, error: null };
      }
      if (name === "demo_request_reset") { const u = staff.find((x) => x.name.toLowerCase() === String(a.p_name || "").trim().toLowerCase()); if (u && u.active && u.role !== "OWNER") u.reset = true; return { data: { ok: true }, error: null }; }
      if (name === "demo_owner_overview") {
        const [e] = ownerOnly(); if (e) return e;
        return { data: { rooms: db.demo_sessions.map((s) => ({ code: s.code, created_at: s.created_at, orders: db.demo_orders.filter((o) => o.session_id === s.id).length, open_orders: db.demo_orders.filter((o) => o.session_id === s.id && o.status === "OPEN").length, paid_count: db.demo_payments.filter((p) => p.session_id === s.id && p.status === "PAID").length, gross: db.demo_payments.filter((p) => p.session_id === s.id && p.status === "PAID").reduce((t, p) => t + p.total, 0), voided_count: db.demo_payments.filter((p) => p.session_id === s.id && p.status === "VOIDED").length, kitchen_mode: s.kitchen_mode, table_count: s.table_count })), roles: Object.keys(roles).map((k) => ({ key: k, label: roles[k].label, views: roles[k].views.slice(), can_void: roles[k].void, can_pay: roles[k].pay, can_export: roles[k].export, builtin: roles[k].builtin, staff_count: staff.filter((x) => x.role === k).length })), staff: staff.map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active, must_change: u.must, reset_requested_at: u.reset ? now() : null, last_login: u.last || null, created_at: now() })) }, error: null };
      }
      if (name === "demo_staff_create") {
        const [e] = ownerOnly(); if (e) return e;
        if (!NAME_RE.test(String(a.p_name || "").trim())) return E("Name: 2-30 letters, numbers, space . _ -");
        if (!roles[String(a.p_role).toUpperCase()] || String(a.p_role).toUpperCase() === "OWNER") return E("Choose a role");
        if (String(a.p_password || "").length < 8) return E("Initial password must be at least 8 characters");
        if (staff.some((x) => x.name.toLowerCase() === a.p_name.trim().toLowerCase())) return E("That name is already taken");
        staff.push({ id: uid(), name: a.p_name.trim(), role: a.p_role.toUpperCase(), pass: a.p_password, must: true, active: true, reset: false, failed: 0 }); return { data: { ok: true }, error: null };
      }
      if (name === "demo_staff_update") {
        const [e] = ownerOnly(); if (e) return e; const u = staff.find((x) => x.id === a.p_id); if (!u) return E("Staff member not found"); if (u.role === "OWNER") return E("The owner account cannot be edited here");
        if (staff.some((x) => x.id !== u.id && x.name.toLowerCase() === a.p_name.trim().toLowerCase())) return E("That name is already taken");
        if (!roles[a.p_role] || a.p_role === "OWNER") return E("Choose a role");
        const changed = a.p_role !== u.role || a.p_active === false; u.name = a.p_name.trim(); u.role = a.p_role; u.active = a.p_active;
        if (changed) Object.keys(tokens).forEach((t) => { if (tokens[t] === u.id) delete tokens[t]; }); return { data: { ok: true }, error: null };
      }
      if (name === "demo_staff_delete") { const [e] = ownerOnly(); if (e) return e; const i = staff.findIndex((x) => x.id === a.p_id); if (i < 0) return E("Staff member not found"); if (staff[i].role === "OWNER") return E("The owner account cannot be deleted"); staff.splice(i, 1); return { data: { ok: true }, error: null }; }
      if (name === "demo_staff_reset") {
        const [e] = ownerOnly(); if (e) return e; const u = staff.find((x) => x.id === a.p_id); if (!u) return E("Staff member not found");
        u.pass = "Temp" + ++tokSeq + "xYz9"; u.must = true; u.reset = false; Object.keys(tokens).forEach((t) => { if (tokens[t] === u.id) delete tokens[t]; });
        return { data: { ok: true, name: u.name, temp: u.pass }, error: null };
      }
      const tokenStaff = () => { const me = sByTok(a.p_token); if (!me) return [E("Please sign in again")]; if (me.must) return [E("Set your new password first")]; return [null, me]; };
      const hasView = (role, v) => roles[role].views.includes(v);
      if (name === "demo_room_create") {
        const c = String(a.p_code || "").toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(c)) return E("Bad room code");
        if (!["ONE", "SPLIT"].includes(a.p_mode)) return E("Kitchen setup must be ONE or SPLIT"); if (!(a.p_tables >= 30 && a.p_tables <= 50)) return E("Tables must be between 30 and 50");
        if (db.demo_sessions.some((x) => x.code === c)) return { data: null, error: { code: "23505", message: "Room code already used" } };
        const r = { id: uid(), code: c, kitchen_mode: a.p_mode, table_count: a.p_tables, created_at: now() }; db.demo_sessions.push(r); changed();
        return { data: { id: r.id, code: r.code, kitchen_mode: r.kitchen_mode, table_count: r.table_count }, error: null };
      }
      if (name === "demo_room_join") {
        const r = db.demo_sessions.find((x) => x.code === String(a.p_code || "").toUpperCase());
        return { data: r ? { id: r.id, code: r.code, kitchen_mode: r.kitchen_mode, table_count: r.table_count } : null, error: null };
      }
      if (name === "demo_room_rev") { const [e] = tokenStaff(); if (e) return e; return { data: { rev: globalRev }, error: null }; }
      if (name === "demo_room_state") {
        const [e, me] = tokenStaff(); if (e) return e; const r = db.demo_sessions.find((x) => x.id === a.p_sid); if (!r) return E("Room not found");
        const rl = roles[me.role], v = rl.views, any = (xs) => xs.some((x) => v.includes(x));
        const sees = any(["order", "kitchen", "cold", "bar", "pos", "history", "dashboard"]), pay = any(["pos", "history", "dashboard"]) || rl.pay || rl.void || rl.export, phone = any(["order", "pos", "dashboard"]);
        return { data: { rev: globalRev, room: { kitchen_mode: r.kitchen_mode, table_count: r.table_count },
          orders: sees ? db.demo_orders.filter((o) => o.session_id === r.id).map((o) => Object.assign({}, o, { customer_phone: phone ? o.customer_phone : null, demo_order_items: db.demo_order_items.filter((i) => i.order_id === o.id).map((i) => Object.assign({}, i)) })) : [],
          payments: pay ? db.demo_payments.filter((p) => p.session_id === r.id).map((p) => Object.assign({}, p)).reverse() : [] }, error: null };
      }
      if (name === "demo_order_send") {
        const [e, me] = tokenStaff(); if (e) return e; if (!hasView(me.role, "order")) return E("Not allowed: your role cannot take orders");
        const r = db.demo_sessions.find((x) => x.id === a.p_sid); if (!r) return E("Room not found");
        const m = /^Table ([0-9]{1,2})$/.exec(a.p_table || ""); if (!m) return E("Pick a table"); if (+m[1] < 1 || +m[1] > r.table_count) return E("That table does not exist in this room");
        if (!Array.isArray(a.p_items) || a.p_items.length < 1 || a.p_items.length > 40) return E("Add between 1 and 40 items");
        const lines = [];
        for (const it of a.p_items) {
          if (!(Number.isInteger(it.qty) && it.qty >= 1 && it.qty <= 50)) return E("Quantity must be 1 to 50");
          let hit = null;
          menuDb.categories.forEach((c) => c.items.forEach((i) => { if (!hit && (i.id === it.id || (!it.id && i.name.toLowerCase() === String(it.name).toLowerCase()))) hit = { i, c }; }));
          if (!hit) menuDb.categories.forEach((c) => c.items.forEach((i) => { if (!hit && i.name.toLowerCase() === String(it.name).toLowerCase()) hit = { i, c }; }));
          if (!hit) return E("That item is not on the menu: " + it.name);
          lines.push({ it, hit });
        }
        let o = db.demo_orders.find((x) => x.session_id === r.id && x.table_name === a.p_table && x.status === "OPEN");
        const cn = (a.p_customer || "").trim() || null, ph = (a.p_phone || "").trim() || null;
        if (!o) { o = { id: uid(), session_id: r.id, table_name: a.p_table, customer_name: cn, customer_phone: ph, created_at: now(), status: "OPEN" }; db.demo_orders.push(o); }
        else { if (cn) o.customer_name = cn; if (ph) o.customer_phone = ph; }
        lines.forEach(({ it, hit }) => db.demo_order_items.push({ id: uid(), order_id: o.id, item_name: hit.i.name, qty: it.qty, status: "PENDING", note: it.note || null, unit_price: hit.i.price, tax_rate: 0.1, station: hit.c.station, created_at: now() }));
        changed(); return { data: { ok: true, order_id: o.id }, error: null };
      }
      if (name === "demo_item_status") {
        const [e, me] = tokenStaff(); if (e) return e; const it = db.demo_order_items.find((x) => x.id === a.p_item_id); if (!it) return E("Item not found");
        const o = db.demo_orders.find((x) => x.id === it.order_id); if (o.status !== "OPEN") return E("Order is already " + o.status.toLowerCase()); if (it.status === "CANCELLED") return E("This item was voided");
        if ((it.status === "PENDING" && a.p_status === "PREPARING") || (it.status === "PREPARING" && a.p_status === "READY")) {
          const ok = it.station === "BAR" ? hasView(me.role, "bar") : it.station === "COLD" ? hasView(me.role, "cold") || hasView(me.role, "kitchen") : hasView(me.role, "kitchen");
          if (!ok) { return E("Not allowed: your role cannot prepare this item"); }
        } else if (it.status === "READY" && a.p_status === "DELIVERED") { if (!hasView(me.role, "order")) return E("Not allowed: your role cannot mark items delivered"); }
        else return E("Cannot move an item from " + it.status + " to " + a.p_status);
        it.status = a.p_status; it.updated_at = now(); if (a.p_status === "READY") { it.ready_at = it.updated_at; it.ready_by = me.name; } if (a.p_status === "DELIVERED") { it.delivered_at = it.updated_at; it.delivered_by = me.name; } changed(); return { data: { ok: true }, error: null };
      }
      if (name === "demo_room_delete") {
        const [e] = ownerOnly(); if (e) return e; const r = db.demo_sessions.find((x) => x.code === String(a.p_code).toUpperCase()); if (!r) return E("Room not found");
        const ids = db.demo_orders.filter((o) => o.session_id === r.id).map((o) => o.id);
        db.demo_order_items = db.demo_order_items.filter((i) => !ids.includes(i.order_id)); db.demo_payments = db.demo_payments.filter((p) => p.session_id !== r.id);
        db.demo_orders = db.demo_orders.filter((o) => o.session_id !== r.id); db.demo_sessions = db.demo_sessions.filter((x) => x.id !== r.id); changed();
        return { data: { ok: true, orders: ids.length, payments: 0 }, error: null };
      }
      if (name === "demo_rooms_delete_empty") {
        const [e] = ownerOnly(); if (e) return e; const before = db.demo_sessions.length;
        db.demo_sessions = db.demo_sessions.filter((r) => !(Date.parse(r.created_at) < clock - 600000 && !db.demo_orders.some((o) => o.session_id === r.id) && !db.demo_payments.some((p) => p.session_id === r.id)));
        changed(); return { data: { ok: true, deleted: before - db.demo_sessions.length }, error: null };
      }
      if (name === "demo_role_save") {
        const [e] = ownerOnly(); if (e) return e; const k = String(a.p_key || "").toUpperCase();
        if (k === "OWNER") return E("The owner role cannot be changed"); if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(k)) return E("Role key: 2-24 letters/numbers/underscore");
        if (String(a.p_label || "").trim().length < 2) return E("Role name: 2-30 characters");
        if ((a.p_views || []).some((v) => !["order", "kitchen", "cold", "bar", "pos", "history", "dashboard"].includes(v))) return E("Unknown screen in the list");
        roles[k] = { label: a.p_label.trim(), views: a.p_views.slice(), void: !!a.p_void, pay: !!a.p_pay, export: !!a.p_export, builtin: roles[k] ? roles[k].builtin : false };
        return { data: { ok: true, key: k }, error: null };
      }
      if (name === "demo_role_delete") {
        const [e] = ownerOnly(); if (e) return e; const r = roles[a.p_key]; if (a.p_key === "OWNER") return E("The owner role cannot be deleted"); if (!r) return E("Role not found");
        const n = staff.filter((x) => x.role === a.p_key).length; if (n) return E(n + " staff still use this role - move them to another role first");
        delete roles[a.p_key]; return { data: { ok: true }, error: null };
      }
      if (name === "demo_roles_restore_defaults") {
        const [e] = ownerOnly(); if (e) return e; let n = 0;
        for (const [k, v] of Object.entries(DEFAULT_ROLES)) if (!roles[k]) { roles[k] = JSON.parse(JSON.stringify(v)); n++; }
        return { data: { ok: true, restored: n }, error: null };
      }
      if (name === "demo_room_update") {
        const [e] = ownerOnly(); if (e) return e; const r = db.demo_sessions.find((x) => x.code === a.p_code); if (!r) return E("Room not found");
        if (!["ONE", "SPLIT"].includes(a.p_mode)) return E("Kitchen mode must be ONE or SPLIT"); if (a.p_tables < 30 || a.p_tables > 50) return E("Tables must be between 30 and 50");
        r.kitchen_mode = a.p_mode; r.table_count = a.p_tables; changed(); return { data: { ok: true }, error: null };
      }
      if (name === "demo_menu_get") return { data: JSON.parse(JSON.stringify(menuDb)), error: null };
      if (name === "demo_menu_save") {
        const [e] = ownerOnly(); if (e) return e; const cats = (a.p_menu || {}).categories || [];
        if (!cats.length) return E("The menu needs 1-20 categories");
        for (const c of cats) { if (!["KITCHEN", "COLD", "BAR"].includes(c.station)) return E("Choose Kitchen, Cold kitchen or Bar for each category"); for (const i of c.items) { if (!(i.price >= 0) || i.price !== Math.floor(i.price)) return E("Price must be a whole number of rupiah (0 - 10,000,000)"); } }
        menuDb.categories = cats.map((c) => ({ id: c.id || u7(++menuSeq), name: c.name.trim(), station: c.station, note: c.note || null, items: c.items.map((i) => ({ id: i.id || u7(++menuSeq), name: i.name.trim(), price: i.price, spicy: !!i.spicy, track: !!i.track })) }));
        return { data: JSON.parse(JSON.stringify(menuDb)), error: null };
      }
      if (name === "demo_owner_recover") {
        if (!client.verified) return E("Verify with the emailed code first");
        if (String(a.p_new || "").length < 12) return E("Owner password must be at least 12 characters");
        const o = staff.find((x) => x.role === "OWNER"); o.pass = a.p_new; o.must = false; Object.keys(tokens).forEach((t) => { if (tokens[t] === o.id) delete tokens[t]; });
        return { data: { ok: true }, error: null };
      }
      if (name === "demo_pay_order") {
        const me = sByTok(a.p_token); if (!me) return E("Please sign in again"); if (me.must) return E("Set your new password first"); if (!roles[me.role].pay) return E("Not allowed: your role cannot take payment");
        const o = db.demo_orders.find((x) => x.id === a.p_order_id);
        if (!o) return E("Order not found");
        if (o.status === "CLOSED") return E("This order has already been paid");
        if (o.status !== "OPEN") return E("Order is " + o.status);
        const items = db.demo_order_items.filter((i) => i.order_id === o.id && i.status !== "CANCELLED");
        if (!items.length) return E("Nothing to charge - every item was voided");
        if (items.some((i) => i.status !== "DELIVERED")) return E("Not all items are delivered yet");
        const sub = items.reduce((s, i) => s + i.qty * i.unit_price, 0), tax = items.reduce((s, i) => s + Math.round(i.qty * i.unit_price * i.tax_rate), 0);
        if (a.p_method === "CASH" && (a.p_tendered == null || a.p_tendered < sub + tax)) return E("Cash received is less than the total");
        const pay = { id: uid(), session_id: o.session_id, order_id: o.id, receipt_no: ++receiptSeq, table_name: o.table_name, customer_name: o.customer_name || null, subtotal: sub, tax, total: sub + tax, method: a.p_method, amount_tendered: a.p_method === "CASH" ? a.p_tendered : null, change_given: a.p_method === "CASH" ? a.p_tendered - sub - tax : null, status: "PAID", paid_at: now(), voided_at: null, void_reason: null, paid_by: me.name, voided_by: null };
        db.demo_payments.push(pay); o.status = "CLOSED"; o.closed_at = now(); changed();
        return { data: Object.assign({}, pay), error: null };
      }
      if (name === "demo_void_item") {
        const me = sByTok(a.p_token); if (!me) return E("Please sign in again"); if (me.must) return E("Set your new password first"); if (!roles[me.role].void) return E("Not allowed: your role cannot void");
        const r = (a.p_reason || "").trim(); if (r.length < 3) return E("A reason (at least 3 characters) is required to void");
        const it = db.demo_order_items.find((x) => x.id === a.p_item_id); if (!it) return E("Item not found");
        const o = db.demo_orders.find((x) => x.id === it.order_id);
        if (o.status === "CLOSED") return E("Order is already paid - void the whole sale instead");
        if (o.status !== "OPEN") return E("Order is already " + o.status);
        if (it.status === "CANCELLED") return E("Item is already voided");
        Object.assign(it, { voided_from_status: it.status, status: "CANCELLED", void_reason: r, voided_at: now() });
        const cancelled = !db.demo_order_items.some((x) => x.order_id === o.id && x.status !== "CANCELLED");
        if (cancelled) Object.assign(o, { status: "CANCELLED", void_reason: "All items voided", voided_at: now(), closed_at: now() });
        changed(); return { data: { ok: true, orderCancelled: cancelled }, error: null };
      }
      if (name === "demo_void_order") {
        const me = sByTok(a.p_token); if (!me) return E("Please sign in again"); if (me.must) return E("Set your new password first"); if (!roles[me.role].void) return E("Not allowed: your role cannot void");
        const r = (a.p_reason || "").trim(); if (r.length < 3) return E("A reason (at least 3 characters) is required to void");
        const o = db.demo_orders.find((x) => x.id === a.p_order_id); if (!o) return E("Order not found");
        if (o.status === "CANCELLED") return E("Order is already voided");
        let wasPaid = false;
        if (o.status === "CLOSED") { const p = db.demo_payments.find((x) => x.order_id === o.id && x.status === "PAID"); if (!p) return E("No active payment found for this order"); Object.assign(p, { status: "VOIDED", voided_at: now(), void_reason: r, voided_by: me.name }); wasPaid = true; }
        else db.demo_order_items.filter((i) => i.order_id === o.id && i.status !== "CANCELLED").forEach((i) => Object.assign(i, { voided_from_status: i.status, status: "CANCELLED", void_reason: r, voided_at: now() }));
        Object.assign(o, { status: "CANCELLED", void_reason: r, voided_at: now(), closed_at: o.closed_at || now() });
        changed(); return { data: { ok: true, wasPaid }, error: null };
      }
      return E("unknown rpc " + name);
    });
  }
  function channel() {
    const ch = { handlers: [], on(_t, _f, h) { ch.handlers.push(h); return ch; }, subscribe(cb) { if (cb) setTimeout(() => cb("SUBSCRIBED"), 0); return ch; } };
    client.channels.push(ch); return ch;
  }
  const auth = {
    signInWithOtp: (o) => { otpRequests.push(o.email); return Promise.resolve({ data: {}, error: null }); },
    verifyOtp: (o) => Promise.resolve(o.token === "123456" && o.email === "chrisanto.pangestu@gmail.com" ? (client.verified = true, { data: { session: { access_token: "x" } }, error: null }) : { data: {}, error: { message: "Token has expired or is invalid" } }),
    signOut: () => { client.verified = false; return Promise.resolve({ error: null }); },
  };
  return { from: builder, rpc, channel, removeChannel() {}, auth };
}

// ---------- simulated browsers ----------
const plays = []; // {win, bytes}
function openWindow(name, url) {
  const sizes = {}; let n = 0;
  const dom = new JSDOM(html, {
    url, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.DEMO_POLL_MS = 60;
      w.supabase = { createClient: () => makeClient() };
      w.URL.createObjectURL = (blob) => { const id = "blob:" + ++n; sizes[id] = blob.size; return id; };
      w.Audio = class { constructor() { this.src = ""; this.currentTime = 0; } play() { plays.push({ win: name, bytes: sizes[this.src] }); return Promise.resolve(); } };
      w.alert = (m) => { w.__alerts = (w.__alerts || []).concat(m); };
      w.print = () => { w.__printed = true; };
      const xl = { utils: { book_new: () => ({ sheets: {} }), aoa_to_sheet: (a) => ({ aoa: a }), book_append_sheet: (wb, ws, nm) => { wb.sheets[nm] = ws.aoa; } }, writeFile: (wb, fn) => { w.__xlsx = { wb, fn }; } };
      w.XLSX = xl;
    },
  });
  const w = dom.window;
  w.__name = name;
  return w;
}
const $ = (w, sel) => w.document.querySelector(sel);
const $$ = (w, sel) => [...w.document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const tap = (w) => w.document.dispatchEvent(new w.Event("pointerdown", { bubbles: true }));
const wavBytes = (notes) => 44 + 2 * Math.max(1, Math.floor(notes.reduce((s, x) => s + x, 0) * 22050)); // same sizing rule as the page
const BYTES = { newOrder: wavBytes([.25, .35, .1, .25, .45]), ready: wavBytes([.2, .2, .55]), voidd: wavBytes([.3, .08, .45]) };
const heard = (win, kind) => plays.filter((p) => p.win === win && p.bytes === BYTES[kind]).length;
const text = (w, sel) => ($(w, sel) || {}).textContent || "";
const URLX = "https://clearion.test/application-example-group/index.html";

(async () => {
  const signIn = async (w, name, pass) => { $(w, "#siName").value = name; $(w, "#siPass").value = pass; click($(w, "#siGo")); await sleep(90); };
  const firstLogin = async (w, name, tmp, pw) => {
    await signIn(w, name, tmp);
    assert(!$(w, "#changeForm").hidden && $(w, "#app").hidden, name + " must choose a password first");
    $(w, "#cpNew").value = pw; $(w, "#cpNew2").value = pw; click($(w, "#cpGo")); await sleep(90);
  };
  const visibleTabs = (w) => $$(w, ".tab-btn").filter((b) => !b.hidden).map((b) => b.dataset.view).join(",");
  const A = openWindow("A", URLX);
  await sleep(50);
  click($(A, "#createBtn")); await sleep(100);
  const code = text(A, "#roomCodeLabel");
  assert(code.length === 6, "room created");
  const join = async (name) => { const w = openWindow(name, URLX); await sleep(30); $(w, "#codeInput").value = code; click($(w, "#joinBtn")); await sleep(100); return w; };
  // before sign-in: sign-in screen only, app hidden, nothing to peek at
  assert(!$(A, "#viewRole").hidden && $(A, "#app").hidden, "sign-in screen before app");
  assert(!/ownerpass|Demo code/.test(A.document.body.innerHTML), "no passwords or codes in the page");
  await signIn(A, "Owner", "wrong-password"); assert(/Wrong name or password/.test(text(A, "#roleErr")) && $(A, "#app").hidden, "wrong owner password rejected");
  await signIn(A, "nobody", "whatever12"); assert(/Wrong name or password/.test(text(A, "#roleErr")), "unknown name gets the same message");

  // owner signs in (own window) and creates the team through the console
  const O = await join("O");
  await signIn(O, "owner", "ownerpass12345");
  assert.strictEqual(visibleTabs(O), "order,kitchen,bar,pos,history,dashboard,owner", "owner sees all tabs");
  assert.strictEqual(A.document.querySelector('.tab-btn[data-view="owner"]').hidden, true);
  click($$(O, ".tab-btn").find((b) => b.dataset.view === "owner")); await sleep(100);
  assert(new RegExp(code).test(text(O, "#ownerRooms")), "owner console lists rooms");
  const addStaff = async (nm, rl, pw) => { $(O, "#stName").value = nm; $(O, "#stRole").value = rl; $(O, "#stPass").value = pw; click($(O, "#stAdd")); await sleep(100); };
  await addStaff("Wati", "WAITER", "short"); assert(/at least 8/.test(text(O, "#ownerMsg")), "short initial password rejected");
  await addStaff("Wati", "WAITER", "tmp-waiter-1"); assert(/Created Wati/.test(text(O, "#ownerMsg")), text(O, "#ownerMsg"));
  await addStaff("wati", "KITCHEN", "tmp-other-12"); assert(/already taken/.test(text(O, "#ownerMsg")), "duplicate name (case-insensitive) rejected");
  await addStaff("Koki", "KITCHEN", "tmp-kitchen-1"); await addStaff("Sari", "SUPERVISOR", "tmp-super-12"); await addStaff("Dewi", "COORDINATOR", "tmp-coord-12");
  await addStaff("Barry", "BAR", "tmp-bar-1234"); await addStaff("Kuki", "KITCHEN_SUP", "tmp-ksup-123"); await addStaff("Fifi", "FLOOR_SUP", "tmp-fsup-123");
  assert(["BAR", "KITCHEN_SUP", "FLOOR_SUP"].every((r) => $$(O, "#stRole option").some((o) => o.value === r)), "new roles offered in the owner console");
  assert(["Wati", "Koki", "Sari", "Dewi"].every((n) => $$(O, ".st-name").some((i) => i.value === n)), "all four staff listed");

  // each person: first sign-in forces their own password
  await signIn(A, "Wati", "tmp-waiter-1");
  assert(!$(A, "#changeForm").hidden && $(A, "#app").hidden, "waiter must choose a password first");
  $(A, "#cpNew").value = "abc"; $(A, "#cpNew2").value = "abc"; click($(A, "#cpGo")); await sleep(60);
  assert(/at least 8/.test(text(A, "#cpErr")) && $(A, "#app").hidden, "weak new password rejected");
  $(A, "#cpNew").value = "waiter-own-pw1"; $(A, "#cpNew2").value = "different-pw-1"; click($(A, "#cpGo")); await sleep(60);
  assert(/do not match/.test(text(A, "#cpErr")), "mismatch rejected");
  $(A, "#cpNew2").value = "waiter-own-pw1"; click($(A, "#cpGo")); await sleep(90);
  assert(!$(A, "#app").hidden, "waiter in after choosing a password");
  assert.strictEqual(visibleTabs(A), "order,pos", "waiter sees only Order Entry + POS: " + visibleTabs(A));
  assert(/Wati · Waiter/.test(text(A, "#roleLabel")), "badge shows name and role");
  const K = await join("K"); await firstLogin(K, "Koki", "tmp-kitchen-1", "kitchen-own-pw1");
  const D = await join("D"); await firstLogin(D, "Sari", "tmp-super-12", "super-own-pw12");
  const C = await join("C"); await firstLogin(C, "Dewi", "tmp-coord-12", "coord-own-pw12");
  const B = await join("B"); await firstLogin(B, "Barry", "tmp-bar-1234", "bar-own-pw-123");
  assert.strictEqual(visibleTabs(B), "bar", "bar sees only the Bar Display");
  assert.strictEqual(visibleTabs(K), "kitchen", "kitchen sees only Kitchen");
  assert.strictEqual(visibleTabs(C), "history,dashboard", "coordinator sees dashboard + history");
  assert.strictEqual(visibleTabs(D), "history,dashboard", "supervisor sees dashboard + history");
  assert($(K, "#view-kitchen").classList.contains("active") && !$(A, "#view-kitchen").classList.contains("active"));
  assert(A.sessionStorage.getItem("demoTok") && !O.sessionStorage.getItem("demoTok"), "staff token kept for the tab session; owner never persisted");
  [A, K, D, C, B].forEach(tap); await sleep(30);

  const ITEM = { d1: "Sample Iced Tea", d2: "Sample Iced Coffee", d3: "Sample Lemon Tea", m1: "Sample Fried Rice", m2: "Sample Chicken Noodle", m3: "Sample Grilled Skewers" };
  const addItem = (w, key, spice) => {
    const nm = ITEM[key] || key, card = Array.from(w.document.querySelectorAll("#menuByCategory .card")).find((c) => c.querySelector(".name").textContent === nm);
    assert(card, "menu card " + nm);
    const pick = card && card.querySelector(".spice-pick"); if (spice) { assert(pick, "spice choice for " + nm); pick.value = spice; }
    click(card.querySelector(".add-item"));
  };
  const sendTo = async (w, table) => { $(w, "#tableSelect").value = table; click($(w, "#sendOrderBtn")); await sleep(120); };

  // 1) waiter orders: 2x Iced Tea (tracked), 1x Fried Rice not spicy -> kitchen rings
  addItem(A, "d1"); addItem(A, "d1"); addItem(A, "m1", "none");
  await sendTo(A, "Table 1");
  if (process.env.DBG) { console.log("plays", JSON.stringify(plays), "BYTES", JSON.stringify(BYTES)); console.log("K board:", text(K, "#kitchenBoard").slice(0, 200)); console.log("K alerts:", text(K, "#alertStack")); console.log("db", db.demo_orders.length, db.demo_order_items.length); }
  assert.strictEqual(heard("K", "newOrder"), 1, "kitchen hears new order once");
  assert.strictEqual(heard("B", "newOrder"), 1, "bar hears the drinks order once");
  assert.strictEqual(heard("A", "newOrder"), 0, "waiter tab does not ring for its own new order");
  assert(/New order: Table 1/.test(text(K, "#alertStack")), "kitchen banner");
  assert(/New drinks: Table 1/.test(text(B, "#alertStack")), "bar banner");
  assert(/Sample Fried Rice/.test(text(K, "#kitchenBoard")) && !/Iced Tea/.test(text(K, "#kitchenBoard")), "kitchen shows food only");
  assert(/Sample Iced Tea/.test(text(B, "#barBoard")) && !/Fried Rice/.test(text(B, "#barBoard")), "bar shows drinks only");
  assert(db.demo_order_items.filter((i) => i.item_name === "Sample Iced Tea").every((i) => i.station === "BAR") && db.demo_order_items.find((i) => i.item_name === "Sample Fried Rice").station === "KITCHEN", "station stored on each line");

  // 2) kitchen advances -> waiter rings on READY only
  const advTo = async (w, next) => { const board = w === B ? "#barBoard" : "#kitchenBoard"; for (let i = 0; i < 6; i++) { const b = $$(w, board + " .advance").find((x) => x.dataset.next === next); if (!b) break; click(b); await sleep(100); } };
  await advTo(K, "PREPARING"); await advTo(B, "PREPARING");
  assert.strictEqual(heard("A", "ready"), 0, "no ready sound before READY");
  await advTo(K, "READY");
  assert(heard("A", "ready") >= 1, "waiter hears READY");
  await advTo(B, "READY");
  assert.strictEqual(heard("K", "ready") + heard("B", "ready"), 0, "kitchen and bar do not ring for ready");
  assert.strictEqual(heard("D", "ready") + heard("D", "newOrder"), 0, "dashboard tab is silent");
  assert(/Ready to serve/.test(text(A, "#alertStack")), "waiter banner");
  // v8: once an item is READY it leaves its station board (still waiting on the waiter's screen)
  assert(!/Fried Rice/.test(text(K, "#kitchenBoard")) && !/Iced Tea/.test(text(B, "#barBoard")), "ready items disappear from kitchen and bar boards");
  assert(/Mark delivered/.test(text(A, "#myOpenOrders")), "...but the waiter can still deliver them");

  // 3) deliver -> Pay this table -> POS
  for (let i = 0; i < 6; i++) { const b = $(A, ".deliver"); if (!b) break; click(b); await sleep(100); }
  assert(/No food orders/.test(text(K, "#kitchenBoard")) && /No drinks/.test(text(B, "#barBoard")), "delivered tickets disappear from kitchen and bar");
  const payBtn = $(A, ".pay-table"); assert(payBtn, "pay button appears when all delivered");
  click(payBtn); await sleep(50);
  assert($(A, "#view-pos").classList.contains("active"), "switched to POS");
  const posText = text(A, "#posDetail");
  assert(/Rp 67\.000/.test(posText), "subtotal 2x10000+47000=67000: " + posText);
  assert(/Rp 6\.700/.test(posText), "tax 6700");
  assert(/Rp 73\.700/.test(posText), "total 73700");
  assert($(A, "#posCharge").disabled, "cash charge disabled until cash entered");
  const cash = $(A, "#posCash"); cash.value = "50000"; cash.dispatchEvent(new A.Event("input", { bubbles: true }));
  assert($(A, "#posCharge").disabled && /Short by Rp 23\.700/.test(text(A, "#posChange")), "short cash blocked");
  cash.value = "100000"; cash.dispatchEvent(new A.Event("input", { bubbles: true }));
  assert(!$(A, "#posCharge").disabled && /Change: Rp 26\.300/.test(text(A, "#posChange")), "change shown");
  click($(A, "#posCharge")); await sleep(150);
  assert(/Receipt #1/.test(text(A, "#posDetail")) && /Rp 73\.700/.test(text(A, "#posDetail")), "receipt shown");
  click($(A, "#rcPrint")); assert(A.__printed, "print called");
  click($(A, "#rcDone"));

  // 4) dashboard: coordinator cannot void, supervisor can; transactions; void the paid sale
  assert(/view only/.test(text(C, "#supStatus")) && !$(C, ".void-order") && !$(C, ".void-item"), "coordinator: no void buttons");
  assert(/can void/.test(text(D, "#supStatus")), "supervisor can void");
  assert(db.demo_payments.length >= 1 && db.demo_payments[0].paid_by === "Wati", "payment recorded who took it");
  assert(!$$(D, ".dash-tab").find((b) => b.dataset.dtab === "report" && !b.hidden), "supervisor has no Excel tab");
  assert($$(C, ".dash-tab").find((b) => b.dataset.dtab === "report" && !b.hidden), "coordinator has the Excel tab");
  click($$(D, ".dash-tab").find((b) => b.dataset.dtab === "tx")); await sleep(20);
  await sleep(80);
  assert(/Table 1/.test(text(D, "#txTable")) && /Rp 73\.700/.test(text(D, "#txStats")), "transaction listed, gross 73700");
  click($(D, ".void-sale"));
  $(D, "#modalInput").value = "ab"; $(D, "#modalInput").dispatchEvent(new D.Event("input", { bubbles: true }));
  assert($(D, "#modalOk").disabled, "reason needs 3+ chars");
  $(D, "#modalInput").value = "wrong table charged"; $(D, "#modalInput").dispatchEvent(new D.Event("input", { bubbles: true }));
  click($(D, "#modalOk")); await sleep(150);
  assert(/Voided[^]*1/.test(text(D, "#txStats")) && /VOIDED/.test(text(D, "#txTable")) && /wrong table charged/.test(text(D, "#txTable")), "sale voided with reason");
  assert(/Paidsales0/.test(text(D, "#txStats").replace(/\s/g, "")), "paid sales now 0: " + text(D, "#txStats"));

  // 5) void during kitchen work: kitchen + waiter are alerted, kitchen told to stop
  addItem(A, "d3"); await sendTo(A, "Table 2");           // 1x Lemon Tea (tracked)
  click($$(D, ".dash-tab").find((b) => b.dataset.dtab === "live")); await sleep(20);
  const voidItemBtn = $(D, ".void-item"); assert(voidItemBtn, "void item button visible when unlocked");
  click(voidItemBtn);
  $(D, "#modalInput").value = "customer left"; $(D, "#modalInput").dispatchEvent(new D.Event("input", { bubbles: true }));
  click($(D, "#modalOk")); await sleep(150);
  assert(heard("B", "voidd") === 1 && heard("K", "voidd") === 0, "bar (not kitchen) hears the drink void");
  assert(/Stop making it/.test(text(B, "#alertStack")), "bar told to stop");
  assert(!/Table 2/.test(text(B, "#barBoard")), "cancelled-order ticket leaves the bar board");

  // 6) second paid sale (card), then Excel
  addItem(A, "m2", "spicy"); await sendTo(A, "Table 3");  // 1x Chicken Noodle 35000
  await advTo(K, "PREPARING"); await advTo(K, "READY");
  click($(A, ".deliver")); await sleep(100);
  click($(A, ".pay-table")); await sleep(50);
  click($$(A, ".pos-method").find((b) => b.dataset.m === "CARD")); await sleep(20);
  click($(A, "#posCharge")); await sleep(150);
  assert(/Receipt #2/.test(text(A, "#posDetail")) && /Rp 38\.500/.test(text(A, "#posDetail")), "second receipt 35000+3500");

  click($$(C, ".dash-tab").find((b) => b.dataset.dtab === "report"));
  click($(C, "#repBtn")); await sleep(30);
  assert(C.__xlsx, "xlsx written"); const { wb, fn } = C.__xlsx;
  assert(/^report-demo-day-\d{4}-\d{2}-\d{2}\.xlsx$/.test(fn), fn);
  assert.deepStrictEqual(Object.keys(wb.sheets), ["Summary", "Sales by day", "Sales by item", "Transactions", "Stock", "Voids"]);
  const sum = Object.fromEntries(wb.sheets["Summary"].filter((r) => r.length >= 2 && typeof r[1] === "number").map((r) => [r[0], r[1]]));
  assert.strictEqual(sum["Paid sales (count)"], 1, "one paid sale");
  assert.strictEqual(sum["Gross sales (incl. tax)"], 38500);
  assert.strictEqual(sum["Net sales (before tax)"] + sum["Tax"], sum["Gross sales (incl. tax)"]);
  assert.strictEqual(sum["Paid sales voided (count)"], 1);
  assert.strictEqual(sum["Paid sales voided (value)"], 73700);
  const items = wb.sheets["Sales by item"]; assert.strictEqual(items[1][0], "Sample Chicken Noodle"); assert.strictEqual(items[1][2], 35000);
  assert.strictEqual(items[items.length - 1][2], 35000, "item net total reconciles to payments net");
  const stock = Object.fromEntries(wb.sheets["Stock"].slice(1).map((r) => [r[0], r]));
  for (const r of Object.values(stock)) assert.strictEqual(r[1] - r[2] + r[3], r[4], "stock identity " + r[0]);
  assert.strictEqual(JSON.stringify(stock["Sample Iced Tea"].slice(1)), "[40,2,0,38]");
  assert.strictEqual(JSON.stringify(stock["Sample Lemon Tea"].slice(1)), "[40,1,1,40]", "voided-while-PENDING is restocked");
  const voids = wb.sheets["Voids"].slice(1); assert.strictEqual(JSON.stringify(voids.map((r) => r[1]).sort()), '["ITEM_VOIDED","SALE_VOIDED"]');
  assert.strictEqual(wb.sheets["Transactions"].length, 3, "header + paid + voided");
  // weekly
  click($$(C, ".rep-period").find((b) => b.dataset.period === "week")); click($(C, "#repBtn")); await sleep(30);
  assert(/^report-demo-week-/.test(C.__xlsx.fn)); assert.strictEqual(C.__xlsx.wb.sheets["Sales by day"].length, 1 + 7 + 1, "7 days + header + total");
  assert.strictEqual(new Date(C.__xlsx.fn.match(/\d{4}-\d{2}-\d{2}/)[0] + "T00:00:00Z").getUTCDay(), 1, "week starts on Monday");

  // 7) right-click blocked (existing behaviour preserved)
  const ev = new A.Event("contextmenu", { bubbles: true, cancelable: true }); A.document.body.dispatchEvent(ev);
  assert(ev.defaultPrevented, "contextmenu blocked");

  // 8) mute: no sound but banner still appears
  const before = plays.length; click($(K, "#soundBtn")); // turns OFF (was ON)
  assert(/OFF/.test(text(K, "#soundBtn")));
  addItem(A, "m3", "none"); await sendTo(A, "Table 4");
  assert(plays.slice(before).filter((p) => p.win === "K" && p.bytes === BYTES.newOrder).length === 0, "muted kitchen is silent");
  assert(/New order: Table 4/.test(text(K, "#alertStack")), "banner still shown when muted");

  // 8b) station supervisors: history, voids from their own screen
  const KS = await join("KS"); await firstLogin(KS, "Kuki", "tmp-ksup-123", "ksup-own-pw12");
  const FS = await join("FS"); await firstLogin(FS, "Fifi", "tmp-fsup-123", "fsup-own-pw12");
  assert.strictEqual(visibleTabs(KS), "kitchen,bar,history", "kitchen supervisor: kitchen, bar, history");
  assert.strictEqual(visibleTabs(FS), "order,pos,history", "floor supervisor: order, pos, history");
  assert(!visibleTabs(A).includes("history") && !visibleTabs(K).includes("history") && !visibleTabs(B).includes("history"), "waiter, kitchen and bar staff cannot open history");
  click($$(KS, ".tab-btn").find((b) => b.dataset.view === "history")); await sleep(40);
  assert(/Table 1/.test(text(KS, "#hsTable")) && /Iced Tea/.test(text(KS, "#hsTable")) && /Fried Rice/.test(text(KS, "#hsTable")), "history lists Table 1's delivered items");
  assert(/Finished lines\s*[3-9]/.test(text(KS, "#hsStats")), "history stats: " + text(KS, "#hsStats"));
  click($$(KS, ".hs-chip").find((b) => b.dataset.st === "BAR")); await sleep(20);
  assert(/Iced Tea/.test(text(KS, "#hsTable")) && !/Fried Rice/.test(text(KS, "#hsTable")), "bar filter shows drinks only");
  click($$(KS, ".hs-chip").find((b) => b.dataset.st === "KITCHEN")); await sleep(20);
  assert(/Fried Rice/.test(text(KS, "#hsTable")) && !/Iced Tea/.test(text(KS, "#hsTable")), "kitchen filter shows food only");
  // kitchen supervisor voids a food line right from the kitchen board (Table 4 grilled skewers is still open)
  click($$(KS, ".tab-btn").find((b) => b.dataset.view === "kitchen")); await sleep(30);
  assert(!$(K, ".kb-void") && $(KS, ".kb-void"), "only the supervisor sees Void on the kitchen board");
  click($(KS, ".kb-void")); $(KS, "#modalInput").value = "customer changed mind"; $(KS, "#modalInput").dispatchEvent(new KS.Event("input", { bubbles: true })); click($(KS, "#modalOk")); await sleep(150);
  assert(db.demo_order_items.some((i) => i.item_name === "Sample Grilled Skewers" && i.status === "CANCELLED" && i.void_reason === "customer changed mind"), "kitchen supervisor voided the line");
  // floor supervisor can void and take payment from the waiters' screens
  addItem(A, "m1", "none"); await sendTo(A, "Table 1");
  assert($(FS, ".ot-void") && !$(A, ".ot-void"), "only the floor supervisor sees Void in Open tables");
  click($(FS, ".ot-void-order")); $(FS, "#modalInput").value = "walked out"; $(FS, "#modalInput").dispatchEvent(new FS.Event("input", { bubbles: true })); click($(FS, "#modalOk")); await sleep(150);
  assert(db.demo_orders.filter((o) => o.table_name === "Table 1").pop().status === "CANCELLED", "floor supervisor voided the whole order");

  // 9) the database refuses wrong roles even if someone bypasses the page
  const watiTok = tokenOf("Wati"), korTok = tokenOf("Koki"), anyOrder = db.demo_orders[0].id;
  const raw = makeClient();
  let res = await raw.rpc("demo_void_order", { p_order_id: anyOrder, p_reason: "hack attempt", p_token: watiTok });
  assert(res.error && /cannot void/.test(res.error.message), "waiter token cannot void");
  res = await raw.rpc("demo_pay_order", { p_order_id: anyOrder, p_method: "CARD", p_tendered: null, p_token: korTok });
  assert(res.error && /cannot take payment/.test(res.error.message), "kitchen token cannot take payment");
  res = await raw.rpc("demo_owner_overview", { p_token: watiTok });
  assert(res.error && /Owner sign-in required/.test(res.error.message), "waiter token cannot open the owner console");
  res = await raw.rpc("demo_pay_order", { p_order_id: anyOrder, p_method: "CARD", p_tendered: null, p_token: "forged" });
  assert(res.error && /sign in again/.test(res.error.message), "forged token rejected");
  res = await raw.rpc("demo_set_password", { p_token: watiTok, p_new: "sneaky-new-pw-1", p_current: "waiter-own-pw1" });
  assert(res.error && /Ask the owner/.test(res.error.message), "staff cannot change their own password");

  // 10) forgot password (staff): request -> owner approves -> temporary password -> must choose own
  const X = openWindow("X", URLX); await sleep(30); $(X, "#codeInput").value = code; click($(X, "#joinBtn")); await sleep(100);
  click($(X, "#forgotStaff")); await sleep(30); assert(/Type your name/.test(text(X, "#forgotMsg")));
  $(X, "#siName").value = "Wati"; click($(X, "#forgotStaff")); await sleep(60);
  assert(/Request sent/.test(text(X, "#forgotMsg")), "request acknowledged");
  $(X, "#siName").value = "ghost"; click($(X, "#forgotStaff")); await sleep(60);
  assert(/Request sent/.test(text(X, "#forgotMsg")), "same answer for unknown names");
  click($(O, "#ownerRefresh")); await sleep(80);
  assert(/RESET REQUESTED/.test(text(O, "#staffTable")) && /Reset requests\s*1/.test(text(O, "#ownerStats")), "owner sees the request");
  const oldWatiTok = tokenOf("Wati");
  const watiRow = $$(O, "#staffTable tbody tr").find((r) => r.dataset.id && r.querySelector(".st-name").value === "Wati");
  click(watiRow.querySelector(".st-reset")); await sleep(100);
  const tempMatch = text(O, "#ownerMsg").match(/Temporary password for Wati: (\S+)/); assert(tempMatch, "temp password shown: " + text(O, "#ownerMsg"));
  assert(!sByTok(oldWatiTok), "old waiter session revoked by the reset");
  await signIn(X, "Wati", "waiter-own-pw1"); assert(/Wrong name or password/.test(text(X, "#roleErr")), "old password no longer works");
  await firstLogin(X, "Wati", tempMatch[1], "waiter-third-pw1");
  assert(!$(X, "#app").hidden && visibleTabs(X) === "order,pos", "waiter back in with a new password");
  // the stale window finds out on its next protected action
  assert(!sByTok(oldWatiTok));

  // 11) owner edits, disables, deletes
  click($(O, "#ownerRefresh")); await sleep(80);
  const rowOf = (n) => $$(O, "#staffTable tbody tr").find((r) => r.dataset.id && r.querySelector(".st-name").value === n);
  let kr = rowOf("Koki"); kr.querySelector(".st-name").value = "Koki Chef"; click(kr.querySelector(".st-save")); await sleep(100);
  assert(staff.some((x) => x.name === "Koki Chef"), "rename saved");
  kr = rowOf("Koki Chef"); click(kr.querySelector(".st-toggle")); await sleep(100);
  assert(staff.find((x) => x.name === "Koki Chef").active === false && /Disabled/.test(text(O, "#staffTable")), "disabled");
  await signIn(X, "Koki Chef", "kitchen-own-pw1");  // X is signed in as Wati: sign out first
  const Y = openWindow("Y", URLX); await sleep(30); $(Y, "#codeInput").value = code; click($(Y, "#joinBtn")); await sleep(100);
  await signIn(Y, "Koki Chef", "kitchen-own-pw1"); assert(/Wrong name or password/.test(text(Y, "#roleErr")) && $(Y, "#app").hidden, "disabled account cannot sign in");
  assert(!sByTok(tokenOf("Koki Chef") || "none"), "disabled account has no live session");
  let dr = rowOf("Dewi"); click(dr.querySelector(".st-del")); await sleep(30);
  $(O, "#modalInput").value = "Wrong"; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(40);
  assert(/does not match/.test(text(O, "#modalErr")) && staff.some((x) => x.name === "Dewi"), "delete needs the exact name");
  $(O, "#modalInput").value = "Dewi"; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(120);
  assert(!staff.some((x) => x.name === "Dewi") && !$$(O, ".st-name").some((i) => i.value === "Dewi"), "deleted");
  assert(!$$(O, "#staffTable tbody tr").some((r) => /Owner/.test(r.textContent) && r.querySelector(".st-del")), "owner row has no delete/disable");

  // 12) owner changes own password (needs the current one), signs out, signs back in
  $(O, "#opCur").value = "nope"; $(O, "#opNew").value = "owner-new-password-1"; $(O, "#opNew2").value = "owner-new-password-1"; click($(O, "#opGo")); await sleep(80);
  assert(/Current password is wrong/.test(text(O, "#ownerMsg")), "wrong current password");
  $(O, "#opCur").value = "ownerpass12345"; click($(O, "#opGo")); await sleep(80);
  assert(/Owner password changed/.test(text(O, "#ownerMsg")), "owner password changed");
  click($(O, "#switchRoleBtn")); await sleep(60);
  assert(!$(O, "#viewRole").hidden && $(O, "#app").hidden, "sign out returns to sign-in");
  await signIn(O, "Owner", "ownerpass12345"); assert(/Wrong name or password/.test(text(O, "#roleErr")), "old owner password dead");

  // 13) owner forgot password: e-mailed code is the proof of mailbox
  click($(O, "#forgotOwner")); assert(!$(O, "#recoverForm").hidden && /c•••u@gmail\.com/.test(text(O, "#rcTo")), "masked mailbox shown: " + text(O, "#rcTo"));
  assert(!/chrisanto\.pangestu@gmail\.com/.test($(O, "#recoverForm").textContent), "full address not displayed");
  click($(O, "#rcSend")); await sleep(60);
  assert.deepStrictEqual(otpRequests, ["chrisanto.pangestu@gmail.com"], "code requested for the owner mailbox only");
  assert(!$(O, "#rcStep2").hidden, "code box shown");
  $(O, "#rcCode").value = "000000"; click($(O, "#rcVerify")); await sleep(60);
  assert(/wrong or has expired/.test(text(O, "#rcMsg")) && $(O, "#rcStep3").hidden, "wrong code rejected");
  // the reset rpc itself refuses before the code is verified
  res = await makeClient().rpc("demo_owner_recover", { p_new: "an-unverified-attempt-1" }); assert(res.error, "recover refused without a verified mailbox");
  $(O, "#rcCode").value = "123456"; click($(O, "#rcVerify")); await sleep(60);
  assert(!$(O, "#rcStep3").hidden, "verified -> new password step");
  $(O, "#rcNew").value = "short"; $(O, "#rcNew2").value = "short"; click($(O, "#rcSet")); await sleep(60);
  assert(/at least 12/.test(text(O, "#rcMsg")), "short owner password refused");
  $(O, "#rcNew").value = "recovered-owner-pw-1"; $(O, "#rcNew2").value = "recovered-owner-pw-1"; click($(O, "#rcSet")); await sleep(80);
  assert(!$(O, "#signinForm").hidden && /Owner password reset/.test(text(O, "#roleErr")), "back at sign-in with a success note");
  await signIn(O, "Owner", "recovered-owner-pw-1"); assert(!$(O, "#app").hidden && /Owner · Owner/.test(text(O, "#roleLabel")), "recovered password works");
  assert(!O.sessionStorage.getItem("demoTok"), "owner token never persisted");


  // ================= v6 =================
  const tabO = (v) => click($$(O, ".tab-btn").find((b) => b.dataset.view === v));
  // 14) tables: 40 by default (30-50 allowed)
  assert.strictEqual($$(X, "#tableSelect option").length, 40, "waiter picks from 40 tables");
  assert.strictEqual($$(X, "#tableSelect option").pop().value, "Table 40", "last table is Table 40");
  // 15) owner changes room: hot + cold kitchen, 35 tables; bounds enforced
  tabO("owner"); await sleep(80); click($(O, "#ownerRefresh")); await sleep(100);
  const roomRow = () => $$(O, "#ownerRooms tbody tr").find((r) => r.querySelector("b") && r.querySelector("b").textContent === code);
  let rr = roomRow(); assert(rr, "room row");
  rr.querySelector(".rm-mode").value = "SPLIT"; rr.querySelector(".rm-tables").value = "29"; click(rr.querySelector(".rm-save")); await sleep(120);
  assert(/between 30 and 50/.test(text(O, "#ownerMsg")), "29 tables refused: " + text(O, "#ownerMsg"));
  rr = roomRow(); rr.querySelector(".rm-mode").value = "SPLIT"; rr.querySelector(".rm-tables").value = "35"; click(rr.querySelector(".rm-save")); await sleep(150);
  assert.strictEqual(db.demo_sessions[0].kitchen_mode, "SPLIT"); assert.strictEqual(db.demo_sessions[0].table_count, 35);
  assert.strictEqual($$(O, "#tableSelect option").length, 35, "owner window now has 35 tables");
  assert(/Cold Kitchen/.test($$(O, ".tab-btn").filter((b) => b.dataset.view === "cold").map((b) => (b.hidden ? "HIDDEN" : b.textContent)).join()), "cold kitchen tab visible in a split room");
  // 16) menu: owner renames + reprices an item and adds a Cold-kitchen category + a drink
  click($$(O, ".tab-btn").find((b) => b.dataset.view === "owner")); await sleep(50);
  const catBox = () => $$(O, "#menuEdit .mn-cat");
  assert.strictEqual(catBox().length, 2, "menu editor shows 2 categories");
  const rice = $$(O, "#menuEdit .mn-iname").find((i) => i.value === "Sample Fried Rice"); rice.value = "Nasi Goreng Special"; rice.dispatchEvent(new O.Event("input", { bubbles: true }));
  const price = rice.closest("tr").querySelector(".mn-iprice"); price.value = "50000"; price.dispatchEvent(new O.Event("input", { bubbles: true }));
  click($(O, "#mnAddCat")); await sleep(30);
  let nc = catBox().pop(); const cn = nc.querySelector(".mn-cname"); cn.value = "Cold Plates"; cn.dispatchEvent(new O.Event("input", { bubbles: true }));
  const cs = nc.querySelector(".mn-cstation"); cs.value = "COLD"; cs.dispatchEvent(new O.Event("change", { bubbles: true }));
  click(nc.querySelector(".mn-iadd")); await sleep(30);
  nc = catBox().pop(); const ni = nc.querySelector(".mn-iname"); ni.value = "Garden Salad"; ni.dispatchEvent(new O.Event("input", { bubbles: true }));
  const np = nc.querySelector(".mn-iprice"); np.value = "25000"; np.dispatchEvent(new O.Event("input", { bubbles: true }));
  const bad = nc.querySelector(".mn-iprice"); bad.value = "12.5"; bad.dispatchEvent(new O.Event("input", { bubbles: true }));
  click($(O, "#mnSave")); await sleep(100); assert(/whole number/.test(text(O, "#ownerMsg")), "fractional price refused in the page");
  nc.querySelector(".mn-iprice").value = "25000"; nc.querySelector(".mn-iprice").dispatchEvent(new O.Event("input", { bubbles: true }));
  click($(O, "#mnSave")); await sleep(150);
  assert(/Menu saved/.test(text(O, "#ownerMsg")), "menu saved: " + text(O, "#ownerMsg"));
  assert(menuDb.categories.length === 3 && menuDb.categories[0].items[0].name === "Nasi Goreng Special" && menuDb.categories[0].items[0].price === 50000, "db has renamed + repriced item");
  assert.strictEqual(menuDb.categories[0].items[0].id, u7(11), "item id stays the same on rename");
  // 17) a waiter opening Order Entry sees the new menu (reloaded when the tab opens)
  const tabA = (v) => click($$(X, ".tab-btn").find((b) => b.dataset.view === v));
  tabA("pos"); await sleep(40); tabA("order"); await sleep(120);
  const names = $$(X, "#menuByCategory .card .name").map((n) => n.textContent);
  assert(names.includes("Nasi Goreng Special") && names.includes("Garden Salad") && !names.includes("Sample Fried Rice"), "waiter sees edited menu: " + names.join("|"));
  assert($$(X, "#menuByCategory .add-item").length === names.length, "every item has an Add to order button");
  // 18) order routing in a split room: salad -> cold board, nasi -> hot kitchen board, tea -> bar
  ITEM.n1 = "Nasi Goreng Special"; ITEM.s1 = "Garden Salad";
  addItem(X, "n1", "none"); addItem(X, "s1"); addItem(X, "d1"); await sendTo(X, "Table 35");
  const o35 = db.demo_orders.filter((o) => o.table_name === "Table 35").pop(); assert(o35, "order for Table 35");
  const st = (n) => db.demo_order_items.filter((i) => i.order_id === o35.id && i.item_name === n).map((i) => i.station)[0];
  assert.strictEqual(st("Nasi Goreng Special"), "KITCHEN"); assert.strictEqual(st("Garden Salad"), "COLD"); assert.strictEqual(st("Sample Iced Tea"), "BAR");
  tabO("kitchen"); await sleep(80);
  assert(/Nasi Goreng/.test(text(O, "#kitchenBoard")) && !/Garden Salad/.test(text(O, "#kitchenBoard")), "hot board has the nasi only");
  tabO("cold"); await sleep(80);
  assert(/Garden Salad/.test(text(O, "#coldBoard")) && !/Nasi Goreng/.test(text(O, "#coldBoard")), "cold board has the salad only");
  tabO("bar"); await sleep(80); assert(/Iced Tea/.test(text(O, "#barBoard")) && !/Garden Salad/.test(text(O, "#barBoard")), "bar has only the drink");
  // 19) switching the room back to ONE kitchen merges cold into the single kitchen screen
  tabO("owner"); await sleep(60); click($(O, "#ownerRefresh")); await sleep(100);
  rr = roomRow(); rr.querySelector(".rm-mode").value = "ONE"; rr.querySelector(".rm-tables").value = "50"; click(rr.querySelector(".rm-save")); await sleep(150);
  assert.strictEqual($$(O, "#tableSelect option").length, 50, "now 50 tables");
  assert($$(O, ".tab-btn").find((b) => b.dataset.view === "cold").hidden, "cold tab hidden again in a one-kitchen room");
  tabO("kitchen"); await sleep(80);
  assert(/Nasi Goreng/.test(text(O, "#kitchenBoard")) && /Garden Salad/.test(text(O, "#kitchenBoard")), "one-kitchen room shows hot + cold on the kitchen screen");

  // 20) custom role: owner creates "Cashier" (POS only, may take payment, cannot void) and assigns a person
  tabO("owner"); await sleep(60);
  click($(O, "#rlNew")); await sleep(30);
  $(O, "#rlLabel").value = "Cashier";
  $$(O, ".rl-view").forEach((c) => { c.checked = c.dataset.v === "pos"; });
  $(O, "#rlPay").checked = true; $(O, "#rlVoid").checked = false; $(O, "#rlXl").checked = false;
  click($(O, "#rlSave")); await sleep(150);
  assert(roles.CASHIER && roles.CASHIER.pay && !roles.CASHIER.void && roles.CASHIER.views.join() === "pos", "custom role stored");
  assert($$(O, "#stRole option").some((o) => o.value === "CASHIER"), "custom role offered when adding staff");
  await addStaff("Cici", "CASHIER", "tmp-cashier-1");
  const E1 = await join("E1"); await firstLogin(E1, "Cici", "tmp-cashier-1", "cashier-own-pw1");
  assert.strictEqual(visibleTabs(E1), "pos", "cashier sees only POS: " + visibleTabs(E1));
  const cTok = tokenOf("Cici");
  const o1 = db.demo_orders.filter((o) => o.status === "OPEN")[0] || o35;
  res = await makeClient().rpc("demo_void_order", { p_order_id: o35.id, p_reason: "cashier tries", p_token: cTok });
  assert(res.error && /cannot void/.test(res.error.message), "cashier cannot void yet");
  // owner flips the void permission: the SAME token works immediately
  const rsel = $(O, "#rlSel"); rsel.value = "CASHIER"; rsel.dispatchEvent(new O.Event("change", { bubbles: true })); await sleep(30);
  assert.strictEqual($(O, "#rlLabel").value, "Cashier"); $(O, "#rlVoid").checked = true; click($(O, "#rlSave")); await sleep(150);
  assert(roles.CASHIER.void === true, "void permission granted");
  res = await makeClient().rpc("demo_void_order", { p_order_id: o35.id, p_reason: "cashier now may", p_token: cTok });
  assert(!res.error, "same token can void once the owner allowed it: " + (res.error && res.error.message));
  // delete rules: cannot delete while held, built-ins have no delete button, free role can go
  assert($(O, "#rlDel").hidden === false, "custom role has a delete button");
  // v9: a standard role can be deleted too (when nobody holds it) and brought back with "Restore default roles"
  rsel.value = "WAITER"; rsel.dispatchEvent(new O.Event("change", { bubbles: true })); await sleep(30);
  assert($(O, "#rlDel").hidden === false, "built-in role has a delete button too");
  click($(O, "#rlDel")); await sleep(30); $(O, "#modalInput").value = "Waiter"; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(120);
  assert(roles.WAITER && /still use this role/.test(text(O, "#modalErr") + text(O, "#ownerMsg")), "a standard role that people hold cannot be deleted: " + text(O, "#modalErr"));
  click($(O, "#modalCancel")); await sleep(30);
  rsel.value = "COLD_KITCHEN"; rsel.dispatchEvent(new O.Event("change", { bubbles: true })); await sleep(30);
  click($(O, "#rlDel")); await sleep(30); $(O, "#modalInput").value = "Cold Kitchen"; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(150);
  assert(!roles.COLD_KITCHEN, "unused standard role deleted");
  assert(![...$(O, "#rlSel").options].some((o) => o.value === "COLD_KITCHEN") && ![...$(O, "#stRole").options].some((o) => o.value === "COLD_KITCHEN"), "deleted role is gone from the role list and the staff form");
  res = await makeClient().rpc("demo_role_delete", { p_key: "OWNER", p_token: tokenOf("Wati") || watiTok });
  assert(res.error, "the owner role (and non-owners) cannot delete roles");
  click($(O, "#rlRestore")); await sleep(150);
  assert(roles.COLD_KITCHEN && roles.COLD_KITCHEN.builtin === true && [...$(O, "#rlSel").options].some((o) => o.value === "COLD_KITCHEN"), "restore default roles brings it back");
  rsel.value = "CASHIER"; rsel.dispatchEvent(new O.Event("change", { bubbles: true })); await sleep(30);
  rsel.value = "CASHIER"; rsel.dispatchEvent(new O.Event("change", { bubbles: true })); await sleep(30);
  click($(O, "#rlDel")); await sleep(30); $(O, "#modalInput").value = "Cashier"; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(120);
  assert(roles.CASHIER && /still use this role/.test(text(O, "#modalErr") + text(O, "#ownerMsg")), "role in use cannot be deleted: " + text(O, "#modalErr"));
  res = await makeClient().rpc("demo_role_save", { p_key: "OWNER", p_label: "x", p_views: ["order"], p_void: true, p_pay: true, p_export: true, p_token: tokenOf("Wati") || watiTok });
  assert(res.error, "non-owner cannot edit roles");

  // v7: a window whose login was revoked (password reset) falls back to the sign-in screen by itself, no data shown
  assert(!$(A, "#viewRole").hidden && $(A, "#app").hidden, "revoked session returns to sign-in on the next poll");
  assert(/Your session ended/.test(text(A, "#roleErr")), "…with an explanation");

  // ================= v8 =================
  $$(O, ".modal-backdrop").forEach((m) => m.remove());   // stale dialog left by the role-delete check above
  // coordinator can trace what the kitchen/bar finished
  click($$(C, ".tab-btn").find((b) => b.dataset.view === "history")); await sleep(60);
  assert(/Table 1/.test(text(C, "#hsTable")) && /Fried Rice/.test(text(C, "#hsTable")) && /Iced Tea/.test(text(C, "#hsTable")), "coordinator history lists finished items");
  assert(/Koki/.test(text(C, "#hsTable")) && /Barry/.test(text(C, "#hsTable")), "history shows who marked each line ready: " + text(C, "#hsTable").slice(0, 300));
  assert(/Wati/.test(text(C, "#hsTable")), "history shows who served it");
  // kitchen naming follows the room's setup (O's room is a one-kitchen room at this point)
  const kTab = (w) => $$(w, ".tab-btn").find((b) => b.dataset.view === "kitchen").textContent;
  assert.strictEqual(kTab(O), "Hot & Cold Kitchen", "one-kitchen name: " + kTab(O));
  tabO("owner"); await sleep(60); click($(O, "#ownerRefresh")); await sleep(100);
  const opts = () => $$(O, "#menuEdit .mn-cstation")[0].textContent;
  assert(/Goes to: Hot & Cold Kitchen/.test(opts()) && !/Goes to: Cold Kitchen/.test(opts()) && !/Goes to: Hot Kitchen/.test(opts()), "menu editor (one kitchen): " + opts());
  rr = roomRow(); rr.querySelector(".rm-mode").value = "SPLIT"; click(rr.querySelector(".rm-save")); await sleep(200);
  assert.strictEqual(kTab(O), "Hot Kitchen", "split name: " + kTab(O));
  assert(/Goes to: Hot Kitchen/.test(opts()) && /Goes to: Cold Kitchen/.test(opts()), "menu editor (split): " + opts());
  rr = roomRow(); rr.querySelector(".rm-mode").value = "ONE"; click(rr.querySelector(".rm-save")); await sleep(200);
  assert.strictEqual(kTab(O), "Hot & Cold Kitchen"); assert(/Goes to: Hot & Cold Kitchen/.test(opts()), "back to one-kitchen names");
  assert(menuDb.categories.some((c) => c.station === "COLD"), "stored COLD category is not rewritten by merely viewing it");

  // deleting rooms
  const extra = openWindow("Z", URLX); await sleep(30); click($(extra, "#createBtn")); await sleep(120);
  const extraCode = text(extra, "#roomCodeLabel"); assert(extraCode.length === 6 && extraCode !== code, "second room created");
  await signIn(extra, "Wati", "waiter-third-pw1"); assert(!$(extra, "#app").hidden, "a waiter is working in the second room");
  click($(O, "#ownerRefresh")); await sleep(100);
  const rowFor = (c) => $$(O, "#ownerRooms tbody tr").find((r) => r.querySelector("b") && r.querySelector("b").textContent === c);
  assert(rowFor(extraCode) && rowFor(extraCode).querySelector(".rm-del"), "delete button on each room");
  click(rowFor(extraCode).querySelector(".rm-del")); await sleep(30);
  $(O, "#modalInput").value = "WRONG1"; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(60);
  assert(/does not match/.test(text(O, "#modalErr")) && db.demo_sessions.some((r) => r.code === extraCode), "wrong code: room stays");
  $(O, "#modalInput").value = extraCode.toLowerCase(); $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(150);
  assert(!db.demo_sessions.some((r) => r.code === extraCode) && /Deleted room/.test(text(O, "#ownerMsg")), "room deleted: " + text(O, "#ownerMsg"));
  await sleep(250);
  assert(!$(extra, "#viewJoin").hidden && /deleted by the owner/.test(text(extra, "#joinErr")), "a device sitting in the deleted room is sent back to the join screen");
  // sweep: an old empty room goes, rooms with orders stay
  const oldEmpty = { id: uid(), code: "OLD111", kitchen_mode: "ONE", table_count: 40, created_at: new Date(clock - 3600000).toISOString() }; db.demo_sessions.push(oldEmpty);
  click($(O, "#ownerRefresh")); await sleep(100); click($(O, "#roomsSweep")); await sleep(150);
  assert(!db.demo_sessions.some((r) => r.code === "OLD111") && db.demo_sessions.some((r) => r.code === code), "empty room swept, active room kept: " + text(O, "#ownerMsg"));
  // owner deletes the room they are sitting in: back to join screen, still signed in
  const keepCode = code;
  rr = roomRow(); assert(rr && rr.querySelector(".rm-del"));
  click(rr.querySelector(".rm-del")); await sleep(30);
  $(O, "#modalInput").value = keepCode; $(O, "#modalInput").dispatchEvent(new O.Event("input", { bubbles: true })); click($(O, "#modalOk")); await sleep(200);
  assert(!db.demo_sessions.some((r) => r.code === keepCode) && db.demo_orders.length === 0 && db.demo_order_items.length === 0 && db.demo_payments.length === 0, "room and everything in it removed");
  assert(!$(O, "#viewJoin").hidden && $(O, "#app").hidden, "owner lands on the join screen");
  assert.deepStrictEqual(directTableCalls, [], "page must not read/write tables directly: " + directTableCalls.join());
  console.log("ALL DEMO UI CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
