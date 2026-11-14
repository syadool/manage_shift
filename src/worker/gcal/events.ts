/** シフト → Google カレンダーの予定 (純粋関数) */
import { overlapMinutes, span } from "../../shared/calc";
import { addDays } from "../../shared/dates";
import { TIME_ZONE, type GEvent } from "./google";

/** 予定に付ける印。この印の付いた予定だけをアプリが管理する (ユーザーが手で足した予定は触らない) */
export const APP_MARK = "manageshift";

export type TitleMode = "symbol" | "workplace";
export type TitleOptions = { titleMode: TitleMode; workplaceName: string | null };

export type MyShift = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  symbol: string | null;
};
export type OtherShift = { date: string; startTime: string; endTime: string; name: string };

const DEFAULT_TITLE = "シフト";

/** シフト ID (UUID) → 予定 ID。Google の予定 ID は base32hex (0-9a-v) なので、ハイフンを除いた16進はそのまま使える */
export function eventId(shiftId: string): string {
  return shiftId.toLowerCase().replace(/[^0-9a-v]/g, "");
}

export function eventTitle(shift: Pick<MyShift, "symbol">, opts: TitleOptions): string {
  const t = opts.titleMode === "workplace" ? opts.workplaceName?.trim() : shift.symbol?.trim();
  return t || DEFAULT_TITLE;
}

/** その日 0:00 からの分 → "YYYY-MM-DDTHH:MM:00" (24:00 や日跨ぎは翌日に繰り上げる) */
function localDateTime(date: string, minutes: number): string {
  const d = addDays(date, Math.floor(minutes / 1440));
  const m = minutes % 1440;
  return `${d}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
}

/** 同じ日に始まり、時間が重なる他のメンバーの名前 (重複なし・出現順) */
export function coworkersOf(shift: MyShift, others: OtherShift[]): string[] {
  const names = others.filter((o) => o.date === shift.date && overlapMinutes(shift, o) > 0).map((o) => o.name);
  return [...new Set(names)];
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 予定を組み立てる。内容の指紋を extendedProperties に入れ、変化が無ければ更新を省く */
export async function buildEvent(shift: MyShift, others: OtherShift[], opts: TitleOptions): Promise<GEvent> {
  const [s, e] = span(shift);
  const coworkers = coworkersOf(shift, others);
  const lines = [
    ...(coworkers.length ? [`一緒に働く人: ${coworkers.join("、")}`] : []),
    ...(shift.breakMinutes ? [`休憩: ${shift.breakMinutes}分`] : []),
    "manageshift から自動で登録した予定です。変更はアプリで行ってください",
  ];
  const body = {
    id: eventId(shift.id),
    summary: eventTitle(shift, opts),
    description: lines.join("\n"),
    start: { dateTime: localDateTime(shift.date, s), timeZone: TIME_ZONE },
    end: { dateTime: localDateTime(shift.date, e), timeZone: TIME_ZONE },
  };
  return { ...body, extendedProperties: { private: { app: APP_MARK, h: await hash(body) } } };
}
