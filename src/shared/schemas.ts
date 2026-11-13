import { z } from "zod";

/** API の入力スキーマ (サーバーとクライアントで共有) */

const yen = (label: string, max: number) =>
  z
    .number({ error: `${label}を数値で入力してください` })
    .int(`${label}は整数で入力してください`)
    .min(0, `${label}は0以上で入力してください`)
    .max(max, `${label}が大きすぎます`);

export const time = z
  .string()
  .regex(/^([01]\d|2[0-4]):[0-5]\d$/, "時刻は HH:MM で入力してください")
  .refine((v) => v <= "24:00", "時刻は 24:00 までで入力してください");

export const settingsInput = z.object({
  hourlyWage: yen("時給", 100_000),
  transportPerDay: yen("交通費", 100_000),
  incomeWallYen: yen("年収の壁", 100_000_000).nullable(),
  wallLabel: z.string().trim().max(40, "壁の名前は40文字までです").nullable(),
  includeTransportInWall: z.boolean(),
});
export type SettingsInput = z.infer<typeof settingsInput>;

export const shiftCodeInput = z
  .object({
    symbol: z.string().trim().min(1, "記号を入力してください").max(8, "記号は8文字までです"),
    isOff: z.boolean(),
    startTime: time.nullable(),
    endTime: time.nullable(),
    breakMinutes: z
      .number()
      .int()
      .min(0, "休憩は0分以上で入力してください")
      .max(24 * 60, "休憩が長すぎます"),
  })
  .refine((v) => v.isOff || (v.startTime && v.endTime), {
    message: "開始・終了時刻を入力してください",
  })
  .transform((v) => (v.isOff ? { ...v, startTime: null, endTime: null, breakMinutes: 0 } : v));
export type ShiftCodeInput = z.input<typeof shiftCodeInput>;

export const memberInput = z.object({
  name: z.string().trim().min(1, "名前を入力してください").max(40, "名前は40文字までです"),
  aliases: z
    .array(z.string().trim().min(1).max(40))
    .max(20, "別名は20個までです")
    .transform((a) => [...new Set(a)]),
  isMe: z.boolean(),
});
export type MemberInput = z.infer<typeof memberInput>;
