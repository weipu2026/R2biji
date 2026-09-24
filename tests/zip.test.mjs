/* ============================================================
 * 极简 ZIP(store-only)单测
 *
 * 这个模块的产物是「灾难恢复时唯一的凭据」,所以要求比别处更严:
 * 写出的包必须能被任何标准工具打开,读回时必须逐字节一致,
 * 任何一处不对都要**明确报错**,绝不能带着坏数据往下走。
 * (格式正确性另有外部验证:生成物经 unzip -t 与 Python zipfile 实测通过。)
 *
 * 注:控制字符一律用 String.fromCharCode 拼,不写字面量 ——
 * 字面量控制字节会让源文件变成「二进制」,grep 与 diff 都会失灵。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipStore, readZipStore, crc32, isSafeEntryName, ZipError } from '../public/js/zip.js';

const te = new TextEncoder();
const enc = (s) => te.encode(s);
const DATE = new Date(2026, 8, 24, 17, 30, 0); // 固定时间戳 → 生成物可复现
/** 'a' + 指定码点 + 'b',用来构造含控制字符的名字 */
const withCode = (n) => `a${String.fromCharCode(n)}b`;

test('CRC-32 对上标准校验值(0xCBF43926 是 CRC-32/ISO-HDLC 的规定向量)', () => {
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0, '空数据 CRC 为 0');
  assert.equal(crc32(enc('a')), 0xe8b7be43);
});

test('往返:名字与字节原样还原(含中文名、空文件、含 0x00/0xff 的二进制)', () => {
  const entries = [
    { name: 'vault.json', bytes: enc('{"magic":"JMBIJI"}') },
    { name: 'cats/秘钥.enc', bytes: new Uint8Array([0, 255, 128, 1]) },
    { name: 'blobs/empty', bytes: new Uint8Array(0) },
    { name: 'blobs/AbC-_.png', bytes: new Uint8Array(300).fill(0xff) },
  ];
  const back = readZipStore(zipStore(entries, { date: DATE }));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) {
    assert.deepEqual(back[i].bytes, entries[i].bytes, `第 ${i + 1} 个条目字节必须一致`);
  }
});

test('同样的输入 + 同样的时间戳 → 逐字节相同的输出(可复现)', () => {
  const e = [{ name: 'a.txt', bytes: enc('hi') }];
  assert.deepEqual(zipStore(e, { date: DATE }), zipStore(e, { date: DATE }));
});

test('多条目结构与偏移正确:每个条目都能独立取出', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    name: `cats/c${i}.enc`,
    bytes: new Uint8Array(i * 7).fill(i),
  }));
  const back = readZipStore(zipStore(entries, { date: DATE }));
  assert.equal(back.length, 20);
  back.forEach((e, i) => {
    assert.equal(e.name, `cats/c${i}.enc`);
    assert.equal(e.bytes.length, i * 7);
    assert.ok(e.bytes.every((b) => b === i), `第 ${i} 个条目内容应全为 ${i}`);
  });
});

/* ---------------- 名字安全(zip-slip 防护) ---------------- */

test('isSafeEntryName:放行正常路径', () => {
  for (const ok of ['vault.json', 'cats/秘钥.enc', 'blobs/a-b_c.png', 'backup/攻略/x.enc', 'a/b/c']) {
    assert.equal(isSafeEntryName(ok), true, `应当放行:${ok}`);
  }
});

test('isSafeEntryName:拦掉越界路径与畸形名', () => {
  const bad = [
    '', '/etc/passwd', 'a/', '../x', 'a/../b', 'a/./b', '.', '..',
    'a\\b', withCode(0), withCode(0x1f), withCode(0x7f), 'x'.repeat(301),
  ];
  for (const b of bad) {
    assert.equal(isSafeEntryName(b), false, `应当拦掉:${JSON.stringify(b)}`);
  }
});

test('写出时会拒绝不安全的名字(不能靠调用方自觉)', () => {
  assert.throws(() => zipStore([{ name: '../evil', bytes: enc('x') }], { date: DATE }), ZipError);
  assert.throws(() => zipStore([{ name: '/abs', bytes: enc('x') }], { date: DATE }), ZipError);
});

/* ---------------- 读侧必须严格 ---------------- */

test('读到损坏的内容必须报错,不能返回坏数据', () => {
  const zip = zipStore([{ name: 'cats/秘钥.enc', bytes: enc('hello world') }], { date: DATE });
  // store 不加密,明文就在包里 —— 改一个字节,CRC 必然对不上
  const needle = enc('hello world');
  let at = -1;
  for (let i = 0; i + needle.length <= zip.length; i++) {
    if (needle.every((b, k) => zip[i + k] === b)) { at = i; break; }
  }
  assert.ok(at > 0, '应当能在包里找到明文位置(store 不加密)');
  const broken = zip.slice();
  broken[at] = 0x48; // 'h' → 'H'
  assert.throws(() => readZipStore(broken), /校验失败/, 'CRC 校验必须拦住');
});

test('截断的文件必须报错', () => {
  const zip = zipStore([{ name: 'a.txt', bytes: enc('x'.repeat(100)) }], { date: DATE });
  for (const cut of [1, 10, 22, 40, zip.length - 1]) {
    assert.throws(() => readZipStore(zip.slice(0, cut)), ZipError, `截到 ${cut} 字节应当报错`);
  }
});

test('不是 zip 的输入必须报错,而不是硬解', () => {
  assert.throws(() => readZipStore(enc('this is definitely not a zip file at all')), ZipError);
  assert.throws(() => readZipStore(new Uint8Array(3)), ZipError);
  assert.throws(() => readZipStore(new Uint8Array(30).fill(0x41)), ZipError);
});

test('压缩过的条目一律拒绝(本模块只认自己写出的 store)', () => {
  const zip = zipStore([{ name: 'a.txt', bytes: enc('abc') }], { date: DATE });
  // 单条目:中央目录头 46 字节 + 名字 5 字节,紧挨在 22 字节 EOCD 之前
  const cd = zip.length - 22 - (46 + 5);
  const patched = zip.slice();
  new DataView(patched.buffer).setUint16(cd + 10, 8, true); // method → deflate
  assert.throws(() => readZipStore(patched), /压缩过/, '必须明确拒绝而不是瞎猜');
});

test('条目重复要报错(否则恢复时不知道用哪份)', () => {
  const entries = [
    { name: 'cats/a.enc', bytes: enc('1') },
    { name: 'cats/a.enc', bytes: enc('2') },
  ];
  const zip = zipStore(entries, { date: DATE }); // 写侧允许(结构本身合法)
  assert.throws(() => readZipStore(zip), /重复/, '读侧必须拦住');
});