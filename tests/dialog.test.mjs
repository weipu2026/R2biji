/* ============================================================
 * 通用对话框的「按钮 → 返回值」契约 —— 极简 DOM 替身单测
 *
 * 为什么单独测这一层:modal() 里按钮与返回值的对应关系写错了**不会报任何错**,
 * 只会静默失效。真发生过:prompt 的「确定」先被 mkBtn 内部的 resolve(null) 落地
 * (Promise 只认第一次 resolve),于是新建分类 / 重命名分类 / 修改主密码
 * 点了全没反应,只有按回车能用 —— 而 69 项离线单测全绿,
 * 因为它们测的是 Library 层,根本碰不到 DOM 这一层。
 *
 * 替身只覆盖 modal() 用到的那点 DOM 面,不做通用实现。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { modal, handleConflict, toast } from '../public/js/ui.js';
import { store } from '../public/js/store.js';

function installDom() {
  const byId = new Map();
  const make = (tag) => {
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      handlers: {},
      className: '',
      _text: null,
      value: '',
      type: '',
      placeholder: '',
      hidden: false,
      dataset: {},
      shown: false,
      closed: false,
      open: false,
      appendChild(c) { c.parent = e; e.children.push(c); return c; },
      addEventListener(ev, fn) { (e.handlers[ev] ||= []).push(fn); },
      removeEventListener(ev, fn) {
        const list = e.handlers[ev];
        if (!list) return;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      },
      click() { for (const fn of [...(e.handlers.click || [])]) fn({}); },
      keydown(key) { for (const fn of [...(e.handlers.keydown || [])]) fn({ key }); },
      focus() {}, select() {},
      // remove() 必须真的从父节点摘掉:toast 靠「摘空了没」来决定要不要退出 top layer,
      // 写成空函数会让那条判据永远为假(假绿)。
      remove() {
        const i = e.parent ? e.parent.children.indexOf(e) : -1;
        if (i >= 0) e.parent.children.splice(i, 1);
        e.parent = null;
      },
      get childElementCount() { return e.children.length; },
      // 真实 DOM 都有这两个 —— 无障碍属性(dialog aria-labelledby / input aria-label)
      // 只在 setAttribute 上生效,替身缺了会把「属性没设」掩盖成「测试崩了」
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      // top layer 相关(提示浮到弹窗之上靠 popover)——只覆盖 ui.js 用到的那点面
      _popoverOpen: false,
      popoverShown: 0,
      popoverHidden: 0,
      matches(sel) { return sel === ':popover-open' ? e._popoverOpen : false; },
      showPopover() { e._popoverOpen = true; e.popoverShown += 1; },
      hidePopover() { e._popoverOpen = false; e.popoverHidden += 1; },
      showModal() { e.shown = true; e.open = true; },
      // ★ close() 派发 close 事件,而且**异步**(排队到下个 task)——与真浏览器一致:
      //   按钮路径先 settle,close 晚到被 settled 挡住;同步派发会破坏这个顺序
      //   (所有按钮用例都会返回 null)。异步派发还让「连续两次 modal 时第二个弹窗
      //   被第一个排队的 close 落定」可复现 —— 那正是 2026-09-28 审计 P1 的护栏。
      close() { e.closed = true; e.open = false; setTimeout(() => { for (const fn of [...(e.handlers.close || [])]) fn({}); }, 0); },
      // 真实 dialog 按 Esc:先派发 cancel(此时还开着),没被阻止才关闭并(异步)派发 close。
      cancel() { for (const fn of [...(e.handlers.cancel || [])]) fn({}); e.closed = true; e.open = false; },
    };
    // body.textContent = '' 必须真的清空子节点 —— 第二次弹窗复用同一个 #modalBody,
    // 不清空的话 btn()/inputOf() 会命中上一次残留的按钮/输入框,断言假绿。
    Object.defineProperty(e, 'textContent', {
      get() { return e._text === null ? '' : e._text; },
      set(v) { e._text = String(v); e.children = []; },
    });
    return e;
  };
  const dlg = make('dialog');
  const body = make('div');
  byId.set('modal', dlg);
  byId.set('modalBody', body);
  // handleConflict 会真的 toast + 刷状态栏:这两个容器必须存在,否则 TypeError 会把
  // 「分流写错」掩盖成「测试自己崩了」
  const toasts = make('div');
  const saveStatus = make('span');
  byId.set('toasts', toasts);
  byId.set('saveStatus', saveStatus);
  globalThis.document = { createElement: make, getElementById: (id) => byId.get(id) || null };
  return { dlg, body, toasts, saveStatus };
}

/** 深度收集后代元素 */
function descendants(root, out = []) {
  for (const c of root.children) { out.push(c); descendants(c, out); }
  return out;
}
const btn = (body, text) => descendants(body).find((e) => e.tagName === 'BUTTON' && e.textContent === text);
const inputOf = (body) => descendants(body).find((e) => e.tagName === 'INPUT');

/* ---------------- prompt:确定/回车 → 输入值;取消 → null ---------------- */

test('prompt:点「确定」必须返回输入框里的值(曾经返回 null → 功能静默失效)', async () => {
  const { body } = installDom();
  const p = modal({ type: 'prompt', title: '新建分类' });
  const input = inputOf(body);
  assert.ok(input, '弹窗里应当有输入框');
  input.value = '秘钥';
  const ok = btn(body, '确定');
  assert.ok(ok, '应当有「确定」按钮');
  ok.click();
  assert.equal(await p, '秘钥', '点确定必须拿到输入值,否则新建/重命名/改密码全部没反应');
});

test('prompt:按回车同样返回输入框的值', async () => {
  const { body } = installDom();
  const p = modal({ type: 'prompt', title: '新建分类' });
  const input = inputOf(body);
  input.value = '攻略';
  input.keydown('Enter');
  assert.equal(await p, '攻略');
});

test('prompt:取消返回 null(调用方据此判断「用户放弃了」)', async () => {
  const { body } = installDom();
  const p = modal({ type: 'prompt', title: '新建分类' });
  inputOf(body).value = '不该被采用';
  btn(body, '取消').click();
  assert.equal(await p, null);
});

test('prompt:密码模式下输入框类型为 password', async () => {
  const { body } = installDom();
  const p = modal({ type: 'prompt', title: '修改主密码', password: true });
  assert.equal(inputOf(body).type, 'password');
  btn(body, '取消').click();
  await p;
});

/* ---------------- confirm:true / false ---------------- */

test('confirm:确定 → true;danger 只改文案', async () => {
  let dom = installDom();
  let p = modal({ type: 'confirm', title: '删除笔记' });
  btn(dom.body, '确定').click();
  assert.equal(await p, true);

  dom = installDom();
  p = modal({ type: 'confirm', title: '删除分类', danger: true });
  assert.ok(btn(dom.body, '删除'), 'danger 时按钮文案应为「删除」');
  assert.equal(btn(dom.body, '确定'), undefined, 'danger 时不该再出现「确定」');
  btn(dom.body, '删除').click();
  assert.equal(await p, true);
});

test('confirm:取消 → false', async () => {
  const { body } = installDom();
  const p = modal({ type: 'confirm', title: '删除笔记' });
  btn(body, '取消').click();
  assert.equal(await p, false);
});

/* ---------------- conflict:三选一 ---------------- */

test('conflict:三个按钮各自返回对应动作', async () => {
  for (const [label, expected] of [
    ['用我的版本覆盖', 'mine'],
    ['以磁盘版本为准', 'disk'],
    ['取消', 'cancel'],
  ]) {
    const { body } = installDom();
    const p = modal({ type: 'conflict', title: '「秘钥」在云端已被其他设备修改' });
    const b = btn(body, label);
    assert.ok(b, `应当有「${label}」按钮`);
    b.click();
    assert.equal(await p, expected, `「${label}」应返回 ${expected}`);
  }
});

/* ---------------- 打开与关闭 ---------------- */

test('弹窗会 showModal,且选完任意按钮都会 close(否则盖住界面)', async () => {
  const { dlg, body } = installDom();
  const p = modal({ type: 'confirm', title: 'x' });
  assert.equal(dlg.shown, true, '应当调用 showModal');
  assert.equal(dlg.closed, false, '未选择前不该关闭');
  btn(body, '确定').click();
  await p;
  assert.equal(dlg.closed, true, '选完必须关闭');
});

/* ---------------- Esc 必须落定 Promise ---------------- */

test('按 Esc(cancel 事件)必须把 Promise 落定为 null,且关掉弹窗', async () => {
  // 曾经 Esc 只关 dialog、Promise 永久挂起:保存冲突弹窗按 Esc 把
  // S.saving 卡成恒 true,整个保存流水线静默失效 —— 全库只剩这一层没有兜底。
  // 用 race 兜底:修复被还原时这里翻红而不是把整个测试进程挂死
  const withTimeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('HANG'), 500))]);
  const { dlg, body } = installDom();
  const p = modal({ type: 'conflict', title: '「秘钥」在云端已被其他设备修改' });
  assert.equal(dlg.closed, false);
  dlg.cancel(); // 模拟原生 dialog 的 Esc:先触发 cancel 再关闭
  assert.equal(await withTimeout(p), null, 'Esc 必须等价于「取消」,绝不能让 await 永久挂起');
  assert.equal(dlg.closed, true, 'Esc 后弹窗应处于关闭态');
  // 提示层也顺带钉住:prompt 的 Esc 同样返回 null(调用方据此判「放弃」)
  const dom2 = installDom();
  const p2 = modal({ type: 'prompt', title: '访问密钥' });
  inputOf(dom2.body).value = '不该被采用';
  dom2.dlg.cancel();
  assert.equal(await withTimeout(p2), null);
});

test('★ 连续两次 modal:第二个弹窗不得被第一个排队的 close 事件落定(修改主密码契约)', async () => {
  // 背景(2026-09-28 审计 P1):dlg 是全应用共用的同一个 <dialog>;changePassword 在
  // 第一问 resolve 后**同一微任务内**发起第二问。而第一个弹窗 dlg.close() 排队的 close
  // 事件是异步(task)派发的 → 第二个弹窗刚注册的监听会收到它、被 settle(null) 提前落定,
  // 于是 if (pw2 == null) return 静默返回 —— 用户以为改了密码,其实没改。
  const { body } = installDom();          // 只建一次 DOM:模拟全应用共用的那一个 dialog
  const p1 = modal({ type: 'prompt', title: '修改主密码', label: '新密码', password: true });
  inputOf(body).value = 'first-strong-password';
  btn(body, '确定').click();
  assert.equal(await p1, 'first-strong-password', '第一问正常返回');

  // changePassword 的真实形状:紧接着发起第二问
  const p2 = modal({ type: 'prompt', title: '再输一遍新密码', password: true });
  inputOf(body).value = 'first-strong-password';
  // 让第一个弹窗排队的 close 事件先派发 —— 旧实现正是在这里把 p2 落定成 null
  let early = 'pending';
  await Promise.race([p2.then((v) => { early = v; }), new Promise((r) => setTimeout(r, 20))]);
  assert.equal(early, 'pending', '★ 第二个弹窗在用户操作前不得被落定(旧实现会得到 null)');

  btn(body, '确定').click();
  assert.equal(await p2, 'first-strong-password', '用户在第二问点确定 → 必须返回输入值');
});
/* ---------------- 2026-09-29 审计 P2-9:覆盖失败绝不能弹绿字 ----------------
 * saveCategory({force:true}) 在「没有内存数据」时返回 {skipped:true}、在「云端刚又被改」
 * 时返回 {conflict:true} —— 两种都**不抛错**。旧实现丢弃返回值:覆盖没发生却弹绿字,
 * 而 saveAll 早在弹窗前就把它移出待保存队列 ⇒ 改动静默脱离保存流程。
 * 正反对照:失败必须红字 + 重新入队;成功才是绿字 + 不入队(否则「一律报错」也能通过)。 */
test('P2-9:覆盖未生效({conflict:true})→ 必须报错并放回待保存队列', async () => {
  const dom = installDom();
  store.clearDirty('甲');
  const catStub = { data: { notes: [] }, lastSeenEtag: 'e1' };
  const saved = [];
  store.set('lib', {
    categoryInfo: () => catStub,
    saveCategory: async (name, opt) => { saved.push({ name, opt }); return { conflict: true }; },
  });
  const p = handleConflict('甲');
  const b = btn(dom.body, '用我的版本覆盖');
  assert.ok(b, '冲突弹窗必须有「用我的版本覆盖」按钮');
  b.click();
  await p;
  assert.equal(saved.length, 1, '必须真的尝试覆盖一次');
  assert.equal(saved[0].opt?.force, true, '覆盖必须走 force(以云端当前版本为基线)');
  const last = dom.toasts.children[dom.toasts.children.length - 1];
  assert.ok(last, '必须给用户提示');
  assert.ok(String(last.className).includes('toast-error'), '覆盖没生效必须报错,不能弹绿字「已覆盖」');
  assert.equal(store.get('dirty').has('甲'), true, '覆盖失败必须重新入队,否则改动静默脱离保存流程');
});

test('P2-9 正对照:覆盖成功({ok:true})→ 绿字且不入队', async () => {
  const dom = installDom();
  store.clearDirty('乙');
  store.set('lib', {
    categoryInfo: () => ({ data: { notes: [] }, lastSeenEtag: 'e1' }),
    saveCategory: async () => ({ ok: true }),
  });
  const p = handleConflict('乙');
  btn(dom.body, '用我的版本覆盖').click();
  await p;
  const last = dom.toasts.children[dom.toasts.children.length - 1];
  assert.ok(String(last.className).includes('toast-error') === false, '成功时不该报错');
  assert.equal(store.get('dirty').has('乙'), false, '成功时不该入队');
});


/* ---------------- 2026-09-29 审计 P3:弹窗必须有无障碍名 ----------------
 * placeholder 不算可访问名(读屏器不播报它),<dialog> 不关联标题时只报「对话框」——
 * 键盘/读屏用户既不知道这是哪个弹窗,也不知道输入框要填什么。 */
test('P3:弹窗必须把标题关联为可访问名,输入框也要有 aria-label', async () => {
  const dom = installDom();
  const p = modal({ type: 'prompt', title: '修改主密码', label: '新主密码', password: true });
  assert.equal(dom.dlg.getAttribute('aria-labelledby'), 'modalTitle', '<dialog> 必须指向标题');
  const h = descendants(dom.body).find((e) => e.tagName === 'H3');
  assert.equal(h.getAttribute('id'), 'modalTitle', '标题必须带上被引用的 id');
  assert.equal(h.textContent, '修改主密码');
  const input = inputOf(dom.body);
  assert.equal(input.getAttribute('aria-label'), '新主密码', '输入框必须有可访问名(placeholder 不算)');
  btn(dom.body, '取消').click();
  await p;
});

test('P3 正对照:没给 label 时输入框退回用标题当可访问名(不能为空)', async () => {
  const dom = installDom();
  const p = modal({ type: 'prompt', title: '新建分类' });
  assert.equal(inputOf(dom.body).getAttribute('aria-label'), '新建分类');
  btn(dom.body, '取消').click();
  await p;
});

/* ---------------- 2026-10-12 全站审计 P2:提示必须浮在弹窗之上 ----------------
 * <dialog>.showModal() 把弹窗放进浏览器的 **top layer** —— 那块区域的层级由
 * 「加入顺序」决定,z-index 一概不参与。而 #toasts 原本只是 z-index:100 的普通
 * fixed 容器 ⇒ **弹窗一开,这期间到达的提示全部被盖住**。
 * 而提示恰恰常在弹窗开着时到达:另一个标签页保存/删除经 BroadcastChannel 推来的
 * 通知、自动保存失败的报错,都是自己冒出来的 —— 用户看到的是「什么都没发生」。
 * 判据:#toasts 必须被挂上 popover="manual" 并真的 showPopover()。 */

test('★ 弹窗开着时提示必须进 top layer(否则被 <dialog> 整个盖住)', async () => {
  const dom = installDom();
  const p = modal({ type: 'confirm', title: '删除分类', danger: true });
  assert.equal(dom.dlg.shown, true, '前提:弹窗已经进了 top layer');

  toast('已在别处锁定 · 2 个分类的改动没能存上', 'warn');

  assert.equal(dom.toasts.getAttribute('popover'), 'manual',
    '#toasts 必须挂 popover="manual" —— 否则它不进 top layer,永远压在弹窗下面');
  assert.equal(dom.toasts.popoverShown, 1, '必须真的调用 showPopover()');
  assert.equal(dom.toasts.children.length, 1, '提示本身照常挂上去');

  btn(dom.body, '取消').click();
  await p;
});

test('提示:连着来两条只 showPopover 一次(已开时再调会抛 InvalidStateError)', () => {
  const dom = installDom();
  toast('第一条');
  toast('第二条');
  assert.equal(dom.toasts.popoverShown, 1, '第二条必须复用已经打开的 popover,重复调用会抛错');
  assert.equal(dom.toasts.children.length, 2, '两条提示都要在');
});

test('提示:最后一条消失后退出 top layer(别一直占着顶层的点击面)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom();
  toast('已复制');
  assert.equal(dom.toasts._popoverOpen, true, '前提:提示在 top layer 里');
  assert.equal(dom.toasts.children.length, 1);

  t.mock.timers.tick(3000); // 非 error 提示 3 秒后自行消失

  assert.equal(dom.toasts.children.length, 0, '到点必须把提示摘掉');
  assert.equal(dom.toasts.popoverHidden, 1, '摘空后必须退出 top layer');
  t.mock.timers.reset();
});

test('提示:error 提示留得比 info 久(失败信息更需要看清)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom();
  toast('保存失败', 'error');
  t.mock.timers.tick(3000);
  assert.equal(dom.toasts.children.length, 1, 'error 提示 3 秒时不该消失');
  t.mock.timers.tick(5000);
  assert.equal(dom.toasts.children.length, 0, 'error 提示 8 秒后应消失');
  t.mock.timers.reset();
});

test('正对照:平台不支持 popover 时不得抛错,提示照常出现(退回普通层级)', () => {
  const dom = installDom();
  delete dom.toasts.showPopover; // 模拟老浏览器
  assert.doesNotThrow(() => toast('降级路径'), '检测不到 showPopover 必须静默跳过,不能把提示功能整个带崩');
  assert.equal(dom.toasts.getAttribute('popover'), null, '不支持时不该白挂一个 popover 属性');
  assert.equal(dom.toasts.children.length, 1, '提示本身必须照常出现');
});

