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
  assert.equal(READ_SIZES[normalizeReadingPref(null).size], '15px', '字号默认应为 15px');
  assert.equal(READ_LHS[normalizeReadingPref(null).lh], '1.85', '行距默认应为 1.85');
  /* 默认全宽是 2026-09-28 用户明确要求过的形态,不许被悄悄改成某个定宽档。 */
  assert.equal(READ_MEASURES[normalizeReadingPref(null).measure], 'none',
    '宽度默认必须是 none(全宽):2026-09-28 用户明确要求通栏');
});

/* 2026-10-25 用户拍板方向 B:**px 定宽,与字号解耦**。
 * 原先居中档是 '36em' —— em 相对正文自身的 font-size,切字号时行宽会跟着
 * 从 540 偷偷变成 612px。这里钉死两件事:
 *   ① 除全宽外每档都必须是 px(出现 em 就说明又耦合回去了);
 *   ② 老键名 wide / center 必须还在(改名会把已存偏好收敛回默认、静默抹掉用户选择)。 */
test('行宽五档:除全宽外一律 px 定宽(不得回退成 em)', () => {
  const keys = Object.keys(READ_MEASURES);
  assert.equal(keys.length, 5, '应为五档,实际 ' + keys.join('/'));
  assert.equal(READ_MEASURES.wide, 'none', '全宽档必须是 none');
  for (const k of ['narrow', 'center', 'broad', 'wider']) {
    assert.ok(READ_MEASURES[k], '缺少档位 ' + k);
    assert.match(READ_MEASURES[k], /^\d+px$/, k + ' 必须是 px 定宽(当前 ' + READ_MEASURES[k] + ')');
  }
});

/* 老键名兼容单列一个用例,理由:上面那条用例里的 `assert.ok(READ_MEASURES[k])`
 * 会**先**因为「缺少档位 center」翻红,把「老键名不许改名」这条意图完全遮住 ——
 * 反向探针实测(2026-10-25):把 center 改成 standard,只有「缺少档位」报出来,
 * 「老键名必须保留」那条断言从未被执行到。两条断言结构重叠时,后者等于不存在。
 * 拆出来之后,改名会命中一条专门说明后果的断言。 */
test('老键名 wide / center 不得改名(改了就静默抹掉已存偏好)', () => {
  for (const legacy of ['wide', 'center']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(READ_MEASURES, legacy),
      '老键名 ' + legacy + ' 必须保留:改名后已存的 { measure: \'' + legacy + '\' } 落不到新表,'
      + 'normalizeReadingPref 会收敛回默认,用户的选择被静默抹掉',
    );
  }
});

test('行宽与字号解耦:三档字号下版心宽度恒定', () => {
  /* 这是方向 B 的核心承诺。不带这条断言的话,把 px 改回 em 也能全绿 ——
   * 因为「有档位、是 px」这些结构事实都还在(只是 unit 变了)。
   * 用相对关系而不是绝对像素:apply 后从表里读值,三档字号共用同一份 measure,
   * 与 READ_SIZES 的任何一档无关。 */
  const measures = ['narrow', 'center', 'broad', 'wider'].map((m) => READ_MEASURES[m]);
  assert.equal(new Set(measures).size, 4, '四档定宽的数值不得重复');
  // 单调递增:档位名字是「窄→更宽」的顺序,数值必须跟着涨
  const px = measures.map((m) => parseInt(m, 10));
  for (let i = 1; i < px.length; i++) {
    assert.ok(px[i] > px[i - 1], '档位数值必须随名字递增:' + measures.join(' < '));
  }
  // 且都不含 em/rem/ch/vw —— 任何相对单位都会重新引入与字号或视口的耦合
  for (const m of measures) {
    assert.doesNotMatch(m, /em|rem|ch|vw|%/, '定宽档不得含相对单位:' + m);
  }
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
      assert.equal(p['--read-measure'], '720px');
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
