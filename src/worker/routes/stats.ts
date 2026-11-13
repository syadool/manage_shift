import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, lte } from "drizzle-orm";
import { coworkerStats } from "../../shared/calc";
import { daysBetween } from "../../shared/dates";
import { dateString } from "../../shared/schemas";
import { summarizeYear } from "../../shared/stats";
import { requireAuth } from "../auth/session";
import { getDb } from "../db/client";
import { members, settings, shifts } from "../db/schema";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const rangeQuery = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.from <= v.to, { message: "期間の指定が正しくありません" })
  .refine((v) => daysBetween(v.from, v.to) <= 366, { message: "期間は1年以内で指定してください" });

const payQuery = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/, "年を YYYY で指定してください")
    .transform(Number),
  /** 利用者の端末の今日 (年収の壁の予測の基準日。サーバーの時刻帯に依存しないよう受け取る) */
  today: dateString,
});

const shiftCols = {
  memberId: shifts.memberId,
  date: shifts.date,
  startTime: shifts.startTime,
  endTime: shifts.endTime,
  breakMinutes: shifts.breakMinutes,
};

export const statsRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  /* 一緒に働いた人: 期間内に自分と時間が重なった人を、重なった時間の多い順に */
  .get("/coworkers", validate("query", rangeQuery), async (c) => {
    const userId = c.get("user")!.id;
    const { from, to } = c.req.valid("query");
    const db = getDb(c.env);
    const memberRows = await db
      .select({ id: members.id, name: members.name, isMe: members.isMe })
      .from(members)
      .where(eq(members.userId, userId));
    const me = memberRows.find((m) => m.isMe);
    if (!me) return c.json({ myDays: 0, coworkers: [], hasMe: false });

    const rows = await db
      .select(shiftCols)
      .from(shifts)
      .where(and(eq(shifts.userId, userId), gte(shifts.date, from), lte(shifts.date, to)));
    const mine = rows.filter((s) => s.memberId === me.id);
    const others = rows.filter((s) => s.memberId !== me.id);
    const names = new Map(memberRows.map((m) => [m.id, m.name]));
    return c.json({
      hasMe: true,
      myDays: new Set(mine.map((s) => s.date)).size,
      coworkers: coworkerStats(mine, others).map((st) => ({ ...st, name: names.get(st.memberId) ?? "" })),
    });
  })

  /* 給与: 自分のシフトから1年分を集計し、年収の壁を判定する */
  .get("/pay", validate("query", payQuery), async (c) => {
    const userId = c.get("user")!.id;
    const { year, today } = c.req.valid("query");
    const db = getDb(c.env);
    const [me, setting] = await Promise.all([
      db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.userId, userId), eq(members.isMe, true)))
        .get(),
      db.select().from(settings).where(eq(settings.userId, userId)).get(),
    ]);
    const rule = { hourlyWage: setting?.hourlyWage ?? 0, transportPerDay: setting?.transportPerDay ?? 0 };
    const wall = {
      yen: setting?.incomeWallYen ?? null,
      label: setting?.wallLabel ?? null,
      includeTransport: setting?.includeTransportInWall ?? false,
    };
    const mine = me
      ? await db
          .select(shiftCols)
          .from(shifts)
          .where(
            and(
              eq(shifts.userId, userId),
              eq(shifts.memberId, me.id),
              gte(shifts.date, `${year}-01-01`),
              lte(shifts.date, `${year}-12-31`),
            ),
          )
      : [];
    return c.json({
      hasMe: !!me,
      settings: { ...rule, ...wall },
      pay: summarizeYear(year, mine, rule, today, wall),
    });
  });
