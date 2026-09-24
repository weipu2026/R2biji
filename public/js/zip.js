/* ============================================================
 * JMbiji 极简 ZIP(store-only)—— 零依赖纯模块
 *
 * 用途:把「全库密文备份」打成一个包。硬要求是它必须是个**普通 zip 文件** ——
 * 双击就能看见里面的 vault.json 与 cats/*.enc、blobs/*,
 * 人工抢救时不需要先写个解析器才能看到自己的数据。
 *
 * 为什么只做 store(不压缩):内容全是 AES-GCM 密文,压缩率≈1,
 * 压了白花 CPU 还要引一个 deflate 实现。副作用是写出来的包用任何工具都能读。
 * 反过来,**读**只支持自己写出的这种(store、无加密、无数据描述符),
 * 遇到别的 zip 一律明确报错,不猜。
 *
 * 上限:条目数 ≤ 65535、总长 < 4GB(再大需要 ZIP64,本模块不做,直接报错)。
 * 个人笔记库远达不到,但宁可报错也不要悄悄写出一个坏包。
 * ============================================================ */

export class ZipError extends Error {
  constructor(msg) { super(msg); this.name = 'ZipError'; }
}

export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** 通用位标记第 11 位:文件名是 UTF-8(分类名可能是中文) */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------------- CRC-32(ZIP 规范要求) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- 工具 ---------------- */

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** JS Date → ZIP 用的 DOS 时间/日期(1980 起算,秒只有 2 秒精度) */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 条目名是否安全(解出来的名字要当对象键用,所以按 zip-slip 防)。
 * 拒绝:绝对路径、结尾斜杠、反斜杠、控制字符、空段、`.` / `..`、超长。
 *
 * 控制字符用**码点判断**而不是转义正则:早先那版把控制字符写成了字面量,
 * 语义是对的,却让源文件里躺了两个裸控制字节(0x00 / 0x1f)——
 * grep 会把整个文件当二进制、编辑器和 diff 都可能无声改坏。不写转义最省事。
 *
 * @returns {boolean}
 */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 300) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('\\')) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return name.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/* ---------------- 写 ---------------- */

/**
 * 打包成 ZIP。
 * @param {{name:string, bytes:Uint8Array}[]} entries
 * @param {{date?:Date}} [opt] 时间戳可注入,便于确定性测试
 * @returns {Uint8Array}
 */
export function zipStore(entries, { date = new Date() } = {}) {
  if (!Array.isArray(entries)) throw new ZipError('entries 必须是数组');
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipError(`条目数 ${entries.length} 超过 ${ZIP_MAX_ENTRIES}(需要 ZIP64,本模块不支持)`);
  }

  let total = 0;
  const prepared = entries.map((e) => {
    const name = e?.name;
    if (!isSafeEntryName(name)) throw new ZipError(`条目名不合法:${JSON.stringify(name)}`);
    const data = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes);
    total += data.length;
    return { name: te.encode(name), data, crc: crc32(data) };
  });
  if (total > ZIP_MAX_BYTES) {
    throw new ZipError(`总长 ${total} 字节超过 4GB(需要 ZIP64,本模块不支持)`);
  }

  const { time, date: dDate } = dosDateTime(date);
  const blobs = [];
  const centrals = [];
  let offset = 0;

  for (const p of prepared) {
    const local = new Uint8Array(30 + p.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);              // 解压所需版本 2.0
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, METHOD_STORE, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, dDate, true);
    lv.setUint32(14, p.crc, true);
    lv.setUint32(18, p.data.length, true);  // compressed(store:与原始同长)
    lv.setUint32(22, p.data.length, true);  // uncompressed
    lv.setUint16(26, p.name.length, true);
    lv.setUint16(28, 0, true);              // extra len
    local.set(p.name, 30);

    const central = new Uint8Array(46 + p.name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);              // version made by
    cv.setUint16(6, 20, true);              // version needed
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, METHOD_STORE, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dDate, true);
    cv.setUint32(16, p.crc, true);
    cv.setUint32(20, p.data.length, true);
    cv.setUint32(24, p.data.length, true);
    cv.setUint16(28, p.name.length, true);
    cv.setUint16(30, 0, true);              // extra
    cv.setUint16(32, 0, true);              // comment
    cv.setUint16(34, 0, true);              // disk
    cv.setUint16(36, 0, true);              // internal attrs
    cv.setUint32(38, 0, true);              // external attrs
    cv.setUint32(42, offset, true);         // 本地头偏移
    central.set(p.name, 46);

    blobs.push(local, p.data);
    centrals.push(central);
    offset += local.length + p.data.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return concat([...blobs, ...centrals, eocd]);
}

/* ---------------- 读(只认自己写出的 store 格式) ---------------- */

/**
 * 解包。校验签名、方法、长度与 CRC —— 备份包是要用来恢复数据的,
 * 任何一处对不上都必须**明确报错**,不能带着坏数据往下走。
 * @param {Uint8Array} input
 * @returns {{name:string, bytes:Uint8Array}[]}
 */
export function readZipStore(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22) throw new ZipError('文件太小,不像 zip');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD 可能带注释,所以从尾部往前扫(注释最长 65535)
  let eocd = -1;
  const from = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('不是 zip 文件(找不到结尾记录)');

  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > bytes.length) throw new ZipError('zip 结构损坏(中央目录越界)');

  const out = [];
  const seen = new Set();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError(`zip 结构损坏(第 ${i + 1} 个条目头不对)`);
    }
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!isSafeEntryName(name)) throw new ZipError(`条目名不安全,拒绝:${JSON.stringify(name)}`);
    if (seen.has(name)) throw new ZipError(`条目重复:${name}`);
    seen.add(name);
    if (method !== METHOD_STORE) {
      throw new ZipError(`条目「${name}」是压缩过的,本模块只认自己写出的未压缩格式`);
    }
    if (csize !== usize) throw new ZipError(`条目「${name}」压缩前后长度不一致`);

    if (localOff + 30 > bytes.length || dv.getUint32(localOff, true) !== SIG_LOCAL) {
      throw new ZipError(`条目「${name}」的本地头不对`);
    }
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + csize > bytes.length) throw new ZipError(`条目「${name}」数据越界`);

    const data = bytes.slice(dataStart, dataStart + csize);
    if (crc32(data) !== crc) throw new ZipError(`条目「${name}」校验失败(内容损坏或被改过)`);
    out.push({ name, bytes: data });
  }
  return out;
}