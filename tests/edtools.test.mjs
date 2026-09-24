/* ============================================================
 * 编辑器选区工具(加粗/高亮/行内码/行前缀)的契约单测。
 * 这层的错误同样「静默」:包裹位置差一位,表现只是快捷键插错地方,
 * 不报任何错 —— 必须钉住。mock 只覆盖 wrapSel/prefixLines 用到的那点面。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapSel, prefixLines } from '../public/js/ui.js';

function ta(value, s, e = s) {
  return {
    value, selectionStart: s, selectionEnd: e,
    sel: null,
    setSelectionRange(a, b) { this.sel = [a, b]; },
  };
}

test('wrapSel:空选区插入一对标记,光标落在中间', () => {
  const t = ta('', 0);
  wrapSel(t, '**');
  assert.equal(t.value, '****');
  assert.deepEqual(t.sel, [2, 2]);
});

test('wrapSel:有选区时把选区包起来,选区保持选中', () => {
  const t = ta('abc', 0, 3);
  wrapSel(t, '**');
  assert.equal(t.value, '**abc**');
  assert.deepEqual(t.sel, [2, 5]);
});

test('wrapSel:再点一次已包裹的选区 = 取消包裹', () => {
  const t = ta('**abc**', 2, 5);
  wrapSel(t, '**');
  assert.equal(t.value, 'abc');
  assert.deepEqual(t.sel, [0, 3]);
});

test('wrapSel:部分重叠不误剥(只有一侧命中就按正常包裹走)', () => {
  const t = ta('***abc', 3, 6);
  wrapSel(t, '**');
  assert.equal(t.value, '*****abc**');
  assert.deepEqual(t.sel, [5, 8]);
});

test('prefixLines:单行加前缀', () => {
  const t = ta('foo', 0, 0);
  prefixLines(t, '- ');
  assert.equal(t.value, '- foo');
  assert.deepEqual(t.sel, [0, 5]);
});

test('prefixLines:多行整段加前缀,未触及的行不动', () => {
  const t = ta('x\na\nb', 3, 6); // 选区只在 a、b 两行
  prefixLines(t, '# ');
  assert.equal(t.value, 'x\n# a\n# b');
});

test('prefixLines:全部已带前缀再点 = 去掉前缀(开关语义)', () => {
  const t = ta('# a\n# b', 0, 6);
  prefixLines(t, '# ');
  assert.equal(t.value, 'a\nb');
});

test('prefixLines:混合(部分带部分不带)→ 统一补齐而不是剥掉', () => {
  const t = ta('- a\nb', 0, 4);
  prefixLines(t, '- ');
  assert.equal(t.value, '- a\n- b');
});
