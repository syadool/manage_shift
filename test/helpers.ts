import { env, exports } from "cloudflare:workers";
import { randomToken, sha256Hex, SESSION_COOKIE } from "../src/worker/auth/session";

export const ORIGIN = "https://shift.test";

/** ユーザーとセッションを直接作成し、その Cookie を返す */
export async function createUser(displayName = "テスト") {
  const userId = crypto.randomUUID();
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("insert into users (id, display_name) values (?, ?)").bind(userId, displayName),
    env.DB.prepare("insert into sessions (id, user_id, expires_at) values (?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      Math.floor(Date.now() / 1000) + 3600,
    ),
  ]);
  return { userId, cookie: `${SESSION_COOKIE}=${token}` };
}

export async function call(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(`${ORIGIN}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, data: await res.json().catch(() => null) };
}
