import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { useNgoNames } from "./ui";

export default function Layout() {
  const { user, memberships, currentNgoId, setCurrentNgoId, isSuper, logout } = useAuth();
  const navigate = useNavigate();
  const names = useNgoNames(memberships.map((m) => m.ngoId));
  const inNgo = memberships.length > 0;

  const onLogout = async () => {
    await logout();
    navigate("/login");
  };

  const label = (id) => names[id] ?? `NGO …${id.slice(-6)}`;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <span className="brand-mark">+</span> Smart Allocate
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/ngos">NGOs</NavLink>
            <NavLink to="/resources">Resources</NavLink>
            {inNgo && <NavLink to="/inventory">Inventory</NavLink>}
            {(inNgo || isSuper) && <NavLink to="/allocate">Request stock</NavLink>}
            {(inNgo || isSuper) && <NavLink to="/requests">Requests</NavLink>}
            {isSuper && <NavLink to="/admin/ngos">Approvals</NavLink>}
          </nav>
          <div className="topbar-right">
            {memberships.length > 1 && (
              <select
                className="ngo-switch"
                style={{ width: "auto", maxWidth: 220 }}
                title="NGO you are working as"
                value={currentNgoId ?? ""}
                onChange={(e) => setCurrentNgoId(e.target.value)}
              >
                {memberships.map((m) => (
                  <option key={m.ngoId} value={m.ngoId}>
                    {label(m.ngoId)}
                  </option>
                ))}
              </select>
            )}
            {memberships.length === 1 && <span className="small muted">{label(memberships[0].ngoId)}</span>}
            <NavLink to="/profile" className="small" style={{ color: "var(--text)" }}>
              {user?.name}
            </NavLink>
            <button className="secondary small" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
