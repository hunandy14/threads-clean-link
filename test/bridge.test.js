// test/bridge.test.js — bridge.js(ISOLATED world 訊息橋接)的行為契約。
// chrome.runtime.sendMessage 全程 mock,不呼叫真實的 service worker。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWindow, runInSandbox } = require('./support/helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');

// 載入 bridge.js 到一個帶假 chrome.runtime 的 sandbox,回傳
// { win, sentMessages, dispatch },讓測試可以送出 TCL_RESOLVE_REQ
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

test('合法短碼解析請求,轉發為一次 chrome.runtime.sendMessage(resolveShare)', async () => {
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

test('service worker 解析成功時,cleanUrl 原樣經 postMessage 傳回 MAIN world', async () => {
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

test('service worker 回應 ok:false 時,原樣轉發失敗結果與 reason', async () => {
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

test('service worker 未回應(response 為 undefined)時,reason 標示為 no-response', async () => {
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

test('chrome.runtime.lastError 視為解析失敗,不視為致命錯誤', async () => {
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

test('回應一律帶回與請求相同的 requestId,供 MAIN world 端配對', async () => {
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

test('event.source 不是本視窗時,忽略訊息且不轉發 chrome.runtime.sendMessage', async () => {
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
