import { useCallback, useEffect, useState } from "react";
import { getNgo, getResourceMap } from "../api";

// Resource catalogue as { [id]: resource } (cached in api.js)
export function useResourceMap() {
  const [map, setMap] = useState({});
  useEffect(() => {
    getResourceMap().then(setMap).catch(() => {});
  }, []);
  return map;
}

// Runs an async loader on mount (and when deps change). Returns { data, error, loading, reload }.
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loader()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      // keep the last good data on a failed reload so the page doesn't blank out
      .catch((error) => alive && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function Alert({ kind = "error", children, onClose }) {
  if (!children) return null;
  return (
    <div className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <div className="row">
        <div className="spacer">{children}</div>
        {onClose && (
          <button className="link small" onClick={onClose} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

export function ErrorText({ error }) {
  if (!error) return null;
  return <Alert>{error.message || String(error)}</Alert>;
}

const STATUS_KIND = {
  APPROVED: "ok",
  DISPATCHED: "ok",
  success: "ok",
  PENDING: "warn",
  PROCESSING: "warn",
  pending_approval: "warn",
  partial_success: "warn",
  REJECTED: "danger",
  failed: "danger",
  CANCELLED: "",
  CLOSED: "",
  NO_STOCK: "danger",
  NGO_ADMIN: "info",
  SUPER_ADMIN: "info",
};

const STATUS_LABEL = {
  pending_approval: "Waiting for approval",
  partial_success: "Partly done",
  success: "Done",
  failed: "Failed",
  NGO_ADMIN: "Admin",
  NGO_WORKER: "Worker",
  VOLUNTEER: "Volunteer",
  SUPER_ADMIN: "Super admin",
  RESIDENT: "Resident",
  NO_STOCK: "No stock",
};

export function StatusBadge({ status }) {
  if (!status) return null;
  const label = STATUS_LABEL[status] ?? status.charAt(0) + status.slice(1).toLowerCase();
  return <span className={`badge ${STATUS_KIND[status] ?? ""}`}>{label}</span>;
}

export function Modal({ title, onClose, wide, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

// [longitude, latitude] input with a "use my location" helper.
export function LocationInput({ value, onChange, label = "Location" }) {
  const [lng, lat] = value ?? ["", ""];
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState("");

  const useMine = () => {
    if (!navigator.geolocation) {
      setGeoError("Your browser can't share location.");
      return;
    }
    setLocating(true);
    setGeoError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChange([round(pos.coords.longitude), round(pos.coords.latitude)]);
        setLocating(false);
      },
      () => {
        setGeoError("Couldn't get your location. Enter it by hand.");
        setLocating(false);
      },
      { timeout: 10000 }
    );
  };

  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{label}</span>
        <span className="spacer" />
        <button type="button" className="link small" onClick={useMine} disabled={locating}>
          {locating ? "Locating…" : "Use my location"}
        </button>
      </div>
      <div className="form-row">
        <input
          type="number"
          step="any"
          placeholder="Latitude (e.g. 28.6139)"
          value={lat}
          onChange={(e) => onChange([lng, e.target.value === "" ? "" : Number(e.target.value)])}
          aria-label="Latitude"
        />
        <input
          type="number"
          step="any"
          placeholder="Longitude (e.g. 77.2090)"
          value={lng}
          onChange={(e) => onChange([e.target.value === "" ? "" : Number(e.target.value), lat])}
          aria-label="Longitude"
        />
      </div>
      {geoError && <small style={{ color: "var(--danger)" }}>{geoError}</small>}
    </div>
  );
}

function round(n) {
  return Math.round(n * 1e5) / 1e5;
}

export function isValidLocation(loc) {
  if (!Array.isArray(loc) || loc.length !== 2) return false;
  const [lng, lat] = loc;
  return (
    typeof lng === "number" && typeof lat === "number" && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
  );
}

// Resolves several NGO ids to names at once: { [id]: name }
export function useNgoNames(ids) {
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  const [names, setNames] = useState({});
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(",") : [];
    Promise.all(list.map((id) => getNgo(id).then((n) => [id, n?.name]).catch(() => [id, null]))).then(
      (pairs) => alive && setNames(Object.fromEntries(pairs.filter(([, n]) => n)))
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return names;
}

// Shows an NGO's name for an id (cached), falling back to a short id.
export function NgoName({ id }) {
  const [name, setName] = useState(null);
  useEffect(() => {
    let alive = true;
    getNgo(id)
      .then((n) => alive && setName(n?.name ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  if (!id) return <span className="muted">—</span>;
  return <span title={id}>{name ?? `NGO …${id.slice(-6)}`}</span>;
}

export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatKm(km) {
  if (km === undefined || km === null) return "—";
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}
