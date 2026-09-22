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
// 【fixture】test/fixtures/scam-thread.json 為合成的六篇範例串文，形狀比照
// 實機抓取樣本（只留 code／userId／username／position／selfThreadLength／
// captionText，無 cookie／token／頭像 URL）。本檔用它組出 (a) 仿 SSR JSON
// 字串、(b) 假 DOM。
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

// 「這個節點在版面上不存在」：自己或任一祖先帶 hidden 屬性，或行內樣式
// display:none。語意與真實 DOM 一致——[hidden] 的 UA 樣式就是
// display:none，而 display:none 會讓整棵子樹都不產生 box，因此判斷必須沿
// 祖先鏈往上走，不能只看節點自己。
function isRenderedHidden(node) {
  let cursor = node;
  while (cursor && cursor.nodeType === 1) {
    if (typeof cursor.hasAttribute === 'function' && cursor.hasAttribute('hidden')) return true;
    if (cursor.style && cursor.style.display === 'none') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

// 有 box 時的量測值，數值本身無意義，只用來與「沒有 box」區分。
function fakeRect() {
  return { x: 0, y: 0, width: 240, height: 80, top: 0, left: 0, right: 240, bottom: 80 };
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
    // 四種位置與真實 DOM 同義：beforebegin／afterend 動的是父層（沒有父
    // 層時回傳 null、不丟例外），afterbegin／beforeend 動的是自己的子節
    // 點。回傳插入的節點。
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
    addEventListener() {},
    removeEventListener() {},
    // ---- 版面量測：display:none 的子樹在真實 DOM 裡沒有 box，
    // getClientRects() 為空陣列、checkVisibility() 為 false、offsetParent 為
    // null。假件照同一套語意給值，供測試自己驗「這兩張卡確實一隱一現」。----
    getClientRects() {
      return isRenderedHidden(node) ? [] : [fakeRect()];
    },
    checkVisibility() {
      return !isRenderedHidden(node);
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
  // hidden 是布林 IDL 屬性，與 id／title 那組字串屬性的反射規則不同：讀取
  // 只問屬性在不在，寫入 true 等同 setAttribute('hidden', '')、寫入 false
  // 等同 removeAttribute('hidden')。`[hidden]` 選擇器與
  // getAttribute('hidden') 因此都看得到空字串值（與真實 DOM 一致）。
  Object.defineProperty(node, 'hidden', {
    get() {
      return node.hasAttribute('hidden');
    },
    set(value) {
      if (value) node.attributes.hidden = '';
      else delete node.attributes.hidden;
    },
  });
  // offsetParent：沒有 box 就沒有 offsetParent。有 box 時取最近的元素祖先
  // （假件不模擬 position 的定位脈絡，本檔的判準只分得清 null 與非 null）。
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
  // nextElementSibling：跳過文字節點，只看元素兄弟；沒有下一個元素時為
  // null，與真實 DOM 一致。
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
  // lastElementChild：最後一個元素子節點，沒有元素子節點時為 null。
  Object.defineProperty(node, 'lastElementChild', {
    get() {
      const elements = node.children;
      return elements[elements.length - 1] || null;
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

// 一個貼文容器：作者列（作者連結＋permalink 時間連結同一列）、本文
// span，可選的原生互動列，外加可選的巢狀子節點（引用貼文）。
//
// 作者列在實機是 `row > [作者名 a, divC]`，時間那一支再往下包三層，量過的
// 祖先鏈是：
//   row（作者列，children＝作者名 <a> ＋ divC）
//     └ divC（flex，align-items:center，gap:6px，overflow:hidden，高 21px）
//         └ divB（flex，只包時間）
//             └ span（block）
//                 └ a（permalink，inline）
//                     └ time
// 警示 tag 的落點是 divC 的末尾：時間右緣到 tag 左緣剛好是 row 的 6px
// gap，time、作者名與「⋯」位移全為 0。divB 與 span 都只有一個元素子節點，
// 實作因此靠「單子節點就往上走」找到 divC，不看任何計算樣式。假件照這個層
// 級搭（row 標 `data-tcl-fake-author-row` 供測試取用，實作不看這顆屬性）。
//
// options.body 可為字串（單一 span）或字串陣列（多個各自獨立的葉
// [dir="auto"] span，對應實機把一篇貼文拆成多段的版面）。
// options.actionRowCounts：互動列各按鈕的計數字串。
// options.dirAutoTimestamp：時間戳記改用 [dir="auto"] span（實測版面），
//   而非 <time> 元素——容器內因此一顆 <time> 都沒有。
// options.foreignTimeLink：{ handle, code } 另外補一塊「別篇貼文的時間連
//   結」（轉發標頭那種），排在作者列之後，讓本卡 permalink 仍是文件序第
//   一個 /post/ 連結（readContainerPermalink 的判準不受影響），單獨考驗
//   「<time> 的連結必須與本卡 permalink 同 code」。
// options.bareTimeLink：時間連結直接掛在作者列下，父層因此本來就有別的元
//   素子節點（版面變體），考驗「沒有單子節點包裹層時退回插在 <a> 之後」。
function createPostContainer(options) {
  const lines = Array.isArray(options.body) ? options.body : [options.body];
  const timeLink = el('a', { href: `/@${options.handle}/post/${options.code}` }, [
    options.dirAutoTimestamp
      ? el('span', { dir: 'auto' }, [text(options.timestamp || '2 小時')])
      : // datetime 是貼文發布時間的來源（見 postedAt 那批測試）；逐篇可覆
        // 寫，才測得出「payload 取的是錨點篇那一顆，不是隨便哪一顆」。
        el('time', { datetime: options.postedAtIso || '2026-09-19T10:00:00Z' }, [text('2 小時')]),
  ]);
  const timeBranch = options.bareTimeLink
    ? timeLink
    : el('div', { 'data-tcl-fake-time-gap-row': 'true' }, [
        el('div', {}, [el('span', {}, [timeLink])]),
      ]);
  const children = [
    el('div', { 'data-tcl-fake-author-row': 'true' }, [
      el('a', { href: `/@${options.handle}` }, [
        el('span', { dir: 'auto' }, [text(options.handle)]),
      ]),
      timeBranch,
    ]),
  ];
  if (options.foreignTimeLink) {
    children.push(
      el('div', { 'data-tcl-fake-repost-header': 'true' }, [
        el(
          'a',
          {
            href: `/@${options.foreignTimeLink.handle}/post/${options.foreignTimeLink.code}`,
          },
          [el('time', { datetime: '2026-09-18T10:00:00Z' }, [text('1 天')])]
        ),
      ])
    );
  }
  children.push(
    el(
      'div',
      {},
      lines.map((line) => el('span', { dir: 'auto' }, [text(line)]))
    )
  );
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
    stripPositionBadge('排程 4/24 小時輪一次，撐了十多年'),
    { text: '排程 4/24 小時輪一次，撐了十多年', position: null, total: null },
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
    1: '第一篇：範例主角在產線待了十多年，上個月正式離職。',
    2: '第二篇：這十多年怎麼過的？簡單講就是拿作息換薪水。',
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
  const body = '第一篇：範例主角在產線待了十多年，上個月正式離職。';
  const root = el('div', {}, [
    createPostContainer({
      handle: AUTHOR,
      code: 'DsQuErY001?xmt=AQGzabcdef',
      body: withBadge(body, 1, 2),
    }),
    createPostContainer({
      handle: AUTHOR,
      code: 'DsQuErY002#focus',
      body: withBadge('第二篇：這十多年怎麼過的？簡單講就是拿作息換薪水。', 2, 2),
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
  const body = '第一篇：範例主角在產線待了十多年，上個月正式離職，這串講完整個過程。';
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
      postedAtIso: post.postedAtIso,
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
//   respondDelayMs 回應結算的延遲（預設 0，即下一個 tick）。真實
//                chrome.runtime 的往返可能比掃描的 debounce（60ms）還久，要
//                測「回應落地前頁面已經重掃過」得先把這段窗口撐開。
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
  // 已經結算給實作的回應。回應延遲時「舊回呼已經落地了沒有」沒有別的觀測
  // 點——過期守衛生效時它什麼都不做，等固定毫秒只是換一種閃爍。
  const replies = [];
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
          const delay = settings.respondDelayMs || 0;
          if (typeof callback === 'function') {
            setTimeout(() => {
              callback(failure ? undefined : reply);
              // 回呼跑完才記一筆：測試看到它時，實作對這則回應的處理已經結
              // 束，斷言不會卡在半途。
              replies.push(index);
            }, delay);
            return undefined;
          }
          return new Promise((resolve, reject) => {
            setTimeout(() => (failure ? reject(failure) : resolve(reply)), delay);
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
    replies,
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
    // 條件輪詢：等到 condition() 為真才往下走，逾時才紅燈。固定長度的等待
    // 在全套併跑時會被排程延遲吃掉（實測 flush() 的 200ms 在負載下不足），
    // 輪詢則是條件一成立就收工，慢的機器只是多等幾圈。逾時訊息帶 label，
    // 紅燈時看得出是哪一個條件沒成立。
    waitFor(condition, options) {
      const settings = options || {};
      const timeout = settings.timeout === undefined ? 2000 : settings.timeout;
      const step = settings.step === undefined ? 20 : settings.step;
      const deadline = Date.now() + timeout;
      return new Promise((resolve, reject) => {
        (function poll() {
          let value;
          try {
            value = condition();
          } catch (e) {
            reject(e);
            return;
          }
          if (value) {
            resolve(value);
            return;
          }
          if (Date.now() >= deadline) {
            reject(
              new Error('waitFor 逾時（' + timeout + 'ms）：' + (settings.label || '條件未成立'))
            );
            return;
          }
          setTimeout(poll, step);
        })();
      });
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

// 落點的細節由「作者列 1」那一筆釘（時間連結右邊）；本筆只保留與落點無
// 關、兩條路徑都成立的不變量：整頁一顆、掛在主文卡、不在互動列內部、文件
// 序早於互動列。
test('掃描流程：命中後在主文卡插一顆 .tcl-scam-tag，且不在互動列內部', async () => {
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
    'tag 的文件序必須早於互動列（作者列與退回落點都在互動列之前）'
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
  await env.waitFor(() => env.toastTexts().length > 0, { label: '首次命中的 toast' });

  assert.deepEqual(env.toastTexts(), [FIRST_HIT_TOAST], '首次入名單應跳一次 toast');
});

test('toast：同一 session 第二次 added:true 不再 toast，但 tag 照掛', async () => {
  const env = loadEnv();
  await env.waitFor(() => env.toastTexts().length > 0, { label: '首次命中的 toast' });
  assert.deepEqual(env.toastTexts(), [FIRST_HIT_TOAST], '第一次要 toast');

  env.clearToasts();
  env.setPathname(SECOND_PATH);
  env.setPage(createPage({ posts: SECOND_POSTS }));
  env.triggerObserver();
  // tag 與 toast 在同一個回呼裡結算（tag 先掛、toast 後跳），等到第二串的
  // tag 就位，「有沒有再 toast」這條負向斷言才問得準。
  await env.waitFor(() => env.hits().length === 2 && env.tags().length === 1, {
    label: '第二串的 scam.hit 與 tag',
  });

  assert.equal(env.hits().length, 2, '第二串照樣送 scam.hit');
  assert.deepEqual(env.toastTexts(), [], '同一 session 第二次不得再 toast');
  assert.equal(env.tags().length, 1, '第二頁的主文卡照樣掛 tag');
});

test('toast：added:false（既有作者只補證據）不 toast，tag 仍在', async () => {
  const env = loadEnv({
    respond: () => ({ ok: true, added: false, entry: { handle: AUTHOR } }),
  });
  await env.waitFor(() => env.tags().length === 1, { label: '主文卡的 tag' });

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
  '第一段鋪陳：範例主角在產線待了十多年，離職之後才發現，難的不是技術，而是被排班表切碎的生活。',
  '不報明牌、不收費、不代操，就是一個待過產線的設備工程師，跟你分享怎麼找波段黑馬股。',
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

// ---- 軟性招攬串：LINE 提及 ＋ 群組詞（PM 規則改版）----
//
// scam-thread-soft.json 是第二份合成串文：七篇自回覆，招攬篇「一個話術詞都
// 沒有」，只留一句「加 LINE：ab12cd……我把你拉進群組」。舊判準（錨點 ＋ 強
// 話術詞）對這串全文回 hit:false，新判準（LINE 提及 ＋ 群組／加入詞）才掃得
// 到。判定本身的邊界在 test/tcl-core.test.js 釘，這裡只走一條端到端：詳情
// 頁掃描 → 命中 → 送 scam.hit → 掛 tag。
const SOFT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'scam-thread-soft.json'), 'utf8')
);
const SOFT_POSTS = SOFT_FIXTURE.posts;
const SOFT_PATH = `/@${AUTHOR}/post/${SOFT_POSTS[0].code}`;
const SOFT_THREAD_TEXT = SOFT_POSTS.map((post) => post.captionText).join('\n\n');

test('軟性招攬端到端：零話術詞的 LINE 群組招攬串照樣命中、送 scam.hit、掛 tag', async () => {
  const env = loadEnv({
    pathname: SOFT_PATH,
    page: [createSsrScript(SOFT_POSTS[0]), createScanDom(SOFT_POSTS)],
  });
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '詳情頁應掃描一次');
  assert.equal(env.detectCalls[0], SOFT_THREAD_TEXT, '七篇串起來的全文');
  assert.ok(env.detectCalls[0].includes('LINE：ab12cd'), 'LINE 提及必須進得了判定的輸入');
  assert.ok(
    !/黑馬股|報明牌|代操|帶單|飆股|穩賺|獲利分享/.test(env.detectCalls[0]),
    '這串刻意不帶任何強話術詞，命中只能來自 LINE 提及 ＋ 群組詞'
  );

  const hits = env.hits();
  assert.equal(hits.length, 1, '軟性招攬串要通報一則 scam.hit');
  assert.equal(hits[0].userId, SOFT_POSTS[0].userId);
  assert.equal(hits[0].handle, AUTHOR);
  assert.equal(hits[0].postUrl, ORIGIN + SOFT_PATH, 'postUrl 為正規化後的乾淨網址');
  // 【斷言翻轉｜D43】v3 標亮整段「LINE：ab12cd」;v4 改標 ID 本體。
  assert.equal(hits[0].anchorMatch, 'ab12cd', 'anchorMatch 取 ID 本體(D43)');
  assert.equal(hits[0].lineId, 'ab12cd', 'payload 一併帶 lineId(D43/D46)');
  assert.ok(hits[0].snippet.includes('LINE：ab12cd'), 'snippet 以 LINE 提及為中心');
  assert.deepEqual(Array.from(hits[0].pitchMatches), [], '沒有話術詞也要成立');

  assert.equal(env.tags().length, 1, '命中就要掛一顆警示');
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
// 與 F1 的多行本文互相遮蔽。buildThreadContainers 的時間戳記是
// [dir="auto"] span，容器內沒有 <time>，落點因此落在退回路徑上——互動列消
// 歧正是退回路徑要解的題。
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
  await env.waitFor(() => env.tags().length === 1, { label: '第一輪的 tag' });

  const tag = env.tags()[0];
  assert.ok(tag, '第一輪應掛上 tag');
  tag.parentNode.removeChild(tag);
  assert.equal(env.tags().length, 0, '前提：tag 已被外力移除');

  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 1, { label: '補回來的 tag' });

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

// ============================================================
// 【第四波：河道卡片的本機黑名單查表】（車道 L5）
//
// 詳情頁的掃描（第二波）負責「發現」詐騙串並把作者寫進黑名單；本段負責
// 「複用」那份名單——河道（首頁 feed）與任何非詳情頁的貼文卡片，只要作者
// 已在本機黑名單裡，就掛上同一顆 `.tcl-scam-tag`，讓使用者在點進去之前就
// 看得到警示。
//
// 【與實作的契約】
//   資料來源：啟動時讀 `chrome.storage.local.scamBlocklist`，經
//     `TCLCore.normalizeScamBlocklist` 正規化後留在記憶體；另監聽
//     `chrome.storage.onChanged`（local 區）更新那份快取。只有 background
//     寫這顆鍵，本段一律唯讀。
//   查表：每張 `div[data-pressable-container]` 抽出作者 handle →
//     `handleIndex[handle.toLowerCase()]` → 命中得到 userId → userId 不在
//     `allowlist`（使用者已解除封鎖）才算命中。
//   標記：命中即掛 `.tcl-scam-tag`，文字 `scamTagLabel`、title
//     `scamBlockedByList`（與詳情頁掃描的 `scamTagTooltip` 不同——這顆說的
//     是「這個帳號在你的黑名單中」，不是「這串貼文疑似詐騙」）。一張卡只
//     掛一顆，已掛不重掛；MutationObserver 續載的新卡也要補掛。
//   詳情頁分工：詳情頁上「主文作者自己那一串」由掃描負責（只掛主文卡一
//     顆），查表不得在六篇上各掛一顆；他人回覆的卡片則照樣查表。
//   總開關：`scamGuardEnabled` 為 false 時不掛（既有 tag 不撤）；切回 true
//     後下一次觸發要補上。
//   零對外：查表是純本機動作——不送任何 `chrome.runtime.sendMessage`、不發
//     任何 fetch，也不跑 `TCLCore.detectScamPitch`。
//
// 【handle 從哪裡來】post-icon.js 的 extractAuthorHandle 宣告在它自己的
// document 守衛內，Node 匯出的 api 上沒有這支，sandbox 的 TCLPostIcon 因此
// 也沒有；實作不能假設它在場，要嘛自己從容器的 `a[href^="/@"]` 取（與
// readContainerPermalink 同一套判準），要嘛在缺席時有等價的後備。
//
// 【fetch 的觀測點】sandbox 本來沒有 `fetch` 全域，實作真的去打請求只會丟
// ReferenceError 被 safeScan 吞掉，測試看不出差別。這裡補一顆會記錄呼叫的
// 假 fetch（一律 reject），讓「有沒有發請求」變成可觀測的事實。
// ============================================================

const FEED_PATH = '/';
const BLOCKED_ID = '123';
const BLOCKED_HANDLE = 'example_author';
// 同一個 handle 的大小寫變體：Threads 的 handle 不分大小寫，查表前必須先
// 小寫化，否則同一個人換個寫法就漏標。
const BLOCKED_HANDLE_MIXED = 'Example_Author';
const BLOCKED_DISPLAY = 'Example Author';
const NEUTRAL_ID = '456';
const NEUTRAL_HANDLE = 'other';
// 詳情頁假 DOM（createScanDom）固定附的那張他人回覆卡。
const REPLY_HANDLE = 'some.other_reader';
const REPLY_ID = '789';
const BLOCKED_BY_LIST_TITLE = I18N.t('zh', 'scamBlockedByList');

// 組一份 storage 形狀的黑名單。欄位比照 v1 計畫 §3，能原封不動通過
// TCLCore.normalizeScamBlocklist（handleIndex 由 entries 重建，這裡照樣寫
// 上，讓 fixture 自己就是合法形狀）。
//   authors:   [[userId, handle, displayName?], ...]
//   allowlist: [[userId, handle], ...]
function buildBlocklist(options) {
  const settings = options || {};
  const authors = settings.authors || [[BLOCKED_ID, BLOCKED_HANDLE, BLOCKED_DISPLAY]];
  const list = { version: 1, entries: {}, handleIndex: {}, allowlist: {} };
  authors.forEach(([id, handle, displayName]) => {
    list.entries[id] = {
      handle,
      displayName: displayName || handle,
      evidence: [],
      addedAt: 1758280000000,
      source: 'auto',
    };
    list.handleIndex[handle.toLowerCase()] = id;
  });
  (settings.allowlist || []).forEach(([id, handle]) => {
    list.allowlist[id] = { at: 1758290000000, handle };
  });
  return list;
}

// 河道卡片：與詳情頁的容器同一種結構（作者連結、permalink、本文、互動
// 列），差別只在沒有串文徽章、作者各不相同。code 每張唯一，避免實作以
// code 當冪等鍵時互相覆蓋。
let feedCardSeq = 0;

// overrides：覆寫容器設定（例如把時間戳記換回 <time> 元素）。
function createFeedCard(handle, body, overrides) {
  feedCardSeq += 1;
  return createPostContainer(
    Object.assign(
      {
        handle,
        code: 'DfEeD' + String(feedCardSeq).padStart(6, '0'),
        body: body || '河道上的一則貼文，內容與投資話術無關。',
        actionRow: true,
        actionRowCounts: F1_COUNTS,
        dirAutoTimestamp: true,
      },
      overrides || {}
    )
  );
}

function createFeedRoot(handles) {
  return el(
    'div',
    { id: 'feed-root' },
    handles.map((handle) => createFeedCard(handle))
  );
}

function cardsOf(env) {
  return env.document.querySelectorAll(CONTAINER_SELECTOR);
}

function tagsIn(card) {
  return card.querySelectorAll('.' + TAG_CLASS);
}

// 預設落在河道（pathname '/'），並補一顆會記錄呼叫的假 fetch。
function loadFeedEnv(options) {
  const settings = Object.assign({ pathname: FEED_PATH }, options || {});
  const env = createScamGuardEnv(settings);
  const fetchCalls = [];
  env.fetchCalls = fetchCalls;
  env.sandbox.fetch = function () {
    fetchCalls.push(Array.prototype.slice.call(arguments));
    return Promise.reject(new Error('河道查表不得發任何請求'));
  };
  assert.doesNotThrow(() => env.load(), 'scam-guard.js 在河道假 DOM 載入不得丟例外');
  return env;
}

test('河道 1：黑名單作者的卡片掛上 tag，其他作者不掛，且完全不對外通訊', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE, BLOCKED_HANDLE_MIXED]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 2, { label: '兩張命中卡的查表 tag' });

  const cards = cardsOf(env);
  assert.equal(cards.length, 3, '前提：河道上有三張卡');
  assert.equal(tagsIn(cards[0]).length, 1, '黑名單作者的卡片要掛一顆 tag');
  assert.equal(tagsIn(cards[1]).length, 0, '不在黑名單的作者不得被標記');
  assert.equal(tagsIn(cards[2]).length, 1, 'handle 大小寫變體是同一個人，查表前要小寫化');
  assert.equal(env.tags().length, 2, '整頁只有兩張命中卡片');

  const tag = tagsIn(cards[0])[0];
  assert.equal(tag.textContent, TAG_LABEL, 'tag 文字沿用 scamTagLabel');
  assert.equal(
    tag.getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '河道的 tag 說的是「這個帳號在你的黑名單中」，不是詳情頁那句串文判定'
  );
  assert.equal(tag.closest(CONTAINER_SELECTOR), cards[0], 'tag 要掛在命中的那張卡內');

  assert.deepEqual(env.sent, [], '查表是純本機動作，不得送任何訊息');
  assert.deepEqual(env.fetchCalls, [], '查表不得發任何請求');
  assert.deepEqual(env.detectCalls, [], '河道不跑串文判定，只查表');
});

test('河道 2：observer 重複觸發，每張命中卡片仍只有一顆 tag', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE, BLOCKED_HANDLE_MIXED]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.flush();

  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  env.triggerObserver();
  await env.flush();

  const cards = cardsOf(env);
  assert.equal(tagsIn(cards[0]).length, 1, '重複觸發不得越掛越多');
  assert.equal(tagsIn(cards[2]).length, 1, '重複觸發不得越掛越多');
  assert.equal(env.tags().length, 2);
  assert.deepEqual(env.sent, [], '重複觸發照樣不得送訊息');
});

test('河道 3：feed 續載的新卡片會補掛，既有卡片不重掛', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.waitFor(() => env.tags().length === 1, { label: '起始那張命中卡的 tag' });
  assert.equal(env.tags().length, 1, '前提：起始兩張卡只有一張命中');

  root.appendChild(createFeedCard(NEUTRAL_HANDLE));
  root.appendChild(createFeedCard(BLOCKED_HANDLE_MIXED));
  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 2, { label: '續載那張命中卡的 tag' });

  const cards = cardsOf(env);
  assert.equal(cards.length, 4, '前提：續載後有四張卡');
  assert.equal(tagsIn(cards[2]).length, 0, '新載入的非黑名單作者不得被標記');
  assert.equal(tagsIn(cards[3]).length, 1, '新載入的黑名單作者要補掛');
  assert.equal(env.tags().length, 2, '舊卡不重掛，總數只多一顆');
});

test('河道 4：userId 在 allowlist（使用者已解除封鎖）時不掛', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE, BLOCKED_HANDLE_MIXED]);
  const env = loadFeedEnv({
    page: [root],
    local: { scamBlocklist: buildBlocklist({ allowlist: [[BLOCKED_ID, BLOCKED_HANDLE]] }) },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.tags().length, 0, '解除封鎖的作者即使還留在 entries 裡，也不得再被標記');
});

test('河道 5：總開關關閉時不掛，切回開啟後下一次觸發補上', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE, BLOCKED_HANDLE_MIXED]);
  const env = loadFeedEnv({
    page: [root],
    local: { scamGuardEnabled: false, scamBlocklist: buildBlocklist() },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();
  assert.equal(env.tags().length, 0, '開關關閉時不得標記河道卡片');

  env.storage.emitChange({ scamGuardEnabled: { oldValue: false, newValue: true } }, 'local');
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 2, { label: '開關切回後補上的兩顆 tag' });

  assert.equal(env.tags().length, 2, '開關切回 true 後，下一次觸發要把命中的卡片補上');
  assert.deepEqual(env.sent, [], '補標記照樣不得送訊息');
});

test('河道 6：storage.onChanged 更新黑名單後，下一次觸發即反映新增與解除', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE, BLOCKED_HANDLE_MIXED]);
  const initial = buildBlocklist();
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: initial } });
  await env.waitFor(() => env.tags().length === 2, { label: '起始名單命中的兩顆 tag' });
  assert.equal(env.tags().length, 2, '前提：起始名單只命中兩張');

  // ---- 新增一位作者 ----
  const extended = buildBlocklist({
    authors: [
      [BLOCKED_ID, BLOCKED_HANDLE, BLOCKED_DISPLAY],
      [NEUTRAL_ID, NEUTRAL_HANDLE, 'Other Author'],
    ],
  });
  env.storage.emitChange({ scamBlocklist: { oldValue: initial, newValue: extended } }, 'local');
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 3, { label: '名單新增那位作者的 tag' });

  const cards = cardsOf(env);
  assert.equal(tagsIn(cards[1]).length, 1, '名單新增的作者，下一次觸發要掛上');
  assert.equal(env.tags().length, 3);

  // ---- 解除原本那一位 ----
  const lifted = buildBlocklist({
    authors: [[NEUTRAL_ID, NEUTRAL_HANDLE, 'Other Author']],
    allowlist: [[BLOCKED_ID, BLOCKED_HANDLE]],
  });
  env.storage.emitChange({ scamBlocklist: { oldValue: extended, newValue: lifted } }, 'local');
  await env.flush();
  root.appendChild(createFeedCard(BLOCKED_HANDLE));
  env.triggerObserver();
  await env.flush();

  const after = cardsOf(env);
  assert.equal(after.length, 4, '前提：解除後又載進一張同作者的新卡');
  assert.equal(tagsIn(after[3]).length, 0, '解除後新載入的卡片不得再掛');
  assert.equal(env.tags().length, 3, '解除不回收既有的 tag，但也不得再新增');
});

test('河道 7：沒有黑名單或黑名單為空時不掛、不丟例外', async () => {
  const cases = [
    ['storage 完全沒有這顆鍵', {}],
    ['空物件', { scamBlocklist: {} }],
    ['null', { scamBlocklist: null }],
    ['正規化後的空名單', { scamBlocklist: buildBlocklist({ authors: [] }) }],
  ];

  for (const [label, local] of cases) {
    const env = loadFeedEnv({
      page: [createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE])],
      local,
    });
    await env.flush();
    env.triggerObserver();
    await env.flush();

    assert.equal(env.tags().length, 0, label + '：不得標記任何卡片');
    assert.deepEqual(env.warnings, [], label + '：不得有例外被吞成 console.warn');
    assert.deepEqual(env.sent, [], label + '：不得送訊息');
  }
});

test('河道 8：詳情頁主文卡由掃描掛好 tag 後，查表不得在同一串上再多掛', async () => {
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createPage(),
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
  });
  await env.flush();
  env.triggerObserver();
  env.triggerObserver();
  await env.flush();

  const cards = cardsOf(env);
  assert.equal(tagsIn(cards[0]).length, 1, '主文卡只有掃描掛的那一顆');
  assert.equal(
    env.tags().length,
    1,
    '詳情頁上主文作者自己那六篇由掃描負責，查表不得每篇各掛一顆'
  );
});

test('河道 8b：詳情頁上他人回覆的卡片照樣查表掛 tag', async () => {
  // 原始 fixture 全文沒有 LINE 錨點，detectScamPitch 回 hit:false——掃描這
  // 條路不會掛任何 tag，頁面上剩下的那一顆必然來自查表。
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createPage({ posts: POSTS }),
    local: { scamBlocklist: buildBlocklist({ authors: [[REPLY_ID, REPLY_HANDLE]] }) },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.deepEqual(env.hits(), [], '前提：這一串未命中串文判定，不送 scam.hit');

  const cards = cardsOf(env);
  const reply = cards[cards.length - 1];
  assert.ok(
    reply.querySelector('a[href^="/@' + REPLY_HANDLE + '/post/"]'),
    '前提：最後一張是他人回覆的卡片'
  );
  assert.equal(tagsIn(reply).length, 1, '他人回覆的作者在黑名單中，要掛 tag');
  assert.equal(env.tags().length, 1, '主文作者不在黑名單，不該有第二顆');
});

// ============================================================
// 【第五波：L5 審查採納的五條】tag 補回、黑名單作者的詳情頁主文標記、引用
// 不誤標、無 permalink 容器的走訪上限、初始競態。上方既有測試維持原樣，本
// 段只新增。
//
// 【與實作的契約（本段新增的部分）】
//   tag 補回：容器沒換、只是 tag 節點被 React 重繪沖掉時，同一張卡的下一次
//     觸發要補回一顆——「已查過表」的記憶不能連「頁面上到底還有沒有警示」
//     一起省掉（詳情頁掃描那條路的 S4 已經有同樣的保證）。
//   詳情頁主文連貫：網址列作者本人在黑名單、但這一串沒踩到 detectScamPitch
//     時，主文卡（code === pathInfo.code）仍要掛一顆 title 為
//     `scamBlockedByList` 的 tag——使用者在河道看得到警示，點進去卻沒有，是
//     比兩邊都沒有更糟的體驗。同一串的其餘容器仍不掛。掃描有命中時以掃描
//     為準：主文卡只有一顆，title 為 `scamTagTooltip`。
//   引用不誤標：外層是中立作者、內層引用了黑名單作者的貼文時，整頁不掛
//     tag。被引用的巢狀容器不是獨立的一張卡，外層卡的作者也不是黑名單上的
//     人——兩邊都不該掛。
//   無 permalink 容器的走訪上限：容器取不到 permalink 就永遠取不到（廣告
//     卡、推薦帳號卡這類版面本來就沒有貼文連結）。每次 MutationObserver 觸
//     發都對它重跑一次 `querySelectorAll('a[href]')` 是白付的成本，連續三
//     次之後要把它記下來別再走訪。
//   初始競態：`readSettings` 的回呼結算前，`onChanged` 可能已經把新名單送
//     到（background 在分頁載入當下寫入）。回呼落地時不得拿「讀取當下」的
//     舊快照把新名單蓋回去。
// ============================================================

// 把 chrome.storage.local.get 的第一次呼叫（init 的 readSettings）攔下來，
// 由測試決定何時、帶什麼值結算——初始競態要的正是「onChanged 先到、get 後
// 到」這個順序，交給假 storage 自己排程是排不出來的。攔截只吃第一次，其餘
// 呼叫照走原本的假實作。
function loadRaceEnv(options) {
  const settings = Object.assign({ pathname: FEED_PATH }, options || {});
  const env = createScamGuardEnv(settings);
  const area = env.sandbox.chrome.storage.local;
  const realGet = area.get.bind(area);
  const pendingGets = [];
  let intercept = true;

  area.get = function (keys, callback) {
    if (!intercept || typeof callback !== 'function') return realGet(keys, callback);
    intercept = false;
    pendingGets.push({ keys, callback });
    // 刻意不回 Promise：讓實作只剩 callback 這一條路，結算時機完全由測試掌控。
    return undefined;
  };

  env.pendingGets = pendingGets;
  env.releaseSettings = function (items) {
    const job = pendingGets.shift();
    assert.ok(job, '前提：init 讀設定的 chrome.storage.local.get 還懸著');
    job.callback(items);
  };

  assert.doesNotThrow(() => env.load(), 'scam-guard.js 在河道假 DOM 載入不得丟例外');
  return env;
}

test('河道 9：河道卡的 tag 被外力移除後，同一張卡的下一次觸發會補回一顆', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.waitFor(() => env.tags().length === 1, { label: '命中卡片的查表 tag' });

  const tag = env.tags()[0];
  assert.ok(tag, '前提：命中的卡片已掛上 tag');
  const card = tag.closest(CONTAINER_SELECTOR);
  assert.ok(card, '前提：tag 掛在某張卡內');
  tag.parentNode.removeChild(tag);
  assert.equal(env.tags().length, 0, '前提：tag 已被外力移除，容器本身沒換');

  env.triggerObserver();
  await env.waitFor(() => tagsIn(card).length === 1, { label: '補回來的查表 tag' });

  assert.equal(
    tagsIn(card).length,
    1,
    'React 重繪沖掉 tag 後，同一張卡的下一次觸發要補回來'
  );

  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(tagsIn(card).length, 1, '補回之後不得越補越多');
  assert.equal(env.tags().length, 1, '整頁仍只有那一顆');
  assert.deepEqual(env.sent, [], '補 tag 是頁面層的事，不得送任何訊息');
});

test('河道 10：黑名單作者的詳情頁即使串文未命中，主文卡仍掛一顆查表 tag', async () => {
  // 原始 fixture 全文沒有 LINE 錨點，detectScamPitch 回 hit:false——掃描這
  // 條路不會掛任何 tag，主文卡上該有的那一顆只能來自查表。
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createPage({ posts: POSTS }),
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.deepEqual(env.hits(), [], '前提：這一串未命中串文判定，不送 scam.hit');

  const cards = cardsOf(env);
  assert.equal(
    tagsIn(cards[0]).length,
    1,
    '作者已在黑名單中，主文卡要掛一顆——河道看得到、點進去卻沒有是更糟的體驗'
  );
  assert.equal(
    tagsIn(cards[0])[0].getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '這一顆說的是「這個帳號在你的黑名單中」，不是串文判定'
  );
  assert.equal(
    env.tags().length,
    1,
    '同一串的其餘容器（自回覆與他人回覆）不得跟著掛'
  );
});

test('河道 11：串文命中時主文卡只有掃描那一顆，title 為 scamTagTooltip（掃描優先）', async () => {
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createPage(),
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.hits().length, 1, '前提：這一串命中串文判定');

  const cards = cardsOf(env);
  assert.equal(tagsIn(cards[0]).length, 1, '掃描與查表都想掛時，主文卡只能有一顆');
  assert.equal(
    tagsIn(cards[0])[0].getAttribute('title'),
    TAG_TOOLTIP,
    '掃描的判定資訊量較大，命中時以 scamTagTooltip 為準'
  );
  assert.equal(env.tags().length, 1);
});

test('河道 12：外層中立作者的卡片內嵌黑名單作者的引用貼文時，整頁不得掛 tag', async () => {
  const quoted = createPostContainer({
    handle: BLOCKED_HANDLE,
    code: 'DqUoTeD0001',
    body: '被引用的那則貼文，作者在黑名單裡。',
  });
  const outer = createPostContainer({
    handle: NEUTRAL_HANDLE,
    code: 'DfEeDqUoTe1',
    body: '轉貼一則看看。',
    actionRow: true,
    dirAutoTimestamp: true,
    extraChildren: [quoted],
  });
  const env = loadFeedEnv({
    page: [el('div', { id: 'feed-root' }, [outer])],
    local: { scamBlocklist: buildBlocklist() },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    outer.querySelectorAll(CONTAINER_SELECTOR).length,
    1,
    '前提：外層卡內確實包著一個巢狀容器'
  );
  assert.equal(
    env.tags().length,
    0,
    '被引用的巢狀容器不是獨立的一張卡，外層卡的作者也不在黑名單——兩邊都不該掛'
  );
});

test('河道 13：永遠取不到 permalink 的容器，連續三次觸發後不再被走訪', async () => {
  // 廣告卡、推薦帳號卡這類版面本來就沒有貼文連結，取不到一次就等於永遠取
  // 不到；每次 MutationObserver 觸發都重跑一次子樹查詢是白付的成本。
  const barren = el('div', { 'data-pressable-container': 'true' }, [
    el('div', {}, [el('span', { dir: 'auto' }, [text('推薦追蹤的帳號')])]),
    createActionRow({}),
  ]);
  const walks = { count: 0 };
  const realQuerySelectorAll = barren.querySelectorAll;
  barren.querySelectorAll = function (selector) {
    walks.count += 1;
    return realQuerySelectorAll(selector);
  };

  const root = el('div', { id: 'feed-root' }, [
    createFeedCard(BLOCKED_HANDLE),
    barren,
    createFeedCard(NEUTRAL_HANDLE),
  ]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });

  // 第 1 次＝init 的那一輪，加上兩次 observer 觸發共三輪。
  await env.flush();
  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.ok(walks.count > 0, '前提：這個容器前幾輪確實被走訪過');
  assert.ok(
    walks.count <= 3,
    `取不到 permalink 的容器最多走訪三次，實際 ${walks.count} 次`
  );
  assert.equal(env.tags().length, 1, '前提：同一頁的黑名單卡片照樣掛得上');

  walks.count = 0;
  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    walks.count,
    0,
    '第四次起不得再走訪——取不到一次就等於永遠取不到，記下來別再問'
  );
});

test('河道 14：readSettings 回呼前 onChanged 先送新名單，回呼落地後不得用舊值蓋回', async () => {
  const root = createFeedRoot([BLOCKED_HANDLE, NEUTRAL_HANDLE]);
  const env = loadRaceEnv({ page: [root], local: {} });
  await env.flush();
  assert.equal(env.pendingGets.length, 1, '前提：init 讀設定的 get 仍懸著未結算');
  assert.equal(env.tags().length, 0, '前提：設定還沒回來，什麼都不該掛');

  // background 在分頁啟動讀取結算前就寫好了名單，onChanged 先到。
  env.storage.emitChange(
    { scamBlocklist: { oldValue: null, newValue: buildBlocklist() } },
    'local'
  );
  await env.flush();

  // 懸著的 get 這時才結算，帶回的是「發出讀取當下」的舊快照——沒有名單。
  env.releaseSettings({ scamGuardEnabled: true, scamBlocklist: null });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    env.tags().length,
    1,
    '啟動讀取帶回的舊快照不得蓋掉 onChanged 已經送到的新名單'
  );
});

// ============================================================
// 【第六波：整合審查（F1／S8）釘下的紅燈】
//
// 【與實作的契約（本段新增的部分）】
//   F1 補回的作用域：scan() 的「同鍵補回 tag」以 document 全文件找
//     `.tcl-scam-tag` 當「警示還在」的證據，但頁面上的 tag 不只一顆來源——
//     詳情頁的他人回覆卡也可能因查表掛上一顆。補回的判準必須限縮到「主文
//     卡那一顆」（lastScan.mainCode 指的那張卡內），否則 React 沖掉主文卡
//     的警示後，全文件仍找得到回覆卡那顆，主文卡的警示就此永久消失。
//   F1 連帶——解除後不得補回：使用者在選項頁解除封鎖（storage 的
//     `scamBlocklist.allowlist[userId]` 多一筆解除紀錄）之後，已掛的 tag 被
//     React 沖掉就該是終局。補回是「還原上一輪判定」，不是「重新判定」，因
//     此必須先確認該作者仍未被使用者否決。
//   S8 冪等鍵要涵蓋本文：冪等鍵只取 pathname ＋ 容器 code 集合時，「容器先
//     掛上、本文後補」這個 React 常見的兩段式渲染會被當成同一輪而整串跳過
//     ——第一輪掃到的是空白本文，之後再也不掃，招攬篇的錨點永遠看不到。
// ============================================================

test('F1：主文卡與回覆卡各有一顆 tag 時，主文卡那顆被沖掉仍要補回（不得被回覆卡那顆遮住）', async () => {
  // createPage() 預設用 MAIN_POSTS（末篇補了 LINE 錨點）→ 掃描必命中，主文
  // 卡掛上掃描的 tag；黑名單只放回覆者 → 回覆卡掛上查表的 tag。
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createPage(),
    local: { scamBlocklist: buildBlocklist({ authors: [[REPLY_ID, REPLY_HANDLE]] }) },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.hits().length, 1, '前提：這一串命中串文判定，送出一次 scam.hit');

  const cards = cardsOf(env);
  const main = cards[0];
  const reply = cards[cards.length - 1];
  assert.ok(
    reply.querySelector('a[href^="/@' + REPLY_HANDLE + '/post/"]'),
    '前提：最後一張是他人回覆的卡片'
  );
  assert.equal(tagsIn(main).length, 1, '前提：主文卡有掃描掛的那一顆');
  assert.equal(tagsIn(reply).length, 1, '前提：回覆者在黑名單，回覆卡有查表掛的那一顆');

  // React 重繪只沖掉主文卡那一顆；回覆卡那顆還在，全文件仍找得到 tag。
  const mainTag = tagsIn(main)[0];
  mainTag.parentNode.removeChild(mainTag);
  assert.equal(tagsIn(main).length, 0, '前提：主文卡的 tag 已被外力移除');
  assert.equal(env.tags().length, 1, '前提：頁面上仍有回覆卡那一顆');

  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    tagsIn(main).length,
    1,
    '別張卡上的 tag 不算主文卡的警示——主文卡那顆被沖掉就要補回來'
  );
  assert.equal(tagsIn(reply).length, 1, '回覆卡那顆不得被重複補掛');
  assert.equal(env.hits().length, 1, '補 tag 是頁面層的事，不得對 background 重送 scam.hit');
});

test('F1 連帶：掃描命中後使用者在選項頁解除，tag 被沖掉不得再補回', async () => {
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createPage(),
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(env.hits().length, 1, '前提：這一串命中串文判定');
  const main = cardsOf(env)[0];
  assert.equal(tagsIn(main).length, 1, '前提：主文卡已掛上掃描的 tag');

  // 選項頁按下「解除」：background 把作者寫進 allowlist，onChanged 送到。
  env.storage.emitChange(
    {
      scamBlocklist: {
        oldValue: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
        newValue: buildBlocklist({
          authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]],
          allowlist: [[POSTS[0].userId, AUTHOR]],
        }),
      },
    },
    'local'
  );
  await env.flush();

  const tag = tagsIn(main)[0];
  if (tag) tag.parentNode.removeChild(tag);
  assert.equal(env.tags().length, 0, '前提：頁面上已無任何 tag');

  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    tagsIn(main).length,
    0,
    '使用者已否決這個作者，補回只是還原上一輪判定，不得把警示重新掛上'
  );
  assert.equal(env.tags().length, 0, '整頁都不該再有警示');
  assert.equal(env.hits().length, 1, '解除之後也不得重送 scam.hit');
});

// 「容器先掛上、本文後補」的兩段式渲染：兩輪的容器組成（pathname ＋ code
// 集合）完全相同，只有本文從空白變成全文。
function createBodyStagedPage(bodies) {
  return [
    el(
      'div',
      { id: 'thread-root' },
      MAIN_POSTS.map((post, index) =>
        createPostContainer({
          handle: AUTHOR,
          code: post.code,
          body: bodies[index],
          actionRow: true,
        })
      )
    ),
  ];
}

test('S8：容器組成不變、本文由空白補成全文時要重掃並命中（冪等鍵不得只看容器 code）', async () => {
  // withoutSsr：SSR 也沒有 captionText，第一輪就只有空白本文可掃。
  const env = loadEnv({ page: createBodyStagedPage(MAIN_POSTS.map(() => '')) });
  await env.waitFor(() => env.detectCalls.length >= 1, { label: '第一輪判定' });

  assert.equal(env.detectCalls.length, 1, '前提：第一輪跑過一次判定');
  assert.equal(
    env.detectCalls[0].replace(/\s/g, ''),
    '',
    '前提：第一輪的本文全空（SSR 也沒有 caption 可補）'
  );
  assert.deepEqual(env.hits(), [], '前提：空白本文不會命中');
  assert.equal(env.tags().length, 0, '前提：第一輪沒有任何 tag');

  // 同樣六個容器、同樣的 code，只是本文渲染出來了。
  env.setPage(createBodyStagedPage(MAIN_POSTS.map((post) => post.captionText)));
  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 1, { label: '重掃命中後的 tag' });

  assert.ok(
    env.detectCalls.length >= 2,
    '容器組成相同不代表這一輪沒有新資訊——本文補上了就必須重掃'
  );
  assert.ok(
    env.detectCalls[env.detectCalls.length - 1].includes(SCAM_TAIL.trim()),
    '重掃時要掃到補上的招攬篇全文'
  );
  assert.equal(env.hits().length, 1, '重掃命中後要送出 scam.hit');
  assert.equal(env.tags().length, 1, '命中後主文卡要掛上一顆警示');
  assert.equal(tagsIn(cardsOf(env)[0]).length, 1, '那一顆掛在主文卡內');
});

// ============================================================
// 【第六波：SPA 由河道進詳情頁留下的隱藏舊層】
//
// staging 真機實測：從河道點卡片以 SPA 進入詳情頁時，Threads 不拆掉河道那
// 一層 DOM，而是把它留在文件裡（外層祖先帶 hidden 屬性＋display:none），再
// 把詳情頁那一層渲染在後面。於是文件中同時存在兩張 code 相同的主文卡：文
// 件序在前的是看不見的舊卡（沒有 box、高度 0），後面那張才是使用者真正看
// 到的主文卡。
//
// 【與實作的契約】掃描、補回、查表三條路都只認使用者看得到的那張卡：
//   容器收集：要濾掉隱藏子樹（自己或祖先帶 hidden 屬性、或 display:none）
//     內的容器，不能只憑文件序取第一個 code 相符者。
//   判定與冪等：本文擷取與冪等鍵只看可見卡——舊卡的殘影不得混進判定文字，
//     舊卡本文變動也不算新資訊、不該觸發重掃。
//   查表讓位：查表只對「掃描實際掛上的那一張」讓位；同 code 的隱藏舊卡不
//     算數，不得連可見卡一起讓掉，讓完就沒人掛了。
//
// 【假 DOM 的可見性】el() 補了 hidden 布林屬性與 getClientRects()／
// offsetParent／checkVisibility()，語意比照真實 DOM——[hidden] 的 UA 樣式是
// display:none，display:none 的整棵子樹都沒有 box。本段的前提斷言用這三支
// 確認「兩張同 code 的卡確實一隱一現」，受測行為本身只看 tag 掛在哪裡。
// ============================================================

// 隱藏舊卡的本文與詳情頁那張不同（河道卡只有摘要），用來驗判定文字取的是
// 哪一張。
const STALE_BODY = '河道卡片上的摘要：離職那年我把十年的維修筆記整理成一套選股流程…';

// 河道那一層被留在文件裡的形狀：外層祖先同時帶 hidden 屬性與行內
// display:none（實機兩者皆有），子樹本身結構完好，只是不渲染。
function createHiddenLayer(children) {
  const layer = el('div', { 'data-tcl-fake-stale-layer': 'true', hidden: '' }, children);
  layer.style.display = 'none';
  return layer;
}

// 詳情頁的 body 子節點：SSR script ＋ 隱藏的河道舊卡（與主文同 code、文件
// 序在前）＋ 正常的詳情頁容器樹。
function createHiddenRoutePage(options) {
  const settings = options || {};
  const posts = settings.posts || MAIN_POSTS;
  const children = [];
  if (!settings.withoutSsr) children.push(createSsrScript(posts[0]));
  children.push(
    createHiddenLayer([
      createPostContainer({
        handle: AUTHOR,
        code: posts[0].code,
        body: settings.staleBody === undefined ? STALE_BODY : settings.staleBody,
        actionRow: true,
        dirAutoTimestamp: true,
      }),
    ])
  );
  children.push(createScanDom(posts));
  return children;
}

function staleCardOf(env) {
  return env.document.querySelector(
    '[data-tcl-fake-stale-layer="true"] ' + CONTAINER_SELECTOR
  );
}

// 使用者看得到的卡片（依文件序）。測試自己用 closest('[hidden]') 判斷，不
// 預設實作採哪一種判準。
function visibleCardsOf(env) {
  return cardsOf(env).filter((card) => !card.closest('[hidden]'));
}

function permalinkCodeOf(card) {
  const anchors = card.querySelectorAll('a[href]');
  for (const anchor of anchors) {
    const match = /\/post\/([A-Za-z0-9_-]+)/.exec(anchor.getAttribute('href') || '');
    if (match) return match[1];
  }
  return null;
}

// 兩張同 code 的卡片確實一隱一現——假 DOM 真的表達得出這件事，紅燈才落在
// 受測行為上，而不是假件自己不成立。
function assertHiddenRouteShape(env) {
  const stale = staleCardOf(env);
  const main = visibleCardsOf(env)[0];
  assert.ok(stale, '前提：文件裡留著河道那一層的舊卡');
  assert.ok(main, '前提：文件裡有使用者看得到的主文卡');
  assert.equal(permalinkCodeOf(stale), permalinkCodeOf(main), '前提：兩張卡的貼文代碼相同');
  assert.equal(cardsOf(env).indexOf(stale), 0, '前提：隱藏舊卡的文件序在可見主文卡之前');
  assert.ok(stale.closest('[hidden]'), '前提：舊卡落在 hidden 子樹內');
  assert.equal(stale.getClientRects().length, 0, '前提：隱藏舊卡沒有 box');
  assert.equal(stale.offsetParent, null, '前提：隱藏舊卡沒有 offsetParent');
  assert.equal(stale.checkVisibility(), false, '前提：隱藏舊卡不可見');
  assert.equal(main.getClientRects().length, 1, '前提：可見主文卡有 box');
  assert.equal(main.checkVisibility(), true, '前提：可見主文卡可見');
  return { stale, main };
}

test('隱藏舊卡 1：掃描命中的 tag 要掛在可見主文卡，不得掛進 hidden 子樹', async () => {
  const env = loadEnv({ page: createHiddenRoutePage() });
  await env.waitFor(() => env.hits().length === 1 && env.tags().length === 1, {
    label: '掃描的 scam.hit 與 tag',
  });

  const { stale, main } = assertHiddenRouteShape(env);
  assert.equal(env.hits().length, 1, '前提：這一串命中串文判定，送出一則 scam.hit');

  assert.equal(
    tagsIn(main).length,
    1,
    '警示要掛在使用者看得到的那張主文卡上，掛進隱藏舊卡等於沒掛'
  );
  assert.equal(tagsIn(stale).length, 0, '隱藏舊卡不得掛 tag');
  assert.equal(env.tags().length, 1, '整頁只掛一顆');
});

test('隱藏舊卡 2：tag 被沖掉後補回的也是可見主文卡', async () => {
  const env = loadEnv({ page: createHiddenRoutePage() });
  await env.waitFor(() => env.tags().length === 1, { label: '第一輪的 tag' });

  env.tags().forEach((tag) => tag.parentNode.removeChild(tag));
  assert.equal(env.tags().length, 0, '前提：頁面上的 tag 已被外力沖掉');

  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 1, { label: '補回來的 tag' });

  const { stale, main } = assertHiddenRouteShape(env);
  assert.equal(tagsIn(main).length, 1, '補回的那一顆同樣要落在可見主文卡上');
  assert.equal(tagsIn(stale).length, 0, '補回不得補到隱藏舊卡');
  assert.equal(env.tags().length, 1, '補回之後整頁仍只有一顆');
  assert.equal(env.hits().length, 1, '補 tag 不得重送 scam.hit');
});

test('隱藏舊卡 3：查表只對掃描實際掛上的那一張讓位，可見主文卡不得兩頭落空', async () => {
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: createHiddenRoutePage(),
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
  });
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => env.hits().length === 1 && env.tags().length === 1, {
    label: '掃描的 scam.hit 與可見主文卡的 tag',
  });

  const { stale, main } = assertHiddenRouteShape(env);
  assert.equal(env.hits().length, 1, '前提：這一串命中串文判定');

  assert.equal(
    tagsIn(main).length,
    1,
    '作者已在名單、串文也命中時，可見主文卡至少要有一顆（掃描或查表掛的都算）'
  );
  assert.equal(tagsIn(stale).length, 0, '隱藏舊卡不得掛 tag');
  assert.equal(env.tags().length, 1, '同一串上不得出現第二顆');
});

test('隱藏舊卡 4：判定文字與冪等鍵只看可見卡，舊卡的殘影不得混進來', async () => {
  const env = loadEnv({ page: createHiddenRoutePage() });
  await env.flush();

  assertHiddenRouteShape(env);
  assert.equal(env.detectCalls.length, 1, '前提：只跑過一輪判定');

  const scanned = env.detectCalls[env.detectCalls.length - 1];
  assert.ok(
    scanned.includes(SCAM_TAIL.trim()),
    'buildThreadText 走的是可見卡，末篇的招攬行必須在判定文字裡'
  );
  assert.ok(!scanned.includes(STALE_BODY), '隱藏舊卡的摘要不得混進判定文字');
  assert.equal(scanned, EXPECTED_THREAD_TEXT, '判定文字剛好是可見的六篇');

  // 冪等鍵同理：舊卡的本文再怎麼變都不是新資訊，不該害整串重掃。
  const staleBody = staleCardOf(env)
    .querySelectorAll('[dir="auto"]')
    .find((node) => node.textContent.indexOf(STALE_BODY) === 0);
  assert.ok(staleBody, '前提：找得到隱藏舊卡的本文節點');
  staleBody.textContent = STALE_BODY + '（河道版摘要又被改寫了一次）';

  env.triggerObserver();
  await env.flush();

  assert.equal(env.detectCalls.length, 1, '隱藏舊卡的本文變動不得改變冪等鍵、觸發重掃');
  assert.equal(env.hits().length, 1, '更不得重送 scam.hit');
  assert.equal(env.tags().length, 1, '整頁仍只有一顆 tag');
});

test('隱藏舊卡 5：河道查表跳過隱藏子樹裡的卡片，只標使用者看得到的那張', async () => {
  const code = 'DxSyNtH0009';
  const body = '河道上的一則貼文，作者已在本機黑名單裡。';
  const stale = createPostContainer({
    handle: BLOCKED_HANDLE,
    code,
    body,
    actionRow: true,
    dirAutoTimestamp: true,
  });
  const visible = createPostContainer({
    handle: BLOCKED_HANDLE,
    code,
    body,
    actionRow: true,
    dirAutoTimestamp: true,
  });
  const root = el('div', { id: 'feed-root' }, [createHiddenLayer([stale]), visible]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => tagsIn(visible).length === 1, { label: '可見卡的查表 tag' });

  assert.ok(stale.closest('[hidden]'), '前提：舊卡落在 hidden 子樹內');
  assert.equal(stale.getClientRects().length, 0, '前提：隱藏舊卡沒有 box');
  assert.equal(visible.getClientRects().length, 1, '前提：可見卡有 box');

  assert.equal(tagsIn(visible).length, 1, '看得到的那張要掛 tag');
  assert.equal(tagsIn(stale).length, 0, '隱藏子樹裡的卡片不得掛 tag');
  assert.equal(env.tags().length, 1, '整頁只有一顆');
});

// ============================================================
// 【第六波：SPA 返回河道與讓位雙判準】
//
// SPA 換頁不重載腳本，詳情頁掃描認領的主文卡（claimedMainCode／
// claimedMainContainer）會一路跟著使用者回到河道。同一篇貼文在河道層與詳
// 情層各有一張卡、是兩個不同節點，只比 code 的讓位會把河道那張也讓掉，使
// 用者剛把作者送進黑名單、回到河道卻什麼都看不到。
//
// 【與實作的契約】
//   讓位雙判準：查表對「掃描認領的那一張容器」讓位；認領的容器缺席——掃描
//     那一輪沒收到節點，或節點已被 React 換掉——才退回比 code。
//   離開詳情頁：readPathInfo() 回 null 時鬆開認領，但不清 lastScan——返回
//     同一篇時冪等鍵照樣命中，不得重送 scam.hit。
// ============================================================

// 收起／攤開一層路由：實機的隱藏層同時帶 hidden 屬性與行內 display:none。
function setLayerHidden(layer, hidden) {
  if (hidden) {
    layer.setAttribute('hidden', '');
    layer.style.display = 'none';
  } else {
    layer.removeAttribute('hidden');
    layer.style.display = '';
  }
}

// SPA 的兩層路由：河道層與詳情層各是一棵子樹，同一篇貼文在兩層各有一張卡
// ——貼文代碼相同、節點不同。初始狀態停在詳情頁（河道層收起來）。
function createTwoLayerRoute(options) {
  const settings = options || {};
  const posts = settings.posts || MAIN_POSTS;
  const feedCard = createPostContainer({
    handle: AUTHOR,
    code: posts[0].code,
    body: STALE_BODY,
    actionRow: true,
    actionRowCounts: F1_COUNTS,
    dirAutoTimestamp: true,
  });
  const feedLayer = el('div', { id: 'feed-layer' }, [feedCard, createFeedCard(NEUTRAL_HANDLE)]);
  const detailLayer = el('div', { id: 'detail-layer' }, [createScanDom(posts)]);
  setLayerHidden(feedLayer, true);
  return {
    children: [createSsrScript(posts[0]), feedLayer, detailLayer],
    feedLayer,
    detailLayer,
    feedCard,
  };
}

// 從詳情頁返回河道：收起詳情層、攤開河道層，並把詳情層那一顆 tag 當成被
// React 沖掉拿掉——留著的話「整頁的 tag 都看得見」這條斷言驗不出新掛的那
// 一顆掛在哪裡。
function goBackToFeed(env, route) {
  env.tags().forEach((tag) => tag.parentNode.removeChild(tag));
  env.setPathname(FEED_PATH);
  setLayerHidden(route.detailLayer, true);
  setLayerHidden(route.feedLayer, false);
  env.triggerObserver();
}

function hiddenTagsOf(env) {
  return env.tags().filter((tag) => tag.closest('[hidden]'));
}

test('返回河道：詳情頁命中寫入名單後切回河道，同一篇的河道卡要掛上查表 tag', async () => {
  const route = createTwoLayerRoute();
  const env = loadFeedEnv({ pathname: DETAIL_PATH, page: route.children, local: {} });

  await env.waitFor(() => env.tags().length === 1, { label: '詳情頁主文卡的掃描 tag' });
  assert.equal(env.hits().length, 1, '前提：這一串命中串文判定，送出一則 scam.hit');
  assert.equal(tagsIn(route.feedCard).length, 0, '前提：收起來的河道卡還沒有 tag');

  // background 寫好名單後廣播：在此之前查表沒有任何可查的作者。
  env.storage.emitChange(
    {
      scamBlocklist: {
        oldValue: undefined,
        newValue: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
      },
    },
    'local'
  );
  await env.flush();

  goBackToFeed(env, route);
  await env.waitFor(() => tagsIn(route.feedCard).length === 1, { label: '河道卡的查表 tag' });

  assert.equal(
    tagsIn(route.feedCard)[0].getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '河道卡上的那一顆來自查表，說的是「這個帳號在你的黑名單中」'
  );
  assert.equal(env.hits().length, 1, '回到河道不掃描，不得再送 scam.hit');
  assert.deepEqual(hiddenTagsOf(env), [], '整頁的 tag 不得落在收起來的路由層裡');
  assert.equal(env.tags().length, 1, '整頁只有河道卡那一顆');
});

test('返回河道：認領不到容器時，陳舊的 code 不得讓掉河道上同一篇的卡片', async () => {
  const posts = MAIN_POSTS;
  const feedCard = createPostContainer({
    handle: AUTHOR,
    code: posts[0].code,
    body: STALE_BODY,
    actionRow: true,
    actionRowCounts: F1_COUNTS,
    dirAutoTimestamp: true,
  });
  const feedLayer = el('div', { id: 'feed-layer' }, [feedCard]);
  setLayerHidden(feedLayer, true);
  // 主文卡整個缺席（虛擬化捲動把它回收掉）：掃描由 SSR 補上第一篇的本文，
  // 認領得到 code 卻認領不到容器，讓位只剩比 code 這條路。
  const detailRoot = createScanDom(posts);
  detailRoot.removeChild(detailRoot.children[0]);
  const detailLayer = el('div', { id: 'detail-layer' }, [detailRoot]);

  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: [createSsrScript(posts[0]), feedLayer, detailLayer],
    local: { scamBlocklist: buildBlocklist() },
  });
  await env.waitFor(() => env.hits().length === 1, { label: '詳情頁送出的 scam.hit' });
  // hits 在送出當下就記了一筆，掛 tag 要等回應回呼；等整條鏈結算完，「沒有
  // 容器可掛」這條前提才問得準。
  await env.flush();
  assert.equal(env.tags().length, 0, '前提：主文卡缺席，掃描的 tag 沒有容器可掛');

  env.setPathname(FEED_PATH);
  setLayerHidden(detailLayer, true);
  setLayerHidden(feedLayer, false);
  env.triggerObserver();

  await env.waitFor(() => tagsIn(feedCard).length === 1, { label: '河道卡的查表 tag' });
  assert.equal(
    tagsIn(feedCard)[0].getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '河道卡上的那一顆來自查表'
  );
  assert.equal(env.tags().length, 1, '整頁只有河道卡那一顆');
});

test('返回同一篇詳情頁：不重送 scam.hit、不重跑判定，tag 補回可見主文卡', async () => {
  const route = createTwoLayerRoute();
  const env = loadEnv({ pathname: DETAIL_PATH, page: route.children });

  await env.waitFor(() => env.tags().length === 1, { label: '詳情頁主文卡的掃描 tag' });
  assert.equal(env.hits().length, 1, '前提：第一次進來送出一則 scam.hit');

  goBackToFeed(env, route);
  await env.flush();

  // 再點回同一篇：DOM 與離開前同一棵，冪等鍵不變。
  env.setPathname(DETAIL_PATH);
  setLayerHidden(route.feedLayer, true);
  setLayerHidden(route.detailLayer, false);
  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 1, { label: '補回主文卡的 tag' });

  const mainCard = route.detailLayer.querySelectorAll(CONTAINER_SELECTOR)[0];
  assert.equal(tagsIn(mainCard).length, 1, 'tag 要補回使用者看得到的主文卡');
  assert.equal(
    tagsIn(mainCard)[0].getAttribute('title'),
    TAG_TOOLTIP,
    '補回的是掃描那一顆，不是查表那一顆'
  );
  assert.equal(env.hits().length, 1, '返回同一篇不得重送 scam.hit（lastScan 不得被清掉）');
  assert.equal(env.detectCalls.length, 1, '冪等鍵不變，不得重跑判定');
  assert.deepEqual(hiddenTagsOf(env), [], '整頁的 tag 不得落在收起來的路由層裡');
});

test('讓位：認領的容器被 React 換掉後，同 code 的新容器照樣讓位給掃描的 tag', async () => {
  const posts = MAIN_POSTS;
  const detailRoot = createScanDom(posts);
  let replacement = null;

  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: [createSsrScript(posts[0]), detailRoot],
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
    // 回應是同步算出、下一個 tick 才回呼的：在這裡換掉主文卡，等於 React
    // 在「掃描已認領、tag 還沒掛上」的空窗期把那張卡重繪成新節點。
    respond(message) {
      if (message && message.type === 'scam.hit' && !replacement) {
        const stale = detailRoot.children[0];
        replacement = createPostContainer({
          handle: AUTHOR,
          code: posts[0].code,
          body: withBadge(posts[0].captionText, posts[0].position, posts.length),
          actionRow: true,
        });
        detailRoot.insertBefore(replacement, stale);
        detailRoot.removeChild(stale);
      }
      return { ok: true, added: true, entry: { handle: AUTHOR } };
    },
  });

  await env.waitFor(() => env.hits().length === 1, { label: '詳情頁送出的 scam.hit' });
  assert.ok(replacement, '前提：主文卡已被換成新節點');
  assert.equal(replacement.parentElement, detailRoot, '前提：新節點就位');

  // 回呼落地就要把 tag 掛上換上來的那一張：不靠測試再觸發一次 observer——真
  // 實頁面上下一次觸發不知道什麼時候來，這段空窗使用者看到的是整頁零警示。
  await env.waitFor(() => tagsIn(replacement).length === 1, {
    label: '回呼落地後新主文卡的 tag',
  });

  assert.equal(
    tagsIn(replacement)[0].getAttribute('title'),
    TAG_TOOLTIP,
    '換上來的主文卡要拿到掃描那一顆（資訊量較大的 scamTagTooltip），不得被查表先佔位'
  );
  assert.equal(env.tags().length, 1, '整頁只有那一顆');

  env.triggerObserver();
  await env.flush();

  assert.equal(tagsIn(replacement).length, 1, '後續觸發不得越掛越多');
  assert.equal(env.tags().length, 1, '整頁仍只有那一顆');
  assert.equal(env.hits().length, 1, '換節點不得重送 scam.hit');
});

// staging 實測：河道卡掛上查表 tag、進了 taggedContainers 之後，從它點進詳
// 情頁，Threads 把河道那一層原地收起來——同一個節點，只是不再渲染。補回捷
// 徑若排在可見性檢查之前，「標過」的記憶就會讓它在看不見的地方無條件重掛，
// 隱藏層因此長出一顆查表 tag（手動刪掉後 200ms 內又長回來，MutationObserver
// 證實是新插入的節點）。
test('查表補回：卡片被收進隱藏層後，「標過」的記憶不得在看不見的地方把 tag 長回來', async () => {
  const card = createFeedCard(BLOCKED_HANDLE);
  const feedLayer = el('div', { id: 'feed-layer' }, [card]);
  const env = loadFeedEnv({ page: [feedLayer], local: { scamBlocklist: buildBlocklist() } });

  await env.waitFor(() => tagsIn(card).length === 1, { label: '河道卡的查表 tag' });
  const code = permalinkCodeOf(card);
  assert.ok(code, '前提：河道卡讀得到貼文代碼');

  // 點進這張卡：河道層原地收起來（同一個節點），詳情層還沒渲染出來。
  setLayerHidden(feedLayer, true);
  env.setPathname(`/@${BLOCKED_HANDLE}/post/${code}`);
  tagsIn(card).forEach((tag) => tag.parentNode.removeChild(tag));
  assert.equal(env.tags().length, 0, '前提：收起來那張卡上的 tag 已被拿掉');

  env.triggerObserver();
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(tagsIn(card).length, 0, '看不見的卡片不得被補回 tag');
  assert.deepEqual(hiddenTagsOf(env), [], '隱藏子樹裡不得長出任何 tag');
  assert.equal(env.tags().length, 0, '整頁一顆都不該有');

  // 返回河道：同一張卡變回可見，補回捷徑要照常運作。
  env.setPathname(FEED_PATH);
  setLayerHidden(feedLayer, false);
  env.triggerObserver();
  await env.waitFor(() => tagsIn(card).length === 1, { label: '變回可見後補回的 tag' });

  assert.equal(
    tagsIn(card)[0].getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '補回的仍是查表那一顆'
  );
  assert.equal(env.tags().length, 1, '整頁只有那一顆');
});

test('往返：河道標過的同一篇，進詳情頁補回的是掃描那一顆，不是查表那一顆', async () => {
  const route = createTwoLayerRoute();
  setLayerHidden(route.feedLayer, false);
  setLayerHidden(route.detailLayer, true);
  const env = loadFeedEnv({
    pathname: FEED_PATH,
    page: route.children,
    local: {
      scamBlocklist: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
    },
  });

  await env.waitFor(() => tagsIn(route.feedCard).length === 1, { label: '河道卡的查表 tag' });
  assert.equal(
    tagsIn(route.feedCard)[0].getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '前提：河道那張先拿到查表 tag'
  );

  // 點進這一篇：河道層原地收起來（內容由 React 卸載，插進去的 tag 跟著消
  // 失），詳情層攤開。
  tagsIn(route.feedCard).forEach((tag) => tag.parentNode.removeChild(tag));
  env.setPathname(DETAIL_PATH);
  setLayerHidden(route.feedLayer, true);
  setLayerHidden(route.detailLayer, false);
  env.triggerObserver();

  const mainCard = route.detailLayer.querySelectorAll(CONTAINER_SELECTOR)[0];
  await env.waitFor(() => tagsIn(mainCard).length === 1, { label: '主文卡的掃描 tag' });
  assert.equal(env.hits().length, 1, '詳情頁這一串命中，送出一則 scam.hit');
  assert.equal(
    tagsIn(mainCard)[0].getAttribute('title'),
    TAG_TOOLTIP,
    '作者已在名單、串文也命中時，主文卡要拿到資訊量較大的掃描那一顆'
  );

  // React 沖掉主文卡那一顆：補回的仍要是掃描那一顆，查表不得趁隙頂上。
  tagsIn(mainCard).forEach((tag) => tag.parentNode.removeChild(tag));
  env.triggerObserver();
  await env.waitFor(() => tagsIn(mainCard).length === 1, { label: '補回主文卡的 tag' });

  assert.equal(
    tagsIn(mainCard)[0].getAttribute('title'),
    TAG_TOOLTIP,
    '補回的是 scamTagTooltip，不是查表的 scamBlockedByList'
  );
  assert.equal(tagsIn(route.feedCard).length, 0, '收起來的河道卡不得被補回查表 tag');
  assert.deepEqual(hiddenTagsOf(env), [], '隱藏層裡不得有任何 tag');
  assert.equal(env.tags().length, 1, '整頁只有主文卡那一顆');
});

test('過期回呼：回應落地前整輪已經重掃，舊回呼不得補掛警示、不得釘住認領', async () => {
  const posts = MAIN_POSTS;
  const detailRoot = createScanDom(posts);
  const env = loadFeedEnv({
    pathname: DETAIL_PATH,
    page: [createSsrScript(posts[0]), detailRoot],
    // 回應晚於掃描的 debounce（60ms）才撐得開「送出後、回應落地前」那段
    // 窗口——真實的 chrome.runtime 往返本來就可能比一次重掃還久。
    respondDelayMs: 400,
  });

  await env.waitFor(() => env.hits().length === 1, { label: '第一輪送出的 scam.hit' });
  assert.equal(env.tags().length, 0, '前提：回應還在路上，tag 還沒掛上');

  // 回應還沒回來，本文先被改寫（展開長文、載入翻譯都會這樣）：冪等鍵換一
  // 把、整輪重跑，而這一次的全文沒有招攬錨點，判定不命中。
  const last = posts[posts.length - 1];
  const bodyNode = detailRoot.children[posts.length - 1]
    .querySelectorAll('[dir="auto"]')
    .find((node) => node.textContent === last.captionText);
  assert.ok(bodyNode, '前提：找得到末篇的本文節點');
  bodyNode.textContent = POSTS[POSTS.length - 1].captionText;

  env.triggerObserver();
  await env.waitFor(() => env.detectCalls.length === 2, { label: '改寫後的重掃' });
  assert.equal(
    TCLCore.detectScamPitch(env.detectCalls[1]).hit,
    false,
    '前提：改寫後的全文不再命中'
  );

  // 舊回呼這時才落地。
  await env.waitFor(() => env.replies.length === 1, { label: '第一輪回應落地' });

  assert.equal(env.tags().length, 0, '當下的判定不命中，過期回呼不得補掛警示');
  assert.deepEqual(env.toastTexts(), [], '過期回呼不得跳 toast');
  assert.equal(env.hits().length, 1, '重掃未命中，不再送 scam.hit');

  // 認領也不得被過期回呼釘住：作者進名單後，主文卡要由查表掛上 LIST tag，
  // 而不是被一顆早該作廢的認領讓掉。
  env.storage.emitChange(
    {
      scamBlocklist: {
        oldValue: undefined,
        newValue: buildBlocklist({ authors: [[POSTS[0].userId, AUTHOR, DISPLAY_NAME]] }),
      },
    },
    'local'
  );
  await env.waitFor(() => env.tags().length === 1, { label: '查表掛上的 tag' });

  assert.equal(
    env.tags()[0].getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '主文卡要拿得到查表那一顆，不得被過期回呼留下的認領讓掉'
  );
  assert.equal(
    env.tags()[0].closest(CONTAINER_SELECTOR),
    detailRoot.children[0],
    'tag 要落在主文卡上'
  );
});

// ============================================================
// 【第五波：警示 tag 改掛作者列】（車道 feat/scam-tag-authorrow）
//
// 使用者裁決：tag 從貼文卡的「互動列上方」移到「作者列時間右邊」——詳情頁
// 掃描那顆與河道查表那顆同一個落點。找不到可用的時間連結才退回互動列上
// 方。
//
// 【與實作的契約】
//   1. insertTag 先取容器內的 <time> → closest('a')，且這個 <a> 的
//      closest(CONTAINER_SELECTOR) 必須是本容器、href 的 code 與本卡
//      permalink 相同。成立就從這個 <a> 往上走「父層只有我這一個元素子節
//      點」的祖先（最多 4 層、不越過容器），停在最外層那一顆並 append 進
//      去——實機量到的 gap 6px 那一層；<a> 的父層本來就有別的元素子節點時
//      退回插在 <a> 之後。tag 改用 <span>（inline），class、role="note"、
//      title 與 textContent 都不變。
//   2. 取不到 <time>，或它的連結不屬於本卡（引用卡、轉發標頭那種指向別篇
//      的時間）→ 退回既有邏輯：互動列上方的 <div>；互動列也找不到才掛容
//      器末端。
//   3. 河道查表（scamBlockedByList）與詳情頁掃描共用這一套落點。
//   4. 冪等不變，補回路徑（掃描的冪等短路、查表的 taggedContainers）補回
//      來的落點與第一次一致。
//   5. 落點那層是 overflow:hidden、高 21px，13px 字級配 1px 上下內距量到
//      20.04px 放得下，因此沿用原尺寸的 13px；退回路徑的 <div> 用更具體的
//      選擇器維持原本的內距與上下間距，配色不變。
// ============================================================

function authorRowOf(card) {
  return card.querySelectorAll('div[data-tcl-fake-author-row]')[0] || null;
}

// 容器內文件序第一顆 <time> 所在的 <a>。
function timeAnchorOf(card) {
  const time = card.querySelector('time');
  return time ? time.closest('a') : null;
}

// 「互動列上方」那個落點上的 tag：與互動列同一層、文件序排在它之前。
function tagsAboveActionRow(card) {
  const row = card.querySelectorAll('div[data-tcl-fake-action-row]')[0];
  if (!row || !row.parentElement) return [];
  const siblings = row.parentElement.childNodes;
  return siblings
    .slice(0, siblings.indexOf(row))
    .filter(
      (node) => node.nodeType === 1 && node.classList && node.classList.contains(TAG_CLASS)
    );
}

// 切出單一 CSS 規則的宣告區段，找不到回傳 null。逐段比對才分得清「作者列
// 那顆」與「退回路徑那顆」各自寫了什麼——整份字串做 indexOf 時，兩條規則
// 任一邊出現的值都會讓斷言過關。選擇器前緣限定在字串開頭或 `}`／`;` 之
// 後，`.tcl-scam-tag` 才不會誤配到 `div.tcl-scam-tag` 的尾段。
function ruleBody(css, selector) {
  const pattern = new RegExp('(?:^|[};])' + selector.replace(/\./g, '\\.') + '\\{([^}]*)\\}');
  const match = pattern.exec(css);
  return match ? match[1] : null;
}

// 時間那一支最外層的單子節點祖先（divC，量到 gap 6px 的那一層）：它是作者
// 列的子節點，往下一路單傳到時間連結。
function timeGapRowOf(card) {
  return card.querySelectorAll('div[data-tcl-fake-time-gap-row]')[0] || null;
}

// 「tag 就在時間右邊」：tag 被 append 進 divC 的末尾，靠 row 的 6px gap 與
// 時間隔開，不落進時間的行盒、也不動到作者名與「⋯」。
function assertTagAfterTime(card, tag, label) {
  const row = authorRowOf(card);
  const anchor = timeAnchorOf(card);
  const gapRow = timeGapRowOf(card);
  assert.ok(row && anchor && gapRow, `${label}：前提——這張卡有作者列與自己的時間連結`);
  assert.equal(anchor.closest(CONTAINER_SELECTOR), card, `${label}：前提——時間連結屬於本卡`);
  assert.equal(gapRow.parentElement, row, `${label}：前提——gap 那一層是作者列的子節點`);
  assert.equal(tag.parentNode, gapRow, `${label}：tag 應掛進 gap 6px 那一層`);
  assert.equal(gapRow.lastElementChild, tag, `${label}：tag 應 append 在該層末尾`);
  assert.equal(tag.tagName, 'SPAN', `${label}：作者列上的 tag 是 inline 的 <span>`);
  assert.equal(tagsAboveActionRow(card).length, 0, `${label}：互動列上方不得再留一顆`);
}

test('作者列 1：詳情頁掃描命中時，tag 插在主文卡作者列的時間連結右邊', async () => {
  const env = loadEnv();
  await env.waitFor(() => env.tags().length === 1, { label: '掃描掛上的 tag' });

  const tag = env.tags()[0];
  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  assert.equal(tag.closest(CONTAINER_SELECTOR), mainCard, 'tag 應落在 position 1 的主文卡');
  assertTagAfterTime(mainCard, tag, '掃描 tag');

  assert.equal(tag.getAttribute('role'), 'note', '換了元素與落點，無障礙語意不變');
  assert.equal(tag.textContent, TAG_LABEL, '文案不變');
  assert.equal(tag.getAttribute('title'), TAG_TOOLTIP, 'title 不變');
});

test('作者列 2：河道查表的 tag 落在同一個位置（作者列時間右邊）', async () => {
  const hitCard = createFeedCard(BLOCKED_HANDLE, null, { dirAutoTimestamp: false });
  const root = el('div', { id: 'feed-root' }, [
    hitCard,
    createFeedCard(NEUTRAL_HANDLE, null, { dirAutoTimestamp: false }),
  ]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.waitFor(() => env.tags().length === 1, { label: '查表掛上的 tag' });

  const tag = env.tags()[0];
  assert.equal(tag.closest(CONTAINER_SELECTOR), hitCard, 'tag 要掛在命中的那張卡內');
  assert.equal(
    tag.getAttribute('title'),
    BLOCKED_BY_LIST_TITLE,
    '河道那顆說的仍是「這個帳號在你的黑名單中」'
  );
  assertTagAfterTime(hitCard, tag, '查表 tag');
});

test('作者列 3：外層卡與引用卡都有 <time> 時，只認外層卡自己那一顆', async () => {
  const quote = createPostContainer({
    handle: 'quoted.person',
    code: 'DqUoTeD001',
    body: '被引用的原文，時間戳記同樣是 <time>。',
  });
  const env = loadEnv({
    page: createDecoratedPage(MAIN_POSTS, (index) =>
      index === 0 ? { dirAutoTimestamp: false, extraChildren: [quote] } : null
    ),
  });
  await env.waitFor(() => env.tags().length === 1, { label: '掃描掛上的 tag' });

  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  assert.ok(quote.querySelector('time'), '前提：引用卡自己也有 <time>');
  assert.equal(
    mainCard.querySelectorAll('time').length,
    2,
    '前提：外層卡的後代裡有兩顆 <time>（自己的＋引用卡的）'
  );

  const tag = env.tags()[0];
  assertTagAfterTime(mainCard, tag, '引用卡外層的掃描 tag');
  assert.equal(quote.querySelectorAll('.' + TAG_CLASS).length, 0, 'tag 不得掉進引用卡裡');
});

test('作者列 4：容器沒有 <time>（廣告卡形狀）時，退回互動列上方的 <div>', async () => {
  const env = loadEnv({ page: createDecoratedPage(MAIN_POSTS) });
  await env.waitFor(() => env.tags().length === 1, { label: '掃描掛上的 tag' });

  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  assert.equal(
    mainCard.querySelectorAll('time').length,
    0,
    '前提：時間戳記是 [dir="auto"] span，整張卡沒有 <time>'
  );

  const tag = env.tags()[0];
  assert.equal(tag.tagName, 'DIV', '退回路徑維持原本的區塊級 <div>');
  assert.deepEqual(tagsAboveActionRow(mainCard), [tag], 'tag 回到互動列上方、與互動列同一層');

  const row = mainCard.querySelectorAll('div[data-tcl-fake-action-row]')[0];
  const order = documentOrder(mainCard);
  assert.ok(
    order.indexOf(tag) < order.indexOf(row),
    'tag 的文件序仍早於互動列（既有「插在互動列上方」的語意在退回路徑上保留）'
  );
  assert.equal(tag.closest('div[data-tcl-fake-action-row]'), null, 'tag 不得塞進互動列內部');
});

test('作者列 5：<time> 的連結指向別篇（轉發標頭）時不採用，退回互動列上方', async () => {
  const env = loadEnv({
    page: createDecoratedPage(MAIN_POSTS, (index) =>
      index === 0 ? { foreignTimeLink: { handle: 'repost.origin', code: 'DxOtHeR001' } } : null
    ),
  });
  await env.waitFor(() => env.tags().length === 1, { label: '掃描掛上的 tag' });

  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  const anchor = timeAnchorOf(mainCard);
  assert.equal(
    anchor.getAttribute('href'),
    '/@repost.origin/post/DxOtHeR001',
    '前提：容器內唯一的 <time> 掛在指向別篇的連結上'
  );

  const tag = env.tags()[0];
  assert.equal(
    anchor.parentElement.querySelectorAll('.' + TAG_CLASS).length,
    0,
    '別篇的時間右邊不得掛上本卡的警示'
  );
  assert.equal(tag.tagName, 'DIV', '退回路徑維持原本的區塊級 <div>');
  assert.deepEqual(tagsAboveActionRow(mainCard), [tag], 'tag 應退回互動列上方');
});

test('作者列 6：掃描的 tag 被外力沖掉後，補回的落點仍在時間連結右邊', async () => {
  const env = loadEnv();
  await env.waitFor(() => env.tags().length === 1, { label: '第一輪的 tag' });

  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  const first = env.tags()[0];
  first.parentNode.removeChild(first);
  assert.equal(env.tags().length, 0, '前提：tag 已被外力移除');

  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 1, { label: '補回來的 tag' });

  assertTagAfterTime(mainCard, env.tags()[0], '補回的掃描 tag');
  assert.equal(env.hits().length, 1, '補 tag 不得對 background 重送 scam.hit');
});

test('作者列 7：查表的 tag 被外力沖掉後，補回的落點仍在時間連結右邊', async () => {
  const hitCard = createFeedCard(BLOCKED_HANDLE, null, { dirAutoTimestamp: false });
  const root = el('div', { id: 'feed-root' }, [hitCard]);
  const env = loadFeedEnv({ page: [root], local: { scamBlocklist: buildBlocklist() } });
  await env.waitFor(() => env.tags().length === 1, { label: '第一輪的查表 tag' });

  const first = env.tags()[0];
  first.parentNode.removeChild(first);
  assert.equal(env.tags().length, 0, '前提：tag 已被外力移除');

  env.triggerObserver();
  await env.waitFor(() => env.tags().length === 1, { label: '補回來的查表 tag' });

  assertTagAfterTime(hitCard, env.tags()[0], '補回的查表 tag');
  assert.deepEqual(env.sent, [], '查表補回照樣不得送訊息');
});

test('作者列 8：.tcl-scam-tag 沿用原本的 13px，靠內距收進 21px 的行高', async () => {
  const env = loadEnv();
  await env.waitFor(() => env.tags().length === 1, { label: '掃描掛上的 tag' });

  const style = env.document.getElementById(STYLE_ID);
  assert.ok(style, '命中時應注入樣式節點');
  const css = style.textContent;
  const base = ruleBody(css, '.' + TAG_CLASS);
  const fallback = ruleBody(css, 'div.' + TAG_CLASS);
  assert.ok(base, '樣式應含 .tcl-scam-tag 規則');
  assert.ok(fallback, '樣式應含 div.tcl-scam-tag 這條退回路徑的覆寫');

  assert.ok(
    base.indexOf('font-size:13px') !== -1,
    '作者列那顆的字級沿用原本 pill 的 13px（量到 20.04px，21px 的行高放得下）'
  );
  assert.ok(
    base.indexOf('padding:1px 8px') !== -1,
    '落點那層是 overflow:hidden、高 21px，內距要收到 1px 8px 才不被切掉'
  );
  assert.ok(
    fallback.indexOf('padding:4px 10px') !== -1,
    '退回路徑的區塊級 tag 覆寫回原本的 4px 10px'
  );
  assert.ok(
    base.indexOf('var(--tcl-warn-fg') !== -1 && base.indexOf('var(--tcl-warn-bg') !== -1,
    '配色仍走 --tcl-warn-* 變數'
  );
});

test('作者列 9：<a> 的父層已有其他元素子節點時，tag 退回插在 <a> 之後', async () => {
  const env = loadEnv({
    page: createDecoratedPage(MAIN_POSTS, (index) =>
      index === 0 ? { bareTimeLink: true, dirAutoTimestamp: false } : null
    ),
  });
  await env.waitFor(() => env.tags().length === 1, { label: '掃描掛上的 tag' });

  const mainCard = env.document.querySelectorAll(CONTAINER_SELECTOR)[0];
  const anchor = timeAnchorOf(mainCard);
  const row = authorRowOf(mainCard);
  assert.equal(anchor.parentElement, row, '前提：這個版面變體把時間連結直接掛在作者列下');
  assert.ok(row.children.length >= 2, '前提：<a> 的父層還有作者名，不是單子節點');

  const tag = env.tags()[0];
  assert.equal(tag.tagName, 'SPAN', '仍是作者列上的 inline <span>');
  assert.equal(tag.parentElement, row, 'tag 仍落在作者列上');
  assert.equal(anchor.nextSibling, tag, '沒有單子節點包裹層可往上走，tag 只能接在 <a> 之後');
  assert.equal(tagsAboveActionRow(mainCard).length, 0, '不得退到互動列上方');
});

// ============================================================
// 證據結構補強：scan() 的 payload 要指出「錨點落在哪一篇」
//
// 【問題】舊 payload 只有 postUrl＝使用者當時開的那一頁。招攬串的錨點幾乎
// 都在末篇，選項頁的證據連結卻一律指向使用者進來的那一篇（通常是第一篇的
// 長篇鋪陳），點進去看不到當初被標記的那句話。
//
// 【契約】scan() 另外送兩個網址與一組訊號：
//   anchorPostUrl  含錨點那一篇的永久連結＝origin + /@handle/post/<該篇 code>
//   threadUrl      串頭（extractThreadFromDom 回的 items[0]）的永久連結
//   signals        detectScamPitch 回的 signals（白名單 link|line|group|join|pitch）
//   postUrl        維持原義：使用者當時開的那一頁（行為不變）
// 錨點落在哪一篇由實作自行定位（detectScamPitch 回的 snippet／anchorMatch
// 對應到 buildThreadText 的哪一段），本檔只斷言 payload 的結果。
// ============================================================

// 軟性招攬串（七篇）的錨點在末篇 DxSoFtP0007，串頭是 DxSoFtP0001。
const SOFT_ANCHOR_CODE = SOFT_POSTS[SOFT_POSTS.length - 1].code;
const SOFT_ANCHOR_URL = `${ORIGIN}/@${AUTHOR}/post/${SOFT_ANCHOR_CODE}`;
const SOFT_THREAD_URL = `${ORIGIN}/@${AUTHOR}/post/${SOFT_POSTS[0].code}`;
const SOFT_DETECTION = TCLCore.detectScamPitch(SOFT_THREAD_TEXT);

test('證據結構：七篇軟性招攬串的 anchorPostUrl 指向帶錨點的末篇，threadUrl 指向串頭', async () => {
  assert.equal(SOFT_POSTS.length, 7, '前置：soft fixture 為七篇自回覆');
  assert.ok(
    SOFT_POSTS[SOFT_POSTS.length - 1].captionText.includes('LINE：ab12cd'),
    '前置：錨點在末篇'
  );
  assert.ok(
    !SOFT_POSTS[0].captionText.includes('LINE'),
    '前置：串頭不帶錨點，兩個網址才分得出來'
  );

  const env = loadEnv({
    pathname: SOFT_PATH,
    page: [createSsrScript(SOFT_POSTS[0]), createScanDom(SOFT_POSTS)],
  });
  await env.flush();

  const hits = env.hits();
  assert.equal(hits.length, 1, '前置：軟性招攬串應送出一則 scam.hit');
  const payload = hits[0];

  assert.equal(
    payload.postUrl,
    ORIGIN + SOFT_PATH,
    'postUrl 維持原義：使用者當時開的那一頁（第一篇）'
  );
  assert.equal(
    payload.anchorPostUrl,
    SOFT_ANCHOR_URL,
    'anchorPostUrl 應指向末篇（DxSoFtP0007）——錨點就在那一篇，證據連結要帶使用者去看得到那句話的地方'
  );
  assert.equal(
    payload.threadUrl,
    SOFT_THREAD_URL,
    'threadUrl 應指向 items[0]（串頭 DxSoFtP0001）'
  );
  assert.notEqual(payload.anchorPostUrl, payload.threadUrl, '本串的錨點不在串頭，兩者必須不同');
  assert.equal(
    TCLCore.normalizePostUrl(payload.anchorPostUrl),
    payload.anchorPostUrl,
    'anchorPostUrl 必須是乾淨的貼文永久連結'
  );
  assert.equal(
    TCLCore.normalizePostUrl(payload.threadUrl),
    payload.threadUrl,
    'threadUrl 必須是乾淨的貼文永久連結'
  );
});

test('證據結構：signals 原樣帶 detectScamPitch 的結果（軟性串是 line ＋ group，沒有話術詞）', async () => {
  const env = loadEnv({
    pathname: SOFT_PATH,
    page: [createSsrScript(SOFT_POSTS[0]), createScanDom(SOFT_POSTS)],
  });
  await env.flush();

  const payload = env.hits()[0];
  assert.ok(payload, '前置：應送出一則 scam.hit');
  // 陣列先 Array.from 搬回本 realm 再比對（同本檔既有註記：sandbox 的
  // Array.prototype 與本檔字面量不同源）。
  assert.deepEqual(
    Array.from(payload.signals),
    SOFT_DETECTION.signals,
    'signals 原樣帶判定結果'
  );
  assert.deepEqual(
    Array.from(payload.signals),
    ['line', 'group'],
    '軟性招攬串踩到的是 LINE 提及與群組詞，沒有連結型錨點也沒有話術詞'
  );
  Array.from(payload.signals).forEach((signal) => {
    assert.ok(
      ['link', 'line', 'group', 'join', 'pitch'].indexOf(signal) !== -1,
      signal + ' 不在 signals 白名單內'
    );
  });
});

// 錨點落在串頭時兩個網址必須相同：實作不得用「一律取末篇」這種近似解，那在
// 單篇貼文（items 只有一篇）與「錨點就在第一篇」的串上會指錯篇。
const HEAD_ANCHOR_POSTS = [
  {
    code: 'DxHeAdA0001',
    userId: SOFT_POSTS[0].userId,
    username: AUTHOR,
    position: 1,
    selfThreadLength: 3,
    captionText: '想多認識同好可以加 LINE：zz11aa，我把你拉進群組一起討論。',
  },
  {
    code: 'DxHeAdA0002',
    userId: SOFT_POSTS[0].userId,
    username: AUTHOR,
    position: 2,
    selfThreadLength: 3,
    captionText: '第二篇只是心得紀錄，沒有任何聯絡方式，單純寫給自己看。',
  },
  {
    code: 'DxHeAdA0003',
    userId: SOFT_POSTS[0].userId,
    username: AUTHOR,
    position: 3,
    selfThreadLength: 3,
    captionText: '第三篇收尾，感謝看到這裡的朋友，下次再聊。',
  },
];
const HEAD_ANCHOR_PATH = `/@${AUTHOR}/post/${HEAD_ANCHOR_POSTS[0].code}`;
const HEAD_ANCHOR_URL = ORIGIN + HEAD_ANCHOR_PATH;

test('證據結構：錨點就在第一篇時，anchorPostUrl 與 threadUrl 相同', async () => {
  const env = loadEnv({
    pathname: HEAD_ANCHOR_PATH,
    page: [createSsrScript(HEAD_ANCHOR_POSTS[0]), createScanDom(HEAD_ANCHOR_POSTS)],
  });
  await env.flush();

  const hits = env.hits();
  assert.equal(hits.length, 1, '前置：錨點在第一篇的串照樣命中');
  const payload = hits[0];

  assert.equal(payload.anchorPostUrl, HEAD_ANCHOR_URL, 'anchorPostUrl 指向第一篇');
  assert.equal(payload.threadUrl, HEAD_ANCHOR_URL, 'threadUrl 也是第一篇');
  assert.equal(
    payload.anchorPostUrl,
    payload.threadUrl,
    '錨點在串頭時兩者相同——實作不得「一律取末篇」'
  );
  // 【斷言翻轉｜D43】標亮位置改成 ID 本體，錨點落在哪一篇的定位不受影響。
  assert.equal(payload.anchorMatch, 'zz11aa', '前置：錨點取的是第一篇那一句的 ID 本體(D43)');
});

test('證據結構：網址列帶 ?xmt= 時，兩個新網址一樣不得沾到 query／hash', async () => {
  const env = loadEnv({
    pathname: `${HEAD_ANCHOR_PATH}?xmt=AQGzabcdef#top`,
    page: [createSsrScript(HEAD_ANCHOR_POSTS[0]), createScanDom(HEAD_ANCHOR_POSTS)],
  });
  await env.flush();

  const payload = env.hits()[0];
  assert.ok(payload, '前置：帶追蹤參數的詳情頁照樣掃得到');
  assert.equal(payload.anchorPostUrl, HEAD_ANCHOR_URL, 'anchorPostUrl 不得帶 query/hash');
  assert.equal(payload.threadUrl, HEAD_ANCHOR_URL, 'threadUrl 不得帶 query/hash');
});

test('證據結構：新欄位不得取代 postUrl——三個網址各有各的語意', async () => {
  // 使用者從末篇（錨點篇）進入詳情頁：postUrl 是末篇，threadUrl 仍是串頭。
  const env = loadEnv({
    pathname: `/@${AUTHOR}/post/${SOFT_ANCHOR_CODE}`,
    page: [createSsrScript(SOFT_POSTS[0]), createScanDom(SOFT_POSTS)],
  });
  await env.flush();

  const payload = env.hits()[0];
  assert.ok(payload, '前置：從末篇進來照樣掃得到整串');
  assert.equal(payload.postUrl, SOFT_ANCHOR_URL, 'postUrl 跟著使用者實際開的那一頁走');
  assert.equal(payload.anchorPostUrl, SOFT_ANCHOR_URL, '這次錨點篇剛好就是使用者開的那一篇');
  assert.equal(payload.threadUrl, SOFT_THREAD_URL, 'threadUrl 永遠是串頭，不隨進入點改變');
});

// ============================================================
// 證據結構補強:postedAt(貼文發布時間)
//
// 證據原本只有 at＝「掃到的時間」，那只反映使用者什麼時候剛好滑到那一頁。
// 使用者在證據卡上要看的是「這篇招攬貼文什麼時候發的」，資料只有卡片自己的
// <time datetime> 帶得出來。
//
// 【契約】extractThreadFromDom 每篇讀「屬於本卡 permalink 的那顆 <time>」
// (判準與掛 tag 用的 findAuthorRowAnchor 相同:time 的 closest('a') 未跨出
// 本容器，且 href 的 code 等於本卡 code)，Date.parse 解析成毫秒;解析不出
// 就不帶這一欄。scan() 的 payload 取**含錨點那一篇**的值。
// ============================================================

const POSTED_ANCHOR_ISO = '2026-09-18T10:00:00.000Z';
const POSTED_ANCHOR_MS = Date.parse(POSTED_ANCHOR_ISO);

test('證據結構:extractThreadFromDom 逐篇帶出 postedAt，取自屬於該篇 permalink 的 <time datetime>', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const items = extractThreadFromDom(createThreadDom(), AUTHOR);
  assert.ok(items.length > 0, '前置:應取得自回覆串各篇');
  items.forEach((item, i) => {
    assert.equal(
      item.postedAt,
      Date.parse('2026-09-19T10:00:00Z'),
      '第 ' + (i + 1) + ' 篇的 postedAt 取自本卡 <time datetime>'
    );
  });
});

test('證據結構:postedAt 只認屬於本卡 permalink 的 <time>，轉發標頭那顆別篇的時間不算', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  // foreignTimeLink 會在容器內多掛一顆指向「別篇」的 <time datetime>
  // (2026-09-18)，本卡自己那顆是 2026-09-19;判準與掛 tag 用的
  // findAuthorRowAnchor 相同:href 的 code 必須等於本卡 code。
  const root = el('div', {}, [
    createPostContainer({
      handle: AUTHOR,
      code: POSTS[0].code,
      body: POSTS[0].captionText,
      actionRow: true,
      foreignTimeLink: { handle: 'some.other_reader', code: 'DxReplY001A' },
    }),
  ]);
  const items = extractThreadFromDom(root, AUTHOR);
  assert.equal(items.length, 1, '前置:應取到那一篇');
  assert.equal(
    items[0].postedAt,
    Date.parse('2026-09-19T10:00:00Z'),
    '取的是本卡那顆，不是轉發標頭裡指向別篇的那顆'
  );
});

test('證據結構:<time datetime> 解析不出來時該篇不帶 postedAt(不補 0、不丟整篇)', () => {
  const extractThreadFromDom = loadFn('extractThreadFromDom');
  const root = el('div', {}, [
    createPostContainer({
      handle: AUTHOR,
      code: POSTS[0].code,
      body: POSTS[0].captionText,
      actionRow: true,
      postedAtIso: '不是時間',
    }),
  ]);
  const items = extractThreadFromDom(root, AUTHOR);
  assert.equal(items.length, 1, '解析不出時間不得讓整篇被丟掉');
  assert.equal(
    Object.prototype.hasOwnProperty.call(items[0], 'postedAt'),
    false,
    '解析失敗就不帶這一欄'
  );
});

test('證據結構:payload 的 postedAt 取含錨點那一篇的發布時間，不是串頭那篇', async () => {
  // 串頭與錨點篇各給不同的 datetime，才分得出取的是哪一顆。
  const posts = SOFT_POSTS.map((post, i) =>
    Object.assign({}, post, {
      postedAtIso: i === SOFT_POSTS.length - 1 ? POSTED_ANCHOR_ISO : '2026-09-01T00:00:00.000Z',
    })
  );
  const env = loadEnv({
    pathname: SOFT_PATH,
    page: [createSsrScript(posts[0]), createScanDom(posts)],
  });
  await env.flush();

  const payload = env.hits()[0];
  assert.ok(payload, '前置:軟性招攬串應送出一則 scam.hit');
  assert.equal(payload.anchorPostUrl, SOFT_ANCHOR_URL, '前置:錨點落在末篇');
  assert.equal(
    payload.postedAt,
    POSTED_ANCHOR_MS,
    'postedAt 是錨點篇的發布時間——證據卡上那個日期講的就是那一篇'
  );
  assert.notEqual(
    payload.postedAt,
    Date.parse('2026-09-01T00:00:00.000Z'),
    '不得取成串頭那篇的時間'
  );
  assert.equal(typeof payload.at, 'number', 'at(掃到的時間)照舊');
  assert.notEqual(payload.postedAt, payload.at, '兩者語意不同，不得互相取代');
});

test('證據結構:錨點篇的 <time> 解析不出來時 payload 不帶 postedAt', async () => {
  const posts = SOFT_POSTS.map((post, i) =>
    Object.assign({}, post, {
      postedAtIso: i === SOFT_POSTS.length - 1 ? '不是時間' : '2026-09-01T00:00:00.000Z',
    })
  );
  const env = loadEnv({
    pathname: SOFT_PATH,
    page: [createSsrScript(posts[0]), createScanDom(posts)],
  });
  await env.flush();

  const payload = env.hits()[0];
  assert.ok(payload, '前置:照樣命中');
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload, 'postedAt'),
    false,
    '取不到就整欄不帶——background 對這一欄的規則是「缺席通過」'
  );
});

// ============================================================
// 規則 v4:暗號型招攬與 ID 跨帳號命中的注入端(D45／D46)
//
// D45 端到端:合成的暗號型招攬串(LINE 提及＋「傳「177」給我」＋ LINE ID),
// 零群組/加入詞、零強話術詞——v3 對它整串漏抓。
//
// D46 是新的一條命中路徑:這一串本身踩不到任何判定門檻，但作者貼出來的 LINE
// ID 已經在警示名單上、而且掛在**另一位**作者名下。同一個 ID 換一個帳號再
// 招攬一次就是同一組人，判定不必再等行動呼籲或話術詞。
//   - 索引由 TCLCore 正規化名單時派生(lineIdIndex),content script 與
//     handleIndex 走同一份 storage 讀取，不另外算一次。
//   - 指向本篇作者自己時不算(自己貼自己的 ID 是常態)。
//   - 使用者已解除封鎖的作者照舊早退，不掛警示。
//
// 合成資料:帳號 ex01abc，userId 沿用 fixture 的 10000000001 與另一位
// 20000000002，不得出現真實 LINE ID 或真實帳號。
// ============================================================

const V4_OTHER_ID = '20000000002';
const V4_OTHER_HANDLE = 'other_scam_author';
const V4_LINE_ID = 'ex01abc';
const V4_OTHER_ANCHOR_URL = `${ORIGIN}/@${V4_OTHER_HANDLE}/post/DxOtHeR0001`;

// 暗號型招攬串:第一篇是鋪陳，第二篇是靶(暗號 CTA ＋ LINE ID)。
const V4_CODE_WORD_POSTS = [
  {
    code: 'DxCoDeW0001',
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 1,
    selfThreadLength: 2,
    captionText: '這幾年我把自己看盤的流程整理成一份表，很多人問我怎麼拿。',
  },
  {
    code: 'DxCoDeW0002',
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 2,
    selfThreadLength: 2,
    captionText: `可以到 LINE 傳「177」給我，我免費把整理好的資料分享給你！\nLINE ID：${V4_LINE_ID}`,
  },
];
const V4_CODE_WORD_PATH = `/@${AUTHOR}/post/${V4_CODE_WORD_POSTS[0].code}`;

// 只帶 LINE ID、沒有任何行動呼籲與話術詞的一串:判定本身不會命中，命中只能
// 來自 ID 跨帳號比對。
const V4_ID_ONLY_POSTS = [
  {
    code: 'DxIdOnL0001',
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 1,
    selfThreadLength: 2,
    captionText: '昨天整理舊筆記，翻到十年前剛進廠時寫的第一本維修紀錄，感觸很深。',
  },
  {
    code: 'DxIdOnL0002',
    userId: POSTS[0].userId,
    username: AUTHOR,
    position: 2,
    selfThreadLength: 2,
    captionText: `有問題的朋友可以找我聊聊。\nLINE ID：${V4_LINE_ID}`,
  },
];
const V4_ID_ONLY_PATH = `/@${AUTHOR}/post/${V4_ID_ONLY_POSTS[0].code}`;

// 一份帶 lineId 證據的警示名單(storage 形狀)。owner 是這個 ID 掛在誰名下。
//   ownerId／ownerHandle：持有 V4_LINE_ID 的那一筆
//   dismissedAuthor：把本篇作者也放一筆已解除的條目
function buildLineIdBlocklist(options) {
  const settings = options || {};
  const list = { version: 2, entries: {} };
  list.entries[settings.ownerId || V4_OTHER_ID] = {
    state: 'active',
    handle: settings.ownerHandle || V4_OTHER_HANDLE,
    displayName: 'Other Author',
    evidence: [
      {
        postUrl: V4_OTHER_ANCHOR_URL,
        anchorPostUrl: V4_OTHER_ANCHOR_URL,
        snippet: `之前那一篇也是同一組人:LINE ID：${V4_LINE_ID}`,
        anchorMatch: V4_LINE_ID,
        lineId: V4_LINE_ID,
        signals: ['line', 'account', 'id'],
        at: 1758280000000,
        rulesVersion: 4,
      },
    ],
    addedAt: 1758280000000,
    updatedAt: 1758280000000,
    source: 'auto',
  };
  if (settings.dismissedAuthor) {
    list.entries[POSTS[0].userId] = {
      state: 'dismissed',
      dismissedAt: 1758290000000,
      handle: AUTHOR,
      displayName: DISPLAY_NAME,
      evidence: [],
      addedAt: 1758270000000,
      updatedAt: 1758290000000,
      source: 'auto',
    };
  }
  return list;
}

test('D45 端到端：暗號型招攬串（零群組詞、零話術詞）照樣命中、送 scam.hit、掛 tag', async () => {
  const env = loadEnv({
    pathname: V4_CODE_WORD_PATH,
    page: [createSsrScript(V4_CODE_WORD_POSTS[0]), createScanDom(V4_CODE_WORD_POSTS)],
  });
  await env.flush();

  assert.ok(
    !/黑馬股|報明牌|代操|帶單|飆股|穩賺|獲利分享|群組|社群|加入/.test(env.detectCalls[0] || ''),
    '前置：這串刻意不帶強話術詞，也不帶群組／加入詞'
  );

  const hits = env.hits();
  assert.equal(hits.length, 1, '暗號型招攬串要通報一則 scam.hit');
  assert.equal(hits[0].userId, POSTS[0].userId);
  assert.ok(hits[0].signals.includes('account'), 'signals 應含 account（帳號型錨點）');
  assert.equal(hits[0].lineId, V4_LINE_ID, 'payload 帶 lineId，background 才存得進證據');
  assert.equal(hits[0].anchorMatch, V4_LINE_ID, '標亮 ID 本體（D43）');
  assert.equal(env.tags().length, 1, '命中就要掛一顆警示');
});

test('D46 ID 跨帳號：ID 掛在另一位作者名下時命中（無行動呼籲、無話術詞），signals 含 id-match', async () => {
  const env = loadEnv({
    pathname: V4_ID_ONLY_PATH,
    page: [createSsrScript(V4_ID_ONLY_POSTS[0]), createScanDom(V4_ID_ONLY_POSTS)],
    local: { scamBlocklist: buildLineIdBlocklist() },
  });
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => env.hits().length === 1, { label: 'ID 跨帳號命中的 scam.hit' });

  const payload = env.hits()[0];
  assert.equal(payload.userId, POSTS[0].userId, '通報的是本篇作者，不是名單上持有 ID 的那一位');
  assert.equal(payload.lineId, V4_LINE_ID, 'payload 要帶 lineId');
  assert.ok(
    payload.signals.includes('id-match'),
    'signals 要記下這一次是靠 ID 跨帳號比對成立的，實得 ' + JSON.stringify(payload.signals)
  );
  await env.waitFor(() => env.tags().length === 1, { label: 'ID 跨帳號命中的警示 tag' });
});

test('D46 ID 跨帳號：索引指向的就是本篇作者時，不因此命中', async () => {
  const env = loadEnv({
    pathname: V4_ID_ONLY_PATH,
    page: [createSsrScript(V4_ID_ONLY_POSTS[0]), createScanDom(V4_ID_ONLY_POSTS)],
    // 同一個 ID 掛在本篇作者自己名下：自己貼自己的 LINE ID 是常態，不是
    // 「換帳號再來一次」。
    local: { scamBlocklist: buildLineIdBlocklist({ ownerId: POSTS[0].userId, ownerHandle: AUTHOR }) },
  });
  await env.flush();
  env.triggerObserver();
  await env.flush();

  assert.equal(
    env.hits().length,
    0,
    'ID 指回本篇作者自己時不得靠這條路成立——否則名單上每個人的每一篇都會被自己的 ID 再標一次'
  );
});

test('D46 ID 跨帳號：本篇作者已解除封鎖時照舊早退，不掛 tag', async () => {
  const env = loadEnv({
    pathname: V4_ID_ONLY_PATH,
    page: [createSsrScript(V4_ID_ONLY_POSTS[0]), createScanDom(V4_ID_ONLY_POSTS)],
    local: { scamBlocklist: buildLineIdBlocklist({ dismissedAuthor: true }) },
    // 已解除的作者，background 回的就是這一組（handleScamHit 的早退分支）。
    respond: () => ({ ok: true, added: false, allowlisted: true }),
  });
  await env.flush();
  env.triggerObserver();
  await env.waitFor(() => env.hits().length === 1, { label: 'ID 跨帳號仍會問過 background' });
  await env.flush();

  assert.equal(
    env.tags().length,
    0,
    '使用者解除過的作者不得因為一條新的命中路徑又長回警示（allowlist 早退照舊）'
  );
});
