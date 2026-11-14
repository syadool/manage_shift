import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
const userRef = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

/** 認証はパスキー (WebAuthn) のみ。パスワード・メールは保持しない */
export const users = sqliteTable("users", {
  id: id(),
  /** パスキー登録時に表示される名前 (パスワードマネージャ上の識別用) */
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const passkeys = sqliteTable(
  "passkeys",
  {
    /** credential ID (base64url) */
    id: id(),
    userId: userRef(),
    /** COSE 公開鍵 (base64url) */
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports", { mode: "json" }).$type<string[]>(),
    deviceType: text("device_type", { enum: ["singleDevice", "multiDevice"] }).notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    /** 利用者が付ける名前 (例: iPhone) */
    name: text("name").notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/** WebAuthn のチャレンジ。1回限り・短時間で失効 */
export const authChallenges = sqliteTable("auth_challenges", {
  id: id(),
  challenge: text("challenge").notNull(),
  kind: text("kind", { enum: ["register", "login", "add"] }).notNull(),
  /** register: 作成予定のユーザー ID / add: ログイン中のユーザー ID */
  userId: text("user_id"),
  displayName: text("display_name"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** セッショントークンの SHA-256 (hex)。トークン自体は保存しない */
    id: id(),
    userId: userRef(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const settings = sqliteTable("settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  hourlyWage: integer("hourly_wage").notNull().default(0),
  transportPerDay: integer("transport_per_day").notNull().default(0),
  incomeWallYen: integer("income_wall_yen"),
  wallLabel: text("wall_label"),
  /** 交通費を年収の壁の判定に含めるか */
  includeTransportInWall: integer("include_transport_in_wall", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const members = sqliteTable(
  "members",
  {
    id: id(),
    userId: userRef(),
    name: text("name").notNull(),
    /** OCR で読んだ名前の揺れ (JSON 配列) */
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    isMe: integer("is_me", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("members_user_idx").on(t.userId)],
);

/**
 * メンバーの名前・別名を正規化したもの (normalizeName)。
 * ユーザー内で一意にし、同時リクエストでも重複した名前を DB が拒否するようにする。
 * members の書き込みと同じ batch (トランザクション) で更新する
 */
export const memberNames = sqliteTable(
  "member_names",
  {
    userId: userRef(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    normalized: text("normalized").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.normalized] }),
    index("member_names_member_idx").on(t.memberId),
  ],
);

export const shiftCodes = sqliteTable(
  "shift_codes",
  {
    id: id(),
    userId: userRef(),
    symbol: text("symbol").notNull(),
    /** "HH:MM" */
    startTime: text("start_time"),
    endTime: text("end_time"),
    breakMinutes: integer("break_minutes").notNull().default(0),
    isOff: integer("is_off", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("shift_codes_user_symbol_uq").on(t.userId, t.symbol)],
);

export const shifts = sqliteTable(
  "shifts",
  {
    id: id(),
    userId: userRef(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    /** "YYYY-MM-DD" */
    date: text("date").notNull(),
    shiftCodeId: text("shift_code_id").references(() => shiftCodes.id, { onDelete: "set null" }),
    /** "HH:MM"。end < start なら日跨ぎ */
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    source: text("source", { enum: ["ocr", "manual"] }).notNull(),
  },
  (t) => [
    index("shifts_user_date_idx").on(t.userId, t.date),
    index("shifts_member_date_idx").on(t.memberId, t.date),
  ],
);

export const imports = sqliteTable(
  "imports",
  {
    id: id(),
    userId: userRef(),
    r2Key: text("r2_key").notNull(),
    /** "YYYY-MM" */
    targetMonth: text("target_month"),
    status: text("status", { enum: ["uploaded", "parsing", "parsed", "committing", "committed", "failed"] }).notNull(),
    rawResult: text("raw_result", { mode: "json" }),
    /** 画像の MIME タイプ */
    contentType: text("content_type").notNull().default("image/jpeg"),
    /** 読み取り (Claude API 呼び出し) の回数。費用の上限管理に使う */
    parseAttempts: integer("parse_attempts").notNull().default(0),
    /** 直近の読み取り失敗の理由 */
    error: text("error"),
    /**
     * 最後に始めた読み取りの識別子。結果はこれが一致するときだけ保存する
     * (同時に読み取ったとき、古い読み取りの結果で上書きしないため)
     */
    parseToken: text("parse_token"),
    /** 最後に読み取りを始めた時刻。読み取り中のまま止まったものを見分けるのに使う */
    parseStartedAt: integer("parse_started_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("imports_user_created_idx").on(t.userId, t.createdAt)],
);
