/* ============================================================
 * 搜索单测 —— findMatches 纯函数(高亮偏移必须在压缩空白后的串上)
 * 曾经:snipOffset 拿原始下标当压缩后的偏移,匹配词前面一带空白
 * 就高亮错位(实测把 admin123 高亮成了「妥善保存。」)
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, renderSearchResult } from '../public/js/search.js';
import { withDom } from './dom-stub.mjs';

function notesOf(content, title = '无标题') {
  return new Map([['工作', [{ id: 'n1', title, content }]]]);
}

test('findMatches:snipOffset 在压缩空白后仍精确指向匹配词', () => {
  // 匹配词前面有换行与连续空格,压缩空白会让长度缩短 ——
  // 偏移若还按原始下标算,mark 就会落在匹配词之前
  const content = '重要说明:\n\n  账号 admin123 保密,勿泄露。';
  const [hit] = findMatches(notesOf(content), 'admin123');
  assert.ok(hit, '必须命中');
  const marked = hit.snippet.slice(hit.snipOffset, hit.snipOffset + 'admin123'.length);
  assert.equal(marked, 'admin123', `高亮切片应为匹配词,实际:${JSON.stringify(marked)}`);
  assert.equal(hit.snippet, '重要说明: 账号 admin123 保密,勿泄露。', '片段空白应已压缩');
});

test('findMatches:匹配词在片段开头/结尾时偏移不越界', () => {
  const head = findMatches(notesOf('admin123 在最前面'), 'admin123');
  assert.equal(head[0].snipOffset, 0);
  assert.equal(head[0].snippet.slice(0, 8), 'admin123');

  const tail = findMatches(notesOf('前文铺垫很长很长很长很长,admin123'), 'admin123');
  assert.equal(tail[0].snippet.slice(tail[0].snipOffset, tail[0].snipOffset + 8), 'admin123');
});

test('findMatches:标题命中不产片段;无命中返回空数组', () => {
  const byTitle = findMatches(notesOf('正文无关', '密钥说明'), '密钥');
  assert.equal(byTitle[0].inTitle, true);
  assert.equal(byTitle[0].snippet, null);
  assert.equal(findMatches(notesOf('完全无关的正文'), '不存在').length, 0);
});

test('findMatches:空查询直接返回空', () => {
  assert.deepEqual(findMatches(notesOf('任意'), ''), []);
});

/* ---------- 渲染层(2026-10-06 审计 P0:高亮与前缀曾被整体抹掉) ---------- */

test('renderSearchResult:片段保留前缀 + 恰好一个 <mark> 包住匹配词', async () => {
  await withDom(async () => {
    const content = '重要说明: 账号 admin123 保密,勿泄露。';
    const [hit] = findMatches(notesOf(content), 'admin123');
    const li = renderSearchResult(hit, 'admin123');
    const snip = li.children.find((c) => c.tag === 'div' && c.className === 'search-item-snippet');
    const marks = snip.children.filter((c) => c.tag === 'mark');
    assert.equal(marks.length, 1, '必须恰好一个高亮节点');
    assert.equal(marks[0].textContent, 'admin123', '高亮内容必须是匹配词本身');
    // ★ 前缀必须完整保留:旧实现第二次 highlightInto(...,'') 用 textContent 赋值
    //   把前文与 <mark> 一起抹掉,实测只剩「 保密,勿泄露。」
    assert.ok(snip.textContent.startsWith('重要说明: 账号 '), `前缀丢失,实得:${JSON.stringify(snip.textContent)}`);
    assert.equal(snip.textContent, content, '片段拼回来必须等于原文');
  });
});

test('renderSearchResult:命中词在片段开头/结尾/整段命中三种边界都不丢内容', async () => {
  await withDom(async () => {
    for (const [content, q] of [
      ['admin123 是账号,勿泄露', 'admin123'],          // 命中在开头
      ['前置说明很长,末尾是 admin123', 'admin123'],   // 命中在结尾
      ['admin123', 'admin123'],                       // 整段就是命中词
    ]) {
      const [hit] = findMatches(notesOf(content), q);
      const li = renderSearchResult(hit, q);
      const snip = li.children.find((c) => c.tag === 'div' && c.className === 'search-item-snippet');
      const marks = snip.children.filter((c) => c.tag === 'mark');
      assert.equal(marks.length, 1, `「${content}」高亮数不对`);
      assert.equal(marks[0].textContent, q);
      assert.ok(snip.textContent.includes(q), `「${content}」匹配词丢失`);
      if (content !== q) assert.ok(snip.textContent.length > q.length, `「${content}」其余内容被吃掉`);
    }
  });
});

test('renderSearchResult:标题命中走 <mark>、标题未命中不高亮', async () => {
  await withDom(async () => {
    const [hit] = findMatches(notesOf('正文里没有 query', 'CF 中转配置'), '中转');
    const li = renderSearchResult(hit, '中转');
    const title = li.children.find((c) => c.tag === 'div' && c.className === 'search-item-title');
    const marks = title.children.filter((c) => c.tag === 'mark');
    assert.equal(marks.length, 1, '标题命中必须有高亮');
    assert.equal(marks[0].textContent, '中转');
    assert.equal(title.textContent, 'CF 中转配置');
  });
});
