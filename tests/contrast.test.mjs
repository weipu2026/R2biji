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
  const h = hex.replace('#', '');
  assert.match(h, /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i, `色值格式不对:${hex}`);
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