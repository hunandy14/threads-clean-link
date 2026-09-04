// test/sync.test.js — 雲端同步引擎 `sync.js`（車道 D）的行為契約，紅燈先行。
//
// 唯一真相源：docs/cloud-sync.md 第 3 節（插件端契約）、第 4 節（資料模型）、
// 第 5 節（模組介面）、D9／D10／D12；後端形狀依 meta-link-clearer 的
// docs/api-spec.md，由 test/helpers/mock-sync-server.js 代言（依據章節與行號見該檔）。
//
// ============================================================================
// 本檔定義的模組契約（sync.js 尚未實作，以下形狀由測試釘定）
// ============================================================================
// `sync.js` 與 tcl-core.js／auth.js 同風格：IIFE 掛 `TCLSync`，同時支援
// CommonJS require；SW 內以 importScripts 載入。全部依賴注入，模組本身不碰
// 全域 `chrome`／`fetch`／`Date`，因此可在 node:test 內直接跑純邏輯。
//
//   TCLSync.create({
//     storage,      // { local: {get,set,remove}, session: {get,set,remove} }
//     fetch,        // (url, init) => Promise<Response>
//     now,          // () => epoch ms
//     alarms,       // { create(name, info), clear(name), get(name), getAll() }
//     broadcast,    // (message) => void，送 {type:"sync.stateChanged", state}
//     auth,         // TCLAuth（signInWithGoogle／exchangeWithBackend）
//     permissions,  // { contains(descriptor) => Promise<boolean> }
//     randomUUID,   // () => string，新 entry 的 id 來源
//     writeChain,   // (fn) => Promise，background.js 的 historyWriteChain
//     setTimeout,   // (fn, ms) => handle，去抖的 SW 存活期路徑（T5 雙保險）
//     clearTimeout, // (handle) => void
//   }) => engine
//
//   engine.getState()        Promise<state>（計劃 5.2 形狀）
//   engine.signIn()          Promise
//   engine.signOut()         Promise
//   engine.syncNow()         Promise
//   engine.deleteCloud()     Promise
//   engine.verifySession()   Promise（SW 啟動時驗 token）
//   engine.notifyRecorded()  Promise（recordHistory 之後的去抖掛鉤）
//   engine.onAlarm(alarm)    Promise（chrome.alarms.onAlarm 轉入）
//
// `writeChain` 是把「history 寫入一律走既有 historyWriteChain 序列化」（T3）
// 變成可觀測契約的唯一辦法：引擎不自己碰 storage.local.history，一律把讀改寫
// 包進注入的鏈。測試據此斷言寫入不交錯。
//
// 車道 C（feat/history-sync-schema）尚未合入，`TCLCore.toSyncItem` 等 helper
// 仍不存在；本檔只透過引擎的外部行為斷言，不直接呼叫那些 helper。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { postKeyOf } = require('../tcl-core.js');
const {
  createMockSyncServer,
  MAX_SYNC_UPSERTS,
  MAX_SYNC_SEEN_ROWS,
} = require('./helpers/mock-sync-server.js');

const REPO_ROOT = path.join(__dirname, '..');

// sync.js 尚未實作：require 會丟 MODULE_NOT_FOUND，這是預期的紅燈。放在每個
// 測試內部呼叫（而非檔案頂層），是為了讓每條契約各自紅一次、數得出來。
function loadSync() {
  return require('../sync.js');
}

const PRODUCTION_BASE = 'https://api.metalinkclearer.workers.dev';
const STAGING_BASE = 'https://api-staging.metalinkclearer.workers.dev';
const LOCAL_BASE = 'http://localhost:8787';

// 後端把 staging 與 production 的 Google Web client 分家了，三個 apiBase
// 各自對應的 client_id（local 沒有自己的 client，併到 production 那組—— 本
// 機後端的 .dev.vars 仍設定舊 client）。
const CLIENT_ID_PRODUCTION = '17054024593-p003rp6cqmm9ks4r8mdphal1ahr3rhum.apps.googleusercontent.com';
const CLIENT_ID_STAGING = '17054024593-846tl3brfgd5f09ouavituflf5b7v6qi.apps.googleusercontent.com';

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';
const POST_C = 'https://www.threads.com/@carol/post/CCCCCCCCCCC';

const T0 = 1_700_000_000_000;

// ---- storage 替身 ----
//
// 【時序紀律】比照 test/support/helpers.js 的 createChromeStorage：get/set/remove
// 一律以 setTimeout(0) 延遲結算，絕不在同一個 tick 直接 resolve——同 tick 假綠燈
// 是本專案已知風險。另外側錄每次寫入（區域、鍵、是否在 writeChain 內），供
// 「history 寫入走序列鏈、不交錯」的斷言使用。
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
    sessionData: session.data,
    writes,
    chainDepth,
    history() {
      return local.data.history || [];
    },
    syncState() {
      return local.data.syncState || null;
    },
    syncAuth() {
      return local.data.syncAuth || null;
    },
    historyWrites() {
      return writes.filter((w) => w.area === 'local' && w.keys.indexOf('history') !== -1);
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
    lastCreate() {
      const list = calls.filter((c) => c.op === 'create');
      return list[list.length - 1] || null;
    },
    /** 週期 alarm 的排定延遲（毫秒），`when` 與 `periodInMinutes` 兩種寫法皆接受。 */
    delayOf(call, at) {
      if (!call) return null;
      const info = call.info || {};
      if (typeof info.when === 'number') return info.when - at;
      if (typeof info.delayInMinutes === 'number') return info.delayInMinutes * 60_000;
      if (typeof info.periodInMinutes === 'number') return info.periodInMinutes * 60_000;
      return null;
    },
  };
}

// TCLAuth 的替身：只回傳 signInWithGoogle 的結果形狀（見 auth.js），
// exchangeWithBackend 沿用真實實作的形狀但改打 mock 伺服器。
function createAuthMock(server, opts = {}) {
  const calls = { signIn: [], exchange: [] };
  return {
    calls,
    signInWithGoogle(options) {
      calls.signIn.push(options);
      if (opts.signInError) return Promise.reject(opts.signInError);
      const email = opts.email || 'someone@example.com';
      // D15（車道 A）：id_token payload 的 name／picture 是後端缺席時的退回
      // 來源。顯式傳 `payloadName: null` / `payloadPicture: null` 表示這枚
      // id_token 完全沒有該 claim，省略則用假值，供「payload 備援」與「白
      // 名單拒絕」兩類測試覆寫。
      const payload = { sub: 'user-abc', email: email };
      if (opts.payloadName !== null) payload.name = opts.payloadName || 'Fake Payload Name';
      if (opts.payloadPicture !== null) {
        payload.picture = opts.payloadPicture || 'https://lh3.googleusercontent.com/a/fake-payload-avatar';
      }
      return Promise.resolve({
        idToken: opts.idToken || 'fake.id.token',
        nonce: opts.nonce || 'nonce-from-auth',
        email: email,
        payload: payload,
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

function signedInState(over = {}) {
  return Object.assign(
    {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: '0',
      lastSyncedAt: T0 - 10 * 60_000,
      clearedAt: null,
      lastError: null,
    },
    over
  );
}

/**
 * 組一整套注入環境。`opts.signedIn` 為 true 時預先發一枚有效 token 並寫入
 * syncAuth／syncState，省去每條測試重跑登入往返。
 */
function makeEnv(opts = {}) {
  const clock = { t: opts.startAt || T0 };
  const now = () => clock.t;
  const server = createMockSyncServer(Object.assign({ now }, opts.server));
  const localSeed = Object.assign({}, opts.local);
  if (opts.history) localSeed.history = opts.history;
  if (opts.signedIn) {
    const token = server.grantToken('tok-seeded');
    localSeed.syncAuth = Object.assign({ token }, opts.syncAuth);
    localSeed.syncState = signedInState(opts.syncState);
  }
  const storage = createSyncStorage(localSeed, opts.session);
  const alarms = createAlarmsMock();
  const broadcasts = [];
  const auth = createAuthMock(server, opts.auth);
  const permissions = {
    granted: opts.granted !== false,
    containsCalls: [],
    requestCalls: [],
    contains(descriptor) {
      permissions.containsCalls.push(descriptor);
      return Promise.resolve(permissions.granted);
    },
    request(descriptor) {
      permissions.requestCalls.push(descriptor);
      return Promise.resolve(true);
    },
  };
  let uuidSeq = 0;
  let timerSeq = 0;
  // 去抖的 SW 存活期路徑（T5 雙保險）：計時器一律注入，測試自己決定何時到期。
  const timers = { calls: [], live: [], cleared: [] };
  const deps = {
    storage: storage.api,
    fetch: server.fetch,
    now,
    alarms: alarms.api,
    broadcast: (message) => broadcasts.push(message),
    auth,
    permissions,
    randomUUID: () => `uuid-${(uuidSeq += 1)}`,
    setTimeout: (fn, ms) => {
      timerSeq += 1;
      const handle = { id: timerSeq, fn, ms, scheduledAt: clock.t };
      timers.calls.push(handle);
      timers.live.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.cleared.push(handle);
      const index = timers.live.indexOf(handle);
      if (index !== -1) timers.live.splice(index, 1);
    },
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
    permissions,
    deps,
    timers,
    /** 讓目前排定的去抖計時器到期（模擬 SW 還活著、2 秒先到）。 */
    async runTimers() {
      const pending = timers.live.splice(0, timers.live.length);
      for (const handle of pending) await handle.fn();
    },
    advance(ms) {
      clock.t += ms;
    },
    /** 用同一份 storage 重建引擎，模擬 SW 被回收後重新啟動。 */
    recreate(TCLSync, sessionSurvives = true) {
      if (!sessionSurvives) {
        Object.keys(storage.sessionData).forEach((k) => delete storage.sessionData[k]);
      }
      return TCLSync.create(deps);
    },
    stateBroadcasts() {
      return broadcasts.filter((m) => m && m.type === 'sync.stateChanged');
    },
    lastState() {
      const list = broadcasts.filter((m) => m && m.type === 'sync.stateChanged');
      return list.length ? list[list.length - 1].state : null;
    },
    syncPosts() {
      return server.requestsTo('/api/v1/links/sync', 'POST');
    },
  };
}

/** 讓所有 setTimeout(0) 排程的 storage 結算跑完。 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ============================================================================
// T1 — 模組形狀與注入
// ============================================================================

test('T1 sync.js 匯出 TCLSync，create() 回傳完整引擎介面', () => {
  const TCLSync = loadSync();
  assert.equal(typeof TCLSync.create, 'function');
  const env = makeEnv();
  const engine = TCLSync.create(env.deps);
  ['getState', 'signIn', 'signOut', 'syncNow', 'deleteCloud', 'verifySession', 'notifyRecorded', 'onAlarm'].forEach(
    (m) => {
      assert.equal(typeof engine[m], 'function', `engine.${m} 應為函式`);
    }
  );
});

test('T1 模組不碰全域 chrome／fetch／Date：只用注入的依賴', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  // 沙箱化：模組若偷用全域 chrome/fetch，這裡會直接丟例外。
  const savedChrome = globalThis.chrome;
  const savedFetch = globalThis.fetch;
  globalThis.chrome = new Proxy(
    {},
    {
      get() {
        throw new Error('sync.js 不得使用全域 chrome，依賴一律注入');
      },
    }
  );
  globalThis.fetch = () => {
    throw new Error('sync.js 不得使用全域 fetch，依賴一律注入');
  };
  try {
    await engine.syncNow();
    await settle();
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.fetch = savedFetch;
  }
  assert.ok(env.syncPosts().length >= 1, '應透過注入的 fetch 發出同步請求');
});

test('T1 常數：alarm 名稱固定、去抖 2 秒、週期不低於 1 分鐘（D12）', () => {
  const TCLSync = loadSync();
  assert.equal(typeof TCLSync.ALARM_NAME, 'string');
  assert.ok(TCLSync.ALARM_NAME.length > 0, 'alarm 名稱必須固定且非空');
  assert.equal(TCLSync.DEBOUNCE_MS, 2000, '新紀錄去抖 2 秒');
  assert.ok(TCLSync.SYNC_PERIOD_MINUTES >= 1, '週期 alarm 不低於 1 分鐘');
});

test('T1 常數：apiBase 三個環境與 Google client id 對照表為模組常數（D5／D9）', () => {
  const TCLSync = loadSync();
  assert.equal(TCLSync.API_BASE_PRODUCTION, PRODUCTION_BASE);
  assert.equal(TCLSync.API_BASE_STAGING, STAGING_BASE);
  assert.equal(TCLSync.API_BASE_LOCAL, LOCAL_BASE);
  assert.equal(TCLSync.CLIENT_ID_PRODUCTION, CLIENT_ID_PRODUCTION);
  assert.equal(TCLSync.CLIENT_ID_STAGING, CLIENT_ID_STAGING);
  assert.deepEqual(TCLSync.CLIENT_ID_BY_API_BASE, {
    [PRODUCTION_BASE]: CLIENT_ID_PRODUCTION,
    [STAGING_BASE]: CLIENT_ID_STAGING,
    // local 沒有自己的 client：本機後端的 .dev.vars 仍設定舊(production)client。
    [LOCAL_BASE]: CLIENT_ID_PRODUCTION,
  });
});

test('T1 打包白名單：sync.js 必須進 build-release.ps1 的 $includeFiles', () => {
  const ps1 = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'build-release.ps1'), 'utf8');
  const match = ps1.match(/\$includeFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(match, 'build-release.ps1 應有 $includeFiles 白名單');
  const included = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(included.includes('sync.js'), 'sync.js 漏了會讓上架 zip 缺檔（見 test/package.test.js）');
});

// ============================================================================
// T2 — 認證狀態機
// ============================================================================

test('T2 signIn：權限未授予時只 contains 不 request，state 轉 error/permission_required', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ granted: false });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.ok(env.permissions.containsCalls.length >= 1, 'SW 端必須先 chrome.permissions.contains');
  assert.deepEqual(env.permissions.requestCalls, [], 'permissions.request 只能在 options 頁的使用者手勢內發');
  assert.deepEqual(env.auth.calls.signIn, [], '權限未授予時不得進入授權流程');
  assert.deepEqual(env.server.requests, [], '權限未授予時不得對後端發任何請求');
  const state = await engine.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.lastError, 'permission_required');
});

test('T2 signIn：token 取自 set-auth-token 標頭並存進 storage.local.syncAuth（D10）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv();
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  const signIns = env.server.requestsTo('/api/auth/sign-in/social', 'POST');
  assert.equal(signIns.length, 1);
  assert.equal(env.storage.syncAuth().token, env.server.currentToken());
  assert.ok(env.storage.syncAuth().token, 'token 必須落地');
  const sessionTokens = Object.keys(env.storage.sessionData).filter((k) =>
    JSON.stringify(env.storage.sessionData[k]).includes(env.server.currentToken())
  );
  assert.deepEqual(sessionTokens, [], 'token 存 local 不存 session（D10：重啟仍要保持登入）');
});

test('T2 signIn：userId／email 寫入 syncState 並廣播 stateChanged', async () => {
  const TCLSync = loadSync();
  const env = makeEnv();
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.equal(env.storage.syncState().email, 'someone@example.com');
  assert.equal(env.storage.syncState().userId, 'user-abc');
  assert.ok(env.stateBroadcasts().length >= 1, '登入後必須廣播 sync.stateChanged');
  assert.equal(env.lastState().email, 'someone@example.com');
});

// ---- D15（車道 A）：syncState 記錄名字與大頭照，供設定頁頭首帳號入口使用 ----

test('T2 signIn：後端 sign-in 回應的 user.name／user.image 寫入 syncState 與 state（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv();
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.equal(env.storage.syncState().displayName, 'Fake User');
  assert.equal(env.storage.syncState().avatarUrl, 'https://lh3.googleusercontent.com/a/fake-mock-user');
  // 計劃 5.2 的 state 形狀同樣要帶這兩欄，車道 B 的 UI 才讀得到。
  assert.equal(env.lastState().displayName, 'Fake User');
  assert.equal(env.lastState().avatarUrl, 'https://lh3.googleusercontent.com/a/fake-mock-user');
  const state = await engine.getState();
  assert.equal(state.displayName, 'Fake User');
  assert.equal(state.avatarUrl, 'https://lh3.googleusercontent.com/a/fake-mock-user');
});

test('T2 signIn：displayName 去頭尾空白、上限 80 字元（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ server: { name: '  Alice  ' } });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.equal(env.storage.syncState().displayName, 'Alice');
});

test('T2 signIn：後端缺 user.name／user.image 時退回 id_token payload 的 name／picture（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ server: { name: null, image: null } });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.equal(env.storage.syncState().displayName, 'Fake Payload Name', '退回 id_token payload 的 name claim');
  assert.equal(
    env.storage.syncState().avatarUrl,
    'https://lh3.googleusercontent.com/a/fake-payload-avatar',
    '退回 id_token payload 的 picture claim'
  );
});

test('T2 signIn：avatarUrl 不在 googleusercontent.com 白名單時存 null（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ server: { image: 'https://evil.example.com/avatar.png' } });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.equal(env.storage.syncState().avatarUrl, null, '白名單外的網址一律拒收，不落地');
  assert.equal(env.storage.syncState().displayName, 'Fake User', 'displayName 不受 avatarUrl 白名單影響');
});

test('T2 verifySession：get-session 回應更新 displayName／avatarUrl（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { displayName: 'Old Name', avatarUrl: 'https://lh3.googleusercontent.com/a/old' },
    server: { name: 'New Name', image: 'https://lh3.googleusercontent.com/a/new' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.verifySession();
  await settle();

  const state = await engine.getState();
  assert.equal(state.displayName, 'New Name');
  assert.equal(state.avatarUrl, 'https://lh3.googleusercontent.com/a/new');
});

test('T2 verifySession：get-session 缺 name／image 時保留既有值（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { displayName: 'Old Name', avatarUrl: 'https://lh3.googleusercontent.com/a/old' },
    server: { name: null, image: null },
  });
  const engine = TCLSync.create(env.deps);
  await engine.verifySession();
  await settle();

  const state = await engine.getState();
  assert.equal(state.displayName, 'Old Name', '後端沒帶這個欄位就不覆寫既有值');
  assert.equal(state.avatarUrl, 'https://lh3.googleusercontent.com/a/old');
});

test('T2 signOut：displayName／avatarUrl 隨 syncState 清空（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { displayName: 'Alice', avatarUrl: 'https://lh3.googleusercontent.com/a/alice' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle();

  assert.equal(env.storage.syncState().displayName, null);
  assert.equal(env.storage.syncState().avatarUrl, null);
});

test('T2 任何 API 回 401：displayName／avatarUrl 隨 syncState 清空（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [entry()],
    syncState: { displayName: 'Alice', avatarUrl: 'https://lh3.googleusercontent.com/a/alice' },
  });
  env.server.failNext({ status: 401, code: 'unauthorized' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().displayName, null, 'session 過期視同登出，清空顯示用欄位');
  assert.equal(env.storage.syncState().avatarUrl, null);
});

test('T6 deleteCloud：displayName／avatarUrl 清空，但 userId／email 保留（D15）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { displayName: 'Alice', avatarUrl: 'https://lh3.googleusercontent.com/a/alice' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle();

  const state = env.storage.syncState();
  assert.equal(state.displayName, null, '刪雲端資料是明確的隱私動作，快取的名字也要清');
  assert.equal(state.avatarUrl, null);
  assert.equal(state.userId, 'user-abc', '刪雲端資料不等於登出，帳號仍保持登入');
  assert.equal(state.email, 'someone@example.com');
});

test('T2 signIn：nonce 落 chrome.storage.session，並與送給後端的 nonce 一致', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ auth: { nonce: 'nonce-xyz' } });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  const written = env.storage.writes.filter(
    (w) => w.area === 'session' && !w.removed && JSON.stringify(w.value).includes('nonce-xyz')
  );
  assert.ok(written.length >= 1, 'nonce 必須寫進 chrome.storage.session（SW 回收後仍可比對）');
  assert.equal(env.auth.calls.exchange[0].nonce, 'nonce-xyz', '換 token 時要帶同一枚 nonce');
});

test('T2 signIn：三個環境各自送出對應的 Google client_id（D5，staging 已分家）', async () => {
  const TCLSync = loadSync();
  const cases = [
    { apiBase: PRODUCTION_BASE, clientId: CLIENT_ID_PRODUCTION, local: {} },
    { apiBase: STAGING_BASE, clientId: CLIENT_ID_STAGING, local: { syncApiBase: STAGING_BASE } },
    // local 沒有自己的 client：本機後端的 .dev.vars 仍設定舊(production)client。
    { apiBase: LOCAL_BASE, clientId: CLIENT_ID_PRODUCTION, local: { syncApiBase: LOCAL_BASE } },
  ];
  for (const c of cases) {
    const env = makeEnv({ local: c.local });
    const engine = TCLSync.create(env.deps);
    await engine.signIn();
    await settle();

    assert.equal(env.auth.calls.signIn.length, 1, `${c.apiBase}：應呼叫一次 signInWithGoogle`);
    // 這一個 clientId 同時餵給 auth.js 的 authorize URL(client_id 參數)與
    // id_token 的 aud 驗證(expected.clientId)——兩者是同一個變數，見
    // auth.js signInWithGoogle，這裡只需確認送對環境的值。
    assert.equal(
      env.auth.calls.signIn[0].clientId,
      c.clientId,
      `${c.apiBase} 應送出對應的 client_id`
    );
    assert.equal(env.auth.calls.signIn[0].apiBase, c.apiBase);
  }
});

test('T2 signIn：成功後立刻觸發一次同步', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  assert.ok(env.syncPosts().length >= 1, '登入成功後必須立刻跑一次 syncNow');
});

test('T2 signOut：帶 Bearer 打 sign-out，清 syncAuth／syncState 回預設', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ dirty: false, serverUpdatedAt: T0 })] });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle();

  const signOuts = env.server.requestsTo('/api/auth/sign-out', 'POST');
  assert.equal(signOuts.length, 1);
  assert.equal(signOuts[0].headers.authorization, 'Bearer tok-seeded');
  assert.equal((env.storage.syncAuth() || {}).token, null, 'token 必須清空');
  const state = await engine.getState();
  assert.equal(state.status, 'signed_out');
  assert.equal(state.email, null);
  assert.equal(state.lastSyncedAt, null);
});

test('T2 signOut：本機 history 保留，但 dirty 重置 true、serverUpdatedAt 重置 null', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'srv-a', url: POST_A, dirty: false, serverUpdatedAt: T0 - 1000 }),
      entry({ id: 'srv-b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 2000 }),
    ],
  });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle();

  const list = env.storage.history();
  assert.equal(list.length, 2, '登出不刪本機紀錄');
  list.forEach((e) => {
    assert.equal(e.dirty, true, '登出後全部標髒，下次登入重新全量上傳');
    assert.equal(e.serverUpdatedAt, null);
  });
});

test('T2 signOut：sign-out 請求失敗（503）也要完成本機清理', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 503, code: 'misconfigured' });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle();

  assert.equal((env.storage.syncAuth() || {}).token, null);
  const state = await engine.getState();
  assert.equal(state.status, 'signed_out');
});

test('T2 啟動驗 token：get-session 回 401 → 清 token、signed_out、lastError=session_expired', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true });
  env.server.failNext({ status: 401, code: 'unauthorized' });
  const engine = TCLSync.create(env.deps);
  await engine.verifySession();
  await settle();

  assert.equal(env.server.requestsTo('/api/auth/get-session', 'GET').length, 1);
  assert.equal((env.storage.syncAuth() || {}).token, null);
  const state = await engine.getState();
  assert.equal(state.status, 'signed_out');
  assert.equal(state.lastError, 'session_expired');
});

test('T2 啟動驗 token：get-session 回 200 但 body 為 null 同樣視為失效（api-spec 2.2）', async () => {
  const TCLSync = loadSync();
  // 伺服器端 session 已被撤銷；依 api-spec 2.2，get-session 回的是 null 而非 401。
  const env = makeEnv({ signedIn: true });
  env.server.expireSession();
  const engine = TCLSync.create(env.deps);
  await engine.verifySession();
  await settle();

  const state = await engine.getState();
  assert.equal(state.status, 'signed_out', 'null session 不能被當成「還登入著」');
  assert.equal(state.lastError, 'session_expired');
  assert.equal((env.storage.syncAuth() || {}).token, null);
});

test('T2 任何 API 回 401 都走同一條失效處理', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 401, code: 'unauthorized' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal((env.storage.syncAuth() || {}).token, null);
  const state = await engine.getState();
  assert.equal(state.status, 'signed_out');
  assert.equal(state.lastError, 'session_expired');
});

test('T2 任何回應帶 set-auth-token 就覆寫本地 token（含一般同步回應）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.rotateTokenOnNextResponse('tok-rotated-1');
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncAuth().token, 'tok-rotated-1', '輪替後的 token 必須覆寫本地存值');
});

test('T2/D9 apiBase：預設 production；syncApiBase 為 staging／local 時採用；其餘值忽略', async () => {
  const TCLSync = loadSync();

  const def = makeEnv({ signedIn: true, history: [entry()] });
  const e1 = TCLSync.create(def.deps);
  assert.equal((await e1.getState()).apiBase, PRODUCTION_BASE);

  const staged = makeEnv({
    signedIn: true,
    local: { syncApiBase: STAGING_BASE },
    server: { apiBase: STAGING_BASE },
    history: [entry()],
  });
  const e2 = TCLSync.create(staged.deps);
  assert.equal((await e2.getState()).apiBase, STAGING_BASE);
  await e2.syncNow();
  await settle();
  assert.ok(staged.syncPosts().length >= 1, 'staging 覆寫時請求要打到 staging base');

  // local:dev-browser --env local 寫入的開發機後端，白名單第三值。
  const localEnv = makeEnv({
    signedIn: true,
    local: { syncApiBase: LOCAL_BASE },
    server: { apiBase: LOCAL_BASE },
    history: [entry()],
  });
  const e3 = TCLSync.create(localEnv.deps);
  assert.equal((await e3.getState()).apiBase, LOCAL_BASE);
  await e3.syncNow();
  await settle();
  assert.ok(localEnv.syncPosts().length >= 1, 'local 覆寫時請求要打到 localhost:8787');

  const bogus = makeEnv({ signedIn: true, local: { syncApiBase: 'https://evil.example' } });
  const e4 = TCLSync.create(bogus.deps);
  assert.equal(
    (await e4.getState()).apiBase,
    PRODUCTION_BASE,
    'production／staging／local 以外的值一律忽略，不得跟著打過去'
  );

  // 白名單是逐字比對，不是前綴或子字串比對。以下三個都長得很像 local 的
  // 合法值:換個埠、把 localhost 當成攻擊者網域的一段、換成等價的迴圈位址。
  // 只要有一個被放行，bearer token 就會被送去那個 origin。
  const nearMisses = ['http://localhost:8788', 'http://localhost.evil', 'http://127.0.0.1:8787'];
  for (const value of nearMisses) {
    const near = makeEnv({ signedIn: true, local: { syncApiBase: value } });
    const engine = TCLSync.create(near.deps);
    assert.equal(
      (await engine.getState()).apiBase,
      PRODUCTION_BASE,
      `${value} 只是長得像白名單值，必須落回 production`
    );
  }
});

test('T2 每個請求都是 credentials:"omit" ＋ Bearer ＋ application/json', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.syncPosts();
  assert.ok(posts.length >= 1);
  posts.forEach((req) => {
    assert.equal(req.credentials, 'omit', 'D1：一律 credentials:"omit"，不夾帶 cookie');
    assert.equal(req.headers.authorization, 'Bearer tok-seeded');
    assert.match(req.headers['content-type'], /^application\/json/i, '否則後端回 415');
  });
});

// ============================================================================
// T3 — 同步往返
// ============================================================================

test('T3 未登入時 syncNow 是 no-op：零請求、不廣播 error', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(env.server.requests, [], '未登入不得發任何請求');
  assert.deepEqual(
    env.stateBroadcasts().filter((m) => m.state && m.state.status === 'error'),
    [],
    '未登入不是錯誤狀態'
  );
});

test('T3 推：只收集 dirty === true 的 entry', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'a', url: POST_A, dirty: true }),
      entry({ id: 'b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 5000 }),
    ],
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const body = env.syncPosts()[0].body;
  const ids = (body.upserts || []).map((it) => it.id);
  assert.deepEqual(ids, ['a'], '乾淨的 entry 不重送');
});

test('T3 推：上雲的 item 形狀符合 api-spec 3.1（original 缺席時以 url 補）', async () => {
  const TCLSync = loadSync();
  const at = T0 - 90_000;
  const raw = entry({ id: 'a', url: POST_A, at, receivedAt: at, seen: [{ at, kind: 'strip' }] });
  delete raw.original; // 伺服器 original 必填，缺席整筆會被靜默丟棄
  const env = makeEnv({ signedIn: true, history: [raw] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const item = env.syncPosts()[0].body.upserts[0];
  assert.equal(item.cleaned, POST_A);
  assert.equal(item.original, POST_A, 'original 缺席要以 url 補，否則整筆被伺服器丟棄');
  assert.equal(item.receivedAt, at, 'receivedAt 取 seen 最早一筆的 at');
  assert.equal(item.seen[0].source, 'clipboard', 'kind strip 依 D4 映射為 clipboard');
  assert.equal('kind' in item, false, 'kind 只留本機，不上雲（D4）');
});

test('T3 推：墓碑（deletedAt 非 null）走 deletes 陣列，不進 upserts', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [entry({ id: 'srv-a', url: POST_A, dirty: true, deletedAt: T0 - 1000 })],
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const body = env.syncPosts()[0].body;
  assert.deepEqual(body.deletes, ['srv-a']);
  assert.deepEqual(body.upserts || [], [], '墓碑不得同時出現在 upserts');
});

test('T3 ack：被推送的 entry 轉為 dirty=false、serverUpdatedAt 更新', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'a', url: POST_A })] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const e = env.storage.history()[0];
  assert.equal(e.dirty, false);
  assert.equal(typeof e.serverUpdatedAt, 'number', 'ack 後要記下伺服器的最後更新時間');
});

test('T3 ack：canonicalId 回傳時就地把本機 id 改名', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'loc-a', url: POST_A })] });
  // 雲端同一篇貼文早已有一張卡（手機端先建的），id 不同。
  env.server.seed([
    { id: 'srv-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 200_000, seen: [{ at: T0 - 200_000 }] },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const ids = env.storage.history().map((e) => e.id);
  assert.deepEqual(ids, ['srv-a'], 'canonicalId 必須就地覆寫本機 id，否則下次同步又分裂一張卡');
});

test('T3 ack：本機墓碑被 ack 後從 storage 真刪', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'srv-a', url: POST_A, dirty: true, deletedAt: T0 - 1000 }),
      entry({ id: 'srv-b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 3000 }),
    ],
  });
  env.server.seed([
    { id: 'srv-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 300_000, seen: [{ at: T0 - 300_000 }] },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const ids = env.storage.history().map((e) => e.id);
  assert.deepEqual(ids, ['srv-b'], '墓碑 ack 之後才真正移除，之前必須保留');
});

test('T3 推：超過單次 50 筆上限要分批多次往返（api-spec 7.2）', async () => {
  const TCLSync = loadSync();
  const history = [];
  for (let i = 0; i < 120; i += 1) {
    const at = T0 - 100_000 - i;
    const url = `https://www.threads.com/@u${i}/post/POST${String(i).padStart(6, '0')}`;
    history.push(entry({ id: `loc-${i}`, url, at, receivedAt: at, seen: [{ at, kind: 'strip' }] }));
  }
  const env = makeEnv({ signedIn: true, history });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(30);

  const posts = env.syncPosts();
  assert.ok(posts.length >= 3, `120 筆至少要拆成 3 次往返，實際 ${posts.length} 次`);
  posts.forEach((req) => {
    assert.ok((req.body.upserts || []).length <= MAX_SYNC_UPSERTS, '單次 upserts 不得超過 50');
  });
  const sent = new Set();
  posts.forEach((req) => (req.body.upserts || []).forEach((it) => sent.add(it.id)));
  assert.equal(sent.size, 120, '分批不得漏送');
  assert.equal(
    env.storage.history().filter((e) => e.dirty).length,
    0,
    '全部 ack 之後不應還有 dirty'
  );
});

test('T3 推：seen 總筆數上限 250 也要切批，不能只看 50 筆（隱藏案例）', async () => {
  const TCLSync = loadSync();
  const history = [];
  for (let i = 0; i < 20; i += 1) {
    const base = T0 - 500_000 - i * 1000;
    const url = `https://www.threads.com/@s${i}/post/SEEN${String(i).padStart(6, '0')}`;
    const seen = [];
    for (let j = 0; j < 40; j += 1) seen.push({ at: base + j, kind: 'strip' });
    history.push(entry({ id: `seen-${i}`, url, at: base, receivedAt: base, seen }));
  }
  const env = makeEnv({ signedIn: true, history });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(30);

  const posts = env.syncPosts();
  posts.forEach((req) => {
    const rows = (req.body.upserts || []).reduce((n, it) => n + (it.seen || []).length, 0);
    assert.ok(rows <= MAX_SYNC_SEEN_ROWS, `單次 seen 總筆數 ${rows} 超過 250，會被伺服器回 422`);
  });
  const err = (await TCLSync.create(env.deps).getState()).lastError;
  assert.equal(err, null, '正確切批就不該出現 too_many_seen');
});

test('T3 拉：帶 cursor、合併 items 進本機、更新 cursor', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [] });
  env.server.seed([
    { id: 'srv-b', original: POST_B, cleaned: POST_B, receivedAt: T0 - 20_000, author: '阿伯', seen: [{ at: T0 - 20_000, source: 'share' }] },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const body = env.syncPosts()[0].body;
  assert.ok('since' in body, '必須帶 since 才拿得到增量（不給＝changes 為 null）');
  const list = env.storage.history();
  assert.equal(list.length, 1);
  assert.equal(list[0].url, POST_B);
  assert.equal(list[0].postKey, postKeyOf(POST_B));
  assert.equal(list[0].dirty, false, '從雲端拉下來的資料不該立刻又標髒');
  assert.notEqual(env.storage.syncState().cursor, '0', 'cursor 必須更新');
});

test('T3 拉：cursor 為 null 的首輪也要拉增量（隱藏案例）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, syncState: { cursor: null }, history: [] });
  env.server.seed([
    { id: 'srv-b', original: POST_B, cleaned: POST_B, receivedAt: T0 - 20_000, seen: [{ at: T0 - 20_000 }] },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const body = env.syncPosts()[0].body;
  assert.ok(
    body.since !== undefined && body.since !== null,
    'cursor 為 null 時省略 since，伺服器 changes 回 null，首次登入永遠拉不到雲端既有資料'
  );
  assert.equal(env.storage.history().length, 1, '首輪就該把雲端既有卡片拉下來');
});

test('T3 拉：同 postKey 合併成一筆，墓碑復活', async () => {
  const TCLSync = loadSync();
  const local = entry({ id: 'loc-a', url: POST_A, dirty: false, serverUpdatedAt: T0 - 9000, deletedAt: T0 - 9000 });
  const env = makeEnv({ signedIn: true, history: [local] });
  env.server.seed([
    { id: 'srv-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 1000, author: '愛麗絲', seen: [{ at: T0 - 1000, source: 'share' }] },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const list = env.storage.history().filter((e) => postKeyOf(e.url) === postKeyOf(POST_A));
  assert.equal(list.length, 1, '同一篇貼文只能有一張卡');
  assert.equal(list[0].deletedAt, null, '雲端有更新的事件時墓碑要復活');
  assert.equal(list[0].author, '愛麗絲');
});

test('T3 拉：回應 tombstones 對應的 postKey 在本機硬刪', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'srv-c', url: POST_C, dirty: false, serverUpdatedAt: T0 - 8000 }),
      entry({ id: 'srv-b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 8000 }),
    ],
  });
  env.server.seedTombstone(POST_C, 'srv-c', T0 - 1000);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const urls = env.storage.history().map((e) => e.url);
  assert.deepEqual(urls, [POST_B], '雲端墓碑要在本機硬刪，不是留一個本機墓碑');
});

test('T3 拉：回應 clearedAt → 本機 receivedAt < clearedAt 的 entry 硬刪', async () => {
  const TCLSync = loadSync();
  const cleared = T0 - 50_000;
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'old', url: POST_A, at: cleared - 10_000, receivedAt: cleared - 10_000, dirty: false, serverUpdatedAt: cleared - 10_000, seen: [{ at: cleared - 10_000, kind: 'strip' }] }),
      entry({ id: 'new', url: POST_B, at: cleared + 10_000, receivedAt: cleared + 10_000, dirty: false, serverUpdatedAt: cleared + 10_000, seen: [{ at: cleared + 10_000, kind: 'strip' }] }),
    ],
  });
  env.server.seed([], { clearedAt: cleared });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const ids = env.storage.history().map((e) => e.id);
  assert.deepEqual(ids, ['new'], '只刪早於全域墓碑水位線的那些');
});

test('T3 拉：hasMore 為 true 時立刻用新 cursor 再拉一次', async () => {
  const TCLSync = loadSync();
  const seedItems = [];
  for (let i = 0; i < 260; i += 1) {
    const at = T0 - 400_000 + i;
    seedItems.push({
      id: `srv-${i}`,
      original: `https://www.threads.com/@m${i}/post/MANY${String(i).padStart(6, '0')}`,
      cleaned: `https://www.threads.com/@m${i}/post/MANY${String(i).padStart(6, '0')}`,
      receivedAt: at,
      seen: [{ at }],
    });
  }
  const env = makeEnv({ signedIn: true, history: [] });
  env.server.seed(seedItems);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(30);

  assert.ok(env.syncPosts().length >= 2, 'hasMore 必須立刻續拉，不能等下一個 alarm');
  assert.equal(env.storage.history().length, 260, '積壓要拉完');
});

test('T3 clearedAt：推送前先打 DELETE /api/v1/links，成功後清空並作廢舊 cursor', async () => {
  // PM 裁決：api-spec 4.3 的 SyncRequest 沒有 clearedAt 欄位；「清空全部」的
  // 雲端語意就是 DELETE /api/v1/links（api-spec 4.4:459-467）——伺服器自己寫
  // cleared_at，其他裝置下次拉取時據此清本機。
  const TCLSync = loadSync();
  const cleared = T0 - 30_000;
  const staleCursor = '1699999999999~srv-old';
  const env = makeEnv({
    signedIn: true,
    syncState: { clearedAt: cleared, cursor: staleCursor },
    history: [entry({ id: 'a', url: POST_A, at: T0 - 10_000, receivedAt: T0 - 10_000, dirty: true })],
  });
  env.server.seed([
    { id: 'srv-old', original: POST_B, cleaned: POST_B, receivedAt: T0 - 400_000, seen: [{ at: T0 - 400_000 }] },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(10);

  const deletes = env.server.requestsTo('/api/v1/links', 'DELETE');
  assert.equal(deletes.length, 1, 'clearedAt 非 null 時要先把雲端清掉');
  assert.equal(deletes[0].headers.authorization, 'Bearer tok-seeded');
  assert.equal(env.server.linkCount(), 0, '雲端資料要被清光');

  const firstPush = env.syncPosts()[0];
  assert.ok(firstPush, '清完之後照樣走完這一輪的推拉');
  assert.ok(
    env.server.requests.indexOf(deletes[0]) < env.server.requests.indexOf(firstPush),
    'DELETE 必須早於推送，否則剛推上去的又被自己清掉'
  );
  assert.notEqual(firstPush.body.since, staleCursor, 'cursor 歸零：舊游標對清空後的雲端已無意義');
  assert.equal(env.storage.syncState().clearedAt, null, '成功後清空本機 clearedAt，不得每輪重刪');
});

test('T3 單飛：同時三次 syncNow 只跑一輪往返', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1); // 第一次請求的回應延後結算
  const engine = TCLSync.create(env.deps);

  const p1 = engine.syncNow();
  const p2 = engine.syncNow();
  const p3 = engine.syncNow();
  await settle(4);
  assert.equal(env.syncPosts().length, 1, '進行中時重複呼叫不得再發一次請求');

  release();
  await Promise.all([p1, p2, p3]);
  await settle();
  assert.equal(env.syncPosts().length, 1);
});

test('T3 單飛：進行中旗標存 chrome.storage.session（SW 回收即自然過期）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);

  const sessionKeys = Object.keys(env.storage.sessionData);
  assert.ok(sessionKeys.length >= 1, '進行中旗標必須落 session，不能只放模組變數');
  const localKeys = Object.keys(env.storage.localData);
  assert.equal(
    localKeys.some((k) => /inflight|running|syncing/i.test(k)),
    false,
    '旗標不得寫 local，否則 SW 被殺會永久卡死'
  );

  release();
  await running;
  await settle();
  assert.equal(
    Object.keys(env.storage.sessionData).some((k) => /inflight|running|syncing/i.test(k)) &&
      JSON.stringify(env.storage.sessionData).includes('true'),
    false,
    '結束後要把旗標放回去'
  );
});

test('T3 SW 中斷：旗標殘留但 session 已清空時，新引擎照樣跑得動', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const abandoned = engine.syncNow();
  await settle(4);
  assert.equal(env.syncPosts().length, 1);

  // SW 被回收：session 區整個消失，local 保留。
  const revived = env.recreate(TCLSync, false);
  await revived.syncNow();
  await settle(10);
  assert.equal(env.syncPosts().length, 2, 'session 過期即解除單飛，不得永久卡死');

  release(1);
  await abandoned.catch(() => {});
  await settle();
});

test('T3 往返期間新寫入的 entry 保持 dirty（只清本輪快照）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'a', url: POST_A })] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);

  // 往返還沒回來，recordHistory 又寫了一筆（模擬使用者剛複製一則新貼文）。
  env.storage.localData.history = env.storage.localData.history.concat([
    entry({ id: 'b', url: POST_B, at: T0, receivedAt: T0, seen: [{ at: T0, kind: 'icon' }] }),
  ]);

  release();
  await running;
  await settle(10);

  const byId = Object.fromEntries(env.storage.history().map((e) => [e.id, e]));
  assert.equal(byId.a.dirty, false, '本輪快照內的 entry 要清 dirty');
  assert.ok(byId.b, '往返期間新寫入的 entry 不得被覆蓋掉');
  assert.equal(byId.b.dirty, true, '不在本輪快照內的 entry 必須保持 dirty，否則永遠不會上雲');
});

test('T3 完成：lastSyncedAt／pendingCount／lastError 更新並廣播', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, syncState: { lastError: 'network_error' }, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const state = await engine.getState();
  assert.equal(state.lastSyncedAt, T0);
  assert.equal(state.pendingCount, 0);
  assert.equal(state.lastError, null, '成功後要清掉上一次的錯誤');
  assert.ok(env.stateBroadcasts().length >= 1);
});

test('T3 失敗：lastError 為錯誤碼字串，且至少廣播一次 status:"error"', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ kind: 'network' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const errors = env.stateBroadcasts().filter((m) => m.state && m.state.status === 'error');
  assert.ok(errors.length >= 1, '失敗必須廣播，否則 UI 永遠停在 syncing');
  assert.equal(typeof errors[errors.length - 1].state.lastError, 'string');
  assert.ok(errors[errors.length - 1].state.lastError.length > 0);
});

test('T3 history 寫入一律走注入的 writeChain，且不與其他寫入交錯', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [entry({ id: 'a', url: POST_A }), entry({ id: 'b', url: POST_B })],
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(10);

  const historyWrites = env.storage.historyWrites();
  assert.ok(historyWrites.length >= 1, '同步至少要回寫一次 history');
  historyWrites.forEach((w) => {
    assert.equal(w.inChain, true, 'history 的讀改寫必須包在 historyWriteChain 內，否則與 recordHistory 互相覆蓋');
  });
});

// ============================================================================
// T4 — 錯誤與退避
// ============================================================================

test('T4 429：讀 Retry-After 排下一次 alarm，不立即重試', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 429, code: 'rate_limited', retryAfter: 90 });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.syncPosts().length, 1, '429 收到就退避，不得立即重試');
  const delay = env.alarms.delayOf(env.alarms.lastCreate(), env.now());
  assert.equal(delay, 90_000, '下一次同步要排在 Retry-After 指定的秒數之後');
  assert.equal((await engine.getState()).lastError, 'rate_limited');
});

test('T4 429：沒帶 Retry-After 時退回預設退避，不得算成 NaN（隱藏案例）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 429, code: 'rate_limited', body: { error: 'rate_limited' } });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const delay = env.alarms.delayOf(env.alarms.lastCreate(), env.now());
  assert.equal(typeof delay, 'number');
  assert.ok(Number.isFinite(delay) && delay > 0, `Retry-After 缺席時的退避必須是有限正數，實際 ${delay}`);
});

test('T4 403 forbidden_origin：不重試、記錯誤碼', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 403, code: 'forbidden_origin' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.syncPosts().length, 1, '403 是程式錯誤，重試永遠不會成功');
  assert.equal((await engine.getState()).lastError, 'forbidden_origin');
});

test('T4 415／503：進入退避曲線', async () => {
  const TCLSync = loadSync();
  for (const failure of [{ status: 415, code: 'unsupported_media_type' }, { status: 503, code: 'misconfigured' }]) {
    const env = makeEnv({ signedIn: true, history: [entry()] });
    env.server.failNext(failure);
    const engine = TCLSync.create(env.deps);
    await engine.syncNow();
    await settle();

    const delay = env.alarms.delayOf(env.alarms.lastCreate(), env.now());
    assert.equal(delay, 30_000, `${failure.code} 第一次失敗要退避到 30 秒`);
    assert.equal((await engine.getState()).lastError, failure.code);
  }
});

test('T4 網路錯誤：退避曲線照手機 pollIntervalFor（首次失敗不加倍，600s 封頂）', async () => {
  // PM 裁決：以手機端 src/lib/sync/scheduler.ts 的 pollIntervalFor 為準——
  //   POLL_INTERVAL_MS = 30_000（scheduler.ts:17）
  //   POLL_BACKOFF_MAX_MS = 600_000（scheduler.ts:19）
  //   pollIntervalFor(f) = f <= 0 ? 30s : min(30s * 2 ** (f - 1), 600s)
  //     （scheduler.ts:31-34）
  // 亦即 30s（正常）→ 30s（第一次失敗，刻意不加倍）→ 60s → 120s → 240s →
  // 480s → 600s（封頂），原文註解見 scheduler.ts:26。
  const TCLSync = loadSync();
  const expected = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000];
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);

  for (let i = 0; i < expected.length; i += 1) {
    env.server.failNext({ kind: 'network' });
    await engine.syncNow();
    await settle();
    const delay = env.alarms.delayOf(env.alarms.lastCreate(), env.now());
    assert.equal(delay, expected[i], `第 ${i + 1} 次連續失敗的退避應為 ${expected[i]}ms`);
    env.advance(expected[i]);
  }
});

test('T4 成功後退避重置回基礎週期', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  env.server.failNext({ kind: 'network' }, 2);
  await engine.syncNow();
  await settle();
  env.advance(60_000);
  await engine.syncNow();
  await settle();
  assert.equal(env.alarms.delayOf(env.alarms.lastCreate(), env.now()), 60_000);

  env.advance(60_000);
  await engine.syncNow();
  await settle();
  const delay = env.alarms.delayOf(env.alarms.lastCreate(), env.now());
  assert.equal(delay, TCLSync.SYNC_PERIOD_MINUTES * 60_000, '成功一次就要把退避歸零');
  assert.equal((await engine.getState()).lastError, null);
});

// ============================================================================
// T5 — 排程
// ============================================================================

test('T5 登入後建立週期 alarm，名稱固定且週期不低於 1 分鐘', async () => {
  const TCLSync = loadSync();
  const env = makeEnv();
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle();

  const periodic = env.alarms
    .creates()
    .filter((c) => c.name === TCLSync.ALARM_NAME && typeof c.info.periodInMinutes === 'number');
  assert.ok(periodic.length >= 1, '登入後必須建立週期 alarm');
  periodic.forEach((c) => {
    assert.ok(c.info.periodInMinutes >= 1, 'MV3 週期 alarm 不得低於 1 分鐘（D12）');
  });
});

test('T5 登出時清除 alarm', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle();

  assert.ok(
    env.alarms.clears().some((c) => c.name === TCLSync.ALARM_NAME),
    '登出後不得留下週期 alarm 繼續打後端'
  );
});

test('T5 recordHistory 後去抖：2 秒 setTimeout ＋ 30 秒 alarm 雙保險', async () => {
  // PM 裁決：Chrome 的 alarm 最小間隔是 30 秒，2 秒排不出來。去抖走注入的
  // setTimeout（SW 存活期），另排一個 30 秒的 alarm 當 SW 被回收時的保底；
  // 兩條路任一先到就跑 syncNow，單飛旗標保證只跑一次。
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();

  assert.deepEqual(env.syncPosts(), [], '去抖期間不得立刻同步');
  assert.equal(TCLSync.DEBOUNCE_MS, 2000);
  assert.equal(env.timers.live.length, 1, '必須用注入的 setTimeout 排 SW 存活期的去抖');
  assert.equal(env.timers.live[0].ms, TCLSync.DEBOUNCE_MS, '去抖 2 秒');

  const guard = env.alarms.lastCreate();
  assert.ok(guard, 'SW 可能在 2 秒內就被回收，必須另排 alarm 保底');
  assert.equal(env.alarms.delayOf(guard, env.now()), 30_000, 'alarm 保底排在 30 秒（Chrome 的最小間隔）');
  assert.notEqual(
    guard.name,
    TCLSync.ALARM_NAME,
    '保底 alarm 不得與週期 alarm 同名，同名建立會把週期排程整個蓋掉'
  );
});

test('T5 去抖：setTimeout 先到就同步，隨後保底 alarm 到期不得重跑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();
  const guard = env.alarms.lastCreate();
  assert.ok(guard);

  env.advance(TCLSync.DEBOUNCE_MS);
  await env.runTimers(); // SW 還活著：2 秒那條先到
  await settle(10);
  assert.equal(env.syncPosts().length, 1, 'setTimeout 到期要跑一次同步');

  env.advance(30_000);
  await engine.onAlarm({ name: guard.name });
  await settle(10);
  assert.equal(env.syncPosts().length, 1, '去抖已經跑過，保底 alarm 到期不得再跑一次');
});

test('T5 連續 recordHistory 只留最後一次的去抖排程（計時器與保底 alarm 一起重排）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();
  const first = env.timers.calls[0];
  assert.ok(first);

  env.advance(1000);
  await engine.notifyRecorded();
  await settle();

  assert.ok(env.timers.cleared.includes(first), '前一個去抖計時器要取消，從最後一次寫入起算');
  assert.equal(env.timers.live.length, 1, '同時只留一個去抖計時器');
  assert.equal(env.timers.live[0].ms, TCLSync.DEBOUNCE_MS);
  assert.equal(env.alarms.delayOf(env.alarms.lastCreate(), env.now()), 30_000, '保底 alarm 一併重排');
  assert.deepEqual(env.syncPosts(), [], '連續分享十次只在安靜之後同步一次');
});

test('T5 onAlarm：收到自家 alarm 才跑同步，別人的 alarm 一律忽略', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);

  await engine.onAlarm({ name: 'someone-elses-alarm' });
  await settle();
  assert.deepEqual(env.syncPosts(), [], '不是自家 alarm 不得動作');

  await engine.onAlarm({ name: TCLSync.ALARM_NAME });
  await settle(10);
  assert.equal(env.syncPosts().length, 1);
});

test('T5 getState：距上次同步超過門檻時順便觸發一次', async () => {
  const TCLSync = loadSync();
  const stale = makeEnv({
    signedIn: true,
    history: [entry()],
    syncState: { lastSyncedAt: T0 - 10 * 60 * 60_000 },
  });
  const e1 = TCLSync.create(stale.deps);
  await e1.getState();
  await settle(10);
  assert.ok(stale.syncPosts().length >= 1, 'options／popup 開啟時該補一次同步');

  const fresh = makeEnv({ signedIn: true, history: [entry()], syncState: { lastSyncedAt: T0 - 1000 } });
  const e2 = TCLSync.create(fresh.deps);
  await e2.getState();
  await settle(10);
  assert.deepEqual(fresh.syncPosts(), [], '剛同步過就不要每次開頁都打一次後端（60/60s 限流共用一桶）');
});

test('T5 排程狀態全在 storage：SW 回收重建引擎後退避不歸零', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const first = TCLSync.create(env.deps);
  env.server.failNext({ kind: 'network' });
  await first.syncNow();
  await settle();
  assert.equal(env.alarms.delayOf(env.alarms.lastCreate(), env.now()), 30_000);

  // SW 被殺，模組變數全沒了；storage 保留。
  env.advance(30_000);
  const revived = env.recreate(TCLSync, false);
  env.server.failNext({ kind: 'network' });
  await revived.syncNow();
  await settle();
  assert.equal(
    env.alarms.delayOf(env.alarms.lastCreate(), env.now()),
    60_000,
    '連續失敗次數必須落 storage，否則 SW 每次被殺退避就重來，等於沒有退避'
  );
});

test('T5 manifest 必須宣告 alarms 權限，否則 chrome.alarms 不存在', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  assert.ok(
    (manifest.permissions || []).includes('alarms'),
    'D12 的週期同步靠 chrome.alarms，manifest.permissions 必須含 "alarms"'
  );
});

// ============================================================================
// T6（引擎側）— deleteCloud 的本機語意
// ============================================================================

test('T6 deleteCloud：打 DELETE /api/v1/links，本機保留但不重推', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'a', url: POST_A, dirty: true, serverUpdatedAt: T0 - 100 }),
      entry({ id: 'b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 200 }),
    ],
  });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle(10);

  const deletes = env.server.requestsTo('/api/v1/links', 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].headers.authorization, 'Bearer tok-seeded');

  const list = env.storage.history();
  assert.equal(list.length, 2, '刪雲端不動本機紀錄');
  list.forEach((e) => {
    assert.equal(e.dirty, false, '刪雲端後不得重新上傳，否則資料立刻又長回來');
    assert.equal(e.serverUpdatedAt, null);
  });
  assert.equal(env.storage.syncState().cursor, null, 'cursor 要歸零，避免拿舊游標拉到不存在的增量');
});

test('T6 deleteCloud：刪完不得順手再跑一次同步把本機推回雲端（隱藏案例）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ dirty: true })] });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle(10);

  assert.deepEqual(env.syncPosts(), [], '刪雲端後緊接著一次同步，等於使用者的刪除完全無效');
  assert.equal(env.server.linkCount(), 0);
});

// ============================================================================
// T7 — pendingCount
// ============================================================================

test('T7 pendingCount 等於 dirty === true 的 entry 數（含墓碑）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'a', url: POST_A, dirty: true }),
      entry({ id: 'b', url: POST_B, dirty: false, serverUpdatedAt: T0 }),
      entry({ id: 'c', url: POST_C, dirty: true, deletedAt: T0 - 1 }),
    ],
  });
  const engine = TCLSync.create(env.deps);
  const state = await engine.getState();
  assert.equal(state.pendingCount, 2, '墓碑也算待同步');
});

test('T7 未登入時 getState 回計劃 5.2 的完整形狀', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: [entry({ dirty: true })] });
  const engine = TCLSync.create(env.deps);
  const state = await engine.getState();

  assert.deepEqual(Object.keys(state).sort(), [
    'apiBase',
    // D15（車道 A）：帳號入口顯示用，見上方 signIn／verifySession 相關測試。
    'avatarUrl',
    'displayName',
    'email',
    'lastError',
    'lastSyncedAt',
    'pendingCount',
    'status',
  ]);
  assert.equal(state.status, 'signed_out');
  assert.equal(state.email, null);
  assert.equal(state.apiBase, PRODUCTION_BASE);
});

// ============================================================================
// T8 — mock 伺服器自身的契約自我檢查（綠燈；引擎的行為預言機必須先是對的）
// ============================================================================

test('T8 mock：Content-Type 不是 application/json 一律 415（api-spec 4.3:388）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  server.grantToken('tok-1');
  const res = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: 'Bearer tok-1', 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(res.status, 415);
  assert.deepEqual(await res.json(), { error: 'unsupported_media_type' });
});

test('T8 mock：登入回應帶 set-auth-token 標頭（插件契約第 3 點）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const res = await server.fetch(`${PRODUCTION_BASE}/api/auth/sign-in/social`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'google', idToken: { token: 'x' } }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-auth-token'), server.currentToken());
  assert.equal(res.headers.get('SET-AUTH-TOKEN'), server.currentToken(), '標頭讀取大小寫不敏感');
});

test('T8 mock：未帶 Bearer 回 401；get-session 未登入回 null（api-spec 2.2）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const noAuth = await server.fetch(`${PRODUCTION_BASE}/api/v1/links`, { method: 'GET', credentials: 'omit' });
  assert.equal(noAuth.status, 401);
  assert.deepEqual(await noAuth.json(), { error: 'unauthorized' });

  const session = await server.fetch(`${PRODUCTION_BASE}/api/auth/get-session`, {
    method: 'GET',
    credentials: 'omit',
  });
  assert.equal(session.status, 200);
  assert.equal(await session.json(), null);
});

test('T8 mock：同 post_key 的既有卡回 canonicalId，不新增一列（api-spec 4.3 規則 4）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const token = server.grantToken('tok-1');
  server.seed([{ id: 'srv-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 5000, seen: [{ at: T0 - 5000 }] }]);
  const res = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upserts: [{ id: 'loc-a', original: POST_A, cleaned: POST_A, receivedAt: T0, seen: [{ at: T0, source: 'share' }] }],
      since: 0,
    }),
  });
  const body = await res.json();
  assert.deepEqual(body.applied.upserts, [{ id: 'loc-a', canonicalId: 'srv-a' }]);
  assert.equal(server.linkCount(), 1);
  assert.ok(body.changes, '帶了 since 就要回增量');
});

test('T8 mock：早於墓碑的事件被拒收，比墓碑新則撤銷墓碑（規則 3）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const token = server.grantToken('tok-1');
  server.seedTombstone(POST_A, 'srv-a', T0 - 1000);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const stale = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers,
    body: JSON.stringify({
      upserts: [{ id: 'loc-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 5000, seen: [{ at: T0 - 5000 }] }],
    }),
  });
  assert.deepEqual((await stale.json()).applied.rejectedIds, ['loc-a']);

  const fresh = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers,
    body: JSON.stringify({
      upserts: [{ id: 'loc-a', original: POST_A, cleaned: POST_A, receivedAt: T0 + 5000, seen: [{ at: T0 + 5000 }] }],
    }),
  });
  assert.equal((await fresh.json()).applied.upserts.length, 1);
  assert.equal(server.tombstoneCount(), 0, '比墓碑新＝又分享了一次，要撤銷墓碑');
});

test('T8 mock：超過 50 筆 upserts 回 422 too_many_upserts（api-spec 7.2）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const token = server.grantToken('tok-1');
  const upserts = [];
  for (let i = 0; i < MAX_SYNC_UPSERTS + 1; i += 1) {
    const url = `https://www.threads.com/@x${i}/post/XXXX${String(i).padStart(6, '0')}`;
    upserts.push({ id: `x-${i}`, original: url, cleaned: url, receivedAt: T0 - i, seen: [{ at: T0 - i }] });
  }
  const res = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upserts }),
  });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'too_many_upserts', max: 50 });
});

test('T8 mock：429 附 Retry-After 標頭與 retryAfter 欄位（api-spec 7.4）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  server.grantToken('tok-1');
  server.failNext({ status: 429, code: 'rate_limited', retryAfter: 60 });
  const res = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: 'Bearer tok-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.deepEqual(await res.json(), { error: 'rate_limited', retryAfter: 60 });
});

test('T8 mock：DELETE /api/v1/links 寫 clearedAt，之後舊資料一律拒收（api-spec 4.4）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const token = server.grantToken('tok-1');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  server.seed([{ id: 'srv-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 5000, seen: [{ at: T0 - 5000 }] }]);

  const cleared = await server.fetch(`${PRODUCTION_BASE}/api/v1/links`, { method: 'DELETE', credentials: 'omit', headers });
  const clearedBody = await cleared.json();
  assert.equal(clearedBody.ok, true);
  assert.equal(typeof clearedBody.clearedAt, 'number');
  assert.equal(server.linkCount(), 0);

  const replay = await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers,
    body: JSON.stringify({
      upserts: [{ id: 'srv-a', original: POST_A, cleaned: POST_A, receivedAt: T0 - 5000, seen: [{ at: T0 - 5000 }] }],
      since: 0,
    }),
  });
  const body = await replay.json();
  assert.deepEqual(body.applied.rejectedIds, ['srv-a'], '早於 clearedAt 的資料不得被寫回去');
  assert.equal(body.changes.clearedAt, clearedBody.clearedAt);
});

test('T8 mock：holdNext 延遲回應到下一個 tick 才結算（競態測試的基礎設施）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  server.grantToken('tok-1');
  const release = server.holdNext(1);
  let settled = false;
  const pending = server
    .fetch(`${PRODUCTION_BASE}/api/auth/get-session`, {
      method: 'GET',
      credentials: 'omit',
      headers: { Authorization: 'Bearer tok-1' },
    })
    .then((res) => {
      settled = true;
      return res;
    });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, 'release 之前不得結算');
  assert.equal(server.pendingCount(), 1);
  release();
  const res = await pending;
  assert.equal(settled, true);
  assert.equal(res.status, 200);
});

test('T8 mock：側錄每次請求的標頭、body 與 credentials', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  const token = server.grantToken('tok-1');
  await server.fetch(`${PRODUCTION_BASE}/api/v1/links/sync`, {
    method: 'POST',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upserts: [], deletes: ['gone'], since: '0' }),
  });
  const req = server.lastRequest();
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/v1/links/sync');
  assert.equal(req.credentials, 'omit');
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(req.body.deletes, ['gone']);
});

// ============================================================================
// 安全審查追加案例（新增，不改既有）
// ============================================================================

// 游標搶跑:cursor 一旦在 applyResponse 之前就前進，寫入失敗時失敗路徑的
// saveState 會把已前進的游標落盤，這一頁的增量從此再也拉不回來——伺服器只認
// 游標，不會重送。
test('T3 游標不搶跑：history 寫入失敗時 cursor 不前進，下一輪重拉同一頁', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, syncState: { cursor: '0' }, history: [] });
  env.server.seed([
    { id: 'srv-b', original: POST_B, cleaned: POST_B, receivedAt: T0 - 20_000, seen: [{ at: T0 - 20_000 }] },
  ]);

  // 只讓 history 那一次寫入失敗（模擬撞到 chrome.storage 配額）；syncState 等
  // 其他鍵照常寫得進去，才測得到「失敗路徑會不會把游標一起落盤」。
  const brokenDeps = Object.assign({}, env.deps, {
    storage: {
      session: env.deps.storage.session,
      local: Object.assign({}, env.deps.storage.local, {
        set(items) {
          if (Object.prototype.hasOwnProperty.call(items, 'history')) {
            return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
          }
          return env.deps.storage.local.set(items);
        },
      }),
    },
  });

  const broken = TCLSync.create(brokenDeps);
  await broken.syncNow();
  await settle(15);

  assert.equal(env.storage.syncState().cursor, '0', 'history 沒落地，游標不得前進');
  assert.equal(env.storage.syncState().lastError, 'storage_quota', '配額失敗要記成可辨識的錯誤碼');
  assert.deepEqual(env.storage.history(), [], '本輪什麼都沒寫進去');

  const healthy = TCLSync.create(env.deps);
  await healthy.syncNow();
  await settle(15);

  const posts = env.syncPosts();
  assert.equal(posts[posts.length - 1].body.since, '0', '下一輪必須用同一個游標重拉');
  assert.equal(env.storage.history().length, 1, '重拉之後那一頁才補得回來');
});

// 拉取是唯一會把 history 變長的寫入路徑;沒有容量上限，雲端資料多於本機上限
// 時會直接把 chrome.storage.local 寫爆。
test('T3 拉：寫回前套用注入的 capHistory 容量上限', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [] });
  const seedItems = [];
  for (let i = 0; i < 6; i += 1) {
    const at = T0 - 300_000 + i;
    const url = `https://www.threads.com/@c${i}/post/CAPS${String(i).padStart(6, '0')}`;
    seedItems.push({ id: `cap-${i}`, original: url, cleaned: url, receivedAt: at, seen: [{ at }] });
  }
  env.server.seed(seedItems);

  const capCalls = [];
  const deps = Object.assign({}, env.deps, {
    capHistory: (list) => {
      capCalls.push(list.length);
      return list.slice(0, 2);
    },
  });
  const engine = TCLSync.create(deps);
  await engine.syncNow();
  await settle(15);

  assert.ok(capCalls.length >= 1, '每一次寫回 history 之前都要過容量上限');
  assert.ok(capCalls.some((n) => n === 6), '傳給 capHistory 的是裁切前的完整清單');
  assert.equal(env.storage.history().length, 2, '超出上限的部分要被裁掉，不得整份寫下去');
});

// 契約第 7 點:403 forbidden_origin 是程式錯誤或後端 allowlist 設定錯誤，
// 「別重試」。排下一次 alarm 等於每隔幾分鐘用同一份必然失敗的請求去敲 60 次／
// 60 秒的限流桶（與手機端共用同一桶）。
test('T4 403 forbidden_origin：不排下一次 alarm', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 403, code: 'forbidden_origin' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(env.alarms.creates(), [], '不可重試的錯誤不得排下一次同步');
  assert.equal(env.storage.syncState().lastError, 'forbidden_origin', '錯誤碼照樣要記');
});

test('T2 登出失效：週期與去抖保底兩支 alarm 都要清', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();
  const guard = env.alarms.lastCreate();
  assert.ok(guard && guard.name !== TCLSync.ALARM_NAME, '前置條件:去抖保底 alarm 已排下');

  env.server.failNext({ status: 401, code: 'unauthorized' });
  await engine.syncNow();
  await settle(10);

  const cleared = env.alarms.clears().map((c) => c.name);
  assert.ok(cleared.includes(TCLSync.ALARM_NAME), '週期 alarm 要清');
  assert.ok(cleared.includes(guard.name), '去抖保底 alarm 也要清，否則登出後照樣喚醒 SW 白跑一輪');
});

// SW 每次被喚醒（每一則訊息、每一個 alarm）都會啟動驗一次;60 次／60 秒的
// 限流桶與手機端共用，光是驗 session 就能把它吃光。
test('T2 verifySession：距上次驗證未滿門檻就跳過，過了門檻才再驗', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true });
  const first = TCLSync.create(env.deps);
  await first.verifySession();
  await settle(10);
  assert.equal(env.server.requestsTo('/api/auth/get-session', 'GET').length, 1);

  // SW 被回收後重建（session 清空、local 保留）：節流狀態必須落 local，
  // 否則每次喚醒都會再打一次。
  const revived = env.recreate(TCLSync, false);
  await revived.verifySession();
  await settle(10);
  assert.equal(
    env.server.requestsTo('/api/auth/get-session', 'GET').length,
    1,
    '門檻內重複喚醒不得再打一次 get-session'
  );

  env.advance(6 * 60_000);
  const later = env.recreate(TCLSync, false);
  await later.verifySession();
  await settle(10);
  assert.equal(
    env.server.requestsTo('/api/auth/get-session', 'GET').length,
    2,
    '過了門檻要照常驗，不能永久跳過'
  );
});

test('T2 signIn：送給後端的 nonce 是從 session 讀回來的那一枚', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ auth: { nonce: 'nonce-roundtrip' } });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle(10);

  assert.equal(env.auth.calls.exchange.length, 1);
  assert.equal(env.auth.calls.exchange[0].nonce, 'nonce-roundtrip');
  assert.equal(env.storage.syncAuth().token, env.server.currentToken(), '登入應完成');
});

test('T2 signIn：session 讀不回同一枚 nonce 時整條拒收，不換 token', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ auth: { nonce: 'nonce-good' } });
  // session 寫得進去卻讀回別的值＝狀態已不可信（被別的流程蓋掉／儲存區異常）。
  const tamperedDeps = Object.assign({}, env.deps, {
    storage: {
      local: env.deps.storage.local,
      session: Object.assign({}, env.deps.storage.session, {
        get(keys) {
          return Promise.resolve({ syncNonce: 'nonce-tampered' });
        },
      }),
    },
  });
  const engine = TCLSync.create(tamperedDeps);
  await engine.signIn();
  await settle(10);

  assert.deepEqual(env.auth.calls.exchange, [], 'nonce 對不上就不得拿 id_token 去換 token');
  assert.equal((env.storage.syncAuth() || {}).token, undefined, '不得留下任何 token');
  assert.equal(env.storage.syncState().lastError, 'nonce_mismatch');
});

test('T2 每個請求都關掉自動跟隨轉址（redirect:"error"）', async () => {
  const TCLSync = loadSync();
  const seen = [];
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const spyDeps = Object.assign({}, env.deps, {
    fetch: (url, init) => {
      seen.push(init);
      return env.deps.fetch(url, init);
    },
  });
  const engine = TCLSync.create(spyDeps);
  await engine.syncNow();
  await settle(10);

  assert.ok(seen.length >= 1);
  seen.forEach((init) => {
    assert.equal(
      init.redirect,
      'error',
      '跟著轉址走的話，轉址目的地的 set-auth-token 也會被當成後端發的 token'
    );
  });
});

test('T4 403 forbidden_origin：連既有的週期 alarm 也要清掉', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);

  // 先成功一輪，讓週期 alarm 真的建起來（登入成功那一輪也會建同一支）。
  await engine.syncNow();
  await settle(10);
  assert.ok(
    env.alarms.creates().some((c) => c.name === TCLSync.ALARM_NAME && typeof c.info.periodInMinutes === 'number'),
    '前置條件:週期 alarm 已建立'
  );

  env.advance(10 * 60_000);
  env.server.failNext({ status: 403, code: 'forbidden_origin' });
  await engine.syncNow();
  await settle(10);

  assert.ok(
    env.alarms.clears().some((c) => c.name === TCLSync.ALARM_NAME),
    '只跳過退避是不夠的:留著週期 alarm 等於每 5 分鐘拿同一份必然失敗的請求去敲限流桶'
  );
  assert.equal(env.storage.syncState().lastError, 'forbidden_origin');
});

// ============================================================================
// T9 — 自清守衛（D19）與收尾修正
// ============================================================================
//
// E1（真機實證）：刪除雲端資料 → 登出 → 再登入，本機紀錄全滅。
// 伺服器對「清空」只有一條廣播管道（`changes.clearedAt`），發動清空的那一台
// 裝置也會拉回自己寫下的水位線；插件把它一律當成別台裝置清的，於是硬刪本機
// 早於水位線的紀錄。登出會把 syncState 整包重設，所以守衛必須存在**獨立的**
// storage key（`syncClearGuard`），才撐得過「登出→再登入」。
// 手機端沒有對應處理可抄：它的 `deleteAccount` 打的是 `DELETE /api/v1/account`
// （整個帳號連同 cleared_at 一起消失），沒有插件這條「刪雲端、留本機」的路。

test('T9/E1 deleteCloud → 登出 → 再登入：本機筆數不變（自清守衛）', async () => {
  const TCLSync = loadSync();
  const old = T0 - 300_000; // 早於稍後寫下的 clearedAt
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'a', url: POST_A, at: old, receivedAt: old, dirty: false, serverUpdatedAt: old, seen: [{ at: old, kind: 'strip' }] }),
      entry({ id: 'b', url: POST_B, at: old + 1, receivedAt: old + 1, dirty: false, serverUpdatedAt: old + 1, seen: [{ at: old + 1, kind: 'strip' }] }),
    ],
  });
  const engine = TCLSync.create(env.deps);

  await engine.deleteCloud();
  await settle(10);
  assert.equal(env.storage.history().length, 2, '前置：刪雲端不動本機紀錄');

  await engine.signOut();
  await settle(10);
  await engine.signIn();
  await settle(20);

  assert.equal(env.storage.syncState().userId, 'user-abc', '前置：同一個帳號重新登入');
  assert.ok(env.syncPosts().length >= 1, '前置：登入後跑過一輪同步（since 從 0 重拉）');
  assert.deepEqual(
    env.storage.history().map((e) => e.id).sort(),
    ['a', 'b'],
    '拉回自己寫下的 cleared_at 不得當成別台裝置清空'
  );
});

test('T9/E1 別台裝置清空（clearedAt 比守衛新）照樣硬刪本機舊紀錄', async () => {
  const TCLSync = loadSync();
  const mine = T0 - 200_000; // 本機自己那一次清空
  const theirs = T0 - 100_000; // 別台裝置後來又清了一次
  const env = makeEnv({
    signedIn: true,
    local: { syncClearGuard: { userId: 'user-abc', clearedAt: mine } },
    history: [
      entry({ id: 'old', url: POST_A, at: theirs - 10_000, receivedAt: theirs - 10_000, dirty: false, serverUpdatedAt: theirs - 10_000, seen: [{ at: theirs - 10_000, kind: 'strip' }] }),
      entry({ id: 'new', url: POST_B, at: theirs + 10_000, receivedAt: theirs + 10_000, dirty: false, serverUpdatedAt: theirs + 10_000, seen: [{ at: theirs + 10_000, kind: 'strip' }] }),
    ],
  });
  env.server.seed([], { clearedAt: theirs });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(10);

  assert.deepEqual(env.storage.history().map((e) => e.id), ['new'], '守衛只擋自己那一次，別台的水位線照舊生效');
});

test('T9/E1 守衛認帳號：換人之後前一位使用者的守衛不得沿用', async () => {
  const TCLSync = loadSync();
  const cleared = T0 - 100_000;
  const env = makeEnv({
    signedIn: true,
    local: { syncClearGuard: { userId: 'user-other', clearedAt: cleared + 10_000 } },
    history: [
      entry({ id: 'old', url: POST_A, at: cleared - 10_000, receivedAt: cleared - 10_000, dirty: false, serverUpdatedAt: cleared - 10_000, seen: [{ at: cleared - 10_000, kind: 'strip' }] }),
    ],
  });
  env.server.seed([], { clearedAt: cleared });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(10);

  assert.deepEqual(env.storage.history(), [], '守衛的 userId 對不上就當成別人清的');
});
