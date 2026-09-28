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

test('SW 护栏:/api/* 仍然永不经缓存(锁屏形同虚设的唯一防线)', () => {
  assert.match(sw, /startsWith\('\/api\/'\)/, '必须保留 /api/* 的显式拒绝');
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
