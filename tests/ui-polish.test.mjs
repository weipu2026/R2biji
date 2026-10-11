/* ============================================================
 * 2026-10-11 UI / 功能批次护栏
 *
 * 判据风格沿用 assets.test.mjs:能用「把函数从源码里抠出来真跑一遍」的就别用
 * 「文件里出现过某字符串」—— 后者在反向探针下常被证明是假绿(掏空函数体只留名字,断言照样绿)。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUB = join(ROOT, 'public');
/** 读 public/ 下的文件并把行尾归一成 LF —— 仓库文件是 CRLF,
 *  多行正则里写 \n 会在 CRLF 上静默不命中(2026-10-11 实测:#8 断言因此假红)。 */
const read = (p) => readFileSync(join(PUB, p), 'utf8').split('\r\n').join('\n');

const css = read('css/style.css');
const noteJs = read('js/features/note.js');
const sidebarJs = read('js/features/sidebar.js');
const uiJs = read('js/ui.js');
const shellJs = read('js/features/shell.js');
const lockJs = read('js/features/lock.js');
const indexHtml = read('index.html');

/* ---------- A1 焦点圈覆盖 ---------- */

test('A1:可聚焦的非按钮元素都必须有焦点圈', () => {
  /* 这 5 类都是「能被 Tab 到达、但不是 .btn/.icon-btn」的元素:
   *   .cat-item / .note-item / .search-item —— clickable() 装的 role=option + tabIndex=0
   *   .att-chip —— 是 <button>,但 class 不含 .btn,所以按钮那条通用规则漏掉它
   *   .secret  —— render.js 给的 tabindex=0 + role=button
   * ⚠️ 将来新增这类「自定义可聚焦元素」时,必须同时加进 style.css 的焦点规则。 */
  for (const cls of ['.cat-item', '.note-item', '.search-item', '.att-chip', '.secret']) {
    assert.match(css, new RegExp(`\\${cls}:focus-visible`),
      `style.css 缺少 ${cls}:focus-visible —— Tab 到它身上看不到任何焦点`);
  }
  // 且这条规则必须真的给出可见样式(不能是空壳规则)
  const block = /\.[^{}]*\.secret:focus-visible[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(block, '必须存在含 .secret:focus-visible 的规则');
  assert.match(block[1], /outline:\s*2px/, '规则体必须真的给出 outline:2px');
});

test('A1:焦点圈不得用 box-shadow(会吃掉列表行选中态的左侧内条)', () => {
  // .cat-item.active 靠 box-shadow: inset 3px 0 0 var(--accent) 画黛蓝条;
  // 焦点规则若也用 box-shadow,整条 box-shadow 会被后写的值覆盖 → 内条消失。
  assert.doesNotMatch(css, /\.cat-item:focus-visible[^{]*\{[^}]*box-shadow/,
    '.cat-item:focus-visible 不得用 box-shadow(必须走 outline)');
  assert.doesNotMatch(css, /\.note-item:focus-visible[^{]*\{[^}]*box-shadow/,
    '.note-item:focus-visible 不得用 box-shadow(必须走 outline)');
});

/* ---------- A2 窄屏空状态 ---------- */

test('A2:窄屏判定是纯函数,且缺 matchMedia 时安全回落', () => {
  const src = /function isNarrowViewport\(\)\s*\{[\s\S]*?\n\}/.exec(uiJs);
  assert.ok(src, 'ui.js 里必须能取出 isNarrowViewport');
  const make = new Function('window', `${src[0]}\n; return isNarrowViewport;`);
  assert.equal(make({ matchMedia: () => ({ matches: true }) })(), true, '窄屏应判 true');
  assert.equal(make({ matchMedia: () => ({ matches: false }) })(), false, '宽屏应判 false');
  assert.equal(make({})(), false, '缺 matchMedia 时必须回落 false,不能抛');
});

test('A2:三处指向「左侧」的空态都补了窄屏提示,且 CSS 有 .empty-sub', () => {
  assert.match(css, /\.empty-sub\s*\{/, 'CSS 必须有 .empty-sub 样式');
  assert.match(sidebarJs, /showEmpty\('从左侧选择一个分类',[^)]*点左上角/, '未选分类的空态缺窄屏提示');
  assert.match(noteJs, /showEmpty\('从左侧选择一条笔记',[^)]*点左上角/, '未选笔记的空态缺窄屏提示');
  assert.match(uiJs, /'点左上角的菜单按钮打开分类列表'/, '载入失败的空态缺窄屏提示');
});

/* ---------- A3 编辑底栏 ---------- */

test('A3:编辑底栏可换行,且窄屏收起 PC 专属提示', () => {
  const foot = /\.edit-foot\s*\{([^}]*)\}/.exec(css);
  assert.ok(foot, '必须能解析出 .edit-foot');
  assert.match(foot[1], /flex-wrap:\s*wrap/, '.edit-foot 必须 flex-wrap:wrap(窄屏 6 个元素会溢出)');
  const mq = /@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(mq, '必须存在窄屏媒体查询');
  assert.match(mq[1], /\.edit-hint\s*\{[^}]*display:\s*none/, '窄屏必须收起 .edit-hint(手机上 Ctrl+S/Ctrl+V 是噪音)');
});

/* ---------- A4 触控目标 ---------- */

test('A4:触屏下的图标按钮被放大到 ≥34px', () => {
  const hover = /@media \(hover: none\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(hover, '必须存在 (hover:none) 媒体查询');
  const body = hover[1];
  const pick = (re, label) => {
    const m = re.exec(body);
    assert.ok(m, `(hover:none) 里解析不出 ${label}`);
    return Number(m[1]);
  };
  assert.ok(pick(/\.icon-btn\s*\{\s*width:\s*(\d+)px/, '.icon-btn 宽度') >= 34, '.icon-btn 触屏应 ≥34px');
  assert.ok(pick(/\.foot-icon\s*\{\s*height:\s*(\d+)px/, '.foot-icon 高度') >= 34, '.foot-icon 触屏应 ≥34px');
  assert.ok(pick(/\.top-theme\s*\{\s*width:\s*(\d+)px/, '.top-theme 宽度') >= 34, '.top-theme 触屏应 ≥34px');
});

/* ---------- A5 滚动定位 ---------- */

test('A5:scrollActiveNoteIntoView 真的把选中项滚进视野,缺能力时安全跳过', () => {
  const src = /function scrollActiveNoteIntoView\(ctx\)\s*\{[\s\S]*?\n\}/.exec(sidebarJs);
  assert.ok(src, 'sidebar.js 里必须能取出 scrollActiveNoteIntoView');
  const fn = new Function(`${src[0]}\n; return scrollActiveNoteIntoView;`)();
  let seen = null;
  fn({ dom: { byId: () => ({ querySelector: () => ({ scrollIntoView: (o) => { seen = o; } }) }) } });
  assert.deepEqual(seen, { block: 'nearest' }, '必须用 block:nearest 滚进视野');
  // 没有选中项 / ul 缺方法(离线替身)时不得抛
  assert.doesNotThrow(() => fn({ dom: { byId: () => ({ querySelector: () => null }) } }));
  assert.doesNotThrow(() => fn({ dom: { byId: () => ({}) } }));
});

test('A5:openNote 与 openCategory 都接上了滚动', () => {
  assert.match(sidebarJs, /renderNoteList\(ctx\);\n\s*scrollActiveNoteIntoView\(ctx\)/, 'openNote 必须滚动到选中项');
  const n = (sidebarJs.match(/scrollActiveNoteIntoView\(ctx\)/g) || []).length;
  assert.ok(n >= 3, `调用点至少 3 处(定义 + openNote + openCategory),实际 ${n}`);
});

/* ---------- A6 附件灯箱 ---------- */

test('A6:图片附件可点开放大,并有 .lightbox 样式', () => {
  assert.match(css, /\.lightbox\s*\{/, 'CSS 必须有 .lightbox');
  assert.match(css, /\.lightbox img\s*\{[^}]*max-height/, '.lightbox img 必须给高度上限,否则撑爆弹窗');
  assert.match(noteJs, /async function openLightbox\(/, 'note.js 必须有 openLightbox');
  assert.match(noteJs, /img\.addEventListener\('click', \(\) => openLightbox\(ctx, att, url\)\)/, '图片必须绑上灯箱点击');
});

/* ---------- B1 快速隐藏 ---------- */

/** 取 Ctrl/⌘+Shift+L 那个 if 的**整条语句**(含条件与结尾 }` )。
 *  ⚠️ 别再用 `[^}]*` 取分支体:分支体里 `lockNow({ confirmDiscard: false })` 本身就带
 *     花括号,`[^}]*` 会在那里提前截断,断言随即假红(2026-10-11 实测)。 */
function bossKeySeg() {
  const m = /\n    if \(\(e\.ctrlKey \|\| e\.metaKey\) && e\.shiftKey[\s\S]*?\n    \}/.exec(shellJs);
  assert.ok(m, '必须能定位 Ctrl/⌘+Shift+L 分支(且必须显式要求 shiftKey,否则会抢 Ctrl+L)');
  return m[0];
}

test('B1:Ctrl/⌘+Shift+L 锁定:要求 shiftKey、confirmDiscard:false、锁完如实告知', () => {
  const seg = bossKeySeg();
  assert.match(seg, /preventDefault\(\)/, '必须 preventDefault');
  /* 必须传 confirmDiscard:false —— lockNow 默认在有未保存改动时弹确认框,而那个框
   * 唯一的「取消」分支就是**不锁定**:在「有人走过来」的当口把正文继续留在屏幕上,
   * 恰恰把老板键废掉。所以这不是「可选优化」,是功能成立的前提。 */
  assert.match(seg, /ctx\.lockNow\(\{\s*confirmDiscard:\s*false\s*\}\)/,
    '老板键必须传 confirmDiscard:false,否则会被确认框拦住');
  assert.match(seg, /n\s*>\s*0\s*&&\s*ctx\.toast\(/,
    '有未保存改动时(n > 0)锁完必须**如实告知**被放弃的改动,不能静默丢数据');
});

test('B1:ui.js 的 lockNow 包装器必须透传选项(否则 confirmDiscard 被静默吞掉)', () => {
  const w = /lockNow:\s*\(([^)]*)\)\s*=>\s*lockNow\(ctx([^)]*)\)/.exec(uiJs);
  assert.ok(w, 'ui.js 里必须能定位 lockNow 包装器');
  assert.ok(w[1].trim() !== '', '包装器必须接收选项参数,不能写成 () =>');
  assert.match(w[2], /,\s*(opt|options)\b/, '必须把选项传给 lockNow(ctx, opt)');
});

test('B1:lockNow 回传被放弃的未保存分类数(真跑一遍,并验证取样在清空之前)', async () => {
  const src = /export async function lockNow\(ctx, \{[\s\S]*?\n\}/.exec(lockJs);
  assert.ok(src, '必须能取出 lockNow 的函数体');
  /* 真跑一次。替身里 releaseSession 模拟 clearAllDirty(**把 dirty 清空**)——
   * 取样点若被挪到清空之后,返回值会变成 0,这条断言就会翻红。 */
  let dirtySize = 2;
  const get = (k) => (k === 'dirty' ? { size: dirtySize }
    : k === 'savePromise' ? Promise.resolve()
    : undefined);
  const ctx = {
    store: { get, set: () => {} },
    saveAll: () => Promise.resolve(),
    stopIdleTimer: () => {},
    api: {}, session: {},
  };
  const releaseSession = () => { dirtySize = 0; };   // ← 等价于 clearAllDirty
  const showLock = () => {};
  const body = src[0].replace(/^export\s+/, '');      // new Function 里不能有 export
  const lockNow = new Function('releaseSession', 'showLock', `${body}\n; return lockNow;`)(releaseSession, showLock);
  const dropped = await lockNow(ctx, { confirmDiscard: false });
  assert.equal(dropped, 2, `必须回传「清空前」的未保存分类数(实际拿到 ${dropped})`);
  // 顺带证明替身本身是真的清了(dirty 已被 releaseSession 归零)
  assert.equal(dirtySize, 0, '替身的 releaseSession 必须真的清空 dirty,否则上一条断言无判别力');
});

/* ---------- B4 非图片附件 ---------- */

test('B4:isImageName 只看扩展名,大小写无关,无扩展名不崩', () => {
  const extSrc = /const IMAGE_EXT = new Set\(\[[^\]]*\]\);/.exec(noteJs);
  const fnSrc = /function isImageName\(name\)\s*\{[\s\S]*?\n\}/.exec(noteJs);
  assert.ok(extSrc && fnSrc, '必须能取出 IMAGE_EXT 与 isImageName');
  const isImageName = new Function(`${extSrc[0]}\n${fnSrc[0]}\n; return isImageName;`)();
  assert.equal(isImageName('a.PNG'), true, '大写扩展名也要认');
  assert.equal(isImageName('照片.jpeg'), true);
  assert.equal(isImageName('data.pdf'), false, 'PDF 不是图片');
  assert.equal(isImageName('note.md'), false);
  assert.equal(isImageName('没有扩展名'), false, '无扩展名不得崩,按非图处理');
});

test('B4:guessMime 认得常见非图类型,未知回落 octet-stream', () => {
  const src = /function guessMime\(name\)\s*\{[\s\S]*?\n\}/.exec(noteJs);
  assert.ok(src, '必须能取出 guessMime');
  const guessMime = new Function(`${src[0]}\n; return guessMime;`)();
  assert.equal(guessMime('x.pdf'), 'application/pdf');
  assert.equal(guessMime('x.zip'), 'application/zip');
  assert.equal(guessMime('x.png'), 'image/png');
  assert.equal(guessMime('x.unknownext'), 'application/octet-stream');
});

test('B4:附件入口放开类型限制,chip 按类型分流', () => {
  assert.doesNotMatch(indexHtml, /id="attInput"[^>]*accept=/, '#attInput 不得再限 image/*');
  assert.match(noteJs, /if \(isImg\) toggleAttachmentImage\(ctx, att, chip\);\n\s*else downloadAttachment\(ctx, att\);/,
    '图片走预览、其余走下载');
  assert.match(uiJs, /file: '<svg/, '图标表必须有 file 图标');
  assert.match(shellJs, /f\.type\.startsWith\('image\/'\)/, '粘贴仍只接图片(剪贴板里本来也只有图片文件)');
});
