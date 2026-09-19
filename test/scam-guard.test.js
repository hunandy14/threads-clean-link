// test/scam-guard.test.js — scam-guard.js(詐騙串文警示 content script)的
// 「取值段」純函式契約：從貼文詳情頁的 SSR JSON 取作者數字 id／串長，從
// DOM 取自回覆串六篇文字。判定（正則命中）與黑名單寫入不在本檔涵蓋。
//
// ============================================================
// 【設計約定：scam-guard.js 對測試暴露的契約】
// 比照 post-icon.js 的既有慣例——CommonJS 相容的 IIFE 模組，純函式一律
// 宣告在 `if (typeof document !== 'undefined')` 守衛「之外」，讓無 document
// 的 Node 測試環境 require() 時不丟例外、不產生副作用：
//
//   (function (root) {
//     ...純函式區...
//     if (typeof document !== 'undefined') { ...DOM 注入層... }
//     if (typeof module !== 'undefined' && module.exports) {
//       module.exports = api;
//     } else {
//       root.TCLScamGuard = api;
//     }
//   })(typeof window !== 'undefined' ? window : this);
//
// 暴露的純函式：
//   extractSsrRoot(scriptTexts: string[]) → object|null
//     輸入詳情頁所有 script[type="application/json"] 的文字。逐筆 JSON.parse
//     （失敗者略過、不丟例外），對成功解析的物件「遞迴 walk」找出任何帶
//     非空 `thread_items` 陣列的節點——刻意不綁固定路徑，因為 Threads 的
//     RelayPrefetchedStreamCache 外層包裝每版都在變。取 thread_items[0].post
//     組出 { code, userId, username, displayName, captionText,
//     selfThreadLength, position }：
//       code            ← post.code
//       userId          ← post.user.id（字串數字 id，比對用主鍵）
//       username        ← post.user.username
//       displayName     ← post.user.full_name
//       captionText     ← post.caption.text
//       selfThreadLength← self_thread_info.self_thread_length
//       position        ← self_thread_info.post_position_in_self_thread
//     self_thread_info 在實測 payload 裡掛在 post.text_post_app_info 之下，
//     但同樣不應綁死路徑（在 post 節點內遞迴找即可）。找不到任何帶
//     thread_items 的節點、輸入非陣列或為空，一律回傳 null。
//   stripPositionBadge(text: string) → { text, position, total }
//     剝掉 DOM 文字尾端的「N/M」串文徽章（實測形狀為 `\n1\n/\n6`，故樣式
//     為 /\s*\n?(\d+)\n?\/\n?(\d+)\s*$/）。回傳剝除後的 text 與解析出的
//     position／total（數字）；沒有徽章時 text 原樣回傳、position 與 total
//     皆為 null。非字串輸入不丟例外。
//   extractThreadFromDom(root, authorHandle) → [{ code, text, position }]
//     對 root.querySelectorAll('div[data-pressable-container]') 逐個容器：
//       - 從容器內 a[href] 找出符合 `/@handle/post/CODE` 的連結，handle 與
//         code 的字元類沿用 tcl-core 的 STRICT_POST_URL_PATTERN
//         （handle [A-Za-z0-9._]{1,80}、code [A-Za-z0-9_-]{1,80}）。
//       - 只收 handle 等於 authorHandle 的容器（不分大小寫；authorHandle
//         帶不帶 '@' 前綴都要能對上，因為 post-icon.extractAuthorHandle
//         回傳的是帶 '@' 的形式）。
//       - 排除巢狀容器：引用貼文會把另一個 data-pressable-container 包在
//         外層容器內，子容器不得另外計為一篇。
//       - 本文取容器內「最長的」 span[dir="auto"]／[dir="auto"] 的
//         textContent，再套 stripPositionBadge。
//       - 回傳依 position 升冪；末篇（實測無徽章）以收集順序補 position。
//   buildThreadText(items) → string
//     以 '\n\n' 串接所有 item.text，供後續正則掃描。非陣列／空陣列回 ''。
//
// 【fixture】test/fixtures/scam-thread.json 為實機抓取的六篇全文（只留
// code／userId／username／position／selfThreadLength／captionText，無
// cookie／token／頭像 URL）。本檔用它組出 (a) 仿 SSR JSON 字串、(b) 假 DOM。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./support/helpers');

const SCAM_GUARD_PATH = path.join(__dirname, '..', 'scam-guard.js');

// require 刻意延遲到各測試內部（沿用 post-icon.test.js 的 loadPostIcon()
// 模式），並先用 existsSync 守門：檔案還沒建立時紅燈要落在這句斷言上，而
// 不是整個測試檔在載入階段就 MODULE_NOT_FOUND 崩掉。
function loadScamGuard() {
  assert.ok(fs.existsSync(SCAM_GUARD_PATH), 'scam-guard.js 尚未建立');
  return require(SCAM_GUARD_PATH);
}

// 先確認契約存在再測行為：函式還沒實作時，紅燈落在「缺這個匯出」的斷言
// 上，而不是 TypeError 崩在呼叫點。
function loadFn(name) {
  const api = loadScamGuard();
  assert.equal(
    typeof api[name],
    'function',
    `scam-guard.js 應在 DOM 守衛外匯出純函式 ${name}`
  );
  return api[name];
}

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'scam-thread.json'), 'utf8')
);
const POSTS = FIXTURE.posts;
const AUTHOR = POSTS[0].username;
// fixture 只留判定必要欄位，不含顯示名（顯示名非本案比對主鍵，且屬可省
// 略的個資），SSR 測試用的 full_name 在此合成。
const DISPLAY_NAME = 'Example Author';
const CONTAINER_SELECTOR = 'div[data-pressable-container]';

// ============================================================
// 【最小假 DOM：一棵支援 closest／querySelectorAll／textContent 的迷你樹】
// 本專案慣例是用 duck-type 假物件替代 DOM（見 post-icon.test.js），但
// extractThreadFromDom 的三條保證——「容器依文件序列出」「巢狀子容器要排
// 除」「本文取子樹內最長的 [dir="auto"]」——天生需要真的樹狀結構與祖先
// 鏈，無法用單層假物件表達。這裡只搭到剛好夠用的程度：屬性讀取、
// 祖先查找、後代查詢、文字串接；不擴充成通用 DOM harness。
// ============================================================

// 只支援本檔用得到的單段選擇器形狀：`tag`、`.class`、`#id`、`[attr]`、
// `[attr="value"]`、`[attr^="value"]` 與它們的組合（例如
// `div.tcl-scam-tag[role="note"]`）。以空白分隔的後代選擇器由
// querySelectorAll 逐段處理，不在本樣式內。
const SELECTOR_PATTERN =
  /^([a-zA-Z]*)((?:[.#][A-Za-z0-9_-]+)*)(?:\[([a-zA-Z-]+)(?:(\^?=)"([^"]*)")?\])?$/;

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
  return actual === value;
}

function text(value) {
  return { nodeType: 3, nodeName: '#text', textContent: value, childNodes: [] };
}

function el(tag, attributes, children) {
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
      while (cursor) {
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
    // 前序走訪後代（不含自己），與真實 querySelectorAll 的文件序一致；
    // 巢狀容器內的節點照樣列出——過濾是受測程式的責任，不是假件的。
    // 以空白分隔的後代選擇器（例如 `[role="button"] svg`）逐段收斂：每
    // 一段都從上一段的結果往下再走一次後代。
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
    removeChild(child) {
      const index = node.childNodes.indexOf(child);
      if (index !== -1) node.childNodes.splice(index, 1);
      if (child.nodeType === 1) {
        child.parentElement = null;
        child.parentNode = null;
      }
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
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
    // 注入端以 textContent 寫入文案（不得用 innerHTML），寫入等同清空子
    // 節點後掛上單一文字節點。
    set(value) {
      node.childNodes.length = 0;
      if (value !== null && value !== undefined && value !== '') {
        node.appendChild(text(String(value)));
      }
    },
  });
  // id／className／title 三個 IDL 屬性與對應的 HTML 屬性互為表裡：注入端
  // 用哪一種寫法都要能被 getAttribute 與選擇器看見。
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
  Object.defineProperty(node, 'nextSibling', {
    get() {
      const parent = node.parentElement;
      if (!parent) return null;
      return parent.childNodes[parent.childNodes.indexOf(node) + 1] || null;
    },
  });

  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

// 原生互動列：四顆按鈕包裝節點，每顆內含 `[role="button"] svg`，svg 同時
// 帶 aria-label 與 <title>（Threads 2026-09 起只剩 title，兩種讀法都要能
// 命中）。結構與標籤比照 post-icon 的 collectActionRowCandidates 與
// ACTION_ROW_LABEL_WHITELIST，注入端才找得到「互動列」這個錨點。
const ACTION_LABELS = ['讚', '回覆', '轉發', '分享'];

// counts：每顆按鈕旁的互動計數（實測為「92」「3,440」這類字串，同樣包在
// [dir="auto"] 裡）。不給就不產生計數節點，既有呼叫的結構不變。
function createActionRow(options) {
  const counts = (options && options.counts) || [];
  return el(
    'div',
    { 'data-tcl-fake-action-row': 'true' },
    ACTION_LABELS.map((label, index) => {
      const children = [
        el('div', { role: 'button' }, [
          el('svg', { 'aria-label': label }, [el('title', {}, [text(label)])]),
        ]),
      ];
      if (counts[index]) children.push(el('span', { dir: 'auto' }, [text(counts[index])]));
      return el('div', {}, children);
    })
  );
}

// 影片貼文多出來的播放器工具列：結構上同樣是「>=4 個子元素、每個都含
// [role="button"] svg」，但標籤全不在 ACTION_ROW_LABEL_WHITELIST 內。實測
// 它可能排在互動列之後，靠「取文件序最後一個候選」會挑錯列。
const PLAYER_LABELS = ['追蹤', '更多', '已靜音', '排序', '附加影音內容'];

function createPlayerRow() {
  return el(
    'div',
    { 'data-tcl-fake-player-row': 'true' },
    PLAYER_LABELS.map((label) =>
      el('div', {}, [
        el('div', { role: 'button' }, [
          el('svg', { 'aria-label': label }, [el('title', {}, [text(label)])]),
        ]),
      ])
    )
  );
}

// 一個貼文容器：作者連結（不帶 /post/）、permalink 連結（時間戳記）、
// 本文 span，可選的原生互動列，外加可選的巢狀子節點（引用貼文）。
//
// options.body 可為字串（單一 span）或字串陣列（多個各自獨立的葉
// [dir="auto"] span，對應實機把一篇貼文拆成多段的版面）。傳字串時的結構
// 與擴充前逐字相同。
// options.actionRowCounts：互動列各按鈕的計數字串。
// options.dirAutoTimestamp：時間戳記改用 [dir="auto"] span（實測版面），
//   而非 <time> 元素。
function createPostContainer(options) {
  const lines = Array.isArray(options.body) ? options.body : [options.body];
  const children = [
    el('a', { href: `/@${options.handle}` }, [
      el('span', { dir: 'auto' }, [text(options.handle)]),
    ]),
    el('a', { href: `/@${options.handle}/post/${options.code}` }, [
      options.dirAutoTimestamp
        ? el('span', { dir: 'auto' }, [text(options.timestamp || '2 小時')])
        : el('time', { datetime: '2026-09-19T10:00:00Z' }, [text('2 小時')]),
    ]),
    el(
      'div',
      {},
      lines.map((line) => el('span', { dir: 'auto' }, [text(line)]))
    ),
  ];
  if (options.actionRow) children.push(createActionRow({ counts: options.actionRowCounts }));
  (options.extraChildren || []).forEach((child) => children.push(child));
  return el('div', { 'data-pressable-container': 'true' }, children);
}

function withBadge(body, position, total) {
  return `${body}\n${position}\n/\n${total}`;
}

// 完整的詳情頁假 DOM：
//   - 六個作者自己的容器，第 1–5 篇尾端帶 `\nN\n/\n6` 徽章、第 6 篇無。
//   - 兩個他人回覆容器（不同 handle），穿插在中間。
//   - 一個巢狀容器（引用貼文，handle 同作者、code 不同）掛在第 3 篇容器
//     內——只有「排除子容器」這條規則能把它濾掉，handle 過濾濾不掉。
function createThreadDom() {
  const containers = [];
  POSTS.forEach((post, index) => {
    const isLast = index === POSTS.length - 1;
    const body = isLast
      ? post.captionText
      : withBadge(post.captionText, post.position, FIXTURE.selfThreadLength);
    const extraChildren = [];
    if (post.position === 3) {
      extraChildren.push(
        createPostContainer({
          handle: AUTHOR,
          code: 'DqUoTeDnEsT',
          body: '引用卡片內的巢狀貼文（同作者，不得重複計為一篇）',
        })
      );
    }
    containers.push(
      createPostContainer({ handle: AUTHOR, code: post.code, body, extraChildren })
    );
    if (index === 1) {
      containers.push(
        createPostContainer({
          handle: 'some.other_reader',
          code: 'DxReplY001A',
          body: '推推，恭喜脫離輪班人生，接下來就是自由的日子了！',
        })
      );
    }
    if (index === 3) {
      containers.push(
        createPostContainer({
          handle: 'another.person99',
          code: 'DxReplY002B',
          body: '同業路過，設備真的很硬，看完只有滿滿的既視感。',
        })
      );
    }
  });
  return el('div', { id: 'thread-root' }, containers);
}

// 仿 SSR：把 thread_items 埋在幾層隨意的包裝底下，驗證實作是遞迴 walk
// 而非綁固定路徑。
function buildSsrJson(post, options) {
  const settings = options || {};
  const item = {
    post: {
      pk: '3721104520121958207',
      code: post.code,
      taken_at: 1758278400,
      caption: { text: post.captionText },
      user: {
        id: post.userId,
        username: post.username,
        full_name: DISPLAY_NAME,
        is_verified: false,
      },
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
                          data: {
                            data: {
                              edges: [
                                {
                                  node: {
                                    thread_items: settings.emptyItems ? [] : [item],
                                  },
                                },
                              ],
                            },
                          },
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

// ---- extractSsrRoot ----

test('extractSsrRoot：從 SSR JSON 取出作者數字 id、帳號、顯示名、首篇內文、串長與位置', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');
  const first = POSTS[0];

  const root = extractSsrRoot([buildSsrJson(first)]);

  assert.ok(root, '應找到帶 thread_items 的節點');
  assert.equal(root.code, first.code);
  assert.equal(root.userId, first.userId, '比對主鍵是數字 user id，不是 handle');
  assert.equal(root.username, first.username);
  assert.equal(root.displayName, DISPLAY_NAME);
  assert.equal(root.captionText, first.captionText);
  assert.equal(root.selfThreadLength, 6);
  assert.equal(root.position, 1);
});

test('extractSsrRoot：thread_items 換一組完全不同的外層包裝也照樣找得到（不綁固定路徑）', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');
  const first = POSTS[0];
  const reshaped = JSON.stringify({
    some: {
      brand: {
        new: [
          null,
          {
            wrapper: {
              thread_items: [
                {
                  post: {
                    code: first.code,
                    caption: { text: first.captionText },
                    user: {
                      id: first.userId,
                      username: first.username,
                      full_name: DISPLAY_NAME,
                    },
                    text_post_app_info: {
                      self_thread_info: {
                        self_thread_length: first.selfThreadLength,
                        post_position_in_self_thread: first.position,
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  });

  const root = extractSsrRoot([reshaped]);

  assert.ok(root, '外層包裝換形狀不應影響取值');
  assert.equal(root.userId, first.userId);
  assert.equal(root.selfThreadLength, 6);
});

test('extractSsrRoot：髒 JSON 逐筆跳過不丟例外，仍取得後面那筆合法的', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');
  const first = POSTS[0];

  let root;
  assert.doesNotThrow(() => {
    root = extractSsrRoot([
      '{"broken":',
      'not json at all',
      '',
      '<!-- html 被塞進來了 -->',
      buildSsrJson(first),
    ]);
  }, '髒 JSON 不得讓整串取值崩掉');

  assert.ok(root);
  assert.equal(root.userId, first.userId);
});

test('extractSsrRoot：沒有任何節點帶 thread_items 時回傳 null', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');

  assert.equal(
    extractSsrRoot(['{"config":{"a":[1,2,3]}}', '{"thread_item":"不是陣列也不是複數"}']),
    null
  );
});

test('extractSsrRoot：thread_items 存在但為空陣列時回傳 null', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');

  assert.equal(extractSsrRoot([buildSsrJson(POSTS[0], { emptyItems: true })]), null);
});

test('extractSsrRoot：空陣列／非陣列輸入一律回傳 null，不丟例外', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');

  assert.equal(extractSsrRoot([]), null);
  assert.equal(extractSsrRoot(null), null);
  assert.equal(extractSsrRoot(undefined), null);
  assert.equal(extractSsrRoot('{"thread_items":[]}'), null, '字串不是字串陣列');
});

// ---- stripPositionBadge ----

test('stripPositionBadge：剝掉實測形狀的 `\\n3\\n/\\n6` 徽章，回傳位置與總數', () => {
  const stripPositionBadge = loadFn('stripPositionBadge');

  assert.deepEqual(stripPositionBadge('這是第三篇的本文\n3\n/\n6'), {
    text: '這是第三篇的本文',
    position: 3,
    total: 6,
  });
});

test('stripPositionBadge：徽章前後多餘空白一併吃掉', () => {
  const stripPositionBadge = loadFn('stripPositionBadge');

  assert.deepEqual(stripPositionBadge('本文\n\n  5\n/\n6  \n'), {
    text: '本文',
    position: 5,
    total: 6,
  });
});

test('stripPositionBadge：沒有徽章時文字原樣回傳，position／total 為 null', () => {
  const stripPositionBadge = loadFn('stripPositionBadge');
  const last = POSTS[5].captionText;

  assert.deepEqual(stripPositionBadge(last), { text: last, position: null, total: null });
});

test('stripPositionBadge：只有尾端「N/M」才算徽章，文中的數字與斜線不受影響', () => {
  const stripPositionBadge = loadFn('stripPositionBadge');

  assert.deepEqual(
    stripPositionBadge('一天睡 4/24 小時，撐了十四年'),
    { text: '一天睡 4/24 小時，撐了十四年', position: null, total: null },
    '斜線不在尾端就不是徽章'
  );
  assert.deepEqual(
    stripPositionBadge('那個月領了 15 萬'),
    { text: '那個月領了 15 萬', position: null, total: null },
    '尾端有數字但沒有斜線就不是徽章'
  );
});

test('stripPositionBadge：非字串輸入不丟例外，position／total 為 null', () => {
  const stripPositionBadge = loadFn('stripPositionBadge');

  [null, undefined, 42, {}].forEach((input) => {
    let result;
    assert.doesNotThrow(() => {
      result = stripPositionBadge(input);
    }, `輸入 ${String(input)} 不得丟例外`);
    assert.equal(result.position, null);
    assert.equal(result.total, null);
  });
});

// ---- extractThreadFromDom ----

test('extractThreadFromDom：取到作者自己的六篇，排除他人回覆與巢狀引用容器', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const root = createThreadDom();

  // 先確認假件本身確實鋪了該有的干擾項，免得測試因為假件少鋪而假綠燈。
  assert.equal(
    root.querySelectorAll(CONTAINER_SELECTOR).length,
    9,
    '假 DOM 應有 6 篇本人 + 2 篇他人 + 1 個巢狀容器'
  );

  const items = extractThreadFromDom(root, AUTHOR);

  assert.equal(items.length, 6, '只收作者本人、非巢狀的六個容器');
  assert.deepEqual(
    items.map((item) => item.code),
    POSTS.map((post) => post.code)
  );
  assert.ok(
    !items.some((item) => item.code === 'DqUoTeDnEsT'),
    '巢狀引用容器不得另外計為一篇'
  );
  assert.ok(
    !items.some((item) => /DxReplY/.test(item.code)),
    '他人回覆容器不得收進串文'
  );
});

test('extractThreadFromDom：每篇本文等於 fixture 原文，徽章已剝除', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');

  const items = extractThreadFromDom(createThreadDom(), AUTHOR);

  POSTS.forEach((post, index) => {
    assert.equal(
      items[index].text,
      post.captionText,
      `第 ${post.position} 篇本文應與 fixture 逐字相符（含徽章已剝除）`
    );
  });
});

test('extractThreadFromDom：position 依徽章解出，末篇無徽章時以收集順序補到 6', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');

  const items = extractThreadFromDom(createThreadDom(), AUTHOR);

  assert.deepEqual(
    items.map((item) => item.position),
    [1, 2, 3, 4, 5, 6]
  );
  assert.equal(items[5].position, 6, '末篇無徽章，以 DOM 收集順序補位');
});

test('extractThreadFromDom：結果依 position 升冪，不跟著 DOM 順序走', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  // DOM 順序刻意打亂成 2、3、1，徽章才是權威。本文一律寫得比作者 handle
  // 節點長，才不會被「取最長的 [dir="auto"]」這條規則誤選成 handle。
  const bodies = {
    1: '第一篇：我在台積電蹲了十四年的設備，上個月終於滾了。',
    2: '第二篇：這十四年怎麼過的？簡單講就是拿肝換錢。',
    3: '第三篇：不報明牌、不收費、不代操，就是分享。',
  };
  const root = el('div', {}, [
    createPostContainer({ handle: AUTHOR, code: 'DsHuFfLe002', body: withBadge(bodies[2], 2, 3) }),
    createPostContainer({ handle: AUTHOR, code: 'DsHuFfLe003', body: withBadge(bodies[3], 3, 3) }),
    createPostContainer({ handle: AUTHOR, code: 'DsHuFfLe001', body: withBadge(bodies[1], 1, 3) }),
  ]);

  const items = extractThreadFromDom(root, AUTHOR);

  assert.deepEqual(
    items.map((item) => item.position),
    [1, 2, 3]
  );
  assert.deepEqual(
    items.map((item) => item.text),
    [bodies[1], bodies[2], bodies[3]]
  );
  assert.deepEqual(
    items.map((item) => item.code),
    ['DsHuFfLe001', 'DsHuFfLe002', 'DsHuFfLe003']
  );
});

test('extractThreadFromDom：authorHandle 比對不分大小寫，帶不帶 @ 前綴都能對上', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');

  ['Example_Author', 'EXAMPLE_AUTHOR', `@${AUTHOR}`, `@Example_Author`].forEach((handle) => {
    assert.equal(
      extractThreadFromDom(createThreadDom(), handle).length,
      6,
      `authorHandle 傳 ${handle} 時仍應取到六篇`
    );
  });
});

test('extractThreadFromDom：handle 不符時回傳空陣列', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');

  assert.deepEqual(extractThreadFromDom(createThreadDom(), 'nobody.here'), []);
});

test('extractThreadFromDom：本文取容器內最長的 [dir="auto"]，短的作者名節點不會被誤選', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');

  const items = extractThreadFromDom(createThreadDom(), AUTHOR);

  assert.ok(
    !items.some((item) => item.text === AUTHOR),
    '作者 handle 的 span[dir="auto"] 不得被當成本文'
  );
});

test('extractThreadFromDom：root 缺失或沒有任何貼文容器時回傳空陣列，不丟例外', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');

  assert.deepEqual(extractThreadFromDom(el('div', {}, []), AUTHOR), []);
  assert.deepEqual(extractThreadFromDom(null, AUTHOR), []);
  assert.deepEqual(extractThreadFromDom(createThreadDom(), null), []);
});

// ---- buildThreadText ----

test('buildThreadText：以空行串接六篇，末篇的招攬原句完整保留（供後續正則掃描）', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const buildThreadText = loadFn('buildThreadText');

  const items = extractThreadFromDom(createThreadDom(), AUTHOR);
  const full = buildThreadText(items);

  assert.equal(full, POSTS.map((post) => post.captionText).join('\n\n'));
  assert.ok(
    full.includes(POSTS[5].captionText),
    '第六篇（招攬篇）全文必須原句落在串接結果裡'
  );
  assert.ok(
    full.includes('不報明牌、不收費、不代操'),
    '招攬話術原句必須可被後續判定掃到'
  );
  assert.ok(full.includes('黑馬股'), '話術關鍵詞必須可被後續判定掃到');
});

test('buildThreadText：空陣列／非陣列回傳空字串，不丟例外', () => {
  const buildThreadText = loadFn('buildThreadText');

  assert.equal(buildThreadText([]), '');
  assert.equal(buildThreadText(null), '');
  assert.equal(buildThreadText(undefined), '');
});

// ---- 模組載入守衛 ----

test('scam-guard.js：無 document 的環境載入時不丟例外，純函式仍掛在 TCLScamGuard 上', () => {
  assert.ok(fs.existsSync(SCAM_GUARD_PATH), 'scam-guard.js 尚未建立');
  const src = fs.readFileSync(SCAM_GUARD_PATH, 'utf8');
  const sandbox = {
    window: {},
    console: { warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    URL,
  };

  assert.doesNotThrow(() => {
    runInSandbox(src, sandbox);
  }, 'DOM 注入層必須包在 typeof document !== "undefined" 守衛內');

  const api = sandbox.window.TCLScamGuard;
  assert.ok(api, '無 module 環境應把 api 掛到 window.TCLScamGuard');
  ['extractSsrRoot', 'stripPositionBadge', 'extractThreadFromDom', 'buildThreadText'].forEach(
    (name) => {
      assert.equal(typeof api[name], 'function', `${name} 必須宣告在 DOM 守衛之外`);
    }
  );
});

// ============================================================
// 【審查建議補強】預篩、code 交叉驗證、href 容忍 query、徽章健全性、
// 巢狀 [dir="auto"] 取最內層。上方既有測試維持原樣，本段只新增。
// ============================================================

test('extractSsrRoot：不含 thread_items 字樣的 script 先被預篩掉，不影響後面那筆的取值', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');
  const first = POSTS[0];
  // 詳情頁實際有數十份 SSR script，絕大多數與串文無關；預篩只是省掉
  // parse，不得改變取值結果。
  const decoys = [
    '{"__bbox":{"require":[["CometPlatformRootClient","init",[],[]]]}}',
    JSON.stringify({ config: { padding: 'x'.repeat(2000) } }),
    '{"preloader":{"resources":[{"href":"/static/a.js"}]}}',
  ];

  const root = extractSsrRoot(decoys.concat([buildSsrJson(first)]));

  assert.ok(root, '預篩不得把合法的那筆一起濾掉');
  assert.equal(root.code, first.code);
  assert.equal(root.userId, first.userId);
  assert.equal(root.selfThreadLength, 6);
});

test('extractSsrRoot：給 expectedCode 時只收 post.code 相符的節點，不符回傳 null', () => {
  const extractSsrRoot = loadFn('extractSsrRoot');

  assert.equal(
    extractSsrRoot([buildSsrJson(POSTS[0])], POSTS[1].code),
    null,
    'code 不符的串（例如 SSR 一併帶進來的推薦貼文）不得被當成本頁主串'
  );
  assert.equal(
    extractSsrRoot([buildSsrJson(POSTS[0])], POSTS[0].code).code,
    POSTS[0].code,
    'code 相符時照常取值'
  );
  assert.equal(
    extractSsrRoot([buildSsrJson(POSTS[0]), buildSsrJson(POSTS[2])], POSTS[2].code).code,
    POSTS[2].code,
    '第一筆不符時要繼續往後找'
  );
});

test('extractThreadFromDom：permalink 帶 ?xmt= 追蹤參數時照樣收，code 不含 query', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const body = '第一篇：我在台積電蹲了十四年的設備，上個月終於滾了。';
  const root = el('div', {}, [
    createPostContainer({
      handle: AUTHOR,
      code: 'DsQuErY001?xmt=AQGzabcdef',
      body: withBadge(body, 1, 2),
    }),
    createPostContainer({
      handle: AUTHOR,
      code: 'DsQuErY002#focus',
      body: withBadge('第二篇：這十四年怎麼過的？簡單講就是拿肝換錢。', 2, 2),
    }),
  ]);

  const items = extractThreadFromDom(root, AUTHOR);

  assert.deepEqual(
    items.map((item) => item.code),
    ['DsQuErY001', 'DsQuErY002'],
    'query／hash 不得被算進 post code'
  );
  assert.equal(items[0].text, body);
});

test('extractThreadFromDom：句尾日期與離譜總數不得被當成徽章，本文原樣保留', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const dated = '第六篇：想跟我一起學的可以來社群，活動到 2026/9/19';
  const ratio = '第一篇：那一年我的勝率大概是 30/100';
  const root = el('div', {}, [
    createPostContainer({ handle: AUTHOR, code: 'DsSaNiTy001', body: ratio }),
    createPostContainer({ handle: AUTHOR, code: 'DsSaNiTy002', body: dated }),
  ]);

  // total=100 超出合理串長上限，不必靠 expectedTotal 就該被擋下。
  const loose = extractThreadFromDom(root, AUTHOR);
  assert.equal(loose[0].text, ratio, '總數離譜的「N/M」不是徽章，本文不得被剝');

  // 句尾日期 9/19 落在合理範圍內，要靠 expectedTotal 才擋得住。
  const strict = extractThreadFromDom(root, AUTHOR, 2);
  assert.deepEqual(
    strict.map((item) => item.text),
    [ratio, dated],
    '總數與 SSR 串長不符時視為無徽章，本文原樣保留'
  );
  assert.deepEqual(
    strict.map((item) => item.position),
    [1, 2],
    '徽章不可信時以收集順序補位'
  );
});

test('extractThreadFromDom：[dir="auto"] 互相巢狀時取最內層，外層包裝節點不得被選', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const body = '第一篇：我在台積電蹲了十四年的設備，上個月終於滾了，這串講完整個過程。';
  // 外層 [dir="auto"] 的 textContent 是「作者名 + 本文」，恆為最長，只靠
  // 長度會選到它。
  const root = el('div', {}, [
    el('div', { 'data-pressable-container': 'true' }, [
      el('a', { href: `/@${AUTHOR}/post/DsNeStEd001` }, [
        el('time', { datetime: '2026-09-19T10:00:00Z' }, [text('2 小時')]),
      ]),
      el('div', { dir: 'auto' }, [
        el('span', { dir: 'auto' }, [text(AUTHOR)]),
        el('span', { dir: 'auto' }, [text(body)]),
      ]),
    ]),
  ]);

  const items = extractThreadFromDom(root, AUTHOR);

  assert.equal(items.length, 1);
  assert.equal(items[0].text, body, '本文應取最內層的 span，不含作者名');
});

// ============================================================
// 【第二波：守衛內的瀏覽器整合層】詳情頁掃描時機、命中後掛 tag、送
// `scam.hit`、toast、樣式注入。上方既有測試維持原樣，本段只新增。
//
// 受測對象是 scam-guard.js 的 `if (typeof document !== 'undefined')` 守衛
// 內那段——Node 直接 require() 永遠進不去，因此改用 vm sandbox：先把真的
// i18n.js 與 tcl-core.js 載進同一個 sandbox（讓 window.TCLI18N /
// window.TCLCore 就位），再載 scam-guard.js。sandbox 的 `window` 就是
// sandbox 自己，比照瀏覽器的 window === globalThis，不論實作是讀
// `root.TCLCore` 還是裸的 `TCLCore` 都拿得到。
//
// 【與實作的契約】
//   路由：只有 location.pathname 為 `/@handle/post/CODE`（容忍尾隨斜線與
//     query/hash）才掃描；河道與其他路徑一律不掃、不送訊息。
//   總開關：chrome.storage.local.scamGuardEnabled === false 不掃；缺席視
//     為 true；onChanged 切回 true 後下一次觸發要掃得到。
//   冪等：MutationObserver 重複觸發時，同一頁同一組容器只掃一次、只掛一
//     顆 tag、只送一則 scam.hit。
//   取值順序：script[type="application/json"] → extractSsrRoot(texts,
//     網址列 code) → extractThreadFromDom(document, ssrRoot.username,
//     ssrRoot.selfThreadLength) → buildThreadText → TCLCore.detectScamPitch。
//   tag：主文卡（position 1 的容器）互動列「上方」插一顆 `.tcl-scam-tag`，
//     role="note"、文字 scamTagLabel、title scamTagTooltip，一律用
//     textContent 寫入（不得 innerHTML）。
//   訊息：`scam.hit` 的 payload 形狀見 §14；postUrl 為
//     location.origin + pathname 正規化後的乾淨網址（去 query/hash）。
//   toast：回應 added:true 且本次 session 首見 → showToast(scamFirstHitToast)；
//     added:false／allowlisted／disabled／失敗都不 toast，allowlisted 另外
//     不掛 tag。
//
// 【toast 的管道】PM 裁決：post-icon.js 的 api 匯出 showToast，scam-guard
// 複用，不自繪。sandbox 因此注入一顆會記錄呼叫的 window.TCLPostIcon.showToast
// 當主要觀測點；toastTexts() 另外也看 DOM 上的 #tcl-toast 節點文字，讓
// 「有沒有 toast」不因實作把文字畫在哪裡而漏判。兩條都空才算沒有 toast。
//
// 【TCLCore 的可得性】PM 裁決：tcl-core.js 一併登記進 manifest 的 ISOLATED
// content_scripts 陣列（順序見 test/package.test.js 的順序測試），真實頁面
// 上 TCLCore 才在場。本段在 sandbox 內先載入真的 tcl-core.js，對齊這個前提。
// ============================================================

const I18N_SRC = fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8');
const CORE_PATH = path.join(__dirname, '..', 'tcl-core.js');
const CORE_SRC = fs.readFileSync(CORE_PATH, 'utf8');
const TCLCore = require(CORE_PATH);
const I18N = require(path.join(__dirname, '..', 'i18n.js'));
const POST_ICON_API = require(path.join(__dirname, '..', 'post-icon.js'));

const ORIGIN = 'https://www.threads.com';
const DETAIL_PATH = `/@${AUTHOR}/post/${POSTS[0].code}`;
const CLEAN_POST_URL = ORIGIN + DETAIL_PATH;
const TAG_CLASS = 'tcl-scam-tag';
const STYLE_ID = 'tcl-scam-guard-style';
const TAG_LABEL = I18N.t('zh', 'scamTagLabel');
const TAG_TOOLTIP = I18N.t('zh', 'scamTagTooltip');
const FIRST_HIT_TOAST = I18N.t('zh', 'scamFirstHitToast');

// fixture 的招攬篇只留了話術詞、沒留 LINE 錨點（detectScamPitch 對原始
// fixture 全文回 hit:false）。掃描流程要走到「命中」這條路，末篇必須帶錨
// 點——這裡補上一行合成的招攬句。
const SCAM_TAIL = '\n有興趣的加我 賴：ex01abc，我再把整理好的筆記傳給你。';

const MAIN_POSTS = POSTS.map((post, index) =>
  index === POSTS.length - 1
    ? Object.assign({}, post, { captionText: post.captionText + SCAM_TAIL })
    : Object.assign({}, post)
);

// 注入端該交給 detectScamPitch 的全文：buildThreadText 以空行串接六篇。
const EXPECTED_THREAD_TEXT = MAIN_POSTS.map((post) => post.captionText).join('\n\n');
const EXPECTED_DETECTION = TCLCore.detectScamPitch(EXPECTED_THREAD_TEXT);

// 第二串（同作者、不同貼文），用來測「同 session 第二次命中不再 toast」。
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

// ---- 假 document ----

// 整棵頁面樹：html > head + body，body 掛 SSR script 與貼文容器。
function createFakeDocument(bodyChildren) {
  const head = el('head', {}, []);
  const body = el('body', {}, bodyChildren || []);
  const html = el('html', {}, [head, body]);
  return {
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
    addEventListener() {},
    removeEventListener() {},
  };
}

function createSsrScript(post) {
  return el('script', { type: 'application/json' }, [text(buildSsrJson(post))]);
}

// 詳情頁的貼文容器樹：作者本人 N 篇（第 1..N-1 篇帶徽章、末篇無），外加
// 一篇他人回覆當干擾項。每個容器都有原生互動列。
function createScanDom(posts) {
  const total = posts.length;
  const containers = posts.map((post, index) =>
    createPostContainer({
      handle: AUTHOR,
      code: post.code,
      body:
        index === total - 1
          ? post.captionText
          : withBadge(post.captionText, post.position, total),
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
  return el('div', { id: 'thread-root' }, containers);
}

// 一頁的 body 子節點：SSR script（可關閉）＋貼文容器樹。
function createPage(options) {
  const settings = options || {};
  const posts = settings.posts || MAIN_POSTS;
  const children = [];
  if (!settings.withoutSsr) children.push(createSsrScript(posts[0]));
  children.push(createScanDom(posts));
  return children;
}

// ---- sandbox ----

// options:
//   pathname     網址列路徑，預設詳情頁
//   local        chrome.storage.local 的初值
//   page         body 子節點（預設 createPage()）
//   respond      (msg, index) => 回應物件；丟出 Error 代表 sendMessage 失敗
//   detect       覆寫 TCLCore.detectScamPitch 的回傳（不給則走真實實作）
function createScamGuardEnv(options) {
  const settings = options || {};
  const pathname = settings.pathname === undefined ? DETAIL_PATH : settings.pathname;
  const location = {
    origin: ORIGIN,
    pathname,
    search: '',
    hash: '',
    href: ORIGIN + pathname,
  };
  const doc = createFakeDocument(settings.page || createPage());
  const storage = createChromeStorage({ langPref: 'zh' }, settings.local || {});

  const sent = [];
  const toasts = [];
  const observers = [];
  const detectCalls = [];
  const warnings = [];

  function replyFor(msg, index) {
    if (typeof settings.respond === 'function') return settings.respond(msg, index);
    return { ok: true, added: true, entry: { handle: AUTHOR } };
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }

  const sandbox = {
    location,
    navigator: { language: 'zh-TW' },
    document: doc,
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    Date,
    console: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: (...args) => warnings.push(args.map(String).join(' ')),
      log: () => {},
    },
    chrome: {
      runtime: {
        id: 'nbjjhmlhnadnjfoheeimcmlkfhgaggeb',
        lastError: undefined,
        // 兩種呼叫慣例都要撐住：帶 callback（回 undefined）與不帶
        // callback（回 Promise）。回應一律延遲一個 tick 結算，避免同
        // tick 假綠燈。
        sendMessage(message, callback) {
          const index = sent.length;
          sent.push(message);
          let reply;
          let failure = null;
          try {
            reply = replyFor(message, index);
          } catch (e) {
            failure = e;
          }
          if (typeof callback === 'function') {
            setTimeout(() => callback(failure ? undefined : reply), 0);
            return undefined;
          }
          return new Promise((resolve, reject) => {
            setTimeout(() => (failure ? reject(failure) : resolve(reply)), 0);
          });
        },
      },
      storage: storage.api,
      i18n: { getUILanguage: () => 'zh-TW' },
    },
  };
  // 瀏覽器裡 window === globalThis；sandbox 也照這個關係接起來，實作讀
  // `root.TCLCore` 或裸的 `TCLCore` 都拿得到同一份。
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  runInSandbox(I18N_SRC, sandbox);
  runInSandbox(CORE_SRC, sandbox);

  // 記錄判定的輸入（驗「掃了什麼文字」與「掃了幾次」），必要時覆寫回
  // 傳。包裝必須發生在載入 scam-guard.js 之前。
  const realDetect = sandbox.TCLCore.detectScamPitch;
  sandbox.TCLCore.detectScamPitch = function (input) {
    detectCalls.push(input);
    return typeof settings.detect === 'function' ? settings.detect(input) : realDetect(input);
  };

  // window.TCLPostIcon：post-icon.js 在 Node 環境匯出的純函式（
  // readActionLabel／pickActionRowIndex／classifyExcerptCandidate 等，實作
  // 要複用的就是這幾支），外加一顆會記錄呼叫的 showToast 當 toast 的觀測
  // 點。這裡不整支跑 post-icon 的 DOM 注入層——它會往假 DOM 塞複製 icon、
  // 另起一個 MutationObserver，對本段要驗的行為只是雜訊。
  sandbox.TCLPostIcon = Object.assign({}, POST_ICON_API, {
    showToast(value) {
      toasts.push(String(value));
    },
  });

  const env = {
    sandbox,
    document: doc,
    location,
    storage,
    sent,
    toasts,
    observers,
    detectCalls,
    warnings,
    load() {
      runInSandbox(fs.readFileSync(SCAM_GUARD_PATH, 'utf8'), sandbox);
      return env;
    },
    hits() {
      return sent.filter((msg) => msg && msg.type === 'scam.hit');
    },
    tags() {
      return doc.querySelectorAll('.' + TAG_CLASS);
    },
    toastTexts() {
      const out = toasts.slice();
      const node = doc.getElementById('tcl-toast');
      if (node && node.textContent) out.push(node.textContent);
      return out;
    },
    // 清掉兩條 toast 管道，讓「下一次有沒有再 toast」可以獨立觀測。
    clearToasts() {
      toasts.length = 0;
      const node = doc.getElementById('tcl-toast');
      if (node && node.parentNode) node.parentNode.removeChild(node);
    },
    setPathname(next) {
      location.pathname = next;
      location.href = ORIGIN + next;
    },
    setPage(children) {
      doc.body.childNodes.length = 0;
      children.forEach((child) => doc.body.appendChild(child));
    },
    triggerObserver() {
      observers
        .filter((observer) => !observer.disconnected)
        .forEach((observer) => observer.callback([], observer));
    },
    // 實作可能用 debounce（post-icon 是 60ms）＋ storage 的非同步回呼，
    // 單一 tick 不夠；統一給一段寬裕的時間讓整條鏈結算完。
    flush() {
      return new Promise((resolve) => setTimeout(resolve, 200));
    },
  };
  return env;
}

// 先確認 scam-guard.js 在假 DOM 環境載入不會崩，紅燈才落在行為斷言上。
function loadEnv(options) {
  const env = createScamGuardEnv(options);
  assert.doesNotThrow(() => env.load(), 'scam-guard.js 在假 DOM 環境載入不得丟例外');
  return env;
}

// 文件序：用來驗「tag 插在互動列上方」。
function documentOrder(root) {
  const out = [];
  (function walk(node) {
    node.childNodes.forEach((child) => {
      if (child.nodeType !== 1) return;
      out.push(child);
      walk(child);
    });
  })(root);
  return out;
}

// ---- 1. 路由判定 ----

test('路由：河道等非詳情頁一律不掃描、不送 scam.hit、不掛 tag', async () => {
  const env = loadEnv({ pathname: '/' });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.deepEqual(env.detectCalls, [], '非詳情頁不得跑判定');
  assert.deepEqual(env.hits(), [], '非詳情頁不得送 scam.hit');
  assert.equal(env.tags().length, 0, '非詳情頁不得掛 tag');
});

test('路由：個人頁這類帶 handle 但不帶 /post/ 的路徑也不掃描', async () => {
  const env = loadEnv({ pathname: `/@${AUTHOR}` });
  await env.flush();

  assert.deepEqual(env.detectCalls, [], '個人頁不是詳情頁，不得跑判定');
  assert.deepEqual(env.hits(), []);
});

test('路由：詳情頁載入後掃描一次，命中即送 scam.hit', async () => {
  const env = loadEnv();
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '詳情頁應掃描一次');
  assert.equal(env.hits().length, 1, '命中應送出一則 scam.hit');
});

test('路由：網址帶 ?xmt= 追蹤參數時照樣認得是詳情頁', async () => {
  const env = loadEnv({ pathname: `${DETAIL_PATH}?xmt=AQGzabcdef` });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, 'query 不得讓詳情頁被判成河道');
});

test('冪等：MutationObserver 重複觸發，同一組容器只掃一次、只送一則、只掛一顆 tag', async () => {
  const env = loadEnv();
  await env.flush();

  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '容器數沒變就不該重掃');
  assert.equal(env.hits().length, 1, 'scam.hit 不得重複送');
  assert.equal(env.tags().length, 1, 'tag 不得重複插');
});

test('冪等：容器數變動（SPA 換頁）時會重掃並對新頁另送一則 scam.hit', async () => {
  const env = loadEnv();
  await env.flush();
  assert.equal(env.hits().length, 1);

  env.setPathname(SECOND_PATH);
  env.setPage(createPage({ posts: SECOND_POSTS }));
  env.triggerObserver();
  await env.flush();

  assert.equal(env.detectCalls.length, 2, '換一串貼文要重掃');
  assert.equal(env.hits().length, 2, '新的一串命中要另外送一則');
});

// ---- 2. 總開關 ----

test('總開關：scamGuardEnabled 為 false 時不掃描、不送訊息、不掛 tag', async () => {
  const env = loadEnv({ local: { scamGuardEnabled: false } });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.deepEqual(env.detectCalls, [], '開關關閉不得跑判定');
  assert.deepEqual(env.hits(), []);
  assert.equal(env.tags().length, 0);
});

test('總開關：storage.local 沒有 scamGuardEnabled 這顆鍵時視為開啟', async () => {
  const env = loadEnv({ local: {} });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '缺席＝預設開，應照樣掃描');
  assert.equal(env.hits().length, 1);
});

test('總開關：onChanged 切回 true 後，下一次觸發就掃得到', async () => {
  const env = loadEnv({ local: { scamGuardEnabled: false } });
  await env.flush();
  assert.deepEqual(env.detectCalls, [], '起始狀態是關閉');

  env.storage.emitChange({ scamGuardEnabled: { oldValue: false, newValue: true } }, 'local');
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '開關切回 true 後應恢復掃描');
  assert.equal(env.hits().length, 1);
  assert.equal(env.tags().length, 1);
});

// ---- 3. 掃描流程 ----

test('掃描流程：交給 detectScamPitch 的是 buildThreadText 串好的六篇全文', async () => {
  const env = loadEnv();
  await env.flush();

  assert.equal(env.detectCalls.length, 1);
  assert.equal(
    env.detectCalls[0],
    EXPECTED_THREAD_TEXT,
    'SSR 取 username/串長、DOM 取六篇文字、buildThreadText 以空行串接'
  );
});

test('掃描流程：命中後在主文卡互動列「上方」插一顆 .tcl-scam-tag', async () => {
  const env = loadEnv();
  await env.flush();

  const tags = env.tags();
  assert.equal(tags.length, 1, '整頁只掛一顆 tag');

  const tag = tags[0];
  const containers = env.document.querySelectorAll(CONTAINER_SELECTOR);
  const mainCard = containers[0];
  assert.equal(
    tag.closest(CONTAINER_SELECTOR),
    mainCard,
    'tag 應掛在 position 1 的主文卡內，不是自回覆的第二篇'
  );

  const row = mainCard.querySelectorAll('div[data-tcl-fake-action-row]')[0];
  assert.ok(row, '假 DOM 的主文卡應有互動列');
  assert.notEqual(
    tag.closest('div[data-tcl-fake-action-row]'),
    row,
    'tag 不得塞進互動列內部'
  );

  const order = documentOrder(mainCard);
  assert.ok(
    order.indexOf(tag) !== -1 && order.indexOf(tag) < order.indexOf(row),
    'tag 的文件序必須早於互動列（插在互動列上方）'
  );
});

test('掃描流程：tag 的無障礙語意與文案走 i18n，且以 textContent 寫入', async () => {
  const env = loadEnv();
  await env.flush();

  const tag = env.tags()[0];
  assert.ok(tag, '命中應掛上 tag');
  assert.equal(tag.getAttribute('role'), 'note', 'tag 應為 role="note"');
  assert.equal(tag.textContent, TAG_LABEL, 'tag 文字應為 i18n 的 scamTagLabel');
  assert.equal(tag.getAttribute('title'), TAG_TOOLTIP, 'title 應為 i18n 的 scamTagTooltip');
  assert.equal(
    tag.querySelectorAll('*').length,
    0,
    '文案以 textContent 寫入（不得用 innerHTML 組 HTML 片段）'
  );
});

test('掃描流程：未命中時不掛 tag、不送訊息', async () => {
  const env = loadEnv({
    detect: () => ({ hit: false, anchorMatch: '', pitchMatches: ['黑馬股'], snippet: '' }),
  });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '詳情頁照樣掃描');
  assert.equal(env.tags().length, 0, '沒命中不得掛 tag');
  assert.deepEqual(env.hits(), [], '沒命中不得送 scam.hit');
});

// ---- 4. scam.hit 與 toast ----

test('scam.hit：payload 形狀照 §14，postUrl 為 origin + pathname 正規化後的乾淨網址', async () => {
  const startedAt = Date.now();
  const env = loadEnv({ pathname: `${DETAIL_PATH}?xmt=AQGzabcdef` });
  await env.flush();

  const hits = env.hits();
  assert.equal(hits.length, 1);
  const payload = hits[0];

  assert.equal(payload.type, 'scam.hit');
  assert.equal(payload.userId, POSTS[0].userId, 'userId 取自 SSR 的 post.user.id');
  assert.equal(payload.handle, AUTHOR, 'handle 為不帶 @ 的原樣帳號');
  assert.equal(payload.displayName, DISPLAY_NAME, 'displayName 取自 SSR 的 full_name');
  assert.equal(payload.postUrl, CLEAN_POST_URL, 'postUrl 不得帶 query/hash');
  assert.equal(
    payload.snippet,
    EXPECTED_DETECTION.snippet,
    'snippet 原樣帶 detectScamPitch 的結果'
  );
  assert.ok(
    payload.snippet.length <= TCLCore.SCAM_LIMITS.SNIPPET_MAX,
    'snippet 不得超過 120 字'
  );
  assert.equal(payload.anchorMatch, EXPECTED_DETECTION.anchorMatch);
  // 陣列先 Array.from 搬回本 realm 再比對：payload 的陣列建在 vm sandbox
  // 內，與本檔字面量的 Array.prototype 不同源，deepEqual 的 prototype 檢查
  // 會判「結構相同但非同一 realm」而誤判失敗（同 background.test.js 的既有
  // 註記）。值與順序照樣逐一比對。
  assert.deepEqual(Array.from(payload.pitchMatches), EXPECTED_DETECTION.pitchMatches);
  assert.equal(typeof payload.at, 'number', 'at 應為毫秒時間戳');
  assert.ok(
    payload.at >= startedAt - 1000 && payload.at <= Date.now() + 1000,
    'at 應是本次命中的時間'
  );
});

test('toast：回應 added:true 時顯示 scamFirstHitToast', async () => {
  const env = loadEnv();
  await env.flush();

  assert.deepEqual(env.toastTexts(), [FIRST_HIT_TOAST], '首次入名單應跳一次 toast');
});

test('toast：同一 session 第二次 added:true 不再 toast，但 tag 照掛', async () => {
  const env = loadEnv();
  await env.flush();
  assert.deepEqual(env.toastTexts(), [FIRST_HIT_TOAST], '第一次要 toast');

  env.clearToasts();
  env.setPathname(SECOND_PATH);
  env.setPage(createPage({ posts: SECOND_POSTS }));
  env.triggerObserver();
  await env.flush();

  assert.equal(env.hits().length, 2, '第二串照樣送 scam.hit');
  assert.deepEqual(env.toastTexts(), [], '同一 session 第二次不得再 toast');
  assert.equal(env.tags().length, 1, '第二頁的主文卡照樣掛 tag');
});

test('toast：added:false（既有作者只補證據）不 toast，tag 仍在', async () => {
  const env = loadEnv({
    respond: () => ({ ok: true, added: false, entry: { handle: AUTHOR } }),
  });
  await env.flush();

  assert.deepEqual(env.toastTexts(), [], 'added:false 不得 toast');
  assert.equal(env.tags().length, 1, '已在名單內的作者照樣要看到警示');
});

test('scam.hit：allowlisted 時不掛 tag、不 toast（使用者已解除封鎖）', async () => {
  const env = loadEnv({
    respond: () => ({ ok: true, added: false, allowlisted: true }),
  });
  await env.flush();

  assert.equal(env.hits().length, 1, '仍要問過 background 才知道在不在白名單');
  assert.deepEqual(env.toastTexts(), []);
  assert.equal(env.tags().length, 0, '白名單作者不得掛 tag');
});

test('scam.hit：回應 disabled 時不 toast，tag 仍在', async () => {
  const env = loadEnv({ respond: () => ({ ok: false, code: 'disabled' }) });
  await env.flush();

  assert.deepEqual(env.toastTexts(), []);
  assert.equal(env.tags().length, 1, '寫入被拒不影響頁面上的警示');
});

test('scam.hit：sendMessage 失敗時不 toast、不丟例外，tag 仍在', async () => {
  const env = loadEnv({
    respond: () => {
      throw new Error('Extension context invalidated');
    },
  });
  await env.flush();

  assert.deepEqual(env.toastTexts(), [], '送訊息失敗不得 toast');
  assert.equal(env.tags().length, 1, '送訊息失敗不影響頁面上的警示');
});

// ---- 5. SSR 缺 id ----

test('SSR 缺席：仍以 pathname 的 handle 掃 DOM，scam.hit 帶 userId:null', async () => {
  const env = loadEnv({ page: createPage({ withoutSsr: true }) });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '沒有 SSR 也要掃得動');
  assert.equal(
    env.detectCalls[0],
    EXPECTED_THREAD_TEXT,
    '作者 handle 改從 pathname 取，六篇全文照樣串得起來'
  );

  const hits = env.hits();
  assert.equal(hits.length, 1);
  assert.equal(
    hits[0].userId,
    null,
    'SSR 取不到 id 時 userId 為 null，交給 background 走匿名備援'
  );
  assert.equal(hits[0].handle, AUTHOR);
  assert.equal(hits[0].postUrl, CLEAN_POST_URL);
  assert.equal(env.tags().length, 1, 'userId 缺席不影響頁面上的警示');
});

// ---- 7. 樣式 ----

test('樣式：注入一次 <style id="tcl-scam-guard-style">，內含 .tcl-scam-tag 規則', async () => {
  const env = loadEnv();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  const styles = env.document
    .querySelectorAll('style')
    .filter((node) => node.getAttribute('id') === STYLE_ID);
  assert.equal(styles.length, 1, '樣式節點只能有一個，重複掃描不得重複注入');
  assert.ok(
    styles[0].textContent.indexOf('.' + TAG_CLASS) !== -1,
    '樣式應含 .tcl-scam-tag 規則'
  );
});

// ============================================================
// 【第三波：審查 FAIL 回歸】多行 span 本文、冪等快取的重讀、互動列消歧、
// SSR 交叉校驗、tag 補回。上方既有測試維持原樣，本段只新增。
// ============================================================

// ---- F1 多行本文 ----
//
// 實機的一篇貼文常被拆成多個各自獨立的葉 [dir="auto"] span（段落、短句、
// 結尾的一行招攬），「取最長的那一個」只會拿到最長的段落，招攬那一行
// （「有興趣的加我 賴：ex01abc」）反而是最短的，錨點因此整個掉了——串文判
// 定的門檻是「錨點 + 強詞」，少了錨點必定漏判。
//
// 同一個容器內還有兩類 [dir="auto"] 不是本文，必須排除：
//   - 作者名與時間戳記：包在 <a> 裡（作者頁連結、permalink）。
//   - 互動列計數（「92」「3,440」）：post-icon 的 classifyExcerptCandidate
//     已經有這條判準（COUNT_LIKE_RE → 'stop'），實作可直接複用。
const F1_LINES = [
  '在台積電蹲了十四年的設備，離職之後才發現，真正難的不是技術，而是每天被排班表切碎的生活。',
  '不報明牌、不收費、不代操，就是一個從無塵室走出來的設備工程師，跟你分享怎麼找波段黑馬股。',
  '有興趣的加我 賴：ex01abc',
];
const F1_TEXT = F1_LINES.join('\n');
const F1_COUNTS = ['92', '3,440', '12', '48'];

// 多行版的完整串文：前五篇照 fixture 原樣，末篇（招攬篇）拆成三段。
const MULTILINE_POSTS = POSTS.slice(0, 5)
  .map((post) => Object.assign({}, post))
  .concat([Object.assign({}, POSTS[5], { captionText: F1_TEXT, lines: F1_LINES })]);
const MULTILINE_THREAD_TEXT = MULTILINE_POSTS.map((post) => post.captionText).join('\n\n');

// 依 posts 建一串貼文容器：第 1..N-1 篇帶徽章、末篇無；每篇都有互動列與
// 互動計數。decorate(index) 可為指定的第幾篇追加容器設定。
function buildThreadContainers(posts, decorate) {
  const total = posts.length;
  return posts.map((post, index) => {
    const isLast = index === total - 1;
    const body = post.lines
      ? post.lines
      : isLast
        ? post.captionText
        : withBadge(post.captionText, post.position, total);
    return createPostContainer(
      Object.assign(
        {
          handle: AUTHOR,
          code: post.code,
          body,
          actionRow: true,
          actionRowCounts: F1_COUNTS,
          dirAutoTimestamp: true,
        },
        (decorate && decorate(index, post)) || {}
      )
    );
  });
}

// 一頁：SSR script ＋ 由 posts 建出的容器樹。decorate 讓個別測試只動自己
// 關心的那一篇。
function createDecoratedPage(posts, decorate) {
  return [
    createSsrScript(posts[0]),
    el('div', { id: 'thread-root' }, buildThreadContainers(posts, decorate)),
  ];
}

function createMultilinePage(decorate) {
  return createDecoratedPage(MULTILINE_POSTS, decorate);
}

test('F1：容器本文由多個獨立 [dir="auto"] span 組成時，以 \\n 串接全部段落', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const root = el('div', {}, [
    createPostContainer({
      handle: AUTHOR,
      code: 'DsMuLtI0001',
      body: F1_LINES,
      actionRow: true,
      actionRowCounts: F1_COUNTS,
      dirAutoTimestamp: true,
    }),
  ]);

  const items = extractThreadFromDom(root, AUTHOR);

  assert.equal(items.length, 1);
  assert.equal(
    items[0].text,
    F1_TEXT,
    '三段本文都要收，取最長的那一段會把招攬的短行丟掉'
  );
  assert.ok(items[0].text.includes('賴：ex01abc'), '錨點所在的短行必須留在本文裡');
});

test('F1：作者名、時間戳記與互動列計數都不得混進本文', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const root = el('div', {}, [
    createPostContainer({
      handle: AUTHOR,
      code: 'DsMuLtI0002',
      body: F1_LINES,
      actionRow: true,
      actionRowCounts: F1_COUNTS,
      dirAutoTimestamp: true,
      timestamp: '3 小時',
    }),
  ]);

  const body = extractThreadFromDom(root, AUTHOR)[0].text;

  assert.ok(!body.includes(AUTHOR), '作者名的 [dir="auto"] 包在 <a> 內，不是本文');
  assert.ok(!body.includes('3 小時'), '時間戳記的 [dir="auto"] 包在 <a> 內，不是本文');
  F1_COUNTS.forEach((count) => {
    assert.ok(!body.includes(count), `互動列計數「${count}」不是本文`);
  });
});

test('F1 端到端：多行本文的詳情頁照樣掃到錨點，命中、送 scam.hit、掛 tag', async () => {
  const env = loadEnv({ page: createMultilinePage() });
  await env.flush();

  assert.equal(env.detectCalls.length, 1);
  assert.equal(
    env.detectCalls[0],
    MULTILINE_THREAD_TEXT,
    '六篇（末篇三段）串起來的全文'
  );
  assert.ok(env.detectCalls[0].includes('賴：ex01abc'), '錨點必須進得了判定的輸入');
  assert.equal(env.hits().length, 1, '多行本文照樣要命中並通報');
  assert.equal(env.tags().length, 1, '多行本文照樣要掛警示');
});

// ---- S1 效能：同鍵重複觸發不重讀 SSR script ----
//
// 詳情頁有數十份 SSR script，其中不乏數百 KB 的大塊 JSON。MutationObserver
// 在 Threads 上每秒可觸發數十次，每次都把所有 script 的 textContent 收成字
// 串陣列（等於整包複製一次）是主執行緒上付不起的成本。冪等判斷必須發生在
// 讀 script 之前，或把上一輪的結果快取起來。

// 會計數 textContent 讀取次數的 SSR script 節點。el() 的 textContent 是不可
// 重新定義的存取器，因此這裡自帶一份最小節點，只實作 querySelectorAll 走訪
// 與選擇器比對需要的介面。
function createCountingSsrScript(post) {
  const json = buildSsrJson(post);
  const counter = { reads: 0 };
  const node = {
    nodeType: 1,
    nodeName: 'SCRIPT',
    tagName: 'SCRIPT',
    attributes: { type: 'application/json' },
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
      while (cursor) {
        if (cursor.matches && cursor.matches(selector)) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    appendChild(child) {
      node.childNodes.push(child);
      return child;
    },
  };
  Object.defineProperty(node, 'textContent', {
    get() {
      counter.reads += 1;
      return json;
    },
  });
  Object.defineProperty(node, 'children', {
    get() {
      return [];
    },
  });
  return { node, counter };
}

test('S1：同一頁同一組容器重複觸發時，不再重讀 SSR script', async () => {
  const script = createCountingSsrScript(MAIN_POSTS[0]);
  const env = loadEnv({ page: [script.node, createScanDom(MAIN_POSTS)] });
  await env.flush();

  assert.ok(script.counter.reads > 0, '第一輪掃描本來就要讀 SSR script');
  assert.equal(env.hits().length, 1, '第一輪應完成一次完整掃描');

  script.counter.reads = 0;
  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    script.counter.reads,
    0,
    '冪等判斷必須早於讀 script：同鍵重掃不得再把整包 SSR JSON 複製一遍'
  );
});

// ---- S2 互動列消歧 ----

// 本文刻意用單段（MAIN_POSTS），讓紅燈只反映「挑錯互動列」這一件事，不
// 與 F1 的多行本文互相遮蔽。
test('S2：容器內有播放器工具列排在互動列之後時，tag 仍插在互動列上方', async () => {
  const env = loadEnv({
    page: createDecoratedPage(MAIN_POSTS, (index) =>
      index === 0 ? { extraChildren: [createPlayerRow()] } : null
    ),
  });
  await env.flush();

  const tag = env.tags()[0];
  assert.ok(tag, '命中應掛上 tag');

  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  const actionRow = mainCard.querySelectorAll('div[data-tcl-fake-action-row]')[0];
  const playerRow = mainCard.querySelectorAll('div[data-tcl-fake-player-row]')[0];
  assert.ok(actionRow && playerRow, '假 DOM 的主文卡應同時有互動列與播放器工具列');

  const order = documentOrder(mainCard);
  assert.ok(
    order.indexOf(actionRow) < order.indexOf(playerRow),
    '假 DOM 前提：播放器工具列排在互動列之後'
  );
  assert.equal(
    tag.parentElement,
    actionRow.parentElement,
    'tag 應與互動列同一層，不是掛在播放器工具列旁'
  );
  assert.ok(
    order.indexOf(tag) < order.indexOf(actionRow),
    '標籤白名單（讚／回覆／轉發／分享）才是互動列，不能只取文件序最後一個候選'
  );
});

// ---- S3 SSR 交叉校驗 ----

test('S3：主文卡的 DOM 本文為空時，掃描文字仍含 SSR 的第一篇全文', async () => {
  const env = loadEnv({
    page: createDecoratedPage(MAIN_POSTS, (index) => (index === 0 ? { body: '' } : null)),
  });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '第一篇沒渲染出文字也要掃得動');
  assert.ok(
    env.detectCalls[0].includes(POSTS[0].captionText),
    'DOM 取不到第一篇本文時，應改用 SSR 的 captionText 補上'
  );
});

test('S3：主文卡容器整個缺席時，掃描文字仍含 SSR 的第一篇全文', async () => {
  const env = loadEnv({
    page: [
      createSsrScript(MAIN_POSTS[0]),
      el('div', { id: 'thread-root' }, buildThreadContainers(MAIN_POSTS.slice(1))),
    ],
  });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '第一篇容器還沒渲染也要掃得動');
  assert.ok(
    env.detectCalls[0].includes(POSTS[0].captionText),
    'SSR 已經帶著第一篇全文，不該因為容器缺席就整篇漏掃'
  );
});

// ---- S4 tag 補回 ----
//
// Threads 是 React 渲染的虛擬化頁面，主文卡重繪時我們插進去的節點會整個被
// 沖掉。冪等鍵擋住重掃的同時，也把「補回 tag」一起擋掉了——使用者捲一下就
// 再也看不到警示。

test('S4：tag 被外力移除後，同鍵的下一次觸發會補回一顆（且只補一顆、不重送訊息）', async () => {
  const env = loadEnv();
  await env.flush();

  const tag = env.tags()[0];
  assert.ok(tag, '第一輪應掛上 tag');
  tag.parentNode.removeChild(tag);
  assert.equal(env.tags().length, 0, '前提：tag 已被外力移除');

  env.triggerObserver();
  await env.flush();

  assert.equal(env.tags().length, 1, 'React 重繪沖掉 tag 後，下一次觸發要補回來');

  env.triggerObserver();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.tags().length, 1, '補回之後不得越補越多');
  assert.equal(
    env.hits().length,
    1,
    '補 tag 是頁面層的事，不得對 background 重送 scam.hit'
  );
});
