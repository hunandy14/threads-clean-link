// test/sync-scheduler.test.js — 同步排程收斂（SW-sched）的行為契約。
//
// 契約重點（設計見 design-sw §3.2）：
// - 單一入口 request(reason)，phase 只有 idle／running 兩態；單飛只在 SW 記憶體，
//   storage.session 與 storage.local 都不落任何單飛或去抖旗標。
// - 一輪進行中收到 manual／recorded 請求時記 rerunPending，輪末走 2 秒去抖補跑
//   （不立即連發）；alarm／stale 請求在進行中直接併入，不補跑。
// - phase 為 running 超過 RUN_STALE_MS 視為被遺棄，新的請求可重入（看門狗）。
// - 一輪受 ROUND_DEADLINE_MS 約束：任何請求在發出前若 now + CALL_TIMEOUT_MS 會
//   超過期限就收手，排 continue；POST 額度（MAX_ROUND_POSTS）照舊。
// - 下一步排程統一經 setNext(kind)：periodic／backoff／continue／soon／fatal／none。
//
// setNext 與 request 是引擎內部函式，本檔只透過 alarms、計時器替身、storage 與
// mock 伺服器的請求紀錄觀察它們的效果。
//
// storage／alarms／auth 替身與 makeEnv 逐字沿用 test/sync.test.js 的 harness（該
// 檔不匯出）。計時器替身不會自己到期，也不推進時鐘：測試以 env.advance(ms) 推進
// 時鐘，再以 fireTimers 手動觸發指定毫秒數的計時器。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { postKeyOf } = require('../tcl-core.js');
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');

function loadSync() {
  return require('../sync.js');
}

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';

const T0 = 1_700_000_000_000;

// 規格值（design-sw §3.2）。行為測試直接用字面值，匯出與關係式另由常數測試把關，
// 常數未匯出時行為測試仍依真實行為判紅綠。
const CALL_TIMEOUT_MS = 30_000;
const MAX_ROUND_POSTS = 12;
const ROUND_DEADLINE_MS = MAX_ROUND_POSTS * CALL_TIMEOUT_MS;
const RUN_STALE_MS = ROUND_DEADLINE_MS + 2 * CALL_TIMEOUT_MS;
const CONTINUE_DELAY_MS = 30_000;

// ---- storage 替身 ----
//
// 【時序紀律】比照 test/support/helpers.js 的 createChromeStorage：get/set/remove
// 一律以 setImmediate 延遲到下一輪結算，絕不在同一個 tick 直接 resolve——同 tick 假綠燈
// 是本專案已知風險。另外側錄每次寫入（區域、鍵、是否在 writeChain 內），供
// 「history 寫入走序列鏈、不交錯」的斷言使用。
function createSyncStorage(localSeed = {}, sessionSeed = {}) {
  const chainDepth = { value: 0 };
  const writes = [];
  let seq = 0;

  function later(fn) {
    setImmediate(fn);
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
  // opts.shareWith：與另一個 env 共用同一台 mock 伺服器與時鐘（D50 的多裝置
  // 情境）。第二台的 token 走 issueSession，不頂掉第一台那一枚。
  const clock = opts.shareWith ? opts.shareWith.clock : { t: opts.startAt || T0 };
  const now = () => clock.t;
  const server = opts.shareWith ? opts.shareWith.server : createMockSyncServer(Object.assign({ now }, opts.server));
  const localSeed = Object.assign({}, opts.local);
  if (opts.history) localSeed.history = opts.history;
  if (opts.signedIn) {
    const token = opts.shareWith ? server.issueSession() : server.grantToken('tok-seeded');
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

/** 讓所有 setImmediate 排程的 storage 結算跑完。 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ============================================================================
// T1 — 模組形狀與注入
// ============================================================================

// ---- 本檔專用小工具 ----

/**
 * 觸發目前排定、毫秒數為 ms 的計時器（例如只觸發 2 秒去抖，不碰請求逾時計時器）。
 * 回傳各計時器回呼的 promise 但不等待：輪中觸發時回呼可能回傳進行中那一輪的
 * promise，在放行前等待會卡住。
 */
function fireTimers(env, ms) {
  const due = env.timers.live.filter((h) => h.ms === ms);
  due.forEach((h) => env.timers.live.splice(env.timers.live.indexOf(h), 1));
  return due.map((h) => Promise.resolve().then(() => h.fn()));
}

function liveTimers(env, ms) {
  return env.timers.live.filter((h) => h.ms === ms);
}

function linkPosts(env) {
  return env.server.requestsTo('/api/v1/links/sync', 'POST');
}

function allPosts(env) {
  return linkPosts(env).concat(env.server.requestsTo('/api/v1/marks/sync', 'POST'));
}

function createsOf(env, name) {
  return env.alarms.creates().filter((c) => c.name === name);
}

function clearsOf(env, name) {
  return env.alarms.clears().filter((c) => c.name === name);
}

function bulkHistory(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const url = `https://www.threads.com/@bulk${i}/post/BULK${String(i).padStart(8, '0')}`;
    const at = T0 - 2_000_000 + i;
    out.push(entry({ id: `bulk-${i}`, url, at, receivedAt: at, seen: [{ at, kind: 'strip' }] }));
  }
  return out;
}

function entryB() {
  return entry({ id: 'b', url: POST_B, at: T0, receivedAt: T0, seen: [{ at: T0, kind: 'icon' }] });
}

function settleAll(list) {
  return Promise.all(list.map((p) => Promise.resolve(p).catch(() => {})));
}

const FLAG_KEY = /^sync(Inflight|Debounce)$/;

// ============================================================================
// 常數：deadline 關係式（SC2／SC4 的前提）
// ============================================================================

test('SC4 常數：CALL_TIMEOUT_MS、ROUND_DEADLINE_MS、RUN_STALE_MS、CONTINUE_DELAY_MS 匯出且符合關係式', () => {
  const TCLSync = loadSync();
  assert.equal(TCLSync.MAX_ROUND_POSTS, MAX_ROUND_POSTS, 'POST 額度維持 12（節流）');
  assert.equal(TCLSync.CALL_TIMEOUT_MS, CALL_TIMEOUT_MS);
  assert.equal(TCLSync.ROUND_DEADLINE_MS, TCLSync.MAX_ROUND_POSTS * TCLSync.CALL_TIMEOUT_MS, '一輪期限＝額度×單次逾時');
  assert.equal(
    TCLSync.RUN_STALE_MS,
    TCLSync.ROUND_DEADLINE_MS + 2 * TCLSync.CALL_TIMEOUT_MS,
    '看門狗＝一輪期限再加兩次逾時的緩衝'
  );
  assert.equal(TCLSync.CONTINUE_DELAY_MS, CONTINUE_DELAY_MS, '續跑間隔沿用 alarm 下限 30 秒');
});

// ============================================================================
// SC1 — 尾端補跑
// ============================================================================

test('SC1 尾端補跑：輪中 notifyRecorded 且 2 秒去抖在輪中到期，輪末重排 2 秒去抖，新紀錄在下一輪送出', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'a', url: POST_A })] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);
  assert.equal(linkPosts(env).length, 1, '前置：第一輪的請求已發出、回應暫緩');

  // 輪中使用者又複製一則貼文：recordHistory 寫入後呼叫 notifyRecorded。
  env.storage.localData.history = env.storage.localData.history.concat([entryB()]);
  await engine.notifyRecorded();
  await settle();

  // SW 還活著：2 秒計時器在第一輪還沒結束前就到期。
  env.advance(TCLSync.DEBOUNCE_MS);
  const fired = fireTimers(env, TCLSync.DEBOUNCE_MS);
  assert.equal(fired.length, 1, '前置：notifyRecorded 排了 2 秒去抖');
  await settle(10);
  assert.equal(linkPosts(env).length, 1, '進行中不得另開一輪');

  release();
  await running;
  await settleAll(fired);
  await settle(20);
  assert.equal(linkPosts(env).length, 1, '補跑走去抖，輪末不得立即連發');
  assert.equal(
    liveTimers(env, TCLSync.DEBOUNCE_MS).length,
    1,
    '輪中有新紀錄：輪末要重排一次 2 秒去抖，不能等 5 分鐘的週期 alarm'
  );

  env.advance(TCLSync.DEBOUNCE_MS);
  await Promise.all(fireTimers(env, TCLSync.DEBOUNCE_MS));
  await settle(20);
  const posts = linkPosts(env);
  assert.equal(posts.length, 2, '補跑的那一輪要發出');
  assert.ok(
    (posts[1].body.upserts || []).some((it) => it.id === 'b'),
    '輪中寫入的新紀錄要在補跑那一輪上雲'
  );
  const byId = Object.fromEntries(env.storage.history().map((e) => [e.id, e]));
  assert.equal(byId.b.dirty, false, '新紀錄被 ack');
});

// ============================================================================
// SC2 — 看門狗
// ============================================================================

test('SC2 看門狗：running 未滿 RUN_STALE_MS 時單飛；滿 RUN_STALE_MS 後新的 request 可重入', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const abandoned = engine.syncNow();
  await settle(4);
  assert.equal(linkPosts(env).length, 1, '前置：第一輪卡在往返中');

  // 計時器替身不推進時鐘，看門狗只看 now() - runStartedAt：直接推時鐘。
  env.advance(RUN_STALE_MS - 1);
  const early = engine.syncNow();
  await settle(10);
  assert.equal(linkPosts(env).length, 1, '未滿 RUN_STALE_MS：仍視為進行中，不得另開一輪');

  env.advance(1);
  const revived = engine.syncNow();
  await settle(20);
  assert.equal(linkPosts(env).length, 2, '滿 RUN_STALE_MS：前一輪視為被遺棄，新的請求要重入並發出請求');

  release();
  await settleAll([abandoned, early, revived]);
  await settle(10);
});

// ============================================================================
// SC3 — 單飛只在記憶體
// ============================================================================

test('SC3 單飛只在記憶體：一輪進行中與去抖待辦期間，session 與 local 都沒有 syncInflight／syncDebounce 鍵', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);
  await engine.notifyRecorded();
  await settle();

  assert.deepEqual(Object.keys(env.storage.sessionData).filter((k) => FLAG_KEY.test(k)), [], 'session 不得落單飛或去抖旗標');
  assert.deepEqual(Object.keys(env.storage.localData).filter((k) => FLAG_KEY.test(k)), [], 'local 不得落單飛或去抖旗標');

  release();
  await running;
  await settle(10);
  const flagWrites = env.storage.writes.filter((w) => w.keys.some((k) => FLAG_KEY.test(k)));
  assert.deepEqual(flagWrites, [], '整輪（含去抖）不得寫入或移除任何單飛／去抖旗標');
});

test('SC3 單飛只在記憶體：SW 重啟（recreate，session 保留）後立即 syncNow 照樣發出請求，不被舊旗標擋 8 分鐘', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1);
  const first = TCLSync.create(env.deps);
  const abandoned = first.syncNow();
  await settle(4);
  assert.equal(linkPosts(env).length, 1, '前置：第一個實例的往返卡在半路');

  // MV3 的 SW 被驅逐後重啟：storage.session 仍在，記憶體全清。
  const revived = env.recreate(TCLSync);
  const p = revived.syncNow();
  await settle(20);
  assert.equal(linkPosts(env).length, 2, '重啟後的新實例不得被前一個實例殘留的狀態擋下');

  release();
  await settleAll([abandoned, p]);
  await settle(10);
});

// ============================================================================
// SC4 — deadline
// ============================================================================

test('SC4 deadline：慢連線下每個請求都在 ROUND_DEADLINE_MS 內結束，一輪提早收手並排 continue，POST ≤ 12', async () => {
  const TCLSync = loadSync();
  // 14 批待推（每批 50 筆），超過單輪 POST 額度。
  const env = makeEnv({ signedIn: true, history: bulkHistory(14 * 50) });
  const roundStart = env.now();
  const starts = [];
  // 慢連線：每個請求耗時接近單次逾時（差 1 秒，逾時計時器不會觸發）。
  const deps = Object.assign({}, env.deps, {
    fetch(url, init) {
      starts.push({ url, method: (init && init.method) || 'GET', at: env.now() });
      env.advance(CALL_TIMEOUT_MS - 1000);
      return env.server.fetch(url, init);
    },
  });
  const engine = TCLSync.create(deps);
  await engine.syncNow();
  await settle(40);

  assert.ok(allPosts(env).length <= MAX_ROUND_POSTS, `POST ${allPosts(env).length} 不得超過 ${MAX_ROUND_POSTS}`);
  assert.ok(starts.length >= 1, '前置：這一輪確實有發請求');
  starts.forEach((s) => {
    assert.ok(
      s.at - roundStart + CALL_TIMEOUT_MS <= ROUND_DEADLINE_MS,
      `${s.method} ${s.url} 在第 ${(s.at - roundStart) / 1000} 秒發出，最壞情況會超過一輪期限 ${ROUND_DEADLINE_MS / 1000} 秒`
    );
  });

  assert.ok(env.storage.history().some((e) => e.dirty === true), '前置：還有待推批次');
  const cont = createsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).pop();
  assert.ok(cont, '提早收手要排 continue（DEBOUNCE_ALARM）續跑');
  assert.equal(env.alarms.delayOf(cont, env.now()), CONTINUE_DELAY_MS, 'continue 排在 30 秒後');
  assert.equal(env.storage.syncState().lastError, null, '提早收手不是失敗，不記錯誤');
});

// ============================================================================
// SC5 — soonPending：計時器與 alarm 誰先到誰跑
// ============================================================================

test('SC5 soonPending：2 秒計時器先到就跑，隨後 DEBOUNCE_ALARM 到期跳過', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();

  env.advance(TCLSync.DEBOUNCE_MS);
  await Promise.all(fireTimers(env, TCLSync.DEBOUNCE_MS));
  await settle(20);
  assert.equal(linkPosts(env).length, 1, '計時器先到：跑一次');

  env.advance(30_000);
  await engine.onAlarm({ name: TCLSync.DEBOUNCE_ALARM_NAME });
  await settle(20);
  assert.equal(linkPosts(env).length, 1, 'alarm 後到：待辦已消化，跳過');
});

test('SC5 soonPending：DEBOUNCE_ALARM 先到就跑，排隊中的 2 秒計時器回呼隨後觸發時跳過', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();
  const timer = liveTimers(env, TCLSync.DEBOUNCE_MS)[0];
  assert.ok(timer, '前置：排了 2 秒計時器');

  env.advance(30_000);
  await engine.onAlarm({ name: TCLSync.DEBOUNCE_ALARM_NAME });
  await settle(20);
  assert.equal(linkPosts(env).length, 1, 'alarm 先到：跑一次');

  // 計時器回呼已經排進事件佇列、來不及取消的情形：直接呼叫它。
  await Promise.resolve(timer.fn());
  await settle(20);
  assert.equal(linkPosts(env).length, 1, '計時器後到：待辦已消化，跳過');
});

test('SC5 soonPending：SW 重啟（記憶體不知道有沒有待辦）時 DEBOUNCE_ALARM 到期照樣跑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();

  // SW 被回收：2 秒計時器隨記憶體消失，只剩保底 alarm。
  env.timers.live.splice(0, env.timers.live.length);
  const revived = env.recreate(TCLSync);
  env.advance(30_000);
  await revived.onAlarm({ name: TCLSync.DEBOUNCE_ALARM_NAME });
  await settle(20);
  assert.equal(linkPosts(env).length, 1, '保底 alarm 要把 SW 被回收前的待辦跑掉');
});

// ============================================================================
// SC6 — setNext 各 kind 的效果
// ============================================================================

test('SC6 setNext periodic：成功一輪後建週期 alarm，退避歸零', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()], local: { syncBackoff: { failures: 2 } } });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(20);

  const last = createsOf(env, TCLSync.ALARM_NAME).pop();
  assert.ok(last, '要建週期 alarm');
  assert.deepEqual(last.info, { periodInMinutes: TCLSync.SYNC_PERIOD_MINUTES });
  assert.deepEqual(env.storage.localData.syncBackoff, { failures: 0 });
  assert.equal(createsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).length, 0, '沒有待推就不排 continue');
});

test('SC6 setNext backoff：失敗後週期 alarm 改排一次性 when，syncBackoff 累加', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ kind: 'network' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow().catch(() => {});
  await settle(20);

  const last = createsOf(env, TCLSync.ALARM_NAME).pop();
  assert.ok(last, '要重排 ALARM');
  assert.equal(last.info.periodInMinutes, undefined, '退避是一次性排程，不是週期');
  assert.equal(last.info.when, env.now() + TCLSync.pollIntervalFor(1), '延遲照退避曲線');
  assert.deepEqual(env.storage.localData.syncBackoff, { failures: 1 });
});

test('SC6 setNext continue：額度用完排 30 秒 DEBOUNCE_ALARM、不排 2 秒計時器，到期續跑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: bulkHistory(14 * 50) });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(40);

  const cont = createsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).pop();
  assert.ok(cont, '要排 continue');
  assert.deepEqual(cont.info, { when: env.now() + CONTINUE_DELAY_MS });
  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 0, 'continue 不排 2 秒計時器');
  const periodic = createsOf(env, TCLSync.ALARM_NAME).pop();
  assert.deepEqual(periodic && periodic.info, { periodInMinutes: TCLSync.SYNC_PERIOD_MINUTES }, '成功收尾仍建週期 alarm');

  const before = linkPosts(env).length;
  env.advance(CONTINUE_DELAY_MS);
  await engine.onAlarm({ name: TCLSync.DEBOUNCE_ALARM_NAME });
  await settle(40);
  assert.ok(linkPosts(env).length > before, 'continue 到期要續跑');
});

test('SC6 setNext soon：notifyRecorded 排 2 秒計時器與 30 秒 DEBOUNCE_ALARM', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();

  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 1);
  const guard = createsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).pop();
  assert.deepEqual(guard && guard.info, { when: env.now() + 30_000 });
  assert.equal(createsOf(env, TCLSync.ALARM_NAME).length, 0, 'soon 不動週期 alarm');
});

test('SC6 setNext fatal：不可重試的錯誤只清週期 alarm，不清 DEBOUNCE_ALARM、不重排', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext({ status: 403, code: 'forbidden_origin' });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow().catch(() => {});
  await settle(20);

  assert.ok(clearsOf(env, TCLSync.ALARM_NAME).length >= 1, '要清週期 alarm');
  assert.equal(clearsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).length, 0, 'fatal 只清週期那一支');
  assert.equal(createsOf(env, TCLSync.ALARM_NAME).length, 0, 'fatal 不得重排 ALARM');
  assert.equal(env.storage.syncState().lastError, 'forbidden_origin');
});

test('SC6 setNext none：登出清兩支 alarm', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.signOut();
  await settle(20);

  assert.ok(clearsOf(env, TCLSync.ALARM_NAME).length >= 1, '清週期 alarm');
  assert.ok(clearsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).length >= 1, '清 DEBOUNCE_ALARM');
  assert.equal(createsOf(env, TCLSync.ALARM_NAME).length, 0);
});

test('SC6 setNext none：登出一併清掉排定中的 2 秒計時器，待辦作廢', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const engine = TCLSync.create(env.deps);
  await engine.notifyRecorded();
  await settle();
  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 1, '前置：去抖已排');

  await engine.signOut();
  await settle(20);
  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 0, 'none 要清計時器');
});

// ============================================================================
// SC7 — request(reason) 的分類
// ============================================================================

test('SC7 reason：running 時的 manual 與 recorded 設 rerunPending，輪末合併成一次 2 秒去抖補跑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'a', url: POST_A })] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);

  env.storage.localData.history = env.storage.localData.history.concat([entryB()]);
  const manual = engine.syncNow(); // manual
  await engine.notifyRecorded();
  env.advance(TCLSync.DEBOUNCE_MS);
  const fired = fireTimers(env, TCLSync.DEBOUNCE_MS); // recorded
  await settle(10);
  assert.equal(linkPosts(env).length, 1, '進行中只併入，不另開');

  release();
  await settleAll([running, manual].concat(fired));
  await settle(20);
  assert.equal(linkPosts(env).length, 1, '補跑不立即連發');
  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 1, '兩個請求合併成一次補跑');

  env.advance(TCLSync.DEBOUNCE_MS);
  await Promise.all(fireTimers(env, TCLSync.DEBOUNCE_MS));
  await settle(20);
  assert.equal(linkPosts(env).length, 2, '補跑一輪');
});

test('SC7 reason：running 時的 manual 單獨也會補跑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'a', url: POST_A })] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);

  env.storage.localData.history = env.storage.localData.history.concat([entryB()]);
  const manual = engine.syncNow();
  await settle(10);

  release();
  await Promise.all([running, manual]);
  await settle(20);
  assert.equal(linkPosts(env).length, 1, '補跑不立即連發');
  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 1, '進行中按了手動同步：輪末要排 2 秒補跑');
  assert.ok(createsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).pop(), '補跑同樣排保底 alarm');

  env.advance(TCLSync.DEBOUNCE_MS);
  await Promise.all(fireTimers(env, TCLSync.DEBOUNCE_MS));
  await settle(20);
  assert.equal(linkPosts(env).length, 2);
  assert.ok((linkPosts(env)[1].body.upserts || []).some((it) => it.id === 'b'), '輪中寫入的紀錄在補跑上雲');
});

test('SC7 reason：running 時的 alarm 與 stale 只併入，不設 rerunPending', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const release = env.server.holdNext(1);
  const engine = TCLSync.create(env.deps);
  const running = engine.syncNow();
  await settle(4);

  const viaAlarm = engine.onAlarm({ name: TCLSync.ALARM_NAME }); // alarm
  const state = await engine.getState(); // lastSyncedAt 已超過 STALE_MS → stale
  assert.equal(state.status, 'syncing', '前置：getState 看得到進行中');
  await settle(10);
  assert.equal(linkPosts(env).length, 1);

  release();
  await settleAll([running, viaAlarm]);
  await settle(20);
  assert.equal(liveTimers(env, TCLSync.DEBOUNCE_MS).length, 0, 'alarm／stale 不補跑');
  assert.equal(createsOf(env, TCLSync.DEBOUNCE_ALARM_NAME).length, 0, 'alarm／stale 不排保底 alarm');
  assert.equal(linkPosts(env).length, 1, '輪末不得自行多跑一輪');
});
