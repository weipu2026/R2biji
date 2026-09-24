/* ============================================================
 * JMbiji 库结构与文件名规则 —— 纯函数,可离线单测
 * 见 DESIGN.md §3 / §4 / §8
 * ============================================================ */

export const ENCRYPTED_EXT = '.enc';
export const VAULT_NAME = 'vault.json';
export const BLOBS_DIR = 'blobs';
export const BACKUP_DIR = 'backup';
export const IGNORE_NAME = 'seafile-ignore.txt';
export const KEEP_BACKUPS_PER_CATEGORY = 10;

/** 非法文件名字符(Windows/macOS/Linux 取并集)与控制字符 */
const ILLEGAL_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g;

/**
 * 清洗分类名:去掉非法字符、压平空白、限长 60。
 * @returns {string|null} 无效(清洗后为空)时返回 null
 */
export function sanitizeCategoryName(raw) {
  const cleaned = String(raw ?? '')
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned.length ? cleaned : null;
}

/**
 * 大小写不敏感文件系统(Win/macOS)撞名检测。
 * 「API」与「api」会撞名 —— 返回与之撞名的既有分类名,无则 null。
 */
export function findCaseCollision(existingNames, name) {
  const lower = String(name).toLowerCase();
  return existingNames.find((n) => n !== name && String(n).toLowerCase() === lower) || null;
}

export function isEncryptedName(name) {
  return name.endsWith(ENCRYPTED_EXT);
}

export function stripEnc(name) {
  return name.slice(0, -ENCRYPTED_EXT.length);
}

/** Seafile / 同步工具生成冲突副本的常见命名特征 */
const CONFLICT_PATTERN = /(SF冲突|冲突副本|conflict|\(冲突)/i;

export function looksLikeConflictCopy(fileName) {
  return CONFLICT_PATTERN.test(fileName);
}

/* ---------- 备份命名与轮换 ---------- */

/**
 * 备份文件名。suffix 用于区分同一毫秒内的多次写入 —— 实测连续 12 次
 * Date.now() 会返回同一个值,只靠时间戳会让备份互相覆盖(12 份只剩 1 份)。
 */
export function backupFileName(categoryBase, ts, suffix = '') {
  return `${categoryBase}.${ts}${suffix ? `-${suffix}` : ''}${ENCRYPTED_EXT}`;
}

/** 解析备份文件名 → { base, ts, suffix, name } | null(非本应用备份命名则 null)。
 *  name 原样带回:轮换时必须按原文件名删除,不能靠 base/ts 重新拼(会丢 suffix)。 */
export function parseBackupFileName(name) {
  const m = /^(.*)\.(\d{13,})(?:-([0-9a-z]{2,8}))?\.enc$/.exec(name);
  return m ? { base: m[1], ts: Number(m[2]), suffix: m[3] || '', name } : null;
}

/**
 * 计算应删除的旧备份:按时间戳降序保留 keep 份。
 * @param {string[]} existingNames backup 目录里的全部文件名
 * @returns {string[]} 要删除的文件名
 */
export function planBackupRotation(existingNames, keep = KEEP_BACKUPS_PER_CATEGORY) {
  const backups = existingNames
    .map(parseBackupFileName)
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts || (a.name < b.name ? 1 : -1));
  return backups.slice(keep).map((b) => b.name);
}

/** seafile-ignore.txt 内容:只忽略自己的临时文件与备份目录,不忽略 *.enc / vault.json */
export const SEAFILE_IGNORE_CONTENT = '*.crswap\nbackup/\n';

/* ---------- 附件(blob)命名:内容寻址 ---------- */

/** HMAC 结果(base64url) + 保留原扩展名,供 Seafile 端识别图片类型 */
export function blobDisplayName(hashB64url, originalName) {
  const dot = originalName.lastIndexOf('.');
  const ext = dot > 0 ? originalName.slice(dot).slice(0, 12) : '';
  return hashB64url + ext;
}

/* ---------- 排序 ---------- */

/** 笔记排序:浮点 order 升序;同序号按创建时间兜底 */
export function sortNotes(notes) {
  return [...notes].sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
}

/**
 * 计算插入/移动后的 order:取相邻两项均值;端点向外扩 1000。
 * @returns {number} 新的 order 值
 */
export function orderBetween(prev, next) {
  if (prev == null && next == null) return 1000;
  if (prev == null) return next - 1000;
  if (next == null) return prev + 1000;
  return (prev + next) / 2;
}

/* ---------- 主密码强度 ---------- */

/** 主密码最短长度。它是唯一同时决定「记不记得住」与「破不破得动」的参数。 */
export const PASSWORD_MIN_LEN = 10;
/** 通过线:估算熵低于它一律拒绝(约等于 64 bit,离线爆破的下限) */
export const PASSWORD_MIN_BITS = 64;
/** 评为「强」的线 */
export const PASSWORD_STRONG_BITS = 90;

/** 一眼就会被字典/规则命中的口令(小写比对),只列高频项,不做穷举 */
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', '1234567890', '12345678901', 'qwertyuiop',
  'qwerty123', '1111111111', 'abc1234567', 'iloveyou', 'admin12345', 'letmein123',
  'welcome123', 'monkey123', 'sunshine1', 'football1', 'jmbiji123', 'jmbiji1234',
  'asdfghjkl', 'zxcvbnm123', 'a123456789', 'aa12345678', '1qaz2wsx3edc',
]);

const SEQUENTIAL = /(0123456789|1234567890|abcdefghij|qwertyuiop|asdfghjkl|zxcvbnm)/;

/** 字符池大小:按是否出现该类字符累加 */
const POOLS = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[^a-zA-Z0-9]/, 33],
];

/**
 * 主密码强度评估(纯函数,离线可测)。
 *
 * 用「长度 × log2(字符池)」估熵,而不是数一数用了几类字符 ——
 * 后者会把 20 位纯小写(94 bit,很强)判成弱,却放行 10 位混合(52 bit,很弱)。
 * 熵只是「防离线爆破」的第二道保险,第一道是访问密钥门。
 *
 * @param {string} pw
 * @returns {{ok:boolean, level:'weak'|'fair'|'strong', bits:number, msg:string}}
 */
export function assessPassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const len = s.length;
  if (len < PASSWORD_MIN_LEN) {
    return { ok: false, level: 'weak', bits: 0, msg: `太短:至少 ${PASSWORD_MIN_LEN} 位(它保护全部数据)` };
  }
  if (WEAK_PASSWORDS.has(s.toLowerCase()) || SEQUENTIAL.test(s.toLowerCase())) {
    return { ok: false, level: 'weak', bits: 0, msg: '太常见或明显连续,换一个' };
  }
  if (/^(.)\1*$/.test(s)) {
    return { ok: false, level: 'weak', bits: 0, msg: '整个密码只有一种字符,换一个' };
  }

  const pool = POOLS.reduce((n, [re, size]) => (re.test(s) ? n + size : n), 0);
  const bits = Math.round(len * Math.log2(pool));
  if (bits >= PASSWORD_STRONG_BITS) {
    return { ok: true, level: 'strong', bits, msg: `很强(约 ${bits} bit),记住它` };
  }
  if (bits >= PASSWORD_MIN_BITS) {
    return { ok: true, level: 'fair', bits, msg: `够用(约 ${bits} bit);再长一点更稳` };
  }
  return {
    ok: false, level: 'weak', bits,
    msg: `偏弱(约 ${bits} bit):加长到 16 位以上,或混入大小写/数字/符号`,
  };
}
