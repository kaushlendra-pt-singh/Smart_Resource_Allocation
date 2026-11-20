import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, onSessionExpired, refreshSession, setAccessToken } from "./api";

const AuthContext = createContext(null);
const CURRENT_NGO_KEY = "currentNgoId";

function readStoredNgo() {
  try {
    return localStorage.getItem(CURRENT_NGO_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [storedNgoId, setStoredNgoId] = useState(readStoredNgo);

  // Try to resume a session from the refresh cookie on page load.
  useEffect(() => {
    refreshSession()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
    onSessionExpired(() => setUser(null));
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api("/api/auth/login", { method: "POST", body: { email, password } });
    setAccessToken(res.accessToken);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(async (form) => {
    const res = await api("/api/auth/register", { method: "POST", body: form });
    setAccessToken(res.accessToken);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  // Roles and memberships live in the token, so after anything that changes them
  // (NGO approved, member added, ownership moved) we fetch a fresh token.
  const reloadUser = useCallback(async () => {
    const res = await refreshSession();
    setUser(res.user);
    return res.user;
  }, []);

  const memberships = user?.joinedNGOs ?? [];
  const isSuper = user?.role === "SUPER_ADMIN";

  const roleIn = useCallback(
    (ngoId) => memberships.find((m) => m.ngoId === ngoId)?.roleInNGO ?? null,
    [memberships]
  );
  const isAdminOf = useCallback((ngoId) => isSuper || roleIn(ngoId) === "NGO_ADMIN", [isSuper, roleIn]);
  const isStaffOf = useCallback(
    (ngoId) => isSuper || ["NGO_ADMIN", "NGO_WORKER"].includes(roleIn(ngoId)),
    [isSuper, roleIn]
  );

  // The NGO the user is currently working as (switcher in the top bar).
  const currentNgoId = useMemo(() => {
    const ids = memberships.map((m) => m.ngoId);
    if (storedNgoId && ids.includes(storedNgoId)) return storedNgoId;
    if (user?.ngoId && ids.includes(user.ngoId)) return user.ngoId;
    return ids[0] ?? null;
  }, [memberships, storedNgoId, user]);

  const setCurrentNgoId = useCallback((id) => {
    setStoredNgoId(id);
    try {
      localStorage.setItem(CURRENT_NGO_KEY, id);
    } catch {
      /* private mode etc. - selection just won't persist */
    }
  }, []);

  const value = {
    user,
    ready,
    login,
    register,
    logout,
    reloadUser,
    memberships,
    isSuper,
    roleIn,
    isAdminOf,
    isStaffOf,
    currentNgoId,
    setCurrentNgoId,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
