import { describe, expect, it } from "vitest";
import { addDays, addMonths, calendarCells, isValidDate, monthRange, weekday } from "../src/shared/dates";

describe("dates", () => {
  it("isValidDate", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-1-01")).toBe(false);
  });
  it("addDays / addMonths はまたぎを扱う", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
  it("monthRange", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("calendarCells は日曜始まりで7の倍数", () => {
    // 2026-11-01 は日曜
    expect(weekday("2026-11-01")).toBe(0);
    const cells = calendarCells("2026-11");
    expect(cells[0]).toBe("2026-11-01");
    expect(cells.length % 7).toBe(0);
    expect(cells.filter(Boolean)).toHaveLength(30);
    // 2026-12-01 は火曜 → 先頭に空きが2つ
    expect(calendarCells("2026-12").slice(0, 3)).toEqual([null, null, "2026-12-01"]);
  });
});
