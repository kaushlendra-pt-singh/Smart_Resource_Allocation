import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, getUsers } from "../api";
import RequestLines from "../components/RequestLines";
import { ErrorText, NgoName, StatusBadge, formatDate, useAsync, useResourceMap } from "../components/ui";

export default function RequestDetail() {
  const { referenceId } = useParams();
  const q = useAsync(() => api(`/allocation/api/requests/${referenceId}`).then((r) => r.data), [referenceId]);
  const resources = useResourceMap();
  const [requester, setRequester] = useState(null);
  const doc = q.data;

  useEffect(() => {
    if (doc?.requestedBy) getUsers([doc.requestedBy]).then((m) => setRequester(m[doc.requestedBy])).catch(() => {});
  }, [doc?.requestedBy]);

  if (q.loading && !doc) return <p className="muted">Loading…</p>;
  if (q.error) return <ErrorText error={q.error} />;

  // how much of each requested item has been planned (any line that isn't rejected/cancelled)
  const planned = {};
  doc.lines
    .filter((l) => !["REJECTED", "CANCELLED"].includes(l.status))
    .forEach((l) => {
      planned[l.resourceId] = (planned[l.resourceId] || 0) + l.quantity;
    });

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small">
            <Link to="/requests">← Requests</Link>
          </p>
          <h1>
            <span className="mono">{doc.referenceId}</span> <StatusBadge status={doc.status} />
          </h1>
          <p>
            Requested by {requester?.name ?? "a team member"} of <NgoName id={doc.requesterNgoId} /> on{" "}
            {formatDate(doc.requestedAt)}
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Asked for</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Requested</th>
                <th className="num">Found / in progress</th>
              </tr>
            </thead>
            <tbody>
              {doc.items.map((it) => (
                <tr key={it.resourceId}>
                  <td>{resources[it.resourceId]?.name ?? <span className="mono small">{it.resourceId}</span>}</td>
                  <td className="num">
                    {it.requestedQuantity} <span className="small muted">{resources[it.resourceId]?.unit?.toLowerCase()}</span>
                  </td>
                  <td className="num">{planned[it.resourceId] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Where it comes from</h2>
        <p className="small muted">
          Each line is one warehouse. The NGO that owns the warehouse approves it, then their team marks it dispatched
          when it leaves.
        </p>
        <RequestLines doc={doc} onChanged={() => q.reload()} />
      </div>
    </>
  );
}
