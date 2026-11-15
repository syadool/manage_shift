import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { overlapMinutes } from "../../shared/calc";
import type { ShiftCodeInput, ShiftInput } from "../../shared/schemas";
import { api } from "./api";

export type Member = { id: string; name: string; aliases: string[]; isMe: boolean };
export type ShiftCode = ShiftCodeInput & { id: string };
export type Shift = ShiftInput & { id: string; source: "ocr" | "manual" };
/** 記号表に無い記号で取り込んだ、時間未登録のシフト */
export type UnknownShift = { id: string; memberId: string; date: string; symbol: string };

/** 期間内のシフトと、メンバー・記号をまとめて取得する */
export function useShiftData(from: string, to: string) {
  const [members, setMembers] = useState<Member[]>();
  const [codes, setCodes] = useState<ShiftCode[]>();
  const [shifts, setShifts] = useState<Shift[]>();
  const [unknownShifts, setUnknownShifts] = useState<UnknownShift[]>([]);
  // メンバー・記号の取得エラーと、シフトの取得エラーは別々に持つ
  // (シフトの再取得が成功しても、メンバー側のエラーを消さないため)
  const [refError, setRefError] = useState("");
  const [shiftError, setShiftError] = useState("");
  const error = refError || shiftError;

  // 期間を素早く切り替えたとき、古い期間の応答が後から届いて上書きしないよう、
  // 最後に出した要求の応答だけを反映する
  const generation = useRef(0);
  const reloadShifts = useCallback(() => {
    const gen = ++generation.current;
    api<{ shifts: Shift[]; unknownShifts?: UnknownShift[] }>(`/shifts?from=${from}&to=${to}`)
      .then((r) => {
        if (gen !== generation.current) return;
        setShifts(r.shifts);
        setUnknownShifts(r.unknownShifts ?? []);
        setShiftError("");
      })
      .catch((e: Error) => {
        if (gen === generation.current) setShiftError(e.message || "読み込みに失敗しました");
      });
  }, [from, to]);

  useEffect(() => {
    const fail = (e: Error) => setRefError(e.message || "読み込みに失敗しました");
    api<{ members: Member[] }>("/members")
      .then((r) => setMembers(r.members))
      .catch(fail);
    api<{ shiftCodes: ShiftCode[] }>("/shift-codes")
      .then((r) => setCodes(r.shiftCodes))
      .catch(fail);
  }, []);
  useEffect(reloadShifts, [reloadShifts]);

  const me = members?.find((m) => m.isMe) ?? null;
  const memberById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);
  const byDate = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts ?? []) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [shifts]);
  const unknownByDate = useMemo(() => {
    const map = new Map<string, UnknownShift[]>();
    for (const s of unknownShifts) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [unknownShifts]);

  const loaded = members !== undefined && codes !== undefined && shifts !== undefined;
  return { loaded, error, members: members ?? [], codes: codes ?? [], shifts: shifts ?? [], unknownShifts, me, memberById, byDate, unknownByDate, reloadShifts };
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

/** 時間未登録のシフトの説明 (ポイントしたときに出す) */
export const unknownShiftTitle = (symbol: string) =>
  `記号「${symbol}」は記号表に無いため、時間が未登録です。記号表に追加すると時間が入ります`;

/** "09:00" -> "9:00" */
export const shortTime = (t: string) => t.replace(/^0(\d)/, "$1");

export const formatMinutes = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
