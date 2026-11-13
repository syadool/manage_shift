import { describe, expect, it } from "vitest";
import { summarizeYear } from "../src/shared/stats";
import { call, createUser } from "./helpers";

const s = (date: string, startTime = "09:00", endTime = "17:00", breakMinutes = 60) => ({
  date,
  startTime,
  endTime,
  breakMinutes,
});
const rule = { hourlyWage: 1000, transportPerDay: 500 };

describe("summarizeYear", () => {
  const shifts = [s("2026-01-10"), s("2026-01-11"), s("2026-06-01"), s("2026-12-20"), s("2025-12-31"), s("2027-01-01")];

  it("月ごと・年合計・基準日前後に分ける (対象年の外は除く)", () => {
    const y = summarizeYear(2026, shifts, rule, "2026-06-30", { yen: null, label: null, includeTransport: false });
    expect(y.months).toHaveLength(12);
    expect(y.months[0]).toMatchObject({ month: "2026-01", workDays: 2, wage: 14000, transport: 1000 });
    expect(y.months[1].workDays).toBe(0);
    expect(y.total).toMatchObject({ workDays: 4, wage: 28000, transport: 2000 });
    expect(y.toDate.workDays).toBe(3);
    expect(y.ahead.workDays).toBe(1);
    expect(y.wall).toBeNull();
  });

  it("年収の壁: 交通費を含めるかで判定額が変わる", () => {
    const wall = { yen: 30000, label: "テスト", includeTransport: false };
    const without = summarizeYear(2026, shifts, rule, "2026-12-31", wall);
    expect(without.wall).toMatchObject({ earned: 28000, willExceed: false, label: "テスト" });
    const withT = summarizeYear(2026, shifts, rule, "2026-12-31", { ...wall, includeTransport: true });
    expect(withT.wall).toMatchObject({ earned: 30000 });
  });

  it("入っているシフトの見込みが今のペースより大きければ、それで予測する", () => {
    const many = Array.from({ length: 30 }, (_, i) => s(`2026-12-${String(i + 1).padStart(2, "0")}`));
    const y = summarizeYear(2026, many, rule, "2026-01-15", { yen: 100000, label: null, includeTransport: false });
    expect(y.wall).toMatchObject({ earned: 0, projected: 210000, willExceed: true });
  });

  it("未来の年は見込みだけ、過去の年は実績だけで判定する", () => {
    const future = summarizeYear(2027, shifts, rule, "2026-06-30", { yen: 1, label: null, includeTransport: false });
    expect(future.wall).toMatchObject({ earned: 0, projected: 7000 });
    const past = summarizeYear(2025, shifts, rule, "2026-06-30", { yen: 1, label: null, includeTransport: false });
    expect(past.wall).toMatchObject({ earned: 7000, projected: 7000 });
  });
});

async function setup() {
  const u = await createUser();
  const post = (p: string, b: unknown) => call(u.cookie, "POST", p, b);
  const me = (await post("/members", { name: "自分", aliases: [], isMe: true })).data.member;
  const a = (await post("/members", { name: "Aさん", aliases: [], isMe: false })).data.member;
  const b = (await post("/members", { name: "Bさん", aliases: [], isMe: false })).data.member;
  const shift = (memberId: string, date: string, startTime: string, endTime: string) =>
    post("/shifts", { memberId, date, shiftCodeId: null, startTime, endTime, breakMinutes: 0 });
  await shift(me.id, "2026-11-01", "09:00", "17:00");
  await shift(a.id, "2026-11-01", "13:00", "22:00"); // 4時間重なる
  await shift(b.id, "2026-11-01", "18:00", "22:00"); // 重ならない
  await shift(me.id, "2026-11-02", "09:00", "13:00");
  await shift(b.id, "2026-11-02", "09:00", "17:00"); // 4時間
  await shift(b.id, "2026-11-03", "09:00", "17:00"); // 自分は休み
  await shift(me.id, "2026-12-01", "09:00", "17:00");
  await shift(a.id, "2026-12-01", "09:00", "17:00"); // 8時間
  return { ...u, me, a, b };
}

describe("集計 API", () => {
  it("一緒に働いた人: 期間内で重なった時間の多い順", async () => {
    const { cookie, a, b } = await setup();
    const nov = await call(cookie, "GET", "/stats/coworkers?from=2026-11-01&to=2026-11-30");
    expect(nov.status).toBe(200);
    expect(nov.data.myDays).toBe(2);
    expect(nov.data.coworkers.map((c: any) => [c.memberId, c.name, c.days, c.minutes])).toEqual([
      [a.id, "Aさん", 1, 240],
      [b.id, "Bさん", 1, 240],
    ]);
    const all = await call(cookie, "GET", "/stats/coworkers?from=2026-11-01&to=2026-12-31");
    expect(all.data.coworkers[0]).toMatchObject({ memberId: a.id, days: 2, minutes: 720 });
  });

  it("一緒に働いた人: 自分が未設定なら空、期間が長すぎれば 400", async () => {
    const u = await createUser();
    const r = await call(u.cookie, "GET", "/stats/coworkers?from=2026-11-01&to=2026-11-30");
    expect(r.data).toEqual({ myDays: 0, coworkers: [], hasMe: false });
    expect((await call(u.cookie, "GET", "/stats/coworkers?from=2026-01-01&to=2027-06-01")).status).toBe(400);
  });

  it("給与: 自分のシフトだけを設定の時給で集計する", async () => {
    const { cookie } = await setup();
    await call(cookie, "PUT", "/settings", {
      hourlyWage: 1200,
      transportPerDay: 300,
      incomeWallYen: 1_300_000,
      wallLabel: "社会保険（扶養）",
      includeTransportInWall: false,
    });
    const r = await call(cookie, "GET", "/stats/pay?year=2026&today=2026-11-15");
    expect(r.status).toBe(200);
    expect(r.data.hasMe).toBe(true);
    expect(r.data.pay.months[10]).toMatchObject({ month: "2026-11", workDays: 2, workedMinutes: 720, wage: 14400, transport: 600 });
    expect(r.data.pay.months[11]).toMatchObject({ workDays: 1, wage: 9600 });
    expect(r.data.pay.wall).toMatchObject({ earned: 14400, wall: 1_300_000, label: "社会保険（扶養）", willExceed: false });
    expect(r.data.settings).toMatchObject({ hourlyWage: 1200 });
  });

  it("給与: 不正な年や基準日は 400、他ユーザーのシフトは含まない", async () => {
    const { cookie } = await setup();
    expect((await call(cookie, "GET", "/stats/pay?year=abc&today=2026-11-15")).status).toBe(400);
    expect((await call(cookie, "GET", "/stats/pay?year=2026&today=2026-02-30")).status).toBe(400);
    const other = await createUser();
    await call(other.cookie, "POST", "/members", { name: "x", aliases: [], isMe: true });
    const r = await call(other.cookie, "GET", "/stats/pay?year=2026&today=2026-11-15");
    expect(r.data.pay.total.workDays).toBe(0);
  });
});
