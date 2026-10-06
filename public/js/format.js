/* ============================================================
 * JMbiji 库结构与文件名规则 —— 纯函数,可离线单测
 * 见 DESIGN.md §3 / §4 / §8
 * ============================================================ */

export const ENCRYPTED_EXT = '.enc';
export const VAULT_NAME = 'vault.json';
export const BLOBS_DIR = 'blobs';
export const BACKUP_DIR = 'backup';
export const IGNORE_NAME = 'seafile-ignore.txt';
export const KEEP_BACKUPS_PER_CATEGORY = 10;

/** 非法文件名字符(Windows/macOS/Linux 取并集)与控制字符。
 * ★ 必须与服务端 validCatName 的拒绝集**对齐**(2026-09-29 审计 P3):服务端还会拒
 *   HTML 元字符 < > " ' ` &,而这里以前少收了 ' ` & 三个 —— 于是「R&D」「O'Brien」
 *   能通过客户端校验、要在服务端跑一个来回才被 400 拒掉,用户只看到一句服务器错误。
 *   两侧口径:客户端**预先剔除**(与 / \ : 等既有处理同一条纪律),服务端保留拒绝
 *   作为兜底(它还要面对非本客户端的请求)。 */
const ILLEGAL_CHARS = /[/\\:*?"<>|'&`\u0000-\u001f]/g;

/**
 * 清洗分类名:去掉非法字符、压平空白、限长 60。
 * @returns {string|null} 无效(清洗后为空)时返回 null
 */
export function sanitizeCategoryName(raw) {
  const cleaned = String(raw ?? '')
    // ★ 先归一成 NFC:macOS 常给 NFD(「café」= e + 组合重音),不归一就会
    //   与 NFC 版本在 R2 里各存一份,用户看到两个同形分类、删一个另一个还在。
    .normalize('NFC')
    .replace(ILLEGAL_CHARS, '')
    // U+FFFD 只来自非法 UTF-8 解码或用户误粘,一律当非法字符剔除(与服务端一致)
    .replace(/\ufffd/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned.length ? cleaned : null;
}

/**
 * 大小写不敏感文件系统(Win/macOS)撞名检测。
 * 「API」与「api」会撞名 —— 返回与之撞名的既有分类名,无则 null。
 * ★ 先做 NFC 归一:否则 NFD 形态的「café」与 NFC 形态比较会判为不同名,
 *   而文件系统与 R2 都按码点存,实际会撞。
 */
export function findCaseCollision(existingNames, name) {
  const fold = (s) => String(s).normalize('NFC').toLowerCase();
  const lower = fold(name);
  return existingNames.find((n) => n !== name && fold(n) === lower) || null;
}

export function isEncryptedName(name) {
  return name.endsWith(ENCRYPTED_EXT);
}
export function stripEnc(name) {
  return name.slice(0, -ENCRYPTED_EXT.length);
}

/* ---------- 状态栏优先级(纯函数,供单测) ---------- */

/**
 * 保存状态栏的优先级。error > busy > dirty > ok。
 * ★ 为什么需要:「保存失败」由 saveAll 直接写入,但 refreshSaveStatus 是 800ms 防抖;
 *   若此刻还有一次 markDirty 挂起的回调到点(且 dirty 已被清空),它会用「已保存」
 *   把刚显示的错误盖掉 → 用户看到假绿,以为存上了。
 *   低优先级不得覆盖高优先级;同/更高可覆盖(进度文案才能刷新)。
 */
export const STATUS_RANK = { error: 3, busy: 2, dirty: 1, ok: 0 };

/**
 * 是否允许用 nextKind 覆盖当前状态(纯决策,不碰 DOM)。
 * @param {number} currentRank 当前优先级(-1 表示尚未设置过任何状态)
 * @param {string} nextKind 即将设置的状态种类
 * @param {boolean} authoritative 是否是「保存流水线的权威终态」
 *   refreshSaveStatus 的写入属于权威终态:它反映的是保存流程跑完后的真实结果,
 *   因此允许覆盖过渡态 busy/dirty —— 但**永远不许覆盖 error**(否则就是假绿)。
 * @returns {boolean}
 */
export function statusAllowsOverride(currentRank, nextKind, authoritative = false) {
  const rank = STATUS_RANK[nextKind] ?? 0;
  // 尚未设置过(-1)时一律放行
  if (currentRank <= 0) return true;
  // ★ error 是唯一粘性状态:任何来源都不得把它改写成非 error(防假绿)
  if (currentRank === STATUS_RANK.error) return rank >= STATUS_RANK.error;
  // 权威终态收尾:保存流程已结束,允许 dirty/ok 覆盖过渡态 busy/dirty
  // (不加这条 → 保存成功后状态栏永久卡在「保存中…」,2026-09-27 实测回归)
  if (authoritative) return true;
  // 其余情况:低优先级不许盖高优先级
  return rank >= currentRank;
}

/** Seafile / 同步工具生成冲突副本的常见命名特征 */
const CONFLICT_PATTERN = /(SF冲突|冲突副本|conflict|\(冲突)/i;

export function looksLikeConflictCopy(fileName) {
  return CONFLICT_PATTERN.test(fileName);
}

/* ---------- 备份命名与轮换 ---------- */

/**
 * 备份文件名。suffix 用于区分同一毫秒内的多次写入 —— 实测连续 12 次
 * Date.now() 会返回同一个值,只靠时间戳会让备份互相覆盖(12 份只剩 1 份)。
 */
export function backupFileName(categoryBase, ts, suffix = '') {
  return `${categoryBase}.${ts}${suffix ? `-${suffix}` : ''}${ENCRYPTED_EXT}`;
}

/** 解析备份文件名 → { base, ts, suffix, name } | null(非本应用备份命名则 null)。
 *  name 原样带回:轮换时必须按原文件名删除,不能靠 base/ts 重新拼(会丢 suffix)。 */
export function parseBackupFileName(name) {
  const m = /^(.*)\.(\d{13,})(?:-([0-9a-z]{2,8}))?\.enc$/.exec(name);
  return m ? { base: m[1], ts: Number(m[2]), suffix: m[3] || '', name } : null;
}

/**
 * 计算应删除的旧备份:按时间戳降序保留 keep 份。
 * @param {string[]} existingNames backup 目录里的全部文件名
 * @returns {string[]} 要删除的文件名
 */
export function planBackupRotation(existingNames, keep = KEEP_BACKUPS_PER_CATEGORY) {
  const backups = existingNames
    .map(parseBackupFileName)
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts || (a.name < b.name ? 1 : -1));
  return backups.slice(keep).map((b) => b.name);
}

/** seafile-ignore.txt 内容:只忽略自己的临时文件与备份目录,不忽略 *.enc / vault.json */
export const SEAFILE_IGNORE_CONTENT = '*.crswap\nbackup/\n';

/** 全库备份包的文件名:带本地日期,便于在下载目录里一眼认出来 */
export function backupArchiveName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `jmbiji-backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}.zip`;
}

/* ---------- 附件(blob)命名:内容寻址 ---------- */

/* 命名规则唯一实现在 vaultlib.js 的 blobFileNameFor():
 * HMAC base64url + 白名单扩展名([A-Za-z0-9]{1,12},不合法就不带)。
 * 此处不要再放平行的「展示名」实现 —— 2026-09-27 审计 P3-3:
 * 旧 blobDisplayName 的扩展名规则(任意字符截 12)与生效版不一致,
 * 拿它拼文件名会在服务端 400,已删。 */

/* ---------- 排序 ---------- */

/** 笔记排序:置顶(pin)优先,组内浮点 order 升序;同序号按创建时间兜底 */
export function sortNotes(notes) {
  return [...notes].sort((a, b) => ((b.pin === true) - (a.pin === true)) || (a.order - b.order) || (a.createdAt - b.createdAt));
}

/**
 * 计算插入/移动后的 order:取相邻两项均值;端点向外扩 1000。
 * @returns {number} 新的 order 值
 */
export function orderBetween(prev, next) {
  if (prev == null && next == null) return 1000;
  if (prev == null) return next - 1000;
  if (next == null) return prev + 1000;
  return (prev + next) / 2;
}

/* ---------- 分类排序与手动调序(2026-09-28) ---------- */

/** 分类手动顺序的步长:首次「铺开」时按视觉序号 × 这个步长,给后续插空留余地 */
export const CAT_ORDER_STEP = 1000;

/**
 * 分类排序:置顶优先 → 手动 order 升序 → 名称兜底。
 *
 * 分类的 order 存在 vault.json 的 catMeta[name].order(跨设备同步)。
 * 从未排过序的分类没有 order,一律视为末尾(新建分类自然落在同分组末尾);
 * 两个 Infinity 相减得 NaN 会让右侧的 localeCompare 接手,顺序依然确定、不抖动。
 * @param {string[]} names
 * @param {(name:string)=>({pin?:boolean, order?:number})} metaOf
 * @returns {string[]} 新数组(不改入参)
 */
export function sortCats(names, metaOf) {
  const pinOf = (n) => (metaOf(n)?.pin === true ? 1 : 0);
  const ordOf = (n) => { const o = metaOf(n)?.order; return Number.isFinite(o) ? o : Infinity; };
  return [...names].sort((a, b) =>
    (pinOf(b) - pinOf(a)) || (ordOf(a) - ordOf(b)) || a.localeCompare(b));
}

/**
 * 计算「上移/下移」后的 catMeta.order 补丁(纯函数,便于单测)。
 *
 * 规则(与笔记的 moveNote 对齐):
 *   · 端点不动、**不跨置顶分区**(跨分区交换没有视觉反馈,只会让人以为点了没反应)
 *   · 顺序「干净」(每个分类都有有限且**严格递增**的 order)→ 只交换相邻两项的值
 *     ⇒ 所见即所得,order 永不漂移(与笔记交换 order 值同思路)
 *   · 顺序不干净(首次使用 / 新建分类缺 order / 有重复值)→ 按**当前视觉顺序**
 *     给全部分类铺一遍 order 再交换 ⇒ 一次写把顺序固化,且铺出的值就是视觉序号,
 *     用户看不到任何跳动。重复值必须走这条路:交换两个相等的值 = 点了没反应。
 * @param {string[]} names 全部分类名
 * @param {(name:string)=>({pin?:boolean, order?:number})} metaOf
 * @param {string} name 要移动的分类
 * @param {number} dir -1 上移 / +1 下移
 * @returns {Record<string, number>|null} 全量 order 补丁;null = 不该动(不存在/端点/跨分区)
 */
export function catMovePatch(names, metaOf, name, dir) {
  const ordered = sortCats(names, metaOf);
  const idx = ordered.indexOf(name);
  if (idx < 0) return null;
  const j = dir < 0 ? idx - 1 : idx + 1;
  if (j < 0 || j >= ordered.length) return null;
  if ((metaOf(ordered[j])?.pin === true) !== (metaOf(name)?.pin === true)) return null;
  /* 先断言项数 > 1,再谈「每一项都干净」—— 空集也满足 every,那会喂出假绿
   * (与 format.test / pin-tail-verify 里同一条纪律) */
  const clean = ordered.length > 1 && ordered.every((n, i) =>
    Number.isFinite(metaOf(n)?.order) && (i === 0 || metaOf(ordered[i - 1]).order < metaOf(n).order));
  const values = clean
    ? ordered.map((n) => metaOf(n).order)
    : ordered.map((_, i) => (i + 1) * CAT_ORDER_STEP);
  const tmp = values[idx]; values[idx] = values[j]; values[j] = tmp;
  const patch = {};
  ordered.forEach((n, i) => { patch[n] = values[i]; });
  return patch;
}

/* ---------- 相对时间 ---------- */

/**
 * 笔记列表里的时间:一眼可读的相对表达。
 * 今天/昨天带时刻(刚存没存一眼分清),更早只到日,跨年补年份。
 * @param {number} ts 毫秒时间戳
 * @param {number} [now] 基准时间,默认当前(测试注入)
 * @returns {string} 非有限输入返回空串(调用方不必判空)
 */
export function relTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const n = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(n) - dayStart(d)) / 86400000);
  if (diffDays <= 0) return `今天 ${p(d.getHours())}:${p(d.getMinutes())}`; // 未来(时钟偏差)也按今天
  if (diffDays === 1) return `昨天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ---------- 回收站 ---------- */

/** 回收站保留天数:到期由 normalizeNoteData 在读取时自动清除(之前有 30 天反悔期) */
export const TRASH_DAYS = 30;
/** 回收站条目上限:防极端情况无界膨胀,超出时丢最旧的 */
export const TRASH_MAX = 500;

/* ---------- 笔记版本历史(快照) ---------- */

/** 每篇笔记保留的历史版本数上限:超出丢最旧的 */
export const SNAP_KEEP = 10;
/** 窗口合并:距最新快照不足该时长的连续保存合并为同一版本 ——
 * 否则「停笔 4 秒自动存」会在一次连续编辑里把 10 个历史槽全刷成中间态,
 * 真正想回去的「编辑前定稿」反而被挤掉。窗口合并后历史里留下的是:
 * 编辑前的旧版本 + 每段连续编辑的最终态,信息密度最高。 */
export const SNAP_WINDOW_MS = 10 * 60 * 1000;

/**
 * 追加一条历史版本引用(纯函数,不改入参)。
 * snaps 为「最新在前」的引用数组,条目 = { file: 内容寻址 blob 名, ts: 保存时刻 }。
 * blob 名由内容 HMAC 派生 → 同内容必然同名,去重不需要存正文哈希。
 *
 * 两种条目:
 *   - 普通条目(无 m 标记)= 「会话起点锚」:一段连续编辑开始时的正文;
 *   - 合并条目(m:1)= 「会话内最新态」:同一段连续编辑的最新版本,随保存滚动更新。
 * 这样 4 秒自动保存不会把历史刷成中间态,而真正想回去的「编辑前定稿」
 * (= 上一段会话的最后一次保存)永远以锚的形式留在历史里。
 *
 * 规则(普通保存):
 *   ① 与最新版同内容 → 原引用返回(不产生新条目、不重复上传);
 *   ② 窗口内(SNAP_WINDOW_MS)且 head 是合并槽 → 替换它(滚动最新态);
 *   ③ 窗口内且 head 是普通锚 → 新开合并槽,head 锚原样保留;
 *   ④ 窗口外 → 插入普通条目(新会话起点)。超 keep 丢最旧。
 * 恢复历史版本走 anchor:true:先把 head 降级为普通锚(m 摘除),再插入普通条目
 * —— 「恢复前的正文」被永久钉住,恢复永远可逆。
 *
 * @returns {Array} 新数组;无变化时返回原引用(调用方据此判断是否写回)
 */
export function pushSnap(snaps, entry, { keep = SNAP_KEEP, windowMs = SNAP_WINDOW_MS, anchor = false } = {}) {
  const list = Array.isArray(snaps) ? snaps : [];
  if (!entry || typeof entry.file !== 'string' || !entry.file) return list;
  const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
  // anchor:恢复前的正文必须成为永久锚 —— head 若是合并槽,先摘掉 m(内容原样保留)
  const demoted = (anchor && list[0]?.m) ? [{ file: list[0].file, ts: list[0].ts }, ...list.slice(1)] : list;
  const head = demoted[0];
  if (head && head.file === entry.file) return demoted;              // ① 同内容去重
  if (!anchor && head && ts - head.ts < windowMs) {                  // ②③ 窗口内
    const next = head.m
      ? [{ file: entry.file, ts, m: 1 }, ...demoted.slice(1)]        // ② 滚动合并槽
      : [{ file: entry.file, ts, m: 1 }, ...demoted];                // ③ 锚保留,新开合并槽
    return next.length > keep ? next.slice(0, keep) : next;
  }
  const plain = [{ file: entry.file, ts }, ...demoted];              // ④/anchor 新会话起点
  return plain.length > keep ? plain.slice(0, keep) : plain;
}

/** 快照引用归一化(读取 / 多端同步时收敛脏数据):只留合法条目,超上限丢最旧。
 * m 标记原样保留(它决定下一段窗口里 head 是被替换还是被保留)。
 * 放在 normalizeNoteData 里做 → 「解密 → 保存」任何路径都会顺带完成清理。 */
export function normalizeSnaps(raw, { keep = SNAP_KEEP } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    if (typeof s.file !== 'string' || !s.file) continue;
    // spread-first:不认识的可选字段原样带过,只规范化 file/ts/m 三项
    out.push({ ...s, file: s.file, ts: Number.isFinite(s.ts) ? s.ts : 0, ...(s.m ? { m: 1 } : {}) });
  }
  return out.slice(0, keep);
}

/* ---------- 随机密码生成 ---------- */

/** 生成池刻意剔除易混淆字符(0/O/o、1/l/I):抄写密码时少一次看错的风险 */
const GEN_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const GEN_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const GEN_DIGITS = '23456789';
const GEN_BASE = GEN_LOWER + GEN_UPPER + GEN_DIGITS;
const GEN_SYMBOLS = '!@#$%^&*()-_=+[]{}:,.?';

/**
 * 随机密码生成(纯函数,Node/浏览器双端可测)。
 * crypto.getRandomValues + 拒绝采样 —— 不用 Math.random(它不是密码学安全的)。
 * 保底:小写/大写/数字各至少一个(要求符号时符号也至少一个),其余位置均匀分布。
 * @param {number} [len=16] 实际长度收敛到 8~64
 * @param {{symbols?:boolean}} [opt]
 * @returns {string}
 */
export function genPassword(len = 16, { symbols = true } = {}) {
  const n = Math.min(64, Math.max(8, Math.round(Number(len) || 16)));
  const pool = GEN_BASE + (symbols ? GEN_SYMBOLS : '');
  const buf = crypto.getRandomValues(new Uint32Array(n * 2 + 16));
  let i = 0;
  const randBelow = (m) => { // 拒绝采样上界,消除取模偏差
    const limit = Math.floor(0x100000000 / m) * m;
    let v;
    do {
      if (i >= buf.length) { crypto.getRandomValues(buf); i = 0; }
      v = buf[i];
      i += 1;
    } while (v >= limit);
    return v % m;
  };
  const next = () => pool[randBelow(pool.length)];
  // 每个字符类先各取一个 —— 「小写/大写/数字各至少一个(带符号时符号也至少一个)」
  // 是**构造出来**的承诺,不靠事后打补丁(旧写法塞进的字符未必属于缺的那一类,
  // 20 万次实测 len=8 时约半数仍缺数字);其余位置从全池均匀取,最后整体洗牌,
  // 不泄露「哪几位是保底位」。
  const parts = [GEN_LOWER, GEN_UPPER, GEN_DIGITS, ...(symbols ? [GEN_SYMBOLS] : [])];
  const out = parts.map((chars) => chars[randBelow(chars.length)]);
  while (out.length < n) out.push(next());
  for (let j = out.length - 1; j > 0; j--) {
    const k = randBelow(j + 1);
    [out[j], out[k]] = [out[k], out[j]];
  }
  return out.join('');
}

/* ---------- 主密码强度 ---------- */

/** 主密码最短长度。它是唯一同时决定「记不记得住」与「破不破得动」的参数。 */
export const PASSWORD_MIN_LEN = 10;
/** 通过线:估算熵低于它一律拒绝(约等于 64 bit,离线爆破的下限) */
export const PASSWORD_MIN_BITS = 64;
/** 评为「强」的线 */
export const PASSWORD_STRONG_BITS = 90;

/** 一眼就会被字典/规则命中的口令(小写比对),只列高频项,不做穷举 */
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', '1234567890', '12345678901', 'qwertyuiop',
  'qwerty123', '1111111111', 'abc1234567', 'iloveyou', 'admin12345', 'letmein123',
  'welcome123', 'monkey123', 'sunshine1', 'football1', 'jmbiji123', 'jmbiji1234',
  'asdfghjkl', 'zxcvbnm123', 'a123456789', 'aa12345678', '1qaz2wsx3edc',
]);

const SEQUENTIAL = /(0123456789|1234567890|abcdefghij|qwertyuiop|asdfghjkl|zxcvbnm)/;

/** 字符池大小:按是否出现该类字符累加 */
const POOLS = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[^a-zA-Z0-9]/, 33],
];

/**
 * 主密码强度评估(纯函数,离线可测)。
 *
 * 用「长度 × log2(字符池)」估熵,而不是数一数用了几类字符 ——
 * 后者会把 20 位纯小写(94 bit,很强)判成弱,却放行 10 位混合(52 bit,很弱)。
 * 熵只是「防离线爆破」的第二道保险,第一道是访问密钥门。
 *
 * @param {string} pw
 * @returns {{ok:boolean, level:'weak'|'fair'|'strong', bits:number, msg:string}}
 */
export function assessPassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const len = s.length;
  if (len < PASSWORD_MIN_LEN) {
    return { ok: false, level: 'weak', bits: 0, msg: `太短:至少 ${PASSWORD_MIN_LEN} 位(它保护全部数据)` };
  }
  if (WEAK_PASSWORDS.has(s.toLowerCase()) || SEQUENTIAL.test(s.toLowerCase())) {
    return { ok: false, level: 'weak', bits: 0, msg: '太常见或明显连续,换一个' };
  }
  if (/^(.)\1*$/.test(s)) {
    return { ok: false, level: 'weak', bits: 0, msg: '整个密码只有一种字符,换一个' };
  }

  const pool = POOLS.reduce((n, [re, size]) => (re.test(s) ? n + size : n), 0);
  const bits = Math.round(len * Math.log2(pool));
  if (bits >= PASSWORD_STRONG_BITS) {
    return { ok: true, level: 'strong', bits, msg: `很强(约 ${bits} bit),记住它` };
  }
  if (bits >= PASSWORD_MIN_BITS) {
    return { ok: true, level: 'fair', bits, msg: `够用(约 ${bits} bit);再长一点更稳` };
  }
  return {
    ok: false, level: 'weak', bits,
    msg: `偏弱(约 ${bits} bit):加长到 16 位以上,或混入大小写/数字/符号`,
  };
}
