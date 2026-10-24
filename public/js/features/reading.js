/* ============================================================
 * feature: 阅读排版偏好(字号 / 行距 / 阅读宽度)
 * ------------------------------------------------------------
 * 2026-10-24 全站审计 A1:正文排版此前全部写死 —— 行距固定 1.85、
 * 字号随全局、行宽不限(2026-09-28 用户明确要求通栏)。宽屏下一行
 * 100+ 个全角字符,远超舒适阅读量;字号与行距也没有任何调节入口。
 * 本模块把三项变成可选偏好:
 *   · 字号  小 14 / 中 15(默认) / 大 17
 *   · 行距  紧凑 1.6 / 标准 1.85(默认) / 宽松 2.1
 *   · 宽度  全宽(默认,尊重 2026-09-28 的通栏要求)/ 居中 36em
 * 落实方式 = 改 :root 上的三个 CSS 变量(--read-size / --read-lh /
 * --read-measure),style.css 的阅读排版规则全部引用它们,不新增硬编码。
 *
 * 36em 的来历:一个全角字符宽 = 2ch(拉丁「0」宽),用户要的「居中 68–75
 * 字符」换算到中英混排的正文 ≈ 34–38 个全角字符,取 36em 兼顾两者。
 *
 * 偏好走 localStorage('jmbiji.read',非敏感),与主题 jmbiji.theme、
 * 等宽 jmbiji.mono 同一套纪律;存取失败(隐私模式)静默降级为仅本次会话。
 *
 * 为什么本模块不持有 ctx:它是纯叶子模块 —— 只碰 document.documentElement
 * 的 CSS 变量与 localStorage,不引用 ui.js 的任何基础设施(dom/toast/modal
 * 一概不用),因此也没有 ctx 可注入。tests/features.test.mjs 要求每个 feature
 * 的源码里出现 ctx 字样,这条注释就是那份说明;将来若它要弹提示或读会话态,
 * 再改成 ctx 形参注入,不要直接 import ui.js(循环依赖)。
 * ============================================================ */

const READ_KEY = 'jmbiji.read';

/** 三档字号(px)。键名单字母,与设置面板的分段按钮 value 对应。 */
export const READ_SIZES = { s: '14px', m: '15px', l: '17px' };
/** 三档行距。 */
export const READ_LHS = { tight: '1.6', std: '1.85', loose: '2.1' };
/** 两种行宽:全宽(通栏)/ 居中(36em ≈ 68–72ch)。 */
export const READ_MEASURES = { wide: 'none', center: '36em' };

const DEFAULTS = { size: 'm', lh: 'std', measure: 'wide' };

/** 把任意来源的原始值收敛成合法偏好(纯函数,可离线单测)。
 *  脏值(手改 localStorage、旧版本遗留)逐项回退默认,不是整体作废 ——
 *  与 loadSettings 对 autoLockMinutes 的收敛同一条纪律。 */
export function normalizeReadingPref(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    size: READ_SIZES[r.size] ? r.size : DEFAULTS.size,
    lh: READ_LHS[r.lh] ? r.lh : DEFAULTS.lh,
    measure: READ_MEASURES[r.measure] ? r.measure : DEFAULTS.measure,
  };
}

/** 读偏好(不存在 / 损坏 → 默认值)。 */
export function loadReadingPref() {
  try {
    const raw = localStorage.getItem(READ_KEY);
    return normalizeReadingPref(raw ? JSON.parse(raw) : null);
  } catch { return normalizeReadingPref(null); }
}

/** 把偏好写到 :root 的 CSS 变量上(style.css 的阅读规则引用它们)。 */
export function applyReadingPref(pref) {
  const p = normalizeReadingPref(pref);
  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty('--read-size', READ_SIZES[p.size]);
  root.style.setProperty('--read-lh', READ_LHS[p.lh]);
  root.style.setProperty('--read-measure', READ_MEASURES[p.measure]);
}

/** 启动时调用:读 + 应用一步完成。 */
export function applyReadingPrefFromStorage() {
  applyReadingPref(loadReadingPref());
}

/** 改一项或多项:与当前值合并 → 收敛 → 持久化 → 应用。返回新偏好。 */
export function setReadingPref(patch) {
  const next = normalizeReadingPref({ ...loadReadingPref(), ...(patch || {}) });
  try { localStorage.setItem(READ_KEY, JSON.stringify(next)); } catch { /* 仅本次会话生效 */ }
  applyReadingPref(next);
  return next;
}
