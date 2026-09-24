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
    };
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
  assert.equal(splitSecretLine('今天天气不错'), null);
  assert.equal(splitSecretLine(null), null);
  // 复合词不误遮:关键字必须紧邻冒号,「密码学:」里的「密码」后面不是分隔符
  assert.equal(splitSecretLine('密码学:研究加密的一门学科'), null);
  // 但「密码:」(冒号前有空格)命中
  assert.deepEqual(splitSecretLine('git 密码 : abc'), { prefix: 'git 密码 : ', secret: 'abc' });
});

test('renderInline:敏感值进 .secret.masked,值完整留在 DOM(显形/复制靠它)', () => withDom(() => {
  const parent = new FakeNode('p');
  renderInline(parent, 'root 密码:Jm8#vQ2x');
  const span = parent.children.find((c) => c.className === 'secret masked');
  assert.ok(span, '应有打码 span');
  assert.equal(span.textContent, 'Jm8#vQ2x', '值必须原样在 DOM 里,视觉遮蔽由 CSS 负责');
  // 普通行完全不受影响
  const plain = new FakeNode('p');
  renderInline(plain, '**加粗**的普通段落');
  assert.equal(plain.children.find((c) => c.className === 'secret masked'), undefined);
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
