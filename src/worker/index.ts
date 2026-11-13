import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth/routes";
import { loadSession, sameOriginOnly } from "./auth/session";
import { syncPending } from "./gcal/sync";
import { gcalRoutes } from "./routes/gcal";
import { importRoutes } from "./routes/imports";
import { memberRoutes } from "./routes/members";
import { settingsRoutes } from "./routes/settings";
import { shiftCodeRoutes } from "./routes/shiftCodes";
import { shiftRoutes } from "./routes/shifts";
import { statsRoutes } from "./routes/stats";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", secureHeaders());
app.use("*", sameOriginOnly);
app.use("*", loadSession);

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);

// 以下は各モジュール内で requireAuth 済み
app.route("/settings", settingsRoutes);
app.route("/shift-codes", shiftCodeRoutes);
app.route("/members", memberRoutes);
app.route("/shifts", shiftRoutes);
app.route("/imports", importRoutes);
app.route("/stats", statsRoutes);
app.route("/gcal", gcalRoutes);

export default {
  fetch: app.fetch,
  /** Google カレンダーへの反映が失敗・途中で終わったものをやり直す */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncPending(env));
  },
} satisfies ExportedHandler<Env>;
