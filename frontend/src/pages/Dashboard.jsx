import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { NgoName, StatusBadge, useAsync } from "../components/ui";

export default function Dashboard() {
  const { user, memberships, currentNgoId, isSuper, isAdminOf, reloadUser } = useAuth();
  const inNgo = memberships.length > 0;

  const counts = useAsync(async () => {
    const out = {};
    if (currentNgoId) {
      const [incoming, mine] = await Promise.all([
        api("/allocation/api/requests", { query: { view: "incoming", status: "PENDING", ngoId: currentNgoId, limit: 1 } }),
        api("/allocation/api/requests", { query: { view: "mine", ngoId: currentNgoId, limit: 1 } }),
      ]);
      out.incomingPending = incoming.pagination.totalItems;
      out.sent = mine.pagination.totalItems;
      const inv = await api("/api/inventory", { query: { ngoId: currentNgoId, limit: 1 } });
      out.warehouses = inv.pagination.totalItems;
    }
    if (isSuper) {
      const pending = await api("/api/ngo/pending", { query: { limit: 1 } });
      out.pendingNgos = pending.data.pagination.totalNGOs;
    }
    return out;
  }, [currentNgoId, isSuper]);

  const c = counts.data ?? {};

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hello, {user.name.split(" ")[0]}</h1>
          <p>
            {currentNgoId ? (
              <>
                Working as <NgoName id={currentNgoId} />
                {isAdminOf(currentNgoId) ? " (admin)" : ""}
              </>
            ) : isSuper ? (
              "Super admin"
            ) : (
              "You're not part of an NGO yet."
            )}
          </p>
        </div>
      </div>

      {!inNgo && !isSuper && (
        <div className="card">
          <h2>Getting started</h2>
          <p>To manage stock you need to belong to an NGO. You can either:</p>
          <ul>
            <li>
              <Link to="/ngos/new">Register your NGO</Link>. A super admin reviews it, and once it's approved you
              become its owner.
            </li>
            <li>
              Ask an NGO admin to add you. They'll need your email: <strong>{user.email}</strong>
            </li>
          </ul>
          <p className="small muted">
            Already approved or added?{" "}
            <button className="link small" onClick={() => reloadUser()}>
              Refresh my access
            </button>
          </p>
        </div>
      )}

      {counts.error && <p className="small muted">Couldn't load summary: {counts.error.message}</p>}

      <div className="grid grid-3">
        {currentNgoId && (
          <>
            <Link to="/requests?view=incoming" className="card" style={{ textDecoration: "none", color: "inherit" }}>
              <div className="muted small">Incoming requests waiting</div>
              <div className="stat">{c.incomingPending ?? "–"}</div>
            </Link>
            <Link to="/requests" className="card" style={{ textDecoration: "none", color: "inherit" }}>
              <div className="muted small">Requests sent by this NGO</div>
              <div className="stat">{c.sent ?? "–"}</div>
            </Link>
            <Link to="/inventory" className="card" style={{ textDecoration: "none", color: "inherit" }}>
              <div className="muted small">Stock lines in warehouses</div>
              <div className="stat">{c.warehouses ?? "–"}</div>
            </Link>
          </>
        )}
        {isSuper && (
          <Link to="/admin/ngos" className="card" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="muted small">NGOs waiting for approval</div>
            <div className="stat">{c.pendingNgos ?? "–"}</div>
          </Link>
        )}
      </div>

      {inNgo && (
        <div className="card">
          <h2>Your NGOs</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>NGO</th>
                  <th>Your role</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.ngoId}>
                    <td>
                      <Link to={`/ngos/${m.ngoId}`}>
                        <NgoName id={m.ngoId} />
                      </Link>
                      {user.ngoId === m.ngoId && <span className="badge" style={{ marginLeft: 8 }}>Owner</span>}
                    </td>
                    <td>
                      <StatusBadge status={m.roleInNGO} />
                    </td>
                    <td className="num">
                      <Link to={`/ngos/${m.ngoId}`} className="small">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {currentNgoId && (
        <div className="card">
          <h2>Quick actions</h2>
          <div className="row">
            <Link to="/allocate" className="btn">
              Request stock
            </Link>
            {isAdminOf(currentNgoId) && (
              <Link to="/inventory" className="btn secondary">
                Add stock to a warehouse
              </Link>
            )}
            <Link to="/requests?view=incoming" className="btn secondary">
              Review incoming requests
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
