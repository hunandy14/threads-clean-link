// test/support/sync-env.js — sync 系列測試共用的引擎注入環境：chrome.storage、
// chrome.alarms、TCLAuth 的替身，已登入狀態的 syncState 範本，以及把它們與
// mock 同步伺服器組成一整套 TCLSync.create(deps) 依賴的 createSyncEnv。
//
// 各檔的差異以 profile 物件表達（storage 的延遲方式與複製深淺、alarms 是否
// 保存排程、auth 替身的 payload、signedInState 的預設欄位），領域專屬的查詢
// 方法（marks 請求、epoch 讀取等）由各檔在 createSyncEnv 的回傳值上自行補掛。
'use strict';

const { createMockSyncServer } = require('../helpers/mock-sync-server.js');

// 各檔共用的虛擬時鐘起點。
const T0 = 1_700_000_000_000;

// 載入受測的 sync.js。放在各測試內部呼叫而非檔案頂層，模組載入失敗時每條
// 測試各自紅一次。
function loadSync() {
  return require('../../sync.js');
}

// ---- storage 替身 ----
//
// 【時序紀律】比照 test/support/helpers.js 的 createChromeStorage：get／set／
// remove 一律延遲到下一輪巨集任務才結算，絕不在同一個 tick 直接 resolve。另外
// 側錄每次寫入（區域、鍵、寫入值、是否在 writeChain 內、序號），供「寫入走序
// 列鏈、不交錯」一類斷言使用。
//
// createSyncStorage(localSeed, sessionSeed, options)
//   localSeed／sessionSeed：兩個區域的初始內容。
//   options.defer：'immediate'（預設）以 setImmediate 延遲；'timeout' 以
//     setTimeout(fn, 0) 延遲，供掛載 test/support/settle.js 假時間的檔案使用，
//     讓結算受虛擬時鐘驅動。
//   options.deepClone：true 時種子與「整區讀取」（get(null)）一律深拷貝，
//     測試手上的種子物件與替身內部資料互不共用參照；預設 false 為淺拷貝。
function createSyncStorage(localSeed = {}, sessionSeed = {}, options = {}) {
  const deepClone = options.deepClone === true;
  const later = options.defer === 'timeout' ? (fn) => setTimeout(fn, 0) : (fn) => setImmediate(fn);
  const chainDepth = { value: 0 };
  const writes = [];
  let seq = 0;

  const copyAll = (obj) => (deepClone ? JSON.parse(JSON.stringify(obj)) : Object.assign({}, obj));

  function makeArea(name, seed) {
    const data = copyAll(seed);

    function read(keys) {
      if (keys === null || keys === undefined) return copyAll(data);
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
    blocklist() {
      return local.data.scamBlocklist || null;
    },
    /** scamBlocklist 的 entries（沒有清單時為空物件）。 */
    entries() {
      const list = local.data.scamBlocklist;
      return (list && list.entries) || {};
    },
    /** 寫到 local 區 key 的所有寫入（含 remove）。 */
    writesTo(key) {
      return writes.filter((w) => w.area === 'local' && w.keys.indexOf(key) !== -1);
    },
    historyWrites() {
      return writes.filter((w) => w.area === 'local' && w.keys.indexOf('history') !== -1);
    },
  };
}

// ---- alarms 替身 ----
//
// createAlarmsMock(options)
//   options.stateful：true（預設）時 create／clear 會維護排程表，get／getAll
//     回傳現存的 alarm；false 時只側錄呼叫，get 一律回 undefined、getAll 一律
//     回空陣列，引擎看不到任何既有 alarm。
function createAlarmsMock(options = {}) {
  const stateful = options.stateful !== false;
  const calls = [];
  const table = new Map();
  return {
    calls,
    api: {
      create(name, info) {
        calls.push({ op: 'create', name, info: Object.assign({}, info) });
        if (stateful) table.set(name, Object.assign({ name }, info));
      },
      clear(name) {
        calls.push({ op: 'clear', name });
        if (stateful) table.delete(name);
        return Promise.resolve(true);
      },
      get(name) {
        return Promise.resolve(stateful ? table.get(name) || undefined : undefined);
      },
      getAll() {
        return Promise.resolve(stateful ? [...table.values()] : []);
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

// ---- TCLAuth 替身 ----
//
// signInWithGoogle 只回傳結果形狀（見 auth.js）；exchangeWithBackend 沿用真實
// 實作的請求形狀但改打 mock 伺服器。
//
// createAuthMock(server, opts)
//   opts.signInError：signInWithGoogle 以此錯誤 reject。
//   opts.email／idToken／nonce：覆寫回傳的對應欄位。
//   opts.payloadName／payloadPicture：id_token payload 的 name／picture 是後端
//     缺席時的退回來源；省略用假值，顯式傳 null 表示這枚 id_token 完全沒有
//     該 claim。
function createAuthMock(server, opts = {}) {
  const calls = { signIn: [], exchange: [] };
  return {
    calls,
    signInWithGoogle(options) {
      calls.signIn.push(options);
      if (opts.signInError) return Promise.reject(opts.signInError);
      const email = opts.email || 'someone@example.com';
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

// 已登入帳號的 syncState 基本欄位；over 覆寫或追加欄位（各檔的 marks 游標等
// 預設值由呼叫端併進 over）。
function signedInState(over = {}) {
  return Object.assign(
    {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: '0',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
    },
    over
  );
}

// ---- 一整套注入環境 ----
//
// createSyncEnv(opts, profile) 回傳 { clock, now, server, storage, alarms,
// broadcasts, auth, permissions, deps, timers, ... }，deps 直接交給
// TCLSync.create。
//
// opts（每條測試各自給）：
//   startAt：時鐘起點，預設 T0。
//   server：併進 createMockSyncServer 的選項。
//   shareWith：與另一個 env 共用同一台 mock 伺服器與時鐘（多裝置情境）；第二
//     台的 token 走 issueSession，不頂掉第一台那一枚。
//   local：local 區的其他初始鍵。
//   history／blocklist／scamGuardEnabled：分別種進 history／scamBlocklist／
//     scamGuardEnabled（null 或省略＝不種）。
//   signedIn：true 時預先發一枚有效 token 並寫入 syncAuth（可用 syncAuth 追加
//     欄位）與 syncState（profile.signedInState(opts.syncState)）。
//   session：session 區的初始內容。
//   auth：併進 profile.auth 後交給 createAuthMock。
//   granted：permissions.contains 的回答，預設 true。
//
// profile（每個檔案固定一份）：
//   storage：交給 createSyncStorage 的 options（defer、deepClone）。
//   alarms：交給 createAlarmsMock 的 options（stateful）。
//   auth：createAuthMock 的預設 opts，例如 { payloadPicture: null }。
//   signedInState：產生已登入 syncState 的函式，預設為本模組的 signedInState。
//
// 注入的 setTimeout 不會自行到期：計時器記在 timers，測試以 runTimers() 決定
// 何時觸發。fetch 預設直通 server.fetch；failPath 排入的故障會在打到該路徑的
// 下一次請求上觸發。
function createSyncEnv(opts = {}, profile = {}) {
  const makeSignedInState = profile.signedInState || signedInState;
  const clock = opts.shareWith ? opts.shareWith.clock : { t: opts.startAt || T0 };
  const now = () => clock.t;
  const server = opts.shareWith ? opts.shareWith.server : createMockSyncServer(Object.assign({ now }, opts.server));
  const localSeed = Object.assign({}, opts.local);
  if (opts.blocklist != null) localSeed.scamBlocklist = opts.blocklist;
  if (opts.history != null) localSeed.history = opts.history;
  if (opts.scamGuardEnabled !== undefined) localSeed.scamGuardEnabled = opts.scamGuardEnabled;
  if (opts.signedIn) {
    const token = opts.shareWith ? server.issueSession() : server.grantToken('tok-seeded');
    localSeed.syncAuth = Object.assign({ token }, opts.syncAuth);
    localSeed.syncState = makeSignedInState(opts.syncState);
  }
  const storage = createSyncStorage(localSeed, opts.session, profile.storage);
  const alarms = createAlarmsMock(profile.alarms);
  const broadcasts = [];
  const auth = createAuthMock(server, Object.assign({}, profile.auth, opts.auth));
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

  // 路徑 → 待觸發的故障佇列。failNext 是伺服器的全域佇列，但這裡緊接著就同步
  // 呼叫 server.fetch，中間沒有 await，因此注入的故障必定落在這一次請求上。
  const pathFailures = new Map();
  function fetchImpl(input, init) {
    if (pathFailures.size) {
      const queue = pathFailures.get(new URL(String(input)).pathname);
      if (queue && queue.length) server.failNext(queue.shift(), 1);
    }
    return server.fetch(input, init);
  }

  let uuidSeq = 0;
  let timerSeq = 0;
  const timers = { calls: [], live: [], cleared: [] };
  const deps = {
    storage: storage.api,
    fetch: fetchImpl,
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
    /** 讓目前排定的去抖計時器到期（模擬 SW 還活著、計時器先到）。 */
    async runTimers() {
      const pending = timers.live.splice(0, timers.live.length);
      for (const handle of pending) await handle.fn();
    },
    advance(ms) {
      clock.t += ms;
    },
    /** 讓打到 path 的接下來 times 次請求以 failure（server.failNext 的格式）失敗。 */
    failPath(path, failure, times = 1) {
      if (!pathFailures.has(path)) pathFailures.set(path, []);
      const queue = pathFailures.get(path);
      for (let i = 0; i < times; i += 1) queue.push(Object.assign({}, failure));
    },
    /** 用同一份 storage 重建引擎，模擬 SW 被回收後重新啟動；sessionSurvives 為 false 時清空 session 區。 */
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

module.exports = {
  T0,
  loadSync,
  createSyncStorage,
  createAlarmsMock,
  createAuthMock,
  signedInState,
  createSyncEnv,
};
