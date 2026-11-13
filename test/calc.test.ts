import { describe, expect, it } from "vitest";
import {
  coworkerStats,
  overlapMinutes,
  summarizePay,
  toMinutes,
  wallStatus,
  workedMinutes,
} from "../src/shared/calc";

describe("toMinutes", () => {
  it("parses HH:MM", () => {
    expect(toMinutes("09:30")).toBe(570);
    expect(toMinutes("0:00")).toBe(0);
    expect(toMinutes("24:00")).toBe(1440);
  });
  it("rejects invalid", () => {
    expect(() => toMinutes("25:00")).toThrow();
    expect(() => toMinutes("9:60")).toThrow();
    expect(() => toMinutes("abc")).toThrow();
  });
});

describe("workedMinutes", () => {
  it("subtracts break", () => {
    expect(workedMinutes({ start: "09:00", end: "17:00", breakMinutes: 60 })).toBe(420);
  });
  it("handles overnight", () => {
    expect(workedMinutes({ start: "22:00", end: "05:00", breakMinutes: 0 })).toBe(420);
  });
  it("never negative", () => {
    expect(workedMinutes({ start: "09:00", end: "09:30", breakMinutes: 60 })).toBe(0);
  });
});

describe("overlapMinutes", () => {
  it("partial overlap", () => {
    expect(overlapMinutes({ start: "09:00", end: "17:00" }, { start: "15:00", end: "22:00" })).toBe(120);
  });
  it("no overlap when touching", () => {
    expect(overlapMinutes({ start: "09:00", end: "15:00" }, { start: "15:00", end: "22:00" })).toBe(0);
  });
  it("overnight overlap", () => {
    expect(overlapMinutes({ start: "20:00", end: "02:00" }, { start: "22:00", end: "06:00" })).toBe(240);
  });
});

describe("summarizePay", () => {
  it("wage + transport per distinct day", () => {
    const r = summarizePay(
      [
        { date: "2026-11-01", start: "09:00", end: "17:00", breakMinutes: 60 },
        { date: "2026-11-02", start: "18:00", end: "22:30", breakMinutes: 0 },
      ],
      { hourlyWage: 1200, transportPerDay: 300 },
    );
    expect(r.workDays).toBe(2);
    expect(r.workedMinutes).toBe(420 + 270);
    expect(r.wage).toBe(1200 * 7 + 1200 * 4.5);
    expect(r.transport).toBe(600);
    expect(r.total).toBe(r.wage + 600);
  });
});

describe("wallStatus", () => {
  it("projects by pace", () => {
    // 年の半分強が経過した時点で 60 万 → 年末予測は約 110 万
    const s = wallStatus(600_000, 1_030_000, "2026-07-01");
    expect(s.remaining).toBe(430_000);
    expect(s.projected).toBeGreaterThan(1_000_000);
    expect(s.willExceed).toBe(true);
  });
  it("uses scheduled shifts when larger than pace", () => {
    const s = wallStatus(100_000, 1_030_000, "2026-12-01", 950_000);
    expect(s.projected).toBe(1_050_000);
    expect(s.willExceed).toBe(true);
  });
});

describe("coworkerStats", () => {
  it("ranks by overlap minutes", () => {
    const mine = [
      { date: "2026-11-01", start: "09:00", end: "17:00", breakMinutes: 60 },
      { date: "2026-11-02", start: "09:00", end: "13:00", breakMinutes: 0 },
    ];
    const others = [
      { memberId: "a", date: "2026-11-01", start: "12:00", end: "20:00", breakMinutes: 0 },
      { memberId: "b", date: "2026-11-01", start: "09:00", end: "17:00", breakMinutes: 0 },
      { memberId: "b", date: "2026-11-02", start: "12:00", end: "18:00", breakMinutes: 0 },
      { memberId: "c", date: "2026-11-03", start: "09:00", end: "17:00", breakMinutes: 0 },
    ];
    expect(coworkerStats(mine, others)).toEqual([
      { memberId: "b", days: 2, minutes: 480 + 60 },
      { memberId: "a", days: 1, minutes: 300 },
    ]);
  });
});
