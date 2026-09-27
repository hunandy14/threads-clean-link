// test/storage-mutate-callers.test.js — SW-1b：background 與 sync 的讀改寫改走
// TCLCore.createMutator 之後，呼叫端的行為契約。
//
// 規格：simplify/design-sw.md §1。
//   - background 6 處（recordHistory、migrateHistoryMerge、migrateHistorySchema、
//     handleScamHit、Remove、Restore）與 sync 4 處（dropUnsendable、applyResponse、
//     applyMarkChanges、resetMirrorFields）共用一條序列佇列與一份 mutate 模板。
//   - 行為變更（§1.2）：recordHistory 撞配額先以 cap level 1 收緊再寫一次（多
//     淘汰舊紀錄），不再放棄本筆；Restore 條目不存在時不寫。
//   - 不退步：sync applyResponse／applyMarkChanges 撞配額仍記 storage_quota，
//     游標不前進。
//
// harness：background 部分比照 test/message-router.test.js 的精簡載入器；sync
// 部分（createSyncStorage／createAlarmsMock／createAuthMock／localEntry／
// localEvidence／blocklist／signedInState／makeEnv／settle）逐字取自
// test/sync-marks.test.js，兩邊修改時需同步。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./support/helpers');
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');

const REPO_ROOT = path.join(__dirname, '..');
const BG_SRC = ['i18n.js', 'tcl-core.js', 'background.js']
  .map((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
  .join('\n');

function loadSync() {
  return require('../sync.js');
}

// tcl-core 的 isQuotaExceededError 以訊息含 QUOTA_BYTES 辨識。
function quotaError() {
  return new Error('QUOTA_BYTES quota exceeded');
}

function realDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// background harness
// ============================================================================

const EXT_ID = 'mutate-test-extension-id';
const HISTORY_KEY = 'history';
const DEVICE_KEY = 'syncDevice';
const SCAM_KEY = 'scamBlocklist';
const SEEDED_DEVICE = {
  deviceId: '11111111-2222-4333-8444-555555555555',
  platform: 'chrome_extension',
  createdAt: 1700000000000,
};

const POST_1 = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';
const POST_2 = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvQ';
const POST_3 = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvR';

const SCAM_USER_ID = '10000000001';
const SCAM_HANDLE = 'example_author';
const SCAM_POST_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const SCAM_AT = 1700000100000;

function scamHit(overrides) {
  return Object.assign(
    {
      type: 'scam.hit',
      userId: SCAM_USER_ID,
      handle: SCAM_HANDLE,
      displayName: 'Example Author',
      postUrl: SCAM_POST_URL,
      snippet: '不報明牌、不收費、不代操，加我 賴：ex01abc 聊黑馬股',
      anchorMatch: '賴：ex01abc',
      pitchMatches: ['黑馬股', '報明牌'],
      at: SCAM_AT,
    },
    overrides || {}
  );
}

// 載入 background.js。saveHistory 開啟、裝置身分預填（首次記錄不搭便車寫
// syncDevice），引擎以 Proxy 替身代打。載入期的啟動動作結算完才清空 set 側錄。
// recordHistory／handleScamHit／handleScamBlocklistRestore 是腳本頂層的函式
// 宣告，直接從沙箱全域呼叫（繞過 og fetch 與路由表，只測讀改寫本身）。
async function loadBackground(localSeed = {}) {
  const storage = createChromeStorage(
    { saveHistory: true },
    Object.assign({ [DEVICE_KEY]: SEEDED_DEVICE }, localSeed)
  );
  const engine = new Proxy({}, { get: () => () => Promise.resolve({ ok: true }) });
  const chrome = {
    runtime: {
      id: EXT_ID,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
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
  const sandbox = {
    chrome,
    TCLSync: { create: () => engine },
    fetch: async () => {
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
  runInSandbox(BG_SRC, sandbox);
  await realDelay(40);
  storage.localCalls.set.length = 0;
  return { sandbox, storage };
}

function setsTo(bg, key) {
  return bg.storage.localCalls.set.filter((items) => Object.prototype.hasOwnProperty.call(items, key));
}

function seedHistory(count) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://www.threads.com/@seeduser/post/P${i}`,
    kind: 'share',
    at: 1000 + count - i,
  }));
}

// ---- recordHistory 撞配額：收緊再寫，本筆保留（§1.2 行為變更） ----

test('B1 recordHistory 撞配額：第二次 set 為 level 1 收緊後內容（筆數較少），本筆仍保留在最前', async () => {
  // 10000 筆（筆數硬上限）＋本筆 → level 0 裁成 10000 筆；level 1 以
  // maxEntries×0.9 收緊，筆數必然更少。
  const bg = await loadBackground({ [HISTORY_KEY]: seedHistory(10000) });
  const originalSet = bg.storage.local.set;
  let n = 0;
  bg.storage.local.set = function (items) {
    n += 1;
    if (n === 1) {
      bg.storage.localCalls.set.push(Object.assign({}, items));
      return Promise.reject(quotaError());
    }
    return originalSet.apply(this, arguments);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await bg.sandbox.recordHistory(POST_1, 'share', {});
    await realDelay(30);
  } finally {
    console.warn = warn;
  }

  const writes = setsTo(bg, HISTORY_KEY);
  assert.equal(writes.length, 2, '撞配額後要以收緊的內容再寫一次（原行為：放棄本筆、只寫一次）');
  const first = writes[0][HISTORY_KEY];
  const second = writes[1][HISTORY_KEY];
  assert.ok(second.length < first.length, `第二次應收緊：${second.length} 應少於 ${first.length}`);
  assert.equal(second[0].url, POST_1, '本筆保留在最前，被淘汰的是舊紀錄');
  const stored = bg.storage.localSnapshot()[HISTORY_KEY];
  assert.equal(stored[0].url, POST_1, '收緊後的內容落地');
  assert.equal(stored.length, second.length);
});

// ---- Restore 條目不存在：不寫（§1.2 行為變更） ----

test('B6 handleScamBlocklistRestore：條目不存在時 storage.set 零次，仍回 ok', async () => {
  const bg = await loadBackground({
    [SCAM_KEY]: { version: 2, entries: {}, handleIndex: {} },
  });
  const res = await bg.sandbox.handleScamBlocklistRestore({ type: 'scam.blocklist.restore', userId: SCAM_USER_ID });
  await realDelay(30);
  assert.equal(res && res.ok, true, '沒有條目可復原不是錯誤');
  assert.equal(setsTo(bg, SCAM_KEY).length, 0, '條目不存在時不得白寫一次整份名單');
});

test('B6 handleScamBlocklistRestore：名單整把鍵缺席時同樣不寫', async () => {
  const bg = await loadBackground({});
  await bg.sandbox.handleScamBlocklistRestore({ type: 'scam.blocklist.restore', userId: SCAM_USER_ID });
  await realDelay(30);
  assert.equal(setsTo(bg, SCAM_KEY).length, 0);
});

// ---- 佇列順序：recordHistory 與 handleScamHit 交錯 ----

test('SQ background 寫入次序等於排隊次序：recordHistory×3 與 handleScamHit 交錯', async () => {
  const bg = await loadBackground({});
  const originalSet = bg.storage.local.set;
  // 第一次 history 寫入卡在閘門上，讓後面的工作全部排進佇列再一起放行。
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let gated = false;
  bg.storage.local.set = function (items) {
    const args = arguments;
    const self = this;
    if (!gated && Object.prototype.hasOwnProperty.call(items, HISTORY_KEY)) {
      gated = true;
      return gate.then(() => originalSet.apply(self, args));
    }
    return originalSet.apply(this, args);
  };

  const r1 = bg.sandbox.recordHistory(POST_1, 'share', {});
  for (let i = 0; i < 100 && !gated; i++) await realDelay(5);
  assert.ok(gated, '前置條件：第一筆紀錄寫入已卡在閘門上');
  // handleScamHit 排隊前還有非同步前置（總開關讀取），給足時間讓它排進去。
  const hit = bg.sandbox.handleScamHit(scamHit());
  await realDelay(60);
  const r2 = bg.sandbox.recordHistory(POST_2, 'share', {});
  const r3 = bg.sandbox.recordHistory(POST_3, 'share', {});
  release();
  await Promise.all([r1, hit, r2, r3]);
  await realDelay(30);

  const order = bg.storage.localCalls.set
    .map((items) => {
      if (Object.prototype.hasOwnProperty.call(items, SCAM_KEY)) return 'scam';
      if (Object.prototype.hasOwnProperty.call(items, HISTORY_KEY)) return 'history:' + items[HISTORY_KEY][0].url;
      return null;
    })
    .filter((x) => x !== null);
  assert.deepEqual(order, ['history:' + POST_1, 'scam', 'history:' + POST_2, 'history:' + POST_3]);
  const snap = bg.storage.localSnapshot();
  assert.equal(snap[HISTORY_KEY].length, 3, '三筆紀錄都保住，沒有互相覆蓋');
  assert.ok(snap[SCAM_KEY].entries[SCAM_USER_ID], '名單那一筆沒有被紀錄寫入蓋掉');
});

// ---- 原始碼守衛 ----

test('SRC background.js 不再有手寫的 historyWriteChain 讀改寫鏈', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'background.js'), 'utf8');
  const hits = src.match(/historyWriteChain\s*=\s*historyWriteChain\s*\.then/g) || [];
  assert.equal(hits.length, 0, '三處手寫鏈（recordHistory、migrateHistoryMerge、migrateHistorySchema）應統一走 enqueue');
});

test('SRC background.js 以 TCLCore 工廠建立佇列與 mutate；sync.js 以 createMutator 自建 mutate', () => {
  const bg = fs.readFileSync(path.join(REPO_ROOT, 'background.js'), 'utf8');
  const sync = fs.readFileSync(path.join(REPO_ROOT, 'sync.js'), 'utf8');
  assert.ok(/TCLCore\.createSerialQueue\(/.test(bg), 'background.js 應以 TCLCore.createSerialQueue() 建佇列');
  assert.ok(/TCLCore\.createMutator\(/.test(bg), 'background.js 應以 TCLCore.createMutator() 建 mutate');
  assert.ok(/createMutator\(/.test(sync), 'sync.js 應以 createMutator() 自建 mutate（enqueue 用注入的 writeChain）');
});

// ============================================================================
// sync harness（逐字取自 test/sync-marks.test.js）
// ============================================================================

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function createSyncStorage(localSeed = {}, sessionSeed = {}) {
  const chainDepth = { value: 0 };
  const writes = [];
  let seq = 0;

  function later(fn) {
    setImmediate(fn);
  }

  function makeArea(name, seed) {
    const data = JSON.parse(JSON.stringify(seed));

    function read(keys) {
      if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(data));
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: data[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
        });
        return out;
      }
      const out = Object.assign({}, keys);
      Object.keys(keys).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
      });
      return out;
    }

    return {
      data,
      api: {
        get(keys) {
          return new Promise((resolve) => later(() => resolve(read(keys))));
        },
        set(items) {
          seq += 1;
          writes.push({
            area: name,
            keys: Object.keys(items),
            inChain: chainDepth.value > 0,
            seq,
          });
          return new Promise((resolve) =>
            later(() => {
              Object.assign(data, items);
              resolve();
            })
          );
        },
        remove(keys) {
          seq += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          writes.push({ area: name, keys: list, removed: true, inChain: chainDepth.value > 0, seq });
          return new Promise((resolve) =>
            later(() => {
              list.forEach((k) => delete data[k]);
              resolve();
            })
          );
        },
      },
    };
  }

  const local = makeArea('local', localSeed);
  const session = makeArea('session', sessionSeed);

  return {
    api: { local: local.api, session: session.api },
    localData: local.data,
    writes,
    chainDepth,
    syncState() {
      return local.data.syncState || null;
    },
    syncAuth() {
      return local.data.syncAuth || null;
    },
    blocklist() {
      return local.data.scamBlocklist || null;
    },
    entries() {
      const list = local.data.scamBlocklist;
      return (list && list.entries) || {};
    },
    writesTo(key) {
      return writes.filter((w) => w.area === 'local' && w.keys.indexOf(key) !== -1);
    },
  };
}

function createAlarmsMock() {
  const calls = [];
  return {
    calls,
    api: {
      create(name, info) {
        calls.push({ op: 'create', name, info: Object.assign({}, info) });
      },
      clear(name) {
        calls.push({ op: 'clear', name });
        return Promise.resolve(true);
      },
      get() {
        return Promise.resolve(undefined);
      },
      getAll() {
        return Promise.resolve([]);
      },
    },
    lastCreate() {
      const list = calls.filter((c) => c.op === 'create');
      return list[list.length - 1] || null;
    },
  };
}

// TCLAuth 的替身（只保留 marks 測試會用到的登入往返，形狀比照 test/sync.test.js）。
function createAuthMock(server) {
  const calls = { signIn: [], exchange: [] };
  return {
    calls,
    signInWithGoogle(options) {
      calls.signIn.push(options);
      return Promise.resolve({
        idToken: 'fake.id.token',
        nonce: 'nonce-from-auth',
        email: 'someone@example.com',
        payload: { sub: 'user-abc', email: 'someone@example.com' },
      });
    },
    exchangeWithBackend(options) {
      calls.exchange.push(options);
      const url = String(options.apiBase).replace(/\/+$/, '') + '/api/auth/sign-in/social';
      return server
        .fetch(url, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'google',
            idToken: { token: options.idToken, nonce: options.nonce },
          }),
        })
        .then((res) =>
          res.json().then((body) => ({
            status: res.status,
            ok: res.ok,
            authToken: res.headers.get('set-auth-token'),
            body,
          }))
        );
    },
    permissionsFor(apiBase) {
      return { permissions: ['identity'], origins: [String(apiBase).replace(/\/$/, '') + '/*'] };
    },
  };
}

// ---- 本機資料建構 ----

/** 本機 v2 黑名單條目（docs/cloud-sync.md §4.5）。缺席的選填欄位就是不寫鍵。 */
function localEntry(over = {}) {
  const updatedAt = over.updatedAt !== undefined ? over.updatedAt : T0 - 3 * DAY;
  return Object.assign(
    {
      state: 'active',
      handle: 'alice',
      source: 'auto',
      addedAt: T0 - 5 * DAY,
      updatedAt,
      evidence: [],
    },
    over
  );
}

/** 本機證據（缺席即不寫鍵，與雲端「可空寫 null」是兩回事）。 */
function localEvidence(over = {}) {
  return Object.assign({ postUrl: POST_A, snippet: '本機片段', at: T0 - 5 * DAY }, over);
}

/** v2 scamBlocklist：handleIndex 由 entries 派生，version 與 handleIndex 都不上雲。 */
function blocklist(entries) {
  const handleIndex = {};
  Object.keys(entries).forEach((id) => {
    const handle = entries[id].handle;
    if (typeof handle === 'string') handleIndex[handle.toLowerCase()] = id;
  });
  return { version: 2, entries, handleIndex };
}

function signedInState(over = {}) {
  return Object.assign(
    {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: '0',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
      marksCursor: null,
      marksEvicted: null,
    },
    over
  );
}

/**
 * 組一整套注入環境。`failPath` 讓故障綁在**路徑**上而不是「下一次請求」——
 * links 與 marks 在同一輪各發各的請求，用全域的 failNext 會綁不住是哪一條。
 */
function makeEnv(opts = {}) {
  // opts.shareWith：與另一個 env 共用同一台 mock 伺服器與時鐘（D50 的多裝置
  // 情境）。第二台的 token 走 issueSession，不頂掉第一台那一枚。
  const clock = opts.shareWith ? opts.shareWith.clock : { t: opts.startAt || T0 };
  const now = () => clock.t;
  const server = opts.shareWith ? opts.shareWith.server : createMockSyncServer(Object.assign({ now }, opts.server));

  const localSeed = Object.assign({}, opts.local);
  if (opts.blocklist !== undefined) localSeed.scamBlocklist = opts.blocklist;
  if (opts.history !== undefined) localSeed.history = opts.history;
  if (opts.scamGuardEnabled !== undefined) localSeed.scamGuardEnabled = opts.scamGuardEnabled;
  if (opts.signedIn) {
    localSeed.syncAuth = { token: opts.shareWith ? server.issueSession() : server.grantToken('tok-seeded') };
    localSeed.syncState = signedInState(opts.syncState);
  }

  const storage = createSyncStorage(localSeed, opts.session);
  const alarms = createAlarmsMock();
  const broadcasts = [];
  const auth = createAuthMock(server);

  const pathFailures = new Map();
  function fetchImpl(input, init) {
    const path = new URL(String(input)).pathname;
    const queue = pathFailures.get(path);
    // failNext 是全域佇列，但這裡緊接著就同步呼叫 server.fetch，中間沒有
    // await，因此注入的故障必定落在這一次請求上。
    if (queue && queue.length) server.failNext(queue.shift(), 1);
    return server.fetch(input, init);
  }

  let uuidSeq = 0;
  const deps = {
    storage: storage.api,
    fetch: fetchImpl,
    now,
    alarms: alarms.api,
    broadcast: (message) => broadcasts.push(message),
    auth,
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
    },
    randomUUID: () => `uuid-${(uuidSeq += 1)}`,
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: () => {},
    writeChain: (fn) => {
      storage.chainDepth.value += 1;
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          storage.chainDepth.value -= 1;
        });
    },
  };

  return {
    clock,
    now,
    server,
    storage,
    alarms,
    broadcasts,
    auth,
    deps,
    advance(ms) {
      clock.t += ms;
    },
    failPath(path, failure, times = 1) {
      if (!pathFailures.has(path)) pathFailures.set(path, []);
      const queue = pathFailures.get(path);
      for (let i = 0; i < times; i += 1) queue.push(Object.assign({}, failure));
    },
    lastState() {
      const list = broadcasts.filter((m) => m && m.type === 'sync.stateChanged');
      return list.length ? list[list.length - 1].state : null;
    },
    marksPosts() {
      return server.requestsTo('/api/v1/marks/sync', 'POST');
    },
    marksGets() {
      return server.requestsTo('/api/v1/marks', 'GET');
    },
    linkPosts() {
      return server.requestsTo('/api/v1/links/sync', 'POST');
    },
    /** 把一輪的 upserts 攤平成 key → Mark。 */
    upsertsByKey() {
      const out = {};
      server.requestsTo('/api/v1/marks/sync', 'POST').forEach((req) => {
        ((req.body && req.body.upserts) || []).forEach((mark) => {
          out[mark.key] = mark;
        });
      });
      return out;
    },
  };
}

/** 讓所有 setImmediate 排程的 storage 結算跑完。 */
async function settle(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// storage.local.set 寫入指定鍵時依 failFor(n) 決定要不要拋配額錯誤（n 為該鍵
// 第幾次寫入，從 1 起算）；其他鍵照常落地。
function depsWithQuotaOn(env, key, failFor) {
  const attempts = { count: 0 };
  const local = env.deps.storage.local;
  const deps = Object.assign({}, env.deps, {
    storage: {
      session: env.deps.storage.session,
      local: Object.assign({}, local, {
        set(items) {
          if (Object.prototype.hasOwnProperty.call(items, key)) {
            attempts.count += 1;
            if (failFor(attempts.count)) return Promise.reject(quotaError());
          }
          return local.set(items);
        },
      }),
    },
  });
  return { deps, attempts };
}

function seedLinkPull(env) {
  env.server.seed([
    { id: 'srv-b', original: POST_B, cleaned: POST_B, receivedAt: T0 - 20_000, seen: [{ at: T0 - 20_000 }] },
  ]);
}

const REMOTE_MARK = {
  key: 'threads:2001',
  state: 'active',
  handle: 'erin',
  source: 'manual',
  addedAt: T0 - 2 * DAY,
  updatedAt: T0 - 2 * DAY,
  evidence: [],
};

// ---- S2 applyResponse ----

test('S2 applyResponse 撞配額（持續）：仍記 storage_quota，游標不前進，history 沒落地', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, syncState: { cursor: '0' }, history: [] });
  seedLinkPull(env);
  const { deps, attempts } = depsWithQuotaOn(env, 'history', () => true);
  await TCLSync.create(deps).syncNow();
  await settle();

  assert.ok(attempts.count >= 1, '前置條件：拉到的紀錄確實觸發 history 寫入');
  assert.equal(env.storage.syncState().cursor, '0', 'history 沒落地，游標不得前進');
  assert.equal(env.storage.syncState().lastError, 'storage_quota');
  assert.deepEqual(env.storage.localData.history, [], '本輪什麼都沒寫進去');
});

test('S2 applyResponse 撞配額（持續）：以 cap level 1 收緊重寫一次後才放棄', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, syncState: { cursor: '0' }, history: [] });
  seedLinkPull(env);
  const { deps, attempts } = depsWithQuotaOn(env, 'history', () => true);
  await TCLSync.create(deps).syncNow();
  await settle();
  assert.equal(attempts.count, 2, 'level 0 失敗後以 level 1 收緊再寫一次，仍失敗才拋 storage_quota');
});

test('S2 applyResponse 只有第一次撞配額：收緊重寫成功，游標前進、lastError 清空', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, syncState: { cursor: '0' }, history: [] });
  seedLinkPull(env);
  const { deps, attempts } = depsWithQuotaOn(env, 'history', (n) => n === 1);
  await TCLSync.create(deps).syncNow();
  await settle();
  assert.equal(attempts.count, 2);
  assert.equal(env.storage.localData.history.length, 1, '收緊後那一頁落地');
  assert.notEqual(env.storage.syncState().cursor, '0', '落地了游標就該前進');
  assert.equal(env.storage.syncState().lastError, null);
});

// ---- S3 applyMarkChanges ----

function makeMarksEnv() {
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0' },
    blocklist: blocklist({}),
  });
  env.server.marks.seed([REMOTE_MARK]);
  return env;
}

test('S3 applyMarkChanges 撞配額（持續）：仍記 storage_quota，marksCursor 不前進，名單沒落地', async () => {
  const TCLSync = loadSync();
  const env = makeMarksEnv();
  const { deps, attempts } = depsWithQuotaOn(env, 'scamBlocklist', () => true);
  await TCLSync.create(deps).syncNow();
  await settle();

  assert.ok(attempts.count >= 1, '前置條件：拉到的 mark 確實觸發名單寫入');
  assert.equal(env.storage.syncState().marksCursor, '0', '名單沒落地，marksCursor 不得前進');
  assert.equal(env.storage.syncState().lastError, 'storage_quota');
  assert.deepEqual(env.storage.entries(), {}, '本機名單一筆都沒寫進去');
});

test('S3 applyMarkChanges 撞配額（持續）：以 cap level 1 收緊重寫一次後才放棄', async () => {
  const TCLSync = loadSync();
  const env = makeMarksEnv();
  const { deps, attempts } = depsWithQuotaOn(env, 'scamBlocklist', () => true);
  await TCLSync.create(deps).syncNow();
  await settle();
  assert.equal(attempts.count, 2, 'level 0 失敗後以 level 1 收緊再寫一次，仍失敗才拋 storage_quota');
});
