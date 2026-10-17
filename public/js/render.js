/* ============================================================
 * JMbiji Markdown 子集渲染器 —— 纯 DOM 构建
 *
 * 安全边界(DESIGN.md §7.3):
 *   - 全程 createElement/createTextNode,零 innerHTML
 *   - 不解析链接、不解析任何 HTML → 无执行面
 *   支持:#/##/### 标题、**加粗**、*斜体*、~~删除线~~、==高亮==、
 *         `行内代码`、``` 代码块、- 无序列表、1. 有序列表、- [ ] 任务列表、--- 分割线
 * ============================================================ */

/* 块级形态:任务列表与分割线。
 * ⚠️ 任务列表必须**先于**无序列表判定 —— 否则「- [ ] 买菜」会被 ul 当成普通条目,
 *   「[ ] 」原样留在正文里(用户看到的是一串字符,而不是一个勾选框)。
 * 分割线与 ul 不冲突:ul 要求 `[-*]` 后紧跟空白,而 `---` / `***` / `___` 都没有。
 * ⚠️ 阅读站 recover.html 的 rdrMd 是同一套子集的**第二实现**,两处必须同步。 */
const TASK_RE = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;

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
const SECRET_RE = /^([^:：=\n]{0,48}?(?:密码|口令|私钥|密钥|秘钥|key|passwo?rds?|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:：=]\s*)([^\s].*)$/im; // m 标志:多行段落里非首行的敏感行也要遮(整段合成一个字符串交给 renderInline)

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
      // 结构:span.secret.masked > (span.secret-raw 前缀+真值 / span.secret-stars 星号)
      // · **前缀(「密码:」等)也放进 raw 层**:遮罩态整行只剩一串星号,不再有
      //   突兀的「密码:」字样;点击显形才连前缀一起出现。
      //   (2026-09-27 用户反馈:多处打码时前面挂着一排「密码:」很突兀)
      // · raw 层必须是 span 的完整内容 —— 块复制 data-copy(cloneWithoutStars)
      //   依赖它拿回「前缀+真值」的原文。
      // · 星号数量只按**值**的字符数算(≤24 截断):前缀不参与,否则星号串过长。
      const span = document.createElement('span');
      span.className = 'secret masked';
      span.title = '点击显示 / 再点隐藏(30 秒无操作自动遮回)';
      /* 键盘可达(2026-09-29 审计 P3):这个可点区域以前只认鼠标 —— 键盘用户既看不见
       * 值、也拿不到自己的密码,而 title 还写着「点击显示」。进 Tab 序 + 按钮语义,
       * Enter/空格 的处理器在 shell.js(与鼠标点击共用同一条切换逻辑)。
       * ⚠️ aria-label 用中性文案:可访问名里绝不能带上真值本身。 */
      span.setAttribute('tabindex', '0');
      span.setAttribute('role', 'button');
      span.setAttribute('aria-expanded', 'false');
      span.setAttribute('aria-label', '敏感内容,按回车显示或隐藏');

      const raw = document.createElement('span');
      raw.className = 'secret-raw';
      raw.textContent = sec.prefix + sec.secret;

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
    } else if (tag === 'hr') {
      el = document.createElement('hr');
    } else if (tag === 'ul' || tag === 'ol') {
      el = document.createElement(tag);
      for (const item of items) {
        // 条目要么是字符串(普通条目),要么是 { text, task, checked }
        const it = typeof item === 'string' ? { text: item } : item;
        const li = document.createElement('li');
        if (it.task) {
          li.classList.add('task');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'task-box';
          box.checked = !!it.checked;
          /* disabled:只读内容里的勾选框不该可点,更不该进 Tab 序 ——
           * 否则一篇任务清单会多出几十个 Tab 停靠点,读屏器还会把它念成表单。 */
          box.disabled = true;
          li.appendChild(box);
        }
        renderInline(li, it.text);
        el.appendChild(li);
      }
    } else {
      el = document.createElement(tag);
      renderInline(el, text);
    }
    el.classList.add('blk');
    el.dataset.copy = copyTextOf(el);
    root.appendChild(el);
  }

  /** 块的复制文本。两处必须「修正」:
   *  · 敏感行:双图层后 textContent 会把 raw+stars 拼起来 → 剔除星号层,
   *    否则用户点「复制本段」得到的是 '密码:xxx••••';
   *  · 任务列表:checkbox 是表单元素、不贡献 textContent → 补回 [x]/[ ] 标记,
   *    否则「复制本段」会静默丢掉勾选状态(看到的与复制到的不是一回事)。
   *  ⚠️ 只用 .class 选择器:测试替身(dom-stub / render.test)只支持 .class。 */
  function copyTextOf(el) {
    if (el.querySelectorAll('.task-box').length) {
      return [...el.children].map((li) => {
        const box = li.querySelectorAll('.task-box')[0];
        return (box ? (box.checked ? '[x] ' : '[ ] ') : '') + cloneWithoutStars(li).textContent;
      }).join('\n');
    }
    return el.querySelectorAll('.secret').length ? cloneWithoutStars(el).textContent : el.textContent;
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

    if (HR_RE.test(line)) {
      flushPara(); flushList();
      addBlock('hr', null, '');
      i += 1;
      continue;
    }

    const task = TASK_RE.exec(line);
    if (task) {
      flushPara();
      if (listTag !== 'ul') { flushList(); listItems = []; listTag = 'ul'; }
      listItems.push({ text: task[2], task: true, checked: task[1].toLowerCase() === 'x' });
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
