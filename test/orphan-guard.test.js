// test/orphan-guard.test.js — 決策 S1 的基礎層（R1）：三支 ISOLATED world
// content script（bridge.js、post-icon.js、scam-guard.js）的孤兒自我退場。
//
// ============================================================
// 【R1 契約】
// 擴充功能更新／重載後，既開分頁裡的舊 content script 仍在跑，但
// chrome.runtime.id 變成 undefined（孤兒）。三支腳本在任何會呼叫
// chrome.runtime.*／chrome.storage.* 的路徑前先判活，判定為孤兒就立刻自我
// 退場：
//   - 斷開 MutationObserver、清掉自己排下的計時器、移除自己插入的 DOM 節點
//     與標記（post-icon 的 .tcl-copy-icon、scam-guard 的 .tcl-scam-tag）；
//   - 從判定孤兒的那一刻起不再呼叫任何 chrome.runtime.*／chrome.storage.*
//     （包含 onChanged.removeListener 這類「收尾」呼叫——孤兒情境下 chrome
//     API 本身就不可靠，收尾靠自己的旗標與 AbortController，不靠 chrome）；
//   - 不拋錯、不 console.error；console.debug 至多一次。
// 「載入當下就已經是孤兒」同樣適用：連第一輪 storage 讀取與監聽註冊都不該
// 發生，也不留下任何活著的 observer／listener。
//
// 本檔只看 chrome.runtime 與 chrome.storage 兩支命名空間的呼叫紀錄；
// chrome.i18n.getUILanguage 由 i18n.js 的語言偵測呼叫，不在 R1 範圍。
// 既有 console.warn 的降級訊息（post-icon.test.js／bridge.test.js 有斷言）
// 不受本檔限制。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECOND_PATH,
  SECOND_POSTS,
  captureUncaught,
  createBridgeEnv,
  createDetailPage,
  createFeedCard,
  createFeedPage,
  createPageEnv,
  wait,
  waitFor,
} = require('./support/reinject-harness');

const CHROME_API_PATH = /^chrome\.(runtime|storage)\./;

function runtimeOrStorage(paths) {
  return paths.filter((p) => CHROME_API_PATH.test(p));
}

function assertQuietExit(env, uncaught, label) {
  assert.deepEqual(env.consoleLog.error, [], `${label}：孤兒退場不得 console.error`);
  assert.ok(env.consoleLog.debug.length <= 1, `${label}：console.debug 至多一次`);
  assert.deepEqual(uncaught.errors, [], `${label}：不得有未捕捉例外或未處理的 rejection`);
}

// ============================================================
// bridge.js
// ============================================================

test('R1 bridge：載入當下已是孤兒——不讀 chrome.storage、不註冊 onChanged、不留 message listener', async () => {
  const uncaught = captureUncaught();
  try {
    const env = createBridgeEnv();
    env.orphan();
    assert.doesNotThrow(() => env.load(), '孤兒載入不得丟例外');
    await wait(30);

    assert.deepEqual(
      runtimeOrStorage(env.callsSinceOrphan()),
      [],
      '孤兒載入不得呼叫任何 chrome.runtime／chrome.storage API（現況會先讀 storage.sync 並註冊 onChanged）'
    );
    assert.equal(env.win.getMessageListenerCount(), 0, '孤兒載入不得留下活著的 message listener');
    assertQuietExit(env, uncaught, 'bridge 孤兒載入');
  } finally {
    uncaught.restore();
  }
});

test('R1 bridge（回歸）：載入後才孤兒化，收到頁面訊息一律不轉發、自我下線、不 console.error', async () => {
  const uncaught = captureUncaught();
  try {
    const env = createBridgeEnv();
    env.load();
    await wait(20);
    env.orphan();

    env.win.postMessage({ type: 'TCL_CLEANED_NOTICE', cleanUrl: 'https://www.threads.com/@a/post/B', kind: 'share' });
    env.win.postMessage({
      type: 'TCL_RESOLVE_REQ',
      requestId: 'req-orphan-guard',
      url: 'https://www.threads.com/share/ABC',
    });
    await wait(30);

    assert.deepEqual(runtimeOrStorage(env.callsSinceOrphan()), [], '孤兒化之後不得再呼叫 chrome API');
    assert.equal(env.win.getMessageListenerCount(), 0, '孤兒自檢後 message listener 應已移除');
    assertQuietExit(env, uncaught, 'bridge 載入後孤兒化');
  } finally {
    uncaught.restore();
  }
});

// ============================================================
// post-icon.js
// ============================================================

test('R1 post-icon：載入當下已是孤兒——不讀 storage、不註冊監聽、不留活 observer、不注入 icon', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.orphan();
    assert.doesNotThrow(() => env.loadPostIcon(), '孤兒載入不得丟例外');
    await wait(80);

    assert.deepEqual(
      runtimeOrStorage(env.callsSinceOrphan()),
      [],
      '孤兒載入不得呼叫 chrome.storage.sync.get／onChanged.addListener（現況 init 在孤兒自檢後照樣讀 storage）'
    );
    assert.equal(
      env.liveObservers().length,
      0,
      '孤兒載入不得留下活著的 MutationObserver（現況 retire 之後 startObserver 仍會建立一個）'
    );
    assert.equal(env.icons().length, 0, '孤兒不得注入任何 icon');
    assertQuietExit(env, uncaught, 'post-icon 孤兒載入');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});

test('R1 post-icon（回歸）：載入後孤兒化，DOM 變動觸發的掃描自我退場——不呼叫 chrome API、observer 斷開、自己的 icon 清掉', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：兩張卡各注入一顆 icon');

    env.orphan();
    env.document.querySelector('#feed-root').appendChild(createFeedCard('late.author'));
    env.triggerObserver();
    await wait(150);

    assert.deepEqual(runtimeOrStorage(env.callsSinceOrphan()), [], '孤兒化之後不得再呼叫 chrome API');
    assert.equal(env.liveObservers().length, 0, '孤兒退場必須斷開 MutationObserver');
    assert.equal(env.icons().length, 0, '孤兒退場必須移除自己注入的 icon，新卡也不得再注入');
    assertQuietExit(env, uncaught, 'post-icon DOM 變動');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});

test('R1 post-icon（回歸）：載入後孤兒化，點擊 icon 當場退場——不呼叫 chrome API、observer 斷開、icon 清掉', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：兩張卡各注入一顆 icon');

    env.orphan();
    const icon = env.icons()[0];
    assert.doesNotThrow(() => icon.fire('click'), '孤兒 icon 被點擊不得丟例外');
    await wait(50);

    assert.deepEqual(runtimeOrStorage(env.callsSinceOrphan()), [], '點擊孤兒 icon 不得呼叫 chrome API');
    assert.equal(env.sent.length, 0, '不得送出 cleanedNotice');
    assert.equal(env.liveObservers().length, 0, '孤兒退場必須斷開 MutationObserver');
    assert.equal(env.icons().length, 0, '孤兒退場必須移除自己注入的 icon');
    assertQuietExit(env, uncaught, 'post-icon 點擊');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});

test('R1 post-icon：孤兒退場時一併清掉退場前已排下的掃描計時器', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：兩張卡各注入一顆 icon');

    // DOM 變動排下 debounce 掃描（尚未觸發），緊接著孤兒化並由點擊觸發退場。
    env.timers.setPhase('before-retire');
    env.triggerObserver();
    env.timers.setPhase('after-retire');
    assert.ok(
      env.timers.records.some((r) => r.phase === 'before-retire'),
      '前提：DOM 變動應排下一顆 debounce 計時器'
    );
    env.orphan();
    env.icons()[0].fire('click');

    assert.deepEqual(
      env.timers.pendingFrom('before-retire').map((r) => r.delay),
      [],
      '退場當下必須 clearTimeout 掉自己排下、尚未觸發的計時器（現況留著讓它空轉一輪）'
    );
    assertQuietExit(env, uncaught, 'post-icon 計時器');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});

// ============================================================
// scam-guard.js
// ============================================================

test('R1 scam-guard：載入當下已是孤兒——不讀 storage、不送 scam.hit、不留活 observer、不掛 tag', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.orphan();
    assert.doesNotThrow(() => env.loadScamGuard(), '孤兒載入不得丟例外');
    await wait(150);

    assert.deepEqual(
      runtimeOrStorage(env.callsSinceOrphan()),
      [],
      '孤兒載入不得呼叫任何 chrome.runtime／chrome.storage API（現況無任何判活）'
    );
    assert.equal(env.liveObservers().length, 0, '孤兒載入不得留下活著的 MutationObserver');
    assert.equal(env.tags().length, 0, '孤兒不得掛警示 tag');
    assertQuietExit(env, uncaught, 'scam-guard 孤兒載入');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});

test('R1 scam-guard：載入後孤兒化，SPA 換頁觸發的掃描不再送 scam.hit、observer 斷開', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：詳情頁命中並掛上一顆 tag');
    assert.equal(env.hits().length, 1, '前提：已送出一則 scam.hit');

    env.orphan();
    env.setPathname(SECOND_PATH);
    env.setPage(createDetailPage(SECOND_POSTS));
    env.triggerObserver();
    await wait(200);

    assert.deepEqual(
      runtimeOrStorage(env.callsSinceOrphan()),
      [],
      '孤兒化之後不得再呼叫 chrome API（現況會對新頁送 chrome.runtime.sendMessage）'
    );
    assert.equal(env.hits().length, 1, '孤兒不得再送 scam.hit');
    assert.equal(env.liveObservers().length, 0, '孤兒退場必須斷開 MutationObserver');
    assertQuietExit(env, uncaught, 'scam-guard SPA 換頁');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});

test('R1 scam-guard：載入後孤兒化，下一次 DOM 變動即退場並移除自己掛上的警示 tag', async () => {
  const uncaught = captureUncaught();
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：詳情頁命中並掛上一顆 tag');

    env.orphan();
    env.triggerObserver();
    await wait(200);

    assert.deepEqual(runtimeOrStorage(env.callsSinceOrphan()), [], '孤兒化之後不得再呼叫 chrome API');
    assert.equal(env.tags().length, 0, '孤兒退場必須移除自己掛上的 tag（交給重注入的新實例重掛）');
    assert.equal(env.liveObservers().length, 0, '孤兒退場必須斷開 MutationObserver');
    assertQuietExit(env, uncaught, 'scam-guard DOM 變動');
  } finally {
    uncaught.restore();
    env.dispose();
  }
});
