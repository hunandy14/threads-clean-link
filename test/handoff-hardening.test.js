// test/handoff-hardening.test.js — 交棒硬化（0.11.1 車道③，H1／審查 D1）。
//
// ============================================================
// 【H1 契約】
// 交棒事件 `threads-clean-link:handoff` 掛在共用的 document 上，頁面 MAIN
// world 的腳本也派得出來；Chromium 跨 world 讀 CustomEvent.detail 會做結構化
// 複製，所以頁面偽造的 detail 活實例照樣讀得到。規則因此改為：
//   - onHandoff 收到事件時，只在本實例已是孤兒（chrome.runtime?.id 判活失
//     敗）時才退場；活實例對任何交棒事件（不論 detail 長什麼樣）一律不理。
//   - 同一 ISOLATED world 內的新實例取代舊實例，改走頁面碰不到的 world 全
//     域握把：bridge 的 window.__tclBridgeDispose、post-icon 的
//     window.__tclPostIconDispose、scam-guard 的 window.__tclScamGuardDispose
//     （新增）。新實例啟動時先呼叫握把讓舊實例退場，再派交棒事件。
//   - 擴充功能更新後的跨 world 重注入：舊實例已是孤兒，新實例派的交棒事件
//     照樣讓它立即退場（兩個 world 只共用 DOM，握把碰不到）。
// 本檔以「兩個 sandbox 共用同一個 document」模擬跨 world；頁面偽造事件以
// 測試直接在 document 上 dispatch 模擬。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONTAINER_SELECTOR,
  ICON_CLASS,
  createBridgeEnv,
  createFeedPage,
  createPageEnv,
  wait,
  waitFor,
} = require('./support/reinject-harness');

const HANDOFF_EVENT = 'threads-clean-link:handoff';
const CHROME_API_PATH = /^chrome\.(runtime|storage)\./;
const CLEANED_NOTICE = {
  type: 'TCL_CLEANED_NOTICE',
  cleanUrl: 'https://www.threads.com/@a/post/B',
  kind: 'share',
};

// 頁面腳本偽造的交棒事件：與真實事件同名、detail 形狀相同，腳本名對得上、
// instanceId 不是任何實例的。
function forgeHandoff(doc, script, detailOverride) {
  const detail = detailOverride === undefined ? { script, instanceId: 'forged-by-page' } : detailOverride;
  doc.dispatchEvent(new CustomEvent(HANDOFF_EVENT, { detail }));
}

// 各種頁面可偽造的 detail：同名腳本＋陌生 instanceId、null、缺欄位。
function forgeAll(doc, script) {
  forgeHandoff(doc, script);
  forgeHandoff(doc, script, { script, instanceId: 'another-forged-id' });
  forgeHandoff(doc, script, null);
  forgeHandoff(doc, script, { script });
}

function iconsPerCard(env) {
  return env.document
    .querySelectorAll(CONTAINER_SELECTOR)
    .map((card) => card.querySelectorAll('.' + ICON_CLASS).length);
}

// 在第一個實例載入前就先掛上的探針：記錄每一則交棒事件派送當下（排在所有
// 實例的監聽器之前執行）呼叫 probe() 的結果。
function probeAtHandoff(doc, probe) {
  const seen = [];
  doc.addEventListener(HANDOFF_EVENT, (event) => {
    seen.push({ detail: event && event.detail, value: probe() });
  });
  return seen;
}

// bridge 環境本身不帶 document；掛上一個共用的假 document 讓交棒路徑生效。
function createBridgeEnvWithDocument(doc) {
  const env = createBridgeEnv();
  env.sandbox.document = doc;
  return env;
}

// ============================================================
// H1-1：活實例收到頁面偽造的交棒事件不退場
// ============================================================

test('H1-1 post-icon：活實例收到頁面偽造的交棒事件不退場，icon 與 observer 都保留', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：注入兩顆 icon');
    await wait(60);

    forgeAll(env.document, 'post-icon');
    await wait(20);

    assert.equal(env.observers[0].disconnected, false, '偽造事件不得讓活實例斷開 observer（D1）');
    assert.equal(env.liveObservers().length, 1, '頁面上仍應有一個活著的 observer');
    assert.equal(env.icons().length, 2, '偽造事件不得收掉 icon');
    assert.equal(env.document.listenerCount(HANDOFF_EVENT), 1, '活實例的交棒監聽器應仍在');

    env.triggerObserver();
    await wait(120);
    assert.deepEqual(iconsPerCard(env), [1, 1], '之後的 DOM 變動仍由活實例正常處理');
  } finally {
    env.dispose();
  }
});

test('H1-1 scam-guard：活實例收到頁面偽造的交棒事件不退場，警示 tag 與 observer 都保留', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：命中並掛 tag');

    forgeAll(env.document, 'scam-guard');
    await wait(20);

    assert.equal(env.observers[0].disconnected, false, '偽造事件不得讓活實例斷開 observer（D1）');
    assert.equal(env.liveObservers().length, 1, '頁面上仍應有一個活著的 observer');
    assert.equal(env.tags().length, 1, '偽造事件不得收掉警示 tag');
    assert.equal(env.document.listenerCount(HANDOFF_EVENT), 1, '活實例的交棒監聽器應仍在');
  } finally {
    env.dispose();
  }
});

test('H1-1 bridge：活實例收到頁面偽造的交棒事件不下線，message listener 保留且照常轉發', async () => {
  const pageEnv = createPageEnv({ pathname: '/', page: createFeedPage(1) });
  const env = createBridgeEnvWithDocument(pageEnv.document);
  try {
    env.load();
    await wait(20);
    assert.equal(env.win.getMessageListenerCount(), 1, '前提：bridge 已註冊 message listener');
    assert.equal(pageEnv.document.listenerCount(HANDOFF_EVENT), 1, '前提：bridge 已註冊交棒監聽器');

    forgeAll(pageEnv.document, 'bridge');
    await wait(20);

    assert.equal(env.win.getMessageListenerCount(), 1, '偽造事件不得讓活的 bridge 下線（D1）');
    assert.equal(pageEnv.document.listenerCount(HANDOFF_EVENT), 1, '活實例的交棒監聽器應仍在');
    env.win.postMessage(CLEANED_NOTICE);
    await wait(30);
    assert.equal(
      env.sent.filter((m) => m && m.type === 'cleanedNotice').length,
      1,
      '偽造事件之後 bridge 仍應照常轉發淨化通知'
    );
  } finally {
    pageEnv.dispose();
  }
});

// ============================================================
// H1-2：同一 world 兩次載入，靠 world 全域握把取代（先呼叫握把再派事件）
// ============================================================

test('H1-2 post-icon：同一 world 兩次載入由握把取代——派交棒事件前舊實例已退場，之後只有一組 icon、一個 observer', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    const seen = probeAtHandoff(env.document, () => env.observers[0] && env.observers[0].disconnected);
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：第一個實例注入兩顆 icon');
    await wait(60);
    const firstHandle = env.sandbox.__tclPostIconDispose;
    assert.equal(typeof firstHandle, 'function', '前提：第一個實例掛上 world 全域握把');

    env.loadPostIcon();
    await wait(50);

    const secondAnnounce = seen[seen.length - 1];
    assert.ok(secondAnnounce, '第二個實例仍應派送交棒事件（跨 world 的孤兒靠它退場）');
    assert.equal(
      secondAnnounce.value,
      true,
      '新實例應先呼叫握把讓舊實例退場，再派交棒事件（派送當下舊 observer 已斷開）'
    );
    assert.notEqual(env.sandbox.__tclPostIconDispose, firstHandle, '握把應換成新實例的');
    assert.equal(env.observers[0].disconnected, true, '舊實例的 observer 應被斷開');
    assert.equal(env.liveObservers().length, 1, '頁面上只能有一個活著的 observer');
    assert.deepEqual(iconsPerCard(env), [1, 1], '每張卡恰好一顆 icon');
    // 探針自己佔一個，實例只剩新的那一個。
    assert.equal(env.document.listenerCount(HANDOFF_EVENT), 2, '交棒監聽器只留新實例的（另一個是測試探針）');
  } finally {
    env.dispose();
  }
});

test('H1-2 scam-guard：同一 world 兩次載入由握把取代——派交棒事件前舊實例已退場，之後只有一顆 tag、一個 observer', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    const seen = probeAtHandoff(env.document, () => env.observers[0] && env.observers[0].disconnected);
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：第一個實例命中並掛 tag');

    env.loadScamGuard();
    await wait(200);

    const secondAnnounce = seen[seen.length - 1];
    assert.ok(secondAnnounce, '第二個實例仍應派送交棒事件');
    assert.equal(
      secondAnnounce.value,
      true,
      '新實例應先呼叫 __tclScamGuardDispose 讓舊實例退場，再派交棒事件'
    );
    assert.equal(env.observers[0].disconnected, true, '舊實例的 observer 應被斷開');
    assert.equal(env.liveObservers().length, 1, '頁面上只能有一個活著的 observer');
    await waitFor(() => env.tags().length === 1, '交棒後恰好一顆 tag');
    assert.equal(env.document.listenerCount(HANDOFF_EVENT), 2, '交棒監聽器只留新實例的（另一個是測試探針）');
  } finally {
    env.dispose();
  }
});

test('H1-2 bridge：同一 world 兩次載入由握把取代——派交棒事件前舊實例已下線，之後只有一個 message listener', async () => {
  const pageEnv = createPageEnv({ pathname: '/', page: createFeedPage(1) });
  const env = createBridgeEnvWithDocument(pageEnv.document);
  try {
    const seen = probeAtHandoff(pageEnv.document, () => env.win.getMessageListenerCount());
    env.load();
    await wait(20);
    env.load();
    await wait(20);

    const secondAnnounce = seen[seen.length - 1];
    assert.ok(secondAnnounce, '第二個實例仍應派送交棒事件');
    assert.equal(
      secondAnnounce.value,
      0,
      '新實例應先呼叫 __tclBridgeDispose 讓舊實例下線，再派交棒事件（派送當下舊 message listener 已拆）'
    );
    assert.equal(env.win.getMessageListenerCount(), 1, '頁面上只能留一個 message listener');
    env.win.postMessage(CLEANED_NOTICE);
    await wait(30);
    assert.equal(
      env.sent.filter((m) => m && m.type === 'cleanedNotice').length,
      1,
      '一次淨化通知只應轉發一次'
    );
  } finally {
    pageEnv.dispose();
  }
});

// ============================================================
// H1-3：跨 world 重注入——舊實例活著時不理偽造事件，孤兒化後收到交棒事件
// 立即退場
// ============================================================

test('H1-3 post-icon：舊 world 活著時不理偽造事件；孤兒化後新 world 重注入，舊實例收事件立即退場，頁面只剩新的一組 icon', async () => {
  const oldWorld = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  const newWorld = createPageEnv({ pathname: '/', document: oldWorld.document });
  try {
    oldWorld.loadPostIcon();
    await waitFor(() => oldWorld.icons().length === 2, '前提：舊實例注入兩顆 icon');
    await wait(60);

    forgeHandoff(oldWorld.document, 'post-icon');
    await wait(20);
    assert.equal(oldWorld.liveObservers().length, 1, '活著的舊實例不得被偽造事件關掉（D1）');
    assert.equal(oldWorld.icons().length, 2, '活著的舊實例 icon 不得被收掉');
    const oldOwners = oldWorld.icons().map((icon) => icon.getAttribute('data-tcl-owner'));

    oldWorld.orphan();
    newWorld.loadPostIcon();
    await wait(50);

    assert.equal(oldWorld.liveObservers().length, 0, '孤兒化的舊實例應在收到交棒事件時就斷開 observer');
    assert.equal(newWorld.liveObservers().length, 1, '新 world 應有一個活著的 observer');
    assert.deepEqual(
      oldWorld.callsSinceOrphan().filter((p) => CHROME_API_PATH.test(p)),
      [],
      '舊 world 退場過程不得呼叫 chrome API'
    );
    assert.deepEqual(iconsPerCard(newWorld), [1, 1], '每張卡恰好一顆 icon');
    newWorld.icons().forEach((icon) => {
      assert.equal(oldOwners.includes(icon.getAttribute('data-tcl-owner')), false, '留下的 icon 應全屬新實例');
    });
  } finally {
    oldWorld.dispose();
    newWorld.dispose();
  }
});

test('H1-3 scam-guard：舊 world 活著時不理偽造事件；孤兒化後新 world 重注入，舊實例收事件立即退場，頁面只剩新的一顆 tag', async () => {
  const oldWorld = createPageEnv({ stubPostIcon: true });
  const newWorld = createPageEnv({ stubPostIcon: true, document: oldWorld.document });
  try {
    oldWorld.loadScamGuard();
    await waitFor(() => oldWorld.tags().length === 1, '前提：舊實例命中並掛 tag');

    forgeHandoff(oldWorld.document, 'scam-guard');
    await wait(20);
    assert.equal(oldWorld.liveObservers().length, 1, '活著的舊實例不得被偽造事件關掉（D1）');
    assert.equal(oldWorld.tags().length, 1, '活著的舊實例 tag 不得被收掉');

    oldWorld.orphan();
    newWorld.loadScamGuard();
    await wait(20);
    assert.equal(oldWorld.liveObservers().length, 0, '孤兒化的舊實例應在收到交棒事件時就斷開 observer');
    await waitFor(() => newWorld.tags().length === 1, '新實例掛上一顆 tag');
    assert.equal(newWorld.liveObservers().length, 1, '新 world 只有一個活著的 observer');
    assert.deepEqual(
      oldWorld.callsSinceOrphan().filter((p) => CHROME_API_PATH.test(p)),
      [],
      '舊 world 退場過程不得呼叫 chrome API'
    );
  } finally {
    oldWorld.dispose();
    newWorld.dispose();
  }
});

test('H1-3 bridge：舊 world 活著時不理偽造事件；孤兒化後新 world 重注入，舊實例收事件立即下線', async () => {
  const pageEnv = createPageEnv({ pathname: '/', page: createFeedPage(1) });
  const oldWorld = createBridgeEnvWithDocument(pageEnv.document);
  const newWorld = createBridgeEnvWithDocument(pageEnv.document);
  try {
    oldWorld.load();
    await wait(20);
    forgeHandoff(pageEnv.document, 'bridge');
    await wait(20);
    assert.equal(oldWorld.win.getMessageListenerCount(), 1, '活著的舊 bridge 不得被偽造事件關掉（D1）');

    oldWorld.orphan();
    newWorld.load();
    await wait(20);

    assert.equal(oldWorld.win.getMessageListenerCount(), 0, '孤兒化的舊 bridge 應在收到交棒事件時就拆掉 message listener');
    assert.equal(newWorld.win.getMessageListenerCount(), 1, '新 world 的 bridge 應註冊 message listener');
    assert.equal(pageEnv.document.listenerCount(HANDOFF_EVENT), 1, '交棒監聽器只留新實例的');
    assert.deepEqual(
      oldWorld.callsSinceOrphan().filter((p) => CHROME_API_PATH.test(p)),
      [],
      '舊 world 下線過程不得呼叫 chrome API'
    );
  } finally {
    pageEnv.dispose();
  }
});

test('H1-3 三支腳本：孤兒實例收到 detail 讀不到（null）的交棒事件也照樣退場', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  const scamEnv = createPageEnv({ stubPostIcon: true });
  const bridgeEnv = createBridgeEnvWithDocument(env.document);
  try {
    env.loadPostIcon();
    scamEnv.loadScamGuard();
    bridgeEnv.load();
    await waitFor(() => env.icons().length === 2, '前提：post-icon 注入兩顆 icon');
    await waitFor(() => scamEnv.tags().length === 1, '前提：scam-guard 掛 tag');
    await wait(60);

    env.orphan();
    scamEnv.orphan();
    bridgeEnv.orphan();
    forgeHandoff(env.document, 'post-icon', null);
    forgeHandoff(scamEnv.document, 'scam-guard', null);
    await wait(20);

    assert.equal(env.liveObservers().length, 0, 'post-icon 孤兒應退場');
    assert.equal(env.icons().length, 0, 'post-icon 孤兒應收掉自己的 icon');
    assert.equal(scamEnv.liveObservers().length, 0, 'scam-guard 孤兒應退場');
    assert.equal(scamEnv.tags().length, 0, 'scam-guard 孤兒應收掉自己的 tag');
    assert.equal(bridgeEnv.win.getMessageListenerCount(), 0, 'bridge 孤兒應下線');
  } finally {
    env.dispose();
    scamEnv.dispose();
  }
});

// ============================================================
// scam-guard 的 world 全域握把
// ============================================================

test('H1 scam-guard：載入後掛上 window.__tclScamGuardDispose，呼叫即退場（斷 observer、收 tag、拆交棒監聽器）', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：命中並掛 tag');

    const dispose = env.sandbox.__tclScamGuardDispose;
    assert.equal(typeof dispose, 'function', 'scam-guard 應在 world 全域掛上 __tclScamGuardDispose 握把');
    dispose();
    await wait(20);

    assert.equal(env.liveObservers().length, 0, '握把應讓實例斷開 observer');
    assert.equal(env.tags().length, 0, '握把應讓實例收掉自己掛的 tag');
    assert.equal(env.document.listenerCount(HANDOFF_EVENT), 0, '握把應讓實例拆掉交棒監聽器');
    assert.doesNotThrow(() => dispose(), '握把冪等，重複呼叫不得丟例外');
  } finally {
    env.dispose();
  }
});
