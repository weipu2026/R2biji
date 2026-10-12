/* ============================================================
 * 启动 / 解锁链路的库信息(vault.json)获取 —— 2026-10-12 办公电脑真机反馈的护栏
 *
 * 现场:早上在办公电脑打开站点,输主密码点「解锁」,屏幕提示
 *   「vault.json 已损坏,请从备份恢复」,随后又正常进入了应用。
 *
 * 根因(boot → doUnlock 两步,复盘见 AUDIT-2026-10-12.md):
 *   ① boot 首次 /api/vault 拉取失败(启动探测超时 10s,办公网首包 TLS 握手/代理
 *      常常超过)→ 失败分支把解锁表单放出来给用户重试,但 store.vaultJson 仍是 null;
 *   ② 用户点「解锁」→ unlockVault(null) → reason='corrupt' → 屏幕上出现
 *      「vault.json 已损坏,请从备份恢复」—— 库里什么都没坏,药方完全错误;
 *   ③ 网络恢复后重载/重试成功 → 「立马又进入了」。
 *
 * 这份用例钉住:点「解锁」= 用户的「重试」意图 → 先补拉库信息,再按真实结果说话;
 * 而「已损坏,请从备份恢复」只允许在**真的拿到了一份结构不合法的库信息**时出现。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDom } from './dom-stub.mjs';
import { Store } from '../public/js/store.js';
import { ApiError } from '../public/js/api.js';
import * as V from '../public/js/vaultlib.js';
import { boot, loadVaultInfo } from '../public/js/features/shell.js';
import { doUnlock, doCreateLibrary, showLock } from '../public/js/features/lock.js';

/** 结构上「像」一份库信息 —— 用于不需要真解密、只关心走哪条分支的用例 */
const VAULT_OBJ = { magic: 'JMBIJI-vault', version: 1, kdf: { salt: 's' }, wrap: {}, verifier: {} };
const netErr = (msg = '无法连接服务器:The operation was aborted due to timeout') => new ApiError(msg, 0, 'network');

/** api 替身。fetchScript 逐次出牌:'ok' | '404' | 'access-key' | Error 实例 */
function makeApi(fetchScript = ['ok']) {
  const calls = { fetchVault: 0, savedKeys: [], setToken: 0 };
  return {
    calls,
    api: {
      loadAccessKey: () => null,
      saveAccessKey: (k) => calls.savedKeys.push(k),
      setToken: () => { calls.setToken += 1; },
      fetchVault: async () => {
        const step = fetchScript[Math.min(calls.fetchVault, fetchScript.length - 1)];
        calls.fetchVault += 1;
        if (step instanceof Error) throw step;
        if (step === 'access-key') throw new ApiError('需要访问密钥', 401, 'access-key');
        if (step === '404') return { status: 404 };
        return { status: 200, json: VAULT_OBJ, etag: 'etag-1' };
      },
    },
  };
}

/** 能跑 boot / showLock / doUnlock / doCreateLibrary 的最小 ctx */
function makeCtx(store, byId, { api, modal = async () => null, reloadVault, ...over } = {}) {
  const calls = { reloadVault: 0, unlockVault: 0, lastJson: 'none', enterApp: 0, derive: 0, savedSessions: 0 };
  const ctx = {
    store,
    dom: { byId },
    toast: () => {},
    modal,
    loadSettings: () => {},
    resetStatusPriority: () => {},
    resumeSession: async () => false,
    enterApp: async () => { calls.enterApp += 1; },
    api,
    vault: {
      /* 与真实 unlockVault 同判别:null → corrupt(「已损坏」);给了对象 → 成功。
       * 真要测「结构不合法」时用例会换成 V.unlockVault。 */
      unlockVault: async (json) => {
        calls.unlockVault += 1;
        calls.lastJson = json;
        if (json) return { ok: true, dek: new Uint8Array(32), authKeyHex: 'a'.repeat(64) };
        return V.unlockVault(json, 'x');
      },
      deriveAllKeys: async () => { calls.derive += 1; return {}; },
    },
    Library: class { constructor() {} async rescan() {} destroy() {} },
    session: {
      saveSession: () => { calls.savedSessions += 1; return true; },
      loadSession: () => null,
      clearSession: () => {},
    },
    // 真实实现由 ui.js 接成 loadVaultInfo(ctx, opt);这里默认给「补拉成功」
    reloadVault: reloadVault || (async () => { calls.reloadVault += 1; store.set('vaultJson', VAULT_OBJ); return 'ok'; }),
    ...over,
  };
  ctx.showLock = (mode) => showLock(ctx, mode);
  return { ctx, calls };
}

const errText = (byId) => byId('lockErr').textContent;

test('★ boot:首包拉取失败时,错误如实可见 + 解锁表单可用(重试路径的前提)', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi([netErr()]);
    const { ctx } = makeCtx(store, byId, { api });

    await boot(ctx);

    assert.match(errText(byId), /无法连接服务器/, '必须把网络原因如实说给用户');
    assert.equal(byId('lockErr').hidden, false, '错误必须可见');
    assert.equal(byId('lockForm').hidden, false, '解锁表单必须放出来(否则用户没有任何重试入口)');
    assert.equal(byId('lockLoading').hidden, true, '探测态必须收起,否则表单与转圈同时挂着');
    assert.equal(store.get('lockMode'), 'unlock',
      '★ 屏幕长得像解锁页,lockMode 就必须是 unlock —— 留在 loading 会让状态与所见不一致');
    assert.equal(store.get('vaultJson'), null, '前提:这次没拿到库信息');
  });
});

test('★★ boot 首包失败后点「解锁」:先补拉库信息,且绝不说「已损坏,请从备份恢复」', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi([netErr()]);
    const { ctx, calls } = makeCtx(store, byId, { api });
    await boot(ctx);

    await doUnlock(ctx, '正确的主密码');

    assert.equal(calls.reloadVault, 1, '★ 点「解锁」就是用户的重试意图 —— 必须先补拉一次库信息');
    assert.equal(calls.unlockVault, 1, '补拉成功后应继续解锁(不该把用户挡在门外)');
    assert.deepEqual(calls.lastJson, VAULT_OBJ, '★ unlockVault 必须拿到真实库信息,而不是 null');
    assert.doesNotMatch(errText(byId), /已损坏/,
      '★ 库里什么都没坏:绝不能提示「vault.json 已损坏,请从备份恢复」(2026-10-12 真机反馈)');
    assert.equal(calls.enterApp, 1, '应当进入应用');
  });
});

test('★ 补拉仍然失败:如实说是连接问题,不调 unlockVault、绝不说「已损坏」', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi([netErr()]);
    const { ctx, calls } = makeCtx(store, byId, {
      api,
      reloadVault: async () => { calls.reloadVault += 1; throw netErr(); },
    });
    await boot(ctx);

    await doUnlock(ctx, '正确的主密码');

    assert.equal(calls.reloadVault, 1);
    assert.equal(calls.unlockVault, 0, '没拿到库信息就不该去解(解了必然报 corrupt)');
    assert.match(errText(byId), /还没能获取到库信息/, '要说清是「没取到」,并带上底层原因');
    assert.match(errText(byId), /无法连接服务器/);
    assert.doesNotMatch(errText(byId), /已损坏/,
      '★ 不得诱导用户去翻备份 —— 这是他真正会照做的一句话');
  });
});

test('补拉拿到 404(服务器上确实没有库):切建库态并说明两条出路', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi([netErr()]);
    const { ctx, calls } = makeCtx(store, byId, {
      api,
      reloadVault: async () => { calls.reloadVault += 1; store.set('vaultJson', null); return 'missing'; },
    });
    await boot(ctx);

    await doUnlock(ctx, 'pw');

    assert.equal(store.get('lockMode'), 'setup', '没有库就该进建库流程');
    assert.equal(calls.unlockVault, 0);
    assert.match(errText(byId), /没有找到笔记库/, '要说清「服务器上没有这个库」');
    assert.match(errText(byId), /备份/, '并指出出路:创建新库或用备份恢复');
  });
});

test('★ 真·库信息结构不合法时,「已损坏,请从备份恢复」仍然要出现(这条分支不能一起被修没)', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    store.set('vaultJson', { magic: '这不是本应用的库', version: 1 });
    const { api } = makeApi();
    const { ctx, calls } = makeCtx(store, byId, { api });
    ctx.vault.unlockVault = (json, pw) => { calls.unlockVault += 1; return V.unlockVault(json, pw); };

    await doUnlock(ctx, 'pw');

    assert.equal(calls.reloadVault, 0, '已有库信息就不该再补拉(白花一次请求)');
    assert.equal(errText(byId), 'vault.json 已损坏,请从备份恢复',
      '结构真的不合法时,这个提示才是正确的');
  });
});

test('已有库信息时不补拉(用户没点重试,不为每次解锁多付一次请求)', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    store.set('vaultJson', VAULT_OBJ);
    const { api } = makeApi();
    const { ctx, calls } = makeCtx(store, byId, { api });

    await doUnlock(ctx, 'pw');

    assert.equal(calls.reloadVault, 0);
    assert.equal(calls.unlockVault, 1);
    assert.equal(calls.enterApp, 1);
  });
});

test('boot 正常路径:库信息与 etag 落进会话态;未开「记住本设备」时停在解锁页', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    store.get('settings').rememberDevice = false;
    const { api } = makeApi(['ok']);
    const { ctx } = makeCtx(store, byId, { api });

    await boot(ctx);

    assert.deepEqual(store.get('vaultJson'), VAULT_OBJ, '必须用 set 落进 store(挂实例属性 = 后续读不到)');
    assert.equal(store.get('vaultEtag'), 'etag-1');
    assert.equal(store.get('lockMode'), 'unlock');
  });
});

test('boot 拿到 404:进建库态,并清掉上一次可能残留的库信息', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    store.set('vaultJson', { stale: true });
    store.set('vaultEtag', 'old-etag');
    const { api } = makeApi(['404']);
    const { ctx } = makeCtx(store, byId, { api });

    await boot(ctx);

    assert.equal(store.get('lockMode'), 'setup');
    assert.equal(store.get('vaultJson'), null, '★ 残留的旧库信息必须清掉,否则会拿它去解新库');
    assert.equal(store.get('vaultEtag'), null);
  });
});

test('★ 访问密钥门:boot 弹窗收下密钥后自动重试,不需要用户刷新页面', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    store.get('settings').rememberDevice = false;
    const { api, calls } = makeApi(['access-key', 'ok']);
    let asked = 0;
    const { ctx } = makeCtx(store, byId, {
      api,
      modal: async (o) => { asked += 1; assert.equal(o.title, '访问密钥'); return '  office-key-123456  '; },
    });

    await boot(ctx);

    assert.equal(asked, 1, 'access-key 错误必须弹输入框,而不是把 401 直接甩给用户');
    assert.equal(calls.savedKeys.length, 1, '输入的密钥要存到本机(下次不再问)');
    assert.equal(calls.savedKeys[0], 'office-key-123456', '存之前要去掉首尾空白');
    assert.equal(calls.fetchVault, 2, '存下密钥后必须自动重试一次');
    assert.equal(store.get('lockMode'), 'unlock', '重试成功后进解锁页');
  });
});

test('★ 用户取消访问密钥输入:如实提示且仍给出可重试的表单', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi(['access-key']);
    const { ctx } = makeCtx(store, byId, { api, modal: async () => null });

    await boot(ctx);

    assert.match(errText(byId), /未提供访问密钥/);
    assert.equal(byId('lockErr').hidden, false);
    assert.equal(byId('lockForm').hidden, false, '表单必须在,否则用户只能刷新页面');
  });
});

test('★★ 建库撞 409:必须真的把服务器上那份库信息拉下来(旧写法只是把 vaultJson 置 null)', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi(['ok']);
    const { ctx, calls } = makeCtx(store, byId, { api });
    ctx.vault.createVault = async () => ({ json: VAULT_OBJ, dek: new Uint8Array(32), authKeyHex: 'a'.repeat(64) });
    ctx.api.createVaultJson = async () => ({ status: 409, etag: null });

    await doCreateLibrary(ctx, 'Abcdef1234!xyz', 'Abcdef1234!xyz');

    assert.equal(calls.reloadVault, 1,
      '★ 服务器上已有库 → 要把那一份拉下来;不拉的话用户接着点解锁必然看到「已损坏」');
    assert.equal(store.get('lockMode'), 'unlock', '必须切到解锁态(含按钮文案/输入框复位)');
    assert.match(errText(byId), /已存在笔记库/);
    assert.equal(byId('pwConfirmField').hidden, true, '解锁态不该再有确认密码框');
    assert.doesNotMatch(errText(byId), /已损坏/);
  });
});

test('建库撞 409 且库信息没取回:如实说是「没连上」,不留成 null 让用户白试', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    const { api } = makeApi(['ok']);
    const { ctx, calls } = makeCtx(store, byId, {
      api,
      reloadVault: async () => { calls.reloadVault += 1; throw netErr(); },
    });
    ctx.vault.createVault = async () => ({ json: VAULT_OBJ, dek: new Uint8Array(32), authKeyHex: 'a'.repeat(64) });
    ctx.api.createVaultJson = async () => ({ status: 409, etag: null });

    await doCreateLibrary(ctx, 'Abcdef1234!xyz', 'Abcdef1234!xyz');

    assert.equal(calls.reloadVault, 1);
    assert.match(errText(byId), /已存在笔记库/);
    assert.match(errText(byId), /没能取回/, '要区分「库不存在」与「库存在但没连上」');
    assert.doesNotMatch(errText(byId), /已损坏/);
  });
});

test('loadVaultInfo:404 返回 missing 并清空会话态;成功返回 ok(契约本身)', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    store.set('vaultJson', { stale: 1 });
    const { api } = makeApi(['404']);
    const { ctx } = makeCtx(store, byId, { api });

    assert.equal(await loadVaultInfo(ctx), 'missing');
    assert.equal(store.get('vaultJson'), null);

    const { api: api2 } = makeApi(['ok']);
    const ctx2 = makeCtx(store, byId, { api: api2 }).ctx;
    assert.equal(await loadVaultInfo(ctx2), 'ok');
    assert.deepEqual(store.get('vaultJson'), VAULT_OBJ);
  });
});

test('loadVaultInfo:用户主动补拉时把更宽松的超时透传给 fetchVault', async () => {
  await withDom(async (_c, byId) => {
    const store = new Store();
    let seenOpt = null;
    const { ctx } = makeCtx(store, byId, {
      api: {
        loadAccessKey: () => null, saveAccessKey: () => {}, setToken: () => {},
        fetchVault: async (opt) => { seenOpt = opt; return { status: 200, json: VAULT_OBJ, etag: 'e' }; },
      },
    });

    await loadVaultInfo(ctx, { timeoutMs: 20_000 });

    assert.deepEqual(seenOpt, { timeoutMs: 20_000 },
      '★ 用户点过按钮 = 他愿意多等:补拉必须能用比启动探测更长的超时');
  });
});
