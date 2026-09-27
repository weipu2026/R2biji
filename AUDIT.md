# JMbiji 安全审计报告

- 日期:2026-09-24
- 范围:`public/`(前端 + 静态资源)、`worker/worker.js`、`dev-server.mjs`、`wrangler.toml`
- 形态:全部部署在 Cloudflare Workers 上,零知识(主密码不出浏览器)
- 方法:逐文件通读 + 受控实验(不靠「看起来像」) + 变异测试(改坏守卫确认用例真会红)
- 结论:**发现并修复 12 项;其中 1 项为「机制从未生效」级别(S1),2 项为「安全默认值/文档反了」级别(S2、S12)。**

---

## 交付摘要

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| S1 | 致命 | 防爆破限流**完全失效**(计数器挂在请求级 `env` 上) | 已修 + 回归用例钉住 |
| S2 | 高 | 访问密钥门「不设 = 没有门」,任何拿到网址者可下载 `vault.json` 离线爆破 | 已修(未设/过短 → fail closed 503) |
| S3 | 高 | 无 CSP、无安全响应头(一次 XSS 就能拿到访问密钥与令牌) | 已修(资产 `_headers` + API 硬化头 + 禁索引) |
| S4 | 中 | 令牌哈希与访问密钥用短路比较(可变时间比较) | 已修(定长比较 + 先哈希) |
| S5 | 中 | 适配层无条件把请求体读进内存(100MB body 可打爆 128MB isolate) | 已修(读前按 `content-length` 预检) |
| S6 | 中 | 限流生效后会新开一条「跨站借受害者 IP 把他锁 10 分钟」的路 | 已修(只对带凭据的失败计数 + 显式 405 预检) |
| S7 | 中 | 备份名只用毫秒时间戳,**同一毫秒的多份互相覆盖**;轮换还删不掉 | 已修(随机后缀 + 按原名删除) |
| S8 | 低 | R2 `list` 不翻页,第 1001 个对象在界面上消失 | 已修(游标翻页) |
| S9 | 低 | 迭代次数无上下限;落盘值可与实际派生值脱钩 | 已修(收口 + `weakKdf` 提示) |
| S10 | 低 | SW 不缓存 `/api/*` 仅靠「清单里没写」这一事实 | 已修(显式硬护栏 + 版本升 v4) |
| S11 | 低 | 本地 dev-server 共用同一个 `env`,与生产语义不一致(**正是它掩盖了 S1**) | 已修(每请求新 env) |
| S12 | 高 | 文档从未写明「R2 桶必须**私有**」。桶一旦被误开公开访问,全部密文可直接下载,且**门(S2)被整体绕过** | 已修(README 部署步骤加 ⛔ 硬警告 + DESIGN/AUDIT 同步) |

另有 1 项**已知缺口未修**,已在文末给出结论与理由:分类名明文出现在 R2 对象键上。

---

## S1 防爆破限流完全失效(致命)

**现象**:连续 15 次鉴权失败封该 IP 10 分钟的策略,在生产环境从未生效过一次。

**根因**:计数表挂在 `env` 上(`env.__authFails`)。
`env` 是**请求级对象** —— Cloudflare 文档明确写「环境变量按 per-Worker 且 per-request 应用」,
Workerd 的 WorkerEntrypoint 也是「每次调用新建实例」。请求一结束,计数器随之丢弃,
`n` 永远从 0 开始,阈值到不了。

**为什么一直没被发现**:单测复用了**同一个 `env` 对象**,于是计数在测试里被保留了 ——
用例是绿的,功能是死的。这是最危险的一类 bug:**测试在替 bug 打掩护**。

**证据(受控实验,两个假设各跑一遍)**:

| 假设 | 15 次失败后第 16 次的行为 |
|---|---|
| H1 `env` 跨请求共享(旧用例的假设) | 第 16 次 429 ✓ 挡住 |
| H2 `env` 每请求新建(生产语义) | 连 40 次都是 401,**一次都没挡住** |

**修复**:计数表改模块级(`const authFails = new Map()`),并顺带
① 容量上限 4096 条(防海量 IP 撑爆内存)② 429 带 `retry-after`
③ 成功即清零 ④ 新增回归用例「每请求一个新 env」——**该用例在修复前必然变红**(已用变异测试确认)。

---

## S2 访问密钥门「不设 = 没有门」(高)

**现象**:`env.ACCESS_KEY` 未设置时 `accessKeyOk()` 直接返回 `true`,于是
`GET /api/vault` 免鉴权返回 `vault.json`。任何拿到网址的人都能把它整个下载走,
**离线、不受任何限流约束**地穷举主密码。而原密码策略只要求 6 位。

**量化**(全部由本机实测反推,不引用未经核对的二手数字):

- 本机单核实测:PBKDF2-SHA256 100 万次 = **334ms** → 约 **3 次/秒/核**。
- 消费级独显对 SHA-256 类工作约为单核的 200~800 倍(按 hashcat `PBKDF2-HMAC-SHA256` 常见基准反推)→ **约 500~2500 次/秒/卡**。
- 6 位小写+数字 = 36⁶ ≈ 2.18×10⁹ 种 → **约 10~50 天**(单卡);多卡按倍数缩短;6 位纯小写(26⁶≈3.1×10⁸)→ 约 1.5~7 天。

结论不变:**网址一泄露 + 密码 6 位 = 一块显卡、十天量级的事**。
(初稿此处写作「2 万次/秒、约 30 小时」,是未实测的估值,偏高约一个数量级;已按实测重算。)

**修复**(三重):
1. **fail closed**:未设置或短于 16 字符 → 所有 `/api/*` 返回 503,并附上要执行的命令。宁可整站打不开,也不静默降级。
2. **密码策略**:≥10 位且估算熵 ≥64 bit(见 `DESIGN.md §5.1`),建库时实时显示弱/中/强。
3. **逃生开关**:`ALLOW_NO_ACCESS_KEY=1` 可显式放弃这层门(文档标注「强烈不推荐」)。

有意**没有**做的:把迭代次数翻倍。每翻一倍只多 1 bit,却让每次解锁多等一倍
(实测 100 万 = 336ms、200 万 = 672ms、400 万 = 1.3s,手机再乘 2~4 倍,而令牌只存内存、
刷新就要重来一次)。同样的预算花在「10 位以上 + 必设访问密钥」收益高一个数量级。

---

## S3 无 CSP、无安全响应头(高)

**现象**:静态资源只带 CF 默认头,API 只带 `no-store`。这个页面持有**明文全部笔记 +
DEK + 访问密钥(localStorage)+ Bearer 令牌(内存)**,一次 XSS 就是全库泄底。

**修复**:两层,缺一不可(CF 文档明确:`_headers` **不作用于 Worker 生成的响应**)

| 位置 | 内容 |
|---|---|
| `public/_headers` | 完整 CSP(`default-src 'none'` + `script-src 'self'` + `frame-ancestors 'none'` …)、HSTS、`nosniff`、`Referrer-Policy`、`Permissions-Policy`、COOP、`X-Robots-Tag: noindex`、`/sw.js` 与入口页 `no-cache` |
| `worker.js` 的 `SEC_HEADERS` | 所有 API 响应带 `nosniff` / `no-store` / `Referrer-Policy` / `X-Frame-Options` / `default-src 'none'; sandbox` |
| `public/robots.txt` | 全站禁索引 |

**上线前核查过(否则严格 CSP 会静默破样式)**:全站零 `innerHTML` / `insertAdjacentHTML` /
`document.write` / `eval`,零内联 `style` 属性,零 `@font-face` / 外部 `url()`。
所以 `script-src 'self'; style-src 'self'` 不会造成任何破坏 —— 这条是**核对过**的,不是猜的。

---

## S4 可变时间比较(中)

令牌哈希、访问密钥都用 `===`,长度不同立刻返回,相同则逐字节短路。
修复:

- 定长比较(`timingSafeEqual`):等长才逐字节异或累加,不提前返回;
- 访问密钥**两侧各取 SHA-256 再比定长摘要** —— 长度也不参与判断。

**诚实说明**:这个属性**无法用功能测试判别**(功能等价的写法给出完全相同的通过/拒绝结果),
所以 `tests/falsify.mjs` 里刻意**没有**为它列变异体,只靠代码审阅。写进 `DESIGN.md §11` 了。

---

## S5 / S6 内存打爆 与 跨站锁死(中)

- **S5**:适配层无条件 `await request.arrayBuffer()`。平台不替你拦(请求体上限 100MB),
  而 isolate 内存只有 128MB —— 一个 100MB 的 PUT 就够把实例打爆。
  修复:读之前先看 `content-length`,超过 50MB+1MB 直接 413。判据抽成纯函数 `declaredTooLarge()` 以便离线测。
- **S6**:这是**修好 S1 之后才暴露出来**的新路径 —— 限流一旦真的生效,任何网站
  只要让受害者的浏览器发 15 次失败请求,就能把他锁 10 分钟。
  修复:只统计「带着凭据来试」的失败。跨站页面能发起的只有不带自定义头的简单请求
  (带 `Authorization` / `X-Access-Key` 会触发 CORS 预检,而本服务**不返回任何 CORS 头** → 预检必败);
  并把 `OPTIONS` 显式定为 405,不落到「路由不匹配」的 404。

---

## S7 备份同毫秒互相覆盖(中)

**证据**:连续调用 12 次 `Date.now()`,得到 **1 个**不同的值。

**影响**:备份名 = `<分类名>.<毫秒>.enc` → 同一毫秒内的多份备份写的是同一个键,
**12 份只剩 1 份**。另外轮换时按 `base/ts` 重拼文件名,加后缀后根本删不掉。

**附带发现(值得单独记一笔)**:原来那条「备份保留上限 10 份」的用例是**偶发绿**的 ——
它能不能过取决于循环里两次 `Date.now()` 是否恰好跨毫秒。这类用例比不写还坏。

**修复**:备份名加 6 位随机后缀;`parseBackupFileName` 把**原文件名**一并带回,
轮换按原名删除;新增「同一毫秒 12 份必须互不顶掉」的用例。

---

## S8 / S9 / S10 / S11(低)

| 编号 | 问题 | 修复 |
|---|---|---|
| S8 | R2 `list` 单次上限 1000 条且不翻游标,第 1001 个分类/附件在界面上「凭空消失」(README 曾把它写成「已知限制」,其实是 bug) | `listAll()` 游标翻页;`MemoryR2` 加 `pageSize` 选项,用小页逼出翻页路径 |
| S9 | 迭代次数无上下限:被篡改的 `vault.json` 写 `1e15` 能冻死标签页;传 0/负数时**落盘值与实际派生值不一致** | `clampIterations`(非法 → 默认,上限 800 万)+ 落盘即派生值 + 低于 10 万在界面提示 |
| S10 | SW 不缓存 `/api/*` 只靠「`ASSETS` 清单里没写」这一事实 | 显式硬护栏 `if (pathname.startsWith('/api/')) return;`(密文一旦被 Cache Storage 留过一份,锁屏就形同虚设)+ 缓存版本升 v4 |
| S11 | dev-server 共用同一个 `env`,与生产语义不一致,且不设 `ACCESS_KEY` 时会被新策略 503 打回 | 每请求新建 `env`(与 CF 一致);本地默认开门并打印警告;静态响应头对齐生产 |

---

## S12 文档从未要求「桶必须私有」(高)

**问题**:README 的部署步骤、DESIGN 的存储布局、`wrangler.toml` 注释,全都没有一句话说明
R2 桶**必须保持私有**。而这几份文档的读者恰好是「刚做完 r2share」的你 ——
r2share 的架构**恰恰需要公开桶**(下载走公开直链不经 Worker),两个项目放在一起看,
把 `jmbiji-vault` 也开成公开访问是一个**极自然、且代价最大**的误操作。

**为什么它比 S2 更严重**:`ACCESS_KEY` 这道门只作用于 **`/api/*`**,
而公开桶的存取走的是 **r2.dev / 自定义域**,**根本不经过 Worker** → 门形同不存在。
后果是:

| 后果 | 说明 |
|---|---|
| 密文全量可下载 | `vault.json` + 全部分类密文 + 全部附件 + 全部备份 |
| 门被绕过 | S2 修好的 fail-closed 拦不住桶的公开端点,一次都不经过 Worker |
| 元数据公开 | 分类名(见文末「已知缺口」)从「能读桶的人可见」升级为**全网可见** |
| 无限次离线穷举 | 不受限流约束(限流在 Worker 里),爆破主密码没有速率上限 |

**核实过的事实**:本项目**从不需要**公开桶 —— 前端所有读写都走 Worker
(`GET/PUT /api/vault`、`GET/PUT/DELETE /api/blob`),`env.VAULT` 是**绑定**而非 S3 端点。
也就是说「私有桶」是零代价的正确配置,不存在功能取舍。

**修复**(文档 + 流水线强制执行):README 部署步骤加 ⛔ 显式警告
(不开 `r2.dev`、不绑自定义域、不启用 Public Access),并说明「为什么这里和 r2share 相反」;
DESIGN 已知限制同步。

**后续加码(2026-09-24 加 GitHub 一键部署时一并落地)**:这条从「文档警告」升级为
**CI 强制拦截**。工作流最后一步用官方 API 直接查状态:

| 检查 | 接口 | 判据 |
|---|---|---|
| r2.dev 公开域 | `GET /accounts/{id}/r2/buckets/{bucket}/domains/managed` | `result.enabled` 必须为 `false` |
| 桶的自定义域 | `GET /accounts/{id}/r2/buckets/{bucket}/domains/custom` | 必须为空列表 |

判定口径是刻意做成非对称的:**只对「已证实公开」判失败**;查不到(如 Token 缺 R2 只读权限)
只发 `::warning::` 并写进 Actions Summary 说明「未能判定」。
理由:R2 只读权限并非部署所必需,不该为一条检查项拦下合法部署;
但也绝不静默当作通过——「看起来没开」和「确认没开」必须区分开。

**为什么不能由 Worker 代码强制**:Worker 只能通过绑定访问对象,**读不到桶的公开访问配置**;
而为了自检去给 Worker 配一套 R2 S3 凭证,等于为了一个检查项新增一条持久的密钥面 ——
不划算。所以走「CI 用管理面 API 查 + 文档硬警告」这条唯一合理路径。

---

## 已核查、判定为非问题(避免误报)

| 项 | 结论 |
|---|---|
| HTML 注入 | 全站零 `innerHTML`/`document.write`;渲染器纯 `createElement`/`textContent`,`<script>` 只能当文本显示 |
| 附件 SVG 带脚本 | 只经 `<img src=blob:>` 展示(不执行脚本);下载后以 `file://` 打开也读不到站点 storage |
| CSRF 写操作 | 所有写操作都要自定义 `Authorization` 头 → 跨站必须过预检 → 预检 405,且任何响应都不带 CORS 头 |
| `vault.json` 内容 | 只有 salt / 迭代次数 / 被 AES-KW 包裹的 DEK / 鉴权哈希;不构成新的爆破面 |
| 建库被抢注 | 访问密钥必填后,只有持钥者能建库;建库本身也走 `If-None-Match: *` 仅一次 |
| 分类名 / 附件名注入 | 服务端白名单校验:分类名 ≤100 字符且禁 `/ \ ` 与控制字符;附件名必须是 43 字符 base64url(+可选扩展名) |
| 条件写失效 | `onlyIf` 用法已按 workerd 源码核实;`MemoryR2` 对不认识的选项静默忽略,恰好复刻真机陷阱,能防回归 |

---

## 部署 checklist 与唯一未修缺口的结论

1. **部署顺序不能反**:先 `npx wrangler secret put ACCESS_KEY`(≥16 个 ASCII 字符),再 `npx wrangler deploy`。
   没设就是整站 503 —— 这是设计如此。若之前已设过,则无感。
2. **桶保持私有**(S12):不要开 `r2.dev` 公开域、不绑自定义域、不启用 Public Access。
   本项目全部读写走 Worker,**私有桶零代价**。
3. **存储格式零变化**:本次改动不涉及 `vault.json`、`cats/`、`blobs/` 的任何格式,已有的库直接可用、无需迁移。
4. **本沙箱验证不到的部分**(必须在本机或 CI 跑):`wrangler dev`、`dev-server.mjs` 的端到端冒烟
   (此环境的 Node HTTP 解析器 llhttp 属 WASM,必然实例化失败)、以及真机 R2 的条件写行为。

### 唯一未修的缺口:分类名明文在 R2 对象键上 —— **结论:不修**

事实:键形如 `cats/<分类名>.enc`,所以能读桶的人看得到「秘钥」「攻略」这类名字与文件大小。
把键改成 `HMAC(分类名)` 技术可行,但**本次不做**,理由三条:

1. **它挡不住真正的对手**。能读桶者若同时能改代码/改配置,他可以在我下次打开网页时
   直接替换 Worker 拿走主密码 —— 那是任何云端零知识方案的共同上限,改键名对此毫无帮助。
   改键名只防「能读不能写」的窄窗口(只读令牌泄露、云厂商内部人员、取证传票)。
2. **代价是永久性的复杂度**:键不可逆 → 名字必须进密文内部 → rescan 要逐个拉取并解密所有分类文件、
   建库要维护映射、改名不再是零加密的文件改名、需要一次性迁移;而「用 R2 控制台人工抢救文件」
   这个便利会消失。与你定的「以简洁高效为主」直接冲突。
3. **有零成本替代**(按性价比排序,均为运营动作,无需改代码):
   分类名用中性串(`01`、`A`、`proj`)而非语义词;
   串行/并行分类的命名里不写敏感词;
   Cloudflare 账户开 2FA 且 R2 只读令牌不外发。
   只要桶保持私有,这条泄露面的实际暴露范围就只剩「你自己账号内的可见性」。

将来若要做,改动范围是:键改 `HMAC(分类名)` + 真名进密文 + `rescan` 逐文件解密 + 一次性迁移脚本;
`DESIGN.md §3` 的键布局与 §11 的已知限制需同步改。本次不做,已在此记录范围以备将来。

## 验证记录

| 项 | 结果 |
|---|---|
| 单测 | **69 项全绿**(加密 10 / 格式 11 / 库 9 / 渲染 6 / Worker 22 / 端到端 1 / 部署配置 10) |
| 变异测试 `tests/falsify.mjs` | **22 个变异体全部如期变红**,还原后复跑全绿 |
| 生成器分支干跑 | 12 个分支各跑一遍:5 个非法输入(缺密钥/过短/占位值/非 ASCII/桶名非法)全部 exit 1;7 个合法输入生成的 TOML 经 `tomllib` 解析通过,`workers_dev` 与 `custom_domain` 确为**布尔**而非字符串,生成物中无 `__` 占位符、无密钥字面量 |
| 受控实验(限流) | 修复前 H2 假设下 40 次不封;修复后第 16 次封并带 `retry-after` |
| 受控实验(备份命名) | 12 次 `Date.now()` = 1 个不同值 → 证实同毫秒覆盖,修复后 12 份互不顶掉 |
| 受控实验(PBKDF2) | 单核 100 万 334ms(≈3 次/秒/核)→ 反推消费级 GPU 约 500~2500 次/秒;据此**否决**了「加迭代次数」这个方案,也**修正了初稿里未经实测的「2 万次/秒」** |
| CSP 与真实资源核对 | 逐行核对 `index.html`:零内联 `<style>`/`<script>`/`style=` 属性/`<form>`/`<iframe>`;仅 3 个 `<link>`(icon/manifest/css)+ 1 个 `<script type="module" src>` → `script-src 'self'`、`manifest-src 'self'`、`form-action 'none'` 不会拦掉任何实际资源 |
| API 响应出口核对 | 逐处清点 `worker.js` 的 6 个响应构造点(`json`/`fail`/`binary`/`empty`/413/最终 `Response`),全部携带 `SEC_HEADERS`,无遗漏出口 |

---

## 附:GitHub 一键部署流水线的验证(2026-09-24 追加)

流水线里最关键的两段 shell —— **上线验收**与**桶可见性审计** —— 无法在受限沙箱里真跑
(需要真的部署、真的 API Token)。但它们的**判定逻辑**可以离线干跑:把 `run:` 块抠出来,
用**假 curl**(按参数返回预设响应)配合**伪造的 `wrangler.deploy.toml`**,逐场景验证。

14 个场景全部如期:验收侧 8 个(门装好 / 无密钥 200 / 密钥未同步 503 / 两边不一致 401 /
响应头缺失 / 库未建 404 / 自定义域 / 取子域 API 失败),审计侧 5 个(默认合规 / r2.dev 已开 /
绑了自定义域 / 查不到 403 / 自定义桶名)。

**干跑抓出三个真缺陷,都属于「好部署反而变红」或「错误信息不可诊断」一级**:

| 缺陷 | 根因 | 后果 |
|---|---|---|
| 取 `workers.dev` 子域失败时,自己写的友好提示永远打不出来 | `set -e` + `curl -f`:4xx/5xx 让赋值直接中止脚本,后面的 `if [ -z "$SUB" ]` 成了死代码 | CI 只留下一句 curl 的原始报错,看的人不知道该怎么办 |
| **桶没有自定义域时(最常见、也是完全正确的情形)审计步骤必然中止** | `grep -o` 未匹配时退出码为 1,`set -o pipefail` 让 `n_custom=$(… \| wc -l)` 整个赋值失败 | **配置越正确、流水线越红**;而且我最初那份「已通过」的判断是假的——它其实在报错 |
| 三处 `NAME=$(sed …)` 赋值同样会因生成物缺失而中止 | 同上 | 报的是 sed 的错,而不是「生成物缺失」 |

修复后把**教训固化成守卫**:`tests/deploy.test.mjs` 新增「赋值管道必须有兜底」——
在任何开了 `set -e` 的 `run:` 块里,`X=$(A | B | C)` 只要管道含非安全命令(`grep`/`curl` 等)
就必须有 `||` 兜底。这条规则自己也有两个坑,已写进注释:`sed` 脚本里的**转义竖线** `\|` 不是管道;
兜底形式也不止 `|| true`(`|| echo '{}'` 同样有效)。

**新增守卫清单**(共 10 条在 `tests/deploy.test.mjs`,5 条新增变异体,总数 22):

| 守卫 | 防的是 |
|---|---|
| 两端常量一致 | `MIN_ACCESS_KEY_LEN` 在 Worker 与 gen-config 改歪 → 本地放过、线上 503 |
| 模板锚点存在 | `gen:routes` 等注入点被删 → 注入静默失效 |
| 模板无真实域名 | 公开仓库里带着作者的域名 |
| 触发器白名单 | 混入 `pull_request*` / `issue_comment` / `workflow_run` → Secrets 交给陌生代码 |
| 权限最小 | 出现 `contents: write` |
| 密钥只经 env | 密钥被内联进 `run:` 脚本正文 |
| 上线验收未掏空 | 验收步骤不再真的带着密钥去请求 |
| **赋值管道有兜底** | 上表前两个缺陷原样复发 |
| gitignore 覆盖生成物 | 生成物 / `.dev.vars` 被提交进公开仓库 |
| npm deploy 用生成物 | 用模板部署 → 丢掉注入的域名与桶名 |

**边界(必须说清)**:以上全是**离线干跑**。整条流水线**尚未在 GitHub 上真正跑过一次**
(本地仓库还没有远端),所以「YAML 结构正确」「判定逻辑正确」是验过的,
而「CI 环境里 `npm ci` → wrangler 鉴权 → 真部署 → 真验收」这一段**只有首次 push 之后才知道**。

---

## 附:S13 孤儿清理 fail-open(2026-09-24 追加,数据丢失级)

**现象**:「清理未引用图片」在**某个分类读不出来**时,会把它引用的图片全部当孤儿**永久删除**。

**根因**:`lib.js` 的 `cleanupOrphanBlobs()` 里 `if (!cat.data) continue;` ——
读不出来的分类被**跳过**,它的引用不进 `refs`,于是它引用的每一张图都成了「孤儿」。

**为什么这条比 S1 更该怕**:S1 是防线失效(还能补救),这条是**直接删数据,且不可逆** ——
`DELETE /api/blob` 直接 `env.VAULT.delete()`,blob **没有 `backup/` 那一层**
(分类有滚动 10 份备份,图片一张都没有)。误删就是永久丢失。

**触发条件宽松到不需要故障**:一次瞬时 GET 失败就够(`loadCategory` 对网络错误同样会
置 `cat.error` 而让 `data` 留在 null),密文损坏当然也算。

**同类第二个口子**:`loadAllCategories()` 只遍历**本机内存里的分类清单**(解锁时拉的)。
别的设备此后新建的分类不在其中 → 它的图片同样被判成孤儿。多端是这个应用的核心用法,
所以这条不是理论风险。

**受控实验(修复前,真 worker.js + 真 lib.js + 内存 R2)**:

| 步骤 | 结果 |
|---|---|
| 设备 A 建分类 + 入库一张图 | R2 中存在 ✓ |
| 设备 B 全新解锁(内存无明文)后该分类密文损坏 | 读取失败:`文件过短或已截断` |
| 点「清理未引用图片」 | 报告删除 1 个,**R2 中图片已消失** ✗ |

**修复**(两处,均为 fail closed):

1. 先 `await this.rescan()` 刷新清单 —— 清点范围必须覆盖别的设备新建的分类;
2. 任一分类 `!cat.data` 时**抛错中止整次清理**(报出是哪几个分类),不再跳过。

**回归与变异**:`tests/e2e.test.mjs` 新增两条用例(读不出来必须中止 / 必须先刷新清单);
`tests/falsify.mjs` 新增两个变异体,各自只打中对应那一条,判别力精确。
单测总数 **69 → 71**,变异体 **22 → 24**,复跑全绿。

**残余窗口(已知未修)**:`rescan()` 到逐个删除之间(秒级)别的设备若恰好新建分类并附图,
仍可能误删。要更硬的保证需服务端标记-清扫,或给新 blob 设冷却期 —— 而冷却期必须用
**服务端时间**判定,否则客户端时钟偏移会让它形同虚设。已记入 `DESIGN.md §11`。

---

## 附:S14/S15 真机点出来的两个缺陷(2026-09-24 追加,加「记住本设备」时发现)

前两轮审计都只跑离线单测与代码审读。这次为了验证「打开即用」在**真实浏览器**里跑了一遍
完整流程(`node dev-server.mjs` + 真页面),当场点出两个离线测不到的缺陷。

### S14(高,功能静默失效)`modal()` 的「确定」按钮点了等于没点

**现象**:新建分类 / 重命名分类 / 修改主密码 —— 三个核心功能**点了完全没反应**,且**没有任何报错**。

**根因**:`mkBtn` 会无条件注册一个 `resolve(val)` 的点击监听;prompt 分支传入的 `val` 是 `null`,
之后才追加 `resolve(input.value)` 想覆盖它。但**先注册的先执行,而 Promise 只认第一次 resolve** ——
于是永远返回 `null`,调用方 `if (name == null) return;` 直接放弃。

**为什么 69 项单测全绿却没发现**:它们测的是 `Library.createCategory()` 这一层,
`modal()` 属于纯 DOM 层,离线套件**根本碰不到**。这条 bug 恰好落在测试覆盖的缝里。

**顺带证实**:按回车走的是另一条分支(`resolve(input.value)`),所以「回车能用、点按钮不能用」——
这种半可用状态最容易被误判成「我点错了」。

**修复**:`mkBtn` 改为 `val === undefined` 时不自动 resolve,由 prompt 分支自己接管。
**新增 `tests/dialog.test.mjs`**:用极简 DOM 替身把三种弹窗的「按钮 → 返回值」契约全部钉住
(prompt 确定/回车/取消、confirm 确定/删除/取消、conflict 三选一、以及「选完必须 close」)。

### S15(中,部署陷阱)改了前端却推不出去

**现象**:`public/` 下改了 js/css,部署后老用户**永远拿到旧代码**,表现为「部署了但界面没变」。

**根因**:`public/sw.js` 是 cache-first,而浏览器**只在 `sw.js` 文件本身变化时**才重新安装它。
改了被缓存的资源却不升 `CACHE` 版本号 → SW 不更新 → 缓存里的旧 js 一直生效。
(本 SW 原有的 `/api/*` 硬护栏没问题,问题在版本管理。)

**同时发现**:新加的 `public/js/session.js` 没登记进 `ASSETS` 清单 —— 联网时看不出来
(退化成普通请求照样能拉到),**只有离线才暴露,表现为整个应用白屏**。

**修复**:`CACHE` 升到 `v5`;`session.js` 登记进 `ASSETS`。
**新增 `tests/assets.test.mjs`**:自动核对「`ASSETS` 里每个文件都存在」与
「`public/js/` 下每个模块都已登记」——后者已实测(故意删掉 `session.js` 那一行,用例立刻变红)。
版本号本身**无法自动断言「有没有升」**,只能写进 `sw.js` 顶部与 `README` 的约定里。

### 验证记录(本轮)

| 项 | 结果 |
|---|---|
| 单测 | **92 项全绿**(原 69 → 71 → 79 → 92) |
| 变异测试 | **28 个变异体全部如期变红**,还原后复跑全绿 |
| 真机流程 | 建库 → 免密恢复 → 新建分类(点确定)→ 取消不误建 → 锁定清会话 → 刷新要求重新输密码,逐步核对 |
| 静态接线 | `ui.js` 引用的 42 个元素 id 与 `index.html` 一一对应,无重复、无遗漏 |

---

## 附:S16/S17 多标签页同步与全库备份(2026-09-24 追加)

不是缺陷,是两处**设计缺口**的补齐;顺带修正了一处与用户实际用法不匹配的设计前提。

### S16 备份分层里「库外」那一层其实是空的

**问题**:审计时把 `vault.json` 的库外副本当作「第 2 层备份」。但它是**只有钥匙、没有箱子** ——
桶被误删或账号出问题,那把钥匙打不开任何东西。而第 1 层(`backup/`)与第 3 层(R2 版本控制)
都**在同一个桶里**,跟着桶一起消失。也就是说:**真正的库外全量备份此前不存在。**

**修复**:侧栏新增「导出全库备份」/「从备份恢复」。
导出物是 `vault.json` + `cats/*.enc` + `blobs/*` 打成的**标准 store-only zip**
(`public/js/zip.js`,零依赖;密文不可压缩所以不压),全程不解密。
做成标准 zip 是为了人工抢救时双击就能看见内容,不需要先写解析器。

**恢复的保守规则**(宁可不恢复,也不要搞成「一半新一半旧」):

| 情形 | 行为 |
|---|---|
| 包里没有合法 `vault.json` | 拒绝(不是本应用的备份) |
| 目标桶里是**另一个库**(包裹的 DEK 不同) | **拒绝** —— 钥匙对不上,导进去只会得到一堆解不开的文件 |
| 分类已存在 | **跳过并如实报告**,绝不覆盖 |
| 附件已存在 | 去重(名字 = 内容寻址,天然幂等) |

**格式正确性由外部工具实测**:生成物经 `unzip -t`(No errors detected)与 Python `zipfile`
(`testzip()` 返回 None、中文名按 UTF-8 标志位正确解码、字节原样)双重验证 ——
不是「自己写自己读」的自证循环。

### S17 「笔记级三方合并」的前提不成立

原计划做 base 快照 + 逐条三方比对,以解决「两台设备各改各的」。但**用户是单人使用,
手机基本只读**,该场景几乎不出现;真正常见的是**同一台电脑开两个标签页**。
为不存在的场景写一个合并引擎(删除墓碑、排序收敛、附件引用都要打磨)不划算。

**改为多标签页同步**(`public/js/tabsync.js`,`BroadcastChannel`):
一个标签页保存/增删分类/锁定时,其他标签页立刻知道。冲突从源头消失,**没有任何静默覆盖的余地**。

★ 两条硬规则(已用变异测试钉住第 2 条):

1. 消息只当「去重新核对」的提示,**绝不当权威状态** —— 收到 `cats-changed` 一律 `rescan()`
   重新问服务器。即便消息是错的或来自同源恶意页面,最坏也只是多拉一次数据。
2. **本地有未保存改动时绝不自动刷新**,只提示「保存时会冲突」—— 自动刷新等于静默丢弃
   用户正在写的东西,比冲突弹窗糟得多。

### 验证记录(本轮)

| 项 | 结果 |
|---|---|
| 单测 | **120 项全绿**(69 → 71 → 79 → 92 → 119 → 120) |
| 变异测试 | **32 个变异体全部如期变红**,还原后复跑全绿 |
| 真机(导出) | 按钮 → 确认框报体积 → 下载 `jmbiji-backup-<日期>.zip`,912 字节、PK 魔数、中文分类名正确;**该真实产物经 `unzip -t` 全过** |
| 真机(导入) | 把该包喂回应用 → 「跳过已存在 2,图片 +0」,**一个都没覆盖**,正在编辑的内容原样还在 |
| 真机(同步) | 应用内新建分类 → 旁听通道收到 `{"type":"cats-changed"}`;干净态收 `cat-saved` → 自动重载;有未保存改动收同一条 → **只警告,编辑框内容仍在** |
| 静态接线 | 45 个元素 id 与 `index.html` 一一对应,无重复、无遗漏 |

## 第 18 轮:外部审计修复(2026-09-24)

针对一轮独立全库审计(Worker / 加密层 / 前端 UI / 渲染与测试四路并行)的修复记录。
审计结论:**无 P0** —— 密码学组合、零 innerHTML、CAS 边界、fail-closed 门等既有承诺全部成立;
但 120 项测试的覆盖缝里藏着 3 个 P1 与一批 P2/P3,本轮全部修复(「报告里说过的」不重复记录)。

### P1(真 BUG,已逐条对过原文)

1. **modal() 的 Esc 挂起**:Promise 只靠按钮/回车落定,原生 `showModal` 下按 Esc 直接关掉
   dialog → `await modal()` 永久挂起。保存冲突弹窗按 Esc 曾把 `S.saving` 卡成恒 true,
   Ctrl+S/自动保存/锁定前保存全部静默失效;boot 的访问密钥弹窗按 Esc 则页面永久卡锁屏。
   现以 `cancel` + `close` 事件 + `settled` 守卫兜底,Esc 等价「取消」。
2. **renameCategory 丢脏标记**:改名后 `S.dirty` 里还是旧名,未保存改动脱离保存队列,
   锁定/刷新后无提示丢失。现在脏标记跟随搬到新名(重命名只换键名,本地数据仍是最新)。
3. **lockNow 毁掉用户选择保留的改动**:冲突弹窗选「留待稍后」后照样 `S.dirty.clear()`。
   现在锁定前若仍有未保存改动,先弹确认(放弃并锁定 / 暂不锁定);远端锁定(另一标签页
   已结束会话)不问。「锁定必毁明文」的安全不变量保持:确认文案明说会放弃改动。

### P2(并发与安全面)

4. **鉴权前不读请求体**:适配层先 `arrayBuffer()` 全量读入再过门,未认证请求也能打满
   isolate 内存。现在传惰性取体函数,鉴权通过后才物化;PUT/POST 缺 Content-Length 一律
   411(chunked 绕过长度预检的口子一并封掉)。
5. **条件删除**:DELETE /api/cat 支持 If-Match(head 比对),不符 412;前端删除带本地 etag,
   没打开过的分类先补拉一次。以前设备 A 能把设备 B 刚保存的新版静默删掉。
6. **备份失败不连累主操作**:writeBackup 包 try/catch 只记日志 —— 主数据 CAS 已成功时,
   备份异常曾把整个请求拖成 5xx,客户端拿旧 etag 重试恒 412(死循环)。
7. **顶层 catch**:handleApiRequest 兜底返回结构化 500,不再让平台吐裸 1101 错误页。
8. **openCategory / runSearch 序号守卫**:慢请求后到不再覆盖用户后选的分类/新查询的结果。
9. **冲突「用我的版本覆盖」失败**:force 保存抛错时把分类放回 dirty,不再脱离保存队列。
10. **addAttachments 竞态**:上传途中 `cat.data` 被另一标签页换掉时,把已入库附件合并进
    最新数据对象,不再对旧引用解引用(TypeError、附件引用悬空)。
11. **改主密码升级 KDF 迭代**:rewrapVault 取 max(旧值, 当前默认) —— 偏弱库免费加码,
    只升不降(反正盐要换、KEK 要重派生,零额外成本)。
12. **键盘可达**:分类/笔记/搜索结果 Tab 聚焦 + Enter/空格触发;全部表单控件与图标按钮补
    aria-label。
13. **SW 混合态**:skipWaiting + claim 后 controllerchange 时刷新对齐(首次安装不刷)。
14. **移动端**:100dvh、safe-area-inset(侧栏底部按钮/toasts 不再被小白条遮)、
    viewport-fit=cover、hover:none 下操作按钮常显。

### P3(择要)

- addNote 忙态守卫 + try/catch(分类加载失败曾是无提示的 unhandled rejection;双击造两条);
- toggleAttachmentImage 双击竞态守卫;
- exportBackup 的 counts 改报**实际写入值**(以前报计划值,途中被删的对象会虚报)并加 4 路并发池;
- putVaultJson 防空 etag(以前拼出 `If-Match: ""` 恒 428 报错误导);请求 120s 超时;
  429 透出 retry-after;
- blobFileNameFor 扩展名过服务端白名单正则(「攻略.最终版」这类原名上传曾必 400);
- normalizeNoteData 保留未知字段(多端版本不同步时白名单重建不丢数据);
- 空白正文预览显示「(空)」;collectEditChanges 死变量;renderCategoryList 重复查询;
- gen-config 与 deploy.yml 双重拒绝 ACCESS_KEY 首尾空白(粘贴带空格曾致全站恒 401 且报错误导);
- HSTS 加 includeSubDomains;
- tests/deploy.test.mjs 归一 CRLF —— Windows(`core.autocrlf=true`)检出下曾必挂
  「没能定位 on: 触发器块」而 CI(Linux LF)能过。

### 明确不修(记录取舍)

- **apple-touch-icon**:需要真实 PNG 资源,离线无法高保真生成;SVG 图标 + manifest 已覆盖
  Android/桌面,iOS 添加主屏时降级为截图图标,待有设计资源再补。
- **改密码前对旧 vault.json 做服务端备份**:vault.json 只有钥匙没有内容,且前端已有
  自动下载兜底,收益有限。
- **deploy.yml 换 jq 解析 CF API 响应**:现有 sed 路径已在生产验证过,收益小于回归风险。

### 验证记录(本轮)

| 项 | 结果 |
|---|---|
| 单测 | **130 项全绿**(120 → 130:dialog +1 / worker +5 / vault +3 / e2e +1;含 1 项 Windows CRLF 假失败修复) |
| 反证 | 8 处修复逐条临时还原:**全部翻红**(411 预检 / 惰性取体 / 条件删除 / 备份容错 / Esc 落定 / rewrap 迭代 / 扩展名净化 / 未知字段保留),还原后复跑全绿 |
| 语法 | 全部改动文件 `node --check` 通过 |
| 行尾 | 仓库文件保持 CRLF,与既有约定一致 |

## 第 19 轮:全站审计(2026-09-25)—— **仅报告,未修复**

四路并行审查(Worker / 加密层 / 前端 UI / 渲染与测试基建),**每条发现都亲自复核取证**后才计入。
本轮共确认 **15 条**(1 P0 + 7 P1 + 5 P2 + 2 P3),另**排除 3 条误报**。
所有「实测」结论都是用仓库自身代码跑出来的,不是读代码推的。

> 本轮**只报告、未改任何代码** —— 见文末「下一步待用户拍板」。

### P0 —— 功能级损毁(实测复现)

**P0-1 `recover.html:333` 把 4 字节字段写成 2 字节 → 导出 zip 超过约 64KB 即损坏**

中央目录的「本地头偏移」是 **4 字节**字段(偏移 42),`public/js/zip.js:158` 写的是
`setUint32(42, offset, true)`,而 `recover.html:333` 写的是 `setUint16(42, offset, true)`。
用仓库自己的 `zipStore` 造一个 70KB 条目的包、把偏移字段高 2 字节清零(即 `setUint16` 的净效果),
再用仓库自己的 `readZipStore` 读回,实测:

```
条目 #1  真实偏移=0      读回=0      (未越界)
条目 #2  真实偏移=70037  读回=4501   <- 偏移被截断
[正确写法 setUint32(42,...)] 读回成功,条目=big.txt, small.txt
[recover.html 现状 setUint16(42,...)] 读回失败 -> 条目「small.txt」的本地头不对
```

**为什么这是 P0**:应急页存在的唯一意义就是「CF 被封那天把备份解开」,而
「一键打包下载 zip」(第 1459 行 `download('R2biji明文_*.zip', zipWriteEntries(entries))`)
正是它给用户的**兜底出口**。真实库(几十本笔记 + 附件)必然超过 64KB,
所以这条路径**在真正需要它的时刻必然失败**,且失败方式是「下载下来才发现打不开」——
用户此时已经没有别的退路了。

而 `tests/recover.test.mjs:146` 那条「产出的 zip 用项目 readZipStore 能读回」用的 fixture
**所有条目都远小于 64KB**,偏移恰好没越界 → 测试永远绿。

### P1 —— 真 BUG

**P1-1 `render.js:163` 有序列表丢内容(`ol[1]` 应为 `ol[2]`)**

```js
const ol = /^(\d{1,3}[.)]\s+|\d{1,3}、\s*)(.*)$/.exec(line);
listItems.push(ol[1]);   // ← 这里推的是「序号标记」
```
实测 `'1. 第一步:打款'` → `ol[1]="1. "`、`ol[2]="第一步:打款"`。
即**有序列表渲染出来只剩 `1. `,正文没了**。同函数的 `recover.html:1070` 写的是 `ol[2]`(正确),
两套实现分叉。

> **测试为什么没抓住**:`tests/render.test.mjs:68` 只断言了 `lists[1].tag === 'ol'` 和
> `children.length === 2`,**从不断言 `<li>` 的文本内容**。「结构对、内容错」是断言写法的盲区。

**P1-2 部署在站点上的 `recover.html` 会被自家 CSP 拦死(但离线双击不受影响)**

`public/_headers` 的 CSP 是 `script-src 'self'; style-src 'self'`,而 `recover.html` 里有
**2 段内联 `<style>` + 2 段内联 `<script>`**(第 7/133/728/888 行)。在带生产同款 CSP 的本地服务上
真实浏览器实测:

| 判据 | `recover.html` | 对照组 `index.html` |
|---|---|---|
| `typeof openJmb` | `undefined` | — |
| `document.styleSheets.length` | **0**(样式全丢) | 1 |
| CSP 拦截日志 | **5 条**(4× inline style + 1× inline script) | **0 条** |
| 背景色 | 透明(未上色) | 正常 `rgb(250,248,242)` |

→ 问题**精确定位在 recover.html 自己,不是 CSP 配错**(主应用在同款 CSP 下完全正常)。
`dev-server.mjs` 镜像的 CSP 与生产 `_headers` **逐字相同**(已比对)。

**为什么只算 P1,不算 P0**:该页的设计用途是「CF 被封那天**双击本地副本**打开」
(见引入提交 `51420c9` 的说明「单文件零依赖,双击即开」),而站点被封时用户本来也访问不到
部署副本;`public/` 下也无任何入口链接到它(`index.html`/`js/*`/`sw.js` 里 `recover` 零命中)。
**所以离线应急这条路照常可用**。受影响的仅是「站点还活着时,直接敲 URL 用它」这一条路径 ——
打开也是白屏且控制台报 CSP,容易被误判成「页面坏了」。

> ⚠️ **为什么 159 项测试全绿却看不到它**:两个浏览器冒烟(`recover-browser-smoke.mjs` /
> `reader-browser-smoke.mjs`)都用 **`file://`** 打开页面,**而 `file://` 不携带任何 HTTP 响应头
> → CSP 根本不生效**。测试跑的是「无 CSP 的 file:// 态」,站点跑的是「有 CSP 的 http 态」。
> 这条值得记住:**浏览器测试的协议选择本身就是一个未声明的假设**。

**P1-3 `SECRET_RE` 缺 `m` 标志 → 多行段落里的敏感行不遮罩**

`render.js:22` 的正则以 `^…$` 界定,但 `renderMarkdown` 把整段多行文本
用 `para.join('\n')` 合成一个字符串交给 `renderInline`(`render.js:96`)。
无 `m` 标志时 `^`/`$` 只匹配整串首尾,实测:

| 输入 | 结果 |
|---|---|
| 单行 `'登录密码: MySecret123'` | 已遮罩 ✓ |
| 多行(敏感行在第 2 行) | **未遮罩 ✗ 明文外露** |
| 同输入 + `m` 标志 | 已遮罩 ✓ |

**P1-4 `recover.html` 多处 `innerHTML` 拼接 zip 条目名 → XSS,且能读到主应用密钥**

`failures` / `warnings` 的每一项都是 `条目「${name}」…`,而 `name` **直接来自拖入的 zip**
(第 254/261/271/275/279/534/571 行),随后在 1387/1435 处拼进 `innerHTML`。

严重性在于同源:`recover.html` 与主应用**同源**,共享 `localStorage`,而
`public/js/session.js` 在「记住本设备」时把**裸 DEK** 明文存在 `jmbiji.session`(该文件注释自己
也讲明了这个安全边界)。→ 一个恶意备份包就能在用户拖入时读走 DEK。

对照:`public/js/render.js` 是**零 innerHTML** 的纯 DOM 构建(已核:`public/js/*.js` 里
`innerHTML` 出现 0 次),`recover.html` 是唯一破例处。

**P1-5 `lib.js:164` `renameCategory` 调 `API.deleteCat(oldName)` 未传 etag**

`deleteCategory:184` 传了 `cat.lastSeenEtag` 并且有详细注释解释为什么必须传,而
`renameCategory` 的删除半程**裸调**。`worker.js:287` 的 DELETE 是「带 If-Match 才校验」的语义
→ 不传就是无条件删 → **改名会把并发设备刚保存的新版静默删掉**,正是 `deleteCategory` 注释里
写明要避免的那个场景。

**P1-6 CI 完全不跑测试**

`.github/workflows/deploy.yml` 的步骤是 Validate → Deploy → Sync → Verify → Audit,
**没有 `npm test`**。全仓 grep `npm test|node --test` 在 `.github/` 下**零命中**。
→ 159 项测试只靠人工记得跑;一旦忘记,坏代码会一路部署上线。

**P1-7 `tests/falsify.mjs` **9 处**锚点失效 → 鉴伪套件恒红**

falsify 的锚点是硬编码字符串,代码改过就失配;失配时它打印 `[跳过] 锚点未找到` 并把 `bad += 1`,
最终**退出码 1**。实跑确认 9 条失效,横跨 4 个文件:

| 文件 | 失效锚点数 |
|---|---|
| `worker/worker.js` | 4(限流状态 / 硬化头 / 预检长度 / 附件体积) |
| `.github/workflows/deploy.yml` | 2(密钥内联 / 验收步骤) |
| `public/js/ui.js` | 1(已确认:`ui.js:109` 早改成 `settle(val)`,锚点还写着 `resolve(val)`) |
| `public/js/session.js` | 1(写入参数校验) |
| `public/sw.js` | 1(ASSETS 清单) |

**这意味着 falsify 现在是「永远失败」状态,作为守卫已完全失效** —— 红着的东西没人看。

> 附带踩坑(本轮亲历,必须记):`npm run test:falsify` 第二次运行时**被 SIGTERM 掐断在
> `finally` 还原之前**,把 `.github/workflows/deploy.yml` 留在「注入了 `pull_request_target`」
> 的变异态。已 `git checkout --` 还原并复核工作区干净。
> **教训:falsify 是「原地改写 + 还原」的破坏性脚本,中断就可能留下变异代码,跑完必须查 `git status`。**

### P2 —— 并发 / 边界 / 体验

**P2-1** `lib.js:107` `saveCategory` 对未知分类 `return { ok: true }` —— 分类不存在(或
   `cat.data` 为 null)时**谎报保存成功**,调用方 `saveAll` 据此把它从 `S.dirty` 移除 →
   改动静默脱离保存队列。达成条件是「dirty 集合与 data 同时为空」,当前触发路径窄
   (冲突弹窗选「以云端版本为准」会把 `data` 置 null 且不复置 dirty),**故列 P2 而非 P0**,
   但这个「成功」返回值本身是错的,建议改成 `{ skipped: true }` 或抛错。
**P2-2** `format.js:163` `genPassword` 的「保底」基本不起作用 —— 逻辑是「发现缺某类就
   `out[at] = next()`,但**不复检**」,而塞进去的那个字符未必属于缺的那一类。
   20 万次实测,至少缺一类的比例:

   | 长度 | 含符号 | 缺失率 | 最常缺 |
   |---|---|---|---|
   | 8 | 是 | **47.5%** | 数字 76k |
   | 12 | 是 | 27.1% | 数字 49k |
   | 16 | 是 | 16.6% | 数字 32k |

   即生成 8 位密码时近一半不含数字,而注释承诺「数字至少一个」。
**P2-3** `search.js:27` 搜索片段高亮错位 —— `snipOffset` 基于**原始**切片计算,随后
   `replace(/\s+/g,' ')` 压缩空白改变了长度,offset 不再指向匹配处。实测匹配词
   `admin123` 被高亮成了 `"妥善保存。"`(真实下标 16,算出来的 26)。
**P2-4** `worker.js:133` `listAll` 50 页硬上限静默截断 —— 注释只为「第 1001 个可⻅」而写,
    但 50 页 × 1000 = 50000 个对象后会**静默停止**,不报错。对个人库够用,属已知取舍。
**P2-5** `worker.js:287` `deleteCategory` 四步非原子(head → get → backup → delete)——
    head 比对通过后、delete 之前仍可被并发写插空。R2 的 delete 不支持条件参数,已被注释
    说明是「能做的最强校验」,属平台限制下的已知残差。

### P3 —— 冗余

**P3-1** `render.js:183` `notePlainText` 是死代码 —— 全仓引用 **0 次**(含测试)。
**P3-2** markdown 渲染两套实现长期分叉 —— `render.js` 的 `renderMarkdown`(98 行)与
    `recover.html` 的 `rdrMd`(约 115 行)是同一套逻辑的两份拷贝,**并且已经各自演化出差异**
    (P1-1 的 `ol[1]` vs `ol[2]` 就是分叉的产物)。加密原语同理(`crypto.js` 10 处 vs
    `recover.html` 18 处 WebCrypto 调用)。这是「单文件零依赖」的必然代价,
    但**每次改动都要两边同步**,建议至少加一条「两边输出等价」的对照测试兜住。

### 已排除的误报(复核后否决)

- ~~「`changeMasterPassword` 未同步 `vaultJson`」~~ —— **不成立**。`lib.js:200`
  明确有 `this.vaultJson = json;`,子代理读漏了。
- ~~「鉴权前就物化请求体」~~ —— **不成立**。`worker.js:497` 传的是惰性函数
  `body = () => request.arrayBuffer()…`,`putCategory`/`vault PUT` 内部才调 `bodyBytes(body)`,
  且 `handleApi` 的 Bearer 校验在第 387 行、早于任何取体。上一轮已修,子代理看的是旧印象。
- ~~`recover.html` 的 `@@DATA@@` 注入可被 `</script>` 逃逸~~ —— **不成立**。
  `recover.html:703` 对 blobs 做了 `.replace(/</g,'\\u003c')`;`catalog`/`dek` 等字段
  全是 base64/数字,不含 `<`。

### 隐私 / 凭据核查结论

| 检查项 | 结论 |
|---|---|
| 服务端是否见到明文 | **否**。Worker 全程只搬运密文,R2 对象名(`cats/*.enc`、`blobs/*`)不含明文标题 |
| 主密码是否会上传 | **否**。只在浏览器参与 PBKDF2;`vault.json` 只存 `auth.hash = SHA-256(authKey)` |
| 仓库内是否硬编码真实域名/密钥 | **否**。`wrangler.toml` 全是合法占位默认值;`.dev.vars` 已被 gitignore |
| 主应用是否零 `innerHTML` | **是**(`public/js/*.js` 命中 0 次),XSS 面只剩 `recover.html`(见 P1-3) |
| 浏览器侧明文残留 | `localStorage['jmbiji.session']` **存裸 DEK 明文**(设计如此,`session.js` 已声明);这正是 P1-3 值得修的原因 |
| 离线密码本是否零泄漏 | 阅读站内嵌的是密文,标题/正文/附件字节/附件原名全在密文里(上轮已验) |

### 验证记录(本轮)

| 项 | 结果 |
|---|---|
| 单测 | `npm test` **159 项全绿**(审计未改代码,这是审计前基线) |
| 复现手段 | 6 个一次性探针(`.probe-*.mjs`),全部用仓库自身模块跑,跑完已删除 |
| CSP | 真实 Edge headless + CDP,在带生产同款 CSP 的本地服务上实测;含主应用对照组 |
| 变异测试 | `npm run test:falsify` → **退出码 1,9 处锚点失效**(确认已失效,非本轮引入) |
| 工作区 | 清理探针后 `git status` 干净(中途已还原被 falsify 遗留的 `deploy.yml` 变异) |

### 优化建议(非缺陷,按性价比排序)

1. **给测试补「内容断言」而不只是「结构断言」** —— P1-1 能活下来,是因为 `<ol>` 的断言只查
   tag 与子元素个数。建议凡是渲染类用例,都对 `textContent` 落一条断言。
2. **给 falsify 加自检:锚点失配即整体报错退出** —— 现在 9 处失配却只在日志里逐条 `[跳过]`,
   套件恒红就被当噪音忽略。更好的是**把锚点改成从源码里按语义定位**(如 `find` + 正则),
   或至少在失配数 > 0 时打印一行「本套件已失效,守卫不成立」的醒目结论。
3. **浏览器测试改用 http 服务而非 `file://`** —— 否则 CSP / 安全响应头这一类
   「只在 HTTP 下存在」的问题永远测不到(P1-2 就是这么漏的)。成本很低:
   `dev-server.mjs` 已经在镜像生产头,直接指向它即可。
4. **`recover.html` 补一条大文件用例** —— fixture 里放一个 >64KB 的条目,
   P0-1 这类「字段宽度写错」的问题就能被测试挡住。
5. **CI 里加一步 `npm test`** —— 放在 Deploy 之前。风险提示:159 项目前全绿,加进去是安全的。
6. **`recover.html` 的 `innerHTML` 收口** —— 与主应用保持一致改用 `textContent` +
   `createElement`(仓库里已有成熟写法可抄),顺手把 P1-4 消掉。
7. **两边 markdown 实现加「输出等价」对照测试** —— 防止继续分叉。

### 下一步待用户拍板

本轮**只出报告,未改任何代码**(工作区除本文件外干净)。可选修复范围:

| 选项 | 覆盖内容 | 风险 |
|---|---|---|
| A. 只修 P0 | `recover.html:333` 一处改 `setUint16`→`setUint32`,补大文件用例 | 极低,改动 ~2 行 |
| B. P0 + P1 | 再加有序列表、`SECRET_RE` 的 `m`、`recover.html` XSS 收口、`renameCategory` etag、CI 加测试、falsify 锚点 | 低,均为局部改动 |
| C. 全修(含 P2/P3) | 再加 `saveCategory` 返回值语义、密码生成器重写(用洗牌保证各类至少一个)、搜索 offset 对齐、死代码清理 | 中,密码生成器与搜索属逻辑重写,需带反证测试 |
| D. 先只做「测试基建」三项 | 内容断言 + 浏览器测试改 http + CI 加 `npm test` | 低,但会立刻暴露更多既有问题 |

我的建议:**先做 D,再做 A/B** —— 测试基建不修好,后面每次修复都缺少可靠的判据;
尤其 falsify 现在已经失效,等于变异测试这道防线是空的。
### 第 19 轮修复记录(2026-09-25,当天全修)—— 15 条全部修复并验证

上一节为审计报告(仅报告);同日用户拍板「全修 P0~P3 一波流」,以下为修复与验证记录。

**源码修复(12 文件,24 处补丁,全部带命中断言应用)**:

| 条目 | 修复 |
|---|---|
| P0-1 | recover.html setUint16→**setUint32**(4 字节偏移字段);补 >64KB 条目回归用例 |
| P1-1 | render.js ol[1]→**ol[2]**;render.test 补 li 文本内容断言 |
| P1-2 | _headers 对 /recover.html 单独放宽 CSP(内联页是「双击即用」设计,不能拆外部资源);dev-server.mjs 镜像同款按路径头。真机 Edge 实测:openJmb=function、styleSheets=1、着色正常、拦截 0 条(修复前 5 条) |
| P1-3 | SECRET_RE 加 **m** 标志;render.test 补多行段落敏感行用例 |
| P1-4 | recover.html 全部动态 innerHTML 拼接处包 rdrEsc()(zip 条目名来自不可信包,同源可读裸 DEK) |
| P1-5 | renameCategory 删除半程改传 **got.etag**(刚 get 的服务器当前版本),不再无条件删 |
| P1-6 | deploy.yml 在 Deploy 前加 **npm test** 步骤(测试不绿不上线) |
| P1-7 | falsify.mjs 锚点匹配改为**行尾自适应**(CRLF 文件上 
 锚点全部失配,9 处失效里 8 处是这个根因);ui.js 锚点 resolve→settle。实跑恢复「全部守卫具备判别力 ✓」退出码 0 |
| P2-1 | saveCategory 无内存数据时如实返回 {skipped:true}(不再谎报 ok);saveAll 与冲突「以云端为准」分支配套清理 dirty |
| P2-2 | genPassword 重写为**洗牌法**:每类先各取一个+全池补齐+Fisher-Yates,类别保证是构造出来的;测试升级为 300 次统计断言 |
| P2-3 | search.js snipOffset 在压缩空白后的串上重新定位;新建 tests/search.test.mjs(4 用例) |
| P2-4 | listAll 到 50 页上限时 console.warn 出声(不再静默截断) |
| P2-5 | deleteCategory 在 delete 前终检一次 etag,把 TOCTOU 窗口压到极限(R2 delete 无条件参数,平台限制) |
| P3-1 | 删除 notePlainText 死代码(全仓引用 0) |
| P3-2 | 双实现对账靠既有互证测试 + 本轮补的 ol 内容断言;完整合并留待后续(单文件设计所致) |

**验证记录**:

| 项 | 结果 |
|---|---|
| 单测 | npm test **165 项全绿**(159 → +6:search 4、大 zip 1、多行遮罩 1) |
| 判别力 | 5 条核心修复逐条改回旧写法,**全部如期翻红**且还原后 sha 一致 |
| 变异测试 | npm run test:falsify 退出码 **0**,全部守卫具备判别力(修复前恒红 9 处) |
| CSP 真机 | Edge headless + CDP:recover.html 完整可用、index.html 仍严格、拦截 0 条 |
| 工作区 | 探针全部清理,git status 只剩预期修复文件 |


---

## 第 20 轮审计(2026-09-26)· 全站复查:缺陷 + 逻辑错误 + 冗余 + 升级建议

> 方法:三路并行子代理侦察 → **逐条复核(读原文 + 跑探针定论)**。
> 子代理结论一律视为假设,本轮据此**否决了 4 条误报**(见下),并**证伪了自己一度以为的 P0**。

### 已实测确认的缺陷

| # | 位置 | 级别 | 问题 | 证据 |
|---|---|---|---|---|
| 1 | `ui.js:466-496` lockNow | P2 | 锁屏只 `stopIdleTimer()`,**不清 `S.autoSaveTimer`** → 锁屏后 4 秒定时器仍触发 `saveAll()`(靠 `if(!S.lib)return` 兜住,无数据损坏,但属计时器泄漏) | 真机 CDP 劫持 setTimeout:created:8521 / fired:12529(锁屏 ~8600) |
| 2 | `worker.js:272-288` putCategory | **P1** | `If-Match: *` 未被识别为通配,**绕过 CAS 直接覆盖** | probe 实测 status=200,读回为通配符覆盖内容 |
| 3 | `worker.js:294-320` deleteCategory | **P1** | **不带 `If-Match` 时跳过全部校验无条件删**(PUT 有 428 守卫,DELETE 没有);带 `*` 反而 412 | probe:无头 → 204 真删;带 `*` → 412 |
| 4 | `worker.js:430/455` | P2 | 非法 UTF-8 键 `%FF` 与真 U+FFFD 归一成同一 key | `%FF` 建 201 → 真 U+FFFD 得 409「已存在」 |
| 5 | `worker.js:221-225` validCatName | P2 | 服务端零 HTML 元字符校验、不做 Unicode NFC 归一、不查大小写冲突 | `<img src=x onerror=...>` 201 落盘;`café`(NFC) 与 `cafe´`(NFD) 并存;路径穿越 `../` → 400 正确拦 |
| 6 | `recover.html:1000` RDR_SECRET_RE | **P1** | 与 `render.js:22` 分叉:**缺 `m` 标志** → 多行段落里非首行的敏感行**不遮罩、明文泄漏** | 真实部署串下:段落内第 2 行敏感值原样输出;render.js 同输入正常遮罩(其源码注释明确写了加 m 的理由) |
| 7 | `style.css:978-979` toast | P2 | 暗色下 `.toast-error/.toast-warn` 硬编码 `#fff` 文字,**对比度 3.15:1 / 2.49:1**,低于 WCAG AA(4.5:1);亮色正常(7.07/5.86) | 亮度公式计算 |
| 8 | `style.css:1034-1036` reduced-motion | P2 | `* { animation: none !important }` 把**加载 spinner 也停转** → 减弱动画用户看到「卡住」 | 源码 |
| 9 | `ui.js:276-282` refreshSaveStatus | P2 | 800ms 防抖窗口内,若此刻 `dirty.size===0`(如保存失败已清 dirty),会用「已保存」**覆盖刚显示的错误状态** | 源码 + SAVE_DEBOUNCE_MS=800 |
| 10 | `index.html` | P3 | 无 `<noscript>` 回退;禁用 JS 时白屏无提示 | grep 计数 0 |

### 已排除的误报(复核后否决)

| 子代理结论 | 否决理由 |
|---|---|
| P0-1 `saveAll` 把 `res.skipped` 当成功清 dirty | `markDirty` 全部 9 处调用点都在 `activeNoteData()/categoryInfo()` 返回的**活对象守卫内**;`cat.data===null` 时 `addAttachments` 走 warn 分支**根本不调 markDirty** → 不可达 |
| P0-2 `recover.html` 里 `\\n` 是字面双反斜杠 → reader 全会崩 | **我自己的误判**:从**源码**抽取拿到的是**未求值的模板原文**;`READER_TEMPLATE` 是模板串,`\\n` **求值后正是 `\n`**。用真实部署串重跑,reader 10 项断言**全 PASS**。⚠️ 教训:抽 reader 段**必须从 `READER_TEMPLATE` 的求值结果抽**,不能从 recover.html 源码直切(测试注释早已写明) |
| SVG 附件 blob: XSS 可读 accessKey | 真机 Edge 三条对照实验:`image/svg+xml` blob 加载后 `document.title` 未变、localStorage 无被窃值;`<object>` 同;`application/octet-stream` 对照同 → **CSP `script-src 'self'` 不允许 blob: 内联脚本**。降级为「若将来放宽 CSP 则变可利用」的潜在风险 |
| `style.css:583` `.pinned:not(.active)` 特异性抬高覆盖选中态 | **是刻意设计**:作者用 `:not(.active)` **主动排除**选中态,让 `.active`(有独立 `--sel` 底)胜出,避免特异性打架 |
| J/K 快捷键漏守卫 | 子代理自查已撤回(守卫含 !e.shiftKey、焦点检查、searchPanel 检查、S.editing 检查) |
| `addAttachments` 并发重复引用 | 上传后合并 + 内容寻址去重,已堵住 |

### 验证方式
- 缺陷 1:真机 CDP 劫持 `setTimeout` 记录创建/触发时间戳
- 缺陷 2/3/4/5:以仓库自身 `handleApi` 写 probe(带完整 Bearer 鉴权),走真实 R2 mock
- 缺陷 6:从 `READER_TEMPLATE` **求值**后抽取 reader 段,与 `render.js` 同输入对照
- 缺陷 7:WCAG 亮度对比度公式核算
- **审计全程未修改任何产品文件**;探针脚本已全部清理,`git status` 仅剩既有改动

### 第 20 轮 · 修复落地(用户选「全修含 P3」)

| 缺陷 | 修复 | 位置 | 验证 |
|---|---|---|---|
| P1-2 If-Match:* 绕过 CAS | 抽 `readIfMatch()`,`*` 一律 428 不当通配 | worker.js | 单测 #17 + 真机 e2e |
| P1-3 DELETE 无条件删 | 强制 If-Match(缺头/`*` → 428),与 PUT 对齐 | worker.js | 单测 #22 + 真机 e2e |
| P1-1 reader 敏感行泄漏 | RDR_SECRET_RE 补 `m` 标志 | recover.html | 单测 #6 + 反向探针翻红 |
| P2-4 %FF 键归一冲突 | 拒 U+FFFD 名 | worker.js | 单测 #20 + 真机 e2e |
| P2-5 分类名校验空洞 | NFC 归一 + 拒 HTML 元字符/空白/控制字符;拦大小写重名 | worker.js + format.js | 单测 #18/#19/#20 + 真机 e2e |
| P2-1 lockNow 计时器泄漏 | 补 clearTimeout(autoSaveTimer/statusTimer) | ui.js | 代码复核 |
| P2-6 toast 对比度不足 | 走 `--toast-*-fg` 变量(暗色 4.80/5.56:1) | style.css | assets 护栏 #8 + 反向探针 |
| P2-7 spinner 被停转 | `*:not(.spinner)` + 单独保留 | style.css | assets 护栏 #7 + 反向探针 |
| P2-3 状态被防抖覆盖 | `statusAllowsOverride` 优先级(error 粘性) | format.js + ui.js | format 单测 #15 + 反向探针 |
| P3-1 无 noscript | 补回退(样式走外部 CSS,规避 CSP) | index.html + style.css | assets 护栏 #6 |

```
npm test          → 180/180 全绿(175 基线 + 5 组新用例)
npm run test:falsify → 新守卫全部有判别力(唯一红灯为既存 falsify.mjs:251,与本次无关)
真机 e2e          → 13/13 通过(dev-server + 真实 HTTP,覆盖 5 条 worker 修复)
反向探针          → 4 条注入全部如期翻红,还原后复绿
工作区            → 探针全清;diff 均小范围,无整文件行尾重写
```

---

## 第 21 轮:`busy` 粘性回归 —— 保存成功后状态栏永久卡在「保存中…」(2026-09-27)

> 发现路径:为「允许重构」先建 S0 行为快照护栏(真实浏览器 CDP 驱动完整流程),
> 护栏首跑即抓到此缺陷。**证明:纯 node 单测与既有 e2e 都覆盖不到它** —— ui.js 此前零测试覆盖。

### 缺陷(用户可见,P1)

**现象**:新建笔记 → 点「保存」→ 云端 PUT 全部 200 成功、内容确实落盘,
但顶部状态栏**永远停在「保存中…」**,8 秒以上不消失。用户会以为没存上。

**根因(上一轮修复引入的回归)**:第 20 轮为修「error 被 800ms 防抖的『已保存』盖掉」
引入了优先级守卫 `statusAllowsOverride(currentRank, nextKind)`,但把 **busy 也当成了粘性状态**:

```
saveAll():  setStatus('保存中…', 'busy')   → statusRank = 2
            ...保存成功...
            refreshSaveStatus() → 800ms 后 setStatus('已保存', 'ok')   ← rank 0
守卫判定:   currentRank(2) <= 0 ? 否 ; rank(0) >= 2 ? 否  →  return false 被拒
```

状态栏从此只能等**用户再次编辑**(markDirty → resetStatusPriority)才解冻。

**为什么单测没拦住**:第 20 轮新增的单测里有一条
`assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'ok'), false)`
—— 它把「busy 拦住 ok」**当成了期望行为**并固化下来。
这是典型的「测试固化了错误行为」:全绿不等于正确。

### 证据链(全部实测,非推断)

| 实验 | 结果 |
|---|---|
| 拦截页面 fetch,记录保存阶段请求 | `PUT /api/cat?...` → 200,`PUT /api/vault` → 200(**保存确实成功**) |
| 采样状态栏 8 秒(每 200ms) | 恒为 `保存中… / kind=busy`,从未变「已保存」 |
| 保存后再敲一个字(`markDirty`) | 立刻变为「有未保存更改」→ **证明是守卫粘住,而非 UI 未刷新** |
| 模态框是否打开 | false(排除 handleConflict 等待用户) |

### 修复

引入「权威终态」概念:`refreshSaveStatus` 的写入反映保存流水线跑完后的**真实结果**,
允许覆盖过渡态 busy/dirty,**但永远不许覆盖 error**(error 仍粘性,假绿问题不回退)。

```js
// format.js
export function statusAllowsOverride(currentRank, nextKind, authoritative = false) {
  const rank = STATUS_RANK[nextKind] ?? 0;
  if (currentRank <= 0) return true;
  if (currentRank === STATUS_RANK.error) return rank >= STATUS_RANK.error; // error 唯一粘性
  if (authoritative) return true;                                          // 权威终态可收尾
  return rank >= currentRank;
}
```

```js
// ui.js refreshSaveStatus: 传 authoritative=true
if (S.dirty.size > 0) setStatus('有未保存更改', 'dirty', true);
else setStatus('已保存', 'ok', true);
```

### 验证(正反双向)

```
npm test                         → 181/181 全绿(180 基线 + 新增 1 条)
S0 行为快照(CDP 真机)           → 30/30 全绿(修复前 24/26,2 条红即此缺陷)
反向探针 A:ui.js 去掉 authoritative → 单测仍 181 绿(纯函数未变,证明单测抓不到)
                                     CDP 护栏翻红(卡在「保存完成」超时)✓ 有判别力
反向探针 B:format.js 注释掉 authoritative → 单测 #73 精确翻红 ✓ 有判别力
还原后 sha1 比对                 → 与修复版逐字节一致
行尾复核                         → format.js/ui.js 纯 CRLF;format.test.mjs 保持 LF;无整文件重写
```

### 副产物:S0 行为快照护栏(重构前哨)

位置 `.ui-tests/`(被 gitignore,不进仓库):
- `cdp.mjs` —— 零依赖 CDP 驱动器(Edge headless,自建 WebSocket + Page/Runtime 域)
- `s0-guardrail.mjs` —— 11 大节、30 条断言,覆盖:冷启动锁屏 → 建库 → 建分类 →
  建笔记保存 → 阅读渲染(Markdown) → 搜索(含点击跳转) → 主题切换 →
  刷新后数据仍在 → 锁定 → 解锁 → 错误密码被拒

**跑法**:`node .ui-tests/s0-guardrail.mjs`(脚本内自启 dev-server,跑完自动收尾)。

---

## 第 22 轮:S1/S2 重构落地 —— 状态收口 + 三个 feature 抽出(2026-09-27)

> 用户授权「方案 A」全量重构(分 5 阶段,S0 护栏先行)。本轮完成 **S1 + S2**。
> 每阶段结束都跑「单测 + S0 真机护栏」双绿才进下一阶段。

### S1:会话态收口到 store(272 处访问点零改动)

**问题**:`ui.js` 散着 245 处 `S.xxx` 直访(226 读 + 46 写,共 272 处引用),
改状态的地方与读状态的地方混在 2000 行文件里,「设了值但忘了刷 UI」没有任何机制兜底。

**方案(用户选 Proxy)**:新增 `public/js/store.js`(Store 类 + `createProxy` 工厂),
`ui.js` 里 `const S = createProxy(store)` —— **272 处访问点一字未改**,
行为 100% 等价,但状态已汇聚进单一容器且可订阅(`subscribe` / `subscribeAny` / `patch`)。

**关键设计**:
- `set()` 做**值相等短路**(`Object.is`)。这是订阅机制的安全底线 ——
  没有它,订阅回调里 `set` 同值会直接把调用链打成死循环。
- 已知契约:**原地修改容器/对象属性不触发通知**(`S.dirty.add()` / `S.settings.x = 1`)。
  既有代码就是这么用的,故行为不变;但 S3 引入订阅时,凡被订阅的字段必须**整体换新对象**。
  该契约已用单测钉住(不是隐性陷阱)。
- `defaultState()` 是字段的单一出处,含 5 个流程控制字段(saving/resavePending/三个 timer),
  因为经 Proxy 读写都会落进 store,与其留成隐式字段不如显式声明、由单测「字段齐全」护栏兜住。

### S2:抽出三个 feature(ui.js 1971 → 1782 行)

引入 `ctx`(feature 上下文)概念:`ui.js` 把共享基础设施注入给 feature,
feature **不碰 ui.js 私有变量**(否则会循环依赖)。

| feature | 行数 | 依赖 ctx |
|---|---|---|
| `features/theme.js` | 58 | dom, icons(**零 store 依赖,故最先抽**) |
| `features/search.js` | 70 | + store, openNote, renderCategoryList, clickable |
| `features/data.js` | 181 | + modal, markDirty, renderNoteList, activeNoteData, copyText, downloadBytes |

抽取顺序按「依赖从少到多」,不是原计划的 search→data→shell —— 先抽零依赖的 theme 验证模式跑通。

### ⚠️ 本轮发现并修复的两个守卫盲区

1. **`assets.test.mjs` 只扫 `public/js/` 顶层,不递归** → `features/` 子目录里的模块
   漏登记进 SW `ASSETS` 时**全绿放过**(离线才白屏)。已改为**递归遍历**,
   并用探针验证判别力(精确报出 `features/theme.js`)。
2. **`createProxy` 完全没有单测覆盖** → 探针把 proxy 的 `set` 改成静默丢弃后,
   单测 192 全绿而只有真机护栏翻红。已补 3 条用例(含「写入必须真的落进 store」)。

### 新增守卫(共 3 个文件 / 28 条用例)

- `tests/store.test.mjs`(14 条):短路语义、防递归、patch 原子性、订阅异常隔离、
  原地修改契约、`createProxy` 读写与通知、默认字段齐全。
- `tests/features.test.mjs`(5 条):feature 不得 import ui.js(防循环依赖)、
  引用的 `ctx.xxx` 必须已注入、`ui.js` 的 ctx 字段与测试里的 `CTX_KEYS` **双向对账**、
  每个 feature 必须被 ui.js import(防「拆出去没接上」)。
- `tests/assets.test.mjs`(改):递归扫描。

### 验证(每阶段双绿)

```
S1 后:  单测 195/195  ·  S0 真机护栏 30/30
S2 后:  单测 200/200  ·  S0 真机护栏 30/30
反向探针(全部如期翻红):
  · store 去掉 Object.is 短路        → 单测 2 条红(短路 + 防递归)
  · store 的 proxy set 丢弃写入      → 补测前:单测全绿(盲区!)+ 护栏红;补测后:单测 3 条红
  · sw.js 移除 features/theme.js     → assets 递归守卫红
  · feature 引用 ctx.notInjected     → features 契约守卫红
  · ui.js 删掉 data.js 的 import     → features「必须 import」守卫红
行尾复核:新增 6 个文件全部 CRLF(与 public/** 一致);无整文件重写
```

### ⚠️ 又一次真实教训:反向探针用中文标识符 → 假绿

验证「feature 引用未注入的 ctx 字段」时,第一次注入写的是 `ctx.不存在的字段` ——
而守卫的正则是 `/ctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g`,**中文标识符不匹配** → 测试全绿,
看起来像「守卫没判别力」。改用 ASCII 的 `ctx.notInjected` 后精确翻红。
**教训:反向探针跑出全绿时,第一反应必须是「注入是否真的生效」,而不是「守卫无效」或「问题已解决」。**

### 剩余阶段

- **S4**:`ui.js` 只剩薄壳 controller;删兼容层;核对 ASSETS;线上逐字节比对


---

## S3 落地(抽核心 feature:lock / sidebar / note)

`ui.js` **1782 → 1077 行**(-40%)。三个 feature 全部抽出并三重验证(单测 + 真机护栏 + 反向探针)。

| 模块 | 行数 | 迁出的区块 |
|---|---|---|
| `features/lock.js` | 261 | 锁屏 / 记住本设备 / 解锁建库 **+ `resumeSession`**(与解锁同属密钥生命周期) |
| `features/sidebar.js` | 346 | 左侧分类列 + 笔记列表 |
| `features/note.js` | 318 | 阅读视图 + 编辑视图 + 笔记增删排序 |

### 抓到的两个真缺陷(单测都看不见,只有真机护栏抓到)

1. **`S.set(...)` TypeError**
   `S = createProxy(store)` 是 **Proxy,只有属性赋值会触发写入,没有 `set()` / `get()` 方法**。
   我把 `S.vaultJson = res.json` 改成 `S.set('vaultJson', res.json)` 后,护栏「刷新后自动回到应用」
   「用原主密码可解锁」两条翻红。
   ⚠️ **更隐蔽的一面**:`S.get('x')` 不报错,而是**静默返回 `undefined`**(Proxy 的 `get` 陷阱
   把它当成字段名 `get` 去查)。诊断期我就踩了一次:`window.__diagStore = S` 后调 `S.get(...)`
   报 `S.get is not a function` —— 因为我暴露的是 **Proxy** 而非原始 `store`。
   → **面向 feature 注入的永远是原始 `store`(有 `.get`);`S` 只在 ui.js 内部用。**

2. **`renderNoteList` 漏掉 `F.sortNotes`(排序改动在界面上不可见)**
   `moveNote` 正确交换了各项的 `order` 值,`sortNotes` 也能正确排序,但 `renderNoteList`
   直接遍历 `cat.data.notes` 的**存储顺序** → 用户点「上移」**界面纹丝不动**,
   要等下次从密文重载才看见效果。
   真机取证的现场:store 里 `orders = [2000, 1000]`(已互换),而 DOM 顺序仍是 `[一, 二]`。
   修法:`const notes = F.sortNotes(cat.data.notes)` —— **与同文件 `moveNoteSelection`(:341) 同源**,
   视觉第几行就是第几个。

### ctx 注入的两条硬约定(写进 code 注释)

- **feature 之间不互相 import**,循环依赖由 ui.js 的 `ctx` 解开。
- **ctx 里的跨模块入口必须绑定 ctx**:`openNote: (id) => openNote(ctx, id)`。
  若直接注入裸函数引用,feature 内部写 `ctx.activeNoteData()`(无参)会拿到 `undefined` 作 ctx
  → `TypeError: Cannot read properties of undefined (reading 'store')`。本轮实测:护栏 **9 条同时翻红**
  (编辑态 / 阅读视图 / 搜索全部失效)。统一口径:**feature 内部一律写 `ctx.fn(x)`**。

### 护栏盲区补全(反向探针发现 4 条,已全部补齐并翻红验证)

| # | 盲区 | 为什么原断言看不出 | 补的断言 |
|---|---|---|---|
| ① | 分类排序 | 两个中文名(甲/乙)的**插入序恰等于字典序** | 第二个分类改用「丙」(字形序在「甲」之前) |
| ② | 切分类重置笔记 | `showEmpty` 本身就会隐藏 readView,`activeNoteId` 没清也照样绿 | 切**回来**时不自动选中任何笔记 |
| ③ | 笔记排序 | 只有 1 条笔记,「排序」无从观测 | 建第二条 → 上移 → 顺序必须真的变 |
| ④ | markDirty | 状态栏停在原值「已保存」与「没变」**无法区分** | 先确认已保存,再改一个字,状态栏必须离开 |
| ⑥ | 删除分类 | 护栏压根没这个场景 | 删完 `activeCat` 必须复位 + 回空状态 |

⚠️ 补 ① 时踩到一个**平台事实**:`localeCompare` 在默认 locale 下**中文排在拉丁字母之前**
(`['AAA-x','中文'].sort(localeCompare)` → `['中文','AAA-x']`),所以用 ASCII 前缀反而造不出差异。
最终用「丙」——它按字形序排在「甲」**之前**。

### 验证(双绿 + 反向探针)

```
单测       205/205      (含新增 tests/lock.test.mjs 5 条 —— 专测 releaseSession)
S0 真机护栏 49/49       (从 30 涨到 49)
反向探针    6/6 全部如期翻红(且每条翻红的都是目标断言)
  · ① 删分类排序    → 分类按名称排序 红
  · ② 不重置笔记    → 切回来不自动选中 红
  · ③ 绕过 sortNotes→ 上移后顺序真的变了 红
  · ④ 不标脏        → 改动后离开「已保存」 红
  · ⑤ 不渲染 MD     → Markdown 列表已渲染为 <li> 红
  · ⑥ 不清 activeCat→ 删除后当前分类名复位 红
  · releaseSession 单测反向探针 4/4 红
```

### ⚠️ 探针自身的两个安全网(本轮踩到才加)

1. **探针被中断会污染工作区**:每个 case 跑一遍完整护栏(≈40s),全部 6 个超工具超时 → SIGTERM
   → `finally` 没执行 → 源文件残留 `MUTANT:`。
   **次轮运行会把脏代码当基线**,表现为「锚点未找到」+「还原后仍 2 条红」,极易误判。
   → 已加:① 启动时**污染自检**(发现 `MUTANT:` 立即报错退出);② 注册 `SIGTERM`/`SIGINT` 兜底还原;
   ③ 支持 `ONLY=1,2` 分批跑,避免触发超时。
2. **护栏绝不能并发跑**:同一数据目录下两个护栏进程互相覆盖,表现为「分类没建出来」等
   看似真缺陷的假红。**必须串行。**

---

## S4 落地(抽 shell + 加固 store 纪律)

`ui.js` **1077 → 854 行**;累计从重构起点的 1782 行降至 **854 行(-52%)**。

| 模块 | 行数 | 职责 |
|---|---|---|
| `features/shell.js` | 311 | 启动编排(`boot`)+ 全部 DOM 事件绑定(`bindEvents`)+ 入口(`start`) |
| `main.js` | 25 | 接线:`start(ctx)`,3 行逻辑 |
| `ui.js` | 854 | 共享基础设施(toast/modal/工具/保存流水线/设置/备份)+ ctx 组装 |

**三层边界**:main 接线 → ui 组装 → features 干活。`shell.js` 是**唯一**知道所有 DOM id 的模块,
每个监听都只是「DOM 事件 → 一次 `ctx.<feature>` 调用」的胶水,不含业务逻辑。

### 🔴 抓到的真缺陷:`ctx.store.x = v` 静默丢状态

`ui.js` 里的 `S = createProxy(store)` 支持 `S.x = v` 直访(代理把属性赋值转成 `set()`)——
**那是 ui.js 的特权**。我机械改写时把 `S.vaultJson = res.json` 变成了
`ctx.store.vaultJson = res.json`,而 `ctx.store` 是**原始 store 实例**:
状态全在 `_state` 里,**实例上根本没有字段**。

结果:写只是挂了个没人读的实例属性 → `store.get('vaultJson')` 读不到 → **建库后进不去应用**。
表现是护栏「建库后进入应用」20s 超时(S0 护栏又一次证明了它的价值)。

修法:feature 一律 `ctx.store.get('x')` / `ctx.store.set('x', v)`。
共修正 **13 处**。

### 🔴 顺带发现:一条「文档里写着、代码里不存在」的守卫

DESIGN.md §10.5 一直写着「`defaultState` 漏声明会红」,查证后发现:
`tests/store.test.mjs` 里那条是**硬编码白名单**(只有名单里的字段在不在),
**证明不了「代码里没写别的字段」** —— 所以 `lockMode` 用了**半年**、从未在 `defaultState()`
里声明过,一路无人拦。

修补(三件事):
1. `store.js` 的 `defaultState()` 补上 `lockMode` 及其取值说明;
2. 新增 **`tests/store-discipline.test.mjs`**(2 条反向扫描守卫):
   - 代码里每个 `.set('x')` / `patch({ x })` 的**字面量键**都必须在 `defaultState()` 中;
   - feature 不得直访 `ctx.store.<字段>`(必须走 get/set)。
3. `store.test.mjs` 的白名单补 `lockMode`,并在注释里写明它与新守卫是**互补**关系。

⚠️ 首版 patch 键提取正则写成 `/(?:\s)([A-Za-z_]\w*)\s*[:,]/`,把**值**也当成了键
(`{ activeCat: null, ... }` 里的 `null` 前面正好有空格),报出「patch({ null })」这种假阳性。
改为 `[{,]\s*([A-Za-z_]\w*)\s*:` —— 键只出现在 `{` 或 `,` 之后且紧跟冒号。

### 护栏盲区补全(反向探针发现 2 条,已补齐并翻红验证)

| # | 盲区 | 为什么原断言看不出 | 补的断言 |
|---|---|---|---|
| ③ | 主题初始化 | 护栏默认就是浅色,`initTheme` 整段删掉也照样浅色 → **恒绿** | **预置 `localStorage['jmbiji.theme']='dark'` 再刷新**,首屏必须是深色;并断言按钮已按深色态更新 |
| ④ | 多标签页同步 | 只开一个标签,没有「第二方」可观测 | **开第二个页面**(共享 localStorage → 自动进应用),在 A 建分类,B 必须自己刷出来 |

### 验证(双绿 + 反向探针 7/7 + falsify 全绿)

```
单测        207/207     (205 + store-discipline 2 条)
S0 真机护栏  53/53       (从 49 → 53;新增 主题 2 条 + TabSync 2 条)
反向探针     7/7 全部如期翻红(每条翻红的都是目标断言)
  · ① bindEvents 不再被调用     → 主密码输入框存在 红
  · ② boot 写 store 改直访      → 建库后进入应用 红(复现本轮真缺陷)
  · ③ 跳过 initTheme            → 主题 2 条红
  · ④ 不初始化 TabSync          → 第二个标签 红
  · ⑤ store 写入未声明字段      → store-discipline 红
  · ⑥ feature 直访 store 字段   → store-discipline 红
  · ⑦ shell.js 漏登记 ASSETS    → assets 递归守卫红
npm run test:falsify          全部守卫具备判别力 ✓(含本轮修好的「上线验收」)
行尾:public/js/** 全量 20 文件纯 CRLF,无一混合
```

### 修掉的历史遗留:falsify 的「验收步骤被掏空」失效守卫

**根因**:旧断言是 `assert.match(workflow, /\/api\/vault/)` 这类「文件里出现过某字符串」,
而 `/api/vault`、`x-access-key`、`401`、`404` 在**注释、echo、summary 表格**里到处都是 ——
把真正发请求的那两行掏空,其余字符串照样在,断言全绿。

**修法**:断言改落在**请求本身**与**判定分支**上:
- 取出真正执行请求的两行(而不是全文搜索),断言两次探测都打 `/api/vault`;
- 带密钥那行**必须真的含** `x-access-key: $ACCESS_KEY`;
- 无密钥那行**绝不能**含 `x-access-key`;
- `case "$no_key"` / `case "$yes_key"` 的分支必须覆盖三态,且每个「坏」态都必须 `fail=1`。

**教训**:断言必须落在「**我发出的请求**」与「**判定逻辑**」上,不是「文件里有没有这个词」。
