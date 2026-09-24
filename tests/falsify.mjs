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
    from: 'for (let page = 0; page < 50; page++) {',
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
    from: '  return Math.min(Math.floor(iterations), PBKDF2_ITERATIONS_MAX);',
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
    from: '      if (!cat.data) { unreadable.push(name); continue; }',
    to: '      if (!cat.data) { continue; } // MUTANT',
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
    from: '      if (val !== undefined) b.addEventListener(\'click\', () => { dlg.close(); resolve(val); });',
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
  try {
    out = execFileSync(NODE, ['--test', ...TEST_FILES], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { failed, pass: pass ? Number(pass[1]) : 0, fail: fail ? Number(fail[1]) : -1 };
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
  if (!src.includes(m.from)) {
    console.log(`[跳过] ${m.label}\n        锚点未找到(${m.file})—— 代码改过就要同步改本脚本`);
    bad += 1;
    continue;
  }
  try {
    writeFileSync(path, src.replace(m.from, m.to), 'utf8');
    const { failed, pass, fail } = runTests();
    const hit = failed.some((f) => f.includes(m.expect));
    if (hit) {
      console.log(`[红✓] ${m.label}\n        「${m.expect}」如期失败(共 ${fail} 项,用例通过 ${pass} 项)`);
    } else {
      bad += 1;
      console.log(`[绿✗] ${m.label}\n        期望「${m.expect}」变红,实际没红 —— 这条守卫没有判别力。失败项:${failed.slice(0, 3).join(' / ') || '(无)'}`);
    }
  } finally {
    writeFileSync(path, src, 'utf8'); // 无论如何都还原
  }
}

const final = runTests();
const restored = final.fail === 0;
console.log(`\n还原后复跑:${restored ? `全绿 ✓(${final.pass} 项)` : `仍有失败 ✗ ${final.failed.join(' / ')}`}`);
const ok = bad === 0 && restored;
console.log(`鉴伪结论:${ok ? '全部守卫具备判别力 ✓' : '存在无效守卫或未还原 ✗'}`);

/* 说明:定长比较(timingSafeEqual)的时序性质无法用功能测试判别 ——
 * 任何功能等价的写法都得到相同的通过/拒绝结果。它只能靠代码审阅保证,
 * 这里刻意不列变异体,免得给出「已经验证过」的错觉。 */
process.exit(ok ? 0 : 1);