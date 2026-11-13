import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq, lt } from "drizzle-orm";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import type { AppEnv } from "../types";

export const SESSION_COOKIE = "__Host-sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 残りがこれを下回ったら有効期限を延長する */
const SESSION_REFRESH_MS = 15 * 24 * 60 * 60 * 1000;

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cookieOptions = (expires: Date) =>
  ({ path: "/", httpOnly: true, secure: true, sameSite: "Lax", expires }) as const;

/** セッションを発行し Cookie をセット。DB にはトークンのハッシュのみ保存 */
export async function startSession(c: Context<AppEnv>, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = getDb(c.env);
  await db.batch([
    db.delete(sessions).where(lt(sessions.expiresAt, new Date())),
    db.insert(sessions).values({ id: await sha256Hex(token), userId, expiresAt }),
  ]);
  setCookie(c, SESSION_COOKIE, token, cookieOptions(expiresAt));
}

export async function endSession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await getDb(c.env).delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

/** Cookie からユーザーを解決し c.var.user に入れる (未ログインなら null) */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const db = getDb(c.env);
    const id = await sha256Hex(token);
    const row = await db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt, displayName: users.displayName })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (row && row.expiresAt.getTime() > Date.now()) {
      c.set("user", { id: row.userId, displayName: row.displayName });
      if (row.expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS) {
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
        setCookie(c, SESSION_COOKIE, token, cookieOptions(expiresAt));
      }
    } else if (row) {
      await db.delete(sessions).where(eq(sessions.id, id));
      deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    }
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized" }, 401);
  await next();
};

/**
 * CSRF 対策: 状態を変えるリクエストは同一オリジンからのみ受け付ける。
 * (Cookie は SameSite=Lax、API は JSON のみ受け付けることと併用)
 */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  await next();
};
