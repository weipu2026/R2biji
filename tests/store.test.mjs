/* ============================================================
 * 会话状态容器 —— 纯模块单测
 *
 * 重点在两条不变量:
 *   1. 值相等短路:值没变必须不通知(否则订阅回调里 set 同值 → 无限递归)
 *   2. 通知的完整性:真变了必须通知到每个订阅者,且 patch 只通知一次
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, store, defaultState, createProxy } from '../public/js/store.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('Store:读写基本语义', () => {
  const s = new Store();
  assert.equal(s.get('activeCat'), null);
  assert.equal(s.set('activeCat', '攻略'), true);
  assert.equal(s.get('activeCat'), '攻略');
  // 未定义字段读出来是 undefined(与直访普通对象一致,不抛错)
  assert.equal(s.get('不存在的字段'), undefined);
});

test('★ 值相等短路:同值 set 必须返回 false 且不通知', () => {
  const s = new Store();
  let calls = 0;
  s.subscribe('activeCat', () => { calls++; });

  assert.equal(s.set('activeCat', '甲'), true);
  assert.equal(calls, 1);

  // 再设同一个值:短路,不通知
  assert.equal(s.set('activeCat', '甲'), false, '同值 set 必须返回 false');
  assert.equal(calls, 1, '同值 set 不得触发通知');

  // 设回 null 也算变更
  assert.equal(s.set('activeCat', null), true);
  assert.equal(calls, 2);
});

test('★ 短路是防递归的底线:订阅回调里 set 同值不得栈溢出', () => {
  const s = new Store();
  let depth = 0;
  s.subscribe('n', (v) => {
    depth++;
    assert.ok(depth < 50, '订阅回调递归爆了 —— 短路失效');
    s.set('n', v); // 回调里写回同值
  });
  s.set('n', 1);
  assert.equal(depth, 1, '同值写回必须被短路,回调只应执行一次');
});

test('subscribe 回传新值与旧值,退订后不再通知', () => {
  const s = new Store();
  const seen = [];
  const off = s.subscribe('editing', (v, prev) => seen.push([prev, v]));

  s.set('editing', true);
  s.set('editing', false);
  assert.deepEqual(seen, [[false, true], [true, false]]);

  off();
  s.set('editing', true);
  assert.equal(seen.length, 2, '退订后不得再收到通知');
});

test('patch 批量写入:只通知一次,且中途不被订阅者看到半成品', () => {
  const s = new Store();
  const snapshots = [];
  s.subscribe('activeCat', () => snapshots.push(s.get('activeNoteId')));
  s.subscribe('activeNoteId', () => snapshots.push('note-changed'));

  s.patch({ activeCat: '乙', activeNoteId: 'n1' });
  // activeCat 的回调执行时,activeNoteId 已经是最终值(n1),不是半成品
  assert.deepEqual(snapshots[0], 'n1');
  assert.equal(s.get('activeCat'), '乙');
  assert.equal(s.get('activeNoteId'), 'n1');
});

test('patch 对未变化的键不通知', () => {
  const s = new Store();
  let calls = 0;
  s.subscribe('editing', () => { calls++; });
  s.patch({ editing: false });        // 本来就是 false → 不算变更
  assert.equal(calls, 0);
  s.patch({ editing: false, activeCat: '丙' }); // 只有一个真变了
  assert.equal(calls, 0, 'editing 未变,不该通知');
});

test('subscribeAny 能观测到所有键的变更(护栏/调试用)', () => {
  const s = new Store();
  const log = [];
  s.subscribeAny((k, v) => log.push([k, v]));
  s.set('activeCat', '丁');
  s.set('editing', true);
  assert.deepEqual(log, [['activeCat', '丁'], ['editing', true]]);
});

test('订阅回调抛异常不得打断其他订阅者', () => {
  const s = new Store();
  let second = 0;
  s.subscribe('x', () => { throw new Error('故意炸'); });
  s.subscribe('x', () => { second++; });
  const origErr = console.error;
  console.error = () => {}; // 静音预期内的错误日志
  try {
    s.set('x', 1);
  } finally {
    console.error = origErr;
  }
  assert.equal(second, 1, '前一个回调抛错后,后一个仍须收到通知');
});

test('★ 已知契约:原地修改容器/对象属性不会触发通知(必须整体换新对象)', () => {
  const s = new Store();
  let calls = 0;
  s.subscribe('settings', () => { calls++; });

  // 反例:原地改属性 —— 引用没变,不通知
  s.get('settings').autoLockMinutes = 30;
  assert.equal(calls, 0, '原地改属性不该通知(这是既有代码的使用方式)');
  assert.equal(s.get('settings').autoLockMinutes, 30, '值确实改到了(只是没通知)');

  // 正解:整体换新对象才通知
  s.set('settings', { ...s.get('settings'), autoLockMinutes: 60 });
  assert.equal(calls, 1, '整体换新对象必须通知');

  // 同理:dirty 这种 Set 也是引用相等即短路
  let dirtyCalls = 0;
  s.subscribe('dirty', () => { dirtyCalls++; });
  s.get('dirty').add('甲');
  assert.equal(dirtyCalls, 0, 'Set 原地 add 不通知');
  s.set('dirty', new Set(s.get('dirty')));
  assert.equal(dirtyCalls, 1, '换成新 Set 才通知');
});

test('defaultState 每次返回全新的容器(Set/Map 不共享)', () => {
  const a = defaultState();
  const b = defaultState();
  a.dirty.add('甲');
  a.objectUrls.set('k', 'v');
  assert.equal(b.dirty.size, 0, 'dirty 容器不得跨实例共享');
  assert.equal(b.objectUrls.size, 0, 'objectUrls 容器不得跨实例共享');
  assert.notEqual(a.settings, b.settings, 'settings 不得共享同一个对象');
});

test('单例 store 的默认状态完整(字段齐全,防止漏声明的裸字段访问)', () => {
  // ⚠️ 这是「白名单」式检查:只能证明名单里的字段都在,证明不了「代码里没写别的字段」。
  //    后者由 tests/store-discipline.test.mjs 反向扫描 .set()/.patch() 覆盖 —— 两文件互补。
  //    历史教训:lockMode 用了半年没进名单,这条白名单守卫一直是绿的。
  const need = ['lib', 'vaultJson', 'vaultEtag', 'activeCat', 'activeNoteId',
    'editing', 'lockMode', 'dirty', 'dirtyGen', 'tabs', 'settings', 'objectUrls',
    'saving', 'resavePending', 'autoSaveTimer', 'statusTimer', 'idleTimer'];
  for (const k of need) {
    assert.notEqual(store.get(k), undefined, `store 缺少字段: ${k}`);
  }
});

/* ---------- createProxy:ui.js 里那 272 处 `S.xxx` 的底座 ----------
 * 这层要是坏了,表现是「整个界面不动」(状态写不进去),而**单测此前完全没覆盖它**
 * —— 靠 S0 真机护栏才兜住。补上后,单测可独立发现。 */
test('★ createProxy:读走 store,写真的落进 store(不得是个空壳)', () => {
  const st = new Store();
  const S = createProxy(st);

  assert.equal(S.activeCat, null, '读应反映 store 初值');

  S.activeCat = '戊';
  assert.equal(S.activeCat, '戊', '代理读出的是写入值');
  assert.equal(st.get('activeCat'), '戊', '★ 写入必须真的落进 store(否则状态全丢)');

  // 多次读写不同字段都要正确
  S.editing = true;
  S.activeNoteId = 'n9';
  assert.equal(st.get('editing'), true);
  assert.equal(st.get('activeNoteId'), 'n9');
});

test('★ createProxy:写入会触发订阅通知(代理不是旁路)', () => {
  const st = new Store();
  const S = createProxy(st);
  const seen = [];
  st.subscribe('activeCat', (v, prev) => seen.push([prev, v]));

  S.activeCat = '己';
  assert.deepEqual(seen, [[null, '己']], '经代理写入也必须通知订阅者');

  // 同值写入被短路,不重复通知
  S.activeCat = '己';
  assert.equal(seen.length, 1);
});

test('createProxy:未声明字段也支持读写(兼容既有隐式字段)', () => {
  const st = new Store();
  const S = createProxy(st);
  assert.equal(S.某个没声明的字段, undefined);
  S.某个没声明的字段 = 42;
  assert.equal(S.某个没声明的字段, 42);
  assert.equal(st.get('某个没声明的字段'), 42);
});

/* ---------- 脏标记代数:saveAll 竞态防护的底座 ----------
 * 2026-09-27 全站审计 P1:saveAll 在 `await saveCategory(name)` 期间用户又改了
 * 同一分类,await 返回后无条件 `dirty.delete(name)` 会把新改动静默抹掉。
 * 修法是给每个分类记「改动代数」,结束后只在代数未变时才清。
 * 这一组是那套机制的单元护栏 —— 单靠真机护栏跑不出这个时序。 */
test('★ markDirty:每次标记都把该分类的代数 +1', () => {
  const st = new Store();
  assert.equal(st.markDirty('甲'), 1, '首次标记 → 代数 1');
  assert.equal(st.markDirty('甲'), 2, '再次标记 → 代数 2');
  assert.equal(st.markDirty('乙'), 1, '别的分类代数独立计数');
  assert.equal(st.get('dirty').has('甲'), true);
});

test('★ clearDirtyIfUnchanged:代数变了就**不清**(这正是 P1 的修复点)', () => {
  const st = new Store();
  const gen = st.markDirty('甲');          // 保存发起,记下代数
  st.markDirty('甲');                      // await 期间用户又改了 → 代数变

  const cleared = st.clearDirtyIfUnchanged('甲', gen);
  assert.equal(cleared, false, '★ 窗口期有新改动时不得清脏标记(否则新改动丢失)');
  assert.equal(st.get('dirty').has('甲'), true, '分类必须仍在待保存队列里');
});

test('★ clearDirtyIfUnchanged:代数没变才清(正常保存完成路径)', () => {
  const st = new Store();
  const gen = st.markDirty('甲');          // 保存发起
  // await 期间无人再改 → 代数不变
  const cleared = st.clearDirtyIfUnchanged('甲', gen);
  assert.equal(cleared, true, '无新改动 → 正常移出队列');
  assert.equal(st.get('dirty').has('甲'), false);
  assert.equal(st.get('dirtyGen').has('甲'), false, '代数条目也要一起清,防 Map 泄漏');
});

test('moveDirty:重命名把脏标记与代数一并搬到新名字(内容新旧不变)', () => {
  const st = new Store();
  const gen = st.markDirty('旧名');
  assert.equal(st.moveDirty('旧名', '新名'), true);

  assert.equal(st.get('dirty').has('旧名'), false, '旧名不再在队列');
  assert.equal(st.get('dirty').has('新名'), true, '新名接住脏标记');
  // 代数必须延续 —— 否则保存中的那一轮会误判为「无新改动」而提前清掉
  assert.equal(st.get('dirtyGen').get('新名'), gen, '代数要跟着搬,不能重置');
  assert.equal(st.clearDirtyIfUnchanged('新名', gen), true, '搬迁后仍按原代数判定');
});

test('moveDirty:源分类不在队列时是空操作,不凭空造脏标记', () => {
  const st = new Store();
  assert.equal(st.moveDirty('没标过', '新名'), false);
  assert.equal(st.get('dirty').has('新名'), false, '不得无中生有');
});

test('clearDirty / clearAllDirty:两处一起清,不留 Map 残留', () => {
  const st = new Store();
  st.markDirty('甲'); st.markDirty('乙');
  assert.equal(st.clearDirty('甲'), true);
  assert.equal(st.get('dirtyGen').has('甲'), false, 'Set 清了 Map 也要清');
  assert.equal(st.clearDirty('甲'), false, '重复清是安全的空操作');

  st.clearAllDirty();
  assert.equal(st.get('dirty').size, 0);
  assert.equal(st.get('dirtyGen').size, 0, '★ 整体清空时 Map 不得漏清');
});

test('★ createProxy:经代理调用的 store 方法 this 必须绑到真实 store', () => {
  // 回归:引入 S.markDirty 后若不绑定,this 会是 Proxy 本身,
  // 方法内 this._state 经代理读到 undefined → TypeError。
  const st = new Store();
  const S = createProxy(st);
  assert.doesNotThrow(() => S.markDirty('丙'), '经代理调用不得抛错');
  assert.equal(st.get('dirty').has('丙'), true, '动作要真的落在真实 store 上');
  assert.equal(st.get('dirtyGen').get('丙'), 1);

  // 解构成独立函数调用同样要能工作(bind 已固定 this)
  const md = S.markDirty;
  assert.equal(md('丁'), 1);
  assert.equal(st.get('dirty').has('丁'), true);
});
