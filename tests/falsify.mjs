#!/usr/bin/env node
/* ============================================================
 * 鉴伪(变异测试):逐条破坏本次安全加固的守卫,确认对应用例确实变红,
 * 然后还原。全绿的测试套件本身不说明任何事 —— 只有「能按需变红」才有判别力。
 *
 *   node tests/falsify.mjs          全部变异体
 *   node tests/falsify.mjs 限流     只跑标签里含「限流」的
 *
 * 退出码 0 = 所有该红的都红了;1 = 存在无效守卫(用例是摆设)。
 * 每个变异体跑完必定还原原文件(即使中途断言抛错)。
 * ============================================================ */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** @type {Array<{label:string, file:string, from:string, to:string, expect?:string}>} */
const MUTANTS = [
  {
    label: '限流状态退回「挂在 env 上」(每请求清零)',
    file: 'worker/worker.js',
    from: 'export async function handleApi(method, url, headers, body, env) {\n  const u = new URL(url);',
    to: 'export async function handleApi(method, url, headers, body, env) {\n  authFails.clear(); // MUTANT:模拟按请求丢弃状态\n  const u = new URL(url);',
    expect: '每请求一个新 env',
  },
  {
    label: '访问密钥门退回「未设置=不启用」',
    file: 'worker/worker.js',
    from: "if (!k) return { open: false, reason: 'unset' };",
    to: "if (!k) return { open: true }; // MUTANT",
    expect: '未配置 → 503',
  },
  {
    label: '访问密钥过短不再拒绝',
    file: 'worker/worker.js',
    from: 'if (k.length < MIN_ACCESS_KEY_LEN) return { open: false, reason: \'weak\' };',
    to: "if (false && k.length < MIN_ACCESS_KEY_LEN) return { open: false, reason: 'weak' }; // MUTANT",
    expect: '过短(<16 字符)',
  },
  {
    label: '列表退回单页(不翻游标)',
    file: 'worker/worker.js',
    from: 'for (let page = 0; page < MAX_LIST_PAGES; page++) {',
    to: 'for (let page = 0; page < 1; page++) { // MUTANT',
    expect: '列表翻页',
  },
  {
    label: '密钥门的「无凭据不计数」判据失效',
    file: 'worker/worker.js',
    from: "recordAuthFail(ip, !!headers['x-access-key']); // 只对「带着密钥来试」计数",
    to: 'recordAuthFail(ip, true); // MUTANT',
    expect: '不带任何凭据的探测不计数',
  },
  {
    label: '令牌门的「无凭据不计数」判据失效',
    file: 'worker/worker.js',
    from: "recordAuthFail(ip, !!headers.authorization); // 只对「带着令牌来试」计数",
    to: 'recordAuthFail(ip, true); // MUTANT',
    expect: '不带任何凭据的探测不计数',
  },
  {
    label: '429 不再带 retry-after',
    file: 'worker/worker.js',
    from: "const RATE_HEADERS = { 'retry-after': String(Math.ceil(AUTH_BLOCK_MS / 1000)) };",
    to: 'const RATE_HEADERS = {}; // MUTANT',
    expect: '每请求一个新 env',
  },
  {
    label: 'OPTIONS 不再显式处理(退化成路由不匹配)',
    file: 'worker/worker.js',
    from: "if (method === 'OPTIONS') return fail(405, 'method', '不支持的请求方法');",
    to: "if (method === 'OPTIONSX') return fail(405, 'method', '不支持的请求方法'); // MUTANT",
    expect: 'OPTIONS 一律 405',
  },
  {
    label: 'API 响应丢掉硬化头',
    file: 'worker/worker.js',
    from: "  'x-content-type-options': 'nosniff',\n  'referrer-policy': 'no-referrer',",
    to: "  // MUTANT:硬化头被删\n",
    expect: '硬化头',
  },
  {
    label: '适配层不再预检声明长度',
    file: 'worker/worker.js',
    from: '  const n = Number(contentLength || 0);\n  return Number.isFinite(n) && n > MAX_REQUEST_BYTES;',
    to: '  const n = Number(contentLength || 0);\n  return false && n > MAX_REQUEST_BYTES; // MUTANT',
    expect: '适配层预检',
  },
  {
    label: '备份轮换退回按 base/ts 重拼文件名(丢掉随机后缀)',
    file: 'public/js/format.js',
    from: 'return backups.slice(keep).map((b) => b.name);',
    to: 'return backups.slice(keep).map((b) => `${b.base}.${b.ts}${ENCRYPTED_EXT}`); // MUTANT',
    expect: '同一毫秒写入的多份',
  },
  {
    label: '备份不再加随机后缀(同毫秒会互相覆盖)',
    file: 'worker/worker.js',
    from: 'backupFileName(backupBase, Date.now(), shortRand())',
    to: 'backupFileName(backupBase, Date.now()) /* MUTANT */',
    // 用「备份名必须带随机后缀」这条确定性断言来判别;
    // 「备份保留 10 份」那条在变异体下是否失败取决于是否跨毫秒,不可靠。
    expect: '且旧版进备份',
  },
  {
    label: '密码强度不再拦截弱密码',
    file: 'public/js/format.js',
    from: "  if (len < PASSWORD_MIN_LEN) {",
    to: "  if (false && len < PASSWORD_MIN_LEN) { // MUTANT",
    expect: '拒绝过短',
  },
  {
    label: '解锁不再标记 weakKdf',
    file: 'public/js/vaultlib.js',
    from: 'weakKdf: !(Number(json.kdf.iterations) >= PBKDF2_ITERATIONS_MIN)',
    to: 'weakKdf: false /* MUTANT */',
    expect: 'weakKdf 提示',
  },
  {
    label: '迭代次数不再设上限(被篡改的 vault.json 可冻死标签页)',
    file: 'public/js/crypto.js',
    from: '  return Math.min(Math.max(1, Math.floor(iterations)), PBKDF2_ITERATIONS_MAX);',
    to: '  return Math.floor(iterations); // MUTANT',
    expect: '迭代次数收口',
  },
  {
    label: '建库落盘值与实际派生值脱钩',
    file: 'public/js/vaultlib.js',
    from: 'kdf: { name: \'PBKDF2\', hash: \'SHA-256\', iterations: iters, salt: bytesToB64(salt) },',
    to: "kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 12345, salt: bytesToB64(salt) }, // MUTANT",
    expect: '非法迭代次数回落默认值',
  },
  /* ---- 孤儿清理的 fail-closed 守卫(tests/e2e.test.mjs)----
   * blobs 没有备份层,误删一张图 = 永久丢失,所以这两条尤其不能是摆设。 */
  {
    label: '孤儿清理退回 fail-open(读不出来的分类直接跳过)',
    file: 'public/js/lib.js',
    from: '    if (unreadable.size) {',
    to: '    if (false) { // MUTANT:读不出来的分类直接跳过(fail-open)',
    expect: '分类读不出来时必须整次中止',
  },
  {
    label: '孤儿清理不再先刷新分类清单(别的设备新建的图片会被误删)',
    file: 'public/js/lib.js',
    from: '    await this.rescan(); // ① 清单必须是新的:本机那份可能已经落后于别的设备',
    to: '    // MUTANT:不再刷新清单',
    expect: '必须先刷新分类清单',
  },
  /* ---- 「记住本设备」的落盘边界(tests/session.test.mjs)----
   * 这是唯一把密钥写进浏览器存储的地方,读侧不校验 = 脏数据会被拿去解密。 */
  {
    label: '本机会话不再校验 DEK 长度(脏数据被当成有效会话)',
    file: 'public/js/session.js',
    from: '    if (dek.length !== DEK_BYTES) return null;',
    to: '    if (false && dek.length !== DEK_BYTES) return null; // MUTANT',
    expect: '读到脏数据一律当作',
  },
  {
    label: '本机会话不再校验写入参数(非法密钥也照存)',
    file: 'public/js/session.js',
    from: '    if (!(dek instanceof Uint8Array) || dek.length !== DEK_BYTES) return false;\n    if (!AUTH_HEX_RE.test(String(authKeyHex || \'\'))) return false;',
    to: '    // MUTANT:入参校验被删\n',
    expect: '拒收非法入参',
  },
  /* ---- 弹窗的「按钮 → 返回值」契约(tests/dialog.test.mjs)----
   * 还原那个真实发生过的 bug:mkBtn 无条件自动 resolve,prompt 的「确定」先落地 null。 */
  {
    label: '弹窗按钮退回「无条件自动 resolve」(prompt 确定返回 null)',
    file: 'public/js/ui.js',
    from: '      if (val !== undefined) b.addEventListener(\'click\', () => { dlg.close(); settle(val); });',
    to: '      b.addEventListener(\'click\', () => { dlg.close(); resolve(val); }); // MUTANT',
    expect: '点「确定」必须返回输入框里的值',
  },
  /* ---- 静态资源清单(tests/assets.test.mjs)---- */
  {
    label: 'SW 清单漏登记一个模块(离线会白屏,联网时看不出来)',
    file: 'public/sw.js',
    from: "  './js/session.js',\n",
    to: '',
    expect: 'public/js 下的每个模块都必须登记',
  },
  /* ---- 多标签页同步 + 全库备份 ---- */
  {
    label: '标签页同步退回「不管本地有没有未保存改动都刷新」',
    file: 'public/js/tabsync.js',
    from: "  return isDirty ? 'warn-dirty' : 'reload';",
    to: "  return 'reload'; // MUTANT",
    expect: '本地有未保存改动 → 只警告,不刷新',
  },
  {
    label: '恢复备份时不再核对「是不是同一个库」',
    file: 'public/js/lib.js',
    from: '      if (!sameDek) {',
    to: '      if (false && !sameDek) { // MUTANT',
    expect: '目标是另一个库时必须拒绝',
  },
  {
    label: '恢复备份时改成覆盖已存在的分类(而非仅新建)',
    file: 'public/js/lib.js',
    from: '        const res = await API.putCat(name, e.bytes, { createOnly: true });',
    to: '        const res = await API.putCat(name, e.bytes, { createOnly: false }); // MUTANT',
    expect: '恢复时已存在的分类一律跳过',
  },
  {
    label: '附件清单不再回真实体积(导出前的体积提示会说谎)',
    file: 'worker/worker.js',
    from: '    const blobs = objects.map((o) => ({\n      name: o.key.slice(BLOB_PREFIX.length),\n      size: o.size,',
    to: '    const blobs = objects.map((o) => ({\n      name: o.key.slice(BLOB_PREFIX.length),\n      size: 0, // MUTANT',
    expect: '附件清单:names 与带体积的 blobs 必须一致且 size 真实',
  },
  {
    label: 'ZIP 读侧不再校验 CRC(坏包会被当成好数据)',
    file: 'public/js/zip.js',
    from: '    if (crc32(data) !== crc) throw new ZipError(`条目「${name}」校验失败(内容损坏或被改过)`);',
    to: '    // MUTANT:不再校验 CRC',
    expect: '读到损坏的内容必须报错',
  },
  /* ---- 部署链路守卫(tests/deploy.test.mjs)---- */
  {
    label: 'gen-config 的最短密钥长度与 Worker 改歪',
    file: 'scripts/gen-config.mjs',
    from: 'const MIN_ACCESS_KEY_LEN = 16;',
    to: 'const MIN_ACCESS_KEY_LEN = 12; // MUTANT',
    expect: '两端常量一致',
  },
  {
    label: '模板的 gen:routes 锚点被删(注入会静默失效)',
    file: 'wrangler.toml',
    from: '# gen:routes',
    to: '# (锚点被删)',
    expect: '模板锚点',
  },
  {
    label: '工作流混入 pull_request_target(公开仓库的密钥外泄通道)',
    file: '.github/workflows/deploy.yml',
    from: '  workflow_dispatch:',
    to: '  pull_request_target:\n  workflow_dispatch:',
    expect: '工作流触发器',
  },
  {
    label: '密钥被内联进 run 脚本正文(不再经 env 传递)',
    file: '.github/workflows/deploy.yml',
    from: '          ACCESS_KEY: ${{ secrets.ACCESS_KEY }}\n        run: |\n          set -euo pipefail\n          # 与部署读同一份配置',
    to: '          X: dummy\n        run: |\n          ACCESS_KEY="${{ secrets.ACCESS_KEY }}"\n          set -euo pipefail\n          # 与部署读同一份配置',
    expect: '密钥只经 env 传递',
  },
  {
    label: '验收步骤被掏空(不再带着访问密钥去请求)',
    file: '.github/workflows/deploy.yml',
    from: '          no_key=$(code "$URL/api/vault")\n          yes_key=$(code -H "x-access-key: $ACCESS_KEY" "$URL/api/vault")',
    to: '          no_key=$(code "$URL/")\n          yes_key=$(code "$URL/")  # MUTANT:不再带密钥去请求',
    expect: '上线验收',
  },
  {
    label: '去掉赋值管道的 || true 兜底(set -e 下会中止步骤)',
    file: '.github/workflows/deploy.yml',
    from: "| tr -d ' ' || true)",
    to: "| tr -d ' ')",
    expect: '赋值管道必须有兜底',
  },
  /* ---- 侧栏交互契约(tests/sidebar-guard.test.mjs)---- */
  {
    label: '点分类不再自动打开顶端笔记(退回「再点一次才能读」)',
    file: 'public/js/features/sidebar.js',
    from: 'const openId = notes.some((n) => n.id === prevId) ? prevId : (notes[0]?.id ?? null);',
    to: 'const openId = null; // MUTANT:退回旧行为,选分类不选笔记',
    expect: '点分类自动打开列表最顶端那篇',
  },
  /* ---- 阅读视图契约(tests/note-view.test.mjs)---- */
  {
    label: '换笔记不归零阅读面(会停在上一篇的中段)',
    file: 'public/js/features/note.js',
    from: 'if (lastReadNoteId !== note.id) {',
    to: 'if (false) { // MUTANT:从不归零,也不记录当前篇',
    expect: '换笔记:阅读面滚回顶部',
  },
  /* ---- 分类手动调序(format.js 纯函数 + sidebar 三按钮)---- */
  {
    label: '分类上移/下移不再拦住「跨置顶分区」(点了像没反应)',
    file: 'public/js/format.js',
    from: "  if ((metaOf(ordered[j])?.pin === true) !== (metaOf(name)?.pin === true)) return null;",
    to: '  // MUTANT:去掉「不跨置顶分区」判断',
    expect: '不跨置顶分区',
  },
  {
    label: '分类排序丢掉「置顶优先」(置顶项会掉回名称序)',
    file: 'public/js/format.js',
    from: '    (pinOf(b) - pinOf(a)) || (ordOf(a) - ordOf(b)) || a.localeCompare(b));',
    to: '    (ordOf(a) - ordOf(b)) || a.localeCompare(b)); // MUTANT:丢掉置顶主键',
    expect: '置顶优先',
  },
  {
    label: '分类行的上移/下移/重命名按钮被摘掉(只剩置顶)',
    file: 'public/js/features/sidebar.js',
    from: '    btns.append(upBtn, downBtn, pinBtn, renameBtn);   // 顺序与笔记列一致',
    to: '    btns.append(pinBtn); // MUTANT:只剩置顶',
    expect: '分类行有 上移/下移/置顶/重命名 四个按钮',
  },
  /* ---- 2026-09-28 全站再审计(P1×3 + 本轮引入的 P2×6)的守卫 ---- */
  {
    label: '阅读站敏感行点击退回「直接判 e.target 类名」(值点不出来)',
    file: 'public/recover.html',
    from: '    var el = e.target && e.target.closest ? e.target.closest(".secret") : null;',
    to: '    var el = e.target && e.target.classList && e.target.classList.contains("secret") ? e.target : null; // MUTANT',
    expect: '阅读站敏感行点击',
  },
  {
    label: '连续两次 modal:close 监听不再看「弹窗是否真的关掉」',
    file: 'public/js/ui.js',
    from: '    const onClose = () => { if (dlg.open) return; settle(null); };',
    to: '    const onClose = () => settle(null); // MUTANT',
    expect: '连续两次 modal',
  },
  {
    label: '跨标签页同步只重扫分类清单,不重拉 vault 元信息(顺序/置顶永远陈旧)',
    file: 'public/js/ui.js',
    from: '    await Promise.all([S.lib.rescan(), S.lib.refreshVaultMeta()]);',
    to: '    await S.lib.rescan(); // MUTANT:不重拉 vault 元信息',
    expect: '收到 cats-changed',
  },
  {
    label: 'clickable 的键盘处理不再判事件源(行内按钮的按键被整行抢走)',
    file: 'public/js/features/sidebar.js',
    from: '    if (e.target !== el) return;',
    to: '    // MUTANT:不判事件源',
    expect: 'clickable:行内按钮上的 Enter/空格',
  },
  {
    label: '分类调序成功后不再广播(别的标签页顺序视图不动)',
    file: 'public/js/features/sidebar.js',
    from: "    if (moved) ctx.store.get('tabs')?.send({ type: 'cats-changed' });",
    to: '    // MUTANT:不广播',
    expect: '分类上移/下移:成功后必须广播',
  },
  {
    label: '分类调序冲突(412)时不再重绘(界面停在过期顺序上)',
    file: 'public/js/features/sidebar.js',
    from: '        renderCategoryList(ctx);',
    to: '        if (moved) renderCategoryList(ctx); // MUTANT',
    expect: '分类上移/下移:成功后必须广播',
  },
  {
    label: '置顶后不再广播(别的标签页置顶视图不动)',
    file: 'public/js/features/sidebar.js',
    from: "        ctx.store.get('tabs')?.send({ type: 'cats-changed' }); // 别的标签页的置顶视图跟着失效",
    to: '        // MUTANT:不广播置顶变更',
    expect: '置顶成功必须广播',
  },
  {
    label: '删分类只清 pin/count、留下 order 残渣(同名重建插回原位)',
    file: 'public/js/lib.js',
    from: '      try { await this.setCatMeta(name, { pin: null, count: null, order: null }); } catch { /* 忽略 */ }',
    to: '      try { await this.setCatMeta(name, { pin: null, count: null }); } catch { /* 忽略 */ } // MUTANT',
    expect: '删分类必须连 order 一起清',
  },
  {
    label: 'refreshVaultMeta 变空操作(vaultJson 不更新)',
    file: 'public/js/lib.js',
    from: '  async refreshVaultMeta() {',
    to: '  async refreshVaultMeta() { return false; // MUTANT',
    expect: 'refreshVaultMeta:跨标签页',
  },
  {
    label: '分类调序 412 时在新基线上重放相对位移(一次点击移两格)',
    file: 'public/js/lib.js',
    from: '        if (fresh.status === 200) { this.vaultJson = fresh.json; this.vaultEtag = fresh.etag; }\n        return false;',
    to: '        if (fresh.status === 200) { this.vaultJson = fresh.json; this.vaultEtag = fresh.etag; }\n        return this.moveCat(name, dir); // MUTANT:重放',
    expect: '分类调序冲突',
  },
  {
    label: '释放会话时不再交还 Library 手里最新的 vault.json(改密码后原地解锁被锁在门外)',
    file: 'public/js/features/lock.js',
    from: '    if (lib.vaultJson) store.set(\'vaultJson\', lib.vaultJson);',
    to: '    // MUTANT:不交还 vault.json',
    expect: '交还给会话态',
  },

  /* ---- 2026-09-29 全站再审计:P2-7 / P2-8 / P2-9 + P3 全部 ---- */
  {
    label: 'vault PUT 退回「head 后无条件 put」(窗口期相互覆盖别人的写)',
    file: 'worker/worker.js',
    from: 'const res = await env.VAULT.put(VAULT_KEY, raw, { onlyIf: { etagMatches: normEtag(cur.etag) } });',
    to: 'const res = await env.VAULT.put(VAULT_KEY, raw); // MUTANT:无条件写',
    expect: 'vault 写:head→put 之间被插空必须 412',
  },
  {
    label: '瞬时错误退回「一律写进 cat.error」(一次网络抖动永久锁死分类)',
    file: 'public/js/lib.js',
    from: '      if (e instanceof C.FormatError || e instanceof C.CryptoError || e instanceof LibraryError) {\n        cat.error = e.message;\n      } else {\n        cat.transient = e.message;\n      }',
    to: '      cat.error = e.message; // MUTANT:不分级',
    expect: 'P2-7:一次网络抖动不得把分类永久标成',
  },
  {
    label: '覆盖未生效时不再落回「待保存」(用户以为已覆盖,改动静默脱离保存流程)',
    file: 'public/js/ui.js',
    from: '      if (r?.ok) {',
    to: '      if (true) { // MUTANT:失败也当成功',
    expect: 'P2-9:覆盖未生效',
  },
  {
    label: '弹窗不再把标题关联为可访问名(读屏器只念「对话框」)',
    file: 'public/js/ui.js',
    from: "    dlg.setAttribute('aria-labelledby', 'modalTitle');",
    to: '    // MUTANT:不关联标题',
    expect: 'P3:弹窗必须把标题关联为可访问名',
  },
  {
    label: '401 退回「丢掉服务端消息」(用户看不到到底哪里不对)',
    file: 'public/js/api.js',
    from: "    throw new ApiError(message || '鉴权失败(令牌缺失或不正确)', 401, code || 'bad-token');",
    to: "    throw new ApiError('鉴权失败', 401, 'bad-token'); // MUTANT",
    expect: 'P3:401 必须带上服务端消息与 bad-token 码',
  },
  {
    label: '分类名清洗集退回「只去尖括号」(引号与 & 会带进服务端被拒)',
    file: 'public/js/format.js',
    from: "    .replace(ILLEGAL_CHARS, '')",
    to: "    .replace(/[<>]/g, '') // MUTANT",
    expect: 'P3:清洗后的分类名不得残留',
  },
  {
    label: '敏感行不再进 Tab 序(键盘用户永远够不到自己的密码)',
    file: 'public/js/render.js',
    from: "      span.setAttribute('tabindex', '0');",
    to: '      // MUTANT:不进 Tab 序',
    expect: 'P3:敏感行必须可聚焦并能向读屏器表达状态',
  },
  {
    label: 'SW 清单漏掉应急恢复页(离线救灾会落到主应用外壳)',
    file: 'public/sw.js',
    from: "  './recover.html',\n",
    to: '',
    expect: 'P3:ASSETS 必须含应急恢复页',
  },
  {
    label: '离线导航兜底退回「一律回主应用外壳」',
    file: 'public/sw.js',
    from: "    if (p.endsWith('/recover.html')) return './recover.html';",
    to: '    // MUTANT:不再按路径区分',
    expect: 'P3:离线导航兜底必须按路径给页面',
  },
  {
    label: '暗色主题退回裸 .toast 规则(把 error/warn 配色一起压死)',
    file: 'public/css/style.css',
    from: ':root[data-theme="dark"] .toast:not(.toast-error):not(.toast-warn) { background: rgba(236, 233, 225, .9); color: #1e2128; }',
    to: ':root[data-theme="dark"] .toast { background: rgba(236, 233, 225, .9); } /* MUTANT */',
    expect: 'P3:暗色主题不得用裸 .toast 规则压死',
  },
  {
    label: '笔记列的图钉槽位外距不再补偿 padding-right 的差(两列图钉错位)',
    file: 'public/css/style.css',
    from: '.note-item .pin-slot { margin-right: 36px; }',
    to: '.note-item .pin-slot { margin-right: 30px; } /* MUTANT */',
    expect: 'P3:两列图钉必须落在同一条竖线上',
  },
  {
    label: '笔记整表重建后不再还焦点(键盘按一次就掉焦点)',
    file: 'public/js/features/sidebar.js',
    from: "  if (!notes.length) {\n    const li = document.createElement('li');\n    li.className = 'note-item none';\n    li.textContent = '暂无笔记';\n    ul.appendChild(li);\n  }\n  restoreFocusKey(ul, keepFocus);",
    to: "  if (!notes.length) {\n    const li = document.createElement('li');\n    li.className = 'note-item none';\n    li.textContent = '暂无笔记';\n    ul.appendChild(li);\n  }\n  // MUTANT:不还焦点",
    expect: 'renderNoteList:整表重建后焦点必须回到同一个 focusKey',
  },
  {
    label: '分类整表重建后不再还焦点(只修了笔记列)',
    file: 'public/js/features/sidebar.js',
    from: "  if (!names.length) {\n    const li = document.createElement('li');\n    li.className = 'cat-item none';\n    li.textContent = '暂无分类,点上方 + 新建';\n    ul.appendChild(li);\n  }\n  restoreFocusKey(ul, keepFocus);",
    to: "  if (!names.length) {\n    const li = document.createElement('li');\n    li.className = 'cat-item none';\n    li.textContent = '暂无分类,点上方 + 新建';\n    ul.appendChild(li);\n  }\n  // MUTANT:不还焦点",
    expect: 'renderCategoryList:整表重建后焦点也必须还回原按钮',
  },

  /* ---------- 手机端阅读:标题竖排 + 上下滑动翻篇(2026-09-29 真机反馈) ---------- */
  {
    label: '阅读标题丢回 word-break:break-all(每个字符都成换行点 → 一字一行)',
    file: 'public/css/style.css',
    from: '  overflow-wrap: anywhere;    /* 禁用 break-all:它会制造「逐字一行」的断点 */',
    to: '  word-break: break-all; /* MUTANT */',
    expect: '禁用 word-break:break-all',
  },
  {
    label: '阅读标题去掉宽度下限(flex 自动最小尺寸对中文只剩一个汉字宽)',
    file: 'public/css/style.css',
    from: '  min-width: min(100%, 11em); /* 宽度下限:约 11 个汉字,低于此值宁可整行换行 */\n',
    to: '  /* MUTANT:去掉宽度下限 */\n',
    expect: '必须有宽度下限',
  },
  {
    label: '阅读标题区不再允许换行(标题被挤在操作按钮旁边)',
    file: 'public/css/style.css',
    from: '  gap: 16px; flex-wrap: wrap;',
    to: '  gap: 16px;',
    expect: '必须允许整行换下去',
  },
  {
    label: '窄屏不再纵向堆叠标题与操作区(只靠宽度下限硬撑)',
    file: 'public/css/style.css',
    from: '  .read-head { flex-direction: column; align-items: stretch; gap: 10px; }',
    to: '  /* MUTANT:窄屏不堆叠 */',
    expect: '手机端阅读标题纵向堆叠',
  },
  {
    label: '正文段落改用 break-all(为长 URL 图省事,却把「逐字一行」那类风险放开)',
    file: 'public/css/style.css',
    from: '.read-body p { margin: 10px 0; word-break: break-word; white-space: pre-wrap; }',
    to: '.read-body p { margin: 10px 0; word-break: break-all; white-space: pre-wrap; } /* MUTANT */',
    expect: 'break-all 只有已知安全的一处',
  },
  {
    label: '滑动翻篇不看边界(中段上划也被当成翻篇,长笔记读不下去)',
    file: 'public/js/features/note.js',
    from: '  if (dy < 0) return atBottom ? 1 : 0;   // 上划(手指向上):已到底 → 下一篇\n  return atTop ? -1 : 0;                 // 下划(手指向下):已到顶 → 上一篇',
    to: '  if (dy < 0) return 1; // MUTANT:不看边界\n  return atTop ? -1 : 0;',
    expect: '中段起手的上划只是正常阅读滚动',
  },
  {
    label: '滑动翻篇方向反转(上划去了上一篇)',
    file: 'public/js/features/note.js',
    from: '  if (dy < 0) return atBottom ? 1 : 0;   // 上划(手指向上):已到底 → 下一篇',
    to: '  if (dy < 0) return atBottom ? -1 : 0; // MUTANT:方向反转',
    expect: '方向不得反',
  },
  {
    label: '滑动翻篇不判纵横比(斜着划也被当成翻篇)',
    file: 'public/js/features/note.js',
    from: '  if (Math.abs(dx) > Math.abs(dy)) return 0;',
    to: '  if (false) return 0; // MUTANT:不判纵横比',
    expect: '横向位移更大时不算',
  },
  {
    label: '滑动翻篇不绑 touchcancel(被打断的手势仍会翻篇)',
    file: 'public/js/features/note.js',
    from: "  view.addEventListener('touchcancel', () => { start = null; }, { passive: true });",
    to: '  // MUTANT:不绑 touchcancel',
    expect: 'touchcancel 之后这次手势作废',
  },
  {
    label: '滑动判定算出来了却不真翻篇(接线断了)',
    file: 'public/js/features/note.js',
    from: '    if (delta) ctx.moveNoteSelection(delta);',
    to: '    // MUTANT:不翻篇',
    expect: '接线:底部上划 → 翻下一篇',
  },
  {
    label: '滑动翻篇不区分选字手势(用户在选字,笔记却被翻走)',
    file: 'public/js/features/note.js',
    // 2026-09-29 代码加了 selectionchange 直判(selChanged),纯 Node 单测拿不到 document,
    // 靠快照判据兜底 —— 变异体只破坏快照判据、保留 selChanged,单测才有判别力。
    from: '    const nowSel = selectionLength();\n    if (selChanged || (nowSel > 0 && nowSel !== from.selLen)) return;',
    to: '    // MUTANT:不比对选区变化',
    expect: '划动过程中选出文字',
  },
  {
    label: '只要有选区就一律不翻篇(残留选区变成永久挡板)',
    file: 'public/js/features/note.js',
    from: 'if (selChanged || (nowSel > 0 && nowSel !== from.selLen)) return;',
    to: 'if (selChanged || nowSel > 0) return;',
    expect: '页面残留着上一次的选区',
  },
  {
    label: '进应用不判空库(一个分类都没有也去打开一个不存在的分类)',
    file: 'public/js/ui.js',
    from: '  if (!names.length) return null;',
    to: '  // MUTANT:不判空库',
    expect: '一个分类都没有',
  },
  {
    label: '进应用忽略阅读位置记忆(每次都从头打开第一个分类)',
    file: 'public/js/ui.js',
    from: '  if (last && names.includes(last.cat)) return last.cat;',
    to: '  // MUTANT:忽略记忆',
    expect: '记忆里的分类还在',
  },
  {
    label: '进应用不校验记忆里的分类是否还在(去打开一个已删除的分类)',
    file: 'public/js/ui.js',
    from: '  if (last && names.includes(last.cat)) return last.cat;',
    to: '  if (last && last.cat) return last.cat;',
    expect: '记忆里的分类已被删',
  },
  {
    label: '复位状态也写进阅读位置记忆(把用户的位置抹掉)',
    file: 'public/js/ui.js',
    from: '  if (!cat || !noteId) return;',
    to: '  // MUTANT:复位也写',
    expect: '复位态',
  },
  {
    label: '算出了该回到哪一篇却不落地(activeNoteId 不摆进去)',
    file: 'public/js/ui.js',
    from: "  ctx.store.set('activeNoteId', last && last.cat === cat ? last.noteId : null);",
    to: "  ctx.store.set('activeNoteId', null);",
    expect: '回到上次读的那一篇',
  },
  {
    label: '进应用:载入失败也回报「已打开」(兜底分支永不触发,阅读区永远停在「正在载入…」)',
    file: 'public/js/ui.js',
    from: "  return ctx.store.get('activeCat') !== null;",
    to: '  return true;',
    expect: '如实返回「没打开」',
  },
  {
    label: '进应用:兜底不再区分「载入失败」与「一个分类都没有」',
    file: 'public/js/ui.js',
    from: "    if (names.length) {\n      showEmpty('内容没能载入",
    to: "    if (false) {\n      showEmpty('内容没能载入",
    expect: '落「可重试」的兜底',
  },
  {
    label: '滑动翻篇:忽略 selectionchange 直接信号,只看抬起瞬间的选区快照',
    file: 'public/js/features/note.js',
    from: '    if (selChanged || (nowSel > 0 && nowSel !== from.selLen)) return;',
    to: '    if (nowSel > 0 && nowSel !== from.selLen) return;',
    expect: 'selectionchange 变过',
  },
  {
    label: '滑动翻篇:不注册 selectionchange 监听(直接信号整条失效)',
    file: 'public/js/features/note.js',
    from: "    doc.addEventListener('selectionchange', () => { if (start) selChanged = true; });",
    to: '    // MUTANT:不注册',
    expect: 'selectionchange 变过',
  },
  {
    label: '滑动翻篇:新手势不复位「选过字」标记(选完字就再也划不动)',
    file: 'public/js/features/note.js',
    from: '    start = null;\n    selChanged = false;',
    to: '    start = null;',
    expect: '新手势必须清掉',
  },
  /* ---- 2026-09-29:分类改名 / 跨分类移动的新守卫 ---- */
  {
    label: '分类改名:未选分类时退回静默 return(用户又会以为「没有这个功能」)',
    file: 'public/js/features/sidebar.js',
    from: "    ctx.toast('先选择一个要改名的分类', 'warn');\n    return;",
    to: '    return; // MUTANT:点了毫无反馈',
    expect: '没选分类时必须给出提示',
  },
  {
    label: '分类行的重命名按钮改「当前选中」那个分类(点乙却把甲改了)',
    file: 'public/js/features/sidebar.js',
    from: "    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameCategoryByName(ctx, name); });",
    to: "    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameCategoryByName(ctx, S.get('activeCat')); }); // MUTANT",
    expect: '改的是它所在那一行',
  },
  {
    label: '分类改名:不迁移本机的阅读位置记录(下次进应用位置丢失)',
    file: 'public/js/features/sidebar.js',
    from: '    ctx.renameLastReadCat?.(name, created);',
    to: '    // MUTANT:不迁移阅读位置',
    expect: 'renameCategoryByName:改',
  },
  {
    label: '跨分类移动:改成「先删源、再写目标」(中途中断就是笔记丢失)',
    file: 'public/js/features/note.js',
    from: '    const res = await lib.appendNoteToCategory(toName, moved);',
    to: '    const i0 = src.data.notes.findIndex((n) => n.id === noteId);\n'
      + '    if (i0 >= 0) src.data.notes.splice(i0, 1); // MUTANT:先把源删了\n'
      + '    ctx.markDirty(fromName);\n'
      + '    const res = await lib.appendNoteToCategory(toName, moved);',
    expect: '目标写失败(冲突)',
  },
  {
    label: '跨分类移动:去掉忙态守卫(网络往返期间重复点击会造出两份副本)',
    file: 'public/js/features/note.js',
    from: "  if (movingNote) return false;\n  const fromName = S.get('activeCat');",
    to: "  const fromName = S.get('activeCat'); // MUTANT:去掉忙态守卫",
    expect: '并发第二次调用被忙态守卫挡住',
  },
  {
    label: '跨分类移动:目标追加失败后不回滚内存(界面多出一篇云端并不存在的笔记)',
    file: 'public/js/lib.js',
    from: '      const added = dst.data.notes[before];\n      dst.data.notes.length = before;',
    // 变异:把长度回滚那行换成空操作(块体其余语句保留,语法仍合法)
    to: '      const added = dst.data.notes[before];\n      void added; // MUTANT:不回滚长度',
    expect: '源一动不动且内存回滚',
  },
  {
    label: '追加失败时先截断再读(「截掉多出来的 snap 引用」变成永不执行的死分支)',
    file: 'public/js/lib.js',
    from: '      const added = dst.data.notes[before];\n      dst.data.notes.length = before;',
    to: '      dst.data.notes.length = before; // MUTANT:先截断再读\n      const added = dst.data.notes[before];',
    expect: '失败时必须回滚内存与快照引用',
  },
  {
    label: 'vault 元信息写入不再比对内容(没变化也照写 —— 白烧一次条件写与请求数)',
    file: 'public/js/lib.js',
    from: '      if (after === before) return false;',
    to: '      if (false && after === before) return false; // MUTANT:不再比对内容',
    expect: '没变化时不写云端',
  },
  {
    label: '笔记行的「移动到其他分类」按钮被摘掉(功能又变成找不到)',
    file: 'public/js/features/sidebar.js',
    from: '    btns.append(upBtn, downBtn, pinBtn, moveBtn);',
    to: '    btns.append(upBtn, downBtn, pinBtn); // MUTANT:摘掉移动入口',
    expect: '笔记行的操作按钮是 4 个',
  },
  {
    label: '阅读位置改名迁移时丢掉 noteId(下次进应用只回到分类顶端,不是那一篇)',
    file: 'public/js/ui.js',
    from: "      noteId: typeof v.noteId === 'string' && v.noteId ? v.noteId : null,\n    }));\n    return true;",
    to: '      noteId: null, // MUTANT\n    }));\n    return true;',
    expect: 'noteId 原样',
  },
  {
    label: '移动「正在编辑」的笔记前不收集编辑框(未提交的字随移动静默丢失)',
    file: 'public/js/features/note.js',
    from: "    if (S.get('editing') && S.get('activeNoteId') === noteId) {\n      try { ctx.collectEditChanges?.(); } catch { /* 收集不了就按内存现状移动 */ }\n    }",
    to: '    // MUTANT:不收集编辑框',
    expect: '编辑框未提交的修改收进内存',
  },
  {
    label: '编辑中删除笔记不收集编辑框(进回收站的是上次收尾的旧版,不是用户眼前这份)',
    file: 'public/js/features/note.js',
    from: "  if (S.get('editing')) { try { ctx.collectEditChanges?.(); } catch { /* 按内存现状删除 */ } }",
    to: '  // MUTANT:不收集编辑框',
    expect: '先把编辑框收进内存再入回收站',
  },
  {
    label: '切换笔记前不收集编辑框(离开编辑态的字静默丢失)',
    file: 'public/js/features/sidebar.js',
    from: "  if (S.get('editing')) { try { ctx.collectEditChanges?.(); } catch { /* 按内存现状切换 */ } }\n  S.patch({ activeNoteId: noteId, editing: false });",
    to: '  S.patch({ activeNoteId: noteId, editing: false }); // MUTANT:切换前不收集',
    expect: '切换前必须把编辑框收进内存',
  },
  {
    label: '切换分类前不收集编辑框(跨分类切走时字静默丢失)',
    file: 'public/js/features/sidebar.js',
    from: "  if (S.get('editing')) { try { ctx.collectEditChanges?.(); } catch { /* 按内存现状切换 */ } }\n  /* ★ await 之后必须**重新取 lib 并复核存活**",
    to: "  /* MUTANT:切分类前不收集 */\n  /* ★ await 之后必须**重新取 lib 并复核存活**",
    expect: '切换分类前同样先收集编辑框',
  },
  {
    label: '删分类不复位 editing 标志(留下「编辑态恒真」的脏状态)',
    file: 'public/js/features/sidebar.js',
    from: "    S.patch({ activeCat: null, activeNoteId: null, editing: false });",
    to: '    S.patch({ activeCat: null, activeNoteId: null }); // MUTANT:不复位 editing',
    expect: 'editing 必须复位',
  },

  /* ---- 2026-10-06 审计:搜索高亮 / 孤儿清理陈旧数据 / 阅读站按行遮罩 / 快照成本 ---- */
  {
    label: '搜索片段不再按节点追加(退回三次 highlightInto → 前文与高亮被整体抹掉)',
    file: 'public/js/search.js',
    from: '    if (offset > 0) snip.appendChild(document.createTextNode(result.snippet.slice(0, offset)));',
    to: '    if (false) snip.appendChild(document.createTextNode(result.snippet.slice(0, offset))); // MUTANT:前缀不写入',
    expect: '片段保留前缀',
  },
  {
    label: '孤儿清理退回用缓存明文清点(删掉别端刚传的图)',
    file: 'public/js/lib.js',
    from: '        try { await this.loadCategory(name, { force: true }); } catch { unreadable.add(name); }',
    to: '        try { await this.loadCategory(name); } catch { unreadable.add(name); } // MUTANT:用缓存明文清点',
    expect: '必须用当下明文清点',
  },
  {
    label: '阅读站遮罩只处理段内第一行(命中即吞掉其余正文)',
    file: 'public/recover.html',
    from: '  for (var i = 0; i < lines.length; i++) {',
    to: '  for (var i = 0; i < 1; i++) { // MUTANT:只处理第一行,段内其余正文被丢掉',
    // 期望串必须是**用例名**里出现的字样(falsify 匹配测试名,不匹配断言消息)
    expect: '主站 renderInline 与阅读站 rdrInline',
  },
  {
    label: '快照退回「每次保存给当前正文拍档」(首存 N 次串行上传 + 全量哈希)',
    file: 'public/js/lib.js',
    from: '    if (prev === undefined || prev === current || !prev) return false; // 首次 / 没改过 / 原为空',
    to: '    // MUTANT:不再判断是否改过',
    expect: '快照成本',
  },
  {
    label: 'saveAll 在途时退回 undefined(等待方等于没等)',
    file: 'public/js/ui.js',
    from: '  if (S.saving) { S.resavePending = true; return S.savePromise || Promise.resolve(); }',
    to: '  if (S.saving) { S.resavePending = true; return; } // MUTANT',
    expect: 'saveAll 是单例',
  },
  {
    label: '锁屏不再关共用 <dialog>(锁屏上方仍浮着弹窗内容)',
    file: 'public/js/features/lock.js',
    from: '  const dlg = $(\'modal\');',
    to: '  // MUTANT:不关弹窗',
    expect: '共用 <dialog>',
  },
  {
    label: '恢复历史时存档失败不再中止(恢复前的正文被覆盖 = 永久丢失)',
    file: 'public/js/lib.js',
    from: '      await this.snapshotNote(note, { anchor: true, strict: true });',
    to: '      await this.snapshotNote(note, { anchor: true }); // MUTANT:strict 丢失 → 失败被吞,恢复照做',
    expect: '存档失败必须中止恢复',
  },
  /* ---- 版本历史(快照)守卫 ---- */
  {
    label: 'pushSnap 窗口合并判据失效(4 秒自动保存把历史刷成中间态)',
    file: 'public/js/format.js',
    from: 'if (!anchor && head && ts - head.ts < windowMs) {                  // ②③ 窗口内',
    to: 'if (false) { // MUTANT:窗口合并判据失效',
    expect: 'pushSnap:窗口内滚动合并',
  },
  {
    label: 'pushSnap 同内容去重失效(每存一次就多一条重复历史)',
    file: 'public/js/format.js',
    from: 'if (head && head.file === entry.file) return demoted;              // ① 同内容去重',
    to: 'if (false && head && head.file === entry.file) return demoted; // MUTANT:去重失效',
    expect: '与最新版同内容',
  },
  {
    label: '恢复前的正文不再被钉成永久锚(恢复操作可能被后续保存冲掉)',
    file: 'public/js/format.js',
    from: "const demoted = (anchor && list[0]?.m) ? [{ file: list[0].file, ts: list[0].ts }, ...list.slice(1)] : list;",
    to: 'const demoted = list; // MUTANT:不降级合并槽',
    expect: 'pushSnap:anchor(恢复前)',
  },
  {
    label: '孤儿清理漏收版本快照引用(清理把历史全部误删)',
    file: 'public/js/lib.js',
    from: "for (const s of (note.snaps || [])) refs.add(s.file); // 版本历史也是活的引用,清了就回不去",
    to: '// MUTANT:快照引用不参与清点',
    expect: '全生命周期:建库',
  },
  /* ---- 2026-10-06 速度专项:静态资源缓存(头 + SW 策略) ---- */
  {
    label: 'js/css 退回 no-cache(每次访问都回源,首屏 20 次往返)',
    file: 'public/_headers',
    from: '/js/*\n  Cache-Control: public, max-age=3600, stale-while-revalidate=86400',
    to: '/js/*\n  Cache-Control: no-cache',
    expect: 'js/css 必须有非 no-cache 的 Cache-Control',
  },
  {
    label: '静态资源改用 immutable(零构建项目文件名无 hash → 部署后长期停在旧版)',
    file: 'public/_headers',
    from: '/css/*\n  Cache-Control: public, max-age=3600, stale-while-revalidate=86400',
    to: '/css/*\n  Cache-Control: public, max-age=31536000, immutable',
    expect: '不许用 immutable',
  },
  {
    label: 'SW 静态资源退回「先等网络再决定」(SWR 失效,首屏照旧每次回源)',
    file: 'public/sw.js',
    from: '      if (cached) {',
    to: '      if (false) { // MUTANT:不再用缓存优先',
    expect: 'SWR:命中缓存时',
  },
  {
    label: 'SW 导航请求也改走缓存优先(部署后界面停在旧外壳)',
    file: 'public/sw.js',
    from: "  if (e.request.mode === 'navigate') {",
    to: "  if (false) { // MUTANT:导航不再走 network-first",
    expect: '导航请求保持 network-first',
  },
  {
    label: '离线白名单放宽到全部 /api/*(附件与写请求也进缓存管道)',
    file: 'public/sw.js',
    from: "    if (OFFLINE_API_GET.test(url.pathname)) {",
    to: "    if (true) { // MUTANT:什么 API 都想缓存",
    expect: '白名单外的 /api/* 一律不经 SW',
  },
  {
    label: '离线回退被摘掉(断网时 API 不再回退本地副本)',
    file: 'public/sw.js',
    from: "          .catch(() => caches.match(e.request).then((hit) => hit || Response.error())),",
    to: "          .catch(() => Response.error()), // MUTANT:不回退本地副本",
    expect: '离线时回退上次的副本',
  },
  {
    label: '在线响应不再写入缓存副本(下次离线无货可回退)',
    file: 'public/sw.js',
    from: "            if (res && res.ok && res.type === 'basic') {\n              e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {}));\n            }\n            return res;",
    to: "            return res; // MUTANT:不写入缓存",
    expect: '在线取网络版并顺手更新本地副本',
  },
  {
    label: '焦点圈退回只覆盖按钮(列表行/附件/敏感行又摸黑)',
    file: 'public/css/style.css',
    from: `.cat-item:focus-visible, .note-item:focus-visible,
.search-item:focus-visible, .att-chip:focus-visible, .secret:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;   /* 画在内侧:相邻两行不会互相压住对方的圈 */
}`,
    to: `/* MUTANT:焦点圈只剩按钮那 6 类 */`,
    expect: '可聚焦的非按钮元素都必须有焦点圈',
  },
  {
    label: '焦点圈改用 box-shadow(吃掉列表行选中态的左侧内条)',
    file: 'public/css/style.css',
    from: `  outline: 2px solid var(--accent);
  outline-offset: -2px;   /* 画在内侧:相邻两行不会互相压住对方的圈 */
}`,
    to: `  outline: none;
  box-shadow: var(--ring);
}`,
    expect: '焦点圈不得用 box-shadow',
  },
  {
    label: '窄屏判定恒为 false(手机上不再补方位提示)',
    file: 'public/js/ui.js',
    from: `  try { return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); } catch { return false; }`,
    to: `  return false; // MUTANT:窄屏永不成立`,
    expect: '窄屏判定是纯函数',
  },
  {
    label: '列出状态退回「从左侧选择」(手机上指向不存在的位置)',
    file: 'public/js/features/sidebar.js',
    from: `    ctx.showEmpty('从左侧选择一个分类', null, 'sparkle', '点左上角的菜单按钮打开分类列表');`,
    to: `    ctx.showEmpty('从左侧选择一个分类'); // MUTANT`,
    expect: '三处指向「左侧」的空态都补了窄屏提示',
  },
  {
    label: '编辑底栏不再换行(窄屏整排溢出)',
    file: 'public/css/style.css',
    from: `  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}`,
    to: `  border-top: 1px solid var(--border);
  padding-top: 12px;
}`,
    expect: '编辑底栏可换行',
  },
  {
    label: '窄屏不再收起 PC 专属编辑提示',
    file: 'public/css/style.css',
    from: `  .edit-hint { display: none; }`,
    to: `  /* MUTANT:窄屏仍显示 Ctrl+S/Ctrl+V 提示 */`,
    expect: '编辑底栏可换行',
  },
  {
    label: '触屏图标按钮尺寸退回紧凑(手指易误触)',
    file: 'public/css/style.css',
    from: `  .icon-btn { width: 34px; height: 34px; }`,
    to: `  .icon-btn { width: 28px; height: 28px; } /* MUTANT */`,
    expect: '触屏下的图标按钮被放大',
  },
  {
    label: '滚动定位退回 center(不再用 nearest)',
    file: 'public/js/features/sidebar.js',
    from: `li.scrollIntoView({ block: 'nearest' })`,
    to: `li.scrollIntoView({ block: 'center' }) // MUTANT`,
    expect: 'scrollActiveNoteIntoView 真的把选中项滚进视野',
  },
  {
    label: 'openNote 不再滚动到选中项(新建的笔记看不见)',
    file: 'public/js/features/sidebar.js',
    from: `  renderNoteList(ctx);
  scrollActiveNoteIntoView(ctx);
  ctx.renderReadView();`,
    to: `  renderNoteList(ctx);
  ctx.renderReadView(); // MUTANT:不滚`,
    expect: 'openNote 与 openCategory 都接上了滚动',
  },
  {
    label: '图片不再绑灯箱点击',
    file: 'public/js/features/note.js',
    from: `    img.addEventListener('click', () => openLightbox(ctx, att, url));`,
    to: `    // MUTANT:不再绑灯箱`,
    expect: '图片附件可点开放大',
  },
  {
    label: 'Ctrl+Shift+L 不再要求 shiftKey(会抢 Ctrl+L)',
    file: 'public/js/features/shell.js',
    from: `(e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l'`,
    to: `(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' // MUTANT`,
    expect: 'Ctrl/⌘+Shift+L 锁定',
  },
  {
    label: '快速隐藏分支不再调用 lockNow',
    file: 'public/js/features/shell.js',
    from: `      Promise.resolve(ctx.lockNow({ confirmDiscard: false }))`,
    to: `      Promise.resolve(null) // MUTANT:锁定被摘掉`,
    expect: 'Ctrl/⌘+Shift+L 锁定',
  },
  {
    label: '老板键又被确认框拦住(有未保存改动时停在原界面 = 老板键失效)',
    file: 'public/js/features/shell.js',
    from: `ctx.lockNow({ confirmDiscard: false })`,
    to: `ctx.lockNow() /* MUTANT:落回默认 confirmDiscard:true */`,
    expect: 'confirmDiscard:false',
  },
  {
    label: '老板键锁完不再如实告知被放弃的改动(静默丢数据)',
    file: 'public/js/features/shell.js',
    from: `        .then((n) => n > 0 && ctx.toast(`,
    to: `        .then((n) => false && ctx.toast(`,
    expect: '如实告知',
  },
  {
    label: 'ui.js 的 lockNow 包装器吞掉选项(老板键的 confirmDiscard 传不进去)',
    file: 'public/js/ui.js',
    from: `  lockNow: (opt) => lockNow(ctx, opt),`,
    to: `  lockNow: () => lockNow(ctx), // MUTANT:选项被吞`,
    expect: '透传选项',
  },
  {
    label: 'lockNow 不再回传被放弃的改动数(无确认框入口无从如实提示)',
    file: 'public/js/features/lock.js',
    from: `  const dropped = S.get('dirty').size;`,
    to: `  const dropped = 0; // MUTANT:恒为 0`,
    expect: '回传被放弃',
  },
  {
    label: 'isImageName 恒真(所有附件都当图片去贴)',
    file: 'public/js/features/note.js',
    from: `  return guessMime(String(name)).startsWith('image/');`,
    to: `  return true; // MUTANT`,
    expect: 'isImageName 以 guessMime 为单一来源',
  },
  {
    label: 'guessMime 丢掉非图类型(下载得到 octet-stream)',
    file: 'public/js/features/note.js',
    from: `    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',`,
    to: `    // MUTANT:非图类型全丢`,
    expect: 'guessMime 认得常见非图类型',
  },
  {
    label: '附件入口退回只收图片',
    file: 'public/index.html',
    from: `<input id="attInput" type="file" multiple hidden>`,
    to: `<input id="attInput" type="file" accept="image/*" multiple hidden>`,
    expect: '附件入口放开类型限制',
  },

  /* ---------- 2026-10-11 审计修复(无障碍 / 并发 / 顺序 / 冗余) ---------- */
  {
    label: '.blk-copy 聚焦时不再置 opacity:1(元素连同焦点圈一起隐形)',
    file: 'public/css/style.css',
    from: `.blk-copy:focus-visible { opacity: 1; outline: 2px solid var(--accent); outline-offset: -2px; }`,
    to: `.blk-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }`,
    expect: 'A1:.blk-copy 聚焦时必须可见',
  },
  {
    label: '.blk-copy 整条焦点规则被删(反向扫描必须抓到,列举式的旧断言抓不到)',
    file: 'public/css/style.css',
    from: `
.blk-copy:focus-visible { opacity: 1; outline: 2px solid var(--accent); outline-offset: -2px; }`,
    to: ``,
    expect: 'A1(反向扫描)',
  },
  {
    label: '.edit-body 聚焦反馈退回几乎不可见的 tint(实测浅 1.06 / 暗 1.01)',
    file: 'public/css/style.css',
    from: `.edit-body:focus {
  box-shadow: inset 0 0 0 2px var(--accent);
}`,
    to: `.edit-body:focus {
  background: color-mix(in srgb, var(--hover) 55%, transparent);
  box-shadow: inset 2px 0 0 var(--accent-weak);
}`,
    expect: 'A9:.edit-body 聚焦反馈必须达标',
  },
  {
    label: '悬停/置顶底上的 .cat-count 不再提亮(掉回 4.42 / 4.21)',
    file: 'public/css/style.css',
    from: `.cat-item:hover .cat-count,
.cat-item.pinned:not(.active) .cat-count { color: var(--text); }`,
    to: ``,
    expect: 'P3:--muted 落在深底上的次要文字',
  },
  {
    label: '搜索结果摘要悬停底上不再提亮(掉回 4.42)',
    file: 'public/css/style.css',
    from: `.search-item:hover .search-item-snippet { color: var(--text); }`,
    to: ``,
    expect: 'P3:--muted 落在深底上的次要文字',
  },
  {
    label: '编辑态附件删除按钮丢掉统一焦点圈',
    file: 'public/css/style.css',
    from: `
.att-del:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }`,
    to: ``,
    expect: 'P3:编辑态附件删除按钮纳入统一焦点圈',
  },
  {
    label: '触屏笔记列图钉退回 8px(两列差 2px,图钉不在同一条竖线)',
    file: 'public/css/style.css',
    from: `  .note-item .pin-slot { margin-right: 10px; }`,
    to: `  .note-item .pin-slot { margin-right: 8px; }`,
    expect: 'P3:触屏两列图钉保留 2px 补偿',
  },
  {
    label: 'downloadAttachment 去掉并发守卫(双击重复解密 + objectURL 泄漏)',
    file: 'public/js/features/note.js',
    from: `  if (attLoading.has(att.file)) return;
  attLoading.add(att.file);
  try {
    let url = map.get(att.file);`,
    to: `  try {
    let url = map.get(att.file);`,
    expect: 'P2:downloadAttachment 必须有并发守卫',
  },
  {
    label: 'note.js 下载退回内联建锚点(不再复用 ctx.downloadUrl)',
    file: 'public/js/features/note.js',
    from: `    ctx.downloadUrl(url, att.name);`,
    to: `    const a = document.createElement('a');
    a.href = url;
    a.download = att.name;
    a.click();`,
    expect: 'P3:下载统一走 ctx.downloadUrl',
  },
  {
    label: 'isImageName 改回自带的扩展名表(同一语义又变两处实现)',
    file: 'public/js/features/note.js',
    from: `  return guessMime(String(name)).startsWith('image/');`,
    to: `  const IMAGE_EXT = new Set(['png']); // MUTANT:又另存一份
  return IMAGE_EXT.has(String(name));`,
    expect: 'B4:isImageName 以 guessMime 为单一来源',
  },
  {
    label: '远端锁定不再消费回传的 dropped(本端未保存改动被静默丢弃)',
    file: 'public/js/ui.js',
    from: `    Promise.resolve(lockNow(ctx, { broadcast: false, confirmDiscard: false }))
      .then((n) => n > 0 && toast(\`已在别处锁定 · \${n} 个分类的改动没能存上\`, 'warn'))
      .catch(() => {});`,
    to: `    lockNow(ctx, { broadcast: false, confirmDiscard: false });`,
    expect: 'P3:远端锁定也要消费回传的 dropped',
  },
  {
    label: '老板键挪回 dialog[open] 守卫之后(弹窗开着时失效)',
    file: 'public/js/features/shell.js',
    from: `    if (ctx.store.get('lockMode')) return;
    /* Ctrl/⌘ + Shift + L = 立即锁定(「老板键」)。`,
    to: `    if (ctx.store.get('lockMode')) return;
    if (document.querySelector('dialog[open]')) return;
    /* Ctrl/⌘ + Shift + L = 立即锁定(「老板键」)。`,
    expect: 'B1:老板键必须排在',
  },
  {
    label: '老板键的 promise 链丢掉 .catch(会冒泡成 unhandledrejection)',
    file: 'public/js/features/shell.js',
    from: `        .catch(() => { /* 锁定异常不该冒泡成 unhandledrejection(审计 P3) */ });
`,
    to: ``,
    expect: 'B1:Ctrl/⌘+Shift+L 锁定',
  },
  {
    label: '解锁前不再补拉库信息(首包失败后点解锁 → 拿 null 去解 → 谎报「vault.json 已损坏」)',
    file: 'public/js/features/lock.js',
    from: `  if (!S.get('vaultJson')) {`,
    to: `  if (false && !S.get('vaultJson')) { // MUTANT:不补拉`,
    expect: 'boot 首包失败后点「解锁」',
  },
  {
    label: '补拉失败时谎报「已损坏,请从备份恢复」(用户会真的去翻备份)',
    file: 'public/js/features/lock.js',
    from: '      err.textContent = `还没能获取到库信息,无法解锁:${e.message}`;',
    to: "      err.textContent = 'vault.json 已损坏,请从备份恢复'; // MUTANT",
    expect: '补拉仍然失败',
  },
  {
    label: '建库撞 409 后不再补拉库信息(旧写法:置 null 就走,用户点解锁撞「已损坏」)',
    file: 'public/js/features/lock.js',
    from: `      $('lockErr').textContent = '服务器上已存在笔记库,请直接解锁';
      $('lockErr').hidden = false;
      try {`,
    to: `      $('lockErr').textContent = '服务器上已存在笔记库,请直接解锁';
      $('lockErr').hidden = false;
      if (true) return; // MUTANT:不补拉库信息
      try {`,
    expect: '建库撞 409',
  },
  {
    label: 'boot 拉取失败后不再放出解锁表单(用户没有重试入口,只能刷新页面)',
    file: 'public/js/features/shell.js',
    from: `    ctx.showLock('unlock');
    ctx.dom.byId('lockErr').textContent = e.message;`,
    to: `    ctx.dom.byId('lockErr').textContent = e.message; // MUTANT:放出表单那步被删`,
    expect: 'boot:首包拉取失败时',
  },
  {
    label: '404 时不清除残留的旧库信息(会拿别的库的 vault.json 去解当前密码)',
    file: 'public/js/features/shell.js',
    from: `      ctx.store.set('vaultJson', null);
      ctx.store.set('vaultEtag', null);
      return 'missing';`,
    to: `      return 'missing'; // MUTANT:不清残留`,
    expect: 'boot 拿到 404',
  },
  {
    label: '补拉不透传超时(用户主动重试仍只给 10s 探测预算,慢网下白点一次)',
    file: 'public/js/features/shell.js',
    from: '      res = await ctx.api.fetchVault(opt);',
    to: '      res = await ctx.api.fetchVault(); // MUTANT:忽略调用方给的超时',
    expect: '更宽松的超时',
  },

  /* ---- 2026-10-12 全站审计(第三轮):P0×2 / P1×4 / P2×若干 ---- */

  {
    label: '把上一级 CSP 的摘除语法写成注释(线上白屏:两条策略取交集)',
    file: 'public/_headers',
    from: '  ! Content-Security-Policy',
    to: '  # MUTANT:摘除失效',
    expect: 'CSP 守卫:recover.html 必须真的摘掉',
  },
  {
    label: '外层转义器退回「原样返回」(摘要表/告警条变成可注入的 innerHTML)',
    file: 'public/recover.html',
    /* ★ 锚点必须覆盖到 `});`(2026-10-12):原锚点只到 `function (c) {` 为止,
     *   替换掉它之后,紧随其后的 `return {...}[c];` 与 `});` 失去配对,
     *   **整个脚本段变成语法错误** —— 而 recover.test.mjs 是用
     *   `import('data:text/javascript,…')` 加载该段的,语法错误会让**模块加载失败**
     *   (用例根本没注册),falsify 匹配不到 expect 用例名 → 误报成「守卫没判别力」。
     *   教训:替换后必须保证**整段语法完整**,故这里把 `});` 一并纳入锚点。 */
    from: `function escHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });`,
    to: `function escHtml(s) {
  return String(s); // MUTANT:不转义`,
    expect: '转义器实现必须真的转义',
  },
  {
    label: '外层又去调模板内的 rdrEsc(ReferenceError:结果面板整块渲染不出来)',
    file: 'public/recover.html',
    from: ': escHtml(String(iters))}',
    to: ': rdrEsc(String(iters))}',
    expect: 'READER_TEMPLATE 里的函数不得在模板外被调用',
  },
  {
    label: '拖放区退回「只有 click」(键盘用户在出事那天选不了备份包)',
    file: 'public/recover.html',
    from: '    <div id="drop" role="button" tabindex="0"',
    to: '    <div id="drop"',
    expect: 'a11y 守卫:应急页的文件选择器必须键盘可达',
  },
  {
    label: '键盘激活漏掉空格键(按空格变成滚动页面)',
    file: 'public/recover.html',
    from: "    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {",
    to: "    if (e.key === 'Enter') { // MUTANT:漏掉空格",
    expect: 'a11y 守卫:应急页的文件选择器必须键盘可达',
  },
  {
    label: '阅读站解析完不释放 DOM 里的 base64 源文本(驻留两份,手机上多占 5MB)',
    file: 'public/recover.html',
    from: "    elData.textContent = '';",
    to: '    void elData; // MUTANT:不释放',
    expect: '必须释放 DOM 里的源文本',
  },
  {
    label: '暗色主按钮字色退回硬编码 #fff(2.49:1,「确定」糊在底里)',
    file: 'public/css/style.css',
    from: ':root[data-theme="dark"] .btn.primary { color: #1e2128; }',
    to: ':root[data-theme="dark"] .btn.primary { color: #fff; }',
    expect: '主按钮文字压在强调色底上必须',
  },
  {
    label: '提示宿主的 popover 默认样式漏归零一项(会被撑成全屏不透明面板)',
    file: 'public/css/style.css',
    from: `#toasts[popover] {
  inset: auto auto calc(22px + env(safe-area-inset-bottom, 0px)) 50%;
  margin: 0;`,
    to: `#toasts[popover] {
  inset: auto auto calc(22px + env(safe-area-inset-bottom, 0px)) 50%;`,
    expect: '提示宿主挂 popover 后必须把 UA 默认样式归零',
  },
  {
    label: '提示不再进 top layer(弹窗开着时到达的提示全部被盖住)',
    file: 'public/js/ui.js',
    from: '  enterTopLayer(host);',
    to: '  void enterTopLayer; // MUTANT:不进 top layer',
    expect: '弹窗开着时提示必须进 top layer',
  },
  {
    label: '提示宿主重复 showPopover(已开时再调会抛 InvalidStateError)',
    file: 'public/js/ui.js',
    from: "    if (host.matches && host.matches(':popover-open')) return true; // 已在里面,重复调用会抛",
    to: '    // MUTANT:不查已开',
    expect: '连着来两条只 showPopover 一次',
  },
  {
    label: 'HIDE_WORKERS_DEV 静默忽略(没配域名时不再出声,用户以为入口已经关了)',
    file: 'scripts/gen-config.mjs',
    from: 'HIDE_WORKERS_DEV=1 被忽略',
    to: 'HIDE_WORKERS_DEV=1 未生效',
    expect: '必须显式告警',
  },
  {
    label: '分类 etag 只剥引号不剥 W/(该分类条件保存恒 412,表现是「点了没反应」)',
    file: 'public/js/api.js',
    from: "  return String(raw || '').replace(/\"/g, '').replace(/^W\\//i, '');",
    to: `  return String(raw || '').replace(/"/g, ''); // MUTANT:不剥 W/`,
    expect: '分类读取也必须剥掉弱验证器前缀',
  },
  {
    label: '自动锁屏退回 lockNow 默认(弹确认框等人点 = 永不锁定 + 谎报已锁)',
    file: 'public/js/features/lock.js',
    from: '    dropped = (await ctx.lockNow({ confirmDiscard: false })) || 0;',
    to: '    dropped = (await ctx.lockNow()) || 0; // MUTANT:走默认确认框',
    expect: 'autoLock 必须 confirmDiscard:false',
  },
  {
    label: '自动锁屏失败时静默(会话没释放、明文还在屏幕上,用户却什么都不知道)',
    file: 'public/js/features/lock.js',
    from: "    ctx.toast(`自动锁屏失败(${e?.message || e}),明文仍在屏幕上 —— 请手动锁定`, 'error');",
    to: '    void e; // MUTANT:静默失败',
    expect: '锁定失败必须报错',
  },
  {
    label: '孤儿清理判据退回「内存里有没有明文」(有旧明文的分类会带着过时引用面去删图)',
    file: 'public/js/lib.js',
    from: '        try { await this.loadCategory(name, { force: true }); } catch { unreadable.add(name); }',
    to: '        try { await this.loadCategory(name, { force: true }); } catch { /* MUTANT:不记名 */ }',
    expect: '本轮重拉失败的分类必须记名并整次中止',
  },
  {
    label: '列表截断判据退回「cursor 是否残留」(任何多页列表都误报被截断)',
    file: 'worker/worker.js',
    from: '  if (truncated) {',
    to: '  if (cursor) { // MUTANT:用残留游标当判据',
    expect: '正常翻页不得误报',
  },
  {
    label: '笔记摘要多截几个字符(列表 tooltip 与旧行为漂移)',
    file: 'public/js/format.js',
    from: '  if (folded.length >= n) return folded.slice(0, n);',
    to: '  if (folded.length >= n) return folded.slice(0, n + 3); // MUTANT',
    expect: 'notePreview:必须与朴素实现',
  },
  {
    label: '回收站剩余天数不再判到期(过期条目会显示「还剩 -10 天」)',
    file: 'public/js/format.js',
    from: `  return left <= 0 ? 0 : Math.ceil(left / 86400000);`,
    to: `  return Math.round(left / 86400000); // MUTANT:不管是否到期`,
    expect: 'trashDaysLeft',
  },
  {
    label: '离线文案判据放宽成真值判断(取不到 onLine 时反过来误报离线)',
    file: 'public/js/format.js',
    from: `  return online === false ? offlineText : errText;`,
    to: `  return online ? errText : offlineText; // MUTANT:undefined 也走离线分支`,
    expect: 'offlineBlobMessage',
  },
  {
    label: '任务列表判定删掉(「[ ] 」标记原样留在正文里)',
    file: 'public/js/render.js',
    from: `    const task = TASK_RE.exec(line);
    if (task) {
      flushPara();
      if (listTag !== 'ul') { flushList(); listItems = []; listTag = 'ul'; }
      listItems.push({ text: task[2], task: true, checked: task[1].toLowerCase() === 'x' });
      i += 1;
      continue;
    }

`,
    to: ``,
    expect: '任务列表渲染成只读勾选框',
  },
  {
    label: '任务勾选框不再 disabled(每条任务多一个 Tab 停靠点)',
    file: 'public/js/render.js',
    from: `          box.disabled = true;`,
    to: `          box.disabled = false; // MUTANT`,
    expect: '任务列表渲染成只读勾选框',
  },
  {
    label: '任务列表的块复制不再补 [x]/[ ] 标记(勾选状态被静默丢掉)',
    file: 'public/js/render.js',
    from: `        return (box ? (box.checked ? '[x] ' : '[ ] ') : '') + cloneWithoutStars(li).textContent;`,
    to: `        return cloneWithoutStars(li).textContent; // MUTANT:丢掉勾选状态`,
    expect: 'data-copy 补回',
  },
  {
    label: '分割线判定删掉(--- 退化成普通段落)',
    file: 'public/js/render.js',
    from: `    if (HR_RE.test(line)) {
      flushPara(); flushList();
      addBlock('hr', null, '');
      i += 1;
      continue;
    }

`,
    to: ``,
    expect: '分割线 --- / *** / ___ 渲染成',
  },
  {
    label: '阅读站的任务条目退化成普通 li(与主站语法漂移)',
    file: 'public/recover.html',
    from: `      lis.push('<li' + (it.task ? ' class="task"' : '') + '>' + box + rdrInline(it.text, true) + '</li>');`,
    to: `      lis.push('<li>' + rdrInline(it.text, true) + '</li>'); // MUTANT`,
    expect: '阅读站 rdrMd 与主站 renderMarkdown 同语法',
  },
  {
    label: '回收站条目不再显示剩余天数(算了不显示)',
    file: 'public/js/features/data.js',
    from: "        const leftText = leftDays > 0 ? `还剩 ${leftDays} 天` : '今天到期';",
    to: "        const leftText = ''; // MUTANT:算了不显示",
    expect: 'B8:回收站条目必须显示剩余保留天数',
  },
  {
    label: '密码生成器又写回内联样式(绕过 style.css 的口径)',
    file: 'public/js/features/data.js',
    from: `      out.className = 'modal-input gen-out';`,
    to: `      out.className = 'modal-input';
      out.style.fontFamily = 'var(--mono)'; // MUTANT`,
    expect: 'A7:密码生成器的静态样式',
  },
  {
    label: '附件失败退回直接报「解密失败」(离线被误报成文件损坏)',
    file: 'public/js/features/note.js',
    from: "    ctx.toast(F.offlineBlobMessage(isOffline(),\n      '离线状态:附件需要联网(正文可正常阅读)',\n      `附件解密失败:${e.message}`), 'error');",
    to: "    ctx.toast(`附件解密失败:${e.message}`, 'error'); // MUTANT:不看离线",
    expect: '离线读附件/历史',
  },
  {
    label: '添加附件失败退回不区分离线',
    file: 'public/js/features/note.js',
    from: "      ctx.toast(F.offlineBlobMessage(isOffline(),\n        '离线状态:添加附件需要联网',\n        `「${file.name}」入库失败:${e.message}`), 'error');",
    to: "      ctx.toast(`「${file.name}」入库失败:${e.message}`, 'error'); // MUTANT",
    expect: '离线读附件/历史',
  },
  {
    label: 'isOffline 恒为真(在线也报离线,把网络抖动说成离线)',
    file: 'public/js/features/note.js',
    from: `  return typeof navigator !== 'undefined' && navigator.onLine === false;`,
    to: `  return true; // MUTANT:永远算离线`,
    expect: '离线读附件/历史',
  },
  {
    label: 'SW 清单漏登记 apple-touch-icon(离线时 iOS 主屏图标 404)',
    file: 'public/sw.js',
    from: `  './apple-touch-icon.png',`,
    to: ``,
    expect: 'index.html 与 manifest 引用的每个本地文件都必须登记',
  },

  {
    label: "复制按钮把「点击那一刻的 DOM」当原值(连点卡在已复制)",
    file: "public/js/ui.js",
    from: "    if (btn.dataset.origLabel === undefined) btn.dataset.origLabel = label.textContent;",
    to: "    btn.dataset.origLabel = label.textContent; // MUTANT:每点一次都覆盖原值",
    expect: "A9:复制按钮",
  },
  {
    label: "搜索空查询不作废在途轮次(慢搜索在空输入框上自己弹面板)",
    file: "public/js/features/search.js",
    from: "  if (!q) { searchSeq++; panel.hidden = true; panel.textContent = ''; return; }",
    to: "  if (!q) { panel.hidden = true; panel.textContent = ''; return; } // MUTANT",
    expect: "空查询必须作废在途搜索轮次",
  },
  {
    label: "closeSearch 不作废在途轮次(Esc 之后面板又被弹回来)",
    file: "public/js/features/search.js",
    from: "  searchSeq++;\n  const box = ctx.dom.byId('searchBox');",
    to: "  const box = ctx.dom.byId('searchBox'); // MUTANT:不作废在途轮次",
    expect: "closeSearch(Esc / 点别处)同样要作废在途轮次",
  },
  {
    label: "点搜索结果写回裸分类名(抹掉「· N 篇」)",
    file: "public/js/features/search.js",
    from: "      panel.hidden = true;\n      ctx.dom.byId('searchBox').value = '';",
    to: "      ctx.dom.byId('activeCatName').textContent = r.cat; // MUTANT:覆盖标题\n      panel.hidden = true;\n      ctx.dom.byId('searchBox').value = '';",
    expect: "点搜索结果不得覆盖 activeCatName",
  },
  {
    label: "openCategory 失败也回传 true(调用方据此报「已载入最新版本」)",
    file: "public/js/features/sidebar.js",
    from: "    ctx.toast(`分类「${name}」无法打开:${e.message}`, 'error');\n    renderCategoryList(ctx);\n    return false;",
    to: "    ctx.toast(`分类「${name}」无法打开:${e.message}`, 'error');\n    renderCategoryList(ctx);\n    return true; // MUTANT:失败也报喜",
    expect: "openCategory 加载失败必须回传 false",
  },
  {
    label: "会话已销毁也把冲突分类塞回脏集(幻影「有未保存更改」)",
    file: "public/js/ui.js",
    from: "    if (S.lib) S.markDirty(name); // 留待稍后",
    to: "    S.markDirty(name); // MUTANT:不判会话存活",
    expect: "重载失败不报喜 / 会话已销毁不标脏 / 追加失败先取引用再截断",
  },
  {
    label: "openCategory 在 await 之后不复核 lib(锁屏上抛 null.categoryInfo)",
    file: "public/js/features/sidebar.js",
    from: "  const lib = S.get('lib');\n  if (!lib || seq !== catOpenSeq) return false;",
    to: "  const lib = S.get('lib');\n  if (seq !== catOpenSeq) return false; // MUTANT:不判 lib 存活",
    expect: "openCategory 在 await 期间会话被销毁",
  },
  {
    label: "搜索拉全部分类失败不 catch(离线按 Ctrl+K 零反馈 + unhandledrejection)",
    file: "public/js/features/search.js",
    from: "  try { await lib.loadAllCategories(); }\n  catch (e) { ctx.toast(`搜索需要先联网加载全部分类:${e.message}`, 'error'); return; }",
    to: "  await lib.loadAllCategories(); // MUTANT:无 catch",
    expect: "搜索前拉全部分类失败(离线)必须给反馈",
  },
  {
    label: "紧急锁定不先关冲突弹窗(老板键卡在永不落定的 promise 上)",
    file: "public/js/features/lock.js",
    from: "    const dlg = ctx.dom?.byId('modal');\n    if (dlg && dlg.open) dlg.close();",
    to: "    // MUTANT:不关弹窗,直接等保存",
    expect: "锁定必须先关掉冲突弹窗再等保存",
  },
  {
    label: "downloadBytes 自造不 append 的锚点(部分浏览器拿到空文件)",
    file: "public/js/ui.js",
    from: "  downloadUrl(url, fileName);",
    to: "  const a = document.createElement('a'); a.href = url; a.download = fileName; a.click(); // MUTANT",
    expect: "下载锚点只有一份实现",
  },
  {
    label: "doUnlock 失败不清理半成品会话(lib 与令牌留在内存)",
    file: "public/js/features/lock.js",
    from: "    const cur = S.get('lib');\n    if (cur) { cur.destroy(); S.set('lib', null); }\n    ctx.api.clearToken();\n    err.textContent = `打开失败:${e.message}`;",
    to: "    err.textContent = `打开失败:${e.message}`; // MUTANT:半成品会话留在内存",
    expect: "doUnlock 失败必须收干净半成品会话",
  },
  {
    label: "追加失败先截断长度再取引用(取回恒 undefined,清理从未执行)",
    file: "public/js/lib.js",
    from: "      const added = dst.data.notes[before];\n      dst.data.notes.length = before;",
    to: "      dst.data.notes.length = before; // MUTANT:先截断\n      const added = dst.data.notes[before];",
    expect: "重载失败不报喜 / 会话已销毁不标脏 / 追加失败先取引用再截断",
  },
  {
    label: "zip 写端不校验 bytes 类型(漏传内容静默写成 0 字节条目)",
    file: "public/js/zip.js",
    from: "    const raw = e.bytes;\n    let data;\n    if (raw instanceof Uint8Array) data = raw;\n    else if (raw instanceof ArrayBuffer) data = new Uint8Array(raw);\n    else if (Array.isArray(raw)) data = new Uint8Array(raw);\n    else {\n      throw new ZipError(`条目「${name}」缺少内容(bytes 必须是 Uint8Array / ArrayBuffer / 数字数组)`);\n    }",
    to: "    const data = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes); // MUTANT:不校验",
    expect: "写端:bytes 缺失或类型不对必须当场报错",
  },
  {
    label: "zip 写端不查重(写出的包自己读不回来)",
    file: "public/js/zip.js",
    from: "    if (seenNames.has(name)) throw new ZipError(`条目重复:${name}`);\n    seenNames.add(name);",
    to: "    seenNames.add(name); // MUTANT:不查重",
    expect: "条目重复要报错",
  },
  {
    label: "zip 日期不处理无效 Date、不夹 2107(写出非法 DOS 日期)",
    file: "public/js/zip.js",
    from: "  const d = Number.isNaN(raw.getTime()) ? new Date(1980, 0, 1) : raw;\n  const year = Math.min(2107, Math.max(1980, d.getFullYear()));",
    to: "  const d = raw; // MUTANT:不处理无效日期\n  const year = Math.max(1980, d.getFullYear()); // MUTANT:不夹上限",
    expect: "日期:无效 Date 退回 1980-01-01",
  },
  {
    label: "zip 读端取第一个 EOCD 签名(注释里的假签名会误导解析)",
    file: "public/js/zip.js",
    from: "    if (dv.getUint32(i, true) !== SIG_EOCD) continue;\n    if (i + 22 + dv.getUint16(i + 20, true) !== bytes.length) continue;\n    eocd = i; break;",
    to: "    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; } // MUTANT:不看注释长度",
    expect: "EOCD 只认",
  },
  {
    label: "zip 读端不显式校验条目名长度(subarray 静默截短)",
    file: "public/js/zip.js",
    from: "    if (p + 46 + nameLen > bytes.length) {\n      throw new ZipError(`zip 结构损坏(第 ${i + 1} 个条目名越界)`);\n    }",
    to: "    // MUTANT:不校验名字长度",
    expect: "条目名长度越界要说清楚",
  },
  {
    label: "zip 读端不校验中央目录用尽(count 偏小就静默少读)",
    file: "public/js/zip.js",
    from: "  if (p !== cdOffset + cdSize) {\n    throw new ZipError(\n      `zip 结构损坏(中央目录与条目数不符:读到 ${p - cdOffset} 字节,声明 ${cdSize} 字节)`,\n    );\n  }",
    to: "  // MUTANT:不校验中央目录是否用尽",
    expect: "中央目录必须刚好用尽",
  },
  {
    label: "moveDirty 不判目标已脏(覆盖代数,在途保存会误清脏标记)",
    file: "public/js/store.js",
    from: "    if (this._state.dirty.has(to)) {\n      throw new Error(`待保存队列里已存在「${to}」,不能把「${from}」的改动合并过去`);\n    }",
    to: "    // MUTANT:不判重,直接覆盖",
    expect: "moveDirty:目标分类已有脏标记",
  },
  {
    label: "编辑器工具条不排除 [data-genpw](pw 按钮被双绑)",
    file: "public/js/features/shell.js",
    from: "  for (const b of document.querySelectorAll('#edTools .ed-btn:not([data-genpw])')) {",
    to: "  for (const b of document.querySelectorAll('#edTools .ed-btn')) { // MUTANT:双绑",
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "tabsync 消息处理失败完全静默(多标签页同步失效无痕迹)",
    file: "public/js/tabsync.js",
    from: "          console.error('tab 消息处理失败', msg, e);",
    to: "          // MUTANT:静默",
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "getCat 不剥 W/ 弱 etag(与 fetchVault 口径不一致 → 恒 412)",
    file: "public/js/api.js",
    from: "  return { bytes: new Uint8Array(await res.arrayBuffer()), etag: normEtag(res.headers.get('etag')) };",
    to: `  return { bytes: new Uint8Array(await res.arrayBuffer()), etag: (res.headers.get('etag') || '').replace(/"/g, '') }; // MUTANT:不剥 W/`,
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "建库失败退回解锁态时不清 pwHint(留下上一态的强度提示)",
    file: "public/js/features/lock.js",
    from: "      ctx.showLock('unlock');",
    to: "      ctx.showLock('setup'); // MUTANT:留在建库态",
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "ui.js 重新导入搜索纯函数(死导入)",
    file: "public/js/ui.js",
    from: "import { saveSession, loadSession, clearSession } from './session.js';",
    to: "import { findMatches, renderSearchResult } from './search.js'; // MUTANT:死导入\nimport { saveSession, loadSession, clearSession } from './session.js';",
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "theme.js 把内部函数重新导出(无人引用的公开面)",
    file: "public/js/features/theme.js",
    from: "function applyTheme(mode, ctx) {",
    to: "export function applyTheme(mode, ctx) { // MUTANT",
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "search 重新引入死字段 qLen",
    file: "public/js/features/search.js",
    from: "/** 搜索序号守卫:慢查询后到不得覆盖新查询的结果。",
    to: "const qLen = 0; // MUTANT:死字段\n\n/** 搜索序号守卫:慢查询后到不得覆盖新查询的结果。",
    expect: "A11:死代码与双绑清理",
  },
  {
    label: "冲突弹窗「留待稍后」无条件报喜(重载失败也报「已改为云端版本」)",
    file: "public/js/ui.js",
    from: "    const reloaded = S.activeCat === name ? await openCategory(ctx, name) : true;\n    if (reloaded) toast(`「${name}」已改为云端版本,本地未保存的改动已放弃`, 'warn');",
    to: "    await openCategory(ctx, name); // MUTANT:不看返回值\n    toast(`「${name}」已改为云端版本,本地未保存的改动已放弃`, 'warn');",
    expect: "A12:重载失败不报喜",
  },
];

/* 自动发现测试文件,不手写清单 —— 手写清单必然漂移:
 * 新增一个 *.test.mjs 却忘了加进来,那个文件就**静默地不受变异测试覆盖**,
 * 而 falsify 会照样打印「全部守卫具备判别力」。
 * (同样的教训也发生在 public/sw.js 的 ASSETS 上,那边由 tests/assets.test.mjs 盯着。) */
const TEST_FILES = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => `tests/${f}`);

const NODE = process.execPath;

function runTests() {
  let out = '';
  let failed = [];
  // TEST_CONCURRENCY:资源受限环境(小内存 CI/沙箱)可调低并发,
  // 避免测试进程并行时把内存挤爆 —— 那会产生与代码无关的假失败,污染判红
  const args = ['--test', ...TEST_FILES];
  const cc = Number(process.env.TEST_CONCURRENCY || '');
  if (Number.isFinite(cc) && cc > 0) args.splice(1, 0, `--test-concurrency=${cc}`);
  try {
    // maxBuffer 必须显式给足:默认 1MB,而 430 项全套 + 失败详情已到 160KB 量级,
    // 再长一点就会 ENOBUFS —— 那时 e.stdout 是 undefined,out 变成空串,
    // 一条 not ok 都解析不到(2026-10-17 实测过一次假绿,根因就是这个家族)
    out = execFileSync(NODE, args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('not ok ')) {
      const m = /^not ok \d+ - (.*)$/.exec(line);
      if (m) failed.push(m[1].trim());
    }
  }
  const pass = /# pass (\d+)/.exec(out);
  const fail = /# fail (\d+)/.exec(out);
  /* ran = 这一轮测试**真的跑完了**(看到了 TAP 的汇总行)。
   * 没有它,「测试进程根本没起来」(沙箱 spawn 抖动 / 磁盘瞬时占用 / ENOBUFS)
   * 与「跑完了且全绿」在返回值上**完全一样** —— failed 都是空数组,
   * 于是被误判成「这条守卫没有判别力」,而真相是这次测量从未发生。
   * 假绿比漏报危险得多:它会让人相信一套根本不存在的护栏。 */
  return { failed, pass: pass ? Number(pass[1]) : 0, fail: fail ? Number(fail[1]) : -1, ran: !!pass };
}

const only = process.argv[2] || '';
const selected = only ? MUTANTS.filter((m) => m.label.includes(only)) : MUTANTS;
if (!selected.length) {
  console.error(`没有匹配「${only}」的变异体`);
  process.exit(2);
}

let bad = 0;
for (const m of selected) {
  const path = join(ROOT, m.file);
  const src = readFileSync(path, 'utf8');
  // 仓库文件是 CRLF:锚点按 \n 书写,匹配前把锚点适配成目标文件的实际行尾。
  // 不适配的话,**所有多行锚点**都会在 CRLF 文件上失配,整套守卫静默退化成「跳过」
  // (2026-09-25 实测:9 处失效锚点里 8 处是这个原因,只有 1 处是代码改名)
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const from = m.from.split('\n').join(eol);
  const to = m.to.split('\n').join(eol);
  if (!src.includes(from)) {
    console.log(`[跳过] ${m.label}\n        锚点未找到(${m.file})—— 代码改过就要同步改本脚本`);
    bad += 1;
    continue;
  }
  try {
    writeFileSync(path, src.replace(from, to), 'utf8');
    const { failed, pass, fail, ran } = runTests();
    if (!ran) {
      /* 测试没跑成 ≠ 守卫没判别力。此时 failed 为空,若继续走下面的判定,
       * 会打印一条假的「[绿✗] 这条守卫没有判别力」—— 而真相是这次测量从未发生。
       * 宁可中断并计入 bad,也绝不产出没有事实支撑的结论。 */
      bad += 1;
      console.log(`[中断] ${m.label}\n        测试进程未能完成运行(未见 # pass 汇总),本轮不计入结论 —— 请重跑`);
      continue;
    }
    const hit = failed.some((f) => f.includes(m.expect));
    if (hit) {
      console.log(`[红✓] ${m.label}\n        「${m.expect}」如期失败(共 ${fail} 项,用例通过 ${pass} 项)`);
    } else {
      bad += 1;
      console.log(`[绿✗] ${m.label}\n        期望「${m.expect}」变红,实际没红 —— 这条守卫没有判别力。失败项:${failed.slice(0, 3).join(' / ') || '(无)'}`);
    }
  } finally {
    /* 还原失败必须**炸出声**:静默失败会把工作区留在变异态,
     * 而后续所有测试都会拿变异态当基线跑(2026-10-17 实测:
     * 一次 EPERM 就让 style.css 带着 MUTANT 注释活到了下一次会话)。 */
    try {
      writeFileSync(path, src, 'utf8'); // 无论如何都还原
    } catch (e) {
      console.error(`\n[严重] 还原失败:${path} —— ${e.message}\n        工作区可能已留在变异态,请立刻执行 git diff 核对!`);
      throw e;
    }
  }
}

const final = runTests();
/* restored 必须同时要求 ran:没跑成时 fail 是哨兵值 -1,
 * 只比 fail===0 足以把「压根没测」糊弄成另一种结论。 */
const restored = final.ran && final.fail === 0;
console.log(`\n还原后复跑:${restored ? `全绿 ✓(${final.pass} 项)` : `仍有失败 ✗ ${final.failed.join(' / ')}`}`);
const ok = bad === 0 && restored;
console.log(`鉴伪结论:${ok ? '全部守卫具备判别力 ✓' : '存在无效守卫或未还原 ✗'}`);

/* 说明:定长比较(timingSafeEqual)的时序性质无法用功能测试判别 ——
 * 任何功能等价的写法都得到相同的通过/拒绝结果。它只能靠代码审阅保证,
 * 这里刻意不列变异体,免得给出「已经验证过」的错觉。 */
process.exit(ok ? 0 : 1);