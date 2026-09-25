/* ============================================================
 * 搜索单测 —— findMatches 纯函数(高亮偏移必须在压缩空白后的串上)
 * 曾经:snipOffset 拿原始下标当压缩后的偏移,匹配词前面一带空白
 * 就高亮错位(实测把 admin123 高亮成了「妥善保存。」)
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches } from '../public/js/search.js';

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
