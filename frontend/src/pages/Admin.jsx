import { useCallback, useEffect, useState } from "react";
import Topbar from "../components/Topbar.jsx";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext.jsx";
import { useSettings } from "../hooks/useSettings";
import { STATIONS, stationName } from "../lib/stations";

const ROLES = ["ADMIN", "COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"];

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

function Staff() {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", role: "FOH" });
  const [roles, setRoles] = useState(ROLES);
  const reload = useCallback(async () => {
    setList(await api.getUsers());
    const r = await api.getRoles();
    const on = r.filter((x) => x.enabled).map((x) => x.role);
    setRoles(on);
    setForm((f) => (on.includes(f.role) ? f : { ...f, role: on.includes("FOH") ? "FOH" : on[0] }));
  }, []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  // a person who still holds a removed role keeps it visible in their own dropdown
  const optionsFor = (current) => (roles.includes(current) ? roles : [...roles, current]);

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
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {roles.map((r) => <option key={r}>{r}</option>)}
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
                <select value={u.role} disabled={u.id === user.id} onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value }), "Role changed; they were signed out")}>
                  {optionsFor(u.role).map((r) => <option key={r}>{r}</option>)}
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

const ROLE_HELP = {
  ADMIN: "Everything, including staff. Always kept.",
  COORDINATOR: "Floor, dashboard, stock, reports, menu and tables. Cannot void.",
  SUPERVISOR: "Floor and dashboard, and can void items, orders and sales.",
  FOH: "Takes orders, delivers, takes payment.",
  KITCHEN: "Sees tickets and marks them preparing / ready.",
};

function Roles() {
  const [roles, setRoles] = useState([]);
  const reload = useCallback(async () => setRoles(await api.getRoles()), []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  const remove = (r) => {
    const extra = r.role === "FOH" || r.role === "KITCHEN" ? ` Without ${r.role} this company cannot run the normal order flow.` : "";
    if (window.confirm(`Remove the ${r.role} role from this company?${extra} You can bring it back later.`)) {
      run(() => api.setRoleEnabled(r.role, false), `${r.role} removed`);
    }
  };
  return (
    <div className="panel">
      <h2>Roles</h2>
      <p>Remove the roles this company does not use. A role can only be removed when nobody active holds it. Removed roles can be brought back.</p>
      <Notice msg={msg} />
      <table>
        <thead><tr><th>Role</th><th>What it does</th><th>Active staff</th><th /></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.role} className={r.enabled ? "" : "voided"}>
              <td>{r.role}</td>
              <td>{ROLE_HELP[r.role]}</td>
              <td>{r.activeStaff}</td>
              <td>
                {!r.removable ? "Always kept" : r.enabled ? (
                  <button className="small danger" onClick={() => remove(r)}>Remove</button>
                ) : (
                  <button className="small" onClick={() => run(() => api.setRoleEnabled(r.role, true), `${r.role} restored`)}>Restore</button>
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

function Menu() {
  const [cats, setCats] = useState([]);
  const [catName, setCatName] = useState("");
  const [item, setItem] = useState({ name: "", price: "", categoryId: "", station: "KITCHEN" });
  const reload = useCallback(async () => setCats(await api.getCategories()), []);
  const [msg, run] = useAction(reload);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
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
          run(() => api.createMenuItem({ name: item.name, price: Number(item.price), categoryId: item.categoryId || null, station: item.station }), "Dish added")
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
        <button className="primary" type="submit">Add dish</button>
      </form>
      <Notice msg={msg} />
      {cats.map((c) => (
        <div key={c.id} className="order-block">
          <strong>{c.name}</strong>{" "}
          {c.menuItems.length === 0 && (
            <button className="small" onClick={() => run(() => api.deleteCategory(c.id), "Category removed")}>Remove empty category</button>
          )}
          <table>
            <tbody>
              {c.menuItems.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.price}</td>
                  <td>
                    <select value={m.station} aria-label={`Station for ${m.name}`} onChange={(e) => run(() => api.updateMenuItem(m.id, { station: e.target.value }), `${m.name} now goes to ${stationName(e.target.value)}`)}>
                      {STATIONS.map((st) => <option key={st} value={st}>{stationName(st)}</option>)}
                    </select>
                  </td>
                  <td><button className="small" onClick={() => run(() => api.updateMenuItem(m.id, { active: false }), `${m.name} switched off`)}>Switch off</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState(user.role === "ADMIN" ? "staff" : "menu"); // coordinators have no Staff tab
  return (
    <>
      <Topbar title="Admin" />
      <div className="container">
        <div className="tabs">
          {user.role === "ADMIN" && <button className={tab === "staff" ? "primary" : ""} onClick={() => setTab("staff")}>Staff</button>}
          {user.role === "ADMIN" && <button className={tab === "roles" ? "primary" : ""} onClick={() => setTab("roles")}>Roles</button>}
          <button className={tab === "menu" ? "primary" : ""} onClick={() => setTab("menu")}>Menu</button>
          <button className={tab === "tables" ? "primary" : ""} onClick={() => setTab("tables")}>Tables</button>
          <button className={tab === "kitchen" ? "primary" : ""} onClick={() => setTab("kitchen")}>Kitchen</button>
        </div>
        {tab === "staff" && user.role === "ADMIN" && <Staff />}
        {tab === "roles" && user.role === "ADMIN" && <Roles />}
        {tab === "menu" && <Menu />}
        {tab === "tables" && <Tables />}
        {tab === "kitchen" && <Kitchen />}
      </div>
    </>
  );
}
