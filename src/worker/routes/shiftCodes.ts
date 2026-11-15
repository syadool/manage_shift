import { Hono } from "hono";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { shiftCodeInput } from "../../shared/schemas";
import { normalizeSymbol } from "../../shared/importing";
import { getDb, type Db } from "../db/client";
import { shiftCodes, shifts, unknownShifts } from "../db/schema";
import { requireAuth } from "../auth/session";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const columns = {
  id: shiftCodes.id,
  symbol: shiftCodes.symbol,
  isOff: shiftCodes.isOff,
  startTime: shiftCodes.startTime,
  endTime: shiftCodes.endTime,
  breakMinutes: shiftCodes.breakMinutes,
};

const DUPLICATE = "この記号は既に登録されています";

/**
 * 表記ゆれ (全角/半角など) をそろえると既存の記号と同じになるものは登録させない。
 * 画像から読み取った記号を、どちらの記号か決められなくなるため (例: 「1」と「①」)
 */
async function findLooseDuplicate(db: Db, userId: string, symbol: string, excludeId?: string) {
  const rows = await db
    .select({ id: shiftCodes.id, symbol: shiftCodes.symbol })
    .from(shiftCodes)
    .where(eq(shiftCodes.userId, userId));
  const key = normalizeSymbol(symbol);
  return rows.find((r) => r.id !== excludeId && normalizeSymbol(r.symbol) === key) ?? null;
}

type CodeRow = {
  id: string;
  symbol: string;
  isOff: boolean;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number;
};

/**
 * 記号表に無い記号で取り込んでいた時間未登録のシフトのうち、この記号に当たるものを解決する。
 * 勤務の記号ならシフトに移し (その日に手入力のシフトがあれば移さない)、休みの記号なら消す
 */
async function resolveUnknownShifts(db: Db, userId: string, code: CodeRow) {
  const key = normalizeSymbol(code.symbol);
  const pending = (
    await db
      .select()
      .from(unknownShifts)
      .where(eq(unknownShifts.userId, userId))
  ).filter((u) => normalizeSymbol(u.symbol) === key);
  if (pending.length === 0) return;

  const works = !code.isOff && code.startTime && code.endTime && code.startTime !== code.endTime;
  const manual = new Set<string>();
  if (works) {
    const dates = [...new Set(pending.map((u) => u.date))];
    for (let i = 0; i < dates.length; i += 50) {
      const rows = await db
        .select({ memberId: shifts.memberId, date: shifts.date })
        .from(shifts)
        .where(
          and(eq(shifts.userId, userId), eq(shifts.source, "manual"), inArray(shifts.date, dates.slice(i, i + 50))),
        );
      for (const r of rows) manual.add(`${r.memberId}|${r.date}`);
    }
  }

  const statements = [];
  const ids = pending.map((u) => u.id);
  for (let i = 0; i < ids.length; i += 50) {
    statements.push(db.delete(unknownShifts).where(inArray(unknownShifts.id, ids.slice(i, i + 50))));
  }
  if (works) {
    const values = pending
      .filter((u) => !manual.has(`${u.memberId}|${u.date}`))
      .map((u) => ({
        id: crypto.randomUUID(),
        userId,
        memberId: u.memberId,
        date: u.date,
        shiftCodeId: code.id,
        startTime: code.startTime!,
        endTime: code.endTime!,
        breakMinutes: code.breakMinutes,
        source: "ocr" as const,
      }));
    for (let i = 0; i < values.length; i += 10) {
      statements.push(db.insert(shifts).values(values.slice(i, i + 10)));
    }
  }
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
}

const looseMessage = (other: string) => `「${other}」と見分けがつかないため登録できません`;

export const shiftCodeRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const rows = await getDb(c.env)
      .select(columns)
      .from(shiftCodes)
      .where(eq(shiftCodes.userId, c.get("user")!.id))
      .orderBy(asc(shiftCodes.symbol));
    return c.json({ shiftCodes: rows });
  })

  .post("/", validate("json", shiftCodeInput), async (c) => {
    const userId = c.get("user")!.id;
    const input = c.req.valid("json");
    const db = getDb(c.env);
    const dup = await db
      .select({ id: shiftCodes.id })
      .from(shiftCodes)
      .where(and(eq(shiftCodes.userId, userId), eq(shiftCodes.symbol, input.symbol)))
      .get();
    if (dup) return c.json({ error: DUPLICATE }, 409);
    const loose = await findLooseDuplicate(db, userId, input.symbol);
    if (loose) return c.json({ error: looseMessage(loose.symbol) }, 409);
    const row = await db
      .insert(shiftCodes)
      .values({ id: crypto.randomUUID(), userId, ...input })
      .returning(columns)
      .get();
    await resolveUnknownShifts(db, userId, row);
    return c.json({ shiftCode: row }, 201);
  })

  .put("/:id", validate("json", shiftCodeInput), async (c) => {
    const userId = c.get("user")!.id;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const db = getDb(c.env);
    const dup = await db
      .select({ id: shiftCodes.id })
      .from(shiftCodes)
      .where(
        and(eq(shiftCodes.userId, userId), eq(shiftCodes.symbol, input.symbol), ne(shiftCodes.id, id)),
      )
      .get();
    if (dup) return c.json({ error: DUPLICATE }, 409);
    const loose = await findLooseDuplicate(db, userId, input.symbol, id);
    if (loose) return c.json({ error: looseMessage(loose.symbol) }, 409);
    const row = await db
      .update(shiftCodes)
      .set(input)
      .where(and(eq(shiftCodes.id, id), eq(shiftCodes.userId, userId)))
      .returning(columns)
      .get();
    if (!row) return c.json({ error: "not found" }, 404);
    await resolveUnknownShifts(db, userId, row);
    return c.json({ shiftCode: row });
  })

  .delete("/:id", async (c) => {
    const deleted = await getDb(c.env)
      .delete(shiftCodes)
      .where(and(eq(shiftCodes.id, c.req.param("id")), eq(shiftCodes.userId, c.get("user")!.id)))
      .returning({ id: shiftCodes.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
