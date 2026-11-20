import { useState } from "react";
import { api, getResourceMap } from "../api";
import { useAuth } from "../auth";
import { Alert, ErrorText, Field, Modal, NgoName, useAsync } from "../components/ui";

export const CATEGORIES = ["FOOD", "MEDICAL", "SHELTER", "CLOTHING", "WATER", "OTHER"];
export const UNITS = ["KG", "LITERS", "BOXES", "UNITS", "PACKETS"];

const pretty = (s) => s.charAt(0) + s.slice(1).toLowerCase();

export default function Resources() {
  const { user } = useAuth();
  const canCreate = ["NGO_ADMIN", "SUPER_ADMIN"].includes(user.role);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ search: "", category: "" });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);

  const listQ = useAsync(() => api("/api/resources", { query: { ...query, limit: 100 } }), [query]);
  const resources = listQ.data?.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Resources</h1>
          <p>The shared catalogue of relief items. Every NGO stocks items from this list.</p>
        </div>
        {canCreate && (
          <button onClick={() => setCreating(true)}>Add a resource</button>
        )}
      </div>

      <form
        className="row"
        style={{ marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ ...query, search: search.trim() });
        }}
      >
        <input style={{ maxWidth: 280 }} placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={{ width: "auto" }} value={query.category} onChange={(e) => setQuery({ ...query, category: e.target.value })}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {pretty(c)}
            </option>
          ))}
        </select>
        <button type="submit" className="secondary">
          Search
        </button>
      </form>

      <ErrorText error={listQ.error} />

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Unit</th>
                <th>Perishable</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!listQ.loading && resources.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No resources found.
                  </td>
                </tr>
              )}
              {resources.map((r) => (
                <tr key={r._id}>
                  <td>
                    {r.name}
                    {r.description && r.description !== "No description given" && (
                      <div className="small muted">{r.description}</div>
                    )}
                  </td>
                  <td>{pretty(r.category)}</td>
                  <td>{r.unit.toLowerCase()}</td>
                  <td>{r.isPerishable ? "Yes" : "No"}</td>
                  <td className="num">
                    <button className="secondary small" onClick={() => setOpenId(r._id)}>
                      Stock
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <CreateResource
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            getResourceMap(true).catch(() => {});
            listQ.reload();
          }}
        />
      )}
      {openId && <ResourceStock resourceId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function CreateResource({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", category: "FOOD", unit: "KG", desc: "", perishable: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/resources", { method: "POST", body: { ...form, name: form.name.trim() } });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a resource" onClose={onClose}>
      <Alert>{error}</Alert>
      <form onSubmit={submit}>
        <Field label="Name" hint="Be specific, e.g. “Rice (5 kg bag)” rather than “Food”.">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
        </Field>
        <div className="form-row">
          <Field label="Category">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {pretty(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Counted in">
            <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description (optional)">
          <input value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.perishable} onChange={(e) => setForm({ ...form, perishable: e.target.checked })} />
          Perishable
        </label>
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add resource"}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResourceStock({ resourceId, onClose }) {
  const q = useAsync(() => api(`/api/resources/${resourceId}`).then((r) => r.data), [resourceId]);
  const d = q.data;
  const unit = d?.resource?.unit?.toLowerCase() ?? "";

  return (
    <Modal title={d?.resource?.name ?? "Stock"} onClose={onClose} wide>
      <ErrorText error={q.error} />
      {q.loading && <p className="muted">Loading…</p>}
      {d && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            <div>
              <div className="small muted">In warehouses</div>
              <div className="stat">
                {d.stockSummary.totalQuantity} <span className="small muted">{unit}</span>
              </div>
            </div>
            <div>
              <div className="small muted">Free for other NGOs</div>
              <div className="stat">{d.stockSummary.availableQuantity}</div>
            </div>
            <div>
              <div className="small muted">On hold for requests</div>
              <div className="stat">{d.stockSummary.allocatedQuantity}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Warehouse</th>
                  <th>NGO</th>
                  <th className="num">Total</th>
                  <th className="num">Protected</th>
                  <th className="num">On hold</th>
                  <th className="num">Free</th>
                </tr>
              </thead>
              <tbody>
                {d.warehouses.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      Nobody stocks this yet.
                    </td>
                  </tr>
                )}
                {d.warehouses.map((w) => (
                  <tr key={w._id}>
                    <td>
                      {w.warehouseName}
                      <div className="small muted">
                        {w.location?.city}, {w.location?.state}
                      </div>
                    </td>
                    <td>
                      <NgoName id={w.ngoId} />
                    </td>
                    <td className="num">{w.totalQuantity}</td>
                    <td className="num">{w.reservedQuantity}</td>
                    <td className="num">{w.allocatedQuantity}</td>
                    <td className="num">{w.availableQuantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
