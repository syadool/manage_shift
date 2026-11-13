/** 自分のシフトを Google カレンダーに反映する (差分を照合して追加・更新・削除) */
import type { Context, MiddlewareHandler } from "hono";
import { and, eq, gt, gte, ne, sql } from "drizzle-orm";
import { addDays } from "../../shared/dates";
import { getDb } from "../db/client";
import { gcalConnections, members, shiftCodes, shifts } from "../db/schema";
import type { AppEnv } from "../types";
import { decrypt } from "./crypto";
import { APP_MARK, buildEvent, type MyShift, type OtherShift } from "./events";
import { google, GoogleError, type GEvent } from "./google";

/** 何日前のシフトから反映するか。それより前の予定は触らない */
export const SYNC_PAST_DAYS = 31;
/**
 * 1回の同期で行う追加・更新・削除の上限。Workers の1リクエストあたりのサブリクエスト数の上限を超えないため。
 * 残りは次の同期 (定期実行) で行う
 */
export const MAX_OPS_PER_SYNC = 40;

export const REAUTH_MESSAGE = "Google との連携が切れました。もう一度連携してください";

export function gcalConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY);
}

export const credsOf = (env: Env) => ({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });

/** 日本時間の今日 "YYYY-MM-DD" */
export function jstToday(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

export type SyncResult =
  | { ok: true; inserted: number; updated: number; deleted: number; remaining: number }
  | { ok: false; error: string };

/** 反映すべき予定 (予定 ID → 予定) */
async function desiredEvents(env: Env, userId: string, from: string, opts: Parameters<typeof buildEvent>[2]) {
  const db = getDb(env);
  const me = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.isMe, true)))
    .get();
  const out = new Map<string, GEvent>();
  if (!me) return out;

  const [mine, others] = await Promise.all([
    db
      .select({
        id: shifts.id,
        date: shifts.date,
        startTime: shifts.startTime,
        endTime: shifts.endTime,
        breakMinutes: shifts.breakMinutes,
        symbol: shiftCodes.symbol,
      })
      .from(shifts)
      .leftJoin(shiftCodes, eq(shiftCodes.id, shifts.shiftCodeId))
      .where(and(eq(shifts.userId, userId), eq(shifts.memberId, me.id), gte(shifts.date, from))),
    db
      .select({ date: shifts.date, startTime: shifts.startTime, endTime: shifts.endTime, name: members.name })
      .from(shifts)
      .innerJoin(members, eq(members.id, shifts.memberId))
      .where(and(eq(shifts.userId, userId), ne(shifts.memberId, me.id), gte(shifts.date, from))),
  ]);
  const othersByDate = new Map<string, OtherShift[]>();
  for (const o of others) othersByDate.set(o.date, [...(othersByDate.get(o.date) ?? []), o]);
  for (const s of mine as MyShift[]) {
    const ev = await buildEvent(s, othersByDate.get(s.date) ?? [], opts);
    out.set(ev.id, ev);
  }
  return out;
}

const isStatus = (e: unknown, ...codes: number[]) => e instanceof GoogleError && codes.includes(e.status);

/**
 * 1ユーザー分を同期する。失敗は接続情報の lastError に残し、結果として返す (例外は投げない)
 */
export async function syncUser(env: Env, userId: string, now = Date.now()): Promise<SyncResult | null> {
  if (!gcalConfigured(env)) return null;
  const db = getDb(env);
  const conn = await db.select().from(gcalConnections).where(eq(gcalConnections.userId, userId)).get();
  if (!conn || conn.status !== "active") return null;
  const generation = conn.dirty;
  const where = eq(gcalConnections.userId, userId);

  try {
    let accessToken: string;
    try {
      accessToken = await google.refresh(credsOf(env), await decrypt(env.TOKEN_ENCRYPTION_KEY, conn.refreshTokenEnc));
    } catch (e) {
      if (e instanceof GoogleError && (e.code === "invalid_grant" || e.status === 401)) {
        await db.update(gcalConnections).set({ status: "reauth_required", lastError: REAUTH_MESSAGE }).where(where);
        return { ok: false, error: REAUTH_MESSAGE };
      }
      throw e;
    }

    const from = addDays(jstToday(now), -SYNC_PAST_DAYS);
    const desired = await desiredEvents(env, userId, from, {
      titleMode: conn.titleMode,
      workplaceName: conn.workplaceName,
    });

    // カレンダーが未作成、またはユーザーが Google 側で削除していたら作り直す
    let calendarId = conn.calendarId;
    let listed: Awaited<ReturnType<typeof google.listEvents>> = [];
    if (calendarId) {
      try {
        listed = await google.listEvents(accessToken, calendarId, `${from}T00:00:00+09:00`);
      } catch (e) {
        if (!isStatus(e, 404, 410)) throw e;
        calendarId = null;
      }
    }
    if (!calendarId) {
      calendarId = await google.createCalendar(accessToken);
      await db.update(gcalConnections).set({ calendarId }).where(where);
    }

    // アプリが付けた印のある予定だけを対象にする
    const actual = new Map<string, string | undefined>();
    for (const ev of listed) {
      const priv = ev.extendedProperties?.private;
      if (priv?.app !== APP_MARK) continue;
      const startDate = (ev.start?.dateTime ?? ev.start?.date ?? "").slice(0, 10);
      // 範囲より前に始まる予定は触らない (前日からの日跨ぎなど)
      if (startDate < from) continue;
      actual.set(ev.id, priv.h);
    }

    type Op = () => Promise<"inserted" | "updated" | "deleted">;
    const ops: Op[] = [];
    for (const [id, ev] of desired) {
      if (!actual.has(id)) {
        ops.push(async () => {
          try {
            await google.insertEvent(accessToken, calendarId!, ev);
            return "inserted";
          } catch (e) {
            // 同じ ID の予定が既にある (取り消し済み・同時に同期した) なら置き換える
            if (!isStatus(e, 409)) throw e;
            await google.updateEvent(accessToken, calendarId!, ev);
            return "updated";
          }
        });
      } else if (actual.get(id) !== ev.extendedProperties.private.h) {
        ops.push(async () => {
          await google.updateEvent(accessToken, calendarId!, ev);
          return "updated";
        });
      }
    }
    for (const id of actual.keys()) {
      if (desired.has(id)) continue;
      ops.push(async () => {
        try {
          await google.deleteEvent(accessToken, calendarId!, id);
        } catch (e) {
          if (!isStatus(e, 404, 410)) throw e;
        }
        return "deleted";
      });
    }

    const counts = { inserted: 0, updated: 0, deleted: 0 };
    for (const op of ops.slice(0, MAX_OPS_PER_SYNC)) counts[await op()]++;
    const remaining = Math.max(0, ops.length - MAX_OPS_PER_SYNC);

    await db
      .update(gcalConnections)
      .set({ lastSyncedAt: new Date(now), lastError: null })
      .where(where);
    if (remaining === 0) {
      // 同期中に新しい変更が入っていなければ、反映済みにする
      await db
        .update(gcalConnections)
        .set({ dirty: 0 })
        .where(and(where, eq(gcalConnections.dirty, generation)));
    } else {
      await db
        .update(gcalConnections)
        .set({ dirty: generation + 1 })
        .where(and(where, eq(gcalConnections.dirty, 0)));
    }
    return { ok: true, ...counts, remaining };
  } catch (e) {
    console.error("gcal sync failed", e);
    const error =
      e instanceof GoogleError ? `Google カレンダーへの反映に失敗しました (${e.status})` : "Google カレンダーへの反映に失敗しました";
    await db.update(gcalConnections).set({ lastError: error }).where(where);
    return { ok: false, error };
  }
}

/** 変更があったことを記録し、レスポンスを返した後に同期する。連携していなければ何もしない */
export async function markDirtyAndSync(c: Context<AppEnv>, userId: string) {
  if (!gcalConfigured(c.env)) return;
  const db = getDb(c.env);
  const row = await db
    .update(gcalConnections)
    .set({ dirty: sql`${gcalConnections.dirty} + 1` })
    .where(and(eq(gcalConnections.userId, userId), eq(gcalConnections.status, "active")))
    .returning({ userId: gcalConnections.userId })
    .get();
  if (!row) return;
  c.executionCtx.waitUntil(syncUser(c.env, userId));
}

/** 変更のある接続を順に同期する (Cron から呼ぶ) */
export async function syncPending(env: Env, limit = 10) {
  if (!gcalConfigured(env)) return;
  const rows = await getDb(env)
    .select({ userId: gcalConnections.userId })
    .from(gcalConnections)
    .where(and(eq(gcalConnections.status, "active"), gt(gcalConnections.dirty, 0)))
    .limit(limit);
  for (const r of rows) await syncUser(env, r.userId);
}

/** 状態を変えるリクエストが成功したら Google カレンダーへ反映する (各ルーターに use する) */
export const syncAfterWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const user = c.get("user");
  if (user && c.req.method !== "GET" && c.req.method !== "HEAD" && c.res.status < 300) {
    await markDirtyAndSync(c, user.id);
  }
};
