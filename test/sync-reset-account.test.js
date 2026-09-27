// test/sync-reset-account.test.js — 登入／過期／登出／刪雲端四條路徑收成
// resetAccount 單表（SW-2c）的行為契約。
//
// 契約重點：
// - 帳號五鍵 syncAuth、syncState、syncBackoff、syncVerifiedAt、syncDevices 由
//   一次 storage.local.set 寫入（chrome.storage 單次 set 為原子）。
// - 標髒只在登入（finishSignIn）發生；登出與刪雲端不動 history 與 scamBlocklist（D54）。
// - 登入時退避歸零、syncVerifiedAt 設為 now。
// - 舊版守衛鍵 LEGACY_GUARD_KEYS 由 background 的 onInstalled 清一次，sync.js 不再移除。
// - 廣播與 alarm 行為不變。
//
// storage／alarms／auth 替身沿用 test/sync.test.js 的 harness（該檔不匯出，這裡
// 保留同樣的時序紀律：get/set/remove 一律 setTimeout(0) 延遲結算）。
'use strict';

const test = require('node:test');
// chrome.storage 替身的 setTimeout(0) 落盤與本檔 settle() 的逐輪讓出都走假時
// 間（test/support/settle.js），每一輪不再吃作業系統計時器顆粒。
const fakeClock = require('./support/settle').installSettle();
test.beforeEach(fakeClock.reset);
const assert = require('node:assert/strict');

const TCLCore = require('../tcl-core.js');
const { postKeyOf } = TCLCore;
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');

function loadSync() {
  return require('../sync.js');
}

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;
const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';
const POST_C = 'https://www.threads.com/@carol/post/CCCCCCCCCCC';
const POST_D = 'https://www.threads.com/@dave/post/DDDDDDDDDDD';

// 帳號五鍵。
const ACCOUNT_KEYS = ['syncAuth', 'syncState', 'syncBackoff', 'syncVerifiedAt', 'syncDevices'];
const LEGACY_GUARD_KEYS = ['syncClearGuard', 'syncMarksClearGuard'];

// ---- storage 替身（同 sync.test.js 的 createSyncStorage） ----
function createSyncStorage(localSeed = {}, sessionSeed = {}) {
  const chainDepth = { value: 0 };
  const writes = [];
  let seq = 0;

  function later(fn) {
    setTimeout(fn, 0);
  }

  function makeArea(name, seed) {
    const data = Object.assign({}, seed);

    function read(keys) {
      if (keys === null || keys === undefined) return Object.assign({}, data);
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
            value: JSON.parse(JSON.stringify(items)),
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
    history() {
      return local.data.history || [];
    },
    syncAuth() {
      return local.data.syncAuth || null;
    },
  };
}

function createAlarmsMock() {
  const calls = [];
  const table = new Map();
  return {
    calls,
    api: {
      create(name, info) {
        calls.push({ op: 'create', name, info: Object.assign({}, info) });
        table.set(name, Object.assign({ name }, info));
      },
      clear(name) {
        calls.push({ op: 'clear', name });
        table.delete(name);
        return Promise.resolve(true);
      },
      get(name) {
        return Promise.resolve(table.get(name) || undefined);
      },
      getAll() {
        return Promise.resolve([...table.values()]);
      },
    },
    creates() {
      return calls.filter((c) => c.op === 'create');
    },
    clears() {
      return calls.filter((c) => c.op === 'clear');
    },
  };
}

function createAuthMock(server) {
  return {
    signInWithGoogle() {
      return Promise.resolve({
        idToken: 'fake.id.token',
        nonce: 'nonce-from-auth',
        email: 'someone@example.com',
        payload: { sub: 'user-abc', email: 'someone@example.com', name: 'Fake Payload Name' },
      });
    },
    exchangeWithBackend(options) {
      const url = String(options.apiBase).replace(/\/+$/, '') + '/api/auth/sign-in/social';
      return server
        .fetch(url, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'google', idToken: { token: options.idToken, nonce: options.nonce } }),
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

function entry(over = {}) {
  const at = over.at !== undefined ? over.at : T0 - 60_000;
  const url = over.url || POST_A;
  return Object.assign(
    {
      id: 'loc-a',
      url,
      postKey: postKeyOf(url),
      original: url,
      kind: 'strip',
      at,
      receivedAt: at,
      seen: [{ at, kind: 'strip' }],
      dirty: true,
      serverUpdatedAt: null,
      deletedAt: null,
    },
    over
  );
}

/** 已同步、未同步、墓碑混合的本機紀錄。 */
function mixedHistory() {
  return [
    entry({ id: 'srv-a', url: POST_A, dirty: false, serverUpdatedAt: T0 - 1000 }),
    entry({ id: 'srv-b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 2000 }),
    entry({ id: 'loc-c', url: POST_C, dirty: true, serverUpdatedAt: null }),
    entry({ id: 'tomb-d', url: POST_D, dirty: false, serverUpdatedAt: T0 - 3000, deletedAt: T0 - 500 }),
  ];
}

/** v2 scamBlocklist（形狀同 sync-marks.test.js 的 blocklist()）。 */
function sampleBlocklist() {
  const entries = {
    7001: {
      state: 'active',
      handle: 'synthetic_a',
      source: 'auto',
      addedAt: T0 - 5 * DAY,
      updatedAt: T0 - 3 * DAY,
      evidence: [],
    },
    7002: {
      state: 'active',
      handle: 'synthetic_b',
      source: 'auto',
      addedAt: T0 - 5 * DAY,
      updatedAt: T0 - 2 * DAY,
      dirty: true,
      dirtyAt: T0 - DAY,
      evidence: [],
    },
  };
  return { version: 2, entries, handleIndex: { synthetic_a: '7001', synthetic_b: '7002' } };
}

function signedInState(over = {}) {
  return Object.assign(
    {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: 'cur-before',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
      marksCursor: 'marks-before',
      marksEvicted: 3,
    },
    over
  );
}

function makeEnv(opts = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const server = createMockSyncServer({ now });
  const localSeed = Object.assign({}, opts.local);
  if (opts.history) localSeed.history = opts.history;
  if (opts.signedIn) {
    localSeed.syncAuth = { token: server.grantToken('tok-seeded') };
    localSeed.syncState = signedInState(opts.syncState);
  }
  const storage = createSyncStorage(localSeed);
  const alarms = createAlarmsMock();
  const broadcasts = [];
  // 每則廣播送出時的寫入數，用來界定「登入完成前」的寫入窗口。
  const broadcastWriteMarks = [];
  // 每次 fetch 發出時的寫入數，用來界定「401 之後」的寫入窗口。
  const fetchWriteMarks = [];
  let uuidSeq = 0;
  const deps = {
    storage: storage.api,
    fetch: (url, init) => {
      fetchWriteMarks.push({ url: String(url), at: storage.writes.length });
      return server.fetch(url, init);
    },
    now,
    alarms: alarms.api,
    broadcast: (message) => {
      broadcasts.push(message);
      broadcastWriteMarks.push(storage.writes.length);
    },
    auth: createAuthMock(server),
    permissions: {
      contains() {
        return Promise.resolve(true);
      },
      request() {
        return Promise.resolve(true);
      },
    },
    randomUUID: () => `uuid-${(uuidSeq += 1)}`,
    setTimeout: () => ({}),
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
    server,
    storage,
    alarms,
    broadcasts,
    deps,
    statuses() {
      return broadcasts.filter((m) => m && m.type === 'sync.stateChanged').map((m) => m.state.status);
    },
    /** 第一則 status 為 `status` 的廣播送出時的寫入數。 */
    writesAtFirstStatus(status) {
      const i = broadcasts.findIndex((m) => m && m.type === 'sync.stateChanged' && m.state.status === status);
      return i === -1 ? null : broadcastWriteMarks[i];
    },
    /** 第一次打到 `pathPart` 的 fetch 發出時的寫入數。 */
    writesAtFirstFetch(pathPart) {
      const hit = fetchWriteMarks.find((m) => m.url.indexOf(pathPart) !== -1);
      return hit ? hit.at : null;
    },
  };
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 窗口內碰到帳號五鍵（set 或 remove）的本機寫入。 */
function accountWrites(writes) {
  return writes.filter((w) => w.area === 'local' && w.keys.some((k) => ACCOUNT_KEYS.indexOf(k) !== -1));
}

/** 斷言窗口內帳號鍵只有一次 set，且鍵集合等於 expectedKeys；回傳該次 payload。 */
function assertSingleAccountSet(writes, expectedKeys, label) {
  const hits = accountWrites(writes);
  assert.equal(
    hits.length,
    1,
    `${label}：帳號鍵應由同一次 storage.local.set 寫入，實得 ${hits.length} 次：` +
      JSON.stringify(hits.map((w) => ({ keys: w.keys, removed: !!w.removed })))
  );
  const only = hits[0];
  assert.ok(!only.removed, `${label}：帳號鍵以 set 寫入，不走 remove`);
  assert.deepEqual([...only.keys].sort(), [...expectedKeys].sort(), `${label}：一次寫入的鍵集合`);
  return only.value;
}

function assertResetState(value, label) {
  assert.deepEqual(
    TCLCore.normalizeSyncState(value),
    TCLCore.normalizeSyncState(null),
    `${label}：syncState 整包重設`
  );
}

/** 從登出態走完一次登入，回傳登入完成（廣播 signed_in）之前的寫入窗口。 */
async function signInWindow(env, engine) {
  const start = env.storage.writes.length;
  await engine.signIn();
  await settle(14);
  const end = env.writesAtFirstStatus('signed_in');
  assert.notEqual(end, null, '前置：登入要廣播 signed_in');
  return env.storage.writes.slice(start, end);
}

// ============================================================================
// RA1 — 四條路徑：帳號五鍵同一次 set，值符合矩陣
// ============================================================================

test('RA1 登入（同帳號）：syncAuth／syncState／syncBackoff／syncVerifiedAt 同一次 set，syncDevices 不動', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: mixedHistory(),
    local: {
      syncBackoff: { failures: 3 },
      syncDevices: { fetchedAt: T0 - 1000, devices: [] },
    },
  });
  const engine = TCLSync.create(env.deps);
  const window = await signInWindow(env, engine);

  const value = assertSingleAccountSet(window, ['syncAuth', 'syncState', 'syncBackoff', 'syncVerifiedAt'], '登入');
  assert.ok(value.syncAuth && typeof value.syncAuth.token === 'string' && value.syncAuth.token, '新 token');
  const state = TCLCore.normalizeSyncState(value.syncState);
  assert.equal(state.userId, 'user-abc', '身分欄位寫入');
  assert.equal(state.cursor, null, 'cursor 歸零');
  assert.equal(state.lastSyncedAt, null);
  assert.equal(state.lastError, null);
  assert.equal(state.marksCursor, null, 'marks 游標歸零');
  assert.ok(!('marksPushedAt' in state), 'marks 不再有推送水位線（名單改由登入時全部標 dirty 全推）');
  assert.deepEqual(value.syncBackoff, { failures: 0 }, '退避歸零');
  assert.equal(value.syncVerifiedAt, T0, 'syncVerifiedAt 設為 now');
});

test('RA1 登入（換帳號）：五鍵同一次 set，syncDevices 以 null 清掉', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: mixedHistory(),
    local: {
      // 前一位使用者過期後留下的登出態：userId 仍在。
      syncState: signedInState({ lastError: 'session_expired' }),
      syncAuth: { token: null },
      syncDevices: {
        fetchedAt: T0 - 1000,
        devices: [{ deviceId: '11111111-2222-4333-8444-555555555555', name: '合成手機' }],
      },
    },
  });
  env.server.setUser({ id: 'user-zzz', email: 'other@example.com' });
  const engine = TCLSync.create(env.deps);
  const window = await signInWindow(env, engine);

  const value = assertSingleAccountSet(window, ACCOUNT_KEYS, '換帳號登入');
  assert.equal(TCLCore.normalizeSyncState(value.syncState).userId, 'user-zzz');
  assert.equal(value.syncDevices, null, '別台裝置快取以 null 清掉');
});

test('RA1 過期（get-session 401）：五鍵同一次 set，syncState 為合併 patch', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    local: {
      syncBackoff: { failures: 4 },
      syncDevices: { fetchedAt: T0 - 1000, devices: [] },
    },
  });
  env.server.failNext({ status: 401, code: 'unauthorized' });
  const engine = TCLSync.create(env.deps);
  await engine.verifySession();
  await settle();

  const start = env.writesAtFirstFetch('/api/auth/get-session');
  assert.notEqual(start, null, '前置：打過 get-session');
  const value = assertSingleAccountSet(env.storage.writes.slice(start), ACCOUNT_KEYS, '過期');
  assert.deepEqual(value.syncAuth, { token: null });
  const state = TCLCore.normalizeSyncState(value.syncState);
  assert.equal(state.lastError, 'session_expired');
  assert.equal(state.userId, 'user-abc', 'userId 保留（帳號切換偵測要用）');
  assert.equal(state.cursor, 'cur-before', 'cursor 保留');
  assert.equal(state.marksCursor, 'marks-before', 'marks 欄位保留');
  assert.deepEqual(value.syncBackoff, { failures: 0 });
  assert.equal(value.syncVerifiedAt, null);
  assert.equal(value.syncDevices, null);
});

test('RA1 登出：五鍵同一次 set，syncState 整包重設', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    local: {
      syncBackoff: { failures: 2 },
      syncVerifiedAt: T0 - 1000,
      syncDevices: { fetchedAt: T0 - 1000, devices: [] },
    },
  });
  const engine = TCLSync.create(env.deps);
  const start = env.storage.writes.length;
  await engine.signOut();
  await settle();

  const value = assertSingleAccountSet(env.storage.writes.slice(start), ACCOUNT_KEYS, '登出');
  assert.deepEqual(value.syncAuth, { token: null });
  assertResetState(value.syncState, '登出');
  assert.deepEqual(value.syncBackoff, { failures: 0 });
  assert.equal(value.syncVerifiedAt, null);
  assert.equal(value.syncDevices, null);
});

test('RA1 刪雲端成功：五鍵同一次 set，syncState 整包重設', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    local: {
      syncBackoff: { failures: 2 },
      syncVerifiedAt: T0 - 1000,
      syncDevices: { fetchedAt: T0 - 1000, devices: [] },
    },
  });
  const engine = TCLSync.create(env.deps);
  const start = env.storage.writes.length;
  const result = await engine.deleteCloud();
  await settle();

  assert.equal(result && result.ok, true, '前置：刪雲端成功');
  const value = assertSingleAccountSet(env.storage.writes.slice(start), ACCOUNT_KEYS, '刪雲端');
  assert.deepEqual(value.syncAuth, { token: null });
  assertResetState(value.syncState, '刪雲端');
  assert.deepEqual(value.syncBackoff, { failures: 0 });
  assert.equal(value.syncVerifiedAt, null);
  assert.equal(value.syncDevices, null);
});

// ============================================================================
// RA2 — 標髒只在登入（D54）
// ============================================================================

for (const [label, run] of [
  ['登出', (engine) => engine.signOut()],
  ['刪雲端', (engine) => engine.deleteCloud()],
]) {
  test(`RA2 ${label}成功：history 與 scamBlocklist 原封不動，沒有任何寫入碰到兩者（D54）`, async () => {
    const TCLSync = loadSync();
    const history = mixedHistory();
    const list = sampleBlocklist();
    const env = makeEnv({ signedIn: true, history, local: { scamBlocklist: list } });
    const engine = TCLSync.create(env.deps);
    const start = env.storage.writes.length;
    await run(engine);
    await settle();

    assert.equal(env.storage.syncAuth().token, null, '前置：已登出');
    const touched = env.storage.writes
      .slice(start)
      .filter((w) => w.area === 'local' && (w.keys.includes('history') || w.keys.includes('scamBlocklist')));
    assert.deepEqual(
      touched.map((w) => w.keys),
      [],
      `${label}不得寫 history／scamBlocklist`
    );
    assert.deepEqual(env.storage.history(), history, 'history 一格不動（dirty／serverUpdatedAt 維持原值）');
    assert.deepEqual(env.storage.localData.scamBlocklist, list, 'scamBlocklist 一格不動');
  });
}

test('RA2 登入：token 寫入前先把 history 全部標髒、serverUpdatedAt 歸 null（墓碑 deletedAt 不動）', async () => {
  const TCLSync = loadSync();
  const history = mixedHistory();
  const env = makeEnv({ history });
  const engine = TCLSync.create(env.deps);
  const window = await signInWindow(env, engine);

  const historyIdx = window.findIndex((w) => w.area === 'local' && w.keys.includes('history') && !w.removed);
  const authIdx = window.findIndex((w) => w.area === 'local' && w.keys.includes('syncAuth'));
  assert.notEqual(historyIdx, -1, '登入要寫一次 history 標髒');
  assert.ok(historyIdx < authIdx, '標髒排在 token 寫入之前');
  const marked = window[historyIdx].value.history;
  assert.equal(marked.length, history.length, '本機一筆不刪');
  marked.forEach((e) => {
    assert.equal(e.dirty, true, `${e.id}：全部標髒`);
    assert.equal(e.serverUpdatedAt, null, `${e.id}：鏡像欄位歸 null`);
  });
  assert.equal(marked.find((e) => e.id === 'tomb-d').deletedAt, T0 - 500, '墓碑 deletedAt 不動');
});

// ============================================================================
// RA3 — 登入時退避歸零、syncVerifiedAt 設為 now
// ============================================================================

test('RA3 登入：token 落地當下 syncBackoff 已歸零，syncVerifiedAt 為登入當下的 now', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: [entry()],
    local: { syncBackoff: { failures: 5 }, syncVerifiedAt: T0 - 7 * DAY },
  });
  const engine = TCLSync.create(env.deps);
  const window = await signInWindow(env, engine);

  const authWrite = window.find((w) => w.area === 'local' && w.keys.includes('syncAuth'));
  assert.ok(authWrite, '前置：登入寫了 token');
  assert.deepEqual(authWrite.value.syncBackoff, { failures: 0 }, '退避與 token 同一次寫入歸零');
  assert.equal(authWrite.value.syncVerifiedAt, T0, 'syncVerifiedAt 與 token 同一次寫入為 now');
  assert.equal(env.storage.localData.syncVerifiedAt, T0, '登入後本機 syncVerifiedAt 為登入當下');
});

// ============================================================================
// RA4 — 刪雲端的本機寫入失敗：storage_write_failed、token 保留
// ============================================================================

test('RA4 刪雲端：R11 成功但帳號鍵寫入失敗 → 回 storage_write_failed、token 保留、不宣稱已登出', async () => {
  const TCLSync = loadSync();
  const history = mixedHistory();
  const env = makeEnv({ signedIn: true, history });
  const brokenDeps = Object.assign({}, env.deps, {
    storage: {
      session: env.deps.storage.session,
      local: Object.assign({}, env.deps.storage.local, {
        set(items) {
          if (Object.prototype.hasOwnProperty.call(items, 'syncAuth')) {
            return Promise.reject(new Error('IO error'));
          }
          return env.deps.storage.local.set(items);
        },
      }),
    },
  });
  const engine = TCLSync.create(brokenDeps);
  let result;
  await assert.doesNotReject(async () => {
    result = await engine.deleteCloud();
  }, 'deleteCloud 不得把寫入失敗往外拋');
  await settle();

  assert.equal(env.server.requestsTo('/api/v1/cloud-data', 'DELETE').length, 1, '前置：R11 端點成功');
  assert.equal(result && result.ok, false);
  assert.equal(result && result.code, 'storage_write_failed');
  assert.notEqual(result && result.signedOut, true, '寫入沒落地不得宣稱已登出');
  assert.equal(env.storage.syncAuth().token, 'tok-seeded', 'token 保留');
  assert.deepEqual(env.storage.history(), history, 'history 原封不動');
});

// ============================================================================
// RA5 — LEGACY_GUARD_KEYS 改由 onInstalled 清一次
// ============================================================================

function legacyRemoves(writes) {
  return writes.filter((w) => w.removed && w.keys.some((k) => LEGACY_GUARD_KEYS.indexOf(k) !== -1));
}

const LEGACY_SEED = {
  syncClearGuard: { userId: 'user-abc', clearedAt: T0 - 5000 },
  syncMarksClearGuard: { userId: 'user-abc', clearedAt: null, pending: true, sentAt: T0 - 5000 },
};

test('RA5 登入：sync.js 不再移除舊版守衛鍵', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: [entry()], local: Object.assign({}, LEGACY_SEED) });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle(14);

  assert.equal(typeof (env.storage.syncAuth() || {}).token, 'string', '前置：已登入');
  assert.deepEqual(
    legacyRemoves(env.storage.writes).map((w) => w.keys),
    [],
    '守衛鍵的移除改由 onInstalled 負責'
  );
  assert.deepEqual(env.storage.localData.syncClearGuard, LEGACY_SEED.syncClearGuard);
  assert.deepEqual(env.storage.localData.syncMarksClearGuard, LEGACY_SEED.syncMarksClearGuard);
});

test('RA5 刪雲端：sync.js 不再移除舊版守衛鍵', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()], local: Object.assign({}, LEGACY_SEED) });
  const engine = TCLSync.create(env.deps);
  const result = await engine.deleteCloud();
  await settle();

  assert.equal(result && result.ok, true, '前置：刪雲端成功');
  assert.deepEqual(
    legacyRemoves(env.storage.writes).map((w) => w.keys),
    [],
    '守衛鍵的移除改由 onInstalled 負責'
  );
  assert.deepEqual(env.storage.localData.syncClearGuard, LEGACY_SEED.syncClearGuard);
});

// background.js 的 onInstalled 載入器（同 background.test.js 的
// loadBackgroundForMigration）。共用 createChromeStorage 的 local 區沒有
// remove()，這裡在本檔替身上補一支側錄版，不改共用 helper。
function loadBackgroundForInstall(localSeed) {
  const onInstalledListeners = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => onInstalledListeners.push(fn) },
      onMessage: { addListener: () => {} },
      id: 'test-extension-id',
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{}] },
    tabs: { TAB_ID_NONE: -1, query: async () => [] },
  };
  const storage = createChromeStorage({ saveHistory: true }, localSeed);
  const removeCalls = [];
  storage.api.local.remove = function (keys, callback) {
    removeCalls.push(Array.isArray(keys) ? keys.slice() : [keys]);
    if (typeof callback === 'function') {
      setTimeout(callback, 0);
      return undefined;
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  };
  chrome.storage = storage.api;
  loadSwSources({
    chrome,
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
  });
  return {
    removeCalls,
    fireInstalled(details) {
      onInstalledListeners.slice().forEach((fn) => fn(details || { reason: 'update' }));
    },
  };
}

for (const reason of ['update', 'install']) {
  test(`RA5 background onInstalled（${reason}）：舊版守衛鍵清一次`, async () => {
    const bg = loadBackgroundForInstall(Object.assign({ history: [] }, LEGACY_SEED));
    bg.fireInstalled({ reason });
    await settle(20);

    const hits = bg.removeCalls.filter((keys) => keys.some((k) => LEGACY_GUARD_KEYS.indexOf(k) !== -1));
    assert.equal(hits.length, 1, 'onInstalled 移除舊版守衛鍵恰好一次');
    const removed = new Set(hits[0]);
    LEGACY_GUARD_KEYS.forEach((k) => assert.ok(removed.has(k), `${k} 要一併移除`));
  });
}

// ============================================================================
// RA6 — 廣播與 alarm 行為不退步
// ============================================================================

function assertSignedOutTail(env, TCLSync, label) {
  const statuses = env.statuses();
  assert.equal(statuses.filter((s) => s === 'signed_out').length, 1, `${label}：signed_out 恰好廣播一次`);
  assert.equal(statuses[statuses.length - 1], 'signed_out', `${label}：最後一則廣播為 signed_out`);
  const cleared = env.alarms.clears().map((c) => c.name);
  assert.ok(cleared.includes(TCLSync.ALARM_NAME), `${label}：清週期 alarm`);
  assert.ok(cleared.includes(TCLSync.DEBOUNCE_ALARM_NAME), `${label}：清去抖 alarm`);
}

test('RA6 登入：signed_in 在首輪同步前恰好廣播一次，並建立週期 alarm', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle(14);

  const statuses = env.statuses();
  const firstSyncing = statuses.indexOf('syncing');
  const beforeSync = firstSyncing === -1 ? statuses : statuses.slice(0, firstSyncing);
  assert.equal(beforeSync.filter((s) => s === 'signed_in').length, 1, '登入完成廣播 signed_in 一次');
  const periodic = env.alarms.creates().filter((c) => c.name === TCLSync.ALARM_NAME);
  assert.ok(periodic.length >= 1, '建立週期 alarm');
  assert.equal(periodic[0].info.periodInMinutes, TCLSync.SYNC_PERIOD_MINUTES);
});

test('RA6 過期：signed_out 廣播一次，兩支 alarm 都清', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 401, code: 'unauthorized' });
  const engine = TCLSync.create(env.deps);
  await engine.verifySession();
  await settle();
  assertSignedOutTail(env, TCLSync, '過期');
});

test('RA6 登出：signed_out 廣播一次，兩支 alarm 都清', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle();
  assertSignedOutTail(env, TCLSync, '登出');
});

test('RA6 刪雲端：signed_out 廣播一次，兩支 alarm 都清', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle();
  assertSignedOutTail(env, TCLSync, '刪雲端');
});
