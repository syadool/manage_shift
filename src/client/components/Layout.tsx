import { CalendarDays, ImageUp, Settings, Users, Wallet, type LucideIcon } from "lucide-react";
import { NavLink, Outlet } from "react-router";

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "カレンダー", icon: CalendarDays },
  { to: "/coworkers", label: "メンバー", icon: Users },
  { to: "/pay", label: "給与", icon: Wallet },
  { to: "/import", label: "取り込み", icon: ImageUp },
  { to: "/settings", label: "設定", icon: Settings },
];

/** アイコンは全て線アイコン・線幅 1.5 で統一 */
export const ICON_PROPS = { size: 16, strokeWidth: 1.5 } as const;

/**
 * PC: 左サイドナビ / スマホ: 下部タブ。
 * 本文の左余白は 24px (はみ出すボタン枠の分を確保)。
 */
export function Layout() {
  return (
    <div className="min-h-dvh md:flex">
      <nav className="hidden w-25 shrink-0 border-r border-ink-100 py-3 md:block">
        <ul>
          {NAV.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `flex items-center gap-1 px-2 py-1 text-sm ${isActive ? "text-ink-900" : "text-ink-500"}`
                }
              >
                <Icon {...ICON_PROPS} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main className="flex-1 px-3 pt-3 pb-[calc(80px+env(safe-area-inset-bottom))] md:px-4 md:pb-10">
        <Outlet />
      </main>

      {/* iPhone のホームバーと重ならないよう、下に安全領域ぶんの余白を取る */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-ink-100 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        <ul className="grid grid-cols-5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-0 py-1 text-xs ${isActive ? "text-ink-900" : "text-ink-500"}`
                }
              >
                <Icon size={20} strokeWidth={1.5} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
