/* 库结构 / 文件名规则单测 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCategoryName, findCaseCollision,
  looksLikeConflictCopy, backupFileName, parseBackupFileName,
  planBackupRotation, sortNotes, orderBetween,
  sortCats, catMovePatch, CAT_ORDER_STEP,
  stripEnc, isEncryptedName, SEAFILE_IGNORE_CONTENT,
  assessPassword, PASSWORD_MIN_LEN, relTime, genPassword,
  statusAllowsOverride, STATUS_RANK,
} from '../public/js/format.js';

test('分类名清洗:非法字符 / 空白 / 限长', () => {
  assert.equal(sanitizeCategoryName('秘钥'), '秘钥');
  assert.equal(sanitizeCategoryName('API/密钥'), 'API密钥');
  assert.equal(sanitizeCategoryName('  a:b*c?  '), 'abc');
  assert.equal(sanitizeCategoryName('x'.repeat(100)), 'x'.repeat(60));
  assert.equal(sanitizeCategoryName('///'), null);
  assert.equal(sanitizeCategoryName(''), null);
  assert.equal(sanitizeCategoryName(null), null);
});

test('大小写撞名检测(Win/macOS 文件系统不区分大小写)', () => {
  assert.equal(findCaseCollision(['攻略', 'api'], 'API'), 'api');
  assert.equal(findCaseCollision(['攻略', 'API'], 'API'), null);
  assert.equal(findCaseCollision(['攻略'], '秘钥'), null);
});

test('冲突副本识别', () => {
  assert.ok(looksLikeConflictCopy('攻略 (SF冲突).enc'));
  assert.ok(looksLikeConflictCopy('攻略 (冲突副本 2026-09-24).enc'));
  assert.ok(looksLikeConflictCopy('xxx (conflicted copy).enc'));
  assert.ok(!looksLikeConflictCopy('攻略.enc'));
});

test('备份命名往返', () => {
  const name = backupFileName('攻略', 1727000000000);
  assert.equal(name, '攻略.1727000000000.enc');
  assert.deepEqual(parseBackupFileName(name), { base: '攻略', ts: 1727000000000, suffix: '', name });
  assert.equal(parseBackupFileName('攻略.enc'), null);
  assert.equal(parseBackupFileName('vault.1727000000000.enc').base, 'vault');
  assert.ok(isEncryptedName(name));
  assert.equal(stripEnc(name), '攻略.1727000000000');

  // 带随机后缀(同一毫秒内多次备份):能解析,且原文件名原样带回
  const withSuffix = backupFileName('攻略', 1727000000000, 'a1b2c3');
  assert.equal(withSuffix, '攻略.1727000000000-a1b2c3.enc');
  assert.deepEqual(parseBackupFileName(withSuffix), { base: '攻略', ts: 1727000000000, suffix: 'a1b2c3', name: withSuffix });
});

test('备份轮换:保留最新 10 份,删其余', () => {
  const names = [];
  for (let i = 0; i < 15; i++) names.push(backupFileName('攻略', 1727000000000 + i));
  const toDelete = planBackupRotation(names, 10);
  assert.equal(toDelete.length, 5);
  // 删的是最旧的 5 份
  for (const d of toDelete) {
    const ts = parseBackupFileName(d).ts;
    assert.ok(ts < 1727000000005);
  }
  // 少于 10 份时 nothing to delete
  assert.deepEqual(planBackupRotation(names.slice(0, 3), 10), []);
  // 非备份命名的文件不受影响
  assert.deepEqual(planBackupRotation(['readme.txt', '攻略.enc'], 10), []);
});

test('备份轮换:同一毫秒写入的多份(带随机后缀)不会互相顶掉', () => {
  // 实测连续 12 次 Date.now() 返回同一个值,靠时间戳命名会让 12 份备份只剩 1 份。
  const ts = 1727000000000;
  const names = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', '07', '18', '29', '3a', '4b', '5c']
    .map((sfx) => backupFileName('日志', ts, sfx));
  assert.equal(new Set(names).size, 12, '12 份备份必须是 12 个不同的文件名');
  const toDelete = planBackupRotation(names, 10);
  assert.equal(toDelete.length, 2);
  // 删除时按原文件名删(不能重新拼,否则会丢后缀 → 删不掉)
  for (const d of toDelete) assert.ok(names.includes(d));
});

/* 附件命名单测已随 blobDisplayName 删除(2026-09-27 审计 P3-3:与生效的
 * blobFileNameFor 规则不一致的平行实现,误导维护者)。真实规则的单测在
 * vault.test.mjs 的 blobFileNameFor 用例里。 */

test('笔记排序与 order 计算', () => {
  const notes = [
    { order: 2000, createdAt: 1 }, { order: 1000, createdAt: 9 }, { order: 1000, createdAt: 2 },
  ];
  const sorted = sortNotes(notes);
  assert.deepEqual(sorted.map((n) => n.order), [1000, 1000, 2000]);
  assert.equal(sorted[0].createdAt, 2);
  assert.ok(sortNotes(notes) !== notes, '应返回副本,不改原数组');

  assert.equal(orderBetween(null, null), 1000);
  assert.equal(orderBetween(null, 500), -500);
  assert.equal(orderBetween(500, null), 1500);
  assert.equal(orderBetween(1000, 2000), 1500);
});

test('笔记排序:置顶优先,组内按 order;pin 非布尔值不炸', () => {
  const notes = [
    { order: 1, createdAt: 1 },                // 普通组最前
    { order: 9000, createdAt: 2, pin: true },  // 置顶组,order 最大
    { order: 2, createdAt: 3 },                // 普通组
    { order: 1000, createdAt: 4, pin: 'yes' }, // 脏值:只有 === true 才算置顶
    { order: 500, createdAt: 5, pin: true },   // 置顶组,order 最小
  ];
  const sorted = sortNotes(notes);
  assert.deepEqual(sorted.map((n) => n.pin === true), [true, true, false, false, false]);
  assert.deepEqual(sorted.map((n) => n.order), [500, 9000, 1, 2, 1000]);
  assert.ok(sortNotes(notes) !== notes, '应返回副本,不改原数组');
});

test('seafile-ignore 内容恰好两行且不忽略自己人', () => {
  const lines = SEAFILE_IGNORE_CONTENT.trim().split('\n');
  assert.deepEqual(lines, ['*.crswap', 'backup/']);
  assert.ok(!SEAFILE_IGNORE_CONTENT.includes('.enc'));
  assert.ok(!SEAFILE_IGNORE_CONTENT.includes('vault.json'));
});

/* ---------- 主密码强度 ---------- */

test('密码强度:拒绝过短 / 常见 / 单一字符', () => {
  assert.equal(PASSWORD_MIN_LEN, 10);
  for (const pw of ['', 'short', 'a'.repeat(9), 'password', 'Password1', '1234567890', 'abcdEFGHIJ', null, undefined]) {
    const r = assessPassword(pw);
    assert.equal(r.ok, false, `「${pw}」应被拒`);
    assert.equal(r.level, 'weak');
    assert.ok(r.msg.length > 0);
  }
  const same = assessPassword('a'.repeat(15));
  assert.equal(same.ok, false);
  assert.ok(same.msg.includes('一种字符'), '整串同字符应单独提示');

  // 最短长度是硬底,且必须是「太短」这条提示 —— 9 位就算把字符池拉满
  // (大小写+数字+符号)也得被长度拦下,而不是绕到熵里给一句模糊的「偏弱」。
  const dense9 = assessPassword('Kx7#mQ2!v');
  assert.equal(dense9.ok, false);
  assert.ok(dense9.msg.includes('太短'), `9 位混合字符应报「太短」,实际:${dense9.msg}`);
});

test('密码强度:合格与优秀的分档', () => {
  const fair = assessPassword('hensy-tiger-9');
  assert.equal(fair.ok, true);
  assert.equal(fair.level, 'fair');
  const strong = assessPassword('Kx7#mQ2!vLn9@Wp4');
  assert.equal(strong.ok, true);
  assert.equal(strong.level, 'strong');
  // 单一字符类别但足够长(≥16)→ 放行:长度已把爆破成本拉够
  assert.equal(assessPassword('x'.repeat(20)).ok, false, '整串同字符仍应拒');
  assert.equal(assessPassword('qwrtpldkfjghsnmxbvz').ok, true, '20 位纯字母应放行');
  assert.equal(assessPassword('abc1234567').ok, false, '顺序串应拒');
});

test('genPassword:长度 / 字符集 / 易混淆剔除 / 类别保底 / 随机性', () => {
  for (const [len, sym] of [[8, true], [16, true], [32, false], [64, true]]) {
    const pw = genPassword(len, { symbols: sym });
    assert.equal(pw.length, len, `长度应为 ${len}`);
    assert.ok(!/[0O1lIo]/.test(pw), '易混淆字符(0/O/1/l/I/o)必须剔除');
    if (!sym) assert.ok(!/[!@#$%^&*()\-_=+[\]{}:,.?]/.test(pw), '关掉符号后不应出现符号');
  }
  const pw = genPassword(16);
  assert.ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw), '三类字符各至少一个');
  // 类别保证必须是**构造出来**的:旧实现靠事后补塞(塞进的字符未必属于缺的那类),
  // 20 万次实测 len=8 约 47% 仍缺数字 —— 这里 300 次小长度全部四类齐全才能通过
  for (let i = 0; i < 300; i++) {
    const p8 = genPassword(8);
    assert.ok(/[a-z]/.test(p8) && /[A-Z]/.test(p8) && /[0-9]/.test(p8) && /[^a-zA-Z0-9]/.test(p8),
      `第 ${i} 次生成缺少字符类`);
  }
  for (let i = 0; i < 100; i++) {
    const p8 = genPassword(8, { symbols: false });
    assert.ok(/[a-z]/.test(p8) && /[A-Z]/.test(p8) && /[0-9]/.test(p8),
      `无符号模式第 ${i} 次缺少字符类`);
  }
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(genPassword(16));
  assert.ok(seen.size > 45, '50 次生成几乎不应重复');
  assert.equal(genPassword(3).length, 8, '低于下限按 8 处理');
  assert.equal(genPassword(999).length, 64, '高于上限按 64 处理');
  assert.equal(genPassword('垃圾').length, 16, '非法输入按默认 16 处理');
});

/* ---------- 相对时间 ---------- */

test('relTime:今天带时刻 / 昨天 / 同年月日 / 跨年补年份 / 非法输入', () => {
  const now = new Date(2026, 8, 24, 22, 0).getTime(); // 2026-09-24 22:00
  const t = (mo, d, h = 12, mi = 30, y = 2026) => new Date(y, mo, d, h, mi).getTime();
  assert.equal(relTime(t(8, 24), now), '今天 12:30');
  assert.equal(relTime(t(8, 24, 8, 5), now), '今天 08:05');
  assert.equal(relTime(t(8, 23), now), '昨天 12:30');
  assert.equal(relTime(t(8, 1), now), '9月1日');
  assert.equal(relTime(t(0, 15), now), '1月15日');
  assert.equal(relTime(t(11, 31, 12, 0, 2025), now), '2025年12月31日');
  // 未来时间戳(设备间时钟偏差):按今天算,不出负数怪话
  assert.equal(relTime(t(8, 24, 23, 0), now), '今天 23:00');
  assert.equal(relTime(Number.NaN, now), '');
  assert.equal(relTime(undefined, now), '');
});

/* ---------- 状态栏优先级(防「保存失败」被防抖的『已保存』盖掉) ---------- */

test('statusAllowsOverride:低优先级不得覆盖高优先级,error 粘性', () => {
  assert.equal(STATUS_RANK.error > STATUS_RANK.busy, true, 'error 高于 busy');
  assert.equal(STATUS_RANK.busy > STATUS_RANK.dirty, true, 'busy 高于 dirty');
  assert.equal(STATUS_RANK.dirty > STATUS_RANK.ok, true, 'dirty 高于 ok');

  // 未设过(-1)一律放行
  assert.equal(statusAllowsOverride(-1, 'ok'), true);
  assert.equal(statusAllowsOverride(-1, 'error'), true);

  // ★ 核心场景:已显示 error(rank 3),防抖回调想写『已保存』(ok, 0)→ 必须拦
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'ok'), false, 'error 不得被 ok 盖');
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'dirty'), false, 'error 不得被 dirty 盖');
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'busy'), false, 'error 不得被 busy 盖');
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'error'), true, 'error 可被新 error 刷新');

  // busy 可被 error 盖(升级);非权威来源不可被 ok/dirty 盖(降级)
  assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'error'), true);
  assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'ok'), false);

  // dirty 可被 busy/error 盖(保存开始/失败);非权威来源不可被 ok 盖(降级)
  assert.equal(statusAllowsOverride(STATUS_RANK.dirty, 'busy'), true);
  assert.equal(statusAllowsOverride(STATUS_RANK.dirty, 'ok'), false);

  // ok 可被任何状态盖
  assert.equal(statusAllowsOverride(STATUS_RANK.ok, 'dirty'), true);
  assert.equal(statusAllowsOverride(STATUS_RANK.ok, 'error'), true);
  // ok 自身可刷新(连续显示)
  assert.equal(statusAllowsOverride(STATUS_RANK.ok, 'ok'), true);

  // 未知 kind 按最低优先级处理:不得盖过高优先级
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'whatever'), false);
});

/* ★ 2026-09-27 回归修复:busy 是过渡态,不许粘住终态收尾。
 * 背景:上一轮加优先级守卫时,把 busy 也当成了粘性状态 →
 *   saveAll 里 setStatus('保存中…','busy') 之后,refreshSaveStatus 写的
 *   「已保存」(rank 0) 被守卫拒掉 → 状态栏**永久卡在「保存中…」**。
 *   保存其实成功了(PUT 全部 200),用户却以为没存上。此前的单测
 *   (上面那句 busy→ok 应为 false)恰好把错误行为固化了,所以全绿也没拦住。
 * 这条用例的存在意义:一旦有人把 authoritative 分支删掉,它必须立刻翻红。 */
test('statusAllowsOverride:权威终态可收尾过渡态,但永远盖不动 error', () => {
  // 保存流程跑完 → 权威写入「已保存」/「有未保存更改」,必须能盖掉 busy
  assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'ok', true), true, '权威 ok 必须能收尾 busy');
  assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'dirty', true), true, '权威 dirty 必须能收尾 busy');
  assert.equal(statusAllowsOverride(STATUS_RANK.dirty, 'ok', true), true, '权威 ok 必须能收尾 dirty');

  // ★ 但 error 是唯一粘性状态:权威终态也不许把它改写成假绿
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'ok', true), false, '权威 ok 不得盖 error');
  assert.equal(statusAllowsOverride(STATUS_RANK.error, 'dirty', true), false, '权威 dirty 不得盖 error');

  // 非权威来源在 busy 前依然要按优先级守规矩(防止中途被静默降级)
  assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'ok', false), false);
  assert.equal(statusAllowsOverride(STATUS_RANK.busy, 'dirty', false), false);
});

/* ---------- 分类排序与手动调序(2026-09-28) ---------- */

/** 把 { 名: meta } 包成 sortCats / catMovePatch 要的 metaOf 取值器 */
const metaOf = (obj) => (n) => obj[n] || {};

test('sortCats:置顶优先 → 手动 order 升序 → 名称兜底', () => {
  const meta = { a: { order: 2000 }, b: { order: 1000 }, c: { pin: true, order: 9000 }, d: { pin: true, order: 8000 } };
  assert.deepEqual(sortCats(['a', 'b', 'c', 'd'], metaOf(meta)), ['d', 'c', 'b', 'a']);
});

test('sortCats:从未排过序的分类(无 order)落在末尾,组内按名称兜底', () => {
  const meta = { a: { order: 1000 } };
  assert.deepEqual(sortCats(['c', 'a', 'b'], metaOf(meta)), ['a', 'b', 'c']);
});

test('sortCats:不改入参(返回新数组)', () => {
  const names = ['b', 'a'];
  const out = sortCats(names, metaOf({}));
  assert.notEqual(out, names, '必须返回新数组');
  assert.deepEqual(names, ['b', 'a'], '入参顺序不得被就地改写');
});

test('catMovePatch:顺序干净时只交换相邻两项的值(order 不漂移)', () => {
  const meta = { a: { order: 1000 }, b: { order: 2000 }, c: { order: 3000 } };
  assert.deepEqual(catMovePatch(['a', 'b', 'c'], metaOf(meta), 'b', -1), { a: 2000, b: 1000, c: 3000 });
});

test('catMovePatch:★上移一次后视觉顺序确实前移一位(不是「点了没反应」)', () => {
  const meta = { a: { order: 1000 }, b: { order: 2000 }, c: { order: 3000 } };
  const m = metaOf(meta);
  assert.deepEqual(sortCats(['a', 'b', 'c'], m), ['a', 'b', 'c'], '前置:初始顺序');
  const patch = catMovePatch(['a', 'b', 'c'], m, 'c', -1);
  const after = metaOf(Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [k, { ...(meta[k] || {}), order: v }])));
  assert.deepEqual(sortCats(['a', 'b', 'c'], after), ['a', 'c', 'b'],
    '★ 补丁应用回 meta 后,该分类必须真的前进一位');
});

test('catMovePatch:首次使用(全无 order)按当前视觉顺序铺一遍再交换', () => {
  // 视觉顺序 = 名称序 a,b,c → 铺开 a=1000 b=2000 c=3000,再把 b 与 a 交换
  assert.deepEqual(catMovePatch(['c', 'a', 'b'], metaOf({}), 'b', -1), { a: 2000, b: 1000, c: 3000 });
});

test('catMovePatch:补丁覆盖全部分类(materialize 只写两个会漏掉其余)', () => {
  const patch = catMovePatch(['a', 'b', 'c'], metaOf({}), 'c', -1);
  assert.equal(Object.keys(patch).length, 3);
  assert.equal(CAT_ORDER_STEP, 1000, '步长是外部依赖的值,改了要一起改文档');
});

test('catMovePatch:order 有重复值时重新铺开(交换两个相等的值 = 点了没反应)', () => {
  const meta = { a: { order: 1000 }, b: { order: 1000 } };
  const patch = catMovePatch(['a', 'b'], metaOf(meta), 'b', -1);
  assert.deepEqual(patch, { a: 2000, b: 1000 });
  assert.equal(new Set(Object.values(patch)).size, 2, '重铺后两个值必须互不相同');
});

test('catMovePatch:端点 / 不存在的分类一律返回 null', () => {
  const meta = { a: { order: 1000 }, b: { order: 2000 } };
  assert.equal(catMovePatch(['a', 'b'], metaOf(meta), 'a', -1), null, '首项上移');
  assert.equal(catMovePatch(['a', 'b'], metaOf(meta), 'b', 1), null, '末项下移');
  assert.equal(catMovePatch(['a', 'b'], metaOf(meta), '不存在', 1), null);
  assert.equal(catMovePatch([], metaOf(meta), 'a', 1), null, '空列表');
});

test('catMovePatch:★不跨置顶分区', () => {
  const meta = { a: { pin: true, order: 1000 }, b: { pin: true, order: 2000 }, c: { order: 3000 } };
  const m = metaOf(meta);
  assert.equal(catMovePatch(['a', 'b', 'c'], m, 'b', 1), null, '★ 置顶组末项不得下移进未置顶组');
  assert.equal(catMovePatch(['a', 'b', 'c'], m, 'c', -1), null, '★ 未置顶组首项不得上移进置顶组');
  assert.deepEqual(catMovePatch(['a', 'b', 'c'], m, 'b', -1), { a: 2000, b: 1000, c: 3000 },
    '分组内部照常可动');
});

test('catMovePatch:未排过序时置顶分区内部也能动(分区判定先于顺序铺开)', () => {
  const meta = { z: { pin: true }, y: { pin: true }, a: {} };
  const m = metaOf(meta);
  assert.deepEqual(sortCats(['z', 'y', 'a'], m), ['y', 'z', 'a'], '前置:视觉顺序');
  assert.deepEqual(catMovePatch(['z', 'y', 'a'], m, 'z', -1), { y: 2000, z: 1000, a: 3000 });
});
