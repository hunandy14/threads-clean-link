// test/clipboard-guard.test.js — clipboard-guard.js(MAIN world 剪貼簿
// 攔截淨化)的行為契約。全程用 vm sandbox 離線模擬 navigator.clipboard 與
// window.postMessage 橋接，不發真實網路請求、不碰真實剪貼簿。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Blob } = require('node:buffer');
const { FakeClipboardItem, createWindow, runInSandbox } = require('./support/helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'clipboard-guard.js'), 'utf8');
const CLEAN_POST_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

// 依情境模擬 bridge.js + background.js 對 TCL_RESOLVE_REQ 的回應:
// success 回傳 cleanUrl、failure 回傳 ok:false、timeout 永不回應(讓
// clipboard-guard.js 自己的 2500ms 逾時機制接手)、late 在逾時之後才
// 送達一個原本會成功的回應(驗證競態:不能觸發第二次原生寫入)。
function installBridgeSim(win, scenario, opts = {}) {
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'TCL_RESOLVE_REQ') return;
    if (scenario === 'timeout') return;
    const defaultDelay = scenario === 'late' ? 2600 : 5;
    setTimeout(() => {
      if (scenario === 'success' || scenario === 'late') {
        win.postMessage({
          type: 'TCL_RESOLVE_RES',
          requestId: data.requestId,
          ok: true,
          cleanUrl: opts.cleanUrl ?? CLEAN_POST_URL,
        });
      } else if (scenario === 'failure') {
        win.postMessage({
          type: 'TCL_RESOLVE_RES',
          requestId: data.requestId,
          ok: false,
          reason: 'network-error',
        });
      }
    }, opts.delay ?? defaultDelay);
  });
}

function loadGuard(clipboard, win) {
  win.ClipboardItem = FakeClipboardItem;
  return runInSandbox(SRC, {
    navigator: { clipboard },
    window: win,
    Blob,
    setTimeout,
    clearTimeout,
    console,
  });
}

function recordingWriteText(recorder) {
  return {
    async writeText(data) {
      recorder.push(data);
    },
  };
}

function rejectingWriteText(rejectError, callCounter) {
  return {
    async writeText() {
      callCounter.count++;
      throw rejectError;
    },
  };
}

function recordingWrite(recorder) {
  return {
    async write(items) {
      const out = [];
      for (const item of items) {
        const entry = { types: item.types };
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          entry.text = await blob.text();
        }
        out.push(entry);
      }
      recorder.push(out);
    },
  };
}

function rejectingWrite(rejectError, callCounter) {
  return {
    async write() {
      callCounter.count++;
      throw rejectError;
    },
  };
}

// 記錄原生 write() 收到的「原始參數陣列」本身(參照，不轉換內容)，
// 用來斷言「原樣放行」時傳給原生函式的就是同一個陣列物件，不是重建的複本。
function recordingWriteRaw(recorder) {
  return {
    async write(items) {
      recorder.push(items);
    },
  };
}

// ---- 短碼分支:writeText ----

test('短碼(帶尾斜線)經橋接成功解析後，寫入乾淨貼文網址', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('https://www.threads.com/share/DHuf91XTf/');

  assert.equal(recorder[0], CLEAN_POST_URL);
});

test('短碼橋接回應失敗時，原樣寫入原始短碼(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'failure');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(shareUrl);

  assert.equal(recorder[0], shareUrl);
});

test('短碼橋接逾時(2500ms)後，原樣寫入原始短碼(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'timeout');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/ABCDEF';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `應等滿 2500ms 才 fail-open，實際 ${elapsed}ms`);
});

test('threads.net 短碼(無 www)經橋接成功解析後，寫入乾淨貼文網址', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('https://threads.net/share/xyz123');

  assert.equal(recorder[0], CLEAN_POST_URL);
});

test('短碼前後帶空白且附 query 時，trim 後仍判定為短碼並解析成功', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('  https://www.threads.com/share/DHuf91XTf?foo=bar  ');

  assert.equal(recorder[0], CLEAN_POST_URL);
});

// ---- 短碼分支:write() ----

test('write() 寫入單一 text/plain 短碼，經橋接成功解析後寫入乾淨貼文網址', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWrite(recorder), win);
  const item = new FakeClipboardItem({
    'text/plain': new Blob(['https://www.threads.com/share/DHuf91XTf/'], { type: 'text/plain' }),
  });

  await sandbox.navigator.clipboard.write([item]);

  assert.equal(recorder[0][0].text, CLEAN_POST_URL);
});

test('write() 短碼橋接回應失敗時，原樣放行原始內容(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'failure');
  const sandbox = loadGuard(recordingWrite(recorder), win);
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';
  const item = new FakeClipboardItem({
    'text/plain': new Blob([shareUrl], { type: 'text/plain' }),
  });

  await sandbox.navigator.clipboard.write([item]);

  assert.equal(recorder[0][0].text, shareUrl);
});

// ---- 既有 ?xmt 淨化邏輯(短碼分支之外的既有行為，須與短碼分支共存不受影響) ----

test('帶 ?xmt 追蹤參數的貼文網址，同步去除 query 後放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText(
    'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7?xmt=AQG0abc'
  );

  assert.equal(recorder[0], 'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7');
});

test('已乾淨的貼文網址原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const url = 'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7';

  await sandbox.navigator.clipboard.writeText(url);

  assert.equal(recorder[0], url);
});

test('非網址字串原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('hello world, not a url');

  assert.equal(recorder[0], 'hello world, not a url');
});

test('非字串輸入原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText(12345);

  assert.equal(recorder[0], 12345);
});

test('貼文網址後接空白與其他文字時，不誤判為單一網址、原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const text = 'https://www.threads.com/@abc/post/123?xmt=1 and here is my comment';

  await sandbox.navigator.clipboard.writeText(text);

  assert.equal(recorder[0], text);
});

test('非 threads 網域的 /share/ 路徑不觸發短碼解析，原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const url = 'https://evil.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(url);

  assert.equal(recorder[0], url);
});

test('write() 多格式(text/plain + text/html)item 原樣放行，不嘗試改寫', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWrite(recorder), win);
  const plainUrl = 'https://www.threads.com/@abc/post/123?xmt=ZZZ';
  const item = new FakeClipboardItem({
    'text/plain': new Blob([plainUrl], { type: 'text/plain' }),
    'text/html': new Blob(['<a href="...">link</a>'], { type: 'text/html' }),
  });

  await sandbox.navigator.clipboard.write([item]);

  assert.equal(recorder[0][0].text, plainUrl);
});

// ---- 原生寫入被拒時:只呼叫一次，rejection 原樣傳回呼叫端 ----

test('writeText 短碼路徑:原生寫入被拒時只呼叫一次，rejection 原樣傳回', async () => {
  const rejectError = new Error('NotAllowedError: native writeText rejected');
  const callCounter = { count: 0 };
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(rejectingWriteText(rejectError, callCounter), win);

  await assert.rejects(
    () => sandbox.navigator.clipboard.writeText('https://www.threads.com/share/DHuf91XTf/'),
    (err) => err === rejectError
  );
  assert.equal(callCounter.count, 1);
});

test('write() 短碼路徑:原生寫入被拒時只呼叫一次，rejection 原樣傳回', async () => {
  const rejectError = new Error('NotAllowedError: native write rejected');
  const callCounter = { count: 0 };
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(rejectingWrite(rejectError, callCounter), win);
  const item = new FakeClipboardItem({
    'text/plain': new Blob(['https://www.threads.com/share/DHuf91XTf/'], { type: 'text/plain' }),
  });

  await assert.rejects(
    () => sandbox.navigator.clipboard.write([item]),
    (err) => err === rejectError
  );
  assert.equal(callCounter.count, 1);
});

test('write() ?xmt 路徑:原生寫入被拒時只呼叫一次，rejection 原樣傳回', async () => {
  const rejectError = new Error('NotAllowedError: native write rejected');
  const callCounter = { count: 0 };
  const win = createWindow();
  const sandbox = loadGuard(rejectingWrite(rejectError, callCounter), win);
  const item = new FakeClipboardItem({
    'text/plain': new Blob(['https://www.threads.com/@abc/post/123?xmt=ZZZ'], { type: 'text/plain' }),
  });

  await assert.rejects(
    () => sandbox.navigator.clipboard.write([item]),
    (err) => err === rejectError
  );
  assert.equal(callCounter.count, 1);
});

test('writeText ?xmt 路徑:原生寫入被拒時只呼叫一次，rejection 原樣傳回', async () => {
  const rejectError = new Error('NotAllowedError: native writeText rejected');
  const callCounter = { count: 0 };
  const win = createWindow();
  const sandbox = loadGuard(rejectingWriteText(rejectError, callCounter), win);

  await assert.rejects(
    () => sandbox.navigator.clipboard.writeText('https://www.threads.com/@abc/post/123?xmt=ZZZ'),
    (err) => err === rejectError
  );
  assert.equal(callCounter.count, 1);
});

// ---- 縱深防禦:cleanUrl 需通過貼文網址格式驗證才信任 ----

test('橋接回傳非貼文格式的 cleanUrl 時，視同解析失敗、寫回原始短碼', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success', { cleanUrl: 'https://evil.com/not-a-post-url' });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(shareUrl);

  assert.equal(recorder[0], shareUrl);
});

test('write() 橋接回傳非貼文格式的 cleanUrl 時，視同解析失敗、維持原始短碼', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success', { cleanUrl: 'not even a url' });
  const sandbox = loadGuard(recordingWrite(recorder), win);
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';
  const item = new FakeClipboardItem({
    'text/plain': new Blob([shareUrl], { type: 'text/plain' }),
  });

  await sandbox.navigator.clipboard.write([item]);

  assert.equal(recorder[0][0].text, shareUrl);
});

// ---- 競態:逾時後才送達的回應，不得觸發第二次原生寫入 ----

test('短碼橋接逾時後才送達的遲到回應(late):原生寫入僅呼叫一次(fail-open 原值)，遲到回應不再觸發第二次寫入', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'late');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/LATE0001';

  await sandbox.navigator.clipboard.writeText(shareUrl);
  assert.equal(recorder.length, 1);
  assert.equal(recorder[0], shareUrl);

  // 遲到回應(2600ms 後送達)此時應該已經抵達;確認沒有觸發第二次原生寫入。
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(recorder.length, 1);
});

// ---- guard 端訊息驗證:requestId 與 event.source 都必須符合才採信 ----

test('guard 端:requestId 不符的回應會被忽略，落入逾時 fail-open', async () => {
  const recorder = [];
  const win = createWindow();
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'TCL_RESOLVE_REQ') return;
    setTimeout(() => {
      win.postMessage({
        type: 'TCL_RESOLVE_RES',
        requestId: 'requestId-does-not-match',
        ok: true,
        cleanUrl: CLEAN_POST_URL,
      });
    }, 5);
  });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/MISMATCH1';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder.length, 1);
  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `requestId 不符應被忽略、落入逾時路徑，實際 ${elapsed}ms`);
});

test('guard 端:event.source 非本視窗的回應不被採信，落入逾時 fail-open', async () => {
  const recorder = [];
  const win = createWindow();
  const fakeOtherWindow = {};
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'TCL_RESOLVE_REQ') return;
    setTimeout(() => {
      win.dispatchRawMessageEvent({
        source: fakeOtherWindow,
        origin: win.location.origin,
        data: {
          type: 'TCL_RESOLVE_RES',
          requestId: data.requestId,
          ok: true,
          cleanUrl: CLEAN_POST_URL,
        },
      });
    }, 5);
  });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/SOURCEBAD1';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder.length, 1);
  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `非本視窗來源應被忽略、落入逾時路徑，實際 ${elapsed}ms`);
});

// ---- 解析流程結束後，message 監聽器須正確移除，不累積洩漏 ----

test('guard 端:短碼解析成功後，已移除自己的 message 監聽器，不累積洩漏', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const baselineListenerCount = win.getMessageListenerCount(); // bridge 模擬器自身的監聽器
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('https://www.threads.com/share/LEAKCHECK1');

  assert.equal(win.getMessageListenerCount(), baselineListenerCount);
});

// ---- write():不符合單一 text/plain 條件的 items，以參照相等原樣放行 ----

test('write():多格式(text/plain + text/html)ClipboardItem 以參照相等原樣放行，不重建新陣列', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteRaw(recorder), win);
  const item = new FakeClipboardItem({
    'text/plain': new Blob(['https://www.threads.com/@abc/post/123?xmt=ZZZ'], { type: 'text/plain' }),
    'text/html': new Blob(['<a href="...">link</a>'], { type: 'text/html' }),
  });
  const originalItems = [item];

  await sandbox.navigator.clipboard.write(originalItems);

  assert.equal(recorder[0], originalItems);
});

test('write():單一 image/png ClipboardItem 以參照相等原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteRaw(recorder), win);
  const item = new FakeClipboardItem({
    'image/png': new Blob([], { type: 'image/png' }),
  });
  const originalItems = [item];

  await sandbox.navigator.clipboard.write(originalItems);

  assert.equal(recorder[0], originalItems);
});

// ============================================================
// v1.1 設定規格:S3(autoClean 關閉)、S4(resolveShortcode 關閉)、
// S5(兩者皆開時行為不變)、S6(設定經 TCL_SETTINGS_PUSH 下放與即時生效)
//
// 【協定約定】bridge(ISOLATED world)以 postMessage 下放設定，訊息形狀為
//   { type: 'TCL_SETTINGS_PUSH', settings: { autoClean, resolveShortcode, notifySuccess } }
//
// 【時序紀律】設定推播與橋接回應一律經 setTimeout 延遲送達(createWindow 的
// postMessage 本身即為 setTimeout(0) 排程)，不在同一個 tick 直接結算。
//
// 【防假綠燈】凡「行為不得改變」類的條目(S4 的 ?xmt 分支、S5、S6 的預設值)，
// 測試都先以「設定關閉」的可鑑別情境確認設定確實生效，再驗證開啟時的行為，
// 避免實作根本沒接上設定卻碰巧通過。
// ============================================================

const SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
const XMT_URL = 'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7?xmt=AQG0abc';
const XMT_URL_CLEANED = 'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7';
const SHARE_URL = 'https://www.threads.com/share/DHuf91XTf/';

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 記錄 guard 送出的 TCL_RESOLVE_REQ。respond:true 時模擬 bridge 於 5ms 後
// 回覆一個「會成功」的解析結果——刻意如此:設定關閉卻仍發請求的實作會立刻
// 因為內容被改寫而紅燈，不必等 2500ms 逾時。
function trackResolveRequests(win, opts = {}) {
  const requests = [];
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'TCL_RESOLVE_REQ') return;
    requests.push(data);
    if (!opts.respond) return;
    setTimeout(() => {
      win.postMessage({
        type: 'TCL_RESOLVE_RES',
        requestId: data.requestId,
        ok: true,
        cleanUrl: opts.cleanUrl ?? CLEAN_POST_URL,
      });
    }, 5);
  });
  return requests;
}

// 模擬 bridge 下放設定:postMessage 一則 TCL_SETTINGS_PUSH，並等它非同步送達。
async function pushSettings(win, settings) {
  win.postMessage({ type: SETTINGS_PUSH_TYPE, settings });
  await settle();
}

function settings(overrides) {
  return Object.assign(
    { autoClean: true, resolveShortcode: true, notifySuccess: false },
    overrides
  );
}

// ---- S3:autoClean=false 一律直接放行原始內容 ----

test('S3:autoClean=false 時，writeText 對帶 ?xmt 的貼文網址原樣放行、不改寫、不發解析請求', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: false }));

  await sandbox.navigator.clipboard.writeText(XMT_URL);

  assert.equal(recorder[0], XMT_URL);
  assert.equal(requests.length, 0);
});

test('S3:autoClean=false 時，writeText 對 /share/ 短碼原樣放行，且完全不發 TCL_RESOLVE_REQ', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: false }));

  await sandbox.navigator.clipboard.writeText(SHARE_URL);

  assert.equal(recorder[0], SHARE_URL);
  assert.equal(requests.length, 0);
});

test('S3:autoClean=false 時，write() 對 ?xmt 貼文網址以參照相等原樣放行，不重建 items', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteRaw(recorder), win);
  await pushSettings(win, settings({ autoClean: false }));
  const originalItems = [
    new FakeClipboardItem({ 'text/plain': new Blob([XMT_URL], { type: 'text/plain' }) }),
  ];

  await sandbox.navigator.clipboard.write(originalItems);

  assert.equal(recorder[0], originalItems);
  assert.equal(requests.length, 0);
});

test('S3:autoClean=false 時，write() 對 /share/ 短碼以參照相等原樣放行，且不發解析請求', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteRaw(recorder), win);
  await pushSettings(win, settings({ autoClean: false }));
  const originalItems = [
    new FakeClipboardItem({ 'text/plain': new Blob([SHARE_URL], { type: 'text/plain' }) }),
  ];

  await sandbox.navigator.clipboard.write(originalItems);

  assert.equal(recorder[0], originalItems);
  assert.equal(requests.length, 0);
});

// ---- S4:autoClean=true 且 resolveShortcode=false ----

test('S4:resolveShortcode=false 時，writeText 對 /share/ 短碼放行原文且零網路請求', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: true, resolveShortcode: false }));

  await sandbox.navigator.clipboard.writeText(SHARE_URL);

  assert.equal(recorder[0], SHARE_URL);
  assert.equal(requests.length, 0);
});

test('S4:resolveShortcode=false 時，?xmt 參數剪除分支照常運作(全程零請求)', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: true, resolveShortcode: false }));

  // 先以短碼確認 resolveShortcode=false 確實生效(防假綠燈)，再驗證 ?xmt 分支不受影響。
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], SHARE_URL);
  assert.equal(requests.length, 0);

  await sandbox.navigator.clipboard.writeText(XMT_URL);

  assert.equal(recorder[1], XMT_URL_CLEANED);
  assert.equal(requests.length, 0);
});

test('S4:resolveShortcode=false 時，write() 短碼以參照相等放行且零請求；?xmt 分支照常剪除', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWrite(recorder), win);
  const shareItems = [
    new FakeClipboardItem({ 'text/plain': new Blob([SHARE_URL], { type: 'text/plain' }) }),
  ];
  await pushSettings(win, settings({ autoClean: true, resolveShortcode: false }));

  await sandbox.navigator.clipboard.write(shareItems);
  assert.equal(recorder[0][0].text, SHARE_URL);
  assert.equal(requests.length, 0);

  await sandbox.navigator.clipboard.write([
    new FakeClipboardItem({ 'text/plain': new Blob([XMT_URL], { type: 'text/plain' }) }),
  ]);

  assert.equal(recorder[1][0].text, XMT_URL_CLEANED);
  assert.equal(requests.length, 0);
});

// ---- S5:autoClean=true 且 resolveShortcode=true 時，現行淨化行為完全不變 ----

test('S5:兩者皆開時，writeText 短碼解析行為與現行完全一致', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  // 前置:先推播全關並確認放行，證明設定確實生效(否則下面的「行為不變」是假綠燈)。
  await pushSettings(win, settings({ autoClean: false, resolveShortcode: false }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], SHARE_URL);
  assert.equal(requests.length, 0);

  await pushSettings(win, settings({ autoClean: true, resolveShortcode: true }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);

  assert.equal(recorder[1], CLEAN_POST_URL);
  assert.equal(requests.length, 1);
});

test('S5:兩者皆開時，?xmt 剪除與非網址放行行為與現行完全一致', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.writeText(XMT_URL);
  assert.equal(recorder[0], XMT_URL);

  await pushSettings(win, settings({ autoClean: true, resolveShortcode: true }));
  await sandbox.navigator.clipboard.writeText(XMT_URL);
  await sandbox.navigator.clipboard.writeText('hello world, not a url');

  assert.equal(recorder[1], XMT_URL_CLEANED);
  assert.equal(recorder[2], 'hello world, not a url');
});

test('S5:兩者皆開時，write() 短碼解析行為與現行完全一致', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWrite(recorder), win);
  const makeItems = () => [
    new FakeClipboardItem({ 'text/plain': new Blob([SHARE_URL], { type: 'text/plain' }) }),
  ];

  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.write(makeItems());
  assert.equal(recorder[0][0].text, SHARE_URL);
  assert.equal(requests.length, 0);

  await pushSettings(win, settings({ autoClean: true, resolveShortcode: true }));
  await sandbox.navigator.clipboard.write(makeItems());

  assert.equal(recorder[1][0].text, CLEAN_POST_URL);
  assert.equal(requests.length, 1);
});

// ---- S6(MAIN world 端):首次推播前用預設值，收到推播後即時採用新值 ----

test('S6:guard 在收到第一次 TCL_SETTINGS_PUSH 前，以預設值(兩者皆開)運作', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  // 尚未推播任何設定:預設 autoClean=true、resolveShortcode=true。
  await sandbox.navigator.clipboard.writeText(XMT_URL);
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], XMT_URL_CLEANED);
  assert.equal(recorder[1], CLEAN_POST_URL);
  assert.equal(requests.length, 1);

  // 推播關閉後必須即時改變行為，證明上面走的是「預設值」而不是「沒接設定」。
  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.writeText(XMT_URL);

  assert.equal(recorder[2], XMT_URL);
  assert.equal(requests.length, 1);
});

test('S6:連續推播(開→關→開)時，guard 每次都即時採用最新設定', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await pushSettings(win, settings({ autoClean: true, resolveShortcode: true }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], CLEAN_POST_URL);
  assert.equal(requests.length, 1);

  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[1], SHARE_URL);
  assert.equal(requests.length, 1);

  await pushSettings(win, settings({ autoClean: true, resolveShortcode: true }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[2], CLEAN_POST_URL);
  assert.equal(requests.length, 2);
});
