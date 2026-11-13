/** 勤務時間・給与・重なりの計算 (純粋関数) */

export type Interval = { start: string; end: string };
export type WorkShift = Interval & { date: string; breakMinutes: number };

const DAY = 24 * 60;

/** "HH:MM" -> 分 */
export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`invalid time: ${hhmm}`);
  return h * 60 + min;
}

/** その日 0:00 起点の [開始, 終了) 分。終了が開始以前なら翌日に跨ぐ */
export function span({ start, end }: Interval): [number, number] {
  const s = toMinutes(start);
  let e = toMinutes(end);
  if (e <= s) e += DAY;
  return [s, e];
}

/** 実働分 = 拘束時間 − 休憩 (負にはしない) */
export function workedMinutes(shift: Interval & { breakMinutes: number }): number {
  const [s, e] = span(shift);
  return Math.max(0, e - s - shift.breakMinutes);
}

/** 同じ日に始まる2つのシフトの重なり分 */
export function overlapMinutes(a: Interval, b: Interval): number {
  const [as, ae] = span(a);
  const [bs, be] = span(b);
  return Math.max(0, Math.min(ae, be) - Math.max(as, bs));
}

export type PayRule = { hourlyWage: number; transportPerDay: number };

export type PaySummary = {
  workDays: number;
  workedMinutes: number;
  wage: number;
  transport: number;
  total: number;
};

/** 概算給与。1分単位で計算し、円未満は切り捨て */
export function summarizePay(shifts: WorkShift[], rule: PayRule): PaySummary {
  const minutes = shifts.reduce((sum, s) => sum + workedMinutes(s), 0);
  const workDays = new Set(shifts.map((s) => s.date)).size;
  const wage = Math.floor((minutes * rule.hourlyWage) / 60);
  const transport = workDays * rule.transportPerDay;
  return { workDays, workedMinutes: minutes, wage, transport, total: wage + transport };
}

export type WallStatus = {
  earned: number;
  wall: number;
  remaining: number;
  /** 今のペースのままの年末予測 */
  projected: number;
  willExceed: boolean;
};

/**
 * 年収の壁チェック。
 * @param earned 1月〜基準日までの累計 (壁の判定対象額)
 * @param asOf 基準日 "YYYY-MM-DD"
 * @param scheduledAhead 基準日より後に既に入っているシフト分の見込み額
 */
export function wallStatus(
  earned: number,
  wall: number,
  asOf: string,
  scheduledAhead = 0,
): WallStatus {
  const d = new Date(`${asOf}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const elapsedRatio = (d.getTime() - start + 86400000) / (end - start);
  const paceProjection = elapsedRatio > 0 ? Math.round(earned / elapsedRatio) : earned;
  const projected = Math.max(paceProjection, earned + scheduledAhead);
  return {
    earned,
    wall,
    remaining: wall - earned,
    projected,
    willExceed: projected > wall,
  };
}

export type CoworkerStat = { memberId: string; days: number; minutes: number };

/** 自分のシフトと他メンバーのシフトから「誰と何日・何分かぶったか」を集計 (分の多い順) */
export function coworkerStats(
  mine: WorkShift[],
  others: (WorkShift & { memberId: string })[],
): CoworkerStat[] {
  const byDate = new Map<string, WorkShift[]>();
  for (const s of mine) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);

  const stats = new Map<string, { days: Set<string>; minutes: number }>();
  for (const o of others) {
    const mineThatDay = byDate.get(o.date);
    if (!mineThatDay) continue;
    const minutes = mineThatDay.reduce((sum, m) => sum + overlapMinutes(m, o), 0);
    if (minutes === 0) continue;
    const st = stats.get(o.memberId) ?? { days: new Set<string>(), minutes: 0 };
    st.days.add(o.date);
    st.minutes += minutes;
    stats.set(o.memberId, st);
  }
  return [...stats]
    .map(([memberId, s]) => ({ memberId, days: s.days.size, minutes: s.minutes }))
    .sort((a, b) => b.minutes - a.minutes || b.days - a.days);
}
