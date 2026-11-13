import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
const userRef = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = sqliteTable(
  "sessions",
  {
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
    status: text("status", { enum: ["uploaded", "parsed", "committed", "failed"] }).notNull(),
    rawResult: text("raw_result", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("imports_user_idx").on(t.userId)],
);
