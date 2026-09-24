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
import { saveSession, loadSession } from '../public/js/session.js';

const ITER = 1000;

/* Node 没有 localStorage,给个 Map 版替身(session.js 与 api.js 都按「不可用就降级」写,
 * 这里提供可用版本,才能测到真实路径) */
globalThis.localStorage = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
})();

/* 把浏览器 fetch 桥接到纯函数核心 handleApi。
 * 刻意不构造 undici 的 Request/Response(受限沙箱里其内部惰性 WASM 必然
 * 实例化失败,产生 unhandledRejection 噪音),用纯对象模拟网络层:
 * - 头部键统一小写(真实 HTTP 传输语义);
 * - 字符串体编码为字节(handleApi 只收 Uint8Array/null);
 * - 响应提供 api.js 用到的最小面(ok/status/headers.get/json/arrayBuffer)。 */
let env = { VAULT: new MemoryR2(), ALLOW_NO_ACCESS_KEY: '1' };
const te = new TextEncoder();

/** 每个用例开头调用:换一个全新的内存桶。
 *  共用同一个桶会让用例之间互相污染(建库会 409),而这类污染恰好会掩盖真 bug。 */
function freshEnv() { env = { VAULT: new MemoryR2(), ALLOW_NO_ACCESS_KEY: '1' }; }

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
  freshEnv();
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

/* ============================================================
 * 孤儿清理的 fail-closed 守卫(两条都是真实数据丢失路径的回归)
 *
 * blobs 是全应用唯一没有备份层的东西:DELETE /api/blob 直接删对象,
 * 不像分类那样先写 backup/ —— 误删一张图就是永久丢失。
 * 因此「清点不全」的每种情况都必须整次中止,而不是照着删。
 * ============================================================ */

test('孤儿清理:分类读不出来时必须整次中止,一张图片都不许删', async () => {
  freshEnv();
  API.clearToken();

  const { json, dek, authKeyHex } = await V.createVault('清理守卫密码abc', ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(json))).status, 201);
  API.setToken(authKeyHex);

  /* 设备 A:建分类 + 放一张图 + 保存 */
  const a = new Library(await V.deriveAllKeys(dek), json, dek, null);
  await a.rescan();
  await a.createCategory('攻略');
  const img = new Uint8Array([137, 80, 78, 71, 7, 7, 7]);
  const att = await a.addAttachment(img, '重要截图.png');
  a.categoryInfo('攻略').data.notes.push({
    id: 'n1', title: '攻略', content: '看图', order: 1000,
    createdAt: 1, updatedAt: 1, attachments: [{ file: att.file, name: '重要截图.png' }],
  });
  assert.deepEqual(await a.saveCategory('攻略'), { ok: true });

  /* 设备 B:全新解锁(内存里没有明文),随后该分类密文损坏 */
  const b = await unlockAs('清理守卫密码abc');
  await b.rescan();
  await env.VAULT.put('cats/攻略.enc', new Uint8Array([1, 2, 3])); // 截断

  const readable = await b.loadCategory('攻略').then(() => true, () => false);
  assert.equal(readable, false, '前提:损坏的分类应当读不出来');
  assert.ok(b.categoryInfo('攻略').error, '前提:读取失败必须被记进 error(而不是静默当成空分类)');

  await assert.rejects(() => b.cleanupOrphanBlobs(), /无法清点/, '读不出来就必须中止,不能照删');
  assert.ok(await env.VAULT.head(`blobs/${att.file}`), '图片必须原样留在 R2(blob 没有备份层)');
});

test('孤儿清理:必须先刷新分类清单,否则别的设备新建的图片会被误删', async () => {
  freshEnv();
  API.clearToken();

  const { json, dek, authKeyHex } = await V.createVault('多端清理密码abc', ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(json))).status, 201);
  API.setToken(authKeyHex);

  /* 设备 A 解锁并建一个空分类 —— 它的分类清单就停在这一刻 */
  const a = new Library(await V.deriveAllKeys(dek), json, dek, null);
  await a.rescan();
  await a.createCategory('A的分类');

  /* 设备 B 随后新建另一个分类,并放一张图 */
  const b = await unlockAs('多端清理密码abc');
  await b.rescan();
  await b.createCategory('B的分类');
  const img = new Uint8Array([137, 80, 78, 71, 5, 5, 5]);
  const att = await b.addAttachment(img, 'B的图.png');
  b.categoryInfo('B的分类').data.notes.push({
    id: 'n1', title: 'B 的笔记', content: '看图', order: 1000,
    createdAt: 1, updatedAt: 1, attachments: [{ file: att.file, name: 'B的图.png' }],
  });
  assert.deepEqual(await b.saveCategory('B的分类'), { ok: true });

  /* 回到设备 A:A 的清单里根本没有「B的分类」,若不清点就直接删,这张图就没了 */
  const removed = await a.cleanupOrphanBlobs();
  assert.deepEqual(removed, [], '本机清单之外的分类,其图片一张都不该被删');
  assert.ok(await env.VAULT.head(`blobs/${att.file}`), 'B 的图片必须还在');
});

/* ============================================================
 * 「记住本设备」:落盘的会话必须**真的能解开笔记**
 *
 * 这条是「打开即用」的实质判据 —— 光验证「存了几个字节、读得回来」不够,
 * 要证明**不碰主密码**也能读到明文。所以这里刻意不调用 unlockVault。
 * ============================================================ */
test('记住本设备:落盘的会话足以解开笔记,全程不用主密码', async () => {
  freshEnv();
  API.clearToken();

  /* ---- 设备 A:建库、建分类、写一条笔记 ---- */
  const PW = '记住本设备密码abc';
  const { json, dek, authKeyHex } = await V.createVault(PW, ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(json))).status, 201);
  API.setToken(authKeyHex);
  const a = new Library(await V.deriveAllKeys(dek), json, dek, null);
  await a.rescan();
  await a.createCategory('秘钥');
  a.categoryInfo('秘钥').data.notes.push({
    id: 'n1', title: '中转站令牌', content: '**base_url**: https://x',
    order: 1000, createdAt: 1, updatedAt: 1, attachments: [],
  });
  assert.deepEqual(await a.saveCategory('秘钥'), { ok: true });

  /* ---- 勾选「记住本设备」:只落盘 DEK + 令牌 ---- */
  assert.equal(saveSession({ dek, authKeyHex }), true, '应当存得下');

  /* ---- 模拟「下次打开」:清掉内存态,只用落盘的会话 ---- */
  API.clearToken();
  if (a) a.destroy();
  const sess = loadSession();
  assert.ok(sess, '应当读得回本机会话');

  const vaultNow = (await API.fetchVault()).json;
  assert.equal(await V.dekMatchesVault(vaultNow, sess.dek), true, '会话里的 DEK 必须与当前库配对');

  API.setToken(sess.authKeyHex);
  const b = new Library(await V.deriveAllKeys(sess.dek), vaultNow, sess.dek, null);
  await b.rescan();
  const notes = await b.loadCategory('秘钥'); // 这一步会真的解密
  assert.equal(notes.notes[0].title, '中转站令牌', '用落盘的会话必须能读到明文');
  assert.equal(notes.notes[0].content, '**base_url**: https://x');

  /* ---- 主密码仍然有效(会话是「额外的便捷」,不是「替代品」) ---- */
  assert.equal((await V.unlockVault(vaultNow, PW)).ok, true, '主密码不该因为记住会话而失效');
});

/* ============================================================
 * 全库密文备份:导出 → 桶没了 → 恢复 → 数据完好
 *
 * 这是 ③ 的核心判据。它补的是「vault.json 单独一份副本只有钥匙、没有箱子」
 * 那个真空 —— 桶一旦丢失或账号出问题,手上那把钥匙打不开任何东西。
 * ============================================================ */
test('全库备份:导出 → 桶清空 → 恢复,笔记与图片必须完好', async () => {
  freshEnv();
  API.clearToken();

  const PW = '全库备份测试密码';
  const { json, dek, authKeyHex } = await V.createVault(PW, ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(json))).status, 201);
  API.setToken(authKeyHex);

  /* ---- 造点内容:两个分类、一条笔记、两张图 ---- */
  const a = new Library(await V.deriveAllKeys(dek), json, dek, null);
  await a.rescan();
  await a.createCategory('秘钥');
  await a.createCategory('攻略');
  const img1 = new Uint8Array([137, 80, 78, 71, 1, 1, 1]);
  const img2 = new Uint8Array([137, 80, 78, 71, 2, 2, 2]);
  const att1 = await a.addAttachment(img1, '截图.png');
  const att2 = await a.addAttachment(img2, '另一张.png');
  a.categoryInfo('秘钥').data.notes.push({
    id: 'n1', title: 'CF 中转', content: '**base_url**: https://x',
    order: 1000, createdAt: 1, updatedAt: 1,
    attachments: [{ file: att1.file, name: '截图.png' }],
  });
  assert.deepEqual(await a.saveCategory('秘钥'), { ok: true });

  /* ---- 导出:先给计划(总量),再打包 ---- */
  let plan = null;
  const exported = await a.exportBackup({
    onPlan: (p) => { plan = p; return true; },
  });
  assert.ok(plan, 'exportBackup 必须先报总量');
  assert.equal(plan.cats, 2, '两个分类');
  assert.equal(plan.blobs, 2, '两张图片');
  assert.ok(plan.bytes > 0, '总量应当大于 0');
  assert.ok(exported.bytes.length > 0);
  assert.ok(exported.bytes[0] === 0x50 && exported.bytes[1] === 0x4b, '应当是 zip(PK 开头)');

  /* ---- 灾难:整个桶没了 ---- */
  freshEnv();
  API.setToken(authKeyHex); // 令牌还在内存里,桶本身换成了空的
  assert.equal((await API.fetchVault()).status, 404, '前提:新桶里没有库');

  /* ---- 恢复 ---- */
  const r = await a.importBackup(exported.bytes);
  assert.equal(r.vaultCreated, true, '空桶 → 应当把 vault.json 建出来');
  assert.deepEqual(r.catsAdded.sort(), ['攻略', '秘钥'], '两个分类都该恢复');
  assert.deepEqual(r.catsSkipped, []);
  assert.equal(r.blobsAdded, 2, '两张图片都该恢复');
  assert.deepEqual(r.failed, [], '不该有失败项');

  /* ---- 关键:用**原主密码**解锁恢复出来的库,内容必须一模一样 ---- */
  const vaultAfter = await API.fetchVault();
  assert.equal(vaultAfter.status, 200);
  const unlocked = await V.unlockVault(vaultAfter.json, PW);
  assert.ok(unlocked.ok, '原主密码必须能解锁恢复出来的库');
  assert.deepEqual(unlocked.dek, dek, 'DEK 必须与备份前一致(否则密文全废)');

  API.setToken(unlocked.authKeyHex);
  const b = new Library(await V.deriveAllKeys(unlocked.dek), vaultAfter.json, unlocked.dek, null);
  await b.rescan();
  assert.deepEqual(b.listCategories().sort(), ['攻略', '秘钥']);
  const notes = await b.loadCategory('秘钥');
  assert.equal(notes.notes[0].title, 'CF 中转', '笔记内容必须完好');
  assert.equal(notes.notes[0].attachments[0].file, att1.file);
  assert.deepEqual(await b.readAttachment(att1.file), img1, '附件必须能解密回原始字节');
  assert.deepEqual(await b.readAttachment(att2.file), img2);
});

test('全库备份:目标是另一个库时必须拒绝(否则得到一堆解不开的文件)', async () => {
  freshEnv();
  API.clearToken();

  const A = await V.createVault('备份来源库密码', ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(A.json))).status, 201);
  API.setToken(A.authKeyHex);
  const libA = new Library(await V.deriveAllKeys(A.dek), A.json, A.dek, null);
  await libA.rescan();
  await libA.createCategory('甲的机密');
  const zipOfA = (await libA.exportBackup()).bytes;

  // 换一个桶,建一个**不同的库**(另一把 DEK)
  freshEnv();
  const B = await V.createVault('另一个库的密码', ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(B.json))).status, 201);
  API.setToken(B.authKeyHex);
  const libB = new Library(await V.deriveAllKeys(B.dek), B.json, B.dek, null);
  await libB.rescan();

  await assert.rejects(
    () => libB.importBackup(zipOfA),
    (e) => e.code === 'foreign-vault',
    '往别的库里导必须被拒 —— 钥匙对不上,导进去只会得到解不开的密文',
  );

  // 拒绝之后,原来的库必须毫发无伤
  await libB.rescan();
  assert.deepEqual(libB.listCategories(), [], '拒绝导入不该在目标库里留下东西');
  assert.equal((await API.fetchVault()).json.wrap.wrappedDek, B.json.wrap.wrappedDek, '目标库的钥匙不该被换掉');
});

test('全库备份:恢复时已存在的分类一律跳过,绝不覆盖', async () => {
  freshEnv();
  API.clearToken();

  const PW = '不覆盖测试密码ab';
  const { json, dek, authKeyHex } = await V.createVault(PW, ITER);
  assert.equal((await API.createVaultJson(JSON.stringify(json))).status, 201);
  API.setToken(authKeyHex);
  const a = new Library(await V.deriveAllKeys(dek), json, dek, null);
  await a.rescan();
  await a.createCategory('秘钥');
  const zipBytes = (await a.exportBackup()).bytes;

  // 服务器上的这个分类随后被改成了「新版本」
  a.categoryInfo('秘钥').data.notes.push({
    id: 'n9', title: '服务器上的新版本', content: '新', order: 1,
    createdAt: 9, updatedAt: 9, attachments: [],
  });
  assert.deepEqual(await a.saveCategory('秘钥'), { ok: true });

  // 恢复旧备份 → 该分类必须被跳过,不能把新版本盖回旧的
  const r = await a.importBackup(zipBytes);
  assert.equal(r.catsAdded.length, 0);
  assert.deepEqual(r.catsSkipped, ['秘钥']);

  const still = await a.loadCategory('秘钥');
  assert.equal(still.notes[0].title, '服务器上的新版本', '服务器上的较新版本绝不能被旧备份覆盖');
});
