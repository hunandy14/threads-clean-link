// test/message-router.test.js — background.js 單一 runtime.onMessage 路由的
// 入口契約：未知類型、原型鍵、寄件者被拒一律回 false 且不呼叫 sendResponse，
// 也不碰引擎或 storage。各路由成功／失敗的回應形狀由 background.test.js 負責。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');

const EXT_ID = 'router-test-extension-id';
const EXT_PAGE_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };
const SCAM_TAB_SENDER = { id: EXT_ID, tab: { id: 7 }, url: 'https://www.threads.com/@someone' };
const CONTENT_SCRIPT_ELSEWHERE = { id: EXT_ID, tab: { id: 8 }, url: 'https://example.com/' };
const OTHER_EXTENSION_SENDER = { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', url: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.html' };

const SYNC_TYPES = [
  'sync.getState',
  'sync.signIn',
  'sync.signOut',
  'sync.now',
  'sync.deleteCloud',
  'sync.devices.list',
  'sync.devices.rename',
  'sync.devices.remove',
];

// 每個 type 的合法寄件者與一組應被拒的寄件者。
const CASES = [
  { type: 'resolveShare', ok: EXT_PAGE_SENDER, rejected: [OTHER_EXTENSION_SENDER, undefined, {}] },
  { type: 'cleanedNotice', ok: EXT_PAGE_SENDER, rejected: [OTHER_EXTENSION_SENDER, undefined, {}] },
  ...SYNC_TYPES.map((type) => ({
    type,
    ok: EXT_PAGE_SENDER,
    rejected: [SCAM_TAB_SENDER, OTHER_EXTENSION_SENDER, undefined],
  })),
  {
    type: 'scam.hit',
    ok: SCAM_TAB_SENDER,
    rejected: [EXT_PAGE_SENDER, CONTENT_SCRIPT_ELSEWHERE, OTHER_EXTENSION_SENDER, undefined],
  },
  { type: 'scam.blocklist.remove', ok: EXT_PAGE_SENDER, rejected: [SCAM_TAB_SENDER, OTHER_EXTENSION_SENDER, undefined] },
  { type: 'scam.blocklist.restore', ok: EXT_PAGE_SENDER, rejected: [SCAM_TAB_SENDER, OTHER_EXTENSION_SENDER, undefined] },
];

// 載入 background.js。withEngine 為 true 時注入假 TCLSync，引擎的每次方法呼叫
// 都記進 engineCalls；fetch 與 storage 寫入一併側錄，供「被拒時什麼都沒碰」斷言。
// 載入期的啟動動作（例如 verifySession）結算完才清空側錄，只留訊息引發的呼叫。
async function loadBackground({ withEngine = true } = {}) {
  const listeners = [];
  const engineCalls = [];
  const fetchCalls = [];
  const storage = createChromeStorage({}, {});
  const chrome = {
    runtime: {
      id: EXT_ID,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => Promise.resolve(undefined),
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1, query: async () => [] },
    alarms: {
      create: () => {},
      clear: async () => true,
      get: async () => undefined,
      getAll: async () => [],
      onAlarm: { addListener: () => {} },
    },
    storage: storage.api,
  };
  const engine = new Proxy(
    {},
    {
      get: (_, name) => (...args) => {
        engineCalls.push({ name, args });
        return Promise.resolve({ ok: true });
      },
    }
  );
  const sandbox = {
    chrome,
    fetch: async (url) => {
      fetchCalls.push(url);
      throw new Error('fetch 不該被呼叫');
    },
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
    AbortController,
    AbortSignal,
  };
  if (withEngine) sandbox.TCLSync = { create: () => engine };
  loadSwSources(sandbox);
  assert.equal(listeners.length, 1, 'background.js 只註冊一支 onMessage 監聽器');
  await settle();
  engineCalls.length = 0;
  fetchCalls.length = 0;
  storage.localCalls.set.length = 0;
  return { listener: listeners[0], engineCalls, fetchCalls, storage };
}

// 等所有 storage 假實作的 setTimeout(0) 與後續 microtask 結算完畢。
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// 送一則訊息，回傳 listener 的回傳值與 sendResponse 被呼叫的次數。
function dispatch(bg, message, sender) {
  const responses = [];
  const returned = bg.listener(message, sender, (response) => responses.push(response));
  return { returned, responses };
}

function assertUntouched(bg, label) {
  assert.deepEqual(bg.engineCalls, [], `${label}：不得碰引擎`);
  assert.deepEqual(bg.fetchCalls, [], `${label}：不得發網路請求`);
  assert.deepEqual(bg.storage.localCalls.set, [], `${label}：不得寫 storage.local`);
}

test('未知 type 回 false，不呼叫 sendResponse，也不碰任何東西', async () => {
  const bg = await loadBackground();
  const messages = [
    { type: 'nope' },
    { type: 'sync.unknown' },
    { type: 'scam.blocklist' },
    { type: '' },
    { type: 42 },
    { type: null },
    {},
    null,
    undefined,
    'resolveShare',
  ];
  for (const message of messages) {
    for (const sender of [EXT_PAGE_SENDER, SCAM_TAB_SENDER]) {
      const { returned, responses } = dispatch(bg, message, sender);
      assert.equal(returned, false, `${JSON.stringify(message)} 應回 false`);
      await settle();
      assert.deepEqual(responses, [], `${JSON.stringify(message)} 不得呼叫 sendResponse`);
    }
  }
  assertUntouched(bg, '未知 type');
});

test('原型鍵（constructor、__proto__ 等）不會命中任何路由', async () => {
  const bg = await loadBackground();
  const protoKeys = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
  for (const type of protoKeys) {
    for (const sender of [EXT_PAGE_SENDER, SCAM_TAB_SENDER, OTHER_EXTENSION_SENDER]) {
      let returned;
      assert.doesNotThrow(() => {
        ({ returned } = dispatch(bg, { type }, sender));
      }, `${type} 不得讓 listener 拋錯`);
      assert.equal(returned, false, `${type} 應回 false`);
    }
  }
  await settle();
  assertUntouched(bg, '原型鍵');
});

for (const { type, ok, rejected } of CASES) {
  test(`${type}：寄件者被拒時回 false，不呼叫 sendResponse，不碰引擎與 storage`, async () => {
    const bg = await loadBackground();
    for (const sender of rejected) {
      const { returned, responses } = dispatch(bg, { type, url: 'https://www.threads.com/share/X' }, sender);
      assert.equal(returned, false, `${type} 對 ${JSON.stringify(sender)} 應回 false`);
      await settle();
      assert.deepEqual(responses, [], `${type} 對 ${JSON.stringify(sender)} 不得回應`);
    }
    assertUntouched(bg, type);

    // 對照組：合法寄件者確實會被這條路由接手，上面的 false 不是因為 type 本身沒掛上。
    const { returned } = dispatch(bg, { type }, ok);
    assert.equal(returned, type !== 'cleanedNotice', `${type} 對合法寄件者的回傳值`);
  });
}

test('sync.*：沒有引擎時視同未知類型，回 false 且不回應', async () => {
  const bg = await loadBackground({ withEngine: false });
  for (const type of SYNC_TYPES) {
    const { returned, responses } = dispatch(bg, { type }, EXT_PAGE_SENDER);
    assert.equal(returned, false, `${type} 沒有引擎應回 false`);
    await settle();
    assert.deepEqual(responses, [], `${type} 沒有引擎不得回應`);
  }
});

test('cleanedNotice：合法寄件者也不回應（背景執行），listener 回 false', async () => {
  const bg = await loadBackground();
  const { returned, responses } = dispatch(bg, { type: 'cleanedNotice' }, EXT_PAGE_SENDER);
  assert.equal(returned, false);
  await settle();
  assert.deepEqual(responses, []);
});
