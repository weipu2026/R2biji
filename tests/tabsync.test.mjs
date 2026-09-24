/* ============================================================
 * 多标签页同步:消息校验 + 决策 + 通道行为
 *
 * 最要紧的是那条安全策略:**本地有未保存改动时,绝不因为别的标签页的通知就刷新**
 * —— 那等于静默丢掉用户正在写的东西,比冲突弹窗糟得多。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TabSync, parseTabMessage, planSavedCategoryAction } from '../public/js/tabsync.js';

/** 假的 BroadcastChannel:按名字登记,postMessage 投给**同名的其他**实例
 *  (复刻真语义:不投给发送者自己),并按结构化克隆的方式传值。 */
function makeBus() {
  const byName = new Map();
  return class FakeChannel {
    constructor(name) {
      this.name = name;
      this.sent = [];
      this.closed = false;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(this);
    }
    postMessage(m) {
      this.sent.push(m);
      const clone = JSON.parse(JSON.stringify(m)); // 真 BroadcastChannel 是结构化克隆
      for (const other of byName.get(this.name)) {
        if (other !== this && !other.closed) other.onmessage?.({ data: clone });
      }
    }
    close() { this.closed = true; byName.get(this.name)?.delete(this); }
  };
}

/* ---------------- 消息校验:不认识的一律忽略 ---------------- */

test('parseTabMessage:认三种消息', () => {
  assert.deepEqual(parseTabMessage({ type: 'cat-saved', name: '秘钥' }), { type: 'cat-saved', name: '秘钥' });
  assert.deepEqual(parseTabMessage({ type: 'cats-changed' }), { type: 'cats-changed' });
  assert.deepEqual(parseTabMessage({ type: 'locked' }), { type: 'locked' });
});

test('parseTabMessage:畸形/陌生消息一律 null(不抛错)', () => {
  const bad = [
    null, undefined, 42, 'cat-saved', [],
    {},
    { type: 123 },
    { type: 'unknown-type' },
    { type: 'cat-saved' },              // 缺 name
    { type: 'cat-saved', name: '' },    // name 为空
    { type: 'cat-saved', name: 42 },    // name 非字符串
    { type: '__proto__' },
  ];
  for (const m of bad) {
    assert.equal(parseTabMessage(m), null, `应当忽略:${JSON.stringify(m)}`);
  }
});

test('parseTabMessage:只保留已知字段(不透传来源对象的其他键)', () => {
  const out = parseTabMessage({ type: 'cat-saved', name: 'a', evil: 'x', type2: 'y' });
  assert.deepEqual(out, { type: 'cat-saved', name: 'a' });
  assert.equal('evil' in out, false);
});

/* ---------------- 决策:绝不静默丢弃未保存的改动 ---------------- */

test('planSavedCategoryAction:本地有未保存改动 → 只警告,不刷新', () => {
  assert.equal(
    planSavedCategoryAction({ isKnown: true, isDirty: true }),
    'warn-dirty',
    '正在编辑时自动刷新会丢掉用户的改动,必须只警告',
  );
});

test('planSavedCategoryAction:本地干净 → 重读云端', () => {
  assert.equal(planSavedCategoryAction({ isKnown: true, isDirty: false }), 'reload');
});

test('planSavedCategoryAction:本机没这个分类 → 不关我事', () => {
  assert.equal(planSavedCategoryAction({ isKnown: false, isDirty: false }), 'ignore');
  assert.equal(planSavedCategoryAction({ isKnown: false, isDirty: true }), 'ignore');
});

/* ---------------- 通道行为 ---------------- */

test('两个标签页互通,且发送者收不到自己的消息', () => {
  const FakeChannel = makeBus();
  const gotA = [];
  const gotB = [];
  const a = new TabSync({ Channel: FakeChannel, onMessage: (m) => gotA.push(m) });
  const b = new TabSync({ Channel: FakeChannel, onMessage: (m) => gotB.push(m) });

  assert.equal(a.enabled, true);
  assert.equal(a.send({ type: 'cat-saved', name: '秘钥' }), true);

  assert.deepEqual(gotB, [{ type: 'cat-saved', name: '秘钥' }], '另一个标签页必须收到');
  assert.deepEqual(gotA, [], '发送者不该收到自己的消息(否则会自我循环)');
});

test('通道会过滤掉畸形消息,回调根本不会被调用', () => {
  const FakeChannel = makeBus();
  const got = [];
  const a = new TabSync({ Channel: FakeChannel, onMessage: (m) => got.push(m) });
  const b = new TabSync({ Channel: FakeChannel });
  b.channel.onmessage({ data: { type: 'nonsense' } });
  assert.deepEqual(got, []);
  void a;
});

test('回调抛错不影响后续消息(一条坏消息不该让同步整体失效)', () => {
  const FakeChannel = makeBus();
  const got = [];
  let first = true;
  const a = new TabSync({
    Channel: FakeChannel,
    onMessage: (m) => { if (first) { first = false; throw new Error('boom'); } got.push(m); },
  });
  const b = new TabSync({ Channel: FakeChannel });
  b.send({ type: 'locked' });
  b.send({ type: 'cat-saved', name: 'x' });
  assert.deepEqual(got, [{ type: 'cat-saved', name: 'x' }], '第二条应当照常送达');
  void a;
});

test('环境不支持 BroadcastChannel → 静默降级,不抛错', () => {
  // 注意必须传 null 而不是 undefined:解构默认值只对 undefined 生效,
  // 而 Node 22 自带全局 BroadcastChannel —— 传 undefined 会建出**真通道**,
  // 既测不到降级路径,又会因为句柄没关而让测试进程退不出去。
  const t = new TabSync({ Channel: null });
  assert.equal(t.enabled, false);
  assert.equal(t.send({ type: 'locked' }), false);
  assert.doesNotThrow(() => t.close());
});

test('构造失败(隐私模式等)→ 同样降级而不是崩掉', () => {
  const Boom = function Boom() { throw new Error('blocked'); };
  const t = new TabSync({ Channel: Boom });
  assert.equal(t.enabled, false);
  assert.equal(t.send({ type: 'locked' }), false);
});

test('close() 之后不再收发', () => {
  const FakeChannel = makeBus();
  const got = [];
  const a = new TabSync({ Channel: FakeChannel, onMessage: (m) => got.push(m) });
  const b = new TabSync({ Channel: FakeChannel });
  a.close();
  assert.equal(a.enabled, false);
  assert.equal(a.send({ type: 'locked' }), false);
  b.send({ type: 'locked' });
  assert.deepEqual(got, [], '关掉之后不该再收到');
});