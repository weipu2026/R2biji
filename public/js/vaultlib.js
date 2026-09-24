/* ============================================================
 * JMbiji 库级操作 —— vault.json / 笔记数据 / 附件(纯模块)
 * ============================================================ */

import { TRASH_DAYS, TRASH_MAX } from './format.js';
import {
  PBKDF2_ITERATIONS_DEFAULT, PBKDF2_ITERATIONS_MIN, PBKDF2_ITERATIONS_MAX, MAGIC, FORMAT_VERSION,
  clampIterations,
  deriveKekBytes, importKekBytes, deriveAuthKey, sha256Hex,
  generateDekBytes, wrapDek, unwrapDek,
  deriveContentKey, deriveAttachKey, deriveFilenameKey,
  makeVerifier, checkVerifier,
  sealText, seal, openText, open,
  hmacBytes, bytesToB64, b64ToBytes, bytesToB64url, bytesToHex,
  CryptoError, FormatError,
} from './crypto.js';

export const VAULT_MAGIC = 'JMBIJI';
export const VAULT_VERSION = 1;

/* ---------- 建库 ---------- */

/**
 * 新建库参数:vault.json 的可序列化内容 + 裸 DEK(仅本次内存使用) + 鉴权令牌 hex。
 * vault.json 里只存 authHash = SHA-256(authKey);令牌本身只存在于内存。
 * @returns {{ json: object, dek: Uint8Array, authKeyHex: string }}
 */
export async function createVault(password, iterations = PBKDF2_ITERATIONS_DEFAULT) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iters = clampIterations(iterations); // 落盘值与实际派生值必须一致
  const kekBytes = await deriveKekBytes(password, salt, iters);
  const kek = await importKekBytes(kekBytes);
  const dek = generateDekBytes();
  const wrappedDek = await wrapDek(dek, kek);
  const contentKey = await deriveContentKey(dek);
  const verifier = await makeVerifier(contentKey);
  const authKey = await deriveAuthKey(kekBytes);
  const authHash = await sha256Hex(authKey);
  const json = {
    magic: VAULT_MAGIC,
    version: VAULT_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: iters, salt: bytesToB64(salt) },
    wrap: { alg: 'AES-KW', wrappedDek: bytesToB64(wrappedDek) },
    verifier,
    auth: { hash: authHash },
  };
  return { json, dek, authKeyHex: bytesToHex(authKey) };
}

/** 从 DEK 派生全部三把子密钥 */
export async function deriveAllKeys(dekBytes) {
  return {
    contentKey: await deriveContentKey(dekBytes),
    attachKey: await deriveAttachKey(dekBytes),
    filenameKey: await deriveFilenameKey(dekBytes),
  };
}

/**
 * 这份 vault.json 与本机存的 DEK 是否配对(校验块判定)。
 *
 * 「记住本设备」恢复会话时必做:本机存的 DEK 可能属于**另一个库**
 * (桶被换过、vault.json 被别处的库覆盖、存储被手工改过)。
 * 不校验就会「进去了,但每个分类都 ⛔ 打不开」—— 那种状态极难自查,
 * 不如在这里一次判定,失败就回落锁屏让用户输主密码。
 */
export async function dekMatchesVault(json, dekBytes) {
  try {
    if (!json?.verifier || !(dekBytes instanceof Uint8Array)) return false;
    return await checkVerifier(await deriveContentKey(dekBytes), json.verifier);
  } catch {
    return false;
  }
}

/**
 * 解锁 vault.json。
 * @returns {{ ok:true, dek:Uint8Array, authKeyHex:string, weakKdf:boolean }
 *          | { ok:false, reason:'corrupt'|'password' }}
 *  corrupt  = 文件结构损坏(魔数/版本/字段不合法)
 *  password = 结构合法但密码不对(解包失败或校验块不过)
 *  weakKdf  = 该库的 PBKDF2 迭代次数低于当前下限(仅提示,不阻断解锁)
 */
export async function unlockVault(json, password) {
  try {
    if (!json || typeof json !== 'object') return { ok: false, reason: 'corrupt' };
    if (json.magic !== VAULT_MAGIC || json.version !== VAULT_VERSION) return { ok: false, reason: 'corrupt' };
    if (!json.kdf || json.kdf.name !== 'PBKDF2' || json.kdf.hash !== 'SHA-256') return { ok: false, reason: 'corrupt' };
    if (!json.wrap || json.wrap.alg !== 'AES-KW' || typeof json.wrap.wrappedDek !== 'string') return { ok: false, reason: 'corrupt' };

    const kekBytes = await deriveKekBytes(password, b64ToBytes(json.kdf.salt), json.kdf.iterations);
    const kek = await importKekBytes(kekBytes);
    const dek = await unwrapDek(b64ToBytes(json.wrap.wrappedDek), kek);
    const contentKey = await deriveContentKey(dek);
    if (!(await checkVerifier(contentKey, json.verifier))) return { ok: false, reason: 'password' };
    const authKeyHex = bytesToHex(await deriveAuthKey(kekBytes));
    return { ok: true, dek, authKeyHex, weakKdf: !(Number(json.kdf.iterations) >= PBKDF2_ITERATIONS_MIN) };
  } catch (e) {
    if (e instanceof CryptoError) return { ok: false, reason: 'password' };
    return { ok: false, reason: 'corrupt' };
  }
}

/** 修改主密码:用新盐重派生 KEK 重包同一把 DEK,内容文件零改动。
 * ★ 鉴权令牌随 KEK 一起更换 —— 返回 { json, authKeyHex },
 *   调用方必须同步更新内存中的 Bearer 令牌,否则后续所有请求 401。 */
export async function rewrapVault(json, dekBytes, newPassword) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // 改密码是免费的安全升级点:旧库迭代次数偏弱(低于当前默认)时顺手升到默认;
  // 旧库本来就更高则保留(只加码,绝不降级)。反正盐要换、KEK 要重派生,零额外成本。
  const iterations = Math.max(clampIterations(json.kdf.iterations), PBKDF2_ITERATIONS_DEFAULT);
  const kekBytes = await deriveKekBytes(newPassword, salt, iterations);
  const kek = await importKekBytes(kekBytes);
  const wrappedDek = await wrapDek(dekBytes, kek);
  const contentKey = await deriveContentKey(dekBytes);
  const verifier = await makeVerifier(contentKey);
  const authKey = await deriveAuthKey(kekBytes);
  return {
    json: {
      ...json,
      kdf: { ...json.kdf, salt: bytesToB64(salt), iterations },
      wrap: { alg: 'AES-KW', wrappedDek: bytesToB64(wrappedDek) },
      verifier,
      auth: { hash: await sha256Hex(authKey) },
    },
    authKeyHex: bytesToHex(authKey),
  };
}

/* ---------- 笔记数据(密文内部的 JSON) ---------- */

function newNoteId(i) {
  return `n${Date.now().toString(36)}${i.toString(36)}${crypto.getRandomValues(new Uint8Array(4))[0].toString(36)}`;
}

/**
 * 归一化分类文件解密出的数据:宽容读取、补默认值;结构完全不对才抛 FormatError。
 */
export function normalizeNoteData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notes)) {
    throw new FormatError('笔记数据结构异常');
  }
  const now = Date.now();
  const notes = raw.notes.map((n, i) => ({
    // 先铺开原对象:多端版本不同步时,新版本加的可选字段不得在白名单重建中丢失
    ...(n && typeof n === 'object' && !Array.isArray(n) ? n : {}),
    id: typeof n?.id === 'string' && n.id ? n.id : newNoteId(i),
    title: typeof n?.title === 'string' ? n.title : '无标题',
    content: typeof n?.content === 'string' ? n.content : '',
    order: Number.isFinite(n?.order) ? n.order : (i + 1) * 1000,
    createdAt: Number.isFinite(n?.createdAt) ? n.createdAt : now,
    updatedAt: Number.isFinite(n?.updatedAt) ? n.updatedAt : now,
    attachments: Array.isArray(n?.attachments)
      ? n.attachments
        .filter((a) => a && typeof a.file === 'string')
        .map((a) => ({ file: a.file, name: typeof a.name === 'string' ? a.name : a.file }))
      : [],
  }));

  // 回收站:同一密文文件内的延期删除区(trash 数组,条目 = 笔记 + deletedAt)。
  // 读取时统一归一并清除过期项(TRASH_DAYS 天),条目超上限丢最旧的 ——
  // 集中在 normalize 里做,「解密 → 保存」的任何路径都会顺带完成清理,
  // 不需要单独的清理任务,多端之间也自然一致。
  const dayMs = TRASH_DAYS * 86400000;
  const trash = (Array.isArray(raw.trash) ? raw.trash : [])
    .map((t) => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
      const deletedAt = Number.isFinite(t.deletedAt) ? t.deletedAt
        : (Number.isFinite(t.updatedAt) ? t.updatedAt : now); // 缺日期的兜底,再一起参与过期判定
      return { ...t, deletedAt };
    })
    .filter(Boolean)
    .filter((t) => now - t.deletedAt < dayMs)
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, TRASH_MAX);

  return { notes, trash };
}

/* ---------- 分类文件(密文) ---------- */

export async function encryptCategory(contentKey, noteData) {
  return sealText(contentKey, MAGIC.CATEGORY, JSON.stringify(noteData));
}

export async function decryptCategory(contentKey, fileBytes) {
  const text = await openText(contentKey, MAGIC.CATEGORY, fileBytes);
  try {
    return normalizeNoteData(JSON.parse(text));
  } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new FormatError('分类文件内容不是合法 JSON');
  }
}

/* ---------- 图片附件 ---------- */

/**
 * 附件文件名 = HMAC(文件名子密钥, SHA-256(原始字节)) base64url + 原扩展名。
 * 同一张图无论插多少次,文件名一致 → 天然去重、写一次不再动。
 */
export async function blobFileNameFor(filenameKey, originalBytes, originalName) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', originalBytes));
  const mac = await hmacBytes(filenameKey, digest);
  // 扩展名必须过服务端的白名单正则([A-Za-z0-9]{1,12}):「攻略.最终版」这类
  // 原名以前会把非法扩展名带进 blob 名,上传在服务端 400 必失败。不合法就干脆不带。
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(originalName || '');
  return bytesToB64url(mac) + (m ? m[0] : '');
}

export async function encryptBlob(attachKey, originalBytes) {
  return seal(attachKey, MAGIC.BLOB, originalBytes);
}

export async function decryptBlob(attachKey, fileBytes) {
  return open(attachKey, MAGIC.BLOB, fileBytes);
}

/* ---------- 常量再导出,便于上层统一取用 ---------- */

export { FORMAT_VERSION, PBKDF2_ITERATIONS_DEFAULT, PBKDF2_ITERATIONS_MIN, PBKDF2_ITERATIONS_MAX, CryptoError, FormatError };
