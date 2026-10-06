/* JMbiji Service Worker:仅缓存应用自身(外壳),不碰任何库数据与 /api/*
 *
 * 缓存策略(2026-10-06 起,分两类):
 *   · **导航请求**(mode==='navigate',即「打开/刷新页面」)→ 纯 network-first:
 *     先走网络,拿到就是最新版,失败才回缓存。这是「部署了但界面没变」的最后
 *     一道保险。
 *   · **静态资源**(js/css/图标/manifest)→ stale-while-revalidate:
 *     命中缓存就立刻返回(零网络往返),同时后台悄悄更新,下次访问即新版。
 *   ⚠️ 此前对所有请求一律 network-first,把 _headers 给 js/css 加的长缓存
 *      完全抵消掉了 —— 浏览器缓存根本轮不到生效。首屏 20 个模块(gzip≈139KB)
 *      因此每次访问都要付 20 次串行往返(模块图 5 层深)。
 *
 * ✅ 因此**不再需要「改完资源把版本号 +1」**:任何 css/js 改动,用户普通刷新即可拿到,
 *    不再出现「部署了但界面没变」。CACHE 版本号只在**清理历史旧缓存**时才需要动。
 *    唯一仍要改 sw.js 的场景:新增/删除 js 模块时同步 ASSETS 清单
 *    (tests/assets.test.mjs 会自动核对清单与实际文件)—— 而改 sw.js 本身就会触发重装。
 *
 * 硬护栏:/api/* 一律不经过缓存。密文与 vault.json 只要被 Cache Storage 留过一份,
 * 锁屏就形同虚设(换用户/退出登录都还能从缓存读出来)。ASSETS 清单里没有 API 路径,
 * 下面这行是防止将来有人往里加。
 */
const CACHE = 'jmbiji-v18';
const ASSETS = [
  './',
  './index.html',
  // 应急恢复页:离线救灾时最需要它 —— 以前不在清单里,离线打开会落到主应用外壳
  './recover.html',
  './css/style.css',
  './js/crypto.js',
  './js/format.js',
  './js/vaultlib.js',
  './js/api.js',
  './js/lib.js',
  './js/render.js',
  './js/search.js',
  './js/session.js',
  './js/store.js',
  './js/tabsync.js',
  './js/zip.js',
  './js/ui.js',
  './js/main.js',
  './js/features/theme.js',
  './js/features/search.js',
  './js/features/data.js',
  './js/features/lock.js',
  './js/features/sidebar.js',
  './js/features/note.js',
  './js/features/shell.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  // 预缓存:首次打开(甚至还没访问过某个模块)就具备完整离线能力
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 离线导航兜底该取哪个页面。
 *  ★ 以前一律回 index.html:离线打开 /recover.html(应急恢复页)会拿到主应用外壳,
 *    用户以为「应急页也坏了」—— 而那正是最需要它的时刻(2026-09-29 审计 P3)。
 *    按请求路径给对应页面,认不出来才回主应用。 */
function navFallback(url) {
  try {
    const p = new URL(url).pathname;
    if (p.endsWith('/recover.html')) return './recover.html';
  } catch { /* URL 解析失败:按主应用兜底 */ }
  return './index.html';
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 只管自己域名的资源:跨域请求交给浏览器原生处理(本应用零第三方依赖,
  // 但将来引了 CDN/字体时,跨域 GET 走进这条管道会在离线时以 undefined 响应
  // 并把原生网络错误换成 SW 异常)(2026-10-06 审计 P2)
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  /* 导航请求(打开页面)保持**纯network-first**:先走网络,拿到就是最新版,
     失败才回缓存。这一条是「部署了但界面没变」的最后一道保险,不动。 */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {}));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request, { ignoreSearch: true })
            .then((hit) => hit || caches.match(navFallback(e.request.url))),
        ),
    );
    return;
  }

  /* 静态资源(js/css/图标/manifest)改 stale-while-revalidate(2026-10-06 速度专项):
   * 此前对所有请求一律 network-first,于是 `_headers` 里给 js/css 加的长缓存
   * (max-age=3600 + stale-while-revalidate=86400)**完全被抵消** —— 浏览器缓存
   * 命中与否根本轮不到生效,SW 每次都强制回源。首屏 20 个模块 = 20 次串行往返。
   *
   * 现在:命中缓存就**立刻**返回(零往返,首屏不再等网络),同时后台悄悄更新,
   * 下次访问就是新版。零依赖的原生 ESM 新旧混用不会崩,且 sw.js 自身仍 no-cache,
   * 它的 skipWaiting + clients.claim 会把整页刷新到一致状态。
   *
   * 硬护栏不变:/api/* 一律不经过缓存(上面已 return)—— 密文与 vault.json 只要被
   * Cache Storage 留过一份,锁屏就形同虚设。 */
  e.respondWith(
    caches.match(e.request, { ignoreSearch: false }).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {}));
          }
          return res;
        })
        .catch(() => null);
      if (cached) {
        // 有缓存就用它,后台那次 fetch 只为「下次访问是新的」;失败也无所谓(已有缓存可用)
        e.waitUntil(fresh);
        return cached;
      }
      return fresh.then((res) => res || Response.error());
    }),
  );
});
