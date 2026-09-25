#!/usr/bin/env node
/**
 * 部署前配置生成器 —— 把「因人而异」的域名/桶名从环境变量注入模板,产出真正的部署配置。
 *
 *   模板 wrangler.toml  +  环境变量 / GitHub Secrets  →  wrangler.deploy.toml
 *
 * 为什么需要这一步:wrangler **不支持**在 wrangler.toml 里插值环境变量,
 * 而自定义域名是结构化字段(`[[routes]]` + `custom_domain`),只能由脚本拼出来。
 * 有了它,「域名放 GitHub Variables/Secrets、不填就用 workers.dev」才落得了地,
 * 同时仓库里不会残留任何人的真实域名(fork-safe:别人 fork 后不可能带着你的域名静默上线)。
 *
 * 取值优先级:process.env(CI 注入)→ .dev.vars(本地)
 *
 * 【必填】ACCESS_KEY    访问密钥门,≥16 个 ASCII 字符。
 *                       ⚠️ 本脚本**不会**把它写进生成物 —— 它只作为一道闸门在这里校验,
 *                       真正的下发由工作流的 `wrangler secret put` 负责。
 *                       这样「生成物里不含密钥」这件事是结构性的,而不是靠自觉。
 *
 * 【选填】WORKER_DOMAIN   自定义域名,如 bij.example.com(不带协议头)。
 *                         留空 → 不生成 routes 块,站点走 <name>.<子域>.workers.dev。
 *       BUCKET_NAME      R2 桶名,默认 jmbiji-vault。
 *       HIDE_WORKERS_DEV  设为 1 → 关闭 workers.dev 入口。默认保留双入口:首次绑自定义域
 *                         DNS 未生效时,CI 验收要靠 workers.dev 兜底(见 deploy.yml Verify)。
 *       ALLOW_NO_ACCESS_KEY 设为 1 → 跳过 ACCESS_KEY 校验(与 Worker 的同名开关语义一致,强烈不推荐)。
 *
 * 任一必填项缺失/非法 → 打印原因并 exit 1(CI 因此中断,符合「必填」语义)。
 *
 * 用法:
 *   npm run deploy                       # = gen-config → wrangler deploy --config wrangler.deploy.toml
 *   ACCESS_KEY=… WORKER_DOMAIN=bij.x.com node scripts/gen-config.mjs
 *   node scripts/gen-config.mjs          # 只校验 + 生成,不部署
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TMPL = 'wrangler.toml';
const OUT = 'wrangler.deploy.toml';

/** 与 Worker 的 MIN_ACCESS_KEY_LEN 必须一致(有单测钉住两处相等)。 */
const MIN_ACCESS_KEY_LEN = 16;

const errors = [];
const err = (m) => errors.push(m);
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const warn = (m) => console.log('  \x1b[33m⚠\x1b[0m ' + m);

/* ---------------- 取值:env 优先,其次 .dev.vars ---------------- */

function loadDevVars() {
  if (!existsSync('.dev.vars')) return {};
  const out = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const devVars = loadDevVars();
const get = (name) => {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromFile = devVars[name];
  return fromFile !== undefined && fromFile !== '' ? fromFile : undefined;
};

/* ---------------- 校验工具 ---------------- */

// 合法主机名(允许多级子域);不含协议、不含路径
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// 明显的占位/示例值
const PLACEHOLDER_RE =
  /__|<[^>]*>|example\.(com|org|net)$|your-?domain|yourdomain|changeme|placeholder|^todo$/i;
// 示例密钥:README 里出现的示例值必须在这里被拒 —— 否则有人照抄就会得到一个
// 「全世界都知道」的访问密钥(公开仓库场景下这是真实风险,不是假想)。
const PLACEHOLDER_KEY_RE =
  /^(change-?me|your-?key|test|password|123456|access-?key|secret|jmbiji|example)/i;

/** 去掉协议头/路径/端口,统一小写 */
function normHost(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/* ---------------- 读模板 ---------------- */

if (!existsSync(TMPL)) {
  console.error(`✗ 找不到模板 ${TMPL}`);
  process.exit(1);
}
const template = readFileSync(TMPL, 'utf8');

/* ---------------- ACCESS_KEY(必填,只校验不落盘) ---------------- */

const allowNoKey = get('ALLOW_NO_ACCESS_KEY') === '1';
const accessKey = get('ACCESS_KEY');

if (allowNoKey) {
  warn('ALLOW_NO_ACCESS_KEY=1:跳过访问密钥校验。任何拿到网址的人都能拉走 vault.json 离线爆破主密码(强烈不推荐)。');
} else if (!accessKey) {
  err(
    '缺少必填项 ACCESS_KEY(访问密钥门)。\n' +
      '    它必须与 Worker 的 secret 一致,设置方式二选一:\n' +
      '      · 本地:  echo "你的密钥" | npx wrangler secret put ACCESS_KEY   (再 export ACCESS_KEY=… 后部署)\n' +
      '      · GitHub:仓库 Settings → Secrets and variables → Actions → Secrets 里加 ACCESS_KEY,工作流会自动同步',
  );
} else if (accessKey.length < MIN_ACCESS_KEY_LEN) {
  err(
    `ACCESS_KEY 过短(${accessKey.length} 字符,至少 ${MIN_ACCESS_KEY_LEN} 个)。\n` +
      '    未达标的密钥会被 Worker 直接拒绝,整站 503 —— 这是刻意的 fail closed。\n' +
      '    建议:≥20 位、混合大小写与符号的随机串(例:openssl rand -base64 24)。',
  );
} else if (!/^[\x20-\x7e]+$/.test(accessKey)) {
  err('ACCESS_KEY 必须是 ASCII 可见字符(不含中文/换行/控制字符),否则 HTTP 头无法携带。');
} else if (/^\s|\s$/.test(accessKey)) {
  err(
    'ACCESS_KEY 首尾含空白字符(多半是粘贴带进来的)。\n' +
      '    这里校验的是去掉与否的原值,与 Worker secret 里的实际值一旦不一致,表现为全站恒 401 且报错误导。\n' +
      '    请去掉首尾空白,并确认 GitHub Secrets 里存的是同一份值。',
  );
} else if (PLACEHOLDER_KEY_RE.test(accessKey)) {
  err(
    'ACCESS_KEY 看起来是示例/占位值,拒绝部署 ——\n' +
      '    公开仓库里的示例值等于「全世界都知道的密钥」,而它是唯一挡住 vault.json 离线爆破的一层。\n' +
      '    请换成自拟的随机串。',
  );
} else {
  ok(`ACCESS_KEY 已校验(长度 ${accessKey.length},不会写入生成物)`);
}

/* ---------------- WORKER_DOMAIN(选填) ---------------- */

const rawDomain = get('WORKER_DOMAIN');
let domain;
if (rawDomain) {
  const h = normHost(rawDomain);
  if (PLACEHOLDER_RE.test(h)) {
    err(`WORKER_DOMAIN 是占位/示例值:${rawDomain}(请填你的真实域名,或留空用 *.workers.dev)`);
  } else if (!HOST_RE.test(h)) {
    err(
      `WORKER_DOMAIN 非法:${rawDomain}\n` +
        '    只填域名本身,不要协议头、路径、端口或通配符。正确:bij.example.com',
    );
  } else {
    domain = h;
    ok(`WORKER_DOMAIN = ${domain}(将写入 [[routes]] custom_domain)`);
  }
} else {
  console.log('  · WORKER_DOMAIN 未配置 → 不生成自定义域路由,站点走 <name>.<子域>.workers.dev');
}

/* ---------------- BUCKET_NAME(选填) ---------------- */

const bucket = get('BUCKET_NAME') || 'jmbiji-vault';
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
  err(`BUCKET_NAME 非法:${bucket}(只允许小写字母/数字/连字符,3~63 字符,首尾须为字母或数字)`);
} else {
  ok(`BUCKET_NAME = ${bucket}`);
}

/* ---------------- 模板标记检查(防止有人删了锚点静默失效) ---------------- */

if (!/^#\s*gen:routes\s*$/m.test(template)) {
  err(`模板 ${TMPL} 缺少 "# gen:routes" 标记行,无法插入路由块(该锚点被删掉了?)`);
}
if (!/^\s*workers_dev\s*=/m.test(template)) {
  err(`模板 ${TMPL} 缺少 workers_dev 行,无法按自定义域切换入口`);
}
if (!/^\s*bucket_name\s*=/m.test(template)) {
  err(`模板 ${TMPL} 缺少 bucket_name 行,无法注入桶名`);
}

if (errors.length) {
  console.error('\n✗ 配置校验未通过:\n');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error('\n修好后重跑。');
  process.exit(1);
}

/* ---------------- 注入 ---------------- */

/** 按键名逐行覆盖(锚定行首,避免误伤注释里出现的同名文字)。
 *  用函数式回调,避免值里的 `$` 被当作替换模式。
 *  quoted=true 写 TOML 字符串,quoted=false 写裸值(布尔量必须走这条 ——
 *  `workers_dev = "false"` 在 TOML 里是字符串,wrangler 拿到字符串会直接报类型错误)。 */
function setKey(src, key, value, { quoted = true } = {}) {
  const re = new RegExp('^(\\s*)' + key + '(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|[^\\r\\n#]*)(.*)$', 'm');
  if (!re.test(src)) return null;
  const rendered = quoted ? `"${value}"` : String(value);
  return src.replace(re, (_m, indent, eq, _old, tail) => `${indent}${key}${eq}${rendered}${tail}`);
}

let out = template;

// ① 桶名
const withBucket = setKey(out, 'bucket_name', bucket);
if (withBucket === null) {
  console.error('✗ 注入 bucket_name 失败(模板结构变了?)');
  process.exit(1);
}
out = withBucket;

// ② 自定义域路由 + workers.dev 开关
// 默认**双入口**:workers.dev 是首次绑自定义域、DNS 还没生效时的验收兜底
// (deploy.yml Verify 会自动退回它;两个入口指向同一个 Worker,门完全一致)。
// 真的只要自定义域一个入口 → 设 HIDE_WORKERS_DEV=1。
const hideDev = get('HIDE_WORKERS_DEV') === '1';
const routesBlock = domain
  ? [
      '# 由 scripts/gen-config.mjs 注入:自定义域名入口。',
      '# custom_domain = true 会让 Cloudflare 自动签发/续期证书,并要求该域名的 DNS 托管在同一账户。',
      '[[routes]]',
      `pattern = "${domain}"`,
      'custom_domain = true',
    ].join('\n')
  : '';

const withRoutes = out.replace(/^#\s*gen:routes\s*$/m, () => routesBlock);
if (withRoutes === out) {
  console.error('✗ 注入路由失败(gen:routes 锚点没被替换)');
  process.exit(1);
}
out = withRoutes;

if (domain) {
  const want = hideDev ? 'false' : 'true';
  const switched = setKey(out, 'workers_dev', want, { quoted: false });
  if (switched === null) {
    console.error('✗ 注入 workers_dev 失败');
    process.exit(1);
  }
  out = switched;
  if (hideDev) warn('HIDE_WORKERS_DEV=1:已关闭 workers.dev 入口。首次绑域 DNS 未生效期间,CI 验收将无处兜底。');
}

out = `# ⚠️ 本文件由 scripts/gen-config.mjs 生成,请勿手改(改动会在下次部署时被覆盖)。\n${out}`;

writeFileSync(OUT, out);

/* ---------------- 回读校验(生成物必须真的含期望值) ---------------- */

const back = readFileSync(OUT, 'utf8');
const fails = [];
if (!back.includes(`bucket_name = "${bucket}"`)) fails.push('bucket_name');
if (domain) {
  if (!back.includes(`pattern = "${domain}"`)) fails.push('routes.pattern');
  if (!back.includes(`workers_dev = ${hideDev ? 'false' : 'true'}`)) fails.push('workers_dev');
} else if (/^\s*\[\[routes\]\]/m.test(back)) {
  fails.push('意外的 routes 块(未配 WORKER_DOMAIN 却生成了路由)');
}
if (accessKey && back.includes(accessKey)) fails.push('生成物里出现了 ACCESS_KEY(不应落盘)');

if (fails.length) {
  console.error(`✗ 生成物回读校验失败:${fails.join(' / ')}`);
  process.exit(1);
}
ok(`已生成 ${OUT}(${out.split('\n').length} 行)`);
if (accessKey) ok('已确认生成物中不含 ACCESS_KEY');
if (domain) {
  console.log(`  · 入口:https://${domain}${hideDev ? '' : '  (另保留 workers.dev 兜底入口)'}`);
} else {
  console.log('  · 入口:<worker 名>.<你的账户子域>.workers.dev');
}
console.log('  · 下一步:npx wrangler deploy --config ' + OUT);
