import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Google カレンダー連携のテスト用 (Google への通信は test/gcal.test.ts で差し替える)
            GOOGLE_CLIENT_ID: "test-client",
            GOOGLE_CLIENT_SECRET: "test-secret",
            TOKEN_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
