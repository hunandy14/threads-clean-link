// test/support/ig-dom.js — post-icon 站點設定測試共用的迷你 DOM 與頁面環境。
//
// 提供三樣東西：
//   1. parseHtml／createDocument：把 test/fixtures/instagram/*.html 這類手寫
//      fixture 解析成一棵可查詢、可插拔節點的迷你 DOM（含 SVG 命名空間）。
//   2. 選擇器引擎：複合選擇器（tag／#id／.class／[attr op value]，值可加或
//      不加引號）、後代／子代／相鄰組合子、選擇器清單，以及 :scope、
//      :not()、:is()、:first-child、:last-child。不支援的形狀直接丟例外並
//      指名選擇器，避免靜默回空陣列造成誤判。
//   3. createSiteEnv：document_idle 那組 ISOLATED 腳本的 sandbox（window
//      即 sandbox），含 chrome 替身、剪貼簿紀錄、會隨 DOM 變動自動回呼的
//      MutationObserver 替身，以及 Trusted Types 的執行模擬——強制模式下
//      對 innerHTML 指派一般字串會丟 TypeError，與真實 Instagram 一致。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./helpers');

const ROOT_DIR = path.join(__dirname, '..', '..');
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'instagram');
const SRC = {
  i18n: fs.readFileSync(path.join(ROOT_DIR, 'i18n.js'), 'utf8'),
  core: fs.readFileSync(path.join(ROOT_DIR, 'tcl-core.js'), 'utf8'),
  postIcon: fs.readFileSync(path.join(ROOT_DIR, 'post-icon.js'), 'utf8'),
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);
const SUPPORTED_PSEUDOS = new Set(['scope', 'not', 'is', 'first-child', 'last-child']);

// ============================================================
// 選擇器引擎
// ============================================================

const selectorCache = new Map();

function parseSelectorList(input) {
  const src = String(input);
  if (selectorCache.has(src)) return selectorCache.get(src);
  let i = 0;
  const list = [];
  let complex = [];
  let pending = null;

  function fail(reason) {
    throw new Error('迷你 DOM 不支援的選擇器：' + src + (reason ? '（' + reason + '）' : ''));
  }
  function skipWs() {
    let had = false;
    while (i < src.length && /\s/.test(src[i])) {
      i += 1;
      had = true;
    }
    return had;
  }
  function readIdent() {
    const m = /^-?[A-Za-z_ -￿][\w -￿-]*/.exec(src.slice(i));
    if (!m) fail('預期識別字');
    i += m[0].length;
    return m[0];
  }
  function readCompound() {
    const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
    let any = false;
    if (src[i] === '*') {
      i += 1;
      any = true;
    } else if (/[A-Za-z]/.test(src[i] || '')) {
      c.tag = readIdent().toLowerCase();
      any = true;
    }
    for (;;) {
      const ch = src[i];
      if (ch === '#') {
        i += 1;
        c.ids.push(readIdent());
      } else if (ch === '.') {
        i += 1;
        c.classes.push(readIdent());
      } else if (ch === '[') {
        i += 1;
        skipWs();
        const name = readIdent().toLowerCase();
        skipWs();
        let op = null;
        let value = null;
        const m = /^([\^$*~|]?=)/.exec(src.slice(i));
        if (m) {
          op = m[1];
          i += op.length;
          skipWs();
          if (src[i] === '"' || src[i] === "'") {
            const quote = src[i];
            const end = src.indexOf(quote, i + 1);
            if (end === -1) fail('引號未閉合');
            value = src.slice(i + 1, end);
            i = end + 1;
          } else {
            const mm = /^[^\s\]]+/.exec(src.slice(i));
            if (!mm) fail('缺屬性值');
            value = mm[0];
            i += value.length;
          }
          skipWs();
        }
        if (src[i] !== ']') fail('缺 ]');
        i += 1;
        c.attrs.push({ name, op, value });
      } else if (ch === ':') {
        i += 1;
        if (src[i] === ':') fail('不支援偽元素');
        const name = readIdent().toLowerCase();
        if (!SUPPORTED_PSEUDOS.has(name)) fail(':' + name);
        let arg = null;
        if (src[i] === '(') {
          let depth = 1;
          const start = i + 1;
          i += 1;
          while (i < src.length && depth) {
            if (src[i] === '(') depth += 1;
            else if (src[i] === ')') depth -= 1;
            i += 1;
          }
          if (depth) fail('括號未閉合');
          arg = src.slice(start, i - 1);
        }
        if ((name === 'not' || name === 'is') && arg === null) fail(':' + name + ' 缺參數');
        c.pseudos.push({ name, arg: arg === null ? null : parseSelectorList(arg) });
      } else {
        break;
      }
      any = true;
    }
    if (!any) fail();
    return c;
  }

  skipWs();
  while (i < src.length) {
    complex.push({ combinator: pending, compound: readCompound() });
    pending = null;
    const hadWs = skipWs();
    const ch = src[i];
    if (ch === undefined) break;
    if (ch === ',') {
      i += 1;
      list.push(complex);
      complex = [];
      skipWs();
      continue;
    }
    if (ch === '>' || ch === '+' || ch === '~') {
      pending = ch;
      i += 1;
      skipWs();
      continue;
    }
    if (hadWs) {
      pending = ' ';
      continue;
    }
    fail();
  }
  if (pending) fail('結尾為組合子');
  if (!complex.length) fail('空選擇器');
  list.push(complex);
  selectorCache.set(src, list);
  return list;
}

function parentElementOf(node) {
  const parent = node && node.parentNode;
  return parent && parent.nodeType === 1 ? parent : null;
}

function matchAttr(actual, attr) {
  if (actual === null) return false;
  const v = attr.value;
  switch (attr.op) {
    case null:
      return true;
    case '=':
      return actual === v;
    case '^=':
      return v !== '' && actual.indexOf(v) === 0;
    case '$=':
      return v !== '' && actual.slice(-v.length) === v;
    case '*=':
      return v !== '' && actual.indexOf(v) !== -1;
    case '~=':
      return actual.split(/\s+/).indexOf(v) !== -1;
    case '|=':
      return actual === v || actual.indexOf(v + '-') === 0;
    default:
      return false;
  }
}

function matchCompound(node, c, scope) {
  if (!node || node.nodeType !== 1) return false;
  if (c.tag && node.localName !== c.tag) return false;
  for (const id of c.ids) if (node.getAttribute('id') !== id) return false;
  for (const cls of c.classes) if (!node.classList.contains(cls)) return false;
  for (const attr of c.attrs) if (!matchAttr(node.getAttribute(attr.name), attr)) return false;
  for (const p of c.pseudos) {
    if (p.name === 'scope') {
      if (node !== scope) return false;
    } else if (p.name === 'not') {
      if (matchList(node, p.arg, scope)) return false;
    } else if (p.name === 'is') {
      if (!matchList(node, p.arg, scope)) return false;
    } else if (p.name === 'first-child') {
      if (!node.parentNode || node.parentNode.children[0] !== node) return false;
    } else if (p.name === 'last-child') {
      const siblings = node.parentNode ? node.parentNode.children : [];
      if (siblings[siblings.length - 1] !== node) return false;
    }
  }
  return true;
}

function matchComplex(node, parts, idx, scope) {
  const part = parts[idx];
  if (!matchCompound(node, part.compound, scope)) return false;
  if (idx === 0) return true;
  switch (part.combinator) {
    case '>': {
      const parent = parentElementOf(node);
      return !!parent && matchComplex(parent, parts, idx - 1, scope);
    }
    case ' ': {
      let cursor = parentElementOf(node);
      while (cursor) {
        if (matchComplex(cursor, parts, idx - 1, scope)) return true;
        cursor = parentElementOf(cursor);
      }
      return false;
    }
    case '+': {
      const prev = node.previousElementSibling;
      return !!prev && matchComplex(prev, parts, idx - 1, scope);
    }
    case '~': {
      let prev = node.previousElementSibling;
      while (prev) {
        if (matchComplex(prev, parts, idx - 1, scope)) return true;
        prev = prev.previousElementSibling;
      }
      return false;
    }
    default:
      return false;
  }
}

function matchList(node, list, scope) {
  return list.some((parts) => matchComplex(node, parts, parts.length - 1, scope));
}

function queryAll(root, selector) {
  const list = parseSelectorList(selector);
  const scope = root.nodeType === 9 ? root.documentElement : root;
  const found = [];
  (function walk(cursor) {
    cursor.childNodes.forEach((child) => {
      if (child.nodeType !== 1) return;
      if (matchList(child, list, scope)) found.push(child);
      walk(child);
    });
  })(root);
  return found;
}

// ============================================================
// 節點
// ============================================================

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/g, (all, code) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos' || code === '#39') return "'";
    if (code === 'nbsp') return ' ';
    if (code[1] === 'x' || code[1] === 'X') return String.fromCodePoint(parseInt(code.slice(2), 16));
    return String.fromCodePoint(parseInt(code.slice(1), 10));
  });
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function camelize(name) {
  return name.replace(/-([a-z])/g, (all, ch) => ch.toUpperCase());
}

function parseInlineStyle(value) {
  const style = {};
  String(value || '')
    .split(';')
    .forEach((decl) => {
      const idx = decl.indexOf(':');
      if (idx === -1) return;
      const name = decl.slice(0, idx).trim();
      if (name) style[camelize(name)] = decl.slice(idx + 1).trim();
    });
  return style;
}

function createListenerTable() {
  const entries = [];
  function capture(options) {
    if (typeof options === 'boolean') return options;
    return !!(options && options.capture);
  }
  return {
    add(type, fn, options) {
      if (typeof fn !== 'function' && !(fn && typeof fn.handleEvent === 'function')) return;
      const signal = options && typeof options === 'object' ? options.signal : undefined;
      if (signal && signal.aborted) return;
      const cap = capture(options);
      if (entries.some((e) => e.type === type && e.fn === fn && e.capture === cap)) return;
      const entry = { type, fn, capture: cap, once: !!(options && options.once) };
      entries.push(entry);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => {
          const idx = entries.indexOf(entry);
          if (idx !== -1) entries.splice(idx, 1);
        });
      }
    },
    remove(type, fn, options) {
      const cap = capture(options);
      const idx = entries.findIndex((e) => e.type === type && e.fn === fn && e.capture === cap);
      if (idx !== -1) entries.splice(idx, 1);
    },
    dispatch(target, event) {
      entries
        .filter((e) => e.type === event.type)
        .forEach((e) => {
          if (entries.indexOf(e) === -1) return;
          if (e.once) entries.splice(entries.indexOf(e), 1);
          if (typeof e.fn === 'function') e.fn.call(target, event);
          else e.fn.handleEvent(event);
        });
    },
    count(type) {
      return entries.filter((e) => (type === undefined ? true : e.type === type)).length;
    },
  };
}

class MiniNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = createListenerTable();
  }
  get parentElement() {
    return parentElementOf(this);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    return parent.childNodes[parent.childNodes.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    return parent.childNodes[parent.childNodes.indexOf(this) - 1] || null;
  }
  get nextElementSibling() {
    let cursor = this.nextSibling;
    while (cursor && cursor.nodeType !== 1) cursor = cursor.nextSibling;
    return cursor;
  }
  get previousElementSibling() {
    let cursor = this.previousSibling;
    while (cursor && cursor.nodeType !== 1) cursor = cursor.previousSibling;
    return cursor;
  }
  get isConnected() {
    let cursor = this;
    while (cursor) {
      if (cursor.nodeType === 9) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }
  contains(other) {
    let cursor = other;
    while (cursor) {
      if (cursor === this) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }
  getRootNode() {
    let cursor = this;
    while (cursor.parentNode) cursor = cursor.parentNode;
    return cursor;
  }
  // 只回報前後與包含關係（PRECEDING 2、FOLLOWING 4、CONTAINS 8、
  // CONTAINED_BY 16）；不同樹回 DISCONNECTED 1。
  compareDocumentPosition(other) {
    if (other === this) return 0;
    if (this.contains(other)) return 16 | 4;
    if (other.contains(this)) return 8 | 2;
    const chain = (node) => {
      const list = [];
      for (let cursor = node; cursor; cursor = cursor.parentNode) list.unshift(cursor);
      return list;
    };
    const a = chain(this);
    const b = chain(other);
    if (a[0] !== b[0]) return 1;
    let i = 0;
    while (a[i] === b[i]) i += 1;
    const siblings = a[i - 1].childNodes;
    return siblings.indexOf(b[i]) > siblings.indexOf(a[i]) ? 4 : 2;
  }
  addEventListener(type, fn, options) {
    this._listeners.add(type, fn, options);
  }
  removeEventListener(type, fn, options) {
    this._listeners.remove(type, fn, options);
  }
  dispatchEvent(event) {
    if (event && !event.target) {
      try {
        event.target = this;
      } catch (e) {
        // 唯讀 target 就沿用原值。
      }
    }
    let cursor = this;
    let stopped = false;
    const originalStop = event && event.stopPropagation;
    if (event) {
      event.stopPropagation = function () {
        stopped = true;
        if (typeof originalStop === 'function') originalStop.call(event);
      };
    }
    while (cursor) {
      cursor._listeners.dispatch(cursor, event);
      if (stopped || !(event && event.bubbles)) break;
      cursor = cursor.parentNode;
    }
    if (this.ownerDocument && this.ownerDocument._dispatched) this.ownerDocument._dispatched.push(event);
    return true;
  }
  listenerCount(type) {
    return this._listeners.count(type);
  }
  _adopt(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
  }
  insertBefore(newNode, refNode) {
    if (newNode.nodeType === 11) {
      newNode.childNodes.slice().forEach((child) => this.insertBefore(child, refNode));
      return newNode;
    }
    if (refNode && refNode.parentNode !== this) {
      throw new Error('迷你 DOM：insertBefore 的參考節點不是本節點的子節點');
    }
    this._adopt(newNode);
    const index = refNode ? this.childNodes.indexOf(refNode) : -1;
    if (index === -1) this.childNodes.push(newNode);
    else this.childNodes.splice(index, 0, newNode);
    notifyMutation(this, [newNode], []);
    return newNode;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index === -1) throw new Error('迷你 DOM：removeChild 的節點不是本節點的子節點');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    notifyMutation(this, [], [child]);
    return child;
  }
  replaceChild(newChild, oldChild) {
    this.insertBefore(newChild, oldChild);
    return this.removeChild(oldChild);
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
  }
  prepend(...nodes) {
    const ref = this.firstChild;
    nodes.forEach((n) => this.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, ref));
  }
  replaceChildren(...nodes) {
    this.childNodes.slice().forEach((child) => this.removeChild(child));
    this.append(...nodes);
  }
  before(...nodes) {
    if (!this.parentNode) return;
    nodes.forEach((n) => this.parentNode.insertBefore(n, this));
  }
  after(...nodes) {
    if (!this.parentNode) return;
    const ref = this.nextSibling;
    nodes.forEach((n) => this.parentNode.insertBefore(n, ref));
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceWith(...nodes) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const ref = this.nextSibling;
    parent.removeChild(this);
    nodes.forEach((n) => parent.insertBefore(n, ref));
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    const list = this.children;
    return list[list.length - 1] || null;
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 8 ? '' : c.textContent)).join('');
  }
  set textContent(value) {
    this.childNodes.slice().forEach((child) => this.removeChild(child));
    if (value !== null && value !== undefined && value !== '') {
      this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }
  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }
}

class MiniText extends MiniNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.nodeName = '#text';
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value);
  }
  get nodeValue() {
    return this.data;
  }
  set nodeValue(value) {
    this.data = String(value);
  }
  get innerText() {
    return this.data;
  }
  cloneNode() {
    return new MiniText(this.ownerDocument, this.data);
  }
}

class MiniElement extends MiniNode {
  constructor(doc, namespaceURI, qualifiedName) {
    super(doc);
    this.nodeType = 1;
    this.namespaceURI = namespaceURI || HTML_NS;
    this.localName = String(qualifiedName).toLowerCase();
    this._tag = this.namespaceURI === HTML_NS ? String(qualifiedName).toUpperCase() : String(qualifiedName);
    this._attrs = new Map();
    this.style = {};
    const self = this;
    this.classList = {
      add(...names) {
        const list = self._classes();
        names.forEach((n) => {
          if (list.indexOf(n) === -1) list.push(n);
        });
        self.setAttribute('class', list.join(' '));
      },
      remove(...names) {
        self.setAttribute(
          'class',
          self._classes().filter((n) => names.indexOf(n) === -1).join(' ')
        );
      },
      contains(name) {
        return self._classes().indexOf(name) !== -1;
      },
      toggle(name, force) {
        const has = self._classes().indexOf(name) !== -1;
        const want = force === undefined ? !has : !!force;
        if (want) self.classList.add(name);
        else self.classList.remove(name);
        return want;
      },
    };
  }
  _classes() {
    return String(this.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean);
  }
  get nodeName() {
    return this._tag;
  }
  get tagName() {
    return this._tag;
  }
  get attributes() {
    return Array.from(this._attrs.entries()).map(([name, value]) => ({ name, value }));
  }
  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this._attrs.set(key, String(value));
    if (key === 'style') this.style = parseInlineStyle(value);
  }
  setAttributeNS(ns, name, value) {
    this.setAttribute(name, value);
  }
  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }
  removeAttribute(name) {
    this._attrs.delete(String(name).toLowerCase());
  }
  toggleAttribute(name, force) {
    const has = this.hasAttribute(name);
    const want = force === undefined ? !has : !!force;
    if (want) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return want;
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(value) {
    this.setAttribute('id', value);
  }
  get className() {
    return this.getAttribute('class') || '';
  }
  set className(value) {
    this.setAttribute('class', value);
  }
  get title() {
    return this.getAttribute('title') || '';
  }
  set title(value) {
    this.setAttribute('title', value);
  }
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }
  get tabIndex() {
    const v = this.getAttribute('tabindex');
    return v === null ? -1 : Number(v);
  }
  set tabIndex(value) {
    this.setAttribute('tabindex', value);
  }
  get innerText() {
    return this.childNodes
      .map((c) => {
        if (c.nodeType === 1 && c.localName === 'br') return '\n';
        return c.nodeType === 8 ? '' : c.innerText;
      })
      .join('');
  }
  set innerText(value) {
    this.textContent = value;
  }
  get innerHTML() {
    return this.childNodes.map(serialize).join('');
  }
  set innerHTML(value) {
    const doc = this.ownerDocument;
    const trusted = value && typeof value === 'object' && value.__trustedHTML === true;
    if (doc && doc._trustedTypesEnforced && !trusted) {
      throw new TypeError(
        "Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment."
      );
    }
    this.childNodes.slice().forEach((child) => this.removeChild(child));
    parseHtmlInto(doc, this, String(value));
  }
  get outerHTML() {
    return serialize(this);
  }
  matches(selector) {
    return matchList(this, parseSelectorList(selector), this);
  }
  closest(selector) {
    const list = parseSelectorList(selector);
    let cursor = this;
    while (cursor && cursor.nodeType === 1) {
      if (matchList(cursor, list, cursor)) return cursor;
      cursor = parentElementOf(cursor);
    }
    return null;
  }
  insertAdjacentElement(position, element) {
    switch (String(position).toLowerCase()) {
      case 'beforebegin':
        return this.parentNode ? this.parentNode.insertBefore(element, this) : null;
      case 'afterend':
        return this.parentNode ? this.parentNode.insertBefore(element, this.nextSibling) : null;
      case 'afterbegin':
        return this.insertBefore(element, this.firstChild);
      case 'beforeend':
        return this.appendChild(element);
      default:
        throw new Error('迷你 DOM 不支援的 insertAdjacentElement 位置：' + position);
    }
  }
  cloneNode(deep) {
    const copy = new MiniElement(this.ownerDocument, this.namespaceURI, this._tag);
    this._attrs.forEach((value, name) => copy.setAttribute(name, value));
    if (deep) this.childNodes.forEach((child) => copy.appendChild(child.cloneNode(true)));
    return copy;
  }
  click() {
    this.dispatchEvent(createEvent('click', { bubbles: true }));
  }
  focus() {}
  blur() {}
  getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  getClientRects() {
    return [];
  }
  // ---- 測試專用 ----
  fire(type, extra) {
    const event = Object.assign(createEvent(type, { bubbles: true }), extra || {});
    return this.dispatchEvent(event);
  }
}

class MiniFragment extends MiniNode {
  constructor(doc) {
    super(doc);
    this.nodeType = 11;
    this.nodeName = '#document-fragment';
  }
  cloneNode(deep) {
    const copy = new MiniFragment(this.ownerDocument);
    if (deep) this.childNodes.forEach((c) => copy.appendChild(c.cloneNode(true)));
    return copy;
  }
}

function createEvent(type, init) {
  const opts = init || {};
  return {
    type,
    bubbles: !!opts.bubbles,
    cancelable: !!opts.cancelable,
    detail: opts.detail,
    defaultPrevented: false,
    target: null,
    key: opts.key,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  if (node.nodeType !== 1) return '';
  const attrs = node.attributes
    .map((a) => ' ' + a.name + '="' + String(a.value).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"')
    .join('');
  const tag = node.namespaceURI === HTML_NS ? node.localName : node._tag;
  if (node.namespaceURI === HTML_NS && VOID_TAGS.has(node.localName)) return '<' + tag + attrs + '>';
  return '<' + tag + attrs + '>' + node.childNodes.map(serialize).join('') + '</' + tag + '>';
}

// MutationObserver 通知：每個仍在觀察、且 target 涵蓋變動點的 observer，
// 於同一個 microtask 內批次收到 childList 紀錄（與瀏覽器的非同步交付一致）。
function notifyMutation(parent, added, removed) {
  const doc = parent.ownerDocument || (parent.nodeType === 9 ? parent : null);
  if (!doc || !doc._observers) return;
  doc._observers.forEach((obs) => {
    if (!obs.observing) return;
    const covered = obs.target === parent || (obs.options.subtree && obs.target.contains(parent));
    if (!covered || !obs.options.childList) return;
    obs._queue.push({ type: 'childList', target: parent, addedNodes: added, removedNodes: removed });
    if (!obs._scheduled) {
      obs._scheduled = true;
      queueMicrotask(() => {
        obs._scheduled = false;
        if (!obs.observing) {
          obs._queue = [];
          return;
        }
        const records = obs._queue;
        obs._queue = [];
        obs.deliveries += 1;
        obs.callback(records, obs);
      });
    }
  });
}

class MiniDocument extends MiniNode {
  constructor() {
    super(null);
    this.ownerDocument = null;
    this.nodeType = 9;
    this.nodeName = '#document';
    this.readyState = 'complete';
    this._observers = [];
    this._dispatched = [];
    this._trustedTypesEnforced = false;
    const html = this.createElement('html');
    html.appendChild(this.createElement('head'));
    html.appendChild(this.createElement('body'));
    this.appendChild(html);
  }
  get documentElement() {
    return this.childNodes.find((c) => c.nodeType === 1) || null;
  }
  get head() {
    return this.documentElement.children.find((c) => c.localName === 'head') || null;
  }
  get body() {
    return this.documentElement.children.find((c) => c.localName === 'body') || null;
  }
  createElement(tag) {
    return new MiniElement(this, HTML_NS, tag);
  }
  createElementNS(ns, tag) {
    return new MiniElement(this, ns || HTML_NS, tag);
  }
  createTextNode(value) {
    return new MiniText(this, value);
  }
  createDocumentFragment() {
    return new MiniFragment(this);
  }
  createComment() {
    const node = new MiniText(this, '');
    node.nodeType = 8;
    node.nodeName = '#comment';
    return node;
  }
  getElementById(id) {
    return queryAll(this, '[id="' + id + '"]')[0] || null;
  }
}

// ============================================================
// HTML 解析（只服務手寫 fixture：不跑腳本、不處理 <template>／<table> 修補）
// ============================================================

const TOKEN_RE =
  /<!--[\s\S]*?-->|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTR_RE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseHtmlInto(doc, parent, html) {
  const stack = [parent];
  TOKEN_RE.lastIndex = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const name = m[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].localName === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    if (m[2]) {
      const name = m[2];
      const inSvg = top.nodeType === 1 && top.namespaceURI === SVG_NS && top.localName !== 'foreignobject';
      const ns = name.toLowerCase() === 'svg' || inSvg ? SVG_NS : HTML_NS;
      const node = doc.createElementNS(ns, ns === SVG_NS ? name : name.toLowerCase());
      const attrSrc = m[3] || '';
      const ar = new RegExp(ATTR_RE.source, 'g');
      let a;
      while ((a = ar.exec(attrSrc))) {
        const value = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
        node.setAttribute(a[1], decodeEntities(value));
      }
      top.appendChild(node);
      const selfClosing = m[4] === '/' || (ns === HTML_NS && VOID_TAGS.has(node.localName));
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (m[5] !== undefined && m[0][0] !== '<') {
      if (/^[ \t\r\n]*$/.test(m[5])) continue;
      top.appendChild(doc.createTextNode(decodeEntities(m[5].replace(/[ \t\r\n]+/g, ' '))));
    }
  }
}

function createDocument(bodyHtml) {
  const doc = new MiniDocument();
  if (bodyHtml) parseHtmlInto(doc, doc.body, bodyHtml);
  return doc;
}

// 解析一段 HTML，回傳頂層元素陣列（不掛進任何文件樹）。
function parseFragment(doc, html) {
  const holder = doc.createElement('div');
  parseHtmlInto(doc, holder, html);
  return holder.children.slice();
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

// 取 fixture 裡 <main> 的內層 HTML（SPA 切頁時換掉 main 的子節點用）。
function fixtureMainInner(name) {
  const doc = createDocument(readFixture(name));
  const main = doc.querySelector('main');
  if (!main) throw new Error('fixture 沒有 <main>：' + name);
  return main.innerHTML;
}

// ============================================================
// MutationObserver 替身
// ============================================================

function createObserverDouble(doc) {
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = {};
      this.observing = false;
      this.disconnected = false;
      this.deliveries = 0;
      this._queue = [];
      this._scheduled = false;
      observers.push(this);
    }
    observe(target, options) {
      if (!target || typeof target.contains !== 'function') {
        throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
      }
      this.target = target;
      this.options = Object.assign({}, options);
      this.observing = true;
      this.disconnected = false;
      if (doc._observers.indexOf(this) === -1) doc._observers.push(this);
    }
    disconnect() {
      this.observing = false;
      this.disconnected = true;
      this._queue = [];
    }
    takeRecords() {
      const records = this._queue;
      this._queue = [];
      return records;
    }
  }
  return {
    FakeMutationObserver,
    observers,
    live() {
      return observers.filter((o) => o.observing && !o.disconnected);
    },
  };
}

// ============================================================
// 頁面環境
// ============================================================

function createLocation(origin, pathname) {
  const url = new URL(pathname || '/', origin);
  const location = {
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    href: url.href,
  };
  return location;
}

function setLocationPath(location, next) {
  const url = new URL(next, location.origin);
  location.pathname = url.pathname;
  location.search = url.search;
  location.hash = url.hash;
  location.href = url.href;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 等過 debounce 掃描（SCAN_DEBOUNCE_MS 60ms）與 storage 回呼的餘裕。
function settle() {
  return wait(150);
}

// options:
//   origin            頁面來源（預設 https://www.instagram.com）
//   pathname          網址列路徑（預設 '/'）
//   html              <body> 內層 HTML（通常是 readFixture(...)）
//   sync              chrome.storage.sync 初值（預設 { langPref: 'zh' }）
//   trustedTypes      'policy'（預設：可建 policy，innerHTML 只收 TrustedHTML）
//                     'throwing'（createPolicy 會丟例外，innerHTML 一律不可用）
//                     'none'（沒有 window.trustedTypes，innerHTML 不受限）
//   runtimeId         chrome.runtime.id 初值（預設有效 id）
function createSiteEnv(options) {
  const settings = options || {};
  const origin = settings.origin || 'https://www.instagram.com';
  const location = createLocation(origin, settings.pathname || '/');
  const doc = createDocument(settings.html || '');
  const ttMode = settings.trustedTypes || 'policy';
  doc._trustedTypesEnforced = ttMode !== 'none';

  const obs = createObserverDouble(doc);
  const storage = createChromeStorage(settings.sync || { langPref: 'zh' }, {});
  storage.api.onChanged.removeListener = function () {};
  const sent = [];
  const clipboardWrites = [];
  const consoleLog = { warn: [], error: [], log: [] };
  const policyCalls = [];

  let trustedTypes;
  if (ttMode === 'throwing') {
    trustedTypes = {
      defaultPolicy: null,
      createPolicy(name) {
        policyCalls.push(name);
        throw new TypeError(
          "Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy \"" + name + '" disallowed.'
        );
      },
      isHTML() {
        return false;
      },
    };
  } else if (ttMode === 'policy') {
    trustedTypes = {
      defaultPolicy: null,
      createPolicy(name, rules) {
        policyCalls.push(name);
        return {
          name,
          createHTML(input) {
            const html = rules && typeof rules.createHTML === 'function' ? rules.createHTML(input) : '';
            return { __trustedHTML: true, toString: () => String(html) };
          },
        };
      },
      isHTML(value) {
        return !!(value && value.__trustedHTML);
      },
    };
  }

  const chrome = {
    runtime: {
      id: settings.runtimeId === undefined ? 'tcl-test-ext' : settings.runtimeId,
      lastError: undefined,
      getURL(p) {
        return 'chrome-extension://tcl-test-ext/' + p;
      },
      sendMessage(message) {
        sent.push(message);
        return Promise.resolve(undefined);
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: storage.api,
    i18n: { getUILanguage: () => 'zh-TW' },
  };

  const windowListeners = createListenerTable();
  const sandbox = {
    location,
    navigator: {
      language: 'zh-TW',
      clipboard: {
        writeText(value) {
          clipboardWrites.push(value);
          return Promise.resolve();
        },
      },
    },
    document: doc,
    chrome,
    MutationObserver: obs.FakeMutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    URL,
    Date,
    Map,
    Set,
    WeakMap,
    WeakSet,
    AbortController,
    AbortSignal,
    CustomEvent: function CustomEvent(type, init) {
      return createEvent(type, init);
    },
    Event: function Event(type, init) {
      return createEvent(type, init);
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    getComputedStyle(node) {
      const style = (node && node.style) || {};
      return {
        color: style.color || '',
        display: style.display || '',
        flexDirection: style.flexDirection || '',
        getPropertyValue(name) {
          return style[camelize(name)] || '';
        },
      };
    },
    addEventListener(type, fn, opts) {
      windowListeners.add(type, fn, opts);
    },
    removeEventListener(type, fn, opts) {
      windowListeners.remove(type, fn, opts);
    },
    dispatchEvent(event) {
      windowListeners.dispatch(sandbox, event);
      return true;
    },
    history: {
      pushState(state, title, url) {
        if (url !== undefined && url !== null) setLocationPath(location, String(url));
      },
      replaceState(state, title, url) {
        if (url !== undefined && url !== null) setLocationPath(location, String(url));
      },
    },
    console: {
      warn: (...args) => consoleLog.warn.push(args.map(String).join(' ')),
      error: (...args) => consoleLog.error.push(args.map(String).join(' ')),
      log: (...args) => consoleLog.log.push(args.map(String).join(' ')),
      info: (...args) => consoleLog.log.push(args.map(String).join(' ')),
      debug: (...args) => consoleLog.log.push(args.map(String).join(' ')),
    },
  };
  if (trustedTypes) sandbox.trustedTypes = trustedTypes;
  if (settings.runtimeId === null) delete chrome.runtime.id;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  runInSandbox(SRC.i18n, sandbox);
  runInSandbox(SRC.core, sandbox);

  const env = {
    sandbox,
    window: sandbox,
    document: doc,
    location,
    chrome,
    storage,
    sent,
    clipboardWrites,
    consoleLog,
    policyCalls,
    observers: obs.observers,
    liveObservers: obs.live,
    loadPostIcon() {
      runInSandbox(SRC.postIcon, sandbox);
      return env;
    },
    icons() {
      return doc.querySelectorAll('.tcl-copy-icon');
    },
    byId(id) {
      return doc.getElementById(id);
    },
    main() {
      return doc.querySelector('main');
    },
    // SPA 切頁：先改網址列，再把 <main> 的子節點換成新頁內容（main 本身保
    // 留，與 Instagram 的 SPA 行為一致）。
    navigate(pathname, mainInnerHtml) {
      setLocationPath(location, pathname);
      if (mainInnerHtml !== undefined) {
        const main = doc.querySelector('main');
        main.childNodes.slice().forEach((child) => main.removeChild(child));
        parseHtmlInto(doc, main, mainInnerHtml);
      }
    },
    setPathname(pathname) {
      setLocationPath(location, pathname);
    },
    // 對 main 做一次無關緊要的子節點變動，讓 observer 收到紀錄。
    poke() {
      const main = doc.querySelector('main') || doc.body;
      const marker = doc.createElement('div');
      marker.setAttribute('data-fx-poke', '');
      main.appendChild(marker);
      main.removeChild(marker);
    },
    orphan() {
      chrome.runtime.id = undefined;
    },
    payloads() {
      return sent.filter((m) => m && m.type === 'cleanedNotice').map((m) => JSON.parse(JSON.stringify(m)));
    },
  };
  return env;
}

module.exports = {
  SVG_NS,
  HTML_NS,
  createDocument,
  parseFragment,
  parseSelectorList,
  readFixture,
  fixtureMainInner,
  createSiteEnv,
  wait,
  settle,
};

// 節點相等斷言：失敗時只回報 <tag#id> 摘要。node:test 的報告器會 inspect
// AssertionError 的 actual／expected，迷你 DOM 的節點互相參照（parentNode、
// ownerDocument），直接塞進 assert.equal 會讓報告器卡死。
function describeNode(node) {
  if (node === null) return 'null';
  if (node === undefined) return 'undefined';
  if (node && node.nodeType === 1) return '<' + node.localName + (node.id ? '#' + node.id : '') + '>';
  if (node && node.nodeType === 9) return '#document';
  return typeof node === 'object' ? '[object]' : String(node);
}

function assertSameNode(actual, expected, message) {
  assert.ok(
    actual === expected,
    (message || '節點不同') + '：實際 ' + describeNode(actual) + '，預期 ' + describeNode(expected)
  );
}

module.exports.assertSameNode = assertSameNode;
module.exports.describeNode = describeNode;
