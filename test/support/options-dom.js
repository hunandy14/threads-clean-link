// test/support/options-dom.js — options 頁 controller 測試共用的最小 DOM stub。
// makeNode／makeDocumentStub 原本寫在 options.test.js 裡，對話框與 popover
// 的測試檔(options-dialog.test.js)也要用同一套，故抽到這裡。
//
// 除了原本的節點與 document 行為，這裡另外模擬原生 <dialog> 與 Popover API
// 的最小子集，行為以規格為準，但事件一律同步派送:
// - dialog:open、returnValue、showModal()、close(rv)。showModal 會收掉所有
//   auto popover、記下開啟前的焦點並把焦點交給 autofocus 節點;close 會還原
//   焦點，然後同步派送 close 事件。真實瀏覽器的 close 事件是另排 task 派送，
//   所以產品碼不得依賴 close 事件的時序。
// - popover:showPopover()、hidePopover()、togglePopover(force)、
//   matches(':popover-open')，派送 beforetoggle 與 toggle，事件帶
//   newState／oldState。popoverTargetElement 在 click 的預設動作切換目標。
//   子樹被移出文件時，裡面開著的 popover 不派事件、直接隱藏。
// - document:pressEscape() 模擬使用者按 Esc 的完整鏈路(keydown 由焦點節點
//   往上冒泡到 document，沒被 preventDefault 才對 top layer 最上層發 close
//   request);lightDismiss(target) 模擬點在 target 上的 light dismiss。
//
// 靜態節點在 stub 裡是扁平的(getElementById 即時補建，彼此沒有 parentNode)。
// 「某節點在不在某個對話框或選單裡」「對話框的 autofocus 是哪一顆」「某元素
// 是不是 popover」這三件事改讀 options.html 的原文推導，HTML 漏寫屬性時測試
// 就會失敗。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPTIONS_HTML_PATH = path.join(__dirname, '..', '..', 'options.html');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=\/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(raw))) {
    let v = m[2];
    if (v === undefined) v = '';
    else if (/^["']/.test(v)) v = v.slice(1, -1);
    attrs[m[1].toLowerCase()] = v;
  }
  return attrs;
}

// 把 options.html 解析成 id 表:每個帶 id 的元素記下標籤、屬性與祖先 id(由近
// 到遠)，另外整理出「每個 dialog 內第一個 autofocus 節點」。只求足夠判斷巢狀
// 關係，不是完整的 HTML parser。
function parseStaticHtml(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const byId = {};
  const ancestors = {};
  const order = [];
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = parseAttrs(m[3]);
    const id = attrs.id || null;
    if (id) {
      byId[id] = { tag, attrs };
      ancestors[id] = stack.filter((s) => s.id).map((s) => s.id).reverse();
      order.push(id);
    }
    if (m[4] !== '/' && !VOID_TAGS.has(tag)) stack.push({ tag, id });
  }
  const autofocusIn = {};
  order.forEach((id) => {
    if (!Object.prototype.hasOwnProperty.call(byId[id].attrs, 'autofocus')) return;
    const dlg = ancestors[id].find((a) => byId[a].tag === 'dialog');
    if (dlg && !autofocusIn[dlg]) autofocusIn[dlg] = id;
  });
  return { byId, ancestors, autofocusIn };
}

const STATIC_HTML = parseStaticHtml(fs.readFileSync(OPTIONS_HTML_PATH, 'utf8'));

function makeNode(tag, ownerDoc) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  let text = '';
  const node = {
    tag: tag || 'div',
    children: [],
    style: {},
    dataset: {},
    hidden: false,
    value: '',
    title: '',
    checked: false,
    classList: {
      // 比照真實 DOM 的 classList.add/remove:可變參數，一次收多個
      // class(options.js 的 statusDot 重設就是 remove('is-danger',
      // 'is-warning') 一次兩個，只認單一參數會漏清第二個)。
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const next = force === undefined ? !classes.has(c) : force;
        if (next) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    removeAttribute(k) {
      delete attrs[k];
    },
    contains(other) {
      // 淺層足夠:帳號選單的「點外關閉」只需要判斷目標是否為容器自身或
      // 其直接子節點(測試以 fire('click', { target }) 模擬，不會構造更深的
      // 巢狀節點)。
      if (other === node) return true;
      return node.children.indexOf(other) !== -1;
    },
    appendChild(n) {
      this.children.push(n);
      n.parentNode = node;
      return n;
    },
    // 行內編輯(裝置改名)要在既有節點前插入 input、收尾再把 input 拔掉;
    // parentNode 也一併記錄，讓「拿到 input 就能移除自己」這種真實 DOM
    // 寫法在 stub 下也成立。ref 不在子節點內時退化成 append(比照真 DOM
    // 會丟 NotFoundError 過於嚴苛，測試只需要順序正確)。
    insertBefore(n, ref) {
      const idx = this.children.indexOf(ref);
      if (idx === -1) this.children.push(n);
      else this.children.splice(idx, 0, n);
      n.parentNode = node;
      return n;
    },
    removeChild(n) {
      if (ownerDoc && ownerDoc._popovers) ownerDoc._hidePopoversIn([n]);
      const idx = this.children.indexOf(n);
      if (idx !== -1) this.children.splice(idx, 1);
      if (n.parentNode === node) n.parentNode = null;
      return n;
    },
    // <input> 進入編輯態時的全選，行為上對測試無影響，補上避免炸。
    select() {},
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener() {},
    // 測試專用(比照 support/helpers.js 的 createCheckboxDocument):派送
    // 任意型別的事件給已註冊的監聽器，用來模擬使用者點擊卡片動作按鈕。
    fire(type, event) {
      (listeners[type] || []).slice().forEach((fn) => fn(event || { type, target: node }));
      // 比照 popovertarget 的預設動作:click 派送完才切換目標 popover，
      // 監聽器 preventDefault 過就不切。
      if (type === 'click' && node.popoverTargetElement && !(event && event.defaultPrevented)) {
        const pop = node.popoverTargetElement;
        pop._invoker = node;
        if (typeof pop.togglePopover === 'function') pop.togglePopover();
      }
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
    click() {},
    // popover 定位 helper 讀 bottom 與 right。
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
    },
    // 帳號選單的鍵盤導覽/開合測試需要 focus 落點:owner document 存在時
    // 才記錄(比照真 DOM 的 document.activeElement)，沒有 owner 時(獨立
    // 建立的節點，如既有測試直接呼叫 makeNode() 者)安靜 no-op。
    focus() {
      if (ownerDoc) ownerDoc.activeElement = node;
    },
    blur() {
      if (ownerDoc && ownerDoc.activeElement === node) ownerDoc.activeElement = null;
    },
  };
  // 比照真 DOM:對 textContent 賦值會清空既有子節點(renderList 靠這個清單)。
  Object.defineProperty(node, 'textContent', {
    get() {
      return text;
    },
    set(v) {
      text = String(v);
      if (ownerDoc && ownerDoc._popovers && node.children.length) ownerDoc._hidePopoversIn(node.children);
      // 比照真 DOM:被清掉的子節點離開文件，parentNode 歸零(焦點歸還靠這個
      // 判斷舊節點已不可聚焦)。
      node.children.forEach((c) => {
        if (c && c.parentNode === node) c.parentNode = null;
      });
      node.children.length = 0;
    },
  });
  installDialogApi(node, ownerDoc);
  return node;
}

// options.html 的靜態巢狀關係:key 是子節點的 id，value 是它在 HTML 裡所屬
// 的容器 id。真實 document.getElementById 只找得到「還在文件樹裡」的節點——
// 容器被 textContent='' 清空後，原本掛在裡面的靜態節點就查不到了(回 null)。
// 扁平 id 表的 stub 永遠回同一個物件，看不見這個差異，會把「節點被清掉之後
// 再也拿不回來」這類 bug 一路放行(回歸:renderDetailDeviceRow 先清空
// #detailDeviceRow 再判 null 早退，第二次開帶歸屬的紀錄時「裝置」列永久消失)。
// 需要這種保真度的 id 逐一登記在這裡，其餘 id 維持原本的扁平行為。
const STATIC_PARENT_ID = {
  detailDeviceName: 'detailDeviceRow',
};

function isInSubtree(root, node) {
  if (!root || !node) return false;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === node) return true;
    (cur.children || []).forEach((c) => stack.push(c));
  }
  return false;
}

function makeDocumentStub() {
  const byId = {};
  const docListeners = {};
  const doc = {
    ids: byId,
    documentElement: makeNode('html'),
    body: null,
    activeElement: null,
    getElementById(id) {
      const parentId = STATIC_PARENT_ID[id];
      if (!byId[id]) {
        byId[id] = makeNode('#' + id, doc);
        byId[id].__stubId = id;
        // 比照 options.html 掛進靜態容器，讓「被搬離容器」這件事測得出來。
        if (parentId) doc.getElementById(parentId).appendChild(byId[id]);
      }
      // 已經不在容器的子樹裡 → 比照真實 DOM 回 null。doc.ids 仍握有節點
      // 參照，測試要斷言殘留內容時可直接讀 doc.ids[id]。
      if (parentId && !isInSubtree(byId[parentId], byId[id])) return null;
      return byId[id];
    },
    createElement(tag) {
      return makeNode(tag, doc);
    },
    createElementNS(ns, tag) {
      return makeNode(tag, doc);
    },
    createTextNode(text) {
      const n = makeNode('#text', doc);
      n.textContent = text;
      return n;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    // 帳號選單的「點外關閉」/Esc 監聽掛在 document 層級(見 options.js 的
    // bindAccount)，比照節點的 addEventListener/fire 慣例真的登記/派送，
    // 而不是像既有多數測試那樣留白 no-op——這兩個行為只能靠 document 層級
    // 事件驗證，其餘既有的對話框 Esc 處理仍是留白(見各處「由人工/CDP
    // 驗證」註解)，這裡只為帳號選單新增的兩條路徑補上最小可行的派送。
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    removeEventListener() {},
    fire(type, event) {
      (docListeners[type] || []).slice().forEach((fn) => fn(event || { type }));
    },
  };
  installDocumentDialogApi(doc);
  return doc;
}

// ---- <dialog> 與 Popover API ----

function makeEvent(type, target, extra) {
  return Object.assign(
    {
      type,
      target,
      currentTarget: target,
      cancelable: false,
      defaultPrevented: false,
      _stopped: false,
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      },
      stopPropagation() {
        this._stopped = true;
      },
      stopImmediatePropagation() {
        this._stopped = true;
      },
    },
    extra || {}
  );
}

function staticInfo(node) {
  return (node && node.__stubId && STATIC_HTML.byId[node.__stubId]) || null;
}

// popover 屬性的型別:IDL(el.popover)優先，其次 setAttribute，最後才看
// options.html 的靜態屬性。沒有 popover 屬性回 null;'' 與 'auto' 為 auto，
// 其餘無效值比照規格退成 manual。
function popoverTypeOf(node) {
  let v = null;
  if (typeof node.popover === 'string') v = node.popover;
  else if (node.getAttribute('popover') !== null) v = node.getAttribute('popover');
  else {
    const info = staticInfo(node);
    if (info && Object.prototype.hasOwnProperty.call(info.attrs, 'popover')) v = info.attrs.popover;
  }
  if (v === null) return null;
  v = String(v).toLowerCase();
  if (v === '' || v === 'auto') return 'auto';
  return 'manual';
}

function isDialogNode(node) {
  const info = staticInfo(node);
  return node.tag === 'dialog' || (!!info && info.tag === 'dialog');
}

function installDialogApi(node, ownerDoc) {
  node.open = false;
  node.returnValue = '';
  node.popoverTargetElement = null;
  node._popoverOpen = false;

  node.showModal = function () {
    if (node.open) return;
    const doc = ownerDoc;
    if (doc) doc._hideAllAutoPopovers(false);
    node._opener = doc ? doc.activeElement : null;
    node.open = true;
    if (!doc) return;
    doc._modal.push(node);
    doc._topLayer.push(node);
    const target = doc._autofocusTarget(node);
    if (target && typeof target.focus === 'function') target.focus();
  };

  node.close = function (rv) {
    if (!node.open) return;
    if (rv !== undefined) node.returnValue = String(rv);
    node.open = false;
    const doc = ownerDoc;
    if (doc) {
      doc._remove(doc._modal, node);
      doc._remove(doc._topLayer, node);
      const opener = node._opener;
      node._opener = null;
      const focusWasInside = !!doc.activeElement && doc.contains(node, doc.activeElement);
      // 開啟前的焦點若已不可聚焦(被移出文件、落在關著的選單裡)，焦點掉回 body。
      if (opener && doc.isFocusable(opener)) opener.focus();
      else if (opener || focusWasInside) doc.activeElement = doc.body;
    }
    node.fire('close', makeEvent('close', node));
  };

  node.showPopover = function () {
    const type = popoverTypeOf(node);
    if (!type) {
      const err = new Error('NotSupportedError:元素沒有 popover 屬性');
      err.name = 'NotSupportedError';
      throw err;
    }
    if (node._popoverOpen) return;
    const before = makeEvent('beforetoggle', node, { cancelable: true, newState: 'open', oldState: 'closed' });
    node.fire('beforetoggle', before);
    if (before.defaultPrevented) return;
    const doc = ownerDoc;
    if (doc && type === 'auto') {
      doc._popovers
        .filter((p) => p !== node && p._popoverType === 'auto' && !doc.contains(p, node))
        .reverse()
        .forEach((p) => doc._hidePopover(p, false, true));
    }
    node._popoverType = type;
    node._popoverPrevFocus = doc ? doc.activeElement : null;
    node._popoverOpen = true;
    if (doc) {
      doc._popovers.push(node);
      doc._topLayer.push(node);
    }
    node.fire('toggle', makeEvent('toggle', node, { newState: 'open', oldState: 'closed' }));
  };

  node.hidePopover = function () {
    if (ownerDoc) ownerDoc._hidePopover(node, true, true);
    else node._popoverOpen = false;
  };

  node.togglePopover = function (force) {
    const next = force === undefined ? !node._popoverOpen : !!force;
    if (next) node.showPopover();
    else node.hidePopover();
    return node._popoverOpen;
  };

  node.matches = function (sel) {
    const s = String(sel).trim();
    if (s === ':popover-open') return !!node._popoverOpen;
    if (s === '[open]' || s === 'dialog[open]') return !!node.open;
    return false;
  };
}

function installDocumentDialogApi(doc) {
  doc._modal = [];
  doc._popovers = [];
  doc._topLayer = [];
  doc.body = doc.createElement('body');
  doc.documentElement.clientWidth = 1000;

  doc._remove = function (list, item) {
    const idx = list.indexOf(item);
    if (idx !== -1) list.splice(idx, 1);
  };

  // 由近到遠的祖先:先走 parentNode，走到頂若是 options.html 的靜態節點，
  // 再接上它在 HTML 裡的祖先。
  doc.ancestorsOf = function (node) {
    const out = [];
    let cur = node;
    while (cur.parentNode) {
      cur = cur.parentNode;
      out.push(cur);
    }
    const id = cur.__stubId;
    if (id && STATIC_HTML.ancestors[id]) {
      STATIC_HTML.ancestors[id].forEach((aid) => out.push(doc.getElementById(aid) || doc.ids[aid]));
    }
    return out.filter(Boolean);
  };

  // 深層包含:動態子樹與 options.html 的靜態巢狀都算。
  doc.contains = function (container, node) {
    if (!container || !node) return false;
    if (container === node) return true;
    return doc.ancestorsOf(node).indexOf(container) !== -1;
  };

  doc.isConnected = function (node) {
    let cur = node;
    while (cur.parentNode) cur = cur.parentNode;
    if (cur === doc.body || cur === doc.documentElement) return true;
    if (!cur.__stubId) return false;
    // 登記在 STATIC_PARENT_ID 的節點本來就該掛在容器下，沒有 parentNode 代表
    // 已被清出容器。
    return !STATIC_PARENT_ID[cur.__stubId];
  };

  // 可聚焦:在文件裡、自己與祖先都沒有 hidden、不在關著的 popover 或 dialog 裡。
  doc.isFocusable = function (node) {
    if (!node || typeof node.focus !== 'function') return false;
    if (!doc.isConnected(node)) return false;
    return [node].concat(doc.ancestorsOf(node)).every((n) => {
      if (n.hidden === true) return false;
      if (n !== node && popoverTypeOf(n) && !n._popoverOpen) return false;
      if (n !== node && isDialogNode(n) && !n.open) return false;
      return true;
    });
  };

  // 有 modal 開著時，不在最上層 modal 裡的節點都是 inert;開在它之後的
  // popover(例如 toast)不受影響。
  doc.isInert = function (node) {
    const top = doc._modal[doc._modal.length - 1];
    if (!top) return false;
    if (doc.contains(top, node)) return false;
    const topIdx = doc._topLayer.indexOf(top);
    return !doc._popovers.some((p) => doc._topLayer.indexOf(p) > topIdx && doc.contains(p, node));
  };

  // showModal 的焦點落點:dialog 內第一個 autofocus 節點。動態子節點帶
  // autofocus 者優先，否則讀 options.html;都沒有就聚焦 dialog 本身(規格會
  // 找第一個可聚焦的後代，stub 看不到靜態後代，刻意落在 dialog 上，讓漏寫
  // autofocus 的情況在測試裡現形)。
  doc._autofocusTarget = function (dialog) {
    const queue = (dialog.children || []).slice();
    while (queue.length) {
      const cur = queue.shift();
      if (cur.autofocus === true || cur.getAttribute('autofocus') !== null) return cur;
      (cur.children || []).forEach((c) => queue.push(c));
    }
    const id = dialog.__stubId && STATIC_HTML.autofocusIn[dialog.__stubId];
    if (id) return doc.getElementById(id);
    return dialog;
  };

  // 隱藏 popover。focusPrev 為 true(腳本呼叫 hidePopover、按 Esc)時，若焦點
  // 在 popover 裡，還給開啟前的元素;light dismiss 與 showModal 不還。
  doc._hidePopover = function (pop, focusPrev, fireEvents) {
    if (!pop._popoverOpen) return;
    if (fireEvents) {
      pop.fire('beforetoggle', makeEvent('beforetoggle', pop, { newState: 'closed', oldState: 'open' }));
    }
    pop._popoverOpen = false;
    doc._remove(doc._popovers, pop);
    doc._remove(doc._topLayer, pop);
    const prev = pop._popoverPrevFocus;
    pop._popoverPrevFocus = null;
    if (focusPrev && prev && doc.activeElement && doc.contains(pop, doc.activeElement) && doc.isFocusable(prev)) {
      prev.focus();
    }
    if (fireEvents) {
      pop.fire('toggle', makeEvent('toggle', pop, { newState: 'closed', oldState: 'open' }));
    }
  };

  doc._hideAllAutoPopovers = function (focusPrev) {
    doc._popovers
      .filter((p) => p._popoverType === 'auto')
      .reverse()
      .forEach((p) => doc._hidePopover(p, focusPrev, true));
  };

  // 子樹被移出文件:裡面開著的 popover 不派事件、直接隱藏。
  doc._hidePopoversIn = function (roots) {
    doc._popovers.slice().forEach((p) => {
      if (roots.some((r) => isInSubtree(r, p))) doc._hidePopover(p, false, false);
    });
  };

  // 使用者按 Esc:keydown 從焦點節點沿祖先冒泡到 document;沒被
  // preventDefault 才對 top layer 最上層的 auto popover 或 modal 發 close
  // request。modal 先收到可取消的 cancel，沒被擋才 close()。回傳被關掉的
  // 節點，沒有則回 null。
  doc.pressEscape = function () {
    const active = doc.activeElement;
    const ev = makeEvent('keydown', active || doc, { key: 'Escape', cancelable: true });
    if (active && typeof active.fire === 'function') {
      const chain = [active].concat(doc.ancestorsOf(active));
      for (const n of chain) {
        if (ev._stopped) break;
        ev.currentTarget = n;
        n.fire('keydown', ev);
      }
    }
    if (!ev._stopped) doc.fire('keydown', ev);
    if (ev.defaultPrevented) return null;
    for (let i = doc._topLayer.length - 1; i >= 0; i--) {
      const el = doc._topLayer[i];
      if (el._popoverOpen && el._popoverType === 'auto') {
        doc._hidePopover(el, true, true);
        return el;
      }
      if (el.open && doc._modal.indexOf(el) !== -1) {
        const cancel = makeEvent('cancel', el, { cancelable: true });
        el.fire('cancel', cancel);
        if (cancel.defaultPrevented) return null;
        el.close();
        return el;
      }
    }
    return null;
  };

  // 使用者點在 target 上的 light dismiss:收掉不含 target 的 auto popover，
  // target 是該 popover 的觸發鈕(或在觸發鈕裡)時不收。只處理 dismiss，不派
  // click 給 target。
  doc.lightDismiss = function (target) {
    doc._popovers
      .filter((p) => p._popoverType === 'auto')
      .reverse()
      .forEach((p) => {
        if (doc.contains(p, target)) return;
        if (p._invoker && doc.contains(p._invoker, target)) return;
        doc._hidePopover(p, false, true);
      });
  };
}

function isPopoverOpen(node) {
  return !!node && typeof node.matches === 'function' && node.matches(':popover-open');
}

module.exports = {
  makeNode,
  makeDocumentStub,
  isInSubtree,
  isPopoverOpen,
  parseStaticHtml,
  STATIC_PARENT_ID,
};
