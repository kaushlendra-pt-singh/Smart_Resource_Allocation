import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, NgoName, StatusBadge, formatDate, formatKm, useResourceMap } from "./ui";

const ACTION_TEXT = {
  approve: { label: "Approve", confirm: null, done: "Approved. The stock is now on hold." },
  reject: { label: "Reject", confirm: "Reject this line? The requesting NGO will see it was declined.", done: "Rejected." },
  dispatch: { label: "Mark dispatched", confirm: "Has this stock actually left the warehouse?", done: "Marked as dispatched." },
  cancel: { label: "Cancel", confirm: "Cancel this line? Any stock on hold is released.", done: "Cancelled." },
};

// Lines of one allocation request, with the buttons this user is allowed to press.
// The backend checks every action again; this only hides buttons that would be refused.
export default function RequestLines({ doc, onChanged, compact = false }) {
  const { user, isAdminOf, isStaffOf } = useAuth();
  const resources = useResourceMap();
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const canCancel = (line) =>
    doc.requestedBy === user._id || isAdminOf(doc.requesterNgoId) || isAdminOf(line.ngoId);

  const actionsFor = (line) => {
    const out = [];
    if (line.status === "PENDING") {
      if (isAdminOf(line.ngoId)) out.push("approve", "reject");
      if (canCancel(line)) out.push("cancel");
    } else if (line.status === "APPROVED") {
      if (isStaffOf(line.ngoId)) out.push("dispatch");
      if (canCancel(line)) out.push("cancel");
    }
    return out;
  };

  const run = async (line, action) => {
    const text = ACTION_TEXT[action];
    if (text.confirm && !window.confirm(text.confirm)) return;
    setBusy(`${line.lineId}:${action}`);
    setMsg(null);
    try {
      await api(`/allocation/api/requests/${doc.referenceId}/lines/${line.lineId}/${action}`, { method: "POST", body: {} });
      // In a list the row may disappear after reload (e.g. it's no longer "pending"),
      // so the parent shows the confirmation; on the detail page we show it here.
      if (!compact) setMsg({ kind: "success", text: text.done });
      onChanged?.(`${doc.referenceId}: ${text.done}`);
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {msg && <Alert kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>From</th>
              <th className="num">Qty</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No lines you can see.
                </td>
              </tr>
            )}
            {doc.lines.map((line) => {
              const res = resources[line.resourceId];
              return (
                <tr key={line.lineId}>
                  <td>{res?.name ?? <span className="mono small">{line.resourceId}</span>}</td>
                  <td>
                    {line.warehouseName}
                    <div className="small muted">
                      <NgoName id={line.ngoId} /> · {formatKm(line.distanceKm)}
                    </div>
                  </td>
                  <td className="num">
                    {line.quantity} <span className="small muted">{res?.unit?.toLowerCase()}</span>
                  </td>
                  <td>
                    <StatusBadge status={line.status} />
                    {!compact && line.decidedAt && <div className="small muted">{formatDate(line.decidedAt)}</div>}
                    {!compact && line.note && <div className="small muted">“{line.note}”</div>}
                  </td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                      {actionsFor(line).map((a) => (
                        <button
                          key={a}
                          className={`small ${a === "approve" || a === "dispatch" ? "" : a === "reject" ? "danger" : "secondary"}`}
                          disabled={!!busy}
                          onClick={() => run(line, a)}
                        >
                          {busy === `${line.lineId}:${a}` ? "…" : ACTION_TEXT[a].label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
