import { useCallback, useEffect, useMemo, useState } from "react";
import { overlapMinutes } from "../../shared/calc";
import type { ShiftCodeInput, ShiftInput } from "../../shared/schemas";
import { api } from "./api";

export type Member = { id: string; name: string; aliases: string[]; isMe: boolean };
export type ShiftCode = ShiftCodeInput & { id: string };
export type Shift = ShiftInput & { id: string; source: "ocr" | "manual" };

/** 期間内のシフトと、メンバー・記号をまとめて取得する */
export function useShiftData(from: string, to: string) {
  const [members, setMembers] = useState<Member[]>();
  const [codes, setCodes] = useState<ShiftCode[]>();
  const [shifts, setShifts] = useState<Shift[]>();
  const [error, setError] = useState("");

  const reloadShifts = useCallback(() => {
    api<{ shifts: Shift[] }>(`/shifts?from=${from}&to=${to}`)
      .then((r) => setShifts(r.shifts))
      .catch((e: Error) => setError(e.message));
  }, [from, to]);

  useEffect(() => {
    api<{ members: Member[] }>("/members").then((r) => setMembers(r.members));
    api<{ shiftCodes: ShiftCode[] }>("/shift-codes").then((r) => setCodes(r.shiftCodes));
  }, []);
  useEffect(reloadShifts, [reloadShifts]);

  const me = members?.find((m) => m.isMe) ?? null;
  const memberById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);
  const byDate = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts ?? []) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [shifts]);

  const loaded = members !== undefined && codes !== undefined && shifts !== undefined;
  return { loaded, error, members: members ?? [], codes: codes ?? [], shifts: shifts ?? [], me, memberById, byDate, reloadShifts };
}

/** その日の自分のシフトと、時間が重なる他メンバー (重なり分の多い順) */
export function coworkersOn(dayShifts: Shift[], meId: string | null) {
  const mine = dayShifts.filter((s) => s.memberId === meId);
  const others = new Map<string, number>();
  for (const o of dayShifts) {
    if (o.memberId === meId) continue;
    const min = mine.reduce((sum, m) => sum + overlapMinutes(m, o), 0);
    if (min > 0) others.set(o.memberId, (others.get(o.memberId) ?? 0) + min);
  }
  return {
    mine,
    coworkers: [...others].sort((a, b) => b[1] - a[1]).map(([memberId, minutes]) => ({ memberId, minutes })),
  };
}

/** "09:00" -> "9:00" */
export const shortTime = (t: string) => t.replace(/^0(\d)/, "$1");

export const formatMinutes = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
