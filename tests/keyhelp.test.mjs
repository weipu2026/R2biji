/* ============================================================
 * 快捷键帮助面板的数据契约
 *
 * 为什么要单独测:清单是**手写常量**,真机上要逐条按过才知道对不对,而「键位重复」
 * 「文案为空」「组里没条目」这类漂移不会有任何报错 —— 弹出来就是一份骗人的清单。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_HELP_GROUPS } from '../public/js/features/shell.js';

test('清单结构:每组有名字有条目,条目有键位有文案', () => {
  assert.ok(KEY_HELP_GROUPS.length >= 3, '至少 全局 / 阅读 / 编辑 三组');
  const seen = new Set();
  for (const g of KEY_HELP_GROUPS) {
    assert.ok(g.name && g.name.trim(), '组名不能空');
    assert.ok(Array.isArray(g.items) && g.items.length, `「${g.name}」组不能空`);
    for (const it of g.items) {
      assert.ok(Array.isArray(it.keys) && it.keys.length, `「${g.name}」有条目没有键位`);
      assert.ok(it.desc && it.desc.trim(), `「${g.name} / ${it.keys.join('+')}」没有说明文案`);
      // 键位在组合串意义上唯一:同一个组合写两遍,用户会以为有两个不同功能
      const key = it.keys.join('+');
      assert.ok(!seen.has(key), `键位「${key}」重复出现(分组不同也不行:用户只记键位)`);
      seen.add(key);
    }
  }
});

test('清单必须覆盖已实现的快捷键(漏一个就等于清单骗人)', () => {
  /* 上面防重复,这里防遗漏:新增快捷键却忘了加进清单时,用户按下去有反应、
   * 清单里查不到 —— 那正是这个面板要消灭的问题。 */
  const keys = KEY_HELP_GROUPS.flatMap((g) => g.items.map((i) => i.keys.join('+')));
  for (const k of ['Ctrl+S', 'Ctrl+K', 'Ctrl+Shift+L', '?', 'J', 'K', 'Ctrl+Enter']) {
    assert.ok(keys.includes(k), `清单里必须有「${k}」`);
  }
});

test('触屏手势必须单独成组(手机上照抄桌面清单会让人以为功能缺失)', () => {
  const names = KEY_HELP_GROUPS.map((g) => g.name);
  assert.ok(names.some((n) => /触屏|手势/.test(n)), '必须有一组专门讲触屏手势');
  // 桌面组里不该混进手势描述
  for (const g of KEY_HELP_GROUPS) {
    if (/触屏|手势/.test(g.name)) continue;
    for (const it of g.items) {
      assert.doesNotMatch(it.desc, /滑动|双击/,
        `「${g.name} / ${it.keys.join('+')}」是桌面条目,不该描述触屏手势`);
    }
  }
});
