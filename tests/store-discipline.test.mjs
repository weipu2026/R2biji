/* ============================================================
 * store 使用纪律守卫(2026-09-27 新增)
 *
 * 起因:DESIGN.md §10.5 一直写着「defaultState 漏声明会红」,
 *       但**实际并不存在这条守卫**。抽 features/shell.js 时才发现
 *       lock.js 用了许久的 'lockMode' 从来没在 defaultState 里声明过,
 *       一路无人拦。
 * 教训:文档里写着的守卫,必须能在代码里指出它在哪一行 ——
 *       否则那只是一句自我安慰。
 *
 * 本文件盯两条纪律:
 *   ① 所有被写入的 store 字段,必须先在 defaultState() 声明
 *      (隐式字段会让 get() 读不到、订阅也接不上)
 *   ② feature 拿到的是**原始 store**,不得直访字段,必须走 get/set
 *      (ui.js 内部的 S 是 createProxy,直访是它的特权)
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { defaultState } from '../public/js/store.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_JS = join(ROOT, 'public', 'js');
const FEATURES = join(PUBLIC_JS, 'features');

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('★ 被写入的 store 字段必须先在 defaultState() 声明(防隐式字段)', () => {
  const declared = new Set(Object.keys(defaultState()));
  const offenders = [];

  for (const f of jsFiles(PUBLIC_JS)) {
    const src = readFileSync(f, 'utf8');
    // 只认「字面量键」的写法 —— Map/Set 的 .set() 都用变量键,不会命中
    for (const m of src.matchAll(/\.set\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
      if (!declared.has(m[1])) offenders.push(`${relative(ROOT, f)} → set('${m[1]}')`);
    }
    // patch({ a: 1, b }) —— 键只出现在 `{` 或 `,` 之后且紧跟冒号。
    // ⚠️ 不能写成 /(?:\s)([A-Za-z_]\w*)\s*[:,]/ —— 那会把**值**也吞进来
    //    (`{ activeCat: null, ... }` 里的 null 前面正好有空格)。
    //    (2026-09-27 实测:首版正则报出「patch({ null })」这种假阳性。)
    for (const m of src.matchAll(/\.patch\(\{([^}]*)\}/g)) {
      for (const km of m[1].matchAll(/[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
        if (!declared.has(km[1])) offenders.push(`${relative(ROOT, f)} → patch({ ${km[1]} })`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    '以下字段被写入但未在 store.js 的 defaultState() 声明(隐式字段会让 get() 读不到):\n'
    + offenders.join('\n'));
});

test('★ feature 不得直访 store 字段(拿到的是原始 store,必须走 get/set)', () => {
  const offenders = [];
  for (const f of readdirSync(FEATURES).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(FEATURES, f), 'utf8');
    // 匹配 ctx.store.<字段> —— 读与写都算;get/set/patch/subscribe 是方法,放行
    for (const m of src.matchAll(/ctx\.store\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const k = m[1];
      if (k === 'get' || k === 'set' || k === 'patch' || k === 'subscribe') continue;
      offenders.push(`${f} → ctx.store.${k}`);
    }
  }
  assert.deepEqual(offenders, [],
    'feature 不得直访 store 字段 —— 原始 store 的字段都在 _state 里,\n'
    + '直访写只会挂个没人读的实例属性,直访读恒为 undefined。请改 get()/set():\n'
    + offenders.join('\n'));
});
