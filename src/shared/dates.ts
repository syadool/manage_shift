/** "YYYY-MM-DD" / "YYYY-MM" の日付文字列ユーティリティ (タイムゾーンに依存しないよう UTC で計算) */

const DAY_MS = 86_400_000;

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const format = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  return format(new Date(parse(date).getTime() + n * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / DAY_MS);
}

/** 0 = 日曜 */
export function weekday(date: string): number {
  return parse(date).getUTCDay();
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  return { from, to: addDays(`${addMonths(month, 1)}-01`, -1) };
}

/** 月カレンダー (日曜始まり) のマス。前後月の日付は null */
export function calendarCells(month: string): (string | null)[] {
  const { from, to } = monthRange(month);
  const cells: (string | null)[] = Array(weekday(from)).fill(null);
  for (let d = from; d <= to; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 端末のローカル日付 "YYYY-MM-DD" */
export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
