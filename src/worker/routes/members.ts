import { Hono } from "hono";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { memberInput, type MemberInput } from "../../shared/schemas";
import { normalizeName } from "../../shared/names";
import { getDb, type Db } from "../db/client";
import { memberNames, members } from "../db/schema";
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

/** 名前と別名を正規化し、重複を除いたもの (member_names に入れる値) */
function normalizedNames(input: MemberInput): string[] {
  return [...new Set([input.name, ...input.aliases].map(normalizeName))];
}

function nameRows(userId: string, memberId: string, input: MemberInput) {
  return normalizedNames(input).map((normalized) => ({ userId, memberId, normalized }));
}

/** D1 の一意制約違反 (member_names の主キー) か */
function isNameConstraintError(e: unknown): boolean {
  const msg = (x: unknown): string => (x instanceof Error ? `${x.message} ${msg(x.cause)}` : "");
  return /UNIQUE constraint failed: member_names|PRIMARY KEY.*member_names/i.test(msg(e));
}

const conflictMessage = (conflict: { name: string; owner: string } | null) =>
  conflict ? `「${conflict.name}」は ${conflict.owner} さんで使われています` : "同じ名前のメンバーが既にいます";

/**
 * 「自分」は1人だけ。isMe=true で保存するときは他を外す。
 * 対象 (id) が本人のメンバーとして存在する場合に限って外す。
 * 更新対象が削除済みなどで保存に失敗したとき、元の「自分」が消えないようにするため。
 * 判定を同じ UPDATE 文の中で行うので、別リクエストとの競合でも状態がずれない
 */
function clearOtherMe(db: Db, userId: string, id: string) {
  return db
    .update(members)
    .set({ isMe: false })
    .where(
      and(
        eq(members.userId, userId),
        ne(members.id, id),
        sql`exists (select 1 from ${members} as target where target.id = ${id} and target.user_id = ${userId})`,
      ),
    );
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
    // 先に読み出してわかりやすいメッセージを返す。最終的な重複の防止は member_names の一意制約が担う
    const conflict = await findNameConflict(db, userId, input);
    if (conflict) return c.json({ error: conflictMessage(conflict) }, 409);

    const id = crypto.randomUUID();
    try {
      // 挿入 → 名前の登録 → 他の「自分」を外す、を1つのトランザクションで行う
      // (clearOtherMe は対象の存在を条件にするため、挿入の後に置く)
      const [[row]] = await db.batch([
        db.insert(members).values({ id, userId, ...input }).returning(columns),
        db.insert(memberNames).values(nameRows(userId, id, input)),
        ...(input.isMe ? [clearOtherMe(db, userId, id)] : []),
      ]);
      return c.json({ member: row }, 201);
    } catch (e) {
      if (!isNameConstraintError(e)) throw e;
      return c.json({ error: conflictMessage(await findNameConflict(db, userId, input)) }, 409);
    }
  })

  .put("/:id", validate("json", memberInput), async (c) => {
    const userId = c.get("user")!.id;
    const id = c.req.param("id");
    const input = c.req.valid("json");
    const db = getDb(c.env);
    const owned = () =>
      db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.id, id), eq(members.userId, userId)))
        .get();
    // 他ユーザーのメンバーに名前を登録しないよう、先に所有を確認する
    if (!(await owned())) return c.json({ error: "not found" }, 404);
    const conflict = await findNameConflict(db, userId, input, id);
    if (conflict) return c.json({ error: conflictMessage(conflict) }, 409);

    try {
      // 名前の入れ替え・更新・他の「自分」を外す、を1つのトランザクションで行う
      const results = await db.batch([
        db.delete(memberNames).where(and(eq(memberNames.userId, userId), eq(memberNames.memberId, id))),
        db.insert(memberNames).values(nameRows(userId, id, input)),
        ...(input.isMe ? [clearOtherMe(db, userId, id)] : []),
        db
          .update(members)
          .set(input)
          .where(and(eq(members.id, id), eq(members.userId, userId)))
          .returning(columns),
      ]);
      const rows = results[results.length - 1] as { id: string }[];
      if (rows.length === 0) return c.json({ error: "not found" }, 404);
      return c.json({ member: rows[0] });
    } catch (e) {
      // 確認の後で削除された場合は、名前の挿入が外部キー違反で失敗する
      if (!(await owned())) return c.json({ error: "not found" }, 404);
      if (!isNameConstraintError(e)) throw e;
      return c.json({ error: conflictMessage(await findNameConflict(db, userId, input, id)) }, 409);
    }
  })

  .delete("/:id", async (c) => {
    const deleted = await getDb(c.env)
      .delete(members)
      .where(and(eq(members.id, c.req.param("id")), eq(members.userId, c.get("user")!.id)))
      .returning({ id: members.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
