import { Hono } from "hono";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { memberInput, type MemberInput } from "../../shared/schemas";
import { normalizeName } from "../../shared/names";
import { getDb, type Db } from "../db/client";
import { members } from "../db/schema";
import { requireAuth } from "../auth/session";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const columns = {
  id: members.id,
  name: members.name,
  aliases: members.aliases,
  isMe: members.isMe,
};

/**
 * 名前・別名は OCR の照合に使うため、他のメンバーと重複させない。
 * 重複していればその名前を返す
 */
async function findNameConflict(db: Db, userId: string, input: MemberInput, excludeId?: string) {
  const others = await db
    .select({ name: members.name, aliases: members.aliases })
    .from(members)
    .where(excludeId ? and(eq(members.userId, userId), ne(members.id, excludeId)) : eq(members.userId, userId));
  const taken = new Map<string, string>();
  for (const o of others) {
    for (const n of [o.name, ...o.aliases]) taken.set(normalizeName(n), o.name);
  }
  for (const n of [input.name, ...input.aliases]) {
    const owner = taken.get(normalizeName(n));
    if (owner) return { name: n, owner };
  }
  return null;
}

/** 「自分」は1人だけ。isMe=true で保存するときは他を外す */
function clearOtherMe(db: Db, userId: string, id: string) {
  return db
    .update(members)
    .set({ isMe: false })
    .where(and(eq(members.userId, userId), ne(members.id, id)));
}

export const memberRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const rows = await getDb(c.env)
      .select(columns)
      .from(members)
      .where(eq(members.userId, c.get("user")!.id))
      .orderBy(desc(members.isMe), asc(members.createdAt), asc(members.name));
    return c.json({ members: rows });
  })

  .post("/", validate("json", memberInput), async (c) => {
    const userId = c.get("user")!.id;
    const input = c.req.valid("json");
    const db = getDb(c.env);
    const conflict = await findNameConflict(db, userId, input);
    if (conflict) {
      return c.json({ error: `「${conflict.name}」は ${conflict.owner} さんで使われています` }, 409);
    }
    const id = crypto.randomUUID();
    const insert = db.insert(members).values({ id, userId, ...input }).returning(columns);
    const [, [row]] = input.isMe
      ? await db.batch([clearOtherMe(db, userId, id), insert])
      : [null, await insert];
    return c.json({ member: row }, 201);
  })

  .put("/:id", validate("json", memberInput), async (c) => {
    const userId = c.get("user")!.id;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const db = getDb(c.env);
    const conflict = await findNameConflict(db, userId, input, id);
    if (conflict) {
      return c.json({ error: `「${conflict.name}」は ${conflict.owner} さんで使われています` }, 409);
    }
    const update = db
      .update(members)
      .set(input)
      .where(and(eq(members.id, id), eq(members.userId, userId)))
      .returning(columns);
    const [, rows] = input.isMe ? await db.batch([clearOtherMe(db, userId, id), update]) : [null, await update];
    if (rows.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ member: rows[0] });
  })

  .delete("/:id", async (c) => {
    const deleted = await getDb(c.env)
      .delete(members)
      .where(and(eq(members.id, c.req.param("id")), eq(members.userId, c.get("user")!.id)))
      .returning({ id: members.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
