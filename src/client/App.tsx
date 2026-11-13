import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Placeholder } from "./pages/Placeholder";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Placeholder label="カレンダー" />} />
        <Route path="coworkers" element={<Placeholder label="一緒に働く人" />} />
        <Route path="pay" element={<Placeholder label="給与" />} />
        <Route path="import" element={<Placeholder label="取り込み" />} />
        <Route path="settings" element={<Placeholder label="設定" />} />
      </Route>
    </Routes>
  );
}
