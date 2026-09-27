/* ============================================================
 * 部署链路的守卫用例(纯文本断言,零依赖、可离线跑)
 *
 * 这里测的不是运行时逻辑,而是「部署配置本身」的正确性——
 * 这类东西一旦配错,单测全绿也照样能把站点上线成一个裸奔或者打不开的状态:
 *   · ACCESS_KEY 最短长度在 Worker 与 gen-config 各有一份 → 两边改歪就会
 *     出现「本地校验放过、线上 503」这种最难查的错配;
 *   · 模板锚点被删 → 注入静默失效,部署出去的配置与预期不符;
 *   · 工作流触发器被改成 pull_request_target → 公开仓库上等于把密钥交给陌生代码;
 *   · 验收步骤被掏空 → CI 变绿但什么都没验。
 * 每条都写成了可被 tests/falsify.mjs 反向破坏的确定性断言。
 * ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const workerSrc = read('worker/worker.js');
const genSrc = read('scripts/gen-config.mjs');
const template = read('wrangler.toml');
// Windows 下 core.autocrlf 检出为 CRLF,而下面的触发器正则只认 LF
// —— 不归一的话本地必挂「没能定位 on: 触发器块」、CI(Linux LF)却能过
const workflow = read('.github/workflows/deploy.yml').replace(/\r\n/g, '\n');
const gitignore = read('.gitignore');
const pkg = JSON.parse(read('package.json'));

test('部署守卫:两端常量一致 —— MIN_ACCESS_KEY_LEN 在 Worker 与 gen-config 必须相同且 ≥16', () => {
  const inWorker = /const MIN_ACCESS_KEY_LEN = (\d+);/.exec(workerSrc);
  const inGen = /const MIN_ACCESS_KEY_LEN = (\d+);/.exec(genSrc);
  assert.ok(inWorker, 'worker.js 里没找到 MIN_ACCESS_KEY_LEN');
  assert.ok(inGen, 'gen-config.mjs 里没找到 MIN_ACCESS_KEY_LEN');
  assert.equal(
    Number(inGen[1]),
    Number(inWorker[1]),
    'gen-config 与 Worker 的最短长度不一致:本地会放过、线上必然 503',
  );
  assert.ok(Number(inWorker[1]) >= 16, `最短长度 ${inWorker[1]} 太弱`);
});

test('部署守卫:模板锚点 —— wrangler.toml 必须保留三个注入点', () => {
  assert.match(template, /^#\s*gen:routes\s*$/m, '缺少 # gen:routes 标记行,路由注入会失效');
  assert.match(template, /^\s*workers_dev\s*=/m, '缺少 workers_dev 行,无法按自定义域切换入口');
  assert.match(template, /^\s*bucket_name\s*=/m, '缺少 bucket_name 行,无法注入桶名');
});

test('部署守卫:fork 安全 —— 模板里不得出现任何真实域名路由', () => {
  assert.doesNotMatch(
    template,
    /^\s*\[\[routes\]\]/m,
    '模板里出现了 [[routes]]:仓库是公开的,真实域名只能由部署时注入',
  );
  assert.doesNotMatch(template, /pattern\s*=\s*"[^"]+"/, '模板里出现了硬编码的域名 pattern');
});

test('部署守卫:工作流触发器 —— 只允许 push(main) 与手动触发,禁止 pull_request*', () => {
  // 只看 on: 到 jobs: 之间那段「触发器块」,并去掉注释行 ——
  // 文件头部的说明注释里正好讨论过 pull_request_target 这个反面例子,
  // 全文匹配会把注释也算成触发器(这条断言自己先踩过一次)。
  const block = /^on:\n([\s\S]*?)^jobs:/m.exec(workflow);
  assert.ok(block, '没能定位 on: 触发器块');
  const triggers = block[1]
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  for (const danger of ['pull_request', 'issue_comment', 'workflow_run']) {
    assert.doesNotMatch(
      triggers,
      new RegExp(danger),
      `触发器里出现了 ${danger}:公开仓库下这类事件会把 Secrets 交给陌生代码执行`,
    );
  }
  assert.match(triggers, /push:/, '缺少 push 触发器');
  assert.match(triggers, /branches:\s*\[main\]/, 'push 未限定在 main 分支');
  assert.match(triggers, /workflow_dispatch:/, '缺少手动触发入口');
});

test('部署守卫:工作流权限 —— 必须显式最小权限 contents: read', () => {
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/, '缺少 permissions: contents: read');
  assert.doesNotMatch(workflow, /contents:\s*write/, '不该有 contents: write 权限');
});

test('部署守卫:密钥只经 env 传递 —— 插值不得出现在 run 脚本正文里', () => {
  const offenders = workflow
    .split('\n')
    .filter((l) => l.includes('${{ secrets.'))
    .filter((l) => !/^[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{/.test(l.trim()));
  assert.deepEqual(
    offenders,
    [],
    `密钥插值只能写成 env 的「键: 值」形式,不能内联进脚本正文(会落进 runner 上的临时脚本):\n${offenders.join('\n')}`,
  );
});

test('部署守卫:上线验收 —— 工作流必须真的断言门的三态与桶的公开域', () => {
  /* ⚠️ 这条守卫曾长期失效(2026-09-27 falsify 报「没判别力」)。
   *   旧写法是 assert.match(workflow, /\/api\/vault/) 这类「文件里出现过某字符串」,
   *   而 /api/vault、x-access-key、401、404 在注释、echo、summary 表格里到处都是
   *   —— 把**真正发请求的那两行**掏空(改成不请求 /api/vault、不带密钥),
   *   其余字符串照样在,断言全绿。
   *   教训:断言必须落在**请求本身**与**判定分支**上,而不是「文件里有没有这个词」。 */

  // ① 取出真正执行请求的两行,而不是全文搜索
  const reqLines = workflow.split('\n').filter((l) => /\bcode\b.*\$URL/.test(l) && l.includes('='));
  const noKeyLine = reqLines.find((l) => /no_key\s*=/.test(l));
  const yesKeyLine = reqLines.find((l) => /yes_key\s*=/.test(l));
  assert.ok(noKeyLine, '找不到 no_key 那次请求(无密钥探测)');
  assert.ok(yesKeyLine, '找不到 yes_key 那次请求(带密钥探测)');

  // ② 两次探测必须打同一个端点 —— 否则「门的三态」比的不是同一件事
  assert.match(noKeyLine, /\/api\/vault/, '无密钥探测没有请求 /api/vault');
  assert.match(yesKeyLine, /\/api\/vault/, '带密钥探测没有请求 /api/vault');

  // ③ 关键区分点:带密钥那次必须**真的带上密钥**
  //    这条是 mutant 的照妖镜 —— 旧写法里 288 行还有一处 x-access-key(重试循环),
  //    全文 match 抓得到,但被掏空的正是首次请求这一行。
  assert.match(
    yesKeyLine,
    /x-access-key:\s*\$ACCESS_KEY/,
    '带密钥探测没有真的带上 x-access-key(门的三态就退化成同一件事)',
  );
  // ④ 反向:无密钥那次**绝不能**带密钥,否则「无密钥必须 401」验的是个假命题
  assert.doesNotMatch(
    noKeyLine,
    /x-access-key/,
    '无密钥探测竟然带了访问密钥,「无密钥必须 401」就不成立了',
  );

  // ⑤ 两次探测必须能取到不同的状态码(变量名不同且都被判过)
  const noCase = /case\s+"\$no_key"\s+in([\s\S]*?)esac/.exec(workflow);
  const yesCase = /case\s+"\$yes_key"\s+in([\s\S]*?)esac/.exec(workflow);
  assert.ok(noCase, '缺少对 $no_key 的分支判定');
  assert.ok(yesCase, '缺少对 $yes_key 的分支判定');
  // 三态必须都能判红:否则「门装歪了」会被静默放过
  assert.match(noCase[1], /401\)/, '$no_key 分支没有 401 这一态(门生效)');
  assert.match(noCase[1], /200\)[\s\S]*?fail=1/, '$no_key 拿到 200(门没装)时没有判红 —— 最致命的漏判');
  assert.match(noCase[1], /503\)[\s\S]*?fail=1/, '$no_key 拿到 503(密钥没同步)时没有判红');
  assert.match(yesCase[1], /200\|404\)/, '$yes_key 分支没有 200|404 这一态(带密钥可访问)');
  assert.match(yesCase[1], /401\)[\s\S]*?fail=1/, '$yes_key 仍 401(密钥不一致)时没有判红');

  // ⑥ 桶公开域检查(该项原本就有判别力,保留)
  assert.match(
    workflow,
    /domains\/managed/,
    '缺少桶公开访问(r2.dev)检查:桶被误开公开会整体绕过访问密钥门',
  );
});

test('部署守卫:首次绑域不红 —— Verify 必须能回退 workers.dev,gen-config 默认双入口', () => {
  assert.match(workflow, /get_dev_url/, 'Verify 缺少 workers.dev 兜底取址(首次绑域 DNS 未生效会必红)');
  assert.match(workflow, /URL_NOTE/, 'Verify 缺少「DNS 未生效已回退」的放行出口');
  assert.match(genSrc, /HIDE_WORKERS_DEV/, 'gen-config 缺少 HIDE_WORKERS_DEV 开关');
  assert.doesNotMatch(genSrc, /KEEP_WORKERS_DEV/, 'gen-config 仍残留旧开关 KEEP_WORKERS_DEV');
});

test('部署守卫:工作流里的赋值管道必须有兜底 —— set -e 下非零退出会中止整步', () => {
  // 规则:`X=$(A | B | C)` 这种赋值,在 `set -euo pipefail` 的步骤里,
  // 只要管道里有任何一个环节非零退出(典型:grep 没匹配到、curl 4xx/5xx),
  // 赋值本身就失败 → set -e 立刻中止 → 后面自己写的提示语全成了死代码。
  // 实测踩过两次:① 取 workers.dev 子域时 curl -f 失败,友好提示永远打不出来;
  //              ② 桶没有任何自定义域(最常见也最正确的情形)时 grep -o 没匹配 → 步骤中止,
  //                 于是「桶配置完全正确」反而让流水线永远变红。
  // 判据:管道里有非「安全命令」时,必须用 `|| true` 兜住。
  // 判据:管道里有非「安全命令」时,必须用 `|| 兜底` 接住(通常写 `|| true`)。
  // 两个必须避开的自伤(都真踩过):
  //   · 拆管道要防住 `sed -n 's/a\|b/p'` 里的**转义竖线** —— 那是 sed 的模式分隔符,不是 shell 管道,
  //     按 `|` 硬拆会把 `printf|sed` 误判成含 unknown 命令(`(?<!\\)\|` 才是对的);
  //   · 兜底形式不止 `|| true`, `|| echo '{}'` 之类同样能阻止中止,不能只认字面量 `|| true`。
  const SAFE = new Set(['printf', 'echo', 'cat', 'wc', 'tr', 'tail', 'head', 'sed', 'sort', 'uniq', 'cut', 'awk', 'true']);

  const lines = workflow.split('\n');
  const blocks = [];
  let cur = null;
  let runIndent = 0;
  for (const line of lines) {
    const open = /^(\s*)run: \|\s*$/.exec(line);
    if (open) { runIndent = open[1].length; cur = []; blocks.push(cur); continue; }
    if (!cur) continue;
    if (line.trim() === '') { cur.push(line); continue; }
    const ind = line.match(/^\s*/)[0].length;
    if (ind > runIndent) cur.push(line);
    else cur = null;
  }

  const offenders = [];
  for (const block of blocks) {
    const text = block.join('\n');
    if (!/set -e/.test(text)) continue; // 没开 set -e 的步骤不受这条规则约束
    for (const line of block) {
      const m = /^\s*[A-Za-z_][A-Za-z0-9_]*=\$\((.+)\)\s*$/.exec(line);
      if (!m) continue;
      const rhs = m[1];
      if (!rhs.includes('|')) continue;
      if (/\|\|/.test(rhs)) continue; // 已有兜底命令,失败时它接管退出码
      const stages = rhs.split(/(?<!\\)\|(?!\|)/).map((s) => s.trim().split(/[\s(]+/)[0]);
      const unsafe = stages.filter((c) => c && !SAFE.has(c));
      if (unsafe.length) offenders.push(`${line.trim()}  ← 管道里有 ${unsafe.join(' / ')},需加兜底(\`|| true\` 或 \`|| echo\`)`);
    }
  }
  assert.deepEqual(offenders, [], `以下赋值在管道失败时会中止步骤:\n${offenders.join('\n')}`);
});

test('部署守卫:gitignore 必须忽略生成物与本地密钥文件', () => {
  for (const p of ['wrangler.deploy.toml', '.dev.vars', 'node_modules/']) {
    assert.ok(
      gitignore.split('\n').some((l) => l.trim() === p),
      `.gitignore 没有忽略 ${p}(公开仓库里这类文件必须进不去)`,
    );
  }
});

test('部署守卫:npm run deploy 必须先注入配置再部署生成物', () => {
  const deploy = pkg.scripts?.deploy ?? '';
  assert.match(deploy, /node scripts\/gen-config\.mjs/, 'deploy 没有先跑 gen-config');
  assert.match(
    deploy,
    /wrangler deploy --config wrangler\.deploy\.toml/,
    'deploy 没有用生成的配置(用模板部署会丢掉注入的域名/桶名)',
  );
});
