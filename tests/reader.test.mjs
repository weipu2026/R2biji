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
import { withDom } from './dom-stub.mjs';

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

test('敏感行遮罩:多行段落的非首行也必须遮(与主站 render.js 的 m 标志对齐)', async () => {
  const readerCode = extractBetween(
    mod.READER_TEMPLATE, '/*READER-SCRIPT-START*/', '/*READER-SCRIPT-END*/', 'READER-SCRIPT',
  );
  const rd = await import('data:text/javascript,' + encodeURIComponent(
    readerCode + '\nexport { rdrMd };',
  ));
  // rdrMd 把连续行 join('\n') 合成**一个**段落再交给 rdrInline。
  // 缺 m 标志时 ^...$ 只匹配首行 → 段内第 2 行起的敏感值会明文泄漏。
  const html = rd.rdrMd('这是第一行说明\n密码: sk-leak-777\n第三行普通文字');
  assert.ok(html.includes('class="secret masked"'), '段内第 2 行的敏感值必须被遮罩(缺 m 会漏遮)');
  assert.ok(html.includes('sk-leak-777'), '敏感值仍应在 DOM 里(点击可显形)');
  assert.ok(html.includes('密码: '), '命中行的前缀保留(遮罩 span 跟着它)');
  /* ★ 2026-10-06 审计 P0:旧实现在此提前 return,段内**其余行被整段吞掉**
   *   (非敏感正文丢失 = 离线阅读站「打码即删段」)。此前本用例把该行为钉成
   *   「已知取舍」,理由写的是「主站也是整段交给 renderInline」—— 那条理由在
   *   主站 2026-09-27 改成按行切分之后就已经不成立了,属过期契约,一并纠正。 */
  assert.ok(html.includes('这是第一行说明'), '敏感行之前的正文必须保留');
  assert.ok(html.includes('第三行普通文字'), '敏感行之后的正文必须保留');
});

test('★ 主站 renderInline 与阅读站 rdrInline 必须逐字一致(平行实现不得漂移)', async () => {
  /* 两处是同语义的**两份实现**:主站 DOM 版(render.js)/ 阅读站字符串版(recover.html)。
   * 2026-10-06 的 P0 正是「主站修了按行切分、阅读站没跟」造成的:打码命中后
   * 阅读站把整段正文吞掉。⇒ 同一批文本两边必须产出**逐字相同**的可见文本。
   * ⚠️ 比对对象必须是 renderInline/rdrInline 这一对平行函数:文档级
   *   renderMarkdown().textContent 不含块间换行,而 rdrMd 的 HTML 串含,
   *   直接比整篇会把「块拼接方式」读成「内容不一致」(2026-10-06 踩过)。 */
  const readerCode = extractBetween(
    mod.READER_TEMPLATE, '/*READER-SCRIPT-START*/', '/*READER-SCRIPT-END*/', 'READER-SCRIPT',
  );
  const rd = await import('data:text/javascript,' + encodeURIComponent(
    readerCode + '\nexport { rdrInline, rdrMd };',
  ));
  await withDom(async () => {
    const { renderInline } = await import('../public/js/render.js');
    const cases = [
      '普通一段文字',
      '第一行说明\n密码: sk-leak-777\n第三行普通文字',   // 段内单行敏感(P0 现场)
      '多行\n全部\n敏感\n行',                          // 每行都敏感
      '口令:bbb\n密钥:ccc',                              // 段内多行敏感
      '没有敏感行\n只有换行',
      '正文 **加粗** 与 `代码` 混排\n密码: aaa\n- 不是列表',
      'key: abcdefghijklmnopqrstuvwxyz0123456789',       // 星号上限(>24 截断)
      '密码: 带 空格 的 值',
      'pwd=123456789',
    ];
    const strip = (html) => html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    for (const src of cases) {
      const host = document.createElement('span');
      renderInline(host, src);
      const main = host.textContent;
      const reader = strip(rd.rdrInline(src, true));
      assert.equal(reader, main,
        `两处行内渲染不一致:\n输入:${JSON.stringify(src)}\n主站:${JSON.stringify(main)}\n阅读站:${JSON.stringify(reader)}`);
    }
  });
});

test('★ 主站 renderMarkdown 与阅读站 rdrMd 的可见文本必须一致(块拼接归一后)', async () => {
  const readerCode = extractBetween(
    mod.READER_TEMPLATE, '/*READER-SCRIPT-START*/', '/*READER-SCRIPT-END*/', 'READER-SCRIPT',
  );
  const rd = await import('data:text/javascript,' + encodeURIComponent(readerCode + '\nexport { rdrMd };'));
  await withDom(async () => {
    const { renderMarkdown } = await import('../public/js/render.js');
    // 去掉全部空白后比对:主站 DOM 的 textContent 不含块间分隔,阅读站 HTML 串含 ——
    // 那是**块拼接方式**的差异,不是内容差异(行级细节由上一条 renderInline 用例守住)
    const visible = (s) => s.replace(/\s+/g, '');
    for (const src of [
      '第一行说明\n密码: sk-leak-777\n第三行普通文字',
      '标题一\n密码: aaa\n正文 **加粗** 与 `代码`\n- 列表项',
      '多行\n全部\n敏感\n行',
    ]) {
      assert.equal(
        visible(rd.rdrMd(src).replace(/<[^>]+>/g, '')),
        visible(renderMarkdown(src).textContent),
        `文档级可见文本不一致:${JSON.stringify(src)}`,
      );
    }
  });
});

test('★ 阅读站敏感行点击:双层结构下必须点得开(closest 判据,不是 e.target)', async () => {
  // 背景(2026-09-28 审计 P1,星号双图层引入的回归):遮罩态可见的是 .secret-stars
  // 这个**子 span**,点击事件源的类名是 secret-stars → 直接判 e.target 会永远 return,
  // 值再也点不出来(title 却还写着「点击显示」)。主站 shell.js 用的是同款 closest 判据。
  const readerCode = extractBetween(
    mod.READER_TEMPLATE, '/*READER-SCRIPT-START*/', '/*READER-SCRIPT-END*/', 'READER-SCRIPT',
  );
  const fStart = readerCode.indexOf('function rdrToggleSecret');
  const fEnd = readerCode.indexOf("$('view').addEventListener");
  assert.ok(fStart > 0 && fEnd > fStart, '阅读站点击处理器必须具名(rdrToggleSecret)且有绑定处');
  const toggleSrc = readerCode.slice(fStart, fEnd);
  const rd = await import("data:text/javascript," + encodeURIComponent(
    'const st = { maskTimers: [] };\n' + toggleSrc + '\nexport { rdrToggleSecret, st };',
  ));
  const mk = (cls) => {
    const el = { parent: null, _cls: new Set(cls.split(' ')) };
    el.classList = {
      contains: (c) => el._cls.has(c),
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
    };
    el.closest = (sel) => {
      const want = sel.replace(".", "");
      let n = el;
      while (n) { if (n._cls && n._cls.has(want)) return n; n = n.parent; }
      return null;
    };
    return el;
  };
  const secret = mk('secret masked');
  const stars = mk('secret-stars'); stars.parent = secret;
  const raw = mk('secret-raw'); raw.parent = secret;
  try {
    // 遮罩态:用户点得到的就是星号层
    rd.rdrToggleSecret({ target: stars });
    assert.equal(secret.classList.contains('masked'), false,
      '★ 点星号必须显形(旧实现直接判 e.target 类名 → 永远不动,值点不出来)');
    // 显形态:点真值层 → 遮回
    rd.rdrToggleSecret({ target: raw });
    assert.equal(secret.classList.contains('masked'), true, '显形态点真值层 → 必须遮回');
    // 不在 .secret 里的点击必须被忽略(不能误伤别的元素)
    const other = mk('something-else');
    rd.rdrToggleSecret({ target: other });
    assert.equal(other._cls.has('masked'), false, '★ 非敏感元素不得被加上 masked');
  } finally {
    // 显形会挂一个 30s 的「自动遮回」定时器 —— 不清掉会让 node --test 白等半分钟
    for (const t of rd.st.maskTimers) clearTimeout(t);
  }
});