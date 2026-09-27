// test/script-handoff.test.js — 決策 S1 的交棒（R3）與冪等（R4）：同一頁面
// 上 post-icon.js／scam-guard.js 被載入兩次（手動 F5 × 自癒重注入的競態，
// 或擴充功能更新後的重注入）時，舊實例乾淨退場、新實例接手。
//
// ============================================================
// 【R3 契約：以 document 上的 CustomEvent 交棒】
//   - 新實例啟動時在 document 上 dispatch 一個 CustomEvent：
//       type   帶專案命名空間的字串（本檔以 /tcl|threads-clean-link/i 判定）；
//       detail { script: 腳本名, instanceId: 隨機字串 }。腳本名的欄位名
//              本檔接受 script／scriptName／name 三者之一，值須能辨識出
//              post-icon 或 scam-guard；instanceId 為非空字串且每次載入不同。
//   - 舊實例監聽同一事件，收到「同腳本名且 instanceId 不是自己」才退場
//     （別支腳本的事件、自己發的事件都不理會）。退場內容同 R1：斷
//     observer、清計時器、移除自己插入的節點與標記。
//   - cleanup 統一掛在一個 AbortController 上：交棒監聽器本身也隨退場移
//     除，頁面上同一事件的 document 監聽器只剩新實例那一個。
//   - post-icon 既有的 root.__tclPostIconDispose 可保留一版相容，但交棒
//     不得依賴它：擴充功能更新後，舊實例留在已失效的舊 ISOLATED world，
//     重注入的新實例跑在新 world，兩者只共用 DOM、不共用 window 全域——
//     本檔以「兩個 sandbox 共用同一個 document」模擬這個情境。
// 【R4】重注入後頁面上只有一組 icon／tag、只有一個活著的 observer，SPA
// 換頁後只有一個實例在掃描（只送一則 scam.hit）。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  CONTAINER_SELECTOR,
  ICON_CLASS,
  SECOND_PATH,
  SECOND_POSTS,
  TAG_CLASS,
  createDetailPage,
  createFeedPage,
  createPageEnv,
  wait,
  waitFor,
} = require('./support/reinject-harness');

const NAMESPACE = /tcl|threads-clean-link/i;
const SCRIPT_KEYS = ['script', 'scriptName', 'name'];

function scriptKeyOf(detail) {
  if (!detail || typeof detail !== 'object') return null;
  return SCRIPT_KEYS.find((key) => typeof detail[key] === 'string') || null;
}

// document 上派送過、形狀像交棒事件（detail 帶腳本名與 instanceId）且腳本
// 名符合 scriptPattern 的事件。
function handoffEvents(doc, scriptPattern) {
  return doc.dispatched.filter((event) => {
    const detail = event && event.detail;
    const key = scriptKeyOf(detail);
    return key !== null && scriptPattern.test(detail[key]) && typeof detail.instanceId === 'string';
  });
}

function assertHandoffShape(doc, scriptPattern, expectedCount, label) {
  const events = handoffEvents(doc, scriptPattern);
  assert.equal(
    events.length,
    expectedCount,
    `${label}：每次載入應在 document 上 dispatch 一個交棒 CustomEvent（detail 含腳本名與 instanceId）`
  );
  events.forEach((event) => {
    assert.equal(typeof event.type, 'string');
    assert.match(event.type, NAMESPACE, `${label}：事件名應帶專案命名空間`);
    assert.ok(event.detail.instanceId.length > 0, `${label}：instanceId 不得為空字串`);
  });
  return events;
}

function iconsPerCard(env) {
  return env.document
    .querySelectorAll(CONTAINER_SELECTOR)
    .map((card) => card.querySelectorAll('.' + ICON_CLASS).length);
}

// ============================================================
// post-icon.js：同一 world 載入兩次
// ============================================================

test('R3 post-icon：每次載入都在 document 上 dispatch 命名空間 CustomEvent，detail 帶腳本名與各自不同的 instanceId', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    env.loadPostIcon();
    const events = assertHandoffShape(env.document, /post-icon/, 2, 'post-icon');
    assert.equal(events[0].type, events[1].type, '兩次載入用同一個事件名');
    assert.notEqual(
      events[0].detail.instanceId,
      events[1].detail.instanceId,
      '兩個實例的 instanceId 必須不同'
    );
  } finally {
    env.dispose();
  }
});

test('R4 post-icon（回歸）：同一 world 載入兩次後，每張卡只有一顆 icon、只有一個活著的 observer', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：第一個實例注入兩顆 icon');
    env.loadPostIcon();
    await wait(50);

    assert.equal(env.observers.length, 2, '兩次載入各建立一個 observer');
    assert.equal(env.observers[0].disconnected, true, '舊實例的 observer 應被斷開');
    assert.equal(env.liveObservers().length, 1, '頁面上只能有一個活著的 observer');
    assert.deepEqual(iconsPerCard(env), [1, 1], '每張卡恰好一顆 icon，不重複');

    env.triggerObserver();
    await wait(120);
    assert.deepEqual(iconsPerCard(env), [1, 1], 'DOM 變動後仍然每張卡一顆');
  } finally {
    env.dispose();
  }
});

test('R3 post-icon：交棒不依賴 window.__tclPostIconDispose——拿掉全域握把，舊實例仍要靠 CustomEvent 退場', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：第一個實例注入兩顆 icon');
    // 必須在 context 內刪：vm 的全域代理不會把外部 delete 同步進去。
    vm.runInContext('delete window.__tclPostIconDispose', env.sandbox);
    assert.equal(typeof env.sandbox.__tclPostIconDispose, 'undefined', '前提：全域握把已拿掉');
    env.loadPostIcon();
    await wait(50);

    assert.equal(env.observers[0].disconnected, true, '舊實例應收到交棒事件而斷開 observer');
    assert.equal(env.liveObservers().length, 1, '頁面上只能有一個活著的 observer');
    assert.deepEqual(iconsPerCard(env), [1, 1], '每張卡恰好一顆 icon');
  } finally {
    env.dispose();
  }
});

test('R3 post-icon：只對「同腳本名、不同 instanceId」的交棒事件退場，自己發的與別支腳本的一律不理', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：注入兩顆 icon');
    const [own] = assertHandoffShape(env.document, /post-icon/, 1, 'post-icon');
    const key = scriptKeyOf(own.detail);

    // 自己的 instanceId：不得自我退場。
    env.document.dispatchEvent(
      new CustomEvent(own.type, { detail: Object.assign({}, own.detail) })
    );
    // 別支腳本（scam-guard）的交棒事件：不得退場。
    env.document.dispatchEvent(
      new CustomEvent(own.type, {
        detail: Object.assign({}, own.detail, {
          [key]: own.detail[key].replace(/post-icon/, 'scam-guard'),
          instanceId: 'foreign-instance',
        }),
      })
    );
    await wait(20);
    assert.equal(env.observers[0].disconnected, false, '自己或別支腳本的事件不得讓本實例退場');
    assert.equal(env.icons().length, 2, 'icon 不得被收掉');

    // 同腳本、不同 instanceId：退場。
    env.document.dispatchEvent(
      new CustomEvent(own.type, {
        detail: Object.assign({}, own.detail, { instanceId: 'newer-instance' }),
      })
    );
    await wait(20);
    assert.equal(env.observers[0].disconnected, true, '同腳本新實例的事件應讓本實例斷開 observer');
    assert.equal(env.icons().length, 0, '退場應移除本實例注入的 icon');
  } finally {
    env.dispose();
  }
});

test('R3 post-icon：cleanup 掛在 AbortController——交棒後交棒事件的 document 監聽器只剩一個，舊實例排下的計時器被清掉', async () => {
  const env = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  try {
    env.loadPostIcon();
    await waitFor(() => env.icons().length === 2, '前提：注入兩顆 icon');

    env.timers.setPhase('old-instance');
    env.triggerObserver();
    env.timers.setPhase('new-instance');
    assert.ok(
      env.timers.records.some((r) => r.phase === 'old-instance'),
      '前提：舊實例應排下一顆 debounce 計時器'
    );
    env.loadPostIcon();

    const [event] = handoffEvents(env.document, /post-icon/);
    assert.ok(event, '應有交棒事件可供辨識事件名');
    assert.equal(
      env.document.listenerCount(event.type),
      1,
      '舊實例的交棒監聽器應隨 AbortController 一起移除，只留新實例的'
    );
    assert.deepEqual(
      env.timers.pendingFrom('old-instance').map((r) => r.delay),
      [],
      '舊實例排下、尚未觸發的計時器應在退場時被取消'
    );
  } finally {
    env.dispose();
  }
});

// ============================================================
// post-icon.js：更新後重注入（舊 world 已孤兒、新 world 共用同一個 DOM）
// ============================================================

test('R3／R4 post-icon：重注入到新 world 時，舊 world 的孤兒實例立即退場（不等下一次 DOM 變動），頁面只剩新實例的一組 icon', async () => {
  const oldWorld = createPageEnv({ pathname: '/', page: createFeedPage(2) });
  const newWorld = createPageEnv({ pathname: '/', document: oldWorld.document });
  try {
    oldWorld.loadPostIcon();
    await waitFor(() => oldWorld.icons().length === 2, '前提：舊實例注入兩顆 icon');
    // 等舊實例的 storage 讀取回呼全部結算，免得孤兒化後由回呼觸發的掃描
    // 自檢先一步讓它退場，測不到「交棒事件」這條路。
    await wait(60);
    const oldOwners = oldWorld.icons().map((icon) => icon.getAttribute('data-tcl-owner'));

    oldWorld.orphan();
    newWorld.loadPostIcon();
    await wait(50);

    assert.equal(
      oldWorld.liveObservers().length,
      0,
      '舊 world 的 observer 應在收到交棒事件時就斷開（兩個 world 不共用 window 全域，只能靠 DOM 事件）'
    );
    assert.equal(newWorld.liveObservers().length, 1, '新 world 應有一個活著的 observer');
    assert.deepEqual(oldWorld.callsSinceOrphan().filter((p) => /^chrome\.(runtime|storage)\./.test(p)), [],
      '舊 world 退場過程不得呼叫 chrome API');
    assert.deepEqual(iconsPerCard(newWorld), [1, 1], '每張卡恰好一顆 icon');
    newWorld.icons().forEach((icon) => {
      assert.equal(
        oldOwners.includes(icon.getAttribute('data-tcl-owner')),
        false,
        '留在頁面上的 icon 應全部屬於新實例'
      );
    });
  } finally {
    oldWorld.dispose();
    newWorld.dispose();
  }
});

// ============================================================
// scam-guard.js：同一 world 載入兩次
// ============================================================

test('R3 scam-guard：每次載入都在 document 上 dispatch 命名空間 CustomEvent，detail 帶腳本名與各自不同的 instanceId', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    env.loadScamGuard();
    const events = assertHandoffShape(env.document, /scam-guard/, 2, 'scam-guard');
    assert.equal(events[0].type, events[1].type, '兩次載入用同一個事件名');
    assert.notEqual(events[0].detail.instanceId, events[1].detail.instanceId, 'instanceId 必須不同');
  } finally {
    env.dispose();
  }
});

test('R3 scam-guard：同一 world 載入兩次後，只有一個活著的 observer、交棒監聽器只剩一個', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：第一個實例命中並掛 tag');
    env.loadScamGuard();
    await wait(150);

    assert.equal(env.observers.length, 2, '兩次載入各建立一個 observer');
    assert.equal(env.observers[0].disconnected, true, '舊實例的 observer 應被斷開（現況沒有任何交棒）');
    assert.equal(env.liveObservers().length, 1, '頁面上只能有一個活著的 observer');

    const [event] = handoffEvents(env.document, /scam-guard/);
    assert.ok(event, '應有交棒事件可供辨識事件名');
    assert.equal(env.document.listenerCount(event.type), 1, '交棒事件的 document 監聽器只留新實例的');
  } finally {
    env.dispose();
  }
});

test('R4 scam-guard（回歸）：同一 world 載入兩次後，頁面上只有一顆警示 tag', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：第一個實例命中並掛 tag');
    env.loadScamGuard();
    await wait(200);
    await waitFor(() => env.tags().length === 1, '交棒後應恰好一顆 tag');
    env.triggerObserver();
    await wait(150);
    assert.equal(env.tags().length, 1, '交棒並經過一次 DOM 變動後仍只有一顆 tag');
  } finally {
    env.dispose();
  }
});

test('R3／R4 scam-guard：同一 world 載入兩次後 SPA 換頁，只有一個實例掃描（只送一則新的 scam.hit、只掛一顆 tag）', async () => {
  const env = createPageEnv({ stubPostIcon: true });
  try {
    env.loadScamGuard();
    await waitFor(() => env.tags().length === 1, '前提：第一個實例命中並掛 tag');
    env.loadScamGuard();
    await wait(200);
    const hitsBefore = env.hits().length;

    env.setPathname(SECOND_PATH);
    env.setPage(createDetailPage(SECOND_POSTS));
    env.triggerObserver();
    await wait(250);

    assert.equal(env.hits().length - hitsBefore, 1, '換頁後只應有一個實例送出 scam.hit（現況兩個 observer 各送一則）');
    assert.equal(env.tags().length, 1, '新頁只掛一顆 tag');
  } finally {
    env.dispose();
  }
});

// ============================================================
// scam-guard.js：更新後重注入（舊 world 已孤兒、新 world 共用同一個 DOM）
// ============================================================

test('R3／R4 scam-guard：重注入到新 world 時，舊 world 的孤兒實例立即退場並收掉自己的 tag，頁面只剩新實例掛的一顆', async () => {
  const oldWorld = createPageEnv({ stubPostIcon: true });
  const newWorld = createPageEnv({ stubPostIcon: true, document: oldWorld.document });
  try {
    oldWorld.loadScamGuard();
    await waitFor(() => oldWorld.tags().length === 1, '前提：舊實例命中並掛 tag');

    oldWorld.orphan();
    newWorld.loadScamGuard();
    await wait(20);
    assert.equal(
      oldWorld.liveObservers().length,
      0,
      '舊 world 的 observer 應在收到交棒事件時就斷開（不等下一次 DOM 變動）'
    );
    await waitFor(() => newWorld.hits().length === 1, '新實例應重新判定並送出 scam.hit');
    await waitFor(() => newWorld.tags().length === 1, '新實例掛上一顆 tag');

    newWorld.setPathname(SECOND_PATH);
    oldWorld.setPathname(SECOND_PATH);
    newWorld.setPage(createDetailPage(SECOND_POSTS));
    oldWorld.triggerObserver();
    newWorld.triggerObserver();
    await wait(250);

    assert.deepEqual(
      oldWorld.callsSinceOrphan().filter((p) => /^chrome\.(runtime|storage)\./.test(p)),
      [],
      '舊 world 退場後不得呼叫 chrome API'
    );
    assert.equal(newWorld.liveObservers().length, 1, '新 world 只有一個活著的 observer');
    assert.equal(newWorld.document.querySelectorAll('.' + TAG_CLASS).length, 1, '新頁只掛一顆 tag');
  } finally {
    oldWorld.dispose();
    newWorld.dispose();
  }
});
