import { Hono } from "hono";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { isValidDate, monthRange } from "../../shared/dates";
import { commitInput, matchCode, normalizeSymbol, type Extraction } from "../../shared/importing";
import { normalizeName } from "../../shared/names";
import { MAX_ALIASES } from "../../shared/schemas";
import { requireAuth } from "../auth/session";
import { getDb } from "../db/client";
import { imports, memberNames, members, shiftCodes, shifts } from "../db/schema";
import { ExtractError, ocr } from "../ocr/extract";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { isNameConstraintError, nameRows } from "./members";

/** 1枚あたりの上限 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 1ユーザーが1日 (直近24時間) にアップロードできる枚数。読み取りの費用の上限を兼ねる */
export const DAILY_UPLOAD_LIMIT = 20;
/** 1枚あたりの読み取り回数の上限 */
export const MAX_PARSE_ATTEMPTS = 3;

/** D1 は1文に渡せる値が100個まで。メンバー ID の IN 句はこの件数ずつに分ける */
const ID_CHUNK = 50;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** ファイル先頭のバイトで画像の種類を判定する (Content-Type は信用しない) */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

const summary = {
  id: imports.id,
  status: imports.status,
  targetMonth: imports.targetMonth,
  parseAttempts: imports.parseAttempts,
  error: imports.error,
  createdAt: imports.createdAt,
};

export const importRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", async (c) => {
    const rows = await getDb(c.env)
      .select(summary)
      .from(imports)
      .where(eq(imports.userId, c.get("user")!.id))
      .orderBy(desc(imports.createdAt))
      .limit(30);
    return c.json({ imports: rows });
  })

  /* 画像のアップロード */
  .post("/", async (c) => {
    const userId = c.get("user")!.id;
    const db = getDb(c.env);

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("image");
    if (!file || typeof file === "string") return c.json({ error: "画像を選んでください" }, 400);
    if (file.size > MAX_IMAGE_BYTES) return c.json({ error: "画像は10MBまでです" }, 400);
    const body = await file.arrayBuffer();
    const type = sniffImageType(new Uint8Array(body, 0, Math.min(16, body.byteLength)));
    if (!type) return c.json({ error: "JPEG・PNG・WebP の画像を選んでください" }, 400);

    // 枠の確保: 「直近24時間の件数が上限未満なら挿入」を1つの文で行う (同時アップロードでも上限を超えない)
    const id = crypto.randomUUID();
    const r2Key = `${userId}/${id}`;
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const reserved = await c.env.DB.prepare(
      `insert into imports (id, user_id, r2_key, content_type, status)
       select ?1, ?2, ?3, ?4, 'uploaded'
       where (select count(*) from imports where user_id = ?2 and created_at >= ?5) < ?6`,
    )
      .bind(id, userId, r2Key, type, since, DAILY_UPLOAD_LIMIT)
      .run();
    if (reserved.meta.changes !== 1) {
      return c.json({ error: `取り込みは1日${DAILY_UPLOAD_LIMIT}枚までです` }, 429);
    }

    try {
      await c.env.IMAGES.put(r2Key, body, { httpMetadata: { contentType: type } });
    } catch (e) {
      // 保存に失敗したら確保した枠を戻す
      await db.delete(imports).where(eq(imports.id, id));
      throw e;
    }
    const row = await db.select(summary).from(imports).where(eq(imports.id, id)).get();
    return c.json({ import: row }, 201);
  })

  /* 読み取り (Claude API) */
  .post("/:id/parse", async (c) => {
    const userId = c.get("user")!.id;
    const id = c.req.param("id");
    const db = getDb(c.env);

    // 回数の上限を超えていないものだけ、先に回数を増やして確保する (同時実行でも上限を超えない)
    // 読み取りごとにトークンを発行する。結果はトークンが一致する (= 最後に始めた読み取り) ときだけ保存する
    const token = crypto.randomUUID();
    const claimed = await db
      .update(imports)
      .set({ parseAttempts: sql`${imports.parseAttempts} + 1`, parseToken: token })
      .where(
        and(
          eq(imports.id, id),
          eq(imports.userId, userId),
          inArray(imports.status, ["uploaded", "failed", "parsed"]),
          sql`${imports.parseAttempts} < ${MAX_PARSE_ATTEMPTS}`,
        ),
      )
      .returning({ r2Key: imports.r2Key, contentType: imports.contentType })
      .get();
    if (!claimed) {
      const exists = await db
        .select({ status: imports.status })
        .from(imports)
        .where(and(eq(imports.id, id), eq(imports.userId, userId)))
        .get();
      if (!exists) return c.json({ error: "not found" }, 404);
      if (exists.status === "committed" || exists.status === "committing") {
        return c.json({ error: "確定済みの取り込みです" }, 409);
      }
      return c.json({ error: `読み取りは1枚につき${MAX_PARSE_ATTEMPTS}回までです` }, 429);
    }

    /** この読み取りが今も有効で、まだ確定していない場合だけ更新する */
    const stillMine = and(
      eq(imports.id, id),
      eq(imports.userId, userId),
      eq(imports.parseToken, token),
      inArray(imports.status, ["uploaded", "failed", "parsed"]),
    );

    const object = await c.env.IMAGES.get(claimed.r2Key);
    if (!object) return c.json({ error: "画像が見つかりません" }, 404);

    const [memberRows, codeRows] = await Promise.all([
      db.select({ name: members.name, aliases: members.aliases }).from(members).where(eq(members.userId, userId)),
      db.select({ symbol: shiftCodes.symbol }).from(shiftCodes).where(eq(shiftCodes.userId, userId)),
    ]);

    try {
      const result = await ocr.extract(c.env, {
        image: await object.arrayBuffer(),
        mediaType: claimed.contentType as "image/jpeg" | "image/png" | "image/webp",
        knownSymbols: codeRows.map((r) => r.symbol),
        knownNames: memberRows.flatMap((m) => [m.name, ...m.aliases]),
      });
      const row = await db
        .update(imports)
        .set({ status: "parsed", rawResult: result, targetMonth: result.yearMonth, error: null })
        .where(stillMine)
        .returning(summary)
        .get();
      if (!row) {
        return c.json({ error: "別の画面での読み取りや保存が先に行われたため、この結果は使われませんでした" }, 409);
      }
      return c.json({ import: row, result });
    } catch (e) {
      const message = e instanceof ExtractError ? e.message : "読み取りに失敗しました";
      if (!(e instanceof ExtractError)) console.error("extract failed", e);
      await db
        .update(imports)
        .set({ status: "failed", error: message })
        .where(stillMine);
      return c.json({ error: message }, 502);
    }
  })

  .get("/:id", async (c) => {
    const row = await getDb(c.env)
      .select({ ...summary, rawResult: imports.rawResult })
      .from(imports)
      .where(and(eq(imports.id, c.req.param("id")), eq(imports.userId, c.get("user")!.id)))
      .get();
    if (!row) return c.json({ error: "not found" }, 404);
    const { rawResult, ...rest } = row;
    return c.json({ import: rest, result: (rawResult as Extraction | null) ?? null });
  })

  .get("/:id/image", async (c) => {
    const row = await getDb(c.env)
      .select({ r2Key: imports.r2Key, contentType: imports.contentType })
      .from(imports)
      .where(and(eq(imports.id, c.req.param("id")), eq(imports.userId, c.get("user")!.id)))
      .get();
    if (!row) return c.json({ error: "not found" }, 404);
    const object = await c.env.IMAGES.get(row.r2Key);
    if (!object) return c.json({ error: "not found" }, 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": row.contentType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  })

  /* 確定: 確認・修正後の内容でシフトを置き換える */
  .post("/:id/commit", validate("json", commitInput), async (c) => {
    const userId = c.get("user")!.id;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const db = getDb(c.env);

    const imp = await db
      .select({ status: imports.status })
      .from(imports)
      .where(and(eq(imports.id, id), eq(imports.userId, userId)))
      .get();
    if (!imp) return c.json({ error: "not found" }, 404);
    if (imp.status !== "parsed") return c.json({ error: "読み取りが完了していません" }, 409);

    const [memberRows, codeRows] = await Promise.all([
      db.select().from(members).where(eq(members.userId, userId)),
      db.select().from(shiftCodes).where(eq(shiftCodes.userId, userId)),
    ]);
    const memberById = new Map(memberRows.map((m) => [m.id, m]));

    // 1. 行の検証: 紐付け先が本人のメンバーか、同じメンバーへの重複がないか、記号がすべて既知か
    const rows = input.rows.filter((r) => r.target.type !== "skip");
    const usedMembers = new Set<string>();
    const newNames = new Set<string>();
    const unknown = new Set<string>();
    for (const r of rows) {
      if (r.target.type === "member") {
        if (!memberById.has(r.target.memberId)) return c.json({ error: "メンバーが見つかりません" }, 400);
        if (usedMembers.has(r.target.memberId)) {
          return c.json({ error: `${memberById.get(r.target.memberId)!.name} さんに複数の行が紐付いています` }, 400);
        }
        usedMembers.add(r.target.memberId);
      } else if (r.target.type === "new") {
        const key = normalizeName(r.target.name);
        if (newNames.has(key)) return c.json({ error: `「${r.target.name}」が複数あります` }, 400);
        newNames.add(key);
      }
      for (const cell of r.cells) {
        if (normalizeSymbol(cell.symbol) !== "" && !matchCode(cell.symbol, codeRows)) unknown.add(cell.symbol);
      }
    }
    if (unknown.size > 0) {
      return c.json({ error: `記号表に無い記号があります: ${[...unknown].join("、")}`, unknownSymbols: [...unknown] }, 400);
    }

    // 2. 書き込み内容を組み立てる
    const { from, to } = monthRange(input.yearMonth);
    // 手入力・手で直したシフトがある日は、画像のシフトを作らない (手で直した内容を優先し、二重にしない)
    const existingIds = rows.flatMap((r) => (r.target.type === "member" ? [r.target.memberId] : []));
    const manualDays = new Set<string>();
    for (const ids of chunks(existingIds, ID_CHUNK)) {
      const rows = await db
        .select({ memberId: shifts.memberId, date: shifts.date })
        .from(shifts)
        .where(
          and(
            eq(shifts.userId, userId),
            inArray(shifts.memberId, ids),
            eq(shifts.source, "manual"),
            gte(shifts.date, from),
            lte(shifts.date, to),
          ),
        );
      for (const r of rows) manualDays.add(`${r.memberId}|${r.date}`);
    }
    let skippedManual = 0;
    let aliasesSkipped = 0;
    const statements = [];
    const shiftValues: (typeof shifts.$inferInsert)[] = [];
    const targetIds: string[] = [];

    for (const r of rows) {
      let memberId: string;
      if (r.target.type === "new") {
        memberId = crypto.randomUUID();
        const member = { name: r.target.name, aliases: [] as string[], isMe: false };
        statements.push(db.insert(members).values({ id: memberId, userId, ...member }));
        statements.push(db.insert(memberNames).values(nameRows(userId, memberId, member)));
      } else if (r.target.type === "member") {
        memberId = r.target.memberId;
        const m = memberById.get(memberId)!;
        const known = [m.name, ...m.aliases].map(normalizeName);
        const wantsAlias = r.target.rememberAlias && r.readName && !known.includes(normalizeName(r.readName));
        if (wantsAlias && m.aliases.length >= MAX_ALIASES) {
          // 別名が上限に達していれば覚えない (設定画面で保存できない状態のメンバーを作らないため)。シフトは保存する
          aliasesSkipped++;
        } else if (wantsAlias) {
          // 読み取った名前を別名として覚える (次回から自動で紐付く)
          statements.push(
            // 読み込んだ時点の配列で置き換えず、DB の現在の値の末尾に追加する
            // (同時に別の取り込みが別名を足しても、互いに消し合わない)
            db
              .update(members)
              .set({ aliases: sql`json_insert(${members.aliases}, '$[#]', ${r.readName})` })
              .where(
                and(
                  eq(members.id, memberId),
                  eq(members.userId, userId),
                  sql`json_array_length(${members.aliases}) < ${MAX_ALIASES}`,
                ),
              ),
          );
          // 照合用の名前は、直前の UPDATE で別名が実際に追加された場合だけ登録する
          // (同時の取り込みで上限に達し追加されなかったとき、members と member_names がずれないように)
          statements.push(
            db.insert(memberNames).select(
              db
                .select({
                  userId: sql<string>`${userId}`.as("user_id"),
                  memberId: sql<string>`${memberId}`.as("member_id"),
                  normalized: sql<string>`${normalizeName(r.readName)}`.as("normalized"),
                })
                .from(members)
                .where(
                  and(
                    eq(members.id, memberId),
                    eq(members.userId, userId),
                    sql`exists (select 1 from json_each(${members.aliases}) where value = ${r.readName})`,
                  ),
                ),
            ),
          );
        }
      } else {
        continue;
      }
      targetIds.push(memberId);

      for (const cell of r.cells) {
        const code = matchCode(cell.symbol, codeRows);
        if (!code || code.isOff || !code.startTime || !code.endTime) continue;
        const date = `${input.yearMonth}-${String(cell.day).padStart(2, "0")}`;
        if (!isValidDate(date)) continue; // 31日が無い月など
        if (manualDays.has(`${memberId}|${date}`)) {
          skippedManual++;
          continue;
        }
        shiftValues.push({
          id: crypto.randomUUID(),
          userId,
          memberId,
          date,
          shiftCodeId: code.id,
          startTime: code.startTime,
          endTime: code.endTime,
          breakMinutes: code.breakMinutes,
          source: "ocr",
        });
      }
    }

    // 3. その月の対象メンバーの「画像から取り込んだシフト」だけを置き換える (手入力は残す)
    // メンバー数が多くても D1 の1文あたりの値の上限 (100) を超えないよう分ける。すべて同じ batch に入れる
    for (const ids of chunks(targetIds, ID_CHUNK)) {
      statements.push(
        db
          .delete(shifts)
          .where(
            and(
              eq(shifts.userId, userId),
              inArray(shifts.memberId, ids),
              eq(shifts.source, "ocr"),
              gte(shifts.date, from),
              lte(shifts.date, to),
            ),
          ),
      );
    }
    // D1 の1文あたりの変数上限を超えないよう、シフトは分けて挿入する
    for (let i = 0; i < shiftValues.length; i += 10) {
      statements.push(db.insert(shifts).values(shiftValues.slice(i, i + 10)));
    }
    statements.push(
      db
        .update(imports)
        .set({ status: "committed", targetMonth: input.yearMonth })
        .where(and(eq(imports.id, id), eq(imports.userId, userId), eq(imports.status, "committing"))),
    );

    // 書き込みの前に「確認待ち → 確定処理中」を1つの文で確保する。
    // 同じ取り込みを2つの画面から同時に保存しても、書き込むのは確保できた1つだけにする
    const claimedCommit = await db
      .update(imports)
      .set({ status: "committing" })
      .where(and(eq(imports.id, id), eq(imports.userId, userId), eq(imports.status, "parsed")))
      .returning({ id: imports.id })
      .get();
    if (!claimedCommit) {
      return c.json({ error: "この取り込みは既に保存されたか、別の画面で保存中です" }, 409);
    }

    try {
      // すべて1つのトランザクションで行う
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    } catch (e) {
      // 失敗したら確認待ちに戻す (やり直せるように)
      await db
        .update(imports)
        .set({ status: "parsed" })
        .where(and(eq(imports.id, id), eq(imports.status, "committing")));
      if (isNameConstraintError(e)) {
        return c.json({ error: "既存のメンバーと同じ名前・別名が含まれています" }, 409);
      }
      throw e;
    }
    return c.json({
      ok: true,
      yearMonth: input.yearMonth,
      created: shiftValues.length,
      members: targetIds.length,
      skippedManual,
      aliasesSkipped,
    });
  });
