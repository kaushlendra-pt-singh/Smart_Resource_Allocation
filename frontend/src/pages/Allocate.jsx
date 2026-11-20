import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getNgo } from "../api";
import { useAuth } from "../auth";
import { Alert, Field, LocationInput, NgoName, StatusBadge, formatKm, isValidLocation, useAsync } from "../components/ui";

const emptyItem = () => ({ key: Math.random().toString(36).slice(2), resourceId: "", requestedQuantity: "", preferredWarehouseName: "" });

export default function Allocate() {
  const { currentNgoId, isSuper, memberships } = useAuth();
  const resourcesQ = useAsync(() => api("/api/resources", { query: { limit: 200 } }), []);
  const resources = resourcesQ.data?.data ?? [];

  const [items, setItems] = useState([emptyItem()]);
  const [target, setTarget] = useState(["", ""]);
  const [radius, setRadius] = useState(50);
  const [partial, setPartial] = useState(true);
  const [urgency, setUrgency] = useState("MEDIUM");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const setItem = (key, patch) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const useNgoLocation = async () => {
    try {
      const ngo = await getNgo(currentNgoId);
      if (ngo?.location?.coordinates) setTarget(ngo.location.coordinates);
    } catch (err) {
      setError(err.message);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setResult(null);
    const cleanItems = items.map((i) => ({
      resourceId: i.resourceId,
      requestedQuantity: Number(i.requestedQuantity),
      preferredWarehouseName: i.preferredWarehouseName.trim() || undefined,
    }));
    if (cleanItems.some((i) => !i.resourceId || !Number.isInteger(i.requestedQuantity) || i.requestedQuantity <= 0)) {
      setError("Each line needs an item and a whole-number quantity.");
      return;
    }
    if (!isValidLocation(target)) {
      setError("Enter where the stock is needed (latitude and longitude).");
      return;
    }
    setBusy(true);
    try {
      const res = await api("/allocation/api/allocate", {
        method: "POST",
        body: {
          requesterNgoId: currentNgoId || undefined,
          items: cleanItems,
          targetLocation: target,
          maxSearchRadiusKm: Number(radius) || 50,
          allowPartialFulfillment: partial,
          urgencyLevel: urgency,
        },
      });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resourceName = (id) => resources.find((r) => r._id === id)?.name ?? "Item";
  const unitOf = (id) => resources.find((r) => r._id === id)?.unit?.toLowerCase() ?? "";

  if (!currentNgoId && !isSuper) {
    return (
      <div className="card">
        <h1>Request stock</h1>
        <p className="muted">Only members of an NGO can request stock.</p>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Request stock</h1>
          <p>
            We look for the nearest warehouses that have it. Stock from your own warehouses is held straight away; stock
            from other NGOs waits for them to approve.
          </p>
        </div>
      </div>

      <div className="grid split">
        <form onSubmit={submit} className="card">
          {memberships.length > 1 && (
            <p className="small muted">
              Requesting for <strong><NgoName id={currentNgoId} /></strong>. Switch NGO in the top bar.
            </p>
          )}
          <Alert>{error}</Alert>

          <h2>What do you need?</h2>
          {items.map((it, idx) => (
            <div className="line-item" key={it.key}>
              <div className="form-row">
                <Field label={`Item ${items.length > 1 ? idx + 1 : ""}`}>
                  <select value={it.resourceId} onChange={(e) => setItem(it.key, { resourceId: e.target.value })} required>
                    <option value="">Choose…</option>
                    {resources.map((r) => (
                      <option key={r._id} value={r._id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Quantity ${unitOf(it.resourceId) ? `(${unitOf(it.resourceId)})` : ""}`}>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={it.requestedQuantity}
                    onChange={(e) => setItem(it.key, { requestedQuantity: e.target.value })}
                    required
                  />
                </Field>
              </div>
              <div className="row">
                <input
                  style={{ flex: 1 }}
                  placeholder="Preferred warehouse (optional)"
                  value={it.preferredWarehouseName}
                  onChange={(e) => setItem(it.key, { preferredWarehouseName: e.target.value })}
                />
                {items.length > 1 && (
                  <button type="button" className="link small" onClick={() => setItems(items.filter((x) => x.key !== it.key))}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
          <button type="button" className="secondary small" onClick={() => setItems([...items, emptyItem()])}>
            + Another item
          </button>

          <hr />
          <h2>Where is it needed?</h2>
          {currentNgoId && (
            <button type="button" className="link small" onClick={useNgoLocation} style={{ marginBottom: 8 }}>
              Use our NGO's office location
            </button>
          )}
          <LocationInput label="Delivery point" value={target} onChange={setTarget} />
          <div className="form-row">
            <Field label="Search radius (km)">
              <input type="number" min="1" max="3000" value={radius} onChange={(e) => setRadius(e.target.value)} />
            </Field>
            <Field label="Urgency">
              <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
            Split across warehouses and accept a partial amount if needed
          </label>
          {!partial && (
            <p className="small muted" style={{ marginTop: -6 }}>
              All or nothing: each item must come complete from a single warehouse, otherwise nothing is requested.
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "Finding stock…" : "Find and request stock"}
          </button>
        </form>

        <div>
          {!result && (
            <div className="card small muted">
              <h3 style={{ color: "var(--text)" }}>What happens next</h3>
              <ol style={{ paddingLeft: 18, margin: 0 }}>
                <li>Warehouses within the radius are ranked by distance.</li>
                <li>Your own stock is put on hold immediately.</li>
                <li>Other NGOs see your request under "Incoming" and approve or reject it.</li>
                <li>Once approved, their team sends it out and marks it dispatched.</li>
              </ol>
            </div>
          )}
          {result && <Result result={result} resourceName={resourceName} unitOf={unitOf} />}
        </div>
      </div>
    </>
  );
}

function Result({ result, resourceName, unitOf }) {
  const saved = result.status !== "failed";
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Result</h2>
        <StatusBadge status={result.status} />
      </div>
      <p>{result.message}</p>
      {saved && (
        <p className="small">
          Reference <span className="mono">{result.referenceId}</span> ·{" "}
          <Link to={`/requests/${result.referenceId}`}>Open request</Link>
        </p>
      )}
      {result.results.map((r) => (
        <div key={r.resourceId} style={{ marginTop: 12 }}>
          <h3>
            {resourceName(r.resourceId)}{" "}
            <span className="small muted">
              {r.totalAllocatedQuantity} of {r.requestedQuantity} {unitOf(r.resourceId)}
            </span>
          </h3>
          {r.allocations.length === 0 ? (
            <p className="small muted">Nothing found for this item.</p>
          ) : (
            <table>
              <tbody>
                {r.allocations.map((a) => (
                  <tr key={a.inventoryId}>
                    <td>
                      {a.warehouseName}
                      <div className="small muted">
                        <NgoName id={a.ngoId} /> · {formatKm(a.distanceKm)}
                      </div>
                    </td>
                    <td className="num">{a.allocatedQuantity}</td>
                    <td className="num">
                      <StatusBadge status={a.lineStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
