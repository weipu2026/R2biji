/* sw.js 缓存策略守卫(2026-10-06 速度专项落成正式用例)
 *
 * 背景:此前 sw.js 对所有请求一律 network-first,把 public/_headers 给 js/css 加的
 * 长缓存完全抵消 —— 浏览器缓存根本轮不到生效,首屏 20 个模块(gzip≈139KB)每次
 * 访问都要付 20 次串行往返。现改为「导航 network-first + 静态资源 SWR」。
 *
 * 这个文件必须**跑真代码**:把 sw.js 的 fetch 监听器原文抠出来在沙箱里执行,
 * 而不是重写一份等价实现 —— 后者会与真实 sw.js 分叉,测出来的绿是假绿。
 * 沙箱复刻了三条真实 SW 语义:Cache Storage 按 url 索引、waitUntil 在响应
 * 返回后才完成、Response.error() 用于网络彻底失败的场景。
 *
 *
 * 复刻的语义点(照真实 SW 规格):
 *   · respondWith 的 Promise 落定 = 该请求的响应
 *   · waitUntil 里的 promise 必须在响应返回**之后**才完成(用于后台更新)
 *   · caches.match 未命中返回 undefined(不是 null)
 *   · Response body 只能读一次 → 复用缓存响应时必须 clone
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sw = readFileSync('public/sw.js', 'utf8');

/** 抠出 ASSETS 清单(与 assets.test.mjs 同一判据,避免两处漂移) */
function assetsFromSw() {
  const block = /const ASSETS = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(block, 'sw.js 里应当有 const ASSETS = [...]');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const ASSETS = assetsFromSw();

const start = sw.indexOf("self.addEventListener('fetch'");
const end = sw.lastIndexOf('});') + 3;
if (start < 0) throw new Error('sw.js 里找不到 fetch 监听器');
const fetchSrc = sw.slice(start, end);
/** OFFLINE_API_GET 定义在 fetch 监听器**之外** —— 沙箱只拼 fetchSrc + navSrc 是不够的,
 *  handler 一引用它就 ReferenceError(2026-10-11 实测:5 条用例齐刷刷假红,看着像功能没做)。
 *  把它的声明原样抠出来一起注入沙箱。 */
const offlineDecl = /const OFFLINE_API_GET = [^\n]+;/.exec(sw);
assert.ok(offlineDecl, 'sw.js 必须声明 OFFLINE_API_GET 白名单');
const navSrc = sw.slice(sw.indexOf('function navFallback'), sw.indexOf("self.addEventListener('fetch'"));

/** 在沙箱里搭一套最小 SW 运行时 */
function makeRuntime({ online = true, seed = {} } = {}) {
  const store = new Map(Object.entries(seed));
  const pending = [];
  let networkHits = 0;
  const served = [];

  const Response_ = class {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.type = init.type ?? 'basic'; }
    /* ★ 真实 Response 有 clone(),而且**必须有** —— sw.js 回写缓存用的就是 res.clone()
     *  (响应体只能读一次)。替身漏掉它时,那次 `.catch(() => {})` 会把 TypeError 静默吞掉,
     *  表现是「缓存永远写不进去」;只有断言了 Cache Storage 的用例才抓得到。
     *  (2026-10-11 实际踩到:只断言响应体的老用例全绿放过。) */
    clone() { return new Response_(this.body, { status: this.status, type: this.type }); }
    /* ★ 真实 Response 的 ok 是「200 ≤ status < 300」的 getter,替身也必须有 ——
     *  sw.js 回写缓存前判的是 `res && res.ok && res.type === 'basic'`,
     *  替身漏掉 ok 时它就恒为 undefined,回写分支永不进入,
     *  表现同样是「缓存永远写不进去」(与漏 clone 是同一类假绿,2026-10-11 连着踩到)。 */
    get ok() { return this.status >= 200 && this.status < 300; }
    // 真实 Response 有这个静态方法:网络彻底失败时用它返回一个网络错误响应
    static error() { const r = new Response_(null, { status: 0, type: 'error' }); return r; }
  };
  const CACHE_NAME = 'jmbiji-test';
  // 真实 Cache Storage 的 key 是 Request 对象,但内部按 (url, method, vary) 索引。
  // 替身统一用 url 字符串作 key —— 否则 seed 命中不了,测出来的「未命中」是假象。
  const keyOf = (r) => (typeof r === 'string' ? r : r?.url);
  const caches = {
    open: async (name) => ({
      put: (req, res) => { store.set(keyOf(req), res); },
      addAll: async () => {},
    }),
    match: async (req) => store.get(keyOf(req)),
    keys: async () => [CACHE_NAME],
    delete: async () => true,
  };
  const scope = {
    URL,
    caches,
    console,
    Response: Response_,
    // listeners 必须建在沙箱内(sw.js 里的 self.addEventListener 要往它上面挂)
    listeners: {},
    fetch: async (req) => {
      networkHits++;
      if (!online) throw new TypeError('Failed to fetch');
      // sw.js 里是 fetch(e.request) —— 传进来的是 Request 对象,取其 url
      const url = typeof req === 'string' ? req : req?.url;
      return new Response_('network:' + url, { status: 200 });
    },
  };
  scope.self = {
    location: { origin: 'https://x.test' },
    addEventListener: (t, fn) => { scope.listeners[t] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const keys = Object.keys(scope);
  const vals = keys.map((k) => scope[k]);
  const fn = new Function(...keys, 'CACHE', offlineDecl[0] + '\n' + fetchSrc + '\n' + navSrc);
  fn(...vals, CACHE_NAME);
  const L = scope.listeners;

  return {
    cache: L, CACHE_NAME, store,
    hits: () => networkHits,
    served,
    /** 派发一个 fetch 事件,返回「响应 + 后台任务是否已完成」 */
    async dispatch(req, { wait = true } = {}) {
      const events = [];
      const e = {
        request: { url: req, method: 'GET', mode: 'basic' },
        respondWith: (p) => { events.push(p); },
        waitUntil: (p) => { pending.push(p); },
      };
      L.fetch(e);
      if (!events.length) return { sw: false, res: null };
      const res = await events[0];
      const before = pending.length;
      if (wait) await Promise.allSettled(pending.splice(0, before));
      this.served.push(res.body);
      return { sw: true, res };
    },
  };
}

/* ---------- 静态资源:stale-while-revalidate ---------- */

test('SWR:命中缓存时**不等网络**就返回(一个 tick 内 resolve)', async () => {
  const rt = makeRuntime({ online: true, seed: { 'https://x.test/js/main.js': { body: 'cached-js', status: 200, type: 'basic' } } });
  const h0 = rt.hits();
  const events = [];
  const e = {
    request: { url: 'https://x.test/js/main.js', method: 'GET', mode: 'basic' },
    respondWith: (p) => events.push(p),
    waitUntil: () => {},
  };
  rt.cache.fetch(e);
  const p = events[0];
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  /* 若实现退回「先 await 网络再决定用不用缓存」,这里 settled 仍是 false。
   * 这条断言是 SWR 全部收益的来源:首屏 20 个模块少等 20 个 RTT。 */
  assert.ok(settled, '命中缓存却仍在等网络 —— SWR 没生效,首屏照旧每次回源');
  const res = await p;
  assert.equal(res.body, 'cached-js', '必须返回缓存内容而不是网络内容');
  assert.equal(rt.hits(), h0 + 1, '后台应恰好发 1 次刷新请求(不阻塞响应)');
});

test('SWR:未命中缓存时回源网络', async () => {
  const rt = makeRuntime({ online: true });
  const r = await rt.dispatch('https://x.test/js/lazy.js');
  assert.equal(r.res.body, 'network:https://x.test/js/lazy.js');
});

test('SWR:离线且有缓存仍可用(离线能力不丢)', async () => {
  const rt = makeRuntime({ online: false, seed: { 'https://x.test/css/style.css': { body: 'cached-css', status: 200, type: 'basic' } } });
  const r = await rt.dispatch('https://x.test/css/style.css');
  assert.equal(r.res.body, 'cached-css', '离线时必须能用缓存兜底');
});

test('离线且无缓存:给网络错误响应,不得静默 undefined', async () => {
  const rt = makeRuntime({ online: false });
  const r = await rt.dispatch('https://x.test/js/gone.js');
  /* Response.error() 才是正确行为(浏览器呈现网络错误);
   * 反例是返回 undefined —— 那会让 respondWith 抛 TypeError,表现同样是空白。 */
  assert.ok(r.res && r.res.status === 0 && r.res.type === 'error',
    '离线无缓存时应给 status=0 的网络错误响应,实际 ' + JSON.stringify(r.res));
});

/* ---------- 导航请求:必须保持 network-first ---------- */

test('导航请求保持 network-first(刷新即最新版这条语义不能丢)', async () => {
  const rt = makeRuntime({ online: true, seed: { 'https://x.test/index.html': { body: 'cached-html', status: 200, type: 'basic' } } });
  const events = [];
  const e = {
    request: { url: 'https://x.test/index.html', method: 'GET', mode: 'navigate' },
    respondWith: (p) => events.push(p),
    waitUntil: () => {},
  };
  rt.cache.fetch(e);
  const res = await events[0];
  /* 命中了缓存也不能用:入口页必须拿网络版本,否则部署后仍是旧外壳。
   * 静态资源可以 SWR(内容是纯代码,新旧混用不崩),HTML 不行。 */
  assert.equal(res.body, 'network:https://x.test/index.html',
    '导航请求拿到了缓存的旧外壳 —— 部署后界面不会更新');
});

/* ---------- 硬护栏:绕过 SW 的四条 ---------- */

/* ---------- 只读密文接口:离线可读的支点(2026-10-11 起) ----------
 * 旧口径是「/api/* 一律不经 SW」,但它把两件事混为一谈:缓存里存的是**密文**
 * (没有主密码解不开),而且同样一份密文本来就躺在 R2 上;真正会让锁屏失效的是**明文**副本。
 * 现在放行三个只读密文接口换「断网也能打开笔记」。代价与威胁等级见 sw.js 顶部注释
 * 与 SECURITY.md「缓存泄露」条 —— 锁定不清除这份副本。 */

test('只读密文接口 GET 时由 SW 接管(离线才有得读)', () => {
  const rt = makeRuntime({ online: true });
  const urls = [
    'https://x.test/api/vault',
    'https://x.test/api/cats',
    'https://x.test/api/cat?key=%E7%A7%98%E9%92%A5',
  ];
  for (const u of urls) {
    const events = [];
    rt.cache.fetch({ request: { url: u, method: 'GET', mode: 'cors' }, respondWith: (p) => events.push(p), waitUntil: () => {} });
    assert.equal(events.length, 1, u + ' 必须由 SW 接管 —— 否则断网时 boot 第一步就卡死在锁屏');
  }
});

test('只读密文接口:在线取网络版并顺手更新本地副本', async () => {
  const rt = makeRuntime({ online: true });
  const r = await rt.dispatch('https://x.test/api/vault');
  assert.equal(r.res.body, 'network:https://x.test/api/vault', '在线必须给网络版,不能拿旧副本糊弄');
  assert.ok(rt.store.has('https://x.test/api/vault'),
    '成功响应必须写进缓存,供下次离线回退(实际缓存键:' + [...rt.store.keys()].join(' | ') + ')');
});

test('只读密文接口:离线时回退上次的副本(离线可读的核心)', async () => {
  const rt = makeRuntime({ online: false, seed: { 'https://x.test/api/vault': { body: 'CACHED-CIPHERTEXT', status: 200, type: 'basic' } } });
  const r = await rt.dispatch('https://x.test/api/vault');
  assert.equal(r.res.body, 'CACHED-CIPHERTEXT', '离线必须回退缓存副本,否则私密笔记在飞机/地铁上等于废掉');
});

test('只读密文接口:离线且无副本时给网络错误响应(不得静默 undefined)', async () => {
  const rt = makeRuntime({ online: false });
  const r = await rt.dispatch('https://x.test/api/vault');
  assert.ok(r.res && r.res.status === 0 && r.res.type === 'error', '离线无副本应给 Response.error()');
});

test('白名单外的 /api/* 一律不经 SW(附件、健康检查等不落缓存)', () => {
  const rt = makeRuntime({ online: true });
  const urls = [
    'https://x.test/api/blobs',
    'https://x.test/api/blob?key=x',
    'https://x.test/api/catx',
  ];
  for (const u of urls) {
    const events = [];
    rt.cache.fetch({ request: { url: u, method: 'GET', mode: 'cors' }, respondWith: (p) => events.push(p), waitUntil: () => {} });
    assert.equal(events.length, 0, u + ' 不在离线白名单里,不得由 SW 接管');
  }
});

test('/api/* 的 POST 不经 SW(POST 是为拿令牌,绝不能落缓存)', () => {
  const rt = makeRuntime({ online: true });
  const events = [];
  rt.cache.fetch({ request: { url: 'https://x.test/api/vault', method: 'POST', mode: 'cors' }, respondWith: (p) => events.push(p), waitUntil: () => {} });
  assert.equal(events.length, 0, '写/鉴权请求被 SW 接管了 —— 离线的旧副本可能被当成成功');
});

test('跨域 GET 不经 SW', () => {
  const rt = makeRuntime({ online: true });
  const events = [];
  rt.cache.fetch({ request: { url: 'https://cdn.other/x.js', method: 'GET', mode: 'no-cors' }, respondWith: (p) => events.push(p), waitUntil: () => {} });
  assert.equal(events.length, 0, '跨域请求被接管:离线时会以 undefined 响应并把原生网络错误换成 SW 异常');
});

test('非 GET 不经 SW', () => {
  const rt = makeRuntime({ online: true });
  const events = [];
  rt.cache.fetch({ request: { url: 'https://x.test/api/vault', method: 'PUT', mode: 'cors' }, respondWith: (p) => events.push(p), waitUntil: () => {} });
  assert.equal(events.length, 0, '非 GET 请求被接管');
});

test('ASSETS 清单里不得出现 /api/(防止有人往里加)', () => {
  const api = ASSETS.filter((a) => a.includes('/api/'));
  assert.deepEqual(api, [], 'ASSETS 含 API 路径:' + api.join(', '));
});