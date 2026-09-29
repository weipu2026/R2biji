/* ============================================================
 * 手机端阅读体验:标题不被压成竖列 + 上下滑动翻篇 —— 纯 Node,零依赖
 *
 * 两件事都来自 2026-09-29 真机反馈:
 *   1. 「进入笔记后标题是一字一行的竖列」—— CSS 缺陷,而且**不是**某一行的笔误,
 *      是三条规则叠加的必然结果(见下)。这类缺陷删掉任一条都会复发,所以用
 *      CSS 文本断言钉住整组约束,而不是钉住某一行的写法。
 *   2. 「手机上翻篇要反复开抽屉」—— 行为缺陷,判定逻辑抽成纯函数 readSwipeIntent,
 *      再用桩 DOM 驱动真实的 bindReadSwipe,确保接线不是摆设。
 *
 * 桩 DOM 只有 addEventListener / 三个尺寸属性 —— 够用,且不引入任何依赖。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSwipeIntent, bindReadSwipe, SWIPE_MIN_PX } from '../public/js/features/note.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------- CSS 文本工具 ----------
 * ⚠️ 断言前必须先剥掉注释:本模块依赖的 style.css 里,解释这段缺陷的注释正文
 *    自己就写着 `word-break:break-all`。不剥注释的话,「已删掉 break-all」这条断言
 *    会被注释里的同名文字喂饱 —— 恒绿,即假护栏(项目里 assets.test.mjs 踩过同族坑)。 */
const css = readFileSync(join(ROOT, 'public', 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出某个选择器的规则体(第一个匹配)。选择器按字面量转义,避免 . 被当通配。 */
function ruleBlock(source, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(source);
  return m ? m[1] : null;
}

/** 取出 @media (max-width: 760px) 整块。内层规则以「换行 + 两个空格 + }」收尾,
 *  媒体块以「换行 + }」收尾 —— 用 \n\} 锚定不会提前截断。 */
const mobileBlock = (() => {
  const m = /@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, 'style.css 应当有 max-width: 760px 的窄屏块');
  return m[1];
})();

/* ---------- 1. 标题竖排(一字一行)的护栏 ---------- */

test('窄屏阅读标题:操作区不得把标题挤到「一个汉字宽」—— 必须允许整行换下去', () => {
  const head = ruleBlock(css, '.read-head');
  assert.ok(head, '.read-head 规则必须存在');
  assert.match(head, /flex-wrap:\s*wrap/,
    '.read-head 必须 flex-wrap: wrap:操作区 .read-actions 是 flex-shrink:0(不压缩),'
    + '不允许换行的话,标题会被挤到只剩一个汉字宽 —— 这就是竖排的成因');
});

test('窄屏阅读标题:必须有宽度下限,低于此值宁可整行换行也不逐字断行', () => {
  const title = ruleBlock(css, '#readTitle');
  assert.ok(title, '#readTitle 规则必须存在');
  assert.match(title, /min-width:\s*min\(100%,\s*[\d.]+em\)/,
    '#readTitle 必须有 min-width 下限(flex 的自动最小尺寸对中文只是「一个汉字」,'
    + '必须显式抬高下限),否则窄屏上会退化成竖排');
});

test('★ 阅读标题禁用 word-break:break-all(它就是「每个字符都是换行点」的来源)', () => {
  const title = ruleBlock(css, '#readTitle');
  assert.ok(title, '#readTitle 规则必须存在');
  assert.doesNotMatch(title, /word-break:\s*break-all/,
    'break-all 让 min-content 塌成一个字符宽,配合 flex 收缩必然竖排');
  assert.match(title, /overflow-wrap:\s*anywhere/,
    '长英文/URL 仍要能断 —— 改用 overflow-wrap: anywhere(只在整词放不下时才断)');
});

test('手机端阅读标题纵向堆叠(标题独占一行,操作按钮换到下一行)', () => {
  const head = ruleBlock(mobileBlock, '.read-head');
  assert.ok(head, `窄屏块里必须有 .read-head 覆盖。块内容:${mobileBlock.slice(0, 200)}`);
  assert.match(head, /flex-direction:\s*column/,
    '窄屏下标题与操作区必须上下分两行 —— 这是竖排的根本解(横向空间本来就不够)');
  const actions = ruleBlock(mobileBlock, '.read-actions');
  assert.ok(actions && /flex-wrap:\s*wrap/.test(actions),
    '窄屏下操作按钮要能换行,否则 4 个按钮自己就会横向溢出');
});

test('★ 全站 word-break:break-all 只有已知安全的一处(把「逐字一行」钉成一类)', () => {
  /* 这个缺陷不是「某一行写错了」,而是四条同时成立才发作:
   *   可换行的中文文本 + 在 flex 横排里可收缩 + 兄弟节点 flex-shrink:0 + break-all
   * 与其为每个场景各写一条断言(改一个地方就要补一处),不如**把 break-all 的落点
   * 收成一张白名单**:将来任何地方新加 break-all 都会在这里变红。
   * 目前唯一允许的是块级上下文里的行内代码 —— 它的可用宽度是整个正文宽,不存在挤压,
   * 而长 hash/URL 又确实需要能在任意位置断。
   * (2026-09-29 全站审计:另外 9 处 flex-shrink:0 场景的兄弟要么是按钮、
   *  要么自身 nowrap + ellipsis,均无此风险。) */
  const hits = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /word-break:\s*break-all/.test(body))
    .map(([, sel]) => sel.trim().replace(/\s+/g, ' '));
  assert.deepEqual(hits, ['.read-body code'],
    `break-all 只允许出现在 .read-body code,实际出现在 ${JSON.stringify(hits)} —— `
    + '新增的这处若处于 flex 横排里且可收缩,窄屏上就会退化成「一字一行」');
});

/* ---------- 2. 滑动翻篇:纯函数判定 ---------- */

test('上下滑动翻篇:位移不足阈值不算翻篇', () => {
  assert.equal(readSwipeIntent({ dx: 0, dy: -(SWIPE_MIN_PX - 1), atTop: false, atBottom: true }), 0);
  assert.equal(readSwipeIntent({ dx: 0, dy: SWIPE_MIN_PX - 1, atTop: true, atBottom: false }), 0);
});

test('上下滑动翻篇:恰好达到阈值即算(边界取「≥」,不是「>」)', () => {
  assert.equal(readSwipeIntent({ dx: 0, dy: -SWIPE_MIN_PX, atTop: false, atBottom: true }), 1);
  assert.equal(readSwipeIntent({ dx: 0, dy: SWIPE_MIN_PX, atTop: true, atBottom: false }), -1);
});

test('上下滑动翻篇:横向位移更大时不算 —— 斜着划是常见的滚动/选中手势', () => {
  assert.equal(readSwipeIntent({ dx: 120, dy: -80, atTop: false, atBottom: true }), 0);
  assert.equal(readSwipeIntent({ dx: -120, dy: 80, atTop: true, atBottom: false }), 0);
});

test('★ 上划翻下一篇必须「手势开始时已到底」—— 中段起手的上划只是正常阅读滚动', () => {
  assert.equal(readSwipeIntent({ dx: 0, dy: -90, atTop: false, atBottom: true }), 1, '已到底 → 下一篇');
  assert.equal(readSwipeIntent({ dx: 0, dy: -90, atTop: false, atBottom: false }), 0,
    '中段上划必须放行给滚动,抢过来翻篇会让长笔记读不下去');
});

test('★ 下划翻上一篇必须「手势开始时已在顶部」', () => {
  assert.equal(readSwipeIntent({ dx: 0, dy: 90, atTop: true, atBottom: false }), -1, '已在顶 → 上一篇');
  assert.equal(readSwipeIntent({ dx: 0, dy: 90, atTop: false, atBottom: true }), 0,
    '非顶部下划=正常回滚,不得翻篇');
});

test('内容短到滚不动时,两个方向都能翻篇(短笔记靠滑动切换)', () => {
  const both = { atTop: true, atBottom: true };
  assert.equal(readSwipeIntent({ dx: 0, dy: -90, ...both }), 1);
  assert.equal(readSwipeIntent({ dx: 0, dy: 90, ...both }), -1);
});

test('上划只会去下一篇、下划只会去上一篇(方向不得反)', () => {
  const both = { atTop: true, atBottom: true };
  assert.equal(readSwipeIntent({ dx: 0, dy: -200, ...both }), 1, '手指向上 = 读到更下面 = 下一篇');
  assert.equal(readSwipeIntent({ dx: 0, dy: 200, ...both }), -1, '手指向下 = 回到上面 = 上一篇');
});

/* ---------- 3. 滑动翻篇:接线(桩 DOM 驱动真实 bindReadSwipe) ---------- */

/** 只保留 bindReadSwipe 真正会碰的东西:addEventListener + 滚动尺寸。 */
class FakeView {
  constructor({ scrollTop = 0, scrollHeight = 1000, clientHeight = 400 } = {}) {
    Object.assign(this, { scrollTop, scrollHeight, clientHeight });
    this.handlers = {};
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  emit(type, payload = {}) { for (const fn of this.handlers[type] || []) fn(payload); }
  get bound() { return Object.keys(this.handlers); }
}

/** document 桩:只提供 selectionchange 的注册与触发(选区事件只发在 document 上)。
 *  给它挂到 view.ownerDocument 上,测试就不必去动全局 document。 */
function mkDoc() {
  const handlers = {};
  return {
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    emit(type) { for (const fn of handlers[type] || []) fn({}); },
  };
}

function harness(opts = {}, { locked = false, editing = false } = {}) {
  const view = new FakeView(opts);
  view.ownerDocument = mkDoc();
  const moves = [];
  const ctx = {
    dom: { byId: (id) => (id === 'readView' ? view : null) },
    store: { get: (k) => (k === 'editing' ? editing : k === 'lockReason' ? locked : undefined) },
    moveNoteSelection: (d) => { moves.push(d); return true; },
  };
  bindReadSwipe(ctx);
  const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });
  return { ctx, view, doc: view.ownerDocument, moves, touch };
}

test('bindReadSwipe 会绑上 touchstart / touchend / touchcancel(缺一条手势就没反应或无法作废)', () => {
  const { view } = harness();
  for (const t of ['touchstart', 'touchend', 'touchcancel']) {
    assert.ok(view.bound.includes(t), `必须绑定 ${t}`);
  }
});

test('接线:底部上划 → 翻下一篇;顶部下划 → 翻上一篇', () => {
  const bottom = harness({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  bottom.view.emit('touchstart', bottom.touch(200, 700));
  bottom.view.emit('touchend', bottom.touch(200, 600));   // 手指向上 100px
  assert.deepEqual(bottom.moves, [1], '已在底部再上划 → 下一篇');

  const top = harness({ scrollTop: 0 });
  top.view.emit('touchstart', top.touch(200, 300));
  top.view.emit('touchend', top.touch(200, 400));          // 手指向下 100px
  assert.deepEqual(top.moves, [-1], '已在顶部再下划 → 上一篇');
});

test('接线:中段上划不动(那是滚动,不是翻篇)', () => {
  const { view, moves, touch } = harness({ scrollTop: 200, scrollHeight: 1000, clientHeight: 400 });
  view.emit('touchstart', touch(200, 700));
  view.emit('touchend', touch(200, 600));
  assert.deepEqual(moves, [], '中段滑动必须放行给滚动');
});

test('接线:没有 touchstart 的 touchend 不翻篇(不成对手势)', () => {
  const { view, moves } = harness();
  view.emit('touchend', { changedTouches: [{ clientX: 200, clientY: 100 }] });
  assert.deepEqual(moves, []);
});

test('接线:touchcancel 之后这次手势作废(系统手势/来电打断)', () => {
  /* ★ 必须先证「同一场景不取消就会翻篇」的基线,否则这条断言可能是恒绿的:
   *   上次写的版本用「顶部 + 上划」,而顶部上划本来就判 0(边界不满足)
   *   → 不绑 touchcancel 也照样通过。这条假绿是 2026-09-29 跑鉴伪时抓出来的
   *   (变异体「滑动翻篇不绑 touchcancel」没能打红它)。
   *   改用内容不可滚动的场景:两个方向都满足边界,不取消就必然翻篇。 */
  const short = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };

  const base = harness(short);
  base.view.emit('touchstart', base.touch(200, 700));
  base.view.emit('touchend', base.touch(200, 600));
  assert.deepEqual(base.moves, [1], '基线:该场景本应翻到下一篇(否则下面的断言没有判别力)');

  const cancelled = harness(short);
  cancelled.view.emit('touchstart', cancelled.touch(200, 700));
  cancelled.view.emit('touchcancel');
  cancelled.view.emit('touchend', cancelled.touch(200, 600));
  assert.deepEqual(cancelled.moves, [], '被取消的手势不得翻篇');
});

test('接线:编辑态不接管滑动(readView 那时本就隐藏,这里是兜底)', () => {
  const { view, moves, touch } = harness({ scrollTop: 0 }, { editing: true });
  view.emit('touchstart', touch(200, 700));
  view.emit('touchend', touch(200, 600));
  assert.deepEqual(moves, []);
});

test('接线:多指(捏合缩放)不接管', () => {
  const { view, moves } = harness({ scrollTop: 0 });
  view.emit('touchstart', { touches: [{ clientX: 10, clientY: 10 }, { clientX: 90, clientY: 90 }] });
  view.emit('touchend', { changedTouches: [{ clientX: 200, clientY: 600 }] });
  assert.deepEqual(moves, []);
});

test('接线:越界时静默 —— moveNoteSelection 说不翻就什么都不做,也不弹提示', () => {
  const { view, touch } = harness({ scrollTop: 0 });
  const ctx = {
    dom: { byId: () => view },
    store: { get: () => false },
    moveNoteSelection: () => false, // 已是第一篇
  };
  bindReadSwipe(ctx);
  assert.doesNotThrow(() => {
    view.emit('touchstart', touch(200, 300));
    view.emit('touchend', touch(200, 400));
  });
});

test('bindReadSwipe:阅读面不存在时不抛(锁屏竞态下 byId 可能拿不到)', () => {
  assert.doesNotThrow(() => bindReadSwipe({ dom: { byId: () => null }, store: { get: () => false }, moveNoteSelection() {} }));
});

/* ---------- 4. 手势与「选中文字」的竞争 ----------
 * 手机上长按选字、或拖着选区手柄扩展,手指同样会抬起一次纵向位移可能 >56px 的触摸。
 * 若不区分「用户在选字」和「用户想翻篇」,就会在选字到一半时把用户翻到别的笔记去。
 * 判据:手势期间**选区的有无/长度变了** → 这是文本操作,让给系统;没变 → 才是翻篇手势。
 * 用长度比对而不是「当前有无选区」,是为了不误伤「页面上残留着上一次的选区、
 * 用户此刻只想翻篇」这条路径(那一条必须仍然能翻)。 */

/** 临时装一个最小 window 桩(只提供 getSelection),并在回调里允许改选区文本。 */
function withWindow(initialText, fn) {
  const has = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const orig = globalThis.window;
  let text = initialText;
  globalThis.window = { getSelection: () => ({ toString: () => text }) };
  try {
    return fn({ setSel: (t) => { text = t; } });
  } finally {
    if (has) globalThis.window = orig; else delete globalThis.window;
  }
}

/** 内容短到滚不动 —— 两端边界同时满足,是这个缺陷最容易发作的场景。 */
const SHORT = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };

test('★ 手势:划动过程中选出文字(长按选字)不得被当成翻篇', () => {
  const h = harness(SHORT);
  withWindow('', ({ setSel }) => {
    h.view.emit('touchstart', h.touch(200, 700));
    setSel('被选中的一段话');                      // 拖动过程中系统选出了文字
    h.view.emit('touchend', h.touch(200, 600));
  });
  assert.deepEqual(h.moves, [], '手势期间新选出了文字 → 是选字操作,必须放行给系统');
});

test('★ 手势:起始已有选区、拖动扩展选区(长度变化)不得被当成翻篇', () => {
  const h = harness(SHORT);
  withWindow('词', ({ setSel }) => {
    h.view.emit('touchstart', h.touch(200, 700));   // 此时已有 1 字选区
    setSel('词扩展成了很长的一段');                  // 拖着选区手柄往下扩
    h.view.emit('touchend', h.touch(200, 600));
  });
  assert.deepEqual(h.moves, [], '选区长度变了 → 是文本操作,必须放行给系统');
});

test('手势:页面残留着上一次的选区、但它没变时,仍然要能翻篇(别过度拦截)', () => {
  const h = harness(SHORT);
  withWindow('上次留下的选区', () => {
    h.view.emit('touchstart', h.touch(200, 700));
    h.view.emit('touchend', h.touch(200, 600));     // 选区全程未变 → 用户是想翻篇
  });
  assert.deepEqual(h.moves, [1], '选区没被本次手势改动过 → 不得因为「页面上有选区」就一律拦截');
});

test('手势:无选区时照常翻篇(基线 —— 上面的断言必须靠它才有判别力)', () => {
  const h = harness(SHORT);
  withWindow('', () => {
    h.view.emit('touchstart', h.touch(200, 700));
    h.view.emit('touchend', h.touch(200, 600));
  });
  assert.deepEqual(h.moves, [1], '基线:无选区时本场景必须翻篇');
});

test('手势:无 DOM 环境(纯 Node)下选区检测不抛异常', () => {
  const h = harness(SHORT);
  assert.equal(typeof globalThis.window, 'undefined', '本用例前提:没有 window 桩');
  h.view.emit('touchstart', h.touch(200, 700));
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [1], '没有 window 也要能正常翻篇');
});

/* ---------- 5. 选区事件的**直接信号**(比抬起瞬间的快照更靠得住) ----------
 * 只看 touchend 那一刻的选区长度有个缺口:某些移动浏览器在抬起时,系统选择控件会
 * 先清掉/重建选区(拖手柄扩展选区时尤其明显),那一刻读到的长度可能正好是 0 ——
 * 于是「用户在选字」被判成「用户在翻篇」,缺陷照旧。selectionchange 发生在手势
 * **过程中**,是这件事的直接信号。下面这组合同时钉住两条判据的可用性,以及
 * 「标记必须在新手势开始时清掉」这条容易漏的收尾。 */

test('★★ 选字:手势期间 selectionchange 变过 → 不翻篇(哪怕抬起时已读不到选区)', () => {
  const h = harness(SHORT);   // 两端都贴边:不被拦就必然翻篇
  h.view.emit('touchstart', h.touch(200, 700));
  h.doc.emit('selectionchange');              // 手势进行中,选区变了
  h.view.emit('touchend', h.touch(200, 600)); // 抬起时读不到选区(无 window 桩 → 长度 0)
  assert.deepEqual(h.moves, [], '手势期间选区变过 = 用户在选字,不得翻篇');
});

test('★★ 基线:同一场景(两端贴边 + 上划)没有选区事件时会翻篇', () => {
  const h = harness(SHORT);
  h.view.emit('touchstart', h.touch(200, 700));
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [1], '基线:证明上面那条断言有判别力(否则它可能是恒绿的)');
});

test('★★ 新手势必须清掉上一轮的「选过字」标记(否则选完字就再也划不动了)', () => {
  const h = harness(SHORT);
  // 第一次:选字手势 → 被拦
  h.view.emit('touchstart', h.touch(200, 700));
  h.doc.emit('selectionchange');
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [], '第一次是选字,不该翻篇');
  // 第二次:纯滑动 → 必须能翻(标记若没清,这里会被上一轮挡死)
  h.view.emit('touchstart', h.touch(200, 700));
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [1], '新手势开始时必须把标记清掉');
});

test('选区事件发生在手势之外(上一轮残留 / 只是选中)→ 不影响本轮翻篇', () => {
  const h = harness(SHORT);
  h.doc.emit('selectionchange');              // 手势还没开始
  h.view.emit('touchstart', h.touch(200, 700));
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [1], '不在手势期间的选区变化与本轮无关,不得误伤');
});

test('选区事件在手势被 touchcancel 作废后发出 → 不残留成下一轮的挡箭牌', () => {
  const h = harness(SHORT);
  h.view.emit('touchstart', h.touch(200, 700));
  h.view.emit('touchcancel');                 // 系统手势打断:本次手势作废
  h.doc.emit('selectionchange');              // 打断之后系统重设了选区
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [], '被取消的手势本就不翻篇');
  // 再来一次干净手势:必须能翻(标记不得跨手势残留)
  h.view.emit('touchstart', h.touch(200, 700));
  h.view.emit('touchend', h.touch(200, 600));
  assert.deepEqual(h.moves, [1], '作废手势期间的选区事件不得污染下一次手势');
});
