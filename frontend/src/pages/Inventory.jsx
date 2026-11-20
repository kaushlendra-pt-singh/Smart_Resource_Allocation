import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, ErrorText, Field, LocationInput, Modal, NgoName, formatDate, isValidLocation, useAsync } from "../components/ui";

export default function Inventory() {
  const { currentNgoId, isAdminOf, isStaffOf } = useAuth();
  const [filter, setFilter] = useState("");
  const [modal, setModal] = useState(null); // { kind, item }
  const [flash, setFlash] = useState("");

  const invQ = useAsync(
    () => (currentNgoId ? api("/api/inventory", { query: { ngoId: currentNgoId, limit: 200 } }) : Promise.resolve(null)),
    [currentNgoId]
  );
  const items = invQ.data?.data ?? [];
  const canAdmin = isAdminOf(currentNgoId);
  const canDispatch = isStaffOf(currentNgoId);

  // group rows by warehouse for a more natural read
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const map = new Map();
    items
      .filter((i) => !f || i.warehouseName.toLowerCase().includes(f) || i.resourceId?.name?.toLowerCase().includes(f))
      .forEach((i) => {
        if (!map.has(i.warehouseName)) map.set(i.warehouseName, { location: i.location, rows: [] });
        map.get(i.warehouseName).rows.push(i);
      });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items, filter]);

  const done = (text) => {
    setModal(null);
    setFlash(text);
    invQ.reload();
  };

  if (!currentNgoId) {
    return (
      <div className="card">
        <h1>Inventory</h1>
        <p className="muted">You need to be part of an NGO to see its warehouses.</p>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p>
            Warehouses of <NgoName id={currentNgoId} />
          </p>
        </div>
        {canAdmin && <button onClick={() => setModal({ kind: "restock" })}>Add stock</button>}
      </div>

      {flash && <Alert kind="success" onClose={() => setFlash("")}>{flash}</Alert>}
      <ErrorText error={invQ.error} />

      <div className="card small muted" style={{ padding: "10px 16px" }}>
        <strong style={{ color: "var(--text)" }}>How stock is counted:</strong> <em>Total</em> is what's on the shelf.{" "}
        <em>On hold</em> is promised to approved requests. <em>Protected</em> is kept back for your own NGO, so other
        NGOs can't request it. <em>Free</em> is what other NGOs can ask for.
      </div>

      {items.length > 0 && (
        <input
          style={{ maxWidth: 300, marginBottom: 14 }}
          placeholder="Filter by warehouse or item"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      {invQ.loading && <p className="muted">Loading…</p>}
      {!invQ.loading && items.length === 0 && (
        <div className="card empty">
          No stock recorded yet.
          {canAdmin && (
            <>
              {" "}
              <button className="link" onClick={() => setModal({ kind: "restock" })}>
                Add your first warehouse
              </button>
            </>
          )}
        </div>
      )}

      {groups.map(([warehouse, g]) => (
        <div className="card" key={warehouse} style={{ padding: 0 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }} className="row">
            <h2 style={{ margin: 0 }}>{warehouse}</h2>
            <span className="small muted">
              {[g.location?.address, g.location?.city, g.location?.state].filter(Boolean).join(", ")}
            </span>
            <span className="spacer" />
            {canAdmin && (
              <button className="secondary small" onClick={() => setModal({ kind: "restock", item: g.rows[0], newItem: true })}>
                Add item here
              </button>
            )}
          </div>
          <div className="table-wrap">
            <table className="inv">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Total</th>
                  <th className="num">On hold</th>
                  <th className="num">Protected</th>
                  <th className="num">Free</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((i) => (
                  <tr key={i._id}>
                    <td>
                      {i.resourceId?.name ?? "Unknown item"}
                      <span className="small muted"> · {i.resourceId?.unit?.toLowerCase()}</span>
                    </td>
                    <td className="num">{i.totalQuantity}</td>
                    <td className="num">{i.allocatedQuantity}</td>
                    <td className="num">{i.reservedQuantity}</td>
                    <td className="num">
                      <strong>{i.availableQuantity}</strong>
                    </td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        {canAdmin && (
                          <button className="secondary small" onClick={() => setModal({ kind: "restock", item: i })}>
                            Restock
                          </button>
                        )}
                        {canDispatch && (
                          <button className="secondary small" onClick={() => setModal({ kind: "dispatch", item: i })}>
                            Send out
                          </button>
                        )}
                        {canAdmin && (
                          <button className="secondary small" onClick={() => setModal({ kind: "reserve", item: i })}>
                            Protect
                          </button>
                        )}
                        {canAdmin && (
                          <button className="link small" onClick={() => setModal({ kind: "ledger", item: i })}>
                            History
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {modal?.kind === "restock" && (
        <RestockModal
          ngoId={currentNgoId}
          item={modal.item}
          newItem={modal.newItem}
          warehouses={items}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {modal?.kind === "dispatch" && <DispatchModal item={modal.item} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "reserve" && <ReserveModal item={modal.item} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "ledger" && <LedgerModal item={modal.item} onClose={() => setModal(null)} />}
    </>
  );
}

function RestockModal({ ngoId, item, newItem, warehouses, onClose, onDone }) {
  // item set + !newItem -> restock that exact line; item + newItem -> new item in that warehouse
  const fixedLine = item && !newItem;
  const resourcesQ = useAsync(() => api("/api/resources", { query: { limit: 200 } }), []);
  const [form, setForm] = useState({
    resourceId: fixedLine ? item.resourceId?._id : "",
    warehouseName: item?.warehouseName ?? "",
    city: item?.location?.city ?? "",
    state: item?.location?.state ?? "",
    address: item?.location?.address ?? "",
    coordinates: item?.location?.coordinates ?? ["", ""],
    quantity: "",
    notes: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const warehouseNames = [...new Set(warehouses.map((w) => w.warehouseName))];

  // picking an existing warehouse name fills in its location
  const pickWarehouse = (name) => {
    const w = warehouses.find((x) => x.warehouseName === name);
    setForm((f) =>
      w
        ? { ...f, warehouseName: name, city: w.location.city, state: w.location.state, address: w.location.address ?? "", coordinates: w.location.coordinates }
        : { ...f, warehouseName: name }
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    const qty = Number(form.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError("Quantity must be a whole number above zero.");
      return;
    }
    if (!isValidLocation(form.coordinates)) {
      setError("Enter the warehouse's latitude and longitude.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/inventory/restock", {
        method: "POST",
        body: {
          ngoId,
          resourceId: form.resourceId,
          warehouseName: form.warehouseName.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          address: form.address.trim(),
          coordinates: form.coordinates,
          quantity: qty,
          notes: form.notes.trim() || undefined,
        },
      });
      onDone(`Added ${qty} to ${form.warehouseName.trim()}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resources = resourcesQ.data?.data ?? [];

  return (
    <Modal title={fixedLine ? `Restock ${item.resourceId?.name}` : "Add stock"} onClose={onClose}>
      <Alert>{error}</Alert>
      <form onSubmit={submit}>
        {!fixedLine && (
          <Field label="Item" hint={<>Not in the list? <Link to="/resources">Add it to the catalogue</Link> first.</>}>
            <select value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })} required>
              <option value="">Choose an item…</option>
              {resources.map((r) => (
                <option key={r._id} value={r._id}>
                  {r.name} ({r.unit.toLowerCase()})
                </option>
              ))}
            </select>
          </Field>
        )}

        {!item && (
          <>
            <Field label="Warehouse" hint="Pick an existing one or type a new name.">
              <input list="warehouse-names" value={form.warehouseName} onChange={(e) => pickWarehouse(e.target.value)} required />
              <datalist id="warehouse-names">
                {warehouseNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </Field>
            <div className="form-row">
              <Field label="City">
                <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} required />
              </Field>
              <Field label="State">
                <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} required />
              </Field>
            </div>
            <Field label="Street address (optional)">
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <LocationInput label="Warehouse coordinates" value={form.coordinates} onChange={(c) => setForm({ ...form, coordinates: c })} />
          </>
        )}
        {item && (
          <p className="small muted">
            Warehouse: <strong>{item.warehouseName}</strong>, {item.location?.city}
          </p>
        )}

        <div className="form-row">
          <Field label={`Quantity to add${fixedLine ? ` (${item.resourceId?.unit?.toLowerCase()})` : ""}`}>
            <input type="number" min="1" step="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
          </Field>
          <Field label="Note (optional)">
            <input placeholder="e.g. donation from…" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add stock"}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DispatchModal({ item, onClose, onDone }) {
  const max = Math.max(0, item.totalQuantity - item.allocatedQuantity);
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const n = Number(qty);
    if (!Number.isInteger(n) || n <= 0 || n > max) {
      setError(`Enter a whole number between 1 and ${max}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/inventory/dispatch", { method: "POST", body: { inventoryId: item._id, quantity: n, notes: notes.trim() || undefined } });
      onDone(`Sent out ${n} ${item.resourceId?.unit?.toLowerCase()} of ${item.resourceId?.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Send out ${item.resourceId?.name}`} onClose={onClose}>
      <p className="small muted">
        For your own field use. Stock on hold for approved requests can't be sent out here; use the request instead.
        Up to <strong>{max}</strong> can leave {item.warehouseName}.
      </p>
      <Alert>{error}</Alert>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Quantity">
            <input type="number" min="1" max={max} step="1" value={qty} onChange={(e) => setQty(e.target.value)} required autoFocus />
          </Field>
          <Field label="Where is it going? (optional)">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="row">
          <button type="submit" disabled={busy || max === 0}>
            {busy ? "Saving…" : "Send out"}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReserveModal({ item, onClose, onDone }) {
  const [value, setValue] = useState(String(item.reservedQuantity ?? 0));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      setError("Enter a whole number, 0 or more.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/inventory/${item._id}/owner-reserve`, { method: "PATCH", body: { reservedQuantity: n } });
      onDone(`${n} ${item.resourceId?.unit?.toLowerCase()} of ${item.resourceId?.name} is now protected.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Protect ${item.resourceId?.name}`} onClose={onClose}>
      <p className="small muted">
        Protected stock stays visible to other NGOs but they can't request it. Admins of your NGO can still use it.
      </p>
      <Alert>{error}</Alert>
      <form onSubmit={submit}>
        <Field label={`Keep back (${item.resourceId?.unit?.toLowerCase()})`} hint={`Currently ${item.totalQuantity} on the shelf.`}>
          <input type="number" min="0" step="1" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
        </Field>
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

const ACTION_LABEL = {
  RESTOCK: "Restocked",
  RESERVE: "Put on hold",
  CANCEL_RESERVATION: "Hold released",
  DISPATCH: "Sent out",
  ADJUSTMENT: "Protected amount changed",
};

function LedgerModal({ item, onClose }) {
  const [page, setPage] = useState(1);
  const q = useAsync(() => api(`/api/inventory/ledger/${item._id}`, { query: { page, limit: 20 } }), [item._id, page]);
  const rows = q.data?.data ?? [];
  const pg = q.data?.pagination;

  return (
    <Modal title={`History: ${item.resourceId?.name} at ${item.warehouseName}`} onClose={onClose} wide>
      <ErrorText error={q.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th className="num">Qty</th>
              <th>Reference</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {!q.loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No history yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r._id}>
                <td className="small">{formatDate(r.createdAt)}</td>
                <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                <td className="num">{r.quantity > 0 ? `+${r.quantity}` : r.quantity}</td>
                <td className="small">
                  {r.referenceId?.startsWith("ALLOC-") ? (
                    <Link to={`/requests/${r.referenceId}`} className="mono">
                      {r.referenceId}
                    </Link>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small muted">{r.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pg && pg.totalPages > 1 && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Newer
          </button>
          <span className="small muted">
            Page {pg.currentPage} of {pg.totalPages}
          </span>
          <button className="secondary small" disabled={page >= pg.totalPages} onClick={() => setPage(page + 1)}>
            Older
          </button>
        </div>
      )}
    </Modal>
  );
}
