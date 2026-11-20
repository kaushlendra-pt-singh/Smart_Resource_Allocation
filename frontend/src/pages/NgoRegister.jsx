import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Alert, Field, LocationInput, isValidLocation } from "../components/ui";

const CATEGORIES = ["Disaster relief", "Health", "Food & nutrition", "Shelter", "Education", "Other"];

// Uploads straight to Cloudinary with a short-lived signature from ngo_svc.
async function uploadToCloudinary(file) {
  const sig = await api("/api/ngo/upload-signature");
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", sig.apiKey);
  form.append("timestamp", sig.timestamp);
  form.append("signature", sig.signature);
  form.append("folder", "ngo_verification_docs");
  const res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName.trim()}/auto/upload`, {
    method: "POST",
    body: form,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || "Upload failed.");
  return body.secure_url;
}

function DocInput({ label, value, onChange }) {
  const [mode, setMode] = useState("upload");
  const [status, setStatus] = useState("");

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setStatus("That file is over 10 MB.");
      return;
    }
    setStatus("Uploading…");
    try {
      onChange(await uploadToCloudinary(file));
      setStatus("Uploaded.");
    } catch (err) {
      onChange("");
      setStatus(err.message);
    }
  };

  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{label}</span>
        <span className="spacer" />
        <button type="button" className="link small" onClick={() => setMode(mode === "upload" ? "url" : "upload")}>
          {mode === "upload" ? "Paste a link instead" : "Upload a file instead"}
        </button>
      </div>
      {mode === "upload" ? (
        <input type="file" accept=".pdf,image/*" onChange={onFile} />
      ) : (
        <input type="url" placeholder="https://…" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {mode === "upload" && (status || value) && (
        <small className="muted">
          {status}{" "}
          {value && (
            <a href={value} target="_blank" rel="noreferrer">
              View file
            </a>
          )}
        </small>
      )}
    </div>
  );
}

export default function NgoRegister() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    registrationNumber: "",
    category: "",
    description: "",
    website: "",
    address: "",
    coordinates: ["", ""],
    regDoc: "",
    license: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!isValidLocation(form.coordinates)) {
      setError("Enter a valid latitude and longitude for the NGO's main office.");
      return;
    }
    if (!form.regDoc || !form.license) {
      setError("Both the registration certificate and the licence are required.");
      return;
    }
    setBusy(true);
    try {
      const res = await api("/api/ngo/register", {
        method: "POST",
        body: {
          name: form.name.trim(),
          registrationNumber: form.registrationNumber.trim(),
          category: form.category,
          description: form.description.trim(),
          website: form.website.trim(),
          location: { address: form.address.trim(), coordinates: form.coordinates },
          regDoc: form.regDoc,
          license: form.license,
        },
      });
      setDone(res.ngo);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card" style={{ maxWidth: 620 }}>
        <h1>Application sent</h1>
        <p>
          <strong>{done.name}</strong> is now waiting for a super admin to review it. Once it's approved you'll be its
          owner and admin. Use "Refresh my access" on the home page after approval.
        </p>
        <div className="row">
          <Link to={`/ngos/${done._id}`} className="btn">
            View application
          </Link>
          <button className="secondary" onClick={() => navigate("/")}>
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Register an NGO</h1>
          <p>You'll become the owner once a super admin approves it.</p>
        </div>
      </div>

      <form onSubmit={submit} style={{ maxWidth: 720 }}>
        <Alert>{error}</Alert>
        <div className="card">
          <h2>Organisation</h2>
          <div className="form-row">
            <Field label="Name">
              <input value={form.name} onChange={set("name")} required />
            </Field>
            <Field label="Registration number" hint="As on your government certificate.">
              <input value={form.registrationNumber} onChange={set("registrationNumber")} required />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Category">
              <select value={form.category} onChange={set("category")}>
                <option value="">Choose…</option>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Website (optional)">
              <input type="url" placeholder="https://" value={form.website} onChange={set("website")} />
            </Field>
          </div>
          <Field label="What does the NGO do? (optional)">
            <textarea rows={3} value={form.description} onChange={set("description")} />
          </Field>
        </div>

        <div className="card">
          <h2>Main office</h2>
          <Field label="Address">
            <input value={form.address} onChange={set("address")} required />
          </Field>
          <LocationInput label="Coordinates" value={form.coordinates} onChange={(c) => setForm({ ...form, coordinates: c })} />
        </div>

        <div className="card">
          <h2>Documents</h2>
          <p className="small muted">PDF or image, up to 10 MB each. A super admin checks these before approving.</p>
          <DocInput label="Registration certificate" value={form.regDoc} onChange={(v) => setForm((f) => ({ ...f, regDoc: v }))} />
          <DocInput label="Licence" value={form.license} onChange={(v) => setForm((f) => ({ ...f, license: v }))} />
        </div>

        <button type="submit" disabled={busy}>
          {busy ? "Submitting…" : "Submit for review"}
        </button>
      </form>
    </>
  );
}
