/* JMbiji Service Worker:仅缓存应用自身(外壳),不碰任何库数据与 /api/* */
const CACHE = 'jmbiji-v4';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/crypto.js',
  './js/format.js',
  './js/vaultlib.js',
  './js/api.js',
  './js/lib.js',
  './js/render.js',
  './js/search.js',
  './js/ui.js',
  './js/main.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 硬护栏:/api/* 一律不经过缓存。密文与 vault.json 只要被 Cache Storage 留过
  // 一份,锁屏就形同虚设(换用户/退出登录都还能从缓存读出来)。
  // 目前 ASSETS 清单里没有 API 路径,这行是防止将来有人往里加。
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)),
  );
});
