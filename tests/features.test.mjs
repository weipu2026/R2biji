/* ============================================================
 * features/ 模块契约守卫
 *
 * 为什么需要:features/ 是从 ui.js 拆出的模块,它们靠「ctx 注入」拿共享基础设施。
 * 这层契约有三处最容易坏、而且**坏了不会报错只会静默失效**:
 *   1. 模块被 import 了但漏登记进 sw.js 的 ASSETS → 离线白屏(assets.test.mjs 管)
 *   2. feature 引用了 ctx 里没有的字段 → 运行时 undefined 报错
 *   3. feature 偷偷 import 了 ui.js → 循环依赖(ui.js 又 import 它)
 * 本文件盯 2 与 3;1 由 assets.test.mjs 的递归扫描盯。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FEATURES = join(ROOT, 'public', 'js', 'features');
const UI = join(ROOT, 'public', 'js', 'ui.js');

/** ctx 里当前提供的字段(与 ui.js 里 `const ctx = {...}` 同步)。
 *  ★ 加新注入项时,**必须**同时更新这里 —— 否则下面的「feature 只用已注入字段」
 *    用例会红,提前拦住「feature 引用了不存在的 ctx 字段」。 */
const CTX_KEYS = ['dom', 'icons', 'toast', 'modal', 'store', 'markDirty', 'copyText', 'downloadBytes',
  'saveAll', 'resetStatusPriority', 'stopIdleTimer', 'enterApp', 'api', 'session', 'vault', 'Library',
  'fmtTime', 'showEmpty', 'closeDrawer', 'renderMarkdown',
  // 本文件私有、但 shell.js 需要的基础设施
  'assessPassword', 'wrapSel', 'prefixLines', 'loadSettings', 'saveSettings', 'saveRememberPref',
  'changePassword', 'exportFullBackup', 'importFromBackup', 'TabSync', 'onTabMessage',
  // feature 之间的入口(已绑定 ctx)
  'clickable', 'openNote', 'activeNoteData', 'renderNoteList', 'renderCategoryList',
  'addNote', 'renderReadView', 'moveNote', 'toggleNotePin',
  // shell.js 的入口绑定(一律不带 ctx)
  'showLock', 'lockNow', 'doUnlock', 'doCreateLibrary', 'resumeSession',
  'addCategory', 'renameCategory', 'deleteCategory', 'openCategory',
  'enterEditMode', 'exitEditMode', 'collectEditChanges', 'addAttachments',
  'copyWholeNote', 'deleteNote', 'moveNoteSelection',
  'runSearch', 'closeSearch', 'toggleTheme', 'initTheme', 'openTrash', 'openPwGenerator', 'exportNoteMd'];

function featureFiles() {
  if (!existsSync(FEATURES)) return [];
  return readdirSync(FEATURES).filter((f) => f.endsWith('.js'));
}

test('features/ 目录存在且至少有一个模块(重构产出,别被误删)', () => {
  assert.ok(featureFiles().length > 0, 'features/ 下应当有拆出的 feature 模块');
});

test('★ 每个 feature 都通过 mount(ctx) 或显式形参接收 ctx,不 import ui.js(防循环依赖)', () => {
  for (const f of featureFiles()) {
    const src = readFileSync(join(FEATURES, f), 'utf8');
    // 循环依赖:feature 一旦 import ui.js,ui.js 又 import 它 → 加载顺序未定义
    assert.doesNotMatch(src, /from\s+['"][^'"]*ui\.js['"]/,
      `${f} 不得 import ui.js(会造成循环依赖)`);
    // ctx 的获取方式:要么 module 级持有,要么形参传入 —— 至少得出现 ctx
    assert.match(src, /\bctx\b/, `${f} 应当通过 ctx 拿共享基础设施`);
  }
});

test('★ feature 引用的 ctx.xxx 必须是已注入的字段(防「用了没注入的东西」)', () => {
  for (const f of featureFiles()) {
    const src = readFileSync(join(FEATURES, f), 'utf8');
    for (const m of src.matchAll(/\bctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      assert.ok(CTX_KEYS.includes(m[1]),
        `${f} 引用了 ctx.${m[1]},但它不在已注入列表 [${CTX_KEYS.join(', ')}] 里`);
    }
  }
});

test('★ ui.js 里 ctx 的字段与上面的 CTX_KEYS 一致(单一出处,双向对账)', () => {
  const ui = readFileSync(UI, 'utf8');
  // ⚠️ 不能用 /const ctx = \{([\s\S]*?)\n\};/ —— ctx 里有内联的嵌套对象
  //    (`dom: { byId: $ }`),惰性匹配会在那个内层 `}` 后提前收尾。
  //    改为:从 `const ctx = {` 起,取到**行首**的 `};` 为止。
  const block = /const ctx = \{([\s\S]*?)\n\};/.exec(ui);
  assert.ok(block, 'ui.js 里应能找到 const ctx = { ... }; 定义');
  // 只取顶层的键(缩进恰好两格),排除内层嵌套对象的字段。
  // ⚠️ 必须同时匹配两种写法:`dom: {...}`(带冒号)与 `toast,`(ES6 简写属性)——
  //    只认冒号会漏掉简写项(2026-09-27 实测踩到)。
  const declared = [...block[1].matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\s*[:,]/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...CTX_KEYS].sort(),
    `ui.js 的 ctx 字段 [${declared.join(', ')}] 与 tests 里登记的 CTX_KEYS [${CTX_KEYS.join(', ')}] 不一致`);
});

test('ui.js 必须 import 每个 feature 的入口(否则拆出去等于没接上)', () => {
  const ui = readFileSync(UI, 'utf8');
  for (const f of featureFiles()) {
    const base = f.replace(/\.js$/, '');
    assert.match(ui, new RegExp(`from\\s+['"]\\./features/${base}\\.js['"]`),
      `ui.js 没有 import features/${f} —— 拆出去了却没接上`);
  }
});
