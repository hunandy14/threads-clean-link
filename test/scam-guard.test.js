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
const { runInSandbox } = require('./support/helpers');

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
const DISPLAY_NAME = 'Dakka Knight';
const CONTAINER_SELECTOR = 'div[data-pressable-container]';

// ============================================================
// 【最小假 DOM：一棵支援 closest／querySelectorAll／textContent 的迷你樹】
// 本專案慣例是用 duck-type 假物件替代 DOM（見 post-icon.test.js），但
// extractThreadFromDom 的三條保證——「容器依文件序列出」「巢狀子容器要排
// 除」「本文取子樹內最長的 [dir="auto"]」——天生需要真的樹狀結構與祖先
// 鏈，無法用單層假物件表達。這裡只搭到剛好夠用的程度：屬性讀取、
// 祖先查找、後代查詢、文字串接；不擴充成通用 DOM harness。
// ============================================================

// 只支援本檔用得到的選擇器形狀：`tag`、`tag[attr]`、`[attr="value"]`、
// `tag[attr="value"]`、`tag[attr^="value"]`。
const SELECTOR_PATTERN = /^([a-zA-Z]*)(?:\[([a-zA-Z-]+)(?:(\^?=)"([^"]*)")?\])?$/;

function matchesSelector(node, selector) {
  const parsed = SELECTOR_PATTERN.exec(String(selector).trim());
  assert.ok(parsed, `假 DOM 不支援的選擇器：${selector}`);
  const [, tag, attr, operator, value] = parsed;
  if (tag && node.nodeName !== tag.toUpperCase()) return false;
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
    // 前序走訪後代（不含自己），與真實 querySelectorAll 的文件序一致；
    // 巢狀容器內的節點照樣列出——過濾是受測程式的責任，不是假件的。
    querySelectorAll(selector) {
      const out = [];
      (function walk(current) {
        current.childNodes.forEach((child) => {
          if (child.nodeType !== 1) return;
          if (child.matches(selector)) out.push(child);
          walk(child);
        });
      })(node);
      return out;
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
  });

  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

// 一個貼文容器：作者連結（不帶 /post/）、permalink 連結（時間戳記）、
// 本文 span，外加可選的巢狀子節點（引用貼文）。
function createPostContainer(options) {
  const children = [
    el('a', { href: `/@${options.handle}` }, [
      el('span', { dir: 'auto' }, [text(options.handle)]),
    ]),
    el('a', { href: `/@${options.handle}/post/${options.code}` }, [
      el('time', { datetime: '2026-09-19T10:00:00Z' }, [text('2 小時')]),
    ]),
    el('div', {}, [el('span', { dir: 'auto' }, [text(options.body)])]),
  ];
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

  ['DakkaKnight', 'DAKKAKNIGHT', `@${AUTHOR}`, `@DakkaKnight`].forEach((handle) => {
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
