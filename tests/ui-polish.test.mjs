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
const dataJs = read('js/features/data.js');

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
  // ★ 2026-10-11 审计 P3:promise 链必须有 .catch,否则 lockNow 抛错会冒泡成 unhandledrejection
  assert.match(seg, /\.catch\(/, '老板键的 promise 链必须有 .catch(不能裸 .then)');
});

test('B1:老板键必须排在「有弹窗打开就 return」的全局守卫之前(紧急时刻也能锁)', () => {
  /* ★ 2026-10-11 审计 P2:老板键的核心场景是「有人走过来」的紧急时刻,而那一刻屏幕上
   *   完全可能正开着弹窗(回收站/版本历史/密码生成器)。此前它排在 dialog[open] 守卫
   *   之后 → 被静默拦掉,等于最需要它的时候失效。showLock 内部本就会 dlg.close()。 */
  const iBoss = shellJs.indexOf("e.shiftKey && e.key.toLowerCase() === 'l'");
  const iGuard = shellJs.indexOf("document.querySelector('dialog[open]')");
  assert.ok(iBoss > -1, '必须能定位老板键判定');
  assert.ok(iGuard > -1, '必须能定位 dialog[open] 全局守卫');
  assert.ok(iBoss < iGuard, '老板键必须在 dialog[open] 守卫**之前** —— 否则弹窗开着时它不生效');
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

test('B4:isImageName 以 guessMime 为单一来源(不再另存扩展名表)', () => {
  /* ★ 2026-10-11 审计 P3:此前 isImageName 自带 IMAGE_EXT 集合,与 guessMime 的图片段是
   *   「同一语义两处实现」——改一处忘另一处就会错配。现收敛:凡 MIME 以 image/ 开头即图片。 */
  const fnSrc = /function isImageName\(name\)\s*\{[\s\S]*?\n\}/.exec(noteJs);
  const mimeSrc = /function guessMime\(name\)\s*\{[\s\S]*?\n\}/.exec(noteJs);
  assert.ok(fnSrc && mimeSrc, '必须能取出 isImageName 与 guessMime');
  assert.doesNotMatch(noteJs, /const IMAGE_EXT/, '不得再另存 IMAGE_EXT —— 同一语义两处实现');
  assert.match(fnSrc[0], /guessMime\(/, 'isImageName 必须基于 guessMime 判定');
  const isImageName = new Function(`${mimeSrc[0]}\n${fnSrc[0]}\n; return isImageName;`)();
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

/* ==================== 2026-10-11 审计修复的护栏 ==================== */

test('A1(反向扫描):凡 <button> 的自定义类都必须有焦点圈', () => {
  /* ★ 审计 P3:此前 A1 是**硬编码列举** 5 个类 —— 于是 .blk-copy 这种「是 <button>、
   *   class 不含 .btn」的漏网永远扫不到(它确实漏了)。改反向扫描:从源码里抠出所有
   *   「createElement('button') 之后紧跟的 className」,逐个要求 CSS 里有焦点规则。 */
  const classes = new Set();
  const re = /createElement\('button'\)[\s\S]{0,240}?className\s*=\s*'([^']+)'/g;
  for (const f of ['js/features/note.js', 'js/features/sidebar.js', 'js/features/shell.js', 'js/ui.js']) {
    const src = read(f);
    let m;
    while ((m = re.exec(src))) classes.add(m[1].split(/\s+/)[0]);
  }
  assert.ok(classes.size >= 2, `反向扫描应至少扫到 2 个按钮类(实际 ${classes.size})—— 正则失效会静默漏检`);
  for (const cls of classes) {
    if (cls === 'btn') continue;   // .btn 系列已由 style.css 的通用焦点规则覆盖
    const safe = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // 拼进 RegExp 必须转义
    assert.match(css, new RegExp(`\\.${safe}:focus`),
      `按钮类 .${cls} 没有焦点规则 —— Tab 到它身上看不到焦点`);
  }
});

test('A1:.blk-copy 聚焦时必须可见(否则 opacity:0 连焦点圈一起隐形)', () => {
  const blk = /\.blk-copy:focus-visible\s*\{([^}]*)\}/.exec(css);
  assert.ok(blk, '.blk-copy 必须有 :focus-visible 规则');
  assert.match(blk[1], /opacity:\s*1/, '聚焦时必须把 opacity 提到 1 —— opacity 作用于整个渲染层,含 outline');
  assert.match(blk[1], /outline:/, '同时要给出可见的焦点圈');
});

test('A9:.edit-body 聚焦反馈必须达标(整圈 2px 黛蓝内框,不再用几乎不可见的 tint)', () => {
  /* ★ 审计 P2 实测:旧写法 tint 合成后浅色 1.06:1、暗色 1.01:1(--hover 与 --panel 几乎同色),
   *   左内线 1.18/1.28 —— 全都够不到 WCAG 非文本 3:1。新写法整圈 2px --accent:对白 7.00 / 对暗 6.07。 */
  const f = /\.edit-body:focus\s*\{([^}]*)\}/.exec(css);
  assert.ok(f, '必须有 .edit-body:focus 规则');
  assert.match(f[1], /box-shadow:\s*inset 0 0 0 2px var\(--accent\)/,
    '必须用整圈 2px 黛蓝内框(inset 不占布局、不外扩,且两种主题都达标)');
  // ⚠️ 判据必须落在**属性声明**上,不能落在「文件里出现过 color-mix」——实现里那条
  //    新注释就提到了这个词,裸 /color-mix\(/ 会被自己的注释喂成假红(2026-10-11 实测)。
  assert.doesNotMatch(css, /background(-color)?:\s*color-mix/, '不得再用 color-mix 做 tint(实测不达标,且全仓唯一一处无 @supports 兜底)');
  assert.doesNotMatch(css, /\.edit-body:focus-within/, 'textarea 无子元素,:focus-within 恒等价于 :focus(冗余)');
});

test('P3:--muted 落在深底上的次要文字提到 --text(纸面底之外仍要可读)', () => {
  const catCount = /\.cat-item:hover \.cat-count,\n\.cat-item\.pinned:not\(\.active\) \.cat-count\s*\{([^}]*)\}/.exec(css);
  assert.ok(catCount, '.cat-count 的悬停/置顶态必须有单独规则');
  assert.match(catCount[1], /color:\s*var\(--text\)/, '悬停(4.42)/置顶(4.21)底上都不到 4.5,必须提到 --text');
  assert.match(css, /\.search-item:hover \.search-item-snippet\s*\{[^}]*var\(--text\)/,
    '搜索结果摘要悬停时底变 --hover,必须提到 --text');
});

test('P3:编辑态附件删除按钮纳入统一焦点圈', () => {
  assert.match(css, /\.att-del:focus-visible\s*\{[^}]*outline:\s*2px/, '.att-del 必须有焦点圈(别只剩 UA 默认圈)');
});

test('P3:触屏两列图钉保留 2px 补偿', () => {
  const mq = /@media \(hover: none\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(mq, '必须存在 (hover:none) 媒体查询');
  const cat = /\.cat-item \.pin-slot\s*\{\s*margin-right:\s*(\d+)px/.exec(mq[1]);
  const note = /\.note-item \.pin-slot\s*\{\s*margin-right:\s*(\d+)px/.exec(mq[1]);
  assert.ok(cat && note, '(hover:none) 里必须能解析出两列 .pin-slot');
  assert.ok(Number(note[1]) > Number(cat[1]),
    `笔记列必须比分类列多补偿(margin-right),实际 cat=${cat[1]} note=${note[1]}`);
});

test('P2:downloadAttachment 必须有并发守卫(否则双击重复解密 + objectURL 泄漏)', () => {
  const src = /async function downloadAttachment\(ctx, att\)\s*\{[\s\S]*?\n\}/.exec(noteJs);
  assert.ok(src, '必须能取出 downloadAttachment');
  const body = src[0];
  assert.match(body, /if \(attLoading\.has\(att\.file\)\) return;/, '必须先查 attLoading 守卫');
  assert.match(body, /attLoading\.add\(att\.file\)/, '必须登记在途');
  assert.match(body, /finally\s*\{[\s\S]*attLoading\.delete\(att\.file\)/, '必须 finally 释放,异常也不能卡住');
});

test('P3:下载统一走 ctx.downloadUrl(消掉内联锚点重复)', () => {
  assert.match(uiJs, /function downloadUrl\(url, fileName\)\s*\{/, 'ui.js 必须有 downloadUrl');
  assert.match(uiJs, /^\s*downloadUrl,/m, 'ctx 必须挂上 downloadUrl');
  assert.match(noteJs, /ctx\.downloadUrl\(url, att\.name\)/, 'note.js 必须复用它(不再内联建锚点)');
});

test('P3:远端锁定也要消费回传的 dropped(别静默丢本端改动)', () => {
  const seg = /if \(msg\.type === 'locked'\)\s*\{([\s\S]*?)\n  \}/.exec(uiJs);
  assert.ok(seg, '必须能取出 onTabMessage 的 locked 分支');
  assert.match(seg[1], /\.then\(\(n\) => n > 0 && toast\(/, '必须消费 lockNow 的返回值并提示');
});

/* ---------- 2026-10-11(本批):离线提示 / 静态样式 / 回收站剩余天数 ---------- */

test('A7:密码生成器的静态样式必须走 style.css(不得内联)', () => {
  /* data.js 是 feature 模块,里面的样式全是静态值 —— 按 index.html 的口径应一律进 style.css。
   * ⚠️ 唯一的例外是「运行时算出来的定位」(search.js 的浮层 top 依赖 getBoundingClientRect),
   *    那类值来自布局、写不进样式表;data.js 里不存在这种需求,所以这里可以全禁。
   * (2026-10-11 审计 P3:此前 fontFamily / fontSize / justifyContent 三处写在内联 style 上,
   *  靠 CSSOM 侥幸绕过 CSP(style-src 'self'),功能无碍但口径不一致。) */
  assert.doesNotMatch(dataJs, /\.style\.\w+\s*=/, 'data.js 不得再出现内联样式赋值');
  assert.match(dataJs, /'modal-input gen-out'/, '生成结果框必须挂 .gen-out');
  assert.match(dataJs, /'modal-btns gen-ops'/, '按钮行必须挂 .gen-ops');
  assert.match(css, /\.modal-input\.gen-out\s*\{[^}]*font-family:\s*var\(--mono\)/,
    'style.css 必须定义 .gen-out 的等宽字体');
  assert.match(css, /\.modal-btns\.gen-ops\s*\{[^}]*justify-content:\s*flex-start/,
    'style.css 必须定义 .gen-ops 的左对齐');
});

test('B8:回收站条目必须显示剩余保留天数', () => {
  // 纯函数(到期口径 / 向上取整 / 负值截 0)在 format.test.mjs 真跑;这里只钉「接线」:
  // 算了不显示等于没做,所以文案模板也要断言。
  assert.match(dataJs, /F\.trashDaysLeft\(note\.deletedAt\)/, '回收站条目必须用 F.trashDaysLeft 算剩余天数');
  assert.match(dataJs, /还剩 \$\{leftDays\} 天/, '必须把剩余天数显示出来');
  assert.match(dataJs, /'今天到期'/, '到期当天要有明确文案,不能显示「还剩 0 天」');
});

test('P2:离线读附件/历史的失败提示必须区分「离线」与「解密失败」', () => {
  /* ① 真跑 isOffline —— 判据落在**分支语义**上,不是「文件里出现过某字符串」。
   *    附件与版本历史走 /api/blob,它不在 SW 离线白名单 → 断网必然失败;
   *    若原样抛出,用户看到的是「附件解密失败:Failed to fetch」,把离线误报成文件损坏。 */
  const src = /function isOffline\(\)\s*\{[\s\S]*?\n\}/.exec(noteJs);
  assert.ok(src, 'note.js 必须定义 isOffline()');
  const isOffline = new Function(src[0] + '; return isOffline;')();
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNav = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
  try {
    setNav({ onLine: false });
    assert.equal(isOffline(), true, 'onLine === false 才算离线');
    setNav({ onLine: true });
    assert.equal(isOffline(), false, '在线不得误判成离线');
    setNav(undefined);
    assert.equal(isOffline(), false, '取不到 navigator(Node / 老环境)必须按在线 —— 反了会把网络抖动误报成离线');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }

  /* ② 附件(预览 / 下载 / 入库)+ 历史恢复 = 4 条需要联网的失败路径,都必须过 offlineBlobMessage。
   *    ⚠️ 将来新增第 5 条这类路径时,这个数字要一起改 —— 否则本用例不会自动翻红。 */
  const wired = noteJs.match(/F\.offlineBlobMessage\(isOffline\(\)/g) || [];
  assert.equal(wired.length, 4, `附件/历史的 4 条网络失败路径都要区分离线,实际 ${wired.length} 处`);

  /* ③ 旧写法绝迹:toast 不得直接以失败文案开头(退回去就是「把离线报成解密失败」) */
  assert.doesNotMatch(noteJs, /ctx\.toast\(\s*`附件解密失败/, '附件失败必须经过 offlineBlobMessage');
  assert.doesNotMatch(noteJs, /ctx\.toast\(\s*`「\$\{file\.name\}」入库失败/, '入库失败必须经过 offlineBlobMessage');
  assert.doesNotMatch(noteJs, /ctx\.toast\(\s*`恢复失败/, '历史恢复失败必须经过 offlineBlobMessage');
});

/* ---------- 2026-10-17 审计:交互竞态 / 死代码 / 口径一致 ---------- */

const libJs = read('js/lib.js');
const apiJs = read('js/api.js');
const tabsyncJs = read('js/tabsync.js');
const themeJs = read('js/features/theme.js');
const searchFeatureJs = read('js/features/search.js');

test('A9:复制按钮 1.5 秒内连点两次,不得永久卡在「已复制」', () => {
  /* 旧实现把「原值」存成点击那一刻的 DOM 文本:第二次点击时 label 里已经是
   * 「 已复制」,它的定时器到点就把按钮**永久**还原成这个中间态。
   * 判据必须落在**连点后的最终文案**上 —— 只看「有没有 copied 类」抓不到。 */
  const src = /function flashCopied\(btn\)\s*\{[\s\S]*?\n\}/.exec(uiJs);
  assert.ok(src, 'ui.js 里应能找到 flashCopied 定义');
  const timers = [];
  const setTimeoutStub = (fn) => { timers.push(fn); return timers.length; };
  const clearTimeoutStub = (id) => { if (id) timers[id - 1] = () => {}; };
  const flashCopied = new Function(
    'document', 'ICON', 'setTimeout', 'clearTimeout',
    src[0] + '; return flashCopied;',
  )({ createElement: () => ({ className: '', textContent: '' }) }, { check: '<svg/>' }, setTimeoutStub, clearTimeoutStub);

  /* 文字按钮(已拆好 .btn-label 结构) */
  const label = { className: '', textContent: '复制' };
  const btn = {
    dataset: {},
    classList: { add() {}, remove() {} },
    textContent: '复制',
    querySelector: (sel) => (sel === '.btn-label' ? label : null),
  };
  flashCopied(btn);
  flashCopied(btn);              // 1.5s 内第二次
  for (const fn of timers) fn(); // 所有定时器到点
  assert.equal(label.textContent, '复制', '连点后必须还原成原始文案,不能停在「已复制」');
  assert.equal(btn.dataset.origLabel, '复制', '原值要记在元素上,不能取「点击那一刻的 DOM」');

  /* 纯图标按钮:内容存 dataset.origHTML,连点同样要还原 */
  const timers2 = [];
  const flash2 = new Function(
    'document', 'ICON', 'setTimeout', 'clearTimeout',
    src[0] + '; return flashCopied;',
  )({ createElement: () => ({}) }, { check: '<svg class=\'check\'/>' },
    (fn) => { timers2.push(fn); return timers2.length; },
    (id) => { if (id) timers2[id - 1] = () => {}; });
  const iconBtn = { dataset: {}, classList: { add() {}, remove() {} }, textContent: '', innerHTML: '<svg class=\'orig\'/>', querySelector: () => null };
  flash2(iconBtn);
  flash2(iconBtn);
  for (const fn of timers2) fn();
  assert.equal(iconBtn.innerHTML, '<svg class=\'orig\'/>', '纯图标按钮连点后必须还原成原图标');
});

test('A10:下载锚点只有一份实现(不 append 就 click 会拿到空文件)', () => {
  /* downloadUrl 的注释早就写明「必须先 append 进文档再 click」,
   * 而 downloadBytes / downloadVaultBackup 各写了一份**裸 click** 的锚点逻辑。 */
  const db = /function downloadBytes\([\s\S]*?\n\}/.exec(uiJs);
  assert.ok(db, 'ui.js 里应能找到 downloadBytes');
  assert.match(db[0], /downloadUrl\(url, fileName\)/, 'downloadBytes 必须委托 downloadUrl');
  /* lock.js 的 vault.json 备份同样不得自建锚点:它走 ctx.downloadBytes,
   * 而 downloadBytes 内部再走 downloadUrl —— 与 note.js 收敛到 ctx.downloadUrl
   * 是同一条纪律:一处实现,一处修。 */
  assert.match(lockJs, /ctx\.downloadBytes\([\s\S]{0,60}TextEncoder/, 'downloadVaultBackup 必须走 ctx.downloadBytes');
  assert.doesNotMatch(lockJs, /document\.createElement\('a'\)/, 'lock.js 不得自建下载锚点');
});

test('A11:死代码与双绑清理', () => {
  assert.doesNotMatch(uiJs, /import \{[^}]*findMatches[^}]*\} from '\.\/search\.js'/, 'ui.js 不得再导入 findMatches(搜索已迁走)');
  assert.match(shellJs, /\.ed-btn:not\(\[data-genpw\]\)/, 'pw 按钮同时带 .ed-btn 与 data-genpw,循环必须排除它');
  assert.doesNotMatch(searchFeatureJs, /\bqLen\b/, 'searchSeq 用序号判据,qLen 是死字段');
  assert.doesNotMatch(themeJs, /export function (loadThemePref|setThemePref|applyTheme)/, 'theme.js 的三个函数无人外部引用,收回模块内');
  assert.match(tabsyncJs, /catch \(e\) \{[\s\S]*?console\.error\('tab 消息处理失败'/, '多标签页同步失败必须留痕');
  /* 409 建库冲突:必须切到解锁态(showLock 本身负责清掉上一态残留的 pwHint) */
  assert.match(lockJs, /ctx\.showLock\('unlock'\)/, '409 分支必须切到解锁态,不能留着建库表单');
  assert.match(lockJs, /hint\.hidden = !isSetup;[\s\S]*?hint\.textContent = '';/, 'showLock 必须清掉上一态的密码强度提示');
  /* etag 归一化:fetchVault 与 getCat 必须走同一个 normEtag(都剥 W/ 弱验证器) */
  const vaultFn = /export async function fetchVault\([\s\S]*?\n\}/.exec(apiJs);
  const catFn = /export async function getCat\([\s\S]*?\n\}/.exec(apiJs);
  assert.ok(vaultFn && catFn, 'api.js 里应能找到 fetchVault 与 getCat');
  assert.match(vaultFn[0], /normEtag\(/, 'fetchVault 必须归一化 etag');
  assert.match(catFn[0], /normEtag\(/, 'getCat 必须与 fetchVault 同口径 —— 口径不一致迟早 412');
});

test('A12:重载失败不报喜 / 会话已销毁不标脏 / 追加失败先取引用再截断', () => {
  const reloaded = uiJs.match(/if \(reloaded\) toast\(/g) || [];
  assert.equal(reloaded.length, 2, 'handleConflict 与 onTabMessage 两处都必须看 openCategory 的返回值再报喜');
  assert.match(uiJs, /if \(S\.lib\) S\.markDirty\(name\)/, '会话已销毁时不得把分类塞回脏集(幻影未保存标记)');
  /* lib.js 追加失败回滚:必须先取 added 再截断长度 ——
   * 旧写法先 length = before 再取 notes[before],取回恒 undefined,引用清理从未执行。 */
  const m = /const added = dst\.data\.notes\[before\];\s*\n\s*dst\.data\.notes\.length = before;/.exec(libJs);
  assert.ok(m, 'lib.js 必须先取 notes[before] 再截断');
});
