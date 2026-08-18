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

// 【精簡】原本「帶尾斜線」「threads.net 無 www」「前後帶空白且附 query」
// 三條各自一測，驗的是同一個不變量:形態合法的短碼一律經橋接解析後寫入
// 乾淨貼文網址。併為一條多案例測試，三種形態逐一跑過。
// 使用者變更設定規格:autoClean 預設值改為 false，這裡測的是短碼解析本
// 身的行為(與預設值問題無關)，載入後先明確推播 autoClean:true 開啟，
// 讓測試繼續驗證同一件事——不因預設值翻轉而失去這批測試的鑑別力。預設
// 值本身的測試移到下方 S6 專區。
test('短碼經橋接成功解析後寫入乾淨貼文網址(尾斜線／無 www 的 threads.net／前後空白加 query)', async () => {
  const cases = [
    ['https://www.threads.com/share/DHuf91XTf/', '帶尾斜線'],
    ['https://threads.net/share/xyz123', 'threads.net 且無 www'],
    ['  https://www.threads.com/share/DHuf91XTf?foo=bar  ', '前後帶空白且附 query，須 trim 後判定'],
  ];

  for (const [input, label] of cases) {
    const recorder = [];
    const win = createWindow();
    installBridgeSim(win, 'success');
    const sandbox = loadGuard(recordingWriteText(recorder), win);
    win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await sandbox.navigator.clipboard.writeText(input);

    assert.equal(recorder[0], CLEAN_POST_URL, label);
  }
});

test('短碼橋接回應失敗時，原樣寫入原始短碼(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'failure');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shareUrl = 'https://www.threads.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(shareUrl);

  assert.equal(recorder[0], shareUrl);
});

test('短碼橋接逾時(2500ms)後，原樣寫入原始短碼(fail-open)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'timeout');
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shareUrl = 'https://www.threads.com/share/ABCDEF';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `應等滿 2500ms 才 fail-open，實際 ${elapsed}ms`);
});

// ---- 短碼分支:write() ----

test('write() 寫入單一 text/plain 短碼，經橋接成功解析後寫入乾淨貼文網址', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const sandbox = loadGuard(recordingWrite(recorder), win);
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
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
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  await sandbox.navigator.clipboard.writeText(
    'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7?xmt=AQG0abc'
  );

  assert.equal(recorder[0], 'https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7');
});

// 【精簡】「已乾淨的貼文網址」「非網址字串」「非字串輸入」「貼文網址後接
// 空白與其他文字」四條驗的是同一個不變量:沒有東西可淨化的輸入一律原樣
// 放行、不改寫。併為一條多案例測試。非 threads 網域的 /share/ 屬網域驗證，
// 仍單獨保留一條(見下)。
test('沒有東西可淨化的輸入一律原樣放行(已乾淨網址／非網址字串／非字串／網址後接文字)', async () => {
  const cases = [
    ['https://www.threads.com/@datinglab.tw/post/DbX8s51k1W7', '已乾淨的貼文網址'],
    ['hello world, not a url', '非網址字串'],
    [12345, '非字串輸入'],
    [
      'https://www.threads.com/@abc/post/123?xmt=1 and here is my comment',
      '貼文網址後接空白與其他文字，不得誤判為單一網址',
    ],
  ];

  for (const [input, label] of cases) {
    const recorder = [];
    const win = createWindow();
    const sandbox = loadGuard(recordingWriteText(recorder), win);

    await sandbox.navigator.clipboard.writeText(input);

    assert.equal(recorder[0], input, label);
  }
});

test('非 threads 網域的 /share/ 路徑不觸發短碼解析，原樣放行', async () => {
  const recorder = [];
  const win = createWindow();
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const url = 'https://evil.com/share/DHuf91XTf/';

  await sandbox.navigator.clipboard.writeText(url);

  assert.equal(recorder[0], url);
});

// 【精簡】原本此處另有一條「write() 多格式 item 原樣放行，不嘗試改寫」，
// 與後面「以參照相等原樣放行，不重建新陣列」那條是同一個案例的弱化版
// (後者連陣列參照都比對，嚴格涵蓋前者)，故刪除弱版、只留嚴格版。

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
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
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
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shareUrl = 'https://www.threads.com/share/SOURCEBAD1';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder.length, 1);
  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `非本視窗來源應被忽略、落入逾時路徑，實際 ${elapsed}ms`);
});

// 修正:onMessage(TCL_RESOLVE_RES)先前只驗 event.source，未驗 event.origin，
// 與 bridge.js:29-30 的同款驗證不對稱。這裡比照上一條 event.source 測試，
// 改用 dispatchRawMessageEvent 偽造一個 source 正確但 origin 錯誤的回應。
test('guard 端:event.origin 與本頁不符的回應不被採信，落入逾時 fail-open', async () => {
  const recorder = [];
  const win = createWindow();
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'TCL_RESOLVE_REQ') return;
    setTimeout(() => {
      win.dispatchRawMessageEvent({
        source: win,
        origin: 'https://evil.example',
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
  win.postMessage({ type: 'TCL_SETTINGS_PUSH', settings: { autoClean: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shareUrl = 'https://www.threads.com/share/ORIGINBAD1';

  const startedAt = Date.now();
  await sandbox.navigator.clipboard.writeText(shareUrl);
  const elapsed = Date.now() - startedAt;

  assert.equal(recorder.length, 1);
  assert.equal(recorder[0], shareUrl);
  assert.ok(elapsed >= 2500, `origin 不符應被忽略、落入逾時路徑，實際 ${elapsed}ms`);
});

// ---- 解析流程結束後，每次請求的 message 監聽器須正確移除，不累積洩漏 ----
//
// 【PM 裁決:S6 期望值調整】原斷言為「解析後回到基準」。v1.1 規格 S6 要求 guard
// 常駐一支 message 監聽器接收 TCL_SETTINGS_PUSH，因此基準值改為「基準 +1」:
// 常駐的設定監聽器是 S6 的設計，每次解析請求自己那支則仍須用完即移除。
// 防洩漏的原始意圖以「多輪解析後數量不再增長」保留。

test('guard 端:短碼解析成功後，只剩常駐的設定監聽器(基準+1)，多輪解析不再增長', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'success');
  const baselineListenerCount = win.getMessageListenerCount(); // bridge 模擬器自身的監聽器
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  // 載入即常駐一支設定監聽器(S6)。
  assert.equal(win.getMessageListenerCount(), baselineListenerCount + 1);

  await sandbox.navigator.clipboard.writeText('https://www.threads.com/share/LEAKCHECK1');
  assert.equal(win.getMessageListenerCount(), baselineListenerCount + 1);

  // 多輪解析後仍是同一支常駐監聽器，不累積洩漏。
  await sandbox.navigator.clipboard.writeText('https://www.threads.com/share/LEAKCHECK2');
  await sandbox.navigator.clipboard.writeText('https://www.threads.com/share/LEAKCHECK3');

  assert.equal(win.getMessageListenerCount(), baselineListenerCount + 1);
});

// ---- write():不符合單一 text/plain 條件的 items，以參照相等原樣放行 ----

// 【精簡】「多格式 item」與「單一 image/png」是同一個不變量(不符合單一
// text/plain 條件者一律以參照相等原樣放行、不重建新陣列)的兩個資料變體，
// 併為一條多案例測試。
test('write():不符單一 text/plain 條件的 items 以參照相等原樣放行，不重建新陣列', async () => {
  const cases = [
    [
      {
        'text/plain': new Blob(['https://www.threads.com/@abc/post/123?xmt=ZZZ'], { type: 'text/plain' }),
        'text/html': new Blob(['<a href="...">link</a>'], { type: 'text/html' }),
      },
      '多格式(text/plain + text/html)',
    ],
    [{ 'image/png': new Blob([], { type: 'image/png' }) }, '單一 image/png'],
  ];

  for (const [types, label] of cases) {
    const recorder = [];
    const win = createWindow();
    const sandbox = loadGuard(recordingWriteRaw(recorder), win);
    const originalItems = [new FakeClipboardItem(types)];

    await sandbox.navigator.clipboard.write(originalItems);

    assert.equal(recorder[0], originalItems, label);
  }
});

// ============================================================
// v1.1 設定規格:S3(autoClean 關閉)、S5(autoClean 開啟時行為不變)、
// S6(設定經 TCL_SETTINGS_PUSH 下放與即時生效)
//
// 【R1-1 開關合併】resolveShortcode 徹底移除——Threads 的複製連結只會吐
// share 短連結，「攔截但不解析」是幾乎無作用的組合。原 S4
// (resolveShortcode 關閉)整段隨之刪除;短碼解析與 ?xmt 剪參一律收在
// autoClean 這一顆之下。
//
// 【使用者變更設定規格】notifySuccess 整組移除，settings 只剩 autoClean
// 一顆鍵；autoClean 預設值改為 false。
//
// 【協定約定】bridge(ISOLATED world)以 postMessage 下放設定，訊息形狀為
//   { type: 'TCL_SETTINGS_PUSH', settings: { autoClean } }
//
// 【時序紀律】設定推播與橋接回應一律經 setTimeout 延遲送達(createWindow 的
// postMessage 本身即為 setTimeout(0) 排程)，不在同一個 tick 直接結算。
//
// 【防假綠燈】凡「行為不得改變」類的條目(S5、S6 的預設值)，測試都先以
// 「設定關閉」的可鑑別情境確認設定確實生效，再驗證開啟時的行為，避免實作
// 根本沒接上設定卻碰巧通過。
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

// 使用者變更設定規格:notifySuccess 整組移除，settings 只剩 autoClean 一
// 顆鍵下放給 MAIN world。
function settings(overrides) {
  return Object.assign({ autoClean: true }, overrides);
}

// ---- S3:autoClean=false 一律直接放行原始內容 ----

// 【精簡】原本 ?xmt 與 /share/ 兩種輸入各自一測(writeText 與 write() 各兩條)，
// 驗的是同一個不變量:autoClean=false 時一律原樣放行且完全不發解析請求。
// 兩條路徑(writeText／write())是不同分支各留一條，路徑內的兩種輸入併成多案例。
test('S3:autoClean=false 時，writeText 對 ?xmt 與 /share/ 皆原樣放行，且完全不發 TCL_RESOLVE_REQ', async () => {
  for (const input of [XMT_URL, SHARE_URL]) {
    const recorder = [];
    const win = createWindow();
    const requests = trackResolveRequests(win, { respond: true });
    const sandbox = loadGuard(recordingWriteText(recorder), win);
    await pushSettings(win, settings({ autoClean: false }));

    await sandbox.navigator.clipboard.writeText(input);

    assert.equal(recorder[0], input, `${input} 應原樣放行`);
    assert.equal(requests.length, 0, `${input} 不得送出解析請求`);
  }
});

test('S3:autoClean=false 時，write() 對 ?xmt 與 /share/ 皆以參照相等原樣放行，且不發解析請求', async () => {
  for (const input of [XMT_URL, SHARE_URL]) {
    const recorder = [];
    const win = createWindow();
    const requests = trackResolveRequests(win, { respond: true });
    const sandbox = loadGuard(recordingWriteRaw(recorder), win);
    await pushSettings(win, settings({ autoClean: false }));
    const originalItems = [
      new FakeClipboardItem({ 'text/plain': new Blob([input], { type: 'text/plain' }) }),
    ];

    await sandbox.navigator.clipboard.write(originalItems);

    assert.equal(recorder[0], originalItems, `${input} 應以參照相等原樣放行`);
    assert.equal(requests.length, 0, `${input} 不得送出解析請求`);
  }
});

// ---- S5:autoClean=true 時，現行淨化行為(短碼解析與 ?xmt 剪參)完全不變 ----
//
// 【精簡:整節刪除】S5 原有三條，形式都是「先推播關閉確認放行、再推播開啟
// 確認行為與現行一致」——後半段與既有的成功流程測試完全重疊，屬於典型的
// 「錯誤/關閉路徑後再跑一次成功流程」。逐條對應到仍在的覆蓋:
//   - writeText 短碼解析     → 上方短碼多案例測試(預設 true)
//                              + S6「連續推播(開→關→開)」(明示推播 true)
//   - ?xmt 剪除與非網址放行  → 上方 ?xmt 測試與「原樣放行」多案例測試
//                              + S6「首次推播前用預設值」
//   - write() 短碼解析       → 上方 write() 短碼成功測試(預設 true);
//                              autoClean 這道閘是兩條路徑共用的同一個判斷，
//                              關閉側由 S3 的 write() 測試覆蓋。
// 前半段「關閉確實生效」的可鑑別性由 S3 與 S6 各自保留，不因此節刪除而失守。

// ---- S6(MAIN world 端):首次推播前用預設值，收到推播後即時採用新值 ----

// 使用者變更設定規格:autoClean 預設值改為 false。原斷言方向「預設開
// 啟，推播關閉後改變行為」整個倒過來:預設關閉，推播開啟後才改變行為。
test('S6:guard 在收到第一次 TCL_SETTINGS_PUSH 前，以預設值(autoClean=false)運作', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  // 尚未推播任何設定:預設 autoClean=false，一律原樣放行、不發解析請求。
  await sandbox.navigator.clipboard.writeText(XMT_URL);
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], XMT_URL);
  assert.equal(recorder[1], SHARE_URL);
  assert.equal(requests.length, 0);

  // 推播開啟後必須即時改變行為，證明上面走的是「預設值」而不是「沒接設定」。
  await pushSettings(win, settings({ autoClean: true }));
  await sandbox.navigator.clipboard.writeText(XMT_URL);

  assert.equal(recorder[2], XMT_URL_CLEANED);
  assert.equal(requests.length, 0);
});

test('S6:連續推播(開→關→開)時，guard 每次都即時採用最新設定', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  await pushSettings(win, settings({ autoClean: true }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], CLEAN_POST_URL);
  assert.equal(requests.length, 1);

  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[1], SHARE_URL);
  assert.equal(requests.length, 1);

  await pushSettings(win, settings({ autoClean: true }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[2], CLEAN_POST_URL);
  assert.equal(requests.length, 2);
});

// ---- S8:TCL_SETTINGS_PUSH 的來源驗證(PM 裁決採納，與 TCL_RESOLVE_RES 同等級) ----
//
// guard 對 TCL_RESOLVE_RES 已要求 event.source 必須是本視窗;設定推播是同一條
// postMessage 管道，必須做同等級的來源驗證。驗證不過的推播要「完全忽略」——
// 不是部分套用、也不是先套用再回退，而是設定一點都不得生效。
// 每支測試都附上「同樣內容改由合法管道下放必須生效」的對照組，避免實作用
// 「一律忽略所有推播」的假動作通過。

// 使用者變更設定規格:autoClean 預設值改為 false，偽造推播若想製造「可
// 觀察到的差異」必須改成嘗試把它打開(true)，否則跟 ambient 預設值本來
// 就相同、驗不出偽造是否真的被忽略。
test('S8:event.source 非本視窗的 TCL_SETTINGS_PUSH 必須完全忽略，設定不得生效', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const fakeOtherWindow = {};

  // 偽造來源、想打開 autoClean 的推播:必須被忽略，guard 仍以預設值(autoClean=false)原樣放行。
  win.dispatchRawMessageEvent({
    source: fakeOtherWindow,
    origin: win.location.origin,
    data: { type: SETTINGS_PUSH_TYPE, settings: settings({ autoClean: true }) },
  });
  await settle();
  await sandbox.navigator.clipboard.writeText(XMT_URL);
  assert.equal(recorder[0], XMT_URL, '偽造來源的推播不得生效');

  // 對照組:同樣的內容改由合法管道(window.postMessage，source === window)下放，必須生效。
  await pushSettings(win, settings({ autoClean: true }));
  await sandbox.navigator.clipboard.writeText(XMT_URL);

  assert.equal(recorder[1], XMT_URL_CLEANED, '合法來源的推播必須生效');
  assert.equal(requests.length, 0);
});

test('S8:偽造來源的推播不得覆蓋既有的合法設定', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  const fakeOtherWindow = {};

  // 先以合法管道關閉 autoClean。
  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], SHARE_URL);
  assert.equal(requests.length, 0);

  // 偽造來源想把 autoClean 開回來:必須被忽略，設定維持關閉。
  win.dispatchRawMessageEvent({
    source: fakeOtherWindow,
    origin: win.location.origin,
    data: { type: SETTINGS_PUSH_TYPE, settings: settings({ autoClean: true }) },
  });
  await settle();
  await sandbox.navigator.clipboard.writeText(SHARE_URL);

  assert.equal(recorder[1], SHARE_URL, '偽造來源不得覆蓋既有合法設定');
  assert.equal(requests.length, 0);
});

// 修正:TCL_SETTINGS_PUSH 的監聽器先前只驗 event.source，未驗 event.origin，
// 與 bridge.js:29-30、以及本檔上方 TCL_RESOLVE_RES 的同款驗證不對稱。
// 比照上兩條 S8 測試的形狀，改偽造一個 source 正確但 origin 錯誤的推播。

test('S8:origin 與本頁不符的 TCL_SETTINGS_PUSH 必須完全忽略，設定不得生效', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  // 偽造 origin、想打開 autoClean 的推播:必須被忽略，guard 仍以預設值(autoClean=false)原樣放行。
  win.dispatchRawMessageEvent({
    source: win,
    origin: 'https://evil.example',
    data: { type: SETTINGS_PUSH_TYPE, settings: settings({ autoClean: true }) },
  });
  await settle();
  await sandbox.navigator.clipboard.writeText(XMT_URL);
  assert.equal(recorder[0], XMT_URL, '偽造 origin 的推播不得生效');

  // 對照組:同樣的內容改由合法管道(origin 相符)下放，必須生效。
  await pushSettings(win, settings({ autoClean: true }));
  await sandbox.navigator.clipboard.writeText(XMT_URL);

  assert.equal(recorder[1], XMT_URL_CLEANED, '合法 origin 的推播必須生效');
  assert.equal(requests.length, 0);
});

test('S8:origin 與本頁不符的推播不得覆蓋既有的合法設定', async () => {
  const recorder = [];
  const win = createWindow();
  const requests = trackResolveRequests(win, { respond: true });
  const sandbox = loadGuard(recordingWriteText(recorder), win);

  // 先以合法管道關閉 autoClean。
  await pushSettings(win, settings({ autoClean: false }));
  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  assert.equal(recorder[0], SHARE_URL);
  assert.equal(requests.length, 0);

  // 偽造 origin 想把 autoClean 開回來:必須被忽略，設定維持關閉。
  win.dispatchRawMessageEvent({
    source: win,
    origin: 'https://evil.example',
    data: { type: SETTINGS_PUSH_TYPE, settings: settings({ autoClean: true }) },
  });
  await settle();
  await sandbox.navigator.clipboard.writeText(SHARE_URL);

  assert.equal(recorder[1], SHARE_URL, '偽造 origin 不得覆蓋既有合法設定');
  assert.equal(requests.length, 0);
});

// ============================================================
// R1-2 通知涵蓋自動路徑(MAIN world 端):自動淨化成功時，guard 要往
// bridge 送出一則通知，轉發給 background 寫入淨化紀錄(方案甲:歷史即
// 收藏，唯一資料集)。
//
// 【協定約定】guard → bridge 的訊息形狀:
//   { type: 'TCL_CLEANED_NOTICE', cleanUrl: <實際寫入剪貼簿的淨化後字串> }
//
// 【判定基準(規格明文)】必須以 guard「實際把淨化後內容寫入剪貼簿」為準:
//   - 解析逾時後才回來的遲到結果不得觸發通知(防 timeout race 假通知)
//   - fail-open 放行原文(解析失敗／autoClean 關閉／內容本來就乾淨)不算成功
//   - 原生寫入被拒(rejection)代表根本沒寫進去，也不算成功
//
// 使用者變更設定規格:notifySuccess(成功類通知的顯示與否)已整組移除，
// 這裡的 notice 不再有「要不要顯示」的把關，background 收到就無條件記
// 錄一筆——本節純測 guard 該不該送出 notice 這個判定基準本身。
// ============================================================

const CLEANED_NOTICE_TYPE = 'TCL_CLEANED_NOTICE';

// 側錄 guard 送出的 TCL_CLEANED_NOTICE。
function trackCleanedNotices(win) {
  const notices = [];
  win.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === CLEANED_NOTICE_TYPE) notices.push(data);
  });
  return notices;
}

// 【精簡】三條淨化成功送 notice 的測試(writeText 短碼／writeText ?xmt／
// write() 短碼)驗的是同一個不變量:實際寫入淨化後內容就送出一則 notice，
// 且 notice 的 cleanUrl 等於實際寫入的內容。併為一條三案例測試，三條路徑
// 都仍各跑一次。
test('R1-2:淨化成功實際寫入後，guard 送出 TCL_CLEANED_NOTICE，cleanUrl 等於寫入內容', async () => {
  const cases = [
    {
      label: 'writeText 短碼解析',
      resolve: true,
      run: async (sandbox) => sandbox.navigator.clipboard.writeText(SHARE_URL),
      makeClipboard: recordingWriteText,
      written: (recorder) => recorder[0],
      expected: CLEAN_POST_URL,
      expectedKind: 'share',
    },
    {
      label: 'writeText ?xmt 剪參',
      resolve: false,
      run: async (sandbox) => sandbox.navigator.clipboard.writeText(XMT_URL),
      makeClipboard: recordingWriteText,
      written: (recorder) => recorder[0],
      expected: XMT_URL_CLEANED,
      expectedKind: 'strip',
    },
    {
      label: 'write() 短碼解析',
      resolve: true,
      run: async (sandbox) =>
        sandbox.navigator.clipboard.write([
          new FakeClipboardItem({ 'text/plain': new Blob([SHARE_URL], { type: 'text/plain' }) }),
        ]),
      makeClipboard: recordingWrite,
      written: (recorder) => recorder[0][0].text,
      expected: CLEAN_POST_URL,
      expectedKind: 'share',
    },
  ];

  for (const { label, resolve, run, makeClipboard, written, expected, expectedKind } of cases) {
    const recorder = [];
    const win = createWindow();
    if (resolve) trackResolveRequests(win, { respond: true });
    const notices = trackCleanedNotices(win);
    const sandbox = loadGuard(makeClipboard(recorder), win);
    await pushSettings(win, settings({ autoClean: true }));

    await run(sandbox);
    await settle();

    assert.equal(written(recorder), expected, `${label}:應實際寫入淨化後內容`);
    assert.equal(notices.length, 1, `${label}:應送出剛好一則 notice`);
    assert.equal(notices[0].cleanUrl, expected, `${label}:notice 的 cleanUrl 應等於實際寫入的內容`);
    assert.equal(notices[0].kind, expectedKind, `${label}:notice 應標示淨化來源 kind`);
  }
});

test('R1-2:解析逾時後才送達的遲到結果，不得觸發通知(防 timeout race 假通知)', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'late'); // 2600ms 才回應，已超過 guard 的 2500ms 逾時
  const notices = trackCleanedNotices(win);
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: true }));
  const shareUrl = 'https://www.threads.com/share/LATE0002';

  await sandbox.navigator.clipboard.writeText(shareUrl);
  assert.equal(recorder[0], shareUrl, '逾時後應 fail-open 寫入原文');

  // 等遲到回應確實送達之後再檢查:它不得補送一則成功通知。
  await settle(500);

  assert.equal(notices.length, 0);
});

test('R1-2:橋接解析失敗而 fail-open 寫入原文時，不得送出通知', async () => {
  const recorder = [];
  const win = createWindow();
  installBridgeSim(win, 'failure');
  const notices = trackCleanedNotices(win);
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: true }));

  await sandbox.navigator.clipboard.writeText(SHARE_URL);
  await settle();

  assert.equal(recorder[0], SHARE_URL);
  assert.equal(notices.length, 0);
});

test('R1-2:autoClean=false 原樣放行時，不得送出通知', async () => {
  const recorder = [];
  const win = createWindow();
  trackResolveRequests(win, { respond: true });
  const notices = trackCleanedNotices(win);
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: false }));

  await sandbox.navigator.clipboard.writeText(XMT_URL);
  await settle();

  assert.equal(recorder[0], XMT_URL);
  assert.equal(notices.length, 0);
});

test('R1-2:內容本來就乾淨、未做任何改寫時，不得送出通知', async () => {
  const recorder = [];
  const win = createWindow();
  const notices = trackCleanedNotices(win);
  const sandbox = loadGuard(recordingWriteText(recorder), win);
  await pushSettings(win, settings({ autoClean: true }));

  await sandbox.navigator.clipboard.writeText(CLEAN_POST_URL);
  await sandbox.navigator.clipboard.writeText('hello world, not a url');
  await settle();

  assert.equal(notices.length, 0);
});

test('R1-2:原生寫入被拒(沒真的寫進剪貼簿)時，不得送出通知', async () => {
  const rejectError = new Error('NotAllowedError: native writeText rejected');
  const callCounter = { count: 0 };
  const win = createWindow();
  trackResolveRequests(win, { respond: true });
  const notices = trackCleanedNotices(win);
  const sandbox = loadGuard(rejectingWriteText(rejectError, callCounter), win);
  await pushSettings(win, settings({ autoClean: true }));

  await assert.rejects(
    () => sandbox.navigator.clipboard.writeText(SHARE_URL),
    (err) => err === rejectError
  );
  await settle();

  assert.equal(callCounter.count, 1);
  assert.equal(notices.length, 0);
});
