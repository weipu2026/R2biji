/* ============================================================
 * shell.js 的新增导出(2026-10-24):混版自愈判据 + 导入分流
 * ------------------------------------------------------------
 * ① mixedShellGaps —— 「新 HTML + 旧 JS」混版的判据。部署后首次访问,
 *    index.html 走 network-first 永远最新,js 模块走 stale-while-revalidate
 *    可能还是旧版:旧 JS 不认识新按钮 → 无图标、点击无反应、控制台零报错
 *    (2026-10-24 用户线上实测)。判据必须同时满足两个条件才报缺口:
 *    「HTML 声明了」且「文档里存在」且「没被本版本 JS 打标」。
 * ② classifyImportFiles / routeImports —— 文件选择与拖拽放置共用的分流。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mixedShellGaps, classifyImportFiles, routeImports } from '../public/js/features/shell.js';

/* ── ① 混版自愈判据 ── */

test('mixedShellGaps:一致态(全部存在且已打标)→ 无缺口', () => {
  const doc = {
    documentElement: { dataset: { controls: 'btnSettings btnPrint' } },
    getElementById: (id) => ({ dataset: { wired: '1' } }),
  };
  assert.deepEqual(mixedShellGaps(doc), []);
});

test('mixedShellGaps:混版(存在但没打标)→ 点名', () => {
  const doc = {
    documentElement: { dataset: { controls: 'btnSettings btnPrint' } },
    getElementById: (id) => (id === 'btnSettings' ? { dataset: { wired: '1' } } : { dataset: {} }),
  };
  assert.deepEqual(mixedShellGaps(doc), ['btnPrint']);
});

test('mixedShellGaps:反向混版(声明了但文档里没有)→ 不报', () => {
  // 旧 HTML + 新 JS(离线兜底):绑定处已有 voidEl 保险,重载也还是旧 HTML,
  // 报了就会白重载一次 —— 判据绝不能朝这个方向开火。
  const doc = {
    documentElement: { dataset: { controls: 'btnSettings btnPrint' } },
    getElementById: (id) => (id === 'btnSettings' ? { dataset: { wired: '1' } } : null),
  };
  assert.deepEqual(mixedShellGaps(doc), []);
});

test('mixedShellGaps:声明为空 / 格式脏(多余空白)都不误报', () => {
  assert.deepEqual(mixedShellGaps({ documentElement: { dataset: {} }, getElementById: () => ({ dataset: {} }) }), []);
  const doc = {
    documentElement: { dataset: { controls: '  btnSettings   btnPrint  ' } },
    getElementById: (id) => ({ dataset: { wired: '1' } }),
  };
  assert.deepEqual(mixedShellGaps(doc), []);
});

/* ── ② 导入分流 ── */

const f = (name) => ({ name });

test('classifyImportFiles:按扩展名三堆,大小写不敏感', () => {
  const r = classifyImportFiles([f('a.zip'), f('b.MD'), f('c.markdown'), f('d.txt'), f('e.png'), f('f.pdf')]);
  assert.deepEqual(r.zips.map((x) => x.name), ['a.zip']);
  assert.deepEqual(r.texts.map((x) => x.name), ['b.MD', 'c.markdown', 'd.txt']);
  assert.deepEqual(r.bad.map((x) => x.name), ['e.png', 'f.pdf']);
});

test('classifyImportFiles:空与脏输入不抛', () => {
  assert.deepEqual(classifyImportFiles([]), { zips: [], texts: [], bad: [] });
  assert.deepEqual(classifyImportFiles(undefined), { zips: [], texts: [], bad: [] });
  const r = classifyImportFiles([f(''), {}, null]);
  assert.equal(r.zips.length + r.texts.length + r.bad.length, 3); // 全部落 bad,不炸
});

test('routeImports:全是不支持的格式 → 只提示,不启动任何导入', () => {
  const calls = [];
  const ctx = { toast: (m) => calls.push(['toast', m]), importFromBackup: (x) => calls.push(['zip', x]) };
  routeImports(ctx, [f('a.png'), f('b.exe')]);
  assert.deepEqual(calls, [['toast', '只支持 .zip 备份包与 .md / .txt 文本文件']]);
});

test('routeImports:单个 zip 走备份恢复;多个 zip 取第一个并说明', () => {
  const calls = [];
  const ctx = { toast: (m, k) => calls.push(['toast', m, k]), importFromBackup: (x) => calls.push(['zip', x]) };
  routeImports(ctx, [f('a.zip')]);
  assert.deepEqual(calls, [['zip', { name: 'a.zip' }]]);

  calls.length = 0;
  routeImports(ctx, [f('a.zip'), f('b.zip')]);
  assert.equal(calls[0][0], 'toast');
  assert.equal(calls[1][0], 'zip');
  assert.equal(calls[1][1].name, 'a.zip', '多个备份包只恢复第一个');
});
