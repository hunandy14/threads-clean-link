// test/favorites.test.js — background.js 的貼文收藏庫(0.5.0 基座)行為
// 契約:favoriteToggle 訊息的 toggle 語意、id 導出與正規化、上限拒收、
// url 驗證、欄位截斷/丟棄、storage 失敗處理。互動列書籤 icon 與 options
// 收藏分頁皆由其他車道實作,本檔只鎖 background 這側的訊息協定與 schema。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./support/helpers');

// background.js 依賴共用 i18n 模組(真實環境靠 importScripts 載入);
// 測試把 i18n.js 原始碼接在前面,兩支腳本共用同一個 sandbox 全域。
const SRC =
  fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';
const FAV_ID = '@dafucoding/post/DbezfB0gYvP';

function neverFetch() {
  return async (url) => {
    throw new Error('favoriteToggle 不應觸發任何 fetch:' + url);
  };
}

// 建立最小 chrome mock 並載入 background.js。localSeed 預填 storage.local
// 的 favorites 陣列(測上限/去重時用)。
function loadFavorites(localSeed) {
  const onMessageListeners = [];
  const storage = createChromeStorage({}, localSeed ? { favorites: localSeed } : {});
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: () => {} },
    },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1 },
    storage: storage.api,
  };
  runInSandbox(SRC, { chrome, fetch: neverFetch(), console });
  return { storage, onMessageListeners };
}

// 刻意不掛 chrome.storage,模擬 hasStorageLocal() 判假的情境。
function loadFavoritesNoStorage() {
  const onMessageListeners = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: () => {} },
    },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1 },
  };
  runInSandbox(SRC, { chrome, fetch: neverFetch(), console });
  return { onMessageListeners };
}

// 建立 chrome.storage.local.get/set 可依需求丟例外的 mock,測 storage
// 失敗路徑用(createChromeStorage 沒有「失敗模式」,這裡另外手刻)。
function loadFavoritesWithFailingStorage({ failGet = false, failSet = false, seed = [] } = {}) {
  const onMessageListeners = [];
  const setCalls = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: () => {} },
    },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1 },
    storage: {
      local: {
        get: async () => {
          if (failGet) throw new Error('boom-get');
          return { favorites: seed };
        },
        set: async (items) => {
          setCalls.push(items);
          if (failSet) throw new Error('boom-set');
        },
      },
    },
  };
  runInSandbox(SRC, { chrome, fetch: neverFetch(), console });
  return { onMessageListeners, setCalls };
}

// 派送訊息給全部已註冊的 onMessage 監聽器(比照 background.test.js 的
// sendRuntimeMessage 慣例),同步蒐集各監聽器的回傳值(true/false 通道
// 契約),非同步蒐集 sendResponse 收到的回應。
function dispatch(onMessageListeners, message) {
  const returns = [];
  const response = new Promise((resolve) => {
    onMessageListeners.forEach((fn) => {
      returns.push(fn(message, {}, resolve));
    });
  });
  return { returns, response };
}

function seedFavorites(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `@seeduser/post/P${i}`,
    url: `https://www.threads.com/@seeduser/post/P${i}`,
    at: 1000 + i,
  }));
}

// ============================================================
// 訊息通道契約
// ============================================================

test('onMessage 契約:favoriteToggle 回傳 true 保持通道,其他訊息類型該監聽器回傳 false', async () => {
  const { onMessageListeners } = loadFavorites();
  const { returns, response } = dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL });

  // 三支監聽器(resolveShare/cleanedNotice/favoriteToggle)都會被派送到,
  // 只有相符類型的那支回傳 true,其餘回傳 false;至少要有一個 true。
  assert.ok(returns.includes(true), 'favoriteToggle 訊息應有監聽器回傳 true 保持通道開啟');
  assert.equal(returns.filter((r) => r === true).length, 1, '只該有一支監聽器認領 favoriteToggle');

  const res = await response;
  assert.equal(res.ok, true);
});

test('onMessage 契約:不認得的訊息類型,所有監聽器都回傳 false 且不呼叫 sendResponse', () => {
  const { onMessageListeners } = loadFavorites();
  let called = false;
  const returns = onMessageListeners.map((fn) => fn({ type: 'somethingElse' }, {}, () => {
    called = true;
  }));
  assert.deepEqual(returns, [false, false, false]);
  assert.equal(called, false);
});

// ============================================================
// toggle 新增 / 移除 / 去重(依 id)
// ============================================================

test('新增:合法 url 且不存在收藏時,存入陣列頭並回 {ok:true, saved:true}', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  const { response } = dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: CLEAN_URL,
    author: 'Dafu',
    handle: '@dafucoding',
    excerpt: 'hello world',
  });
  const res = await response;

  assert.equal(res.ok, true);
  assert.equal(res.saved, true);

  const list = storage.localSnapshot().favorites;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, FAV_ID);
  assert.equal(list[0].url, CLEAN_URL);
  assert.equal(list[0].author, 'Dafu');
  assert.equal(list[0].handle, '@dafucoding');
  assert.equal(list[0].excerpt, 'hello world');
  assert.equal(typeof list[0].at, 'number');
});

test('新增:選填欄位全部省略時,條目只有 { id, url, at },不含 author/handle/excerpt 鍵', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;

  const entry = storage.localSnapshot().favorites[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'id', 'url']);
});

test('移除:對已存在的 id 再次 toggle 會移除該筆,回 {ok:true, saved:false}', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  assert.equal(storage.localSnapshot().favorites.length, 1);

  const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;

  assert.equal(res.ok, true);
  assert.equal(res.saved, false);
  assert.equal(storage.localSnapshot().favorites.length, 0);
});

test('去重:第二次 toggle 用「同一貼文的不同 query/hash 變形」,依 id 判定為同一筆並移除', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  assert.equal(storage.localSnapshot().favorites.length, 1);

  const res = await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: `${CLEAN_URL}/?xmt=AQGabc`,
  }).response;

  assert.equal(res.ok, true, 'id 相同即視為同一筆收藏,不因 query/hash 不同而各自成一筆');
  assert.equal(res.saved, false, 'id 相同即視為同一筆收藏,不因 query/hash 不同而各自成一筆');
  assert.equal(storage.localSnapshot().favorites.length, 0);
});

test('新增:陣列採「新在前」——後加入的排在既有收藏之前', async () => {
  const seed = [{ id: '@old/post/OLD1', url: 'https://www.threads.com/@old/post/OLD1', at: 1 }];
  const { storage, onMessageListeners } = loadFavorites(seed);

  await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;

  const list = storage.localSnapshot().favorites;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, FAV_ID, '新加入的收藏應在陣列最前面');
  assert.equal(list[1].id, '@old/post/OLD1');
});

// ============================================================
// id 導出與正規化(尾隨斜線／查詢參數／hash 變形皆導出同一個 id/url)
// ============================================================

const ID_DERIVATION_VARIANTS = [
  { label: '無尾綴(基準形)', url: CLEAN_URL },
  { label: '尾隨斜線', url: `${CLEAN_URL}/` },
  { label: '查詢字串', url: `${CLEAN_URL}?xmt=AQGabc` },
  { label: 'hash', url: `${CLEAN_URL}#section` },
  { label: '尾隨斜線 + 查詢字串', url: `${CLEAN_URL}/?xmt=AQGabc` },
];

test('id 導出:尾隨斜線／查詢參數／hash 等變形,一律導出相同的 id 與正規化後的 url', async () => {
  for (const { label, url } of ID_DERIVATION_VARIANTS) {
    const { storage, onMessageListeners } = loadFavorites();
    const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url }).response;

    assert.equal(res.ok, true, `${label}:應成功新增`);
    assert.equal(res.saved, true, `${label}:應成功新增`);
    const entry = storage.localSnapshot().favorites[0];
    assert.equal(entry.id, FAV_ID, `${label}:id 應正規化為 @user/post/id,不含尾綴`);
    assert.equal(entry.url, CLEAN_URL, `${label}:url 應正規化為乾淨網址,不含尾隨斜線/query/hash`);
  }
});

// ============================================================
// 並發序列化(PM 審查修正):get→判斷→set 這段讀-改-寫必須序列化，否則
// 兩個幾乎同時送到的 toggle 各自基於同一份舊快照做決策，後寫入的一方
// 會直接覆蓋掉前一方的結果——審查已用這兩個案例重現丟資料。
//
// 兩則 dispatch() 呼叫刻意「不 await 中間結果」，同步連續呼叫兩次:
// handleFavoriteToggle 在 enqueueFavoriteWrite 之前全是同步程式碼，兩次
// 呼叫會依呼叫順序同步把各自的 task 掛上 favoritesWriteChain,因此執行
// 順序(先 p1 後 p2)是決定性的，不是碰運氣;讓斷言可以鎖住「先到先服務」
// 這個具體語意，而不只是「兩者都不遺失」這種較弱的不變量。
// ============================================================

test('並發:兩個不同貼文同時 toggle，最終各自成功新增，不互相覆蓋掉對方', async () => {
  const otherUrl = 'https://www.threads.com/@otheruser/post/OtherPost1';
  const otherId = '@otheruser/post/OtherPost1';
  const { storage, onMessageListeners } = loadFavorites();

  const p1 = dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  const p2 = dispatch(onMessageListeners, { type: 'favoriteToggle', url: otherUrl }).response;

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.ok, true, '第一篇並發新增應成功');
  assert.equal(res1.saved, true, '第一篇並發新增應成功');
  assert.equal(res2.ok, true, '第二篇並發新增應成功，不得因序列化而被誤判為已存在');
  assert.equal(res2.saved, true, '第二篇並發新增應成功，不得因序列化而被誤判為已存在');

  const list = storage.localSnapshot().favorites;
  assert.equal(list.length, 2, '並發新增兩篇不同貼文，最終必須都保留，不得只剩 1 筆(審查重現的丟資料)');
  // Array.from 用主執行環境的 %Array% 建構 —— list 本身可能是 vm sandbox
  // 內建立的陣列(background.js 跑在 vm context 內)，若直接對它呼叫
  // .map() 會沿用 vm 的 Array.prototype，結果陣列也會是「跨 realm」物件，
  // 與這裡的字面陣列 deepEqual 比對時，即使內容相同也會因 prototype
  // 不同而判定不相等(assert/strict 的 deepStrictEqual 連 prototype 都比)。
  const ids = Array.from(list, (item) => item.id).sort();
  assert.deepEqual(ids, [FAV_ID, otherId].sort());
});

test('並發:同一貼文並發 toggle 兩次，依呼叫順序序列化執行，最終狀態與兩個回應語意一致(一存一刪)', async () => {
  const { storage, onMessageListeners } = loadFavorites();

  const p1 = dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  const p2 = dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.ok, true);
  assert.equal(res1.saved, true, '先發起的 toggle 執行時清單仍是空的，語意應是「新增」');
  assert.equal(res2.ok, true);
  assert.equal(res2.saved, false, '後發起的 toggle 執行時，前一次寫入已序列化完成，應讀到「已存在」而「移除」');

  const list = storage.localSnapshot().favorites;
  assert.equal(list.length, 0, '一存一刪，最終應回到沒有這筆收藏的狀態，與兩個回應語意一致');
});

// ============================================================
// 上限拒收(不擠掉舊收藏)
// ============================================================

test('上限:已滿 500 筆時,新增不存在的 id 回 {ok:false, reason:"full"},且不寫入、不擠掉舊收藏', async () => {
  const seed = seedFavorites(500);
  const { storage, onMessageListeners } = loadFavorites(seed);

  const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'full');
  const list = storage.localSnapshot().favorites;
  assert.equal(list.length, 500, '不得擠掉任何一筆舊收藏');
  assert.equal(list.some((item) => item.id === FAV_ID), false, '拒收的新項目不得混入陣列');
});

test('上限:已滿 500 筆時,對既有收藏 toggle 仍可正常移除(移除不受上限限制)', async () => {
  const seed = seedFavorites(500);
  const { storage, onMessageListeners } = loadFavorites(seed);

  const res = await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: seed[0].url,
  }).response;

  assert.equal(res.ok, true);
  assert.equal(res.saved, false);
  assert.equal(storage.localSnapshot().favorites.length, 499);
});

// ============================================================
// url 驗證:不合法形狀一律拒絕(reason:'invalid-url'),不觸碰 storage
// ============================================================

const INVALID_URL_CASES = [
  { label: '缺少 https', url: 'http://www.threads.com/@user/post/Abc123' },
  { label: '非 threads 網域', url: 'https://www.evil.com/@user/post/Abc123' },
  { label: '缺少 @ 前綴', url: 'https://www.threads.com/user/post/Abc123' },
  { label: '缺少 /post/ 區段', url: 'https://www.threads.com/@user/Abc123' },
  { label: '貼文 id 後尾隨額外路徑段', url: 'https://www.threads.com/@user/post/Abc123/extra' },
  { label: '網址中夾帶空白', url: 'https://www.threads.com/@user/post/Abc 123' },
  { label: '網址中夾帶非法字元', url: 'https://www.threads.com/@user/post/Abc<123>' },
  { label: 'handle 為空', url: 'https://www.threads.com/@/post/Abc123' },
  { label: '貼文 id 為空', url: 'https://www.threads.com/@user/post/' },
  { label: 'handle 超過 60 字元上限', url: `https://www.threads.com/@${'a'.repeat(61)}/post/Abc123` },
  { label: '貼文 id 超過 60 字元上限', url: `https://www.threads.com/@user/post/${'a'.repeat(61)}` },
  { label: '完全不是網址的字串', url: 'not-a-url' },
  { label: 'url 為 null', url: null },
  { label: 'url 為 undefined', url: undefined },
  { label: 'url 為數字', url: 12345 },
];

test('url 驗證:不合法形狀一律回 {ok:false, reason:"invalid-url"},且不呼叫 storage.local.set', async () => {
  for (const { label, url } of INVALID_URL_CASES) {
    const { storage, onMessageListeners } = loadFavorites();
    const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url }).response;

    assert.equal(res.ok, false, label);
    assert.equal(res.reason, 'invalid-url', label);
    assert.equal(storage.localCalls.set.length, 0, `${label}:不該有任何 storage.local.set 呼叫`);
  }
});

test('url 驗證:handle/postId 剛好等於 60 字元上限時仍合法放行(邊界值)', async () => {
  const url = `https://www.threads.com/@${'a'.repeat(60)}/post/${'B'.repeat(60)}`;
  const { onMessageListeners } = loadFavorites();
  const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url }).response;
  assert.equal(res.ok, true);
  assert.equal(res.saved, true);
});

// ============================================================
// 欄位截斷 / 非字串欄位丟棄
// ============================================================

test('欄位截斷:author/handle 截斷至 100 字元,excerpt 截斷至 2000 字元', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: CLEAN_URL,
    author: 'A'.repeat(150),
    handle: 'H'.repeat(150),
    excerpt: 'E'.repeat(2500),
  }).response;

  const entry = storage.localSnapshot().favorites[0];
  assert.equal(entry.author.length, 100);
  assert.equal(entry.author, 'A'.repeat(100));
  assert.equal(entry.handle.length, 100);
  assert.equal(entry.handle, 'H'.repeat(100));
  assert.equal(entry.excerpt.length, 2000);
  assert.equal(entry.excerpt, 'E'.repeat(2000));
});

test('欄位截斷:剛好等於上限長度時不截斷(邊界值)', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: CLEAN_URL,
    author: 'A'.repeat(100),
    handle: 'H'.repeat(100),
    excerpt: 'E'.repeat(2000),
  }).response;

  const entry = storage.localSnapshot().favorites[0];
  assert.equal(entry.author, 'A'.repeat(100));
  assert.equal(entry.handle, 'H'.repeat(100));
  assert.equal(entry.excerpt, 'E'.repeat(2000));
});

test('非字串欄位丟棄:author/handle/excerpt 為非字串型別時,整欄不寫入條目', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: CLEAN_URL,
    author: 12345,
    handle: ['@dafucoding'],
    excerpt: { text: 'hi' },
  }).response;

  const entry = storage.localSnapshot().favorites[0];
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'author'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'handle'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'excerpt'), false);
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'id', 'url']);
});

test('非字串欄位丟棄:null 值同樣視為非字串,整欄不寫入條目', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: CLEAN_URL,
    author: null,
    handle: null,
    excerpt: null,
  }).response;

  const entry = storage.localSnapshot().favorites[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'id', 'url']);
});

// PM 審查修正:空字串比照非字串整欄丟棄，不落 author:'' 這種空欄位。
test('非字串欄位丟棄:空字串比照非字串，整欄不寫入條目', async () => {
  const { storage, onMessageListeners } = loadFavorites();
  await dispatch(onMessageListeners, {
    type: 'favoriteToggle',
    url: CLEAN_URL,
    author: '',
    handle: '',
    excerpt: '',
  }).response;

  const entry = storage.localSnapshot().favorites[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'id', 'url']);
});

// ============================================================
// storage 失敗
// ============================================================

test('storage 失敗:chrome.storage.local 不存在時回 {ok:false, reason:"storage"}', async () => {
  const { onMessageListeners } = loadFavoritesNoStorage();
  const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'storage');
});

test('storage 失敗:chrome.storage.local.get 丟出例外時回 {ok:false, reason:"storage"}', async () => {
  const { onMessageListeners } = loadFavoritesWithFailingStorage({ failGet: true });
  const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'storage');
});

test('storage 失敗:chrome.storage.local.set 丟出例外時回 {ok:false, reason:"storage"}', async () => {
  const { onMessageListeners, setCalls } = loadFavoritesWithFailingStorage({ failSet: true });
  const res = await dispatch(onMessageListeners, { type: 'favoriteToggle', url: CLEAN_URL }).response;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'storage');
  assert.equal(setCalls.length, 1, 'set 仍應被呼叫過一次(才會拋出例外)');
});
