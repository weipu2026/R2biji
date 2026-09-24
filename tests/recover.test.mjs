/* ============================================================
 * recover.html 交叉验证 —— 应急解密页必须能打开自家导出的备份包
 *
 * 为什么单独测:recover.html 是**单文件**(内联脚本,双击即用,不允许拆模块),
 * 它的解密逻辑与 public/js/crypto.js / vaultlib.js 是两份实现。
 * 两份实现各自演进而不对账,哪天格式变了、解密页悄悄废了,等 CF 出事那天
 * 用户才发现打不开 —— 这是绝对不能发生的静默失效。
 *
 * 做法:从 recover.html 抠出内联脚本(纯逻辑段,不碰 DOM),以 data: 模块
 * 在 Node 里加载;fixture 用**项目自身的** crypto/vaultlib/zip 真实生成,
 * 两边互为对照。任何一边改了格式而另一边没跟上,这里立刻翻红。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { createVault, deriveAllKeys, encryptCategory, encryptBlob, blobFileNameFor } from '../public/js/vaultlib.js';
import { zipStore, readZipStore } from '../public/js/zip.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

/* ---------- 从 recover.html 抠出内联脚本并加载为模块 ---------- */

const html = readFileSync(join(PUBLIC, 'recover.html'), 'utf8');
const scriptMatch = /\/\*RECOVER-SCRIPT-START\*\/([\s\S]*?)\/\*RECOVER-SCRIPT-END\*\//.exec(html);
assert.ok(scriptMatch, 'recover.html 里必须有 RECOVER-SCRIPT-START/END 标记(测试靠它抽脚本)');
const recover = await import(
  'data:text/javascript;charset=utf-8,'
  + encodeURIComponent(
    scriptMatch[1]
    + '\nexport { readZipEntries, decryptBackupPackage, categoryToMd, buildExportEntries, sanitizeEntryName, zipWriteEntries };',
  )
);

/* ---------- fixture:用项目自身代码造一份真实备份 ---------- */

const PASSWORD = 'test-pass-12345678';
const ATTACH_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const ATTACH2_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 42, 42, 42]);

const fixture = await (async () => {
  const { json, dek } = await createVault(PASSWORD);
  const keys = await deriveAllKeys(dek);
  const now = Date.now();

  const blob1 = await blobFileNameFor(keys.filenameKey, ATTACH_BYTES, '截图 说明.png');
  const blob2 = await blobFileNameFor(keys.filenameKey, ATTACH2_BYTES, '未引用.dat');
  const encBlob1 = await encryptBlob(keys.attachKey, ATTACH_BYTES);
  const encBlob2 = await encryptBlob(keys.attachKey, ATTACH2_BYTES);

  const catWork = {
    notes: [
      {
        id: 'n1', title: '会议纪要', order: 1000, createdAt: now, updatedAt: now,
        content: '# 标题\n\n- 行 A\n- 行 B',
        attachments: [{ file: blob1, name: '截图 说明.png' }],
      },
      {
        id: 'n2', title: '密码学：<敏感>', order: 2000, createdAt: now, updatedAt: now,
        content: 'api_key=abc123', attachments: [],
      },
    ],
    trash: [
      { id: 't1', title: '已删的草稿', content: '废稿内容', createdAt: now, updatedAt: now, deletedAt: now, attachments: [] },
    ],
  };
  const catSecret = {
    notes: [{ id: 'n3', title: '服务器', order: 1000, createdAt: now, updatedAt: now, content: 'ssh root@1.2.3.4', attachments: [] }],
    trash: [],
  };

  const entries = [
    { name: 'vault.json', bytes: new TextEncoder().encode(JSON.stringify(json, null, 2)) },
    { name: 'cats/工作.enc', bytes: await encryptCategory(keys.contentKey, catWork) },
    { name: 'cats/密码本.enc', bytes: await encryptCategory(keys.contentKey, catSecret) },
    { name: `blobs/${blob1}`, bytes: encBlob1 },
    { name: `blobs/${blob2}`, bytes: encBlob2 },
  ];
  return { zipBytes: zipStore(entries), blob1, blob2, catWork, catSecret, keys };
})();

/* ---------- 用例 ---------- */

test('主流程:备份包 + 正确密码 → 分类/笔记/附件全部解出', async () => {
  const r = await recover.decryptBackupPackage(fixture.zipBytes, PASSWORD);
  assert.equal(r.failures.length, 0, `不应有失败项:${r.failures.join(';')}`);
  assert.deepEqual(r.categories.map((c) => c.name), ['工作', '密码本']);

  const work = r.categories[0].data;
  assert.equal(work.notes.length, 2);
  assert.equal(work.notes[0].title, '会议纪要');
  assert.equal(work.notes[0].content, fixture.catWork.notes[0].content);
  assert.equal(work.trash.length, 1);
  assert.equal(work.trash[0].title, '已删的草稿');

  // 附件按笔记里的原名导出
  assert.equal(r.attachments.length, 2);
  assert.equal(r.attachments[0].name, '截图 说明.png');
  assert.deepEqual([...r.attachments[0].bytes], [...ATTACH_BYTES]);
  // 未被任何笔记引用的附件回落到内容寻址名
  assert.equal(r.attachments[1].name, fixture.blob2);
});

test('错误密码:明确报「主密码不对」,不得有半点含糊', async () => {
  await assert.rejects(
    () => recover.decryptBackupPackage(fixture.zipBytes, 'wrong-password-xyz'),
    /主密码不对/,
  );
});

test('不是本应用的包:缺 vault.json 直接拒绝', async () => {
  const fake = zipStore([{ name: 'readme.txt', bytes: new TextEncoder().encode('hello') }]);
  await assert.rejects(() => recover.decryptBackupPackage(fake, PASSWORD), /vault\.json/);
});

test('不是 zip:结构级报错', async () => {
  await assert.rejects(
    () => recover.decryptBackupPackage(new TextEncoder().encode('this is not a zip at all........'), PASSWORD),
    /zip/,
  );
});

test('别的工具重新压缩过(deflate)的包:照样能解', async () => {
  // 用 zlib 把 vault.json 以 deflate 塞进一个标准 zip,覆盖 DecompressionStream 路径
  const raw = new TextEncoder().encode(JSON.stringify({ magic: 'JMBIJI', version: 1 }));
  const zip = zipDeflate([{ name: 'vault.json', bytes: raw }]);
  const { entries } = await recover.readZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.deepEqual([...entries[0].bytes], [...raw]);
});

test('categoryToMd:标题/正文/回收站段齐全', async () => {
  const md = recover.categoryToMd('工作', fixture.catWork);
  assert.match(md, /^# 工作/);
  assert.match(md, /## 会议纪要/);
  assert.match(md, /- 行 A/);
  assert.match(md, /回收站（1 篇）/);
  assert.match(md, /## 已删的草稿/);
  assert.match(md, /废稿内容/);
});

test('buildExportEntries:产出的 zip 用项目 readZipStore 能读回且内容正确', async () => {
  const r = await recover.decryptBackupPackage(fixture.zipBytes, PASSWORD);
  const exportEntries = recover.buildExportEntries(r);
  const names = exportEntries.map((e) => e.name);
  assert.ok(names.includes('README.txt'));
  assert.ok(names.includes('notes/工作.md'));
  assert.ok(names.includes('notes/密码本.md'));
  assert.ok(names.includes('notes/all-notes.json'));
  assert.ok(names.includes('attachments/截图 说明.png'));

  // 项目自身的读实现必须能读回(两套 zip 实现互证)
  const readBack = readZipStore(recover.zipWriteEntries(exportEntries));
  const byName = new Map(readBack.map((e) => [e.name, e.bytes]));
  const workMd = new TextDecoder().decode(byName.get('notes/工作.md'));
  assert.match(workMd, /## 会议纪要/);
  const dump = JSON.parse(new TextDecoder().decode(byName.get('notes/all-notes.json')));
  assert.equal(dump.categories['工作'].notes[0].title, '会议纪要');
  assert.equal(dump.categories['工作'].trash.length, 1);
  assert.deepEqual([...byName.get('attachments/截图 说明.png')], [...ATTACH_BYTES]);
});

test('sanitizeEntryName:路径/控制字符/空名全部挡住', () => {
  assert.equal(recover.sanitizeEntryName('a/b\\c.txt'), 'c.txt');
  assert.equal(recover.sanitizeEntryName('bad\x00name\x1f.md'), 'badname.md');
  assert.equal(recover.sanitizeEntryName(''), '未命名');
  assert.equal(recover.sanitizeEntryName('..'), '未命名');
  assert.equal(recover.sanitizeEntryName('正常名字-123.png'), '正常名字-123.png');
});

test('zipWriteEntries:中文名/多条目与项目 zipStore 产出等价可读', () => {
  const entries = [
    { name: 'notes/分类甲.md', bytes: new TextEncoder().encode('# 甲') },
    { name: 'notes/分类乙.md', bytes: new TextEncoder().encode('# 乙') },
  ];
  const readBack = readZipStore(recover.zipWriteEntries(entries));
  assert.deepEqual(readBack.map((e) => e.name), ['notes/分类甲.md', 'notes/分类乙.md']);
  assert.equal(new TextDecoder().decode(readBack[0].bytes), '# 甲');
});

/* ---------- 辅助:标准 deflate zip 打包(测试专用) ---------- */

function zipDeflate(entries) {
  const te2 = new TextEncoder();
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = te2.encode(e.name);
    const cdata = deflateRawSync(e.bytes);
    const crc = recoverZipCrc(e.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true); // deflate
    lv.setUint32(14, crc, true);
    lv.setUint32(18, cdata.length, true);
    lv.setUint32(22, e.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, cdata);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, cdata.length, true);
    cv.setUint32(24, e.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + cdata.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...centrals, eocd];
  const total = all.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of all) { out.set(a, off); off += a.length; }
  return out;
}

function recoverZipCrc(bytes) {
  // 复用 recover.html 内联脚本里的 crc32 —— 不导出,这里自己算
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
