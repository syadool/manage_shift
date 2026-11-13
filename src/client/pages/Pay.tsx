import { useState } from "react";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import type { PaySummary } from "../../shared/calc";
import { today } from "../../shared/dates";
import type { YearPay } from "../../shared/stats";
import { ICON_PROPS } from "../components/Layout";
import { Button, Hint, LoadError, Section } from "../components/ui";
import { formatMinutes } from "../lib/shiftData";
import { useResource } from "../lib/useResource";

type PayResponse = {
  hasMe: boolean;
  settings: { hourlyWage: number; transportPerDay: number };
  pay: YearPay;
};

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
/** 大きな金額は万円単位 (小数1桁) */
const man = (n: number) => `${(Math.round(n / 1000) / 10).toLocaleString("ja-JP")}万円`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-ink-500">{label}</p>
      <p className="text-xl tabular-nums">{value}</p>
      {sub && <p className="text-xs text-ink-500 tabular-nums">{sub}</p>}
    </div>
  );
}

/** 年収の壁までのメーター: 実績 (濃) と見込み (淡) を同じ棒に積む */
function WallMeter({ wall }: { wall: NonNullable<YearPay["wall"]> }) {
  const scale = Math.max(wall.wall, wall.projected, 1);
  const earnedPct = (Math.min(wall.earned, scale) / scale) * 100;
  const projectedPct = (Math.min(wall.projected, scale) / scale) * 100;
  const wallPct = (wall.wall / scale) * 100;
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 pb-2">
        <Stat label="実績" value={man(wall.earned)} />
        <Stat label="年末の予測" value={man(wall.projected)} />
        <Stat label={wall.remaining >= 0 ? "壁まで残り" : "超過"} value={man(Math.abs(wall.remaining))} />
      </div>
      <div
        className="relative h-2 rounded-sm bg-ink-100"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={wall.wall}
        aria-valuenow={wall.earned}
        aria-label="年収の壁に対する実績"
      >
        <div className="absolute inset-y-0 left-0 rounded-sm bg-ink-300" style={{ width: `${projectedPct}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-sm bg-ink-900" style={{ width: `${earnedPct}%` }} />
        {/* 壁の位置 (予測が壁を超えるとき、棒の途中に来る) */}
        {wallPct < 100 && (
          <div className="absolute -inset-y-1 w-0 border-l-2 border-white" style={{ left: `${wallPct}%` }} />
        )}
      </div>
      <div className="flex gap-2 pt-1 text-xs text-ink-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-1 rounded-sm bg-ink-900" /> 実績
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-1 rounded-sm bg-ink-300" /> 年末までの予測
        </span>
      </div>
      {wall.willExceed && (
        <p role="alert" className="flex items-center gap-1 pt-2 text-sm text-ink-900">
          <TriangleAlert {...ICON_PROPS} className="shrink-0" />
          このままだと年末に約{man(wall.projected)}になり、{man(wall.wall)}を超える見込みです
        </p>
      )}
    </div>
  );
}

/** 月ごとの概算給与 (交通費込み)。今日より前の月は実績、以降は入っているシフトの見込み */
function MonthlyBars({ months, now }: { months: YearPay["months"]; now: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => m.total));
  const thisMonth = now.slice(0, 7);
  return (
    <div>
      <div className="relative flex h-20 items-end gap-0 border-b border-ink-300" onMouseLeave={() => setHover(null)}>
        {months.map((m, i) => {
          const future = m.month > thisMonth;
          return (
            <button
              key={m.month}
              type="button"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${Number(m.month.slice(5))}月 ${yen(m.total)}`}
              className="flex h-full flex-1 items-end justify-center px-0"
            >
              <span
                className={`block w-1/2 max-w-3 rounded-t-sm ${future ? "bg-ink-300" : m.month === thisMonth ? "bg-ink-900" : "bg-ink-700"}`}
                style={{ height: `${(m.total / max) * 100}%`, minHeight: m.total > 0 ? 2 : 0 }}
              />
            </button>
          );
        })}
        {hover !== null && (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-sm border border-ink-100 bg-white px-1 text-xs whitespace-nowrap"
            style={{ left: `${((hover + 0.5) / 12) * 100}%` }}
          >
            {Number(months[hover].month.slice(5))}月 {yen(months[hover].total)}
            <span className="pl-1 text-ink-500">{months[hover].workDays}日</span>
          </div>
        )}
      </div>
      <div className="flex text-xs text-ink-500">
        {months.map((m) => (
          <span key={m.month} className="flex-1 text-center">
            {Number(m.month.slice(5))}
          </span>
        ))}
      </div>
      <div className="flex gap-2 pt-1 text-xs text-ink-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-1 rounded-sm bg-ink-700" /> 実績
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-1 rounded-sm bg-ink-300" /> 見込み
        </span>
      </div>
    </div>
  );
}

function Row({ label, p, strong }: { label: string; p: PaySummary; strong?: boolean }) {
  return (
    <tr className={strong ? "text-ink-900" : ""}>
      <td className="border-t border-ink-100 py-1 pr-2">{label}</td>
      <td className="border-t border-ink-100 py-1 pr-2 text-right tabular-nums">{p.workDays}日</td>
      <td className="border-t border-ink-100 py-1 pr-2 text-right tabular-nums">{formatMinutes(p.workedMinutes)}</td>
      <td className="hidden border-t border-ink-100 py-1 pr-2 text-right tabular-nums sm:table-cell">{yen(p.wage)}</td>
      <td className="hidden border-t border-ink-100 py-1 pr-2 text-right tabular-nums sm:table-cell">{yen(p.transport)}</td>
      <td className="border-t border-ink-100 py-1 text-right tabular-nums">{yen(p.total)}</td>
    </tr>
  );
}

export function Pay() {
  const [params, setParams] = useSearchParams();
  const now = today();
  const y = params.get("y") ?? "";
  const year = /^\d{4}$/.test(y) ? Number(y) : Number(now.slice(0, 4));
  const { data, error, reload } = useResource<PayResponse>(`/stats/pay?year=${year}&today=${now}`);
  const go = (n: number) => setParams({ y: String(year + n) });

  const thisMonth = data?.pay.months.find((m) => m.month === now.slice(0, 7));

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between pb-2">
        <p className="text-base">{year}年</p>
        <div className="flex gap-2">
          <Button variant="ghost" aria-label="前の年" onClick={() => go(-1)}>
            <ChevronLeft {...ICON_PROPS} />
          </Button>
          <Button variant="ghost" aria-label="次の年" onClick={() => go(1)}>
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
      {data && data.hasMe && data.settings.hourlyWage === 0 && (
        <Hint>
          <Link to="/settings" className="underline">
            設定
          </Link>
          で時給を入力すると金額が表示されます
        </Hint>
      )}

      {data?.hasMe && (
        <>
          <div className="grid grid-cols-2 gap-2 pt-1 pb-4">
            {thisMonth && <Stat label="今月" value={yen(thisMonth.total)} sub={`${thisMonth.workDays}日 ・ ${formatMinutes(thisMonth.workedMinutes)}`} />}
            <Stat label="年間 (見込み含む)" value={yen(data.pay.total.total)} sub={`${data.pay.total.workDays}日`} />
          </div>

          {data.pay.wall && (
            <Section title={`年収の壁 ${man(data.pay.wall.wall)}${data.pay.wall.label ? ` ・ ${data.pay.wall.label}` : ""}`}>
              <WallMeter wall={data.pay.wall} />
              <Hint>
                勤務日で集計した概算です{data.pay.wall.includeTransport ? " (交通費を含む)" : " (交通費を含まない)"}
                。給料日や締め日による年のずれは考慮していません
              </Hint>
            </Section>
          )}

          <Section title="月ごと">
            <MonthlyBars months={data.pay.months} now={now} />
            <div className="overflow-x-auto pt-3">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-xs text-ink-500">
                    <th className="py-1 pr-2 text-left font-normal">月</th>
                    <th className="py-1 pr-2 text-right font-normal">出勤</th>
                    <th className="py-1 pr-2 text-right font-normal">実働</th>
                    <th className="hidden py-1 pr-2 text-right font-normal sm:table-cell">給与</th>
                    <th className="hidden py-1 pr-2 text-right font-normal sm:table-cell">交通費</th>
                    <th className="py-1 text-right font-normal">合計</th>
                  </tr>
                </thead>
                <tbody className="text-ink-700">
                  {data.pay.months.map((m) => (
                    <Row key={m.month} label={`${Number(m.month.slice(5))}月`} p={m} />
                  ))}
                  <Row label="年間" p={data.pay.total} strong />
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
