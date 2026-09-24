/* ============================================================
 * JMbiji Markdown 子集渲染器 —— 纯 DOM 构建
 *
 * 安全边界(DESIGN.md §7.3):
 *   - 全程 createElement/createTextNode,零 innerHTML
 *   - 不解析链接、不解析任何 HTML → 无执行面
 *   支持:#/##/### 标题、**加粗**、*斜体*、~~删除线~~、==高亮==、
 *         `行内代码`、``` 代码块、- 无序列表、1. 有序列表
 * ============================================================ */

/* 交替顺序即优先级:**粗** 必须先于 *斜*(否则双星会被拆成两个单星);
 * 故意不做 _下划线_ 斜体 —— 中文语境下划线常见于 snake_case,误伤面太大 */
const INLINE_RE = /(\*\*([^*\n]+)\*\*)|(==([^=\n]+)==)|(`([^`\n]+)`)|(~~([^~\n]+)~~)|(\*([^*\n]+)\*)/g;

/**
 * 敏感行识别:密码/口令/密钥/token 等赋值行,拆成「前缀 + 敏感值」。
 * 阅读视图里敏感值默认打码、点击显形 —— 防的是旁人瞟屏,不是本机攻击者
 * (值本来就完整存在于浏览器内存里,这点 SECURITY.md 的威胁模型讲得很清楚)。
 * 只认「关键字后跟 :/=/：」的赋值形态;「密码学:一门学科」这类也会命中 ——
 * 宁遮勿漏,点一下就显形,误遮的代价远小于漏遮。
 */
const SECRET_RE = /^([^:：=\n]{0,48}?(?:密码|口令|私钥|密钥|秘钥|passwo?rds?|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:：=]\s*)([^\s].*)$/i;

/** 纯函数,导出供单测:命中返回 {prefix, secret},否则 null */
export function splitSecretLine(text) {
  if (typeof text !== 'string') return null;
  const m = SECRET_RE.exec(text);
  return m ? { prefix: m[1], secret: m[2] } : null;
}

/** 行内标记:把一段文本按 **粗** / ==高亮== / `码` 切分并构建节点 */
export function renderInline(parent, text) {
  const sec = splitSecretLine(text);
  if (sec) {
    // 敏感值原样进 DOM(块复制、点击显形都靠它),视觉遮蔽交给 .masked 的 CSS
    renderInlineCore(parent, sec.prefix);
    const span = document.createElement('span');
    span.className = 'secret masked';
    span.textContent = sec.secret;
    span.title = '点击显示 / 再点隐藏(30 秒无操作自动遮回)';
    parent.appendChild(span);
    return;
  }
  renderInlineCore(parent, text);
}

function renderInlineCore(parent, text) {
  INLINE_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const b = document.createElement('strong');
      b.textContent = m[2];
      parent.appendChild(b);
    } else if (m[3] !== undefined) {
      const mark = document.createElement('mark');
      mark.textContent = m[4];
      parent.appendChild(mark);
    } else if (m[7] !== undefined) {
      const del = document.createElement('del');
      del.textContent = m[8];
      parent.appendChild(del);
    } else if (m[9] !== undefined) {
      const em = document.createElement('em');
      em.textContent = m[10];
      parent.appendChild(em);
    } else {
      const code = document.createElement('code');
      code.textContent = m[6];
      parent.appendChild(code);
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

/**
 * 渲染整篇内容为块级元素序列。
 * @param {string} content
 * @returns {HTMLElement} div.md(每个块带 .blk 与 data-copy 全文,供逐块复制)
 */
export function renderMarkdown(content) {
  const root = document.createElement('div');
  root.className = 'md';
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');

  const para = [];
  let listItems = null;
  let listTag = null;

  const flushPara = () => {
    if (!para.length) return;
    addBlock('p', null, para.join('\n'));
    para.length = 0;
  };
  const flushList = () => {
    if (!listItems) return;
    addBlock(listTag, listItems, null);
    listItems = null;
    listTag = null;
  };

  function addBlock(tag, items, text) {
    let el;
    if (tag === 'pre') {
      el = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = text;
      el.appendChild(code);
    } else if (tag === 'ul' || tag === 'ol') {
      el = document.createElement(tag);
      for (const item of items) {
        const li = document.createElement('li');
        renderInline(li, item);
        el.appendChild(li);
      }
    } else {
      el = document.createElement(tag);
      renderInline(el, text);
    }
    el.classList.add('blk');
    el.dataset.copy = el.textContent;
    root.appendChild(el);
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // 吞掉收尾 ```(未闭合则到文末)
      addBlock('pre', null, buf.join('\n'));
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      addBlock(`h${heading[1].length}`, null, heading[2]);
      i += 1;
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (listTag !== 'ul') { flushList(); listItems = []; listTag = 'ul'; }
      listItems.push(ul[1]);
      i += 1;
      continue;
    }

    const ol = /^(\d{1,3}[.)]\s+|\d{1,3}、\s*)(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (listTag !== 'ol') { flushList(); listItems = []; listTag = 'ol'; }
      listItems.push(ol[1]);
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      flushPara(); flushList();
      i += 1;
      continue;
    }

    flushList();
    para.push(line);
    i += 1;
  }
  flushPara(); flushList();
  return root;
}

/** 纯文本导出(复制全文用) */
export function notePlainText(note) {
  return note.content;
}

/** 在父元素内构建带 <mark> 高亮的文本(搜索结果用),纯 DOM */
export function highlightInto(parent, text, query) {
  if (!query) {
    parent.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let from = 0;
  let idx;
  while ((idx = lower.indexOf(q, from)) !== -1) {
    if (idx > from) parent.appendChild(document.createTextNode(text.slice(from, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + query.length);
    parent.appendChild(mark);
    from = idx + query.length;
  }
  if (from < text.length) parent.appendChild(document.createTextNode(text.slice(from)));
}
