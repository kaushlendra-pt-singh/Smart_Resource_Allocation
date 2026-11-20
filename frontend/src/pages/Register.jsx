import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";

export default function Register() {
  const { user, ready, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to="/" replace />;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (form.password.length < 8) {
      setError("Use at least 8 characters for the password.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await register({ ...form, name: form.name.trim(), email: form.email.trim() });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="brand">
          <span className="brand-mark">+</span> Smart Allocate
        </div>
        <div className="card">
          <h1>Create an account</h1>
          <p className="muted">Anyone can sign up. NGO admins can then add you to their team.</p>
          <Alert>{error}</Alert>
          <form onSubmit={submit}>
            <Field label="Full name">
              <input autoComplete="name" value={form.name} onChange={set("name")} required />
            </Field>
            <Field label="Email">
              <input type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
            </Field>
            <Field label="Phone">
              <input type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} required />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <input
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={set("password")}
                required
              />
            </Field>
            <button type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
              {busy ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>
        <p className="small muted" style={{ textAlign: "center" }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
