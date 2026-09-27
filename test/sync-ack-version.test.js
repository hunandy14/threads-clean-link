// test/sync-ack-version.test.js — SW-0：links 通道的 ack 只清「送出當下那一版」的 dirty。
//
// 缺陷：applyResponse 以伺服器回報的 id 比對，命中就無條件清 dirty。POST 往返
// 期間同一筆若又被改動（同一貼文再被複製一次：at 前進、seen 多一筆），ack
// 回來會連新改動的 dirty 一起清掉，這筆新事件要等該卡下次再被動到才會上雲。
//
// 契約：切批當下記下每筆的版本，ack 時重讀本機現值，版本未變才清 dirty；版本
// 已變則保持 dirty，下一輪照常送出。墓碑（deletes）路徑與 marks 通道不變。
//
// 【往返期間的改動形狀】模擬 sw-history.js recordHistory 的真實寫法：經注入的
// writeChain 讀改寫、整批換新物件（不就地改引擎可能持有的舊物件），at 前進、
// seen 追加一筆、dirty 維持 true。現行 history entry 沒有 updatedAt 欄位，本檔
// 也不憑空補上；版本判準須能從既有欄位看出這種改動。
//
// 【延遲 mock】links POST 的替身先讓 mock 伺服器照送出當下的內容處理完，再等
// 一個 setImmediate（下一個 macrotask）才執行往返期間的改動，改動落地後再等
// 一個 setImmediate 才把回應交還引擎。同 tick 解析會讓改動來不及插進往返，
// 測試假綠。
//
// harness（storage／alarms／auth 替身、makeEnv、settle）逐字取自
// test/sync.test.js，兩邊修改時需同步。
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
  CLOUD_DATA_CONTRACT,
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

/** 讓所有 setTimeout(0) 排程的 storage 結算跑完。 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ============================================================================
// SW-0 專用工具
// ============================================================================

const LINKS_SYNC_PATH = '/api/v1/links/sync';

function macrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 把 env.deps.fetch 換成延遲替身：只攔「下一次」links POST。伺服器先依送出當
 * 下的 body 處理完，隔一個 macrotask 跑 inFlight（往返期間的本機改動），再隔
 * 一個 macrotask 才交還回應。必須在 TCLSync.create 之前呼叫。
 */
function delayNextLinksPost(env, inFlight) {
  const base = env.deps.fetch;
  const probe = { hookRuns: 0, dirtyAtHook: null };
  let armed = true;
  env.deps.fetch = async (input, init) => {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const isLinksPost = method === 'POST' && new URL(String(input)).pathname === LINKS_SYNC_PATH;
    if (!armed || !isLinksPost) return base(input, init);
    armed = false;
    const res = await base(input, init);
    await macrotask();
    // 回應尚未交還：此刻本機應仍是送出前的 dirty 狀態，證明改動確實插在往返中間。
    probe.dirtyAtHook = Object.fromEntries(env.storage.history().map((e) => [e.id, e.dirty]));
    await inFlight();
    probe.hookRuns += 1;
    await macrotask();
    return res;
  };
  return probe;
}

/** 經 writeChain 讀改寫 history（比照 recordHistory），patch 一律作用在深拷貝上。 */
function rewriteHistory(env, patchById) {
  return env.deps.writeChain(async () => {
    const got = await env.storage.api.local.get('history');
    const list = Array.isArray(got.history) ? got.history : [];
    const next = list.map((e) => (patchById[e.id] ? patchById[e.id](JSON.parse(JSON.stringify(e))) : e));
    await env.storage.api.local.set({ history: next });
  });
}

/** 同一貼文再被複製一次：at 前進、seen 追加、dirty 維持 true。 */
function recopied(at) {
  return (e) => Object.assign(e, { at, seen: e.seen.concat([{ at, kind: 'strip' }]), dirty: true });
}

/** options.js 的刪除寫法：登入中留墓碑並標 dirty。 */
function tombstoned(deletedAt) {
  return (e) => Object.assign(e, { deletedAt, dirty: true });
}

function byId(env, id) {
  return env.storage.history().find((e) => e && e.id === id) || null;
}

// ============================================================================
// SW-0 測試
// ============================================================================

test('SW-0 規格1：往返期間被改動，ack 後仍 dirty，下一輪 upserts 帶最新內容', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'loc-a', url: POST_A })] });
  const probe = delayNextLinksPost(env, () => rewriteHistory(env, { 'loc-a': recopied(T0) }));
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.equal(probe.dirtyAtHook['loc-a'], true, '改動須發生在 ack 落地之前');
  const firstUp = env.syncPosts()[0].body.upserts.find((u) => u.id === 'loc-a');
  assert.ok(firstUp, '第一輪應送出 loc-a');
  assert.equal(firstUp.seen.length, 1, '第一輪送的是改動前的版本');

  const after = byId(env, 'loc-a');
  assert.ok(after, 'loc-a 應仍在本機');
  assert.equal(after.seen.length, 2, '往返期間追加的 seen 不得被 ack 蓋掉');
  assert.equal(after.dirty, true, '版本已變：ack 不得清掉新改動的 dirty');

  env.advance(60_000);
  const postsBefore = env.syncPosts().length;
  await engine.syncNow();
  await settle();

  const posts = env.syncPosts();
  assert.ok(posts.length > postsBefore, '第二輪應發出 links POST');
  const up = posts[postsBefore].body.upserts.find((u) => u.id === 'loc-a');
  assert.ok(up, '第二輪 upserts 應含 loc-a');
  assert.equal(up.seen.length, 2, '第二輪送出的是往返期間改動後的最新內容');
  assert.equal(byId(env, 'loc-a').dirty, false, '第二輪往返無改動，ack 後應清乾淨');
});

test('SW-0 規格2：往返期間未改動，ack 後 dirty 清為 false', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'loc-a', url: POST_A })] });
  const probe = delayNextLinksPost(env, async () => {});
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.ok(env.syncPosts()[0].body.upserts.some((u) => u.id === 'loc-a'), '第一輪應送出 loc-a');
  const after = byId(env, 'loc-a');
  assert.ok(after, 'loc-a 應仍在本機');
  assert.equal(after.dirty, false, '版本未變：ack 應清 dirty');
  assert.equal(after.seen.length, 1);
});

test('SW-0 規格3：同批多筆只改其中一筆，只有那筆保持 dirty', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'loc-a', url: POST_A, at: T0 - 30_000 }),
      entry({ id: 'loc-b', url: POST_B, at: T0 - 40_000 }),
      entry({ id: 'loc-c', url: POST_C, at: T0 - 50_000 }),
    ],
  });
  const probe = delayNextLinksPost(env, () => rewriteHistory(env, { 'loc-b': recopied(T0) }));
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  const sent = env.syncPosts()[0].body.upserts.map((u) => u.id).sort();
  assert.deepEqual(sent, ['loc-a', 'loc-b', 'loc-c'], '三筆同一批送出');
  assert.equal(byId(env, 'loc-a').dirty, false, 'loc-a 未改動，應清');
  assert.equal(byId(env, 'loc-c').dirty, false, 'loc-c 未改動，應清');
  const b = byId(env, 'loc-b');
  assert.equal(b.seen.length, 2);
  assert.equal(b.dirty, true, 'loc-b 往返期間被改動，應保持 dirty');
});

test('SW-0 規格4：往返期間被刪成墓碑，ack 不把它復活成 dirty upsert', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'loc-a', url: POST_A })] });
  const probe = delayNextLinksPost(env, () => rewriteHistory(env, { 'loc-a': tombstoned(T0) }));
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.ok(env.syncPosts()[0].body.upserts.some((u) => u.id === 'loc-a'), '第一輪送的是刪除前的活資料');
  const after = byId(env, 'loc-a');
  if (after) assert.equal(typeof after.deletedAt, 'number', 'ack 不得清掉往返期間寫入的 deletedAt');

  env.advance(60_000);
  const postsBefore = env.syncPosts().length;
  await engine.syncNow();
  await settle();

  env.syncPosts().slice(postsBefore).forEach((p) => {
    const ups = (p.body && p.body.upserts) || [];
    assert.ok(!ups.some((u) => u.id === 'loc-a'), '墓碑不得以 upsert 形式再送出');
  });
  const final = byId(env, 'loc-a');
  if (final) assert.equal(typeof final.deletedAt, 'number', '本機不得復活成活資料');
});
