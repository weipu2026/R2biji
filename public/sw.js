/* JMbiji Service Worker:仅缓存应用自身(外壳),不碰任何库数据与 /api/*
 *
 * 缓存策略(2026-09-25 起):**全量 network-first**
 *   所有同源静态资源(含页面 HTML)都先走网络,拿到新版直接用,同时顺手刷新缓存;
 *   断网/网络失败才回退缓存 —— 离线可用性不丢,在线时永远是最新的。
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
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 网络成功:返回新版,并顺手刷新缓存(下次断网时的兜底也是新的)
        if (res && res.ok && res.type === 'basic') {
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {}));
        }
        return res;
      })
      .catch(() =>
        // 网络失败(离线):回退缓存;导航请求再兜一层 SPA 外壳
        caches.match(e.request, { ignoreSearch: true })
          .then((hit) => hit || (e.request.mode === 'navigate' ? caches.match(navFallback(e.request.url)) : undefined)),
      ),
  );
});
