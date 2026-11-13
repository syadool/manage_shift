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

## デプロイ

```bash
npx wrangler d1 create manage-shift-db   # 出力された database_id を wrangler.jsonc に設定
npx wrangler r2 bucket create manage-shift-images
npx wrangler secret put ANTHROPIC_API_KEY
npm run db:migrate:remote
npm run deploy
```

## デザインルール

- グラデーション禁止。黒の単色＋グレースケールのみ
- 余白は 8 の倍数 (`--spacing: 8px`。`p-1` = 8px。小数指定は使わない)
- 文字の左端は文字の頭で揃える
- 線アイコン (lucide, strokeWidth 1.5)
- 強弱は濃淡 (ink-900 → ink-100) で示す
- カードは控えめ (影なし・細い罫線か淡い面のみ・入れ子にしない)
- タイトルやキャッチコピーは置かない
