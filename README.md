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

この PR を `main` にマージする前でも後でも設定できます。Secret が 3 つそろうまで、設定画面に連携の項目は出ません。

#### 1. Google Cloud のプロジェクトを作る

1. https://console.cloud.google.com/ を開き、アプリを使う Google アカウントでログインする
2. 画面上部のプロジェクト選択 → 「新しいプロジェクト」→ 名前 (例: `manageshift`) を入れて「作成」
3. 作ったプロジェクトが選ばれていることを画面上部で確認する

#### 2. Google Calendar API を有効にする

1. 左上のメニュー (≡) → 「API とサービス」→「ライブラリ」
2. `Google Calendar API` を検索して開き、「有効にする」

#### 3. 同意画面 (Google Auth Platform) を設定する

1. メニュー (≡) → 「Google Auth Platform」(表示されない場合は「API とサービス」→「OAuth 同意画面」) →「開始」
2. アプリ名: `manageshift`、ユーザー サポートメール: 自分のアドレス →「次へ」
3. 対象: **外部** →「次へ」
4. 連絡先情報: 自分のアドレス →「次へ」→ ポリシーに同意して「作成」
5. 左の「対象」→「テストユーザー」の「+ Add users」→ 連携に使う Google アカウントのアドレスを追加して保存
   (公開ステータスは「テスト中」のままで構いません。テストユーザーに追加したアカウントだけが連携できます。100 人まで)
6. 左の「データアクセス」→「スコープを追加または削除」→ 一覧の下の「スコープの手動追加」に
   `https://www.googleapis.com/auth/calendar.app.created` を入れて「テーブルに追加」→「更新」→ 画面下の「Save」

#### 4. OAuth クライアントを作る

1. 左の「クライアント」→「クライアントを作成」
2. アプリケーションの種類: **ウェブ アプリケーション**、名前: `manageshift`
3. 「承認済みのリダイレクト URI」の「+ URI を追加」で次を入れる (末尾まで正確に)
   - `https://manageshift.fun/api/gcal/callback`
   - ローカル開発もするなら `http://localhost:5173/api/gcal/callback`
4. 「作成」→ 表示される **クライアント ID** と **クライアント シークレット** を控える
   (シークレットは後から見られないことがあるので、JSON をダウンロードしておくと安全です)

#### 5. Cloudflare に Secret を登録する

Cloudflare ダッシュボード → Workers & Pages → `manage-shift` → Settings → Variables and Secrets →「+ Add」で、種類を **Secret** にして次の 3 つを追加する (`ANTHROPIC_API_KEY` と同じ場所です)。

| 名前 | 値 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | 手順 4 のクライアント ID (`….apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | 手順 4 のクライアント シークレット (`GOCSPX-…`) |
| `TOKEN_ENCRYPTION_KEY` | ランダムな 32 バイトを base64 にした文字列 (下のコマンドで作る) |

`TOKEN_ENCRYPTION_KEY` は次のどれかで作ります。一度決めたら変えないでください (変えると連携し直しが必要になります)。

- Mac / Linux のターミナル:

```bash
openssl rand -base64 32
```

- Windows の PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

#### 6. 公開して連携する

1. この PR を `main` にマージする (GitHub Actions が D1 のマイグレーションとデプロイを自動で行います)
2. https://manageshift.fun の設定画面 →「Google カレンダー」→「Google カレンダーと連携」
3. 「このアプリは Google で確認されていません」と出たら「詳細」→「manageshift (安全ではないページ) に移動」→ 許可する
   (自分で作ったアプリを審査に出していないために出る表示です)
4. 設定画面に戻り「連携しました」と出れば完了。Google カレンダーに「シフト (manageshift)」カレンダーが追加されます

#### うまくいかないとき

- `redirect_uri_mismatch`: 手順 4 のリダイレクト URI が `https://manageshift.fun/api/gcal/callback` と一字一句同じか確認する
- `access_denied` / 「アクセスをブロック」: 手順 3-5 のテストユーザーに、そのアカウントが入っているか確認する
- 設定画面に連携の項目が出ない: 手順 5 の Secret が 3 つともあるか、登録後にデプロイし直したか確認する

#### ローカル開発

`.dev.vars` に同じ 3 つを書きます (`.dev.vars.example` を参照)。

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
