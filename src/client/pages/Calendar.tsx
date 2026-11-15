import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { workedMinutes } from "../../shared/calc";
import { addMonths, calendarCells, isValidDate, monthRange, today, WEEKDAYS, weekday } from "../../shared/dates";
import { ICON_PROPS } from "../components/Layout";
import { Button, ErrorText, Hint } from "../components/ui";
import {
  coworkersOn,
  formatMinutes,
  shortTime,
  unknownShiftTitle,
  useShiftData,
  type Member,
  type UnknownShift,
} from "../lib/shiftData";

const monthLabel = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;
export const dayLabel = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEKDAYS[weekday(d)]}）`;

export function Calendar() {
  const [params, setParams] = useSearchParams();
  const now = today();
  // 存在しない月 (例: 2026-13) は今月として扱う
  const m = params.get("m") ?? "";
  const month = /^\d{4}-\d{2}$/.test(m) && isValidDate(`${m}-01`) ? m : now.slice(0, 7);
  const { from, to } = monthRange(month);
  const { loaded, error, me, memberById, byDate, unknownByDate } = useShiftData(from, to);
  const go = (n: number) => setParams({ m: addMonths(month, n) });

  const cells = calendarCells(month);
  // 自分の時間未登録のシフト (記号表に無い記号で取り込んだもの)
  const myUnknown = (d: string) => (me ? (unknownByDate.get(d) ?? []).filter((u) => u.memberId === me.id) : []);
  const listDays = cells
    .filter((d): d is string => !!d)
    .map((d) => ({ date: d, ...coworkersOn(byDate.get(d) ?? [], me?.id ?? null), unknown: myUnknown(d) }))
    .filter((d) => d.mine.length > 0 || d.unknown.length > 0);
  // 出勤日数・実働は時間がわかるシフトだけで数える
  const myDays = listDays.filter((d) => d.mine.length > 0);
  const unknownDays = listDays.filter((d) => d.mine.length === 0).length;
  const totalMinutes = myDays.reduce((sum, d) => sum + d.mine.reduce((s, m) => s + workedMinutes(m), 0), 0);
  const name = (id: string) => memberById.get(id)?.name ?? "";

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between pb-2">
        <p className="text-base">{monthLabel(month)}</p>
        <div className="flex gap-2">
          <Button variant="ghost" aria-label="前の月" onClick={() => go(-1)}>
            <ChevronLeft {...ICON_PROPS} />
          </Button>
          <Button variant="ghost" aria-label="次の月" onClick={() => go(1)}>
            <ChevronRight {...ICON_PROPS} />
          </Button>
        </div>
      </div>

      <ErrorText>{error && `読み込みに失敗しました: ${error}`}</ErrorText>

      {loaded && !me && (
        <Hint>
          <Link to="/settings" className="underline">
            設定
          </Link>
          で「自分」のメンバーを登録すると、自分のシフトが表示されます
        </Hint>
      )}

      <div className="grid grid-cols-7 border-b border-ink-100">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-xs text-ink-500">
            {w}
          </div>
        ))}
        {cells.map((d, i) =>
          d ? (
            <DayCell
              key={d}
              date={d}
              isToday={d === now}
              {...coworkersOn(byDate.get(d) ?? [], me?.id ?? null)}
              unknown={myUnknown(d)}
              memberName={name}
            />
          ) : (
            <div key={`e${i}`} className="border-t border-ink-100" />
          ),
        )}
      </div>

      <div className="flex gap-3 pt-3 pb-2 text-sm">
        <span>
          <span className="text-ink-500">出勤 </span>
          {myDays.length}日
        </span>
        <span>
          <span className="text-ink-500">実働 </span>
          {formatMinutes(totalMinutes)}
        </span>
        {unknownDays > 0 && (
          <span className="text-ink-500" title="記号表に無い記号の日は、出勤・実働に含めていません">
            時間未登録 {unknownDays}日
          </span>
        )}
      </div>

      <ul className="border-t border-ink-100">
        {listDays.map((d) => (
          <li key={d.date} className="border-b border-ink-100">
            <Link to={`/day/${d.date}`} className="grid grid-cols-[80px_1fr] gap-2 py-1 sm:grid-cols-[80px_120px_1fr]">
              <span className="text-sm">{dayLabel(d.date)}</span>
              <span className="text-sm">
                {d.mine.map((m) => `${shortTime(m.startTime)}–${shortTime(m.endTime)}`).join(", ")}
                {d.unknown.map((u) => (
                  <span key={u.id} title={unknownShiftTitle(u.symbol)} className="text-ink-500">
                    {d.mine.length > 0 ? ", " : ""}
                    {u.symbol}（時間未登録）
                  </span>
                ))}
              </span>
              <span className="col-start-2 text-sm text-ink-500 sm:col-start-auto">
                {d.coworkers.map((c) => name(c.memberId)).join("、") || "—"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DayCell({
  date,
  isToday,
  mine,
  unknown,
  coworkers,
  memberName,
}: {
  date: string;
  isToday: boolean;
  mine: { startTime: string; endTime: string }[];
  unknown: UnknownShift[];
  coworkers: { memberId: string }[];
  memberName: (id: string) => Member["name"];
}) {
  const day = Number(date.slice(8, 10));
  return (
    <Link to={`/day/${date}`} className="block min-h-8 border-t border-ink-100 pt-1 pr-1 pb-1 md:min-h-12">
      <span className={`text-xs ${isToday ? "font-bold text-ink-900 underline underline-offset-4" : "text-ink-500"}`}>
        {day}
      </span>
      {mine.map((m, i) => (
        <span key={i} className="mt-1 block rounded-sm bg-ink-900 text-center text-xs leading-3 text-white md:px-1 md:text-left">
          {shortTime(m.startTime)}
          <span className="hidden md:inline">–{shortTime(m.endTime)}</span>
        </span>
      ))}
      {unknown.map((u) => (
        <span
          key={u.id}
          title={unknownShiftTitle(u.symbol)}
          className="mt-1 block truncate rounded-sm bg-ink-100 text-center text-xs leading-3 text-ink-500 md:px-1 md:text-left"
        >
          {u.symbol}
          <span className="sr-only">（時間未登録）</span>
        </span>
      ))}
      {coworkers.length > 0 && (
        <>
          <span className="block pt-1 text-xs text-ink-500 md:hidden">+{coworkers.length}</span>
          <span className="hidden pt-1 text-xs text-ink-500 md:block">
            {coworkers.slice(0, 3).map((c) => (
              <span key={c.memberId} className="block truncate">
                {memberName(c.memberId)}
              </span>
            ))}
            {coworkers.length > 3 && <span className="block">+{coworkers.length - 3}</span>}
          </span>
        </>
      )}
    </Link>
  );
}
