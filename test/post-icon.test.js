// test/post-icon.test.js — post-icon.js(貼文互動列「複製連結」icon)的
// 純邏輯函式契約，以及 i18n.js 新增的 iconTooltip / iconCopied 兩個 key。
//
// ============================================================
// 【設計約定：post-icon.js 對測試暴露的契約】
// 比照 popup.js / i18n.js 的既有慣例——CommonJS 相容的 IIFE 模組，於 Node
// 測試環境以 require() 直接載入(不用 vm sandbox，因為這裡只測「不碰
// document」的純函式；DOM 注入／MutationObserver 屬瀏覽器整合層，不在此檔
// 涵蓋，見規格單第 3 點)：
//
//   (function (root) {
//     ...
//     if (typeof module !== 'undefined' && module.exports) {
//       module.exports = api;
//     } else {
//       root.TCLPostIcon = api;
//     }
//   })(typeof window !== 'undefined' ? window : this);
//
// 模組頂層任何會touch `document` / MutationObserver 的注入邏輯，都必須用
// `typeof document !== 'undefined'` 這類守衛包住，讓 Node 測試環境
// (無 document 全域)require() 時不丟例外、不產生副作用——純函式匯出必須
// 在守衛之外，一律可用。
//
// 暴露的純函式:
//   pickPermalink(hrefs: string[]) → string|null
//     輸入候選 href 字串陣列(來自貼文容器內所有 a[href*="/post/"])。
//     規則:排除以 '/media' 結尾者(不論在陣列中的位置)；過濾後從「保留
//     下來、依原陣列順序」的候選中取第一個。全被排除、原陣列為空、或輸入
//     本身不是陣列，一律回傳 null，不丟例外。
//   buildPostUrl(href: string, origin: string) → string|null
//     以 href 為相對路徑、origin 為基底組成絕對 URL，並去除其 query(?...)
//     與 hash(#...)。href 非字串、origin 不是合法的絕對來源、或組不出合法
//     URL 等任何非法輸入，一律回傳 null，不丟例外(內部須自行 try/catch，
//     不可讓 URL 建構子的例外外洩)。
//   readActionLabel(svg) → string|null
//     讀取互動列按鈕 svg 的無障礙標籤。svg 為任意帶 getAttribute(name) 與
//     querySelector(selector) 方法的物件(對應真實 DOM 的 SVGElement；測試
//     以最小 duck-type 假物件替代)。先取 aria-label 屬性，值為 falsy(缺屬
//     性、空字串)時退到 svg 內 <title> 子元素的 textContent 並去除前後空
//     白。兩邊都取不到非空字串時回傳 null。svg 缺失或不帶上述方法時回傳
//     null，不丟例外。
//   hasExistingIcon(scope) → boolean
//     scope 為任意帶 querySelector(selector) 方法的物件(對應真實 DOM 的
//     Element；測試以最小 duck-type 假物件替代，不搭建完整 DOM)。回傳
//     scope.querySelector('.tcl-copy-icon') 是否有回傳非 falsy 值，用來讓
//     注入邏輯判斷「這一列是否已經注入過，避免重複注入」。scope 缺失或不是
//     帶 querySelector 的物件時回傳 false，不丟例外。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox } = require('./support/helpers');

// require 刻意延遲到各測試內部才載入(而非檔案頂層)：載入失敗(如
// MODULE_NOT_FOUND)時紅燈落在個別測試上，而不是整個測試檔在載入階段就崩掉
// (沿用 test/popup.test.js 的 loadPopup() 模式)。
function loadPostIcon() {
  return require(path.join(__dirname, '..', 'post-icon.js'));
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'post-icon.js'), 'utf8');

// ============================================================
// 【最小 document 假件:只服務「自癒重注入」這兩條測試】
// 本檔其餘測試一律只測不碰 document 的純函式(見檔頭約定)，但孤兒自癒的
// 兩個保證天生就在 DOM 層——「啟動時要先清掉舊實例殘留的 icon 節點」與
// 「孤兒實例不得再掃描注入」，兩者都無法用純函式表達。這裡只搭剛好夠
// init() 跑完的假件(建立樣式節點、查詢選擇器、移除節點)，並記錄查詢過
// 的選擇器供斷言;不擴充成通用 DOM harness——完整注入流程(找互動列、插
// 入節點、點擊回饋)仍屬瀏覽器整合層，不在此檔涵蓋。
// ============================================================

function createStubNode(nodeName) {
  return {
    nodeName,
    id: '',
    textContent: '',
    innerHTML: '',
    style: {},
    childNodes: [],
    classList: { add() {}, remove() {} },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };
}

// staleIconCount:模擬「擴充功能更新前、已孤兒化的舊實例」留在 DOM 上的
// .tcl-copy-icon 節點數量。每顆掛在自己的父節點下，被摘掉時記錄下來。
function createFakeDocument(staleIconCount) {
  let iconNodes = [];
  const removedIndexes = [];
  const selectors = [];

  for (let i = 0; i < staleIconCount; i++) {
    const node = { className: 'tcl-copy-icon', index: i };
    node.parentNode = {
      removeChild(child) {
        removedIndexes.push(child.index);
        iconNodes = iconNodes.filter((n) => n !== child);
        return child;
      },
    };
    iconNodes.push(node);
  }

  return {
    readyState: 'complete',
    head: createStubNode('head'),
    body: createStubNode('body'),
    documentElement: createStubNode('html'),
    getElementById() {
      return null;
    },
    createElement(tag) {
      return createStubNode(tag);
    },
    addEventListener() {},
    querySelectorAll(selector) {
      selectors.push(selector);
      // 真實的 querySelectorAll 回傳靜態 NodeList，這裡也回傳快照——實
      // 作是邊迭代邊 removeChild，回傳活陣列會跳號漏刪。
      if (selector === '.tcl-copy-icon') return iconNodes.slice();
      return [];
    },
    // ---- 測試專用觀測點 ----
    selectors,
    removedIndexes,
    currentIcons() {
      return iconNodes.slice();
    },
  };
}

// chromeRef 傳 null 代表「連 chrome 都沒有」；傳 { runtime: {} } 代表孤兒。
function loadPostIconInFakeDom(doc, chromeRef) {
  const warnings = [];
  const sandbox = {
    window: {
      location: { origin: 'https://www.threads.com' },
      navigator: {},
      getComputedStyle: () => ({ color: '' }),
    },
    document: doc,
    console: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: () => {},
      log: () => {},
    },
    setTimeout,
    clearTimeout,
    URL,
  };
  if (chromeRef) sandbox.chrome = chromeRef;
  runInSandbox(SRC, sandbox);
  return { warnings, api: sandbox.window.TCLPostIcon };
}

const CONTAINER_SELECTOR = 'div[data-pressable-container]';

const i18n = require(path.join(__dirname, '..', 'i18n.js'));

// ---- pickPermalink ----

test('pickPermalink:單一候選、非 /media 結尾，原樣回傳', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(
    pickPermalink(['/@yuki4382/post/DcDrsdAmhlU']),
    '/@yuki4382/post/DcDrsdAmhlU'
  );
});

test('pickPermalink:排除以 /media 結尾的候選，回傳剩下的那個(不論在陣列中的先後位置)', () => {
  const { pickPermalink } = loadPostIcon();
  const post = '/@cracked.kuki/post/DcDz3LyGnDz';
  const media = '/@cracked.kuki/post/DcDz3LyGnDz/media';

  assert.equal(pickPermalink([post, media]), post, 'media 排在後面');
  assert.equal(pickPermalink([media, post]), post, 'media 排在前面，過濾後順序不受影響');
});

test('pickPermalink:全部候選都以 /media 結尾時回傳 null(排除大小寫不敏感，如 /MEDIA)', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(pickPermalink(['/@x/post/abc/media']), null);
  assert.equal(pickPermalink(['/@a/post/X/MEDIA']), null, '大小寫不敏感');
});

test('pickPermalink:空陣列回傳 null', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(pickPermalink([]), null);
});

test('pickPermalink:多個有效候選時，取過濾後陣列順序中的第一個', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(pickPermalink(['/@a/post/1', '/@b/post/2']), '/@a/post/1');
});

test('pickPermalink:非陣列輸入(null／undefined)一律回傳 null，不丟例外', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(pickPermalink(null), null);
  assert.equal(pickPermalink(undefined), null);
});

// ---- filterOwnContainerHrefs(巢狀容器防護:引用貼文複製錯網址的修正) ----
//
// 引用貼文會把被引文的貼文容器巢狀在外層容器內，外層容器用
// querySelectorAll('a[href*="/post/"]') 收集候選時，也會掃到被引文自己的
// permalink。過濾規則:只留 ownContainer 為 true(錨點最近的貼文容器祖先
// 就是目前掃描的這個容器本身)的候選，依原順序保留。

test('filterOwnContainerHrefs:全部候選都屬本容器時，依原順序原樣保留', () => {
  const { filterOwnContainerHrefs } = loadPostIcon();

  assert.deepEqual(
    filterOwnContainerHrefs([
      { href: '/@a/post/1', ownContainer: true },
      { href: '/@a/post/1/media', ownContainer: true },
    ]),
    ['/@a/post/1', '/@a/post/1/media']
  );
});

test('filterOwnContainerHrefs:引用貼文序列——排除 ownContainer 為 false 的候選(被引文的 permalink)', () => {
  const { filterOwnContainerHrefs } = loadPostIcon();
  // 模擬真實掃描順序:外層容器本身的連結先出現，接著是巢狀在內的引用
  // 貼文(被引文)自己的連結，最後才是外層容器的 media 連結。
  const candidates = [
    { href: '/@outer/post/OUTER1', ownContainer: true },
    { href: '/@quoted/post/QUOTED1', ownContainer: false },
    { href: '/@quoted/post/QUOTED1/media', ownContainer: false },
    { href: '/@outer/post/OUTER1/media', ownContainer: true },
  ];

  assert.deepEqual(filterOwnContainerHrefs(candidates), [
    '/@outer/post/OUTER1',
    '/@outer/post/OUTER1/media',
  ]);
});

test('filterOwnContainerHrefs:候選形狀不對(缺 href、href 非字串、候選本身為 null)逐筆略過，不丟例外', () => {
  const { filterOwnContainerHrefs } = loadPostIcon();

  assert.deepEqual(
    filterOwnContainerHrefs([
      { href: '/@a/post/1', ownContainer: true },
      { ownContainer: true }, // 缺 href
      { href: 12345, ownContainer: true }, // href 非字串
      null, // 候選本身為 null
      { href: '/@b/post/2', ownContainer: false }, // 屬巢狀貼文，排除
    ]),
    ['/@a/post/1']
  );
});

test('filterOwnContainerHrefs:非陣列輸入(null／undefined)一律回傳空陣列，不丟例外', () => {
  const { filterOwnContainerHrefs } = loadPostIcon();

  assert.deepEqual(filterOwnContainerHrefs(null), []);
  assert.deepEqual(filterOwnContainerHrefs(undefined), []);
});

// ---- buildPostUrl ----

test('buildPostUrl:相對 href 與 origin 組成絕對 URL', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(
    buildPostUrl('/@yuki4382/post/DcDrsdAmhlU', 'https://www.threads.com'),
    'https://www.threads.com/@yuki4382/post/DcDrsdAmhlU'
  );
});

test('buildPostUrl:去除 query 與 hash', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(
    buildPostUrl('/@x/post/abc?utm=1&foo=2#section', 'https://www.threads.com'),
    'https://www.threads.com/@x/post/abc'
  );
});

test('buildPostUrl:只帶 query(?xmt=...)時同樣去除', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(
    buildPostUrl('/@x/post/abc?xmt=AQG0abc', 'https://www.threads.com'),
    'https://www.threads.com/@x/post/abc'
  );
});

test('buildPostUrl:href 非字串或 origin 非合法絕對來源時一律回傳 null，不丟例外', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(buildPostUrl(null, 'https://www.threads.com'), null);
  assert.equal(buildPostUrl(undefined, 'https://www.threads.com'), null);
  assert.equal(buildPostUrl(12345, 'https://www.threads.com'), null);
  assert.equal(buildPostUrl('/@x/post/abc', 'not-a-url'), null);
  assert.equal(buildPostUrl('/@x/post/abc', null), null);
  assert.equal(buildPostUrl('/@x/post/abc', undefined), null);
});

// 惡意 href(非常規 scheme／協定相對)一律回傳 null，不得被組成看似合法的
// 絕對網址——這兩種輸入是頁面 DOM 可控的攻擊面。
test('buildPostUrl:href 為 javascript: 或 //evil.com/x 這類惡意輸入時回傳 null，不丟例外', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(buildPostUrl('javascript:alert(1)', 'https://www.threads.com'), null);
  assert.equal(buildPostUrl('//evil.com/x', 'https://www.threads.com'), null);
});

// ---- hasExistingIcon(可選：低成本 idempotency 判斷，沿用最小 duck-type 假物件) ----

test('hasExistingIcon:scope.querySelector(".tcl-copy-icon") 有命中時回傳 true', () => {
  const { hasExistingIcon } = loadPostIcon();
  const scope = {
    querySelector(sel) {
      return sel === '.tcl-copy-icon' ? { tagName: 'BUTTON' } : null;
    },
  };

  assert.equal(hasExistingIcon(scope), true);
});

test('hasExistingIcon:scope.querySelector(".tcl-copy-icon") 沒命中時回傳 false', () => {
  const { hasExistingIcon } = loadPostIcon();
  const scope = { querySelector: () => null };

  assert.equal(hasExistingIcon(scope), false);
});

test('hasExistingIcon:scope 缺失或不帶 querySelector 時回傳 false，不丟例外', () => {
  const { hasExistingIcon } = loadPostIcon();

  assert.equal(hasExistingIcon(null), false);
  assert.equal(hasExistingIcon(undefined), false);
  assert.equal(hasExistingIcon({}), false);
});

// ---- readActionLabel(互動列按鈕 svg 的標籤讀取:Threads 2026-09 改版把
// 互動列四顆按鈕 svg 的 aria-label 拿掉了，標籤只剩 svg > title 的
// textContent。讀法統一收在這顆純函式，讓找互動列、消歧、取色三處共用同
// 一個來源判斷，沿用最小 duck-type 假物件) ----

// 先確認契約存在再測行為:函式還沒實作時，紅燈要落在「缺這個匯出」的斷言
// 上，而不是 TypeError 崩在呼叫點。
function loadReadActionLabel() {
  const api = loadPostIcon();
  assert.equal(
    typeof api.readActionLabel,
    'function',
    'post-icon.js 應在 DOM 守衛外匯出純函式 readActionLabel'
  );
  return api.readActionLabel;
}

test('readActionLabel:svg 帶 aria-label 時優先取 aria-label', () => {
  const readActionLabel = loadReadActionLabel();
  const svg = {
    getAttribute: (name) => (name === 'aria-label' ? '分享' : null),
    // 舊結構 aria-label 與 <title> 並存時，不該改讀 <title>。
    querySelector: (sel) => (sel === 'title' ? { textContent: '不該被讀到' } : null),
  };

  assert.equal(readActionLabel(svg), '分享');
});

test('readActionLabel:svg 沒有 aria-label 時退到 svg > title 的 textContent', () => {
  const readActionLabel = loadReadActionLabel();
  const svg = {
    getAttribute: () => null,
    querySelector: (sel) => (sel === 'title' ? { textContent: '讚' } : null),
  };

  assert.equal(readActionLabel(svg), '讚');
});

test('readActionLabel:aria-label 為空字串時同樣退到 svg > title', () => {
  const readActionLabel = loadReadActionLabel();
  const svg = {
    getAttribute: (name) => (name === 'aria-label' ? '' : null),
    querySelector: (sel) => (sel === 'title' ? { textContent: '回覆' } : null),
  };

  assert.equal(readActionLabel(svg), '回覆');
});

test('readActionLabel:<title> 的 textContent 前後空白要去掉', () => {
  const readActionLabel = loadReadActionLabel();
  const svg = {
    getAttribute: () => null,
    querySelector: (sel) => (sel === 'title' ? { textContent: '  轉發\n  ' } : null),
  };

  assert.equal(readActionLabel(svg), '轉發');
});

test('readActionLabel:<title> 只有空白字串視同沒有標籤，回傳 null', () => {
  const readActionLabel = loadReadActionLabel();
  const svg = {
    getAttribute: () => null,
    querySelector: (sel) => (sel === 'title' ? { textContent: '   ' } : null),
  };

  assert.equal(readActionLabel(svg), null);
});

test('readActionLabel:aria-label 與 <title> 都沒有時回傳 null', () => {
  const readActionLabel = loadReadActionLabel();

  assert.equal(readActionLabel({ getAttribute: () => null, querySelector: () => null }), null);
});

test('readActionLabel:svg 缺失或不帶 getAttribute／querySelector 時回傳 null，不丟例外', () => {
  const readActionLabel = loadReadActionLabel();

  assert.equal(readActionLabel(null), null);
  assert.equal(readActionLabel(undefined), null);
  assert.equal(readActionLabel({}), null);
});

// ---- pickActionRowIndex(結構相同的多個互動列候選消歧：影片貼文會多一條
// 播放器工具列，結構上也符合「>=4 個子元素、每個子元素都有 [role="button"]
// 包著 svg」，需要靠按鈕標籤白名單挑出真正的讚/回覆/轉發/分享列。標籤本身
// 的讀法見 readActionLabel——Threads 的 svg 可能帶 aria-label，也可能只在
// svg > title 留下文字，本函式只吃讀好的標籤字串，不管來源) ----

test('pickActionRowIndex:單一候選直通，不需要消歧', () => {
  const { pickActionRowIndex } = loadPostIcon();

  assert.equal(pickActionRowIndex([['追蹤', '更多', '已靜音', '排序']]), 0);
});

test('pickActionRowIndex:多個候選時，優先選白名單交集 >= 3 的那個(不論它在陣列中的位置)', () => {
  const { pickActionRowIndex } = loadPostIcon();
  const videoToolbar = ['追蹤', '更多', '已靜音', '排序', '附加影音內容'];
  const actionRow = ['讚', '回覆', '轉發', '分享'];

  assert.equal(pickActionRowIndex([videoToolbar, actionRow]), 1, '互動列排在後面');
  assert.equal(pickActionRowIndex([actionRow, videoToolbar]), 0, '互動列排在前面');
});

test('pickActionRowIndex:白名單全不中時(頁面語言不在 zh/en)，退回取文件序最後一個候選', () => {
  const { pickActionRowIndex } = loadPostIcon();
  const videoToolbarFr = ['Suivre', 'Plus', 'Muet', 'Trier'];
  const actionRowFr = ['Aimer', "Répondre", 'Republier', 'Partager'];

  assert.equal(pickActionRowIndex([videoToolbarFr, actionRowFr]), 1);
});

test('pickActionRowIndex:同一標籤重複出現不應虛增命中數(去重後才計數相異標籤)', () => {
  const { pickActionRowIndex } = loadPostIcon();
  // 退化列:'分享' 出現 3 次，若只數「命中次數」會誤判達到 >= 3 門檻；
  // 但相異命中標籤其實只有 1 個('分享')，不該被選為互動列。
  const degenerateRow = ['分享', '分享', '分享', 'x'];
  const videoToolbar = ['追蹤', '更多', '已靜音', '排序'];

  // 兩個候選都沒有相異命中 >= 3 個，退回文件序最後一個候選(videoToolbar)，
  // 而不是誤選 degenerateRow。
  assert.equal(pickActionRowIndex([degenerateRow, videoToolbar]), 1);
});

test('pickActionRowIndex:候選清單為空或非陣列輸入一律回傳 null，不丟例外', () => {
  const { pickActionRowIndex } = loadPostIcon();

  assert.equal(pickActionRowIndex([]), null);
  assert.equal(pickActionRowIndex(null), null);
  assert.equal(pickActionRowIndex(undefined), null);
});

// ---- classifyExcerptCandidate(extractExcerpt 逐段決策 push／skip／stop
// 的純函式) ----

test('classifyExcerptCandidate:純標點行(如「...」)不是計數字串，應保留為內文(push)，不中止收集', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('...', true), 'push');
  assert.equal(classifyExcerptCandidate('...', false), 'push');
});

test('classifyExcerptCandidate:已收集到內文後，正文中單獨成行的時間樣式字串(如「3天」「2026-4-29」)不再被當成時間戳記丟棄，應保留為內文(push)', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('3天', true), 'push');
  assert.equal(classifyExcerptCandidate('2026-4-29', true), 'push');
});

test('classifyExcerptCandidate:尚未收集到任何內文時，時間樣式字串仍視為時間戳記，略過(skip)', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('18小時', false), 'skip');
  assert.equal(classifyExcerptCandidate('2026-4-29', false), 'skip');
});

test('classifyExcerptCandidate:計數字串(純數字／千分位逗號／K-M-B 縮寫)一律中止收集(stop)，不論是否已收集到內文', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('97', true), 'stop');
  assert.equal(classifyExcerptCandidate('2,440', true), 'stop');
  assert.equal(classifyExcerptCandidate('1.2K', false), 'stop');
});

test('classifyExcerptCandidate:空字串——已收集到內文時中止(stop)，尚未收集到內文時略過(skip)', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('', true), 'stop');
  assert.equal(classifyExcerptCandidate('', false), 'skip');
});

// ============================================================
// 【摘要擷取的互動列防護:D47 計數字串、D48 結構排除】
// extractExcerpt 把互動列的讚數(「6.5 萬」)與影片貼文的配樂標示列收進了
// 摘要——兩者都是 [dir="auto"] 候選、都跟內文同層並列，唯一可靠的切分是
// 「自己有 [role='button'] 祖先」(D48 主修);字串形狀的計數判斷
// (COUNT_LIKE_RE)保留作第二道(D47)。
//
// extractExcerpt／extractPostInfo 定義在 post-icon.js 的 document 守衛
// 內，Node 直接 require() 取不到，這裡用下面的 loadPostIconApi()(本檔既
// 有的假 document + 假 chrome)取 window.TCLPostIcon，容器則餵下面這棵迷
// 你樹。
//
// 下列 fixture 的結構(層級、dir="auto"／role="button"／
// data-pressable-container 的相對位置)照搬實測員自 staging 擷取的真實
// DOM，文字一律換成合成字串，不含真實帳號與貼文 code。
// ============================================================

// ---- 最小假 DOM:一棵支援 textContent／cloneNode(true)／closest／
// querySelectorAll 的迷你樹。extractExcerpt 的三條保證——「候選依文件序
// 列出」「祖先鏈上有沒有 a／role=button／別的貼文容器」「cleanElementText
// 先 cloneNode 再剝掉按鈕子孫」——天生需要真的樹狀結構與祖先鏈，單層
// duck-type 假物件表達不了。只搭到剛好夠用的程度，不擴充成通用 DOM
// harness;本檔其餘測試維持既有的假物件慣例。----

// 只支援本區用得到的單段選擇器形狀:`tag`、`[attr]`、`[attr="value"]`、
// `[attr^="value"]` 與 tag + 屬性的組合(如 a[href^="/@"])。
const MINI_SELECTOR_RE = /^([a-zA-Z]*)(?:\[([a-zA-Z-]+)(?:(\^?=)"([^"]*)")?\])?$/;

function miniMatches(node, selector) {
  const parsed = MINI_SELECTOR_RE.exec(String(selector).trim());
  assert.ok(parsed, '假 DOM 不支援的選擇器：' + selector);
  const [, tag, attr, operator, value] = parsed;
  if (tag && node.nodeName !== tag.toUpperCase()) return false;
  if (!attr) return true;
  const actual = node.getAttribute(attr);
  if (actual === null) return false;
  if (!operator) return true;
  if (operator === '^=') return actual.indexOf(value) === 0;
  return actual === value;
}

function txt(value) {
  return {
    nodeType: 3,
    nodeName: '#text',
    textContent: value,
    childNodes: [],
    cloneNode() {
      return txt(value);
    },
  };
}

function el(tag, attributes, children) {
  const node = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    attributes: Object.assign({}, attributes || {}),
    childNodes: [],
    parentElement: null,
    parentNode: null,
    get textContent() {
      return node.childNodes.map((child) => child.textContent).join('');
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name)
        ? String(node.attributes[name])
        : null;
    },
    hasAttribute(name) {
      return node.getAttribute(name) !== null;
    },
    matches(selector) {
      return miniMatches(node, selector);
    },
    closest(selector) {
      let cursor = node;
      while (cursor) {
        if (cursor.matches(selector)) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    },
    // 前序走訪後代(不含自己)，與真實 querySelectorAll 的文件序一致;巢狀
    // 容器／按鈕內的節點照樣列出——過濾是受測程式的責任，不是假件的。
    querySelectorAll(selector) {
      const found = [];
      (function walk(cursor) {
        cursor.childNodes.forEach((child) => {
          if (child.nodeType !== 1) return;
          if (child.matches(selector)) found.push(child);
          walk(child);
        });
      })(node);
      return found;
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
    removeChild(child) {
      const idx = node.childNodes.indexOf(child);
      if (idx !== -1) node.childNodes.splice(idx, 1);
      if (child.nodeType === 1) {
        child.parentElement = null;
        child.parentNode = null;
      }
      return child;
    },
    cloneNode(deep) {
      return el(tag, node.attributes, deep ? node.childNodes.map((c) => c.cloneNode(true)) : []);
    },
  };
  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

// ---- fixture 的合成素材(去識別化;帳號、貼文 code、內文全為合成值) ----
const FX_AUTHOR = 'author_a';
const FX_POST_CODE = 'POSTCODE';
const FX_LINE_1 = '內文第一行';
const FX_LINE_2 = '內文第二行';
// 實測的讚數原文用 U+00A0 不斷行空白分隔數字與單位。
const FX_LIKE_COUNT = '6.5 萬';
// 影片貼文的配樂標示列(合成曲名／演出者)。
const FX_MUSIC_ROW = '示意配樂曲名 · 示意演出者';

// 互動列上的一顆計數按鈕:數字包在 [role="button"] 底下的
// <span dir="auto"> 內，與內文 span 同層並列。
function fxCountButton(label, count) {
  return el('div', {}, [
    el('div', { role: 'button' }, [
      el('svg', { role: 'img', title: label }, [el('title', {}, [txt(label)])]),
      el('span', { dir: 'auto' }, [el('div', {}, [el('span', {}, [txt(count)])])]),
    ]),
  ]);
}

// 作者名:整串包在 a[href^="/@"] 內(既有的「在 <a> 內跳過」靠這個形狀)。
function fxAuthorBlock() {
  return el('div', {}, [
    el('a', { href: '/@' + FX_AUTHOR, role: 'link' }, [
      el('span', { dir: 'auto' }, [el('span', {}, [txt(FX_AUTHOR)])]),
    ]),
  ]);
}

// 時間戳記:dir="auto" 在 <a> 外層(closest('a') 取不到)，靠
// RELATIVE_TIME_RE 在「尚未收集到內文」時略過。
function fxTimestamp(label) {
  return el('span', { dir: 'auto' }, [
    el('a', { href: '/@' + FX_AUTHOR + '/post/' + FX_POST_CODE, role: 'link' }, [
      el('time', {}, [txt(label)]),
    ]),
  ]);
}

function fxBodyBlock(lines) {
  return el(
    'div',
    {},
    lines.map((line) => el('span', { dir: 'auto' }, [el('span', {}, [txt(line)])]))
  );
}

// 主文容器(實測 fixture 01):作者／時間戳記／內文／互動列同層並列，
// 互動列三顆計數(讚 6.5 萬、回覆 132、轉發 2,486)各自在 [role="button"] 內。
function createMainPostContainer(options) {
  const opts = options || {};
  const lines = opts.lines || [FX_LINE_1];
  const children = [fxAuthorBlock(), fxTimestamp('17小時'), fxBodyBlock(lines)];
  if (opts.withActionRow !== false) {
    children.push(
      el('div', {}, [
        fxCountButton('讚', FX_LIKE_COUNT),
        fxCountButton('回覆', '132'),
        fxCountButton('轉發', '2,486'),
      ])
    );
  }
  return el('div', { 'data-pressable-container': 'true' }, children);
}

// 一般回文容器(實測 fixture 02):讚數 101，靠既有的 COUNT_LIKE_RE 就擋得住。
function createReplyContainer() {
  return el('div', { 'data-pressable-container': 'true' }, [
    fxAuthorBlock(),
    fxTimestamp('1小時'),
    fxBodyBlock([FX_LINE_1]),
    el('div', {}, [
      fxCountButton('讚', '101'),
      fxCountButton('回覆', '1'),
      fxCountButton('轉發', '1'),
    ]),
  ]);
}

// 回文詳情頁的 focus 容器(實測 fixture 06):內文 span 內嵌「翻譯」按鈕
// (cleanElementText 會剝掉)，內文之後是整列包在 [role="button"] 內的配樂
// 標示列，再來是互動列(計數未載入、span 為空字串)，最後是不在按鈕內的
// 「尚無回覆」區段標題。
function createReplyFocusContainer() {
  return el('div', { 'data-pressable-container': 'true' }, [
    fxAuthorBlock(),
    fxTimestamp('3小時'),
    el('div', {}, [
      el('span', { dir: 'auto' }, [
        el('span', {}, [txt(FX_LINE_1)]),
        el('div', {}, [el('div', { role: 'button' }, [el('span', {}, [txt('翻譯')])])]),
      ]),
    ]),
    el('div', { role: 'button' }, [
      el('div', {}, [el('svg', { 'aria-label': '播放', role: 'img' }, [])]),
      el('div', {}, [el('span', { dir: 'auto' }, [txt(FX_MUSIC_ROW)])]),
    ]),
    el('div', {}, [fxCountButton('讚', ''), fxCountButton('回覆', ''), fxCountButton('轉發', '')]),
    el('div', {}, [el('div', {}, [el('span', { dir: 'auto' }, [txt('尚無回覆')])])]),
  ]);
}

// 取 window.TCLPostIcon:用本檔既有的假 document 載入 post-icon.js(容器
// 選擇器回空陣列，載入時不會真的注入任何東西)，拿守衛內才掛上去的
// extractPostInfo。
//
// 這裡不走 loadPostIconInFakeDom 的 vm sandbox:vm.createContext 會另開一
// 個 realm，realm 內 `{}` 的原型是該 realm 自己的 Object.prototype，而
// node:assert/strict 的 deepEqual 連原型一起比，extractPostInfo 回傳的物件
// 永遠對不上本檔寫的物件字面量。改用 new Function 在同一個 realm 內餵同一
// 組假全域，回傳值就是一般物件。與 sandbox 相同的有三點:同一份假
// document、同一份假 chrome、看不到 module 所以走 root.TCLPostIcon 分支。
// 差別是這樣載入時模組看得到 Node realm 其餘的全域(process／globalThis／
// navigator 等);post-icon.js 取瀏覽器全域一律走 root. 前綴(root.location／
// root.navigator／root.getComputedStyle)，目前沒有用到裸全域，撞不到。
function loadPostIconApi() {
  const win = {
    location: { origin: 'https://www.threads.com' },
    navigator: {},
    getComputedStyle: () => ({ color: '' }),
  };
  const load = new Function(
    'window',
    'document',
    'console',
    'chrome',
    'setTimeout',
    'clearTimeout',
    'URL',
    SRC
  );
  load(
    win,
    createFakeDocument(0),
    { warn() {}, error() {}, log() {} },
    { runtime: { id: 'tcl-test-ext' } },
    setTimeout,
    clearTimeout,
    URL
  );
  const api = win.TCLPostIcon;
  assert.equal(typeof api.extractPostInfo, 'function', '載入後應取得 extractPostInfo');
  return api;
}

function excerptOf(container) {
  return loadPostIconApi().extractPostInfo(container).excerpt;
}

// ---- D47:COUNT_LIKE_RE／classifyExcerptCandidate 的計數字串涵蓋範圍 ----

test('classifyExcerptCandidate(D47):中文計數單位(萬／億)與千分位一律中止收集(stop)', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('5.8萬', true), 'stop');
  assert.equal(classifyExcerptCandidate('5.8 萬', true), 'stop');
  assert.equal(classifyExcerptCandidate('3億', true), 'stop');
  assert.equal(classifyExcerptCandidate('12,345', true), 'stop');
});

test('classifyExcerptCandidate(D47):數字與單位間的不斷行空白(U+00A0)、全形空白(U+3000)、半形空白都要認出來', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('6.5 萬', true), 'stop', '實測讚數原文用 U+00A0');
  assert.equal(classifyExcerptCandidate('6.5　萬', true), 'stop');
  assert.equal(classifyExcerptCandidate('1.2 K', true), 'stop');
});

test('classifyExcerptCandidate(D47):讚數跳動時同一候選內串到兩個計數(「5.9 萬6.0 萬」)，整串仍視為計數而中止(stop)', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('5.9 萬6.0 萬', true), 'stop');
  assert.equal(classifyExcerptCandidate('5.9 萬6.0 萬', true), 'stop');
});

test('classifyExcerptCandidate(D47 誤殺面):內文句子裡含計數字樣但整串不只是計數，仍視為內文(push)', () => {
  const { classifyExcerptCandidate } = loadPostIcon();

  assert.equal(classifyExcerptCandidate('今天賣了 5.8 萬', true), 'push');
  assert.equal(classifyExcerptCandidate('今天賣了 5.8 萬', false), 'push');
  assert.equal(classifyExcerptCandidate('1.2K 人按讚很多嗎', true), 'push');
});

// ---- D48:extractExcerpt 排除「自己在 [role='button'] 內」的候選 ----

test('extractExcerpt(D48 主文):互動列讚數(6.5 萬)不得混進摘要，摘要只剩內文', () => {
  const excerpt = excerptOf(createMainPostContainer());

  assert.equal(excerpt, FX_LINE_1);
  assert.equal(excerpt.indexOf('萬'), -1, '讚數不得出現在摘要內');
  assert.equal(excerpt.indexOf(FX_AUTHOR), -1, '作者名整串在 <a> 內，既有的跳過規則要維持');
});

test('extractExcerpt(D48 主文):多行內文照樣完整收集，互動列計數仍被擋在外', () => {
  const excerpt = excerptOf(createMainPostContainer({ lines: [FX_LINE_1, FX_LINE_2] }));

  assert.equal(excerpt, FX_LINE_1 + '\n' + FX_LINE_2);
});

test('extractExcerpt(D48 回文 focus):整列包在 [role="button"] 內的配樂標示列不得混進摘要', () => {
  const excerpt = excerptOf(createReplyFocusContainer());

  assert.equal(
    excerpt.indexOf(FX_MUSIC_ROW),
    -1,
    '配樂標示列在 [role="button"] 內，屬互動元素不是內文'
  );
});

// 嚴格讀法:配樂列被跳過(skip、不中止)之後，後面「尚無回覆」這種同樣不在
// 按鈕內的區段標題會接著被收——那不是貼文內文，摘要應該就停在內文。上一
// 條只釘「配樂列不得出現」，這條額外釘「摘要乾淨等於內文」。
test('extractExcerpt(D48 回文 focus):摘要等於內文本身，不帶配樂列也不帶「尚無回覆」區段標題', () => {
  assert.equal(excerptOf(createReplyFocusContainer()), FX_LINE_1);
});

test('extractExcerpt(D48 回文):讚數 101 照舊不入摘要，摘要等於內文', () => {
  assert.equal(excerptOf(createReplyContainer()), FX_LINE_1);
});

test('extractExcerpt(D47 第二道):連續兩個計數候選都不在按鈕內時，兩個都不得進入摘要', () => {
  const container = el('div', { 'data-pressable-container': 'true' }, [
    fxAuthorBlock(),
    fxTimestamp('17小時'),
    fxBodyBlock([FX_LINE_1]),
    el('span', { dir: 'auto' }, [txt('6.5 萬')]),
    el('span', { dir: 'auto' }, [txt('6.6 萬')]),
  ]);

  assert.equal(excerptOf(container), FX_LINE_1);
});

test('extractExcerpt(誤殺面):內文行本身含「5.8 萬」「1.2K」這種數字字樣，照樣完整收進摘要', () => {
  const excerpt = excerptOf(
    createMainPostContainer({ lines: ['今天賣了 5.8 萬', '1.2K 人按讚很多嗎'], withActionRow: false })
  );

  assert.equal(excerpt, '今天賣了 5.8 萬\n1.2K 人按讚很多嗎');
});

test('extractExcerpt(既有保證):巢狀引用貼文容器內的文字不屬於本容器，不入摘要', () => {
  const quoted = createMainPostContainer({ lines: ['引用貼文的內文'], withActionRow: false });
  const container = el('div', { 'data-pressable-container': 'true' }, [
    fxAuthorBlock(),
    fxTimestamp('17小時'),
    fxBodyBlock([FX_LINE_1]),
    el('div', {}, [quoted]),
  ]);

  const excerpt = excerptOf(container);
  assert.equal(excerpt, FX_LINE_1);
  assert.equal(excerpt.indexOf('引用貼文的內文'), -1);
});

test('extractExcerpt(D48 邊界):[role="button"] 祖先落在容器「外面」時不算數，內文照收', () => {
  const container = createMainPostContainer({ withActionRow: false });
  // 整個貼文容器被外層的可點擊包裝夾住(祖先鏈往上走得出 [role="button"])，
  // 但那顆按鈕不在容器內，不該讓整個容器的內文都被跳過。
  el('div', { role: 'button' }, [container]);

  assert.equal(excerptOf(container), FX_LINE_1);
});

// 容器節點自己帶 role="button" 時，候選的祖先鏈上找得到按鈕，但那顆按鈕
// 就是容器本身、不是容器「內」的互動元素——內文不得因此被整篇丟掉。
test('extractExcerpt(D48 邊界):容器節點自己帶 role="button" 不算容器內的互動列，內文照收', () => {
  const container = el('div', { 'data-pressable-container': 'true', role: 'button' }, [
    fxAuthorBlock(),
    fxTimestamp('17小時'),
    fxBodyBlock([FX_LINE_1]),
  ]);

  assert.equal(excerptOf(container), FX_LINE_1);
});

// 按鈕內的候選也可能排在內文「之前」(影片貼文的「追蹤」鈕就在內文上方)，
// 此時還沒收集到任何內文，只能跳過這個候選繼續往下看;若改成一律中止，摘要
// 會在第一顆按鈕就整篇空掉。
test('extractExcerpt(D48 分流):內文之前就出現按鈕內的候選時只跳過不中止，摘要仍是內文', () => {
  const container = el('div', { 'data-pressable-container': 'true' }, [
    fxAuthorBlock(),
    el('div', {}, [el('div', { role: 'button' }, [el('span', { dir: 'auto' }, [txt('追蹤')])])]),
    fxTimestamp('17小時'),
    fxBodyBlock([FX_LINE_1]),
    el('div', {}, [fxCountButton('讚', FX_LIKE_COUNT)]),
  ]);

  const excerpt = excerptOf(container);
  assert.equal(excerpt, FX_LINE_1, '內文之前的按鈕只該被跳過，摘要不得整篇空掉');
  assert.equal(excerpt.indexOf('追蹤'), -1, '按鈕內的文字不得進摘要');
});

// ---- 三路徑共用:貼文按鈕／右鍵／自動淨化都經 extractPostInfo(右鍵與自
// 動淨化走 bridge.js 的 root.TCLPostIcon.extractPostInfo)，驗一處即可 ----

test('extractPostInfo:主文容器回傳的 author／handle／excerpt 三欄都乾淨(摘要不含讚數)', () => {
  const info = loadPostIconApi().extractPostInfo(createMainPostContainer());

  assert.deepEqual(info, {
    author: FX_AUTHOR,
    handle: '@' + FX_AUTHOR,
    excerpt: FX_LINE_1,
  });
});

// ---- isSamePostPath(findContainerByCleanUrl 的可測核心——比對
// 兩個網址／href 是否指向同一篇貼文，容忍尾隨斜線／query／hash 差異，也
// 容忍一邊絕對網址、一邊頁面上常見的相對路徑) ----

test('isSamePostPath:絕對網址與相對路徑，path 段相同視為同一篇貼文', () => {
  const { isSamePostPath } = loadPostIcon();

  assert.equal(
    isSamePostPath('https://www.threads.com/@yuki4382/post/DcDrsdAmhlU', '/@yuki4382/post/DcDrsdAmhlU'),
    true
  );
});

test('isSamePostPath:容忍尾隨斜線與 query/hash 差異', () => {
  const { isSamePostPath } = loadPostIcon();

  assert.equal(
    isSamePostPath('https://www.threads.com/@x/post/abc', '/@x/post/abc/?xmt=1#s'),
    true
  );
});

test('isSamePostPath:path 段不同(不同 handle 或 post id)回傳 false', () => {
  const { isSamePostPath } = loadPostIcon();

  assert.equal(isSamePostPath('https://www.threads.com/@a/post/1', '/@b/post/1'), false);
  assert.equal(isSamePostPath('https://www.threads.com/@a/post/1', '/@a/post/2'), false);
});

test('isSamePostPath:任一邊非字串／組不出合法網址一律回傳 false，不丟例外', () => {
  const { isSamePostPath } = loadPostIcon();

  assert.equal(isSamePostPath(null, '/@a/post/1'), false);
  assert.equal(isSamePostPath('/@a/post/1', undefined), false);
  assert.equal(isSamePostPath(12345, '/@a/post/1'), false);
});

test('findContainerByCleanUrl:Node 環境(無 document)一律回傳 null，不丟例外', () => {
  const { findContainerByCleanUrl } = loadPostIcon();

  assert.equal(findContainerByCleanUrl('https://www.threads.com/@a/post/1'), null);
  assert.equal(findContainerByCleanUrl(null), null);
});

// ---- resolveFailureToastKey(share/strip 解析在 Threads 頁面內失敗時，
// 頁內 toast 要顯示的 i18n key 對應) ----

test('resolveFailureToastKey:三個已知失敗原因各自對應 background.js 右鍵路徑既有的失敗文案 key', () => {
  const { resolveFailureToastKey } = loadPostIcon();

  assert.equal(resolveFailureToastKey('invalid-url'), 'bgInvalid');
  assert.equal(resolveFailureToastKey('network-error'), 'bgNetworkError');
  assert.equal(resolveFailureToastKey('format-error'), 'bgFormatError');
});

test('resolveFailureToastKey:未知原因(含非字串)一律 fallback 到 bgUnexpected', () => {
  const { resolveFailureToastKey } = loadPostIcon();

  assert.equal(resolveFailureToastKey('no-response'), 'bgUnexpected');
  assert.equal(resolveFailureToastKey('bridge-exception'), 'bgUnexpected');
  assert.equal(resolveFailureToastKey('Extension context invalidated'), 'bgUnexpected');
  assert.equal(resolveFailureToastKey(null), 'bgUnexpected');
  assert.equal(resolveFailureToastKey(undefined), 'bgUnexpected');
});

// ---- resolvePostCopyEnabled(postCopyEnabled 開關，預設 true，只有明確
// false 才關閉) ----

test('resolvePostCopyEnabled:明確 false 才視為關閉', () => {
  const { resolvePostCopyEnabled } = loadPostIcon();

  assert.equal(resolvePostCopyEnabled(false), false);
});

test('resolvePostCopyEnabled:true／undefined／未設定過／其他雜訊值一律視為啟用(預設 true)', () => {
  const { resolvePostCopyEnabled } = loadPostIcon();

  assert.equal(resolvePostCopyEnabled(true), true);
  assert.equal(resolvePostCopyEnabled(undefined), true);
  assert.equal(resolvePostCopyEnabled(null), true);
  assert.equal(resolvePostCopyEnabled('false'), true);
  assert.equal(resolvePostCopyEnabled(0), true);
});

// ---- 孤兒偵測退場(擴充功能更新後，既開分頁的舊 content script 仍在跑，
// 但 chrome.runtime.id 已消失:sendMessage 必失敗、紀錄靜默丟失。判準與
// 退場行為) ----

test('孤兒偵測:runtime.id 消失即視為情境失效，該實例整個退場——不再掃描注入，並留下 console 訊號', () => {
  const { isExtensionContextLost } = loadPostIcon();

  // 判準本身:runtime 物件還在、只有 id 消失，正是孤兒 content script 的
  // 形狀(這也是 sendMessage 會同步丟 Extension context invalidated 的前
  // 兆)。chrome 或 chrome.runtime 整個缺席同樣視為失效(訊息本來就送不出
  // 去，行為等價)。
  assert.equal(isExtensionContextLost({ runtime: { id: 'abcdefghijklmnop' } }), false, '正常 content script');
  assert.equal(isExtensionContextLost({ runtime: { id: undefined } }), true, '孤兒:id 消失');
  assert.equal(isExtensionContextLost({ runtime: { id: '' } }), true);
  assert.equal(isExtensionContextLost({}), true);
  assert.equal(isExtensionContextLost(null), true);
  assert.equal(isExtensionContextLost(undefined), true);

  // 退場行為:孤兒實例載入(或既有實例的下一輪掃描)必須整個短路，不得再
  // 去掃貼文容器——否則它會繼續注入「點了會複製、但不會記錄」的假 icon，
  // 還會跟自癒重注入的新實例搶同一個容器(冪等檢查先到先贏)。
  const doc = createFakeDocument(0);
  const { warnings } = loadPostIconInFakeDom(doc, { runtime: {} });

  assert.equal(
    doc.selectors.includes(CONTAINER_SELECTOR),
    false,
    '孤兒實例不得再掃描貼文容器(掃描前的 runtime 自檢必須先短路)'
  );
  assert.equal(
    warnings.some((line) => line.includes('擴充功能情境已失效')),
    true,
    '孤兒退場必須留下 console.warn，不得像修正前那樣完全無聲'
  );
});

// ---- 自癒重注入的清場(background.js 的 reinjectIntoOpenTabs 會在擴充功能
// 更新後把本腳本重新注入既開分頁) ----

test('自癒重注入:新實例啟動時先清掉舊孤兒殘留的 .tcl-copy-icon 節點，冪等檢查才不會誤判「已注入」而整頁跳過', () => {
  const doc = createFakeDocument(2);
  const { api } = loadPostIconInFakeDom(doc, { runtime: { id: 'abcdefghijklmnop' } });

  // 這就是坑本身:hasExistingIcon 只看得到「有沒有 .tcl-copy-icon 節點」，
  // 分不出那顆是誰注入的。清場沒做的話，重注入的新腳本會在每個容器上都
  // 判定「已經注入過」，頁面就只剩一排點了不會記錄的假 icon。
  assert.equal(api.hasExistingIcon({ querySelector: () => ({}) }), true, '冪等檢查確實只認節點在不在');

  assert.deepEqual(doc.currentIcons(), [], '舊實例殘留的 icon 節點必須在啟動時全數移除');
  assert.deepEqual(doc.removedIndexes, [0, 1], '兩顆殘留 icon 都要從各自的父節點上摘掉(逐一移除，不漏刪)');
  assert.equal(
    doc.selectors.includes(CONTAINER_SELECTOR),
    true,
    '清場之後要照常掃描注入(情境有效的新實例不該被自己的孤兒自檢擋下)'
  );
});

// ============================================================
// 冪等交棒:同一 ISOLATED world 雙注入(手動 F5 × 自癒重注入
// 的毫秒級競態，或更新後的重注入)時，第二個實例先讓第一個退場(斷
// MutationObserver、清它那批 icon)再接手，消除「雙 observer → 雙落盤 →
// 時間軸假事件」。用可觀測的假 MutationObserver 驗證舊 observer 被
// disconnect、新 observer 仍活著。
// ============================================================

// 在同一個假 DOM／window 上把 post-icon.js 連載兩次，回傳建立過的所有假
// MutationObserver(依建立序)，供斷言「舊的被 disconnect、新的仍活著」。
function loadPostIconTwiceInFakeDom() {
  const doc = createFakeDocument(0);
  const observers = [];
  function FakeMutationObserver(cb) {
    this.cb = cb;
    this.disconnected = false;
    this.observed = false;
    observers.push(this);
  }
  FakeMutationObserver.prototype.observe = function () {
    this.observed = true;
  };
  FakeMutationObserver.prototype.disconnect = function () {
    this.disconnected = true;
  };
  const win = {
    location: { origin: 'https://www.threads.com' },
    navigator: {},
    getComputedStyle: () => ({ color: '' }),
  };
  const sandbox = {
    window: win,
    document: doc,
    console: { warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    URL,
    MutationObserver: FakeMutationObserver,
    // 帶有效 runtime.id:情境有效，兩次載入都不因孤兒自檢而提早退場，單純
    // 驗冪等交棒本身。
    chrome: { runtime: { id: 'tcl-test-ext' } },
  };
  runInSandbox(SRC, sandbox); // 實例 A
  runInSandbox(SRC, sandbox); // 實例 B:init 開頭透過 __tclPostIconDispose 讓 A 退場
  return { observers, window: win };
}

test('冪等交棒:同一 window 二次載入 post-icon，舊實例的 MutationObserver 被 disconnect，新實例的仍在運作', () => {
  const { observers, window: win } = loadPostIconTwiceInFakeDom();

  assert.equal(observers.length, 2, '兩次載入應各自建立一個 MutationObserver');
  assert.equal(observers[0].disconnected, true, '舊實例(A)的 observer 應在交棒時被 disconnect');
  assert.equal(observers[1].disconnected, false, '新實例(B)的 observer 應仍在運作，未被誤斷');
  assert.equal(observers[1].observed, true, '新實例(B)應照常 observe 接手掃描');
  assert.equal(
    typeof win.__tclPostIconDispose,
    'function',
    '交棒握把應留在 window 上，供再下一個實例接手'
  );
});

// ============================================================
// 【互動列辨識的假 DOM:只服務「按鈕標籤改由 svg > title 提供」這組測試】
// 這裡不是通用 DOM harness，只搭出一顆貼文容器所需的最小結構——兩條結構
// 相同的候選列(影片播放器工具列 + 真正的互動列)，每條四顆 [role="button"]
// 包著一顆 svg。svg 的標籤可切換成「舊結構:aria-label + title 並存」或
// 「新結構:只有 title」，用來驗證找互動列與取色兩條路徑都不再硬依賴
// aria-label。載入 post-icon.js 時 init() 會同步跑完一輪 scanAndInject，
// 注入結果直接從假節點上觀測。
// ============================================================

const VIDEO_TOOLBAR_LABELS = ['追蹤', '更多', '已靜音', '排序'];
const ACTION_ROW_LABELS = ['讚', '回覆', '轉發', '分享'];
// 逐顆給不同顏色:applyNativeColor 規定取「最後一顆」(分享小飛機)當色樣，
// 取錯任何一顆都會被這組值抓出來(第一顆刻意用按過讚的紅色)。
const ACTION_ROW_COLORS = [
  'rgb(255, 48, 64)',
  'rgb(11, 11, 11)',
  'rgb(22, 22, 22)',
  'rgb(153, 153, 153)',
];

// labelMode:'legacy' = svg 同時有 aria-label 與 <title>(Threads 2026-09
// 改版前)；'title-only' = svg 只剩 <title>(改版後的現況)。
function createFakeActionSvg(label, labelMode, color) {
  return {
    nodeName: 'svg',
    __color: color,
    getAttribute(name) {
      if (name !== 'aria-label') return null;
      return labelMode === 'legacy' ? label : null;
    },
    querySelector(sel) {
      return sel === 'title' ? { textContent: label } : null;
    },
  };
}

// 按鈕 wrapper:一顆 [role="button"] 包著一顆 svg。querySelector 只模擬
// 實作用得到的兩種後代選擇器語義——帶 [aria-label] 的版本必須在 svg 沒有
// 該屬性時落空(這正是 2026-09 改版踩到的坑)，不帶屬性的版本一律命中。
function createFakeButtonWrapper(svg) {
  return {
    nodeName: 'div',
    __svg: svg,
    nextSibling: undefined,
    querySelector(sel) {
      if (sel.indexOf('svg') === -1) return null;
      if (sel.indexOf('svg[aria-label]') !== -1 && svg.getAttribute('aria-label') === null) {
        return null;
      }
      return svg;
    },
  };
}

function createFakeRow(labels, labelMode, colors) {
  const svgs = labels.map((label, i) =>
    createFakeActionSvg(label, labelMode, colors ? colors[i] : 'rgb(0, 0, 0)')
  );
  const row = {
    nodeName: 'div',
    children: svgs.map(createFakeButtonWrapper),
    container: null,
    // ---- 測試專用觀測點:被注入的 icon 節點(尚未注入為 null) ----
    injectedIcon: null,
    querySelector(sel) {
      return sel === '.tcl-copy-icon' ? row.injectedIcon : null;
    },
    querySelectorAll(sel) {
      if (sel.indexOf('svg') === -1) return [];
      if (sel.indexOf('svg[aria-label]') !== -1) {
        return svgs.filter((svg) => svg.getAttribute('aria-label') !== null);
      }
      return svgs.slice();
    },
    closest(sel) {
      return sel === CONTAINER_SELECTOR ? row.container : null;
    },
    insertBefore(node, ref) {
      const idx = ref ? row.children.indexOf(ref) : -1;
      if (idx === -1) row.children.push(node);
      else row.children.splice(idx, 0, node);
      row.injectedIcon = node;
      return node;
    },
  };
  return row;
}

// 回傳 { doc, videoToolbar, actionRow }:容器內依文件序放入播放器工具列與
// 互動列兩條候選，兩者結構完全相同，只能靠按鈕標籤消歧。
function createFakeFeedDocument(labelMode) {
  const videoToolbar = createFakeRow(VIDEO_TOOLBAR_LABELS, labelMode, null);
  const actionRow = createFakeRow(ACTION_ROW_LABELS, labelMode, ACTION_ROW_COLORS);
  const rows = [videoToolbar, actionRow];

  const container = {
    nodeName: 'div',
    querySelector(sel) {
      if (sel !== '.tcl-copy-icon') return null;
      return videoToolbar.injectedIcon || actionRow.injectedIcon || null;
    },
    querySelectorAll(sel) {
      return sel === 'div' ? rows.slice() : [];
    },
  };
  rows.forEach((row) => {
    row.container = container;
  });

  const doc = {
    readyState: 'complete',
    head: createStubNode('head'),
    body: createStubNode('body'),
    documentElement: createStubNode('html'),
    getElementById() {
      return null;
    },
    createElement(tag) {
      return createStubNode(tag);
    },
    addEventListener() {},
    querySelectorAll(selector) {
      return selector === CONTAINER_SELECTOR ? [container] : [];
    },
  };

  return { doc, videoToolbar, actionRow };
}

// 載入 post-icon.js 並跑完一輪同步掃描注入;回傳兩條候選列供斷言。
function injectIntoFakeFeed(labelMode) {
  const { doc, videoToolbar, actionRow } = createFakeFeedDocument(labelMode);
  const sandbox = {
    window: {
      location: { origin: 'https://www.threads.com' },
      navigator: {},
      getComputedStyle: (node) => ({ color: node && node.__color ? node.__color : '' }),
    },
    document: doc,
    console: { warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    URL,
    chrome: { runtime: { id: 'tcl-test-ext' } },
  };
  runInSandbox(SRC, sandbox);
  return { videoToolbar, actionRow };
}

test('找互動列:四顆按鈕 svg 只有 <title> 沒有 aria-label(Threads 2026-09 改版)時，仍要認出互動列並注入 icon', () => {
  const { videoToolbar, actionRow } = injectIntoFakeFeed('title-only');

  assert.notEqual(
    actionRow.injectedIcon,
    null,
    'svg 只剩 <title> 時仍應找到互動列並注入 icon(改版後 aria-label 已不存在)'
  );
  assert.equal(actionRow.injectedIcon.className, 'tcl-copy-icon');
  assert.equal(
    videoToolbar.injectedIcon,
    null,
    '影片播放器工具列結構相同但不是互動列，不該被注入'
  );
});

test('找互動列(回歸):舊結構 svg 帶 aria-label 時照舊認出互動列並注入 icon', () => {
  const { videoToolbar, actionRow } = injectIntoFakeFeed('legacy');

  assert.notEqual(actionRow.injectedIcon, null, '舊結構不得因為放寬選擇器而失效');
  assert.equal(actionRow.injectedIcon.className, 'tcl-copy-icon');
  assert.equal(videoToolbar.injectedIcon, null, '影片播放器工具列不該被注入');
});

test('applyNativeColor:列內 svg 都沒有 aria-label 時，仍取到最後一顆 svg(分享)的顏色', () => {
  const { actionRow } = injectIntoFakeFeed('title-only');

  assert.notEqual(actionRow.injectedIcon, null, '取色的前提是 icon 有被注入');
  assert.equal(
    actionRow.injectedIcon.style.color,
    ACTION_ROW_COLORS[ACTION_ROW_COLORS.length - 1],
    '應取最後一顆 svg 的顏色，而不是第一顆(按過讚會是紅色)或完全取不到'
  );
});

test('applyNativeColor(回歸):舊結構 svg 帶 aria-label 時同樣取到最後一顆 svg 的顏色', () => {
  const { actionRow } = injectIntoFakeFeed('legacy');

  assert.notEqual(actionRow.injectedIcon, null);
  assert.equal(actionRow.injectedIcon.style.color, ACTION_ROW_COLORS[ACTION_ROW_COLORS.length - 1]);
});

// ============================================================
// i18n.js 的 key:iconTooltip(圖示滑鼠提示)、iconCopied(複製成功提示)，
// zh/en 兩份字典都要有這兩個 key 且非空字串;既有的 zh/en key 集合對齊測試
// 在 test/i18n.test.js。
// ============================================================

test('i18n:zh/en 字典都新增 iconTooltip、iconCopied 兩個 key，且為非空字串', () => {
  ['iconTooltip', 'iconCopied'].forEach((key) => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(i18n.STRINGS.zh, key),
      true,
      `zh 字典應有 ${key}`
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(i18n.STRINGS.en, key),
      true,
      `en 字典應有 ${key}`
    );
    assert.equal(typeof i18n.STRINGS.zh[key], 'string', `zh.${key} 應為字串`);
    assert.notEqual(i18n.STRINGS.zh[key], '', `zh.${key} 不得為空字串`);
    assert.equal(typeof i18n.STRINGS.en[key], 'string', `en.${key} 應為字串`);
    assert.notEqual(i18n.STRINGS.en[key], '', `en.${key} 不得為空字串`);
  });
});

test('i18n:t() 取出的 iconTooltip／iconCopied 文案內容正確', () => {
  assert.equal(i18n.t('zh', 'iconTooltip'), '複製原始連結');
  assert.equal(i18n.t('en', 'iconTooltip'), 'Copy original link');
  assert.equal(i18n.t('zh', 'iconCopied'), '已複製原始連結');
  assert.equal(i18n.t('en', 'iconCopied'), 'Original link copied');
});
