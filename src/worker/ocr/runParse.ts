import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { imports, members, shiftCodes } from "../db/schema";
import { ExtractError, ocr } from "./extract";

/**
 * 1回の読み取りを最後まで行い、結果を保存する。
 * 画面との接続が切れても止まらないよう、Workflow から呼ぶ (テストでは直接呼ぶ)。
 * 結果は、この読み取りのトークンが今も有効で、読み取り中のままのときだけ保存する
 * (後から始めた読み取りや、別の画面での確定を上書きしないため)。
 * 例外は投げず、失敗は imports.error に記録する。
 */
export async function runParse(env: Env, importId: string, token: string): Promise<"parsed" | "failed" | "stale"> {
  const db = getDb(env);
  const stillMine = and(eq(imports.id, importId), eq(imports.parseToken, token), eq(imports.status, "parsing"));

  const fail = async (message: string) => {
    const row = await db
      .update(imports)
      .set({ status: "failed", error: message })
      .where(stillMine)
      .returning({ id: imports.id })
      .get();
    return row ? "failed" : "stale";
  };

  const target = await db
    .select({ userId: imports.userId, r2Key: imports.r2Key, contentType: imports.contentType })
    .from(imports)
    .where(stillMine)
    .get();
  if (!target) return "stale";

  try {
    const object = await env.IMAGES.get(target.r2Key);
    if (!object) return fail("画像が見つかりません");

    const [memberRows, codeRows] = await Promise.all([
      db.select({ name: members.name, aliases: members.aliases }).from(members).where(eq(members.userId, target.userId)),
      db.select({ symbol: shiftCodes.symbol }).from(shiftCodes).where(eq(shiftCodes.userId, target.userId)),
    ]);

    const result = await ocr.extract(env, {
      image: await object.arrayBuffer(),
      mediaType: target.contentType as "image/jpeg" | "image/png" | "image/webp",
      knownSymbols: codeRows.map((r) => r.symbol),
      knownNames: memberRows.flatMap((m) => [m.name, ...m.aliases]),
    });
    const saved = await db
      .update(imports)
      .set({ status: "parsed", rawResult: result, targetMonth: result.yearMonth, error: null })
      .where(stillMine)
      .returning({ id: imports.id })
      .get();
    return saved ? "parsed" : "stale";
  } catch (e) {
    if (!(e instanceof ExtractError)) console.error("extract failed", e);
    return fail(e instanceof ExtractError ? e.message : "読み取りに失敗しました");
  }
}

export type ParseParams = { importId: string; token: string };

/** 読み取りの開始方法。本番は Workflow、テストでは差し替えて直接実行する */
export const parseRunner = {
  start: async (env: Env, params: ParseParams): Promise<void> => {
    // インスタンス ID は読み取りのトークン (毎回新しい UUID)
    await env.PARSE_WORKFLOW.create({ id: params.token, params });
  },
};
