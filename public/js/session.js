/* ============================================================
 * JMbiji 本机会话(「记住本设备」)—— 把解锁结果持久化,免去每次输主密码
 *
 * 存什么:裸 DEK(32B)+ 鉴权令牌(hex64)。
 *   · DEK  → 派生内容/附件/文件名三把子密钥,是解开全库的唯一东西
 *   · 令牌 → 让 Worker 认这个会话(Bearer)
 *   注意令牌本身**不能**解密(它是 HKDF(KEK) 的输出,反推不出 KEK),
 *   所以两者都要存;只存令牌的话每次仍得输主密码。
 *
 * ⚠️ 安全边界(必须说清,别让它变成「看起来加密了」的错觉):
 *   存的是明文密钥。任何能读到本浏览器存储的人或代码(XSS)都能直接解开全部笔记,
 *   **不需要**再爆破主密码。这是「打开即用」必然的代价,不是实现瑕疵。
 *   服务端的零知识性质不受影响:R2 里仍然只有密文,主密码仍然从不上传。
 *   不想要就取消勾选「记住本设备」,行为完全回到「刷新即需重新输入」。
 *
 * 纯模块(不依赖 DOM),Node 单测可覆盖;localStorage 不可用时静默降级为「不记住」。
 * ============================================================ */

import { bytesToB64, b64ToBytes } from './crypto.js';

const SESSION_KEY = 'jmbiji.session';
const SESSION_VERSION = 1;

/** 密钥长度(base64 解码后必须是 32 字节) */
const DEK_BYTES = 32;
const AUTH_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * 记住本设备。
 * @param {{dek: Uint8Array, authKeyHex: string}} session
 * @returns {boolean} 是否真的存下来了(false = 隐私模式/配额满,已静默降级)
 */
export function saveSession({ dek, authKeyHex }) {
  try {
    if (!(dek instanceof Uint8Array) || dek.length !== DEK_BYTES) return false;
    if (!AUTH_HEX_RE.test(String(authKeyHex || ''))) return false;
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: SESSION_VERSION,
      dek: bytesToB64(dek),
      authKeyHex,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取本机记住的会话。
 * @returns {{dek: Uint8Array, authKeyHex: string}|null}
 *   版本不符 / 字段缺失 / 长度不对 / 存储不可用 → null(一律当作「没记住」,不抛错)
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o?.v !== SESSION_VERSION) return null;
    if (typeof o.authKeyHex !== 'string' || !AUTH_HEX_RE.test(o.authKeyHex)) return null;
    if (typeof o.dek !== 'string') return null;
    const dek = b64ToBytes(o.dek); // 非法 base64 会抛,由 catch 兜住
    if (dek.length !== DEK_BYTES) return null;
    return { dek, authKeyHex: o.authKeyHex };
  } catch {
    return null;
  }
}

/** 忘掉本设备(锁定、令牌失效、用户取消勾选时调用) */
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* 忽略 */ }
}

/** 本机是否记住了会话(给界面判断用,不暴露密钥) */
export function hasSession() {
  return loadSession() !== null;
}
