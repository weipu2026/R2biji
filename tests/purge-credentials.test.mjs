/* ============================================================
 * 清除本机凭据(purgeLocalCredentials)—— 2026-11-03
 *
 * 用户的威胁模型:主密码是常用密码,可能被盗/被猜到;ACCESS_KEY 是只有他知道
 * 的高熵门。设备淘汰时清掉本机凭据,让下次登录必须**同时**输两样。
 *
 * 这里钉住的不是「函数被调过」,而是**三样都真的清了、顺序对、失败要说**:
 *   ① 访问密钥(localStorage['jmbiji.accessKey'])
 *   ② 记住的会话(裸 DEK,localStorage['jmbiji.session'])
 *   ③ Cache Storage(SW 缓存的 vault.json 与分类密文)
 * 少清任何一样,都还留着一条「断网也能进」的路 —— 详细论证见
 * public/js/features/shell.js 的 purgeLocalCredentials 注释。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { purgeLocalCredentials } from '../public/js/features/shell.js';

/** 造一个只会记账的 ctx;seq 记录调用顺序与参数,deleted 记录被删掉的缓存键。 */
function makeCtx({ confirm = true, cacheThrows = false, lockThrows = false } = {}) {
  const seq = [];
  const deleted = [];
  let lastToast = null;
  globalThis.caches = {
    keys: async () => {
      if (cacheThrows) throw new Error('cache boom');
      return ['jmbiji-v19', 'jmbiji-v20'];
    },
    delete: async (k) => { deleted.push(k); seq.push('cacheDelete:' + k); return true; },
  };
  const ctx = {
    modal: async (o) => { seq.push(`modal:${o.type}`); return confirm; },
    saveAll: async () => { seq.push('saveAll'); },
    api: { saveAccessKey: (k) => { seq.push(`accessKey:${JSON.stringify(k)}`); } },
    session: { clearSession: () => { seq.push('clearSession'); } },
    lockNow: async (opt) => {
      seq.push(`lockNow:${JSON.stringify(opt)}`);
      if (lockThrows) throw new Error('lock boom');
      return 0;
    },
    toast: (msg, kind) => { seq.push(`toast:${kind || 'info'}`); lastToast = { msg, kind: kind || 'info' }; },
  };
  return { ctx, seq, deleted, toast: () => lastToast };
}

test('★ 清除本机凭据:三样一起清(访问密钥 / 裸 DEK / 离线缓存),然后锁定', async () => {
  const { ctx, seq, deleted, toast } = makeCtx();
  const r = await purgeLocalCredentials(ctx);

  assert.equal(r.cancelled, undefined, '确认后不应返回 cancelled');
  /* ① 访问密钥:必须显式传空串(saveAccessKey('') 才走 removeItem 分支) */
  assert.ok(seq.includes('accessKey:""'),
    '必须清掉访问密钥(localStorage[\'jmbiji.accessKey\']),否则联网门对这台机器形同不存在');
  /* ② 记住的会话(裸 DEK):不清就能离线免密直进 */
  assert.ok(seq.includes('clearSession'),
    '必须清掉记住的会话(裸 DEK),否则断网也能免密进入');
  /* ③ SW 缓存:不清就留着 vault.json 与分类密文 */
  assert.deepEqual(deleted.sort(), ['jmbiji-v19', 'jmbiji-v20'],
    '必须删掉全部 Cache Storage 条目,否则离线仍有密文可解');
  /* 清完必须锁:否则明文还在内存与 DOM 里,清了等于没清 */
  assert.ok(seq.some((s) => s.startsWith('lockNow:') && s.includes('"confirmDiscard":false')),
    '清完必须立刻锁定(且不再弹第二个确认框)');

  assert.equal(r.cachesCleared, true, '缓存清成功时应如实返回 true');
  assert.equal(r.dropped, 0, '没有未保存改动时 dropped 应为 0');
  assert.match(toast().msg, /需重新输入访问密钥与主密码/,
    '成功提示必须讲清下次要输两样 —— 否则用户不知道刚才那一下意味着什么');
});

test('清除本机凭据:先存后清(在途改动不能被直接丢弃)', async () => {
  const { ctx, seq } = makeCtx();
  await purgeLocalCredentials(ctx);
  const iSave = seq.indexOf('saveAll');
  const iKey = seq.indexOf('accessKey:""');
  const iLock = seq.findIndex((s) => s.startsWith('lockNow:'));
  const iCache = seq.findIndex((s) => s.startsWith('cacheDelete:'));
  assert.ok(iSave >= 0 && iKey >= 0 && iLock >= 0 && iCache >= 0, '四个关键动作都应发生');
  assert.ok(iSave < iKey && iKey < iLock && iLock < iCache,
    '顺序必须是 保存 → 清凭据 → 锁定 → 清缓存(先清再存会让保存直接 401;先清缓存再锁定会被 SW 写回密文)');
});

/* ★ 2026-11-03 复审抓到的竞态,单独成钉:lockNow 在有未保存改动时会再跑一轮
 * saveAll,saveCategory 缺 etag 时发 GET /api/cat/<分类>(OFFLINE_API_GET 白名单),
 * SW 网络优先分支会把响应写回缓存(sw.js) —— 先清缓存再锁定 = 刚清完又被密文
 * 填回来,「离线可解密」复活。 */
test('★ 清缓存必须发生在 lockNow 之后(锁内保存的白名单 GET 会被 SW 写回缓存)', async () => {
  const { ctx, seq } = makeCtx();
  await purgeLocalCredentials(ctx);
  const iLock = seq.findIndex((s) => s.startsWith('lockNow:'));
  const iCache = seq.findIndex((s) => s.startsWith('cacheDelete:'));
  assert.ok(iLock >= 0 && iCache >= 0, '锁定与清缓存都应发生');
  assert.ok(iCache > iLock,
    '清缓存在 lockNow 之前 = SW 把锁内 saveCategory 的 GET 响应重新写回缓存,本机重新留下可离线解密的密文');
});

test('清除本机凭据:确认框点取消 → 一样都不清,也不锁', async () => {
  const { ctx, seq, deleted } = makeCtx({ confirm: false });
  const r = await purgeLocalCredentials(ctx);
  assert.equal(r.cancelled, true, '取消时必须明确回报 cancelled');
  assert.deepEqual(seq, ['modal:confirm'],
    '取消后除了弹框本身,不应发生任何副作用(尤其不能清凭据或锁定)');
  assert.deepEqual(deleted, [], '取消后不应删任何缓存');
});

test('清除本机凭据:缓存清不掉也要退出登录,并明确说缓存没清', async () => {
  const { ctx, seq, toast } = makeCtx({ cacheThrows: true });
  const r = await purgeLocalCredentials(ctx);
  assert.equal(r.cachesCleared, false, '缓存清理抛错时应如实返回 false');
  assert.ok(seq.some((s) => s.startsWith('lockNow:')),
    '缓存清不掉不代表不锁 —— 访问密钥与会话已经清了,必须继续退出');
  assert.equal(toast().kind, 'warn',
    '缓存没清干净必须用 warn 说出来,不能静默当成「全清了」');
  assert.match(toast().msg, /离线缓存/,
    '提示要指明是离线缓存没清,并给出「清站点数据」的出路');
});

test('清除本机凭据:锁定失败不吞错,报 error 让用户手动锁', async () => {
  const { ctx, toast } = makeCtx({ lockThrows: true });
  const r = await purgeLocalCredentials(ctx); // 不抛 = 符合「不抛异常」的契约
  assert.equal(r.cachesCleared, true, '锁定失败不影响缓存清理的结果');
  assert.equal(toast().kind, 'error',
    '锁定失败时明文仍在屏幕上,必须 error 级提示');
  assert.match(toast().msg, /请手动锁定/,
    '必须明确让人手动锁定 —— 这是唯一能补救的动作');
});
