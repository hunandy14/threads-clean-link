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
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
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
  };
}

// ---- S1:右鍵選單複製功能不受 autoClean 影響 ----

test('S1:autoClean=false 時，右鍵選單仍照常解析短連結並寫入剪貼簿', async () => {
  const bg = loadBackgroundWithSettings({
    autoClean: false,
    resolveShortcode: false,
    notifySuccess: true,
  });

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
  const bg = loadBackgroundWithSettings({
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
  });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.executeScriptCalls.length, 1);
  assert.deepEqual(bg.notifications, []);
});

test('S2:notifySuccess=true 時，右鍵成功複製照常觸發成功通知', async () => {
  const bg = loadBackgroundWithSettings({
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: true,
  });

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, SUCCESS_NOTIFICATION_ID);
  // 防假綠燈:同上，成功通知必須是「讀了設定後決定發出」。
  assert.ok(bg.storage.calls.get.length >= 1, 'service worker 應讀取 chrome.storage.sync 設定');
});

// ---- S2:失敗／錯誤類通知不受設定影響，永遠觸發 ----

test('S2:notifySuccess=false 時，無效分享短連結的錯誤通知照常觸發，成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings({
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
  });

  bg.click({ linkUrl: 'https://evil.com/whatever' }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-invalid');

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功通知在 notifySuccess=false 時不得發出');
});

test('S2:notifySuccess=false 時，網路解析失敗的錯誤通知照常觸發，成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings({
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
  });

  bg.click({ linkUrl: 'https://www.threads.com/share/NETWORKFAIL' }, { id: 7 });
  await settle();
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].id, 'threads-clean-link-network-error');

  bg.click({ linkUrl: SHARE_URL }, { id: 7 });
  await settle();

  assert.equal(bg.notifications.length, 1, '成功通知在 notifySuccess=false 時不得發出');
});

test('S2:notifySuccess=false 時，轉址結果非貼文網址的錯誤通知照常觸發，成功流程仍靜音', async () => {
  const bg = loadBackgroundWithSettings({
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
  });

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
    { autoClean: true, resolveShortcode: true, notifySuccess: false },
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
