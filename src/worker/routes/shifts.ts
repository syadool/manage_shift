import { Hono, type Context } from "hono";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { shiftInput, shiftRangeQuery, type ShiftInput } from "../../shared/schemas";
import { requireAuth } from "../auth/session";
import { getDb } from "../db/client";
import { members, shiftCodes, shifts } from "../db/schema";
import { syncAfterWrite } from "../gcal/sync";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const columns = {
  id: shifts.id,
  memberId: shifts.memberId,
  date: shifts.date,
  shiftCodeId: shifts.shiftCodeId,
  startTime: shifts.startTime,
  endTime: shifts.endTime,
  breakMinutes: shifts.breakMinutes,
  source: shifts.source,
};

/** 参照するメンバー・記号が本人のものか確認。問題があればエラーレスポンスを返す */
async function checkRefs(c: Context<AppEnv>, userId: string, input: ShiftInput) {
  const db = getDb(c.env);
  const member = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, input.memberId), eq(members.userId, userId)))
    .get();
  if (!member) return c.json({ error: "メンバーが見つかりません" }, 400);
  if (input.shiftCodeId) {
    const code = await db
      .select({ isOff: shiftCodes.isOff })
      .from(shiftCodes)
      .where(and(eq(shiftCodes.id, input.shiftCodeId), eq(shiftCodes.userId, userId)))
      .get();
    if (!code) return c.json({ error: "記号が見つかりません" }, 400);
    if (code.isOff) return c.json({ error: "休みの記号ではシフトを登録できません" }, 400);
  }
  return null;
}

export const shiftRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  // 変更を Google カレンダーに反映する
  .use(syncAfterWrite)

  .get("/", validate("query", shiftRangeQuery), async (c) => {
    const { from, to } = c.req.valid("query");
    const rows = await getDb(c.env)
      .select(columns)
      .from(shifts)
      .where(and(eq(shifts.userId, c.get("user")!.id), gte(shifts.date, from), lte(shifts.date, to)))
      .orderBy(asc(shifts.date), asc(shifts.startTime));
    return c.json({ shifts: rows });
  })

  .post("/", validate("json", shiftInput), async (c) => {
    const userId = c.get("user")!.id;
    const input = c.req.valid("json");
    const err = await checkRefs(c, userId, input);
    if (err) return err;
    const row = await getDb(c.env)
      .insert(shifts)
      .values({ id: crypto.randomUUID(), userId, ...input, source: "manual" })
      .returning(columns)
      .get();
    return c.json({ shift: row }, 201);
  })

  .put("/:id", validate("json", shiftInput), async (c) => {
    const userId = c.get("user")!.id;
    const input = c.req.valid("json");
    const err = await checkRefs(c, userId, input);
    if (err) return err;
    // 手で直したシフトは、画像の再取り込みで上書きされないよう manual 扱いにする
    const row = await getDb(c.env)
      .update(shifts)
      .set({ ...input, source: "manual" })
      .where(and(eq(shifts.id, c.req.param("id")), eq(shifts.userId, userId)))
      .returning(columns)
      .get();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ shift: row });
  })

  .delete("/:id", async (c) => {
    const deleted = await getDb(c.env)
      .delete(shifts)
      .where(and(eq(shifts.id, c.req.param("id")), eq(shifts.userId, c.get("user")!.id)))
      .returning({ id: shifts.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
