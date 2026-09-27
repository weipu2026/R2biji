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

export function loadThemePref() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

export function setThemePref(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* 隐私模式:仅本次会话生效 */ }
}

/** 应用主题到 <html data-theme>、切换按钮图标、以及浏览器 UI 色。 */
export function applyTheme(mode, ctx) {
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

/** 启动时初始化:优先用户显式偏好,否则跟随系统;未显式设置时跟随系统变化。 */
export function initTheme(ctx) {
  const pref = loadThemePref();
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  applyTheme(pref || (mq && mq.matches ? 'dark' : 'light'), ctx);
  if (!pref && mq && mq.addEventListener) {
    mq.addEventListener('change', (e) => {
      if (!loadThemePref()) applyTheme(e.matches ? 'dark' : 'light', ctx);
    });
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
