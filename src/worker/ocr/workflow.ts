import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runParse, type ParseParams } from "./runParse";

/**
 * シフト表の読み取りを裏で実行する。
 * 読み取りは1〜2分かかるため、画面との接続 (スマホで画面を消す・アプリを切り替える) に左右されないようにする
 */
export class ParseWorkflow extends WorkflowEntrypoint<Env, ParseParams> {
  async run(event: WorkflowEvent<ParseParams>, step: WorkflowStep) {
    // 自動の再試行はしない (Claude API の料金が二重にかかるため。失敗は画面から再読み取りする)
    return step.do("parse", { retries: { limit: 0, delay: 0 }, timeout: "10 minutes" }, () =>
      runParse(this.env, event.payload.importId, event.payload.token),
    );
  }
}
