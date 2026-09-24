/* ============================================================
 * JMbiji 加密核心 —— 纯模块,不依赖 DOM,浏览器与 Node 测试通用
 *
 * 体系(见 DESIGN.md §5):
 *   主密码 --PBKDF2-SHA256(100 万次)--> KEK(密钥包裹钥匙)
 *   KEK --AES-KW--> 解开随机生成的 DEK(数据钥匙,32 字节)
 *   DEK --HKDF-SHA256--> 三把子密钥:内容 / 附件 / 文件名(按用途分离)
 *   内容/附件: AES-256-GCM,nonce 每次加密重新随机生成,AAD 绑定文件头
 *   文件名:   HMAC-SHA256(内容寻址,不泄露原文信息)
 * ============================================================ */

/**
 * 新建库的默认迭代次数。刻意保持 100 万:
 * 每翻一倍只多 1 bit 强度,却让每次解锁都多等一倍 —— 本机实测
 * 100 万 ≈ 336ms、200 万 ≈ 672ms、400 万 ≈ 1.3s(手机还要再乘 2~4 倍),
 * 而令牌只存内存,刷新页面就要重来一次。同样的预算花在
 * 「密码长度 ≥10 且 ≥2 类字符」(约 +20 bit)和「必设访问密钥」上收益高得多。
 * 想加码就改这一个常量:迭代次数写在 vault.json 里,老库不受影响。
 */
export const PBKDF2_ITERATIONS_DEFAULT = 1_000_000;
/** 低于它视为配置异常(界面上提示,不阻断:降级迭代次数对攻击者毫无帮助) */
export const PBKDF2_ITERATIONS_MIN = 100_000;
/** 上限:防被篡改的 vault.json 写出一个天文数字,把标签页直接冻死 */
export const PBKDF2_ITERATIONS_MAX = 8_000_000;

/** 文件魔数:分类文件 JMB1 / 图片附件 JMBB */
export const MAGIC = { CATEGORY: 'JMB1', BLOB: 'JMBB' };
export const FORMAT_VERSION = 1;

/** 文件头长度:魔数 4B + 版本 1B + nonce 12B */
export const HEADER_LEN = 17;
/** GCM 认证标签 16B —— 用于最小长度校验 */
const TAG_LEN = 16;

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------- 编码工具 ---------- */

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- 错误类型:区分「格式坏」与「密钥/密文坏」 ---------- */

export class CryptoError extends Error {
  constructor(msg) { super(msg); this.name = 'CryptoError'; }
}
export class FormatError extends Error {
  constructor(msg) { super(msg); this.name = 'FormatError'; }
}

/* ---------- 口令派生与信封加密 ---------- */

export async function deriveKek(password, salt, iterations = PBKDF2_ITERATIONS_DEFAULT) {
  const raw = await deriveKekBytes(password, salt, iterations);
  return importKekBytes(raw);
}

/** 把任意外部传入的迭代次数收进 [1, MAX]:非法值回落默认,超大值截断到上限。 */
export function clampIterations(iterations) {
  if (!Number.isFinite(iterations) || iterations <= 0) return PBKDF2_ITERATIONS_DEFAULT;
  return Math.min(Math.floor(iterations), PBKDF2_ITERATIONS_MAX);
}

/** 派生 KEK 原始字节(32B)。云端架构下同一轮派生还要出鉴权钥匙,需要裸字节。 */
export async function deriveKekBytes(password, salt, iterations = PBKDF2_ITERATIONS_DEFAULT) {
  const iters = clampIterations(iterations);
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
    base, 256,
  ));
}

/** 裸 KEK 字节 → AES-KW CryptoKey(不可导出) */
export async function importKekBytes(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
}

/**
 * 鉴权子钥匙:HKDF-SHA256(KEK 原始字节, info=用途串) → 32B。
 * 客户端以 hex 形式作 Bearer 令牌;服务端只存 SHA-256(authKey) 的哈希,
 * 服务端存储泄露时不增加任何新的离线爆破面。
 */
export async function deriveAuthKey(kekBytes) {
  const base = await crypto.subtle.importKey('raw', kekBytes, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode('JMBIJI-auth-v1') },
    base, 256,
  ));
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) throw new FormatError('hex 格式非法');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return bytesToHex(d);
}

export function generateDekBytes() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importDekKey(dekBytes) {
  return crypto.subtle.importKey('raw', dekBytes, { name: 'AES-KW' }, true, ['wrapKey', 'unwrapKey']);
}

/** 用 KEK 包裹 DEK 原始字节(AES-KW 自带完整性校验,包不对即抛错) */
export async function wrapDek(dekBytes, kek) {
  const dekKey = await importDekKey(dekBytes);
  return new Uint8Array(await crypto.subtle.wrapKey('raw', dekKey, kek, { name: 'AES-KW' }));
}

/** 解包 DEK。KEK 不对时 AES-KW 解包失败 → CryptoError(用于判定「密码错误」) */
export async function unwrapDek(wrappedBytes, kek) {
  let dekKey;
  try {
    dekKey = await crypto.subtle.unwrapKey(
      'raw', wrappedBytes, kek,
      { name: 'AES-KW' }, { name: 'AES-KW' },
      true, ['wrapKey', 'unwrapKey'],
    );
  } catch {
    throw new CryptoError('密钥解包失败(主密码错误或密文被改)');
  }
  return new Uint8Array(await crypto.subtle.exportKey('raw', dekKey));
}

/* ---------- 子密钥派生(HKDF,按用途分离) ---------- */

async function deriveSubkey(dekBytes, info, alg, usages) {
  const base = await crypto.subtle.importKey('raw', dekBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    base, alg, false, usages,
  );
}

export function deriveContentKey(dekBytes) {
  return deriveSubkey(dekBytes, 'JMBIJI-content-v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
}
export function deriveAttachKey(dekBytes) {
  return deriveSubkey(dekBytes, 'JMBIJI-attach-v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
}
export function deriveFilenameKey(dekBytes) {
  return deriveSubkey(dekBytes, 'JMBIJI-filename-v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);
}

export async function hmacBytes(filenameKey, bytes) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', filenameKey, bytes));
}

/* ---------- 校验块:区分「密码错」与「文件损坏」 ---------- */

const VERIFIER_PLAIN = 'JMBIJI-verifier-v1';

export async function makeVerifier(contentKey) {
  const { nonce, ct } = await gcmEncrypt(contentKey, te.encode(VERIFIER_PLAIN), new Uint8Array(0));
  return { nonce: bytesToB64(nonce), ct: bytesToB64(ct) };
}

export async function checkVerifier(contentKey, verifier) {
  try {
    if (!verifier || typeof verifier.nonce !== 'string' || typeof verifier.ct !== 'string') return false;
    const plain = await gcmDecrypt(contentKey, b64ToBytes(verifier.nonce), b64ToBytes(verifier.ct), new Uint8Array(0));
    return td.decode(plain) === VERIFIER_PLAIN;
  } catch {
    return false;
  }
}

/* ---------- GCM 原语 ---------- */

export async function gcmEncrypt(key, plaintextBytes, aad = new Uint8Array(0)) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    key, plaintextBytes,
  ));
  return { nonce, ct };
}

export async function gcmDecrypt(key, nonce, ctBytes, aad = new Uint8Array(0)) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    key, ctBytes,
  ));
}

/* ---------- 库文件封装格式:魔数(4) + 版本(1) + nonce(12) + GCM 密文 ---------- */

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/** 加密任意字节。每次调用生成全新 12B nonce;AAD 绑定文件头。 */
export async function seal(key, magic, plaintextBytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header = concat(te.encode(magic), new Uint8Array([FORMAT_VERSION]), nonce);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 },
    key, plaintextBytes,
  ));
  return concat(header, ct);
}

export function parseHeader(bytes, expectedMagic) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LEN + TAG_LEN) {
    throw new FormatError('文件过短或已截断');
  }
  const magic = td.decode(bytes.slice(0, 4));
  if (magic !== expectedMagic) throw new FormatError(`魔数不符:期望 ${expectedMagic},实际「${magic}」`);
  if (bytes[4] !== FORMAT_VERSION) throw new FormatError(`不支持的格式版本:${bytes[4]}`);
  return {
    header: bytes.slice(0, HEADER_LEN),
    nonce: bytes.slice(5, HEADER_LEN),
    ciphertext: bytes.slice(HEADER_LEN),
  };
}

/** 解出原始字节。格式问题 → FormatError;认证失败 → CryptoError。 */
export async function open(key, magic, fileBytes) {
  const { header, nonce, ciphertext } = parseHeader(fileBytes, magic);
  try {
    return await gcmDecrypt(key, nonce, ciphertext, header);
  } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new CryptoError('解密失败(密钥不符或密文被篡改)');
  }
}

export async function sealText(key, magic, text) {
  return seal(key, magic, te.encode(String(text)));
}

export async function openText(key, magic, fileBytes) {
  return td.decode(await open(key, magic, fileBytes));
}

/* ---------- 测试辅助 ---------- */

export function bytesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
