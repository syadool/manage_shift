import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt, lt } from "drizzle-orm";
import { gcalSettingsInput } from "../../shared/schemas";
import { randomToken, requireAuth, sha256Hex } from "../auth/session";
import { getDb } from "../db/client";
import { gcalConnections, oauthStates } from "../db/schema";
import { decrypt, encrypt, pkceChallenge } from "../gcal/crypto";
import { google, GoogleError } from "../gcal/google";
import { credsOf, gcalConfigured, syncUser } from "../gcal/sync";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const STATE_COOKIE = "__Host-gcal_state";
const STATE_TTL_MS = 10 * 60 * 1000;

/** Google に登録するリダイレクト URI。本番は RP_ORIGIN に固定する */
function redirectUri(c: Context<AppEnv>): string {
  const origin = c.env.RP_ORIGIN || new URL(c.req.url).origin;
  return `${origin}/api/gcal/callback`;
}

const done = (c: Context<AppEnv>, result: "connected" | "error" | "denied") =>
  c.redirect(`/settings?gcal=${result}`, 302);

const status = {
  status: gcalConnections.status,
  calendarId: gcalConnections.calendarId,
  dirty: gcalConnections.dirty,
  titleMode: gcalConnections.titleMode,
  workplaceName: gcalConnections.workplaceName,
  lastSyncedAt: gcalConnections.lastSyncedAt,
  lastError: gcalConnections.lastError,
};

export const gcalRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", async (c) => {
    const available = gcalConfigured(c.env);
    const row = await getDb(c.env)
      .select(status)
      .from(gcalConnections)
      .where(eq(gcalConnections.userId, c.get("user")!.id))
      .get();
    if (!row) return c.json({ available, connection: null });
    const { dirty, calendarId, ...rest } = row;
    return c.json({ available, connection: { ...rest, pending: dirty > 0, hasCalendar: calendarId != null } });
  })

  /* 連携開始: Google の認可画面の URL を返す (POST にして同一オリジンからのみ受け付ける) */
  .post("/connect", async (c) => {
    if (!gcalConfigured(c.env)) return c.json({ error: "Google カレンダー連携は設定されていません" }, 503);
    const userId = c.get("user")!.id;
    const state = randomToken();
    const codeVerifier = randomToken(48);
    const db = getDb(c.env);
    await db.batch([
      db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date())),
      db.insert(oauthStates).values({
        id: await sha256Hex(state),
        userId,
        codeVerifier,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      }),
    ]);
    // 認可を始めたブラウザと戻ってきたブラウザが同じか確かめるため、state を Cookie にも入れる
    setCookie(c, STATE_COOKIE, state, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: STATE_TTL_MS / 1000,
    });
    const url = google.authUrl(credsOf(c.env), {
      redirectUri: redirectUri(c),
      state,
      codeChallenge: await pkceChallenge(codeVerifier),
    });
    return c.json({ url });
  })

  /* Google からの戻り先 */
  .get("/callback", async (c) => {
    if (!gcalConfigured(c.env)) return done(c, "error");
    const userId = c.get("user")!.id;
    const state = c.req.query("state");
    const cookieState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    if (!state || !cookieState || state !== cookieState) return done(c, "error");

    // state は1回限り。期限内で、このユーザーが始めたものだけ受け付ける
    const db = getDb(c.env);
    const claimed = await db
      .delete(oauthStates)
      .where(
        and(
          eq(oauthStates.id, await sha256Hex(state)),
          eq(oauthStates.userId, userId),
          gt(oauthStates.expiresAt, new Date()),
        ),
      )
      .returning({ codeVerifier: oauthStates.codeVerifier })
      .get();
    if (!claimed) return done(c, "error");

    const code = c.req.query("code");
    if (!code) return done(c, c.req.query("error") === "access_denied" ? "denied" : "error");

    try {
      const tokens = await google.exchangeCode(credsOf(c.env), {
        code,
        redirectUri: redirectUri(c),
        codeVerifier: claimed.codeVerifier,
      });
      if (!tokens.refreshToken) return done(c, "error");
      const refreshTokenEnc = await encrypt(c.env.TOKEN_ENCRYPTION_KEY, tokens.refreshToken);
      // 再連携のときは、作成済みのカレンダーと表示の設定を引き継ぐ (使えなければ同期時に作り直す)
      await db
        .insert(gcalConnections)
        .values({ userId, refreshTokenEnc, status: "active", dirty: 1 })
        .onConflictDoUpdate({
          target: gcalConnections.userId,
          set: { refreshTokenEnc, status: "active", dirty: 1, lastError: null },
        });
    } catch (e) {
      console.error("gcal connect failed", e);
      return done(c, "error");
    }
    c.executionCtx.waitUntil(syncUser(c.env, userId));
    return done(c, "connected");
  })

  /* 予定のタイトルの設定 */
  .put("/settings", validate("json", gcalSettingsInput), async (c) => {
    const userId = c.get("user")!.id;
    const input = c.req.valid("json");
    const row = await getDb(c.env)
      .update(gcalConnections)
      .set({ titleMode: input.titleMode, workplaceName: input.workplaceName || null })
      .where(eq(gcalConnections.userId, userId))
      .returning({ status: gcalConnections.status })
      .get();
    if (!row) return c.json({ error: "Google カレンダーと連携していません" }, 404);
    // タイトルが変わるので全予定を反映し直す
    const result = await syncUser(c.env, userId);
    return c.json({ ok: true, sync: result });
  })

  /* 今すぐ同期 */
  .post("/sync", async (c) => {
    const userId = c.get("user")!.id;
    const row = await getDb(c.env)
      .select({ status: gcalConnections.status })
      .from(gcalConnections)
      .where(eq(gcalConnections.userId, userId))
      .get();
    if (!row) return c.json({ error: "Google カレンダーと連携していません" }, 404);
    if (row.status !== "active") return c.json({ error: "もう一度連携してください" }, 409);
    const result = await syncUser(c.env, userId);
    if (!result) return c.json({ error: "Google カレンダー連携は設定されていません" }, 503);
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result);
  })

  /* 連携解除: アプリが作ったカレンダーを削除し、トークンを取り消す */
  .delete("/", async (c) => {
    const userId = c.get("user")!.id;
    const db = getDb(c.env);
    const row = await db
      .delete(gcalConnections)
      .where(eq(gcalConnections.userId, userId))
      .returning({ refreshTokenEnc: gcalConnections.refreshTokenEnc, calendarId: gcalConnections.calendarId })
      .get();
    if (!row) return c.json({ ok: true });
    if (gcalConfigured(c.env)) {
      // Google 側の後片付けは失敗しても連携解除自体は完了させる
      try {
        const refreshToken = await decrypt(c.env.TOKEN_ENCRYPTION_KEY, row.refreshTokenEnc);
        if (row.calendarId) {
          const accessToken = await google.refresh(credsOf(c.env), refreshToken);
          await google.deleteCalendar(accessToken, row.calendarId).catch((e) => {
            if (!(e instanceof GoogleError && [404, 410].includes(e.status))) throw e;
          });
        }
        await google.revoke(refreshToken);
      } catch (e) {
        console.error("gcal disconnect cleanup failed", e);
      }
    }
    return c.json({ ok: true });
  });
