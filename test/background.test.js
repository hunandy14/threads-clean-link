// test/background.test.js — background.js(service worker)裡
// resolveShare 訊息處理路徑的行為契約。fetch 與 chrome.* 全程 mock，
// 不發真實網路請求。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./support/helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

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

test('resolveShare 的 onMessage 監聽器會在腳本載入時註冊', () => {
  const { listener } = loadBackground();
  assert.equal(typeof listener, 'function');
});

test('resolveShare 訊息屬於非同步處理，監聽器回傳 true 以保持通道開啟', () => {
  const { listener } = loadBackground();
  const keepAlive = listener({ type: 'resolveShare', url: SHARE_URL }, {}, () => {});
  assert.equal(keepAlive, true);
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

test('非 resolveShare 類型的訊息，監聽器回傳 false 且不呼叫 sendResponse', () => {
  const { listener } = loadBackground();
  let called = false;
  const keepAlive = listener({ type: 'somethingElse' }, {}, () => {
    called = true;
  });
  assert.equal(keepAlive, false);
  assert.equal(called, false);
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

for (const { url, reason } of SHARE_URL_MUST_MATCH_CASES) {
  test(`SHARE_URL_PATTERN 收緊規格(必須匹配):${url} —— ${reason}`, async () => {
    const { listener, calls } = loadBackgroundAlwaysSucceed();
    const response = await callListener(listener, { type: 'resolveShare', url });
    assert.equal(calls.includes(url), true, '應放行並呼叫 fetch 解析短碼');
    assert.equal(response.ok, true);
    assert.equal(response.cleanUrl, CLEAN_POST_URL);
  });
}

for (const { url, reason } of SHARE_URL_MUST_NOT_MATCH_CASES) {
  test(`SHARE_URL_PATTERN 收緊規格(不得匹配):${url} —— ${reason}`, async () => {
    const { listener, calls } = loadBackgroundAlwaysSucceed();
    const response = await callListener(listener, { type: 'resolveShare', url });
    assert.equal(response.ok, false);
    assert.equal(response.reason, 'invalid-url');
    assert.equal(calls.includes(url), false, '不應呼叫 fetch，須在比對階段就拒絕');
  });
}

// ============================================================
// v1.1 設定規格 S1、S2:右鍵選單路徑與通知的設定行為。
//   S1 右鍵選單複製功能不受 autoClean 影響，永遠可用。
//   S2 notifySuccess=false 時一切成功類通知不得觸發;失敗／錯誤類通知
//      不受任何設定影響，永遠觸發(含右鍵路徑)。
//
// 【時序紀律】chrome.storage.sync 的 get/set 一律延遲一個 tick 才結算
// (見 support/helpers.js)，不允許同 tick 直接 resolve 的假綠燈;
// 右鍵點擊流程本身是非同步的，測試以 settle() 等它跑完。
//
// 【防假綠燈】「失敗通知永遠觸發」「notifySuccess=true 時成功通知照發」這類
// 條目，在現況(完全沒有設定機制)下本來就會通過。因此這些測試一律搭配一個
// 可鑑別的斷言:同一個 service worker 內成功流程不得發通知，或斷言 SW 確實
// 讀過 chrome.storage.sync，避免「設定根本沒接上卻碰巧通過」。
// ============================================================

const SUCCESS_NOTIFICATION_ID = 'threads-clean-link-success';

function settle(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 載入 background.js，並以指定設定填入 chrome.storage.sync;同時側錄
// contextMenus.onClicked 監聽器、notifications.create 與 scripting.executeScript。
// opts.clipboardOk 可在測試中途翻轉，模擬「先失敗、後成功」的兩次點擊。
function loadBackgroundWithSettings(initialSettings, opts = {}) {
  const storage = createChromeStorage(initialSettings);
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

// ---- S1:右鍵選單複製功能不受 autoClean 影響 ----

test('S1:autoClean=false 時，右鍵選單仍照常解析短連結並寫入剪貼簿', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: false, notifySuccess: true });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1);
  assert.equal(bg.executeScriptCalls[0].args[0], CLEAN_POST_URL);
  // 防假綠燈:右鍵成功路徑必然要讀 notifySuccess，所以此處必定讀過設定;
  // 若 SW 根本沒接上 chrome.storage.sync，本測試不算通過。
  assert.ok(bg.storage.calls.get.length >= 1, 'service worker 應讀取 chrome.storage.sync 設定');
});

// ---- S2:成功類通知受 notifySuccess 控制 ----

test('S2:notifySuccess=false 時，右鍵成功複製不得觸發任何成功通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: false });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1);
  assert.deepEqual(bg.notifications, []);
});

test('S2:notifySuccess=true 時，右鍵成功複製照常觸發成功通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: true });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, SUCCESS_NOTIFICATION_ID);
  // 防假綠燈:同上，成功通知必須是「讀了設定後決定發出」。
  assert.ok(bg.storage.calls.get.length >= 1, 'service worker 應讀取 chrome.storage.sync 設定');
});

// ---- S2:失敗／錯誤類通知不受設定影響，永遠觸發 ----

test('S2:notifySuccess=false 時，無效分享短連結的錯誤通知照常觸發，成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: false });

  bg.click({ linkUrl: 'https://evil.com/whatever' }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-invalid');

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功通知在 notifySuccess=false 時不得發出');
});

test('S2:notifySuccess=false 時，網路解析失敗的錯誤通知照常觸發，成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: false });

  bg.click({ linkUrl: 'https://www.threads.com/share/NETWORKFAIL' }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-network-error');

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功通知在 notifySuccess=false 時不得發出');
});

test('S2:notifySuccess=false 時，轉址結果非貼文網址的錯誤通知照常觸發，成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: false });

  bg.click({ linkUrl: 'https://www.threads.com/share/NOTAPOST' }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-format-error');

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功通知在 notifySuccess=false 時不得發出');
});

test('S2:notifySuccess=false 時，剪貼簿寫入失敗的錯誤通知照常觸發，其後成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings(
    { autoClean: true, notifySuccess: false },
    { clipboardOk: false }
  );

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-clipboard-error');

  bg.state.clipboardOk = true;
  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功通知在 notifySuccess=false 時不得發出');
});

// ============================================================
// R1-2 通知涵蓋自動路徑(service worker 端):notifySuccess=true 時，
// 右鍵成功「與」自動淨化成功都要通知;notifySuccess=false 時一切成功
// 通知靜默。自動路徑的成功訊息由 bridge 經 chrome.runtime.sendMessage
// 送來，形狀為 { type: 'cleanedNotice', cleanUrl }。
//
// 【把關位置(規格未明定，本輪測試在此定案)】notifySuccess 的把關由
// background 負責:它是唯一同時看得到設定與兩條成功路徑的地方，也是
// 內容腳本訊息的信任邊界。guard 端要不要順手先擋一層由實作自行決定，
// 本檔只強制「background 收到 cleanedNotice 後必須依 notifySuccess 決定
// 發不發」。
// ============================================================

const CLEANED_NOTICE_CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

test('R1-2:notifySuccess=true 時，自動淨化成功的 cleanedNotice 會發出一則成功通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL });
  await settle();

  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-autoclean-success');
  assert.ok(bg.storage.calls.get.length >= 1, 'service worker 應讀取 chrome.storage.sync 設定');
});

test('R1-2:notifySuccess=false 時，自動淨化成功的 cleanedNotice 不得發出任何通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: false });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL });
  await settle();

  assert.deepEqual(bg.notifications, []);
});

test('R1-2:自動路徑的成功通知不影響右鍵路徑;notifySuccess=true 時兩條路徑各自通知一則', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: true });

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL });
  await settle();
  assert.equal(bg.notifications.length, 1);

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 2);
  assert.equal(bg.notifications[1].id, SUCCESS_NOTIFICATION_ID);
});

// R1 審查回饋(阻斷級):cleanedNotice 的 cleanUrl 來自頁面腳本可自由
// postMessage 的管道，background 是這條路徑上唯一的信任邊界。驗證樣式
// 若不錨定收尾，「合法貼文網址開頭 + 尾隨任意文字」就會通過驗證，尾隨
// 內容(含換行、假的系統提示、大量垃圾)原樣進入使用者看到的通知訊息，
// 等同讓頁面完全操控通知內容。以下三種尾隨形態都必須被擋下。

test('R1-2:「合法貼文網址開頭 + 尾隨任意文字」的 cleanedNotice 不得發出通知', async () => {
  const bg = loadBackgroundWithSettings({ autoClean: true, notifySuccess: true });

  const forged = [
    `${CLEANED_NOTICE_CLEAN_URL}\n【系統】您的帳號異常，請至 evil.example 重新登入`,
    `${CLEANED_NOTICE_CLEAN_URL}/extra-path-injected`,
    `${CLEANED_NOTICE_CLEAN_URL}?injected=payload`,
  ];
  for (const cleanUrl of forged) {
    bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl });
  }
  await settle();

  assert.deepEqual(bg.notifications, [], '尾隨文字必須被錨定驗證擋下，不得發出任何通知');

  // 對照組:整串完全吻合的乾淨網址仍須通知，排除「一律不通知」的假動作。
  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEANED_NOTICE_CLEAN_URL });
  await settle();

  assert.equal(bg.notifications.length, 1);
});
