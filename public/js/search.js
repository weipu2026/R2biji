/* ============================================================
 * JMbiji 搜索 —— 标题与正文实时过滤(纯函数 + DOM 高亮在 render.js)
 * ============================================================ */

import { highlightInto } from './render.js';

/**
 * 在已解密的全部笔记里找匹配。
 * @param {Map<string, object[]>} notesByCat 分类名 → 笔记数组
 * @param {string} query
 * @param {number} ctx 片段上下文字符数
 * @returns {{cat:string, note:object, inTitle:boolean, snippet:string, snipOffset:number}[]}
 */
export function findMatches(notesByCat, query, ctx = 26) {
  const q = query.toLowerCase();
  if (!q) return [];
  const out = [];
  for (const [cat, notes] of notesByCat) {
    for (const note of notes) {
      const inTitle = note.title.toLowerCase().includes(q);
      const rawIdx = note.content.toLowerCase().indexOf(q);
      if (!inTitle && rawIdx < 0) continue;
      let snippet = null;
      let snipOffset = -1;
      if (rawIdx >= 0) {
        const start = Math.max(0, rawIdx - ctx);
        // 压缩空白会改变长度,高亮偏移必须在**压缩后的串**上重新定位:
        // 先量出「匹配词之前那段」压缩后的长度,它才是匹配词的新起点
        // (旧写法拿原始下标当压缩后的偏移,匹配词前面一带空白就高亮错位)
        const before = note.content.slice(start, rawIdx).replace(/\s+/g, ' ');
        snippet = note.content.slice(start, rawIdx + q.length + ctx).replace(/\s+/g, ' ');
        snipOffset = before.length;
      }
      out.push({ cat, note, inTitle, snippet, snipOffset, qLen: query.length });
    }
  }
  return out;
}

/** 渲染单条搜索结果(纯 DOM + <mark> 高亮) */
export function renderSearchResult(result, query) {
  const li = document.createElement('li');
  li.className = 'search-item';
  li.dataset.cat = result.cat;
  li.dataset.noteId = result.note.id;

  const title = document.createElement('div');
  title.className = 'search-item-title';
  highlightInto(title, result.note.title || '无标题', result.inTitle ? query : '');
  li.appendChild(title);

  if (result.snippet != null) {
    const snip = document.createElement('div');
    snip.className = 'search-item-snippet';
    const offset = result.snipOffset;
    highlightInto(snip, result.snippet.slice(0, offset), '');
    const mark = document.createElement('mark');
    mark.textContent = result.snippet.slice(offset, offset + query.length);
    snip.appendChild(mark);
    highlightInto(snip, result.snippet.slice(offset + query.length), '');
    li.appendChild(snip);
  }

  const cat = document.createElement('div');
  cat.className = 'search-item-cat';
  cat.textContent = result.cat;
  li.appendChild(cat);
  return li;
}
