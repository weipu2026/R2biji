/* ============================================================
 * 「记住本设备」本机会话的存取 —— 纯模块单测
 *
 * 这是全应用**唯一把密钥落盘**的地方,所以边界要比别处更严:
 * 读到的任何不合规数据都必须当作「没记住」(返回 null),
 * 绝不能半信半疑地拿去解密 —— 那会变成「进去了但每个分类都打不开」。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSession, loadSession, clearSession, hasSession } from '../public/js/session.js';
import { bytesToB64 } from '../public/js/crypto.js';

/* Node 默认没有 localStorage(要开 --experimental-webstorage),
 * 用一个 Map 版替身,并能模拟「存储不可用」(隐私模式/被禁)。 */
function installStorage({ broken = false } = {}) {
  const map = new Map();
  globalThis.localStorage = broken
    ? {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
      removeItem() { throw new Error('storage disabled'); },
    }
    : {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  return map;
}

const DEK = new Uint8Array(32).map((_, i) => i + 1);
const TOKEN = 'a'.repeat(64);
const STORE_KEY = 'jmbiji.session';

test('存取往返:DEK 与令牌原样还原', () => {
  installStorage();
  assert.equal(saveSession({ dek: DEK, authKeyHex: TOKEN }), true);
  const s = loadSession();
  assert.ok(s, '存过就必须读得回来');
  assert.deepEqual(s.dek, DEK, 'DEK 字节必须一致');
  assert.equal(s.authKeyHex, TOKEN);
  assert.equal(hasSession(), true);
});

test('没存过 → null(而不是抛错)', () => {
  installStorage();
  assert.equal(loadSession(), null);
  assert.equal(hasSession(), false);
});

test('clearSession 之后读不到', () => {
  installStorage();
  saveSession({ dek: DEK, authKeyHex: TOKEN });
  assert.equal(hasSession(), true);
  clearSession();
  assert.equal(loadSession(), null, '锁定/退出后必须真的读不到');
});

test('存储不可用(隐私模式)→ 静默降级为「不记住」,不抛错', () => {
  installStorage({ broken: true });
  assert.equal(saveSession({ dek: DEK, authKeyHex: TOKEN }), false, '存不下要如实返回 false');
  assert.equal(loadSession(), null);
  assert.doesNotThrow(() => clearSession());
});

test('拒收非法入参:一条都不许落盘', () => {
  const map = installStorage();
  assert.equal(saveSession({ dek: new Uint8Array(16), authKeyHex: TOKEN }), false, 'DEK 长度不对');
  assert.equal(saveSession({ dek: DEK, authKeyHex: 'xyz' }), false, '令牌不是 hex64');
  assert.equal(saveSession({ dek: DEK, authKeyHex: 'g'.repeat(64) }), false, '令牌含非 hex 字符');
  assert.equal(saveSession({ dek: null, authKeyHex: TOKEN }), false);
  assert.equal(saveSession({}), false);
  assert.equal(map.size, 0, '非法输入不该写进存储');
});

test('读到脏数据一律当作「没记住」', () => {
  const map = installStorage();
  const bad = [
    ['不是 JSON', '{oops'],
    ['版本不符', JSON.stringify({ v: 99, dek: bytesToB64(DEK), authKeyHex: TOKEN })],
    ['缺令牌字段', JSON.stringify({ v: 1, dek: bytesToB64(DEK) })],
    ['缺 dek 字段', JSON.stringify({ v: 1, authKeyHex: TOKEN })],
    ['令牌非 hex64', JSON.stringify({ v: 1, dek: bytesToB64(DEK), authKeyHex: 'zz' })],
    ['DEK 长度不对', JSON.stringify({ v: 1, dek: bytesToB64(new Uint8Array(8)), authKeyHex: TOKEN })],
    ['DEK 不是合法 base64', JSON.stringify({ v: 1, dek: '!!!not-base64!!!', authKeyHex: TOKEN })],
    ['顶层是数组', JSON.stringify([1, 2, 3])],
    ['顶层是 null', 'null'],
  ];
  for (const [why, raw] of bad) {
    map.set(STORE_KEY, raw);
    assert.equal(loadSession(), null, `${why} → 应当被当作「没记住」`);
  }
});
