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

test('条目重复要报错(写侧直接炸,读侧也要拦住被改坏的包)', () => {
  const entries = [
    { name: 'cats/a.enc', bytes: enc('1') },
    { name: 'cats/a.enc', bytes: enc('2') },
  ];
  /* ★ 写侧必须当场报错(2026-10-17 审计 P2):旧行为是「照写、让读侧兜」,
   *   可这张包是用来恢复全库的 —— 写出来自己都读不回来的包,等于到恢复那天
   *   才发现。要么当场炸,要么保证可读,没有第三条路。 */
  assert.throws(() => zipStore(entries, { date: DATE }), /重复/, '写侧必须拦住');

  /* 读侧守卫仍要独立成立:拿一个合法包,把第二个条目的名字在字节层面改成
   * 与第一个相同(本地头与中央目录各一处),模拟「被改坏/被拼接」的包。 */
  const zip = zipStore([
    { name: 'cats/a.enc', bytes: enc('1') },
    { name: 'cats/b.enc', bytes: enc('2') },
  ], { date: DATE });
  const from = enc('cats/b.enc');
  const to = enc('cats/a.enc');
  let hits = 0;
  for (let i = 0; i + from.length <= zip.length; i++) {
    if (from.every((b, k) => zip[i + k] === b)) {
      zip.set(to, i);
      hits += 1;
      i += from.length - 1;
    }
  }
  assert.equal(hits, 2, '名字应在本地头与中央目录各出现一次');
  assert.throws(() => readZipStore(zip), /重复/, '读侧必须拦住');
});
/* ---------------- 2026-10-17 审计 P2:写出/读入加固 ---------------- */

/** 读第一个条目本地头的 DOS 日期字(年 = (v>>9)+1980,月 = (v>>5)&0xf,日 = v&0x1f) */
function firstDosDate(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  return dv.getUint16(12, true);
}

test('写端:bytes 缺失或类型不对必须当场报错(不能静默写成 0 字节条目)', () => {
  for (const bad of [undefined, null, 'abc', 42, {}]) {
    assert.throws(
      () => zipStore([{ name: 'vault.json', bytes: bad }], { date: DATE }),
      ZipError,
      `bytes=${String(bad)} 必须拒绝`,
    );
  }
  /* 0 字节本身是合法的(空文件 / 空 blob 就是),不能连它也拦 —— 只能按类型判。 */
  assert.doesNotThrow(() => zipStore([{ name: 'blobs/empty', bytes: new Uint8Array(0) }], { date: DATE }));
  /* ArrayBuffer 也是合法输入(调用方可能直接从 arrayBuffer 拿来) */
  const buf = new ArrayBuffer(3);
  new Uint8Array(buf).set([1, 2, 3]);
  const back = readZipStore(zipStore([{ name: 'a.bin', bytes: buf }], { date: DATE }));
  assert.deepEqual(back[0].bytes, new Uint8Array([1, 2, 3]));
});

test('日期:无效 Date 退回 1980-01-01,超出 2107 夹到 2107', () => {
  /* 旧写法:NaN << 9 得 0 → 写出「1980 年 0 月 0 日」这种非法 DOS 日期 */
  const bad = firstDosDate(zipStore([{ name: 'a', bytes: enc('x') }], { date: new Date('不是日期') }));
  assert.equal((bad >> 9) + 1980, 1980, '无效日期必须退回 1980 年');
  assert.equal((bad >> 5) & 0xf, 1, '月份不能是 0');
  assert.equal(bad & 0x1f, 1, '日不能是 0');
  assert.equal(readZipStore(zipStore([{ name: 'a', bytes: enc('x') }], { date: new Date('x') })).length, 1,
    '无效日期仍要写出可读的包');
  /* DOS 日期年字段只有 7 位:2200 会被 setUint16 静默截断成 1980 */
  const far = firstDosDate(zipStore([{ name: 'a', bytes: enc('x') }], { date: new Date(2200, 0, 1) }));
  assert.equal((far >> 9) + 1980, 2107, '2200 年必须夹到 2107');
});

test('读端:EOCD 只认「注释长度正好收到文件尾」的那一个(注释里撞上假签名不算)', () => {
  const base = zipStore([{ name: 'vault.json', bytes: enc('{"magic":"JMBIJI"}') }], { date: DATE });
  /* 给真 EOCD 挂 40 字节注释,注释开头塞一个假 EOCD(声称 7 条、目录 999 字节)。
   * 旧写法从尾部往前扫,**第一个命中的签名**就是它 → 按垃圾字段解析 → 报
   * 「中央目录越界」这种误导错误;新写法用「22 + 注释长度 == 文件尾」把它筛掉。 */
  const COMMENT = 40;
  const out = new Uint8Array(base.length + COMMENT);
  out.set(base);
  const fv = new DataView(out.buffer);
  fv.setUint32(base.length, 0x06054b50, true); // 假签名
  fv.setUint16(base.length + 8, 7, true);      // 声称 7 个条目
  fv.setUint32(base.length + 12, 999, true);   // cdSize 垃圾
  fv.setUint32(base.length + 16, 999, true);   // cdOffset 垃圾
  fv.setUint16(base.length + 20, 0, true);     // 它声称没注释 → 收不到文件尾
  fv.setUint16(base.length - 22 + 20, COMMENT, true); // 真 EOCD 的注释长度
  const back = readZipStore(out);
  assert.deepEqual(back.map((e) => e.name), ['vault.json'], '必须认回真 EOCD');
});

test('读端:条目名长度越界要说清楚,不能靠 subarray 静默截短', () => {
  const zip = zipStore([{ name: 'cats/a.enc', bytes: enc('1') }], { date: DATE });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  /* 中央目录头在 EOCD 记录的 cdOffset 处;nameLen 在头内偏移 28 */
  const eocd = zip.length - 22;
  const cdOffset = dv.getUint32(eocd + 16, true);
  dv.setUint16(cdOffset + 28, 0xffff, true);
  assert.throws(() => readZipStore(zip), /条目名越界/, '必须点名是名字越界');
});

test('读端:中央目录必须刚好用尽(count 被改小不能静默少读)', () => {
  const zip = zipStore([
    { name: 'vault.json', bytes: enc('{}') },
    { name: 'cats/a.enc', bytes: enc('1') },
  ], { date: DATE });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  /* 条目数字段在 EOCD 偏移 8/10;改小后旧写法只读 1 条就收工,恢复时静默少文件 */
  dv.setUint16(zip.length - 22 + 8, 1, true);
  dv.setUint16(zip.length - 22 + 10, 1, true);
  assert.throws(() => readZipStore(zip), /中央目录与条目数不符/, '必须拦住');
});
