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
const path = require('node:path');

// 尚未實作 post-icon.js 時 require 會丟 MODULE_NOT_FOUND：刻意延遲到各
// 測試內部才載入，讓紅燈落在個別測試上，而不是整個測試檔在載入階段就崩掉
// (沿用 test/popup.test.js 的 loadPopup() 模式)。
function loadPostIcon() {
  return require(path.join(__dirname, '..', 'post-icon.js'));
}

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

test('pickPermalink:全部候選都以 /media 結尾時回傳 null', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(pickPermalink(['/@x/post/abc/media']), null);
});

test('pickPermalink:排除 /media 結尾時大小寫不敏感(例如 /MEDIA)', () => {
  const { pickPermalink } = loadPostIcon();

  assert.equal(pickPermalink(['/@a/post/X/MEDIA']), null);
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
      { href: '/@b/post/2', ownContainer: false }, // 屬巢狀貼文,排除
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

test('buildPostUrl:href 非字串(null／undefined／數字)一律回傳 null，不丟例外', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(buildPostUrl(null, 'https://www.threads.com'), null);
  assert.equal(buildPostUrl(undefined, 'https://www.threads.com'), null);
  assert.equal(buildPostUrl(12345, 'https://www.threads.com'), null);
});

test('buildPostUrl:origin 非合法絕對來源時回傳 null，不丟例外', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(buildPostUrl('/@x/post/abc', 'not-a-url'), null);
  assert.equal(buildPostUrl('/@x/post/abc', null), null);
  assert.equal(buildPostUrl('/@x/post/abc', undefined), null);
});

test('buildPostUrl:href 為 javascript: 這類非常規 scheme 時回傳 null，不丟例外', () => {
  const { buildPostUrl } = loadPostIcon();

  assert.equal(buildPostUrl('javascript:alert(1)', 'https://www.threads.com'), null);
});

test('buildPostUrl:href 為 //evil.com/x 這類協定相對輸入時回傳 null，不丟例外', () => {
  const { buildPostUrl } = loadPostIcon();

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

// ---- pickActionRowIndex(結構相同的多個互動列候選消歧：影片貼文會多一條
// 播放器工具列，結構上也符合「>=4 個子元素、每個都有 svg[aria-label]」，
// 需要靠 aria-label 白名單挑出真正的讚/回覆/轉發/分享列) ----

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

// ---- classifyExcerptCandidate(0.5.0 貼文收藏庫:extractExcerpt 逐段決
// 策 push／skip／stop 的純函式，PM 審查後修正兩條規則) ----

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

// ---- isSamePostPath(方案甲:findContainerByCleanUrl 的可測核心——比對
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

// ---- resolveFailureToastKey(使用者變更設定規格:share/strip 解析在
// Threads 頁面內失敗時，頁內 toast 要顯示的 i18n key 對應) ----

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

// ---- resolvePostCopyEnabled(使用者變更設定規格:postCopyEnabled 開關，
// 預設 true，只有明確 false 才關閉) ----

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

// ============================================================
// i18n.js 新增 key:iconTooltip(圖示滑鼠提示)、iconCopied(複製成功提示)。
// zh/en 兩份字典都要有這兩個 key 且非空字串；既有的 zh/en key 集合對齊
// 測試在 test/i18n.test.js(不動它)，等實作補上這兩個 key 後會一併通過。
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
