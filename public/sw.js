/*
 * Service Worker: アプリの枠 (HTML・JS・CSS・アイコン) だけをキャッシュし、電波が弱くても画面を開けるようにする。
 * /api 以下 (ログイン状態・シフトなどのデータ) は一切キャッシュしない。
 */
const CACHE = "shift-shell-v2";
const SHELL = ["/manifest.webmanifest", "/icons/icon-192.png"];

/**
 * HTML と、その HTML が読み込むビルド済みの JS・CSS (/assets/...) をまとめて保存する。
 * 初回の表示では Service Worker の登録より先に JS・CSS の読み込みが終わっていて横取りできないため、
 * ここで明示的に取りにいく (保存しないと、オフラインで HTML だけ返って真っ白になる)
 */
async function precacheShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "no-cache" });
  if (!res.ok) throw new Error("shell fetch failed");
  const html = await res.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await cache.put("/", res);
  await cache.addAll([...new Set([...assets, ...SHELL])]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // ページの移動: まずネットワーク (常に最新)。つながらなければキャッシュした枠を返す
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/", { ignoreVary: true })),
    );
    return;
  }

  // ビルド済みファイル (名前にハッシュ付き) とアイコン: キャッシュ優先
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      // 応答に Vary: Origin が付くため、crossorigin 付きの読み込み (Origin ヘッダーあり) とも一致するよう Vary を無視する
      caches.match(req, { ignoreVary: true }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});
