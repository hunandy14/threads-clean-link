// test/support/reinject-harness.js — 孤兒防線（R1）與交棒（R3／R4）兩份測試
// 共用的假頁面環境：一棵可查詢、可插拔節點的迷你 DOM，外加可觀測的
// document 事件、MutationObserver、計時器與 chrome API 呼叫紀錄。
//
// 迷你 DOM（el／matchesSelector／createPostContainer／buildSsrJson 等）複製
// 自 test/scam-guard.test.js 的假件，只多支援 `[attr*="value"]` 選擇器與元
// 素層級的事件監聽，讓 post-icon.js 與 scam-guard.js 能在同一棵樹上跑完整
// 的注入流程。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage, createWindow } = require('./helpers');

const ROOT_DIR = path.join(__dirname, '..', '..');
const SRC = {
  i18n: fs.readFileSync(path.join(ROOT_DIR, 'i18n.js'), 'utf8'),
  core: fs.readFileSync(path.join(ROOT_DIR, 'tcl-core.js'), 'utf8'),
  postIcon: fs.readFileSync(path.join(ROOT_DIR, 'post-icon.js'), 'utf8'),
  scamGuard: fs.readFileSync(path.join(ROOT_DIR, 'scam-guard.js'), 'utf8'),
  bridge: fs.readFileSync(path.join(ROOT_DIR, 'bridge.js'), 'utf8'),
};
const POST_ICON_API = require(path.join(ROOT_DIR, 'post-icon.js'));

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scam-thread.json'), 'utf8')
);
const POSTS = FIXTURE.posts;
const AUTHOR = POSTS[0].username;
const DISPLAY_NAME = 'Example Author';
const ORIGIN = 'https://www.threads.com';
const DETAIL_PATH = `/@${AUTHOR}/post/${POSTS[0].code}`;
const CONTAINER_SELECTOR = 'div[data-pressable-container]';
const ICON_CLASS = 'tcl-copy-icon';
const TAG_CLASS = 'tcl-scam-tag';

// fixture 的招攬篇沒有 LINE 錨點，補一句合成的招攬句讓詳情頁掃描走到命中。
const SCAM_TAIL = '\n有興趣的加我 賴：ex01abc，我再把整理好的筆記傳給你。';
const MAIN_POSTS = POSTS.map((post, index) =>
  index === POSTS.length - 1
    ? Object.assign({}, post, { captionText: post.captionText + SCAM_TAIL })
    : Object.assign({}, post)
);

const SECOND_CODE = 'DsSeCoNd001';
const SECOND_PATH = `/@${AUTHOR}/post/${SECOND_CODE}`;
const SECOND_POSTS = [
  {
    code: SECOND_CODE,
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 1,
    selfThreadLength: 3,
    captionText: '第二串第一篇：離職之後很多人私訊問我，到底是怎麼開始研究股票的。',
  },
  {
    code: 'DsSeCoNd002',
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 2,
    selfThreadLength: 3,
    captionText: '第二串第二篇：我把流程整理成三步，先翻財報再看機台稼動率，最後才看線型。',
  },
  {
    code: 'DsSeCoNd003',
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 3,
    selfThreadLength: 3,
    captionText: '第二串第三篇：不報明牌、不收費，想看完整筆記的加我 賴：vg999，我傳給你。',
  },
];

// ============================================================
// 迷你 DOM
// ============================================================

// 單段選擇器：`tag`、`.class`、`#id`、`[attr]`、`[attr="v"]`、
// `[attr^="v"]`、`[attr*="v"]` 與它們的組合。空白分隔的後代選擇器由
// querySelectorAll 逐段處理。
const SELECTOR_PATTERN =
  /^([a-zA-Z]*)((?:[.#][A-Za-z0-9_-]+)*)(?:\[([a-zA-Z-]+)(?:([\^*]?=)"([^"]*)")?\])?$/;

function classListOf(node) {
  return String(node.getAttribute('class') || '')
    .split(/\s+/)
    .filter(Boolean);
}

function matchesSelector(node, selector) {
  const parsed = SELECTOR_PATTERN.exec(String(selector).trim());
  assert.ok(parsed, `假 DOM 不支援的選擇器：${selector}`);
  const [, tag, qualifiers, attr, operator, value] = parsed;
  if (tag && node.nodeName !== tag.toUpperCase()) return false;
  const marks = qualifiers ? qualifiers.match(/[.#][A-Za-z0-9_-]+/g) || [] : [];
  for (const mark of marks) {
    const name = mark.slice(1);
    if (mark.charAt(0) === '.') {
      if (classListOf(node).indexOf(name) === -1) return false;
    } else if (node.getAttribute('id') !== name) {
      return false;
    }
  }
  if (!attr) return true;
  const actual = node.getAttribute(attr);
  if (actual === null) return false;
  if (!operator) return true;
  if (operator === '^=') return actual.indexOf(value) === 0;
  if (operator === '*=') return actual.indexOf(value) !== -1;
  return actual === value;
}

function text(value) {
  return { nodeType: 3, nodeName: '#text', textContent: value, childNodes: [] };
}

function isRenderedHidden(node) {
  let cursor = node;
  while (cursor && cursor.nodeType === 1) {
    if (typeof cursor.hasAttribute === 'function' && cursor.hasAttribute('hidden')) return true;
    if (cursor.style && cursor.style.display === 'none') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function fakeRect() {
  return { x: 0, y: 0, width: 240, height: 80, top: 0, left: 0, right: 240, bottom: 80 };
}

// 事件監聽表：支援 options.signal（AbortSignal 中止即移除）與 once，供
// 「交棒時一次取消所有監聽」的斷言觀測仍掛著幾個監聽器。
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
      const type = event && event.type;
      entries
        .filter((e) => e.type === type)
        .forEach((e) => {
          if (entries.indexOf(e) === -1) return;
          if (e.once) entries.splice(entries.indexOf(e), 1);
          if (typeof e.fn === 'function') e.fn.call(target, event);
          else e.fn.handleEvent(event);
        });
      return true;
    },
    count(type) {
      return entries.filter((e) => (type === undefined ? true : e.type === type)).length;
    },
    types() {
      return entries.map((e) => e.type);
    },
  };
}

function el(tag, attributes, children) {
  const listeners = createListenerTable();
  const node = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    attributes: Object.assign({}, attributes),
    childNodes: [],
    parentElement: null,
    parentNode: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name)
        ? String(node.attributes[name])
        : null;
    },
    hasAttribute(name) {
      return node.getAttribute(name) !== null;
    },
    matches(selector) {
      return matchesSelector(node, selector);
    },
    closest(selector) {
      let cursor = node;
      while (cursor && cursor.nodeType === 1) {
        if (cursor.matches(selector)) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete node.attributes[name];
    },
    querySelectorAll(selector) {
      const parts = String(selector).trim().split(/\s+/);
      let current = [node];
      parts.forEach((part) => {
        const next = [];
        current.forEach((context) => {
          (function walk(cursor) {
            cursor.childNodes.forEach((child) => {
              if (child.nodeType !== 1) return;
              if (child.matches(part) && next.indexOf(child) === -1) next.push(child);
              walk(child);
            });
          })(context);
        });
        current = next;
      });
      return current;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] || null;
    },
    appendChild(child) {
      if (child.parentNode && child.parentNode !== node && child.parentNode.removeChild) {
        child.parentNode.removeChild(child);
      }
      node.childNodes.push(child);
      if (child.nodeType === 1) {
        child.parentElement = node;
        child.parentNode = node;
      }
      return child;
    },
    insertBefore(newNode, refNode) {
      const index = refNode ? node.childNodes.indexOf(refNode) : -1;
      if (index === -1) return node.appendChild(newNode);
      node.childNodes.splice(index, 0, newNode);
      if (newNode.nodeType === 1) {
        newNode.parentElement = node;
        newNode.parentNode = node;
      }
      return newNode;
    },
    insertAdjacentElement(position, element) {
      const parent = node.parentElement;
      switch (String(position).toLowerCase()) {
        case 'beforebegin':
          return parent ? parent.insertBefore(element, node) : null;
        case 'afterend':
          return parent ? parent.insertBefore(element, node.nextSibling) : null;
        case 'afterbegin':
          return node.insertBefore(element, node.childNodes[0] || null);
        case 'beforeend':
          return node.appendChild(element);
        default:
          throw new Error(`假 DOM 不支援的 insertAdjacentElement 位置：${position}`);
      }
    },
    removeChild(child) {
      const index = node.childNodes.indexOf(child);
      if (index !== -1) node.childNodes.splice(index, 1);
      if (child.nodeType === 1) {
        child.parentElement = null;
        child.parentNode = null;
      }
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
    addEventListener(type, fn, options) {
      listeners.add(type, fn, options);
    },
    removeEventListener(type, fn, options) {
      listeners.remove(type, fn, options);
    },
    dispatchEvent(event) {
      return listeners.dispatch(node, event);
    },
    // ---- 測試專用 ----
    fire(type, extra) {
      const event = Object.assign(
        { type, target: node, currentTarget: node, stopPropagation() {}, preventDefault() {} },
        extra || {}
      );
      return listeners.dispatch(node, event);
    },
    listenerCount(type) {
      return listeners.count(type);
    },
    getClientRects() {
      return isRenderedHidden(node) ? [] : [fakeRect()];
    },
    checkVisibility() {
      return !isRenderedHidden(node);
    },
    getBoundingClientRect() {
      return fakeRect();
    },
    style: {},
    classList: {
      add(...names) {
        const list = classListOf(node);
        names.forEach((name) => {
          if (list.indexOf(name) === -1) list.push(name);
        });
        node.attributes.class = list.join(' ');
      },
      remove(...names) {
        node.attributes.class = classListOf(node)
          .filter((name) => names.indexOf(name) === -1)
          .join(' ');
      },
      contains(name) {
        return classListOf(node).indexOf(name) !== -1;
      },
      toggle(name, force) {
        const has = classListOf(node).indexOf(name) !== -1;
        const want = force === undefined ? !has : !!force;
        if (want) node.classList.add(name);
        else node.classList.remove(name);
        return want;
      },
    },
  };

  Object.defineProperty(node, 'children', {
    get() {
      return node.childNodes.filter((child) => child.nodeType === 1);
    },
  });
  Object.defineProperty(node, 'textContent', {
    get() {
      return node.childNodes.map((child) => child.textContent).join('');
    },
    set(value) {
      node.childNodes.length = 0;
      if (value !== null && value !== undefined && value !== '') {
        node.appendChild(text(String(value)));
      }
    },
  });
  [
    ['id', 'id'],
    ['className', 'class'],
    ['title', 'title'],
  ].forEach(([property, attribute]) => {
    Object.defineProperty(node, property, {
      get() {
        return node.getAttribute(attribute) || '';
      },
      set(value) {
        node.attributes[attribute] = String(value);
      },
    });
  });
  Object.defineProperty(node, 'hidden', {
    get() {
      return node.hasAttribute('hidden');
    },
    set(value) {
      if (value) node.attributes.hidden = '';
      else delete node.attributes.hidden;
    },
  });
  Object.defineProperty(node, 'offsetParent', {
    get() {
      return isRenderedHidden(node) ? null : node.parentElement;
    },
  });
  Object.defineProperty(node, 'nextSibling', {
    get() {
      const parent = node.parentElement;
      if (!parent) return null;
      return parent.childNodes[parent.childNodes.indexOf(node) + 1] || null;
    },
  });
  Object.defineProperty(node, 'nextElementSibling', {
    get() {
      const parent = node.parentElement;
      if (!parent) return null;
      const siblings = parent.childNodes;
      for (let i = siblings.indexOf(node) + 1; i < siblings.length; i += 1) {
        if (siblings[i].nodeType === 1) return siblings[i];
      }
      return null;
    },
  });
  Object.defineProperty(node, 'lastElementChild', {
    get() {
      const elements = node.children;
      return elements[elements.length - 1] || null;
    },
  });

  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

// ---- 頁面零件（比照 scam-guard.test.js）----

const ACTION_LABELS = ['讚', '回覆', '轉發', '分享'];

function createActionRow() {
  return el(
    'div',
    { 'data-tcl-fake-action-row': 'true' },
    ACTION_LABELS.map((label) =>
      el('div', {}, [
        el('div', { role: 'button' }, [
          el('svg', { 'aria-label': label }, [el('title', {}, [text(label)])]),
        ]),
      ])
    )
  );
}

function createPostContainer(options) {
  const lines = Array.isArray(options.body) ? options.body : [options.body];
  const timeLink = el('a', { href: `/@${options.handle}/post/${options.code}` }, [
    el('time', { datetime: '2026-09-19T10:00:00Z' }, [text('2 小時')]),
  ]);
  const children = [
    el('div', { 'data-tcl-fake-author-row': 'true' }, [
      el('a', { href: `/@${options.handle}` }, [el('span', { dir: 'auto' }, [text(options.handle)])]),
      el('div', {}, [el('div', {}, [el('span', {}, [timeLink])])]),
    ]),
    el(
      'div',
      {},
      lines.map((line) => el('span', { dir: 'auto' }, [text(line)]))
    ),
  ];
  if (options.actionRow) children.push(createActionRow());
  return el('div', { 'data-pressable-container': 'true' }, children);
}

function withBadge(body, position, total) {
  return `${body}\n${position}\n/\n${total}`;
}

function buildSsrJson(post) {
  const item = {
    post: {
      pk: '3721104520121958207',
      code: post.code,
      taken_at: 1758278400,
      caption: { text: post.captionText },
      user: { id: post.userId, username: post.username, full_name: DISPLAY_NAME, is_verified: false },
      text_post_app_info: {
        direct_reply_count: 3,
        self_thread_info: {
          self_thread_length: post.selfThreadLength,
          post_position_in_self_thread: post.position,
        },
      },
    },
  };
  return JSON.stringify({
    require: [
      [
        'ScheduledServerJS',
        'handle',
        null,
        [
          {
            __bbox: {
              require: [
                [
                  'RelayPrefetchedStreamCache',
                  'next',
                  [],
                  [
                    {
                      __bbox: {
                        result: {
                          data: { data: { edges: [{ node: { thread_items: [item] } }] } },
                          status: 'success',
                        },
                      },
                    },
                  ],
                ],
              ],
            },
          },
        ],
      ],
    ],
  });
}

// 詳情頁：SSR script ＋ 作者 N 篇（前 N-1 篇帶徽章）＋ 一篇他人回覆，每張卡
// 都有互動列。
function createDetailPage(posts) {
  const list = posts || MAIN_POSTS;
  const total = list.length;
  const containers = list.map((post, index) =>
    createPostContainer({
      handle: AUTHOR,
      code: post.code,
      body: index === total - 1 ? post.captionText : withBadge(post.captionText, post.position, total),
      actionRow: true,
    })
  );
  containers.push(
    createPostContainer({
      handle: 'some.other_reader',
      code: 'DxReplY001A',
      body: '推推，恭喜脫離輪班人生，接下來就是自由的日子了！',
      actionRow: true,
    })
  );
  return [
    el('script', { type: 'application/json' }, [text(buildSsrJson(list[0]))]),
    el('div', { id: 'thread-root' }, containers),
  ];
}

// 河道：N 張互不相干的卡片，每張都有互動列（post-icon 每張注入一顆）。
let feedSeq = 0;
function createFeedCard(handle) {
  feedSeq += 1;
  return createPostContainer({
    handle: handle || 'feed.author',
    code: 'DfEeD' + String(feedSeq).padStart(6, '0'),
    body: '河道上的一則貼文，內容與投資話術無關。',
    actionRow: true,
  });
}
function createFeedPage(count) {
  const cards = [];
  for (let i = 0; i < count; i++) cards.push(createFeedCard('feed.author' + i));
  return [el('div', { id: 'feed-root' }, cards)];
}

// ---- 假 document：迷你 DOM ＋ 可觀測的事件派送 ----
function createFakeDocument(bodyChildren) {
  const head = el('head', {}, []);
  const body = el('body', {}, bodyChildren || []);
  const html = el('html', {}, [head, body]);
  const listeners = createListenerTable();
  const dispatched = [];
  const doc = {
    readyState: 'complete',
    documentElement: html,
    head,
    body,
    createElement(tag) {
      return el(tag, {}, []);
    },
    createTextNode(value) {
      return text(value);
    },
    getElementById(id) {
      return html.querySelectorAll(`[id="${id}"]`)[0] || null;
    },
    querySelector(selector) {
      return html.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      return html.querySelectorAll(selector);
    },
    addEventListener(type, fn, options) {
      listeners.add(type, fn, options);
    },
    removeEventListener(type, fn, options) {
      listeners.remove(type, fn, options);
    },
    // 真實 DOM 的 dispatchEvent 是同步派送；這裡同樣同步呼叫監聽器，並留
    // 下派送紀錄供斷言事件形狀。
    dispatchEvent(event) {
      dispatched.push(event);
      return listeners.dispatch(doc, event);
    },
    // ---- 測試專用 ----
    dispatched,
    listenerCount(type) {
      return listeners.count(type);
    },
    listenerTypes() {
      return listeners.types();
    },
  };
  return doc;
}

// ============================================================
// 可觀測的執行期替身
// ============================================================

// chrome.* 呼叫紀錄：把 chrome 物件樹上的每個函式換成「先記一筆再呼叫原
// 函式」的包裝。紀錄是 { path, seq }；runtime.id 等純資料屬性不受影響，測
// 試照樣可以改寫它來模擬孤兒化。
function instrumentChrome(chrome) {
  const calls = [];
  const seen = new Set();
  (function wrap(obj, prefix) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    Object.keys(obj).forEach((key) => {
      const value = obj[key];
      const name = prefix + '.' + key;
      if (typeof value === 'function') {
        obj[key] = function () {
          calls.push({ path: name, args: Array.prototype.slice.call(arguments) });
          return value.apply(this, arguments);
        };
      } else if (value && typeof value === 'object') {
        wrap(value, name);
      }
    });
  })(chrome, 'chrome');
  return calls;
}

function createChromeDouble(options) {
  const settings = options || {};
  const storage = createChromeStorage(settings.sync || { langPref: 'zh' }, settings.local || {});
  // 交棒（非孤兒）時實作可能想拆掉 onChanged 監聽，替身補上 removeListener。
  storage.api.onChanged.removeListener = function () {};
  const sent = [];
  const chrome = {
    runtime: {
      id: settings.runtimeId === undefined ? 'tcl-test-ext' : settings.runtimeId,
      lastError: undefined,
      getURL(p) {
        return 'chrome-extension://tcl-test-ext/' + p;
      },
      sendMessage(message, callback) {
        sent.push(message);
        const reply =
          typeof settings.respond === 'function'
            ? settings.respond(message)
            : { ok: true, added: true, entry: { handle: AUTHOR } };
        if (typeof callback === 'function') {
          setTimeout(() => callback(reply), 0);
          return undefined;
        }
        return new Promise((resolve) => setTimeout(() => resolve(reply), 0));
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: storage.api,
    i18n: { getUILanguage: () => 'zh-TW' },
  };
  if (settings.runtimeId === null) delete chrome.runtime.id;
  const calls = instrumentChrome(chrome);
  return { chrome, storage, sent, calls };
}

// 計時器替身：沿用真實 setTimeout 排程，另外記下每一顆的延遲、是否已觸
// 發、是否被 clearTimeout 取消，以及排程當下的「階段」標籤（由測試切換），
// 用來斷言「舊實例退場時清掉了它排下的計時器」。
function createTimerDouble() {
  const records = [];
  let phase = 'init';
  function track(kind, realSet, realClear) {
    return {
      set(fn, delay) {
        const args = Array.prototype.slice.call(arguments, 2);
        const record = { kind, delay: delay || 0, phase, fired: false, cleared: false, handle: null };
        record.handle = realSet(function () {
          record.fired = kind === 'timeout' ? true : record.fired;
          if (typeof fn === 'function') fn.apply(null, args);
        }, delay);
        records.push(record);
        return record.handle;
      },
      clear(handle) {
        const record = records.find((r) => r.handle === handle);
        if (record) record.cleared = true;
        return realClear(handle);
      },
    };
  }
  const timeout = track('timeout', setTimeout, clearTimeout);
  const interval = track('interval', setInterval, clearInterval);
  return {
    setTimeout: timeout.set,
    clearTimeout: timeout.clear,
    setInterval: interval.set,
    clearInterval: interval.clear,
    records,
    setPhase(next) {
      phase = next;
    },
    // 某階段排下、到現在既沒觸發也沒被取消的計時器。
    pendingFrom(tag) {
      return records.filter((r) => r.phase === tag && !r.fired && !r.cleared);
    },
    // 測試收尾：把還掛著的計時器清掉，不讓它們拖住行程。
    dispose() {
      records.forEach((r) => {
        if (r.kind === 'interval') clearInterval(r.handle);
        else if (!r.fired) clearTimeout(r.handle);
      });
    },
  };
}

function createObserverDouble() {
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {
      if (!this.disconnected) this.observing = true;
    }
    disconnect() {
      this.observing = false;
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }
  return {
    FakeMutationObserver,
    observers,
    live() {
      return observers.filter((o) => o.observing && !o.disconnected);
    },
    // 模擬 DOM 變動：只有仍在 observe 的 observer 會收到回呼（與瀏覽器一
    // 致——disconnect 之後不再收到任何記錄）。
    trigger() {
      observers
        .filter((o) => o.observing && !o.disconnected)
        .forEach((o) => o.callback([], o));
    },
  };
}

// 未捕捉例外／未處理 rejection 收集器。收集期間暫時接管 process 的兩個事
// 件，restore() 還原。
function captureUncaught() {
  const errors = [];
  const onError = (err) => errors.push(err);
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return {
    errors,
    restore() {
      process.removeListener('uncaughtException', onError);
      process.removeListener('unhandledRejection', onError);
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, label, timeout) {
  const deadline = Date.now() + (timeout || 2000);
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error('waitFor 逾時：' + (label || '條件未成立'));
    await wait(15);
  }
}

// ============================================================
// 頁面環境：document_idle 那組 ISOLATED 腳本共用的 sandbox
// ============================================================
//
// options:
//   pathname   網址列路徑（預設詳情頁）
//   page       body 子節點（預設 createDetailPage()）
//   runtimeId  chrome.runtime.id 初值（undefined＝有效 id；null＝缺席）
//   sync/local chrome.storage 初值
//   respond    sendMessage 的回應
//   document   與另一個環境共用的 document（見下方註解）
//   stubPostIcon 只測 scam-guard 時用 post-icon 的純函式替身頂著
//               root.TCLPostIcon（不跑 post-icon 的注入層）
function createPageEnv(options) {
  const settings = options || {};
  const pathname = settings.pathname === undefined ? DETAIL_PATH : settings.pathname;
  const location = { origin: ORIGIN, pathname, search: '', hash: '', href: ORIGIN + pathname };
  // document 選填：傳入另一個環境的 document，模擬「同一分頁、不同
  // ISOLATED world」——擴充功能更新後，舊實例留在已失效的舊 world，重注入
  // 的新實例跑在新 world，兩者只共用 DOM，不共用 window 全域。
  const doc = settings.document || createFakeDocument(settings.page || createDetailPage());
  const chromeDouble = createChromeDouble(settings);
  const timers = createTimerDouble();
  const obs = createObserverDouble();
  const consoleLog = { error: [], warn: [], debug: [], log: [] };
  const windowListeners = createListenerTable();

  const sandbox = {
    location,
    navigator: { language: 'zh-TW' },
    document: doc,
    MutationObserver: obs.FakeMutationObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    Promise,
    URL,
    Date,
    WeakMap,
    WeakSet,
    CustomEvent,
    Event,
    AbortController,
    AbortSignal,
    getComputedStyle: () => ({ color: '' }),
    addEventListener(type, fn, opts) {
      windowListeners.add(type, fn, opts);
    },
    removeEventListener(type, fn, opts) {
      windowListeners.remove(type, fn, opts);
    },
    dispatchEvent(event) {
      return windowListeners.dispatch(sandbox, event);
    },
    postMessage() {},
    console: {
      error: (...args) => consoleLog.error.push(args.map(String).join(' ')),
      warn: (...args) => consoleLog.warn.push(args.map(String).join(' ')),
      debug: (...args) => consoleLog.debug.push(args.map(String).join(' ')),
      info: (...args) => consoleLog.log.push(args.map(String).join(' ')),
      log: (...args) => consoleLog.log.push(args.map(String).join(' ')),
    },
    chrome: chromeDouble.chrome,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  runInSandbox(SRC.i18n, sandbox);
  runInSandbox(SRC.core, sandbox);
  if (settings.stubPostIcon) {
    sandbox.TCLPostIcon = Object.assign({}, POST_ICON_API, { showToast() {} });
  }

  let orphanMark = null;
  const env = {
    sandbox,
    document: doc,
    location,
    chrome: chromeDouble.chrome,
    storage: chromeDouble.storage,
    sent: chromeDouble.sent,
    chromeCalls: chromeDouble.calls,
    timers,
    observers: obs.observers,
    liveObservers: obs.live,
    triggerObserver: obs.trigger,
    consoleLog,
    windowListenerCount: (type) => windowListeners.count(type),
    loadPostIcon() {
      runInSandbox(SRC.postIcon, sandbox);
      return env;
    },
    loadScamGuard() {
      runInSandbox(SRC.scamGuard, sandbox);
      return env;
    },
    // 模擬擴充功能更新後的孤兒化：runtime.id 變成 undefined，並從這一刻起
    // 另計 chrome API 呼叫。
    orphan() {
      chromeDouble.chrome.runtime.id = undefined;
      orphanMark = chromeDouble.calls.length;
    },
    callsSinceOrphan() {
      return orphanMark === null ? [] : chromeDouble.calls.slice(orphanMark).map((c) => c.path);
    },
    icons() {
      return doc.querySelectorAll('.' + ICON_CLASS);
    },
    tags() {
      return doc.querySelectorAll('.' + TAG_CLASS);
    },
    hits() {
      return chromeDouble.sent.filter((m) => m && m.type === 'scam.hit');
    },
    setPathname(next) {
      location.pathname = next;
      location.href = ORIGIN + next;
    },
    setPage(children) {
      doc.body.childNodes.length = 0;
      children.forEach((child) => doc.body.appendChild(child));
    },
    dispose() {
      timers.dispose();
    },
  };
  return env;
}

// ---- bridge.js 環境（bridge 不碰 document，只聽 window message）----
function createBridgeEnv(options) {
  const settings = options || {};
  const win = createWindow();
  const chromeDouble = createChromeDouble(settings);
  const consoleLog = { error: [], warn: [], debug: [], log: [] };
  const sandbox = {
    window: win,
    chrome: chromeDouble.chrome,
    setTimeout,
    clearTimeout,
    AbortController,
    CustomEvent,
    console: {
      error: (...args) => consoleLog.error.push(args.map(String).join(' ')),
      warn: (...args) => consoleLog.warn.push(args.map(String).join(' ')),
      debug: (...args) => consoleLog.debug.push(args.map(String).join(' ')),
      info: () => {},
      log: () => {},
    },
  };
  let orphanMark = null;
  return {
    win,
    sandbox,
    chrome: chromeDouble.chrome,
    storage: chromeDouble.storage,
    sent: chromeDouble.sent,
    chromeCalls: chromeDouble.calls,
    consoleLog,
    load() {
      runInSandbox(SRC.bridge, sandbox);
    },
    orphan() {
      chromeDouble.chrome.runtime.id = undefined;
      orphanMark = chromeDouble.calls.length;
    },
    callsSinceOrphan() {
      return orphanMark === null ? [] : chromeDouble.calls.slice(orphanMark).map((c) => c.path);
    },
  };
}

module.exports = {
  AUTHOR,
  CONTAINER_SELECTOR,
  DETAIL_PATH,
  ICON_CLASS,
  MAIN_POSTS,
  SECOND_PATH,
  SECOND_POSTS,
  TAG_CLASS,
  captureUncaught,
  createBridgeEnv,
  createDetailPage,
  createFeedCard,
  createFeedPage,
  createPageEnv,
  el,
  wait,
  waitFor,
};
