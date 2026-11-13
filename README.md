# manage_shift

職場のシフト表画像を取り込み、自分のシフト・一緒に働くメンバー・概算給与を管理する Web アプリ。

- Cloudflare Workers (Hono) + Static Assets (React + Vite)
- D1 (Drizzle ORM) / R2 / Claude API (シフト表画像の読み取り)

## 認証

パスキー (WebAuthn) のみ。パスワード・メールアドレスは扱わない。

- 新規登録は名前を入力してパスキーを作成。ログインはユーザー名入力なしでパスキーを選ぶだけ
- ユーザー検証 (生体認証/PIN) 必須、discoverable credential 必須
- チャレンジは 5 分で失効・1 回限り。HttpOnly Cookie でブラウザに紐付け
- セッション Cookie は `__Host-` / HttpOnly / Secure / SameSite=Lax。DB にはトークンの SHA-256 のみ保存
- 状態を変える API は Origin ヘッダが同一オリジンでなければ 403
- 機種変更や紛失に備え、設定画面から複数のパスキーを登録できる (最後の 1 つは削除不可)
- RP ID は既定でアクセスされたホスト名。独自ドメインに固定する場合は `RP_ID` / `RP_ORIGIN` を設定

## 開発

```bash
npm install
npm run db:migrate:local
npm run dev
```

- テスト: `npm test`
- 型チェック: `npm run typecheck`
- スキーマ変更後: `npm run db:generate` → `npm run db:migrate:local`

## デプロイ (Cloudflare)

初回だけ、自分の PC で次を実行します (Cloudflare アカウントが必要。無料プランで動きます)。

```bash
npx wrangler login
npx wrangler d1 create manage-shift-db        # 表示された database_id を wrangler.jsonc に書く
npx wrangler r2 bucket create manage-shift-images
npx wrangler secret put ANTHROPIC_API_KEY     # シフト表画像の読み取りに使う
npm run db:migrate:remote
npm run deploy
```

2回目以降は `npm run db:migrate:remote` (マイグレーションがあるとき) と `npm run deploy` だけです。
`npx wrangler deploy --dry-run` で、実際に公開せずに設定を確認できます。

- **パスキーはドメインに結び付きます。** 最初に使うドメイン (`*.workers.dev` か独自ドメイン) を決めてから登録してください。独自ドメインに移すと、パスキーの作り直しが必要です。固定したい場合は `wrangler.jsonc` の `RP_ID` / `RP_ORIGIN` を設定します
- 画面側のセキュリティヘッダー (CSP など) は `public/_headers`、API 側は Hono の `secureHeaders` で付けています

## ホーム画面に追加 (PWA)

- iPhone: Safari の共有ボタン →「ホーム画面に追加」
- Android / PC の Chrome: アドレスバーのインストールボタン、またはメニューの「アプリをインストール」

Service Worker (`public/sw.js`) は画面の枠 (HTML・JS・CSS・アイコン) だけをキャッシュします。ログイン状態やシフトなどのデータ (`/api`) はキャッシュしません。電波がないときは「通信できません」と表示します。

## デザインルール

- グラデーション禁止。黒の単色＋グレースケールのみ
- 余白は 8 の倍数 (`--spacing: 8px`。`p-1` = 8px。小数指定は使わない)
- 文字の左端は文字の頭で揃える
- 線アイコン (lucide, strokeWidth 1.5)
- 強弱は濃淡 (ink-900 → ink-100) で示す
- カードは控えめ (影なし・細い罫線か淡い面のみ・入れ子にしない)
- タイトルやキャッチコピーは置かない
