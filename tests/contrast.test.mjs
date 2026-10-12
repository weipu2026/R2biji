/* ============================================================
 * 色彩对比度守卫(2026-10-07 新增)
 *
 * 为什么需要:同一个色值常常**身兼两职** —— 既当正文文字色、又当图标色。
 * 而这两者的 WCAG 门槛不同:
 *   · 正文文字   4.5:1 (SC 1.4.3)
 *   · 图标(非文本元素)3:1   (SC 1.4.11)
 * 于是会出现「图标看着没问题、文字其实不达标」的隐蔽状态。
 * 亮色主题的 --muted #8d8778 就是这么藏了很久:3.58:1,图标完全达标,
 * 但它同时用在阅读视图 H3 标题、编辑提示、分类计数等 20+ 处**文字**上,
 * 全部不达标 —— 而当时没有任何单测、任何 lint 会报出来。
 *
 * ★ 关键点:色值必须对**三种背景**都算,不是两种。
 *   上一轮修复就栽在这里:先只核了 panel #ffffff 与 side #f7f5ef,
 *   选出 #7a7466(4.65 / 4.26),结果它在 bg #faf8f2 上只有 4.38 ——漏了第三种。
 * 判据因此写成「对全部三种背景均 ≥4.5」,而不是逐个点名。
 *
 * 判据本身是纯函数(相对亮度按 WCAG 公式),无主观成分。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'public/css/style.css'), 'utf8');

/* ---------- WCAG 相对亮度与对比度(纯函数) ---------- */

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** 相对亮度 L = 0.2126R + 0.7152G + 0.0722B,三通道线性化后加权 */
function luminance(hex) {
  let h = String(hex).trim().replace('#', '').toLowerCase();
  assert.match(h, /^([0-9a-f]{3}|[0-9a-f]{6})$/, `色值格式不对:${hex}`);
  if (h.length === 3) h = h.split('').map((c) => c + c).join(''); // #fff → #ffffff
  const [r, g, b] = [0, 2, 4].map((i) => srgb(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度 (L1+0.05)/(L2+0.05),L1 取较亮者 */
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ---------- 从 style.css 抠真实色值(不硬编码,免得改完 CSS 忘了同步用例) ---------- */

/** 取某个自定义属性在亮/暗两套主题下的值;出现顺序即亮 → 暗。 */
function tokens(name) {
  const all = [...css.matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))].map((m) => m[1]);
  assert.ok(all.length >= 1, `style.css 里找不到 ${name}`);
  return { light: all[0], dark: all[1] ?? null };
}

const T = {
  text: tokens('--text'),
  muted: tokens('--muted'),
  accent: tokens('--accent'),
  danger: tokens('--danger'),
  warn: tokens('--warn'),
  ok: tokens('--ok'),
  panel: tokens('--panel'),
  side: tokens('--side'),
  bg: tokens('--bg'),
};

/** 亮色主题下会用到的**全部**纸面背景。少算一种就会重演上一轮的漏检。 */
const LIGHT_BGS = [
  ['panel', T.panel.light, '--panel #ffffff(纸面:读视图/编辑区)'],
  ['side', T.side.light, '--side #f7f5ef(侧栏)'],
  ['bg', T.bg.light, '--bg #faf8f2(页面底)'],
];

/* ---------- 用例 ---------- */

test('对比度:次要文字色 --muted 对三种纸面背景均 ≥4.5:1', () => {
  /* --muted 同时用在 .cat-count(侧栏)与 .read-empty(纸面)等处,
   * 三个背景都要过线才算达标。 */
  for (const [, bg, where] of LIGHT_BGS) {
    const r = contrast(T.muted.light, bg);
    assert.ok(r >= 4.5,
      `--muted ${T.muted.light} 在 ${where} 上只有 ${r.toFixed(2)}:1,低于正文要求的 4.5:1`);
  }
});

test('对比度:--muted 作图标色时 ≥3:1(它同时是 .icon-btn 的色)', () => {
  /* 这条是 --muted 一直"看起来没问题"的原因:图标门槛本来就低。
   * 保留它是为了提醒:别为了文字达标就把它调得跟正文一样重,
   * 那样 20+ 个图标按钮会一起变沉。 */
  const r = contrast(T.muted.light, T.panel.light);
  assert.ok(r >= 3, `--muted 作图标色只有 ${r.toFixed(2)}:1,低于非文本元素要求的 3:1`);
});

test('对比度:次要色与正文仍留有可辨层次(不是「为了达标」调成同色)', () => {
  /* 若两者差得太近,「次要」就名存实亡了 —— 界面会失去信息层级。
   * 下方阈值 2.5:1 是「能看出深浅差」的经验下限。 */
  const r = contrast(T.muted.light, T.text.light);
  assert.ok(r >= 2.5,
    `--muted ${T.muted.light} 与正文 ${T.text.light} 只差 ${r.toFixed(2)}:1,两者会糊在一起、失去分层`);
  assert.ok(r <= 6,
    `--muted 与正文差 ${r.toFixed(2)}:1,过大的落差会让次要信息喧宾夺主`);
});

test('对比度:正文色 --text 对全部纸面背景 ≥4.5:1', () => {
  for (const [, bg, where] of LIGHT_BGS) {
    const r = contrast(T.text.light, bg);
    assert.ok(r >= 4.5, `--text ${T.text.light} 在 ${where} 上只有 ${r.toFixed(2)}:1`);
  }
});

test('对比度:语义色(强调/危险/警示/成功)对纸面均 ≥4.5:1', () => {
  for (const [name, t] of Object.entries({ accent: T.accent, danger: T.danger, warn: T.warn, ok: T.ok })) {
    if (!t.light) continue;
    const r = contrast(t.light, T.panel.light);
    assert.ok(r >= 4.5, `--${name} ${t.light} 在纸面上只有 ${r.toFixed(2)}:1`);
  }
});

test('对比度:暗色主题的 --muted 对暗纸面 ≥4.5:1', () => {
  if (!T.muted.dark) return; // 未定义暗色主题时跳过
  const bg = T.panel.dark || '#1e2128';
  const r = contrast(T.muted.dark, bg);
  assert.ok(r >= 4.5, `暗色 --muted ${T.muted.dark} 在 ${bg} 上只有 ${r.toFixed(2)}:1`);
});

test('对比度:相对亮度函数自校验(判据本身不能算错)', () => {
  /* WCAG 参考值:黑对白 = 21:1。判据算错的话上面所有用例都是空转。 */
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01, '黑白对比度应为 21:1');
  assert.ok(Math.abs(contrast('#ffffff', '#ffffff') - 1) < 0.001, '同色对比度应为 1:1');
  assert.ok(contrast('#ffffff', '#000000') === contrast('#000000', '#ffffff'),
    '参数顺序不应影响结果');
});

/* ---------- 文字压在**强调色底**上(主按钮)----------
 * 上面那些用例算的都是「色值对纸面背景」,漏掉了反过来的情形:底色本身是
 * --accent(主按钮 .btn.primary),字色写在规则里、与主题无关地硬编码 #fff。
 * 亮色主题下白字压 #2f5a92 是 6.56:1(达标),所以这条一直没被看见 ——
 * 但暗色主题为了让 --accent 在暗纸上达标把它**提亮**成了 #7fa7d9,
 * 白字压上去只剩 2.49:1,不到 AA 门槛的一半。
 * 判据必须按主题分别取「实际生效的字色」来算,不能只看一个硬编码值。 */

/** 取某条规则里某个属性**实际生效**的声明值(找不到返回 null)。 */
function decl(selector, prop) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `style.css 里找不到规则「${selector}」`);
  // `(?:^|[;{\s])` 让 `color` 不会命中 `border-color`(它前面是 `-`,不在允许集合里)
  const d = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`).exec(m[1]);
  return d ? d[1].trim() : null;
}

/** 把声明值解析成真实色值:支持 #rgb / #rrggbb / var(--token)。 */
function color(v, theme = 'light') {
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(v ?? '').trim());
  if (!m) return v;
  const t = tokens(m[1]);
  const hex = theme === 'dark' ? (t.dark || t.light) : t.light;
  assert.ok(hex, `解析不到 ${m[1]} 的${theme === 'dark' ? '暗色' : '亮色'}值`);
  return hex;
}

test('对比度:主按钮文字压在强调色底上必须 ≥4.5:1(亮/暗两套主题都要算)', () => {
  const cases = [
    ['亮色', T.accent.light, color(decl('.btn.primary', 'color'), 'light')],
    ['暗色', T.accent.dark, color(decl(':root[data-theme="dark"] .btn.primary', 'color'), 'dark')],
  ];
  for (const [theme, bg, fg] of cases) {
    assert.ok(bg && fg, `${theme}主题:取不到 --accent 或 .btn.primary 的字色(取到 ${bg} / ${fg})`);
    const r = contrast(fg, bg);
    assert.ok(r >= 4.5,
      `${theme}主题主按钮文字 ${fg} 压在强调色底 ${bg} 上只有 ${r.toFixed(2)}:1 —— ` +
      `界面上最显眼的「确定 / 保存 / 登录」正好糊在底里`);
  }
});

test('对比度:暗色主按钮 hover 态同样达标(--accent-hover 比 --accent 更浅)', () => {
  const hover = tokens('--accent-hover');
  const fg = color(decl(':root[data-theme="dark"] .btn.primary', 'color'), 'dark');
  assert.ok(hover.dark && fg, '取不到暗色 --accent-hover 或暗色主按钮字色');
  const r = contrast(fg, hover.dark);
  assert.ok(r >= 4.5, `暗色主按钮 hover 文字 ${fg} on ${hover.dark} 只有 ${r.toFixed(2)}:1`);
});

test('对比度:暗色主按钮的禁用态必须单独给字色(底色比 accent 深,深墨字会看不见)', () => {
  /* 上面那条把暗色主按钮的字色改成了深墨色(#1e2128)。而禁用态把底色换成
   * 更深的 #3a4456 —— 深墨字压上去只有 1.59:1,几乎等于隐形。
   * WCAG 1.4.3 豁免「非活动控件」,但看不出有个按不了的按钮不算豁免得了的问题,
   * 所以这里要求它单独声明一个浅色字(≥3:1)。 */
  const sel = ':root[data-theme="dark"] .btn.primary:disabled';
  const disabled = color(decl(sel, 'color'), 'dark');
  const bg = color(decl(sel, 'background'), 'dark');
  assert.ok(disabled, '暗色主按钮的禁用态必须显式给 color —— 否则会继承深墨字,压在深底上看不见');
  assert.ok(bg, '取不到暗色禁用态的 background');
  const r = contrast(disabled, bg);
  assert.ok(r >= 3, `暗色禁用态主按钮文字 ${disabled} on ${bg} 只有 ${r.toFixed(2)}:1(至少要能读出「这里有个按不了的按钮」)`);
});