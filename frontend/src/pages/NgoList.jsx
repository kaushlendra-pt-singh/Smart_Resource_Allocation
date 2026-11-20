import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorText, StatusBadge, useAsync } from "../components/ui";

export default function NgoList() {
  const { roleIn } = useAuth();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const { data, error, loading } = useAsync(
    () => api("/api/ngo", { query: { search: query, page, limit: 15 } }),
    [query, page]
  );

  const submit = (e) => {
    e.preventDefault();
    setPage(1);
    setQuery(search.trim());
  };

  const ngos = data?.data ?? [];
  const pg = data?.pagination;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>NGOs</h1>
          <p>Approved organisations on the platform.</p>
        </div>
        <Link to="/ngos/new" className="btn">
          Register an NGO
        </Link>
      </div>

      <form className="row" onSubmit={submit} style={{ marginBottom: 16 }}>
        <input
          style={{ maxWidth: 360 }}
          placeholder="Search by name or address"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit" className="secondary">
          Search
        </button>
      </form>

      <ErrorText error={error} />

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Address</th>
                <th>You</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={4} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && ngos.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    {query ? "No NGOs match that search." : "No approved NGOs yet."}
                  </td>
                </tr>
              )}
              {!loading &&
                ngos.map((n) => (
                  <tr key={n._id}>
                    <td>
                      <Link to={`/ngos/${n._id}`}>{n.name}</Link>
                    </td>
                    <td className="muted">{n.category || "—"}</td>
                    <td className="muted">{n.location?.address}</td>
                    <td>{roleIn(n._id) ? <StatusBadge status={roleIn(n._id)} /> : null}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {pg && pg.totalPages > 1 && (
        <div className="row">
          <button className="secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="small muted">
            Page {pg.currentPage} of {pg.totalPages}
          </span>
          <button className="secondary small" disabled={page >= pg.totalPages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}
