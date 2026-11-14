import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// テストでは Workflow を使わず、読み取りをその場で最後まで実行する
import { parseRunner, runParse } from "../src/worker/ocr/runParse";
parseRunner.start = async (e, params) => {
  await runParse(e, params.importId, params.token);
};
