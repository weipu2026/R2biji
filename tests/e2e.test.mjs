/* ============================================================
 * 端到端集成测试:真 api.js 客户端 ↔ 真 worker.js(内存 R2)
 * 覆盖单测抓不住的「层间契约」:建库→解锁→增删改→多端冲突→改密码换令牌
 * (改密码后 Bearer 必须同步更换,否则后续请求 401 —— 曾在此抓出真 bug)
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../worker/worker.js';
import { MemoryR2 } from '../worker/memory-r2.mjs';
import * as API from '../public/js/api.js';
import { Library } from '../public/js/lib.js';
import * as V from '../public/js/vaultlib.js';
import { hexToBytes, sha256Hex } from '../public/js/crypto.js';

const ITER = 1000;

/* 把浏览器 fetch 桥接到纯函数核心 handleApi。
 * 刻意不构造 undici 的 Request/Response(受限沙箱里其内部惰性 WASM 必然
 * 实例化失败,产生 unhandledRejection 噪音),用纯对象模拟网络层:
 * - 头部键统一小写(真实 HTTP 传输语义);
 * - 字符串体编码为字节(handleApi 只收 Uint8Array/null);
 * - 响应提供 api.js 用到的最小面(ok/status/headers.get/json/arrayBuffer)。 */
const env = { VAULT: new MemoryR2(), ALLOW_NO_ACCESS_KEY: '1' };
const te = new TextEncoder();

function fakeRes(out) {
  const raw = out.body;
  const headers = new Map(Object.entries(out.headers || {}));
  return {
    ok: out.status >= 200 && out.status < 300,
    status: out.status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    json: async () => JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw ?? new Uint8Array())),
    arrayBuffer: async () => (raw instanceof Uint8Array ? raw.slice().buffer : te.encode(String(raw ?? '')).buffer),
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, 'http://localhost');
  const headers = {};
  const h = init.headers || (typeof input !== 'string' ? Object.fromEntries(input.headers || []) : null) || {};
  for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
  let body = init.body ?? null;
  if (typeof body === 'string') body = te.encode(body);
  const out = await handleApi(init.method || 'GET', url.href, headers, body, env);
  return fakeRes(out);
};

/** 端上模拟「解锁」:拉 vault.json → 解锁 → setToken → 构建 Library */
async function unlockAs(password, prevEtag = null) {
  const { status, json, etag } = await API.fetchVault();
  assert.equal(status, 200, 'vault.json 应已存在');
  const res = await V.unlockVault(json, password);
  assert.ok(res.ok, `解锁失败:${res?.reason}`);
  API.setToken(res.authKeyHex);
  const keys = await V.deriveAllKeys(res.dek);
  return new Library(keys, json, res.dek, etag ?? prevEtag);
}

test('全生命周期:建库 → 写读 → 多端 CAS 冲突 → 改密码换令牌 → 旧令牌失效', async () => {
  API.clearToken();

  /* ---- 建库(设备 A) ---- */
  const { json, dek, authKeyHex } = await V.createVault('旧密码abc', ITER);
  const created = await API.createVaultJson(JSON.stringify(json));
  assert.equal(created.status, 201);
  assert.ok(created.etag, '建库响应必须带回 etag(改密码 CAS 的基线)');
  assert.equal((await API.createVaultJson(JSON.stringify(json))).status, 409, '重复建库必须被拒');
  API.setToken(authKeyHex);
  const a = new Library(await V.deriveAllKeys(dek), json, dek, created.etag);
  await a.rescan();

  /* ---- A 建分类 + 附件并保存 ---- */
  await a.createCategory('秘钥');
  const cat = a.categoryInfo('秘钥');
  cat.data.notes.push({
    id: 'n1', title: 'CF 中转', content: '**base_url**: https://x',
    order: 1000, createdAt: 1, updatedAt: 1, attachments: [],
  });
  const img = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const att = await a.addAttachment(img, '截图.png');
  cat.data.notes[0].attachments.push({ file: att.file, name: '截图.png' });
  assert.deepEqual(await a.saveCategory('秘钥'), { ok: true });

  /* ---- 附件内容寻址去重 + 读回一致 ---- */
  const att2 = await a.addAttachment(img, '换名.png');
  assert.equal(att2.existed, true, '同图重复入库应去重');
  assert.deepEqual(await a.readAttachment(att.file), img);

  /* ---- 设备 B 解锁同一库,读到的内容一致 ---- */
  const b = await unlockAs('旧密码abc');
  await b.rescan();
  const bCat = await b.loadCategory('秘钥');
  assert.equal(bCat.notes[0].title, 'CF 中转');
  assert.deepEqual(await b.readAttachment(att.file), img);

  /* ---- 多端 CAS:A、B 同时持有同一版本,B 覆盖后 A 再存 → 冲突;force 可覆盖 ---- */
  bCat.notes[0].content = 'B 改的';
  assert.deepEqual(await b.saveCategory('秘钥'), { ok: true });
  cat.data.notes[0].content = 'A 改的(基于旧版本)';
  assert.deepEqual(await a.saveCategory('秘钥'), { conflict: true }, '旧 etag 写入必须被拒(412)');
  assert.deepEqual(await a.saveCategory('秘钥', { force: true }), { ok: true }, 'force 以服务器当前版本为基线覆盖');

  /* ---- 改主密码:令牌必须同步更换,旧令牌立即失效 ---- */
  const oldToken = (await V.unlockVault((await API.fetchVault()).json, '旧密码abc')).authKeyHex;
  assert.equal(await sha256Hex(hexToBytes(oldToken)), (await API.fetchVault()).json.auth.hash);
  await a.changeMasterPassword('新密码xyz');
  // 旧令牌打服务端 → 401
  const oldRes = await fetch('/api/cats', { headers: { authorization: `Bearer ${oldToken}` } });
  assert.equal(oldRes.status, 401, '旧令牌必须立即失效');
  // a 实例(库内已换新令牌)继续可用
  await a.rescan();
  const aCat = await a.loadCategory('秘钥');
  assert.equal(aCat.notes[0].content, 'A 改的(基于旧版本)');
  aCat.notes[0].content = '改密码后仍能正常保存';
  assert.deepEqual(await a.saveCategory('秘钥'), { ok: true }, '改密码后不刷新页面就能继续保存');

  /* ---- 用新密码在"另一台设备"解锁,验证数据完好 ---- */
  const c = await unlockAs('新密码xyz');
  await c.rescan();
  const cCat = await c.loadCategory('秘钥');
  assert.equal(cCat.notes[0].content, '改密码后仍能正常保存');
  assert.equal(cCat.notes[0].attachments[0].file, att.file, '附件引用跨改密码不变');
  assert.deepEqual(await c.readAttachment(att.file), img);

  /* ---- 孤儿清理:删笔记引用后回收 ---- */
  cCat.notes = [];
  await c.saveCategory('秘钥');
  const removed = await c.cleanupOrphanBlobs();
  assert.deepEqual(removed, [att.file]);
});
