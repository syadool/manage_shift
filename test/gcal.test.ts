import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { decrypt, encrypt } from "../src/worker/gcal/crypto";
import { buildEvent, eventId, eventTitle } from "../src/worker/gcal/events";
import { google, GoogleError, type GEvent } from "../src/worker/gcal/google";
import { jstToday, MAX_OPS_PER_SYNC, syncUser } from "../src/worker/gcal/sync";
import { addDays } from "../src/shared/dates";
import { call, createUser, ORIGIN } from "./helpers";

/* ---------- Google の偽物 (メモリ上のカレンダー) ---------- */

type Stored = GEvent & { status: "confirmed" | "cancelled" };
let calendars: Map<string, Map<string, Stored>>;
let calls: string[];
let refreshError: GoogleError | null;
const real = { ...google };

function installFake() {
  calendars = new Map();
  calls = [];
  refreshError = null;
  let n = 0;
  google.exchangeCode = async (_creds, p) => {
    calls.push(`exchange:${p.code}`);
    return { refreshToken: `refresh-${p.code}`, accessToken: "access", scope: "" };
  };
  google.refresh = async () => {
    if (refreshError) throw refreshError;
    return "access";
  };
  google.revoke = async (token) => {
    calls.push(`revoke:${token}`);
  };
  google.createCalendar = async () => {
    const id = `cal-${++n}`;
    calendars.set(id, new Map());
    calls.push(`createCalendar:${id}`);
    return id;
  };
  google.deleteCalendar = async (_t, id) => {
    calls.push(`deleteCalendar:${id}`);
    calendars.delete(id);
  };
  const calOf = (id: string) => {
    const c = calendars.get(id);
    if (!c) throw new GoogleError(404, null, "not found");
    return c;
  };
  google.listEvents = async (_t, id) =>
    [...calOf(id).values()]
      .filter((e) => e.status === "confirmed")
      .map((e) => ({ id: e.id, start: { dateTime: `${e.start.dateTime}+09:00` }, extendedProperties: e.extendedProperties }));
  google.insertEvent = async (_t, id, ev) => {
    const c = calOf(id);
    if (c.has(ev.id)) throw new GoogleError(409, null, "duplicate");
    calls.push(`insert:${ev.id}`);
    c.set(ev.id, { ...ev, status: "confirmed" });
  };
  google.updateEvent = async (_t, id, ev) => {
    calls.push(`update:${ev.id}`);
    calOf(id).set(ev.id, { ...ev, status: "confirmed" });
  };
  google.deleteEvent = async (_t, id, evId) => {
    const c = calOf(id);
    const e = c.get(evId);
    if (!e || e.status === "cancelled") throw new GoogleError(410, null, "gone");
    calls.push(`delete:${evId}`);
    e.status = "cancelled";
  };
}

beforeEach(installFake);
afterEach(() => Object.assign(google, real));

/* ---------- ヘルパー ---------- */

async function raw(cookie: string, method: string, path: string) {
  return exports.default.fetch(
    new Request(`${ORIGIN}/api${path}`, { method, headers: { Origin: ORIGIN, Cookie: cookie }, redirect: "manual" }),
  );
}

const stateCookieOf = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-gcal_state="))!.split(";")[0];

/** 連携画面を通して連携する */
async function connect(cookie: string, code = "abc") {
  const res = await raw(cookie, "POST", "/gcal/connect");
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const stateCookie = stateCookieOf(res);
  const cb = await raw(`${cookie}; ${stateCookie}`, "GET", `/gcal/callback?state=${state}&code=${code}`);
  return { cb, url: new URL(url), state, stateCookie };
}

async function setupUser() {
  const u = await createUser();
  const me = (await call(u.cookie, "POST", "/members", { name: "自分", aliases: [], isMe: true })).data.member;
  const other = (await call(u.cookie, "POST", "/members", { name: "田中", aliases: [], isMe: false })).data.member;
  const code = (
    await call(u.cookie, "POST", "/shift-codes", {
      symbol: "A",
      isOff: false,
      startTime: "09:00",
      endTime: "17:00",
      breakMinutes: 60,
    })
  ).data.shiftCode;
  return { ...u, me, other, code };
}

/** 背景で動く同期と重ならないよう、手動同期を結果が安定するまで行う */
async function syncNow(cookie: string) {
  const r = await call(cookie, "POST", "/gcal/sync");
  expect(r.status).toBe(200);
  return r.data;
}

const conn = (userId: string) =>
  env.DB.prepare("select * from gcal_connections where user_id = ?").bind(userId).first<Record<string, any>>();

const events = () => {
  const out: Stored[] = [];
  for (const c of calendars.values()) for (const e of c.values()) if (e.status === "confirmed") out.push(e);
  return out;
};

const future = (n: number) => addDays(jstToday(), n);

const shift = (memberId: string, date: string, extra: object = {}) => ({
  memberId,
  date,
  shiftCodeId: null,
  startTime: "09:00",
  endTime: "17:00",
  breakMinutes: 60,
  ...extra,
});

/* ---------- 予定の組み立て ---------- */

describe("予定の組み立て", () => {
  const base = { id: "0f8e2c1a-1234-4abc-9def-0123456789ab", date: "2026-12-01", breakMinutes: 0, symbol: "A" };

  it("予定 ID は Google で使える文字だけ", () => {
    expect(eventId(base.id)).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("タイトルは記号かバイト先名を選べる (時間は入れない)", () => {
    expect(eventTitle({ symbol: "A" }, { titleMode: "symbol", workplaceName: "○○店" })).toBe("A");
    expect(eventTitle({ symbol: "A" }, { titleMode: "workplace", workplaceName: "○○店" })).toBe("○○店");
    expect(eventTitle({ symbol: null }, { titleMode: "symbol", workplaceName: null })).toBe("シフト");
    expect(eventTitle({ symbol: "A" }, { titleMode: "workplace", workplaceName: " " })).toBe("シフト");
  });

  it("日跨ぎ・24:00 は翌日に繰り上げる", async () => {
    const opts = { titleMode: "symbol" as const, workplaceName: null };
    const night = await buildEvent({ ...base, startTime: "22:00", endTime: "05:00" }, [], opts);
    expect(night.start.dateTime).toBe("2026-12-01T22:00:00");
    expect(night.end.dateTime).toBe("2026-12-02T05:00:00");
    const late = await buildEvent({ ...base, startTime: "16:00", endTime: "24:00" }, [], opts);
    expect(late.end.dateTime).toBe("2026-12-02T00:00:00");
    expect(late.start.timeZone).toBe("Asia/Tokyo");
  });

  it("時間が重なるメンバーだけを説明に書き、内容が変わると指紋が変わる", async () => {
    const opts = { titleMode: "symbol" as const, workplaceName: null };
    const mine = { ...base, startTime: "09:00", endTime: "13:00" };
    const others = [
      { date: "2026-12-01", startTime: "12:00", endTime: "18:00", name: "田中" },
      { date: "2026-12-01", startTime: "13:00", endTime: "18:00", name: "佐藤" }, // 重ならない
      { date: "2026-12-02", startTime: "09:00", endTime: "13:00", name: "鈴木" }, // 別の日
    ];
    const ev = await buildEvent(mine, others, opts);
    expect(ev.description).toContain("一緒に働く人: 田中");
    expect(ev.description).not.toContain("佐藤");
    expect(ev.description).not.toContain("鈴木");
    expect((await buildEvent(mine, others, opts)).extendedProperties.private.h).toBe(ev.extendedProperties.private.h);
    expect((await buildEvent(mine, [], opts)).extendedProperties.private.h).not.toBe(ev.extendedProperties.private.h);
  });

  it("トークンの暗号化と復号", async () => {
    const enc = await encrypt(env.TOKEN_ENCRYPTION_KEY, "secret-token");
    expect(enc).not.toContain("secret-token");
    expect(await decrypt(env.TOKEN_ENCRYPTION_KEY, enc)).toBe("secret-token");
  });
});

/* ---------- 連携 (OAuth) ---------- */

describe("連携", () => {
  it("未連携の状態を返す", async () => {
    const u = await createUser();
    const r = await call(u.cookie, "GET", "/gcal");
    expect(r.data).toEqual({ available: true, connection: null });
  });

  it("認可 URL は最小のスコープと PKCE を使う", async () => {
    const u = await createUser();
    const r = await raw(u.cookie, "POST", "/gcal/connect");
    const url = new URL(((await r.json()) as { url: string }).url);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.app.created");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://manageshift.fun/api/gcal/callback");
    expect(r.headers.getSetCookie().join("\n")).toMatch(/__Host-gcal_state=.*HttpOnly/);
  });

  it("連携するとトークンを暗号化して保存し、設定画面に戻る", async () => {
    const u = await setupUser();
    const { cb } = await connect(u.cookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/settings?gcal=connected");
    const row = (await conn(u.userId))!;
    expect(row.status).toBe("active");
    expect(row.refresh_token_enc).not.toContain("refresh-abc");
    expect(await decrypt(env.TOKEN_ENCRYPTION_KEY, row.refresh_token_enc)).toBe("refresh-abc");
  });

  it("state が Cookie と一致しない・再利用・他のユーザーのものは拒否する", async () => {
    const u = await createUser();
    const res = await raw(u.cookie, "POST", "/gcal/connect");
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    const stateCookie = stateCookieOf(res);

    // Cookie なし
    let cb = await raw(u.cookie, "GET", `/gcal/callback?state=${state}&code=x`);
    expect(cb.headers.get("Location")).toBe("/settings?gcal=error");
    // 他のユーザー
    const v = await createUser();
    cb = await raw(`${v.cookie}; ${stateCookie}`, "GET", `/gcal/callback?state=${state}&code=x`);
    expect(cb.headers.get("Location")).toBe("/settings?gcal=error");
    expect(await conn(v.userId)).toBeNull();
    // 正しい組み合わせでも、一度使われた state は使えない
    const first = await connect(u.cookie);
    expect(first.cb.headers.get("Location")).toBe("/settings?gcal=connected");
    cb = await raw(`${u.cookie}; ${first.stateCookie}`, "GET", `/gcal/callback?state=${first.state}&code=y`);
    expect(cb.headers.get("Location")).toBe("/settings?gcal=error");
    expect(calls).not.toContain("exchange:y");
  });

  it("Google の画面で拒否したら denied", async () => {
    const u = await createUser();
    const res = await raw(u.cookie, "POST", "/gcal/connect");
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    const stateCookie = stateCookieOf(res);
    const cb = await raw(`${u.cookie}; ${stateCookie}`, "GET", `/gcal/callback?state=${state}&error=access_denied`);
    expect(cb.headers.get("Location")).toBe("/settings?gcal=denied");
  });

  it("連携解除でカレンダーを削除しトークンを取り消す", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await syncNow(u.cookie);
    const calId = (await conn(u.userId))!.calendar_id;
    expect((await call(u.cookie, "DELETE", "/gcal")).status).toBe(200);
    expect(await conn(u.userId)).toBeNull();
    expect(calls).toContain(`deleteCalendar:${calId}`);
    expect(calls).toContain("revoke:refresh-abc");
  });
});

/* ---------- 同期 ---------- */

describe("同期", () => {
  it("自分のシフトだけを追加・更新・削除する", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    const s1 = (await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1), { shiftCodeId: u.code.id }))).data.shift;
    const s2 = (await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(2)))).data.shift;
    await call(u.cookie, "POST", "/shifts", shift(u.other.id, future(3)));
    await syncNow(u.cookie);

    expect(events().map((e) => e.id).sort()).toEqual([eventId(s1.id), eventId(s2.id)].sort());
    const e1 = events().find((e) => e.id === eventId(s1.id))!;
    expect(e1.summary).toBe("A");
    expect(e1.start.dateTime).toBe(`${future(1)}T09:00:00`);

    // 変更なしなら何もしない
    calls = [];
    expect(await syncNow(u.cookie)).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    expect(calls).toEqual([]);

    // 時間の変更と削除
    await call(u.cookie, "PUT", `/shifts/${s1.id}`, shift(u.me.id, future(1), { startTime: "10:00" }));
    await call(u.cookie, "DELETE", `/shifts/${s2.id}`);
    await syncNow(u.cookie);
    expect(events().map((e) => e.id)).toEqual([eventId(s1.id)]);
    expect(events()[0].start.dateTime).toBe(`${future(1)}T10:00:00`);
    expect(events()[0].summary).toBe("シフト"); // 記号を外した
  });

  it("変更すると自動で反映される", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await vi.waitFor(async () => expect((await conn(u.userId))!.dirty).toBe(0));
    const s = (await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1)))).data.shift;
    await vi.waitFor(() => expect(events().map((e) => e.id)).toEqual([eventId(s.id)]));
  });

  it("他のメンバーのシフトが変わると説明を更新する", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1)));
    await syncNow(u.cookie);
    expect(events()[0].description).not.toContain("田中");
    await call(u.cookie, "POST", "/shifts", shift(u.other.id, future(1), { startTime: "12:00", endTime: "20:00" }));
    await syncNow(u.cookie);
    expect(events()[0].description).toContain("一緒に働く人: 田中");
  });

  it("「自分」を別のメンバーに変えると予定が入れ替わる", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1)));
    const o = (await call(u.cookie, "POST", "/shifts", shift(u.other.id, future(2)))).data.shift;
    await syncNow(u.cookie);
    await call(u.cookie, "PUT", `/members/${u.other.id}`, { name: "田中", aliases: [], isMe: true });
    await syncNow(u.cookie);
    expect(events().map((e) => e.id)).toEqual([eventId(o.id)]);
  });

  it("タイトルをバイト先名に切り替えられる", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1), { shiftCodeId: u.code.id }));
    await syncNow(u.cookie);
    expect(events()[0].summary).toBe("A");

    const r = await call(u.cookie, "PUT", "/gcal/settings", { titleMode: "workplace", workplaceName: "駅前店" });
    expect(r.status).toBe(200);
    expect(events()[0].summary).toBe("駅前店");
    expect((await call(u.cookie, "GET", "/gcal")).data.connection).toMatchObject({
      titleMode: "workplace",
      workplaceName: "駅前店",
    });

    // 記号の名前を変えると、記号モードのタイトルも変わる
    await call(u.cookie, "PUT", "/gcal/settings", { titleMode: "symbol", workplaceName: "駅前店" });
    await call(u.cookie, "PUT", `/shift-codes/${u.code.id}`, {
      symbol: "早",
      isOff: false,
      startTime: "09:00",
      endTime: "17:00",
      breakMinutes: 60,
    });
    await syncNow(u.cookie);
    expect(events()[0].summary).toBe("早");
  });

  it("範囲より前のシフト・アプリ以外の予定は触らない", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await call(u.cookie, "POST", "/shifts", shift(u.me.id, addDays(jstToday(), -60)));
    await syncNow(u.cookie);
    expect(events()).toEqual([]);

    // ユーザーが専用カレンダーに手で足した予定
    const calId = (await conn(u.userId))!.calendar_id as string;
    calendars.get(calId)!.set("manual1", {
      id: "manual1",
      summary: "メモ",
      description: "",
      start: { dateTime: `${future(1)}T09:00:00`, timeZone: "Asia/Tokyo" },
      end: { dateTime: `${future(1)}T10:00:00`, timeZone: "Asia/Tokyo" },
      extendedProperties: { private: {} },
      status: "confirmed",
    });
    await syncNow(u.cookie);
    expect(events().map((e) => e.id)).toEqual(["manual1"]);
  });

  it("Google 側で消された予定・カレンダーを作り直す", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    const s = (await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1)))).data.shift;
    await syncNow(u.cookie);
    const calId = (await conn(u.userId))!.calendar_id as string;

    // 予定だけ削除 (取り消し済みとして残る) → 同じ ID で復活
    calendars.get(calId)!.get(eventId(s.id))!.status = "cancelled";
    await syncNow(u.cookie);
    expect(events().map((e) => e.id)).toEqual([eventId(s.id)]);

    // カレンダーごと削除 → 新しいカレンダーを作る
    calendars.delete(calId);
    await syncNow(u.cookie);
    const newId = (await conn(u.userId))!.calendar_id;
    expect(newId).not.toBe(calId);
    expect(events().map((e) => e.id)).toEqual([eventId(s.id)]);
  });

  it("一度に反映する件数には上限があり、残りは次回に回す", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await vi.waitFor(async () => expect((await conn(u.userId))!.dirty).toBe(0));
    const values = Array.from({ length: MAX_OPS_PER_SYNC + 5 }, (_, i) =>
      env.DB.prepare(
        "insert into shifts (id, user_id, member_id, date, start_time, end_time, break_minutes, source) values (?, ?, ?, ?, '09:00', '17:00', 0, 'manual')",
      ).bind(crypto.randomUUID(), u.userId, u.me.id, future(1 + (i % 60))),
    );
    await env.DB.batch(values);
    const first = await syncUser(env, u.userId);
    expect(first).toMatchObject({ ok: true, inserted: MAX_OPS_PER_SYNC, remaining: 5 });
    expect((await conn(u.userId))!.dirty).toBeGreaterThan(0);
    const second = await syncUser(env, u.userId);
    expect(second).toMatchObject({ ok: true, inserted: 5, remaining: 0 });
    expect((await conn(u.userId))!.dirty).toBe(0);
  });

  it("トークンが失効したら再連携が必要な状態にする", async () => {
    const u = await setupUser();
    await connect(u.cookie);
    await vi.waitFor(async () => expect((await conn(u.userId))!.dirty).toBe(0));
    refreshError = new GoogleError(400, "invalid_grant", "Token has been expired or revoked.");
    const r = await call(u.cookie, "POST", "/gcal/sync");
    expect(r.status).toBe(502);
    expect(r.data.error).toContain("もう一度連携");
    expect((await call(u.cookie, "GET", "/gcal")).data.connection).toMatchObject({
      status: "reauth_required",
    });
    // 再連携で元に戻る
    refreshError = null;
    await connect(u.cookie, "again");
    expect((await conn(u.userId))!.status).toBe("active");
  });

  it("連携していなければ他の API に影響しない", async () => {
    const u = await setupUser();
    const r = await call(u.cookie, "POST", "/shifts", shift(u.me.id, future(1)));
    expect(r.status).toBe(201);
    expect(await conn(u.userId)).toBeNull();
  });
});
