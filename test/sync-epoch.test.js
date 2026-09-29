// test/sync-epoch.test.js — 同步紀元（epoch，SW-4a，決策 S6／後端決策 36）的插件端
// 行為契約。
//
// 後端（2026-09-27 定稿）：
// - `POST /api/v1/links/sync`、`POST /api/v1/marks/sync`、`GET /api/v1/links` 的回
//   應頂層一律帶 `epoch`（非負整數，只增不減，從未刪除過＝0）；links 與 marks 共
//   用同一個值；`DELETE /api/v1/cloud-data` 每次 +1。
// - 請求可選帶 epoch：POST 放 body 頂層、GET 放 query。不帶＝相容模式；壞值 400
//   `bad_epoch`；不符 409 `{ error:"epoch_mismatch", epoch }` 零寫入。
//
// 插件端（design-sw §9.3）：
// - `storage.local.syncEpoch = { userId, epoch }`，不進 resetAccount，跨登出保留，
//   只有換帳號時覆寫。
// - 本機已知時每個 sync POST 帶 body 頂層 epoch。
// - finishSignIn（PM 裁決 EP-A）：本機有此 userId 的 epoch 就不全量標髒；沒有（升
//   級後首次、換帳號、全新安裝）就一律一次性全量標髒並重設游標，第一趟不帶，採用
//   回應的值。
// - 回應沒有 epoch 鍵（舊後端，EP-B）：不寫 syncEpoch、不標髒、不排 continue。
// - 回應 epoch 與本機（已知）不同、或 409 epoch_mismatch（EP-C 同一路徑
//   resetForEpoch）：全部標髒、cursor '0'、marksCursor null、marksBackfillCursor
//   null、寫回新 epoch、`setNext('continue')`，本輪不再發 POST；409 那批視為未送
//   出、dirty 不清、不計入退避。
// - 回填 GET /api/v1/marks 不帶 epoch（EP-D：該端點後端不收、不回）；POST 已校驗。
//
// storage／alarms／auth 替身沿用 test/sync-reset-account.test.js 的 harness（同
// sync.test.js：get/set/remove 一律 setTimeout(0) 延遲結算；setTimeout 注入成空
// 函式，2 秒去抖計時器不會自己跑，續跑只看 alarm 的建立紀錄）。
'use strict';

const test = require('node:test');
// chrome.storage 替身的 setTimeout(0) 落盤與本檔 settle() 的逐輪讓出都走假時
// 間（test/support/settle.js），每一輪不再吃作業系統計時器顆粒。
const fakeClock = require('./support/settle').installSettle();
test.beforeEach(fakeClock.reset);
const assert = require('node:assert/strict');

const TCLCore = require('../tcl-core.js');
const { postKeyOf } = TCLCore;
const { createMockSyncServer, CLOUD_DATA_CONTRACT } = require('./helpers/mock-sync-server.js');
const { loadSync, signedInState: baseSignedInState, createSyncEnv } = require('./support/sync-env');

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;
const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';
const POST_C = 'https://www.threads.com/@carol/post/CCCCCCCCCCC';
const POST_D = 'https://www.threads.com/@dave/post/DDDDDDDDDDD';

const LINKS_SYNC = '/api/v1/links/sync';
const MARKS_SYNC = '/api/v1/marks/sync';
const MARKS_LIST = '/api/v1/marks';
const EPOCH_KEY = 'syncEpoch';
// wave-2 的請求 body 鍵集合（epoch 之外）。
const LINKS_BODY_KEYS = ['upserts', 'deletes', 'since', 'device'];
const MARKS_BODY_KEYS = ['upserts', 'deletes', 'since'];
const MAX_ROUND_POSTS = 12;

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

/** 兩筆已同步、一筆未同步、一筆已同步的墓碑。原本 dirty 的只有 loc-c。 */
function mixedHistory() {
  return [
    entry({ id: 'srv-a', url: POST_A, dirty: false, serverUpdatedAt: T0 - 1000 }),
    entry({ id: 'srv-b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 2000 }),
    entry({ id: 'loc-c', url: POST_C, dirty: true, serverUpdatedAt: null }),
    entry({ id: 'tomb-d', url: POST_D, dirty: false, serverUpdatedAt: T0 - 3000, deletedAt: T0 - 500 }),
  ];
}

/** v2 scamBlocklist：7001 乾淨、7002 dirty。 */
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

// 已登入的 syncState：共用範本再帶本檔的 links／marks 游標。
function signedInState(over = {}) {
  return baseSignedInState(Object.assign({ cursor: '100', marksCursor: '200', marksEvicted: null }, over));
}

// 本檔的環境設定：storage 以 setTimeout(0) 落盤（走假時間）、登入回傳的
// id_token payload 不帶 picture。
const ENV_PROFILE = {
  storage: { defer: 'timeout' },
  auth: { payloadPicture: null },
  signedInState,
};

/**
 * 組一整套注入環境（見 test/support/sync-env.js 的 createSyncEnv）。
 * @param {object} opts
 *   history、blocklist、local（其他本機鍵）、signedIn、syncState（patch）、
 *   epoch（本機 syncEpoch；undefined＝不種）、
 *   afterFetch(record, server)：每次 fetch 結算後呼叫（模擬往返之間別台裝置動作）。
 */
function makeEnv(opts = {}) {
  const local = Object.assign({}, opts.local);
  if (opts.epoch !== undefined) local[EPOCH_KEY] = opts.epoch;
  const env = createSyncEnv(Object.assign({}, opts, { local }), ENV_PROFILE);
  const { server, storage, alarms } = env;
  env.deps.fetch = (url, init) =>
    server.fetch(url, init).then((res) => {
      if (opts.afterFetch) opts.afterFetch(server.lastRequest(), server);
      return res;
    });
  return Object.assign(env, {
    localEpoch() {
      return storage.localData[EPOCH_KEY];
    },
    syncState() {
      return TCLCore.normalizeSyncState(storage.localData.syncState || null);
    },
    blocklist() {
      return storage.localData.scamBlocklist;
    },
    /** 側錄起點：之後的查詢只看這個位置之後的請求。 */
    mark() {
      return server.requests.length;
    },
    posts(path, from = 0) {
      return server.requests.slice(from).filter((r) => r.method === 'POST' && r.path === path);
    },
    gets(path, from = 0) {
      return server.requests.slice(from).filter((r) => r.method === 'GET' && r.path === path);
    },
    debounceCreates(from = 0) {
      return alarms.calls.slice(from).filter((c) => c.op === 'create' && c.name === 'tcl-sync-debounce');
    },
  });
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const hasEpoch = (body) => !!body && Object.prototype.hasOwnProperty.call(body, 'epoch');
const upsertIds = (reqs) => reqs.flatMap((r) => (r.body.upserts || []).map((u) => u.id));
const deleteIds = (reqs) => reqs.flatMap((r) => r.body.deletes || []);
const markKeys = (reqs) => reqs.flatMap((r) => (r.body.upserts || []).map((u) => u.key));
const uniqSorted = (list) => [...new Set(list)].sort();

function assertAllHistoryDirty(env, label) {
  const list = env.storage.history();
  assert.ok(list.length > 0, `${label}：前置 history 不可為空`);
  list.forEach((e) => assert.equal(e.dirty, true, `${label}：${e.id} 應被標髒`));
}

function assertAllMarksDirty(env, label) {
  const entries = env.blocklist().entries;
  Object.keys(entries).forEach((id) => assert.equal(entries[id].dirty, true, `${label}：名單 ${id} 應被標 dirty`));
}

function queryEpoch(record) {
  return new URLSearchParams(record.search || '').get('epoch');
}

// ============================================================================
// EP1 — 首次登入（本機沒有這個 userId 的 epoch）
// ============================================================================

test('EP1 首次登入、雲端 epoch=0：第一趟不帶 epoch，一次性全量標髒（EP-A），syncEpoch 寫成 {userId, 0}', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: mixedHistory(), blocklist: sampleBlocklist() });
  const engine = TCLSync.create(env.deps);

  await engine.signIn();
  await settle();

  const links = env.posts(LINKS_SYNC);
  assert.ok(links.length >= 1, '前置：登入後跑了首輪');
  assert.equal(hasEpoch(links[0].body), false, '本機未知 epoch：第一趟不帶');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 0 }, '採用回應的 epoch');
  // PM 裁決 EP-A：本機沒有此 userId 的 epoch 一律全量標髒，不看回應是不是 0。
  assert.equal(links[0].body.since, '0', '游標重設');
  assert.deepEqual(uniqSorted(upsertIds(links)), ['loc-c', 'srv-a', 'srv-b'], 'history 全量重傳');
  assert.deepEqual(deleteIds(links), ['tomb-d'], '墓碑一併重送');
  assert.deepEqual(uniqSorted(markKeys(env.posts(MARKS_SYNC))), ['threads:7001', 'threads:7002'], '名單全量重傳');
});

test('EP1 首次登入、雲端 epoch=3：全量標髒＋游標重設，之後每個 POST 都帶 epoch:3', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: mixedHistory(), blocklist: sampleBlocklist() });
  env.server.epoch.set(3);
  const engine = TCLSync.create(env.deps);

  await engine.signIn();
  await settle();
  assert.equal(hasEpoch(env.posts(LINKS_SYNC)[0].body), false, '第一趟不帶 epoch');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 3 }, '採用回應的 epoch');

  env.advance(60_000);
  await engine.syncNow();
  await settle();

  const links = env.posts(LINKS_SYNC);
  const later = links.slice(1).concat(env.posts(MARKS_SYNC));
  assert.ok(later.length >= 2, '前置：之後至少還有 links 與 marks 的 POST');
  later.forEach((r) => assert.equal(r.body.epoch, 3, `${r.path} 帶 epoch:3`));
  // PM 裁決 EP-A：全量標髒在登入當下就做，第一趟（不帶 epoch）即從 0 起全量重傳。
  assert.equal(links[0].body.since, '0', '游標重設：第一個 links POST 從 0 起');
  assert.deepEqual(uniqSorted(upsertIds(links)), ['loc-c', 'srv-a', 'srv-b'], 'history 全量重傳');
  assert.deepEqual(deleteIds(links), ['tomb-d'], '墓碑一併重送');
  assert.deepEqual(uniqSorted(markKeys(env.posts(MARKS_SYNC))), ['threads:7001', 'threads:7002'], '名單全量重傳');
  assert.equal(env.server.linkCount(), 3, '雲端由本機重建');
});

// ============================================================================
// EP2 — 再登入（本機有同一個 userId 的 epoch，且與雲端相同）
// ============================================================================

test('EP2 再登入、epoch 相同：不全量標髒，只推原本 dirty 的，第一個 POST 就帶 epoch', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 3 },
  });
  env.server.epoch.set(3);
  const engine = TCLSync.create(env.deps);

  await engine.signIn();
  await settle();

  const links = env.posts(LINKS_SYNC);
  assert.ok(links.length >= 1, '前置：登入後跑了首輪');
  assert.equal(links[0].body.epoch, 3, '第一個 links POST 帶本機 epoch');
  assert.deepEqual(uniqSorted(upsertIds(links)), ['loc-c'], '不整份重傳');
  assert.deepEqual(deleteIds(links), [], '已同步的墓碑不重送');
  const marks = env.posts(MARKS_SYNC);
  marks.forEach((r) => assert.equal(r.body.epoch, 3, 'marks POST 帶 epoch'));
  assert.deepEqual(uniqSorted(markKeys(marks)), ['threads:7002'], '名單只推原本 dirty 的');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 3 }, 'syncEpoch 不變');
  assert.equal(env.storage.history().find((e) => e.id === 'srv-a').dirty, false, '已同步的不被翻髒');
});

// ============================================================================
// EP3 — 回應 epoch 比本機大（別台裝置刪過雲端）
// ============================================================================

test('EP3 回應 epoch 與本機不同：全部標髒、cursor 0、marksCursor null、寫回、排 continue、本輪不再發 POST；下一輪帶新 epoch 全量重傳', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 2 },
  });
  // 只回報不校驗：讓伺服器以 200 回一個比本機大的 epoch（防禦路徑）。
  env.server.epoch.set(5).validate(false);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  const links = env.posts(LINKS_SYNC);
  assert.equal(links.length, 1, '本輪只發出第一個 links POST');
  assert.equal(links[0].body.epoch, 2, '第一個 POST 帶本機舊值');
  assert.equal(env.posts(MARKS_SYNC).length, 0, '本輪不再連發 marks POST');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 5 }, '寫回新 epoch');
  assertAllHistoryDirty(env, 'EP3');
  assertAllMarksDirty(env, 'EP3');
  const state = env.syncState();
  assert.equal(state.cursor, '0', 'links 游標設回 0');
  assert.equal(state.marksCursor, null, 'marks 游標歸 null，下一輪走回填');
  assert.ok(env.debounceCreates().length >= 1, "setNext('continue') 建立續跑 alarm");

  env.server.epoch.validate(true);
  const from = env.mark();
  env.advance(60_000);
  await engine.syncNow();
  await settle();

  const next = env.posts(LINKS_SYNC, from);
  assert.ok(next.length >= 1, '下一輪有 links POST');
  next.concat(env.posts(MARKS_SYNC, from)).forEach((r) => assert.equal(r.body.epoch, 5, `${r.path} 帶新 epoch`));
  assert.equal(next[0].body.since, '0', '下一輪 links 從 0 起');
  assert.deepEqual(uniqSorted(upsertIds(next)), ['loc-c', 'srv-a', 'srv-b'], 'history 全量重傳');
  assert.deepEqual(uniqSorted(markKeys(env.posts(MARKS_SYNC, from))), ['threads:7001', 'threads:7002'], '名單全量重傳');
  assert.ok(env.gets(MARKS_LIST, from).length >= 1, 'marksCursor 為 null：先走回填 GET');
});

// ============================================================================
// EP4 — 409 epoch_mismatch
// ============================================================================

test('EP4 links POST 撞 409：批視為未送出、游標不前進、寫回 409 的 epoch、全部標髒、排 continue、不計入退避', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 2 },
    local: { syncBackoff: { failures: 1 } },
  });
  env.server.epoch.set(5);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  const links = env.posts(LINKS_SYNC);
  assert.equal(links.length, 1, '撞 409 之後本輪不再發 links POST');
  assert.equal(links[0].body.epoch, 2, '帶本機舊值');
  assert.equal(env.posts(MARKS_SYNC).length, 0, '本輪不再連發 marks POST');
  assert.equal(env.server.linkCount(), 0, '前置：伺服器零寫入');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 5 }, '寫回 409 回應體的 epoch');
  assert.equal(env.storage.history().find((e) => e.id === 'loc-c').dirty, true, '沒送成的那一筆 dirty 不清');
  assertAllHistoryDirty(env, 'EP4');
  assertAllMarksDirty(env, 'EP4');
  const state = env.syncState();
  assert.equal(state.cursor, '0', 'links 游標重設為 0（PM 裁決 EP-C）');
  assert.equal(state.marksCursor, null, 'marksCursor 歸 null（PM 裁決 EP-C）');
  assert.notEqual(state.lastError, 'epoch_mismatch', 'epoch_mismatch 不是錯誤態');
  assert.ok(env.storage.localData.syncBackoff.failures <= 1, '不計入退避失敗次數');
  assert.equal(
    env.alarms.creates().filter((c) => c.name === TCLSync.ALARM_NAME && c.info.when !== undefined).length,
    0,
    '不排退避 alarm'
  );
  assert.ok(env.debounceCreates().length >= 1, "setNext('continue') 建立續跑 alarm");

  const from = env.mark();
  env.advance(60_000);
  await engine.syncNow();
  await settle();
  const next = env.posts(LINKS_SYNC, from);
  next.concat(env.posts(MARKS_SYNC, from)).forEach((r) => assert.equal(r.body.epoch, 5, `${r.path} 帶新 epoch`));
  assert.deepEqual(uniqSorted(upsertIds(next)), ['loc-c', 'srv-a', 'srv-b'], '下一輪全量重傳');
  assert.equal(env.server.linkCount(), 3);
});

test('EP4 marks POST 撞 409（links 送完之後別台裝置刪了雲端）：名單 dirty 不清、marksCursor 不前進、寫回 epoch、排 continue、不計入退避', async () => {
  const TCLSync = loadSync();
  let bumped = false;
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 2 },
    afterFetch(record, server) {
      if (!bumped && record.method === 'POST' && record.path === LINKS_SYNC) {
        bumped = true;
        server.epoch.bump();
      }
    },
  });
  env.server.epoch.set(2);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  const marks = env.posts(MARKS_SYNC);
  assert.equal(marks.length, 1, '前置：marks POST 發了一次（撞 409）');
  assert.equal(marks[0].body.epoch, 2);
  assert.equal(env.server.marks.count(), 0, '前置：伺服器零寫入');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 3 }, '寫回 409 回應體的 epoch');
  assert.equal(env.blocklist().entries[7002].dirty, true, '沒送成的 7002 dirty 不清');
  assertAllMarksDirty(env, 'EP4 marks');
  assertAllHistoryDirty(env, 'EP4 marks');
  const state = env.syncState();
  assert.equal(state.cursor, '0', 'links 游標重設為 0（PM 裁決 EP-C）');
  assert.equal(state.marksCursor, null, 'marksCursor 歸 null（PM 裁決 EP-C）');
  assert.notEqual(state.lastError, 'epoch_mismatch');
  assert.equal((env.storage.localData.syncBackoff || { failures: 0 }).failures, 0, '不計入退避失敗次數');
  assert.ok(env.debounceCreates().length >= 1, "setNext('continue') 建立續跑 alarm");
});

// ============================================================================
// EP5 — 換帳號登入
// ============================================================================

for (const cloudEpoch of [0, 2]) {
  test(`EP5 換帳號登入（新帳號雲端 epoch=${cloudEpoch}）：舊帳號的 epoch 不沿用、全量標髒（EP-A），syncEpoch 覆寫為新 userId`, async () => {
    const TCLSync = loadSync();
    const env = makeEnv({
      history: mixedHistory(),
      blocklist: sampleBlocklist(),
      epoch: { userId: 'user-old', epoch: 7 },
      local: { syncState: signedInState({ userId: 'user-old', lastError: 'session_expired' }), syncAuth: { token: null } },
    });
    env.server.setUser({ id: 'user-new', email: 'new@example.com' });
    env.server.epoch.set(cloudEpoch);
    const engine = TCLSync.create(env.deps);

    await engine.signIn();
    await settle();

    const links = env.posts(LINKS_SYNC);
    assert.ok(links.length >= 1, '前置：登入後跑了首輪');
    assert.equal(hasEpoch(links[0].body), false, '換了帳號：第一趟不帶（舊帳號的 7 不沿用）');
    assert.equal(env.syncState().userId, 'user-new', '前置：已換成新帳號');
    assert.deepEqual(env.localEpoch(), { userId: 'user-new', epoch: cloudEpoch }, 'syncEpoch 覆寫為新帳號');
    env.posts(LINKS_SYNC).concat(env.posts(MARKS_SYNC)).forEach((r) => {
      assert.notEqual(r.body.epoch, 7, '任何請求都不得帶舊帳號的 epoch');
    });
    // PM 裁決 EP-A：換帳號＝本機沒有新 userId 的 epoch，一律全量標髒（D25）。
    assert.deepEqual(uniqSorted(upsertIds(links)), ['loc-c', 'srv-a', 'srv-b'], 'history 全量上傳');
    assert.deepEqual(deleteIds(links), ['tomb-d'], '墓碑一併送出');
    assert.deepEqual(uniqSorted(markKeys(env.posts(MARKS_SYNC))), ['threads:7001', 'threads:7002'], '名單全量上傳');
  });
}

// ============================================================================
// EP6 — 跨登出保留；刪雲端之後再登入
// ============================================================================

test('EP6 登出後 syncEpoch 仍在；同帳號再登入不全量重傳', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 4 },
  });
  env.server.epoch.set(4);
  const engine = TCLSync.create(env.deps);

  await engine.signOut();
  await settle();
  assert.equal(env.storage.syncAuth().token, null, '前置：已登出');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 4 }, 'syncEpoch 跨登出保留');

  const from = env.mark();
  await engine.signIn();
  await settle();
  const links = env.posts(LINKS_SYNC, from);
  assert.ok(links.length >= 1, '前置：再登入後跑了首輪');
  assert.equal(links[0].body.epoch, 4, '再登入第一個 POST 就帶保留下來的 epoch');
  assert.deepEqual(uniqSorted(upsertIds(links)), ['loc-c'], '不整份重傳');
  assert.deepEqual(uniqSorted(markKeys(env.posts(MARKS_SYNC, from))), ['threads:7002'], '名單不整份重傳');
});

test('EP6 刪雲端：本機 syncEpoch 不動；同帳號再登入撞到 +1 後的 epoch → 全量重傳並帶新 epoch', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 4 },
  });
  env.server.epoch.set(4);
  const engine = TCLSync.create(env.deps);

  await engine.deleteCloud();
  await settle();
  assert.equal(env.storage.syncAuth().token, null, '前置：刪雲端即登出');
  assert.equal(env.server.epoch.value(), 5, '前置：伺服器 epoch +1');
  assert.equal(env.server.requestsTo(CLOUD_DATA_CONTRACT.path, CLOUD_DATA_CONTRACT.method).length, 1);
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 4 }, '刪雲端不特別處理本機 epoch');

  const from = env.mark();
  await engine.signIn();
  await settle();
  const first = env.posts(LINKS_SYNC, from);
  assert.ok(first.length >= 1, '前置：再登入後跑了首輪');
  assert.equal(first[0].body.epoch, 4, '再登入第一個 POST 帶保留下來的舊值');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 5 }, '寫回伺服器的新 epoch');

  const from2 = env.mark();
  env.advance(60_000);
  await engine.syncNow();
  await settle();
  const next = env.posts(LINKS_SYNC, from2);
  next.concat(env.posts(MARKS_SYNC, from2)).forEach((r) => assert.equal(r.body.epoch, 5, `${r.path} 帶新 epoch`));
  assert.deepEqual(uniqSorted(upsertIds(env.posts(LINKS_SYNC, from))), ['loc-c', 'srv-a', 'srv-b'], 'history 全量重傳');
  assert.equal(env.server.linkCount(), 3, '雲端由本機重建');
  assert.equal(env.server.marks.count(), 2, '名單由本機重建');
});

// ============================================================================
// EP7 — 回填 GET 的 query epoch
// ============================================================================
//
// 插件唯一的回填 GET 是 marks 的 `GET /api/v1/marks`（links 的首輪以 since:'0'
// 的 POST 拉，插件不打 `GET /api/v1/links`）。後端契約只列 `GET /api/v1/links`；
// PM 裁決 EP-D：GET /marks 不帶 epoch（後端不收、不回；POST 已校驗）。

test('EP7 本機 epoch 已知：marks 回填 GET 不帶 query epoch（EP-D）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { marksCursor: null },
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 3 },
  });
  env.server.epoch.set(3);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  const gets = env.gets(MARKS_LIST);
  assert.ok(gets.length >= 1, '前置：marksCursor 為 null，走了回填');
  gets.forEach((r) => assert.equal(queryEpoch(r), null, `回填 GET 不帶 epoch（實得 ${r.search}）`));
  env.server.requests
    .filter((r) => r.method === 'GET' && r.path === '/api/v1/links')
    .forEach((r) => assert.equal(queryEpoch(r), '3', 'GET /api/v1/links 若有打也要帶'));
});

test('EP7 本機 epoch 未知：第一個 links POST 不帶；同輪採用回應的 0 之後，回填 GET 仍不帶（EP-D）', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { marksCursor: null },
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
  });
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(hasEpoch(env.posts(LINKS_SYNC)[0].body), false, '未知時第一個 POST 不帶');
  const gets = env.gets(MARKS_LIST);
  assert.ok(gets.length >= 1, '前置：marksCursor 為 null，走了回填');
  gets.forEach((r) => assert.equal(queryEpoch(r), null, `採用之後回填 GET 仍不帶（實得 ${r.search}）`));
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 0 });
});

test('EP7 舊後端（一直不知道 epoch）：回填 GET 不帶 epoch', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    syncState: { marksCursor: null },
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
  });
  env.server.epoch.report(false);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  const gets = env.gets(MARKS_LIST);
  assert.ok(gets.length >= 1, '前置：marksCursor 為 null，走了回填');
  gets.forEach((r) => assert.equal(queryEpoch(r), null, `未知時不帶（實得 ${r.search}）`));
});

// ============================================================================
// EP8 — 請求形狀與每輪上限
// ============================================================================

test('EP8 請求形狀：除頂層 epoch 外，links／marks POST 的 body 鍵集合與 wave-2 相同', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 1 },
  });
  env.server.epoch.set(1);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  const links = env.posts(LINKS_SYNC);
  const marks = env.posts(MARKS_SYNC);
  assert.ok(links.length >= 1 && marks.length >= 1, '前置：兩條通道都發了 POST');
  for (const [reqs, allowed] of [
    [links, LINKS_BODY_KEYS],
    [marks, MARKS_BODY_KEYS],
  ]) {
    reqs.forEach((r) => {
      assert.equal(r.body.epoch, 1, `${r.path}：body 頂層帶 epoch`);
      assert.equal(typeof r.body.epoch, 'number', 'epoch 是整數，不是字串');
      const rest = Object.keys(r.body).filter((k) => k !== 'epoch');
      rest.forEach((k) => assert.ok(allowed.includes(k), `${r.path}：多出未知鍵 ${k}`));
      assert.ok(rest.includes('upserts') && rest.includes('deletes'), `${r.path}：upserts／deletes 照舊`);
      assert.equal(r.search, '', `${r.path}：POST 不把 epoch 放 query`);
      assert.equal(r.headers.epoch, undefined, `${r.path}：不放標頭`);
    });
  }
});

test('EP8 全量重傳大量資料：每輪 POST 不超過 12 個，且每個都帶 epoch', async () => {
  const TCLSync = loadSync();
  const big = [];
  for (let i = 0; i < 700; i += 1) {
    const url = `https://www.threads.com/@u${i}/post/P${String(i).padStart(10, '0')}`;
    const at = T0 - 100_000 + i;
    big.push(entry({ id: `big-${i}`, url, at, receivedAt: at, seen: [{ at, kind: 'strip' }] }));
  }
  const env = makeEnv({
    signedIn: true,
    history: big,
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 1 },
  });
  env.server.epoch.set(1);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle(40);

  const posts = env.posts(LINKS_SYNC).concat(env.posts(MARKS_SYNC));
  assert.ok(posts.length >= 1, '前置：有發 POST');
  assert.ok(posts.length <= MAX_ROUND_POSTS, `每輪 POST 上限不動（實得 ${posts.length}）`);
  posts.forEach((r) => assert.equal(r.body.epoch, 1, `${r.path} 帶 epoch`));
});

// ============================================================================
// EP9 — 相容：舊後端（回應沒有 epoch 鍵）
// ============================================================================

test('EP9 舊後端、本機已知 epoch：回應沒有 epoch 時一切照舊，不改寫 syncEpoch、不標髒、不排 continue', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: mixedHistory(),
    blocklist: sampleBlocklist(),
    epoch: { userId: 'user-abc', epoch: 3 },
  });
  env.server.epoch.report(false);
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.deepEqual(uniqSorted(upsertIds(env.posts(LINKS_SYNC))), ['loc-c'], '只推原本 dirty 的');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 3 }, 'syncEpoch 不被改寫');
  const h = env.storage.history();
  assert.equal(h.find((e) => e.id === 'srv-a').dirty, false, '不標髒');
  assert.equal(h.find((e) => e.id === 'loc-c').dirty, false, 'ack 照常清 dirty');
  assert.notEqual(env.blocklist().entries[7001].dirty, true, '名單不標髒');
  assert.equal(env.syncState().lastError, null);
  assert.equal(env.debounceCreates().length, 0, '不排 continue');
});

test('EP9 舊後端、首次登入：不寫 syncEpoch，登入照常完成', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: mixedHistory(), blocklist: sampleBlocklist() });
  env.server.epoch.report(false);
  const engine = TCLSync.create(env.deps);

  await engine.signIn();
  await settle();

  assert.ok(env.posts(LINKS_SYNC).length >= 1, '前置：登入後跑了首輪');
  assert.equal(env.localEpoch(), undefined, '回應沒有 epoch：不寫 syncEpoch');
  assert.equal(env.syncState().userId, 'user-abc');
  assert.equal(env.syncState().lastError, null);
});

// ============================================================================
// EP10 — 舊版 marks 遷移必須早於 epoch 採用
// ============================================================================

test('EP10 升級後首輪採用 epoch、遷移前失敗、登出再登入：舊版水位線之後未推的 mark 仍送出', async () => {
  const TCLSync = loadSync();
  const big = [];
  for (let i = 0; i < 60; i += 1) {
    const url = `https://www.threads.com/@m${i}/post/M${String(i).padStart(10, '0')}`;
    const at = T0 - 100_000 + i;
    big.push(entry({ id: `mig-${i}`, url, at, receivedAt: at, seen: [{ at, kind: 'strip' }] }));
  }
  const pushedAt = T0 - 2 * DAY;
  const env = makeEnv({
    signedIn: true,
    // 舊版 syncState：帶 marksPushedAt 鍵即舊版，觸發遷移。
    syncState: { marksPushedAt: pushedAt, marksRejected: {} },
    history: big,
    blocklist: {
      version: 2,
      entries: {
        7003: { state: 'active', handle: 'synthetic_c', source: 'auto', addedAt: T0 - 5 * DAY, updatedAt: T0 - DAY, evidence: [] },
      },
      handleIndex: { synthetic_c: '7003' },
    },
  });
  // 第二個 links POST 斷線：第一個回應已採用 epoch，這一輪在 marks 之前失敗。
  let linksPosts = 0;
  const baseFetch = env.deps.fetch;
  env.deps.fetch = (url, init) => {
    if (init && init.method === 'POST' && String(url).endsWith(LINKS_SYNC)) {
      linksPosts += 1;
      if (linksPosts === 2) return Promise.reject(new TypeError('Failed to fetch'));
    }
    return baseFetch(url, init);
  };
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();
  assert.equal(env.syncState().lastError, 'network_error', '前置：首輪在 links 第二批失敗');
  assert.deepEqual(env.localEpoch(), { userId: 'user-abc', epoch: 0 }, '前置：首輪已採用 epoch');
  assert.equal(env.posts(MARKS_SYNC).length, 0, '前置：首輪沒走到 marks');

  await engine.signOut();
  await settle();
  const from = env.mark();
  await engine.signIn();
  await settle();

  assert.ok(
    markKeys(env.posts(MARKS_SYNC, from)).includes('threads:7003'),
    '水位線之後改過的舊版條目在遷移時已標 dirty，重新登入後送出'
  );
});

// ============================================================================
// EPM — mock-sync-server 的 epoch 契約（後端決策 36）
// ============================================================================

const API = 'https://api.metalinkclearer.workers.dev';
const DEV = '11111111-2222-4333-8444-555555555555';

function mockHarness() {
  const server = createMockSyncServer({ now: () => T0 });
  const token = server.grantToken('tok-epm');
  const call = (method, path, body) =>
    server
      .fetch(API + path, {
        method,
        headers: Object.assign({ Authorization: `Bearer ${token}` }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      .then((res) => res.json().then((json) => ({ status: res.status, body: json })));
  return { server, call };
}

const LINK_ITEM = { id: 'epm-1', original: POST_A, cleaned: POST_A, receivedAt: T0 - 1000, seen: [{ at: T0 - 1000 }] };

test('EPM 三個端點的 200 回應頂層帶 epoch，從未刪除過＝0（空變更集也帶）', async () => {
  const { call } = mockHarness();
  const links = await call('POST', LINKS_SYNC, { upserts: [], deletes: [] });
  const marks = await call('POST', MARKS_SYNC, { upserts: [], deletes: [] });
  const list = await call('GET', '/api/v1/links');
  [links, marks, list].forEach((r) => {
    assert.equal(r.status, 200);
    assert.equal(r.body.epoch, 0);
  });
});

test('EPM 請求帶壞值 → 400 bad_epoch；GET 的 query 同樣校驗', async () => {
  const { server, call } = mockHarness();
  for (const bad of ['1', -1, 1.5, null, true]) {
    const r = await call('POST', LINKS_SYNC, { upserts: [LINK_ITEM], deletes: [], epoch: bad });
    assert.equal(r.status, 400, `links epoch=${JSON.stringify(bad)}`);
    assert.deepEqual(r.body, { error: 'bad_epoch' });
    const m = await call('POST', MARKS_SYNC, { upserts: [], deletes: [], epoch: bad });
    assert.equal(m.status, 400, `marks epoch=${JSON.stringify(bad)}`);
  }
  for (const bad of ['abc', '-1', '1.5', '']) {
    const r = await call('GET', `/api/v1/links?epoch=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `GET ?epoch=${bad}`);
    assert.deepEqual(r.body, { error: 'bad_epoch' });
  }
  assert.equal(server.linkCount(), 0, '壞值零寫入');
});

test('EPM 請求 epoch 與伺服器不符 → 409 epoch_mismatch 帶目前值、零寫入（device 區塊也不 upsert）；相符照常', async () => {
  const { server, call } = mockHarness();
  server.epoch.set(2);
  const device = { deviceId: DEV, name: 'EPM', platform: 'chrome_extension' };
  const r = await call('POST', LINKS_SYNC, { upserts: [LINK_ITEM], deletes: [], since: '0', device, epoch: 1 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'epoch_mismatch', epoch: 2 });
  assert.equal(server.linkCount(), 0, 'links 零寫入');
  assert.equal(server.deviceCount(), 0, 'device 零寫入');
  const m = await call('POST', MARKS_SYNC, { upserts: [], deletes: [], epoch: 0 });
  assert.equal(m.status, 409);
  assert.deepEqual(m.body, { error: 'epoch_mismatch', epoch: 2 });
  const g = await call('GET', '/api/v1/links?epoch=3');
  assert.equal(g.status, 409);

  const ok = await call('POST', LINKS_SYNC, { upserts: [LINK_ITEM], deletes: [], epoch: 2 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.epoch, 2);
  assert.equal(server.linkCount(), 1);
  assert.equal((await call('GET', '/api/v1/links?epoch=2')).status, 200);
});

test('EPM 刪雲端讓 epoch +1（links 與 marks 共用），回應鍵集合不變；epoch 依 userId 各算各的', async () => {
  const { server, call } = mockHarness();
  const del = await call(CLOUD_DATA_CONTRACT.method, CLOUD_DATA_CONTRACT.path);
  assert.equal(del.status, 200);
  assert.deepEqual(Object.keys(del.body).sort(), ['ok', CLOUD_DATA_CONTRACT.revokedKey].sort(), '刪雲端回應不加欄');
  assert.equal(server.epoch.value(), 1);
  const token = server.grantToken('tok-epm-2');
  const post = (path) =>
    server
      .fetch(API + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ upserts: [], deletes: [] }),
      })
      .then((res) => res.json());
  assert.equal((await post(LINKS_SYNC)).epoch, 1);
  assert.equal((await post(MARKS_SYNC)).epoch, 1, 'marks 與 links 同一個值');
  server.setUser({ id: 'user-other' });
  assert.equal(server.epoch.value(), 0, '換使用者從 0 起');
  assert.equal(server.epoch.value('user-abc'), 1);
});

test('EPM 舊後端模式 report(false)：回應不帶 epoch，請求帶了也不校驗', async () => {
  const { server, call } = mockHarness();
  server.epoch.set(4).report(false);
  const r = await call('POST', LINKS_SYNC, { upserts: [LINK_ITEM], deletes: [], epoch: 99 });
  assert.equal(r.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(r.body, 'epoch'), false);
  assert.equal(server.linkCount(), 1);
  const g = await call('GET', '/api/v1/links?epoch=bad');
  assert.equal(g.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(g.body, 'epoch'), false);
});

test('EPM validate(false)：回應照樣帶 epoch，但不校驗請求', async () => {
  const { server, call } = mockHarness();
  server.epoch.set(5).validate(false);
  const r = await call('POST', LINKS_SYNC, { upserts: [], deletes: [], epoch: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.epoch, 5);
});

test('EPM GET /api/v1/marks 不在契約三端點之列：query epoch 不校驗、回應不帶', async () => {
  const { server, call } = mockHarness();
  server.epoch.set(2);
  const r = await call('GET', '/api/v1/marks?limit=10&epoch=9');
  assert.equal(r.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(r.body, 'epoch'), false);
});
