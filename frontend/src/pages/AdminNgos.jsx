import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, forgetNgo, getUsers } from "../api";
import { Alert, ErrorText, StatusBadge, formatDate, useAsync } from "../components/ui";

export default function AdminNgos() {
  const [status, setStatus] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [founders, setFounders] = useState({});

  const listQ = useAsync(
    () =>
      status === "PENDING"
        ? api("/api/ngo/pending", { query: { page, limit: 20 } }).then((r) => ({ ngos: r.data.ngos, pages: r.data.pagination.totalPages }))
        : api("/api/ngo", { query: { status, page, limit: 20 } }).then((r) => ({ ngos: r.data, pages: r.pagination.totalPages })),
    [status, page]
  );

  const ngos = listQ.data?.ngos ?? [];

  useEffect(() => {
    if (ngos.length) getUsers(ngos.map((n) => n.adminId)).then(setFounders).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQ.data]);

  const decide = async (ngo, decision) => {
    if (decision === "REJECTED" && !window.confirm(`Reject ${ngo.name}? This can't be undone.`)) return;
    setBusyId(ngo._id);
    setMsg(null);
    try {
      await api(`/api/ngo/${ngo._id}/verify`, { method: "PATCH", body: { status: decision } });
      forgetNgo(ngo._id);
      setMsg({ kind: "success", text: `${ngo.name} ${decision === "APPROVED" ? "approved" : "rejected"}.` });
      listQ.reload();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>NGO approvals</h1>
          <p>Check the documents, then approve or reject. Approving makes the applicant the NGO's owner.</p>
        </div>
      </div>

      <div className="tabs">
        {["PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            className={status === s ? "active" : ""}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {msg && <Alert kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <ErrorText error={listQ.error} />

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>NGO</th>
                <th>Applicant</th>
                <th>Documents</th>
                <th>Submitted</th>
                <th>{status === "PENDING" ? "" : "Status"}</th>
              </tr>
            </thead>
            <tbody>
              {listQ.loading && (
                <tr>
                  <td colSpan={5} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {!listQ.loading && ngos.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    {status === "PENDING" ? "Nothing waiting for review." : "None."}
                  </td>
                </tr>
              )}
              {!listQ.loading &&
                ngos.map((n) => (
                  <tr key={n._id}>
                    <td>
                      <Link to={`/ngos/${n._id}`}>{n.name}</Link>
                      <div className="small muted mono">{n.registrationNumber}</div>
                      <div className="small muted">{n.location?.address}</div>
                    </td>
                    <td>
                      {founders[n.adminId]?.name ?? <span className="mono small">{n.adminId}</span>}
                      {founders[n.adminId]?.email && <div className="small muted">{founders[n.adminId].email}</div>}
                    </td>
                    <td className="small">
                      <a href={n.regDoc} target="_blank" rel="noreferrer">
                        Certificate
                      </a>
                      <br />
                      <a href={n.license} target="_blank" rel="noreferrer">
                        Licence
                      </a>
                    </td>
                    <td className="small muted">{formatDate(n.createdAt)}</td>
                    <td className="num">
                      {status === "PENDING" ? (
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <button className="small" disabled={busyId === n._id} onClick={() => decide(n, "APPROVED")}>
                            Approve
                          </button>
                          <button className="danger small" disabled={busyId === n._id} onClick={() => decide(n, "REJECTED")}>
                            Reject
                          </button>
                        </div>
                      ) : (
                        <StatusBadge status={n.verificationStatus} />
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {(listQ.data?.pages ?? 1) > 1 && (
        <div className="row">
          <button className="secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="small muted">
            Page {page} of {listQ.data.pages}
          </span>
          <button className="secondary small" disabled={page >= listQ.data.pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}
