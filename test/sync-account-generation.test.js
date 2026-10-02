// test/sync-account-generation.test.js — 一輪同步在途時發生帳號轉場（或被看門
// 狗取代、或與 verifySession 並行）時，舊一輪與舊 ctx 不得把過期的資料寫回。
//
// 契約重點（帳號世代）：
// - resetAccount 每次轉場（登入、登出、過期、刪雲端）遞增記憶體內的帳號世代；
//   runSync 起跑時記下世代，之後每個會寫 syncState／syncAuth／syncBackoff／
//   history dirty／名單 dirty／syncEpoch／alarm 的落地點都先比對，不同即放棄
//   該次寫入並結束本輪（不拋錯、不退避、不廣播 error）。
// - 被看門狗取代的舊一輪，遲到的回應不得覆寫新一輪已前進的狀態。
// - runVerify 較晚落地時不得讓游標倒退、不得帶回舊版 marks 欄位。
// - 同帳號、無轉場的正常路徑行為與請求數不變。
//
// 時序紀律：每條都以延遲回應壓住某個請求、期間做轉場、再放行，不在同一個
// tick 解析。storage 替身的 get／set 一律 setTimeout(0) 落盤，走假時間
// （test/support/settle.js）。
'use strict';

const test = require('node:test');
const fakeClock = require('./support/settle').installSettle();
test.beforeEach(fakeClock.reset);
const assert = require('node:assert/strict');

const { postKeyOf } = require('../tcl-core.js');
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');
const { loadSync, createAlarmsMock: createSharedAlarmsMock } = require('./support/sync-env');

const T0 = 1_700_000_000_000;
const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const LINKS_PATH = '/api/v1/links/sync';
const SIGN_OUT_PATH = '/api/auth/sign-out';
const SESSION_PATH = '/api/auth/get-session';

const USER_A = 'user-A';
const USER_B = 'user-B';

// ---- storage 替身（同 test/sync-reset-account.test.js 的 createSyncStorage） ----
function createSyncStorage(localSeed = {}) {
  const writes = [];
  let seq = 0;

  function later(fn) {
    setTimeout(fn, 0);
  }

  function makeArea(name, seed) {
    const data = JSON.parse(JSON.stringify(seed));

    function read(keys) {
      if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(data));
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: clone(data[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = clone(data[k]);
        });
        return out;
      }
      const out = Object.assign({}, keys);
      Object.keys(keys).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = clone(data[k]);
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
          const value = JSON.parse(JSON.stringify(items));
          writes.push({ area: name, keys: Object.keys(items), value, seq });
          return new Promise((resolve) =>
            later(() => {
              Object.assign(data, JSON.parse(JSON.stringify(value)));
              resolve();
            })
          );
        },
        remove(keys) {
          seq += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          writes.push({ area: name, keys: list, removed: true, seq });
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

  function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  }

  const local = makeArea('local', localSeed);
  const session = makeArea('session', {});

  return {
    api: { local: local.api, session: session.api },
    localData: local.data,
    writes,
    /** 第 from 筆（含）之後、寫到 key 的 local 寫入。 */
    writesOf(key, from = 0) {
      return writes.slice(from).filter((w) => w.area === 'local' && !w.removed && w.keys.indexOf(key) !== -1);
    },
  };
}

// 本檔的 alarms 替身只側錄呼叫、不保存排程。
function createAlarmsMock() {
  return createSharedAlarmsMock({ stateful: false });
}

function response(status, body, headers = {}) {
  const lower = {};
  Object.keys(headers).forEach((k) => {
    lower[k.toLowerCase()] = headers[k];
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(lower, k.toLowerCase()) ? lower[k.toLowerCase()] : null) },
    json: () => Promise.resolve(body === undefined ? null : JSON.parse(JSON.stringify(body))),
  };
}

function linksOk(cursor, epoch, upsertIds = []) {
  return {
    cursor,
    epoch,
    applied: { upserts: upsertIds.map((id) => ({ id })), deletedIds: [], rejectedIds: [] },
    changes: { links: [], deleted: [], hasMore: false },
  };
}

/**
 * 多帳號的後端替身。handler(req) 回傳 response 物件或 'hold'：'hold' 把這個
 * 請求壓住，等測試 release／fail 才結算。一般回應一律 setTimeout(0) 延後，
 * 不在同一個 tick 解析。每筆請求記下發出當下 storage 的寫入數（writesAt）。
 */
function createRouter(storage, handler) {
  const requests = [];
  const parked = [];
  function fetch(url, init) {
    const u = new URL(String(url));
    const req = {
      method: ((init && init.method) || 'GET').toUpperCase(),
      path: u.pathname,
      auth: init && init.headers ? init.headers.Authorization : undefined,
      body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null,
      writesAt: storage.writes.length,
    };
    requests.push(req);
    const out = handler(req);
    if (out === 'hold') {
      return new Promise((resolve, reject) => {
        parked.push({ req, resolve, reject });
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve(out), 0));
  }
  return {
    fetch,
    requests,
    parked,
    /** 放行第一個仍壓著的請求。 */
    release(res) {
      const p = parked.shift();
      assert.ok(p, '沒有被壓住的請求可放行');
      p.resolve(res);
    },
    /** 讓第一個仍壓著的請求以網路錯誤失敗。 */
    fail() {
      const p = parked.shift();
      assert.ok(p, '沒有被壓住的請求可放行');
      p.reject(new TypeError('Failed to fetch'));
    },
    linksPosts(auth) {
      return requests.filter((r) => r.path === LINKS_PATH && r.method === 'POST' && (!auth || r.auth === auth));
    },
  };
}

function entry(over = {}) {
  const at = over.at !== undefined ? over.at : T0 - 60_000;
  const url = over.url || POST_A;
  return Object.assign(
    {
      id: 'e1',
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

function stateA(over = {}) {
  return Object.assign(
    {
      userId: USER_A,
      email: 'a@example.com',
      cursor: 'cA5',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
      marksCursor: 'mA1',
    },
    over
  );
}

/** 以 A 帳號已登入的本機狀態組一套引擎依賴；fetch 由 router 代言。 */
function makeEnv(opts = {}) {
  const TCLSync = loadSync();
  const clock = { t: T0 };
  const now = () => clock.t;
  const local = Object.assign(
    {
      syncAuth: { token: 'tA' },
      syncState: stateA(),
      scamGuardEnabled: false,
      history: [entry()],
    },
    opts.local
  );
  const storage = createSyncStorage(local);
  const router = createRouter(storage, opts.handler);
  const alarms = createAlarmsMock();
  const broadcasts = [];
  let uuidSeq = 0;
  const deps = {
    storage: storage.api,
    fetch: router.fetch,
    now,
    alarms: alarms.api,
    broadcast: (message) => broadcasts.push(message),
    auth: {
      signInWithGoogle() {
        return Promise.resolve({
          idToken: 'fake.id.token.B',
          nonce: 'nonce-B',
          email: 'b@example.com',
          payload: { sub: USER_B, email: 'b@example.com' },
        });
      },
      exchangeWithBackend() {
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                status: 200,
                ok: true,
                authToken: 'tB',
                body: { user: { id: USER_B, email: 'b@example.com', name: 'Bob' } },
              }),
            0
          )
        );
      },
      permissionsFor(apiBase) {
        return { permissions: ['identity'], origins: [String(apiBase).replace(/\/$/, '') + '/*'] };
      },
    },
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
    },
    randomUUID: () => `uuid-${(uuidSeq += 1)}`,
    // 去抖計時器不自行到期：本檔只看轉場，不讓 soon 補跑混進請求序列。
    setTimeout: () => ({}),
    clearTimeout: () => {},
  };
  const engine = TCLSync.create(deps);
  return {
    TCLSync,
    clock,
    storage,
    router,
    alarms,
    broadcasts,
    engine,
    statuses(from = 0) {
      return broadcasts
        .slice(from)
        .filter((m) => m && m.type === 'sync.stateChanged')
        .map((m) => m.state.status);
    },
  };
}

// ============================================================================
// F1 — 換帳號：A 的一輪在途 → 登出 → 登入 B → 放行 A 的回應
// ============================================================================

test('F1 換帳號：A 輪遲到的回應不得清掉 B 的待推、不得寫回 A 的游標與 epoch，B 首請求帶 since 0 且不帶 epoch', async () => {
  // A 本機沒有 syncEpoch：A 輪若照舊落地，會把回應的 epoch 7 以 userId A 採用寫入。
  const env = makeEnv({
    handler(req) {
      if (req.path === SIGN_OUT_PATH) return response(200, {});
      if (req.path === LINKS_PATH && req.auth === 'Bearer tA') return 'hold';
      if (req.path === LINKS_PATH && req.auth === 'Bearer tB') {
        return response(200, linksOk('cB1', 3, (req.body.upserts || []).map((u) => u.id)));
      }
      return response(404, { error: 'not_found' });
    },
  });
  const { engine, router, storage } = env;

  const roundA = engine.syncNow();
  await fakeClock.settle();
  assert.equal(router.parked.length, 1, '前提：A 的 links POST 已發出並被壓住');
  assert.equal(router.parked[0].req.auth, 'Bearer tA');
  assert.equal(router.parked[0].req.body.since, 'cA5');

  const mark = storage.writes.length;
  await fakeClock.advanceUntil(engine.signOut());
  const signingIn = engine.signIn();
  await fakeClock.settle();
  assert.deepEqual(storage.localData.syncAuth, { token: 'tB' }, '前提：B 已在 A 輪在途時登入落地');
  assert.equal(storage.localData.syncState.userId, USER_B);
  assert.equal(storage.localData.history[0].dirty, true, '前提：B 登入（本機無 B 的 epoch）已全量標髒');

  router.release(response(200, linksOk('cA6', 7, ['e1'])));
  await fakeClock.advanceUntil(roundA);
  await fakeClock.advanceUntil(signingIn);
  await fakeClock.settle();
  await fakeClock.advanceUntil(engine.syncNow());
  await fakeClock.settle();

  const bPosts = router.linksPosts('Bearer tB');
  assert.ok(bPosts.length >= 1, 'B 登入後應發出 B 自己的 links POST');
  const firstB = bPosts[0];
  assert.equal(firstB.body.since, '0', 'B 的第一個請求從頭拉（since 0），不得沿用 A 的游標');
  assert.equal(Object.prototype.hasOwnProperty.call(firstB.body, 'epoch'), false, 'B 的第一個請求不帶 epoch');
  assert.deepEqual(
    (firstB.body.upserts || []).map((u) => u.id),
    ['e1'],
    'B 剛標的待推必須還在，第一個請求要把 e1 送上 B 的雲'
  );

  // B 首請求之前，登出之後的 history 寫入不得把 e1 清成乾淨。
  const cleared = storage
    .writesOf('history', mark)
    .filter((w) => w.seq <= firstB.writesAt && (w.value.history || []).some((e) => e.id === 'e1' && e.dirty === false));
  assert.deepEqual(cleared, [], 'A 輪的 ack 不得清掉 B 標的 dirty');

  const staleState = storage
    .writesOf('syncState', mark)
    .filter(
      (w) =>
        w.value.syncState.userId === USER_A ||
        w.value.syncState.cursor === 'cA5' ||
        w.value.syncState.cursor === 'cA6' ||
        w.value.syncState.marksCursor === 'mA1'
    );
  assert.deepEqual(staleState, [], '登出之後不得有任何 syncState 寫入帶 A 的身分或游標');

  const staleEpoch = storage.writesOf('syncEpoch', mark).filter((w) => w.value.syncEpoch && w.value.syncEpoch.userId === USER_A);
  assert.deepEqual(staleEpoch, [], '登出之後不得寫入 A 的 syncEpoch');

  assert.deepEqual(storage.localData.syncEpoch, { userId: USER_B, epoch: 3 }, 'syncEpoch 採用的是 B 回應的值');
  assert.equal(storage.localData.syncState.userId, USER_B);
  assert.equal(storage.localData.syncState.cursor, 'cB1');
  assert.deepEqual(storage.localData.syncAuth, { token: 'tB' });
});

test('F1 換帳號：A 輪在途請求回 401 時不得清掉 B 的 token', async () => {
  const env = makeEnv({
    local: { syncEpoch: { userId: USER_A, epoch: 0 } },
    handler(req) {
      if (req.path === SIGN_OUT_PATH) return response(200, {});
      if (req.path === LINKS_PATH && req.auth === 'Bearer tA') return 'hold';
      if (req.path === LINKS_PATH && req.auth === 'Bearer tB') {
        return response(200, linksOk('cB1', 3, (req.body.upserts || []).map((u) => u.id)));
      }
      return response(404, { error: 'not_found' });
    },
  });
  const { engine, router, storage } = env;

  const roundA = engine.syncNow();
  await fakeClock.settle();
  assert.equal(router.parked.length, 1, '前提：A 的 links POST 已發出並被壓住');

  await fakeClock.advanceUntil(engine.signOut());
  const signingIn = engine.signIn();
  await fakeClock.settle();
  assert.deepEqual(storage.localData.syncAuth, { token: 'tB' }, '前提：B 已在 A 輪在途時登入落地');

  const mark = storage.writes.length;
  const statusMark = env.broadcasts.length;
  // A 的 session 已在登出時撤銷，壓住的那個請求回 401。
  router.release(response(401, { error: 'unauthorized' }));
  await fakeClock.advanceUntil(roundA);
  await fakeClock.advanceUntil(signingIn);
  await fakeClock.settle();

  const clearedToken = storage.writesOf('syncAuth', mark).filter((w) => !w.value.syncAuth || w.value.syncAuth.token !== 'tB');
  assert.deepEqual(clearedToken, [], 'A 請求的 401 不得寫掉 B 的 token');
  assert.deepEqual(storage.localData.syncAuth, { token: 'tB' });
  assert.equal(storage.localData.syncState.userId, USER_B);
  assert.notEqual(storage.localData.syncState.lastError, 'session_expired', 'B 的 syncState 不得被記成過期');
  assert.equal(env.statuses(statusMark).indexOf('signed_out'), -1, '不得廣播 signed_out 把 B 踢出');

  const before = router.linksPosts('Bearer tB').length;
  await fakeClock.advanceUntil(engine.syncNow());
  await fakeClock.settle();
  assert.ok(router.linksPosts('Bearer tB').length > before, 'B 仍可用自己的 token 同步');
});

// ============================================================================
// F2 — 一輪在途時登出：舊輪收尾不得讓帳號「復活」
// ============================================================================

test('F2 同步中登出：舊輪收尾不寫回帳號資料、不重建週期 alarm，最後廣播 signed_out', async () => {
  const env = makeEnv({
    local: { syncEpoch: { userId: USER_A, epoch: 0 } },
    handler(req) {
      if (req.path === SIGN_OUT_PATH) return response(200, {});
      if (req.path === LINKS_PATH) return 'hold';
      return response(404, { error: 'not_found' });
    },
  });
  const { engine, router, storage, alarms, TCLSync } = env;

  const round = engine.syncNow();
  await fakeClock.settle();
  assert.equal(router.parked.length, 1, '前提：A 的 links POST 已發出並被壓住');

  const mark = storage.writes.length;
  await fakeClock.advanceUntil(engine.signOut());
  await fakeClock.settle();
  const resetWrites = storage.writesOf('syncState', mark);
  assert.equal(resetWrites.length, 1, '前提：登出寫了一次重設的 syncState');
  const resetState = resetWrites[0].value.syncState;
  assert.equal(resetState.userId, null);
  assert.deepEqual(storage.localData.syncAuth, { token: null });

  const afterSignOut = storage.writes.length;
  const alarmMark = alarms.calls.length;
  const statusMark = env.broadcasts.length;
  router.release(response(200, linksOk('cA6', 0, ['e1'])));
  await fakeClock.advanceUntil(round);
  await fakeClock.settle();

  const accountKeys = ['syncState', 'syncAuth', 'syncBackoff', 'syncEpoch', 'history', 'scamBlocklist'];
  const leaked = storage.writes
    .slice(afterSignOut)
    .filter((w) => w.area === 'local' && w.keys.some((k) => accountKeys.indexOf(k) !== -1));
  assert.deepEqual(leaked, [], '登出之後舊輪不得寫任何帳號或同步資料');
  assert.deepEqual(storage.localData.syncAuth, { token: null }, 'token 維持 null');
  assert.deepEqual(storage.localData.syncState, resetState, 'syncState 維持登出時的重設值');
  assert.equal(storage.localData.history[0].dirty, true, '舊輪的 ack 不得落地');

  const recreated = alarms.calls.slice(alarmMark).filter((c) => c.op === 'create');
  assert.deepEqual(recreated, [], '登出後不得重建任何 alarm（含週期 ' + TCLSync.ALARM_NAME + '）');

  const statuses = env.statuses();
  assert.equal(statuses[statuses.length - 1], 'signed_out', '廣播最後一則必須是 signed_out');
  assert.deepEqual(
    env.statuses(statusMark).filter((s) => s !== 'signed_out'),
    [],
    '舊輪收尾不得廣播 signed_in／error'
  );

  const requestsBefore = router.requests.length;
  const view = await fakeClock.advanceUntil(engine.getState());
  await fakeClock.settle();
  assert.equal(view.status, 'signed_out', 'options 的 getState 為未登入');
  assert.equal(view.email, null, 'getState 不得帶回 A 的 email');
  assert.equal(view.lastSyncedAt, null, 'getState 不得帶回 lastSyncedAt');
  assert.equal(router.requests.length, requestsBefore, '未登入的 getState 不發請求');
});

// ============================================================================
// D1 — 看門狗開第二輪後，舊輪遲到的失敗不得覆寫新輪狀態
// ============================================================================

test('D1 看門狗：被取代的舊輪遲到失敗時，不得覆寫新輪的 cursor／lastError／lastSyncedAt，也不排退避', async () => {
  let linksSeen = 0;
  const env = makeEnv({
    local: { syncEpoch: { userId: USER_A, epoch: 0 }, history: [] },
    handler(req) {
      if (req.path === LINKS_PATH) {
        linksSeen += 1;
        if (linksSeen === 1) return 'hold';
        return response(200, linksOk('cA9', 0));
      }
      return response(404, { error: 'not_found' });
    },
  });
  const { engine, router, storage, alarms, TCLSync, clock } = env;

  const oldRound = engine.syncNow();
  await fakeClock.settle();
  assert.equal(router.parked.length, 1, '前提：第一輪的 links POST 被壓住');

  // 筆電闔上超過看門狗門檻，醒來後的請求判定前一輪已遺棄，開新的一輪。
  clock.t += TCLSync.RUN_STALE_MS + 1;
  const newRound = engine.syncNow();
  await fakeClock.advanceUntil(newRound);
  await fakeClock.settle();
  assert.equal(router.linksPosts().length, 2, '前提：看門狗放行第二輪');
  const fresh = storage.localData.syncState;
  assert.equal(fresh.cursor, 'cA9', '前提：第二輪已前進游標');
  assert.equal(fresh.lastError, null);
  assert.equal(fresh.lastSyncedAt, clock.t);

  const mark = storage.writes.length;
  const alarmMark = alarms.calls.length;
  const statusMark = env.broadcasts.length;
  clock.t += 1000;
  // 舊輪的連線在喚醒後斷掉。
  router.fail();
  await fakeClock.advanceUntil(oldRound);
  await fakeClock.settle();

  assert.deepEqual(storage.writesOf('syncState', mark), [], '舊輪不得寫 syncState');
  assert.deepEqual(storage.writesOf('syncBackoff', mark), [], '舊輪不得累加退避');
  assert.equal(storage.localData.syncState.cursor, 'cA9', '游標不得倒退');
  assert.equal(storage.localData.syncState.lastError, null, 'lastError 不得被舊輪記成 network_error');
  assert.equal(storage.localData.syncState.lastSyncedAt, fresh.lastSyncedAt, 'lastSyncedAt 不得被舊輪覆寫');
  assert.deepEqual(
    alarms.calls.slice(alarmMark).filter((c) => c.op === 'create'),
    [],
    '舊輪不得把週期 alarm 換成退避 alarm'
  );
  assert.equal(env.statuses(statusMark).indexOf('error'), -1, '舊輪不得廣播 error');
});

// ============================================================================
// D2 — runVerify 與同時起跑的一輪競態
// ============================================================================

test('D2 verifySession 較晚落地：不得讓游標倒退、不得帶回 marksPushedAt 等舊欄位，身分欄照常更新', async () => {
  const env = makeEnv({
    local: {
      syncEpoch: { userId: USER_A, epoch: 0 },
      // 舊版 syncState：帶 legacy 兩格，第一輪會遷移並拿掉。
      syncState: stateA({ marksPushedAt: T0 - 5000, marksRejected: {} }),
    },
    handler(req) {
      if (req.path === SESSION_PATH) return 'hold';
      if (req.path === LINKS_PATH) return response(200, linksOk('cA6', 0, (req.body.upserts || []).map((u) => u.id)));
      return response(404, { error: 'not_found' });
    },
  });
  const { engine, router, storage } = env;

  // SW 啟動：verifySession 與 alarm 喚醒的一輪同時起跑。
  const verifying = engine.verifySession();
  const round = engine.syncNow();
  await fakeClock.advanceUntil(round);
  await fakeClock.settle();
  assert.equal(router.parked.length, 1, '前提：get-session 仍被壓住');
  assert.equal(router.parked[0].req.path, SESSION_PATH);
  assert.equal(storage.localData.syncState.cursor, 'cA6', '前提：那一輪已前進游標');
  assert.equal(
    Object.prototype.hasOwnProperty.call(storage.localData.syncState, 'marksPushedAt'),
    false,
    '前提：那一輪已完成舊版 marks 遷移'
  );

  const mark = storage.writes.length;
  router.release(
    response(200, {
      session: { userId: USER_A, expiresAt: T0 + 90 * 24 * 60 * 60_000 },
      user: { id: USER_A, email: 'a@example.com', name: 'Alice Renamed' },
    })
  );
  await fakeClock.advanceUntil(verifying);
  await fakeClock.settle();

  const regress = storage
    .writesOf('syncState', mark)
    .filter(
      (w) =>
        w.value.syncState.cursor !== 'cA6' ||
        w.value.syncState.lastSyncedAt !== T0 ||
        Object.prototype.hasOwnProperty.call(w.value.syncState, 'marksPushedAt') ||
        Object.prototype.hasOwnProperty.call(w.value.syncState, 'marksRejected')
    );
  assert.deepEqual(regress, [], 'verify 的回寫不得帶回舊游標、舊 lastSyncedAt 或 legacy 欄位');
  const final = storage.localData.syncState;
  assert.equal(final.cursor, 'cA6', '游標不得倒退');
  assert.equal(final.marksCursor, 'mA1');
  assert.equal(final.lastSyncedAt, T0, 'lastSyncedAt 不得倒回那一輪之前的值');
  assert.equal(Object.prototype.hasOwnProperty.call(final, 'marksPushedAt'), false, '不得帶回 marksPushedAt');
  assert.equal(Object.prototype.hasOwnProperty.call(final, 'marksRejected'), false, '不得帶回 marksRejected');
  assert.equal(final.displayName, 'Alice Renamed', 'get-session 的身分欄照常更新');
  assert.equal(final.userId, USER_A);
});

// ============================================================================
// G2 — 回歸保護：同帳號、無轉場的一輪，行為與請求數不變
// ============================================================================

test('G2 正常路徑：同帳號壓住再放行的一輪，只發一次 POST、落地一次 syncState、建週期 alarm', async () => {
  const TCLSync = loadSync();
  const clock = { t: T0 };
  const now = () => clock.t;
  const server = createMockSyncServer({ now });
  const token = server.grantToken('tok-seeded');
  const storage = createSyncStorage({
    syncAuth: { token },
    syncState: {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: '0',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
    },
    scamGuardEnabled: false,
    history: [entry({ id: 'loc-a' })],
  });
  const alarms = createAlarmsMock();
  const broadcasts = [];
  const responses = [];
  const engine = TCLSync.create({
    storage: storage.api,
    fetch: async (url, init) => {
      const res = await server.fetch(url, init);
      const body = await res.json();
      responses.push(body);
      return { status: res.status, ok: res.ok, headers: res.headers, json: () => Promise.resolve(body) };
    },
    now,
    alarms: alarms.api,
    broadcast: (m) => broadcasts.push(m),
    auth: {},
    permissions: { contains: () => Promise.resolve(true) },
    randomUUID: () => 'uuid-1',
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });

  const release = server.holdNext(1);
  const round = engine.syncNow();
  await fakeClock.settle();
  assert.equal(server.pendingCount(), 1, '前提：links POST 被壓住');
  release();
  await fakeClock.advanceUntil(round);
  await fakeClock.settle();

  assert.equal(server.requests.length, 1, '一輪只發一個請求');
  assert.equal(server.requestsTo(LINKS_PATH, 'POST').length, 1);
  const sent = server.requestsTo(LINKS_PATH, 'POST')[0].body;
  assert.equal(sent.since, '0');
  assert.deepEqual(sent.upserts.map((u) => u.id), ['loc-a']);

  const cursor = responses[0].cursor;
  const stateWrites = storage.writesOf('syncState');
  assert.equal(stateWrites.length, 1, '收尾只落地一次 syncState');
  assert.equal(stateWrites[0].value.syncState.cursor, cursor);
  assert.equal(stateWrites[0].value.syncState.lastError, null);
  assert.equal(stateWrites[0].value.syncState.lastSyncedAt, T0);
  assert.equal(stateWrites[0].value.syncState.userId, 'user-abc');
  assert.deepEqual(storage.localData.syncEpoch, { userId: 'user-abc', epoch: responses[0].epoch });
  assert.deepEqual(storage.localData.syncBackoff, { failures: 0 });
  assert.equal(storage.localData.history[0].dirty, false, 'ack 清掉送出的那一版');
  assert.deepEqual(
    alarms.calls.filter((c) => c.op === 'create').map((c) => [c.name, c.info.periodInMinutes]),
    [[TCLSync.ALARM_NAME, TCLSync.SYNC_PERIOD_MINUTES]],
    '只建週期 alarm'
  );
  assert.deepEqual(
    broadcasts.filter((m) => m.type === 'sync.stateChanged').map((m) => m.state.status),
    ['syncing', 'signed_in']
  );
});
