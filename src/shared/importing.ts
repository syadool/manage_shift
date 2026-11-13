import { z } from "zod";
import { isValidDate } from "./dates";
import { normalizeName } from "./names";

/**
 * シフト表画像の読み取り結果。Claude の構造化出力のスキーマにもそのまま使うため、
 * 構造化出力が扱える範囲 (数値・文字列の範囲制約なし) にとどめ、範囲は validateExtraction で確認する
 */
export const extractionSchema = z.object({
  /** 表から読み取れた年月 "YYYY-MM"。読み取れなければ null */
  yearMonth: z.string().nullable(),
  rows: z.array(
    z.object({
      /** 表に書かれている名前 (そのまま) */
      name: z.string(),
      /** 日ごとのセル。空欄は symbol を "" にする */
      cells: z.array(z.object({ day: z.number().int(), symbol: z.string() })),
    }),
  ),
  /** 読み取りにくかった箇所などのメモ */
  notes: z.string(),
});
export type Extraction = z.infer<typeof extractionSchema>;

/** 読み取り結果を整える: 範囲外の日を捨て、同じ日の重複は最初を採用し、日付順に並べる */
export function cleanExtraction(raw: Extraction): Extraction {
  const yearMonth = raw.yearMonth && /^\d{4}-\d{2}$/.test(raw.yearMonth) && isValidDate(`${raw.yearMonth}-01`)
    ? raw.yearMonth
    : null;
  return {
    yearMonth,
    notes: raw.notes,
    rows: raw.rows
      .map((r) => {
        const seen = new Set<number>();
        const cells = r.cells
          .filter((c) => Number.isInteger(c.day) && c.day >= 1 && c.day <= 31)
          .filter((c) => (seen.has(c.day) ? false : (seen.add(c.day), true)))
          .map((c) => ({ day: c.day, symbol: c.symbol.trim() }))
          .sort((a, b) => a.day - b.day);
        return { name: r.name.trim(), cells };
      })
      .filter((r) => r.name !== ""),
  };
}

/** 記号の照合用正規化 (全角/半角の統一と前後の空白除去。大文字小文字は区別する) */
export function normalizeSymbol(symbol: string): string {
  return symbol.normalize("NFKC").trim();
}

type MemberLike = { id: string; name: string; aliases: string[] };
type CodeLike = { id: string; symbol: string; isOff: boolean };

/** 読み取った名前に一致するメンバー (名前・別名を正規化して照合) */
export function matchMember<M extends MemberLike>(readName: string, members: M[]): M | null {
  const key = normalizeName(readName);
  return members.find((m) => [m.name, ...m.aliases].some((n) => normalizeName(n) === key)) ?? null;
}

/**
 * 記号に一致する記号表の行。
 * 完全一致 (前後の空白は除く) を優先し、無ければ表記ゆれ (全角/半角など) をそろえて照合する。
 * そろえた結果が複数の記号に当たる場合 (例: 「1」と「①」) は、どれか決められないので null (未知の記号) にする
 */
export function matchCode<C extends CodeLike>(symbol: string, codes: C[]): C | null {
  const exact = codes.filter((c) => c.symbol.trim() === symbol.trim());
  if (exact.length === 1) return exact[0];
  const key = normalizeSymbol(symbol);
  const loose = codes.filter((c) => normalizeSymbol(c.symbol) === key);
  return loose.length === 1 ? loose[0] : null;
}

/** 確定時の入力。行ごとに、既存メンバーへ紐付け / 新規メンバー / 取り込まない のいずれか */
export const commitInput = z.object({
  yearMonth: z
    .string()
    .refine((v) => /^\d{4}-\d{2}$/.test(v) && isValidDate(`${v}-01`), "年月を YYYY-MM で入力してください"),
  rows: z
    .array(
      z.object({
        readName: z.string().trim().max(40, "読み取った名前は40文字までです"),
        target: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("member"),
            memberId: z.string().min(1),
            /** 読み取った名前を別名として覚えるか */
            rememberAlias: z.boolean(),
          }),
          z.object({
            type: z.literal("new"),
            name: z.string().trim().min(1, "新しいメンバーの名前を入力してください").max(40),
          }),
          z.object({ type: z.literal("skip") }),
        ]),
        cells: z
          .array(z.object({ day: z.number().int().min(1).max(31), symbol: z.string().max(8, "記号は8文字までです") }))
          .max(31),
      }),
    )
    .max(100, "行が多すぎます"),
});
export type CommitInput = z.infer<typeof commitInput>;
