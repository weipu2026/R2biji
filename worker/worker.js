/* ============================================================
 * JMbiji Worker —— 静态资源由 [assets] 自动提供,本文件只处理 /api/*
 *
 * 架构:纯函数核心 handleApi(method, url, headers, body, env)
 *   → 不依赖 Request/Response,Node 离线单测可全覆盖;
 *     default fetch 只做薄适配(Request → 参数,返回值 → Response)。
 *
 * 零依赖(CF Workers 运行时 + Web Crypto)。
 * 备份轮换规则复用前端 format.js 的纯函数(单一出处)。
 *
 * 接口一览(分类/附件名一律走 ?key= 查询参数,避开 URL 路径对
 * %2F 与 .. 的归一化差异):
 *   GET    /api/vault            免鉴权(解锁前置):vault.json + ETag
 *   PUT    /api/vault            建库(免鉴权,If-None-Match:* 仅一次)
 *                               或改主密码(需 Bearer,If-Match CAS)
 *   GET    /api/cats             鉴权:分类清单 [{name,size,uploaded}]
 *   GET    /api/cat?key=名        鉴权:分类密文 + ETag
 *   PUT    /api/cat?key=名        鉴权:If-Match CAS 覆盖(成功后自动备份旧版,
 *                               每分类保留 10 份);If-None-Match:* 仅新建
 *   DELETE /api/cat?key=名        鉴权:备份后删除
 *   GET    /api/blobs            鉴权:附件清单
 *   GET    /api/blob?key=名       鉴权:附件密文
 *   PUT    /api/blob?key=名       鉴权:内容寻址入库(已存在即 200 去重)
 *   DELETE /api/blob?key=名       鉴权:清理未引用附件
 *
 * 鉴权:Authorization: Bearer <hex64> = HKDF(主密码派生的 KEK)。
 * 服务端只存 SHA-256(令牌)(vault.json 的 auth.hash)。
 *
 * env.ACCESS_KEY:所有 /api/* 共用的访问密钥门(值须为 ASCII,≥16 字符)。
 * 它挡住的是最现实的一条路 —— 「拿到网址的人拉走 vault.json 离线爆破主密码」,
 * 因此**未设置或过弱时 fail closed(503)**,不做静默降级。
 * 显式放弃这层门:设环境变量 ALLOW_NO_ACCESS_KEY=1(强烈不推荐)。
 *
 * 跨请求状态一律放模块级:env 是请求级对象,挂在它上面的数据随请求一起丢弃。
 * (限流计数器曾因挂在 env 上而完全失效,回归用例见 tests/worker.test.mjs)
 * ============================================================ */

import { planBackupRotation, backupFileName, KEEP_BACKUPS_PER_CATEGORY } from '../public/js/format.js';

const VAULT_KEY = 'vault.json';
const CAT_PREFIX = 'cats/';
const BLOB_PREFIX = 'blobs/';
const BACKUP_PREFIX = 'backup/';

const MAX_VAULT_BYTES = 16 * 1024;
const MAX_CAT_BYTES = 30 * 1024 * 1024;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;

const AUTH_FAIL_LIMIT = 15;
const AUTH_BLOCK_MS = 10 * 60 * 1000;
const RATE_HEADERS = { 'retry-after': String(Math.ceil(AUTH_BLOCK_MS / 1000)) };

/** 访问密钥最短长度:短于它等于没门(在线可爆破),一律 fail closed */
const MIN_ACCESS_KEY_LEN = 16;
/** 限流表最多跟踪多少个来源 IP,防「海量 IP 撑爆内存」 */
const MAX_TRACKED_IPS = 4096;
/** 适配层读 body 前的预检上限(缓存区之外的宽松余量),超出直接 413 */
export const MAX_REQUEST_BYTES = MAX_BLOB_BYTES + 1024 * 1024;

/* ---------------- 基础工具(返回纯对象,不碰 Response) ---------------- */

/** 所有 API 响应共用的硬化头。CSP 只在「把这个响应当文档直接打开」时生效,
 *  对 fetch 读响应体毫无影响;不设 CORS 头,跨站读不到任何东西。 */
const SEC_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
};

function json(data, status = 200, headers = {}) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...headers }, body: JSON.stringify(data) };
}

function fail(status, code, message, headers = {}) {
  return json({ error: code, message }, status, headers);
}

/** 二进制响应(密文),同样带全套硬化头 */
function binary(body, headers = {}) {
  return { status: 200, headers: { 'content-type': 'application/octet-stream', ...SEC_HEADERS, ...headers }, body };
}

/** 空响应(删除成功等) */
const empty = () => ({ status: 204, headers: { ...SEC_HEADERS }, body: null });

const bytes = (s) => new TextEncoder().encode(s);

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

function bytesFromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** etag 进出 HTTP 头时带引号,内部统一裸值 */
/** etag 归一:剥引号与弱验证器前缀。CF 边缘会对压缩过的 JSON 响应把强 etag 改写成
 * W/"..."(cache 压缩规则),客户端原样带回会让 vault 的 CAS 永远对不上 —— 一律先归一再比。 */
const normEtag = (s) => (s || '').replace(/"/g, '').replace(/^W\//i, '').trim();
const quote = (s) => `"${s}"`;

/** 「仅新建」条件:对象不存在才写入(If-None-Match: * 语义),失败 put() 返回 null。
 * 用纯对象而非 Headers:workerd 对 etagDoesNotMatch='*' 特判为通配符(与
 * If-None-Match: * 等价,见 workerd r2-bucket.c++ buildSingleEtagArray),
 * 且纯函数核心不构造全局对象,Node 单测零环境噪音。 */
function onlyIfNoneMatchStar() {
  return { etagDoesNotMatch: '*' };
}

/* ---------------- vault.json 读取 ---------------- */

/** 读取 vault.json。刻意**不做任何缓存**:
 *  - 挂 `env` 上会重犯「跨请求状态放 env」的错(S1 就是这么栽的);
 *  - 挂模块级则会跨请求变脏 —— 改密码后同一 isolate 还会读到旧哈希,表现为「莫名 401」。
 *  代价是每请求至多多读一次 R2,换来的是「不存在缓存失效这一类 bug」。 */
async function loadVault(env) {
  const raw = await env.VAULT.get(VAULT_KEY);
  if (!raw) return null;
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(await raw.arrayBuffer());
  return { json: JSON.parse(new TextDecoder().decode(buf)), etag: normEtag(raw.etag) };
}

/** 列全前缀下的对象。真机 R2 单次最多返回 1000 个键并给游标,
 *  不分页会让第 1001 个之后的对象在界面上「凭空消失」。 */
async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    objects.push(...res.objects);
    if (!res.truncated) break;
    cursor = res.cursor;
  }
  if (cursor) {
    // 循环跑满 50 页仍有游标 = 后面还有对象被截断。个人库到不了 5 万个对象,
    // 但真到了必须出声 —— 静默截断会让「备份明明存在却看不到」无从诊断
    console.warn(`listAll: ${prefix} 达到 50 页上限,仅返回前 ${objects.length} 个对象,其余被截断`);
  }
  return objects;
}

/* ---------------- 访问控制 ---------------- */

/** 限流表必须放模块级:env 是请求级对象(CF 文档:绑定按 per-request 应用),
 *  挂在 env 上等于每个请求都从零开始 —— 计数永远到不了阈值,限流形同虚设。
 *  放模块级后,同一 isolate 内的多个请求共享它(冷启动/多机房重置,属尽力而为)。 */
const authFails = new Map(); // ip → { n, until }

function isRateBlocked(ip) {
  const rec = authFails.get(ip);
  return !!(rec && rec.until > Date.now());
}

/**
 * 记一次失败。只统计「带着凭据来试」的失败:
 * 跨站页面能发起的只有不带自定义头的简单请求(带 Authorization / X-Access-Key
 * 会触发 CORS 预检,而本服务不返回任何 CORS 头 → 预检必败、真实请求发不出去),
 * 因此该判据同时挡住了「借受害者 IP 刷满失败预算」这条跨站锁死路径。
 */
function recordAuthFail(ip, attempted) {
  if (!attempted) return;
  const rec = authFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= AUTH_FAIL_LIMIT) { rec.until = Date.now() + AUTH_BLOCK_MS; rec.n = 0; }
  authFails.delete(ip); // 重新插入到尾部 = 最近使用,便于按序淘汰
  authFails.set(ip, rec);

  if (authFails.size > MAX_TRACKED_IPS) {
    const now = Date.now();
    for (const [k, v] of authFails) {
      if (authFails.size <= MAX_TRACKED_IPS) break;
      if (v.until <= now) authFails.delete(k); // 优先淘汰封锁已结束的
    }
    while (authFails.size > MAX_TRACKED_IPS) authFails.delete(authFails.keys().next().value);
  }
}

function clearAuthFail(ip) { authFails.delete(ip); }

/** 访问密钥门的配置状态。未配置 / 过短 → fail closed(不静默放行)。 */
function accessKeyGate(env) {
  if (env.ALLOW_NO_ACCESS_KEY === '1') return { open: true };
  const k = typeof env.ACCESS_KEY === 'string' ? env.ACCESS_KEY : '';
  if (!k) return { open: false, reason: 'unset' };
  if (k.length < MIN_ACCESS_KEY_LEN) return { open: false, reason: 'weak' };
  return { open: false, key: k };
}

/** 定长比较:长度不等直接 false;等长则逐字节异或累加,不提前返回。 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 访问密钥比较:两侧各取 SHA-256 再比定长摘要 —— 既不泄露密钥长度,也不短路比较。 */
async function accessKeyMatches(given, expected) {
  return timingSafeEqual(await sha256Hex(bytes(given)), await sha256Hex(bytes(expected)));
}

/** Bearer 令牌校验:sha256(令牌原始字节) === vault.auth.hash */
async function authOk(headers, env) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(headers.authorization || '');
  if (!m) return false;
  const v = await loadVault(env);
  if (!v || !v.json.auth || !/^[0-9a-f]{64}$/.test(v.json.auth.hash)) return false;
  return timingSafeEqual(await sha256Hex(bytesFromHex(m[1])), v.json.auth.hash);
}

/* ---------------- 名称校验 ---------------- */

/** 分类名:非空、无路径分隔符、≤100 字符。返回合法名或 null */
function validCatName(raw) {
  if (!raw || raw === '.' || raw === '..' || raw.length > 100) return null;
  if (/[/\\]/.test(raw) || /[\u0000-\u001f]/.test(raw)) return null;
  return raw;
}

/** 附件名:HMAC(32B) 的 base64url(43 字符)+ 可选扩展名(≤12 字符) */
const BLOB_NAME_RE = /^[A-Za-z0-9_-]{43}(\.[A-Za-z0-9]{1,12})?$/;

/* ---------------- 备份(保留最近 KEEP_BACKUPS_PER_CATEGORY 份) ---------------- */

/** 6 位十六进制随机后缀:同一毫秒内的多次备份不会互相覆盖 */
function shortRand() {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(3))) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 写入一份备份并滚动轮换。oldBytes 由调用方在覆盖/删除前读好。
 *  ★ 备份是尽力而为的安全层,失败**绝不连累主操作**:主数据 CAS 已成功,
 *    这里若把异常抛上去,客户端会拿着请求失败前的旧 etag 反复重试 →
 *    每次都撞 412,陷入「保存成功却报错」的死循环(上层还只会看到裸错误页)。
 *    所以失败只记日志,主流程照常返回成功。 */
async function writeBackup(env, backupBase, oldBytes) {
  try {
    const basePrefix = `${BACKUP_PREFIX}${backupBase}/`;
    await env.VAULT.put(`${basePrefix}${backupFileName(backupBase, Date.now(), shortRand())}`, oldBytes);
    const names = (await listAll(env.VAULT, basePrefix)).map((o) => o.key.slice(basePrefix.length));
    for (const fname of planBackupRotation(names, KEEP_BACKUPS_PER_CATEGORY)) {
      try { await env.VAULT.delete(basePrefix + fname); } catch { /* 轮换失败可容忍 */ }
    }
  } catch (e) {
    console.error(`[jmbiji] 写备份失败(${backupBase}),主数据不受影响:`, e);
  }
}

/* ---------------- 路由处理 ---------------- */

/** body 可能是「惰性取体」函数(见 handleApiRequest):在鉴权门之前绝不物化,
 *  未认证的大请求体不再进 isolate 内存。纯字节入参(测试/dev 直连)原样返回。 */
async function bodyBytes(body) {
  return typeof body === 'function' ? body() : body;
}

async function putCategory(method, headers, body, env, name) {
  if (method !== 'PUT') return fail(405, 'method', '不支持的请求方法');
  const raw = await bodyBytes(body);
  if (!raw || raw.length > MAX_CAT_BYTES) return fail(413, 'too-large', `分类文件上限 ${MAX_CAT_BYTES / 1024 / 1024}MB`);
  const r2key = `${CAT_PREFIX}${name}.enc`;

  const createOnly = (headers['if-none-match'] || '').trim() === '*';
  const ifMatch = normEtag(headers['if-match']);

  if (createOnly) {
    // 「仅新建」用官方条件写:R2PutOptions.onlyIf 支持 Headers,按 RFC 7232
    // 语义处理 If-None-Match: *(对象不存在才写入);条件失败 put() 返回 null。
    // ⚠️ 只能走 onlyIf —— 传不存在的选项名会被静默忽略(等于无条件写)。
    const res = await env.VAULT.put(r2key, raw, { onlyIf: onlyIfNoneMatchStar() });
    if (!res) return fail(409, 'exists', '分类已存在');
    return json({ ok: true, etag: res.etag }, 201);
  }

  if (!ifMatch) return fail(428, 'need-if-match', '缺少 If-Match(条件写,防多端互相覆盖)');
  const current = await env.VAULT.get(r2key);
  if (!current) return fail(404, 'missing', '分类已被其他设备删除');
  const oldBytes = current instanceof Uint8Array ? current : new Uint8Array(await current.arrayBuffer());
  const res = await env.VAULT.put(r2key, raw, { onlyIf: { etagMatches: ifMatch } });
  if (!res) return fail(412, 'conflict', '服务器上的版本已变化(其他设备刚保存),请刷新后重试');
  // CAS 成功 → 立即备份被替换的旧版(拒绝写入不产生备份)
  await writeBackup(env, name, oldBytes);
  return json({ ok: true, etag: res.etag });
}

async function deleteCategory(headers, env, name) {
  const r2key = `${CAT_PREFIX}${name}.enc`;
  const existing = await env.VAULT.head(r2key);
  if (!existing) return fail(404, 'missing', '分类不存在');
  // 条件删除:带 If-Match 时与 head 比对,不符 → 412。此前删除无任何条件,
  // 设备 A 的删除(或改名的删除半程)会把设备 B 刚保存的新版一并删掉。
  // R2 的 delete 不支持条件参数,head 比对是纯函数核心能做的最强校验。
  const ifMatch = normEtag(headers['if-match']);
  if (ifMatch && existing.etag !== ifMatch) {
    return fail(412, 'conflict', '分类刚被其他设备修改,请重新打开后再删除');
  }
  const old = await env.VAULT.get(r2key);
  if (old) {
    const oldBytes = old instanceof Uint8Array ? old : new Uint8Array(await old.arrayBuffer());
    await writeBackup(env, name, oldBytes);
  }
  // delete 前最后核对一次版本:上面 head→get→backup 之间仍可能被并发写插空,
  // 这次比对把竞态窗口压缩到最后一步(R2 的 delete 不支持条件参数,这是极限)
  if (ifMatch) {
    const latest = await env.VAULT.head(r2key);
    if (latest && latest.etag !== ifMatch) {
      return fail(412, 'conflict', '分类刚被其他设备修改,请重新打开后再删除');
    }
  }
  await env.VAULT.delete(r2key);
  return empty();
}

/* ---------------- 纯函数核心 ---------------- */

/**
 * @param {string} method
 * @param {string} url 完整 URL(用 URL 解析查询参数)
 * @param {Record<string,string>} headers 全小写键名
 * @param {Uint8Array|null|(() => Promise<Uint8Array|null>)} body 字节,或惰性取体函数(鉴权通过后才物化)
 * @param {object} env { VAULT: R2 绑定, ACCESS_KEY?: string }
 * @returns {{status:number, headers:object, body:Uint8Array|string|null}}
 */
export async function handleApi(method, url, headers, body, env) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return fail(404, 'not-found', '未知路径');

  // 跨站预检一律不认:本服务不提供任何 CORS 能力,凡带自定义头(Authorization /
  // X-Access-Key)的跨站请求都过不了预检,也就发不出真实请求。
  if (method === 'OPTIONS') return fail(405, 'method', '不支持的请求方法');

  const resource = parts[1];
  const ip = headers['cf-connecting-ip'] || 'unknown';

  if (isRateBlocked(ip)) return fail(429, 'rate-limited', '失败次数过多,请稍后再试', RATE_HEADERS);

  /* ---- 访问密钥门:所有 /api/* 共用;未配置/过弱一律拒绝服务 ---- */
  const gate = accessKeyGate(env);
  if (!gate.open) {
    if (gate.reason === 'unset' || gate.reason === 'weak') {
      const why = gate.reason === 'unset'
        ? '服务端尚未设置 ACCESS_KEY'
        : `ACCESS_KEY 过短(至少 ${MIN_ACCESS_KEY_LEN} 个字符)`;
      // fail closed:vault.json 是离线爆破的唯一入口,门没装好就什么都别给
      return fail(503, 'setup-required',
        `${why},已拒绝全部请求以保护 vault.json。请在部署目录执行:npx wrangler secret put ACCESS_KEY`);
    }
    if (!(await accessKeyMatches(headers['x-access-key'] || '', gate.key))) {
      recordAuthFail(ip, !!headers['x-access-key']); // 只对「带着密钥来试」计数
      return fail(401, 'access-key', '需要访问密钥(X-Access-Key)');
    }
  }

  /* ---- 免鉴权:vault.json 的读与首次创建 / 改密码 ---- */
  if (resource === 'vault' && parts.length === 2) {
    if (method === 'GET') {
      const v = await loadVault(env);
      if (!v) return fail(404, 'no-vault', '库尚未创建');
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS, etag: quote(v.etag) },
        body: JSON.stringify(v.json),
      };
    }
    if (method === 'PUT') {
      const raw = await bodyBytes(body);
      if (!raw || raw.length > MAX_VAULT_BYTES) return fail(413, 'too-large', 'vault.json 过大或为空');
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return fail(400, 'bad-json', 'vault.json 不是合法 JSON');
      }
      if (parsed?.magic !== 'JMBIJI' || !parsed?.kdf || !parsed?.wrap
        || !parsed?.auth?.hash || !/^[0-9a-f]{64}$/.test(parsed.auth.hash)) {
        return fail(400, 'bad-vault', 'vault.json 结构不合法');
      }
      if (await authOk(headers, env)) {
        // 改主密码:If-Match CAS 覆盖。
        // 这里不再额外读一次 vault.json 做存在性判断:能通过 authOk 就说明它存在,
        // 真正的不存在/被改由 R2 的条件写兜底(返回 null → 412)。
        const ifMatch = normEtag(headers['if-match']);
        if (!ifMatch) return fail(428, 'need-if-match', '缺少 If-Match');
        // 不用 R2 onlyIf.etagMatches:etag 一旦经 CF 边缘(压缩 JSON 被改成弱验证器
        // W/"...")往返,客户端带回来的值永远对不上对象真实 etag,表现为「恒 412、
        // 重新解锁也没用」。改为 head 取当前 etag 自己比 —— 比较语义在本地与生产完全
        // 一致;head→put 之间极小窗口由单用户场景兜住,真冲突仍以 412 拒绝。
        const cur = await env.VAULT.head(VAULT_KEY);
        if (!cur || normEtag(cur.etag) !== ifMatch) {
          return fail(412, 'conflict', 'vault.json 已被其他会话修改,请重新解锁');
        }
        const res = await env.VAULT.put(VAULT_KEY, raw);
        return json({ ok: true, etag: res.etag });
      }
      // 建库:只允许创建一次
      const created = await env.VAULT.put(VAULT_KEY, raw, { onlyIf: onlyIfNoneMatchStar() });
      if (!created) return fail(409, 'exists', '库已存在,请直接解锁');
      return json({ ok: true, etag: created.etag }, 201);
    }
    return fail(405, 'method', '不支持的请求方法');
  }

  /* ---- 其余全部需要 Bearer 鉴权 ---- */
  if (!(await authOk(headers, env))) {
    recordAuthFail(ip, !!headers.authorization); // 只对「带着令牌来试」计数
    return fail(401, 'bad-token', '鉴权失败(令牌缺失或不正确)');
  }
  clearAuthFail(ip);

  if (resource === 'cats' && parts.length === 2 && method === 'GET') {
    const objects = await listAll(env.VAULT, CAT_PREFIX);
    const cats = objects.map((o) => ({
      name: o.key.slice(CAT_PREFIX.length, -4), // 去掉前缀与 .enc
      size: o.size,
      uploaded: o.uploaded instanceof Date ? o.uploaded.getTime() : o.uploaded,
    }));
    return json({ cats });
  }

  if (resource === 'cat' && parts.length === 2) {
    const name = validCatName(u.searchParams.get('key') ?? '');
    if (!name) return fail(400, 'bad-name', '分类名不合法');
    if (method === 'GET') {
      const obj = await env.VAULT.get(`${CAT_PREFIX}${name}.enc`);
      if (!obj) return fail(404, 'missing', '分类不存在');
      const buf = obj instanceof Uint8Array ? obj : new Uint8Array(await obj.arrayBuffer());
      return binary(buf, { etag: quote(obj.etag) });
    }
    if (method === 'PUT') return putCategory(method, headers, body, env, name);
    if (method === 'DELETE') return deleteCategory(headers, env, name);
    return fail(405, 'method', '不支持的请求方法');
  }

  if (resource === 'blobs' && parts.length === 2 && method === 'GET') {
    const objects = await listAll(env.VAULT, BLOB_PREFIX);
    const blobs = objects.map((o) => ({
      name: o.key.slice(BLOB_PREFIX.length),
      size: o.size,
      uploaded: o.uploaded instanceof Date ? o.uploaded.getTime() : o.uploaded,
    }));
    // names 保留给既有调用方;blobs 是给「全库导出」用的(要先知道总量才能提示大小)
    return json({ names: blobs.map((b) => b.name), blobs });
  }

  if (resource === 'blob' && parts.length === 2) {
    const name = u.searchParams.get('key') ?? '';
    if (!BLOB_NAME_RE.test(name)) return fail(400, 'bad-name', '附件名不合法');
    const key = `${BLOB_PREFIX}${name}`;
    if (method === 'GET') {
      const obj = await env.VAULT.get(key);
      if (!obj) return fail(404, 'missing', '附件不存在');
      const buf = obj instanceof Uint8Array ? obj : new Uint8Array(await obj.arrayBuffer());
      return binary(buf);
    }
    if (method === 'PUT') {
      const raw = await bodyBytes(body);
      if (!raw || raw.length > MAX_BLOB_BYTES) return fail(413, 'too-large', `附件上限 ${MAX_BLOB_BYTES / 1024 / 1024}MB`);
      const res = await env.VAULT.put(key, raw, { onlyIf: onlyIfNoneMatchStar() });
      return json({ ok: true, existed: !res }, res ? 201 : 200);
    }
    if (method === 'DELETE') {
      await env.VAULT.delete(key);
      return empty();
    }
    return fail(405, 'method', '不支持的请求方法');
  }

  return fail(404, 'not-found', '未知接口');
}

/* ---------------- CF Workers 适配层 ---------------- */

/** 读 body 之前的预检判据。抽成纯函数是刻意的:适配层要构造真 Request/Response,
 *  而受限沙箱里 undici 的惰性 WASM 必然实例化失败,端到端那一步无法离线断言;
 *  这条判据本身(防 100MB body 打爆 128MB isolate)必须被测到。 */
export function declaredTooLarge(contentLength) {
  const n = Number(contentLength || 0);
  return Number.isFinite(n) && n > MAX_REQUEST_BYTES;
}

/** PUT/POST 必须声明长度:chunked(无 Content-Length)会绕过长度预检,
 *  让未认证流量把超大请求体灌进 isolate 内存 → 一律 411 拒收。
 *  抽成纯函数:受限环境构造不了真 Request,单测直接钉这条判据。 */
export function missingDeclaredLength(method, contentLength) {
  if (method !== 'PUT' && method !== 'POST') return false;
  return !/^\d+$/.test(String(contentLength ?? '').trim());
}

const errorResponse = (status, code, message) => new Response(
  JSON.stringify({ error: code, message }),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS } },
);

/** Request → 纯函数核心(测试与本地 dev-server 也用这个入口) */
export async function handleApiRequest(request, env) {
  try {
    // 先看声明长度再决定要不要读:不预检的话,平台不会替你拦住大 body
    if (missingDeclaredLength(request.method, request.headers.get('content-length'))) {
      return errorResponse(411, 'length-required', '缺少 Content-Length');
    }
    if (declaredTooLarge(request.headers.get('content-length'))) {
      return errorResponse(413, 'too-large', '请求体过大');
    }
    const headers = {};
    for (const [k, v] of request.headers.entries()) headers[k] = v;
    let body = null;
    if (request.method === 'PUT' || request.method === 'POST') {
      // ★ 惰性取体:handleApi 内部先过访问密钥门与 Bearer 鉴权,通过后才真正读。
      //   以前是进门之前先 arrayBuffer() 全量读入 —— 未认证请求也能打满 isolate 内存。
      body = () => request.arrayBuffer().then((b) => new Uint8Array(b));
    }
    const out = await handleApi(request.method, request.url, headers, body, env);
    return new Response(out.body, { status: out.status, headers: out.headers });
  } catch (e) {
    // 顶层兜底:任何未捕获异常(典型:vault.json 损坏导致 JSON.parse 抛错)
    // 都必须返回结构化错误,而不是让平台吐出无法诊断的裸 1101 错误页
    console.error('[jmbiji] 请求处理未捕获异常:', e);
    return errorResponse(500, 'internal', '服务器内部错误,请稍后重试');
  }
}

export default {
  async fetch(request, env) {
    return handleApiRequest(request, env);
  },
};
