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
  assert.equal(i18n.t('zh', 'iconTooltip'), '複製連結');
  assert.equal(i18n.t('en', 'iconTooltip'), 'Copy link');
  assert.equal(i18n.t('zh', 'iconCopied'), '已複製原始連結');
  assert.equal(i18n.t('en', 'iconCopied'), 'Original link copied');
});
