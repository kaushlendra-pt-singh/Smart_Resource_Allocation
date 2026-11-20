import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";

export default function Login() {
  const { user, ready, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(location.state?.from || "/", { replace: true });
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
          <h1>Sign in</h1>
          <p className="muted">Coordinate relief stock between NGOs.</p>
          <Alert>{error}</Alert>
          <form onSubmit={submit}>
            <Field label="Email">
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Password">
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <button type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <p className="small muted" style={{ textAlign: "center" }}>
          New here? <Link to="/register">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
