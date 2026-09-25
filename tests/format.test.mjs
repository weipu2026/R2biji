/* 库结构 / 文件名规则单测 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCategoryName, findCaseCollision,
  looksLikeConflictCopy, backupFileName, parseBackupFileName,
  planBackupRotation, blobDisplayName, sortNotes, orderBetween,
  stripEnc, isEncryptedName, SEAFILE_IGNORE_CONTENT,
  assessPassword, PASSWORD_MIN_LEN, relTime, genPassword,
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

test('附件命名:保留扩展名且限长', () => {
  assert.equal(blobDisplayName('AbC-123_x', '截图.png'), 'AbC-123_x.png');
  assert.equal(blobDisplayName('AbC', 'noext'), 'AbC');
  assert.equal(blobDisplayName('AbC', 'a.very.long.extension'), 'AbC.extension');
});

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
