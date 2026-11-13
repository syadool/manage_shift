import { summarizePay, wallStatus, type PayRule, type PaySummary, type WallStatus, type WorkShift } from "./calc";

export type MonthPay = PaySummary & { month: string };

export type YearPay = {
  year: number;
  months: MonthPay[];
  total: PaySummary;
  /** 基準日までに働いた分 */
  toDate: PaySummary;
  /** 基準日より後に入っているシフトの分 */
  ahead: PaySummary;
  /** 年収の壁 (設定されていれば) */
  wall: (WallStatus & { label: string | null; includeTransport: boolean }) | null;
};

export type WallSetting = { yen: number | null; label: string | null; includeTransport: boolean };

/**
 * 1年分の給与を集計する (勤務日ベース)。
 * 年収の壁は、基準日までの実績と、それ以降に入っているシフトの見込みから年末の額を予測する
 */
export function summarizeYear(
  year: number,
  shifts: WorkShift[],
  rule: PayRule,
  today: string,
  wall: WallSetting,
): YearPay {
  const inYear = shifts.filter((s) => s.date.startsWith(`${year}-`));
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { month, ...summarizePay(inYear.filter((s) => s.date.startsWith(month)), rule) };
  });
  const toDate = summarizePay(inYear.filter((s) => s.date <= today), rule);
  const ahead = summarizePay(inYear.filter((s) => s.date > today), rule);
  const total = summarizePay(inYear, rule);

  const amount = (p: PaySummary) => (wall.includeTransport ? p.total : p.wage);
  // 基準日が対象年の外なら、その年の範囲に収めて予測する (過去の年は実績のみ、未来の年は見込みのみ)
  const asOf = today < `${year}-01-01` ? `${year}-01-01` : today > `${year}-12-31` ? `${year}-12-31` : today;
  const wallResult =
    wall.yen == null
      ? null
      : {
          ...wallStatus(amount(toDate), wall.yen, asOf, amount(ahead)),
          label: wall.label,
          includeTransport: wall.includeTransport,
        };
  return { year, months, total, toDate, ahead, wall: wallResult };
}
