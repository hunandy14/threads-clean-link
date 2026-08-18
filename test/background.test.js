// test/background.test.js — background.js(service worker)裡
// resolveShare 訊息處理路徑的行為契約。fetch 與 chrome.* 全程 mock，
// 不發真實網路請求。
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

// 依 url 回傳固定的 fetch 結果，模擬短連結解析伺服器的轉址行為。
function makeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url === SHARE_URL) {
      return { url: `${CLEAN_POST_URL}?xmt=AQGabc`, body: { cancel: async () => {} } };
    }
    if (url === 'https://www.threads.com/share/NETWORKFAIL') {
      throw new Error('network down');
    }
    if (url === 'https://www.threads.com/share/NOTAPOST') {
      return { url: 'https://www.threads.com/login', body: { cancel: async () => {} } };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

// 載入 background.js，回傳 resolveShare 的 onMessage 監聽器與 fetch 呼叫紀錄。
function loadBackground() {
  const chrome = makeChrome();
  const calls = [];
  runInSandbox(SRC, { chrome, fetch: makeFetch(calls), console });
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
// SHARE_URL_PATTERN 尾端收緊規格(v1.1 車道 C)——測試先行、紅燈存證
// 現行 SHARE_URL_PATTERN(background.js:6)為
//   /^https:\/\/(www\.)?threads\.(com|net)\/share\/.+/i
// 只錨定開頭(^)、尾端用 .+ 且不錨定 $，只要 /share/ 後有至少 1 個
// 任意字元(含 /、空白、雜訊)就會判定為合法短碼。以下案例表窮舉
// 「必須匹配」與「不得匹配(收緊目標)」兩類，鎖住尾端收緊後的規格。
// 本節只新增測試、不改動上面任何既有斷言。
// ============================================================

// 一律成功的 fetch mock:只用來觀察 SHARE_URL_PATTERN 是否放行(有沒有
// 呼叫到 fetch),不模擬個別短碼的轉址內容,一律回傳同一組乾淨貼文網址。
function makeAlwaysSucceedFetch(calls) {
  return async (url) => {
    calls.push(url);
    return { url: `${CLEAN_POST_URL}?xmt=AQGabc`, body: { cancel: async () => {} } };
  };
}

// 載入 background.js,搭配一律成功的 fetch mock,回傳監聽器與 fetch 呼叫紀錄。
function loadBackgroundAlwaysSucceed() {
  const chrome = makeChrome();
  const calls = [];
  runInSandbox(SRC, { chrome, fetch: makeAlwaysSucceedFetch(calls), console });
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
// 短碼。現行正則因尾端用 .+ 且未錨定 $，這些案例目前會被誤判為合法，
// 屬本車道要收緊掉的紅燈案例;每一列附一句歸類理由。
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

// 【精簡】原本每個案例各自成為一條測試(共 16 條)，但兩組案例各自只驗證
// 「同一個不變量」的多個資料變體，改為兩條多案例測試:案例表原樣保留，
// 每個 url 的歸類理由仍寫進斷言訊息，失敗時照樣指得出是哪一列。

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
// v1.1 設定規格 S1:右鍵選單路徑不受 autoClean 影響，永遠可用。
//
// 使用者變更設定規格:S2(notifySuccess 把關成功類通知)已隨 notifySuccess
// 整組移除——成功類通知(右鍵路徑的 bgSuccess、自動路徑的
// bgAutoSuccess/bgIconSuccess)全數拆除，不再有「要不要顯示」這道關卡；
// 失敗／錯誤類通知不受任何設定影響，永遠觸發(右鍵路徑維持系統通知；
// share/strip 自動路徑的失敗改走頁內 toast，見 bridge.test.js／
// post-icon.test.js，不在本檔覆蓋範圍)。
//
// 【時序紀律】chrome.storage.sync 的 get/set 一律延遲一個 tick 才結算
// (見 support/helpers.js)，不允許同 tick 直接 resolve 的假綠燈;
// 右鍵點擊流程本身是非同步的，測試以 settle() 等它跑完。
//
// 【防假綠燈】「失敗通知永遠觸發」這類條目，在現況(完全沒有設定機制)下
// 本來就會通過。因此這些測試一律搭配一個可鑑別的斷言:同一個 service
// worker 內成功流程不得發通知，或斷言 SW 確實讀過 chrome.storage.sync，
// 避免「設定根本沒接上卻碰巧通過」。
// ============================================================

// 淨化紀錄 + i18n 之後,cleanedNotice 的完整鏈路(讀設定→記錄→讀設定→
// 讀語言→通知)串了約 5 個 setTimeout(0) tick;Windows 計時器顆粒 ~15ms,
// 60ms 會偶發性等不完,放寬到 150ms。
function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 載入 background.js，並以指定設定填入 chrome.storage.sync;同時側錄
// contextMenus.onClicked 監聽器、notifications.create 與 scripting.executeScript。
// opts.clipboardOk 可在測試中途翻轉，模擬「先失敗、後成功」的兩次點擊。
// opts.localHistory 可預填 storage.local 的 history(測紀錄上限用)。
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
  runInSandbox(SRC, { chrome, fetch: makeFetch(fetchCalls), console });

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

// ---- 使用者變更設定規格:autoClean 預設值改為 false ----
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

// ---- 使用者變更設定規格:成功類通知整組移除，右鍵成功複製不得觸發任何
// 成功通知(不再有 notifySuccess 這種可開關的把關，行為恆定)----

test('右鍵成功複製不得觸發任何成功通知(成功類通知已整組移除)', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1);
  assert.deepEqual(bg.notifications, []);
});

// ---- 失敗／錯誤類通知不受設定影響，永遠觸發 ----

// 【精簡】三種錯誤來源(無效短連結／網路失敗／轉址結果非貼文)驗的是同一個
// 不變量:錯誤通知永遠觸發，且其後的成功流程不發通知(成功類通知已整組
// 移除)。三條併為一條多案例測試，通知 id 逐案例斷言，覆蓋面不減。剪貼簿
// 寫入失敗因為需要中途翻轉 clipboardOk，harness 形狀不同，仍單獨一條(見下)。
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
// 方案甲(歷史即收藏):自動路徑(share/strip/icon)的 cleanedNotice 是淨化
// 紀錄(唯一資料集)的入筆管道，形狀為
// { type: 'cleanedNotice', cleanUrl, kind, author?, handle?, excerpt? }
// (kind 白名單 'share' | 'strip' | 'icon',非法整則忽略——見檔末「淨化
// 紀錄」區塊)。使用者變更設定規格:notifySuccess 整組移除，cleanedNotice
// 收到就無條件記錄，不再發任何通知——本節驗證這一點，並保留 R1/R2 審查
// 留下的阻斷級安全回歸測試(原本驗「不得發出通知」，現改驗「不得寫入紀
// 錄」，驗證核心不變:cleanUrl 必須整串錨定吻合才採信)。
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

// R1 審查回饋(阻斷級，方案甲重組後改驗紀錄而非通知):cleanedNotice 的
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

// R2 審查回饋(阻斷級，同上改驗紀錄):只錨定收尾、字元類用排除法(如
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
  await settle();

  assert.equal(bg.storage.localSnapshot().history, undefined, '非法 kind 不得留下任何紀錄');
  assert.deepEqual(bg.notifications, [], '非法 kind 不得發出任何通知');

  // 對照組:合法 kind 照常記錄,排除「一律不記錄」的假動作。
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(bg.storage.localSnapshot().history.length, 1);
});

// 0.4.0 新增:貼文互動列複製 icon(post-icon.js)點擊複製成功後，經
// cleanedNotice 送 kind:'icon'——白名單需收下這個新來源，記錄與通知都
// 比照 share/strip 既有自動路徑一視同仁，不做特殊抑制。
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

// ---- 方案甲(歷史即收藏):cleanedNotice 選填的 author/handle/excerpt ----
//
// 這三個欄位由複製 icon(post-icon.js)或 bridge.js(share/strip 路徑)從
// 貼文容器 DOM 順手擷取，同屬頁面可控輸入，不信任:型別不是 string 的
// 一律整欄丟棄，字串則截斷至各自長度上限(author/handle 100、excerpt
// 2000)，寫法沿用 0.5.0 貼文收藏庫基座原本的 sanitizeFavoriteField(已
// 改名 sanitizeHistoryField)。三者都是選填，缺席不影響其餘欄位或整筆
// 紀錄的寫入。

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

test('紀錄:author/handle/excerpt 型別不是字串時整欄丟棄，不影響其餘欄位與紀錄本身', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'icon',
    author: 12345,
    handle: null,
    excerpt: { not: 'a string' },
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '型別不符只丟該欄位，不影響整筆紀錄寫入');
  assert.equal(history[0].url, CLEANED_NOTICE_CLEAN_URL);
  assert.equal('author' in history[0], false);
  assert.equal('handle' in history[0], false);
  assert.equal('excerpt' in history[0], false);
});

test('紀錄:author/handle 截斷至 100 字、excerpt 截斷至 2000 字；空字串比照非字串整欄丟棄', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({
    type: 'cleanedNotice',
    cleanUrl: CLEANED_NOTICE_CLEAN_URL,
    kind: 'icon',
    author: 'A'.repeat(150),
    handle: '',
    excerpt: 'E'.repeat(2500),
  });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].author.length, 100, 'author 應截斷至 100 字');
  assert.equal('handle' in history[0], false, '空字串比照非字串整欄丟棄');
  assert.equal(history[0].excerpt.length, 2000, 'excerpt 應截斷至 2000 字');
});

test('紀錄:kind 為 icon 以外的未知字串仍被白名單拒絕，不記錄、不通知', async () => {
  const bg = loadBackgroundWithSettings({ saveHistory: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icons' });
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'bogus' });
  await settle();

  assert.equal(bg.storage.localSnapshot().history, undefined, '白名單以外的 kind 不得留下任何紀錄');
  assert.deepEqual(bg.notifications, [], '白名單以外的 kind 不得發出任何通知');
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

// ============================================================
// 紀錄去重合併(語意對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/share-history-storage.ts:DEDUP_WINDOW_MS／mergeDuplicateItem，
// PM 快查確認後拍板):recordHistory 改為合併式寫入，以 url(cleaned)為
// key，在既有清單找「同 url 且 now - entry.at <= 5 分鐘」的條目——
//   - 命中:合併為一筆並浮到最前;at 更新為 now;author/handle/excerpt 新
//     值優先、新值缺席沿用舊值;kind 更新為本次來源;seen[] append
//     {at, kind} 並裁到 50 筆(舊在前新在後)。
//   - 未命中:新增一筆，seen 為 [{at, kind}] 起始一筆。
//   - 舊資料沒有 seen 欄位:合併時容忍(當空陣列起算)，不做遷移——與手機
//     版拿 existing.receivedAt 合成一筆起始紀錄的做法不同，是本檔案規
//     格明文的刻意簡化(見 background.js 內 mergeHistoryEntry 註解)。
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

test('紀錄去重合併:視窗內命中但既有條目沒有 seen 欄位(舊資料)時，容忍當空陣列起算，不做遷移', async () => {
  const now = Date.now();
  const existing = {
    url: CLEANED_NOTICE_CLEAN_URL,
    kind: 'share',
    at: now - 60 * 1000,
    // 刻意不帶 seen 欄位，模擬 schema 升級前寫入的舊資料。
  };
  const bg = loadBackgroundWithSettings({ saveHistory: true }, { localHistory: [existing] });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL, kind: 'icon' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '仍應合併為一筆，不因缺少 seen 而改走新增路徑');
  assert.equal(history[0].seen.length, 1, '缺席的 seen 當空陣列起算，合併後只有本次這一筆(不遷移補一筆舊資料)');
  assert.equal(history[0].seen[0].kind, 'icon');
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

// 使用者拍板(規格翻轉):紀錄不設上限，原本「超過 1000 筆裁掉最舊」的斷
// 言改為驗證相反的不變量——已有 1000 筆時再寫一筆，變成 1001 筆，原本
// 最舊的一筆(seed 末筆)必須完整保留、不得被裁掉。
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

// 使用者拍板:紀錄不設上限之後，長期使用可能真的把 chrome.storage.local
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
