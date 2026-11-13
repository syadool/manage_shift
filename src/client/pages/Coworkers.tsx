import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { addMonths, monthRange, today } from "../../shared/dates";
import { ICON_PROPS } from "../components/Layout";
import { Button, Hint, LoadError } from "../components/ui";
import { formatMinutes } from "../lib/shiftData";
import { useResource } from "../lib/useResource";

type Stats = {
  hasMe: boolean;
  myDays: number;
  coworkers: { memberId: string; name: string; days: number; minutes: number }[];
};

/** 期間: "YYYY-MM" (月) または "YYYY" (年) */
function parsePeriod(p: string | null, now: string) {
  if (p && /^\d{4}$/.test(p)) return { kind: "year" as const, key: p };
  if (p && /^\d{4}-(0[1-9]|1[0-2])$/.test(p)) return { kind: "month" as const, key: p };
  return { kind: "month" as const, key: now.slice(0, 7) };
}

export function Coworkers() {
  const [params, setParams] = useSearchParams();
  const now = today();
  const period = parsePeriod(params.get("p"), now);
  const range =
    period.kind === "month" ? monthRange(period.key) : { from: `${period.key}-01-01`, to: `${period.key}-12-31` };
  const { data, error, reload } = useResource<Stats>(`/stats/coworkers?from=${range.from}&to=${range.to}`);

  const label =
    period.kind === "month"
      ? `${Number(period.key.slice(0, 4))}年${Number(period.key.slice(5, 7))}月`
      : `${period.key}年`;
  const go = (n: number) =>
    setParams({ p: period.kind === "month" ? addMonths(period.key, n) : String(Number(period.key) + n) });
  const switchTo = (kind: "month" | "year") =>
    setParams({ p: kind === "year" ? period.key.slice(0, 4) : period.kind === "year" ? `${period.key}-01` : period.key });

  const max = Math.max(1, ...(data?.coworkers.map((c) => c.minutes) ?? []));

  return (
    <div className="max-w-xl">
      <div className="flex items-center justify-between pb-2">
        <p className="text-base">{label}</p>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 pr-1 text-sm">
            {(["month", "year"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => switchTo(k)}
                aria-pressed={period.kind === k}
                className={period.kind === k ? "text-ink-900 underline underline-offset-4" : "text-ink-500"}
              >
                {k === "month" ? "月" : "年"}
              </button>
            ))}
          </div>
          <Button variant="ghost" aria-label="前へ" onClick={() => go(-1)}>
            <ChevronLeft {...ICON_PROPS} />
          </Button>
          <Button variant="ghost" aria-label="次へ" onClick={() => go(1)}>
            <ChevronRight {...ICON_PROPS} />
          </Button>
        </div>
      </div>

      {error && <LoadError message={error} onRetry={reload} />}
      {data && !data.hasMe && (
        <Hint>
          <Link to="/settings" className="underline">
            設定
          </Link>
          で「自分」のメンバーを登録すると表示されます
        </Hint>
      )}

      {data?.hasMe && (
        <>
          <p className="pb-2 text-sm">
            <span className="text-ink-500">自分の出勤 </span>
            {data.myDays}日
          </p>
          {data.coworkers.length === 0 ? (
            <p className="border-t border-ink-100 py-2 text-sm text-ink-500">一緒に働いた人はいません</p>
          ) : (
            <ol className="border-t border-ink-100">
              {data.coworkers.map((c) => (
                <li key={c.memberId} className="border-b border-ink-100 py-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-base">{c.name}</span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {c.days}日
                      <span className="pl-1 text-ink-500">{formatMinutes(c.minutes)}</span>
                    </span>
                  </div>
                  {/* 重なった時間の棒。最大を全幅とする */}
                  <div className="mt-1 h-1 rounded-sm bg-ink-50" aria-hidden>
                    <div className="h-1 rounded-sm bg-ink-700" style={{ width: `${(c.minutes / max) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
