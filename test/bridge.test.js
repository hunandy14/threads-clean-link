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
// tclPostIcon(選填):模擬 post-icon.js 掛在 window 上的 TCLPostIcon
// API，測試擷取補欄位與失敗 toast 觸發邏輯用；不傳就等同 post-icon.js
// 尚未載入/舊版沒有這個 API 的情境。
function loadBridge({ sendMessage, tclPostIcon }) {
  const win = createWindow();
  if (tclPostIcon) win.TCLPostIcon = tclPostIcon;
  const sentMessages = [];
  const chrome = {
    runtime: {
      // 孤兒自檢以 chrome.runtime.id 為判準:有 id 代表情境有效(正常
      // content script);孤兒測試把它設成 undefined。既有測試一律走有效情境。
      id: 'tcl-test-ext',
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

  return { win, chrome, sentMessages, dispatch };
}

test('成功路徑:轉發為一次 sendMessage(resolveShare)，cleanUrl 與 requestId 原樣傳回 MAIN world', async () => {
  const { sentMessages, dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: true, cleanUrl: 'https://www.threads.com/@x/post/y' }),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-unique-5',
    url: 'https://www.threads.com/share/ABC',
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, 'resolveShare');
  assert.equal(sentMessages[0].url, 'https://www.threads.com/share/ABC');
  assert.equal(result.ok, true);
  assert.equal(result.cleanUrl, 'https://www.threads.com/@x/post/y');
  assert.equal(result.requestId, 'req-unique-5', '回應須帶回同一個 requestId 供 MAIN world 配對');
});

test('失敗路徑:ok:false 原樣轉發 reason，未回應則標示 no-response', async () => {
  const cases = [
    { respond: (cb) => cb({ ok: false, reason: 'format-error' }), reason: 'format-error' },
    { respond: (cb) => cb(undefined), reason: 'no-response' },
  ];

  for (const { respond, reason } of cases) {
    const { dispatch } = loadBridge({
      sendMessage: (message, callback) => respond(callback),
    });

    const result = await dispatch({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-2',
      url: 'https://www.threads.com/share/BAD',
    });

    assert.equal(result.ok, false, `reason=${reason} 的情境須回報失敗`);
    assert.equal(result.reason, reason);
  }
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

// share/strip 解析在 Threads 頁面內失敗時，改用頁內 toast 提示。渲染邏輯
// 在 post-icon.js，bridge 只負責在偵測到失敗時、透過執行期守衛呼叫
// window.TCLPostIcon.showResolveFailureToast(reason)。

test('resolveShare 失敗(ok:false)時，若 TCLPostIcon 存在就呼叫 showResolveFailureToast(reason)', async () => {
  const calls = [];
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: false, reason: 'format-error' }),
    tclPostIcon: { showResolveFailureToast: (reason) => calls.push(reason) },
  });

  await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-toast-1',
    url: 'https://www.threads.com/share/BAD',
  });

  assert.deepEqual(calls, ['format-error']);
});

test('resolveShare 成功時，不呼叫 showResolveFailureToast', async () => {
  const calls = [];
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: true, cleanUrl: 'https://www.threads.com/@x/post/y' }),
    tclPostIcon: { showResolveFailureToast: (reason) => calls.push(reason) },
  });

  await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-toast-2',
    url: 'https://www.threads.com/share/OK',
  });

  assert.deepEqual(calls, []);
});

// lastError 屬「連線層」失敗(SW 剛好冷啟/訊息通道已關閉等)，不是「解析
// 層」真失敗——複製動作本身通常已經成功，只是這次沒能順道解析／記錄。
// lastError 的原始錯誤訊息字串不在 post-icon.js 已知的三個解析失敗原因白
// 名單內，若跳 toast 會落到 bgUnexpected(「未預期的錯誤」)這個嚇人但失真
// 的文案，因此改用 console.warn。
test('chrome.runtime.lastError 情境不觸發 showResolveFailureToast，改用 console.warn(連線層失敗，非解析層真失敗)', async () => {
  const calls = [];
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { dispatch } = loadBridge({
      sendMessage: (message, callback, runtime) => {
        runtime.lastError = { message: 'context invalidated' };
        callback(undefined);
      },
      tclPostIcon: { showResolveFailureToast: (reason) => calls.push(reason) },
    });

    await dispatch({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-toast-3',
      url: 'https://www.threads.com/share/X',
    });

    assert.deepEqual(calls, [], 'lastError 屬連線層失敗，不得跳頁內 toast');
    assert.ok(warnCalls.length >= 1, '應留 console.warn 供除錯');
  } finally {
    console.warn = originalWarn;
  }
});

// no-response(SW 沒有正常回應，response 缺失或形狀不對)與 lastError 同屬
// 連線層失敗，理由相同，一併不得跳 toast。
test('resolveShare 未收到有效回應(no-response)時不觸發 showResolveFailureToast，改用 console.warn', async () => {
  const calls = [];
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { dispatch } = loadBridge({
      sendMessage: (message, callback) => callback(undefined),
      tclPostIcon: { showResolveFailureToast: (reason) => calls.push(reason) },
    });

    await dispatch({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-toast-no-response',
      url: 'https://www.threads.com/share/X',
    });

    assert.deepEqual(calls, [], 'no-response 屬連線層失敗，不得跳頁內 toast');
    assert.ok(warnCalls.length >= 1, '應留 console.warn 供除錯');
  } finally {
    console.warn = originalWarn;
  }
});

// autoClean=false 時 clipboard-guard.js 仍會送出解析請求以便記錄，但這次
// 失敗不該用頁內 toast 嚇使用者(複製動作本身沒壞)，改成 console.warn 就
// 好。recordOnly 這個旗標由請求本身帶著。

test('recordOnly:true 時，resolveShare 失敗(ok:false)改用 console.warn，不呼叫 showResolveFailureToast', async () => {
  const toastCalls = [];
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { dispatch } = loadBridge({
      sendMessage: (message, callback) => callback({ ok: false, reason: 'network-error' }),
      tclPostIcon: { showResolveFailureToast: (reason) => toastCalls.push(reason) },
    });

    await dispatch({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-record-only-1',
      url: 'https://www.threads.com/share/BAD',
      recordOnly: true,
    });

    assert.deepEqual(toastCalls, [], 'recordOnly 情境不得跳頁內 toast');
    assert.ok(warnCalls.length >= 1, 'recordOnly 情境應留 console.warn 供除錯');
  } finally {
    console.warn = originalWarn;
  }
});

test('recordOnly:true 時，chrome.runtime.lastError 情境同樣改用 console.warn，不呼叫 showResolveFailureToast', async () => {
  const toastCalls = [];
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { dispatch } = loadBridge({
      sendMessage: (message, callback, runtime) => {
        runtime.lastError = { message: 'context invalidated' };
        callback(undefined);
      },
      tclPostIcon: { showResolveFailureToast: (reason) => toastCalls.push(reason) },
    });

    await dispatch({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-record-only-2',
      url: 'https://www.threads.com/share/X',
      recordOnly: true,
    });

    assert.deepEqual(toastCalls, []);
    assert.ok(warnCalls.length >= 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('recordOnly:false(或缺席)時，失敗仍照常呼叫 showResolveFailureToast，行為與修正前一致', async () => {
  const toastCalls = [];
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: false, reason: 'format-error' }),
    tclPostIcon: { showResolveFailureToast: (reason) => toastCalls.push(reason) },
  });

  await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-record-only-3',
    url: 'https://www.threads.com/share/BAD',
    recordOnly: false,
  });

  assert.deepEqual(toastCalls, ['format-error']);
});

test('resolveShare 失敗但 TCLPostIcon 不存在(舊版擴充功能／尚未載入)時，不丟例外，仍正常回應 MAIN world', async () => {
  const { dispatch } = loadBridge({
    sendMessage: (message, callback) => callback({ ok: false, reason: 'network-error' }),
  });

  const result = await dispatch({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-toast-4',
    url: 'https://www.threads.com/share/BAD',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network-error');
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
// 設定規格 S6(ISOLATED world 端):bridge 負責把 chrome.storage.sync 的設定
// 以訊息型別 TCL_SETTINGS_PUSH 下放到 MAIN world，並在
// chrome.storage.onChanged 觸發時再次推播。
//
// 【協定約定】推播訊息形狀:
//   { type: 'TCL_SETTINGS_PUSH', settings: { autoClean, saveHistory } }
// postCopyEnabled(貼文複製按鈕開關)只影響 ISOLATED world 的 post-icon.js
// 是否注入 icon，直接在該檔讀 chrome.storage.sync，不經過這條 MAIN world
// 專用的推播管道。saveHistory 也下放:guard 的 recordOnly 流程「先原生寫
// 入、事後 fire-and-forget 補發解析請求」，若 saveHistory 也關閉就直接省
// 掉整個解析請求，guard 需要這顆設定值才能判斷。
//
// 【時序紀律】storage mock 的 get 與 onChanged 一律延遲一個 tick 才結算
// (見 support/helpers.js)，postMessage 亦為 setTimeout(0) 排程，不允許同 tick
// 直接結算的假綠燈。
// ============================================================

const DEFAULT_SETTINGS = { autoClean: false, saveHistory: true };

// settle() 原本是本檔逐字維護的一份牆鐘等待邏輯，機器忙時固定 ms 等不到
// 非同步鏈路(storage get/onChanged、postMessage 皆經 setTimeout(0) 落盤)
// 跑完就斷言、閒時又白等，兩頭不討好;連同其餘五份逐字或近乎逐字相同的版
// 本收斂進 test/support/settle.js 一份共用實作(原理與各項取捨的完整說明
// 見該檔頭註解)。bridge.js 本身不含任何 setTimeout(靠 sandbox 注入的
// setTimeout 只轉給 storage mock 與 createWindow 的 postMessage 用)，不像
// background.js 有需要排除的長效逾時計時器，但共用實作已一併過濾延遲超過
// 上限的計時器，行為不受影響。
const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

// 載入 bridge.js 到一個同時具備 chrome.runtime 與 chrome.storage 的 sandbox，
// 並側錄它 postMessage 出去的 TCL_SETTINGS_PUSH。
function loadBridgeWithStorage(initialSettings = {}) {
  const win = createWindow();
  const storage = createChromeStorage(initialSettings);
  const sentMessages = [];
  const pushes = [];
  const chrome = {
    runtime: {
      id: 'tcl-test-ext',
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

// settings 形狀含 saveHistory，initialSettings 只給了 autoClean，saveHistory
// 查無此鍵時比照 chrome.storage 既定語意補上 SETTINGS_DEFAULTS 的預設值
// (true)。
test('S6:bridge 載入後讀取 chrome.storage.sync，並以 TCL_SETTINGS_PUSH 把設定下放至 MAIN world', async () => {
  const bridge = loadBridgeWithStorage({ autoClean: true });

  await settle();

  assert.equal(bridge.pushes.length, 1);
  assert.deepEqual(bridge.pushes[0].settings, { autoClean: true, saveHistory: true });
  assert.ok(bridge.storage.calls.get.length >= 1, 'bridge 應向 chrome.storage.sync 讀取設定');
});

test('S6:chrome.storage.sync 為空時，bridge 推播預設值(autoClean=false)', async () => {
  const bridge = loadBridgeWithStorage({});

  await settle();

  assert.equal(bridge.pushes.length, 1);
  assert.deepEqual(bridge.pushes[0].settings, DEFAULT_SETTINGS);
});

test('S6:chrome.storage.onChanged 觸發時，bridge 再次推播，內容為變更後的新值', async () => {
  const bridge = loadBridgeWithStorage({ autoClean: true });
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
});

// ============================================================
// 通知涵蓋自動路徑(ISOLATED world 端):bridge 把 MAIN world 送來的
// TCL_CLEANED_NOTICE 轉為 chrome.runtime.sendMessage 交給 service worker。
//
// 【協定約定】
//   MAIN world → bridge : { type: 'TCL_CLEANED_NOTICE', cleanUrl, kind, original?, removedParams? }
//   bridge → background : { type: 'cleanedNotice', cleanUrl, kind, original?, removedParams? }
// kind 為淨化來源('share' | 'strip'),bridge 只做型別與長度把關(≤16 字元
// 的非空字串)，白名單驗證由 background 負責;形狀不對整則丟棄。
// original/removedParams(紀錄資料層補齊，對齊手機 ShareHistoryItem)選填，
// bridge 純透傳、不做任何驗證，規則與下面的 author/handle/excerpt 透傳一
// 致，真正的 sanitize 交給 background。
//
// 【來源驗證】驗證不過的通知必須完全忽略、不得轉發，否則頁面腳本可以自行
// postMessage 偽造「淨化成功」灌出假通知。bridge 對既有的 TCL_RESOLVE_REQ
// 已同時驗 event.source 與 event.origin，新訊息型別沿用同一組檢查。
// ============================================================

const CLEANED_NOTICE_TYPE = 'TCL_CLEANED_NOTICE';
const CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

function loadBridgeForNotice(tclPostIcon) {
  return loadBridge({
    sendMessage: (message, callback) => {
      if (typeof callback === 'function') callback(undefined);
    },
    tclPostIcon,
  });
}

test('R1-2:合法來源的 TCL_CLEANED_NOTICE 轉發為一次 cleanedNotice 訊息給 service worker', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].cleanUrl, CLEAN_URL);
  assert.equal(notices[0].kind, 'share', 'kind 應原樣轉發給 service worker');
});

// 轉發 TCL_CLEANED_NOTICE 前，若 post-icon.js 已把 TCLPostIcon 掛上
// window，就用 findContainerByCleanUrl + extractPostInfo 就地補
// author/handle/excerpt 進 payload。

test('R1-2:TCLPostIcon 存在且找得到容器時，轉發前補上 author/handle/excerpt', async () => {
  const fakeContainer = { marker: 'fake-container' };
  const { win, sentMessages } = loadBridgeForNotice({
    findContainerByCleanUrl: (url) => (url === CLEAN_URL ? fakeContainer : null),
    extractPostInfo: (container) =>
      container === fakeContainer ? { author: 'Alice', handle: '@alice', excerpt: 'hi there' } : {},
  });

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].author, 'Alice');
  assert.equal(notices[0].handle, '@alice');
  assert.equal(notices[0].excerpt, 'hi there');
});

test('R1-2:找不到對應容器時，靜默省略欄位，仍照常轉發最小形狀', async () => {
  const { win, sentMessages } = loadBridgeForNotice({
    findContainerByCleanUrl: () => null,
    extractPostInfo: () => ({ author: '不該被呼叫到' }),
  });

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'strip' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].author, undefined);
  assert.equal(notices[0].handle, undefined);
  assert.equal(notices[0].excerpt, undefined);
});

// 紀錄資料層補齊 original/removedParams(對齊手機 ShareHistoryItem):bridge
// 純透傳 guard 已經算好的 original/removedParams，規則與上面的
// author/handle/excerpt 透傳一致——不做任何型別/長度驗證，真正的 sanitize
// 交給 background.js(信任邊界)。

test('F 案:MAIN world 送來的 original/removedParams 原樣透傳給 service worker', async () => {
  const { win, sentMessages } = loadBridgeForNotice();
  const removedParams = [{ key: 'xmt', value: 'AQGabc' }];

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    original: `${CLEAN_URL}?xmt=AQGabc`,
    removedParams,
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].original, `${CLEAN_URL}?xmt=AQGabc`);
  assert.equal(notices[0].removedParams, removedParams, '純透傳同一個陣列參照，不重建');
});

test('F 案:MAIN world 沒帶 original/removedParams 時，轉發的訊息也不含這兩個欄位', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].original, undefined);
  assert.equal(notices[0].removedParams, undefined);
});

// original 比照既有的 MAX_CLEAN_URL_LENGTH 做型別+長度檢查、removedParams
// 檢查 Array.isArray + 筆數上限，超限就整欄丟棄，不讓垃圾 payload 越過
// content script → service worker 的程序邊界。

test('code review #1:original 超過 MAX_CLEAN_URL_LENGTH(2048)或型別不是字串時整欄丟棄，不轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    original: 'https://x.example/' + 'a'.repeat(2048),
  });
  await settle();
  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices[0].original, undefined, '超長 original 應整欄丟棄');

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'strip', original: 12345 });
  await settle();
  const notices2 = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices2.length, 2);
  assert.equal(notices2[1].original, undefined, '非字串 original 應整欄丟棄');
});

test('code review #1:removedParams 型別不是陣列時整欄丟棄，不轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    removedParams: 'not-an-array',
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].removedParams, undefined);
});

test('code review #1:removedParams 陣列筆數超過上限(20)時整欄丟棄，不逐筆截斷', async () => {
  const { win, sentMessages } = loadBridgeForNotice();
  const oversized = Array.from({ length: 21 }, (_, i) => ({ key: `p${i}`, value: `v${i}` }));

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    removedParams: oversized,
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].removedParams, undefined, '超過上限應整欄丟棄，不是截斷成 20 筆');
});

test('code review #1:removedParams 陣列筆數恰為上限(20)時仍照樣透傳(邊界不誤殺)', async () => {
  const { win, sentMessages } = loadBridgeForNotice();
  const atLimit = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, value: `v${i}` }));

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    removedParams: atLimit,
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].removedParams, atLimit, '恰為上限(20)不誤殺，仍原樣透傳同一個陣列參照');
});

test('R1-2:TCLPostIcon 不存在(post-icon.js 尚未載入或舊版)時，照常轉發最小形狀，不丟例外', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].author, undefined);
  assert.equal(notices[0].handle, undefined);
  assert.equal(notices[0].excerpt, undefined);
});

test('R1-2:findContainerByCleanUrl／extractPostInfo 本身丟例外時，靜默省略欄位，仍照常轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice({
    findContainerByCleanUrl: () => {
      throw new Error('boom');
    },
  });

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].author, undefined);
});

test('R1-2:event.source 非本視窗的 TCL_CLEANED_NOTICE 完全忽略，不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();
  const fakeOtherWindow = {};

  win.dispatchRawMessageEvent({
    source: fakeOtherWindow,
    origin: win.location.origin,
    data: { type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' },
  });
  await settle();
  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 0);

  // 對照組:同樣內容改由合法管道送出必須轉發，排除「一律不轉發」的假動作。
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 1);
});

test('R1-2:event.origin 與本頁不符的 TCL_CLEANED_NOTICE 完全忽略，不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.dispatchRawMessageEvent({
    source: win,
    origin: 'https://evil.example',
    data: { type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' },
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

// cleanUrl 只驗「非空字串」不足以擋住頁面偽造——頁面腳本可送一筆「合法貼
// 文網址開頭 + 尾隨任意文字」的通知，內容最終會被塞進使用者看到的通知訊
// 息。整串形狀驗證的信任邊界在 background(見 background.test.js 同區塊)，
// bridge 這一層負責先擋掉超長 payload，不讓 100KB 垃圾越過程序邊界。

test('R1-2:合法貼文網址開頭 + 尾隨超長垃圾的 TCL_CLEANED_NOTICE 不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  const oversized = `${CLEAN_URL}\n${'A'.repeat(100 * 1024)}`;
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: oversized, kind: 'share' });
  await settle();

  assert.equal(
    sentMessages.filter((m) => m && m.type === 'cleanedNotice').length,
    0,
    '超長 cleanUrl 必須在 bridge 就被丟棄，不得轉發給 service worker'
  );

  // 對照組:長度正常的合法網址仍須轉發，排除「一律不轉發」的假動作。
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(sentMessages.filter((m) => m && m.type === 'cleanedNotice').length, 1);
});

test('R1-2:kind 缺失、非字串或超長的 TCL_CLEANED_NOTICE 不得轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL });
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 42 });
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: '' });
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'x'.repeat(17) });
  await settle();

  assert.equal(
    sentMessages.filter((m) => m && m.type === 'cleanedNotice').length,
    0,
    'kind 形狀不對必須整則丟棄'
  );

  // 對照組:合法 kind 照常轉發且值原樣保留。
  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'strip' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'strip');
});

// ============================================================
// 孤兒 bridge 退場:擴充功能更新／重載後，既開分頁裡的舊 bridge.js 仍在跑
// 但 chrome.runtime 已斷。修法比照 post-icon 的 retireOrphanInstance:
//   (a) listener 開頭以 chrome.runtime.id 自檢，孤兒時直接 return——不轉
//       發、不 reply、不 handleFailure，把場子讓給重注入的新實例(否則孤兒
//       仍 reply({ok:false,reason:'bridge-exception'}) 搶答，會毒化自癒後
//       的 share 解析);
//   (b) disposed 旗標:第一次偵測到孤兒(自檢通過，或 sendMessage 擲 context
//       invalidated)後永久短路並 removeEventListener 自我下線;
//   (c) 「請重新整理頁面」warn 降級(重注入已接手時是誤導)。
// ============================================================

function loadBridgeWithConsole(sendMessageImpl, opts = {}) {
  const win = createWindow();
  const warnings = [];
  const chrome = {
    runtime: {
      // 預設帶有效 id(情境有效);孤兒-競態測試用 opts.runtimeId 覆寫。
      id: 'runtimeId' in opts ? opts.runtimeId : 'tcl-test-ext',
      lastError: undefined,
      sendMessage: sendMessageImpl,
    },
  };
  runInSandbox(SRC, {
    window: win,
    chrome,
    setTimeout,
    console: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: () => {},
      log: () => {},
    },
  });
  return { win, chrome, warnings };
}

test('R3 孤兒(runtime.id 已消失):listener 收到訊息一律短路——不轉發、不回應、自我下線並留降級 warn', async () => {
  let sendCount = 0;
  // id 尚在時載入(正常註冊 listener)，載入後把 id 抹成 undefined 模擬孤兒化。
  const bridge = loadBridge({
    sendMessage: () => {
      sendCount += 1;
    },
  });
  bridge.chrome.runtime.id = undefined;

  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args.map(String).join(' '));
  try {
    // 兩種訊息都送:cleanedNotice(轉發路徑)與 resolveShare(解析路徑)。
    bridge.win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
    bridge.win.postMessage({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-orphan-id',
      url: 'https://www.threads.com/share/ABC',
    });
    await settle();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sendCount, 0, '孤兒不得再向 background 轉發任何訊息');
  assert.equal(bridge.win.getMessageListenerCount(), 0, '孤兒自檢後必須 removeEventListener 自我下線');
  assert.ok(
    warnCalls.some((line) => line.includes('[threads-clean-link]') && !line.includes('請重新整理頁面')),
    '孤兒退場要留降級 console.warn(不再硬叫「請重新整理頁面」)'
  );
});

test('R3 孤兒(runtime.id 尚在但 sendMessage 同步丟 context invalidated 的競態):resolveShare 不搶答 bridge-exception，自我下線並留 warn', async () => {
  const throwOrphan = () => {
    throw new Error('Extension context invalidated.');
  };
  const bridge = loadBridgeWithConsole(throwOrphan);

  // listener 數量基線:bridge 自己註冊了 1 個(onBridgeMessage)。加上本測試
  // 這個偵測回覆的 listener 後應為 2;孤兒自我下線後 bridge 那個被移除，只
  // 剩本測試這個，回到基線 1。
  const baseCount = bridge.win.getMessageListenerCount();
  let replied = false;
  bridge.win.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'TCL_RESOLVE_RES') replied = true;
  });
  bridge.win.postMessage({
    type: 'TCL_RESOLVE_REQ',
    requestId: 'req-orphan-race',
    url: 'https://www.threads.com/share/ABC',
  });
  await settle();

  assert.equal(replied, false, '孤兒競態不得 reply bridge-exception 搶答(會毒化自癒後的解析)');
  assert.equal(
    bridge.win.getMessageListenerCount(),
    baseCount,
    'sendMessage 擲 context invalidated 後 bridge 應自我下線(只剩本測試的偵測 listener)'
  );
  assert.ok(
    bridge.warnings.some((line) => line.includes('resolveShare') && !line.includes('請重新整理頁面')),
    'resolveShare 孤兒競態要留降級 warn'
  );
});

test('R3 孤兒:cleanedNotice 轉發時 sendMessage 丟 context invalidated 同樣自我下線、留 warn', async () => {
  const throwOrphan = () => {
    throw new Error('Extension context invalidated.');
  };
  const bridge = loadBridgeWithConsole(throwOrphan);

  bridge.win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  assert.equal(bridge.win.getMessageListenerCount(), 0, 'cleanedNotice 孤兒競態後應自我下線');
  assert.ok(
    bridge.warnings.some((line) => line.includes('cleanedNotice') && !line.includes('請重新整理頁面')),
    'cleanedNotice 孤兒轉發要留降級 warn'
  );
});

// ============================================================
// 冪等交棒:同一 ISOLATED world 若雙注入(手動 F5 × 自癒重注入的毫秒級競
// 態，或更新後的重注入)，第二個實例先讓第一個交棒下線再接手，消除「雙
// listener → 雙轉發 cleanedNotice → 時間軸假事件」。刻意用交棒式(dispose
// 舊的、註冊新的)而非永久旗標 return:後者會讓更新後的重注入因旗標仍在而
// 不註冊、舊孤兒又已自檢下線，share 解析就此無人接手。
// ============================================================

test('冪等交棒:同一 window 二次載入 bridge，舊實例交棒下線，只剩一個 listener 處理訊息(不雙轉發)', async () => {
  const win = createWindow();
  const sentMessages = [];
  const chrome = {
    runtime: {
      id: 'tcl-test-ext',
      lastError: undefined,
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (typeof callback === 'function') callback(undefined);
      },
    },
  };
  const sandbox = { window: win, chrome, setTimeout, console };
  runInSandbox(SRC, sandbox); // 實例 A
  runInSandbox(SRC, sandbox); // 實例 B:載入時透過 __tclBridgeDispose 讓 A 下線

  assert.equal(win.getMessageListenerCount(), 1, '交棒後同頁只應留一個 message listener');

  win.postMessage({ type: CLEANED_NOTICE_TYPE, cleanUrl: CLEAN_URL, kind: 'share' });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1, '一次淨化通知只應轉發一次(非雙 listener 雙轉發)');
});

// ============================================================
// bridge 單筆封頂:removedParams 除筆數 ≤20 外，每筆 key/value 再加長度上限
// (對齊 background 的 64/512)，擋住「筆數不多但單筆超長」的巨量 payload
// 越過程序邊界。
// ============================================================

test('F4:removedParams 任一筆 key 超過 64 字元時整欄丟棄，不轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    removedParams: [{ key: 'x'.repeat(65), value: 'v' }],
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].removedParams, undefined, '單筆 key 超長應讓整欄不轉發');
});

test('F4:removedParams 任一筆 value 超過 512 字元時整欄丟棄，不轉發', async () => {
  const { win, sentMessages } = loadBridgeForNotice();

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    removedParams: [{ key: 'utm_source', value: 'v'.repeat(513) }],
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices[0].removedParams, undefined, '單筆 value 超長應讓整欄不轉發');
});

test('F4:removedParams 單筆 key/value 恰在上限(64/512)時仍照常透傳(邊界不誤殺)', async () => {
  const { win, sentMessages } = loadBridgeForNotice();
  const atLimit = [{ key: 'k'.repeat(64), value: 'v'.repeat(512) }];

  win.postMessage({
    type: CLEANED_NOTICE_TYPE,
    cleanUrl: CLEAN_URL,
    kind: 'strip',
    removedParams: atLimit,
  });
  await settle();

  const notices = sentMessages.filter((m) => m && m.type === 'cleanedNotice');
  assert.equal(notices[0].removedParams, atLimit, '恰在上限內不誤殺，原樣透傳同一個陣列參照');
});
