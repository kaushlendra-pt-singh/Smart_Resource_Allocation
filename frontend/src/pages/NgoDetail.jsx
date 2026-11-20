import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, forgetNgo, getUsers } from "../api";
import { useAuth } from "../auth";
import { Alert, ErrorText, Field, LocationInput, StatusBadge, formatDate, isValidLocation, useAsync } from "../components/ui";

export default function NgoDetail() {
  const { ngoId } = useParams();
  const { user, isSuper, isAdminOf, isStaffOf, roleIn, reloadUser } = useAuth();
  const [tab, setTab] = useState("overview");

  const ngoQ = useAsync(() => api(`/api/ngo/${ngoId}`).then((r) => r.data), [ngoId]);
  const ngo = ngoQ.data;

  const isOwner = ngo && ngo.adminId === user._id;
  const isMember = !!roleIn(ngoId);
  const canAdmin = isAdminOf(ngoId);
  const canSeeMembers = isStaffOf(ngoId);
  // Founder whose NGO got approved but whose token is from before the approval
  const needsRefresh = ngo && ngo.verificationStatus === "APPROVED" && isOwner && !isMember;

  const reload = () => {
    forgetNgo(ngoId);
    ngoQ.reload();
  };

  // only block on the first load; later reloads keep the current view (and its messages) on screen
  if (ngoQ.loading && !ngo) return <p className="muted">Loading…</p>;
  if (ngoQ.error) return <ErrorText error={ngoQ.error} />;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small">
            <Link to="/ngos">← NGOs</Link>
          </p>
          <h1>
            {ngo.name} <StatusBadge status={ngo.verificationStatus} />
          </h1>
          <p>
            {ngo.category || "NGO"} · {ngo.location?.address}
          </p>
        </div>
        <div className="row">
          {isOwner && <span className="badge">You own this NGO</span>}
          {!isOwner && isMember && <StatusBadge status={roleIn(ngoId)} />}
        </div>
      </div>

      {needsRefresh && (
        <Alert kind="info">
          This NGO has been approved. Refresh your access to start managing it.{" "}
          <button className="link" onClick={() => reloadUser()}>
            Refresh now
          </button>
        </Alert>
      )}
      {ngo.verificationStatus === "PENDING" && (
        <Alert kind="info">This application is waiting for a super admin to review it.</Alert>
      )}
      {ngo.verificationStatus === "REJECTED" && <Alert>This application was rejected.</Alert>}

      <div className="tabs" role="tablist">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          Overview
        </button>
        {canSeeMembers && (
          <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>
            Team
          </button>
        )}
        {canAdmin && (
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            Settings
          </button>
        )}
      </div>

      {tab === "overview" && <Overview ngo={ngo} showDocs={isMember || isSuper || isOwner} />}
      {tab === "members" && canSeeMembers && <Members ngo={ngo} canAdmin={canAdmin} onChange={reload} />}
      {tab === "settings" && canAdmin && <Settings ngo={ngo} isOwner={isOwner || isSuper} onSaved={reload} />}
    </>
  );
}

function Overview({ ngo, showDocs }) {
  const [lng, lat] = ngo.location?.coordinates ?? [];
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>About</h2>
        <p>{ngo.description || <span className="muted">No description yet.</span>}</p>
        <dl className="kv">
          <dt>Registration no.</dt>
          <dd className="mono">{ngo.registrationNumber}</dd>
          <dt>Website</dt>
          <dd>
            {ngo.website ? (
              <a href={ngo.website} target="_blank" rel="noreferrer">
                {ngo.website}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt>Registered</dt>
          <dd>{formatDate(ngo.createdAt)}</dd>
          <dt>Team size</dt>
          <dd>{(ngo.ngoAdmins?.length ?? 0) + (ngo.ngoWorkers?.length ?? 0)}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>Location</h2>
        <p>{ngo.location?.address}</p>
        {lat !== undefined && (
          <p className="small">
            <span className="mono">
              {lat}, {lng}
            </span>{" "}
            ·{" "}
            <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=13/${lat}/${lng}`} target="_blank" rel="noreferrer">
              Open map
            </a>
          </p>
        )}
        {showDocs && (
          <>
            <hr />
            <h3>Documents</h3>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              <li>
                <a href={ngo.regDoc} target="_blank" rel="noreferrer">
                  Registration certificate
                </a>
              </li>
              <li>
                <a href={ngo.license} target="_blank" rel="noreferrer">
                  Licence
                </a>
              </li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Members({ ngo, canAdmin, onChange }) {
  const { user, reloadUser } = useAuth();
  const membersQ = useAsync(() => api(`/api/ngo/${ngo._id}/members`).then((r) => r.data), [ngo._id, ngo.updatedAt]);
  const [people, setPeople] = useState({});
  const [msg, setMsg] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("NGO_WORKER");
  const [busy, setBusy] = useState(false);

  const admins = membersQ.data?.ngoAdmins ?? [];
  const workers = membersQ.data?.ngoWorkers ?? [];

  useEffect(() => {
    if (admins.length + workers.length) getUsers([...admins, ...workers]).then(setPeople).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersQ.data]);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const found = await api("/api/auth/users/lookup", { query: { email: email.trim() } });
      await api(`/api/ngo/${ngo._id}/members`, {
        method: "POST",
        body: { targetUserId: found.user._id, roleInNGO: role },
      });
      setMsg({ kind: "success", text: `${found.user.name} added. They need to sign out and in (or refresh access) to see it.` });
      setEmail("");
      onChange();
      membersQ.reload();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (memberId, newRole) => {
    setMsg(null);
    try {
      await api(`/api/ngo/${ngo._id}/members`, { method: "POST", body: { targetUserId: memberId, roleInNGO: newRole } });
      onChange();
      membersQ.reload();
      if (memberId === user._id) await reloadUser();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
  };

  const remove = async (memberId) => {
    const who = people[memberId]?.name ?? "this member";
    if (!window.confirm(`Remove ${who} from ${ngo.name}?`)) return;
    setMsg(null);
    try {
      await api(`/api/ngo/${ngo._id}/members/${memberId}`, { method: "DELETE" });
      onChange();
      membersQ.reload();
      if (memberId === user._id) await reloadUser();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
  };

  const rows = [
    ...admins.map((id) => ({ id, role: "NGO_ADMIN" })),
    ...workers.map((id) => ({ id, role: "NGO_WORKER" })),
  ];

  return (
    <div className="grid grid-2">
      <div className="card" style={{ gridColumn: canAdmin ? "auto" : "1 / -1" }}>
        <h2>Team</h2>
        {msg && <Alert kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Alert>}
        <ErrorText error={membersQ.error} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                {canAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ id, role: r }) => {
                const isFounder = id === ngo.adminId;
                return (
                  <tr key={id}>
                    <td>
                      {people[id]?.name ?? <span className="mono">{id}</span>}
                      {id === user._id && <span className="muted small"> (you)</span>}
                      {people[id]?.email && <div className="small muted">{people[id].email}</div>}
                    </td>
                    <td>
                      {isFounder ? <span className="badge">Owner</span> : <StatusBadge status={r} />}
                    </td>
                    {canAdmin && (
                      <td className="num">
                        {!isFounder && (
                          <div className="row" style={{ justifyContent: "flex-end" }}>
                            {r === "NGO_ADMIN" ? (
                              <button className="secondary small" onClick={() => changeRole(id, "NGO_WORKER")}>
                                Make worker
                              </button>
                            ) : (
                              <button className="secondary small" onClick={() => changeRole(id, "NGO_ADMIN")}>
                                Make admin
                              </button>
                            )}
                            <button className="danger small" onClick={() => remove(id)}>
                              Remove
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {canAdmin && (
        <div className="card">
          <h2>Add someone</h2>
          <p className="small muted">They need an account first. Admins have the same rights as you for this NGO, except deleting it or handing over ownership.</p>
          <form onSubmit={add}>
            <Field label="Their email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="NGO_WORKER">Worker: can request and dispatch stock</option>
                <option value="NGO_ADMIN">Admin: also manages stock, team and approvals</option>
              </select>
            </Field>
            <button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add to team"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function Settings({ ngo, isOwner, onSaved }) {
  const navigate = useNavigate();
  const { reloadUser } = useAuth();
  const [form, setForm] = useState({
    name: ngo.name,
    address: ngo.location?.address ?? "",
    coordinates: ngo.location?.coordinates ?? ["", ""],
  });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const membersQ = useAsync(() => api(`/api/ngo/${ngo._id}/members`).then((r) => r.data), [ngo._id]);
  const [people, setPeople] = useState({});

  const admins = (membersQ.data?.ngoAdmins ?? []).filter((id) => id !== ngo.adminId);
  useEffect(() => {
    if (admins.length) getUsers(admins).then(setPeople).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersQ.data]);

  const save = async (e) => {
    e.preventDefault();
    if (!isValidLocation(form.coordinates)) {
      setMsg({ kind: "error", text: "Coordinates look wrong." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/ngo/${ngo._id}`, {
        method: "PATCH",
        body: { name: form.name.trim(), location: { address: form.address.trim(), coordinates: form.coordinates } },
      });
      setMsg({ kind: "success", text: "Saved." });
      onSaved();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const transfer = async () => {
    const name = people[newOwner]?.name ?? "this admin";
    if (!window.confirm(`Hand ownership of ${ngo.name} to ${name}? You'll stay on as an admin.`)) return;
    setMsg(null);
    try {
      await api(`/api/ngo/${ngo._id}/transfer-ownership`, { method: "PATCH", body: { newAdminId: newOwner } });
      await reloadUser();
      onSaved();
      setMsg({ kind: "success", text: `Ownership moved to ${name}.` });
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
  };

  const remove = async () => {
    const typed = window.prompt(`This permanently deletes ${ngo.name} and removes everyone from it.\nType the NGO name to confirm:`);
    if (typed === null) return;
    if (typed.trim() !== ngo.name) {
      setMsg({ kind: "error", text: "The name didn't match, nothing was deleted." });
      return;
    }
    try {
      await api(`/api/ngo/${ngo._id}`, { method: "DELETE" });
      forgetNgo(ngo._id);
      await reloadUser();
      navigate("/");
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
  };

  return (
    <>
      {msg && <Alert kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <div className="grid grid-2">
        <div className="card">
          <h2>Details</h2>
          <form onSubmit={save}>
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="Address">
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
            </Field>
            <LocationInput value={form.coordinates} onChange={(c) => setForm({ ...form, coordinates: c })} />
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </form>
        </div>

        {isOwner && (
          <div className="card">
            <h2>Ownership</h2>
            {ngo.verificationStatus !== "APPROVED" ? (
              <p className="muted small">Ownership can be handed over once the NGO is approved.</p>
            ) : admins.length === 0 ? (
              <p className="muted small">To hand over ownership, first make someone an admin on the Team tab.</p>
            ) : (
              <>
                <Field label="Hand ownership to" hint="Only existing admins can become the owner.">
                  <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
                    <option value="">Choose an admin…</option>
                    {admins.map((id) => (
                      <option key={id} value={id}>
                        {people[id]?.name ?? id}
                      </option>
                    ))}
                  </select>
                </Field>
                <button className="secondary" disabled={!newOwner} onClick={transfer}>
                  Transfer ownership
                </button>
              </>
            )}
            <hr />
            <h3 style={{ color: "var(--danger)" }}>Delete NGO</h3>
            <p className="small muted">Removes the NGO and everyone's membership. Warehouse records stay in inventory.</p>
            <button className="danger" onClick={remove}>
              Delete this NGO
            </button>
          </div>
        )}
      </div>
    </>
  );
}
