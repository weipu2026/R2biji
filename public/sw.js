/* JMbiji Service Worker:缓存应用外壳 + **只读的密文接口**(离线可读的唯一支点)
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
 * 缓存白名单(2026-10-11 起):/api/* **默认**一律不经缓存,唯一例外是上面
 * OFFLINE_API_GET 列出的三个只读密文接口 —— 没有它们,断网时连 boot 第一步的
 * fetchVault 都过不去,整个应用直接停在「无法连接服务器」,私密笔记在飞机/地铁上等于废掉。
 *
 * ⚠️ 「缓存密文 = 锁屏形同虚设」这个旧口径**混淆了两件事**,在此订正:
 *   · 缓存里存的是**密文**:vault.json 只有 KDF 参数与被 KEK 包裹的 DEK,分类文件是
 *     AES-256-GCM 密文 —— 没有主密码,这些副本一个字都读不出来;
 *   · 而这一模一样的密文本来就躺在 R2 上(拿到网址 + ACCESS_KEY 就能拉走),
 *     本地多一份**不新增实质攻击面**;
 *   · 真正会让锁屏失效的是**明文**副本(例如「记住本设备」写进 localStorage 的 DEK),
 *     那与这条缓存策略无关。
 *   它的威胁等级等同于「把全库备份包下载到本机」——DESIGN.md §9 第 18 条已记账。
 *
 * ⚠️ 代价(必须知道):锁定**不会**清除这份密文副本,否则离线阅读就白做了。
 *   不接受就别用它 —— 清掉浏览器站点数据即可回到「本机零留存」。
 * ⚠️ 写请求(PUT/DELETE)永不缓存:离线写必然失败,由应用层报错并保留 dirty,
 *   绝不允许拿旧数据假装保存成功。
 */
const CACHE = 'jmbiji-v18';
/** 允许离线缓存的**只读密文**接口(理由见文件顶部注释):
 *   /api/vault 库级参数   /api/cats 分类清单   /api/cat?key=xxx 单个分类密文
 *  ⚠️ 白名单必须精确到路径。放宽成 "/api/ 前缀" 会把写请求和别的接口一起卷进来;
 *     判据在 tests/sw-cache.test.mjs 里逐条钉着(放行、拒绝、写请求三条)。 */
const OFFLINE_API_GET = /^\/api\/(vault|cats|cat)$/;
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
  /* /api/*:默认不经缓存;唯一例外是只读密文接口(见 OFFLINE_API_GET)。
   * 网络优先 —— 拿到就顺手更新本地副本;网络不可用时才回退上次那份,
   * 这样「打开过至少一次」之后,断网也能解锁并读到正文。 */
  if (url.pathname.startsWith('/api/')) {
    if (OFFLINE_API_GET.test(url.pathname)) {
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            if (res && res.ok && res.type === 'basic') {
              e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {}));
            }
            return res;
          })
          .catch(() => caches.match(e.request).then((hit) => hit || Response.error())),
      );
    }
    return;   // 写请求与白名单外的接口:一律放行给网络,SW 不碰
  }

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
   * 护栏不变:**写请求与白名单外的接口**一律不经过缓存(上面已 return)——
   * 上面那三个只读密文接口是唯一例外,理由见文件顶部注释(存的是密文、且同一份
   * 密文本就在 R2 上,不新增实质攻击面;真正要防的是明文副本)。 */
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
