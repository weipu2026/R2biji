/* ============================================================
 * 保存流水线护栏(2026-10-06 审计 P1)
 * ------------------------------------------------------------
 * 全部用**真实 ui.js 的单例 store + 真实 ctx + 真实 features/lock.js lockNow**
 * (ui.js 的 saveAll 走模块级单例 store,另起一个 Store 实例标脏是标不到它的 ——
 *  2026-10-06 写第一版时踩了这个坑,断言全绿但什么都没测到)。
 *
 * 覆盖的不变量:
 *   1. saveAll 是单例:保存进行中时再调,拿到的是**同一个** promise(不是 undefined)
 *   2. ★ lockNow 必须等到在途保存真的结束才销毁会话 —— 此前它 await 的是
 *      「立即返回的 undefined」,在途保存被 lib.destroy() 打断,未保存改动静默丢失
 *   3. skipped 且分类已被别端删除 → 必须提示(而不是静默丢改动)
 *   4. 保存失败:必须保留脏标记并提示(不吞改动)
 *   5. 会话中途 401(他端改过主密码)→ 提示一次「登录已失效」
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { store as appStore } from '../public/js/store.js';
import { ctx, saveAll } from '../public/js/ui.js';
import { lockNow } from '../public/js/features/lock.js';
import { withDom } from './dom-stub.mjs';
import { ApiError } from '../public/js/api.js';

/** 可控的 lib 替身:saveCategory 的完成时机由用例控制(模拟慢网络) */
function mkLib({ notes, delayMs = 0, fail = null, status = null } = {}) {
  const seq = [];
  return {
    seq,
    categories: new Map(Object.entries(notes || {}).map(([k, v]) => [k, { data: { notes: v } }])),
    categoryInfo(name) { return this.categories.get(name) || null; },
    listCategories() { return [...this.categories.keys()]; },
    sortedCategories() { return [...this.categories.keys()]; },
    catCount: () => 0,
    catPin: () => false,
    async saveCategory(name) {
      seq.push(`save-start:${name}`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) {
        seq.push(`save-fail:${name}`);
        const e = fail instanceof Error ? fail : new Error(String(fail));
        if (status) e.status = status;
        throw e;
      }
      seq.push(`save-end:${name}`);
      return { ok: true };
    },
    destroy() { seq.push('destroy'); this.destroyed = true; },
    setCatCounts: async () => true,
    vaultJson: null,
    vaultEtag: null,
  };
}

/** 读真实 toast DOM(#toasts 的子节点):ui.js 的 toast() 是模块私有函数,
 *  覆盖 ctx.toast 拦不到(saveAll 内部直接调模块级 toast)。 */
function readToasts() {
  const box = document.getElementById('toasts');
  return (box.children || []).map((c) => ({
    msg: c.textContent,
    kind: String(c.className || '').replace(/^toast toast-/, ''),
  }));
}

/** 把单例 store 摆成「已解锁 + 有这个 lib」的现场 */
function setup(lib) {
  appStore.set('lib', lib);
  appStore.get('dirty').clear();
  appStore.get('dirtyGen').clear();
  appStore.set('saving', false);
  appStore.set('savePromise', null);
  appStore.set('resavePending', false);
  return { toasts: readToasts() };
}

test('★ saveAll 是单例:保存进行中再调,拿到同一个 promise(锁定流程据此等待)', async () => {
  const lib = mkLib({ notes: { 甲: [{ id: 'n1' }] }, delayMs: 1500 });
  await withDom(async () => {
    const s = setup(lib);
    {
      appStore.markDirty('甲');
      const p1 = saveAll();
      assert.ok(p1 instanceof Promise, 'saveAll 必须返回 promise,否则 await 等于没等');
      const p2 = saveAll(); // 保存进行中(旧实现:置 flag 后 return undefined)
      assert.ok(p2 instanceof Promise, '★ 保存进行中再调也必须返回 promise,不能是 undefined');
      await p1;
      assert.deepEqual(lib.seq.slice(0, 2), ['save-start:甲', 'save-end:甲']);
      /* 第二次调用置了 resavePending → 主循环结束会排 300ms 补跑。把这一轮等完:
         既验证补跑会发生(且不吞改动),也避免它落在 withDom 之外(那时 document 已撤)。 */
      await new Promise((r) => setTimeout(r, 3200)); // 保存 1500 + 补跑 300 + 防抖 800 + 余量
      assert.equal(lib.seq.filter((x) => x === 'save-end:甲').length, 1, 'dirty 已空时补跑是空转,不得重复上传');
      assert.equal(document.getElementById('saveStatus').textContent, '已保存',
        '★ resavePending 分支必须刷状态栏,否则永久卡在「保存中…」');
      assert.equal(appStore.get('saving'), false, '结束后 saving 必须复位');
      assert.equal(appStore.get('savePromise'), null, '结束后 savePromise 必须清空');
    }
  });
});

test('★ lockNow 必须等在途保存结束才销毁会话(否则未保存改动静默丢失)', async () => {
  const lib = mkLib({ notes: { 甲: [{ id: 'n1' }] }, delayMs: 30 });
  await withDom(async () => {
    const s = setup(lib);
    {
      appStore.markDirty('甲');
      const inflight = saveAll(); // 保存已在途(用户此时点了「锁定」)
      await lockNow(ctx, { broadcast: false, confirmDiscard: false });
      await inflight;
      assert.ok(lib.seq.includes('save-end:甲'), '在途保存必须跑完');
      assert.equal(lib.seq.indexOf('save-end:甲') < lib.seq.indexOf('destroy'), true,
        `destroy 必须排在保存完成之后,实得顺序:${lib.seq.join(' → ')}`);
    }
  });
});

test('★ 分类已被别端删除(skipped)→ 必须提示,不能静默丢改动', async () => {
  const lib = mkLib({ notes: {} }); // lib 里查不到「乙」= 已被别端删掉
  lib.saveCategory = async () => ({ skipped: true });
  await withDom(async () => {
    const s = setup(lib);
    {
      appStore.markDirty('乙');
      await saveAll();
      assert.ok(readToasts().some((t) => t.kind === 'warn' && /乙.*删除/.test(t.msg)),
        `必须有一条 warn 提示说明改动被丢弃,实得:${JSON.stringify(readToasts())}`);
    }
  });
});

test('保存失败:必须保留脏标记并提示(不吞改动)', async () => {
  const lib = mkLib({ notes: { 甲: [{ id: 'n1' }] }, fail: new Error('boom') });
  await withDom(async () => {
    const s = setup(lib);
    {
      appStore.markDirty('甲');
      await saveAll();
      assert.ok(appStore.get('dirty').has('甲'), '失败的分类必须仍在待保存队列里');
      assert.ok(readToasts().some((t) => t.kind === 'error'), '必须有错误提示');
    }
  });
});

test('★ 会话中途 401(他端改过主密码)→ 提示一次「登录已失效」', async () => {
  // 用真实的 ApiError(生产上 api.js 抛的就是它;saveAll 的判定是 instanceof)
  const lib = mkLib({ notes: { 甲: [{ id: 'n1' }] }, fail: new ApiError('鉴权失败(令牌缺失或不正确)', 401, 'unauthorized') });
  await withDom(async () => {
    const s = setup(lib);
    {
      appStore.markDirty('甲');
      await saveAll();
      const authLost = readToasts().filter((t) => /登录状态已失效/.test(t.msg));
      assert.equal(authLost.length, 1, `必须提示一次「登录已失效」,实得:${JSON.stringify(readToasts())}`);
      // 第二次失败不得重复提示(否则会盖住用户该做的事)
      appStore.markDirty('甲');
      await saveAll();
      assert.equal(readToasts().filter((t) => /登录状态已失效/.test(t.msg)).length, 1, '同一次会话只提示一次');
    }
  });
});

test('★ 锁屏必须关掉共用 <dialog>(它浮在 top layer,会盖在锁屏上方泄内容)', async () => {
  const lib = mkLib({ notes: {} });
  await withDom(async () => {
    setup(lib);
    // 造一个「开着的弹窗」:内容里放一个敏感标记,模拟回收站/密码生成器等
    const modal = document.getElementById('modal');
    modal.open = true;
    const body = document.getElementById('modalBody');
    const leak = document.createElement('div');
    leak.textContent = '机密:sk-should-not-be-visible-when-locked';
    body.appendChild(leak);

    await lockNow({ ...ctx, store: appStore, api: ctx.api, session: ctx.session }, { broadcast: false, confirmDiscard: false });

    assert.equal(modal.open, false, '★ 锁屏时共用 dialog 必须被关掉(否则 top layer 浮在锁屏上方)');
    assert.equal(document.body?.textContent?.includes?.('sk-should-not-be-visible') ?? false, false);
  });
});
