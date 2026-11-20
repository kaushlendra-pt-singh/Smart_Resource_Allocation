// Small fetch wrapper used by every page.
// - keeps the access token in memory (never in localStorage)
// - on a 401 it refreshes once using the httpOnly refresh cookie, then retries
// - turns both Express ({ message }) and FastAPI ({ detail }) errors into ApiError

let accessToken = null;
let onSessionLost = () => {};

export function setAccessToken(token) {
  accessToken = token;
}

export function onSessionExpired(fn) {
  onSessionLost = fn;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function errorMessage(body, status) {
  if (body && typeof body.message === "string") return body.message;
  if (body && typeof body.detail === "string") return body.detail;
  if (body && Array.isArray(body.detail)) {
    // FastAPI validation errors
    return body.detail.map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
  }
  if (status === 429) return "Too many requests. Wait a bit and try again.";
  if (status >= 500) return "The server ran into a problem. Try again in a moment.";
  return `Request failed (${status})`;
}

let refreshInFlight = null;

// Shared by the app start-up and by the 401 retry, so parallel requests only refresh once.
export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh-token", { method: "POST", credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new ApiError(errorMessage(body, res.status), res.status, body);
        accessToken = body.accessToken;
        return body;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function api(path, { method = "GET", body, query, retry = true } = {}) {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") params.set(k, v);
    });
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
    });
  } catch {
    throw new ApiError("Can't reach the server. Is the backend running?", 0, null);
  }

  const isAuthCall = path.startsWith("/api/auth/login") || path.startsWith("/api/auth/register");
  if (res.status === 401 && retry && !isAuthCall) {
    try {
      await refreshSession();
    } catch {
      accessToken = null;
      onSessionLost();
      throw new ApiError("Your session has expired. Please sign in again.", 401, null);
    }
    return api(path, { method, body, query, retry: false });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(errorMessage(data, res.status), res.status, data);
  return data;
}

// ---- small caches for things many pages need to display ----

const ngoCache = new Map();

export function getNgo(ngoId) {
  if (!ngoId) return Promise.resolve(null);
  if (!ngoCache.has(ngoId)) {
    const p = api(`/api/ngo/${ngoId}`)
      .then((r) => r.data)
      .catch((err) => {
        ngoCache.delete(ngoId);
        throw err;
      });
    ngoCache.set(ngoId, p);
  }
  return ngoCache.get(ngoId);
}

export function forgetNgo(ngoId) {
  ngoCache.delete(ngoId);
}

let resourcesPromise = null;

// The resource catalogue as { [id]: resource }. Cached for the session; call with fresh=true after adding one.
export function getResourceMap(fresh = false) {
  if (!resourcesPromise || fresh) {
    resourcesPromise = api("/api/resources", { query: { limit: 500 } })
      .then((r) => Object.fromEntries(r.data.map((x) => [x._id, x])))
      .catch((err) => {
        resourcesPromise = null;
        throw err;
      });
  }
  return resourcesPromise;
}

const userNameCache = new Map();

// Returns { [userId]: { name, email? } } for the given ids, fetching only unknown ones.
export async function getUsers(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const missing = unique.filter((id) => !userNameCache.has(id));
  if (missing.length) {
    const res = await api("/api/auth/users/basic", { method: "POST", body: { ids: missing } });
    res.users.forEach((u) => userNameCache.set(u._id, u));
  }
  const out = {};
  unique.forEach((id) => {
    if (userNameCache.has(id)) out[id] = userNameCache.get(id);
  });
  return out;
}
