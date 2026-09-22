// test/sync-marks.test.js — 同步引擎 `sync.js` 的警示名單（marks）通道契約，紅燈先行。
//
// 唯一真相源：docs/cloud-sync.md §3.1（插件端 mark 同步契約）與 §4.5（mark 資料
// 模型與欄位映射表，在 origin/docs/marks-sync 分支）、D35–D40、契約修訂 R1／R2；
// 後端形狀由 test/helpers/mock-sync-server.js 的 marks 端點代言。
//
// ============================================================================
// 本檔釘定的通道契約（sync.js 尚未實作，以下形狀由測試定義）
// ============================================================================
// marks 是與 links **並存**的第二條通道，共用同一套登入態、alarm 排程、退避曲
// 線、`session_expired` 處理與限流回應處理；`engine.syncNow()` 一次往返同時跑
// 完兩條通道。兩條通道各自有獨立水位線。
//
// 【水位線落點】沿 links 的形狀：links 的 `cursor` 存在 `syncState`，因此 marks
// 的四格狀態也存在 **`syncState`** 裡（不另開新鍵）：
//
//   syncState.marksCursor   string | null   拉取水位線，伺服器回應的 cursor 原樣寫回
//   syncState.marksPushedAt number | null   推送水位線，只送 updatedAt 大於它的條目
//   syncState.marksEvicted  number | null   雲端上一輪淘汰筆數，純 UI 提示
//   syncState.marksRejected object | null   被拒 key → 被拒當下的 updatedAt（R2）
//
// 這四格需要 `TCLCore.normalizeSyncState` 一併放行（由 marks 引擎的實作者順手
// 在 tcl-core.js 補上）。
//
// 【一輪 marks 的動作順序】
//   0. `scamGuardEnabled === false` → 整條通道跳過，零請求（D35，開關 A）。
//   1. `marksCursor === null`（首次登入／首次啟用）→ 先走回填
//      `GET /api/v1/marks?limit=…`，以 `nextCursor` 續頁到 null 為止。
//   2. 推：`scamBlocklist.entries` 中 `updatedAt > marksPushedAt` 者（水位線為
//      null 即全部）經 `TCLCore.toScamMark` 轉成固定九欄 Mark，分批 ≤50 送
//      `POST /api/v1/marks/sync`。本機沒有「刪除」動作（解除是 state 變更），
//      `deletes` 恆為空陣列。
//   3. 拉：同一個 POST 帶位置參數（`marksCursor` 為 null 時不帶，依 §3.1 首輪
//      回填走 GET、`changes` 為 null）；`changes.marks` 逐筆 `fromScamMark` 後
//      以 `mergeScamEntry` 併進本機，`changes.deleted` 的每一筆以 `deletedAt`
//      與本機 `updatedAt` 比對——不晚於墓碑的硬刪，**晚於**墓碑的留在本機並於
//      下一輪重送（契約 §3.1 R2③「比墓碑舊不復活」的對稱面，伺服器會以較新
//      的版本撤銷墓碑）。`hasMore` 為 true 時同一輪續拉，`cursor` 恆寫回
//      `marksCursor`。
//   4. `evicted` 只寫 `marksEvicted`，本機一筆不動。
//
// 【rejectedIds 的跳過機制】`rejectedIds` 同時要求「不推進 marksPushedAt」與
// 「不重送」，單靠筆數擋不住下一輪重送——被拒條目的 updatedAt 仍大於水位線。
// 因此 `marksRejected` 是**映射**而非計數：key → 被拒當下的 updatedAt。推送時
// 該 key 的本機 updatedAt 與映射值相同就跳過（同一版重送只會再撞一次），使用者
// 之後真的改動了那一筆（updatedAt 前進）才再送一次。
//
// 【寫入紀律】本機 `scamBlocklist` 的讀改寫一律包進注入的 `writeChain`
// （background 的 historyWriteChain），寫前 normalize、寫後 cap，只有 background
// 寫得到這個鍵。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TCLCore = require('../tcl-core.js');
const { createMockSyncServer, MARKS_FREE_QUOTA, CHANGES_LIMIT } = require('./helpers/mock-sync-server.js');

function loadSync() {
  return require('../sync.js');
}

// Mark 固定九欄、Evidence 固定七欄（§3.1 R1）：鍵一律齊備，可空者寫 null。
const MARK_KEYS = ['key', 'state', 'dismissedAt', 'handle', 'displayName', 'source', 'evidence', 'addedAt', 'updatedAt'];
const EVIDENCE_KEYS = ['anchorPostUrl', 'threadUrl', 'signals', 'at', 'postedAt', 'rulesVersion', 'deviceId'];
// 本機專屬、永不上雲的三欄（D40）。
const LOCAL_ONLY_EVIDENCE_KEYS = ['snippet', 'anchorMatch', 'postUrl'];

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';
const POST_C = 'https://www.threads.com/@carol/post/CCCCCCCCCCC';
const POST_D = 'https://www.threads.com/@dave/post/DDDDDDDDDDD';
const THREAD_A = 'https://www.threads.com/@alice/post/TTTTTTTTTTT';
const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// ---- storage 替身（比照 test/sync.test.js 的時序紀律：一律跨 tick 結算） ----

function createSyncStorage(localSeed = {}, sessionSeed = {}) {
  const chainDepth = { value: 0 };
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
      clearedAt: null,
      lastError: null,
      marksCursor: null,
      marksPushedAt: null,
      marksEvicted: null,
      marksRejected: null,
    },
    over
  );
}

/**
 * 組一整套注入環境。`failPath` 讓故障綁在**路徑**上而不是「下一次請求」——
 * links 與 marks 在同一輪各發各的請求，用全域的 failNext 會綁不住是哪一條。
 */
function makeEnv(opts = {}) {
  const clock = { t: opts.startAt || T0 };
  const now = () => clock.t;
  const server = createMockSyncServer(Object.assign({ now }, opts.server));

  const localSeed = Object.assign({}, opts.local);
  if (opts.blocklist !== undefined) localSeed.scamBlocklist = opts.blocklist;
  if (opts.scamGuardEnabled !== undefined) localSeed.scamGuardEnabled = opts.scamGuardEnabled;
  if (opts.signedIn) {
    localSeed.syncAuth = { token: server.grantToken('tok-seeded') };
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

/** 讓所有 setTimeout(0) 排程的 storage 結算跑完。 */
async function settle(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 批量本機條目，供切批／回填／續拉等量的測試備料。 */
function bulkEntries(count, base, over = {}) {
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    const id = String(base + i);
    entries[id] = localEntry(
      Object.assign({ handle: `bulk${id}`, updatedAt: T0 - DAY + i, addedAt: T0 - 5 * DAY }, over)
    );
  }
  return entries;
}

/** 批量雲端 mark，供回填分頁／hasMore 續拉備料。 */
function bulkMarks(count, base) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const id = String(base + i);
    list.push({
      key: `threads:${id}`,
      state: 'active',
      handle: `bulk${id}`,
      source: 'auto',
      addedAt: T0 - 5 * DAY,
      updatedAt: T0 - 2 * DAY + i,
      evidence: [],
    });
  }
  return list;
}

// ============================================================================
// M1 — 推送
// ============================================================================

test('M1 推：首次全量上傳三筆 active ＋一筆 dismissed——九欄齊備、可空補 null、evidence 七欄、signals 空陣列', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      // 證據齊全：七欄都有值。
      1001: localEntry({
        handle: 'alice',
        displayName: 'Alice',
        updatedAt: T0 - 3 * DAY,
        evidence: [
          localEvidence({
            postUrl: POST_A,
            anchorPostUrl: POST_A,
            threadUrl: THREAD_A,
            anchorMatch: 'line.me/ti/g',
            signals: ['line', 'group'],
            postedAt: T0 - 4 * DAY,
            rulesVersion: 3,
            deviceId: DEVICE_ID,
            at: T0 - 3 * DAY,
          }),
        ],
      }),
      // 只有本機必填三欄：anchorPostUrl 以 postUrl 補位，其餘可空欄位送 null，
      // signals 缺席時送空陣列。
      1002: localEntry({
        handle: 'bob',
        source: 'manual',
        updatedAt: T0 - 2 * DAY,
        evidence: [localEvidence({ postUrl: POST_B, at: T0 - 2 * DAY })],
      }),
      // 完全沒有證據：evidence 是空陣列，不是 null。
      1003: localEntry({ handle: 'carol', updatedAt: T0 - DAY, evidence: [] }),
      1004: localEntry({
        handle: 'dave',
        state: 'dismissed',
        dismissedAt: T0 - 12 * 60 * 60 * 1000,
        updatedAt: T0 - 12 * 60 * 60 * 1000,
        evidence: [localEvidence({ postUrl: POST_D, at: T0 - 6 * DAY })],
      }),
    }),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.equal(posts.length, 1, '四筆在同一批送完（上限 50）');
  assert.deepEqual(posts[0].body.deletes, [], '本機沒有刪除動作，deletes 恆為空陣列');

  const sent = env.upsertsByKey();
  assert.deepEqual(
    Object.keys(sent).sort(),
    ['threads:1001', 'threads:1002', 'threads:1003', 'threads:1004'],
    'key 是 threads: ＋ 作者數字 id，四筆全上'
  );

  Object.keys(sent).forEach((key) => {
    assert.deepEqual(Object.keys(sent[key]).sort(), MARK_KEYS.slice().sort(), `${key} 必須是固定九欄`);
  });

  const a = sent['threads:1001'];
  assert.equal(a.state, 'active');
  assert.equal(a.dismissedAt, null, 'active 的 dismissedAt 一律 null（R2）');
  assert.equal(a.displayName, 'Alice');
  assert.equal(a.source, 'auto');
  assert.equal(a.addedAt, T0 - 5 * DAY);
  assert.equal(a.updatedAt, T0 - 3 * DAY);
  assert.equal(a.evidence.length, 1);
  assert.deepEqual(Object.keys(a.evidence[0]).sort(), EVIDENCE_KEYS.slice().sort(), 'evidence 必須是固定七欄');
  assert.deepEqual(a.evidence[0].signals, ['line', 'group']);
  assert.equal(a.evidence[0].threadUrl, THREAD_A);
  assert.equal(a.evidence[0].postedAt, T0 - 4 * DAY);
  assert.equal(a.evidence[0].rulesVersion, 3);
  assert.equal(a.evidence[0].deviceId, DEVICE_ID);

  const b = sent['threads:1002'];
  assert.equal(b.displayName, null, '本機缺席的 displayName 送 null，不省略鍵');
  assert.equal(b.source, 'manual');
  assert.equal(b.evidence[0].anchorPostUrl, POST_B, 'anchorPostUrl 缺席時以 postUrl 補位（§4.5）');
  assert.equal(b.evidence[0].threadUrl, null);
  assert.deepEqual(b.evidence[0].signals, [], 'signals 恆為陣列，沒有訊號時送空陣列（R2）');
  assert.equal(b.evidence[0].postedAt, null);
  assert.equal(b.evidence[0].rulesVersion, null);
  assert.equal(b.evidence[0].deviceId, null);

  assert.deepEqual(sent['threads:1003'].evidence, [], '沒有證據時送空陣列，不是 null');

  const d = sent['threads:1004'];
  assert.equal(d.state, 'dismissed');
  assert.equal(d.dismissedAt, T0 - 12 * 60 * 60 * 1000, 'dismissed 才帶 dismissedAt');

  // D40：貼文原文與使用者當時開的那一頁一律留在本機。
  Object.keys(sent).forEach((key) => {
    sent[key].evidence.forEach((item) => {
      LOCAL_ONLY_EVIDENCE_KEYS.forEach((field) => {
        assert.ok(!(field in item), `${key} 的 evidence 不得帶本機專屬欄位 ${field}`);
      });
    });
  });

  assert.equal(env.server.marks.count(), 4, '四筆都落到雲端');
  assert.equal(env.server.marks.byKey('threads:1004').state, 'dismissed');
});

test('M1 推：applied.upserts 才推進 syncState.marksPushedAt（被拒收的那筆不算）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 10 * DAY },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
      // 比墓碑舊 → 伺服器回 rejectedIds，不復活。
      1003: localEntry({ handle: 'carol', updatedAt: T0 - 6 * DAY }),
    }),
  });
  env.server.marks.seedTombstone('threads:1003', T0 - 3 * DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.equal(posts.length, 1);
  const body = posts[0].body;
  assert.equal(body.upserts.length, 3, '三筆的 updatedAt 都晚於水位線，全部送出');

  const state = env.storage.syncState();
  assert.equal(
    state.marksPushedAt,
    T0 - 4 * DAY,
    'marksPushedAt 推到 applied.upserts 裡最大的 updatedAt，被拒的 threads:1003 不算數'
  );
  assert.equal(env.server.marks.count(), 2, '被拒那筆沒有寫進雲端');
});

test('M1 推：rejectedIds 記進 syncState.marksRejected 映射，同一版不重送、改動後才再送', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 10 * DAY },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      // 刻意讓被拒那筆的 updatedAt 是全場最大：只靠水位線擋不住重送，必須靠
      // marksRejected 映射跳過（見檔頭）。
      1003: localEntry({ handle: 'carol', updatedAt: T0 - 4 * DAY }),
    }),
  });
  env.server.marks.seedTombstone('threads:1003', T0 - 3 * DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const rejected = env.storage.syncState().marksRejected;
  assert.ok(rejected && typeof rejected === 'object' && !Array.isArray(rejected), 'marksRejected 是映射不是計數');
  assert.equal(
    rejected['threads:1003'],
    T0 - 4 * DAY,
    '記下被拒當下的 updatedAt，之後用它判斷這一筆有沒有改動過'
  );

  // 第二輪：本機這一筆一個字都沒動，不得重送——重送只會每輪再撞一次。
  const afterFirst = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  const second = env.marksPosts().slice(afterFirst);
  assert.ok(second.length >= 1, '第二輪照樣要發一次往返（推空的也要拉）');
  const resent = second.some((req) => ((req.body && req.body.upserts) || []).some((m) => m.key === 'threads:1003'));
  assert.equal(resent, false, '同一版不重送');

  // 第三輪：使用者真的改動了那一筆（updatedAt 前進，且已晚於雲端墓碑），再送一次。
  env.storage.localData.scamBlocklist = blocklist({
    1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
    1003: localEntry({ handle: 'carol', updatedAt: T0 - 2 * DAY }),
  });
  const afterSecond = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  const third = env.marksPosts().slice(afterSecond);
  const sentAgain = third.some((req) => ((req.body && req.body.upserts) || []).some((m) => m.key === 'threads:1003'));
  assert.equal(sentAgain, true, 'updatedAt 變了代表兩端版本對得上了，要再送一次');
  assert.equal(env.server.marks.byKey('threads:1003').updatedAt, T0 - 2 * DAY, '新版蓋掉墓碑寫進雲端');
  assert.equal(
    env.storage.syncState().marksRejected['threads:1003'],
    undefined,
    '推送成功後把這一筆從被拒映射拿掉，映射不無限成長'
  );
});

test('M1 推：51 筆切成兩批（單批上限 50）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist(bulkEntries(51, 2001)),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.equal(posts.length, 2, '51 筆必須切成兩批');
  assert.equal(posts[0].body.upserts.length, 50, '第一批滿 50');
  assert.equal(posts[1].body.upserts.length, 1, '第二批 1 筆');
  posts.forEach((req) => {
    assert.ok(req.body.upserts.length <= 50, '任何一批都不得超過 50');
    assert.deepEqual(req.body.deletes, [], 'deletes 恆為空陣列');
  });
  assert.equal(env.server.marks.count(), 51, '兩批都落地');
});

test('M1 推：只送 updatedAt 晚於 marksPushedAt 的條目', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 2 * DAY },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 2 * DAY }),
      1003: localEntry({ handle: 'carol', updatedAt: T0 - DAY }),
    }),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.upsertsByKey()),
    ['threads:1003'],
    '等於水位線的不送（已推過），只有嚴格大於的才送'
  );
  assert.equal(env.storage.syncState().marksPushedAt, T0 - DAY);
});

test('M1 推：多批中途失敗時，marksPushedAt 不得越過沒送出去的條目', async () => {
  const TCLSync = loadSync();
  // 61 筆切成兩批（50 ＋ 11）。entries 的鍵是作者數字 id，與 updatedAt 的先後
  // 完全無關——這裡刻意讓 id 升冪對上 updatedAt 降冪。若切批照 Object.keys 的
  // 順序走，第一批裝的就是一整包**最新**的條目，水位線一推就越過第二批那些比
  // 較舊、卻根本還沒送出去的條目;第二批一斷線，它們就再也不會被推上去。
  const total = 61;
  const entries = {};
  for (let i = 0; i < total; i += 1) {
    const id = String(5001 + i);
    entries[id] = localEntry({
      handle: `bulk${id}`,
      updatedAt: T0 - DAY - i,
      addedAt: T0 - 5 * DAY,
    });
  }
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist(entries),
  });
  // 第一個 POST 照常（空的故障物件是佔位，被取走但不生效），第二個斷在網路上。
  env.failPath('/api/v1/marks/sync', {});
  env.failPath('/api/v1/marks/sync', { kind: 'network' });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().lastError, 'network_error', '第二批斷線，這一輪算失敗');
  const landed = {};
  env.server.marks.snapshot().forEach((mark) => {
    landed[mark.key] = true;
  });
  assert.equal(Object.keys(landed).length, 50, '只有第一批落地');

  // 水位線的意義是「這個時間點以前的都推上去了」。沒落地的條目一旦落在水位線
  // 底下，下一輪的 updatedAt > marksPushedAt 就再也選不到它們。
  const pushedAt = env.storage.syncState().marksPushedAt;
  const missing = Object.keys(entries).filter((id) => !landed[`threads:${id}`]);
  assert.equal(missing.length, 11, '11 筆沒送出去');
  missing.forEach((id) => {
    assert.ok(
      pushedAt === null || pushedAt < entries[id].updatedAt,
      `threads:${id} 沒上雲，水位線 ${pushedAt} 不得高到蓋過它的 ${entries[id].updatedAt}`
    );
  });

  // 下一輪要把它們補推上去，雲端才會齊 61 筆。
  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  const resent = {};
  env.marksPosts()
    .slice(before)
    .forEach((req) => {
      ((req.body && req.body.upserts) || []).forEach((mark) => {
        resent[mark.key] = true;
      });
    });
  missing.forEach((id) => {
    assert.ok(resent[`threads:${id}`], `threads:${id} 必須在下一輪補推`);
  });
  assert.equal(env.server.marks.count(), total, '兩輪走完雲端要齊 61 筆');
});

// ============================================================================
// M2 — 拉取與合併
// ============================================================================

test('M2 拉：changes.marks 合併——遠端較新覆蓋 state、evidence 取聯集留 3、本機 snippet 保留、本機沒有的直接新增', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    // 水位線都在本機條目之後：這一輪不推，只拉。
    syncState: { marksCursor: '0', marksPushedAt: T0 - 2 * DAY },
    blocklist: blocklist({
      1001: localEntry({
        handle: 'alice',
        state: 'active',
        updatedAt: T0 - 3 * DAY,
        evidence: [
          localEvidence({ postUrl: POST_A, anchorPostUrl: POST_A, snippet: '本機片段A', at: T0 - 5 * DAY }),
          localEvidence({ postUrl: POST_B, anchorPostUrl: POST_B, snippet: '本機片段B', at: T0 - 6 * DAY }),
        ],
      }),
    }),
  });
  env.server.marks.seed([
    {
      key: 'threads:1001',
      state: 'dismissed',
      dismissedAt: T0 - DAY,
      handle: 'alice',
      displayName: '遠端名字',
      source: 'auto',
      addedAt: T0 - 5 * DAY,
      updatedAt: T0 - DAY,
      evidence: [
        { anchorPostUrl: POST_C, at: T0 - 4 * DAY, signals: ['line'] },
        { anchorPostUrl: POST_A, at: T0 - 5 * DAY },
      ],
    },
    {
      key: 'threads:2001',
      state: 'active',
      handle: 'erin',
      source: 'manual',
      addedAt: T0 - 2 * DAY,
      updatedAt: T0 - 2 * DAY,
      evidence: [],
    },
  ]);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const entries = env.storage.entries();
  const merged = entries['1001'];
  assert.ok(merged, 'threads:1001 讀回時剝掉前綴，落在 entries["1001"]');
  assert.equal(merged.state, 'dismissed', '遠端 updatedAt 較大，state 由遠端勝出（LWW）');
  assert.equal(merged.dismissedAt, T0 - DAY);
  assert.equal(merged.updatedAt, T0 - DAY);
  assert.equal(merged.displayName, '遠端名字');

  assert.equal(merged.evidence.length, 3, 'evidence 取聯集後上限 3 筆');
  assert.deepEqual(
    merged.evidence.map((item) => item.anchorPostUrl),
    [POST_C, POST_A, POST_B],
    '依 at 降冪排列，同一錨點只算一筆'
  );
  const kept = merged.evidence.find((item) => item.anchorPostUrl === POST_A);
  assert.equal(kept.snippet, '本機片段A', '本機專屬的 snippet 不因雲端沒有這一欄而消失');

  const added = entries['2001'];
  assert.ok(added, '本機沒有的條目直接新增');
  assert.equal(added.handle, 'erin');
  assert.equal(added.source, 'manual');
  assert.deepEqual(added.evidence, [], '雲端空陣列讀回後仍是空陣列');
  assert.equal('dismissedAt' in added, false, '雲端 null 的欄位讀回時整個鍵拿掉，本機不留一排 null');

  const stored = env.storage.blocklist();
  assert.equal(stored.version, 2);
  assert.equal(stored.handleIndex.erin, '2001', 'handleIndex 由 entries 重建');
});

test('M2 拉：本機不晚於墓碑 deletedAt 時硬刪（伺服器墓碑是帳號層級刪除）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 2 * DAY },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }),
      // 墓碑（T0-DAY）晚於本機這一筆（T0-3DAY）：使用者刪掉之後沒再動過它。
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 3 * DAY }),
    }),
  });
  env.server.marks.seedTombstone('threads:1002', T0 - DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const entries = env.storage.entries();
  assert.deepEqual(Object.keys(entries), ['1001'], '墓碑的 key 在本機是硬刪，不是留一個本機墓碑');
  assert.equal(env.storage.blocklist().handleIndex.bob, undefined, 'handleIndex 不得留下孤兒鍵');
});

test('M2 拉：hasMore 為 true 時同一輪續拉，不等下一個 alarm', async () => {
  const TCLSync = loadSync();
  const total = CHANGES_LIMIT + 1;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.seed(bulkMarks(total, 3001));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(40);

  assert.ok(env.marksPosts().length >= 2, `單頁 ${CHANGES_LIMIT} 筆，hasMore 必須在同一輪續拉`);
  assert.equal(Object.keys(env.storage.entries()).length, total, '續拉的那一頁也要落地');
  const last = env.marksPosts()[env.marksPosts().length - 1];
  assert.ok(
    (last.body && (last.body.cursor || last.body.since)) != null,
    '續拉必須帶上一次回應的 cursor 當續傳位置'
  );
});

test('M2 拉：changes 為 null 時本機一筆不動，cursor 仍恆寫回 syncState.marksCursor（舊後端無 cursor）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    // marksCursor 為 null：依 §3.1 首輪回填走 GET，POST 不帶位置參數，changes 為 null。
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }) }),
  });
  // 舊後端（R4 之前）的 GET 不回頂層 cursor，回填到底也建立不出增量游標，首輪
  // POST 因此不帶 since。這條路徑要一直留著：插件不能因為少一欄就掛掉。
  env.server.marks.listCursor(false);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.equal(posts.length, 1);
  const body = posts[0].body || {};
  assert.ok(
    body.since === undefined || body.since === null || body.since === '',
    '首輪回填走 GET，POST 不帶 since，伺服器才會回 changes: null'
  );

  const state = env.storage.syncState();
  assert.equal(typeof state.marksCursor, 'string', 'changes 為 null 也要把 cursor 寫回');
  assert.ok(state.marksCursor.length > 0);

  const entries = env.storage.entries();
  assert.deepEqual(Object.keys(entries), ['1001'], 'changes 為 null 時本機不動');
  assert.equal(entries['1001'].updatedAt, T0 - 3 * DAY);
});

test('M2 拉：本機 updatedAt 晚於墓碑 deletedAt 時留著，下一輪重送撤銷雲端墓碑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    // 水位線在兩筆本機條目之後：這一輪不推，墓碑才進得了 changes。
    syncState: { marksCursor: '0', marksPushedAt: T0 },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }),
      // 別台裝置在 T0-2DAY 刪掉了 bob，但使用者在那之後（T0-DAY）又在這台動過
      // 同一筆。刪除比較舊，不該吃掉比較新的那份改動。
      1002: localEntry({ handle: 'bob', updatedAt: T0 - DAY }),
    }),
  });
  env.server.marks.seedTombstone('threads:1002', T0 - 2 * DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.storage.entries()).sort(),
    ['1001', '1002'],
    '比墓碑新的條目留在本機'
  );
  assert.equal(
    env.storage.entries()['1002'].updatedAt,
    T0 - DAY,
    '留下來的是本機那一份，不是被墓碑洗過的空殼'
  );

  // 留著卻推不出去等於兩端永遠不一致：水位線要讓回去，下一輪才選得到它。
  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  const resent = {};
  env.marksPosts()
    .slice(before)
    .forEach((req) => {
      ((req.body && req.body.upserts) || []).forEach((mark) => {
        resent[mark.key] = true;
      });
    });
  assert.ok(resent['threads:1002'], '下一輪必須重送這一筆');
  assert.ok(
    env.server.marks.byKey('threads:1002'),
    '較新的版本撤銷墓碑，重新寫回雲端（契約 §3.1 R2③）'
  );
  assert.equal(env.server.marks.tombstoneCount(), 0, '墓碑被撤銷');
});

test('M2 拉：讓位過的水位線不得被同一輪後面那批的 ack 推回去', async () => {
  const TCLSync = loadSync();
  // 墓碑跟著第一批的回應回來，讓位也發生在第一批；但水位線是整輪共用的一格，
  // 第二批的 ack 照樣會把它推到該批的最大 updatedAt，第一批讓出來的空間就這麼
  // 被蓋掉——保留下來的條目下一輪照樣選不到，等於沒保留。
  const entries = {};
  // 51 筆待推 → 切成兩批（50 ＋ 1）。
  for (let i = 0; i < 51; i += 1) {
    const id = String(7001 + i);
    entries[id] = localEntry({ handle: `bulk${id}`, updatedAt: T0 - 5 * DAY + i, addedAt: T0 - 9 * DAY });
  }
  // 這一筆早就推過（updatedAt 在水位線底下），這一輪不會進推送清單；別台裝置
  // 更早以前刪掉它，但本機在那之後又動過，因此墓碑守衛要留著它。
  entries['9001'] = localEntry({ handle: 'carol', updatedAt: T0 - 20 * DAY, addedAt: T0 - 40 * DAY });

  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 10 * DAY },
    blocklist: blocklist(entries),
  });
  env.server.marks.seedTombstone('threads:9001', T0 - 30 * DAY);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(60);

  assert.equal(env.marksPosts().length, 2, '51 筆切成兩批');
  assert.ok(env.storage.entries()['9001'], '比墓碑新，留在本機');

  const pushedAt = env.storage.syncState().marksPushedAt;
  assert.ok(
    pushedAt === null || pushedAt < T0 - 20 * DAY,
    `整輪結束後水位線 ${pushedAt} 必須留在 threads:9001 的 ${T0 - 20 * DAY} 之下，否則它永遠推不出去`
  );

  // 下一輪要把它送上去，伺服器才會以較新的版本撤銷墓碑。
  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle(60);

  const resent = {};
  env.marksPosts()
    .slice(before)
    .forEach((req) => {
      ((req.body && req.body.upserts) || []).forEach((mark) => {
        resent[mark.key] = true;
      });
    });
  assert.ok(resent['threads:9001'], '下一輪必須重送這一筆');
  assert.ok(env.server.marks.byKey('threads:9001'), '較新的版本撤銷墓碑，寫回雲端');
  assert.equal(env.server.marks.tombstoneCount(), 0, '墓碑被撤銷');
});

test('M2 拉：讓位要當場落地——同輪後面那批斷線時，水位線不得回到進這一輪之前的舊值', async () => {
  const TCLSync = loadSync();
  // 讓位只夾得住「這一輪推上去的」水位線，夾不到**進這一輪之前就已經存在**的
  // 舊值——留存的條目本來就在它底下，這正是它沒被推上去的原因。整輪尾端才統一
  // 套用的話，中途一斷線整條鏈就 reject，那一步根本輪不到跑，runSync 的失敗路
  // 徑照樣把舊水位線落盤，留存的條目下一輪依舊選不到、墓碑永遠撤不掉。
  const entries = {};
  for (let i = 0; i < 51; i += 1) {
    const id = String(7001 + i);
    entries[id] = localEntry({ handle: `bulk${id}`, updatedAt: T0 - 5 * DAY + i, addedAt: T0 - 9 * DAY });
  }
  entries['9001'] = localEntry({ handle: 'carol', updatedAt: T0 - 20 * DAY, addedAt: T0 - 40 * DAY });

  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 10 * DAY },
    blocklist: blocklist(entries),
  });
  env.server.marks.seedTombstone('threads:9001', T0 - 30 * DAY);
  // 第一批照常（空的故障物件是佔位），第二批斷在網路上。
  env.failPath('/api/v1/marks/sync', {});
  env.failPath('/api/v1/marks/sync', { kind: 'network' });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(60);

  assert.equal(env.storage.syncState().lastError, 'network_error', '第二批斷線，這一輪算失敗');
  assert.ok(env.storage.entries()['9001'], '比墓碑新，留在本機');

  const pushedAt = env.storage.syncState().marksPushedAt;
  assert.ok(
    pushedAt === null || pushedAt < T0 - 20 * DAY,
    `落盤的水位線 ${pushedAt} 必須已經讓到 threads:9001 的 ${T0 - 20 * DAY} 之下`
  );

  // 下一輪照樣要把它送上去。
  const before = env.marksPosts().length;
  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle(60);

  const resent = {};
  env.marksPosts()
    .slice(before)
    .forEach((req) => {
      ((req.body && req.body.upserts) || []).forEach((mark) => {
        resent[mark.key] = true;
      });
    });
  assert.ok(resent['threads:9001'], '下一輪必須重送這一筆');
  assert.equal(env.server.marks.tombstoneCount(), 0, '較新的版本撤銷墓碑');
});

// ============================================================================
// M3 — evicted
// ============================================================================

test('M3 evicted：只記 syncState.marksEvicted 筆數，本機一筆都不刪', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
      1003: localEntry({ handle: 'carol', updatedAt: T0 - 3 * DAY }),
    }),
  });
  // free 方案、配額壓到 2：這一輪上傳 3 筆，雲端淘汰最舊的 1 筆且不寫墓碑。
  env.server.marks.setPlan('free').setQuota(2);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().marksEvicted, 1, 'evicted 是筆數，落在 syncState.marksEvicted');
  assert.deepEqual(
    Object.keys(env.storage.entries()).sort(),
    ['1001', '1002', '1003'],
    'evicted 只是提示，不得據以刪除本機條目'
  );
  assert.equal(env.server.marks.tombstoneCount(), 0, '淘汰不寫墓碑（寫了其他裝置會跟著刪）');
});

test('M3 evicted：getState() 與廣播都帶回 marksEvicted 筆數，UI 才出得了額度提示', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
      1003: localEntry({ handle: 'carol', updatedAt: T0 - 3 * DAY }),
    }),
  });
  env.server.marks.setPlan('free').setQuota(2);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  // 水位線落在 storage 只夠引擎自己用；提示那張卡片是 C 車道畫的，它拿得到的
  // 只有 getState() 的回傳與 sync.stateChanged 的 state。
  const state = await engine.getState();
  assert.equal(state.marksEvicted, 1, 'getState 必須帶回淘汰筆數，否則提示沒有數字可填');
  assert.equal(state.marksPushedAt, T0 - 3 * DAY, '四格一律原樣帶出，不只帶 evicted 那一格');
  assert.equal(
    state.marksCursor,
    env.storage.syncState().marksCursor,
    'marksCursor 與落盤的同一個值'
  );
  assert.equal(state.marksRejected, null, '這一輪沒有被拒條目，維持預設 null');

  assert.equal(env.lastState().marksEvicted, 1, 'sync.stateChanged 同樣帶四格');
});

// ============================================================================
// M4 — 開關 A（scamGuardEnabled）
// ============================================================================

test('M4 開關 A：scamGuardEnabled 為 false 時 marks 通道零請求，links 通道照常', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: false,
    syncState: { marksCursor: null, marksPushedAt: null },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
    local: {
      history: [
        {
          id: 'loc-a',
          url: POST_A,
          postKey: TCLCore.postKeyOf(POST_A),
          original: POST_A,
          kind: 'strip',
          at: T0 - 60_000,
          receivedAt: T0 - 60_000,
          seen: [{ at: T0 - 60_000, kind: 'strip' }],
          dirty: true,
          serverUpdatedAt: null,
          deletedAt: null,
        },
      ],
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(env.marksPosts(), [], '關閉時不推');
  assert.deepEqual(env.marksGets(), [], '關閉時不拉、不回填');
  assert.ok(env.linkPosts().length >= 1, 'links 通道不受影響');
  assert.equal(env.server.linkCount(), 1, 'links 照常上雲');
  const state = env.storage.syncState();
  assert.equal(state.marksCursor, null, '關閉期間水位線不動');
  assert.equal(state.marksPushedAt, null);
});

test('M4 開關 A：重新開啟後下一輪照常，且推上關閉期間的 updatedAt 變更', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: false,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 5 * DAY },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 4 * DAY }) }),
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();
  assert.deepEqual(env.marksPosts(), [], '關閉時整條通道跳過');

  // 關閉期間使用者又掛了一筆警示（updatedAt 前進）。
  env.storage.localData.scamBlocklist = blocklist({
    1001: localEntry({ handle: 'alice', updatedAt: T0 - 4 * DAY }),
    1002: localEntry({ handle: 'bob', updatedAt: T0 - 3 * DAY }),
  });
  env.storage.localData.scamGuardEnabled = true;

  env.advance(6 * 60_000);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.upsertsByKey()).sort(),
    ['threads:1001', 'threads:1002'],
    '重新開啟後，關閉期間的變更一併補推'
  );
  assert.equal(env.storage.syncState().marksPushedAt, T0 - 3 * DAY);
});

// ============================================================================
// M5 — 首次登入全量與回填
// ============================================================================

test('M5 首次登入：全量上傳所有 entries，免費額度 1,000 的淘汰以 marksEvicted 提示', async () => {
  const TCLSync = loadSync();
  assert.equal(MARKS_FREE_QUOTA, 1000, '免費方案警示名單額度沿用 links 的 1,000 語意');

  const env = makeEnv({
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
      1003: localEntry({ handle: 'carol', updatedAt: T0 - 3 * DAY }),
    }),
  });
  env.server.marks.setPlan('free').setQuota(2);

  const engine = TCLSync.create(env.deps);
  await engine.signIn();
  await settle(40);

  assert.deepEqual(
    Object.keys(env.upsertsByKey()).sort(),
    ['threads:1001', 'threads:1002', 'threads:1003'],
    '首次登入把本機 entries 全量上傳'
  );
  assert.equal(env.storage.syncState().marksEvicted, 1, '超出額度的淘汰筆數記進 marksEvicted 供 UI 提示');
  assert.equal(Object.keys(env.storage.entries()).length, 3, '額度淘汰不動本機');
});

test('M5 回填：marksCursor 為 null 時走 GET /api/v1/marks 分頁（nextCursor）並合併', async () => {
  const TCLSync = loadSync();
  const total = 120;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.seed(bulkMarks(total, 4001));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(40);

  const gets = env.marksGets();
  assert.ok(gets.length >= 2, `單頁上限 100，${total} 筆必須分頁回填`);
  gets.slice(1).forEach((req) => {
    assert.ok(req.search.indexOf('cursor=') !== -1, '續頁必須帶上一頁回應的 nextCursor');
  });
  assert.equal(Object.keys(env.storage.entries()).length, total, '回填的每一頁都要合併進本機');
  assert.ok(env.storage.entries()['4001'], '回填的條目剝掉 threads: 前綴後落在 entries');
  assert.equal(typeof env.storage.syncState().marksCursor, 'string', '回填完照樣把 POST 回應的 cursor 寫回');
});

test('M5 回填：一輪拉不完時不寫 cursor、不推，留待下一輪續填', async () => {
  const TCLSync = loadSync();
  // 單頁上限 100 × 一輪的續頁保險 20 = 2,000 筆；多一筆就拉不完。回填沒到底
  // 卻讓 POST 把 marksCursor 寫下去的話，沒拉到的那些永遠落在增量水位線之前，
  // 從此回填不到——靜默漏資料比慢一輪嚴重得多。
  const total = 2001;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.seed(bulkMarks(total, 6001));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(200);

  assert.equal(env.marksGets().length, 20, '一輪最多 20 頁');
  assert.deepEqual(env.marksPosts(), [], '回填沒到底就整輪收手，連推都不推');
  assert.equal(
    env.storage.syncState().marksCursor,
    null,
    'marksCursor 留在 null，下一輪才會接著回填'
  );
  assert.equal(Object.keys(env.storage.entries()).length, 2000, '拉到的那 2,000 筆照樣落地');
  // 下一輪接著回填是 marksCursor 仍為 null 的結構保證（runMarksRound 以它決定走
  // 不走回填），再跑一輪只是把這 2,000 筆重合併一次，不值那幾秒。
});

// ============================================================================
// M6 — 錯誤語意（沿用 links）
// ============================================================================

test('M6 錯誤：marks 通道 401 走與 links 同一條 session_expired 處理', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
  });
  env.failPath('/api/v1/marks/sync', { status: 401 });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncAuth().token, null, '401 清掉本地 token');
  assert.equal(env.storage.syncState().lastError, 'session_expired', '與 links 記同一個錯誤碼');
  assert.equal(env.lastState().status, 'signed_out', '廣播轉回未登入態');
  assert.ok(
    env.alarms.calls.some((c) => c.op === 'clear' && c.name === TCLSync.ALARM_NAME),
    '失效處理要停掉週期 alarm'
  );
});

test('M6 錯誤：marks 通道 429 進退避排程，Retry-After 夾在上限內', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
  });
  env.failPath('/api/v1/marks/sync', { status: 429, retryAfter: 5 });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().lastError, 'rate_limited');
  const created = env.alarms.lastCreate();
  assert.ok(created, '429 之後要排下一次重試');
  assert.equal(created.name, TCLSync.ALARM_NAME, '退避沿用 links 的同一支 alarm');
  assert.equal(created.info.when, T0 + 5000, 'Retry-After 5 秒');
});

test('M6 錯誤：網路錯誤不動 marksCursor 與 marksPushedAt', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: 'c-before', marksPushedAt: T0 - 5 * DAY },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
  });
  env.failPath('/api/v1/marks/sync', { kind: 'network' });

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const state = env.storage.syncState();
  assert.equal(state.lastError, 'network_error');
  assert.equal(state.marksCursor, 'c-before', '網路錯誤不清水位線，下一輪重拉同一頁');
  assert.equal(state.marksPushedAt, T0 - 5 * DAY, '推送水位線同樣不動');
});

// ============================================================================
// M7 — 與 links 共存
// ============================================================================

test('M7 共存：marks 與 links 在同一輪各自往返，scamBlocklist 的寫入全走序列寫入鏈', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: T0 - 2 * DAY },
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }) }),
    local: {
      history: [
        {
          id: 'loc-a',
          url: POST_A,
          postKey: TCLCore.postKeyOf(POST_A),
          original: POST_A,
          kind: 'strip',
          at: T0 - 60_000,
          receivedAt: T0 - 60_000,
          seen: [{ at: T0 - 60_000, kind: 'strip' }],
          dirty: true,
          serverUpdatedAt: null,
          deletedAt: null,
        },
      ],
    },
  });
  env.server.marks.seed([
    {
      key: 'threads:2001',
      state: 'active',
      handle: 'erin',
      source: 'auto',
      addedAt: T0 - 2 * DAY,
      updatedAt: T0 - 2 * DAY,
      evidence: [],
    },
  ]);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.ok(env.linkPosts().length >= 1, 'links 通道照常往返');
  assert.ok(env.marksPosts().length >= 1, 'marks 通道同一輪跟著往返');
  assert.equal(env.server.linkCount(), 1, 'links 的待推紀錄照樣上雲');
  assert.ok(env.storage.entries()['2001'], 'marks 的增量照樣落地');

  const blocklistWrites = env.storage.writesTo('scamBlocklist');
  assert.ok(blocklistWrites.length >= 1, 'marks 合併必須寫回 scamBlocklist');
  blocklistWrites.forEach((w) => {
    assert.equal(w.inChain, true, 'scamBlocklist 的讀改寫一律包進注入的 writeChain');
  });
  assert.equal(env.storage.syncState().lastError, null, '兩條通道都成功時不記錯誤');
});

// ============================================================================
// R3 — 刪除雲端資料涵蓋警示名單（安全審查 2026-09-22，後端契約 R3 ＋ PM 裁決）
// ----------------------------------------------------------------------------
// 既有的「刪除雲端資料」只打 `DELETE /api/v1/links`，警示名單整份留在後端、
// marks 的四格水位線一格不動。R3 把 links 的 `clearedAt`／自清守衛（D19）一比
// 一鏡射到 marks：
//
//   chrome.storage.local.syncMarksClearGuard = {
//     userId: string | null,        // 發動清空的那個帳號
//     clearedAt: number | null,     // 伺服器寫下的水位線；缺席時 null（待定）
//     pending?: true,               // 待定：等下一次 changes.clearedAt 認領
//     sentAt?: number,              // 診斷用，不參與比較
//   }
//
// 【為什麼是獨立 storage key，不進 syncState】D19 寫得很白：登出與 session 過
// 期會把 `syncState` 整包重設，守衛放進去撐不過那一輪，於是「刪雲端 → 登出 →
// 再登入」會把本機資料全滅（links 那邊是真機實證）。marks 這一側完全相同。
//
// 1. `deleteCloud()` 在 `DELETE /api/v1/links` 之後續打 `DELETE /api/v1/marks`，
//    成功後把回應的 `clearedAt` 寫進 `syncMarksClearGuard`，並把
//    `marksCursor`／`marksPushedAt`／`marksRejected`／`marksEvicted` 四格重設成
//    null。本機名單比照 D19 對本機紀錄的做法**留在這台裝置**——伺服器對
//    `updatedAt <= clearedAt` 的 upsert 一律拒收，留著也推不回去。
// 2. 下行：`changes.clearedAt` 是有限正數且守衛判 `purge` 時，照 links 的判準
//    硬刪（`updatedAt <= clearedAt` 清掉、`>` 的留著），四格重設，下一輪
//    `marksCursor` 為 null 重新回填；同一個水位線不得每一輪重清一次。
//    `changes` 為 null（請求沒帶位置參數）、`clearedAt` 為 null 或 0 一律不得
//    當成清空。
// 3. 守衛四態沿用 links 的 `clearGuardVerdict`：`purge`（沒有守衛／別的帳號／
//    水位線比守衛新）、`skip`（已認領且涵蓋這個水位線）、`claim`（待定守衛，
//    這就是自己那一次）、`invalid`（守衛讀不懂 → 本輪不刪、記錯誤碼廣播、重置
//    成待定）。守衛的更新一律排在名單落盤之後。
// 7. 縱深：`marksEvicted` 夾上限；一輪完整成功且本輪 `evicted === 0` 時歸零。
// 11. 縱深：handle 不合 `^[A-Za-z0-9._]{1,80}$` 的條目不進推送批——送上去必被
//    伺服器退回 rejectedIds，白佔一次往返又把 key 記進 marksRejected。
// ============================================================================

const API_BASE = 'https://api.metalinkclearer.workers.dev';
const MARKS_CLEAR_GUARD_KEY = 'syncMarksClearGuard';
const MARKS_EVICTED_MAX = 1000000;

/**
 * 直接對假後端打一次 `DELETE /api/v1/marks`（模擬別台裝置清空雲端），回傳水位
 * 線。端點未實作時先在這裡斷言失敗，紅燈才不會落在後面一路拿 undefined 比較的
 * 假綠燈上。
 */
async function clearCloudMarks(env) {
  const res = await env.server.fetch(API_BASE + '/api/v1/marks', {
    method: 'DELETE',
    headers: { authorization: 'Bearer tok-seeded' },
  });
  assert.equal(res.status, 200, 'DELETE /api/v1/marks 應回 200（mock 端點見 test/mock-marks-server.test.js）');
  const body = await res.json();
  assert.equal(typeof body.clearedAt, 'number', 'DELETE /api/v1/marks 應回 clearedAt 毫秒');
  return body.clearedAt;
}

function marksDeletes(env) {
  return env.server.requestsTo('/api/v1/marks', 'DELETE');
}

/** 本機的 marks 自清守衛（還沒實作時是 undefined）。 */
function marksGuard(env) {
  return env.storage.localData[MARKS_CLEAR_GUARD_KEY];
}

function requireMarksGuard(env) {
  const guard = marksGuard(env);
  assert.ok(
    guard && typeof guard === 'object',
    `本機應有 ${MARKS_CLEAR_GUARD_KEY}（D19 的自清守衛，刻意不放 syncState——登出會把它整包重設）`
  );
  return guard;
}

/** `DELETE /api/v1/marks` 的回應剝掉 clearedAt，模擬後端沒帶那一欄。 */
function depsWithoutMarksDeleteClearedAt(env) {
  const inner = env.deps.fetch;
  return Object.assign({}, env.deps, {
    fetch(url, init) {
      return Promise.resolve(inner(url, init)).then((res) => {
        const method = ((init && init.method) || 'GET').toUpperCase();
        if (method !== 'DELETE' || new URL(String(url)).pathname !== '/api/v1/marks') return res;
        return { status: res.status, ok: res.ok, headers: res.headers, json: () => Promise.resolve({ ok: true }) };
      });
    },
  });
}

/** 把 `DELETE /api/v1/marks` 回應裡的 `clearedAt` 改寫成指定值（後端降級）。 */
function depsWithMarksDeleteClearedAt(env, value) {
  const inner = env.deps.fetch;
  return Object.assign({}, env.deps, {
    fetch(url, init) {
      return Promise.resolve(inner(url, init)).then((res) => {
        const method = ((init && init.method) || 'GET').toUpperCase();
        if (method !== 'DELETE' || new URL(String(url)).pathname !== '/api/v1/marks') return res;
        return {
          status: res.status,
          ok: res.ok,
          headers: res.headers,
          json: () => Promise.resolve({ ok: true, clearedAt: value }),
        };
      });
    },
  });
}

/** 把 `POST /api/v1/marks/sync` 回應裡的 `changes.clearedAt` 改寫成指定值。 */
function depsWithMarksClearedAt(env, value) {
  const inner = env.deps.fetch;
  return Object.assign({}, env.deps, {
    fetch(url, init) {
      return Promise.resolve(inner(url, init)).then((res) => {
        if (new URL(String(url)).pathname !== '/api/v1/marks/sync') return res;
        return {
          status: res.status,
          ok: res.ok,
          headers: res.headers,
          json: () =>
            Promise.resolve(res.json()).then((body) => {
              if (body && body.changes) body.changes.clearedAt = value;
              return body;
            }),
        };
      });
    },
  });
}

// ---- R3-1 deleteCloud ----

test('R3-1 deleteCloud：links 刪完接著打 DELETE /api/v1/marks，水位線寫進 syncMarksClearGuard、四格重設', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }) }),
    syncState: {
      marksCursor: 'cursor-before-delete',
      marksPushedAt: T0 - 2 * DAY,
      marksEvicted: 7,
      marksRejected: { 'threads:1001': T0 - 3 * DAY },
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle();

  assert.equal(env.server.requestsTo('/api/v1/links', 'DELETE').length, 1, '前置條件:links 照舊刪');
  assert.equal(marksDeletes(env).length, 1, '刪除雲端資料必須涵蓋警示名單，否則名單整份留在後端');
  assert.equal(marksDeletes(env)[0].headers.authorization, 'Bearer tok-seeded');
  const last = env.server.lastRequest();
  assert.equal(last.path, '/api/v1/marks', 'marks 的刪除排在 links 之後（前一步失敗時不吞掉）');
  assert.equal(last.method, 'DELETE');

  assert.equal(typeof env.server.marks.clearedAt, 'function', '前置條件:mock 應有 marks.clearedAt() 輔助 API');
  const guard = requireMarksGuard(env);
  assert.equal(guard.userId, 'user-abc', '守衛認帳號:換人之後舊守衛不得沿用');
  assert.equal(guard.clearedAt, env.server.marks.clearedAt(), '記下伺服器寫的水位線，之後拉回自己這一次不得清本機');

  const state = env.storage.syncState();
  assert.equal(state.marksCursor, null, '舊游標對清空後的雲端沒有意義，歸零重拉');
  assert.equal(state.marksPushedAt, null);
  assert.equal(state.marksRejected, null);
  assert.equal(state.marksEvicted, null);
});

test('R3-1 deleteCloud：守衛不得放進 syncState（登出會把它整包重設）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice' }) }),
    syncState: { marksCursor: 'cursor-before-delete' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle();

  const state = env.storage.syncState();
  assert.equal(
    Object.prototype.hasOwnProperty.call(state, 'marksClearedAt'),
    false,
    'syncState 在登出／session 過期時整包重設，水位線放進去撐不過那一輪（D19）'
  );
});

test('R3-1 deleteCloud：本機警示名單留在這台裝置（比照 D19 對本機紀錄的處理）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 2 * DAY }),
    }),
    syncState: { marksCursor: 'cursor-before-delete' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle();

  assert.deepEqual(
    Object.keys(env.storage.entries()).sort(),
    ['1001', '1002'],
    '「刪雲端但留本機」的語意對警示名單同樣成立（D19）'
  );
});

test('R3-1 deleteCloud：marks 刪除失敗時不得寫下守衛', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice' }) }),
    syncState: { marksCursor: 'cursor-before-delete' },
  });
  env.failPath('/api/v1/marks', { status: 500, body: { error: 'server_error' } });
  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle();

  assert.equal(marksDeletes(env).length, 1, '前置條件:確實打了一次');
  const guard = marksGuard(env);
  assert.ok(
    guard === undefined || guard === null,
    '沒刪成功就記守衛，等於把「已清空」寫死在本機，之後別台裝置真的清空時反而不刪'
  );
});

// ---- R3-2 下行水位線 ----

test('R3-2 下行：別台裝置清空（purge）→ 不晚於水位線的本機條目清掉、晚於的留著，四格重設', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 + 5 * DAY }),
    }),
    // marksCursor 非 null:跳過回填，這一輪直接走增量（POST 帶 since）。
    // marksPushedAt 壓在兩筆之上，這一輪沒有要推的東西，只拉。
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY, marksEvicted: 3 },
  });
  const cleared = await clearCloudMarks(env);
  assert.ok(T0 - 5 * DAY < cleared && cleared < T0 + 5 * DAY, '前置條件:水位線夾在兩筆本機條目之間');

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.storage.entries()),
    ['1002'],
    '沒有守衛＝別台裝置清的:不晚於水位線的本機條目硬刪，晚於的留著（比照 links 的 eventTimeOf > clearedAt）'
  );
  const state = env.storage.syncState();
  assert.equal(state.marksCursor, null, '游標歸零，下一輪重新回填');
  assert.equal(state.marksPushedAt, null);
  assert.equal(state.marksRejected, null);
  assert.equal(state.marksEvicted, null);
});

test('R3-2 下行：清空後的下一輪重新回填（marksCursor 為 null → 走 GET /api/v1/marks）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY },
  });
  await clearCloudMarks(env);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();
  const backfillsAfterFirst = env.marksGets().length;

  env.advance(10 * 60000);
  await engine.syncNow();
  await settle();

  assert.ok(
    env.marksGets().length > backfillsAfterFirst,
    '清空後游標歸零，下一輪必須重走回填，否則沒拉到的雲端警示永遠落在水位線之前'
  );
});

test('R3-2 下行：同一個 clearedAt 不得每一輪重清一次（游標反覆歸零＝永遠在回填）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY },
  });
  await clearCloudMarks(env);
  const engine = TCLSync.create(env.deps);

  // 第一輪:拉到水位線，清本機、四格重設。
  await engine.syncNow();
  await settle();
  // 第二輪:marksCursor 為 null，走回填 ＋ 一次不帶位置參數的 POST（changes 為
  // null），游標重新寫下。
  env.advance(10 * 60000);
  await engine.syncNow();
  await settle();
  assert.notEqual(env.storage.syncState().marksCursor, null, '前置條件:第二輪把游標領回來了');
  // 第三輪:帶 since，伺服器照樣回同一個 clearedAt——這一次不得再判成新的清空。
  env.advance(10 * 60000);
  await engine.syncNow();
  await settle();

  assert.notEqual(
    env.storage.syncState().marksCursor,
    null,
    '同一個水位線要記下來（守衛認領），否則游標每兩輪歸零一次，通道永遠停在回填'
  );
});

test('R3-2 下行：changes 為 null（請求沒帶位置參數）不得被當成清空（舊後端無 cursor）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    // marksCursor 為 null:首輪走回填 GET，接著那次 POST 不帶位置參數，
    // 依契約 changes 整個是 null——沒有 clearedAt 可讀，一律不得推斷成清空。
    syncState: { marksCursor: null },
  });
  await clearCloudMarks(env);
  // 舊後端（R4 之前）：GET 不回頂層 cursor，回填到底也建立不出增量游標。新後端
  // 這一輪就會拉到 changes.clearedAt 而依 D41 判 purge，那是另一條既有路徑。
  env.server.marks.listCursor(false);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.ok(posts.length >= 1, '前置條件:回填後至少發一次 POST');
  assert.equal(posts[0].body.since, undefined, '前置條件:首輪 POST 不帶位置參數');
  assert.deepEqual(Object.keys(env.storage.entries()), ['1001'], 'changes 為 null 時本機名單一筆不動');
});

test('R3-2 下行：changes.clearedAt 為 null 時一格不動', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY, marksEvicted: 3 },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const posts = env.marksPosts();
  assert.ok(posts.length >= 1, '前置條件:這一輪確實發了 POST');
  assert.deepEqual(Object.keys(env.storage.entries()), ['1001'], '雲端沒清空過，本機名單不動');
  assert.notEqual(env.storage.syncState().marksCursor, null, '四格不得因為一個 null 的 clearedAt 被重設');
});

test('R3-2 下行：changes.clearedAt 為 0 視同 null，不清也不重設', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY },
  });
  const engine = TCLSync.create(depsWithMarksClearedAt(env, 0));
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.storage.entries()),
    ['1001'],
    '0 是「沒有水位線」的降級表示（序列化過的 null），拿它去比大小會把整份名單清掉'
  );
  assert.notEqual(env.storage.syncState().marksCursor, null, '四格不得因為 0 被重設');
});

test('R3-2 下行：clearedAt 等於守衛的水位線（自己剛清的那一次）不得清本機名單', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY },
  });
  const cleared = await clearCloudMarks(env);
  // deleteCloud 記下的那一筆守衛:同一個水位線拉回來時是「自己清的」，硬刪不可
  // 逆，一律往不刪倒（links 的自清守衛 D19 同一條紀律）。
  env.storage.localData[MARKS_CLEAR_GUARD_KEY] = { userId: 'user-abc', clearedAt: cleared };

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.storage.entries()),
    ['1001'],
    '自己那一次的水位線拉回來時清本機，等於「刪雲端 → 下一輪」把本機名單也滅了'
  );
  assert.equal(marksGuard(env).clearedAt, cleared, 'skip 的裁決不動守衛');
});

// ---- R3-3 自清守衛（獨立 storage key、四態） ----

test('R3-3 守衛：deleteCloud → 登出 → 再登入兩輪同步，本機名單筆數不變', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }),
      1002: localEntry({ handle: 'bob', updatedAt: T0 - 4 * DAY }),
    }),
    syncState: { marksCursor: '0' },
  });
  const engine = TCLSync.create(env.deps);

  await engine.deleteCloud();
  await settle();
  assert.equal(Object.keys(env.storage.entries()).length, 2, '前置條件:刪雲端不動本機名單');

  await engine.signOut();
  await settle();
  await engine.signIn();
  await settle();
  // 再登入的首輪走回填（POST 不帶位置參數，changes 為 null），第二輪才帶
  // since、才拉得回自己寫下的那個 clearedAt。
  env.advance(10 * 60000);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().userId, 'user-abc', '前置條件:同一個帳號重新登入');
  assert.deepEqual(
    Object.keys(env.storage.entries()).sort(),
    ['1001', '1002'],
    '守衛撐過登出（不在 syncState 裡）才擋得住:拉回自己寫下的水位線不是別台裝置清的'
  );
});

test('R3-3 守衛：userId 對不上就當成別台裝置清的，照樣硬刪', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY },
  });
  const cleared = await clearCloudMarks(env);
  // 水位線比守衛舊，但守衛屬於前一位使用者——換人之後一律不得沿用。
  env.storage.localData[MARKS_CLEAR_GUARD_KEY] = { userId: 'user-other', clearedAt: cleared + 10000 };

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(Object.keys(env.storage.entries()), [], '守衛的 userId 對不上就當成別人清的');
});

test('R3-3 守衛：DELETE 回應缺 clearedAt 記成待定，下一輪認領且不清本機', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0' },
  });
  const engine = TCLSync.create(depsWithoutMarksDeleteClearedAt(env));

  await engine.deleteCloud();
  await settle();
  const pending = requireMarksGuard(env);
  assert.equal(pending.pending, true, '拿不到伺服器水位線就記待定，不得拿本機時間頂替（時鐘差幾秒就全刪）');
  assert.equal(pending.clearedAt, null);

  // 首輪回填（changes 為 null），第二輪才帶 since、拉得回 clearedAt。
  await engine.syncNow();
  await settle();
  env.advance(10 * 60000);
  await engine.syncNow();
  await settle();

  assert.deepEqual(Object.keys(env.storage.entries()), ['1001'], '待定守衛要把拉回來的 clearedAt 認領成自己那一次，本機一筆不刪');
  assert.equal(marksGuard(env).clearedAt, env.server.marks.clearedAt(), '認領後守衛記下伺服器真正的水位線');
});

// 【R3-3 補】下行閘門把 `clearedAt: 0` 當成「沒有水位線」（序列化過的 null），
// 記守衛那一側必須對稱：記成水位線 0 的守衛是「已認領且涵蓋 0」，下一輪拉回真
// 正的 clearedAt 就比它新，整份本機名單會被當成別台裝置清的硬刪。
test('R3-3 守衛：DELETE 回應的 clearedAt 為 0 視同缺席，記成待定而不是水位線 0', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0' },
  });
  const engine = TCLSync.create(depsWithMarksDeleteClearedAt(env, 0));

  await engine.deleteCloud();
  await settle();

  const guard = requireMarksGuard(env);
  assert.equal(guard.pending, true, '0 不是水位線:記成已認領會讓下一輪拉回真正的 clearedAt 判成別台裝置清的');
  assert.equal(guard.clearedAt, null);
  assert.equal(env.storage.syncState().marksCursor, null, '四格照樣重設:雲端那一份確實刪掉了');

  // 首輪回填（changes 為 null），第二輪才帶 since、拉得回伺服器真正的水位線。
  await engine.syncNow();
  await settle();
  env.advance(10 * 60000);
  await engine.syncNow();
  await settle();

  assert.deepEqual(Object.keys(env.storage.entries()), ['1001'], '待定守衛認領那個水位線，本機一筆不刪');
  assert.equal(marksGuard(env).clearedAt, env.server.marks.clearedAt(), '認領後記下伺服器真正的水位線');
});

test('R3-3 守衛：讀不懂時本輪不清本機、記錯誤碼廣播，並重置成待定', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 5 * DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 + 10 * DAY },
    local: { [MARKS_CLEAR_GUARD_KEY]: { userId: 'user-abc', clearedAt: 'corrupt' } },
  });
  await clearCloudMarks(env);

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.storage.entries()),
    ['1001'],
    '守衛壞掉就當成沒有守衛去硬刪，是拿使用者的資料賭（硬刪不可逆，一律往不刪倒）'
  );
  const lastError = env.storage.syncState().lastError;
  assert.equal(typeof lastError, 'string', '不得靜靜吞掉:要記一個錯誤碼（沿用 clear_guard_invalid 或另立 marks 專用碼都行）');
  assert.ok(lastError.length > 0);
  assert.equal(env.lastState().status, 'error', '要廣播出去讓使用者知情');
  assert.equal(marksGuard(env).pending, true, '重置成待定，下一輪認領回來');
});

// ---- R3-7 marksEvicted 的上限與歸零 ----

test('R3-7 marksEvicted：累記夾上限，不得無限成長', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 - 5 * DAY, marksEvicted: MARKS_EVICTED_MAX - 5 },
  });
  // 配額壓到 1，雲端先種 10 筆:這一輪推上去之後會淘汰 10 筆。
  env.server.marks.setQuota(1);
  env.server.marks.seed(bulkMarks(10, 2001));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const evicted = env.storage.syncState().marksEvicted;
  assert.ok(evicted !== null, '前置條件:這一輪確實有淘汰');
  assert.equal(
    evicted,
    MARKS_EVICTED_MAX,
    '累記值夾在 1,000,000:這一格只是 UI 提示的筆數，長年累加會變成無意義的天文數字'
  );
});

test('R3-7 marksEvicted：一輪完整成功且本輪 evicted 為 0 時歸零成 null', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 - 5 * DAY, marksEvicted: 7 },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(Object.keys(env.storage.syncState().marksRejected || {}), [], '前置條件:這一輪沒有被拒的條目');
  assert.equal(
    env.storage.syncState().marksEvicted,
    null,
    '上一輪的淘汰提示在下一輪順利跑完後就該收掉，否則那張提示永遠掛著'
  );
});

test('R3-7 marksEvicted：本輪有錯時不得歸零（提示還沒對帳完）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }) }),
    syncState: { marksCursor: '0', marksPushedAt: T0 - 5 * DAY, marksEvicted: 7 },
  });
  env.failPath('/api/v1/marks/sync', { status: 500, body: { error: 'server_error' } });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.equal(env.storage.syncState().marksEvicted, 7, '這一輪沒跑完，淘汰筆數留著');
});

// ---- R3-11 handle 形狀閘門（推送側） ----

test('R3-11 推：handle 不合 ^[A-Za-z0-9._]{1,80}$ 的條目不進推送批', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice.ok_1', updatedAt: T0 - DAY }),
      // 空白與驚嘆號都不在伺服器的 handle 白名單內:送上去必被退回
      // rejectedIds，白佔一次往返還把 key 記進 marksRejected 永久跳過。
      1002: localEntry({ handle: 'bad handle!', updatedAt: T0 - DAY }),
    }),
    syncState: { marksCursor: '0' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  const pushed = Object.keys(env.upsertsByKey()).sort();
  assert.deepEqual(pushed, ['threads:1001'], 'handle 形狀不合的條目在本機這一關就攔下來');
});

// 【契約澄清｜R3-11】staging 實測：後端把 `handle` 當**必填**（`^[A-Za-z0-9._]
// {1,80}$`），送 `handle: null` 的 mark 整筆進 `applied.rejectedIds`。因此
// 「缺席」與「形狀不合」在推送這一關是同一件事——兩者都攔在本機，不佔往返、也
// 不把 key 記進 marksRejected（記了就得等使用者又動過那一筆才會再送，而補建的
// 空條目根本不會再被動到，那次解除從此同步不出去）。
test('R3-11 推：handle 缺席的條目同樣不進推送批，也不得記進 marksRejected', async () => {
  const TCLSync = loadSync();
  // background 在名單裡沒有該筆時補建的空 dismissed 條目就長這樣:沒有 handle。
  const withoutHandle = localEntry({ state: 'dismissed', dismissedAt: T0 - DAY, updatedAt: T0 - DAY });
  delete withoutHandle.handle;

  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({
      1001: localEntry({ handle: 'alice', updatedAt: T0 - DAY }),
      1002: withoutHandle,
    }),
    syncState: { marksCursor: '0' },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle();

  assert.deepEqual(
    Object.keys(env.upsertsByKey()).sort(),
    ['threads:1001'],
    'handle 缺席的條目送上去必被整筆拒收，白佔一次往返'
  );
  assert.equal(
    env.storage.syncState().marksRejected,
    null,
    '攔在本機這一關才不會把 key 記進被拒映射——那一筆之後再也不會被動到，記了就永遠跳過'
  );
});

// ============================================================================
// CR — 官方 code review（2026-09-22，整合分支 agent/feature/marks-sync）的修補
// ----------------------------------------------------------------------------
// CR-2  回填位置持久化：`syncState.marksBackfillCursor` 記下單輪翻不完時的續填
//       位置，下一輪接著填而不是從第一頁重來。
// CR-3  批次邊界撞上同一個 updatedAt：本批最大值等於下一批首筆時，水位線只推到
//       `max - 1`，否則第 51 筆被卡在水位線底下永遠選不到。
// CR-5  `deleteCloud` 兩條通道各自結算：links 刪成功就地套用 links 側重設，
//       marks 失敗只記 lastError，不得把 links 側連坐。
// CR-7  mark key 的解析收斂到 `TCLCore.scamMarkUserId`，sync.js 不再自備前綴與
//       形狀樣板。
// CR-10 回填與增量的時間線接縫：回填到底時把 `GET /api/v1/marks` 最後一頁的
//       頂層 `cursor` 存成 `marksCursor`，回填後第一個 POST 因此帶得出 `since`。
// ============================================================================

/** 攔在 fetch 前面，讓第 n 次打到某路徑的請求斷在網路上（`failPath` 只綁得住下一次）。 */
function depsFailingNth(env, method, path, n) {
  const inner = env.deps.fetch;
  let seen = 0;
  return Object.assign({}, env.deps, {
    fetch(url, init) {
      const verb = ((init && init.method) || 'GET').toUpperCase();
      if (verb === method && new URL(String(url)).pathname === path) {
        seen += 1;
        if (seen === n) return Promise.reject(new TypeError('Failed to fetch'));
      }
      return inner(url, init);
    },
  });
}

/**
 * 側錄每一次 `GET /api/v1/marks` 的回應本體，並在最後一頁回來之後（第一個 POST
 * 送出之前）跑一次 `onBottom`——別台裝置在回填途中推東西上來，就是落在這個位置。
 */
function depsWatchingBackfill(env, onBottom) {
  const inner = env.deps.fetch;
  const pages = [];
  const deps = Object.assign({}, env.deps, {
    fetch(url, init) {
      const verb = ((init && init.method) || 'GET').toUpperCase();
      if (verb !== 'GET' || new URL(String(url)).pathname !== '/api/v1/marks') return inner(url, init);
      return Promise.resolve(inner(url, init)).then((res) =>
        Promise.resolve(res.json()).then((body) => {
          pages.push(body);
          if (body && body.nextCursor === null && onBottom) onBottom(body);
          return { status: res.status, ok: res.ok, headers: res.headers, json: () => Promise.resolve(body) };
        })
      );
    },
  });
  deps.backfillPages = pages;
  return deps;
}

// ---- CR-2 回填位置持久化 ----

test('CR-2 回填：單輪翻不完時把續填位置記進 syncState.marksBackfillCursor', async () => {
  const TCLSync = loadSync();
  // 沿用 M5 的常數：單頁 100 × 單輪 20 頁 = 2,000，多一筆就翻不完。
  const total = 2001;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.seed(bulkMarks(total, 6001));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(200);

  const state = env.storage.syncState();
  assert.equal(env.marksGets().length, 20, '前置條件：一輪最多 20 頁');
  assert.equal(state.marksCursor, null, '前置條件：沒回填到底就不寫增量游標');
  assert.equal(
    typeof state.marksBackfillCursor,
    'string',
    '翻不完就得記下停在哪一頁：不記的話下一輪從第一頁重來，雲端筆數只要多過單輪翻得完的量就永遠回填不到底，marks 通道從此卡在回填、一筆都推不出去'
  );
  assert.equal(Object.keys(env.storage.entries()).length, 2000, '前置條件：拉到的 2,000 筆照樣落地');
});

test('CR-2 回填：下一輪從記下的位置續填——只再 GET 一頁就到底，2,001 筆全落地', async () => {
  const TCLSync = loadSync();
  const total = 2001;
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.seed(bulkMarks(total, 6001));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(200);
  const firstRound = env.marksGets().length;
  const resumeFrom = env.storage.syncState().marksBackfillCursor;

  env.advance(6 * 60000);
  await engine.syncNow();
  await settle(200);

  const secondRound = env.marksGets().slice(firstRound);
  assert.equal(
    secondRound.length,
    1,
    '續填只剩 1 筆要拿：從頭重來會再翻 20 頁，把 2,000 筆已經拿過的資料重拉一次，還多燒一整輪的限流額度'
  );
  assert.ok(
    typeof resumeFrom === 'string' && secondRound[0].search.indexOf('cursor=' + encodeURIComponent(resumeFrom)) !== -1,
    '續填的第一頁必須帶上一輪記下的位置'
  );

  const state = env.storage.syncState();
  assert.equal(Object.keys(env.storage.entries()).length, total, '兩輪走完 2,001 筆全落地');
  assert.equal(typeof state.marksCursor, 'string', '回填到底才建立增量游標');
  assert.equal(state.marksBackfillCursor, null, '到底之後續填位置清成 null，下一輪不再走回填');
});

// ---- CR-3 批次邊界撞上同一個 updatedAt ----

// 49 筆各自遞增，最後兩筆共用同一個 updatedAt＝TIE：切批後 TIE 同時是第一批的最
// 大值與第二批的首筆。水位線推到 TIE，第二批那一筆的 updatedAt > marksPushedAt
// 就永遠不成立，斷線之後再也補推不上去。
const TIE_AT = T0 - DAY + 49;

function tiedBoundaryEntries() {
  const entries = {};
  for (let i = 0; i < 49; i += 1) {
    const id = String(3001 + i);
    entries[id] = localEntry({ handle: 'bulk' + id, updatedAt: T0 - DAY + i, addedAt: T0 - 5 * DAY });
  }
  entries['3050'] = localEntry({ handle: 'bulk3050', updatedAt: TIE_AT, addedAt: T0 - 5 * DAY });
  entries['3051'] = localEntry({ handle: 'bulk3051', updatedAt: TIE_AT, addedAt: T0 - 5 * DAY });
  return entries;
}

test('CR-3 切批：第 50 與第 51 筆同 updatedAt 時，水位線不得推到那個值上', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist(tiedBoundaryEntries()),
  });
  const deps = depsFailingNth(env, 'POST', '/api/v1/marks/sync', 2);
  const engine = TCLSync.create(deps);
  await engine.syncNow();
  await settle(60);

  const posts = env.marksPosts();
  assert.equal(posts.length, 1, '前置條件：第一批送出，第二批斷在網路上');
  assert.equal(posts[0].body.upserts.length, 50, '前置條件：第一批滿 50');
  assert.equal(env.storage.syncState().lastError, 'network_error', '前置條件：這一輪算失敗');

  const pushedAt = env.storage.syncState().marksPushedAt;
  assert.ok(
    pushedAt !== null && pushedAt < TIE_AT,
    '第 51 筆的 updatedAt 也是 ' + TIE_AT + '，水位線只要推到 ' + TIE_AT + ' 它就永遠選不進推送批（實得 ' + pushedAt + '）'
  );
});

test('CR-3 切批：下一輪第 51 筆必須重新出現在 upserts', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: '0', marksPushedAt: null },
    blocklist: blocklist(tiedBoundaryEntries()),
  });
  const deps = depsFailingNth(env, 'POST', '/api/v1/marks/sync', 2);
  const engine = TCLSync.create(deps);
  await engine.syncNow();
  await settle(60);

  const before = env.marksPosts().length;
  env.advance(6 * 60000);
  await engine.syncNow();
  await settle(60);

  const resent = {};
  env.marksPosts()
    .slice(before)
    .forEach((req) => {
      ((req.body && req.body.upserts) || []).forEach((mark) => {
        resent[mark.key] = true;
      });
    });
  assert.ok(resent['threads:3051'], '第 51 筆沒上雲，下一輪必須補推');
  assert.equal(env.server.marks.count(), 51, '兩輪走完雲端要齊 51 筆');
});

// ---- CR-5 deleteCloud 兩條通道各自結算 ----

test('CR-5 deleteCloud：marks DELETE 失敗時，links 側的本機重設照樣落地', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice', updatedAt: T0 - 3 * DAY }) }),
    local: {
      syncDevices: { fetchedAt: T0 - 60000, devices: [{ deviceId: DEVICE_ID, name: 'Pixel' }] },
    },
    syncState: {
      cursor: 'links-cursor-before-delete',
      displayName: 'Someone',
      avatarUrl: 'https://lh3.googleusercontent.com/a/synthetic',
      marksCursor: 'marks-cursor-before-delete',
      marksPushedAt: T0 - 2 * DAY,
      marksEvicted: 7,
      marksRejected: { 'threads:1001': T0 - 3 * DAY },
    },
  });
  env.failPath('/api/v1/marks', { status: 503, body: { error: 'service_unavailable' } });

  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle(40);

  assert.equal(env.server.requestsTo('/api/v1/links', 'DELETE').length, 1, '前置條件：links 刪成功');
  assert.equal(marksDeletes(env).length, 1, '前置條件：marks 也打了一次，回 503');

  const state = env.storage.syncState();
  // links 那一支已經成功了：雲端那份紀錄真的沒了。marks 收尾失敗不能把它回捲
  // ——本機還留著 cursor 與 displayName，下一輪同步就拿一個指向不存在資料的游
  // 標去續傳，帳號入口也繼續秀著剛被刪掉的那份資料。
  assert.equal(state.cursor, null, 'links 游標已歸零');
  assert.equal(state.displayName, null, 'D15：刪雲端是明確的隱私動作，名字快取一併清掉');
  assert.equal(state.avatarUrl, null, '大頭照快取一併清掉');
  assert.ok(
    env.storage.localData.syncClearGuard,
    'links 的自清守衛必須寫下，否則下一輪拉回自己的水位線會把本機紀錄全刪（D19）'
  );
  assert.ok(
    env.storage.localData.syncDevices === undefined || env.storage.localData.syncDevices === null,
    'links 側的裝置快取一併清掉'
  );

  assert.ok(state.lastError, 'marks 那一支失敗要留下錯誤碼，使用者才知道名單還在雲端');
  const guard = marksGuard(env);
  assert.ok(guard === undefined || guard === null, 'marks 沒刪成功就不得寫守衛');
  assert.equal(state.marksCursor, 'marks-cursor-before-delete', 'marks 沒刪成功，四格不得重設');
  assert.equal(state.marksPushedAt, T0 - 2 * DAY);
  assert.equal(state.marksEvicted, 7);
  assert.deepEqual(state.marksRejected, { 'threads:1001': T0 - 3 * DAY });
});

test('CR-5 deleteCloud：links DELETE 失敗時整個中止，marks 那一支不得送出', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    blocklist: blocklist({ 1001: localEntry({ handle: 'alice' }) }),
    syncState: { cursor: 'links-cursor-before-delete', marksCursor: 'marks-cursor-before-delete' },
  });
  env.failPath('/api/v1/links', { status: 503, body: { error: 'service_unavailable' } });

  const engine = TCLSync.create(env.deps);
  await engine.deleteCloud();
  await settle(40);

  assert.deepEqual(marksDeletes(env), [], 'links 都沒刪成功就去刪名單，等於把一次失敗的操作做了一半');
  const state = env.storage.syncState();
  assert.equal(state.cursor, 'links-cursor-before-delete', '前一步失敗，links 側一格不動');
  assert.equal(state.marksCursor, 'marks-cursor-before-delete');
  assert.ok(state.lastError, '失敗要記錯誤碼');
});

// ---- CR-7 mark key 解析的單一來源 ----

test('CR-7 sync.js 不得自備 mark key 的前綴常數與形狀樣板', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sync.js'), 'utf8');
  // 同一條規則寫兩份，改一邊忘了另一邊就是一條靜默的資料裂縫：sync.js 認得的
  // key 與 tcl-core 認得的不一樣時，墓碑刪到的與合併寫進去的會是兩批條目。
  assert.equal(
    /MARK_USER_ID_PATTERN/.test(src),
    false,
    'mark key 的形狀只該有一把尺（TCLCore.scamMarkUserId），sync.js 不得自備樣板'
  );
  assert.equal(
    /var\s+MARK_KEY_PREFIX\s*=/.test(src),
    false,
    'key 前綴同理：兩份常數哪天分岔，整條 marks 通道會靜默地只對得上一半的條目'
  );
  assert.ok(/scamMarkUserId/.test(src), 'sync.js 應改呼叫 TCLCore.scamMarkUserId');
});

// ---- CR-10 回填與增量的時間線接縫 ----

test('CR-10 接縫：回填到底時把最後一頁的 cursor 存成 marksCursor，第一個 POST 因此帶 since', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.seed(bulkMarks(3, 8001));

  const deps = depsWatchingBackfill(env);
  const engine = TCLSync.create(deps);
  await engine.syncNow();
  await settle(40);

  assert.equal(deps.backfillPages.length, 1, '前置條件：3 筆一頁就到底');
  const bottom = deps.backfillPages[0];
  assert.equal(typeof bottom.cursor, 'string', '前置條件：mock 的 GET 每頁都帶頂層 cursor');

  const posts = env.marksPosts();
  assert.ok(posts.length >= 1, '前置條件：回填到底之後照常推拉一次');
  assert.equal(
    posts[0].body.since,
    bottom.cursor,
    '回填只講「現在有哪些警示」，接手的增量得從回填那一刻的伺服器位置起算；不帶 since 的話這一次 POST 領回來的是一個更晚的游標，中間那段增量從此拉不回來'
  );
});

test('CR-10 接縫：回填期間別台裝置推上來的舊條目，靠 since 在同一輪補回本機', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  // 兩頁的回填量。
  env.server.marks.seed(bulkMarks(120, 8101));

  // 回填翻到底之後、第一個 POST 送出之前，裝置 B 推一筆 updatedAt 比整個回填
  // 區間都舊的 mark：回填照 updatedAt 升冪翻頁，早就翻過那個位置了，這一筆不
  // 可能出現在任何一頁裡，只有增量拿得到它。
  const deps = depsWatchingBackfill(env, () => {
    env.server.marks.seed([
      {
        key: 'threads:8999',
        state: 'active',
        dismissedAt: null,
        handle: 'lateone',
        displayName: null,
        source: 'auto',
        evidence: [],
        addedAt: T0 - 9 * DAY,
        updatedAt: T0 - 9 * DAY,
      },
    ]);
  });
  const engine = TCLSync.create(deps);
  await engine.syncNow();
  await settle(60);

  assert.ok(deps.backfillPages.length >= 2, '前置條件：120 筆分兩頁回填');
  assert.ok(env.storage.entries()['8101'], '前置條件：回填的條目照常落地');
  assert.ok(
    env.storage.entries()['8999'],
    '回填期間寫進雲端、updatedAt 又落在回填區間之前的條目掉進兩條時間線的接縫裡——回填按 updatedAt 翻頁看不到它，增量游標又從回填之後才起算，這一筆會永遠停在雲端'
  );
});

test('CR-10 接縫：舊後端沒回 cursor 時退回原本行為（不帶 since）且不得拋錯', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    scamGuardEnabled: true,
    syncState: { marksCursor: null, marksPushedAt: T0 },
    blocklist: blocklist({}),
  });
  env.server.marks.listCursor(false);
  env.server.marks.seed(bulkMarks(3, 8201));

  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await settle(40);

  const posts = env.marksPosts();
  assert.ok(posts.length >= 1, '沒有 cursor 不該讓整輪掛掉');
  assert.equal(
    Object.prototype.hasOwnProperty.call(posts[0].body, 'since'),
    false,
    '讀不到位置就別亂編一個：帶著 undefined 或本機時戳上去，伺服器會回一段對不上的增量'
  );
  assert.equal(env.storage.syncState().lastError, null, '舊後端只是少一欄，不是錯誤');
  assert.equal(Object.keys(env.storage.entries()).length, 3, '回填照常落地');
  assert.equal(typeof env.storage.syncState().marksCursor, 'string', '仍以 POST 回應的 cursor 建立增量游標');
});
