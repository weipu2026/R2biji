/* ============================================================
 * JMbiji 云端 API 客户端(仅浏览器)—— 与同源 Worker 通信
 *
 * 令牌:解锁/建库时由主密码派生,仅存内存;锁屏即清除。
 * 每个写请求都带 etag 条件(CAS),多端同时保存不会静默覆盖。
 * 无第三方代码、无 innerHTML,令牌的暴露面只有本应用自身。
 * ============================================================ */

let token = null;          // hex64;null = 未解锁
let accessKey = null;      // 可选访问密钥门(localStorage 持久,便于下次使用)

export class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function setToken(hex) { token = hex; }
export function clearToken() { token = null; }
/** 取当前令牌。改主密码会换掉它,「记住本设备」需要在换完后重新落盘。 */
export function getToken() { return token; }

const AK_STORE = 'jmbiji.accessKey';

export function loadAccessKey() {
  try { accessKey = localStorage.getItem(AK_STORE) || null; } catch { accessKey = null; }
  return accessKey;
}

export function saveAccessKey(key) {
  accessKey = key || null;
  try {
    if (accessKey) localStorage.setItem(AK_STORE, accessKey);
    else localStorage.removeItem(AK_STORE);
  } catch { /* 隐私模式下不可持久,忽略 */ }
}

/* ---------------- 请求原语 ---------------- */

/** 请求超时。取值要容得下最慢一档(50MB 附件上传在慢网络下可能要几十秒)。 */
const REQUEST_TIMEOUT_MS = 120_000;

async function req(path, { method = 'GET', body = null, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (accessKey) h['X-Access-Key'] = accessKey;
  let res;
  try {
    res = await fetch(path, { method, headers: h, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new ApiError(`无法连接服务器:${e.message}`, 0, 'network');
  }
  if (res.status === 429) {
    // 服务端限流响应带 retry-after;以前被丢弃,用户只看到干巴巴的失败
    const after = Number(res.headers.get('retry-after') || 0);
    throw new ApiError(after > 0 ? `请求过于频繁,请 ${after} 秒后再试` : '请求过于频繁,请稍后再试', 429, 'rate-limited');
  }
  if (res.status === 401) {
    // 读一次响应体区分「访问密钥缺失」与「解锁令牌失效」
    let code = '';
    try { code = (await res.json()).error || ''; } catch { /* 非 JSON */ }
    if (code === 'access-key') throw new ApiError('需要访问密钥', 401, 'access-key');
  }
  if (res.status === 503) {
    // 服务端 fail closed(未配置/过弱的 ACCESS_KEY):把服务端那句可操作的
    // 提示原样带上来,别让用户看到一句「无法连接服务器」去猜。
    let code = ''; let message = '';
    try { const j = await res.json(); code = j.error || ''; message = j.message || ''; } catch { /* 非 JSON */ }
    throw new ApiError(message || '服务端未就绪(HTTP 503)', 503, code || 'setup-required');
  }
  return res;
}

async function errFrom(res) {
  let code = 'unknown'; let message = `服务器错误(${res.status})`;
  try {
    const j = await res.json();
    if (j.error) code = j.error;
    if (j.message) message = j.message;
  } catch { /* 非 JSON 响应体 */ }
  return new ApiError(message, res.status, code);
}

/* ---------------- 具体接口 ---------------- */

/** 拉取 vault.json(免鉴权)。@returns {{status, json?, etag?}} */
export async function fetchVault() {
  const res = await req('/api/vault');
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw await errFrom(res);
  // W/ 前缀 = CF 边缘把压缩响应的强 etag 改写成了弱验证器,必须剥掉,否则 CAS 恒 412
  return { status: 200, json: await res.json(), etag: (res.headers.get('etag') || '').replace(/"/g, '').replace(/^W\//i, '') };
}

/** 建库(只允许创建)。返回 { status, etag };etag 供建库后的改密码 CAS 使用。 */
export async function createVaultJson(jsonText) {
  const res = await req('/api/vault', { method: 'PUT', body: jsonText, headers: { 'if-none-match': '*', 'content-type': 'application/json' } });
  if (!res.ok && res.status !== 409) throw await errFrom(res);
  let etag = null;
  if (res.ok) {
    try { etag = (await res.json()).etag; } catch { /* 非 JSON */ }
  }
  return { status: res.status, etag }; // 201(含 etag) | 409
}

/** 改主密码:覆盖 vault.json,带 CAS */
export async function putVaultJson(jsonText, etag) {
  if (!etag) {
    // 空 etag 会拼出 If-Match: "" → 服务端恒 428/412,报错误导;提前拦下并说人话
    throw new ApiError('vault 版本信息缺失,请刷新页面重新解锁后再试', 0, 'need-refresh');
  }
  const res = await req('/api/vault', { method: 'PUT', body: jsonText, headers: { 'if-match': `"${etag}"`, 'content-type': 'application/json' } });
  if (res.status === 412) throw new ApiError('vault.json 已被其他会话修改,请重新解锁', 412, 'conflict');
  if (!res.ok) throw await errFrom(res);
  const j = await res.json();
  return j.etag;
}

export async function listCats() {
  const res = await req('/api/cats');
  if (!res.ok) throw await errFrom(res);
  return (await res.json()).cats; // [{name,size,uploaded}]
}

export async function getCat(name) {
  const res = await req(`/api/cat?key=${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await errFrom(res);
  return { bytes: new Uint8Array(await res.arrayBuffer()), etag: (res.headers.get('etag') || '').replace(/"/g, '') };
}

/**
 * 写分类。etag = 上次见到的版本(null 配 createOnly = 新建)。
 * @returns {{status:number, etag?:string}} 200/201 成功;409 已存在;412 冲突
 */
export async function putCat(name, bytes, { etag = null, createOnly = false } = {}) {
  const headers = { 'content-type': 'application/octet-stream' };
  if (createOnly) headers['if-none-match'] = '*';
  else headers['if-match'] = `"${etag}"`;
  const res = await req(`/api/cat?key=${encodeURIComponent(name)}`, { method: 'PUT', body: bytes, headers });
  if (!res.ok && res.status !== 409 && res.status !== 412) throw await errFrom(res);
  const out = { status: res.status };
  if (res.ok) {
    try { out.etag = (await res.json()).etag; } catch { out.etag = null; }
  }
  return out;
}

/** 删除分类。etag = 本地见过的版本 → If-Match 条件删除(412 = 刚被其他设备改过) */
export async function deleteCat(name, etag = null) {
  const headers = {};
  if (etag) headers['if-match'] = `"${etag}"`;
  const res = await req(`/api/cat?key=${encodeURIComponent(name)}`, { method: 'DELETE', headers });
  if (!res.ok && res.status !== 404) throw await errFrom(res);
}

export async function listBlobs() {
  const res = await req('/api/blobs');
  if (!res.ok) throw await errFrom(res);
  return (await res.json()).names;
}

/** 同 listBlobs,但带 size —— 「全库导出」要先知道总量才能提示大小。
 *  老版本 Worker 只回 names 时退化成 size=0(仍可用,只是提示不出总量)。 */
export async function listBlobInfo() {
  const res = await req('/api/blobs');
  if (!res.ok) throw await errFrom(res);
  const j = await res.json();
  return Array.isArray(j.blobs) ? j.blobs : (j.names || []).map((name) => ({ name, size: 0 }));
}

export async function getBlob(name) {
  const res = await req(`/api/blob?key=${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await errFrom(res);
  return new Uint8Array(await res.arrayBuffer());
}

/** 入库附件。返回 201(新写入)或 200(已存在,内容相同去重) */
export async function putBlob(name, bytes) {
  const res = await req(`/api/blob?key=${encodeURIComponent(name)}`, { method: 'PUT', body: bytes });
  if (!res.ok) throw await errFrom(res);
  return res.status;
}

export async function deleteBlob(name) {
  const res = await req(`/api/blob?key=${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await errFrom(res);
}
