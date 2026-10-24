/* ============================================================
 * 主题三态(2026-10-24 A2:features/theme.js 的 setThemeMode / themeMode)
 * ------------------------------------------------------------
 * 顶栏按钮是二态快切(只落浅/深),「跟随系统」只能来自设置面板的三态。
 * 本文件钉三态语义:
 *   · light/dark = 写偏好 + 应用;
 *   · system     = 摘掉偏好 + 按系统当前值落一次;
 *   · themeMode() 回显:无偏好 = 'system'(面板分段按钮要靠它点亮)。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initTheme, setThemeMode, themeMode } from '../public/js/features/theme.js';
import { withDom, withLocalStorage } from './dom-stub.mjs';

/** theme.js 的 applyTheme 会碰 ctx.dom.byId('btnTheme') 与 documentElement */
const makeCtx = (store, byId) => ({ store, dom: { byId }, icons: { sun: '<svg>s</svg>', moon: '<svg>m</svg>' } });

await test('三态:写偏好、摘偏好、回显', async () => {
  await withDom(async (ctx, byId) => {
    const ls = withLocalStorage();
    try {
      initTheme(ctx(undefined));   // 无偏好、无 matchMedia(Node 环境)→ 浅色
      assert.equal(themeMode(), 'system');
      assert.equal(document.documentElement.dataset.theme, 'light');

      setThemeMode(ctx(undefined), 'dark');
      assert.equal(themeMode(), 'dark');
      assert.equal(document.documentElement.dataset.theme, 'dark');
      assert.equal(ls.map.get('jmbiji.theme'), 'dark');

      setThemeMode(ctx(undefined), 'system');
      assert.equal(themeMode(), 'system');
      assert.equal(ls.map.has('jmbiji.theme'), false, '跟随系统必须把显式偏好摘掉');
      assert.equal(document.documentElement.dataset.theme, 'light'); // 无 matchMedia → 按浅色落

      // 顶栏二态快切仍然只落显式值(与三态分工不变)
      setThemeMode(ctx(undefined), 'dark');
      assert.equal(themeMode(), 'dark');
    } finally { ls.restore(); }
  });
});

await test('脏偏好值不当成合法模式(回退 system,而不是把 data-theme 写成脏值)', async () => {
  await withDom(async (ctx) => {
    const ls = withLocalStorage();
    try {
      ls.map.set('jmbiji.theme', 'rainbow');
      assert.equal(themeMode(), 'system');
    } finally { ls.restore(); }
  });
});
