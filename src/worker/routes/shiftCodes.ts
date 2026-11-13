import { Hono } from "hono";
import { and, asc, eq, ne } from "drizzle-orm";
import { shiftCodeInput } from "../../shared/schemas";
import { getDb } from "../db/client";
import { shiftCodes } from "../db/schema";
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
    const row = await db
      .insert(shiftCodes)
      .values({ id: crypto.randomUUID(), userId, ...input })
      .returning(columns)
      .get();
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
    const row = await db
      .update(shiftCodes)
      .set(input)
      .where(and(eq(shiftCodes.id, id), eq(shiftCodes.userId, userId)))
      .returning(columns)
      .get();
    if (!row) return c.json({ error: "not found" }, 404);
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
