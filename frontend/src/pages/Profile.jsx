import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Field, NgoName, StatusBadge } from "../components/ui";

export default function Profile() {
  const { user, memberships, reloadUser } = useAuth();
  const [form, setForm] = useState({ name: user.name, phone: user.phone || "" });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/auth/profile", { method: "PATCH", body: form });
      await reloadUser();
      setMsg({ kind: "success", text: "Profile saved." });
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(user._id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the id is still visible */
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your profile</h1>
          <p>{user.email}</p>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Details</h2>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          <form onSubmit={save}>
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </form>
        </div>

        <div className="card">
          <h2>Account</h2>
          <dl className="kv">
            <dt>Role</dt>
            <dd>
              <StatusBadge status={user.role} />
            </dd>
            <dt>Owns</dt>
            <dd>{user.ngoId ? <Link to={`/ngos/${user.ngoId}`}><NgoName id={user.ngoId} /></Link> : "No NGO"}</dd>
            <dt>User ID</dt>
            <dd>
              <span className="mono">{user._id}</span>{" "}
              <button className="link small" onClick={copyId}>
                {copied ? "Copied" : "Copy"}
              </button>
            </dd>
          </dl>
          <hr />
          <h3>Memberships</h3>
          {memberships.length === 0 ? (
            <p className="muted small">You're not part of any NGO yet.</p>
          ) : (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {memberships.map((m) => (
                <li key={m.ngoId}>
                  <Link to={`/ngos/${m.ngoId}`}>
                    <NgoName id={m.ngoId} />
                  </Link>{" "}
                  <StatusBadge status={m.roleInNGO} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
