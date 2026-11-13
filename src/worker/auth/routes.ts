import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, count, eq, lt } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { getDb } from "../db/client";
import { authChallenges, passkeys, settings, users } from "../db/schema";
import type { AppEnv } from "../types";
import { endSession, requireAuth, startSession } from "./session";

const CHALLENGE_COOKIE = "__Host-wac";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = "シフト";

type ChallengeKind = "register" | "login" | "add";

/** RP ID とオリジンはアクセスされたホストから決める (環境変数で上書き可) */
function rp(c: Context<AppEnv>) {
  const url = new URL(c.req.url);
  return { rpID: c.env.RP_ID || url.hostname, origin: c.env.RP_ORIGIN || url.origin };
}

async function saveChallenge(
  c: Context<AppEnv>,
  challenge: string,
  kind: ChallengeKind,
  extra: { userId?: string; displayName?: string } = {},
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const db = getDb(c.env);
  await db.batch([
    // 使われずに期限切れになったチャレンジを掃除
    db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date())),
    db.insert(authChallenges).values({ id, challenge, kind, expiresAt, ...extra }),
  ]);
  setCookie(c, CHALLENGE_COOKIE, id, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    expires: expiresAt,
  });
}

/** チャレンジを取り出して即削除 (1回限り)。期限切れ・種別違いは null */
async function consumeChallenge(c: Context<AppEnv>, kind: ChallengeKind) {
  const id = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: true });
  if (!id) return null;
  const db = getDb(c.env);
  const row = await db.delete(authChallenges).where(eq(authChallenges.id, id)).returning().get();
  if (!row || row.kind !== kind || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return v.length >= 1 && v.length <= max ? v : null;
}

const bad = (c: Context<AppEnv>, error: string) => c.json({ error }, 400);

export const authRoutes = new Hono<AppEnv>()
  .get("/me", (c) => {
    const user = c.get("user");
    return user ? c.json({ user }) : c.json({ error: "unauthorized" }, 401);
  })

  /* ---------- 新規登録 ---------- */
  .post("/register/options", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const displayName = cleanName(body.displayName, 40);
    if (!displayName) return bad(c, "名前を1〜40文字で入力してください");

    const userId = crypto.randomUUID();
    const { rpID } = rp(c);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: displayName,
      userDisplayName: displayName,
      userID: new Uint8Array(new TextEncoder().encode(userId)),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await saveChallenge(c, options.challenge, "register", { userId, displayName });
    return c.json(options);
  })

  .post("/register/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ch = await consumeChallenge(c, "register");
    if (!ch?.userId || !ch.displayName) return bad(c, "登録の有効期限が切れました。もう一度お試しください");

    const { rpID, origin } = rp(c);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      return bad(c, "パスキーを確認できませんでした");
    }
    if (!verification.verified) return bad(c, "パスキーを確認できませんでした");

    const info = verification.registrationInfo;
    const db = getDb(c.env);
    await db.batch([
      db.insert(users).values({ id: ch.userId, displayName: ch.displayName }),
      db.insert(settings).values({ userId: ch.userId }),
      db.insert(passkeys).values({
        id: info.credential.id,
        userId: ch.userId,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: cleanName(body.name, 40) ?? "パスキー",
      }),
    ]);
    await startSession(c, ch.userId);
    return c.json({ user: { id: ch.userId, displayName: ch.displayName } });
  })

  /* ---------- ログイン (ユーザー名入力なし・discoverable credential) ---------- */
  .post("/login/options", async (c) => {
    const options = await generateAuthenticationOptions({
      rpID: rp(c).rpID,
      userVerification: "required",
    });
    await saveChallenge(c, options.challenge, "login");
    return c.json(options);
  })

  .post("/login/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const response = body.response as AuthenticationResponseJSON | undefined;
    const ch = await consumeChallenge(c, "login");
    if (!ch) return bad(c, "ログインの有効期限が切れました。もう一度お試しください");
    if (typeof response?.id !== "string") return bad(c, "パスキーを確認できませんでした");

    const db = getDb(c.env);
    const pk = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
    if (!pk) return c.json({ error: "このパスキーは登録されていません" }, 401);

    const { rpID, origin } = rp(c);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: pk.id,
          publicKey: isoBase64URL.toBuffer(pk.publicKey),
          counter: pk.counter,
          transports: pk.transports ?? undefined,
        },
      });
    } catch {
      return c.json({ error: "パスキーを確認できませんでした" }, 401);
    }
    if (!verification.verified) return c.json({ error: "パスキーを確認できませんでした" }, 401);

    await db
      .update(passkeys)
      .set({
        counter: verification.authenticationInfo.newCounter,
        backedUp: verification.authenticationInfo.credentialBackedUp,
        lastUsedAt: new Date(),
      })
      .where(eq(passkeys.id, pk.id));
    const user = await db.select().from(users).where(eq(users.id, pk.userId)).get();
    if (!user) return c.json({ error: "unauthorized" }, 401);
    await startSession(c, user.id);
    return c.json({ user: { id: user.id, displayName: user.displayName } });
  })

  .post("/logout", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  })

  /* ---------- パスキー管理 (ログイン中) ---------- */
  .get("/passkeys", requireAuth, async (c) => {
    const rows = await getDb(c.env)
      .select({
        id: passkeys.id,
        name: passkeys.name,
        createdAt: passkeys.createdAt,
        lastUsedAt: passkeys.lastUsedAt,
        backedUp: passkeys.backedUp,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, c.get("user")!.id));
    return c.json({ passkeys: rows });
  })

  .post("/passkeys/options", requireAuth, async (c) => {
    const user = c.get("user")!;
    const existing = await getDb(c.env)
      .select({ id: passkeys.id, transports: passkeys.transports })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id));
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp(c).rpID,
      userName: user.displayName,
      userDisplayName: user.displayName,
      userID: new Uint8Array(new TextEncoder().encode(user.id)),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await saveChallenge(c, options.challenge, "add", { userId: user.id });
    return c.json(options);
  })

  .post("/passkeys/verify", requireAuth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const ch = await consumeChallenge(c, "add");
    if (!ch || ch.userId !== user.id) return bad(c, "有効期限が切れました。もう一度お試しください");

    const { rpID, origin } = rp(c);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      return bad(c, "パスキーを確認できませんでした");
    }
    if (!verification.verified) return bad(c, "パスキーを確認できませんでした");

    const info = verification.registrationInfo;
    await getDb(c.env)
      .insert(passkeys)
      .values({
        id: info.credential.id,
        userId: user.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: cleanName(body.name, 40) ?? "パスキー",
      });
    return c.json({ ok: true });
  })

  .delete("/passkeys/:id", requireAuth, async (c) => {
    const user = c.get("user")!;
    const db = getDb(c.env);
    const [{ n }] = await db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, user.id));
    if (n <= 1) return bad(c, "最後のパスキーは削除できません");
    const deleted = await db
      .delete(passkeys)
      .where(and(eq(passkeys.id, c.req.param("id")), eq(passkeys.userId, user.id)))
      .returning({ id: passkeys.id });
    if (deleted.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
