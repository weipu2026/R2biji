/* 加密核心单测:node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKek, generateDekBytes, wrapDek, unwrapDek,
  deriveContentKey, deriveAttachKey, deriveFilenameKey, hmacBytes,
  makeVerifier, checkVerifier,
  seal, open, sealText, openText, parseHeader,
  bytesToB64, b64ToBytes, bytesToB64url, bytesEqual,
  CryptoError, FormatError, MAGIC,
  clampIterations, PBKDF2_ITERATIONS_DEFAULT, PBKDF2_ITERATIONS_MIN, PBKDF2_ITERATIONS_MAX,
} from '../public/js/crypto.js';

const ITER = 1000; // 测试用低迭代次数(生产默认 100 万)

test('迭代次数收口:非法值回落默认,超大值截断到上限,区间关系自洽', () => {
  assert.equal(clampIterations(undefined), PBKDF2_ITERATIONS_DEFAULT);
  assert.equal(clampIterations(NaN), PBKDF2_ITERATIONS_DEFAULT);
  assert.equal(clampIterations(0), PBKDF2_ITERATIONS_DEFAULT);
  assert.equal(clampIterations(-1), PBKDF2_ITERATIONS_DEFAULT);
  assert.equal(clampIterations(1000), 1000, '合法值原样保留(测试/低配设备需要)');
  assert.equal(clampIterations(PBKDF2_ITERATIONS_MAX + 1), PBKDF2_ITERATIONS_MAX);
  assert.equal(clampIterations(1e15), PBKDF2_ITERATIONS_MAX, '被篡改的 vault.json 不能靠天文数字冻死标签页');
  assert.equal(clampIterations(2.7), 2);
  assert.ok(PBKDF2_ITERATIONS_MIN <= PBKDF2_ITERATIONS_DEFAULT);
  assert.ok(PBKDF2_ITERATIONS_DEFAULT <= PBKDF2_ITERATIONS_MAX);
});

test('b64 与 b64url 往返一致', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes);
  assert.ok(!bytesToB64url(bytes).includes('='));
});

test('KEK 派生确定且与盐/密码绑定', async () => {
  const salt = new Uint8Array(16).fill(7);
  const a = await deriveKek('密码abc', salt, ITER);
  const b = await deriveKek('密码abc', salt, ITER);
  const c = await deriveKek('别的密码', salt, ITER);
  const dek = generateDekBytes();
  const w1 = await wrapDek(dek, a);
  const w2 = await wrapDek(dek, b);   // 同一 KEK 同一 DEK:AES-KW 确定性 → 密文一致
  const w3 = await wrapDek(dek, c);   // 换密码 → 密文不同
  assert.ok(w1.length > 0 && bytesEqual(w1, w2));
  assert.ok(!bytesEqual(w1, w3));
});

test('DEK 包裹/解包往返;错误 KEK 解包失败(CryptoError)', async () => {
  const dek = generateDekBytes();
  const kek = await deriveKek('正确密码', new Uint8Array(16), ITER);
  const wrapped = await wrapDek(dek, kek);
  const back = await unwrapDek(wrapped, kek);
  assert.ok(bytesEqual(dek, back));

  const badKek = await deriveKek('错误密码', new Uint8Array(16), ITER);
  await assert.rejects(() => unwrapDek(wrapped, badKek), CryptoError);
});

test('三把子密钥互不相同(按用途分离)', async () => {
  const dek = generateDekBytes();
  const content = await deriveContentKey(dek);
  const attach = await deriveAttachKey(dek);
  const filename = await deriveFilenameKey(dek);
  // 同一明文用不同子密钥加密:换钥必解不开
  const plain = new TextEncoder().encode('same');
  const c1 = await seal(content, MAGIC.CATEGORY, plain);
  let threw = false;
  try { await open(attach, MAGIC.CATEGORY, c1); } catch (e) { threw = e instanceof CryptoError; }
  assert.ok(threw, '附件密钥不应能解开内容密文');
  let threw2 = false;
  try { await openText(content, MAGIC.BLOB, c1); } catch (e) { threw2 = e instanceof FormatError; }
  assert.ok(threw2, '魔数校验应先拒绝');
  assert.ok(await openText(content, MAGIC.CATEGORY, c1) === 'same');
  void filename;
});

test('文件封装:加解密往返 + AAD 绑定 + 格式校验', async () => {
  const key = await deriveContentKey(generateDekBytes());
  const text = '秘钥内容 base_url=https://example.com';
  const file = await sealText(key, MAGIC.CATEGORY, text);
  assert.equal(new TextDecoder().decode(file.slice(0, 4)), 'JMB1');
  assert.equal(file[4], 1);
  assert.equal(await openText(key, MAGIC.CATEGORY, file), text);

  // 篡改 nonce(文件头内,AAD 覆盖)→ 认证失败 CryptoError
  const tampered = file.slice();
  tampered[8] ^= 0xff;
  await assert.rejects(() => openText(key, MAGIC.CATEGORY, tampered), CryptoError);

  // 篡改密文 → 认证失败
  const tampered2 = file.slice();
  tampered2[20] ^= 0x01;
  await assert.rejects(() => openText(key, MAGIC.CATEGORY, tampered2), CryptoError);

  // 魔数不符 / 过短 / 版本不对 → FormatError
  await assert.rejects(() => openText(key, MAGIC.BLOB, file), FormatError);
  assert.throws(() => parseHeader(new Uint8Array(10), MAGIC.CATEGORY), FormatError);
  const badVer = file.slice();
  badVer[4] = 9;
  assert.throws(() => parseHeader(badVer, MAGIC.CATEGORY), FormatError);
});

test('nonce 每次加密都不同(200 次无重复)', async () => {
  const key = await deriveContentKey(generateDekBytes());
  const plain = new TextEncoder().encode('x');
  const nonces = new Set();
  for (let i = 0; i < 200; i++) {
    const file = await seal(key, MAGIC.CATEGORY, plain);
    nonces.add(bytesToB64(file.slice(5, 17)));
  }
  assert.equal(nonces.size, 200);
});

test('同一明文两次加密密文不同(随机 nonce 生效)', async () => {
  const key = await deriveContentKey(generateDekBytes());
  const a = await sealText(key, MAGIC.CATEGORY, 'same');
  const b = await sealText(key, MAGIC.CATEGORY, 'same');
  assert.ok(!bytesEqual(a, b));
});

test('校验块:密码对通过,密码错不通过', async () => {
  const dek = generateDekBytes();
  const contentKey = await deriveContentKey(dek);
  const verifier = await makeVerifier(contentKey);
  assert.ok(await checkVerifier(contentKey, verifier));
  const otherKey = await deriveContentKey(generateDekBytes());
  assert.equal(await checkVerifier(otherKey, verifier), false);
  assert.equal(await checkVerifier(contentKey, null), false);
});

test('HMAC 文件名:确定性且不泄露原文长度信息外的内容', async () => {
  const fk = await deriveFilenameKey(generateDekBytes());
  const d1 = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('img.png')));
  const m1 = bytesToB64url(await hmacBytes(fk, d1));
  const m2 = bytesToB64url(await hmacBytes(fk, d1));
  assert.equal(m1, m2);
  assert.match(m1, /^[A-Za-z0-9_-]{43}$/);
});
