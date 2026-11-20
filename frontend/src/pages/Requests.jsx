import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import RequestLines from "../components/RequestLines";
import { Alert, ErrorText, NgoName, StatusBadge, formatDate, useAsync } from "../components/ui";

const STATUSES = ["", "PENDING", "APPROVED", "DISPATCHED", "REJECTED", "CANCELLED"];

export default function Requests() {
  const { currentNgoId, isSuper } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") || (currentNgoId ? "mine" : "all");
  const [status, setStatus] = useState(view === "incoming" ? "PENDING" : "");
  const [page, setPage] = useState(1);
  const [flash, setFlash] = useState("");

  const listQ = useAsync(
    () =>
      api("/allocation/api/requests", {
        query: { view, status, page, limit: 15, ngoId: view === "all" ? undefined : currentNgoId },
      }),
    [view, status, page, currentNgoId]
  );

  const setView = (v) => {
    setParams({ view: v });
    setStatus(v === "incoming" ? "PENDING" : "");
    setPage(1);
  };

  const docs = listQ.data?.data ?? [];
  const pg = listQ.data?.pagination;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>
            {view === "incoming"
              ? "Other NGOs asking for stock from your warehouses."
              : view === "all"
              ? "Every request on the platform."
              : "Stock your NGO has asked for."}
          </p>
        </div>
        {currentNgoId && (
          <Link to="/allocate" className="btn">
            New request
          </Link>
        )}
      </div>

      <div className="tabs">
        {currentNgoId && (
          <>
            <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")}>
              Sent
            </button>
            <button className={view === "incoming" ? "active" : ""} onClick={() => setView("incoming")}>
              Incoming
            </button>
          </>
        )}
        {isSuper && (
          <button className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
            All
          </button>
        )}
        <span className="spacer" />
        <select
          style={{ width: "auto", marginBottom: 6 }}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          aria-label="Filter by line status"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? `Has ${s.toLowerCase()} lines` : "Any status"}
            </option>
          ))}
        </select>
      </div>

      {flash && (
        <Alert kind="success" onClose={() => setFlash("")}>
          {flash}
        </Alert>
      )}
      <ErrorText error={listQ.error} />
      {listQ.loading && <p className="muted">Loading…</p>}
      {!listQ.loading && docs.length === 0 && (
        <div className="card empty">
          {view === "incoming" ? "No requests waiting for you." : "No requests yet."}
        </div>
      )}

      {docs.map((doc) => (
        <div className="card" key={doc.referenceId}>
          <div className="row" style={{ marginBottom: 10 }}>
            <Link to={`/requests/${doc.referenceId}`} className="mono">
              {doc.referenceId}
            </Link>
            <StatusBadge status={doc.status} />
            <span className="spacer" />
            <span className="small muted">
              {view !== "mine" && (
                <>
                  from <NgoName id={doc.requesterNgoId} /> ·{" "}
                </>
              )}
              {formatDate(doc.requestedAt)}
            </span>
          </div>
          {view === "incoming" ? (
            <RequestLines
              doc={doc}
              compact
              onChanged={(text) => {
                setFlash(text);
                listQ.reload();
              }}
            />
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              {summary(doc)} · <Link to={`/requests/${doc.referenceId}`}>Details</Link>
            </p>
          )}
        </div>
      ))}

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

function summary(doc) {
  const counts = {};
  doc.lines.forEach((l) => {
    counts[l.status] = (counts[l.status] || 0) + 1;
  });
  const parts = Object.entries(counts).map(([s, n]) => `${n} ${s.toLowerCase()}`);
  return `${doc.items.length} item${doc.items.length === 1 ? "" : "s"}, ${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
