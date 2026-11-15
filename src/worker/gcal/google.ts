/**
 * Google OAuth / Calendar API の呼び出し。
 * テストで差し替えられるよう、関数をオブジェクトにまとめている (ocr と同じ)
 */

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const TIME_ZONE = "Asia/Tokyo";
export const CALENDAR_NAME = "シフト (manageshift)";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleError extends Error {
  constructor(
    public status: number,
    /** OAuth のエラーコード (invalid_grant など) */
    public code: string | null,
    message: string,
    /** Calendar API のエラー理由 (rateLimitExceeded など) */
    public reason: string | null = null,
  ) {
    super(message);
  }

  /** ログ・画面に出す要約 */
  describe(): string {
    return [this.status, this.reason ?? this.code, this.message].filter(Boolean).join(" ");
  }
}

/** 待てば通る (回数制限) エラーの理由 */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);
/** 回数制限のときにやり直すまでの待ち時間 (ミリ秒) */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type GEventTime = { dateTime: string; timeZone: string };
export type GEvent = {
  id: string;
  summary: string;
  description: string;
  start: GEventTime;
  end: GEventTime;
  extendedProperties: { private: Record<string, string> };
};
/** 一覧で返ってくる予定 (必要な項目だけ) */
export type GListedEvent = {
  id: string;
  start?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

type Creds = { clientId: string; clientSecret: string };

function toError(status: number, text: string): GoogleError {
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // JSON 以外の応答
  }
  const err = data.error;
  const code = typeof err === "string" ? err : null;
  const obj = typeof err === "object" && err ? (err as { message?: unknown; status?: unknown; errors?: { reason?: unknown }[] }) : null;
  const reason = obj?.errors?.[0]?.reason ?? obj?.status;
  const message =
    (obj && typeof obj.message === "string" ? obj.message : null) ??
    (typeof data.error_description === "string" ? data.error_description : null) ??
    (text.slice(0, 200) || `Google API error ${status}`);
  return new GoogleError(status, code, message, typeof reason === "string" ? reason : null);
}

/** 回数制限 (429、または理由が回数制限の 403) のときは、少し待ってやり直す */
async function request<T>(url: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    const error = toError(res.status, text);
    const rateLimited = res.status === 429 || (res.status === 403 && RATE_LIMIT_REASONS.has(error.reason ?? ""));
    if (!rateLimited || attempt >= RETRY_DELAYS_MS.length) throw error;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

const api = <T>(accessToken: string, method: string, path: string, body?: unknown) =>
  request<T>(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const form = (params: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params).toString(),
});

const cal = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;

export const google = {
  authUrl(creds: Creds, p: { redirectUri: string; state: string; codeChallenge: string }): string {
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: p.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      // リフレッシュトークンを毎回受け取るため
      prompt: "consent",
      include_granted_scopes: "false",
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTH_URL}?${q}`;
  },

  async exchangeCode(
    creds: Creds,
    p: { code: string; redirectUri: string; codeVerifier: string },
  ): Promise<{ refreshToken: string | null; accessToken: string; scope: string }> {
    const r = await request<{ refresh_token?: string; access_token: string; scope?: string }>(
      TOKEN_URL,
      form({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code: p.code,
        code_verifier: p.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: p.redirectUri,
      }),
    );
    return { refreshToken: r.refresh_token ?? null, accessToken: r.access_token, scope: r.scope ?? "" };
  },

  async refresh(creds: Creds, refreshToken: string): Promise<string> {
    const r = await request<{ access_token: string }>(
      TOKEN_URL,
      form({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    );
    return r.access_token;
  },

  async revoke(token: string): Promise<void> {
    await request(REVOKE_URL, form({ token }));
  },

  async createCalendar(accessToken: string): Promise<string> {
    const r = await api<{ id: string }>(accessToken, "POST", "/calendars", {
      summary: CALENDAR_NAME,
      timeZone: TIME_ZONE,
    });
    return r.id;
  },

  async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    await api(accessToken, "DELETE", cal(calendarId));
  },

  /** timeMin 以降に終わる予定をすべて取得 (取り消し済みは除く) */
  async listEvents(accessToken: string, calendarId: string, timeMin: string): Promise<GListedEvent[]> {
    const out: GListedEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ timeMin, maxResults: "2500", showDeleted: "false", singleEvents: "true" });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await api<{ items?: GListedEvent[]; nextPageToken?: string }>(
        accessToken,
        "GET",
        `${cal(calendarId)}/events?${q}`,
      );
      out.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  },

  async insertEvent(accessToken: string, calendarId: string, event: GEvent): Promise<void> {
    await api(accessToken, "POST", `${cal(calendarId)}/events`, event);
  },

  /** 全体を置き換える。取り消し済みの予定も confirmed に戻す */
  async updateEvent(accessToken: string, calendarId: string, event: GEvent): Promise<void> {
    await api(accessToken, "PUT", `${cal(calendarId)}/events/${encodeURIComponent(event.id)}`, {
      ...event,
      status: "confirmed",
    });
  },

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    await api(accessToken, "DELETE", `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
  },
};
