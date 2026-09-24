# JMbiji · 加密笔记本

端到端加密的云笔记:浏览器打开即用,所有内容在**本地加密后**才上传到 Cloudflare R2,服务器只存它解不开的密文(零知识)。支持桌面与手机浏览器,可安装为 PWA。零第三方运行时依赖、零构建。

设计详见 [DESIGN.md](DESIGN.md)。

## 项目架构

```
JMbiji/
├── public/               前端(静态资源,由 Worker 直接分发)
│   ├── index.html        单页入口
│   ├── css/style.css     界面样式
│   ├── js/
│   │   ├── crypto.js     加密核心:PBKDF2(100万次)→ KEK → AES-KW 包裹 DEK → HKDF 三把子密钥
│   │   ├── format.js     库结构规则:文件名清洗、备份轮换、内容寻址命名、密码强度(纯函数)
│   │   ├── vaultlib.js   vault.json / 分类文件 / 附件 的加解密与数据归一化
│   │   ├── api.js        API 客户端:令牌管理、etag 条件写(CAS)
│   │   ├── lib.js        库业务层:分类/笔记/附件,保存纪律(CAS → 冲突弹窗,绝不静默覆盖)
│   │   ├── render.js     Markdown 子集渲染器(纯 DOM,零 innerHTML,不解析链接与 HTML)
│   │   ├── search.js     全文搜索(标题+正文,高亮)
│   │   ├── ui.js         界面控制器(锁屏、编辑、保存流水线、自动锁屏)
│   │   └── main.js       入口
│   ├── sw.js             Service Worker:仅缓存应用外壳,不碰 /api/*
│   ├── _headers          静态资源的安全响应头(CSP/HSTS/noindex;由 CF 解析,不作为资源返回)
│   ├── robots.txt        全站禁索引
│   └── manifest.webmanifest / icon.svg
├── worker/
│   ├── worker.js         Cloudflare Worker:/api/* 路由(纯函数核心 handleApi + 薄适配层)
│   │                     鉴权/限流/硬化头/条件写全在这一个文件里,跨请求状态放模块级
│   └── memory-r2.mjs     内存版 R2(单测与本地 dev-server 共用,语义与真机一致)
├── dev-server.mjs        本地启动(Node ≥ 22,内存 R2,数据重启即清空)
├── scripts/
│   └── gen-config.mjs    部署前配置生成器:模板 + 环境变量 → wrangler.deploy.toml(见「安装部署」)
├── .github/workflows/
│   └── deploy.yml        一键部署流水线:push main → 部署 → 同步密钥 → 上线验收 → 桶可见性审计
├── wrangler.toml         **部署配置模板**(只有合法默认值,不含任何人的真实域名)
├── SECURITY.md           威胁模型与安全承诺(公开仓库必读)
└── tests/                离线单测(node --test,含 Worker 鉴权/CAS/备份轮换/部署配置守卫)
    └── falsify.mjs       鉴伪:逐条破坏守卫,确认用例会变红(见「开发」)
```

## 安装部署

要求:Node.js ≥ 22;Cloudflare 账号(免费套餐即可,R2 免费额度足够个人使用)。

两条路,**推荐第一条**——它每次 push 都会自动部署并自动验收,不用在本地配任何凭据。

### A. GitHub 一键部署(推荐)

1. 把仓库 push 到 GitHub(公开或私有都行)。
2. 到 **Settings → Secrets and variables → Actions** 按下面的表填好 2 个必填 Secret。
3. push 到 `main`(或在 Actions 页手动 Run workflow)→ 自动完成部署 + 验收。

| 名称 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secrets | ✔ | 权限:`Workers Scripts: Edit` + `Workers R2 Storage: Edit` + `Account Settings: Read`。R2 权限不是可选项——桶不存在时部署会去创建它,缺权限直接失败 |
| `ACCESS_KEY` | Secrets | ✔ | 访问密钥门,≥16 个 ASCII 字符。会被自动同步到 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | Variables | | 32 位账户 id;只关联一个账户时可留空 |
| `WORKER_DOMAIN` | Variables | | 自定义域名,如 `bij.example.com`(不带 `http://`)。留空 → 用 `<worker名>.<你的子域>.workers.dev` |
| `BUCKET_NAME` | Variables | | R2 桶名,默认 `jmbiji-vault` |
| `KEEP_WORKERS_DEV` | Variables | | 设为 `1` 时,配了自定义域也保留 workers.dev 入口(默认只留一个入口) |

工作流共 8 个步骤,其中下列 5 个是**硬性校验/验收**,任一不通过就整体失败:

| 顺序 | 步骤 | 作用 |
|---|---|---|
| 1 | Validate | 必填项缺失/密钥过短非 ASCII → 立刻失败(不浪费一次安装依赖) |
| 2 | Deploy | `gen-config` 注入域名与桶名 → `wrangler deploy --config wrangler.deploy.toml` |
| 3 | Sync secret | 把 `ACCESS_KEY` 写成 Worker secret(必须在部署之后,首次部署前 Worker 还不存在) |
| 4 | Verify live | 真的去请求线上:首页 200 + CSP/X-Frame-Options 齐备 + **无密钥访问 `/api/vault` 必须 401** + 带密钥必须 200/404。结果写进 Actions 的 Summary |
| 5 | Audit bucket | 用官方 API 查桶的 r2.dev 公开域与自定义域,已确认公开 → 直接失败 |

> **主密码不在上表里,也不需要放在任何地方。** 它是零知识设计:只在浏览器里参与 PBKDF2 派生,
> **从不发送给服务器**,所以 CI 里放它既无用、又会制造「配了就安全」的错觉。
> 「访问密钥」开门,「主密码」解密——两回事。

**公开仓库须知的四条约定**(工作流已按此写好,改动时别破坏):

- 只监听 `push` 到 `main` 与手动触发。**不要**改成 `pull_request` / `pull_request_target`——
  后者会把 Secrets 交给来自 fork 的代码执行,是经典外泄通道。`tests/deploy.test.mjs` 会拦住这种改动。
- 权限固定 `contents: read`,`checkout` 关闭凭据落盘。
- 所有密钥只经 `env:` 传入,不内联进 run 脚本正文。
- 别把线上真实域名/网址写进仓库文件:仓库公开后它就不再是秘密,`ACCESS_KEY` 与主密码才是唯一的门与锁。

### B. 本地手动部署

```bash
npm install                           # 只装了 wrangler(构建/运行时零依赖)
export ACCESS_KEY='至少16个ASCII字符'  # gen-config 会校验它,不合法就拒绝部署
npm run deploy                        # = gen-config(注入域名/桶名)→ wrangler deploy --config wrangler.deploy.toml
```

想绑自定义域就加 `WORKER_DOMAIN=bij.example.com`;不设则走 `*.workers.dev`。
`npm run deploy` 之外单独跑 `npm run gen-config` 可以只看校验与生成结果、不部署。

⚠️ **顺序不能反**:`ACCESS_KEY` 未设置(或短于 16 字符)时,服务端会 **fail closed**,
所有 `/api/*` 一律返回 503 并提示要跑哪条命令 —— 宁可整站打不开,也不把 `vault.json`
暴露给「拿到网址的人」离线爆破主密码。这是刻意的默认行为,不是故障。

`ACCESS_KEY` 是访问密钥门,**与主密码是两回事**:它只在本机浏览器里保存,
网页首次打开时要求输入一次,换设备/换浏览器再输一次。
用 GitHub 流水线部署时,这个值以仓库里的 Secrets 为权威来源:CI 每次都会覆盖 Worker 上的同名 secret。

⛔ **R2 桶必须保持「私有」——不要开公开访问。**
不开 `r2.dev` 公开域、不绑自定义域、不在桶设置里启用 Public Access。
本项目与 r2share 不同:这里**所有读写都走 Worker**(`/api/vault`、`/api/blob`),
桶本身**从来不需要对外可达**。一旦桶被公开:`vault.json` 与全部密文可被任何人
直接下载,而 `ACCESS_KEY` 这道门会被**整体绕过** —— 门只拦 `/api/*`,管不到桶的
公开端点,等于把「离线穷举主密码」的入口白送出去。走流水线时第 5 步会自动查这一项。

部署完成得到 `https://jmbiji.<你的子域>.workers.dev`,手机/桌面浏览器直接打开;「安装应用」后即成 PWA。

**本地体验**(不部署):`./start.sh`(或 `node dev-server.mjs 8787`)→ http://localhost:8787 。本地不设 `ACCESS_KEY` 时会自动关掉这层门并打印警告(想按生产语义试:`ACCESS_KEY=至少16个字符 node dev-server.mjs`)。注意本地版数据只在内存里,重启即清空,仅用于调 UI。

## 使用

- **建库**:首次打开选「新建空库」→ 设定主密码(服务端永不接触主密码)。密码要求 **≥10 位**且估算熵 ≥64 bit,输入时实时显示 弱/中/强。
- **读为主**:打开即阅读态;每段、每条笔记、列表项都有复制按钮。
- **编辑**:改动先存内存;Ctrl+S / 切走页面 / 5 分钟无操作 / 关闭页面时保存。
- **多端**:直接在另一台设备打开同一网址即可;同时编辑同一分类时后保存方会收到冲突提示(覆盖对方 / 以云端为准 / 取消),绝不静默覆盖。
- **格式**:`# 标题`、`**加粗**`、`==高亮==`、`` `行内代码` ``、三反引号代码块、`-` 列表。
- **图片**:编辑态「添加图片」;同图自动去重;删除笔记后用侧栏「清理未引用图片」回收。
- **改主密码**:侧栏底部,只重包密钥,全部分类文件零改动零重传。改完请重新备份 `vault.json`。
- **锁定**:顶栏「锁定」;自动锁屏默认 **15 分钟**(可关/可改)。刷新页面后需重新输主密码(令牌只存内存,不落盘)。

## 配置参考

| 配置 | 位置 | 必填 | 说明 |
|---|---|---|---|
| 主密码 | 仅用户记忆 | ✔ | 不可找回;忘记 = 数据无法恢复。≥10 位且估算熵 ≥64 bit |
| `ACCESS_KEY` | `wrangler secret put` | ✔ | 访问密钥门(≥16 个 ASCII 字符),所有 `/api/*` 共用。**未设置/过短 = 整站 503**(fail closed);网页首次打开时要求输入一次 |
| 桶名 | `wrangler.toml` | | 默认 `jmbiji-vault`,部署时自动创建 |
| `ALLOW_NO_ACCESS_KEY` | `wrangler.toml` 的 `[vars]` | | 设为 `1` 可显式关掉访问密钥门。**强烈不推荐**:等于允许「拿到网址的人」下载 `vault.json` 离线穷举主密码 |

唯一需要做的运维动作:**建库后、每次改主密码后,把 `vault.json` 抄送一份到库外**。丢失它 = 全库不可恢复。
⚠️ 这份副本要放在**不会外泄的位置**(别放浏览器下载目录、公共网盘):拿到它的人不受访问密钥门与限流的任何约束,可以离线穷举主密码。

## 安全模型(端到端零知识)

| 环节 | 方案 |
|---|---|
| 传输 | 全程 HTTPS(Cloudflare 边缘) |
| 主密码 | 只在浏览器内存中做 KDF,从不发送到服务器 |
| 存储内容 | R2 中只有密文:分类/附件 AES-256-GCM,`vault.json` 不含任何能解密数据的机密 |
| API 鉴权 | Bearer 令牌 = 由 KEK 经 HKDF 派生,仅存内存;服务端只存其 SHA-256,库文件泄露也不新增爆破面 |
| 防覆盖 | 每次写入带 If-Match 条件(R2 CAS);创建用 If-None-Match: *(仅一次) |
| 备份 | 服务器在覆盖/删除分类前自动把旧版存入 `backup/`,每分类滚动保留 10 份 |
| 防爆破 | 访问密钥门未配置/过短一律 503(fail closed);失败 15 次封禁该 IP 10 分钟(带 `retry-after`) |
| 抗跨站 | 不返回任何 CORS 头,`OPTIONS` 预检一律 405;限流只统计「带凭据来试」的失败,跨站页面无法借你的 IP 刷满失败预算 |
| 抗 XSS | 零 `innerHTML`、零内联脚本、不解析任何 HTML;静态资源带严格 CSP(`script-src 'self'` + `frame-ancestors 'none'`),API 响应带 `default-src 'none'` |
| 抗时序侧信道 | 令牌哈希与访问密钥均走定长比较(密钥先两侧各取 SHA-256,长度不参与判断) |
| 抗索引泄露 | Service Worker 硬护栏:`/api/*` 永不经缓存;`robots.txt` + `X-Robots-Tag` 全站禁索引 |
| 抗内存打爆 | 读请求体前先看 `content-length`,超限直接 413,不把大 body 读进 128MB 的 isolate |

## 已知限制

| 限制 | 说明 |
|---|---|
| 主密码不可找回 | 无任何后门;忘记 = 数据无法恢复 |
| 服务器看不到内容 | 同理也**帮不了你**:只靠 `backup/` 滚动 10 份,更早的历史不保留 |
| 冲突不合并 | 密文不可合并;后保存方手动选择覆盖或以云端为准 |
| 文件名可读 | 分类名出现在 R2 对象键上(有意为之,便于人工辨认与抢救)。**这是本设计最大的元数据泄露面**:能读桶的人看得到分类名与文件大小,只是看不到内容 |
| 库外 `vault.json` 副本是离线靶子 | 它不受访问密钥门与限流保护;主密码强度就是那一刻的全部防线 |
| 禁止复制 `.enc` | 复制分类文件再编辑会破坏加密安全性(同钥同随机数);需要副本请在应用内操作 |
| 限流按 isolate 计 | 冷启动/换代/多机房各算一份,尽力而为而非硬保证 |
| 定时比较无法自动验证 | 时序性质测不出来(功能等价的写法结果一样),只能靠代码审阅 |
| 刷新需重输主密码 | 令牌只存内存,不做任何形式的「记住我」 |
| 公开仓库 ≠ 公开可读 | 代码公开不影响内容安全(零知识),但**站点入口不再是秘密**:一旦网址出现在 README/截图/公告里,`ACCESS_KEY` 与主密码就是唯一的门与锁 |
| 桶若被误开公开访问 | 全部密文可被直接下载,且 `ACCESS_KEY` 门会被整体绕过(门只拦 `/api/*`)。走 GitHub 流水线时第 5 步会自动查;手动部署请自己确认 |
| 附件单文件 ≤ 50MB,分类 ≤ 30MB | 超出会被 API 拒绝 |

## 开发

```bash
npm test                # 离线单测 69 项(加密/格式/库/渲染/Worker/端到端/部署配置),Node ≥ 22
npm run test:falsify    # 鉴伪:逐条破坏 22 个守卫 → 确认对应用例真的会变红 → 自动还原
npx wrangler dev        # 本地真实 Worker + R2 模拟
```

`npm test` 全绿不说明任何事 —— 它也可能是「用例写松了」。`falsify.mjs` 会故意破坏
限流、访问密钥门、翻页、硬化头、备份命名等 16 处守卫,任何一处没能让用例变红都会以
非零码退出。**改了安全相关代码,两个都要跑。**
