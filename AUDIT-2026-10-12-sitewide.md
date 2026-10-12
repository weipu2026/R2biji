# 全站源码审计报告(2026-10-12,第三轮)

范围:整个仓库(前端 `public/`、Worker `worker/`、部署脚本与 CI)。
目标:Bug / 逻辑错误 / UI 错误 / 代码冗余,以及在允许改动核心代码的前提下做
「更快、更省、更安全」的优化。

结论:**2 个 P0、4 个 P1、20 个 P2/P3 全部已修**(共 26 项),每条都补了回归护栏,
并为每条能构造出等价错误实现的修复补了鉴伪变异体(变异体 **154 → 172**)。
未修项已单列,理由写在「刻意未改」一节。

> 本轮(全站)与同日早些时候的 `AUDIT-2026-10-12.md`(办公电脑启动链路的单点复盘)
> 是两份不同的报告:那份针对 1 个 BUG,这份针对整棵树。

---

## 0. 分级口径

| 级别 | 含义 |
| --- | --- |
| P0 | 线上功能直接不可用 / 安全防线被绕过,且**本地看不出来** |
| P1 | 数据丢失或安全语义被破坏(「看起来成功了,其实没做」) |
| P2 | 体验 / 可达性 / 性能 / 可诊断性明显受损,有稳定的触发条件 |
| P3 | 瑕疵,或已论证可豁免但值得记录 |

---

## 1. P0 —— 线上直接不可用

### P0-1 应急页调用模板内的函数,结果面板整块渲染不出来

- **位置** `public/recover.html`(外层 DOM 段)
- **类型** 运行时 ReferenceError / 作用域错误
- **触发** 解密成功、渲染结果摘要表时
- **影响** 外层代码调用了 `READER_TEMPLATE` 模板字面量**内部**才定义的 `rdrEsc`。
  那个函数只存在于「生成出来的离线阅读站」自己的作用域里,外层调用必然
  `rdrEsc is not defined` —— 摘要表整块渲染不出来;**含告警的包连结果面板一起消失**
  (而解密其实已经成功)。用户只看到一句英文报错,且这正是「出事那天才打开」的页面。
- **为什么一直没被发现** 纯逻辑单测只加载 `RECOVER-SCRIPT` 段、不跑 DOM 段,一路全绿;
  而它只在真实浏览器里跑到那一行才炸。
- **修复** 在外层作用域补一个 `escHtml()`(见 P2-10),并把 5 处外层调用全部换过去。
- **护栏** `tests/recover.test.mjs`「转义器实现必须真的转义」+
  「READER_TEMPLATE 里的函数不得在模板外被调用(作用域自检)」——后者是**静态作用域自检**,
  对模板内定义、外层未定义、却在外层被调用的函数名做差集,必须为空。
- **变异体** 2 条(转义器退回原样返回 / 外层改回调 `rdrEsc`)

### P0-2 `recover.html` 的 CSP 放宽其实是无效的 —— 线上白屏、本地正常

- **位置** `public/_headers`
- **类型** 配置语义误解 → 安全策略取交集
- **触发** 线上直接打开 `/recover.html`
- **影响** Cloudflare 的 `_headers` 官方语义是「一条请求命中多条规则时**继承全部**规则的头」,
  且「同一个头被应用两次时,值用**逗号**连接」。于是「再写一条更宽松的 CSP」得到的是
  `严格策略, 宽松策略`;浏览器对多条策略取**交集**,严格那条的
  `script-src 'self'`(无 `unsafe-inline`)照样把内联脚本全部拦掉 ——
  而这一页 100% 依赖内联脚本与样式 ⇒ **整页白屏**。
  这正是「本地好、线上坏」的经典形态:本地 dev-server 是单独放宽 CSP 的,看着完全正常。
- **修复** 用官方提供的 `! Header-Name` **摘除**语法:先把 `/*` 那条 CSP 摘掉,
  再挂本页自己的。文件内写明了完整理由,免得后人「顺手清理没用的一行」。
- **护栏** `tests/deploy.test.mjs` 2 条:一条按 **CF 真实语义**(继承全部 + 逗号连接 + `!` 摘除)
  模拟合并,断言 `/recover.html` 拿到的 CSP 恰好一条、含 `'unsafe-inline'`、
  且 `script-src` 只出现一次;另一条钉住「放宽的前提是事实」(该页确实全靠内联)。
- **变异体** 1 条(把 `!` 摘除行注释掉)

> 这条的判别力来自一个关键点:**按 object-merge(后者胜)去模拟 `_headers` 会得出与线上
> 完全相反的结论**。测试里因此专门实现了 `mergeHeadersCf()`,而不是复用现成的合并写法。

---

## 2. P1 —— 数据丢失 / 安全语义被破坏

### P1-1 自动锁屏:既不锁,又谎报「已自动锁屏」

- **位置** `public/js/ui.js` `resetIdleTimer` ↔ `public/js/features/lock.js` `lockNow`
- **类型** 逻辑错误 + 谎报成功(安全语义)
- **触发** 开着「空闲自动锁屏」,且有未保存改动时人走开
- **影响** 空闲到点后走的是 `lockNow` 的**默认** `confirmDiscard: true` ——
  有未保存改动时弹确认框,而那个框**唯一的取消分支就是不锁定**。
  人不在场 ⇒ 没人点 ⇒ 屏幕永远停在已解锁状态、**明文留在屏幕上**;
  而调用方在定时器里无条件报了「已自动锁屏」。既没锁、又谎报锁了,是最坏的一种组合。
- **修复** 新增 `lock.js` 的 `autoLock(ctx)`:显式 `confirmDiscard: false`,
  并在锁完后**如实报数**(「N 个分类的改动没能存上,已放弃(服务器上的是完整版本)」);
  `resetIdleTimer` 改为调用它。
- **附带收紧** 锁定**失败**时不再静默:报 error 档「自动锁屏失败(原因),明文仍在屏幕上 ——
  请手动锁定」。这条路径存在的全部意义就是「不谎报已锁」,失败时沉默等于把最坏结果藏起来。
- **护栏** `tests/lock.test.mjs` 4 条(必须传 `confirmDiscard:false` / 有改动必须报数 /
  失败必须报错且不得说「已自动锁屏」/ 返回值异常时不得乱报数)
- **变异体** 2 条

### P1-2 孤儿图片清理会被「内存里的旧明文」骗过 —— 删掉别端刚引用的图

- **位置** `public/js/lib.js` `cleanupOrphanBlobs`
- **类型** 不可逆数据丢失(blobs 是全应用唯一**没有备份层**的东西)
- **触发** 某分类的**本轮**重拉失败,但内存里还留着几小时前的已解密明文
- **影响** 旧判据是「读不到就一张不删 = `!cat.data`」。而 `rescan()` 有意保留已解密明文、
  `loadCategory(force)` 失败时**不会**清掉那份旧明文 ⇒ `!cat.data` 不成立,
  这个分类会带着**过时的引用面**进入清点:此后别的设备上传、当前确实被引用的图片
  会被判成孤儿删掉,而 blobs 没有备份层 = 永久丢失。
- **修复** 自己驱动重拉、逐类记名,**判据收紧为「本轮重拉成了没有」**;
  永久损坏与瞬时失败一律保守:记名 → 整次中止 → 一张不删。
  同时订正了 `loadCategory` catch 里那句已经过时的注释(它还在说判据是 `!cat.data`)。
- **护栏** `tests/e2e.test.mjs`「本轮重拉失败的分类必须记名并整次中止(有旧明文也不能照清)」
  ——专门造出「热缓存 + 只让该分类重拉失败」这两个前提。
- **变异体** 1 条(catch 里不记名)

### P1-3 解锁失败后,半初始化的 Library 没被销毁 —— 密钥留在内存

- **位置** `public/js/features/lock.js` `doUnlock`
- **类型** 资源/密钥泄漏
- **触发** 拿到库信息后,解锁过程在中途抛错(解密失败、写令牌失败…)
- **影响** 已经构造出的 Library 实例(持有 contentKey / attachKey)被留在 store 里,
  既没有销毁、也不会被下一次成功解锁覆盖路径复用清理 ⇒ 密钥与令牌留在内存里,
  「锁定 = 释放明文」这条不变量被绕过。
- **修复** catch 里显式 `lib.destroy()` 并把 `S.get('lib')` 置空。
- **护栏** `tests/e2e.test.mjs` 相关解锁链路已有覆盖 + `tests/boot-vault.test.mjs`

### P1-4 分类 etag 只剥引号不剥 `W/` —— 该分类条件保存恒 412

- **位置** `public/js/api.js` `getCat`
- **类型** 逻辑错误(静默失败)
- **触发** Cloudflare 边缘把分类(二进制/压缩)响应的强 etag 改写成弱验证器 `W/"…"` 时
- **影响** `fetchVault` 早就剥了 `W/`,**但分类那条只剥了引号**。残留的 `W/` 被拼进
  `If-Match` 后服务端归一对不上 ⇒ 该分类**恒 412**,用户看到的是
  「保存按钮点了没反应」,重新打开、重新解锁都不管用。
- **修复** 抽出唯一的 `normEtag()`(去引号 + 去 `W/` 前缀),`fetchVault` 与 `getCat` 共用。
- **护栏** `tests/e2e.test.mjs`「分类读取也必须剥掉弱验证器前缀(W/),否则该分类的条件保存恒 412」
  ——把分类响应的 etag 改写成弱验证器,再走一次真实的条件保存。
- **变异体** 1 条

---

## 3. P2 —— 体验 / 可达性 / 性能 / 可诊断性

| 编号 | 位置 | 问题 | 修复 | 护栏 | 变异体 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | `public/css/style.css` `.btn.primary` | 暗色主题把 `--accent` 提亮成 `#7fa7d9` 后,硬编码白字压上去只有 **2.49:1**(AA 要 4.5:1)——界面上最显眼的「确定 / 保存 / 登录」正好糊在底里 | 暗色单独覆盖为深墨 `#1e2128`(6.27:1;hover 7.52:1);禁用态底色更深,单独给 `--muted`(3.09:1) | `tests/contrast.test.mjs` 3 条(含 hover、含禁用态) | 1 条 |
| P2-2 | `public/js/ui.js` toast ↔ `public/index.html` `#toasts` | `<dialog>.showModal()` 把弹窗放进 **top layer**,那里层级由加入顺序决定、`z-index` 一概不参与 ⇒ 弹窗开着期间到达的提示(**别端保存/删除的广播通知**、自动保存失败的报错)一条都看不见 | `#toasts` 挂 `popover="manual"` 并 `showPopover()`,自己也进 top layer;摘空后 `hidePopover()` 退出 | `tests/dialog.test.mjs` 5 条 + `tests/assets.test.mjs` 1 条(UA 默认样式归零清单) | 3 条 |
| P2-3 | `public/recover.html` `#drop` | `#zipInput` 是 `display:none`(不进 tab 序),而拖放区只绑了 `click` ⇒ **键盘用户在「出事那天」第 1 步直接卡死**,页面文字却还在说「点击选择文件」 | `role="button"` + `tabindex="0"` + `aria-label` + `:focus-visible` + Enter/Space 激活(空格 `preventDefault`) | `tests/deploy.test.mjs` 1 条(静态) | 2 条 |
| P2-4 | `public/recover.html` | 主密码框/文件框只有 placeholder(**placeholder 不算可访问名**),解密失败的行内提示不播报 | `aria-label` ×2、`role="alert"`;阅读站的解锁框/搜索框/报错同样处理 | `tests/deploy.test.mjs` 1 条 | — |
| P2-5 | `public/recover.html`(阅读站段) | 内嵌附件是 base64(预算 4MB → 源文本约 5.4MB),`<script type="application/json">` 的内容被 HTML 解析器当文本节点**一直留在 DOM 里**,`JSON.parse` 之后又有一份 ⇒ 两份同时驻留 | 解析成功后把两个源文本节点清空(解锁/锁定只读内存副本,从不回读 DOM) | `tests/deploy.test.mjs` 1 条(含「不得改回直接从 DOM 读」的反向断言) | 1 条 |
| P2-6 | `worker/worker.js` `listAll` | 截断判据用「循环结束后 `cursor` 是否残留」,而 `cursor` 正常翻完最后一页时**不会被清掉** ⇒ 任何超过一页的列表都误报「达到 50 页上限,其余被截断」(备份明明全在) | 改用本轮返回值 `res.truncated` 覆盖独立标志 | `tests/worker.test.mjs` 2 条(不许误报 + 真截断必须出声) | 1 条 |
| P2-7 | `scripts/gen-config.mjs` | `HIDE_WORKERS_DEV=1` 只在「有自定义域」时才生效;没配域名时被**静默忽略**,用户会以为入口已关,甚至拿它去做安全判断 | 忽略时显式告警并给出两条出路(同时配域名 / 去掉开关) | `tests/deploy.test.mjs` 1 条(含「声明必须先于使用」的 TDZ 断言) | 1 条 |
| P2-8 | `public/js/format.js` `ILLEGAL_CHARS` | 客户端清洗集比服务端 `validCatName` **窄**:零宽字符 / bidi 控制符 / `\u007f-\u009f` / BOM 能过客户端、到服务端被 400 拒 | 与服务端对齐 | `tests/format.test.mjs`(既有 P3 清洗用例) | 既有 |
| P2-9 | `public/js/format.js` `notePreview` | 每次重画笔记列表都要对**每一篇的整段正文**跑 `/\s+/g`(100 篇 × 20KB ≈ 2MB 正则),切笔记/切分类/置顶/多标签同步各付一次 | 有界扫描(前 400 字符足够,前导空白走快速路径),**输出与旧写法逐字符相同** | `tests/format.test.mjs` 2 条(含 300 条随机输入与朴素实现逐条对照) | 1 条 |
| P2-10 | `public/recover.html` | 外层摘要/告警面板缺转义器(与 P0-1 同源) | 新增外层 `escHtml()` 并全部改过去 | 见 P0-1 | 见 P0-1 |
| P2-11 | `public/js/features/search.js` | 分类读不到时搜索静默少结果,表头却报「0 条匹配」——用户会以为库里真没有 | 表头补「有 N 个分类这次没读到,结果可能不全」 | `tests/search.test.mjs` | — |
| P2-12 | `public/js/features/note.js` | `moveNote` / `deleteNote` 未判 `cat?.data` ⇒ 分类数据缺失时 null 解引用 | 补空值护栏 | `tests/move-note.test.mjs` | — |
| P2-13 | `public/js/features/note.js` | `collectEditChanges` 每敲一个键都重渲染整块附件区 | 从逐键路径移除,改为真正需要时渲染 | `tests/features.test.mjs` | — |
| P2-14 | `public/js/features/data.js` | `restoreFromTrash` 的 `maxOrder` 归约遇到非有限值会产生 NaN order ⇒ 该笔记排序行为未定义 | 归约里跳过非有限 `order` | — | — |
| P2-15 | `public/js/ui.js` / `features/lock.js` / `features/data.js` | 「下载」三份重复实现(Blob 构造、`a.click`、`revokeObjectURL` 时机各异) | 统一到 `downloadUrl()` / `downloadBytes()` | `tests/features.test.mjs` | — |

---

## 4. P3 —— 已记录

| 编号 | 位置 | 说明 |
| --- | --- | --- |
| P3-1 | `public/js/ui.js` | 删掉死导入 `findMatches, renderSearchResult`(已迁到 features/ 之后没人再用) |
| P3-2 | `public/js/features/theme.js` | 去掉三个只在本模块用的多余导出 |
| P3-3 | `public/js/features/sidebar.js` | tooltip 改用 `F.notePreview()`(顺带吃到 P2-9 的性能收益) |
| P3-4 | `public/js/lib.js` | `appendNoteToCategory` 的「回滚」分支里,读源笔记发生在截断**之后** ⇒ 取到的是已被删掉的 `undefined`,回滚其实什么都没恢复。改为截断前先读(配变异体:退回「先截断再读」) |
| P3-5 | `public/_headers` | 把 CF `_headers` 的合并语义与 `!` 摘除语法写进文件注释(这是 P0-2 的根因知识,不留下来下次还会踩) |

### 刻意未改

| 项 | 为什么不动 |
| --- | --- |
| 亮色主题 `.btn.primary:disabled`(`#9db4d0` 底 + 白字 ≈ 2.13:1) | WCAG 1.4.3 明确豁免「非活动控件」;而 `#9db4d0` 是刻意的「洗淡版强调色」,改它会动到整体观感。已记录,不算缺陷 |
| `timingSafeEqual` 的时序性质 | 功能等价的写法得到完全相同的通过/拒绝结果,任何单测都无判别力;只能靠代码审阅。鉴伪脚本里**刻意不列**这类变异体,免得给出「已经验证过」的错觉 |
| `recover.html` 的 CSP 放宽本身 | 该页是「单文件应急页」(双击即用、不依赖任何外部资源),内联是设计前提。已用一条守卫钉住这个前提,前提一旦消失就会被要求收紧回去 |

---

## 5. 验证

| 手段 | 结果 |
| --- | --- |
| 全量离线单测 `npm test` | 全绿 **464 项**(435 → 464,本次新增 29 条) |
| 鉴伪 `npm run test:falsify` | 变异体 **154 → 172**,全部「按需变红」后自动还原 |
| 锚点自检 `.ui-tests/check-anchors.mjs` | 全部匹配(变异体锚点失配会静默退化成「跳过」= 假绿) |
| `gen-config` 三场景干跑 | 无域名+开关 → 告警且保留双入口;域名+开关 → `workers_dev=false`;域名无开关 → `true` |
| CSP 摘除咬合验证 | 删掉 `!` 摘除行 → 合并结果变成逗号连接的两条策略(守卫判红) |
| 线上验证 | **本次做不了**:宿主代理端口未监听、`workers.dev` 直连 502。P0-2 的依据改为官方文档语义 + 仓库内证据(该页确实 100% 内联、CI 只校 `/` 的响应头、不校 `/recover.html`) |

本次新增的 **18 条**变异体逐项归属:`P0-1×2`、`P0-2×1`、`P1-1×2`、`P1-2×1`、`P1-4×1`、
`P2-1×1`、`P2-2×3`、`P2-3×2`、`P2-5×1`、`P2-6×1`、`P2-7×1`、`P2-9×1`、`P3-4×1` —— 合计 18,
与 `154 → 172` 对得上。**未**配变异体的项,要么其「错误实现」不产生可被单测观测的行为差异
(如 P1-3 密钥是否及时释放、P2-13 的渲染频次),要么本次未新增守卫(如 P2-11/P2-12 靠既有用例覆盖)、
要么与 P0-1 同源(P2-10)。

### 本次新增护栏的分布

| 文件 | 新增 | 针对 |
| --- | --- | --- |
| `tests/deploy.test.mjs` | 6 | CSP 摘除(×2)、应急页可达性(×2)、base64 释放、`HIDE_WORKERS_DEV` 告警 |
| `tests/dialog.test.mjs` | 5 | 提示进 top layer(×5) |
| `tests/lock.test.mjs` | 4 | `autoLock` 契约 |
| `tests/contrast.test.mjs` | 3 | 主按钮字色(亮/暗/hover/禁用) |
| `tests/e2e.test.mjs` | 2 | 孤儿清理判据、分类 etag 弱验证器 |
| `tests/move-note.test.mjs` | 2 | `appendNoteToCategory` 回滚分支(冲突中止须恢复 snaps / 成功须保留) |
| `tests/format.test.mjs` | 2 | `notePreview` 等价性 |
| `tests/worker.test.mjs` | 2 | 列表截断判据(正反) |
| `tests/recover.test.mjs` | 2 | 转义器实现、模板作用域自检 |
| `tests/assets.test.mjs` | 1 | popover UA 默认样式归零清单 |
| **合计** | **29** | |

---

## 6. 一条贯穿全篇的方法论

本次 2 个 P0 有一个共同形状:**本地全绿、线上全坏**。

- P0-1 是「只加载纯逻辑段、不跑 DOM 段」的测试分层造成的盲区;
- P0-2 是「本地 dev-server 与线上平台的 CSP 合并语义不同」造成的盲区。

两处都补了**按平台真实语义**建模的守卫(静态作用域自检 / `mergeHeadersCf`),
而不是加一句断言把当前现象钉住 —— 前者在下次有人改回去时仍然有效。

---

## 7. 优化建议(尚未实施)

上一至四节是**缺陷**;本节是「不算缺陷、但做了会更好」的空间,全部**未改动**。
每条都注明「该做 / 不建议做」及理由,免得把一堆待办摊在你面前。
依据均为当前工作树的静态事实(可复核)。

### 7.1 值得做

| 编号 | 位置 | 现状 | 建议 | 依据 / 为什么值得 |
| --- | --- | --- | --- | --- |
| O-1 | `public/index.html:186` | 唯一的入口是 `<script type="module" src="js/main.js">`,**没有任何 `modulepreload`**。ESM 的依赖是「取到一个模块、解析出它的 `import`、再去取下一层」——`main → shell → ui → lib/api/crypto…`,首屏要串行等好几层 RTT | 对关键链补 `<link rel="modulepreload" href="js/ui.js">` 等若干条,让浏览器**并行预取** | 纯声明式、不动任何逻辑、失败也只是回到现状;弱网下首屏可省数层往返 |
| O-2 | `public/js/zip.js:178` `lib.js:778` | 全库导出:`zipStore()` 结尾 `concat([...blobs, ...centrals, eocd])` —— 必然 `new Uint8Array(total)` 并**整库复制一份**连续缓冲,导出瞬间峰值内存 ≈ **库大小的 2 倍**(大库含附件时是真实的 OOM 风险) | 让 `zipStore` 返回**分段数组**,`downloadBytes` 接 `new Blob(parts)`(Blob 不必连续,由浏览器分段持有) | 峰值降到 ≈ 1 倍;`downloadBytes` 已在 `ui.js:1109` 用 `new Blob([bytes])`,只需放开成多段入参,改动面小 |
| O-3 | 全站(无全局错误处理) | 前端崩溃只进 `console`,用户端**看不到任何提示**;`lock.js:200` 的注释还专门交代「不要让锁定异常冒泡成 `unhandledrejection`」—— 说明这个缺口是已知的,只是没堵 | 注册一次 `window.onerror` + `unhandledrejection` → 走 `toast(msg,'error')` 如实告知(可选:上报到 Worker 的一个只收不读的端点) | 与 P2-6/P2-11 同一类「可诊断性」;没有它,用户只会说「网站坏了」,你拿不到任何现场 |
| O-4 | `public/js/api.js` `req()` | 任何网络抖动(超时/连接重置)都**直接抛错**,包括 `fetchVault` / `listCats` / `getCat` / `getBlob` 这些**幂等 GET** | 只对 GET 加**一次**退避重试;写请求(PUT/DELETE)**绝不重试** | 写请求重试会撞 CAS 语义(`if-match` 已失效),是数据风险;GET 重试无副作用,弱网体验提升明显 |
| O-5 | `public/js/ui.js`(1233 行) | 该文件仍是全仓最大单体。`features/` 已迁出一批,但 `ui.js` 同时扛着「`ctx` 注入包组装」与大量视图逻辑 | 按 feature 继续外迁,`ui.js` 只留 `ctx` 组装 + 共享基础设施 | 与既有分层方向一致;越晚拆越贵。**属结构债,非缺陷** |

### 7.2 不建议做(已权衡,写下来免得反复讨论)

| 项 | 为什么不建议 |
| --- | --- |
| 列表渲染分片 / 虚拟滚动 | 当前规模(几十类、几百篇)全量重画**没有可感延迟**;为「万一上千篇」引入虚拟滚动会显著加复杂度。**等真有大库实例再说**,届时按阈值触发即可 |
| `require-trusted-types-for 'script'`(Trusted Types) | 本应用全程 `createElement` / `createTextNode`、**零 `innerHTML`**(`render.js:5` 有明文约束),XSS 面本就极窄;引入 TT 只添复杂度和误报,收益不成比例 |
| `accessKey` 改不落盘 | 它是「可选访问密钥门」,落 localStorage 是为了「下次免输」。无 XSS 面时该风险极低,改掉直接伤可用性。**权衡后保留** |
| `Cross-Origin-Resource-Policy` / HSTS `preload` | 本站是「孤岛应用」(CSP `default-src 'none'`、无外链、无嵌入需求),这两条防的是「被别人嵌入 / 子域降级」,威胁模型不成立。**加了只是噪音** |
| CSP 违规上报(`report-to`) | 与 O-3 重叠:全局错误处理已能覆盖绝大多数前端异常;单独引 CSP 上报要配 endpoint + 解析格式,收益小。**若 O-3 落地后可顺带加** |
| `/api/cats` 边缘缓存 | Worker 侧 `cache-control: no-store` 是**刻意的**(响应含密文与结构元数据);列表虽小,缓存收益也小,不值得为此放松一条安全语义 |
| 写请求(CAS)自动合并 / 重放 | 零知识下「自动重放」可能把别端的中间态覆盖掉,且 412 的语义就是「请人工确认」。**保持现状**(提示 + 手动重试) |
