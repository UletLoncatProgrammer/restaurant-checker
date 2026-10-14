import { useCallback, useEffect, useState } from "react";
import Topbar from "../components/Topbar.jsx";
import { api } from "../lib/api";
import { rp } from "../lib/money";
import { useAuth } from "../context/AuthContext.jsx";
import { useSettings } from "../hooks/useSettings";
import { STATIONS, stationName } from "../lib/stations";
import { can, SHORT } from "../lib/permissions";


function useAction(reload) {
  const [msg, setMsg] = useState(null);
  const run = async (fn, ok) => {
    setMsg(null);
    try {
      const out = await fn();
      if (reload) await reload();
      setMsg({ ok: true, text: typeof ok === "function" ? ok(out) : ok || "Saved" });
      return out;
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };
  return [msg, run];
}

function Notice({ msg }) {
  if (!msg) return null;
  return <p className={msg.ok ? "ok-text" : "error-text"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>;
}

// Role names for dropdowns and lists: the server sends key + label; older data only a key.
const roleKey = (r) => r.key || r.role;
const roleLabel = (r) => r.label || r.role;

function Staff() {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", role: "FOH" });
  const [roles, setRoles] = useState([]); // every role of the company
  const reload = useCallback(async () => {
    setList(await api.getUsers());
    const r = await api.getRoles();
    setRoles(r);
    const on = r.filter((x) => x.enabled).map(roleKey);
    setForm((f) => (on.includes(f.role) ? f : { ...f, role: on.includes("FOH") ? "FOH" : on[0] }));
  }, []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  const usable = roles.filter((r) => r.enabled);
  // a person who still holds a removed role keeps it visible in their own dropdown
  const optionsFor = (current) => (usable.some((r) => roleKey(r) === current) ? usable : [...usable, roles.find((r) => roleKey(r) === current) || { key: current, label: current }]);

  return (
    <div className="panel">
      <h2>Staff</h2>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api.createUser(form), (r) => `Created ${r.user.name}. Temporary password (shown once): ${r.temporaryPassword}`).then((r) => r && setForm({ name: "", email: "", role: "FOH" }));
        }}
      >
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} aria-label="Role for the new person">
          {usable.map((r) => <option key={roleKey(r)} value={roleKey(r)}>{roleLabel(r)}</option>)}
        </select>
        <button className="primary" type="submit">Add staff</button>
      </form>
      <Notice msg={msg} />
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id} className={u.active ? "" : "voided"}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select value={u.role} disabled={u.id === user.id} aria-label={`Role of ${u.name}`} onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value }), "Role changed; they were signed out")}>
                  {optionsFor(u.role).map((r) => <option key={roleKey(r)} value={roleKey(r)}>{roleLabel(r)}</option>)}
                </select>
              </td>
              <td>{u.active ? (u.mustChangePassword ? "Temporary password" : "Active") : "Disabled"}</td>
              <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
              <td>
                <button className="small" onClick={() => run(() => api.resetPassword(u.id), (r) => `New temporary password for ${u.name} (shown once): ${r.temporaryPassword}`)}>Reset password</button>{" "}
                {u.id !== user.id && (
                  <button className="small" onClick={() => run(() => api.updateUser(u.id, { active: !u.active }), u.active ? "Disabled" : "Enabled")}>
                    {u.active ? "Disable" : "Enable"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Roles: what each kind of staff member may do (tick-boxes), the company's own roles,
// and switching off built-in roles it doesn't use. Admin always has everything.
function Roles() {
  const [roles, setRoles] = useState([]);
  const [perms, setPerms] = useState([]); // [{ key, label, grantable }]
  const [editing, setEditing] = useState(null); // { key (null = new), label, builtin, picked: [] }
  const reload = useCallback(async () => {
    setRoles(await api.getRoles());
    if (typeof api.getPermissions === "function") setPerms(await api.getPermissions());
  }, []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);

  const remove = (r) => {
    const k = roleKey(r);
    const extra = k === "FOH" || k === "KITCHEN" ? ` Without ${roleLabel(r)} this company cannot run the normal order flow.` : "";
    if (window.confirm(`Remove the ${roleLabel(r)} role from this company?${extra} You can bring it back later.`)) {
      run(() => api.setRoleEnabled(k, false), `${roleLabel(r)} removed`);
    }
  };
  const del = (r) => {
    if (window.confirm(`Delete the role "${roleLabel(r)}"? This cannot be undone.`)) run(() => api.deleteRole(roleKey(r)), `${roleLabel(r)} deleted`);
  };
  const toggle = (p) =>
    setEditing((e) => ({ ...e, picked: e.picked.includes(p) ? e.picked.filter((x) => x !== p) : [...e.picked, p] }));
  async function save() {
    const e = editing;
    const ok = await run(
      () => (e.key ? api.updateRole(e.key, e.builtin ? { permissions: e.picked } : { label: e.label, permissions: e.picked }) : api.createRole(e.label, e.picked)),
      e.key ? `${e.label} saved. People with this role are signed in again with the new screens.` : `Role "${e.label}" created. Give it to staff in the Staff tab.`
    );
    if (ok) setEditing(null);
  }
  const grantable = perms.filter((p) => p.grantable);

  return (
    <div className="panel">
      <h2>Roles</h2>
      <p>
        Each role decides which screens a person sees and what they may do. Change the tick-boxes of a role, make your own
        (for example "Food runner" or "Cashier"), or remove built-in roles you don't use. Admin always has everything.
      </p>
      <button className="primary" onClick={() => setEditing({ key: null, label: "", builtin: false, picked: [] })}>New role</button>
      <Notice msg={msg} />
      {editing && (
        <div className="role-editor">
          <h3>{editing.key ? `Edit ${editing.label}` : "New role"}</h3>
          {editing.builtin ? null : (
            <input value={editing.label} maxLength={40} placeholder="Role name, e.g. Food runner" aria-label="Role name"
              onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
          )}
          {grantable.map((p) => (
            <label key={p.key} className="choice">
              <input type="checkbox" checked={editing.picked.includes(p.key)} onChange={() => toggle(p.key)} aria-label={p.label} />
              <span>{p.label}</span>
            </label>
          ))}
          <div className="admin-form">
            <button className="primary" onClick={save} disabled={!editing.builtin && editing.label.trim().length < 2}>Save role</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      <table>
        <thead><tr><th>Role</th><th>May do</th><th>Active staff</th><th /></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={roleKey(r)} className={r.enabled ? "" : "voided"}>
              <td>{roleLabel(r)}{r.builtin === false ? <span className="stock-note"> (your own)</span> : null}</td>
              <td className="stock-note">{(r.permissions || []).map((p) => SHORT[p] || p).join(", ") || "nothing yet"}</td>
              <td>{r.activeStaff}</td>
              <td>
                {roleKey(r) === "ADMIN" ? "Always kept" : (
                  <>
                    {r.enabled !== false && (
                      <button className="small" onClick={() => setEditing({ key: roleKey(r), label: roleLabel(r), builtin: r.builtin !== false, picked: [...(r.permissions || [])] })}>
                        Edit
                      </button>
                    )}{" "}
                    {r.builtin === false ? (
                      <button className="small danger" onClick={() => del(r)}>Delete</button>
                    ) : r.enabled ? (
                      <button className="small danger" onClick={() => remove(r)}>Remove</button>
                    ) : (
                      <button className="small" onClick={() => run(() => api.setRoleEnabled(roleKey(r), true), `${roleLabel(r)} restored`)}>Restore</button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One kitchen screen for hot and cold dishes, or separate Hot Kitchen and Cold Kitchen screens.
function Kitchen() {
  const { kitchenMode } = useSettings();
  const [msg, run] = useAction(null);
  const choose = (mode) =>
    run(() => api.updateSettings({ kitchenMode: mode }), mode === "SPLIT" ? "Hot and cold kitchen are now separate screens" : "Hot and cold dishes now share one kitchen screen");
  return (
    <div className="panel">
      <h2>Kitchen setup</h2>
      <p>Where do cold dishes (salads, desserts, cold drinks made in the kitchen) get made?</p>
      <label className="choice">
        <input type="radio" name="kmode" checked={kitchenMode !== "SPLIT"} onChange={() => choose("ONE")} />
        <span><strong>One kitchen</strong> — hot and cold dishes appear on one screen, "Hot &amp; Cold Kitchen".</span>
      </label>
      <label className="choice">
        <input type="radio" name="kmode" checked={kitchenMode === "SPLIT"} onChange={() => choose("SPLIT")} />
        <span><strong>Separate hot and cold kitchen</strong> — "Hot Kitchen" and "Cold Kitchen" are two screens.</span>
      </label>
      <p className="stock-note">The Bar always has its own screen. Choose where each dish is made in the Menu tab. Open kitchen screens switch immediately.</p>
      <Notice msg={msg} />
    </div>
  );
}

// Tax, service charge (Admin only): the money rules of every bill from now on.
function Billing() {
  const { billing } = useSettings();
  const [form, setForm] = useState(null);
  useEffect(() => { if (billing && !form) setForm({ ...billing }); }, [billing, form]);
  const [msg, run] = useAction(null);
  if (!form) return <div className="panel"><p>Loading…</p></div>;
  const ex = 100000;
  const svc = Math.round((ex * Number(form.servicePercent || 0)) / 100);
  const tax = Math.round(((ex + (form.taxOnService ? svc : 0)) * Number(form.taxPercent || 0)) / 100);
  function save(e) {
    e.preventDefault();
    run(() => api.updateSettings({
      taxLabel: form.taxLabel.trim(),
      taxPercent: Number(form.taxPercent),
      servicePercent: Number(form.servicePercent),
      taxOnService: form.taxOnService,
    }), "Saved. New bills use these rates; bills already paid keep theirs.");
  }
  return (
    <form className="panel" onSubmit={save}>
      <h2>Tax and service charge</h2>
      <p className="stock-note">
        Restaurant meals in Indonesia pay the local restaurant tax (PBJT, often printed as "PB1"), not VAT.
        It is at most 10%; your city's regulation (Perda) sets the exact rate. Check with your accountant.
      </p>
      <div className="admin-form">
        <label>Tax name<input value={form.taxLabel} maxLength={20} onChange={(e) => setForm({ ...form, taxLabel: e.target.value })} aria-label="Tax name" /></label>
        <label>Tax %<input type="number" min="0" max="25" step="0.01" value={form.taxPercent} onChange={(e) => setForm({ ...form, taxPercent: e.target.value })} aria-label="Tax percent" /></label>
        <label>Service charge %<input type="number" min="0" max="25" step="0.01" value={form.servicePercent} onChange={(e) => setForm({ ...form, servicePercent: e.target.value })} aria-label="Service charge percent" /></label>
      </div>
      <label className="choice">
        <input type="checkbox" checked={form.taxOnService} onChange={(e) => setForm({ ...form, taxOnService: e.target.checked })} />
        <span>Charge tax on the service charge too (tax on food + service)</span>
      </label>
      <p className="stock-note">
        Example for food of {rp(ex)} without member discount: service {rp(svc)}, {form.taxLabel || "tax"} {rp(tax)}, total {rp(ex + svc + tax)}.
        A member discount is taken off the food first.
      </p>
      <button className="primary" type="submit">Save</button>
      <Notice msg={msg} />
    </form>
  );
}

// Members: regulars with a discount, found by phone at the till.
function Members() {
  const [list, setList] = useState([]);
  const [q, setQ] = useState("");
  const blank = { name: "", phone: "", discountPercent: "10", note: "" };
  const [form, setForm] = useState(blank);
  const reload = useCallback(async () => setList(await api.getMembers(q.trim())), [q]);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  return (
    <div className="panel">
      <h2>Members</h2>
      <p className="stock-note">At payment the cashier types the member's phone; their discount comes off the food before service and tax.</p>
      <form className="admin-form" onSubmit={(e) => {
        e.preventDefault();
        run(() => api.createMember({ name: form.name, phone: form.phone, discountPercent: Number(form.discountPercent), note: form.note }), (m) => `Member ${m.name} added`)
          .then((r) => r && setForm(blank));
      }}>
        <input placeholder="Name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} required aria-label="Member name" />
        <input placeholder="Phone" inputMode="tel" value={form.phone} maxLength={30} onChange={(e) => setForm({ ...form, phone: e.target.value })} required aria-label="Member phone" />
        <input type="number" min="0.01" max="100" step="0.01" value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} required aria-label="Discount percent" title="Discount %" />
        <input placeholder="Note (optional)" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="Member note" />
        <button className="primary" type="submit">Add member</button>
      </form>
      <input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" style={{ width: "100%", margin: "0.5rem 0" }} />
      <Notice msg={msg} />
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Discount %</th><th>Note</th><th /></tr></thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id} className={m.active ? "" : "switched-off"}>
              <td><SaveOnBlur value={m.name} label={`Name of member ${m.name}`} maxLength={60} onSave={(v) => v && run(() => api.updateMember(m.id, { name: v }), "Saved")} /></td>
              <td><SaveOnBlur value={m.phone} label={`Phone of ${m.name}`} maxLength={30} onSave={(v) => v && run(() => api.updateMember(m.id, { phone: v }), "Saved")} /></td>
              <td style={{ width: "7rem" }}><SaveOnBlur value={String(m.discountPercent)} label={`Discount of ${m.name}`} inputMode="decimal"
                onSave={(v) => run(() => api.updateMember(m.id, { discountPercent: Number(v) }), `${m.name}: discount saved`)} /></td>
              <td><SaveOnBlur value={m.note} label={`Note for ${m.name}`} maxLength={200} onSave={(v) => run(() => api.updateMember(m.id, { note: v }), "Saved")} /></td>
              <td>
                {m.active
                  ? <button className="small" onClick={() => run(() => api.updateMember(m.id, { active: false }), `${m.name} switched off`)}>Switch off</button>
                  : <button className="small primary" onClick={() => run(() => api.updateMember(m.id, { active: true }), `${m.name} is a member again`)}>Switch on</button>}
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={5}>No members yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Tables() {
  const [tables, setTables] = useState([]);
  const [label, setLabel] = useState("");
  const reload = useCallback(async () => setTables(await api.getTables()), []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  return (
    <div className="panel">
      <h2>Tables</h2>
      <form className="admin-form" onSubmit={(e) => { e.preventDefault(); run(() => api.createTable(label), "Table added").then((r) => r && setLabel("")); }}>
        <input placeholder="New table name, e.g. Table 12" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={30} />
        <button className="primary" type="submit">Add table</button>
      </form>
      <Notice msg={msg} />
      <div className="chip-row">
        {tables.map((t) => (
          <span key={t.id} className="chip">
            {t.label}{" "}
            <button className="small" title="Take out of service" onClick={() => run(() => api.updateTable(t.id, { active: false }), `${t.label} removed`)}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

// A text box that saves itself when you leave it (or press Enter) and the value changed.
function SaveOnBlur({ value, onSave, label, ...rest }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const commit = () => { if (String(v).trim() !== String(value ?? "").trim()) onSave(String(v).trim()); };
  return (
    <input value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} {...rest} />
  );
}

// The whole menu: categories (name, waiters' note hint, where their dishes are made)
// and dishes (name, price, where made, spice choice, stock counting, on/off).
function Menu() {
  const [cats, setCats] = useState([]);
  const [catName, setCatName] = useState("");
  const blank = { name: "", price: "", categoryId: "", station: "KITCHEN", trackStock: false, spiceOption: false };
  const [item, setItem] = useState(blank);
  const reload = useCallback(async () => setCats(await api.getCategories(true)), []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  const savePrice = (m, raw) => {
    const price = Number(raw);
    if (!raw || !Number.isFinite(price) || price < 0) return run(() => Promise.reject(new Error("Price must be a number")), "");
    return run(() => api.updateMenuItem(m.id, { price }), `${m.name}: price saved`);
  };
  return (
    <div className="panel">
      <h2>Menu</h2>
      <form className="admin-form" onSubmit={(e) => { e.preventDefault(); run(() => api.createCategory(catName), "Category added").then((r) => r && setCatName("")); }}>
        <input placeholder="New category" value={catName} onChange={(e) => setCatName(e.target.value)} required maxLength={60} />
        <button className="primary" type="submit">Add category</button>
      </form>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          const { name, price, categoryId, station, trackStock, spiceOption } = item;
          run(() => api.createMenuItem({ name, price: Number(price), categoryId: categoryId || null, station, trackStock, spiceOption }), "Dish added")
            .then((r) => r && setItem({ ...item, name: "", price: "" }));
        }}
      >
        <input placeholder="Dish name" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} required maxLength={80} />
        <input type="number" min="0" step="any" placeholder="Price" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} required />
        <select value={item.categoryId} onChange={(e) => setItem({ ...item, categoryId: e.target.value })} required>
          <option value="">Category…</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={item.station} onChange={(e) => setItem({ ...item, station: e.target.value })} aria-label="Made in">
          {STATIONS.map((st) => <option key={st} value={st}>Made in: {stationName(st)}</option>)}
        </select>
        <label className="choice" style={{ margin: 0 }}>
          <input type="checkbox" checked={item.spiceOption} onChange={(e) => setItem({ ...item, spiceOption: e.target.checked })} />
          <span>Ask spicy / not spicy</span>
        </label>
        <label className="choice" style={{ margin: 0 }}>
          <input type="checkbox" checked={item.trackStock} onChange={(e) => setItem({ ...item, trackStock: e.target.checked })} />
          <span>Count stock</span>
        </label>
        <button className="primary" type="submit">Add dish</button>
      </form>
      <Notice msg={msg} />
      {cats.map((c) => {
        const activeCount = c.menuItems.filter((m) => m.active !== false).length;
        return (
          <div key={c.id} className="order-block">
            <div className="admin-form" style={{ alignItems: "center" }}>
              <SaveOnBlur value={c.name} label={`Name of category ${c.name}`} maxLength={60} style={{ fontWeight: 700 }}
                onSave={(v) => v && run(() => api.updateCategory(c.id, { name: v }), "Category renamed")} />
              <SaveOnBlur value={c.noteHint} label={`Note hint for ${c.name}`} maxLength={80} placeholder="Hint for waiters' notes, e.g. less sugar, less ice"
                onSave={(v) => run(() => api.updateCategory(c.id, { noteHint: v }), "Note hint saved")} />
              <select value="" aria-label={`Where all dishes of ${c.name} are made`}
                onChange={(e) => e.target.value && run(() => api.updateCategory(c.id, { station: e.target.value }), `All dishes in ${c.name} now go to ${stationName(e.target.value)}`)}>
                <option value="">Move all dishes to…</option>
                {STATIONS.map((st) => <option key={st} value={st}>{stationName(st)}</option>)}
              </select>
              {activeCount === 0 && (
                <button className="small" onClick={() => run(() => api.deleteCategory(c.id), "Category removed")}>Remove empty category</button>
              )}
            </div>
            <table>
              <tbody>
                {c.menuItems.map((m) => {
                  const on = m.active !== false;
                  return (
                    <tr key={m.id} className={on ? "" : "switched-off"}>
                      <td><SaveOnBlur value={m.name} label={`Name of ${m.name}`} maxLength={80} onSave={(v) => v && run(() => api.updateMenuItem(m.id, { name: v }), "Name saved")} /></td>
                      <td style={{ width: "8rem" }}><SaveOnBlur value={String(Number(m.price))} label={`Price of ${m.name}`} inputMode="decimal" onSave={(v) => savePrice(m, v)} /></td>
                      <td>
                        <select value={m.station} aria-label={`Station for ${m.name}`} onChange={(e) => run(() => api.updateMenuItem(m.id, { station: e.target.value }), `${m.name} now goes to ${stationName(e.target.value)}`)}>
                          {STATIONS.map((st) => <option key={st} value={st}>{stationName(st)}</option>)}
                        </select>
                      </td>
                      <td>
                        <label className="choice" style={{ margin: 0 }}>
                          <input type="checkbox" checked={!!m.spiceOption} aria-label={`Spicy choice for ${m.name}`}
                            onChange={(e) => run(() => api.updateMenuItem(m.id, { spiceOption: e.target.checked }), e.target.checked ? `Waiters will ask spicy / not spicy for ${m.name}` : `No spice choice for ${m.name}`)} />
                          <span>Spicy?</span>
                        </label>
                      </td>
                      <td>
                        <label className="choice" style={{ margin: 0 }} title="Count how many are left (bottled drinks, portions). Add deliveries in Dashboard > Stock.">
                          <input type="checkbox" checked={!!m.trackStock} aria-label={`Count stock for ${m.name}`}
                            onChange={(e) => run(() => api.updateMenuItem(m.id, { trackStock: e.target.checked }), e.target.checked ? `Counting stock for ${m.name}: add the first delivery in Dashboard > Stock` : `Stopped counting stock for ${m.name}`)} />
                          <span>Count stock</span>
                        </label>
                      </td>
                      <td>
                        {on
                          ? <button className="small" onClick={() => run(() => api.updateMenuItem(m.id, { active: false }), `${m.name} switched off (waiters no longer see it)`)}>Switch off</button>
                          : <button className="small primary" onClick={() => run(() => api.updateMenuItem(m.id, { active: true }), `${m.name} is back on the menu`)}>Switch on</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  // each tab and the permission it needs
  const tabs = [["staff", "Staff", "STAFF"], ["roles", "Roles", "STAFF"], ["billing", "Billing", "STAFF"], ["members", "Members", "MEMBERS"],
    ["menu", "Menu", "MENU"], ["tables", "Tables", "MENU"], ["kitchen", "Kitchen", "MENU"]]
    .filter(([, , perm]) => can(user, perm));
  const [tab, setTab] = useState(tabs.length ? tabs[0][0] : "menu");
  const allowed = (t) => tabs.some(([k]) => k === t);
  return (
    <>
      <Topbar title="Admin" />
      <div className="container">
        <div className="tabs">
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? "primary" : ""} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === "staff" && allowed("staff") && <Staff />}
        {tab === "roles" && allowed("roles") && <Roles />}
        {tab === "menu" && allowed("menu") && <Menu />}
        {tab === "tables" && allowed("tables") && <Tables />}
        {tab === "kitchen" && allowed("kitchen") && <Kitchen />}
        {tab === "billing" && allowed("billing") && <Billing />}
        {tab === "members" && allowed("members") && <Members />}
      </div>
    </>
  );
}
