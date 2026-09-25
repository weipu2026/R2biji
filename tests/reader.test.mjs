/* ============================================================
 * 离线阅读站(recover.html 生成物)交叉验证 —— 纯 Node,零依赖
 *
 * 链路:构造备份包 → decryptBackupPackage → buildReaderSite
 *      → 从生成的 HTML 里抽出阅读站脚本,在 Node 里跑真正的解密,
 *        与 recover.html 侧的实现互证(同一条加密链,两个独立实现)。
 *
 * 关键断言:
 *   1. 生成的 HTML 里零明文泄漏(标题/正文/密文/附件字节/附件原名)
 *   2. 正确密码解锁后目录与原文一致,附件能解回原字节
 *   3. 错误密码/密文篡改必须明确报错
 *   4. Markdown 渲染与主站 render.js 同语法,XSS 一律转义
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, 'public/recover.html'), 'utf8');

function extractBetween(text, startMark, endMark, what) {
  const a = text.indexOf(startMark);
  const b = text.indexOf(endMark);
  assert.ok(a > 0 && b > a, `${what} 标记存在且有序`);
  return text.slice(a, b);
}

const recoverCode = extractBetween(src, '/*RECOVER-SCRIPT-START*/', '/*RECOVER-SCRIPT-END*/', 'RECOVER-SCRIPT');

const mod = await import('data:text/javascript,' + encodeURIComponent(
  recoverCode
    + '\nexport { decryptBackupPackage, buildReaderSite, zipWriteEntries, encryptJmb,'
    + ' wrapDekForReader, deriveContentKeyEnc, deriveAttachKeyEnc, bytesToB64, b64ToBytes, READER_TEMPLATE };',
));

const PW = 'reader-test-密码456';
const ITERS = 2000; // 测试用小迭代数,别拿真实库的 100 万次折磨 CI

async function makeFixture() {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappedDek = await mod.wrapDekForReader(dek, PW, salt, ITERS);
  const vaultJson = {
    magic: 'JMBIJI',
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', salt: mod.bytesToB64(salt), iterations: ITERS },
    wrap: { alg: 'AES-KW', wrappedDek },
  };
  const noteData = {
    notes: [{
      title: '冒烟笔记',
      content: '# API 清单\n\n生产密钥如下:\n\n密码: sk-live-9999\n\n- 项目 **加粗**\n- 第二条',
      createdAt: 1758700000000,
      updatedAt: 1758800000000,
      attachments: [{ file: 'abc123', name: '笔记附件.txt' }],
    }],
    trash: [{ title: '废稿', content: '已删除的内容', createdAt: 1, updatedAt: 2, deletedAt: 3 }],
  };
  const entries = [{
    name: 'vault.json',
    bytes: new TextEncoder().encode(JSON.stringify(vaultJson)),
  }];
  const contentKey = await mod.deriveContentKeyEnc(dek);
  entries.push({
    name: 'cats/工作.enc',
    bytes: await mod.encryptJmb(contentKey, 'JMB1', new TextEncoder().encode(JSON.stringify(noteData))),
  });
  const attBytes = new TextEncoder().encode('hello-attachment-bytes');
  const attachKey = await mod.deriveAttachKeyEnc(dek);
  entries.push({ name: 'blobs/abc123', bytes: await mod.encryptJmb(attachKey, 'JMBB', attBytes) });
  return { zip: mod.zipWriteEntries(entries), noteData, attBytes };
}

async function loadReader(html) {
  const dataJson = JSON.parse(html.match(/<script id="reader-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const blobsJson = JSON.parse(html.match(/<script id="reader-blobs"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const readerCode = extractBetween(html, '/*READER-SCRIPT-START*/', '/*READER-SCRIPT-END*/', 'READER-SCRIPT');
  const rd = await import('data:text/javascript,' + encodeURIComponent(
    readerCode + '\nexport { readerUnlock, rdrMd, rdrOpen, rdrAttachKey, rdrB64ToBytes };',
  ));
  return { dataJson, blobsJson, rd };
}

test('端到端:备份包 → 解密 → 生成阅读站 → 阅读站脚本独立解密互证', async () => {
  const { zip, attBytes } = await makeFixture();
  const result = await mod.decryptBackupPackage(zip, PW);
  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0].name, '工作');
  assert.equal(result.categories[0].data.notes[0].title, '冒烟笔记');
  assert.equal(result.blobs.length, 1);
  assert.equal(result.blobs[0].file, 'abc123');
  assert.deepEqual(new TextDecoder().decode(result.blobs[0].bytes), 'hello-attachment-bytes');

  const site = await mod.buildReaderSite(result, PW, result.vaultInfo);
  assert.ok(site.html.startsWith('<!DOCTYPE html>'), '生成物是完整 HTML');
  assert.ok(site.bytes > 2000, `阅读站体积合理(实际 ${site.bytes})`);
  assert.equal(site.embedded, 1);
  assert.deepEqual(site.skipped, []);

  // ★ 明文零泄漏:标题/密钥/附件字节/附件原名都不允许出现在 HTML 里
  for (const leak of ['冒烟笔记', 'sk-live-9999', 'hello-attachment-bytes', '笔记附件.txt', '废稿']) {
    assert.ok(!site.html.includes(leak), `泄漏检测失败:${leak}`);
  }
  assert.ok(site.html.includes('id="reader-data"'), '数据块存在');
  assert.ok(site.html.includes('id="reader-blobs"'), '附件块存在');

  const { dataJson, blobsJson, rd } = await loadReader(site.html);
  assert.equal(dataJson.nBlobs, 1);
  assert.equal(dataJson.kdf.iterations, ITERS);
  assert.equal(blobsJson.length, 1);
  assert.equal(blobsJson[0].file, 'abc123');

  // 正确密码 → 目录与原文一致
  const un = await rd.readerUnlock(dataJson, PW);
  assert.equal(un.catalog.categories.length, 1);
  assert.equal(un.catalog.categories[0].name, '工作');
  const notes = un.catalog.categories[0].notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, '冒烟笔记');
  assert.ok(notes[0].content.includes('sk-live-9999'));
  assert.equal(un.catalog.categories[0].trash.length, 1);

  // 附件:阅读站侧用同一把 DEK 派生 attach key,解回原字节
  const attKey = await rd.rdrAttachKey(un.dek);
  const plain = await rd.rdrOpen(attKey, 'JMBB', rd.rdrB64ToBytes(blobsJson[0].data));
  assert.deepEqual(new TextDecoder().decode(plain), 'hello-attachment-bytes');
  assert.deepEqual(new Uint8Array(plain), new Uint8Array(attBytes));
});

test('错误密码:解锁必须明确报错,绝不静默', async () => {
  const { zip } = await makeFixture();
  const result = await mod.decryptBackupPackage(zip, PW);
  const site = await mod.buildReaderSite(result, PW, result.vaultInfo);
  const { dataJson, rd } = await loadReader(site.html);
  await assert.rejects(
    () => rd.readerUnlock(dataJson, 'wrong-' + PW),
    /主密码不对/,
  );
  await assert.rejects(() => rd.readerUnlock(dataJson, ''), /主密码不对|数据块/);
});

test('密文被篡改:目录解密必须失败', async () => {
  const { zip } = await makeFixture();
  const result = await mod.decryptBackupPackage(zip, PW);
  const site = await mod.buildReaderSite(result, PW, result.vaultInfo);
  const { dataJson, rd } = await loadReader(site.html);
  const bad = { ...dataJson, catalog: dataJson.catalog.slice(0, -4) + 'AAAA' };
  await assert.rejects(() => rd.readerUnlock(bad, PW), /目录密文|解密失败/);
});

test('附件引用机制:全部嵌入时 skipped 为空,替换 blobs 后计数自洽', async () => {
  const { zip } = await makeFixture();
  const result = await mod.decryptBackupPackage(zip, PW);
  // 预算(READER_BLOB_LIMIT=64MiB)远大于单测附件 → 全嵌入、无跳过
  const site = await mod.buildReaderSite(result, PW, result.vaultInfo);
  assert.equal(site.embedded, 1);
  assert.deepEqual(site.skipped, []);
  // blobs 清空 → 全部不计入(上层 UI 据此把附件标为「未包含」)
  const empty = await mod.buildReaderSite({ ...result, blobs: [] }, PW, result.vaultInfo);
  assert.equal(empty.embedded, 0);
  assert.deepEqual(empty.skipped, []);
});

test('Markdown 渲染与主站同语法,敏感行遮罩,XSS 一律转义', async () => {
  // 注意:必须从 READER_TEMPLATE 的「值」(已做模板转义)里抽取,
  // 不能从 recover.html 源码里直接切 —— 那拿到的是未转义的模板原文
  const readerCode = extractBetween(
    mod.READER_TEMPLATE, '/*READER-SCRIPT-START*/', '/*READER-SCRIPT-END*/', 'READER-SCRIPT',
  );
  const rd = await import('data:text/javascript,' + encodeURIComponent(
    readerCode + '\nexport { rdrMd, rdrEsc, rdrInline };',
  ));

  const html = rd.rdrMd(
    '# 标题一\n\n## 标题二\n\n- 项目 **加粗**\n- *斜体* ~~删除~~ ==高亮== `code`\n\n1. 有序\n2. 第二\n\n```\nraw <b>&\n```\n\n密码: sk-abc123',
  );
  assert.ok(html.includes('<h1>标题一</h1>'), 'h1');
  assert.ok(html.includes('<h2>标题二</h2>'), 'h2');
  assert.ok(html.includes('<strong>加粗</strong>'), '加粗');
  assert.ok(html.includes('<em>斜体</em>'), '斜体');
  assert.ok(html.includes('<del>删除</del>'), '删除线');
  assert.ok(html.includes('<mark>高亮</mark>'), '高亮');
  assert.ok(html.includes('<code>code</code>'), '行内代码');
  assert.ok(html.includes('<ol>'), '有序列表');
  assert.ok(html.includes('<pre><code>raw &lt;b&gt;&amp;</code></pre>'), '代码块转义');
  assert.ok(html.includes('class="secret masked"'), '敏感行默认遮罩');
  assert.ok(html.includes('sk-abc123'), '敏感值在 DOM 里(点击显形)');

  const xss = rd.rdrMd('<script>alert(1)</scr' + 'ipt>\n密码: <img src=x onerror=alert(1)>');
  assert.ok(!xss.includes('<script'), 'script 标签必须被转义');
  assert.ok(!xss.includes('<img'), 'img 标签必须被转义');
  assert.ok(xss.includes('&lt;img'), '转义后以文本呈现');
});
