import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Placeholder } from "./pages/Placeholder";
import { Settings } from "./pages/Settings";

export function App() {
  const { user } = useAuth();
  if (user === undefined) return null;
  if (user === null) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Placeholder label="カレンダー" />} />
        <Route path="coworkers" element={<Placeholder label="一緒に働く人" />} />
        <Route path="pay" element={<Placeholder label="給与" />} />
        <Route path="import" element={<Placeholder label="取り込み" />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
