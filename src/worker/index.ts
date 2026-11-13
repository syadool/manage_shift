import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth/routes";
import { loadSession, sameOriginOnly } from "./auth/session";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", secureHeaders());
app.use("*", sameOriginOnly);
app.use("*", loadSession);

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);

export default app;
