import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { overlapMinutes, span, workedMinutes } from "../../shared/calc";
import { addDays, isValidDate } from "../../shared/dates";
import { ICON_PROPS } from "../components/Layout";
import { ShiftForm } from "../components/ShiftForm";
import { Button, Hint } from "../components/ui";
import { formatMinutes, shortTime, useShiftData, type Shift } from "../lib/shiftData";
import { dayLabel } from "./Calendar";

/** 表示する時間帯 (時)。シフトに合わせて広げ、日跨ぎは 24 時以降として描く */
function hourRange(shifts: Shift[]): [number, number] {
  let lo = 9;
  let hi = 22;
  for (const s of shifts) {
    const [a, b] = span(s);
    lo = Math.min(lo, Math.floor(a / 60));
    hi = Math.max(hi, Math.ceil(b / 60));
  }
  return [lo, hi];
}

/**
 * 日付ごとに画面を作り直す (key=date)。
 * 編集中のフォームが別の日に持ち越され、元のシフトの日付を書き換えてしまうのを防ぐ
 */
export function Day() {
  const { date = "" } = useParams();
  return <DayView key={date} date={date} />;
}

function DayView({ date }: { date: string }) {
  const navigate = useNavigate();
  const valid = isValidDate(date);
  const data = useShiftData(valid ? date : "2000-01-01", valid ? date : "2000-01-01");
  const [editing, setEditing] = useState<Shift | "new" | null>(null);
  if (!valid) return <Navigate to="/" replace />;

  const { loaded, members, codes, me, memberById, byDate, reloadShifts } = data;
  const dayShifts = byDate.get(date) ?? [];
  const mine = dayShifts.filter((s) => s.memberId === me?.id);
  const rows = [...dayShifts].sort(
    (a, b) => Number(b.memberId === me?.id) - Number(a.memberId === me?.id) || span(a)[0] - span(b)[0],
  );
  const [lo, hi] = hourRange(dayShifts);
  const pct = (min: number) => ((min - lo * 60) / ((hi - lo) * 60)) * 100;
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const step = hi - lo > 12 ? 3 : 2;

  const done = () => {
    setEditing(null);
    reloadShifts();
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between pb-2">
        <Link to={`/?m=${date.slice(0, 7)}`} className="text-base">
          {dayLabel(date)}
        </Link>
        <div className="flex gap-2">
          <Button variant="ghost" aria-label="前の日" onClick={() => navigate(`/day/${addDays(date, -1)}`)}>
            <ChevronLeft {...ICON_PROPS} />
          </Button>
          <Button variant="ghost" aria-label="次の日" onClick={() => navigate(`/day/${addDays(date, 1)}`)}>
            <ChevronRight {...ICON_PROPS} />
          </Button>
        </div>
      </div>

      {loaded && dayShifts.length === 0 && <p className="py-2 text-sm text-ink-500">シフトなし</p>}

      {dayShifts.length > 0 && (
        <div className="grid grid-cols-[80px_1fr] gap-x-2">
          {/* 時刻の目盛り */}
          <div />
          <div className="relative h-3 text-xs text-ink-500">
            {hours
              .filter((h) => (h - lo) % step === 0)
              .map((h) => (
                <span key={h} className="absolute -translate-x-1/2" style={{ left: `${pct(h * 60)}%` }}>
                  {h % 24}
                </span>
              ))}
          </div>

          {rows.map((s) => {
            const isMe = s.memberId === me?.id;
            const [a, b] = span(s);
            const overlaps = isMe
              ? []
              : mine.flatMap((m) => {
                  if (overlapMinutes(m, s) === 0) return [];
                  const [ma, mb] = span(m);
                  return [[Math.max(a, ma), Math.min(b, mb)]];
                });
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setEditing(s)}
                className="col-span-2 grid grid-cols-subgrid items-center border-t border-ink-100 py-1 text-left"
              >
                <span className="min-w-0">
                  <span className={`block truncate text-sm ${isMe ? "text-ink-900" : "text-ink-700"}`}>
                    {memberById.get(s.memberId)?.name}
                  </span>
                  <span className="block text-xs text-ink-500">
                    {shortTime(s.startTime)}–{shortTime(s.endTime)}
                  </span>
                </span>
                <span className="relative h-3">
                  {/* 1時間ごとの補助線 */}
                  {hours.map((h) => (
                    <span
                      key={h}
                      className="absolute inset-y-0 border-l border-ink-100"
                      style={{ left: `${pct(h * 60)}%` }}
                    />
                  ))}
                  <span
                    className={`absolute inset-y-0 rounded-sm ${isMe ? "bg-ink-900" : "bg-ink-300"}`}
                    style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%` }}
                  />
                  {overlaps.map(([oa, ob], i) => (
                    <span
                      key={i}
                      className="absolute inset-y-0 bg-ink-700"
                      style={{ left: `${pct(oa)}%`, width: `${pct(ob) - pct(oa)}%` }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {mine.length > 0 && (
        <p className="pt-2 text-sm">
          <span className="text-ink-500">実働 </span>
          {formatMinutes(mine.reduce((sum, m) => sum + workedMinutes(m), 0))}
        </p>
      )}

      <div className="pt-3">
        {editing ? (
          <ShiftForm
            key={editing === "new" ? "new" : editing.id}
            date={date}
            members={members}
            codes={codes}
            shift={editing === "new" ? undefined : editing}
            defaultMemberId={me?.id}
            onDone={done}
          />
        ) : (
          <Button variant="secondary" onClick={() => setEditing("new")} disabled={!loaded || members.length === 0}>
            <Plus {...ICON_PROPS} />
            シフトを追加
          </Button>
        )}
        {loaded && members.length === 0 && (
          <Hint>
            <Link to="/settings" className="underline">
              設定
            </Link>
            でメンバーを登録してください
          </Hint>
        )}
      </div>
    </div>
  );
}
