/* ============================================================
 * 静态资源清单守卫:Service Worker 的 ASSETS 必须与 public/ 实际文件对得上
 *
 * 为什么需要:SW 安装时会按清单预缓存,清单漏登记一个模块不会报任何错 ——
 * 联网时它退化成普通请求照样能拉到(network-first 下更是如此),
 * 只有**离线**时才暴露(表现为那个模块加载失败甚至整个应用白屏)。
 * 这类错靠人眼发现不了,而「新增模块」是每次加功能都会做的事。
 *
 * 版本号说明(2026-09-25 起):fetch 已全量 network-first,普通刷新即拿新版,
 * **不再需要「改完资源升 CACHE 版本号」**;版本号只在清理历史旧缓存时才动。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

/** 抠出 ASSETS 数组里的字符串字面量 */
function assetsFromSw() {
  const block = /const ASSETS = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(block, 'sw.js 里应当有 const ASSETS = [...]');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const ASSETS = assetsFromSw();
/** './js/ui.js' → 'public/js/ui.js' */
const toPath = (a) => join(PUBLIC, a.replace(/^\.\//, ''));

test('SW 清单:每个条目都真实存在(漏登记 / 写错名都会让离线白屏)', () => {
  for (const a of ASSETS) {
    if (a === './') continue; // 目录本身,对应 index.html
    assert.ok(existsSync(toPath(a)), `ASSETS 里的 ${a} 在 public/ 下不存在`);
  }
});

test('SW 清单:public/js 下的每个模块都必须登记(新加模块最容易漏)', () => {
  // ★ 必须**递归**:重构后 js/ 下多了 features/ 子目录,只扫顶层会漏掉整目录
  //  (2026-09-27 实测:features/theme.js 漏登记时,只扫顶层的旧写法全绿放过)
  const walk = (dir, base = '') => {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...walk(join(dir, e.name), `${base}${e.name}/`));
      else if (e.name.endsWith('.js')) out.push(`${base}${e.name}`);
    }
    return out;
  };
  const onDisk = walk(join(PUBLIC, 'js'));
  assert.ok(onDisk.length > 0, 'public/js 下应当有模块');
  const listed = new Set(ASSETS.map((a) => a.replace(/^\.\/js\//, '')));
  const missing = onDisk.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `这些模块没登记进 sw.js 的 ASSETS:${missing.join(', ')}`);
});

test('SW 清单:css 与入口页也在(否则离线连样式和外壳都没有)', () => {
  for (const need of ['./', './index.html', './css/style.css']) {
    assert.ok(ASSETS.includes(need), `ASSETS 缺少 ${need}`);
  }
});

test('SW 护栏:/api/* 仍走显式分支,且离线白名单只含三个只读密文接口', () => {
  assert.match(sw, /startsWith\('\/api\/'\)/, '必须保留 /api/* 的显式分支(不能只靠 ASSETS 没登记)');
  const m = /const OFFLINE_API_GET = (\/[^\n]+\/);/.exec(sw);
  assert.ok(m, 'sw.js 必须显式声明 OFFLINE_API_GET 白名单');
  const re = eval(m[1]);
  for (const p of ['/api/vault', '/api/cats', '/api/cat']) {
    assert.ok(re.test(p), p + ' 应在离线白名单里');
  }
  for (const p of ['/api/blobs', '/api/blob', '/api/catx', '/api/vault2', '/api/cats/../vault']) {
    assert.equal(re.test(p), false, p + ' 不该进白名单 —— 白名单必须精确到路径,放宽成前缀会把写请求卷进来');
  }
});

test('CACHE 版本号形如 jmbiji-vN(network-first 后仅为清理旧缓存而存在)', () => {
  const m = /const CACHE = '([^']+)'/.exec(sw);
  assert.ok(m, 'sw.js 里应当有 const CACHE');
  assert.match(m[1], /^jmbiji-v\d+$/, `CACHE 版本号格式异常:${m[1]}`);
});

/* ---------- 无障碍 / 可用性护栏(2026-09-26 审计) ---------- */

test('index.html 必须有 <noscript> 回退(禁用 JS 时不是一片空白)', () => {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<noscript>/, '禁用 JS 时 #lock/#app 全 hidden,没有 noscript 就是纯白屏');
  // 回退文案的样式必须在外部 CSS 里:CSP 是 style-src 'self',内联 style 属性会被拦掉
  assert.doesNotMatch(/<noscript>[\s\S]*?<div[^>]*\sstyle=/.exec(html) || '', /[\s\S]/, 'noscript 里不得用内联 style(CSP 会拦掉,等于没写样式)');
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  assert.match(css, /\.noscript-warn\s*\{/, 'noscript 的样式类 .noscript-warn 必须存在于 style.css');
});

test('reduced-motion 不得停掉状态指示动画(spinner)', () => {
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, '应当存在 prefers-reduced-motion 块');
  const body = block[1];
  // 旧写法 `* { animation: none !important }` 会把 .spinner 的旋转也杀掉 → 用户以为卡死。
  // 判据:不得存在「裸 * 选择器」的块直接停掉 animation(*:not(.spinner) 是允许的例外)。
  // 用行锚定匹配,避免被注释里的同类文字误导。
  const bareStar = /^\s*\*\s*\{([^}]*)\}/gm;
  let m2, bad = false;
  while ((m2 = bareStar.exec(body)) !== null) {
    if (/animation:\s*none\s*!important/.test(m2[1])) bad = true;
  }
  assert.equal(bad, false, '不得用裸 `*` 选择器停掉全部 animation(spinner 是状态指示,必须保留)');
  assert.match(body, /\.spinner/, 'spinner 必须在 reduced-motion 下被显式保留');
});

test('toast 文字色走主题变量,暗色下不得硬编码 #fff', () => {
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /\.toast-error\s*\{[^}]*color:\s*#fff/i, 'toast-error 不得硬编码 #fff(暗色下 --danger 是浅色,白字对比仅 3.15:1)');
  assert.doesNotMatch(css, /\.toast-warn\s*\{[^}]*color:\s*#fff/i, 'toast-warn 不得硬编码 #fff(暗色下 --warn 是浅色,白字对比仅 2.49:1)');
  assert.match(css, /--toast-error-fg:/, '必须定义 --toast-error-fg 变量');
  assert.match(css, /--toast-warn-fg:/, '必须定义 --toast-warn-fg 变量');
});

/* ---------- 2026-09-29 审计 P3:离线救灾与主题配色 ---------- */
test('P3:ASSETS 必须含应急恢复页(离线救灾时最需要它)', () => {
  assert.ok(ASSETS.includes('./recover.html'), 'recover.html 必须进清单,否则离线打开只会拿到主应用外壳');
});

test('P3:离线导航兜底必须按路径给页面(不能一律回主应用外壳)', () => {
  /* ★ 行为断言,不是「文件里出现过某字符串」:把 navFallback 从 sw.js 里取出来**真的跑一遍**。
   *   只查字符串的写法在 2026-09-29 的反向探针里被证明是假绿 —— 把函数体掏空、只留名字与
   *   调用点,断言照样全绿。(同一条纪律:断言要落在「判定分支」上,不是落在文本上。) */
  const src = /function navFallback\(url\)\s*\{[\s\S]*?\n\}/.exec(sw);
  assert.ok(src, 'sw.js 里必须能取出 navFallback 的定义');
  const navFallback = new Function(src[0] + '; return navFallback;')();
  assert.equal(navFallback('https://x/recover.html'), './recover.html',
    'recover.html 的离线导航必须回到恢复页本身');
  assert.equal(navFallback('https://x/recover.html?k=1'), './recover.html', '带查询串也要认得出来');
  assert.equal(navFallback('https://x/'), './index.html', '其它路径才回主应用外壳');
  assert.equal(navFallback('https://x/a/b'), './index.html');
  // URL 解析不了时也必须兜底,不能抛
  assert.equal(navFallback('::::'), './index.html');
  assert.match(sw, /caches\.match\(navFallback\(/, '导航兜底必须走 navFallback(不能被绕过)');
});

test('P3:暗色主题不得用裸 .toast 规则压死 error/warn 配色', () => {
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  // 裸写是 0,3,0,会恒定覆盖 0,1,0 的 .toast-error/.toast-warn ⇒ 失败提示与普通提示同貌,
  // --toast-error-fg / --toast-warn-fg 变成永远用不上的死代码。
  assert.doesNotMatch(css, /:root\[data-theme="dark"\]\s*\.toast\s*\{/,
    '暗色通用 toast 规则必须排除 .toast-error / .toast-warn(裸写会压死它们)');
  // 逐条检查:每条暗色 toast 规则都必须显式排除 error/warn
  // (不能要求 `:not(.toast-warn)` 紧跟 .toast —— 实际写法是 `:not(.toast-error):not(.toast-warn)`)
  const darkRules = [...css.matchAll(/:root\[data-theme="dark"\]\s*\.toast[^{]*\{/g)].map((m) => m[0]);
  assert.ok(darkRules.length > 0, '应当存在暗色主题的 toast 规则');
  for (const rule of darkRules) {
    assert.match(rule, /:not\(\.toast-error\)/, `这条暗色 toast 规则没排除 .toast-error:${rule}`);
    assert.match(rule, /:not\(\.toast-warn\)/, `这条暗色 toast 规则没排除 .toast-warn:${rule}`);
  }
  // 无毛玻璃回落里那条同特异性的 .toast 也必须排除(否则同样压死)
  const fallback = /@supports not \(\(backdrop-filter[\s\S]*?\n\}/.exec(css);
  assert.ok(fallback, '应当存在无毛玻璃能力的回落块');
  assert.doesNotMatch(fallback[0], /^\s*\.toast\s*\{/m,
    '回落块里的裸 .toast(0,1,0)与 .toast-error 同特异性 —— 写在后面会覆盖它');
});

test('P3:两列图钉必须落在同一条竖线上(外距要补偿 padding-right 的差)', () => {
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  const pick = (re, label) => {
    const m = re.exec(css);
    assert.ok(m, `解析不出 ${label}`);
    return Number(m[1]);
  };
  // 图钉竖线位置 = 行的 padding-right + 槽位的 margin-right(槽位定宽 15px,图标靠左)
  const catPad = pick(/\.cat-item\s*\{[^}]*padding:\s*7px\s+(\d+)px/, '分类行的 padding-right');
  const notePad = pick(/\.note-item\s*\{[^}]*padding:\s*7px\s+(\d+)px\s+7px/, '笔记行的 padding-right');
  const catSlot = pick(/\.cat-item\s*\.pin-slot\s*\{\s*margin-right:\s*(\d+)px/, '分类列 .pin-slot 的 margin-right');
  const noteSlot = pick(/\.note-item\s*\.pin-slot\s*\{\s*margin-right:\s*(\d+)px/, '笔记列 .pin-slot 的 margin-right');
  assert.equal(catPad + catSlot, notePad + noteSlot,
    `两列的图钉竖线必须一致:分类 ${catPad}+${catSlot} vs 笔记 ${notePad}+${noteSlot}`);
});

test('P3:触屏两列图钉也要落在同一条竖线(padding 没变,补偿必须保留)', () => {
  /* ★ 2026-10-11 审计 P3:上一条只覆盖桌面 —— 触屏那条规则此前把两列 margin-right 一律写成
   *   8px,而行的 padding-right 并没有跟着变(仍是 cat 10 / note 8),于是笔记列图钉偏右 2px,
   *   且**没有任何断言覆盖**(正则撞不到合并选择器)。现两列分别写值,这里补上等式。 */
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  const mq = /@media \(hover: none\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(mq, '必须存在 (hover:none) 媒体查询');
  const body = mq[1];
  const globalN = (re, label) => {
    const m = re.exec(css);
    assert.ok(m, `解析不出 ${label}`);
    return Number(m[1]);
  };
  const inBody = (re, label) => {
    const m = re.exec(body);
    assert.ok(m, `(hover:none) 里解析不出 ${label}`);
    return Number(m[1]);
  };
  const catPad = globalN(/\.cat-item\s*\{[^}]*padding:\s*7px\s+(\d+)px/, '分类行 padding-right');
  const notePad = globalN(/\.note-item\s*\{[^}]*padding:\s*7px\s+(\d+)px\s+7px/, '笔记行 padding-right');
  const catSlot = inBody(/\.cat-item\s*\.pin-slot\s*\{\s*margin-right:\s*(\d+)px/, '触屏分类列 .pin-slot');
  const noteSlot = inBody(/\.note-item\s*\.pin-slot\s*\{\s*margin-right:\s*(\d+)px/, '触屏笔记列 .pin-slot');
  assert.equal(catPad + catSlot, notePad + noteSlot,
    `触屏两列图钉也必须同线:分类 ${catPad}+${catSlot} vs 笔记 ${notePad}+${noteSlot}`);
});

/* ---------------- 2026-10-12 全站审计 P2:提示宿主的 popover 默认样式 ----------------
 * .modal 是原生 <dialog> + showModal() —— 它落在浏览器的 **top layer**,
 * 那块区域的层级由「加入顺序」决定,z-index 一概不参与。z-index:100 的普通容器
 * (原本的 #toasts)永远压在它下面 ⇒ 弹窗开着期间到达的提示一条都看不见。
 * 修法是让 #toasts 自己也进 top layer(popover="manual",见 ui.js 的 toast())。
 *
 * 但 popover 自带一整套 UA 默认样式:inset:0 + margin:auto(把元素撑满并居中)、
 * border、padding、background:Canvas、color:CanvasText、overflow:auto。
 * 不逐条归零,#toasts 会变成一块盖住整屏的不透明面板 —— 而这类事故只在真机上
 * 才看得见(单测与 dev-server 都不渲染)。这条用例就是那份「归零清单」。 */
test('P2:提示宿主挂 popover 后必须把 UA 默认样式归零(否则会被撑成全屏不透明面板)', () => {
  const css = readFileSync(join(PUBLIC, 'css', 'style.css'), 'utf8');
  const base = /#toasts\s*\{([^}]*)\}/.exec(css);
  assert.ok(base, 'style.css 里应当有 #toasts 基础规则');
  const m = /#toasts\[popover\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, '必须有 #toasts[popover] 规则 —— 一旦挂上 popover 属性,UA 那套默认样式就会生效');
  const rule = m[1];
  const has = (prop) => new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(rule);
  for (const p of ['inset', 'margin', 'padding', 'border', 'background', 'color', 'width', 'height', 'max-height', 'overflow']) {
    assert.ok(has(p), `#toasts[popover] 缺 ${p} —— popover 的 UA 默认值会直接露出来`);
  }
  assert.match(rule, /inset:\s*auto\s+auto\s[^;]*50%/,
    'inset 必须写成「auto auto <bottom> 50%」才等价于 #toasts 原来的 fixed 定位(UA 默认是 inset:0)');
  assert.match(rule, /margin:\s*0/, 'popover 默认 margin:auto 会把它居中拉伸');
  assert.match(rule, /padding:\s*0/, 'popover 默认有 padding,会在提示周围多出一圈');
  assert.match(rule, /border:\s*0/, 'popover 默认带边框');
  assert.match(rule, /background:\s*transparent/, 'popover 默认 background:Canvas 会变成一块不透明面板');
  assert.match(rule, /overflow:\s*visible/, 'popover 默认 overflow:auto 会给宿主加滚动条');
  // 底部对齐量必须与基础规则**逐字相同**:否则挂上 popover 的瞬间提示会跳位(含 iOS 安全区)
  const baseBottom = /(?:^|[;{\s])bottom\s*:\s*([^;]+)/.exec(base[1])[1].trim();
  assert.ok(rule.includes(baseBottom),
    `#toasts[popover] 的底部对齐量必须与 #toasts 一致(${baseBottom}),否则提示进 top layer 的那一刻会跳位`);
});

