// test/bridge.test.js — bridge.js(ISOLATED world 訊息橋接)的行為契約。
// chrome.runtime.sendMessage 全程 mock，不呼叫真實的 service worker。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWindow, runInSandbox, createChromeStorage } = require('./support/helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');

// 載入 bridge.js 到一個帶假 chrome.runtime 的 sandbox，回傳
// { win, sentMessages, dispatch }，讓測試可以送出 TCL_RESOLVE_REQ
// 並攔截它經 postMessage 送回的 TCL_RESOLVE_RES。
function loadBridge({ sendMessage }) {
  const win = createWindow();
  const sentMessages = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        sentMessages.push(message);
        sendMessage(message, callback, chrome.runtime);
      },
    },
  };
  runInSandbox(SRC, { window: win, chrome, setTimeout, console });

  function dispatch(request) {
    return new Promise((resolve) => {
      win.addEventListener('message', function onMessage(event) {
        if (event.data && event.data.type === 'TCL_RESOLVE_RES') {
          resolve(event.data);
        }
      });
      win.postMessage(request);
    });
  }

  return { win, sentMessages, dispatch };
}

test('合法短碼解析請求，轉發為一次 chrome.runtime.sendMessage(resolveShare)', async () => {
  const { sentMessages, dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: true, cleanUrl: 'https://www.threads.com/@x/post/y' }),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-1',
    url: 'https://www.threads.com/share/ABC',
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, 'resolveShare');
  assert.equal(sentMessages[0].url, 'https://www.threads.com/share/ABC');
  assert.equal(result.requestId, 'req-1');
});

test('service worker 解析成功時，cleanUrl 原樣經 postMessage 傳回 MAIN world', async () => {
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: true, cleanUrl: 'https://www.threads.com/@x/post/y' }),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-1',
    url: 'https://www.threads.com/share/ABC',
  });

  assert.equal(result.ok, true);
  assert.equal(result.cleanUrl, 'https://www.threads.com/@x/post/y');
});

test('service worker 回應 ok:false 時，原樣轉發失敗結果與 reason', async () => {
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: false, reason: 'format-error' }),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-2',
    url: 'https://www.threads.com/share/BAD',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'format-error');
});

test('service worker 未回應(response 為 undefined)時，reason 標示為 no-response', async () => {
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback(undefined),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-3',
    url: 'https://www.threads.com/share/X',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-response');
});

test('chrome.runtime.lastError 視為解析失敗，不視為致命錯誤', async () => {
  const { dispatch } = loadBridge({
    sendMessage: (message, callback, runtime) => {
      runtime.lastError = { message: 'context invalidated' };
      callback(undefined);
    },
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-4',
    url: 'https://www.threads.com/share/X',
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

test('回應一律帶回與請求相同的 requestId，供 MAIN world 端配對', async () => {
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: true, cleanUrl: 'https://www.threads.com/@x/post/y' }),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-unique-5',
    url: 'https://www.threads.com/share/X',
  });

  assert.equal(result.requestId, 'req-unique-5');
});

test('event.source 不是本視窗時，忽略訊息且不轉發 chrome.runtime.sendMessage', async () => {
  const { win, sentMessages } = loadBridge({
    sendMessage: () => {},
  });
  const fakeOtherWindow = {};

  win.dispatchRawMessageEvent({
    source: fakeOtherWindow,
    origin: win.location.origin,
    data: { type: 'TCL_RESOLVE_REQ', requestId: 'req-6', url: 'https://www.threads.com/share/X' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sentMessages.length, 0);
});

// ============================================================
// v1.1 設定規格 S6(ISOLATED world 端):bridge 負責把 chrome.storage.sync
// 的設定以新訊息型別 TCL_SETTINGS_PUSH 下放到 MAIN world，並在
// chrome.storage.onChanged 觸發時再次推播。
//
// 【協定約定】推播訊息形狀:
//   { type: 'TCL_SETTINGS_PUSH', settings: { autoClean, notifySuccess } }
//
// 【R1-1 開關合併】設定鍵砍為兩顆，resolveShortcode 徹底移除。
//
// 【時序紀律】storage mock 的 get 與 onChanged 一律延遲一個 tick 才結算
// (見 support/helpers.js)，postMessage 亦為 setTimeout(0) 排程，不允許同 tick
// 直接結算的假綠燈。
// ============================================================

const DEFAULT_SETTINGS = { autoClean: true, notifySuccess: false };

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 載入 bridge.js 到一個同時具備 chrome.runtime 與 chrome.storage 的 sandbox，
// 並側錄它 postMessage 出去的 TCL_SETTINGS_PUSH。
function loadBridgeWithStorage(initialSettings = {}) {
  const win = createWindow();
  const storage = createChromeStorage(initialSettings);
  const sentMessages = [];
  const pushes = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (typeof callback === 'function') setTimeout(() => callback(undefined), 0);
      },
    },
    storage: storage.api,
  };

  win.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'TCL_SETTINGS_PUSH') pushes.push(data);
  });

  runInSandbox(SRC, { window: win, chrome, setTimeout, clearTimeout, console });

  return { win, storage, pushes, sentMessages };
}

test('S6:bridge 載入後讀取 chrome.storage.sync，並以 TCL_SETTINGS_PUSH 把設定下放至 MAIN world', async () => {
  const bridge = loadBridgeWithStorage({ autoClean: false, notifySuccess: true });

  await settle();

  assert.equal(bridge.pushes.length, 1);
  assert.deepEqual(bridge.pushes[0].settings, { autoClean: false, notifySuccess: true });
  assert.ok(bridge.storage.calls.get.length >= 1, 'bridge 應向 chrome.storage.sync 讀取設定');
});

test('S6:chrome.storage.sync 為空時，bridge 推播兩個預設值', async () => {
  const bridge = loadBridgeWithStorage({});

  await settle();

  assert.equal(bridge.pushes.length, 1);
  assert.deepEqual(bridge.pushes[0].settings, DEFAULT_SETTINGS);
});

test('S6:chrome.storage.onChanged 觸發時，bridge 再次推播，內容為變更後的新值', async () => {
  const bridge = loadBridgeWithStorage({ autoClean: true, notifySuccess: false });
  await settle();
  const pushCountBeforeChange = bridge.pushes.length;
  assert.ok(
    bridge.storage.onChangedListenerCount() >= 1,
    'bridge 應註冊 chrome.storage.onChanged 監聽器'
  );

  bridge.storage.emitChange({ autoClean: { oldValue: true, newValue: false } }, 'sync');
  await settle();

  assert.equal(bridge.pushes.length, pushCountBeforeChange + 1);
  const latest = bridge.pushes[bridge.pushes.length - 1];
  assert.equal(latest.settings.autoClean, false);
  assert.equal(latest.settings.notifySuccess, false);
});

// ============================================================
// R1-2 通知涵蓋自動路徑(ISOLATED world 端):bridge 把 MAIN world 送來的
// TCL_CLEANED_NOTICE 轉為 chrome.runtime.sendMessage 交給 service worker。
//
// 【協定約定】
//   MAIN world → bridge : { type: 'TCL_CLEANED_NOTICE', cleanUrl }
//   bridge → background : { type: 'cleanedNotice', cleanUrl }
//
// 【來源驗證(規格明文，比照 S8 等級)】驗證不過的通知必須完全忽略、不得
// 轉發，否則頁面腳本可以自行 postMessage 偽造「淨化成功」灌出假通知。
// bridge 對既有的 TCL_RESOLVE_REQ 已同時驗 event.source 與 event.origin，
// 新訊息型別沿用同一組檢查。
// ============================================================

const CLEANED_NOTICE_TYPE = 'TCL_CLEANED_NOTICE';
const CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

function loadBridgeForNotice() {
  return loadBridge({
    sendMessage: (message, callback) => {
      if (typeof callback === 'function') callback(undefined);
    },
  });
}

test('R1-2:合法來源的 TCL_CLEANED_NOTICE 轉發為一次 cleanedNotice 訊息給 service worker', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].cleanUrl, CLEAN_URL);
});

test('R1-2:event.source 非本視窗的 TCL_CLEANED_NOTICE 完全忽略，不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();
  const fakeOtherWindow = {};

  win.dispatchRawMessageEvent({
    source: fakeOtherWindow,
    origin: win.location.origin,
    data: { type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL },
  });
  await settle();
  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 0);

  // 對照組:同樣內容改由合法管道送出必須轉發，排除「一律不轉發」的假動作。
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL });
  await settle();

  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 1);
});

test('R1-2:event.origin 與本頁不符的 TCL_CLEANED_NOTICE 完全忽略，不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.dispatchRawMessageEvent({
    source: win,
    origin: 'https://evil.example',
    data: { type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL },
  });
  await settle();

  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 0);
});

test('R1-2:cleanUrl 缺失或非字串的 TCL_CLEANED_NOTICE 不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({ type: CLEANED_NOTICE_TYPE });
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: 12345 });
  await settle();

  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 0);
});
