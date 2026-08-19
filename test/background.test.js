// test/background.test.js — background.js(service worker)裡
// resolveShare 訊息處理路徑的行為契約。fetch 與 chrome.* 全程 mock，
// 不發真實網路請求。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./support/helpers');

// background.js 依賴共用 i18n 與 tcl-core 模組(真實環境靠 importScripts
// 載入);測試把 i18n.js 與 tcl-core.js 原始碼接在前面,三支腳本共用同一個
// sandbox 全域(TCLI18N / TCLCore 已存在,background 的 importScripts 條件式便
// 不執行)。
const SRC =
  fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'tcl-core.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const SHARE_URL = 'https://www.threads.com/share/DHuf91XTf/';
const CLEAN_POST_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

function makeChrome() {
  const onMessageListeners = [];
  const chrome = {
    onMessageListeners,
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
  return chrome;
}

// 這組 fixture 的 finalUrl 帶 '~' 字元，寬鬆的 CLEAN_POST_URL_PATTERN(排
// 除法字元類、無長度上限)可以匹配，但嚴格的 POST_URL_PATTERN(白名單字
// 元類、長度上限 80)不能——'~' 在前者的字元類內、不在後者的白名單內。
const SHARE_URL_WEIRD_HANDLE = 'https://www.threads.com/share/WEIRDHANDLE';
const WEIRD_HANDLE_FINAL_URL = 'https://www.threads.com/@weird~handle/post/AbC123';

// 不含任何 og 標籤的最小 HTML，供不關心 og 擷取的測試當作 response.text()
// 的預設回傳值。mock response 一律要有 .text()，否則會落入 extractOgFields
// 的容錯分支(console.error + ogFields 保持 {})，測試輸出會多噪音。
const NO_OG_HTML = '<html><head></head><body></body></html>';

function fetchResult(url, text) {
  return { url, text: async () => (text !== undefined ? text : NO_OG_HTML) };
}

// 自建 sandbox 用於測 og 擷取/合併/快取橋接，不透過共用的
// loadBackgroundWithSettings(該函式的 fetch mock 是固定案例，不適合逐
// 一加測不同 HTML 內容)。fetch 對固定的 shareUrl 回傳可自訂的 finalUrl
// 與 HTML 內容；回傳值同時支援 menu 路徑(click)與自動路徑
// (sendResolveShare + sendCleanedNotice)兩種呼叫方式，涵蓋 og 快取橋接
// (resolveShare 快取 → cleanedNotice 撈出合併)需要的完整往返。
const OG_SHARE_URL = 'https://www.threads.com/share/OGTEST';
const OG_FINAL_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

function loadBackgroundWithOgHtml(html, opts = {}) {
  const chrome = makeChrome();
  const storage = createChromeStorage({ saveHistory: true });
  const executeScriptCalls = [];
  const onClickedListeners = [];
  const onMessageListeners = [];
  const state = { clipboardOk: opts.clipboardOk !== false };
  chrome.contextMenus.onClicked.addListener = (fn) => onClickedListeners.push(fn);
  chrome.runtime.onMessage.addListener = (fn) => onMessageListeners.push(fn);
  chrome.scripting = {
    executeScript: async (arg) => {
      executeScriptCalls.push(arg);
      return [{ result: state.clipboardOk ? { ok: true } : { ok: false, reason: 'NotAllowedError' } }];
    },
  };
  chrome.storage = storage.api;
  const fetchCalls = [];
  // 側錄每次 fetch 的 init 物件，供 Accept-Language header 斷言。
  const fetchInits = [];
  const finalUrl = opts.finalUrl || OG_FINAL_URL;
  const shareUrl = opts.shareUrl || OG_SHARE_URL;
  const fetchImpl = async (url, init) => {
    fetchCalls.push(url);
    fetchInits.push(init);
    if (url === shareUrl) return fetchResult(finalUrl, html);
    // share 路徑的 cleanedNotice 也走 fetchOgFieldsForLocalKind:快取命中
    // (resolveShare 已寫入)時不會走到這裡;快取未命中(如 NO_OG_HTML 落負
    // 快取後 TTL 內短路,或對從未 resolveShare 的其他貼文頁)才會 fetch 貼文
    // 頁本身,一律回傳無 og 的最小 HTML(og 空 → DOM 版維持)。
    return fetchResult(url, NO_OG_HTML);
  };
  // fetchOgFieldsForLocalKind 內部用 setTimeout 做逾時競速，vm sandbox
  // 預設不含這個全域，這裡明確注入。
  runInSandbox(SRC, { chrome, fetch: fetchImpl, console, URL, URLSearchParams, setTimeout, clearTimeout });

  return {
    storage,
    executeScriptCalls,
    fetchCalls,
    fetchInits,
    click(info, tab) {
      onClickedListeners[0](info, tab);
    },
    // 模擬 bridge.js 經 chrome.runtime.sendMessage 對 resolveShare 監聽
    // 器發送請求，並等待回應(callback 形式)。
    sendResolveShare(message) {
      return new Promise((resolve) => {
        onMessageListeners.slice().forEach((fn) => fn(message, {}, resolve));
      });
    },
    // 模擬 bridge.js 轉發 cleanedNotice，不需要回應。
    sendCleanedNotice(message) {
      onMessageListeners.slice().forEach((fn) => fn(message, {}, () => {}));
    },
  };
}

// 依 url 回傳固定的 fetch 結果，模擬短連結解析伺服器的轉址行為。
function makeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url === SHARE_URL) {
      return fetchResult(`${CLEAN_POST_URL}?xmt=AQGabc`);
    }
    if (url === 'https://www.threads.com/share/NETWORKFAIL') {
      throw new Error('network down');
    }
    if (url === 'https://www.threads.com/share/NOTAPOST') {
      return fetchResult('https://www.threads.com/login');
    }
    if (url === SHARE_URL_WEIRD_HANDLE) {
      return fetchResult(WEIRD_HANDLE_FINAL_URL);
    }
    // share/strip/icon 三條 kind 的 cleanedNotice 一律經
    // fetchOgFieldsForLocalKind 對「貼文頁本身」補一次 og fetch。此 mock
    // 對任何貼文頁(/post/ 形狀,涵蓋 www／無 www、.com／.net 各變體)回傳無
    // og 的最小 HTML(og 空 → 負快取 → 落盤沿用 DOM 版欄位)。
    if (/\/post\//.test(url)) {
      return fetchResult(url);
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

// 載入 background.js，回傳 resolveShare 的 onMessage 監聽器與 fetch 呼叫紀錄。
function loadBackground() {
  const chrome = makeChrome();
  const calls = [];
  // diffRemovedParams(右鍵路徑用)需要 URL/URLSearchParams，vm sandbox
  // 預設不含這兩個全域(見 Node vm 文件)，這裡明確注入，讓 background.js
  // 的行為與真實瀏覽器/Service Worker 環境一致(兩者原生都有
  // URL/URLSearchParams)。fetchOgFieldsForLocalKind 內部用 setTimeout 做
  // 逾時競速，一併注入。
  runInSandbox(SRC, { chrome, fetch: makeFetch(calls), console, URL, URLSearchParams, setTimeout, clearTimeout });
  return { listener: chrome.onMessageListeners[0], calls };
}

function callListener(listener, message) {
  return new Promise((resolve) => {
    const keepAlive = listener(message, {}, resolve);
    resolve.keepAlive = keepAlive;
  });
}

// 訊息通道契約:認得的類型回傳 true(保持通道開啟等非同步 sendResponse)，
// 不認得的類型回傳 false 且不佔用 sendResponse。監聽器有沒有註冊由本測試
// 順帶驗證(取不到就會在此丟錯)，不另立一條。
test('onMessage 契約:resolveShare 回傳 true 保持通道，其他類型回傳 false 且不呼叫 sendResponse', () => {
  const { listener } = loadBackground();
  assert.equal(typeof listener, 'function', '腳本載入時就該註冊 onMessage 監聽器');

  assert.equal(listener({ type: 'resolveShare', url: SHARE_URL }, {}, () => {}), true);

  let called = false;
  const keepAlive = listener({ type: 'somethingElse' }, {}, () => {
    called = true;
  });
  assert.equal(keepAlive, false);
  assert.equal(called, false);
});

test('合法短碼解析成功時，sendResponse 收到 ok:true 與去除追蹤參數的乾淨貼文網址', async () => {
  const { listener } = loadBackground();
  const response = await callListener(listener, { type: 'resolveShare', url: SHARE_URL });
  assert.equal(response.ok, true);
  assert.equal(response.cleanUrl, CLEAN_POST_URL);
});

test('不符 SHARE_URL_PATTERN 的 url 會被拒絕，且不會發出任何 fetch 請求', async () => {
  const { listener, calls } = loadBackground();
  const response = await callListener(listener, { type: 'resolveShare', url: 'https://evil.com/whatever' });
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'invalid-url');
  assert.equal(calls.includes('https://evil.com/whatever'), false);
});

test('fetch 丟出例外時，回傳 ok:false 與 reason:network-error', async () => {
  const { listener } = loadBackground();
  const response = await callListener(listener, {
    type: 'resolveShare',
    url: 'https://www.threads.com/share/NETWORKFAIL',
  });
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'network-error');
});

test('轉址結果不是貼文網址時，回傳 ok:false 與 reason:format-error', async () => {
  const { listener } = loadBackground();
  const response = await callListener(listener, {
    type: 'resolveShare',
    url: 'https://www.threads.com/share/NOTAPOST',
  });
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'format-error');
});

// ============================================================
// SHARE_URL_PATTERN 尾端收緊規格
// SHARE_URL_PATTERN(background.js:6)為
//   /^https:\/\/(www\.)?threads\.(com|net)\/share\/.+/i
// 只錨定開頭(^)、尾端用 .+ 且不錨定 $，只要 /share/ 後有至少 1 個
// 任意字元(含 /、空白、雜訊)就會判定為合法短碼。以下案例表窮舉
// 「必須匹配」與「不得匹配(收緊目標)」兩類，鎖住尾端收緊後的規格。
// ============================================================

// 一律成功的 fetch mock:只用來觀察 SHARE_URL_PATTERN 是否放行(有沒有
// 呼叫到 fetch),不模擬個別短碼的轉址內容,一律回傳同一組乾淨貼文網址。
function makeAlwaysSucceedFetch(calls) {
  return async (url) => {
    calls.push(url);
    return fetchResult(`${CLEAN_POST_URL}?xmt=AQGabc`);
  };
}

// 載入 background.js,搭配一律成功的 fetch mock,回傳監聽器與 fetch 呼叫紀錄。
function loadBackgroundAlwaysSucceed() {
  const chrome = makeChrome();
  const calls = [];
  runInSandbox(SRC, { chrome, fetch: makeAlwaysSucceedFetch(calls), console, URL, URLSearchParams, setTimeout, clearTimeout });
  return { listener: chrome.onMessageListeners[0], calls };
}

// 必須匹配:代表現行合法實務的 /share/ 短碼形式,收緊後仍必須放行、
// 不得誤傷。每一列附一句歸類理由。
const SHARE_URL_MUST_MATCH_CASES = [
  {
    url: 'https://www.threads.com/share/DHuf91XTf/',
    reason: '既有 background.test.js 覆蓋的合法短碼(英數混合、含尾斜線)，收緊後仍須放行。',
  },
  {
    url: 'https://www.threads.com/share/NETWORKFAIL',
    reason: '既有 background.test.js 覆蓋的合法短碼形式(全大寫英文、無尾斜線)，收緊後仍須放行。',
  },
  {
    url: 'https://www.threads.com/share/NOTAPOST',
    reason: '既有 background.test.js 覆蓋的合法短碼形式，收緊後仍須放行。',
  },
  {
    url: 'https://www.threads.com/share/AbCdEfGhI',
    reason: 'README/store-listing 文件承諾的範例短碼(大小寫混合英數)，代表官方文件的合法格式。',
  },
  {
    url: 'https://threads.net/share/xyz123',
    reason: 'clipboard-guard.test.js 覆蓋的合法短碼形式(無 www、threads.net 網域)，跨檔案需一致放行。',
  },
  {
    url: 'https://www.threads.com/share/Abc-123_XYZ',
    reason: '英數之外常見 URL-safe 字元(連字號、底線)構成的短碼，屬合法短碼字元集。',
  },
  {
    url: 'https://www.threads.com/share/DHuf91XTf?xmt=AQGabc',
    reason: '邊界:短碼後接 query，屬既有語意，收緊只動短碼本體、不得動到尾隨 query 的放行。',
  },
  {
    url: 'https://www.threads.com/share/DHuf91XTf#section',
    reason: '邊界:短碼後接 hash，同上，尾隨 hash 的放行語意須維持不變。',
  },
];

// 不得匹配(收緊目標):短碼後尾隨額外路徑段、夾帶非法字元/雜訊、或空
// 短碼。正則因尾端用 .+ 且未錨定 $，這些案例會被誤判為合法，屬收緊
// 目標;每一列附一句歸類理由。
const SHARE_URL_MUST_NOT_MATCH_CASES = [
  {
    url: 'https://www.threads.com/share/Abc123/extra',
    reason: '短碼後尾隨額外路徑段(單層)，不是短碼該有的形式，應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/Abc123/extra/more',
    reason: '短碼後尾隨額外路徑段(多層)，同上應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/Abc123/extra?x=1',
    reason: '短碼後尾隨額外路徑段，即使段落後又接 query 也不能被 query 掩護放行，應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/Abc 123',
    reason: '短碼中夾帶空白字元，非 URL-safe，應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/Abc<123>',
    reason: '短碼夾帶明顯非短碼雜訊字元(角括號)，應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/AbCdEfGhI and more text',
    reason: '短碼後直接空白銜接雜訊文字，非合法短碼延伸，應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/?xmt=abc',
    reason: '空短碼(斜線後直接接 query，短碼本體為空)，應被拒絕。',
  },
  {
    url: 'https://www.threads.com/share/',
    reason: '空短碼(斜線後無任何字元、無 query/hash)。現行正則因 .+ 至少需 1 字元，此案例今日已'
      + '正確拒絕、非本次新增紅燈，僅為收緊規格窮舉完整性而納入，作為迴歸鎖。',
  },
];

test('SHARE_URL_PATTERN 收緊規格(必須匹配):合法短碼一律放行並送出 fetch', async () => {
  for (const { url, reason } of SHARE_URL_MUST_MATCH_CASES) {
    const { listener, calls } = loadBackgroundAlwaysSucceed();
    const response = await callListener(listener, { type: 'resolveShare', url });
    assert.equal(calls.includes(url), true, `${url} 應放行並呼叫 fetch 解析短碼 —— ${reason}`);
    assert.equal(response.ok, true, `${url} —— ${reason}`);
    assert.equal(response.cleanUrl, CLEAN_POST_URL, `${url} —— ${reason}`);
  }
});

test('SHARE_URL_PATTERN 收緊規格(不得匹配):非法短碼一律在比對階段就拒絕，不發 fetch', async () => {
  for (const { url, reason } of SHARE_URL_MUST_NOT_MATCH_CASES) {
    const { listener, calls } = loadBackgroundAlwaysSucceed();
    const response = await callListener(listener, { type: 'resolveShare', url });
    assert.equal(response.ok, false, `${url} —— ${reason}`);
    assert.equal(response.reason, 'invalid-url', `${url} —— ${reason}`);
    assert.equal(calls.includes(url), false, `${url} 不應呼叫 fetch —— ${reason}`);
  }
});

// ============================================================
// S1:右鍵選單路徑不受 autoClean 影響，永遠可用。
//
// 成功類通知(右鍵路徑的 bgSuccess、自動路徑的 bgAutoSuccess/bgIconSuccess)
// 全數拆除，不再有「要不要顯示」這道關卡;失敗／錯誤類通知不受任何設定
// 影響，永遠觸發(右鍵路徑維持系統通知;share/strip 自動路徑的失敗改走頁
// 內 toast，見 bridge.test.js／post-icon.test.js，不在本檔覆蓋範圍)。
//
// 【時序紀律】chrome.storage.sync 的 get/set 一律延遲一個 tick 才結算
// (見 support/helpers.js)，不允許同 tick 直接 resolve 的假綠燈;
// 右鍵點擊流程本身是非同步的，測試以 settle() 等它跑完。
//
// 【防假綠燈】「失敗通知永遠觸發」這類條目，在完全沒有設定機制下本來就
// 會通過。因此這些測試一律搭配一個可鑑別的斷言:同一個 service worker 內
// 成功流程不得發通知，或斷言 SW 確實讀過 chrome.storage.sync，避免「設定
// 根本沒接上卻碰巧通過」。
// ============================================================

// cleanedNotice 的完整鏈路(讀設定→記錄→讀設定→讀語言→通知)串了約 5 個
// setTimeout(0) tick;Windows 計時器顆粒 ~15ms,60ms 會偶發性等不完,放寬
// 到 150ms。
function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 凍結 Date:讓 background.js 的 Date.now() 回傳固定值,供去重視窗邊界測試
// 釘死 `<=` 運算子,避免測試端 now 與 recordHistory 內 Date.now() 的毫秒
// 級偏移讓 now-300000 這種貼邊案例變得不確定。函式體內的 Date 是測試檔的
// 原生 Date(非凍結),不會遞迴。
function makeFrozenDate(fixed) {
  function FrozenDate(...args) {
    return args.length ? new Date(...args) : new Date(fixed);
  }
  FrozenDate.now = () => fixed;
  FrozenDate.parse = Date.parse;
  FrozenDate.UTC = Date.UTC;
  FrozenDate.prototype = Date.prototype;
  return FrozenDate;
}

// 載入 background.js，並以指定設定填入 chrome.storage.sync;同時側錄
// contextMenus.onClicked 監聽器、notifications.create 與 scripting.executeScript。
// opts.clipboardOk 可在測試中途翻轉，模擬「先失敗、後成功」的兩次點擊。
// opts.localHistory 可預填 storage.local 的 history(測紀錄上限用)。
// opts.now(選填):注入凍結的 Date,讓 recordHistory 的 Date.now() 回傳此值
// (去重視窗邊界測試用)。
function loadBackgroundWithSettings(initialSettings, opts = {}) {
  const storage = createChromeStorage(
    initialSettings,
    opts.localHistory ? { history: opts.localHistory } : {}
  );
  const notifications = [];
  const executeScriptCalls = [];
  const onClickedListeners = [];
  const state = { clipboardOk: opts.clipboardOk !== false };
  const onMessageListeners = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: (fn) => onClickedListeners.push(fn) },
    },
    notifications: {
      create: (id, options) => {
        notifications.push({ id, options });
      },
    },
    scripting: {
      executeScript: async (arg) => {
        executeScriptCalls.push(arg);
        return [
          { result: state.clipboardOk ? { ok: true } : { ok: false, reason: 'NotAllowedError' } },
        ];
      },
    },
    tabs: { TAB_ID_NONE: -1 },
    storage: storage.api,
  };
  const fetchCalls = [];
  // 同上方 loadBackground 的理由，右鍵路徑(handleShareLinkClick →
  // buildMenuHistoryExtra → diffRemovedParams)這條路徑經這個 loader 進
  // 入，同樣需要注入 URL/URLSearchParams。fetchOgFieldsForLocalKind
  // 內部用 setTimeout 做逾時競速，一併注入。
  const sandbox = { chrome, fetch: makeFetch(fetchCalls), console, URL, URLSearchParams, setTimeout, clearTimeout };
  if (opts.now !== undefined) sandbox.Date = makeFrozenDate(opts.now);
  runInSandbox(SRC, sandbox);

  return {
    storage,
    notifications,
    executeScriptCalls,
    fetchCalls,
    state,
    click(info, tab) {
      onClickedListeners[0](info, tab);
    },
    // 模擬 bridge 經 chrome.runtime.sendMessage 送訊息給 service worker;
    // 派送給所有已註冊的 onMessage 監聽器，不假設實作註冊了幾支。
    sendRuntimeMessage(message) {
      onMessageListeners.slice().forEach((fn) => fn(message, {}, () => {}));
    },
  };
}

// ---- autoClean 預設值為 false ----
//
// background.js 本身不依 settings.autoClean 分支任何邏輯(這顆設定驅動
// 的行為在 bridge.js／clipboard-guard.js，兩者測試已各自覆蓋預設值)，
// 但 DEFAULT_SETTINGS 是 getSettings() 的權威預設值來源，
// chrome.storage.sync.get(DEFAULT_SETTINGS) 呼叫時會把這個物件原樣當
// 「查無此鍵時的預設值」傳進去——mock 的 calls.get 側錄了每次呼叫的原始
// 引數，可以從中驗證 background.js 內建的 autoClean 預設值確實是 false。
test('DEFAULT_SETTINGS:autoClean 預設值為 false', async () => {
  const bg = loadBackgroundWithSettings({});

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  const getCallWithAutoClean = bg.storage.calls.get.find(
    (keys) => keys && typeof keys === 'object' && 'autoClean' in keys
  );
  assert.ok(getCallWithAutoClean, 'getSettings() 應以包含 autoClean 鍵的物件呼叫 chrome.storage.sync.get');
  assert.equal(getCallWithAutoClean.autoClean, false);
});

// ---- S1:右鍵選單複製功能不受 autoClean 影響 ----

test('S1:autoClean=false 時，右鍵選單仍照常解析短連結並寫入剪貼簿', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: false });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1);
  assert.equal(bg.executeScriptCalls[0].args[0], CLEAN_POST_URL);
  // 防假綠燈:成功複製後 recordHistory 必然要讀 saveHistory 設定，所以
  // 此處必定讀過 chrome.storage.sync;若 SW 根本沒接上，本測試不算通過。
  assert.ok(bg.storage.calls.get.length >= 1, 'service worker 應讀取 chrome.storage.sync 設定');
});

// ---- 成功類通知整組移除，右鍵成功複製不得觸發任何成功通知(不再有
// notifySuccess 這種可開關的把關，行為恆定)----

test('右鍵成功複製不得觸發任何成功通知(成功類通知已整組移除)', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1);
  assert.deepEqual(bg.notifications, []);
});

// ---- 失敗／錯誤類通知不受設定影響，永遠觸發 ----

// 三種錯誤來源(無效短連結／網路失敗／轉址結果非貼文)驗同一個不變量:
// 錯誤通知永遠觸發，且其後的成功流程不發通知。剪貼簿寫入失敗因為需要中途
// 翻轉 clipboardOk，harness 形狀不同，仍單獨一條(見下)。
test('各類錯誤通知照常觸發，其後成功流程不發通知', async () => {
  const cases = [
    { linkUrl: 'https://evil.com/whatever', id: 'threads-clean-link-invalid' },
    { linkUrl: 'https://www.threads.com/share/NETWORKFAIL', id: 'threads-clean-link-network-error' },
    { linkUrl: 'https://www.threads.com/share/NOTAPOST', id: 'threads-clean-link-format-error' },
  ];

  for (const { linkUrl, id } of cases) {
    const bg = loadBackgroundWithSettings({ autoClean: true });

    bg.click({ linkUrl }, { id: 7 });
    await settle();
    assert.equal(bg.notifications.length, 1, `${linkUrl} 的錯誤通知必須照常觸發`);
    assert.equal(bg.notifications[0].id, id);

    bg.click({ linkUrl: SHARE_URL }, { id: 7 });
    await settle();

    assert.equal(bg.notifications.length, 1, '成功流程不得發出通知(成功類通知已整組移除)');
  }
});

test('剪貼簿寫入失敗的錯誤通知照常觸發，其後成功流程不發通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true }, { clipboardOk: false });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-clipboard-error');

  bg.state.clipboardOk = true;
  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功流程不得發出通知(成功類通知已整組移除)');
});

// ============================================================
// 自動路徑(share/strip/icon)的 cleanedNotice 是淨化紀錄(唯一資料集)的
// 入筆管道，形狀為
// { type: 'cleanedNotice', cleanUrl, kind, author?, handle?, excerpt? }
// (kind 白名單 'share' | 'strip' | 'icon',非法整則忽略——見檔末「淨化
// 紀錄」區塊)。cleanedNotice 收到就無條件記錄，不再發任何通知。安全回歸:
// cleanUrl 必須整串錨定吻合才採信，否則不得寫入紀錄。
// ============================================================

const CLEANED_NOTICE_CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

test('cleanedNotice 從不觸發任何通知(成功類通知已整組移除)，但仍正常寫入紀錄', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  assert.deepEqual(bg.notifications, []);
  assert.equal(bg.storage.localSnapshot().history.length, 1);
});

test('自動路徑的 cleanedNotice 不影響右鍵路徑的錯誤/失敗通知邏輯，且兩條路徑都不觸發成功通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();
  assert.deepEqual(bg.notifications, []);

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.deepEqual(bg.notifications, [], '右鍵成功複製同樣不得觸發通知');
  // 規格演進(本次紀錄去重合併):CLEANED_NOTICE_CLEAN_URL 與 SHARE_URL 解析
  // 後的 CLEAN_POST_URL 是同一個字串，兩次寫入相距僅一個 settle()，落在
  // 去重視窗內——依新規格應合併為一筆，原本「兩條路徑各自留一筆」的斷言
  // 已不成立，改驗合併後的不變量:仍只有一筆、kind 更新為最近一次
  // (menu)、seen[] 累積兩筆(share→menu)。
  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '同一乾淨網址在去重視窗內應合併為一筆，不再各自留存');
  assert.equal(history[0].kind, 'menu', 'kind 應更新為最近一次來源');
  assert.equal(history[0].seen.length, 2, 'seen[] 應累積兩筆(share、menu)');
  assert.equal(history[0].seen[0].kind, 'share', 'seen[] 舊在前');
  assert.equal(history[0].seen[1].kind, 'menu', 'seen[] 新在後');
});

// cleanedNotice 的
// cleanUrl 來自頁面腳本可自由 postMessage 的管道，background 是這條路徑
// 上唯一的信任邊界。驗證樣式若不錨定收尾，「合法貼文網址開頭 + 尾隨任意
// 文字」就會通過驗證，尾隨內容(含換行、假的系統提示、大量垃圾)原樣寫
// 進淨化紀錄(之後會呈現在 options 頁)，等同讓頁面完全操控紀錄內容。
// 以下三種尾隨形態都必須被擋下、不得留下任何紀錄。

test('R1-2:「合法貼文網址開頭 + 尾隨任意文字」的 cleanedNotice 不得寫入紀錄', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  const forged = [
    `${CLEANED_NOTICE_CLEAN_URL}\n【系統】您的帳號異常，請至 evil.example 重新登入`,
    `${CLEANED_NOTICE_CLEAN_URL}/extra-path-injected`,
    `${CLEANED_NOTICE_CLEAN_URL}?injected=payload`,
  ];
  for (const cleanUrl of forged) {
    bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl, kind: 'share' });
  }
  await settle();

  assert.equal(bg.storage.localSnapshot().history, undefined, '尾隨文字必須被錨定驗證擋下，不得寫入任何紀錄');

  // 對照組:整串完全吻合的乾淨網址仍須記錄，排除「一律不記錄」的假動作。
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(bg.storage.localSnapshot().history.length, 1);
});

// 只錨定收尾、字元類用排除法(如
// [^/?#\s]+)仍有缺口——尾隨文字只要「不含空白」就整串吻合而過關。中文
// 釣魚句不需要空白，純英數長串同理;頁面甚至不必偽造 notice，直接
// writeText 一個帶中文句的假貼文網址走完整條自動淨化鏈也會被記錄。驗證
// 樣式必須收緊到 Threads 實際使用的 ASCII 字母表並加長度上限。

test('R2:「合法前綴 + 無空白中文文字」的 cleanedNotice 不得寫入紀錄', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  const forged = [
    `${CLEANED_NOTICE_CLEAN_URL}帳號異常，請至evil.example重新登入驗證`,
    `${CLEANED_NOTICE_CLEAN_URL}:您的帳號已被停用。`,
    `${CLEANED_NOTICE_CLEAN_URL}【系統通知】請立即點擊下方連結`,
  ];
  for (const cleanUrl of forged) {
    bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl, kind: 'share' });
  }
  await settle();

  assert.equal(
    bg.storage.localSnapshot().history,
    undefined,
    '不含空白的中文尾隨文字必須被擋下，不得寫入任何紀錄'
  );

  // 對照組:整串完全吻合的乾淨網址仍須記錄。
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(bg.storage.localSnapshot().history.length, 1);
});

test('R2:「合法前綴 + 純英數長串」的 cleanedNotice 不得寫入紀錄', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  const forged = [
    `${CLEANED_NOTICE_CLEAN_URL}${'A'.repeat(1000)}`,
    `${CLEANED_NOTICE_CLEAN_URL}${'0'.repeat(200)}`,
  ];
  for (const cleanUrl of forged) {
    bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl, kind: 'share' });
  }
  await settle();

  assert.equal(
    bg.storage.localSnapshot().history,
    undefined,
    '純英數長串尾隨必須被長度上限擋下，不得寫入任何紀錄'
  );

  // 對照組:四種合法寫法(www／無 www、.com／.net)都必須正常記錄。
  const legit = [
    'https://www.threads.com/@dafucoding/post/DbezfB0gYvP',
    'https://threads.com/@dafucoding/post/DbezfB0gYvP',
    'https://www.threads.net/@dafu.coding_1/post/Dbez-fB0_gYvP',
    'https://threads.net/@dafucoding/post/DbezfB0gYvP',
  ];
  for (const cleanUrl of legit) {
    bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl, kind: 'share' });
  }
  // 4 則併發 cleanedNotice 經 historyWriteChain 序列化，每筆都要走
  // getSettings→storage.local.get→storage.local.set 三個 tick，比對通知
  // 路徑的鏈路深得多；預設 settle(150) 的緩衝量是抓單筆通知鏈路估的，
  // 這裡改記錄且是 4 筆併發，需要更寬裕的緩衝，避免 Windows 計時器顆粒
  // 造成偶發性等不完。
  await settle(600);

  assert.equal(bg.storage.localSnapshot().history.length, legit.length, '合法網址一律照常記錄，不得誤殺');
});

// ============================================================
// 淨化紀錄(storage.local):background 是唯一的記錄落點。
//   - 自動路徑:cleanedNotice 通過錨定驗證後記錄,kind 白名單
//     share|strip|icon,非法(含缺失、'menu'、任意字串)整則忽略——不記錄
//     也不通知。('menu' 刻意排除在此訊息白名單外,只由右鍵路徑直接寫入)
//   - 右鍵路徑:剪貼簿實際寫入成功後記錄 kind:'menu';寫入失敗不留紀錄。
//   - saveHistory=false 時不記錄;上限 1000 筆,新到舊,超過裁掉最舊。
// ============================================================

test('紀錄:合法 cleanedNotice 寫入一筆 { url, kind, at } 到 storage.local', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'strip' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL);
  assert.equal(history[0].kind, 'strip');
  assert.equal(typeof history[0].at, 'number');
});

test('紀錄:kind 缺失或非白名單的 cleanedNotice 整則忽略——不記錄、不通知', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL });
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'menu' });
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'evil' });
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icons' });
  await settle();

  assert.equal(bg.storage.localSnapshot().history, undefined, '非法 kind 不得留下任何紀錄');
  assert.deepEqual(bg.notifications, [], '非法 kind 不得發出任何通知');

  // 對照組:合法 kind 照常記錄,排除「一律不記錄」的假動作。
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(bg.storage.localSnapshot().history.length, 1);
});

// 貼文互動列複製 icon(post-icon.js)點擊複製成功後，經 cleanedNotice 送
// kind:'icon':白名單收下這個來源，記錄與通知都比照 share/strip 自動路徑
// 一視同仁，不做特殊抑制。
test('紀錄:cleanedNotice 的 kind 為 icon(貼文互動列複製按鈕)時照常記錄一筆', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL);
  assert.equal(history[0].kind, 'icon');
  assert.equal(typeof history[0].at, 'number');
});

// ---- cleanedNotice 選填的 author/handle/excerpt ----
//
// 這三個欄位由複製 icon(post-icon.js)或 bridge.js(share/strip 路徑)從
// 貼文容器 DOM 順手擷取，同屬頁面可控輸入，不信任:型別不是 string 的
// 一律整欄丟棄，字串則截斷至各自長度上限(author/handle 100、excerpt
// 2000)。三者都是選填，缺席不影響其餘欄位或整筆紀錄的寫入。

test('紀錄:cleanedNotice 帶合法的 author/handle/excerpt 時，三個欄位原樣寫入紀錄', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'icon',
    author: 'Dafu Coding',
    handle: '@dafucoding',
    excerpt: '今天天氣真好',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, 'Dafu Coding');
  assert.equal(history[0].handle, '@dafucoding');
  assert.equal(history[0].excerpt, '今天天氣真好');
});

test('紀錄:cleanedNotice 缺席 author/handle/excerpt 時，紀錄照常寫入、且不含這三個欄位', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL);
  assert.equal(history[0].kind, 'share');
  assert.equal('author' in history[0], false, '缺席欄位不得寫成 undefined 佔位');
  assert.equal('handle' in history[0], false);
  assert.equal('excerpt' in history[0], false);
});

// ---- cleanedNotice 選填的 original/removedParams(對齊手機
// ShareHistoryItem)----
//
// guard 端(clipboard-guard.js)經 bridge.js 透傳，share 分支只夾帶
// original(短碼原文，無 removedParams——伺服器端重新導向前的網址帶了
// 哪些參數，guard 這層無從得知);strip 分支兩者都夾帶(剝參前原網址與
// 被剝除的查詢參數清單)。sanitize 規則:original 非字串/空字串/與
// cleaned url 相同一律整欄丟棄，否則截斷至 2048 字;removedParams 非陣
// 列整欄丟棄，陣列逐筆 sanitize(key 非空字串 ≤64、value 字串 ≤512，
// 任一不符整筆丟棄)並裁到 20 筆上限。

test('紀錄:cleanedNotice 帶合法的 original(share 分支，無 removedParams)時，original 原樣寫入、removedParams 不出現', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });
  const original = 'https://www.threads.com/share/BASzGWiaOw/';

  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    original,
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].original, original);
  assert.equal('removedParams' in history[0], false, 'share 分支沒有 removedParams，不得憑空生出');
});

test('紀錄:cleanedNotice 帶合法的 original 與 removedParams(strip 分支)時，兩欄原樣寫入', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });
  const original = `${CLEANED_NOTICE_CLEAN_URL}?xmt=AQGabc`;
  const removedParams = [{ key: 'xmt', value: 'AQGabc' }];

  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'strip',
    original,
    removedParams,
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].original, original);
  // 不用 assert.deepEqual 比對整個陣列:background.js 經 vm sandbox(另一
  // 個 realm)載入，sanitize 後新建的物件與本檔案(host realm)字面量物件
  // 結構相同但非同一個 realm，deepStrictEqual 會誤判失敗(此檔案其餘涉及
  // storage 內容的斷言，一律逐欄比對，不比對整個物件/陣列，同一個理由)。
  assert.equal(history[0].removedParams.length, 1);
  assert.equal(history[0].removedParams[0].key, 'xmt');
  assert.equal(history[0].removedParams[0].value, 'AQGabc');
});

test('紀錄:cleanedNotice 缺席 original/removedParams 時，紀錄照常寫入、且不含這兩個欄位', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal('original' in history[0], false, '缺席欄位不得寫成 undefined 佔位');
  assert.equal('removedParams' in history[0], false);
});

test('紀錄:saveHistory=false 時自動與右鍵兩條路徑都不記錄', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: false });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1, '右鍵複製功能本身不受 saveHistory 影響');
  assert.equal(bg.storage.localSnapshot().history, undefined);
});

test('紀錄:右鍵路徑在剪貼簿寫入成功後記 kind:menu;寫入失敗不留紀錄', async () => {
  const ok = loadBackgroundWithSettings({ saveHistory: true });
  ok.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  const history = ok.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].url, CLEAN_POST_URL);
  assert.equal(history[0].kind, 'menu');

  const failed = loadBackgroundWithSettings(
    { saveHistory: true },
    { clipboardOk: false }
  );
  failed.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(failed.storage.localSnapshot().history, undefined, '沒寫進剪貼簿就不算淨化成功');
});

// 右鍵路徑(menu)不經 guard/bridge，original(使用者右鍵點擊的短碼
// 連結)與 removedParams(finalUrl 與 cleanUrl 的差集)background 自身就
// 有(見 buildMenuHistoryExtra/diffRemovedParams)。fetch mock 對 SHARE_URL
// 固定回傳 `${CLEAN_POST_URL}?xmt=AQGabc`，diff 出來剛好就是一筆
// { key: 'xmt', value: 'AQGabc' }。
test('紀錄:右鍵路徑(menu)自身算出 original(短碼連結)與 removedParams(finalUrl 與 cleanUrl 的差集)', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });
  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].original, SHARE_URL, 'original 應為使用者右鍵點擊的短碼連結');
  assert.equal(history[0].removedParams.length, 1);
  assert.equal(history[0].removedParams[0].key, 'xmt');
  assert.equal(history[0].removedParams[0].value, 'AQGabc');
});

// ============================================================
// 短碼解析路徑(share 與右鍵路徑共用的 resolveFinalUrl)順手從同一個
// response 擷取 og:description(excerpt 全文)／og:title(拆 author/handle)，
// 經 sanitize 後以「og 有值就蓋過 DOM 版、handle 仍以 DOM/URL 為準」的
// 混合制流入 recordHistory 的 extra。web DOM 抓到的「作者」實為 username，
// 是錯值不是缺席，og 解析出的顯示名稱優先蓋過;重複值(author === handle
// 去掉開頭 @)一律視同 author 缺席。手機因為不做 DOM 擷取而沒有這個問題
// (對齊 hunandy14/meta-link-clearer 的 src/lib/post-meta.ts)。
// ============================================================

test('OG 案:右鍵路徑(menu)從 og:title/og:description 抽出 author/handle/excerpt', async () => {
  const html =
    '<html><head>' +
    '<meta property="og:title" content="かえで (@kaede.hong) on Threads" />' +
    '<meta property="og:description" content="今天天氣真好，適合出門走走。" />' +
    '</head><body></body></html>';
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, 'かえで');
  assert.equal(history[0].handle, '@kaede.hong');
  assert.equal(history[0].excerpt, '今天天氣真好，適合出門走走。');
});

test('OG 案:content 在 property 之前的屬性順序也解析得到(對齊手機版同款測試)', async () => {
  const html = '<meta content="阿明 (@a_ming) on Threads" property="og:title" />';
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, '阿明');
  assert.equal(history[0].handle, '@a_ming');
});

test('OG 案:og:title 不含 (@handle) 形狀時，整串當作者名並去掉 on Threads 尾綴，不解析 handle(對齊手機版)', async () => {
  const html = '<meta property="og:title" content="Some Page on Threads" />';
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, 'Some Page');
  assert.equal('handle' in history[0], false);
});

test('OG 案:HTML entity 解碼——十進位(&#65292; 全形逗號)、hex(&#x5b8b; 中日文)、amp/lt/gt/quot 皆正確還原', async () => {
  const html =
    '<meta property="og:title" content="&#x5b8b;&#x9577;&#x537f; (@sample_x) on Threads" />' +
    '<meta property="og:description" content="今天路過巷口那間老茶行&#65292;想起小時候 &amp; &lt;tag&gt; &quot;quote&quot;" />';
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, '宋長卿');
  assert.equal(history[0].handle, '@sample_x');
  assert.equal(history[0].excerpt, '今天路過巷口那間老茶行，想起小時候 & <tag> "quote"');
});

// 惡意輸入案例:og:description 帶 &lt;script&gt; 這類會讓人聯想到 HTML
// 注入的內容，解碼後應該就是純文字字面值 "<script>...</script>"，不得
// 被當成可執行的 HTML 標籤——這裡只驗證入庫的是字面字串本身，下游
// options.js 一律用 textContent 渲染(不是 innerHTML)，純文字字串本來
// 就不會被瀏覽器解讀為標籤。
test('OG 案:entity 惡意輸入(&lt;script&gt;)解碼後仍為純文字入庫，不是可執行 HTML', async () => {
  const html = '<meta property="og:description" content="&lt;script&gt;alert(1)&lt;/script&gt;" />';
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].excerpt, '<script>alert(1)</script>');
  assert.equal(typeof history[0].excerpt, 'string');
});

test('OG 案:掃描長度上限(64KB)——og meta 標籤位於掃描範圍之外時擷取不到，缺席回退(不硬造)', async () => {
  const padding = 'x'.repeat(70000); // 超過 OG_SCAN_LIMIT(65536)
  const html = `<html><head><!--${padding}--><meta property="og:description" content="超出掃描範圍的內文" /></head></html>`;
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '擷取不到 og 資訊不影響解析本身，剪貼簿複製與紀錄照常完成');
  assert.equal('excerpt' in history[0], false, '超出掃描範圍的 og 內容不得被找到，缺席就是缺席、不硬造');
});

// 對照組:og meta 標籤在掃描範圍「之內」時，即使前面有大量填充內容，仍
// 應正確擷取——確認掃描上限不是「整份 HTML 都不掃」的假動作。
test('OG 案:掃描長度上限對照組——og meta 標籤在 64KB 範圍內時正常擷取', async () => {
  const padding = 'x'.repeat(1000); // 遠小於 OG_SCAN_LIMIT
  const html = `<html><head><!--${padding}--><meta property="og:description" content="範圍內的內文" /></head></html>`;
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].excerpt, '範圍內的內文');
});

// og 來源的 excerpt/author 落地前必須再過 sanitizeHistoryField，否則會繞過
// HISTORY_EXCERPT_MAX/HISTORY_AUTHOR_MAX 直通入庫(og:content 屬性值本
// 身沒有長度上限，extractOgMeta 的 [^"]* 會整段吃下來)。這裡的內容長度
// (超過 2000/100)與 OG_SCAN_LIMIT(64KB 的正則掃描範圍)是兩件不同的
// 事:內容本身遠小於 64KB，不會落入掃描長度上限那條防線，只有落地前的
// sanitizeHistoryField 這一關能擋下來。

test('OG 案:og:description 超過 2000 字時截斷至 2000(code review 回歸釘子)', async () => {
  const longExcerpt = 'あ'.repeat(3000);
  const html = `<meta property="og:description" content="${longExcerpt}" />`;
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].excerpt.length, 2000, 'og:description 超過長度上限應截斷至 2000 字，不得繞過');
});

test('OG 案:og:title 解析出的顯示名稱超過 100 字時截斷至 100(code review 回歸釘子)', async () => {
  const longName = 'a'.repeat(150);
  const html = `<meta property="og:title" content="${longName} (@short_handle) on Threads" />`;
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author.length, 100, 'og:title 解析出的顯示名稱超過長度上限應截斷至 100 字，不得繞過');
  assert.equal(history[0].handle, '@short_handle', 'handle 本身不受影響，仍照常寫入');
});

test('OG 案:沒有任何 og 欄位時，右鍵路徑不寫入 author/handle/excerpt(缺席回退)', async () => {
  const bg = loadBackgroundWithOgHtml(NO_OG_HTML);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '擷取不到 og 資訊不影響複製與紀錄本身');
  assert.equal('author' in history[0], false);
  assert.equal('handle' in history[0], false);
  assert.equal('excerpt' in history[0], false);
});

// 優先序:share 路徑(guard/bridge 自動路徑)——og:title 解析出的顯示名
// 稱覆蓋 DOM 版 author(DOM 版通常其實是 username，是錯值)；handle 仍以
// DOM/URL 擷取版為準，og 版不覆蓋；excerpt 以 og 版(全文)覆蓋 DOM 版
// (通常是截斷版)。透過 og 快取橋接:先送 resolveShare(觸發
// resolveFinalUrl 擷取並快取 og 資訊)，再送 cleanedNotice(帶 DOM 版
// author/handle/excerpt)，驗證 handleCleanedNotice 把兩者正確合併。
test('OG 案:share 路徑合併優先序——author 被 og 覆蓋、handle 維持 DOM 版、excerpt 被 og(全文)覆蓋', async () => {
  const html =
    '<meta property="og:title" content="真實顯示名稱 (@real_handle) on Threads" />' +
    '<meta property="og:description" content="這是完整未截斷的貼文全文內容。" />';
  const bg = loadBackgroundWithOgHtml(html);

  const resolveResponse = await bg.sendResolveShare({ type: 'resolveShare', url: OG_SHARE_URL });
  assert.equal(resolveResponse.ok, true);
  assert.equal(resolveResponse.cleanUrl, OG_FINAL_URL);

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: OG_FINAL_URL,
    kind: 'share',
    author: 'dom_username', // web DOM 抓到的「作者」其實是 username
    handle: '@dom_username',
    excerpt: '這是被 DOM 顯示層截斷的內文…',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, '真實顯示名稱', 'author 應被 og:title 解析出的顯示名稱覆蓋');
  assert.equal(history[0].handle, '@dom_username', 'handle 仍應維持 DOM/URL 擷取版，og 版不覆蓋');
  assert.equal(history[0].excerpt, '這是完整未截斷的貼文全文內容。', 'excerpt 應被 og 版(全文)覆蓋');
});

// 優先序:og 缺席時完全維持 DOM 版(og 只補位/覆蓋，不會把 DOM 版清空)。
test('OG 案:share 路徑 og 缺席時，完全維持 DOM 版 author/handle/excerpt', async () => {
  const bg = loadBackgroundWithOgHtml(NO_OG_HTML);

  await bg.sendResolveShare({ type: 'resolveShare', url: OG_SHARE_URL });
  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: OG_FINAL_URL,
    kind: 'share',
    author: 'dom_author',
    handle: '@dom_handle',
    excerpt: 'dom excerpt',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, 'dom_author');
  assert.equal(history[0].handle, '@dom_handle');
  assert.equal(history[0].excerpt, 'dom excerpt');
});

// 優先序:handle 在 DOM 版缺席時，og 版補位(不是「DOM 有值才生效」，是
// 「DOM 沒有才輪到 og」)。
test('OG 案:share 路徑 DOM 版 handle 缺席時，og 版補位', async () => {
  const html = '<meta property="og:title" content="真實顯示名稱 (@og_handle) on Threads" />';
  const bg = loadBackgroundWithOgHtml(html);

  await bg.sendResolveShare({ type: 'resolveShare', url: OG_SHARE_URL });
  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: OG_FINAL_URL,
    kind: 'strip', // strip 路徑不會觸發 resolveShare，但這裡刻意測試「若剛好有快取」的補位行為與 kind 無關
    excerpt: 'dom excerpt',
    // 刻意不帶 author/handle，模擬 DOM 完全沒抓到的情況。
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, '真實顯示名稱');
  assert.equal(history[0].handle, '@og_handle', 'DOM 版缺席時 og 版應補位');
});

// 重複值防禦:DOM 版 author 與 handle(去掉開頭 @)相同時(web DOM 抓到的
// 「作者」實為 username 的典型症狀)，且沒有 og 資訊可覆蓋，author 應視
// 同缺席，不落重複值。
test('OG 案:重複值防禦——DOM 版 author 與 handle(去掉 @)相同、且無 og 可覆蓋時，author 視同缺席', async () => {
  const bg = loadBackgroundWithOgHtml(NO_OG_HTML);

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: CLEAN_POST_URL,
    kind: 'icon', // icon 路徑，從不觸發 resolveShare，og 快取恆為空
    author: 'dupe_user',
    handle: '@dupe_user',
    excerpt: 'some excerpt',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal('author' in history[0], false, 'author 與 handle 重複時應視同缺席，不存重複值');
  assert.equal(history[0].handle, '@dupe_user', 'handle 本身不受影響，仍照常寫入');
  assert.equal(history[0].excerpt, 'some excerpt');
});

// 重複值防禦對照組:author 與 handle 不同時，兩者都應正常保留(排除「一
// 律清空 author」的假動作)。
test('OG 案:重複值防禦對照組——author 與 handle 不同時，兩者皆正常保留', async () => {
  const bg = loadBackgroundWithOgHtml(NO_OG_HTML);

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: CLEAN_POST_URL,
    kind: 'icon',
    author: '真實顯示名稱',
    handle: '@some_handle',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, '真實顯示名稱');
  assert.equal(history[0].handle, '@some_handle');
});

// 重複值防禦:og 覆蓋後與 handle 仍相同的邊角情況(og:title 只有帳號名、
// 沒有真正的顯示名稱)，一樣要套用防禦，不因為來源是 og 就放行。
test('OG 案:重複值防禦亦適用於 og 覆蓋後的結果(og:title 解析出的名稱恰好與 handle 相同)', async () => {
  const html = '<meta property="og:title" content="dupe_user (@dupe_user) on Threads" />';
  const bg = loadBackgroundWithOgHtml(html);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal('author' in history[0], false, 'og 覆蓋後若仍與 handle 重複，一樣視同缺席');
  assert.equal(history[0].handle, '@dupe_user');
});

test('OG 案:og 快取以 cleanUrl 為鍵，不同網址互不污染', async () => {
  const html = '<meta property="og:title" content="甲使用者 (@user_a) on Threads" />';
  const bg = loadBackgroundWithOgHtml(html);

  await bg.sendResolveShare({ type: 'resolveShare', url: OG_SHARE_URL });

  // 對另一個從未呼叫過 resolveShare 的網址送 cleanedNotice，快取裡沒有
  // 它的資料，不該誤撈到剛剛甲網址快取的 og 資訊。
  const otherUrl = 'https://www.threads.com/@other/post/OtherPost';
  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: otherUrl,
    kind: 'icon',
    author: 'dom_author',
    handle: '@dom_handle',
  });
  await settle();

  const otherEntry = bg.storage.localSnapshot().history.find((e) => e.url === otherUrl);
  assert.equal(otherEntry.author, 'dom_author', '沒有對應快取時不得誤用其他網址的 og 資訊');
  assert.equal(otherEntry.handle, '@dom_handle');
});

// ============================================================
// icon/strip 路徑的 web 動態牆 DOM 沒有個人顯示名
// 稱(只有 username)，author 恆等於 handle 會被重複值防禦丟棄，卡片只
// 剩 @handle。handleCleanedNotice 對 kind icon/strip 且 cleanUrl 通過
// POST_URL_PATTERN 者，直接 fetch 該貼文頁補抓 og，紀錄落盤延後至 og
// 取回(逾時 2.5 秒或 fetch 失敗則直接用 DOM 欄位落盤，不做「先落盤再補
// 寫」)。與 share 路徑不同:icon/strip 從未呼叫 resolveShare，og 快取無
// 從橋接，這裡改對 cleanUrl(貼文頁本身)直接發 fetch，不經短碼中繼。
// ============================================================

// fetch mock 直接對 postUrl(貼文頁本身)開通，可自訂回傳的 html、是否
// 失敗、是否延遲(逾時測試用)，不透過 loadBackgroundWithOgHtml(該 loader
// 的 fetch mock 是對 shareUrl 開通，模擬的是 share 路徑的短碼中繼)。
function loadBackgroundWithLocalOgFetch(postUrl, opts = {}) {
  const chrome = makeChrome();
  const storage = createChromeStorage({ saveHistory: true });
  const executeScriptCalls = [];
  const onMessageListeners = [];
  chrome.runtime.onMessage.addListener = (fn) => onMessageListeners.push(fn);
  chrome.scripting = {
    executeScript: async (arg) => {
      executeScriptCalls.push(arg);
      return [{ result: { ok: true } }];
    },
  };
  chrome.storage = storage.api;
  const fetchCalls = [];
  // 側錄每次 fetch 的 init 物件，供 Accept-Language header 斷言。
  const fetchInits = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push(url);
    fetchInits.push(init);
    if (url === postUrl) {
      if (opts.fail) {
        throw new Error('mock fetch failure');
      }
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      return fetchResult(postUrl, opts.html !== undefined ? opts.html : NO_OG_HTML);
    }
    throw new Error('unexpected fetch: ' + url);
  };
  runInSandbox(SRC, { chrome, fetch: fetchImpl, console, URL, URLSearchParams, setTimeout, clearTimeout });
  return {
    storage,
    executeScriptCalls,
    fetchCalls,
    fetchInits,
    sendCleanedNotice(message) {
      onMessageListeners.slice().forEach((fn) => fn(message, {}, () => {}));
    },
  };
}

const LOCAL_OG_POST_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

test('OG 案(本地路徑補強):icon 路徑 fetch 成功時，og 解析出的顯示名稱入庫(不再只剩 @handle)', async () => {
  const html =
    '<meta property="og:title" content="大福 (@dafucoding) on Threads" />' +
    '<meta property="og:description" content="今天天氣真好，適合出門走走。" />';
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding', // web DOM 沒有個人名稱，只有 username
    handle: '@dafucoding',
    excerpt: '2.6 萬', // 摘要吸到讚數髒字
  });
  await settle();

  assert.equal(bg.fetchCalls.length, 1, 'icon 路徑應對貼文頁本身發一次 fetch');
  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, '大福', 'author 應由 og:title 解析出的顯示名稱補強，不再與 handle 重複');
  assert.equal(history[0].handle, '@dafucoding');
  assert.equal(history[0].excerpt, '今天天氣真好，適合出門走走。', 'excerpt 應由 og:description 覆蓋 DOM 版讚數髒字');
});

test('OG 案(本地路徑補強):icon 路徑 fetch 失敗時，回退 DOM 欄位落盤，紀錄不遺失', async () => {
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { fail: true });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
    excerpt: 'dom excerpt',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, 'fetch 失敗不得遺失紀錄');
  assert.equal('author' in history[0], false, 'author 與 handle 重複(DOM 版沒有真名)，og 又拿不到，視同缺席');
  assert.equal(history[0].handle, '@dafucoding');
  assert.equal(history[0].excerpt, 'dom excerpt', 'og 拿不到時完全維持 DOM 版');
});

// 逾時測試需要真實等待超過 OG_LOCAL_FETCH_TIMEOUT_MS(2.5 秒)，settle 放
// 寬到 2700ms(2500 逾時 + Windows 計時器顆粒緩衝)。delayMs 故意設為
// 3000(略高於逾時值)，確保測試斷言時逾時已先觸發；背景 fetch 之後才
// resolve，只會呼叫 cacheOgFields 快取起來(供後續節流重用)，不會再次
// recordHistory，不會污染時間軸(規格明文禁止「先落盤再補寫」)。
test('OG 案(本地路徑補強):icon 路徑 fetch 逾時(超過 2.5 秒)時，回退 DOM 欄位落盤', async () => {
  const html = '<meta property="og:title" content="大福 (@dafucoding) on Threads" />';
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html, delayMs: 3000 });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
    excerpt: 'dom excerpt',
  });
  await settle(2700);

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '逾時不得遺失紀錄');
  assert.equal('author' in history[0], false, 'og 逾時前拿不到，DOM 版 author 與 handle 重複，視同缺席');
  assert.equal(history[0].handle, '@dafucoding');
  assert.equal(history[0].excerpt, 'dom excerpt', '逾時時完全維持 DOM 版');
});

test('OG 案(本地路徑補強):同一 cleanUrl 的 icon 節流——60 秒內第二次事件重用快取，不重複 fetch', async () => {
  const html = '<meta property="og:title" content="大福 (@dafucoding) on Threads" />';
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle();
  assert.equal(bg.fetchCalls.length, 1, '第一次事件應觸發一次 fetch');

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle();

  assert.equal(bg.fetchCalls.length, 1, '60 秒節流窗口內第二次事件不得再發 fetch，應重用快取');
  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '同一 cleanUrl 在去重視窗內合併為一筆，不得多長一筆');
  assert.equal(history[0].author, '大福', '節流重用的快取仍應正確帶出 og 解析結果');
});

test('OG 案(本地路徑補強):strip 路徑抽驗——og fetch 成功時同樣補強顯示名稱(與 icon 共用同一段邏輯)', async () => {
  const html = '<meta property="og:title" content="大福 (@dafucoding) on Threads" />';
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'strip',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle();

  assert.equal(bg.fetchCalls.length, 1, 'strip 路徑同樣應對貼文頁本身發一次 fetch');
  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, '大福', 'strip 路徑應與 icon 路徑共用同一段 og 補強邏輯');
  assert.equal(history[0].handle, '@dafucoding');
});

// extractCleanPostUrl 用的
// CLEAN_POST_URL_PATTERN 刻意寬鬆(排除法字元類、無長度上限)，只用來從
// 轉址結果「截」出前段乾淨網址;寫入 history 前要再過一次全 repo 單一
// 權威的 POST_URL_PATTERN(白名單字元類、長度上限 80)。這裡讓 fetch mock
// 回傳一個帶 '~' 字元(不在白名單內，但也不是 /、?、# 因此不會擋在
// extractCleanPostUrl 那一關)的 finalUrl，驗證:剪貼簿仍照常寫入(複製
// 功能本身不受影響)，但不寫入紀錄，且留一句 console.warn。
test('紀錄:右鍵路徑解析出的網址不符嚴格白名單樣式(POST_URL_PATTERN)時，略過記錄但不影響已複製到剪貼簿的內容', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    bg.click({ linkUrl: SHARE_URL_WEIRD_HANDLE }, { id: 7 });
    await settle();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(bg.executeScriptCalls.length, 1, '剪貼簿複製本身不受這個邊界情況影響，應照常寫入');
  assert.equal(bg.executeScriptCalls[0].args[0], 'https://www.threads.com/@weird~handle/post/AbC123');
  assert.equal(bg.storage.localSnapshot().history, undefined, '不符嚴格白名單樣式的網址不得寫入紀錄');
  assert.ok(
    warnCalls.some((args) => typeof args[0] === 'string' && args[0].includes('[threads-clean-link]')),
    '應留一句帶前綴的 console.warn'
  );
});

// 對照組:handle/post id 長度恰為 80 時仍應通過(邊界不誤殺)，81 則被拒。
// 這裡自建 sandbox(不經 loadBackgroundWithSettings)，settle() 用長一
// 點的等待:右鍵路徑的紀錄鏈路(getSettings→storage.local.get→
// storage.local.set)本來就比一般測試多幾個 tick，兩個案例各跑一輪，
// Windows 計時器顆粒下用預設 150ms 偶發等不完，放寬到 400ms。
test('紀錄:POST_URL_PATTERN 的 handle/post id 長度上限 80——恰為 80 時通過，81 時拒絕(不記錄)', async () => {
  const cases = [
    { len: 80, label: '恰為 80，應通過', shouldRecord: true },
    { len: 81, label: '81，應拒絕', shouldRecord: false },
  ];

  for (const { len, label, shouldRecord } of cases) {
    const handle = 'h'.repeat(len);
    const shareUrl = `https://www.threads.com/share/LEN${len}`;
    const finalUrl = `https://www.threads.com/@${handle}/post/AbC123`;
    const chrome = makeChrome();
    const storage = createChromeStorage({ saveHistory: true });
    const executeScriptCalls = [];
    const onClickedListeners = [];
    chrome.contextMenus.onClicked.addListener = (fn) => onClickedListeners.push(fn);
    chrome.scripting = {
      executeScript: async (arg) => {
        executeScriptCalls.push(arg);
        return [{ result: { ok: true } }];
      },
    };
    chrome.tabs = { TAB_ID_NONE: -1 };
    chrome.storage = storage.api;
    const fetchImpl = async (url) => {
      if (url === shareUrl) return fetchResult(finalUrl);
      throw new Error('unexpected fetch: ' + url);
    };
    // fetchOgFieldsForLocalKind 內部用 setTimeout 做逾時競速，一併注入
    // (此測試雖走右鍵路徑不會觸發，維持一致性)。
    runInSandbox(SRC, { chrome, fetch: fetchImpl, console, URL, URLSearchParams, setTimeout, clearTimeout });

    onClickedListeners[0]({ linkUrl: shareUrl }, { id: 7 });
    await settle(400);

    assert.equal(executeScriptCalls.length, 1, `${label}:剪貼簿應照常寫入`);
    const history = storage.localSnapshot().history;
    if (shouldRecord) {
      assert.equal(history && history.length, 1, `${label}:應寫入紀錄`);
    } else {
      assert.equal(history, undefined, `${label}:不應寫入紀錄`);
    }
  }
});

// ============================================================
// 紀錄去重合併(語意對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/share-history-storage.ts:DEDUP_WINDOW_MS／mergeDuplicateItem):
// recordHistory 為合併式寫入，以 url(cleaned)為 key，在既有清單找「同 url
// 且 now - entry.at <= 5 分鐘」的條目——
//   - 命中:合併為一筆並浮到最前;at 更新為 now;author/handle/excerpt 新
//     值優先、新值缺席沿用舊值;kind 更新為本次來源;seen[] append
//     {at, kind} 並裁到 50 筆(舊在前新在後)。
//   - 未命中:新增一筆，seen 為 [{at, kind}] 起始一筆。
//   - 舊資料沒有 seen 欄位:合併時照手機版語意補種一筆起始紀錄
//     [{ at: existing.at }](對齊 existing.seen ?? [{ at:
//     existing.receivedAt }] 的等效寫法)，種子紀錄不帶 kind，再疊上本
//     次事件(見 background.js 內 mergeHistoryEntry 註解)。
// ============================================================

test('紀錄去重合併:視窗內命中時合併為一筆——浮到最前、at 更新、author/handle/excerpt 新值優先缺席沿用舊值、kind 更新為最近一次、seen[] 追加', async () => {
  const now = Date.now();
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: now - 60 * 1000, // 1 分鐘前，落在 5 分鐘去重視窗內
    author: 'Old Author',
    handle: '@old',
    excerpt: 'Old excerpt',
    seen: [{ at: now - 60 * 1000, kind: 'share' }],
  };
  const other = { url: 'https://www.threads.com/@other/post/OtherPost', kind: 'strip', at: now - 1000 };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [other, existing] });

  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'icon',
    author: 'New Author',
    excerpt: 'New excerpt',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 2, '視窗內命中應合併，不新增第三筆');
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL, '合併後的條目應浮到陣列最前');
  assert.ok(history[0].at >= now, 'at 應更新為本次寫入時間');
  assert.equal(history[0].kind, 'icon', 'kind 應更新為本次來源');
  assert.equal(history[0].author, 'New Author', '本次有值的欄位應以新值優先');
  assert.equal(history[0].handle, '@old', '本次缺席的欄位應沿用舊值');
  assert.equal(history[0].excerpt, 'New excerpt', '本次有值的欄位應以新值優先');
  assert.equal(history[0].seen.length, 2, 'seen[] 應在既有一筆基礎上再追加一筆');
  assert.equal(history[0].seen[0].kind, 'share', 'seen[] 舊在前');
  assert.equal(history[0].seen[1].kind, 'icon', 'seen[] 新在後');
  assert.equal(history[1].url, other.url, '未命中的其他條目不受影響');
});

// original/removedParams 合併語意與 author/handle/excerpt 完全一致(新值
// 優先、本次缺席沿用舊值)，這裡獨立驗證這兩個欄位。
test('紀錄去重合併:視窗內命中時 original/removedParams 新值優先、本次缺席沿用舊值', async () => {
  const now = Date.now();
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'strip',
    at: now - 60 * 1000,
    original: `${CLEANED_NOTICE_CLEAN_URL}?utm_source=old`,
    removedParams: [{ key: 'utm_source', value: 'old' }],
  };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [existing] });

  // 本次只帶 original，不帶 removedParams:removedParams 應沿用舊值。
  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'strip',
    original: `${CLEANED_NOTICE_CLEAN_URL}?utm_source=new`,
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].original, `${CLEANED_NOTICE_CLEAN_URL}?utm_source=new`, '本次有值的 original 應以新值優先');
  assert.equal(history[0].removedParams.length, 1, '本次缺席的 removedParams 應沿用舊值');
  assert.equal(history[0].removedParams[0].key, 'utm_source');
  assert.equal(history[0].removedParams[0].value, 'old', '沿用的是舊的 removedParams 內容，不是本次的');
});

test('紀錄去重合併:同一 url 但超出去重視窗(> 5 分鐘)時新增一筆，不合併', async () => {
  const now = Date.now();
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: now - 6 * 60 * 1000, // 6 分鐘前，超出 5 分鐘去重視窗
    seen: [{ at: now - 6 * 60 * 1000, kind: 'share' }],
  };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [existing] });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 2, '超出去重視窗應新增一筆，不與舊條目合併');
  assert.equal(history[0].kind, 'icon', '新條目在最前');
  assert.equal(history[0].seen.length, 1, '新條目的 seen[] 只有自己這一筆起始紀錄');
  assert.equal(history[1].url, CLEANED_NOTICE_CLEAN_URL, '視窗外的舊條目原樣保留，不受影響');
  assert.equal(history[1].kind, 'share', '舊條目的 kind 不因新條目寫入而改變');
});

test('紀錄去重合併:seen[] 累積超過 50 筆時裁到最新 50 筆，捨棄最舊', async () => {
  const now = Date.now();
  const seenSeed = Array.from({ length: 50 }, (_, i) => ({ at: now - (50 - i) * 1000, kind: 'share' }));
  const existing = { url: CLEANED_NOTICE_CLEAN_URL, kind: 'share', at: now - 1000, seen: seenSeed };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [existing] });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const seen = bg.storage.localSnapshot().history[0].seen;
  assert.equal(seen.length, 50, 'seen[] 應裁到上限 50 筆');
  assert.equal(seen[49].kind, 'icon', '最新一筆(本次)保留在陣列尾端');
  assert.equal(seen[0].at, seenSeed[1].at, '最舊的一筆(seed[0])被裁掉，陣列開頭往後遞補');
});

// existing.seen 缺席時補種一筆起始紀錄 [{ at: existing.at }](對齊手機版
// `existing.seen ?? [{ at:
// existing.receivedAt }]` 的等效寫法)，讓時間軸看得到條目原本第一次出
// 現的時間;種子紀錄不帶 kind(那一刻沒有對應的來源事件，UI 時間軸端已
// 容忍缺 kind 標籤)，再疊上本次事件，合併後 seen[] 應有兩筆。
test('紀錄去重合併:視窗內命中但既有條目沒有 seen 欄位(舊資料)時，照手機語意補種一筆起始紀錄(不帶 kind)，加上本次事件共兩筆', async () => {
  const now = Date.now();
  const existingAt = now - 60 * 1000;
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: existingAt,
    // 刻意不帶 seen 欄位，模擬 schema 升級前寫入的舊資料。
  };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [existing] });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '仍應合併為一筆，不因缺少 seen 而改走新增路徑');
  const seen = history[0].seen;
  assert.equal(seen.length, 2, '補種一筆起始紀錄，加上本次事件應為兩筆');
  assert.equal(seen[0].at, existingAt, '種子紀錄的 at 沿用既有條目原本的 at(第一次出現的時間)');
  assert.equal('kind' in seen[0], false, '種子紀錄不帶 kind，對齊手機版沒有來源標籤的起始記錄');
  assert.equal(seen[1].kind, 'icon', '本次事件仍照常記 kind');
});

test('紀錄去重合併:既有條目的 seen[] 若含偽造/損毀資料(at 非數字、kind 不在白名單、非物件)，合併時逐筆 sanitize、不整組作廢', async () => {
  const now = Date.now();
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: now - 60 * 1000,
    seen: [
      { at: now - 120 * 1000, kind: 'share' }, // 合法
      { at: 'not-a-number', kind: 'share' }, // at 非數字，應丟棄
      { at: now - 100 * 1000, kind: 'evil' }, // kind 不在白名單，應丟棄
      'not-an-object', // 非物件，應丟棄
    ],
  };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [existing] });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const seen = bg.storage.localSnapshot().history[0].seen;
  assert.equal(seen.length, 2, '偽造/損毀的 seen 記錄逐筆丟棄，只留合法的一筆加上本次新增的一筆');
  assert.equal(seen[0].kind, 'share');
  assert.equal(seen[1].kind, 'icon');
});

// 紀錄不設上限:已有 1000 筆時再寫一筆變成 1001 筆，原本最舊的一筆(seed
// 末筆)必須完整保留、不得被裁掉。
test('紀錄:不設上限，已有 1000 筆時再寫一筆變成 1001 筆，最舊的一筆仍完整保留', async () => {
  const seed = Array.from({ length: 1000 }, (_, i) => ({
    url: `https://www.threads.com/@seeduser/post/P${i}`,
    kind: 'share',
    at: 1000 + i,
  }));
  const bg = loadBackgroundWithSettings(
    { saveHistory: true },
    { localHistory: seed }
  );

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1001, '不設上限，1000 筆基礎上再寫一筆應變成 1001 筆');
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL, '新紀錄插在最前');
  assert.equal(history[1000].url, seed[999].url, '最舊的一筆(seed 末筆)完整保留，不得被裁掉');
});

// 紀錄不設上限，長期使用可能把 chrome.storage.local
// 的容量配額(未申請 unlimitedStorage 權限時仍有總量上限)寫爆。配額失敗
// 要優雅降級:console.warn(帶 [threads-clean-link] 前綴)、不重試、不丟例
// 外，且不影響複製/淨化等主功能持續運作。
test('紀錄:chrome.storage.local.set 超出配額(QUOTA_BYTES)時優雅降級——console.warn、不重試、不影響主功能', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });
  const originalSet = bg.storage.local.set;
  let setCallCount = 0;
  bg.storage.local.set = () => {
    setCallCount += 1;
    return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
  };

  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnCalls.push(args);
  };
  try {
    bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
    await settle();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(setCallCount, 1, '配額失敗不得重試');
  assert.ok(
    warnCalls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('[threads-clean-link]') && args[0].includes('配額')
    ),
    '應以 [threads-clean-link] 前綴 console.warn 配額訊息'
  );
  assert.equal(bg.storage.localSnapshot().history, undefined, '寫入失敗這筆紀錄本來就沒有落地，snapshot 維持原狀');

  // 對照組:配額問題排除後(換回正常的 set)，複製/淨化等主功能繼續正常運作，
  // 不因剛才那次配額失敗而卡住或損壞。
  bg.storage.local.set = originalSet;
  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();
  assert.equal(bg.executeScriptCalls.length, 1, '配額失敗不影響右鍵複製等主功能持續運作');
  assert.equal(bg.storage.localSnapshot().history.length, 1, '排除配額問題後，新的紀錄應能正常寫入');
});

// ============================================================
// 擴充功能更新後的自癒重注入(chrome.runtime.onInstalled)
// ------------------------------------------------------------
// 更新完成的當下，既開 threads 分頁裡的舊 content script 已經孤兒化
// (chrome.runtime.id 消失、sendMessage 必失敗、紀錄靜默丟失)。background
// 對這些分頁重新注入 ISOLATED world 的三支腳本，讓它們立刻換上有效身分。
// 這條測試釘住兩件事:注入目標只限 threads 分頁(絕不外流到其他站台)，以及
// 注入的檔案清單/順序/world 與 manifest 的 content_scripts 對齊。
// ============================================================

function loadBackgroundForReinject(tabs, opts = {}) {
  const chrome = makeChrome();
  const onInstalledListeners = [];
  const queryArgs = [];
  const executeScriptCalls = [];
  chrome.runtime.onInstalled.addListener = (fn) => onInstalledListeners.push(fn);
  chrome.tabs = {
    TAB_ID_NONE: -1,
    query: async (queryInfo) => {
      queryArgs.push(queryInfo);
      if (opts.queryThrows) throw new Error('tabs.query 失敗');
      return tabs;
    },
  };
  chrome.scripting = {
    executeScript: async (injection) => {
      executeScriptCalls.push(injection);
      if (opts.injectThrows) throw new Error('cannot inject into this tab');
      return [{}];
    },
  };
  chrome.storage = createChromeStorage({}).api;
  runInSandbox(SRC, {
    chrome,
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
    console,
    URL,
    URLSearchParams,
  });

  return {
    queryArgs,
    executeScriptCalls,
    fireInstalled(details) {
      onInstalledListeners.slice().forEach((fn) => fn(details || { reason: 'update' }));
    },
  };
}

test('自癒重注入:onInstalled 只對 threads 分頁重新注入 ISOLATED world 腳本，其餘分頁一律不碰', async () => {
  const bg = loadBackgroundForReinject([
    { id: 1, url: 'https://www.threads.com/@kaede.hong/post/DcDrsdAmhlU' },
    { id: 2, url: 'https://threads.net/search?q=x' },
    // 以下都不該被注入:形近網域、把 threads.com 放在子網域位置的釣魚網
    // 域、非 https、URL 被權限遮蔽(undefined)、以及沒有有效 tabId 的分頁。
    { id: 3, url: 'https://evilthreads.com/@x/post/1' },
    { id: 4, url: 'https://threads.com.evil.example/@x/post/1' },
    { id: 5, url: 'http://www.threads.com/@x/post/1' },
    { id: 6, url: undefined },
    { id: -1, url: 'https://www.threads.com/' },
  ]);

  bg.fireInstalled();
  await settle();

  // 陣列一律先 Array.from 搬回本 realm 再比對:sandbox 內建立的陣列與外
  // 層的 Array.prototype 不同源，deepEqual 會判「結構相同但非同一 realm」
  // 而失敗(同 helpers.js 對 settings 物件的既有註記)。
  assert.equal(bg.queryArgs.length, 1, 'tabs.query 只查一次');
  assert.deepEqual(
    Array.from(bg.queryArgs[0].url),
    ['https://*.threads.com/*', 'https://*.threads.net/*'],
    'tabs.query 應以 manifest 既有的 host 樣式先擋一層(不新增任何權限)'
  );

  assert.deepEqual(
    bg.executeScriptCalls.map((call) => call.target.tabId).sort((a, b) => a - b),
    [1, 2],
    '只有真正的 threads 分頁會被重新注入'
  );
  bg.executeScriptCalls.forEach((call) => {
    assert.deepEqual(
      Array.from(call.files),
      ['bridge.js', 'i18n.js', 'post-icon.js'],
      '檔案與順序需對齊 manifest 的 content_scripts(MAIN world 的 clipboard-guard.js 刻意不重注入)'
    );
    assert.equal(call.world, 'ISOLATED', '重注入的是 ISOLATED world 腳本');
  });
});

test('自癒重注入:單一分頁注入失敗(已凍結/不允許注入)不影響其他分頁，也不會變成未捕捉的 rejection', async () => {
  const bg = loadBackgroundForReinject(
    [
      { id: 11, url: 'https://www.threads.com/' },
      { id: 12, url: 'https://www.threads.net/' },
    ],
    { injectThrows: true }
  );

  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    bg.fireInstalled();
    await settle();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(bg.executeScriptCalls.length, 2, '一個分頁失敗不得中斷其他分頁的注入');
  assert.equal(
    warnCalls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('分頁自癒重注入失敗')
    ).length,
    2,
    '每個失敗的分頁各留一則可查的警告'
  );
});

// ============================================================
// 語系鎖定 + 解析保底:Threads 貼文頁的 og:title 隨 Accept-Language 換
// 格式(英文「かえで (@kaede.hong) on Threads」/ 中文「Threads 上的かえ
// で（@kaede.hong）」全形括號 + 前綴)。抓貼文頁的 fetch 一律鎖成英文，
// 解析規則不必追語系;保底是 header 萬一失效時，解析器仍認得全形樣式，
// 且再退一步的 fallback 遇到帳號殘片就整欄放棄。
// ============================================================

const OG_CHINESE_TITLE_HTML =
  '<meta property="og:title" content="Threads 上的かえで（@kaede.hong）" />' +
  '<meta property="og:description" content="今天的貓很可愛。" />';

test('語系鎖定:share/menu 共用的短碼解析 fetch 帶 Accept-Language: en', async () => {
  const bg = loadBackgroundWithOgHtml('<meta property="og:title" content="大福 (@dafucoding) on Threads" />');

  await bg.sendResolveShare({ type: 'resolveShare', url: OG_SHARE_URL });

  assert.equal(bg.fetchCalls.length, 1);
  assert.equal(
    bg.fetchInits[0] && bg.fetchInits[0].headers && bg.fetchInits[0].headers['Accept-Language'],
    'en',
    'resolveFinalUrl 的 fetch 應鎖英文語系，讓 og:title 恆為半形括號格式'
  );
  // 既有的 fetch 選項不得被覆寫掉。
  assert.equal(bg.fetchInits[0].credentials, 'omit', '語系 header 不得動到既有的匿名請求設定');
  assert.equal(bg.fetchInits[0].redirect, 'follow', '語系 header 不得動到既有的轉址跟隨設定');
});

test('語系鎖定:右鍵選單路徑走的是同一個短碼解析器，不另開 fetch，同樣帶 Accept-Language: en', async () => {
  const bg = loadBackgroundWithOgHtml('<meta property="og:title" content="大福 (@dafucoding) on Threads" />');

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.fetchCalls.length, 1, '右鍵路徑不得另開第三個抓貼文頁的 fetch');
  assert.equal(bg.fetchCalls[0], OG_SHARE_URL);
  assert.equal(
    bg.fetchInits[0].headers['Accept-Language'],
    'en',
    '右鍵路徑經 handleShareLinkClick → resolveFinalUrl，語系鎖定自動涵蓋'
  );
});

test('語系鎖定:icon/strip 本地路徑的 og 補強 fetch 帶 Accept-Language: en', async () => {
  const html = '<meta property="og:title" content="大福 (@dafucoding) on Threads" />';
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle();

  assert.equal(bg.fetchCalls.length, 1);
  assert.equal(
    bg.fetchInits[0] && bg.fetchInits[0].headers && bg.fetchInits[0].headers['Accept-Language'],
    'en',
    'fetchOgFieldsForLocalKind 的 fetch 同樣要鎖英文語系'
  );
  assert.equal(bg.fetchInits[0].credentials, 'omit');
  assert.equal(bg.fetchInits[0].redirect, 'follow');
});

test('解析保底:header 失效模擬——中文格式 og:title(全形括號 + 前綴)仍解出 author/handle', async () => {
  const bg = loadBackgroundWithOgHtml(OG_CHINESE_TITLE_HTML);

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, 'かえで', '全形括號樣式應剝掉「Threads 上的」前綴，只留顯示名稱');
  assert.equal(history[0].handle, '@kaede.hong', '全形括號內的帳號應正確解析並補回 @');
  assert.equal(history[0].excerpt, '今天的貓很可愛。');
});

test('解析保底:中文格式在 icon 本地路徑同樣解得出來(兩條路徑共用同一個解析器)', async () => {
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html: OG_CHINESE_TITLE_HTML });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'kaede.hong', // web DOM 只有 username
    handle: '@kaede.hong',
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author, 'かえで', 'icon 路徑也應吃到全形括號保底的解析結果');
  assert.equal(history[0].handle, '@kaede.hong');
});

test('解析保底:英文格式維持原行為不受保底影響(既有主式零改動的回歸釘子)', async () => {
  const bg = loadBackgroundWithOgHtml(
    '<meta property="og:title" content="かえで (@kaede.hong) on Threads" />'
  );

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, 'かえで');
  assert.equal(history[0].handle, '@kaede.hong');
});

test('解析保底:兩式都不成立且 fallback 結果仍夾帶「（@」殘片時，author 整欄放棄', async () => {
  // 全形左括號但收尾是半形右括號——兩式都比對不到，fallback 會整串當作
  // 顯示名稱，但字串裡還有帳號殘片，寧缺勿錯。
  const bg = loadBackgroundWithOgHtml(
    '<meta property="og:title" content="Threads 上的かえで（@kaede.hong)" />'
  );

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '解析放棄不得影響紀錄本身落盤');
  assert.equal('author' in history[0], false, '髒字串(含「（@」殘片)不得整串塞進 author');
  assert.equal('handle' in history[0], false, '解析失敗時 handle 也不該憑空生出');
});

test('解析保底:fallback 結果夾帶半形「(@」殘片同樣整欄放棄', async () => {
  // 半形左括號但沒有右括號——主式的 [^)]+ 找不到收尾，fallback 接手。
  const bg = loadBackgroundWithOgHtml(
    '<meta property="og:title" content="Some Page (@broken on Threads" />'
  );

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal('author' in history[0], false, '半形殘片與全形殘片一視同仁，整欄放棄');
});

test('解析保底:乾淨的 fallback(粉專等無帳號形狀的 og:title)仍照常入庫，不被殘片防線誤殺', async () => {
  const bg = loadBackgroundWithOgHtml('<meta property="og:title" content="Some Page on Threads" />');

  bg.click({ linkUrl: OG_SHARE_URL }, { id: 7 });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history[0].author, 'Some Page', '沒有帳號殘片的 fallback 應維持既有行為');
  assert.equal('handle' in history[0], false);
});

// ============================================================
// 去重視窗貼邊(DEDUP_WINDOW_MS = 5 分鐘 = 300000ms)。釘死邊界運算子
// `now - at <= DEDUP_WINDOW_MS`:at 恰為 now-300000 應合併(邊界含),at 為
// now-300001 應新增。用凍結 Date 消除「測試端 now」與「recordHistory 內
// Date.now()」的毫秒級偏移,否則 now-300000 這種貼邊案例會因偏移而變得不
// 確定。
// ============================================================

const W1_FIXED_NOW = 1700000000000;

test('W1 去重視窗貼邊:at 恰為 now-300000(邊界含)應合併為一筆', async () => {
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: W1_FIXED_NOW - 300000,
    seen: [{ at: W1_FIXED_NOW - 300000, kind: 'share' }],
  };
  const bg = loadBackgroundWithSettings(
    { saveHistory: true },
    { localHistory: [existing], now: W1_FIXED_NOW }
  );

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, 'now-300000 落在去重視窗邊界內(<=),應合併不新增');
  assert.equal(history[0].kind, 'icon', '合併後 kind 更新為本次');
  assert.equal(history[0].seen.length, 2, 'seen[] 在既有一筆上追加本次一筆');
});

test('W1 去重視窗貼邊:at 為 now-300001(邊界外)應新增一筆', async () => {
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: W1_FIXED_NOW - 300001,
    seen: [{ at: W1_FIXED_NOW - 300001, kind: 'share' }],
  };
  const bg = loadBackgroundWithSettings(
    { saveHistory: true },
    { localHistory: [existing], now: W1_FIXED_NOW }
  );

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 2, 'now-300001 超出去重視窗(>),應新增不合併');
  assert.equal(history[0].kind, 'icon', '新條目在最前');
  assert.equal(history[0].seen.length, 1, '新條目 seen[] 只有自己這筆起始紀錄');
});

// ============================================================
// saveHistory 省請求:handleCleanedNotice 進 fetch 之前先 await
// getSettings(),saveHistory 為 false 直接 return——連 og 補強 fetch 都不
// 發、連 recordHistory 都不呼叫。對齊 guard 端 share 路徑已有的省請求閘。
// ============================================================

test('cr中1:saveHistory=false 時,cleanedNotice 進 fetch 前就 return——不發 og 補強 fetch、不記錄', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: false });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  assert.equal(bg.fetchCalls.length, 0, 'saveHistory 關閉時,連 og 補強 fetch 都不該發(省請求閘在 fetch 之前)');
  assert.equal(bg.storage.localSnapshot().history, undefined, 'saveHistory 關閉時不記錄');
});

test('cr中1 對照組:saveHistory=true 時,cleanedNotice 照常補 og fetch 並記錄', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  assert.equal(bg.fetchCalls.length, 1, 'saveHistory 開啟時應照常對貼文頁補一次 og fetch');
  assert.equal(bg.storage.localSnapshot().history.length, 1, '照常記錄一筆');
});

// ============================================================
// 儲存上限(位元組軟預算 8MB + 筆數硬保險 10000),兩者取先觸發者,一律
// 從尾端(最舊)裁,本次最新一筆永遠保留。
// ============================================================

test('R5 筆數硬保險:總筆數超過 HISTORY_MAX_ENTRIES(10000)時從尾端(最舊)裁回 10000', async () => {
  const now = Date.now();
  const existing = Array.from({ length: 10000 }, (_, i) => ({
    url: `https://www.threads.com/@u/post/P${i}`,
    kind: 'icon',
    at: now - 1000 - i,
    seen: [{ at: now - 1000 - i, kind: 'icon' }],
  }));
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: existing });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle(600);

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 10000, '總筆數(10001)應被硬保險裁回 10000');
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL, '本次最新一筆在最前,不被裁掉');
  assert.equal(
    history[history.length - 1].url,
    'https://www.threads.com/@u/post/P9998',
    '最舊一筆(P9999)被從尾端裁掉'
  );
});

test('R5 位元組軟預算:序列化超過 8MB 時從尾端(最舊)裁到預算內,最新一筆保留', async () => {
  const now = Date.now();
  const bigExcerpt = 'x'.repeat(50000); // 約 50KB/筆
  const existing = Array.from({ length: 200 }, (_, i) => ({
    url: `https://www.threads.com/@u/post/Q${i}`,
    kind: 'icon',
    at: now - 1000 - i,
    excerpt: bigExcerpt,
    seen: [{ at: now - 1000 - i, kind: 'icon' }],
  }));
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: existing });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle(600);

  const history = bg.storage.localSnapshot().history;
  const bytes = JSON.stringify(history).length;
  assert.ok(bytes <= 8 * 1024 * 1024, `序列化位元組(${bytes})應被裁到軟預算 8MB 內`);
  assert.ok(history.length < 201, '軟預算超標時應從尾端裁掉最舊的若干筆(不是原封不動)');
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL, '本次最新一筆永遠保留,不被位元組裁切吃掉');
});

// ============================================================
// og 快取加固:(1) in-flight 去重;(2) 空結果負快取(短 TTL);(3) 真 LRU
// (set 前先 delete)。
// ============================================================

test('F3 負快取:og 抓不到(空結果)時入負快取,短 TTL 內第二次事件不再 fetch', async () => {
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html: NO_OG_HTML });

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle();
  assert.equal(bg.fetchCalls.length, 1, '第一次事件 og 抓不到,發一次 fetch');

  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle();
  assert.equal(bg.fetchCalls.length, 1, 'og 空結果已入負快取,短 TTL 內第二次事件不再重跑 fetch');
});

test('F3 in-flight 去重:同一 cleanUrl 兩次事件在 fetch 未完成前併發,只發一次 fetch', async () => {
  const html = '<meta property="og:title" content="大福 (@dafucoding) on Threads" />';
  const bg = loadBackgroundWithLocalOgFetch(LOCAL_OG_POST_URL, { html, delayMs: 100 });

  // 兩次事件同步併發:第二次進來時,第一次的 fetch 仍在 in-flight(尚未寫回
  // 快取),第二次應接同一個 in-flight promise,不重複發 fetch。
  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  bg.sendCleanedNotice({
    type: 'cleanedNotice',
    cleanUrl: LOCAL_OG_POST_URL,
    kind: 'icon',
    author: 'dafucoding',
    handle: '@dafucoding',
  });
  await settle(400);

  assert.equal(bg.fetchCalls.length, 1, '併發事件共用同一個 in-flight fetch,不重複發');
  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '同一 cleanUrl 去重視窗內合併為一筆');
  assert.equal(history[0].author, '大福', 'in-flight 共用的 fetch 結果照樣補強顯示名稱');
});

// og 快取多路由 loader:share 短碼 /share/S{i} 解析到 /@u{i}/post/P{i}(帶
// 各自 og);貼文頁本身(cleanedNotice 補強路徑)回無 og。供 LRU 溢位測試
// 灌入超過 OG_CACHE_MAX(20)個不同 cleanUrl。
function loadBackgroundOgMulti() {
  const chrome = makeChrome();
  const storage = createChromeStorage({ saveHistory: true });
  const onMessageListeners = [];
  chrome.runtime.onMessage.addListener = (fn) => onMessageListeners.push(fn);
  chrome.scripting = { executeScript: async () => [{ result: { ok: true } }] };
  chrome.storage = storage.api;
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    const m = /\/share\/S(\d+)$/.exec(url);
    if (m) {
      const i = m[1];
      return fetchResult(
        `https://www.threads.com/@u${i}/post/P${i}`,
        `<meta property="og:title" content="Author${i} (@u${i}) on Threads" />`
      );
    }
    if (/\/post\//.test(url)) return fetchResult(url, NO_OG_HTML);
    throw new Error('unexpected fetch: ' + url);
  };
  runInSandbox(SRC, { chrome, fetch: fetchImpl, console, URL, URLSearchParams, setTimeout, clearTimeout });
  return {
    storage,
    fetchCalls,
    resolve(i) {
      return new Promise((resolve) => {
        onMessageListeners
          .slice()
          .forEach((fn) => fn({ type: 'resolveShare', url: `https://www.threads.com/share/S${i}` }, {}, resolve));
      });
    },
    notice(finalUrl) {
      onMessageListeners
        .slice()
        .forEach((fn) => fn({ type: 'cleanedNotice', cleanUrl: finalUrl, kind: 'share' }, {}, () => {}));
    },
  };
}

test('F3 淘汰改真 LRU:重新被解析的 og 刷新到最新,溢位淘汰時得以存活(非最久未用被誤淘)', async () => {
  const bg = loadBackgroundOgMulti();

  // 填滿快取(OG_CACHE_MAX = 20):解析 S1..S20。
  for (let i = 1; i <= 20; i++) await bg.resolve(i);
  // 重新解析 S1 → cacheOgFields 的 set 前先 delete,把 f1 移到迭代序最新。
  await bg.resolve(1);
  // 再解析 S21 → 溢位,淘汰迭代序最舊者(真 LRU 下應為 f2,而非剛刷新的 f1)。
  await bg.resolve(21);

  const before = bg.fetchCalls.length;
  // f1 最近才被重新解析,真 LRU 下仍在快取:cleanedNotice peek 命中,不再 fetch。
  bg.notice('https://www.threads.com/@u1/post/P1');
  await settle();
  assert.equal(bg.fetchCalls.length, before, 'f1 最近才刷新,真 LRU 下應存活,cleanedNotice 不需再 fetch');

  const mid = bg.fetchCalls.length;
  // f2 是最久未用,已在 S21 溢位時被淘汰:peek miss → 需補一次 fetch。
  bg.notice('https://www.threads.com/@u2/post/P2');
  await settle();
  assert.equal(bg.fetchCalls.length, mid + 1, 'f2 最久未用已被淘汰,cleanedNotice 需補一次 fetch');
});
