/* ============================================================
 * feature: 深浅色主题
 * ------------------------------------------------------------
 * 从 ui.js 的「深浅色主题」区块原样迁出。
 *
 * 依赖(经 ctx 注入,见 ui.js 顶部 ctx 说明):
 *   - dom.byId(id)  取元素
 *   - icons         描边图标表(btnTheme 用 sun/moon)
 * 不碰 store 状态:主题偏好直接走 localStorage,与加密/会话无关。
 * ============================================================ */

const THEME_KEY = 'jmbiji.theme';

/** 深/浅色下 <meta name="theme-color"> 的取值(与 css 变量同色) */
const THEME_COLOR = { dark: '#1e2128', light: '#faf8f2' };

function loadThemePref() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function setThemePref(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* 隐私模式:仅本次会话生效 */ }
}

/** 应用主题到 <html data-theme>、切换按钮图标、以及浏览器 UI 色。 */
function applyTheme(mode, ctx) {
  const root = document.documentElement;
  if (root) root.dataset.theme = mode;
  const btn = ctx.dom.byId('btnTheme');
  if (btn) {
    btn.innerHTML = mode === 'dark' ? ctx.icons.sun : ctx.icons.moon;
    btn.title = mode === 'dark' ? '切换为浅色' : '切换为深色';
    btn.setAttribute('aria-label', btn.title);
  }
  const meta = document.querySelector && document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[mode] || THEME_COLOR.light);
}

/** 启动时初始化:优先用户显式偏好,否则跟随系统。
 *  系统监听**常驻**(不再要求「当前无偏好」):设置面板可以把偏好摘掉
 *  切回跟随系统,彼时监听若已被摘,「跟随」就名不副实。handler 内部
 *  再判一次 loadThemePref(),显式偏好在位时自然空转,不会抢。 */
export function initTheme(ctx) {
  const pref = loadThemePref();
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  applyTheme(pref || (mq && mq.matches ? 'dark' : 'light'), ctx);
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', (e) => {
      if (!loadThemePref()) applyTheme(e.matches ? 'dark' : 'light', ctx);
    });
  }
}

/** 当前主题模式:'system' 跟随系统 / 'light' / 'dark'(显式偏好)。
 *  设置面板的分段按钮要靠它回显当前项。 */
export function themeMode() {
  const pref = loadThemePref();
  return pref === 'dark' || pref === 'light' ? pref : 'system';
}

/** 设置主题模式(设置面板用):三态。
 *  · 'system' = 摘掉显式偏好、立即按系统当前值落一次,之后跟随变化;
 *  · 'light' / 'dark' = 写入偏好并应用。
 *  与 toggleTheme(顶栏二态快切)的分工:快切永远落到显式浅/深,
 *  想要「跟随系统」只能来这里 —— 二态按钮表达不了三态。 */
export function setThemeMode(ctx, mode) {
  if (mode === 'system') {
    try { localStorage.removeItem(THEME_KEY); } catch { /* 隐私模式:仅本次会话 */ }
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    applyTheme(mq && mq.matches ? 'dark' : 'light', ctx);
  } else if (mode === 'light' || mode === 'dark') {
    setThemePref(mode);
    applyTheme(mode, ctx);
  }
}

/** 用户在顶栏点「主题」:翻转并存偏好。返回新主题(供调用方更新 aria 等)。 */
export function toggleTheme(ctx) {
  const cur = (document.documentElement && document.documentElement.dataset.theme) || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  setThemePref(next);
  applyTheme(next, ctx);
  return next;
}
