import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import NgoList from "./pages/NgoList";
import NgoRegister from "./pages/NgoRegister";
import NgoDetail from "./pages/NgoDetail";
import AdminNgos from "./pages/AdminNgos";
import Resources from "./pages/Resources";
import Inventory from "./pages/Inventory";
import Allocate from "./pages/Allocate";
import Requests from "./pages/Requests";
import RequestDetail from "./pages/RequestDetail";
import Profile from "./pages/Profile";

function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="page muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function RequireSuper({ children }) {
  const { isSuper } = useAuth();
  if (!isSuper) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="ngos" element={<NgoList />} />
        <Route path="ngos/new" element={<NgoRegister />} />
        <Route path="ngos/:ngoId" element={<NgoDetail />} />
        <Route
          path="admin/ngos"
          element={
            <RequireSuper>
              <AdminNgos />
            </RequireSuper>
          }
        />
        <Route path="resources" element={<Resources />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="allocate" element={<Allocate />} />
        <Route path="requests" element={<Requests />} />
        <Route path="requests/:referenceId" element={<RequestDetail />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
