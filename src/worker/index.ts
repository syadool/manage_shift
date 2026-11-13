import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth/routes";
import { loadSession, sameOriginOnly } from "./auth/session";
import { memberRoutes } from "./routes/members";
import { settingsRoutes } from "./routes/settings";
import { shiftCodeRoutes } from "./routes/shiftCodes";
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

export default app;
