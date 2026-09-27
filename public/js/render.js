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
const SECRET_RE = /^([^:：=\n]{0,48}?(?:密码|口令|私钥|密钥|秘钥|passwo?rds?|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:：=]\s*)([^\s].*)$/im; // m 标志:多行段落里非首行的敏感行也要遮(整段合成一个字符串交给 renderInline)

/** 纯函数,导出供单测:命中返回 {prefix, secret},否则 null */
export function splitSecretLine(text) {
  if (typeof text !== 'string') return null;
  const m = SECRET_RE.exec(text);
  return m ? { prefix: m[1], secret: m[2] } : null;
}

/** 行内标记:把一段文本按 **粗** / ==高亮== / `码` 切分并构建节点。
 *  ⚠️ 敏感行按**行**逐条处理:此前命中第一处敏感行就整体 return,同段后续的
 *  敏感行会明文外露(2026-09-27 真机探针实测:3 行 2 敏感只遮第 1 处)。
 *  现在按行切分,每行独立判定,命中行打星号遮罩,其余行走普通行内标记。 */
export function renderInline(parent, text) {
  const lines = String(text).split('\n');
  lines.forEach((line, idx) => {
    if (idx > 0) parent.appendChild(document.createTextNode('\n'));
    const sec = splitSecretLine(line);
    if (sec) {
      // 结构:span.secret.masked > (span.secret-raw 真值 + span.secret-stars 星号)
      // · 真值必须完整留在 DOM(块复制 data-copy、点击显形、整篇导出都靠它);
      //   但它从「唯一内容」降级为「两个图层之一」,显隐由 .masked 类控制。
      // · 星号数量 = 真值字符数(≤24 截断):比模糊滤镜干净,多处打码不再是满屏糊块。
      //   (2026-09-27 用户反馈:blur(6px) 多处命中时头晕难看,改经典星号)
      renderInlineCore(parent, sec.prefix);
      const span = document.createElement('span');
      span.className = 'secret masked';
      span.title = '点击显示 / 再点隐藏(30 秒无操作自动遮回)';

      const raw = document.createElement('span');
      raw.className = 'secret-raw';
      raw.textContent = sec.secret;

      const stars = document.createElement('span');
      stars.className = 'secret-stars';
      stars.setAttribute('aria-hidden', 'true');
      stars.textContent = '•'.repeat(Math.min(sec.secret.replace(/\s+/g, '').length || 1, 24));

      span.appendChild(raw);
      span.appendChild(stars);
      parent.appendChild(span);
      return;
    }
    renderInlineCore(parent, line);
  });
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
    // 快照复制文本:跳过星号图层(.secret-stars),否则块复制会带上一串 •
    // (textContent 不理会 CSS 显隐,两个图层都会被拼进来)
    el.dataset.copy = [...el.querySelectorAll('.secret')].length
      ? cloneWithoutStars(el).textContent
      : el.textContent;
    root.appendChild(el);
  }

  /** 复制快照用的浅克隆:星号图层置空,真值图层保留 → textContent 即纯净原文 */
  function cloneWithoutStars(el) {
    const c = el.cloneNode(true);
    for (const s of c.querySelectorAll('.secret-stars')) s.textContent = '';
    return c;
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
      listItems.push(ol[2]); // ol[1] 是序号标记(如「1. 」),内容在 ol[2] —— 曾写错导致有序列表正文全丢
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
