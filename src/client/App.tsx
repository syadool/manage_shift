import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Button } from "./components/ui";
import { useAuth } from "./lib/auth";
import { Calendar } from "./pages/Calendar";
import { Coworkers } from "./pages/Coworkers";
import { Day } from "./pages/Day";
import { Import } from "./pages/Import";
import { ImportReview } from "./pages/ImportReview";
import { Login } from "./pages/Login";
import { Pay } from "./pages/Pay";
import { Settings } from "./pages/Settings";

export function App() {
  const { user, unreachable, recheck } = useAuth();
  if (unreachable) {
    return (
      <div className="mx-auto flex max-w-sm items-center gap-2 px-3 pt-10">
        <p role="alert" className="text-sm text-ink-900">
          通信できません
        </p>
        <Button variant="ghost" onClick={recheck}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (user === undefined) return null;
  if (user === null) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Calendar />} />
        <Route path="day/:date" element={<Day />} />
        <Route path="coworkers" element={<Coworkers />} />
        <Route path="pay" element={<Pay />} />
        <Route path="import" element={<Import />} />
        <Route path="import/:id" element={<ImportReview />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
