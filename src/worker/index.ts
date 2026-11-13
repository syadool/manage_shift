import { Hono } from "hono";

export type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>().basePath("/api");

app.get("/health", (c) => c.json({ ok: true }));

export default app;
