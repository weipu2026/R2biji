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

import { readFileSync, writeFileSync } from 'node:fs';
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
];

const TEST_FILES = ['crypto', 'format', 'vault', 'render', 'worker', 'e2e', 'deploy']
  .map((n) => `tests/${n}.test.mjs`);

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