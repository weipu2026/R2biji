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
const settingsJs = read('js/features/settings.js');
const readingJs = read('js/features/reading.js');

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

test('A10:编辑框必须留水平内距(否则聚焦内框压住首列文字)', () => {
  /* ★ 2026-10-18 用户反馈:点进正文后,深蓝 2px 内框与每一行的首字重叠,光标落在最左时看不见。
   *   根因:.edit-body / .edit-title 的左右 padding 都是 0,文字从容器左边界起排,而
   *   .edit-body:focus 画的 inset 2px 框正落在边界上 → 每行首字左边缘被吃掉 2px。
   *   判据取**解析出的数值**而不是字符串:以后改成 10px、或拆成 padding-left/right
   *   都不该误红;同时要求标题与正文同值,否则两行不再落在同一文字列(视觉上比压字更糊)。
   *   ⚠️ 只查「规则块里有没有 padding」会被 `padding: 14px 0` 喂成假绿 —— 必须展开简写。 */
  const padLR = (sel) => {
    const blk = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css);
    if (!blk) return null;
    /* 必须先剥掉块内注释:本文件的注释就写在 padding 上方,注释闭合符紧跟属性时
     * `(?:^|;)\s*padding` 不命中(实测把这条断言自己喂成假红);注释里写
     * `padding: 0` 之类的举例也会被误当成真声明。 */
    const body = blk[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const one = (name) => {
      const m = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([\\d.]+)px').exec(body);
      return m ? Number(m[1]) : null;
    };
    const l = one('padding-left');
    const r = one('padding-right');
    if (l != null || r != null) return [l, r];
    const m = /(?:^|;)\s*padding\s*:\s*([^;}]+)/.exec(body);
    if (!m) return null;
    const v = m[1].trim().split(/\s+/).map((x) => (/^[\d.]+px$/.test(x) ? Number(parseFloat(x)) : NaN));
    if (v.length === 1) return [v[0], v[0]];
    return [v[1], v[1]]; // 2/3/4 值简写:第二个值是左右
  };

  for (const sel of ['.edit-body', '.edit-title']) {
    const lr = padLR(sel);
    assert.ok(lr, `${sel} 必须能解析出左右内距`);
    assert.ok(lr[0] >= 8 && lr[1] >= 8,
      `${sel} 左右内距都必须 ≥8px(实际 ${lr.join('/')}px):焦点框 2px 画在边框上,内距为 0 时压住首字`);
  }
  assert.deepEqual(padLR('.edit-body'), padLR('.edit-title'),
    '标题与正文必须同内距,否则两行不在同一文字列');
});

test('P3:--muted 落在深底上的次要文字提到 --text(纸面底之外仍要可读)', () => {
  const catCount = /\.cat-item:hover \.cat-count,\n\.cat-item\.pinned:not\(\.active\) \.cat-count\s*\{([^}]*)\}/.exec(css);
  assert.ok(catCount, '.cat-count 的悬停/置顶态必须有单独规则');
  assert.match(catCount[1], /color:\s*var\(--text\)/, '悬停(4.42)/置顶(4.21)底上都不到 4.5,必须提到 --text');
  assert.match(css, /\.search-item:hover \.search-item-snippet\s*\{[^}]*var\(--text\)/,
    '搜索结果摘要悬停时底变 --hover,必须提到 --text');
});

test('A11:锁屏的动态提示必须进读屏播报(此前只写不念,H2)', () => {
  /* 锁屏是全应用最关键的入口,而 #pwHint(密码强度)与 #lockErr(密码错误/库不存在)
   * 此前都是纯 textContent 静默写入 —— 读屏用户输错主密码按「解锁」,屏幕上出现红条
   * 而耳机里没有任何声音。同文件的搜索面板/toast 早就挂了 live region,这是漏网的。
   * 判据取**标签自身**的属性,不是「文件里出现过 aria-live」。 */
  const html = read('index.html');
  const hint = /<div id="pwHint"[^>]*>/.exec(html);
  assert.ok(hint, '#pwHint 必须存在');
  assert.match(hint[0], /aria-live="polite"/, '强度提示要 polite:随输入连续变化,不该打断用户');
  const err = /<div id="lockErr"[^>]*>/.exec(html);
  assert.ok(err, '#lockErr 必须存在');
  assert.match(err[0], /role="alert"/, '密码错误/库不存在要 alert:assertive 立即播报');
});

test('P3:编辑态附件删除按钮纳入统一焦点圈', () => {
  assert.match(css, /\.att-del:focus-visible\s*\{[^}]*outline:\s*2px/, '.att-del 必须有焦点圈(别只剩 UA 默认圈)');
});

test('A12:导入入口按扩展名分流(.zip 走备份恢复、.md/.txt 走批量导入)', () => {
  /* 判据取**标签自身**与 shell.js 的调用点,不是「文件里出现过 .md」——
   * accept 里漏了 .md 时文件选择器根本选不到它,而分流写错会让 .md 静默走进
   * 「从备份恢复」那条路(解包失败才暴露)。 */
  const html = read('index.html');
  const inp = /<input id="importInput"[^>]*>/.exec(html);
  assert.ok(inp, '#importInput 必须存在');
  assert.match(inp[0], /\.md/, 'accept 必须收 .md');
  assert.match(inp[0], /multiple/, '批量导入要能一次选多个文件');
  const shell = read('js/features/shell.js');
  assert.match(shell, /importMdFiles/, 'shell.js 必须有 .md 导入分支');
  assert.match(shell, /mdFileToNote/,
    '标题/正文解析必须走 format.js 的纯函数(可离线单测),不要在 shell 里现写一遍');
});

test('A13:快捷键帮助必须有入口、有清单、有样式(三处缺一就不算能用)', () => {
  /* 2026-10-18:已有 9 个快捷键却没有任何集中展示,新用户全靠试。
   * 判据分三层 —— 入口(按钮与 ? 键)、数据(KEY_HELP_GROUPS)、样式(keyhelp-row),
   * 任缺一层都会让这个功能「看起来有、实际用不了」。 */
  const html = read('index.html');
  const btn = /<button id="btnHelpKeys"[^>]*>/.exec(html);
  assert.ok(btn, '侧栏必须有快捷键帮助按钮');
  const shell = read('js/features/shell.js');
  assert.match(shell, /openKeyHelp/, 'shell.js 必须有打开面板的函数');
  assert.match(shell, /e\.key === '\?'/, '桌面端必须再给一个 ? 的全局入口');
  assert.match(shell, /btnHelpKeys'\)\.innerHTML = ICON\.keyboard/,
    '按钮图标必须由 shell 注入(HTML 里零 SVG 的口径)');
  assert.match(read('js/ui.js'), /\n\s*keyboard:/, 'ICON 表必须有 keyboard 图标');
  const css = read('css/style.css');
  assert.match(css, /\.keyhelp-row\s*\{/, '帮助面板必须有成套样式(否则弹出来是一堆裸文本)');
});

test('A14:清理未引用图片必须有忙态 + 防重入 + 权威终态(秒级操作不能静默)', () => {
  /* 清理要解密全部分类再逐个删 blob,是秒级操作:期间界面没有任何变化,用户
   * 会以为「点过了就等于清干净了」。与导出/恢复同一套口径:busy + 禁用按钮,
   * 结束用 refreshSaveStatus 收尾。
   * 判据取**处理器整段**,不是「文件里出现过 setStatus」—— 掏空 finally 只留
   * 函数名,后者照样绿(2026-10-11 起本文件就吃过这个亏)。 */
  const shell = read('js/features/shell.js');
  const seg = /\$\('btnCleanBlobs'\)\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n  \}\);/.exec(shell);
  assert.ok(seg, '必须能定位到清理按钮的处理器(改名/缩进一变,这条就该红)');
  const body = seg[1];
  assert.match(body, /cleanBtn\.disabled = true/, '必须防重入:并发清理会放大秒级残余窗口');
  assert.match(body, /setStatus\('正在清理未引用图片…', 'busy'\)/, '必须进忙态');
  assert.match(body, /finally \{[\s\S]*?cleanBtn\.disabled = false/, 'finally 必须解除禁用(否则按钮永久失效)');
  assert.match(body, /finally \{[\s\S]*?refreshSaveStatus\(\)/,
    'finally 必须用权威终态收尾(把 busy 换回已保存 / 有未保存更改)');
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
/* ---------- A15 混版自愈:HTML 声明 ↔ JS 绑定 双向对账 ---------- */

test('A15:data-controls 声明的每个接线点在 shell.js 里都有真实绑定', () => {
  /* 混版自愈(2026-10-24)的地基:index.html 的 data-controls 列出「本版本
   * 应该有绑定」的控件,shell.js 的 bindEvents 逐个绑。两份清单必须互为
   * 印证 —— 声明了却没人绑 = 静默失灵(用户报的快捷键 BUG 同款);
   * 绑了却没声明 = 自愈判据看不见它,混版时同样不自愈。 */
  const declared = (/data-controls="([^"]+)"/.exec(indexHtml) || [null, ''])[1].split(/\s+/).filter(Boolean);
  assert.ok(declared.length >= 30, 'data-controls 应有全部接线点,只解析到 ' + declared.length + ' 个');
  for (const id of declared) {
    assert.ok(shellJs.includes("$('" + id + "')"),
      'data-controls 声明了 #' + id + ',但 shell.js 里没有 $(\'' + id + '\') 的绑定');
    assert.match(indexHtml, new RegExp('id="' + id + '"'),
      'data-controls 声明了 #' + id + ',但 index.html 里没有这个元素');
  }
  /* 本轮新增的两个控件必须在声明里(漏声明 = 自愈对它们瞎掉) */
  for (const id of ['btnSettings', 'btnPrint']) {
    assert.ok(declared.includes(id), '#' + id + ' 是本轮新增控件,必须进 data-controls');
  }
  /* 打标循环与 boot 核对:判据落在「代码真的在那儿」上,不是字符串出现过 */
  assert.match(shellJs, /for \(const id of \(document\.documentElement\.dataset\.controls[\s\S]*?el\.dataset\.wired = '1'/,
    'bindEvents 末尾必须存在混版打标循环');
  assert.match(shellJs, /mixedShellGaps\(document\)/, 'start() 必须跑一次混版核对');
  assert.match(shellJs, /healMixedShell\(gaps\)/, '有缺口必须走自愈动作');
});

/* ---------- A16 阅读排版:变量层通通落地 ---------- */

test('A16:阅读字号/行距/宽度走 CSS 变量,标题不写死 px', () => {
  for (const v of ['--read-size: 15px', '--read-lh: 1.85', '--read-measure: none']) {
    assert.ok(css.includes(v), ':root 缺少 ' + v + '(默认值)');
  }
  const mdRule = /\.read-body \.md \{[^}]*\}/.exec(css);
  assert.ok(mdRule, '找不到 .read-body .md 规则');
  assert.match(mdRule[0], /font-size: var\(--read-size\)/, '正文必须引用 --read-size');
  assert.match(mdRule[0], /line-height: var\(--read-lh\)/, '正文必须引用 --read-lh');
  const measureRule = /\.read-body \.md, \.read-body > \* \{[^}]*\}/.exec(css);
  assert.ok(measureRule, '找不到行宽规则');
  assert.match(measureRule[0], /max-width: var\(--read-measure\)/, '行宽必须引用 --read-measure');
  /* 标题改 em(相对字号):绝对值不会随档缩放,「大」档就名不副实 */
  assert.doesNotMatch(css, /\.read-body h1 \{ font-size: \d+px/, 'h1 不得再写死 px');
  assert.match(css, /\.read-body h1 \{ font-size: 1\.4em/, 'h1 应为 1.4em(21px @15px 基准)');
  /* 模块侧:取值表 + 收敛函数 + 应用函数 */
  const reading = read('js/features/reading.js');
  assert.match(reading, /export function normalizeReadingPref/, 'reading.js 必须导出收敛函数');
  assert.match(reading, /export function applyReadingPref/, 'reading.js 必须导出应用函数');
});

/* ---------- A17 集中设置面板:入口、数据、样式三层齐备 ---------- */

test('A17:设置面板有入口、有分段控件、有样式', () => {
  assert.match(indexHtml, /id="btnSettings"/, 'index.html 必须有设置按钮');
  assert.match(shellJs, /\$\('btnSettings'\).innerHTML = ICON\.sliders/, '设置按钮的图标必须由 shell 注入');
  assert.match(shellJs, /\$\('btnSettings'\).addEventListener\('click', \(\) => ctx\.openSettings\(\)\)/, '设置按钮必须打开面板');
  assert.match(uiJs, /sliders:/, 'ICON 表必须有 sliders(设置图标)');
  const settings = read('js/features/settings.js');
  assert.match(settings, /className = 'set-seg'/, '面板必须用分段按钮组(可发现性优于 select)');
  assert.match(settings, /setAttribute\('aria-pressed'/, '分段按钮必须标 aria-pressed(读屏器播报当前项)');
  assert.match(settings, /ctx\.reading\.load\(\)/, '阅读偏好必须从 reading.js 读当前值');
  assert.match(settings, /ctx\.saveSettings\(\{ autoLockMinutes/, '自动锁屏必须走 saveSettings 补丁式写入');
  for (const sel of ['.set-row', '.set-seg', '.set-seg-btn[aria-pressed="true"]']) {
    assert.ok(css.includes(sel), 'style.css 缺少 ' + sel);
  }
  /* 侧栏那个裸 select 必须真的移走了(散落三处正是审计记的问题) */
  assert.doesNotMatch(indexHtml, /id="autoLock"/, '自动锁屏不应再留在侧栏');
  assert.match(uiJs, /saveSettings\(patch\)/, 'saveSettings 必须改成补丁式签名');
});

/* ---------- A18 拖拽导入 + 打印出口 ---------- */

test('A18:页面级拖拽有遮罩有监听,打印有按钮有样式', () => {
  assert.match(indexHtml, /id="dropVeil"/, 'index.html 必须有拖拽遮罩');
  assert.match(indexHtml, /id="btnPrint"/, '阅读态必须有打印按钮');
  assert.match(shellJs, /window\.addEventListener\('dragover'/, '必须监听 dragover(否则浏览器不收 drop)');
  assert.match(shellJs, /window\.addEventListener\('drop'/, '必须监听 drop');
  assert.match(shellJs, /routeImports\(ctx, \[\.\.\.\(e\.dataTransfer/, 'drop 必须走同一条分流');
  assert.match(shellJs, /\$\('btnPrint'\).addEventListener\('click', \(\) => window\.print\(\)\)/, '打印按钮必须调 window.print()');
  const veil = /\.drop-veil \{[^}]*\}/.exec(css);
  assert.ok(veil, 'style.css 必须有 .drop-veil 规则');
  assert.match(veil[0], /pointer-events: none/, '遮罩不得抢指针事件(放置目标是 document)');
  /* 打印:chrome 全收、正文通铺、敏感行强制遮罩上纸 */
  const print = /@media print \{[\s\S]*?\n\}/.exec(css);
  assert.ok(print, 'style.css 必须有 @media print 块');
  assert.match(print[0], /\.topbar[^{]*\{[^}]*display: none/, '打印必须隐藏顶栏');
  assert.match(print[0], /\.sidebar[^{]*\{[^}]*display: none/, '打印必须隐藏侧栏');
  assert.match(print[0], /\.secret \.secret-raw \{ display: none/, '打印必须强制遮罩敏感行(纸会流转)');
  assert.match(print[0], /max-width: none/, '打印必须通铺(不跟随屏幕上的居中偏好)');
});

/* ============================================================
 * A19:打印的「可用性」—— 不是「规则存在」,而是「纸上真的完整」
 * ------------------------------------------------------------
 * 2026-10-24 复审真机实测(此前 A18 全绿却没拦住):
 *  ① #app 的 height:100vh 在打印时把文档锁成一屏 → 3360px 正文只出 1 页,
 *     后面的内容静默丢失。只解 html/body 无效(实测仍 1 页),必须解 #app。
 *  ② 深色主题的 --text 是 #ece9e1,而 body 背景被刷成 #fff;浏览器默认
 *     **不打印背景色** → 白纸白字,一张纸全空。必须把整组配色重置回浅色。
 *  ③ .blk-copy 是 hover 才显形的绝对定位按钮,鼠标停在某段上时它 opacity:1,
 *     会印到纸上并压住正文。
 * 这三条都不是「规则写没写」,是「写了但这些情形没想到」。
 * ============================================================ */
test('A19:打印必须解掉 100vh 定高、深色配色回到纸上可读、块按钮不上纸', () => {
  const print = /@media print \{[\s\S]*?\n\}/.exec(css);
  assert.ok(print, '前提:必须有 @media print 块');
  const p = print[0];

  /* ① 高度链:只解 html/body 不够,#app 必须一起解(实测只解前者仍是 1 页) */
  assert.match(p, /#app\s*\{[^}]*height:\s*auto/,
    '★ 打印必须解掉 #app 的定高,否则长笔记只出第一屏(内容静默丢失)');
  assert.match(p, /overflow:\s*visible/, '打印必须让 #readView 溢出可见(否则内部滚动区被裁)');

  /* ② 深色配色:必须整体重置,逐个覆写文字色会漏 */
  assert.match(p, /:root\[data-theme="dark"\]\s*\{/,
    '★ 深色主题必须有专门的打印配色重置(否则白纸白字)');
  const darkBlock = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(p);
  assert.ok(darkBlock, '深色打印配色块必须可解析');
  assert.match(darkBlock[1], /--text:\s*#000/, '打印时正文色必须是深色(白纸白字是可用性事故)');
  assert.match(darkBlock[1], /--bg:\s*#fff/, '打印时底色必须是白');

  /* ③ 块级悬浮按钮 */
  assert.match(p, /\.blk-copy\s*\{[^}]*display:\s*none/,
    '★ 段级复制按钮不得上纸(hover 显形时会印出来并压住正文)');
});

/* ============================================================
 * A20:拖拽的退出路径 —— 遮罩不能永久卡在屏幕上
 * ------------------------------------------------------------
 * 2026-10-24 复审真机实测:拖文件到桌面松手 / 按 Esc 取消 / Alt+Tab 切走,
 * 浏览器不一定派发 dragleave(relatedTarget === null 也不来)→ 遮罩永久
 * 盖住整个界面。另外锁屏上拖文件会弹遮罩、还提示「先选择分类」,
 * 这是在未解锁的界面上承诺能写数据。
 * ============================================================ */
test('A20:拖拽要有心跳/失焦兜底,且锁屏态不接拖拽', () => {
  /* ★ 先剥注释再断言:注释里同样出现这些词,「文件里有过」会喂假绿
   *   (2026-10-24 反向探针实测:只砍处理器里的心跳时,armDrop 里还有一处
   *    同名调用 → 旧的宽松断言照样绿)。所以取**dragover 处理器体**再查。 */
  const noComment = shellJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const dragoverBody = /addEventListener\('dragover',[^]*?\n  \}\)/.exec(noComment);
  assert.ok(dragoverBody, 'dragover 处理器必须可解析');
  assert.match(dragoverBody[0], /setTimeout\(disarmDrop/,
    '★ dragover 里必须有续期心跳(拖动结束不一定会派发 dragleave)');
  assert.match(shellJs, /addEventListener\('blur'[\s\S]{0,80}disarmDrop/,
    '窗口失焦必须收遮罩(Alt+Tab / 拖去别的应用)');
  assert.match(shellJs, /const canAcceptDrop\s*=/,
    '必须有「进应用了吗」的判据');
  assert.match(shellJs, /canAcceptDrop\(\)\)\s*return/, 'dragover 必须用该判据拦住锁屏态');
  const dropHandler = /addEventListener\('drop'[\s\S]*?\n  \}\)/.exec(shellJs);
  assert.ok(dropHandler, 'drop 处理器必须可解析');
  assert.match(dropHandler[0], /canAcceptDrop\(\)/,
    '★ 锁屏态收到 drop 也不能接(未解锁的界面不该承诺能导入)');
});

/* ============================================================
 * A21:设置面板的回显必须跟着真实状态走
 * ------------------------------------------------------------
 * 2026-10-24 复审真机实测:面板开着时点顶栏那枚主题按钮,主题真的变了,
 * 但面板里「深色」仍高亮 —— 显示说谎比不显示更糟。同时 seg 必须把值
 * 存在 dataset 上,否则事后无法从 DOM 反查当前项代表哪个值。
 * ============================================================ */
test('A21:设置面板分段按钮带值、主题回显随 data-theme 同步', () => {
  assert.match(settingsJs, /b\.dataset\.value = String\(o\.value\)/,
    '★ 分段按钮必须把值存在 dataset 上(否则无法反查当前项)');
  assert.match(settingsJs, /function syncSeg\(/, '必须有 syncSeg 用于刷新回显');
  /* ★ 必须落在「new MutationObserver(...).observe(documentElement, {...data-theme})」
   *   这个整体上:M8 变异把 new 换成 null 时,只查关键词仍会绿。 */
  const noCommentSet = settingsJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(noCommentSet, /new MutationObserver\([^)]*\)[\s\S]{0,120}\.observe\(document\.documentElement,\s*\{\s*attributes:\s*true,\s*attributeFilter:\s*\['data-theme'\]\s*\}\)/,
    '★ 必须真的 new 出观察者并 observe(documentElement, data-theme);面板开着时被顶栏改动才不会显示旧值');
  assert.match(settingsJs, /themeObserver\.disconnect\(\)/,
    '观察者必须在面板关闭时断开(否则泄漏累积)');
  /* ★ 取 finally 块体再断言:M9 把 disconnect 移到 finally 之后时,
   *   宽松写法会被「块外那行」或注释骗过。 */
  const finallyBlock = /\} finally \{([\s\S]*?)\n  \}/.exec(noCommentSet);
  assert.ok(finallyBlock, 'openSettings 必须有 finally 块');
  assert.match(finallyBlock[1], /themeObserver\.disconnect\(\)/,
    '断开必须在 finally 块**内部**(modal 抛异常时也要断,否则泄漏累积)');
});

