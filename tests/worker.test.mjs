/* Worker 单测:内存 mock R2,覆盖鉴权 / CAS / 建库守卫 / 备份轮换 / 大小上限 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi, declaredTooLarge, missingDeclaredLength, MAX_REQUEST_BYTES } from '../worker/worker.js';
import { MemoryR2 } from '../worker/memory-r2.mjs';
import { createVault } from '../public/js/vaultlib.js';

/* 沙箱环境噪音过滤:Node 的 Headers/Response 会触发一次内部惰性 WASM 实例化,
 * 在 RLIMIT_AS 受限的沙箱里该后台实例化必然失败并抛 unhandledRejection
 * (功能本身不受影响)。只吞掉这一条已知信息,其余照常上抛。 */
process.on('unhandledRejection', (e) => {
  if (e instanceof RangeError && /WebAssembly\.instantiate/.test(e.message)) return;
  throw e;
});

const ITER = 1000;

/** 默认环境走「显式放弃访问密钥门」的开放模式(ALLOW_NO_ACCESS_KEY=1),
 *  与既有用例保持一致;门自身的 fail closed 行为由末尾专门用例覆盖。 */
const newEnv = () => ({ VAULT: new MemoryR2(), ALLOW_NO_ACCESS_KEY: '1' });

/** 访问密钥 ≥16 字符才算合格(短于它服务端直接 503,见专用用例) */
const GOOD_KEY = 'test-access-key-0123456789';

const te = new TextEncoder();

/** 纯函数核心的返回值 → fetch 风格响应对象(不构造 Request/Response/Headers,
 * 沙箱与任意 Node 环境零噪音)。headers 键全小写。 */
function toRes(out) {
  const raw = out.body;
  return {
    status: out.status,
    headers: { get: (k) => (out.headers[k.toLowerCase()] ?? null) },
    json: async () => JSON.parse(raw),
    arrayBuffer: async () => (raw instanceof Uint8Array ? raw.slice().buffer : te.encode(String(raw ?? '')).buffer),
  };
}

const call = async (env, method, path, { body = null, headers = {} } = {}) => {
  const b = body == null ? null : (typeof body === 'string' ? te.encode(body) : body);
  const out = await handleApi(method, `http://localhost${path}`, headers, b, env);
  return toRes(out);
};

/** 建好库并返回 {env, token, vaultJson} */
async function setup() {
  const env = newEnv();
  const { json, authKeyHex } = await createVault('测试密码abc', ITER);
  const res = await call(env, 'PUT', '/api/vault', { body: JSON.stringify(json) });
  assert.equal(res.status, 201);
  return { env, token: authKeyHex, json };
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

/* ---------- 建库与鉴权 ---------- */

test('未建库:GET vault 404;带任意令牌访问受保护接口 401', async () => {
  const env = newEnv();
  assert.equal((await call(env, 'GET', '/api/vault')).status, 404);
  assert.equal((await call(env, 'GET', '/api/cats', { headers: auth('f'.repeat(64)) })).status, 401);
  assert.equal((await call(env, 'GET', '/api/cats', {})).status, 401);
});

test('建库只允许一次:二次 PUT → 409;非法结构 → 400', async () => {
  const env = newEnv();
  const { json } = await createVault('pw-test-1', ITER);
  const body = JSON.stringify(json);
  assert.equal((await call(env, 'PUT', '/api/vault', { body })).status, 201);
  assert.equal((await call(env, 'PUT', '/api/vault', { body })).status, 409);
  // 结构不合法:缺 auth.hash / 魔数不对 / 非 JSON
  const noAuth = { ...json, auth: undefined };
  assert.equal((await call(env, 'PUT', '/api/vault', { body: JSON.stringify(noAuth) })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/vault', { body: '{"x":1}' })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/vault', { body: 'not json' })).status, 400);
});

test('正确令牌通过鉴权;令牌哈希与 vault.json 的 auth.hash 一致才放行', async () => {
  const { env, token } = await setup();
  const res = await call(env, 'GET', '/api/cats', { headers: auth(token) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).cats, []);
  // 改一位令牌 → 401
  const bad = (token[0] === '0' ? '1' : '0') + token.slice(1);
  assert.equal((await call(env, 'GET', '/api/cats', { headers: auth(bad) })).status, 401);
});

/* ---------- 防爆破限流 ----------
 * ★ 回归要点:限流计数器曾挂在 env 上。env 是请求级对象,生产环境每个请求都是
 *   新的 env → 计数每请求清零 → 15 次阈值永远到不了 → 限流**完全失效**,
 *   而旧用例因为复用同一个 env 对象,一直是绿的(假绿)。
 *   下面的用例刻意「每次请求都新建 env」,与生产语义一致。 */

/** 建库并返回「每次调用都产出新 env 对象」的工厂(r2 是共享的) */
async function setupPerRequest(password) {
  const r2 = new MemoryR2();
  const envOf = () => ({ VAULT: r2, ALLOW_NO_ACCESS_KEY: '1' });
  const { json, authKeyHex } = await createVault(password, ITER);
  const res = await call(envOf(), 'PUT', '/api/vault', { body: JSON.stringify(json) });
  assert.equal(res.status, 201);
  return { r2, envOf, token: authKeyHex };
}

test('限流:每请求一个新 env(生产语义)下依然生效,并带 retry-after', async () => {
  const { envOf, token } = await setupPerRequest('pw-ratelimit');
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  const bad = { authorization: `Bearer ${'f'.repeat(64)}`, ...ip };

  for (let i = 1; i <= 15; i++) {
    assert.equal((await call(envOf(), 'GET', '/api/cats', { headers: bad })).status, 401, `第 ${i} 次应为 401`);
  }
  const blocked = await call(envOf(), 'GET', '/api/cats', { headers: bad });
  assert.equal(blocked.status, 429, '第 16 次必须被限流(修复前这里恒为 401)');
  assert.equal(blocked.headers.get('retry-after'), '600');
  // 封锁期内正确令牌同样被挡(避免「边爆破边正常用」)
  assert.equal((await call(envOf(), 'GET', '/api/cats', { headers: { authorization: `Bearer ${token}`, ...ip } })).status, 429);
});

test('限流:动作成功即清零计数,不会「攒够 15 次才封」', async () => {
  const { envOf, token } = await setupPerRequest('pw-ratelimit-clear');
  const ip = { 'cf-connecting-ip': '198.51.100.11' };
  const bad = { authorization: `Bearer ${'e'.repeat(64)}`, ...ip };
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 10; i++) await call(envOf(), 'GET', '/api/cats', { headers: bad });
    assert.equal((await call(envOf(), 'GET', '/api/cats', { headers: { authorization: `Bearer ${token}`, ...ip } })).status, 200);
  }
});

test('限流:不带任何凭据的探测不计数(跨站借受害者 IP 刷满失败预算无效)', async () => {
  // 两道门各测一遍 —— 「带凭据才计数」这条判据在两条分支上都要成立。
  // 跨站页面只能发出不带自定义头的简单请求(带 x-access-key / authorization
  // 会触发 CORS 预检,而本服务不返回任何 CORS 头 → 预检必败)。

  /* 路径一:访问密钥门(带门环境,请求不带 x-access-key) */
  const r2a = new MemoryR2();
  const envA = () => ({ VAULT: r2a, ACCESS_KEY: GOOD_KEY });
  const { json } = await createVault('pw-noauth', ITER);
  await call(envA(), 'PUT', '/api/vault', { body: JSON.stringify(json), headers: { 'x-access-key': GOOD_KEY } });
  const ipA = { 'cf-connecting-ip': '198.51.100.8' };
  for (let i = 1; i <= 40; i++) {
    assert.equal((await call(envA(), 'GET', '/api/cats', { headers: { ...ipA } })).status, 401, `密钥门:第 ${i} 次应为 401 而非 429`);
  }
  // 而「带着错误密钥来试」要计数:15 次后必须封
  const guess = { 'x-access-key': 'wrong-key-0123456789', ...ipA };
  for (let i = 1; i <= 15; i++) await call(envA(), 'GET', '/api/cats', { headers: guess });
  assert.equal((await call(envA(), 'GET', '/api/cats', { headers: guess })).status, 429);

  /* 路径二:令牌门(开门环境,请求不带 authorization) */
  const { envOf } = await setupPerRequest('pw-noauth-token');
  const ipB = { 'cf-connecting-ip': '198.51.100.13' };
  for (let i = 1; i <= 40; i++) {
    assert.equal((await call(envOf(), 'GET', '/api/cats', { headers: { ...ipB } })).status, 401, `令牌门:第 ${i} 次应为 401 而非 429`);
  }
  const guess2 = { authorization: `Bearer ${'c'.repeat(64)}`, ...ipB };
  for (let i = 1; i <= 15; i++) await call(envOf(), 'GET', '/api/cats', { headers: guess2 });
  assert.equal((await call(envOf(), 'GET', '/api/cats', { headers: guess2 })).status, 429);
});

/* ---------- 访问密钥门:fail closed ---------- */

test('访问密钥门:未配置 → 503 setup-required,连 vault.json 都不给', async () => {
  const env = { VAULT: new MemoryR2() }; // 刻意不设 ACCESS_KEY,也不放弃
  const { json } = await createVault('pw-gate', ITER);
  const res = await call(env, 'PUT', '/api/vault', { body: JSON.stringify(json) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'setup-required');
  assert.equal((await call(env, 'GET', '/api/vault')).status, 503);
  assert.equal((await call(env, 'GET', '/api/cats')).status, 503);
});

test('访问密钥门:过短(<16 字符)等同于没门,同样 fail closed', async () => {
  const env = { VAULT: new MemoryR2(), ACCESS_KEY: 'short-key' };
  const res = await call(env, 'GET', '/api/vault');
  assert.equal(res.status, 503);
  assert.match((await res.json()).message, /16/);
});

test('访问密钥门:配置正确时必须带对密钥,错一位即 401', async () => {
  const env = { VAULT: new MemoryR2(), ACCESS_KEY: GOOD_KEY };
  const { json, authKeyHex } = await createVault('pw-gate2', ITER);
  assert.equal((await call(env, 'GET', '/api/vault')).status, 401);
  assert.equal((await call(env, 'GET', '/api/vault', { headers: { 'x-access-key': GOOD_KEY.slice(0, -1) + 'x' } })).status, 401, '只错最后一位必须被拒');
  assert.equal((await call(env, 'GET', '/api/vault', { headers: { 'x-access-key': GOOD_KEY[0] + GOOD_KEY.slice(2) } })).status, 401, '只错第一位必须被拒');
  // 长度不同也走同一条路径:两侧先各取定长 SHA-256 摘要再比,长度不参与判断
  assert.equal((await call(env, 'GET', '/api/vault', { headers: { 'x-access-key': `${GOOD_KEY}x` } })).status, 401);
  assert.equal((await call(env, 'GET', '/api/vault', { headers: { 'x-access-key': '' } })).status, 401);
  assert.equal((await call(env, 'PUT', '/api/vault', { body: JSON.stringify(json), headers: { 'x-access-key': GOOD_KEY } })).status, 201);
  assert.equal((await call(env, 'GET', '/api/cats', {
    headers: { 'x-access-key': GOOD_KEY, authorization: `Bearer ${authKeyHex}` },
  })).status, 200);
});

test('跨站预检:OPTIONS 一律 405(不是 404),且任何响应都不带 CORS 允许头', async () => {
  const env = newEnv();
  // 必须是 405 而不是落到「未知接口」的 404:说明存在显式的预检处理,
  // 而不是「碰巧没有这条路由」。
  for (const p of ['/api/vault', '/api/cats', '/api/cat?key=x', '/api/blobs', '/api/blob?key=y']) {
    const res = await call(env, 'OPTIONS', p);
    assert.equal(res.status, 405, `${p} 的 OPTIONS 应为 405`);
    assert.equal((await res.json()).error, 'method');
  }
  for (const h of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods']) {
    assert.equal((await call(env, 'OPTIONS', '/api/vault')).headers.get(h), null, `不得出现 ${h}`);
  }
  assert.equal((await call(env, 'GET', '/api/vault')).headers.get('access-control-allow-origin'), null);
});

test('所有 API 响应都带硬化头(nosniff / no-store / CSP)', async () => {
  const { env, token } = await setup();
  const pairs = [
    await call(env, 'GET', '/api/vault'),
    await call(env, 'GET', '/api/cats', { headers: auth(token) }),
  ];
  for (const res of pairs) {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  }
  // 二进制响应(密文)同样带
  await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('头')}`, { body: new Uint8Array([1]), headers: { ...auth(token), 'if-none-match': '*' } });
  const bin = await call(env, 'GET', `/api/cat?key=${encodeURIComponent('头')}`, { headers: auth(token) });
  assert.equal(bin.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(bin.status, 200);
});

test('列表翻页:对象数超过单页上限时不会只拿到前 1000 个', async () => {
  const env = { VAULT: new MemoryR2({ pageSize: 3 }), ALLOW_NO_ACCESS_KEY: '1' };
  const { json, authKeyHex } = await createVault('pw-page', ITER);
  await call(env, 'PUT', '/api/vault', { body: JSON.stringify(json) });
  const h = auth(authKeyHex);
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  for (const n of names) {
    await call(env, 'PUT', `/api/cat?key=${n}`, { body: new Uint8Array([1]), headers: { ...h, 'if-none-match': '*' } });
  }
  const cats = (await (await call(env, 'GET', '/api/cats', { headers: h })).json()).cats;
  assert.deepEqual(cats.map((c) => c.name).sort(), names);

  const blob = 'z'.repeat(43) + '.png';
  for (const n of [blob, 'y'.repeat(43) + '.png', 'x'.repeat(43) + '.png', 'w'.repeat(43) + '.png']) {
    await call(env, 'PUT', `/api/blob?key=${n}`, { body: new Uint8Array([1]), headers: h });
  }
  assert.equal((await (await call(env, 'GET', '/api/blobs', { headers: h })).json()).names.length, 4);
});

/* /api/blobs 同时回 names 与带体积的 blobs:
 * 前者是向后兼容(既有调用方在用),后者是「全库导出」用来先提示体积的。 */
test('附件清单:names 与带体积的 blobs 必须一致且 size 真实', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  const names = ['a'.repeat(43) + '.png', 'b'.repeat(43) + '.png'];
  for (const n of names) {
    await call(env, 'PUT', `/api/blob?key=${n}`, { body: new Uint8Array([1, 2, 3]), headers: h });
  }
  const body = (await (await call(env, 'GET', '/api/blobs', { headers: h })).json());
  assert.deepEqual([...body.names].sort(), [...names].sort(), 'names 必须保留(向后兼容)');
  assert.deepEqual(body.blobs.map((b) => b.name).sort(), [...names].sort(), 'blobs 名单必须与 names 一致');
  for (const b of body.blobs) {
    assert.equal(b.size, 3, 'size 必须是对象的真实字节数,否则导出前的体积提示会撒谎');
    assert.ok(Number.isFinite(b.uploaded), 'uploaded 必须是数字时间戳');
  }
});

/* ---------- 可选访问密钥门 ---------- */

test('设置 ACCESS_KEY 后:无密钥 → 401 access-key;带密钥正常', async () => {
  const env = { VAULT: new MemoryR2(), ACCESS_KEY: GOOD_KEY };
  const { json, authKeyHex } = await createVault('pw-acc-key', ITER);
  const body = JSON.stringify(json);

  const noKey = await call(env, 'GET', '/api/vault');
  assert.equal(noKey.status, 401);
  assert.equal((await noKey.json()).error, 'access-key');

  const key = { 'x-access-key': GOOD_KEY };
  assert.equal((await call(env, 'PUT', '/api/vault', { body, headers: key })).status, 201);
  assert.equal((await call(env, 'GET', '/api/vault', { headers: key })).status, 200);
  assert.equal((await call(env, 'GET', '/api/cats', { headers: { ...key, authorization: `Bearer ${authKeyHex}` } })).status, 200);
});

/* ---------- 分类:CRUD + CAS + 备份 ---------- */

test('分类:新建(If-None-Match:*)→ 重复 → 409;非法名 → 400', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  const bytes = new Uint8Array([1, 2, 3]);
  const res = await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('秘钥')}`, {
    body: bytes, headers: { ...h, 'if-none-match': '*' },
  });
  assert.equal(res.status, 201);
  assert.ok((await res.json()).etag);
  assert.equal((await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('秘钥')}`, {
    body: bytes, headers: { ...h, 'if-none-match': '*' },
  })).status, 409);
  assert.equal((await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('a/b')}`, {
    body: bytes, headers: { ...h, 'if-none-match': '*' },
  })).status, 400);
  assert.equal((await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('..')}`, {
    body: bytes, headers: { ...h, 'if-none-match': '*' },
  })).status, 400);
});

test('分类覆盖:无 If-Match → 428;旧 etag → 412;正确 etag → 200,且旧版进备份', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  const put = (body, extra = {}) => call(env, 'PUT', `/api/cat?key=${encodeURIComponent('攻略')}`, {
    body, headers: { ...h, ...extra },
  });
  const first = await put(new Uint8Array([1]), { 'if-none-match': '*' });
  const etag1 = (await first.json()).etag;

  assert.equal((await put(new Uint8Array([2]))).status, 428);
  assert.equal((await put(new Uint8Array([2]), { 'if-match': '"stale"' })).status, 412);

  const second = await put(new Uint8Array([2, 2]), { 'if-match': `"${etag1}"` });
  assert.equal(second.status, 200);
  const etag2 = (await second.json()).etag;
  assert.notEqual(etag2, etag1);

  const got = await call(env, 'GET', `/api/cat?key=${encodeURIComponent('攻略')}`, { headers: h });
  assert.equal(got.status, 200);
  assert.equal((await got.arrayBuffer()).byteLength, 2);
  assert.equal((await call(env, 'GET', `/api/cat?key=${encodeURIComponent('攻略')}`, { headers: h })).headers.get('etag'), `"${etag2}"`);
  assert.equal(env.VAULT.backupCount('攻略'), 1, '覆盖前应备份旧版');
  // 备份名必须带随机后缀:只靠毫秒时间戳,同一毫秒内的多份备份会写同一个键而互相覆盖
  // (实测连续 12 次 Date.now() 返回同一个值)。这条断言是确定性的,不依赖时序。
  const bkeys = (await env.VAULT.list({ prefix: 'backup/攻略/' })).objects.map((o) => o.key);
  assert.match(bkeys[0], /^backup\/攻略\/攻略\.\d{13,}-[0-9a-z]{2,8}\.enc$/, `备份名缺随机后缀:${bkeys[0]}`);
});

test('备份滚动:同一分类反复覆盖,备份保留上限 10 份', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('日志')}`, {
    body: new Uint8Array([0]), headers: { ...h, 'if-none-match': '*' },
  });
  for (let i = 0; i < 12; i++) {
    const cur = await call(env, 'GET', `/api/cat?key=${encodeURIComponent('日志')}`, { headers: h });
    const etag = cur.headers.get('etag');
    await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('日志')}`, {
      body: new Uint8Array([i + 1]), headers: { ...h, 'if-match': etag },
    });
  }
  assert.equal(env.VAULT.backupCount('日志'), 10);
});

test('分类删除:备份后删除,GET → 404', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('临时')}`, {
    body: new Uint8Array([9]), headers: { ...h, 'if-none-match': '*' },
  });
  assert.equal((await call(env, 'DELETE', `/api/cat?key=${encodeURIComponent('临时')}`, { headers: h })).status, 204);
  assert.equal((await call(env, 'GET', `/api/cat?key=${encodeURIComponent('临时')}`, { headers: h })).status, 404);
  assert.equal(env.VAULT.backupCount('临时'), 1, '删除前应备份');
  assert.equal((await call(env, 'DELETE', `/api/cat?key=${encodeURIComponent('不存在')}`, { headers: h })).status, 404);
});

test('分类列表:名称、大小正确返回', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('秘钥')}`, {
    body: new Uint8Array(5), headers: { ...h, 'if-none-match': '*' },
  });
  const cats = (await (await call(env, 'GET', '/api/cats', { headers: h })).json()).cats;
  assert.deepEqual(cats.map((c) => c.name), ['秘钥']);
  assert.equal(cats[0].size, 5);
});

/* ---------- 附件 ---------- */

test('附件:内容寻址入库去重 + 读取 + 非法名拒收 + 清理删除', async () => {
  const { env, token } = await setup();
  const h = auth(token);
  const name = 'a'.repeat(43) + '.png'; // HMAC 32B base64url = 43 字符
  const bytes = new Uint8Array([137, 80, 78, 71]);
  assert.equal((await call(env, 'PUT', `/api/blob?key=${name}`, { body: bytes, headers: h })).status, 201);
  assert.equal((await call(env, 'PUT', `/api/blob?key=${name}`, { body: bytes, headers: h })).status, 200, '同内容再传 → 已存在');
  const got = await call(env, 'GET', `/api/blob?key=${name}`, { headers: h });
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  assert.equal((await call(env, 'PUT', '/api/blob?key=short', { body: bytes, headers: h })).status, 400);
  assert.deepEqual((await (await call(env, 'GET', '/api/blobs', { headers: h })).json()).names, [name]);
  assert.equal((await call(env, 'DELETE', `/api/blob?key=${name}`, { headers: h })).status, 204);
  assert.deepEqual((await (await call(env, 'GET', '/api/blobs', { headers: h })).json()).names, []);
});

/* ---------- 限流以外的大小上限 ---------- */

test('分类超过 30MB → 413', async () => {
  const { env, token } = await setup();
  const big = new Uint8Array(31 * 1024 * 1024);
  const res = await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('大')}`, {
    body: big, headers: { ...auth(token), 'if-none-match': '*' },
  });
  assert.equal(res.status, 413);
});

/* ---------- 适配层预检 ----------
 * 说明:适配层本身要构造真 Request/Response,而受限沙箱里 undici 的惰性 WASM
 * 会必然实例化失败(与本文件顶部的噪音过滤同源),所以端到端那一步无法离线断言;
 * 这里改为直接测「读 body 之前」的那条判据 —— 它才是防内存打爆的关键。 */

test('适配层预检:声明长度超限必须在读取请求体之前就判定为过大', () => {
  const over = String(MAX_REQUEST_BYTES + 1);
  assert.equal(declaredTooLarge(over), true);
  assert.equal(declaredTooLarge(String(200 * 1024 * 1024)), true, '100MB 级 body 必须提前挡下');
  assert.equal(declaredTooLarge(String(MAX_REQUEST_BYTES)), false, '恰好等于是允许的');
  assert.equal(declaredTooLarge(String(1024)), false);
  // 没有 content-length(分块传输)或不是数字 → 交给路由层按实际字节数判断
  assert.equal(declaredTooLarge(null), false);
  assert.equal(declaredTooLarge(undefined), false);
  assert.equal(declaredTooLarge(''), false);
  assert.equal(declaredTooLarge('abc'), false);
});

/* ---------- 改主密码 ---------- */

test('改主密码:authed PUT vault 走 CAS;旧 etag → 412', async () => {
  const { env, token, json } = await setup();
  const h = auth(token);
  const got = await call(env, 'GET', '/api/vault');
  const etag = got.headers.get('etag');
  // 用旧 etag 正常覆盖
  const res = await call(env, 'PUT', '/api/vault', { body: JSON.stringify(json), headers: { ...h, 'if-match': etag } });
  assert.equal(res.status, 200);
  // 再用旧 etag → 412
  const res2 = await call(env, 'PUT', '/api/vault', { body: JSON.stringify(json), headers: { ...h, 'if-match': etag } });
  assert.equal(res2.status, 412);
});

/* ---------- 本轮审计修复的回归:惰性取体 / 条件删除 / 备份容错 ---------- */

test('411:PUT/POST 缺 Content-Length 一律拒收(chunked 绕过预检的口子)', () => {
  assert.equal(missingDeclaredLength('PUT', null), true);
  assert.equal(missingDeclaredLength('PUT', ''), true);
  assert.equal(missingDeclaredLength('PUT', '  '), true);
  assert.equal(missingDeclaredLength('PUT', 'abc'), true);
  assert.equal(missingDeclaredLength('PUT', '123'), false);
  assert.equal(missingDeclaredLength('POST', '0'), false);
  // 无主体的方法不要求声明长度(浏览器对 bodyless DELETE 不带 content-length)
  assert.equal(missingDeclaredLength('DELETE', null), false);
  assert.equal(missingDeclaredLength('GET', null), false);
});

test('惰性取体:鉴权失败时请求体函数绝不能被调用(未认证不得打内存)', async () => {
  const { env } = await setup();
  let reads = 0;
  const res = await call(env, 'PUT', '/api/cat?key=lazy', {
    body: () => { reads += 1; return Promise.resolve(new Uint8Array([1])); },
    headers: auth('f'.repeat(64)), // 错误令牌 → 401
  });
  assert.equal(res.status, 401);
  assert.equal(reads, 0, '鉴权失败路径不得物化请求体(以前进门之前就 arrayBuffer 全量读入)');
});

test('惰性取体:鉴权通过后正常取体入库,往返一致', async () => {
  const { env, token } = await setup();
  const name = `${'A'.repeat(43)}.png`;
  const bytes = new Uint8Array([9, 8, 7]);
  const put = await call(env, 'PUT', `/api/blob?key=${name}`, {
    body: () => Promise.resolve(bytes),
    headers: auth(token),
  });
  assert.equal(put.status, 201);
  const got = await call(env, 'GET', `/api/blob?key=${name}`, { headers: auth(token) });
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
});

test('条件删除:If-Match 不符 → 412 且对象还在;相符 → 204', async () => {
  const { env, token } = await setup();
  const put = await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('测试')}`, {
    body: new Uint8Array([1]), headers: { ...auth(token), 'if-none-match': '*' },
  });
  assert.equal(put.status, 201);
  const etag = (await put.json()).etag;

  const stale = await call(env, 'DELETE', `/api/cat?key=${encodeURIComponent('测试')}`, {
    headers: { ...auth(token), 'if-match': '"stale-etag"' },
  });
  assert.equal(stale.status, 412, '旧 etag 删除必须被拒(否则会把别的设备刚存的新版删掉)');
  assert.equal(
    (await call(env, 'GET', `/api/cat?key=${encodeURIComponent('测试')}`, { headers: auth(token) })).status,
    200,
    '412 之后对象必须还在',
  );

  const ok = await call(env, 'DELETE', `/api/cat?key=${encodeURIComponent('测试')}`, {
    headers: { ...auth(token), 'if-match': `"${etag}"` },
  });
  assert.equal(ok.status, 204);
  assert.equal(
    (await call(env, 'GET', `/api/cat?key=${encodeURIComponent('测试')}`, { headers: auth(token) })).status,
    404,
  );
});

test('备份写失败不连累主保存:主数据 200、后续 CAS 正常(不再 1101 死循环)', async () => {
  const { env, token } = await setup();
  const put1 = await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('测试')}`, {
    body: new Uint8Array([1]), headers: { ...auth(token), 'if-none-match': '*' },
  });
  assert.equal(put1.status, 201);
  const etag1 = (await put1.json()).etag;

  // 换一个「backup/ 前缀写入必炸」的 R2 代理
  const real = env.VAULT;
  env.VAULT = {
    get: real.get.bind(real), head: real.head.bind(real), list: real.list.bind(real), delete: real.delete.bind(real),
    put: async (k, b, o) => {
      if (String(k).startsWith('backup/')) throw new Error('磁盘着火了');
      return real.put(k, b, o);
    },
  };

  const res = await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('测试')}`, {
    body: new Uint8Array([2]), headers: { ...auth(token), 'if-match': `"${etag1}"` },
  });
  assert.equal(res.status, 200, '主数据 CAS 已成功,备份失败绝不能把整个请求拖垮');

  // 且客户端拿到新 etag 后能继续正常保存(以前这里会陷入 412 死循环)
  const etag2 = (await res.json()).etag;
  const res2 = await call(env, 'PUT', `/api/cat?key=${encodeURIComponent('测试')}`, {
    body: new Uint8Array([3]), headers: { ...auth(token), 'if-match': `"${etag2}"` },
  });
  assert.equal(res2.status, 200);
});
