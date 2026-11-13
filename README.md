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

## シフト表画像の読み取り (Claude API)

- 取り込み画面で画像を選ぶと、ブラウザで長辺 2000px の JPEG に縮小してアップロードし、R2 に保存します
- Worker が Claude API (`claude-opus-5-5`, 構造化出力) で表を読み取り、確認・修正画面で直してから保存します
- 同じ月を取り込み直すと、画像から取り込んだシフトだけを置き換えます (手入力のシフトは残ります)
- 費用の上限: アップロードは1ユーザー1日20枚まで、読み取りは1枚3回まで

開発時は `.dev.vars` に API キーを書きます (`.dev.vars.example` をコピー。`.dev.vars` はコミットしません)。本番は上記の Secret を使います。

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Google カレンダー連携

設定画面から Google カレンダーと連携すると、**自分 (「自分」に設定したメンバー) のシフト**を Google カレンダーに自動で反映します (アプリ → Google の片方向)。

- アプリ専用の「シフト (manageshift)」カレンダーを作り、そこにだけ書き込みます。スコープは `calendar.app.created` (アプリが作ったカレンダーだけ操作できる最小の権限)
- 予定のタイトルは「シフトの記号」か「バイト先名」を選べます。時間は予定の開始・終了に入ります。説明欄には時間が重なるメンバー名が入ります
- シフト・メンバー・記号の変更や画像の取り込みを保存すると、すぐに反映します。失敗したもの・件数が多くて残ったものは 15 分ごとの Cron でやり直します
- 反映するのは 31 日前以降のシフトです。DB の内容と Google 側の予定を照合して追加・更新・削除するので、Google 側で予定やカレンダーを消しても次の反映で元に戻ります
- リフレッシュトークンは `TOKEN_ENCRYPTION_KEY` で AES-GCM 暗号化して保存します。連携を解除すると専用カレンダーを削除し、トークンを取り消します

### 設定手順

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作り、**Google Calendar API** を有効にする
2. OAuth 同意画面を作成 (外部)。スコープに `https://www.googleapis.com/auth/calendar.app.created` を追加。審査が済むまではテストユーザーに登録した Google アカウント (100 人まで) だけが連携できます
3. 認証情報 → OAuth クライアント ID (ウェブ アプリケーション) を作成し、承認済みのリダイレクト URI に次を登録
   - 本番: `https://manageshift.fun/api/gcal/callback`
   - 開発: `http://localhost:5173/api/gcal/callback`
4. Secret を登録 (開発は `.dev.vars`)。未設定なら連携機能は表示されません

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

```bash
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

## デプロイ (Cloudflare)

本番は独自ドメイン **https://manageshift.fun** で公開しています (`wrangler.jsonc` の `routes`)。`workers.dev` とプレビュー URL は無効にしています。

- D1: `manage-shift-db` (APAC)。ID は `wrangler.jsonc` に記載
- R2: `manage-shift-images`
- Secret: `ANTHROPIC_API_KEY` (シフト表画像の読み取り)。Cloudflare ダッシュボード → Workers & Pages → manage-shift → Settings → Variables and Secrets で設定する。値はリポジトリに置かない

**`main` にマージされると、GitHub Actions (`.github/workflows/deploy.yml`) が自動で公開します。**
型チェック → テスト → ビルド → D1 マイグレーション → デプロイ → 動作確認 (`/api/health`) の順で、途中で失敗したら公開しません。
GitHub のリポジトリ設定 → Secrets and variables → Actions に、Secret `CLOUDFLARE_API_TOKEN` が必要です (権限はワークフローの先頭に記載)。
Actions タブの「Deploy」→「Run workflow」で、手動でも実行できます。

手元から公開する場合:

```bash
npx wrangler login
npm run db:migrate:remote   # マイグレーションがあるとき
npm run deploy
```

`npx wrangler deploy --dry-run` で、実際に公開せずに設定を確認できます。
認証は `wrangler login`、または `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` で行います。

- **パスキーは `manageshift.fun` に結び付いています** (`RP_ID` / `RP_ORIGIN`)。ドメインを変えると、パスキーの登録し直しが必要です
- ローカル開発では `.dev.vars` で `RP_ID` / `RP_ORIGIN` を空にし、localhost で登録できるようにしています (`.dev.vars.example` をコピー)
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
