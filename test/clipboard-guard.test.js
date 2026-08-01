// test/clipboard-guard.test.js — clipboard-guard.js(MAIN world 剪貼簿
// 攔截淨化)的行為契約。全程用 vm sandbox 離線模擬 navigator.clipboard 與
// window.postMessage 橋接,不發真實網路請求、不碰真實剪貼簿。
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
// clipboard-guard.js 自己的 2500ms 逾時機制接手)。
function installBridgeSim(win, scenario, opts = {}) {
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'TCL_RESOLVE_REQ') return;
    if (scenario === 'timeout') return;
    setTimeout(() => {
      if (scenario === 'success') {
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
    }, opts.delay ?? 5);
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

// ---- 短碼分支:writeText ----

test('短碼(帶尾斜線)經橋接成功解析後,寫入乾淨貼文網址', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('https://www.threads.com/share/DHuf91XTf/');

  assert.equal(recorder[0], CLEAN_POST_URL);
});

test('短碼橋接回應失敗時,原樣寫入原始短碼(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'failure');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(shareUrl);

  assert.equal(recorder[0], shareUrl);
});

test('短碼橋接逾時(2500ms)後,原樣寫入原始短碼(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'timeout');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/ABCDEF';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `應等滿 2500ms 才 fail-open,實際 ${elapsed}ms`);
});

test('threads.net 短碼(無 www)經橋接成功解析後,寫入乾淨貼文網址', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('https://threads.net/share/xyz123');

  assert.equal(recorder[0], CLEAN_POST_URL);
});

test('短碼前後帶空白且附 query 時,trim 後仍判定為短碼並解析成功', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await sandbox.navigator.clipboard.writeText('  https://www.threads.com/share/DHuf91XTf?foo=bar  ');

  assert.equal(recorder[0], CLEAN_POST_URL);
});

// ---- 短碼分支:write() ----

test('write() 寫入單一 text/plain 短碼,經橋接成功解析後寫入乾淨貼文網址', async () => {
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

test('write() 短碼橋接回應失敗時,原樣放行原始內容(fail-open)', async () => {
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

// ---- 既有 ?xmt 淨化邏輯(短碼分支之外的既有行為,須與短碼分支共存不受影響) ----

test('帶 ?xmt 追蹤參數的貼文網址,同步去除 query 後放行', async () => {
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

test('貼文網址後接空白與其他文字時,不誤判為單一網址、原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const text = 'https://www.threads.com/@abc/post/123?xmt=1 and here is my comment';

  await sandbox.navigator.clipboard.writeText(text);

  assert.equal(recorder[0], text);
});

test('非 threads 網域的 /share/ 路徑不觸發短碼解析,原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const url = 'https://evil.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(url);

  assert.equal(recorder[0], url);
});

test('write() 多格式(text/plain + text/html)item 原樣放行,不嘗試改寫', async () => {
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

// ---- 原生寫入被拒時:只呼叫一次,rejection 原樣傳回呼叫端 ----

test('writeText 短碼路徑:原生寫入被拒時只呼叫一次,rejection 原樣傳回', async () => {
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

test('write() 短碼路徑:原生寫入被拒時只呼叫一次,rejection 原樣傳回', async () => {
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

test('write() ?xmt 路徑:原生寫入被拒時只呼叫一次,rejection 原樣傳回', async () => {
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

test('writeText ?xmt 路徑:原生寫入被拒時只呼叫一次,rejection 原樣傳回', async () => {
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

test('橋接回傳非貼文格式的 cleanUrl 時,視同解析失敗、寫回原始短碼', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success', { cleanUrl: 'https://evil.com/not-a-post-url' });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(shareUrl);

  assert.equal(recorder[0], shareUrl);
});

test('write() 橋接回傳非貼文格式的 cleanUrl 時,視同解析失敗、維持原始短碼', async () => {
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
