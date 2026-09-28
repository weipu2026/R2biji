/* 渲染器单测:Node 环境用最小 DOM 桩(renderMarkdown 只用 createElement/textContent/classList/dataset) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline, highlightInto, splitSecretLine } from '../public/js/render.js';

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.classes = new Set();
    this.dataset = {};
    this._text = null;
    this.attrs = {};
  }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self.classes.delete(c)),
      toggle: (c, on) => { if (on === undefined) { self.classes.has(c) ? self.classes.delete(c) : self.classes.add(c); } else if (on) self.classes.add(c); else self.classes.delete(c); },
      contains: (c) => self.classes.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  /** 子树内按 class 前缀匹配(测试桩够用:生产代码只查 .secret / .secret-stars) */
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (String(c.className).split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  cloneNode() {
    const c = new FakeNode(this.tag);
    c.classes = new Set(this.classes);
    c.dataset = { ...this.dataset };
    c._text = this._text;
    c.attrs = { ...this.attrs };
    // children 是引用共享的 —— 但 cloneWithoutStars 只改克隆树上星号层的 textContent,
    // 该 setter 会清 children 并设 _text,不会污染原树;其余节点只读
    for (const ch of this.children) c.children.push(ch.cloneNode ? ch.cloneNode() : ch);
    return c;
  }
}

function withDom(fn) {
  global.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => new FakeNode(undefined, t),
  };
  // createTextNode 需要带预置文本:重载
  global.document.createTextNode = (t) => {
    const n = new FakeNode(undefined);
    n._text = t;
    return n;
  };
  try {
    return fn();
  } finally {
    delete global.document;
  }
}

test('renderMarkdown:标题 / 加粗 / 高亮 / 行内代码', () => withDom(() => {
  const md = renderMarkdown('# 大标题\n\n**粗**和==亮==加`码`\n');
  assert.equal(md.className, 'md');
  assert.deepEqual(md.children.map((c) => c.tag), ['h1', 'p']);
  const p = md.children[1];
  assert.deepEqual(p.children.map((c) => c.tag || c._text), ['strong', '和', 'mark', '加', 'code']);
  // 每块带 data-copy 供逐块复制
  assert.ok(md.children.every((c) => c.dataset.copy !== undefined));
}));

test('renderMarkdown:代码块与未闭合代码块', () => withDom(() => {
  const md = renderMarkdown('前段\n```\nconst a=1\nconst b=2\n```\n后段\n```\n未闭合');
  const pres = md.children.filter((c) => c.tag === 'pre');
  assert.equal(pres.length, 2);
  assert.equal(pres[0].children[0].textContent, 'const a=1\nconst b=2');
  assert.equal(pres[1].children[0].textContent, '未闭合');
  assert.equal(pres[0].dataset.copy, 'const a=1\nconst b=2');
}));

test('renderMarkdown:列表(1. 与 1、两种序号)', () => withDom(() => {
  const md = renderMarkdown('- a\n- b\n1. c\n2、d');
  const lists = md.children.filter((c) => c.tag === 'ul' || c.tag === 'ol');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].tag, 'ul');
  assert.equal(lists[0].children.length, 2);
  assert.equal(lists[1].tag, 'ol');
  assert.equal(lists[1].children.length, 2);
  // 内容断言:曾经只断言结构(tag+个数),ol[1] 拿成序号标记、正文全丢也照样绿
  assert.equal(lists[1].children[0].textContent, 'c');
  assert.equal(lists[1].children[1].textContent, 'd');
  assert.equal(lists[0].children[0].textContent, 'a');
}));

test('renderMarkdown:敏感行在多行段落的非首行也遮罩', () => withDom(() => {
  // 曾经 SECRET_RE 缺 m 标志:整段多行文本合成一个字符串后,^$ 只匹配整串首尾,
  // 敏感行不在首行时明文外露(实测:单行遮、多行漏)
  const md = renderMarkdown('先看说明文字\n登录密码: MySecret123\n再看下一段');
  let masked = null;
  const walk = (n) => {
    for (const c of n.children) {
      if (String(c.className).includes('masked')) masked = c;
      walk(c);
    }
  };
  walk(md);
  assert.ok(masked, '多行段落中的敏感行必须被 .secret.masked 遮罩');
  // 双图层结构:raw 层 = 前缀+真值(显形才可见),stars 层 = 星号
  const raw = masked.children.find((c) => String(c.className).includes('secret-raw'));
  const stars = masked.children.find((c) => String(c.className).includes('secret-stars'));
  assert.ok(raw && stars, '必须有 raw + stars 两个图层');
  assert.equal(raw.textContent, '登录密码: MySecret123', 'raw 层 = 前缀+真值(显形时整体出现)');
  assert.match(stars.textContent, /^[•]+$/, '星号层全是 •');
  assert.equal(stars.textContent.length, 'MySecret123'.length, '星号数只按值的字符数算(前缀不参与)');
}));

test('renderMarkdown:零 innerHTML —— <script> 只能是文本', () => withDom(() => {
  const md = renderMarkdown('<script>alert(1)</script>');
  const p = md.children[0];
  assert.equal(p.tag, 'p');
  // 整段是纯文本节点,没有任何元素子节点
  assert.ok(p.children.every((c) => c.tag === undefined));
  assert.ok(p.textContent.includes('<script>'));
  // 段内文本原样保留,未被解析
  assert.equal(p.textContent, '<script>alert(1)</script>');
}));

test('renderInline:相邻标记、无标记纯文本', () => withDom(() => {
  const parent = new FakeNode('p');
  renderInline(parent, 'a**b**c==d==e`f`g');
  assert.deepEqual(parent.children.map((c) => c.tag || c._text),
    ['a', 'strong', 'c', 'mark', 'e', 'code', 'g']);
}));

test('splitSecretLine:赋值形态拆出前缀与敏感值,普通句子不命中', () => {
  assert.deepEqual(splitSecretLine('root 密码:Jm8#vQ2x'), { prefix: 'root 密码:', secret: 'Jm8#vQ2x' });
  assert.deepEqual(splitSecretLine('数据库密码：abc 123'), { prefix: '数据库密码：', secret: 'abc 123' });
  assert.deepEqual(splitSecretLine('API_KEY=sk-abcdef'), { prefix: 'API_KEY=', secret: 'sk-abcdef' });
  assert.deepEqual(splitSecretLine('GitHub token: ghp_123'), { prefix: 'GitHub token: ', secret: 'ghp_123' });
  // 2026-09-27 用户要求:key / 密钥 也要遮(密钥原有,key 新增)
  assert.deepEqual(splitSecretLine('key: sk-123'), { prefix: 'key: ', secret: 'sk-123' });
  assert.deepEqual(splitSecretLine('encryption key： abcd'), { prefix: 'encryption key： ', secret: 'abcd' });
  assert.deepEqual(splitSecretLine('密钥: xyz'), { prefix: '密钥: ', secret: 'xyz' });
  assert.deepEqual(splitSecretLine('密钥：我的主密钥'), { prefix: '密钥：', secret: '我的主密钥' });
  assert.equal(splitSecretLine('今天天气不错'), null);
  assert.equal(splitSecretLine(null), null);
  // 复合词不误遮:关键字必须紧邻冒号,「密码学:」里的「密码」后面不是分隔符
  assert.equal(splitSecretLine('密码学:研究加密的一门学科'), null);
  // 但「密码:」(冒号前有空格)命中
  assert.deepEqual(splitSecretLine('git 密码 : abc'), { prefix: 'git 密码 : ', secret: 'abc' });
});

test('renderInline:敏感值进 .secret.masked,前缀+真值完整留在 raw 层(显形/复制靠它)', () => withDom(() => {
  const parent = new FakeNode('p');
  renderInline(parent, 'root 密码:Jm8#vQ2x');
  const span = parent.children.find((c) => c.className === 'secret masked');
  assert.ok(span, '应有打码 span');
  const raw = span.children.find((c) => String(c.className).includes('secret-raw'));
  assert.ok(raw, '真值层必须存在');
  assert.equal(raw.textContent, 'root 密码:Jm8#vQ2x', '前缀+值都进 raw 层(显形时整体出现)');
  // 遮罩态下 span 之外不得再有裸的前缀文本(否则星号串前面挂着「密码:」很突兀)
  const bareTexts = parent.children
    .filter((c) => c.tag === undefined)
    .map((c) => String(c._text ?? ''));
  assert.ok(!bareTexts.some((t) => t.includes('密码')), '前缀必须收进 span,不留在 span 外');
  // 普通行完全不受影响
  const plain = new FakeNode('p');
  renderInline(plain, '**加粗**的普通段落');
  assert.equal(plain.children.find((c) => c.className === 'secret masked'), undefined);
}));

test('★ renderMarkdown:块复制 data-copy 不带星号(星号图层不污染复制)', () => withDom(() => {
  // 双图层后 el.textContent 会把 raw+stars 拼起来 —— dataset.copy 必须剔除星号层,
  // 否则用户点「复制本段」得到 '密码:xxx••••'(2026-09-27 星号化引入,反向探针钉住)
  const md = renderMarkdown('root 密码:Jm8#vQ2x\n');
  const p = md.children[0];
  assert.equal(p.dataset.copy, 'root 密码:Jm8#vQ2x',
    `data-copy 应为纯净原文,拿到的是 ${JSON.stringify(p.dataset.copy)}`);
  // 列表里的敏感行同样受保护:data-copy 在 ul(blk)上,不在 li 上
  const md2 = renderMarkdown('- token: abc123\n');
  const ul = md2.children[0];
  assert.equal(ul.dataset.copy, 'token: abc123');
}));

test('★ 敏感值星号数:超长截断到 24,空值至少 1 个', () => withDom(() => {
  const long = 'a'.repeat(40);
  const md = renderMarkdown(`密码: ${long}\n`);
  const walk = (n) => {
    for (const c of n.children) {
      if (String(c.className).includes('secret-stars')) return c;
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  const stars = walk(md);
  assert.ok(stars, '应能找到星号层');
  assert.equal(stars.textContent.length, 24, '超长值星号截断到 24');

  const md2 = renderMarkdown('密码: \u00a0x\n'); // 空白值兜底
  const st2 = walk(md2);
  assert.ok(st2 && st2.textContent.length >= 1, '至少 1 个星号,不能空成不可点');
}));

test('★ 同段多处敏感行必须全部遮罩(此前只遮第一处,其余明文外露)', () => withDom(() => {
  // 2026-09-27 真机探针实测:renderInline 命中第一处敏感行就 return,
  // rest 不递归 → 第 2 处敏感值明文(裸 textNode)。按行循环处理后:
  // 两处都必须包在 .secret.masked 里(裸明文 = textNode;raw 层真值是有意保留的,点击才显形)
  const md = renderMarkdown('服务器密码: Jm8#vQ2x\n数据库 token: abc12345\n普通文字不被遮\n');
  const p = md.children[0];
  const maskedCount = p.querySelectorAll('.secret').length;
  assert.equal(maskedCount, 2, `应遮住 2 处,实际 ${maskedCount}`);

  // 「明文外露」的精确定义:敏感值出现在裸文本节点里,而不是藏在 raw 层
  const walkTexts = (n) => {
    const out = [];
    for (const c of n.children || []) {
      if (c.tag === undefined) out.push(String(c._text ?? c.textContent)); // 裸 textNode
      else if (!String(c.className).includes('secret')) out.push(...walkTexts(c)); // 非 secret 元素内
    }
    return out;
  };
  const bareTexts = walkTexts(p).join('\n');
  assert.ok(!bareTexts.includes('abc12345'), '第 2 处敏感值不得以裸文本形式外露');
  assert.ok(bareTexts.includes('普通文字不被遮'), '普通行不受影响');

  // 每个遮罩 span 都应有非空星号层(视觉遮蔽真实生效)
  for (const s of p.querySelectorAll('.secret')) {
    const stars = s.querySelectorAll('.secret-stars')[0];
    assert.ok(stars && stars.textContent.length >= 1, '每处遮罩都要有星号层');
  }
}));

test('renderMarkdown:斜体与删除线(单星/双波浪)', () => withDom(() => {
  const md = renderMarkdown('*斜*和~~删~~\n');
  const p = md.children[0];
  assert.deepEqual(p.children.map((c) => c.tag || c._text), ['em', '和', 'del']);
}));

test('renderInline:双星优先于单星,不成对单星保持纯文本', () => withDom(() => {
  const parent = new FakeNode('p');
  renderInline(parent, '**粗**与*斜*与2*3+4');
  assert.deepEqual(parent.children.map((c) => c.tag || c._text),
    ['strong', '与', 'em', '与2*3+4'],
    '双星必须整体匹配;落单的 * 不能被吃进任何标记');
}));

test('highlightInto:大小写不敏感、多命中、拼接无损', () => withDom(() => {
  const parent = new FakeNode('div');
  highlightInto(parent, 'AbC abc XYZ', 'abc');
  const marks = parent.children.filter((c) => c.tag === 'mark');
  assert.equal(marks.length, 2);
  assert.equal(marks[0]._text, 'AbC');
  assert.equal(marks[1]._text, 'abc');
  assert.equal(parent.textContent, 'AbC abc XYZ');
}));

/* 2026-09-29 审计 P3:敏感行此前只有 click 一条路,键盘用户既看不到值、也拿不到自己的密码。
 * 这里把「可聚焦 + 能向读屏器表达状态」钉成渲染契约 —— 删掉任一属性即翻红。
 * ⚠️ 可访问名绝不能带上真值本身(读屏器会把密码念出来)。 */
test('P3:敏感行必须可聚焦并能向读屏器表达状态(tabindex/role/aria-expanded/aria-label)', () => withDom(() => {
  const parent = new FakeNode('p');
  renderInline(parent, 'root 密码:Jm8#vQ2x');
  const span = parent.children.find((c) => c.className === 'secret masked');
  assert.ok(span, '前置:敏感行确实被包成 .secret.masked');
  assert.equal(span.getAttribute('tabindex'), '0', '不在 Tab 序里 → 键盘用户永远够不到它');
  assert.equal(span.getAttribute('role'), 'button', '要能被当按钮激活');
  assert.equal(span.getAttribute('aria-expanded'), 'false', '初始必须是「已遮罩」');
  const label = span.getAttribute('aria-label');
  assert.ok(label && label.length > 0, '必须有无障碍名(svg/title 都不算)');
  assert.ok(!label.includes('Jm8#vQ2x'), '可访问名里绝不能带上真值本身');
}));
