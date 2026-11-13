import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { settingsInput } from "../../shared/schemas";
import { getDb } from "../db/client";
import { settings } from "../db/schema";
import { requireAuth } from "../auth/session";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const DEFAULTS = {
  hourlyWage: 0,
  transportPerDay: 0,
  incomeWallYen: null,
  wallLabel: null,
  includeTransportInWall: false,
};

export const settingsRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const row = await getDb(c.env)
      .select()
      .from(settings)
      .where(eq(settings.userId, c.get("user")!.id))
      .get();
    const { userId: _, ...rest } = row ?? { userId: "", ...DEFAULTS };
    return c.json({ settings: rest });
  })
  .put("/", validate("json", settingsInput), async (c) => {
    const userId = c.get("user")!.id;
    const input = c.req.valid("json");
    const values = { ...input, wallLabel: input.wallLabel || null };
    await getDb(c.env)
      .insert(settings)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: settings.userId, set: values });
    return c.json({ settings: values });
  });
