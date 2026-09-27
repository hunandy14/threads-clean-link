// test/sync-marks-dirty.test.js — SW-4b（決策 S6）：marks 通道改為每筆 dirty 模型。
//
// 規格：simplify/design-sw.md §9.1、§9.2、§9.4。
//
// 【新模型】
// - 名單條目新增本機專有欄位 `dirty: true`（沒有這個鍵＝乾淨）與 `dirtyAt`
//   （版本戳，ack 比對用，語意同 SW-0 的 links ack）。toScamMark 不送、
//   fromScamMark 不讀，mergeScamEntry 保留本機的 dirty／dirtyAt。
// - 設 dirty：handleScamHit 新建或補證據、remove、restore、墓碑守衛留下的
//   條目、登入全量重傳（resetAccount('signIn') 的 markDirty）。
// - planMarkBatches 只篩 `dirty === true && isScamMarkHandle(handle)`，依 key 排
//   序每 50 筆一批，記 sent[key] = dirtyAt。
// - ack：applied.upserts 的 key 若本機 dirtyAt 仍等於 sent[key] 才清 dirty；
//   applied.rejectedIds 同樣清 dirty（同一版不重送，下次本機改動再標）。清
//   dirty 與同一頁 changes 的合併走同一次 mutate，每批一次 blocklist 寫入。
// - syncState 刪除 marksPushedAt、marksRejected；保留 marksCursor、
//   marksEvicted、marksBackfillCursor。
//
// 【遷移】原始 syncState 帶 `marksPushedAt` 鍵視為舊版。runMarksRound 開頭一次
// mutate 依舊規則標 dirty：sel = max(updatedAt, pushAfter)；
// `(pushedAt === null || sel > pushedAt) && rejected[key] !== sel` 就標，並刪掉
// pushAfter。下一次 saveState 把舊欄位清掉。登出態不遷移，登入後第一輪才遷
// 移（登入本來就全部標 dirty）。遷移與推送之間被殺只多推一次。
//
// harness：sync 部分（createSyncStorage／createAlarmsMock／createAuthMock／
// localEntry／localEvidence／blocklist／makeEnv／settle）逐字取自
// test/sync-marks.test.js，兩邊修改時需同步；唯一差異是 signedInState 不帶
// marksPushedAt／marksRejected 兩鍵——帶了就是舊版 syncState，會觸發遷移。
// background 部分比照 test/storage-mutate-callers.test.js 的精簡載入器。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');

const TCLCore = require('../tcl-core.js');
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');

function loadSync() {
  return require('../sync.js');
}

// Mark 固定九欄（§3.1 R1）。
const MARK_KEYS = ['key', 'state', 'dismissedAt', 'handle', 'displayName', 'source', 'evidence', 'addedAt', 'updatedAt'];

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const MARKS_SYNC_PATH = '/api/v1/marks/sync';

// ---- storage 替身（逐字取自 test/sync-marks.test.js） ----

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


/**
 * 新模型的已登入 syncState：刻意不帶 marksPushedAt／marksRejected 兩鍵。原始物
 * 件帶 marksPushedAt 鍵就是舊版（§9.2 遷移判準），會在第一輪觸發遷移。
 */
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
      marksBackfillCursor: null,
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

// ============================================================================
// 本檔專用小工具
// ============================================================================

/** 帶 dirty 的本機條目。dirtyAt 預設取 updatedAt，版本戳的實際來源由實作決定。 */
function dirtyEntry(over = {}) {
  const base = localEntry(over);
  return Object.assign(base, { dirty: true, dirtyAt: over.dirtyAt !== undefined ? over.dirtyAt : base.updatedAt });
}

/** 某幾次 POST（預設全部）送出的 upsert key，依出現順序。 */
function upsertKeys(env, from = 0) {
  const out = [];
  env
    .marksPosts()
    .slice(from)
    .forEach((req) => {
      ((req.body && req.body.upserts) || []).forEach((mark) => out.push(mark.key));
    });
  return out;
}

/** 經注入的 writeChain 就地改一筆條目（模擬 background 的讀改寫，整包換新物件）。 */
function patchEntry(env, id, patch) {
  return env.deps.writeChain(() =>
    env.storage.api.local.get('scamBlocklist').then((got) => {
      const list = JSON.parse(JSON.stringify(got.scamBlocklist));
      list.entries[id] = Object.assign({}, list.entries[id], patch);
      return env.storage.api.local.set({ scamBlocklist: list });
    })
  );
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// MD1 — 只送 dirty
// ============================================================================

test('MD1 只送 dirty：名單 5 筆其中 2 筆 dirty，POST upserts 恰 2 筆；ack 後 dirty 清掉', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0' },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: dirtyEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
      1003: localEntry({ handle: 'carol', updatedAt: T0 - DAY }),
      1004: dirtyEntry({ handle: 'dave', updatedAt: T0 - 6 * DAY }),
      1005: localEntry({ handle: 'erin', updatedAt: T0 - 2 * DAY }),
    }),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().lastError, null, '前置條件：這一輪成功');
  assert.deepEqual(
    upsertKeys(env).sort(),
    ['threads:1002', 'threads:1004'],
    '只送 dirty 的條目：乾淨的條目不論 updatedAt 多新都不送（不再有時戳水位線）'
  );
  const entries = env.storage.entries();
  assert.notEqual(entries['1002'].dirty, true, 'ack 之後 1002 的 dirty 要清掉');
  assert.notEqual(entries['1004'].dirty, true, 'ack 之後 1004 的 dirty 要清掉');
  ['1001', '1003', '1005'].forEach((id) => {
    assert.notEqual(entries[id].dirty, true, `${id} 本來就乾淨，不得被標髒`);
  });

  // 第二輪：沒有 dirty 就只推空的（仍要發一次往返拉增量）。
  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();
  assert.ok(env.marksPosts().length > before, '第二輪照樣發一次往返');
  assert.deepEqual(upsertKeys(env, before), [], '全部乾淨時 upserts 為空');
});

test('MD1 只送 dirty：handle 不合伺服器那把尺的 dirty 條目不進批，也不被清 dirty', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0' },
    blocklist: blocklist({
      1001: dirtyEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: dirtyEntry({ handle: undefined, state: 'dismissed', dismissedAt: T0 - DAY, updatedAt: T0 - DAY }),
    }),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(upsertKeys(env), ['threads:1001'], '沒有 handle 的條目送上去只會被拒，不進批');
  assert.equal(env.storage.entries()['1002'].dirty, true, '沒送出去的那筆 dirty 原封不動');
});

// ============================================================================
// MD2 — ack 版本比對
// ============================================================================

test('MD2 ack 版本比對：往返期間 dirtyAt 前進（再補證據），ack 不清 dirty，下一輪重送最新內容', async () => {
  const TCLSync = loadSync();
  const V1 = T0 - 3 * DAY;
  const V2 = T0 - 10_000;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0' },
    blocklist: blocklist({
      1001: dirtyEntry({
        handle: 'alice',
        updatedAt: T0 - 3 * DAY,
        dirtyAt: V1,
        evidence: [localEvidence({ postUrl: POST_A, at: T0 - 3 * DAY })],
      }),
    }),
  });

  // 延遲 mock：伺服器照送出當下的內容處理完，等一個 macrotask 再落地往返期間
  // 的改動（補一筆證據、dirtyAt 前進），改動落地後再等一個 macrotask 才把回應
  // 交還引擎。同 tick 解析會讓改動來不及插進往返，測試假綠。
  const origFetch = env.deps.fetch;
  let fired = false;
  env.deps.fetch = (input, init) => {
    const res = origFetch(input, init);
    if (fired || new URL(String(input)).pathname !== MARKS_SYNC_PATH) return res;
    fired = true;
    return Promise.resolve(res).then(async (response) => {
      await nextTick();
      await patchEntry(env, '1001', {
        evidence: [
          localEvidence({ postUrl: POST_A, at: T0 - 3 * DAY }),
          localEvidence({ postUrl: POST_B, anchorPostUrl: POST_B, at: T0 - 20_000 }),
        ],
        dirty: true,
        dirtyAt: V2,
      });
      await nextTick();
      return response;
    });
  };

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.ok(fired, '前置條件：往返期間的改動確實插進去了');
  assert.equal(env.storage.syncState().lastError, null, '前置條件：第一輪成功');
  const first = upsertKeys(env);
  assert.deepEqual(first, ['threads:1001'], '前置條件：第一輪送的是舊版（一篇證據）');
  assert.equal(env.marksPosts()[0].body.upserts[0].evidence.length, 1, '前置條件：送出當下只有一篇證據');

  const mid = env.storage.entries()['1001'];
  assert.equal(mid.evidence.length, 2, '前置條件：往返期間補的證據留在本機');
  assert.equal(
    mid.dirty,
    true,
    'ack 回來時本機 dirtyAt 已不是送出當下那一版：清掉 dirty 等於把往返期間的新證據一起當成已上雲，這篇命中從此推不出去'
  );
  assert.equal(mid.dirtyAt, V2, 'dirtyAt 維持往返期間寫下的新版本');

  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  const resent = env
    .marksPosts()
    .slice(before)
    .flatMap((req) => (req.body && req.body.upserts) || [])
    .filter((mark) => mark.key === 'threads:1001');
  assert.equal(resent.length, 1, '下一輪重送這一筆');
  assert.equal(resent[0].evidence.length, 2, '重送的是最新內容（兩篇證據）');
  assert.equal(env.server.marks.byKey('threads:1001').evidence.length, 2, '雲端補齊兩篇');
  assert.notEqual(env.storage.entries()['1001'].dirty, true, '這一版 ack 對得上，dirty 清掉');
});

// ============================================================================
// MD3 — rejectedIds 清 dirty
// ============================================================================

test('MD3 rejectedIds 清 dirty：同一版不重送，本機下次改動再標髒後才重送', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    // 游標落在墓碑之後：增量拉不到那筆墓碑，被拒的條目留在本機（否則會被墓碑
    // 守衛硬刪，看不出 dirty 的去向）。
    syncState: { marksCursor: String(T0 - 2 * DAY) },
    blocklist: blocklist({
      1001: dirtyEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      // 比雲端墓碑舊 → 伺服器回 rejectedIds。
      1003: dirtyEntry({ handle: 'carol', updatedAt: T0 - 6 * DAY }),
    }),
  });
  env.server.marks.seedTombstone('threads:1003', T0 - 3 * DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(upsertKeys(env).sort(), ['threads:1001', 'threads:1003'], '前置條件：兩筆 dirty 都送出');
  assert.equal(env.server.marks.byKey('threads:1003'), null, '前置條件：1003 被拒，沒有寫進雲端');
  const entries = env.storage.entries();
  assert.ok(entries['1003'], '前置條件：被拒的條目仍在本機');
  assert.notEqual(entries['1003'].dirty, true, 'rejectedIds 也清 dirty：同一版重送只會每輪再撞一次');
  assert.notEqual(entries['1001'].dirty, true, '收下的那筆照常清 dirty');
  assert.ok(!hasKey(env.storage.syncState(), 'marksRejected'), '被拒映射退場，syncState 不再有 marksRejected');

  // 第二輪：本機沒動，不重送。
  const afterFirst = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();
  assert.ok(env.marksPosts().length > afterFirst, '第二輪照樣發一次往返');
  assert.ok(!upsertKeys(env, afterFirst).includes('threads:1003'), '同一版不重送');

  // 第三輪：使用者改動了那一筆（updatedAt 晚於墓碑、再標髒），才重送。
  await patchEntry(env, '1003', { updatedAt: T0 - 2 * DAY, dirty: true, dirtyAt: T0 - 2 * DAY });
  const afterSecond = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();
  assert.ok(upsertKeys(env, afterSecond).includes('threads:1003'), '本機改動再標髒，下一輪重送');
  assert.equal(env.server.marks.byKey('threads:1003').updatedAt, T0 - 2 * DAY, '新版撤銷墓碑寫進雲端');
  assert.notEqual(env.storage.entries()['1003'].dirty, true, '這次收下了，dirty 清掉');
});

// ============================================================================
// MD4 — 遠端純量較新時本機 dirty 仍保留（CR-1 改寫）
// ============================================================================

test('MD4 mergeScamEntry：遠端純量較新（本機 LWW 輸），本機的 dirty／dirtyAt 照樣保留', () => {
  const local = {
    state: 'active',
    handle: 'alice',
    source: 'auto',
    addedAt: T0 - 5 * DAY,
    updatedAt: T0 - 3 * DAY,
    evidence: [{ postUrl: POST_A, at: T0 - 3 * DAY }],
    dirty: true,
    dirtyAt: T0 - 60_000,
  };
  const remote = {
    state: 'dismissed',
    dismissedAt: T0 - DAY,
    handle: 'alice',
    displayName: 'Cloud Name',
    source: 'auto',
    addedAt: T0 - 5 * DAY,
    updatedAt: T0 - DAY,
    evidence: [],
  };
  const merged = TCLCore.mergeScamEntry(local, remote);
  assert.equal(merged.state, 'dismissed', '前置條件：純量由較新的遠端勝出');
  assert.equal(merged.dirty, true, 'dirty 是本機專有欄位，與雲端那份的新舊無關；純量落敗就洗掉的話，本機那篇新證據再也推不出去');
  assert.equal(merged.dirtyAt, T0 - 60_000, 'dirtyAt 一併保留，ack 比對才對得上');

  const clean = TCLCore.mergeScamEntry(Object.assign({}, local, { dirty: undefined, dirtyAt: undefined }), remote);
  assert.notEqual(clean.dirty, true, '本機乾淨時合併不得憑空標髒');

  // 遠端（fromScamMark 的輸出）不會帶 dirty；就算帶了也不採信。
  const spoofed = TCLCore.mergeScamEntry(
    Object.assign({}, local, { dirty: undefined, dirtyAt: undefined }),
    Object.assign({}, remote, { dirty: true, dirtyAt: 1 })
  );
  assert.notEqual(spoofed.dirty, true, 'dirty 只認本機那一份');
});

test('MD4 回填合併遠端較新的純量之後，本機 dirty 條目仍是 dirty，並於推送時送出', async () => {
  const TCLSync = loadSync();
  const V = T0 - 60_000;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null },
    blocklist: blocklist({
      1001: dirtyEntry({
        handle: 'alice',
        updatedAt: T0 - 3 * DAY,
        dirtyAt: V,
        evidence: [localEvidence({ postUrl: POST_A, anchorPostUrl: POST_A, at: T0 - 3 * DAY })],
      }),
    }),
  });
  env.server.marks.seed([
    {
      key: 'threads:1001',
      state: 'active',
      dismissedAt: null,
      handle: 'alice',
      displayName: 'Cloud Name',
      source: 'auto',
      evidence: [],
      addedAt: T0 - 5 * DAY,
      updatedAt: T0 - DAY,
    },
  ]);
  // 推送斷線：回填已經合併完，這一輪的推送沒送出去，dirty 是否保留一目了然。
  env.failPath(MARKS_SYNC_PATH, { kind: 'network' });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const mid = env.storage.entries()['1001'];
  assert.equal(mid.displayName, 'Cloud Name', '前置條件：遠端較新，純量由它勝出（回填合併真的跑過）');
  assert.equal(mid.dirty, true, '合併之後本機 dirty 仍在：那篇本機證據還沒上雲');
  assert.equal(mid.dirtyAt, V, 'dirtyAt 一併保留');

  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  const sent = env.upsertsByKey()['threads:1001'];
  assert.ok(sent, '下一輪照樣推得出去');
  assert.equal(sent.evidence.length, 1, '送出去的帶著本機那篇證據');
  assert.equal(env.server.marks.byKey('threads:1001').evidence.length, 1, '雲端補上本機證據');
  assert.notEqual(env.storage.entries()['1001'].dirty, true, '推成功後清 dirty');
});

// ============================================================================
// MD5 — 墓碑守衛留下的條目標 dirty
// ============================================================================

test('MD5 墓碑守衛：本機比墓碑新的條目留下並標 dirty，下一輪重送撤銷墓碑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0' },
    blocklist: blocklist({
      // 乾淨條目：這一輪本來不推，只靠守衛的標髒才推得出去。
      1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }),
      // 不晚於墓碑：照常硬刪（對照組）。
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
    }),
  });
  env.server.marks.seedTombstone('threads:1001', T0 - 2 * DAY);
  env.server.marks.seedTombstone('threads:1002', T0 - 3 * DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(upsertKeys(env), [], '前置條件：第一輪沒有 dirty，推空的只為了拉增量');
  const entries = env.storage.entries();
  assert.equal(entries['1002'], undefined, '對照組：不晚於墓碑的硬刪');
  assert.ok(entries['1001'], '比墓碑新的留在本機');
  assert.equal(entries['1001'].dirty, true, '留下的條目標 dirty，下一輪才推得出去，否則兩端永遠不一致');
  assert.ok(Number.isFinite(entries['1001'].dirtyAt), '標髒時一併記 dirtyAt');
  assert.ok(!hasKey(env.storage.syncState(), 'marksPushedAt'), '讓位不再靠退水位線');

  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  assert.deepEqual(upsertKeys(env, before), ['threads:1001'], '下一輪重送留下的那筆');
  assert.equal(env.server.marks.byKey('threads:1001').updatedAt, T0 - DAY, '較新的版本撤銷墓碑寫進雲端');
  assert.notEqual(env.storage.entries()['1001'].dirty, true, '收下之後清 dirty');
});

// ============================================================================
// MD6 — background 的三條寫入路徑設 dirty
// ============================================================================

const BG_EXT_ID = 'marks-dirty-test-extension-id';
const BG_SCAM_KEY = 'scamBlocklist';
const BG_USER_ID = '10000000001';
const BG_HANDLE = 'example_author';
const BG_POST_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const BG_POST_URL_2 = 'https://www.threads.com/@example_author/post/DxSyNtH0007';
const BG_AT = 1700000100000;

function bgScamHit(overrides) {
  return Object.assign(
    {
      type: 'scam.hit',
      userId: BG_USER_ID,
      handle: BG_HANDLE,
      displayName: 'Example Author',
      postUrl: BG_POST_URL,
      snippet: '不報明牌、不收費、不代操，加我 賴：ex01abc 聊黑馬股',
      anchorMatch: '賴：ex01abc',
      pitchMatches: ['黑馬股', '報明牌'],
      at: BG_AT,
    },
    overrides || {}
  );
}

function bgEntry(over) {
  return Object.assign(
    {
      state: 'active',
      handle: BG_HANDLE,
      displayName: 'Example Author',
      source: 'auto',
      addedAt: BG_AT,
      updatedAt: BG_AT,
      evidence: [{ postUrl: BG_POST_URL, anchorPostUrl: BG_POST_URL, snippet: '片段', at: BG_AT }],
    },
    over || {}
  );
}

function bgBlocklist(entries) {
  const handleIndex = {};
  Object.keys(entries).forEach((id) => {
    if (entries[id].state !== 'dismissed') handleIndex[entries[id].handle.toLowerCase()] = id;
  });
  return { version: 2, entries, handleIndex };
}

/**
 * 載入 background.js（比照 test/storage-mutate-callers.test.js）。引擎以 Proxy
 * 替身代打；handleScamHit／handleScamBlocklistRemove／handleScamBlocklistRestore
 * 是腳本頂層的函式宣告，直接從沙箱全域呼叫。
 */
async function loadBackground(localSeed = {}) {
  const storage = createChromeStorage(
    { saveHistory: true },
    Object.assign(
      {
        syncDevice: {
          deviceId: '11111111-2222-4333-8444-555555555555',
          platform: 'chrome_extension',
          createdAt: 1700000000000,
        },
      },
      localSeed
    )
  );
  const engine = new Proxy({}, { get: () => () => Promise.resolve({ ok: true }) });
  const chrome = {
    runtime: {
      id: BG_EXT_ID,
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
  loadSwSources(sandbox);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { sandbox, storage };
}

function bgEntryOf(bg, userId) {
  const list = bg.storage.localSnapshot()[BG_SCAM_KEY];
  assert.ok(list && list.entries, '名單應已落地');
  const entry = list.entries[userId || BG_USER_ID];
  assert.ok(entry, '名單應有 userId=' + (userId || BG_USER_ID) + ' 的條目');
  return JSON.parse(JSON.stringify(entry));
}

test('MD6 handleScamHit 新建條目：設 dirty 與 dirtyAt', async () => {
  const bg = await loadBackground();
  const res = await bg.sandbox.handleScamHit(bgScamHit());
  assert.equal(res && res.ok, true, '前置條件：命中寫入成功');
  assert.equal(res.added, true, '前置條件：走新建分支');
  const entry = bgEntryOf(bg);
  assert.equal(entry.dirty, true, '新建的條目要推上雲，標 dirty');
  assert.ok(Number.isFinite(entry.dirtyAt), 'dirtyAt 是 ack 比對用的版本戳，必須是有限數字');
  assert.ok(!hasKey(entry, 'pushAfter'), 'pushAfter 由 dirty 取代，新路徑不再寫');
});

test('MD6 handleScamHit 補證據：設 dirty、dirtyAt 前進，updatedAt 不動、不寫 pushAfter', async () => {
  const OLD = BG_AT - 1000;
  const bg = await loadBackground({
    [BG_SCAM_KEY]: bgBlocklist({ [BG_USER_ID]: bgEntry({ dirty: true, dirtyAt: OLD }) }),
  });
  const res = await bg.sandbox.handleScamHit(
    bgScamHit({ postUrl: BG_POST_URL_2, anchorPostUrl: BG_POST_URL_2, at: BG_AT + 3600000 })
  );
  assert.equal(res && res.ok, true, '前置條件：命中寫入成功');
  const entry = bgEntryOf(bg);
  assert.equal(entry.evidence.length, 2, '前置條件：新證據併進去');
  assert.equal(entry.updatedAt, BG_AT, 'CR-1：被動再掃到不推進 updatedAt');
  assert.equal(entry.dirty, true, '補了證據就要推，標 dirty');
  assert.ok(Number.isFinite(entry.dirtyAt), 'dirtyAt 是有限數字');
  assert.notEqual(
    entry.dirtyAt,
    OLD,
    '已經 dirty 的條目再補證據，dirtyAt 也要換一版：往返途中補的證據靠它讓 ack 認出「送出去的不是最新版」'
  );
  assert.ok(!hasKey(entry, 'pushAfter'), 'pushAfter 由 dirty 取代，新路徑不再寫');
});

test('MD6 handleScamHit 重複證據：不寫、不標髒（回歸保護）', async () => {
  const bg = await loadBackground({ [BG_SCAM_KEY]: bgBlocklist({ [BG_USER_ID]: bgEntry() }) });
  bg.storage.localCalls.set.length = 0;
  await bg.sandbox.handleScamHit(bgScamHit({ anchorPostUrl: BG_POST_URL, at: BG_AT + 3600000 }));
  const writes = bg.storage.localCalls.set.filter((items) => hasKey(items, BG_SCAM_KEY));
  assert.deepEqual(writes, [], '沒有新證據就不寫');
  assert.notEqual(bgEntryOf(bg).dirty, true, '沒有改動不標髒');
});

test('MD6 scam.blocklist.remove：既有條目與補建條目都設 dirty 與 dirtyAt', async () => {
  const OTHER_ID = '10000000002';
  const bg = await loadBackground({ [BG_SCAM_KEY]: bgBlocklist({ [BG_USER_ID]: bgEntry() }) });
  const res = await bg.sandbox.handleScamBlocklistRemove({ type: 'scam.blocklist.remove', userId: BG_USER_ID });
  assert.equal(res && res.ok, true, '前置條件：解除成功');
  const entry = bgEntryOf(bg);
  assert.equal(entry.state, 'dismissed', '前置條件：翻成 dismissed');
  assert.equal(entry.dirty, true, '解除是跨裝置要一致的狀態變更，標 dirty');
  assert.ok(Number.isFinite(entry.dirtyAt), 'dirtyAt 是有限數字');

  await bg.sandbox.handleScamBlocklistRemove({
    type: 'scam.blocklist.remove',
    userId: OTHER_ID,
    handle: 'other_author',
  });
  const created = bgEntryOf(bg, OTHER_ID);
  assert.equal(created.state, 'dismissed', '前置條件：補建一筆解除條目');
  assert.equal(created.dirty, true, '補建的解除條目同樣要推，標 dirty');
  assert.ok(Number.isFinite(created.dirtyAt), 'dirtyAt 是有限數字');
});

test('MD6 scam.blocklist.restore：設 dirty 與 dirtyAt', async () => {
  const bg = await loadBackground({
    [BG_SCAM_KEY]: bgBlocklist({
      [BG_USER_ID]: bgEntry({ state: 'dismissed', dismissedAt: BG_AT + 60000, updatedAt: BG_AT + 60000 }),
    }),
  });
  const res = await bg.sandbox.handleScamBlocklistRestore({ type: 'scam.blocklist.restore', userId: BG_USER_ID });
  assert.equal(res && res.ok, true, '前置條件：復原成功');
  const entry = bgEntryOf(bg);
  assert.equal(entry.state, 'active', '前置條件：翻回 active');
  assert.equal(entry.dirty, true, '復原同樣是名單的狀態變更，標 dirty');
  assert.ok(Number.isFinite(entry.dirtyAt), 'dirtyAt 是有限數字');
});

// ============================================================================
// MD7 — syncState 形狀
// ============================================================================

test('MD7 normalizeSyncState：舊值帶 marksPushedAt／marksRejected 也不輸出這兩鍵，其餘三格保留', () => {
  const out = TCLCore.normalizeSyncState({
    userId: 'user-abc',
    marksCursor: 'm-cur',
    marksPushedAt: T0,
    marksEvicted: 3,
    marksRejected: { 'threads:1001': T0 - DAY },
    marksBackfillCursor: 'b-cur',
  });
  assert.ok(!hasKey(out, 'marksPushedAt'), 'marksPushedAt 退場');
  assert.ok(!hasKey(out, 'marksRejected'), 'marksRejected 退場');
  assert.equal(out.marksCursor, 'm-cur', '下行游標保留');
  assert.equal(out.marksEvicted, 3, '淘汰筆數保留');
  assert.equal(out.marksBackfillCursor, 'b-cur', '回填續填位置保留');

  const empty = TCLCore.normalizeSyncState(null);
  assert.ok(!hasKey(empty, 'marksPushedAt') && !hasKey(empty, 'marksRejected'), '預設形狀也不帶兩鍵');
  assert.ok(
    !hasKey(TCLCore.DEFAULT_SYNC_STATE, 'marksPushedAt') && !hasKey(TCLCore.DEFAULT_SYNC_STATE, 'marksRejected'),
    'DEFAULT_SYNC_STATE 同步刪掉兩鍵'
  );
  assert.equal(typeof TCLCore.normalizeMarksRejected, 'undefined', 'normalizeMarksRejected 隨映射退場');
});

test('MD7 buildState：getState 不再輸出 marksPushedAt／marksRejected', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    local: {
      syncState: {
        userId: null,
        email: null,
        cursor: null,
        lastSyncedAt: null,
        lastError: null,
        marksCursor: null,
        marksPushedAt: null,
        marksEvicted: null,
        marksRejected: null,
        marksBackfillCursor: null,
      },
    },
  });
  const engine = TCLSync.create(env.deps);
  const state = await engine.getState();
  assert.ok(!hasKey(state, 'marksPushedAt'), 'marksPushedAt 不再對外');
  assert.ok(!hasKey(state, 'marksRejected'), 'marksRejected 不再對外');
  ['marksCursor', 'marksEvicted', 'marksBackfillCursor'].forEach((key) => {
    assert.ok(hasKey(state, key), `${key} 照樣帶出`);
  });
});

test('MD7 normalizeScamBlocklist：dirty 與 dirtyAt 是本機專有欄位，正規化保留、toScamMark 不送', () => {
  const list = TCLCore.normalizeScamBlocklist(
    blocklist({ 1001: dirtyEntry({ handle: 'alice', dirtyAt: T0 - 5 }), 1002: localEntry({ handle: 'bob' }) })
  );
  assert.equal(list.entries['1001'].dirty, true, 'dirty 過正規化要留著，否則每一次寫入都把待推旗標洗掉');
  assert.equal(list.entries['1001'].dirtyAt, T0 - 5, 'dirtyAt 同樣保留');
  assert.notEqual(list.entries['1002'].dirty, true, '乾淨條目不長出 dirty');

  const mark = TCLCore.toScamMark('1001', list.entries['1001']);
  assert.deepEqual(Object.keys(mark).sort(), MARK_KEYS.slice().sort(), 'mark 固定九欄，dirty／dirtyAt 不上雲');
  const parsed = TCLCore.fromScamMark(Object.assign({}, mark, { dirty: true, dirtyAt: 9 }));
  assert.ok(parsed, '前置條件：雲端 mark 讀得回來');
  assert.ok(!hasKey(parsed.entry, 'dirty') && !hasKey(parsed.entry, 'dirtyAt'), 'fromScamMark 不讀 dirty／dirtyAt');
});

// ============================================================================
// MD8 — 舊版 syncState 遷移
// ============================================================================

const LEGACY_PUSHED_AT = T0 - 2 * DAY;

/** 舊規則的各種組合。註解是舊規則的判定結果。 */
function legacyEntries() {
  return {
    // sel = updatedAt ≤ pushedAt → 乾淨
    1001: localEntry({ handle: 'u1001', updatedAt: T0 - 3 * DAY }),
    // sel = updatedAt > pushedAt → dirty
    1002: localEntry({ handle: 'u1002', updatedAt: T0 - DAY }),
    // sel = pushAfter > pushedAt（updatedAt 在水位線下）→ dirty
    1003: localEntry({ handle: 'u1003', updatedAt: T0 - 3 * DAY, pushAfter: T0 - DAY + 5 }),
    // sel > pushedAt 但與被拒映射同一版 → 乾淨
    1004: localEntry({ handle: 'u1004', updatedAt: T0 - DAY }),
    // sel > pushedAt，被拒映射記的是較舊的一版 → dirty
    1005: localEntry({ handle: 'u1005', updatedAt: T0 - DAY + 10 }),
    // sel 等於 pushedAt（嚴格大於才算）→ 乾淨
    1006: localEntry({ handle: 'u1006', updatedAt: LEGACY_PUSHED_AT }),
    // pushAfter 恰等於 pushedAt → 乾淨，pushAfter 照樣刪
    1007: localEntry({ handle: 'u1007', updatedAt: T0 - 3 * DAY, pushAfter: LEGACY_PUSHED_AT }),
  };
}

const LEGACY_DIRTY = ['1002', '1003', '1005'];

function legacySyncState() {
  return Object.assign(signedInState({ marksCursor: '0' }), {
    marksPushedAt: LEGACY_PUSHED_AT,
    marksRejected: { 'threads:1004': T0 - DAY, 'threads:1005': T0 - DAY },
  });
}

function assertLegacyDirty(entries, label) {
  Object.keys(legacyEntries()).forEach((id) => {
    if (LEGACY_DIRTY.includes(id)) {
      assert.equal(entries[id].dirty, true, `${label}：${id} 依舊規則要標 dirty`);
      assert.ok(Number.isFinite(entries[id].dirtyAt), `${label}：${id} 一併記 dirtyAt`);
    } else {
      assert.notEqual(entries[id].dirty, true, `${label}：${id} 依舊規則不標 dirty`);
    }
    assert.ok(!hasKey(entries[id], 'pushAfter'), `${label}：${id} 的 pushAfter 在遷移時刪掉`);
  });
}

test('MD8 遷移：第一輪推送前依舊規則標 dirty、刪 pushAfter，saveState 後舊欄位消失', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, scamGuardEnabled: true, blocklist: blocklist(legacyEntries()) });
  env.storage.localData.syncState = legacySyncState();
  // 推送斷線：遷移已落地、推送沒送出，dirty 的判定結果原樣留在本機。
  env.failPath(MARKS_SYNC_PATH, { kind: 'network' });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().lastError, 'network_error', '前置條件：推送那一步斷線');
  assertLegacyDirty(env.storage.entries(), '遷移後');
  const raw = env.storage.syncState();
  assert.ok(!hasKey(raw, 'marksPushedAt'), 'saveState 之後 marksPushedAt 消失');
  assert.ok(!hasKey(raw, 'marksRejected'), 'saveState 之後 marksRejected 消失');
  assert.equal(raw.marksCursor, '0', '下行游標不受遷移影響');
});

test('MD8 遷移冪等：遷移與推送之間被殺（舊 syncState 沒被清），重跑只多推一次、不漏不重', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, scamGuardEnabled: true, blocklist: blocklist(legacyEntries()) });
  env.storage.localData.syncState = legacySyncState();
  env.failPath(MARKS_SYNC_PATH, { kind: 'network' });

  await TCLSync.create(env.deps).syncNow();
  await settle();
  assertLegacyDirty(env.storage.entries(), '第一次遷移後');

  // 模擬 SW 在遷移落地之後、saveState 之前被殺：storage 裡仍是舊版 syncState。
  // 此時 pushAfter 已刪，重跑舊規則時 1003 不會再被選中——遷移只能標髒、不能
  // 清髒，否則那筆新證據就漏推了。
  env.storage.localData.syncState = legacySyncState();
  env.advance(6 * 60_000);
  const before = env.marksPosts().length;
  await TCLSync.create(env.deps).syncNow();
  await settle();

  assert.equal(env.storage.syncState().lastError, null, '前置條件：重跑這一輪成功');
  const keys = upsertKeys(env, before);
  assert.deepEqual(
    keys.slice().sort(),
    LEGACY_DIRTY.map((id) => 'threads:' + id).sort(),
    '重跑送出的恰是舊規則選中的那幾筆，各一次'
  );
  const entries = env.storage.entries();
  Object.keys(legacyEntries()).forEach((id) => {
    assert.notEqual(entries[id].dirty, true, `${id}：推完之後沒有殘留 dirty`);
    assert.ok(!hasKey(entries[id], 'pushAfter'), `${id}：pushAfter 不復返`);
  });
  const raw = env.storage.syncState();
  assert.ok(!hasKey(raw, 'marksPushedAt') && !hasKey(raw, 'marksRejected'), '舊欄位清掉');

  // 再一輪：舊欄位已清、沒有 dirty，不得再推任何一筆。
  env.advance(6 * 60_000);
  const after = env.marksPosts().length;
  await TCLSync.create(env.deps).syncNow();
  await settle();
  assert.deepEqual(upsertKeys(env, after), [], '遷移只發生一次，之後全部乾淨');
});

test('MD8 遷移：成功的一輪只推舊規則選中的條目（回歸保護）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, scamGuardEnabled: true, blocklist: blocklist(legacyEntries()) });
  env.storage.localData.syncState = legacySyncState();

  await TCLSync.create(env.deps).syncNow();
  await settle();

  assert.deepEqual(
    upsertKeys(env).sort(),
    LEGACY_DIRTY.map((id) => 'threads:' + id).sort(),
    '遷移前後推送的集合一致：舊版升級不漏推、不重推整份名單'
  );
});

test('MD8 遷移：水位線為 null 時被拒映射照樣生效（對齊 0.10.0 選批規則）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'u1001', updatedAt: T0 - DAY }),
      // 被拒映射記的正是這一版：0.10.0 的 planMarkBatches 不論水位線是否 null 都跳過。
      1002: localEntry({ handle: 'u1002', updatedAt: T0 - 2 * DAY }),
      // 被拒映射記的是較舊的一版：照樣要推。
      1003: localEntry({ handle: 'u1003', updatedAt: T0 - DAY + 7 }),
    }),
  });
  env.storage.localData.syncState = Object.assign(signedInState({ marksCursor: '0' }), {
    marksPushedAt: null,
    marksRejected: { 'threads:1002': T0 - 2 * DAY, 'threads:1003': T0 - DAY },
  });
  env.failPath(MARKS_SYNC_PATH, { kind: 'network' });

  await TCLSync.create(env.deps).syncNow();
  await settle();

  const entries = env.storage.entries();
  assert.equal(entries['1001'].dirty, true, '水位線 null：沒被拒的條目全推');
  assert.notEqual(entries['1002'].dirty, true, '水位線 null 也不重送被拒的同一版');
  assert.equal(entries['1003'].dirty, true, '被拒的是較舊一版，本機已改過，照樣要推');
});

test('MD8 遷移：登出態不遷移，登入後第一輪才遷移（登入本來就全部標 dirty）', async () => {
  const TCLSync = loadSync();
  const entries = legacyEntries();
  const env = makeEnv({ scamGuardEnabled: true, blocklist: blocklist(entries), history: [] });
  // 舊版 normalize 會把所有鍵寫成 null：登出態的舊 syncState 同樣帶 marksPushedAt 鍵。
  env.storage.localData.syncState = {
    userId: null,
    email: null,
    displayName: null,
    avatarUrl: null,
    cursor: null,
    lastSyncedAt: null,
    lastError: null,
    marksCursor: null,
    marksPushedAt: null,
    marksEvicted: null,
    marksRejected: null,
    marksBackfillCursor: null,
  };
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();
  assert.deepEqual(env.storage.writesTo('scamBlocklist'), [], '登出態零寫入：不遷移');
  assert.equal(env.storage.entries()['1003'].pushAfter, T0 - DAY + 5, '登出態 pushAfter 原封不動');
  Object.keys(entries).forEach((id) => {
    assert.notEqual(env.storage.entries()[id].dirty, true, `${id}：登出態不標 dirty`);
  });
  assert.deepEqual(env.server.requests.length, 0, '登出態零請求');

  await engine.signIn();
  await settle(40);

  assert.equal(env.storage.syncState().lastError, null, '前置條件：登入後第一輪成功');
  assert.deepEqual(
    upsertKeys(env).sort(),
    Object.keys(entries).map((id) => 'threads:' + id).sort(),
    '登入全量重傳：整份名單都送'
  );
  const after = env.storage.entries();
  // pushAfter 在這條路徑不強制清除：登入重設 syncState 之後已無舊版判準，殘
  // 留的 pushAfter 不再有讀者（選批只看 dirty），由下一個 minor 的正規化剝除。
  Object.keys(entries).forEach((id) => {
    assert.notEqual(after[id].dirty, true, `${id}：推完清 dirty`);
  });
  const raw = env.storage.syncState();
  assert.ok(!hasKey(raw, 'marksPushedAt') && !hasKey(raw, 'marksRejected'), '舊欄位消失');
});

// ============================================================================
// MD9 — 登入全量重傳
// ============================================================================

test('MD9 登入全量重傳：finishSignIn 之後名單全部 dirty', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    // 警示總開關關閉：marks 通道整條跳過，登入時標的 dirty 原樣留在本機可觀察。
    scamGuardEnabled: false,
    history: [],
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }),
      1002: localEntry({ handle: 'bob', state: 'dismissed', dismissedAt: T0 - DAY, updatedAt: T0 - DAY }),
      1003: localEntry({ handle: 'carol', updatedAt: T0 - 5 * DAY }),
    }),
  });
  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle(40);

  assert.ok(env.storage.syncAuth() && env.storage.syncAuth().token, '前置條件：登入成功');
  assert.equal(env.marksPosts().length, 0, '前置條件：marks 通道關閉，沒有推送清掉 dirty');
  const entries = env.storage.entries();
  ['1001', '1002', '1003'].forEach((id) => {
    assert.equal(entries[id].dirty, true, `${id}：登入＝重建鏡像，名單全部標 dirty`);
    assert.ok(Number.isFinite(entries[id].dirtyAt), `${id}：一併記 dirtyAt`);
  });
  const raw = env.storage.syncState();
  assert.ok(!hasKey(raw, 'marksPushedAt') && !hasKey(raw, 'marksRejected'), '登入重設的 syncState 不帶舊兩鍵');
});

test('MD9 toScamMark 不送 dirty／dirtyAt（回歸保護）', () => {
  const mark = TCLCore.toScamMark('1001', dirtyEntry({ handle: 'alice', dirtyAt: T0 }));
  assert.deepEqual(Object.keys(mark).sort(), MARK_KEYS.slice().sort(), '固定九欄，本機專有欄位不上雲');
});

// ============================================================================
// MD10 — 每批一次 blocklist 寫入，依 key 切批
// ============================================================================

test('MD10 每輪 blocklist 寫入次數 ≤ 批數：清 dirty 與 changes 合併同一次 mutate；依 key 排序切批', async () => {
  const TCLSync = loadSync();
  // 51 筆 dirty：key 升冪對上 updatedAt 降冪，舊的「依 updatedAt 排序」切法會把
  // 最大的 key 排進第一批。
  const entries = {};
  for (let i = 0; i < 51; i += 1) {
    const id = String(2001 + i);
    entries[id] = dirtyEntry({ handle: `bulk${id}`, updatedAt: T0 - DAY - i, addedAt: T0 - 5 * DAY });
  }
  // 三筆乾淨條目：不進批。
  entries['3001'] = localEntry({ handle: 'clean1', updatedAt: T0 - DAY });
  entries['3002'] = localEntry({ handle: 'clean2', updatedAt: T0 - DAY });
  entries['3003'] = localEntry({ handle: 'clean3', updatedAt: T0 - DAY });

  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0' },
    blocklist: blocklist(entries),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.equal(posts.length, 2, '51 筆切兩批');
  const firstBatch = posts[0].body.upserts.map((mark) => mark.key);
  const expected = [];
  for (let i = 0; i < 50; i += 1) expected.push('threads:' + (2001 + i));
  assert.deepEqual(firstBatch, expected, '依 key 升冪切批，第一批是 key 最小的 50 筆');
  assert.deepEqual(posts[1].body.upserts.map((mark) => mark.key), ['threads:2051'], '第二批是剩下那一筆');

  const writes = env.storage.writesTo('scamBlocklist');
  assert.ok(writes.length >= 1, '清 dirty 一定要落盤');
  assert.ok(
    writes.length <= posts.length,
    `每批最多一次 blocklist 寫入（實得 ${writes.length} 次、${posts.length} 批）：清 dirty 與 changes 的合併要走同一次 mutate`
  );
  const after = env.storage.entries();
  Object.keys(entries).forEach((id) => {
    assert.notEqual(after[id].dirty, true, `${id}：推完沒有殘留 dirty`);
  });
});
