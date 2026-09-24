/* 库级操作单测:vault.json 建库/解锁/改密码 + 分类数据 + 附件命名 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault, unlockVault, rewrapVault, deriveAllKeys, dekMatchesVault,
  encryptCategory, decryptCategory, normalizeNoteData,
  blobFileNameFor, encryptBlob, decryptBlob,
  PBKDF2_ITERATIONS_DEFAULT, PBKDF2_ITERATIONS_MIN, PBKDF2_ITERATIONS_MAX,
} from '../public/js/vaultlib.js';
import { CryptoError, FormatError } from '../public/js/crypto.js';

const ITER = 1000;

test('建库 → 正确密码解锁成功,并产出鉴权令牌与 authHash', async () => {
  const { json, dek, authKeyHex } = await createVault('强密码123', ITER);
  assert.equal(json.magic, 'JMBIJI');
  assert.equal(json.kdf.iterations, ITER);
  assert.match(json.auth.hash, /^[0-9a-f]{64}$/, 'authHash 应为 hex64');
  assert.match(authKeyHex, /^[0-9a-f]{64}$/, '鉴权令牌应为 hex64');
  const res = await unlockVault(json, '强密码123');
  assert.ok(res.ok);
  assert.deepEqual(res.dek, dek);
  // 同一密码解锁两次,令牌必须一致(服务端 authHash 校验的依据)
  const res2 = await unlockVault(json, '强密码123');
  assert.equal(res2.authKeyHex, authKeyHex);
  assert.notEqual(res2.authKeyHex, json.auth.hash, '服务端存的应是令牌的哈希,不是令牌本身');
});

test('错误密码 → reason=password;结构损坏 → reason=corrupt', async () => {
  const { json } = await createVault('正确密码', ITER);
  assert.deepEqual(await unlockVault(json, '错误密码'), { ok: false, reason: 'password' });
  assert.equal((await unlockVault({ ...json, magic: 'XX' }, '正确密码')).reason, 'corrupt');
  assert.equal((await unlockVault({ ...json, version: 99 }, '正确密码')).reason, 'corrupt');
  assert.equal((await unlockVault({ ...json, wrap: {} }, '正确密码')).reason, 'corrupt');
  // wrappedDek 被篡改 → 解包失败 → password
  const w = json.wrap.wrappedDek;
  const tampered = (w[0] === 'A' ? 'B' : 'A') + w.slice(1);
  assert.equal((await unlockVault({ ...json, wrap: { ...json.wrap, wrappedDek: tampered } }, '正确密码')).reason, 'password');
  assert.equal((await unlockVault(null, 'x')).reason, 'corrupt');
});

test('改主密码:重包 DEK,旧密码失效、新密码可解锁,dek 不变;鉴权令牌随之更换', async () => {
  const { json, dek, authKeyHex: oldToken } = await createVault('旧密码abc', ITER);
  const { json: newJson, authKeyHex: newToken } = await rewrapVault(json, dek, '新密码xyz');
  assert.equal((await unlockVault(newJson, '旧密码abc')).ok, false);
  const res = await unlockVault(newJson, '新密码xyz');
  assert.ok(res.ok);
  assert.deepEqual(res.dek, dek);
  assert.notEqual(newJson.kdf.salt, json.kdf.salt, '盐应换新');
  assert.notEqual(newToken, oldToken, '改密码后旧令牌必须失效');
  assert.equal(res.authKeyHex, newToken, '重包返回的令牌应与新密码解锁派生的一致');
  // 新令牌的 SHA-256 应等于新 authHash(服务端校验依据)
  const { sha256Hex, hexToBytes } = await import('../public/js/crypto.js');
  assert.equal(await sha256Hex(hexToBytes(newToken)), newJson.auth.hash);
});

test('派生子密钥后分类数据加解密往返;换库密钥解不开', async () => {
  const { dek } = await createVault('pw123456', ITER);
  const { contentKey } = await deriveAllKeys(dek);
  const data = { notes: [{ id: 'n1', title: 'CF 中转', content: '**base_url**: https://x', order: 1000, createdAt: 1, updatedAt: 2, attachments: [] }] };
  const bytes = await encryptCategory(contentKey, data);
  const back = await decryptCategory(contentKey, bytes);
  assert.equal(back.notes[0].title, 'CF 中转');

  const other = await deriveAllKeys((await createVault('other99', ITER)).dek);
  await assert.rejects(() => decryptCategory(other.contentKey, bytes), CryptoError);
});

test('分类数据损坏 → FormatError 而非静默', async () => {
  const { dek } = await createVault('pw123456', ITER);
  const { contentKey } = await deriveAllKeys(dek);
  // 合法加密、但内部 JSON 结构不对(无 notes 数组)
  const bad = await encryptCategory(contentKey, { foo: 1 });
  await assert.rejects(() => decryptCategory(contentKey, bad), FormatError);
});

test('normalizeNoteData:宽容读取、补默认值', () => {
  const out = normalizeNoteData({ notes: [{ title: 't', content: 'c' }] });
  assert.equal(out.notes.length, 1);
  assert.ok(out.notes[0].id);
  assert.ok(Number.isFinite(out.notes[0].order));
  assert.deepEqual(out.notes[0].attachments, []);
  assert.throws(() => normalizeNoteData({ nope: 1 }), FormatError);
  assert.throws(() => normalizeNoteData(null), FormatError);
  // 坏附件条目被过滤
  const out2 = normalizeNoteData({ notes: [{ attachments: [{ file: 'a.png' }, null, { name: 'x' }] }] });
  assert.equal(out2.notes[0].attachments.length, 1);
});

test('附件:内容寻址文件名稳定 + 加解密往返 + 去重语义', async () => {
  const { dek } = await createVault('pw123456', ITER);
  const { attachKey, filenameKey } = await deriveAllKeys(dek);
  const imgBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);
  const n1 = await blobFileNameFor(filenameKey, imgBytes, '截图.png');
  const n2 = await blobFileNameFor(filenameKey, imgBytes.slice(), '任意名字.png');
  assert.equal(n1, n2, '同内容同文件名(与原名无关)');
  assert.ok(n1.endsWith('.png'));
  const enc = await encryptBlob(attachKey, imgBytes);
  const back = await decryptBlob(attachKey, enc);
  assert.deepEqual(back, imgBytes);
  const otherKeys = await deriveAllKeys((await createVault('other99', ITER)).dek);
  await assert.rejects(() => decryptBlob(otherKeys.attachKey, enc), CryptoError);
});

/* ---------- 迭代次数上下限 ---------- */

test('解锁:迭代次数低于当前下限时置 weakKdf 提示(但照常解锁)', async () => {
  const low = await createVault('低迭代密码123', ITER); // 1000 次
  const r = await unlockVault(low.json, '低迭代密码123');
  assert.equal(r.ok, true);
  assert.equal(r.weakKdf, true);

  const normal = await createVault('正常迭代密码123', PBKDF2_ITERATIONS_MIN);
  const r2 = await unlockVault(normal.json, '正常迭代密码123');
  assert.equal(r2.ok, true);
  assert.equal(r2.weakKdf, false);
});

test('建库:非法迭代次数回落默认值,落盘值与实际派生值一致', async () => {
  const a = await createVault('非法迭代密码123', 0);
  assert.equal(a.json.kdf.iterations, PBKDF2_ITERATIONS_DEFAULT);
  // 落盘值即解锁时用的值:能解开就说明两者一致
  assert.equal((await unlockVault(a.json, '非法迭代密码123')).ok, true);
  const b = await createVault('负迭代密码1234', -5);
  assert.equal(b.json.kdf.iterations, PBKDF2_ITERATIONS_DEFAULT);
});

/* dekMatchesVault:「记住本设备」恢复会话前的配对校验。
 * 本机存的 DEK 可能属于另一个库,不校验就会「进去了但每个分类都打不开」。 */
test('dekMatchesVault:只认与这份 vault.json 配对的 DEK', async () => {
  const a = await createVault('配对校验密码A', ITER);
  const b = await createVault('配对校验密码B', ITER);

  assert.equal(await dekMatchesVault(a.json, a.dek), true, '自己的 DEK 必须判定为配对');
  assert.equal(await dekMatchesVault(a.json, b.dek), false, '另一个库的 DEK 必须被判不配对');
  assert.equal(await dekMatchesVault(b.json, a.dek), false, '反向同样');

  // 改主密码不换 DEK → 仍然配对(否则改完密码就被踢下线)
  const { json: rewrapped } = await rewrapVault(a.json, a.dek, '换个密码abc');
  assert.equal(await dekMatchesVault(rewrapped, a.dek), true, '改密码后 DEK 不变,应当仍配对');

  // 畸形输入一律 false,不抛错
  assert.equal(await dekMatchesVault(null, a.dek), false);
  assert.equal(await dekMatchesVault({}, a.dek), false);
  assert.equal(await dekMatchesVault(a.json, null), false);
  assert.equal(await dekMatchesVault(a.json, new Uint8Array(8)), false);
});
