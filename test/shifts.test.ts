import { describe, expect, it } from "vitest";
import { call, createUser } from "./helpers";

async function setup() {
  const u = await createUser();
  const me = (await call(u.cookie, "POST", "/members", { name: "自分", aliases: [], isMe: true })).data.member;
  const other = (await call(u.cookie, "POST", "/members", { name: "他人", aliases: [], isMe: false })).data.member;
  const code = (
    await call(u.cookie, "POST", "/shift-codes", {
      symbol: "A",
      isOff: false,
      startTime: "09:00",
      endTime: "17:00",
      breakMinutes: 60,
    })
  ).data.shiftCode;
  const off = (
    await call(u.cookie, "POST", "/shift-codes", {
      symbol: "×",
      isOff: true,
      startTime: null,
      endTime: null,
      breakMinutes: 0,
    })
  ).data.shiftCode;
  return { ...u, me, other, code, off };
}

const shift = (memberId: string, date: string, extra: object = {}) => ({
  memberId,
  date,
  shiftCodeId: null,
  startTime: "09:00",
  endTime: "17:00",
  breakMinutes: 60,
  ...extra,
});

describe("シフト", () => {
  it("期間で取得できる (日付・開始時刻順)", async () => {
    const { cookie, me, other } = await setup();
    await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-02"));
    await call(cookie, "POST", "/shifts", shift(other.id, "2026-11-01", { startTime: "13:00", endTime: "22:00" }));
    await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01"));
    await call(cookie, "POST", "/shifts", shift(me.id, "2026-12-01"));

    const r = await call(cookie, "GET", "/shifts?from=2026-11-01&to=2026-11-30");
    expect(r.status).toBe(200);
    expect(r.data.shifts.map((s: any) => [s.date, s.startTime])).toEqual([
      ["2026-11-01", "09:00"],
      ["2026-11-01", "13:00"],
      ["2026-11-02", "09:00"],
    ]);
    expect(r.data.shifts[0].source).toBe("manual");
  });

  it("期間の指定が不正なら 400", async () => {
    const { cookie } = await setup();
    expect((await call(cookie, "GET", "/shifts?from=2026-11-30&to=2026-11-01")).status).toBe(400);
    expect((await call(cookie, "GET", "/shifts?from=2026-01-01&to=2026-12-31")).status).toBe(400);
    expect((await call(cookie, "GET", "/shifts?from=2026-02-30&to=2026-03-01")).status).toBe(400);
    expect((await call(cookie, "GET", "/shifts")).status).toBe(400);
  });

  it("日跨ぎを登録でき、開始と終了が同じなら 400", async () => {
    const { cookie, me } = await setup();
    const r = await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01", { startTime: "22:00", endTime: "05:00" }));
    expect(r.status).toBe(201);
    const same = await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01", { startTime: "10:00", endTime: "10:00" }));
    expect(same.status).toBe(400);
  });

  it("記号の参照と休み記号の拒否", async () => {
    const { cookie, me, code, off } = await setup();
    expect((await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01", { shiftCodeId: code.id }))).status).toBe(201);
    const r = await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01", { shiftCodeId: off.id }));
    expect(r.status).toBe(400);
  });

  it("記号を削除してもシフトは残る (記号の参照だけ外れる)", async () => {
    const { cookie, me, code } = await setup();
    await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01", { shiftCodeId: code.id }));
    await call(cookie, "DELETE", `/shift-codes/${code.id}`);
    const r = await call(cookie, "GET", "/shifts?from=2026-11-01&to=2026-11-01");
    expect(r.data.shifts).toHaveLength(1);
    expect(r.data.shifts[0].shiftCodeId).toBeNull();
  });

  it("メンバーを削除するとそのシフトも消える", async () => {
    const { cookie, other } = await setup();
    await call(cookie, "POST", "/shifts", shift(other.id, "2026-11-01"));
    await call(cookie, "DELETE", `/members/${other.id}`);
    expect((await call(cookie, "GET", "/shifts?from=2026-11-01&to=2026-11-01")).data.shifts).toEqual([]);
  });

  it("更新・削除", async () => {
    const { cookie, me } = await setup();
    const s = (await call(cookie, "POST", "/shifts", shift(me.id, "2026-11-01"))).data.shift;
    const u = await call(cookie, "PUT", `/shifts/${s.id}`, shift(me.id, "2026-11-03", { startTime: "10:00" }));
    expect(u.data.shift).toMatchObject({ date: "2026-11-03", startTime: "10:00" });
    expect((await call(cookie, "DELETE", `/shifts/${s.id}`)).status).toBe(200);
    expect((await call(cookie, "DELETE", `/shifts/${s.id}`)).status).toBe(404);
  });

  it("他ユーザーのメンバー・記号・シフトには触れない", async () => {
    const a = await setup();
    const b = await setup();
    // b が a のメンバー/記号を使って登録しようとする
    expect((await call(b.cookie, "POST", "/shifts", shift(a.me.id, "2026-11-01"))).status).toBe(400);
    expect(
      (await call(b.cookie, "POST", "/shifts", shift(b.me.id, "2026-11-01", { shiftCodeId: a.code.id }))).status,
    ).toBe(400);
    const s = (await call(a.cookie, "POST", "/shifts", shift(a.me.id, "2026-11-01"))).data.shift;
    expect((await call(b.cookie, "GET", "/shifts?from=2026-11-01&to=2026-11-01")).data.shifts).toEqual([]);
    expect((await call(b.cookie, "PUT", `/shifts/${s.id}`, shift(b.me.id, "2026-11-01"))).status).toBe(404);
    expect((await call(b.cookie, "DELETE", `/shifts/${s.id}`)).status).toBe(404);
  });
});
