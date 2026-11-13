import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { cleanExtraction, extractionSchema, type Extraction } from "../../shared/importing";

export type ExtractInput = {
  image: ArrayBuffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** 精度を上げるためのヒント (登録済みの記号とメンバー名) */
  knownSymbols: string[];
  knownNames: string[];
};

export class ExtractError extends Error {}

const MODEL = "claude-opus-5-5";

const SYSTEM = `あなたはアルバイト先のシフト表の画像を読み取り、表の内容をそのまま構造化データにします。

表の形: 行が人、列が日付。各セルにはその日の勤務を表す記号 (例: A, B, 早, 遅, ○, ×) が書かれています。

守ること:
- 画像に書かれている通りに読む。読めないセルや空欄は symbol を "" にし、推測で埋めない
- 名前は表記を変えずにそのまま書く (敬称や番号が付いていれば除く)
- day は日付の列の「日」の数字 (1〜31)。曜日の列や合計の列は含めない
- 表の見出しなどから年月がわかれば yearMonth を "YYYY-MM" で返す。わからなければ null
- 表に無い人や日を足さない
- 読みにくかった箇所や、判断に迷った点があれば notes に短く書く (なければ "")`;

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Claude API でシフト表画像を読み取る */
async function extractWithClaude(env: Env, input: ExtractInput): Promise<Extraction> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ExtractError("画像の読み取りが設定されていません (API キー未設定)");

  // 開発コンテナの ANTHROPIC_BASE_URL などを拾わないよう、接続先は明示する
  const client = new Anthropic({ apiKey, baseURL: "https://api.anthropic.com" });

  const hints = [
    input.knownSymbols.length ? `登録済みの記号: ${input.knownSymbols.join(" / ")}` : "",
    input.knownNames.length ? `登録済みのメンバー名: ${input.knownNames.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let response;
  try {
    response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      // 安全上の判断で断られた場合に、別のモデルで自動的にやり直す
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(extractionSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: input.mediaType, data: base64(input.image) } },
            {
              type: "text",
              text: `このシフト表を読み取ってください。${
                hints ? `\n\n参考 (表記ゆれの判断用。画像に無いものを足さないこと):\n${hints}` : ""
              }`,
            },
          ],
        },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new ExtractError("混み合っています。しばらくしてからお試しください");
    if (e instanceof Anthropic.AuthenticationError) throw new ExtractError("API キーが正しくありません");
    if (e instanceof Anthropic.BadRequestError) throw new ExtractError(`画像を読み取れませんでした: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new ExtractError(`読み取りに失敗しました (${e.status})`);
    throw e;
  }

  if (response.stop_reason === "refusal") throw new ExtractError("この画像は読み取れませんでした");
  if (response.stop_reason === "max_tokens") throw new ExtractError("表が大きすぎて読み取りきれませんでした");
  if (!response.parsed_output) throw new ExtractError("読み取り結果の形式が正しくありませんでした");
  return cleanExtraction(response.parsed_output);
}

/** テストで差し替えられるよう、オブジェクト経由で呼ぶ */
export const ocr = { extract: extractWithClaude };
