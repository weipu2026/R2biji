/* ============================================================
 * 阅读排版偏好(2026-10-24 A1:features/reading.js)
 * ------------------------------------------------------------
 * 三档字号 / 三档行距 / 两种行宽,落在 :root 的三个 CSS 变量上。
 * 用例分两层:
 *   ① normalizeReadingPref 纯函数(脏值逐项回退,不是整体作废);
 *   ② load / set / apply 的编排(localStorage 读写 + CSS 变量落点)。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReadingPref, loadReadingPref, setReadingPref, applyReadingPref,
  READ_SIZES, READ_LHS, READ_MEASURES,
} from '../public/js/features/reading.js';
import { withDom, withLocalStorage } from './dom-stub.mjs';

test('normalize:合法值原样通过,缺项回退默认', () => {
  assert.deepEqual(normalizeReadingPref({ size: 'l', lh: 'loose', measure: 'center' }),
    { size: 'l', lh: 'loose', measure: 'center' });
  assert.deepEqual(normalizeReadingPref({}), { size: 'm', lh: 'std', measure: 'wide' });
  assert.deepEqual(normalizeReadingPref(null), { size: 'm', lh: 'std', measure: 'wide' });
  assert.deepEqual(normalizeReadingPref('垃圾'), { size: 'm', lh: 'std', measure: 'wide' });
});

test('normalize:脏值**逐项**回退,不连坐同批的合法项', () => {
  // 「字号被手改坏、行距合法」时只回落差那一项 —— 整体作废会让用户
  // 莫名其妙丢光偏好(与 loadSettings 对 autoLockMinutes 的收敛同纪律)
  assert.deepEqual(normalizeReadingPref({ size: 'XXL', lh: 'tight', measure: 'wide' }),
    { size: 'm', lh: 'tight', measure: 'wide' });
  assert.deepEqual(normalizeReadingPref({ size: 's', lh: 1.85, measure: 'nope' }),
    { size: 's', lh: 'std', measure: 'wide' });
});

test('三张取值表与默认值互为印证(改表忘了改默认会静默错档)', () => {
  assert.equal(READ_SIZES[normalizeReadingPref(null).size], '15px');
  assert.equal(READ_LHS[normalizeReadingPref(null).lh], '1.85');
  assert.equal(READ_MEASURES[normalizeReadingPref(null).measure], 'none');
});

await test('load/set/apply:localStorage ↔ CSS 变量闭环', async () => {
  await withDom(async (ctx, byId) => {
    const ls = withLocalStorage();
    try {
      // 无偏好 → 默认值三件套
      applyReadingPref(loadReadingPref());
      let p = document.documentElement.style._p;
      assert.equal(p['--read-size'], '15px');
      assert.equal(p['--read-lh'], '1.85');
      assert.equal(p['--read-measure'], 'none');

      // 单项合并不冲掉其余两项(设置面板就是逐项点的)
      setReadingPref({ size: 'l' });
      p = document.documentElement.style._p;
      assert.equal(p['--read-size'], '17px');
      assert.equal(p['--read-lh'], '1.85');       // 未被冲掉
      assert.equal(p['--read-measure'], 'none');  // 未被冲掉
      assert.equal(ls.map.get('jmbiji.read'), JSON.stringify({ size: 'l', lh: 'std', measure: 'wide' }));

      // 持久化 → 重新 load 读回
      setReadingPref({ lh: 'loose', measure: 'center' });
      assert.deepEqual(loadReadingPref(), { size: 'l', lh: 'loose', measure: 'center' });
      p = document.documentElement.style._p;
      assert.equal(p['--read-lh'], '2.1');
      assert.equal(p['--read-measure'], '36em');
    } finally { ls.restore(); }
  });
});

await test('load:localStorage 损坏(手改 / 旧版遗留)时回落默认,不抛', async () => {
  await withDom(async () => {
    const ls = withLocalStorage();
    try {
      ls.map.set('jmbiji.read', '{ 这不是 JSON');
      assert.deepEqual(loadReadingPref(), { size: 'm', lh: 'std', measure: 'wide' });
      ls.map.set('jmbiji.read', JSON.stringify({ size: 'l', lh: '坏', measure: 'center' }));
      assert.deepEqual(loadReadingPref(), { size: 'l', lh: 'std', measure: 'center' });
    } finally { ls.restore(); }
  });
});
