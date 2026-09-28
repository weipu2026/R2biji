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
import { modal } from '../public/js/ui.js';

function installDom() {
  const byId = new Map();
  const make = (tag) => {
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      handlers: {},
      className: '',
      _text: null,
      value: '',
      type: '',
      placeholder: '',
      shown: false,
      closed: false,
      open: false,
      appendChild(c) { e.children.push(c); return c; },
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
  globalThis.document = { createElement: make, getElementById: (id) => byId.get(id) || null };
  return { dlg, body };
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