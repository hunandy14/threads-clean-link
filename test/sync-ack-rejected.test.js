// test/sync-ack-rejected.test.js — 0.11.1 修正車道②：ack 版本比對補齊三個缺口
// （審查 PR #73 的 D2、D3、D4）。
//
// R1（D3）：links ack 的 rejectedIds 分支也要比對切批快照版本。伺服器以「早於
//   雲端墓碑」拒收送出的那一版，但往返期間使用者又複製了同一篇（at 前進，復
//   活意圖），回應落地時必須保持 dirty，下一輪送出最新內容；版本未變才清。
// R2（D2）：版本指紋要涵蓋 options 匯入合併（mergeSamePostEntries）會改到的欄
//   位（receivedAt、author／handle／excerpt／removedParams）。往返期間匯入補上
//   author 與更早的 receivedAt，ack 不得清 dirty，下一輪推出新欄位。
// R3（D4）：刪雲端遠端成功（伺服器清空、epoch +1）但本機帳號鍵寫入失敗回
//   storage_write_failed 之後，下一次成功登入或同步時，雲端不得永遠缺少已 ack
//   過的舊卡與名單。
// R4：回歸保護。正常 ack、正常 rejected（版本未變）照樣清 dirty，請求數不變。
//
// 【延遲 mock】links POST 的替身先讓 mock 伺服器照送出當下的內容處理完，隔一個
// setImmediate 才執行往返期間的本機改動，改動落地後再隔一個 setImmediate 才把
// 回應交還引擎（同 test/sync-ack-version.test.js）。
//
// harness（storage／alarms／auth 替身、makeEnv、settle、延遲替身）逐字取自
// test/sync-ack-version.test.js（其源頭為 test/sync.test.js），修改時需同步。
'use strict';

const test = require('node:test');
// chrome.storage 替身的 setTimeout(0) 落盤與本檔 settle() 的逐輪讓出都走假時
// 間（test/support/settle.js），每一輪不再吃作業系統計時器顆粒。
const fakeClock = require('./support/settle').installSettle();
test.beforeEach(fakeClock.reset);
const assert = require('node:assert/strict');

const { postKeyOf } = require('../tcl-core.js');
const {
  CLOUD_DATA_CONTRACT,
} = require('./helpers/mock-sync-server.js');
const { loadSync, createSyncEnv } = require('./support/sync-env');

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const POST_B = 'https://www.threads.com/@bob/post/BBBBBBBBBBB';
const POST_C = 'https://www.threads.com/@carol/post/CCCCCCCCCCC';

const T0 = 1_700_000_000_000;

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

/**
 * 組一整套注入環境（見 test/support/sync-env.js 的 createSyncEnv）。`opts.signedIn`
 * 為 true 時預先發一枚有效 token 並寫入 syncAuth／syncState，省去每條測試重跑登入往返。
 */
function makeEnv(opts = {}) {
  return createSyncEnv(opts, { storage: { defer: 'timeout' } });
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

function byId(env, id) {
  return env.storage.history().find((e) => e && e.id === id) || null;
}

// ============================================================================
// 車道②專用工具
// ============================================================================

const DAY = 24 * 60 * 60_000;
const MARKS_SYNC_PATH = '/api/v1/marks/sync';

/** 一串 links POST 裡指定 id 的第一筆 upsert（找不到回 null）。 */
function upsertIn(posts, id) {
  for (const p of posts) {
    const up = ((p.body && p.body.upserts) || []).find((u) => u.id === id);
    if (up) return up;
  }
  return null;
}

/** options 匯入合併（mergeSamePostEntries）的效果：補作者資訊與更早的 receivedAt，at 與 seen 不動。 */
function importMerged(patch) {
  return (e) => Object.assign(e, patch, { dirty: true, deletedAt: null });
}

/** v2 scamBlocklist：兩筆都已同步（沒有 dirty），代表「已 ack 過」的名單。 */
function syncedBlocklist() {
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
      evidence: [],
    },
  };
  return { version: 2, entries, handleIndex: { synthetic_a: '7001', synthetic_b: '7002' } };
}

/** 兩筆已 ack（dirty:false）、一筆尚未送出。 */
function ackedHistory() {
  return [
    entry({ id: 'srv-a', url: POST_A, dirty: false, serverUpdatedAt: T0 - 1000 }),
    entry({ id: 'srv-b', url: POST_B, dirty: false, serverUpdatedAt: T0 - 2000 }),
    entry({ id: 'loc-c', url: POST_C, dirty: true, serverUpdatedAt: null }),
  ];
}

/**
 * 讓「下一次」含 syncAuth 的 storage.local.set 失敗一次（resetAccount 的帳號鍵
 * 單次寫入），其餘寫入照常。失敗同樣延遲到下一個 setTimeout(0) 才結算。必須在
 * TCLSync.create 之前呼叫。
 */
function failNextAccountWrite(env) {
  const base = env.deps.storage.local;
  const probe = { failed: 0 };
  let armed = true;
  env.deps.storage = {
    session: env.deps.storage.session,
    local: Object.assign({}, base, {
      set(items) {
        if (armed && Object.prototype.hasOwnProperty.call(items, 'syncAuth')) {
          armed = false;
          probe.failed += 1;
          return new Promise((resolve, reject) => setTimeout(() => reject(new Error('IO error')), 0));
        }
        return base.set(items);
      },
    }),
  };
  return probe;
}

// ============================================================================
// R1（D3）rejectedIds 分支比對版本
// ============================================================================

test('R1 版本已變：送出的舊版被墓碑拒收、往返期間再複製同一篇 → 保持 dirty，下一輪送出最新內容並被收下', async () => {
  const TCLSync = loadSync();
  // 雲端墓碑 T0-30s 晚於本機這一版（T0-60s）→ 拒收；游標已越過墓碑，本輪增量不會把它帶回來。
  const env = makeEnv({
    signedIn: true,
    history: [entry({ id: 'loc-a', url: POST_A })],
    syncState: { cursor: String(T0 - 1000) },
  });
  env.server.seedTombstone(POST_A, 'srv-tomb-a', T0 - 30_000);
  const probe = delayNextLinksPost(env, () => rewriteHistory(env, { 'loc-a': recopied(T0) }));
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.equal(probe.dirtyAtHook['loc-a'], true, '改動須發生在回應落地之前');
  const firstUp = upsertIn(env.syncPosts().slice(0, 1), 'loc-a');
  assert.ok(firstUp, '第一輪應送出 loc-a');
  assert.equal(firstUp.seen.length, 1, '第一輪送的是改動前的版本');
  assert.equal(env.server.linkByPostKey(POST_A), null, '前置：第一輪被墓碑拒收');

  const after = byId(env, 'loc-a');
  assert.ok(after, 'loc-a 應仍在本機');
  assert.equal(after.seen.length, 2, '往返期間追加的 seen 不得被蓋掉');
  assert.equal(after.dirty, true, '版本已變：rejected 不得清掉新改動的 dirty');

  env.advance(60_000);
  const postsBefore = env.syncPosts().length;
  await engine.syncNow();
  await settle();

  const up = upsertIn(env.syncPosts().slice(postsBefore), 'loc-a');
  assert.ok(up, '第二輪 upserts 應含 loc-a');
  assert.equal(up.seen.length, 2, '第二輪送出往返期間改動後的最新內容');
  assert.ok(env.server.linkByPostKey(POST_A), '新版晚於墓碑，雲端收下（復活）');
  assert.equal(byId(env, 'loc-a').dirty, false, '第二輪收下後清乾淨');
});

test('R1 版本未變：送出的那一版被墓碑拒收、往返期間沒動 → 清 dirty，下一輪不再重送', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [entry({ id: 'loc-a', url: POST_A })],
    syncState: { cursor: String(T0 - 1000) },
  });
  env.server.seedTombstone(POST_A, 'srv-tomb-a', T0 - 30_000);
  const probe = delayNextLinksPost(env, async () => {});
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.ok(upsertIn(env.syncPosts().slice(0, 1), 'loc-a'), '第一輪應送出 loc-a');
  assert.equal(env.server.linkByPostKey(POST_A), null, '前置：被墓碑拒收');
  const after = byId(env, 'loc-a');
  assert.ok(after, '拒收的那筆留在本機');
  assert.equal(after.dirty, false, '版本未變：拒收即清 dirty，不無限重試');

  env.advance(60_000);
  const postsBefore = env.syncPosts().length;
  await engine.syncNow();
  await settle();
  assert.equal(upsertIn(env.syncPosts().slice(postsBefore), 'loc-a'), null, '下一輪不得重送被拒的同一版');
});

// ============================================================================
// R2（D2）版本指紋涵蓋匯入合併欄位
// ============================================================================

test('R2 往返期間 options 匯入補上 author 與更早的 receivedAt → ack 不清 dirty，下一輪推出新欄位', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry({ id: 'loc-a', url: POST_A })] });
  const imported = {
    author: 'Alice Imported',
    handle: 'alice',
    excerpt: 'imported excerpt',
    receivedAt: T0 - 120_000,
  };
  const probe = delayNextLinksPost(env, () => rewriteHistory(env, { 'loc-a': importMerged(imported) }));
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.equal(probe.dirtyAtHook['loc-a'], true, '匯入須發生在 ack 落地之前');
  const firstUp = upsertIn(env.syncPosts().slice(0, 1), 'loc-a');
  assert.ok(firstUp, '第一輪應送出 loc-a');
  assert.equal(firstUp.author, undefined, '第一輪送的是匯入前的版本');

  const after = byId(env, 'loc-a');
  assert.equal(after.author, 'Alice Imported', '前置：匯入補上的欄位留在本機');
  assert.equal(after.at, T0 - 60_000, '前置：匯入沒動 at');
  assert.equal(after.seen.length, 1, '前置：匯入沒動 seen 筆數');
  assert.equal(after.dirty, true, '匯入改了會上雲的欄位：ack 不得清 dirty');

  env.advance(60_000);
  const postsBefore = env.syncPosts().length;
  await engine.syncNow();
  await settle();

  const up = upsertIn(env.syncPosts().slice(postsBefore), 'loc-a');
  assert.ok(up, '第二輪 upserts 應含 loc-a');
  assert.equal(up.author, 'Alice Imported', '第二輪推出匯入補上的 author');
  assert.equal(up.handle, 'alice', '第二輪推出匯入補上的 handle');
  assert.equal(up.receivedAt, T0 - 120_000, '第二輪推出更早的 receivedAt');
  assert.equal(byId(env, 'loc-a').dirty, false, '第二輪往返無改動，ack 後清乾淨');
});

// ============================================================================
// R3（D4）刪雲端本機寫入失敗之後，雲端要能重建
// ============================================================================

test('R3 刪雲端遠端成功、帳號鍵寫入失敗、session 已撤 → 同帳號再登入：全部紀錄與名單重新上雲', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: ackedHistory(),
    local: { scamBlocklist: syncedBlocklist(), syncEpoch: { userId: 'user-abc', epoch: 0 } },
  });
  const failed = failNextAccountWrite(env);
  const engine = TCLSync.create(env.deps);

  const result = await engine.deleteCloud();
  await settle();
  assert.equal(failed.failed, 1, '前置：帳號鍵寫入失敗一次');
  assert.equal(result && result.code, 'storage_write_failed', '前置：回 storage_write_failed');
  assert.equal(env.server.requestsTo(CLOUD_DATA_CONTRACT.path, CLOUD_DATA_CONTRACT.method).length, 1);
  assert.equal(env.server.linkCount(), 0, '前置：雲端已清空');

  // 下一次請求撞 401 走過期出口，再以同一帳號登入。
  env.advance(60_000);
  await engine.syncNow();
  await settle();
  env.advance(60_000);
  await engine.signIn();
  await settle();
  env.advance(60_000);
  await engine.syncNow();
  await settle();

  assert.ok(env.server.linkByPostKey(POST_A), 'srv-a（已 ack 過）重新上雲');
  assert.ok(env.server.linkByPostKey(POST_B), 'srv-b（已 ack 過）重新上雲');
  assert.ok(env.server.linkByPostKey(POST_C), 'loc-c 上雲');
  assert.equal(env.server.marks.count(), 2, '名單兩筆（已 ack 過）重新上雲');
});

test('R3 刪雲端遠端成功、帳號鍵寫入失敗、token 仍有效且本機 epoch 未知 → 下一次同步：全部紀錄與名單重新上雲', async () => {
  const TCLSync = loadSync();
  // 本機沒有 syncEpoch（升級後尚未採用），伺服器端 session 撤銷沒生效（token 仍可用）。
  const env = makeEnv({
    signedIn: true,
    history: ackedHistory(),
    local: { scamBlocklist: syncedBlocklist() },
  });
  const failed = failNextAccountWrite(env);
  const engine = TCLSync.create(env.deps);

  const result = await engine.deleteCloud();
  await settle();
  assert.equal(failed.failed, 1, '前置：帳號鍵寫入失敗一次');
  assert.equal(result && result.code, 'storage_write_failed', '前置：回 storage_write_failed');
  assert.equal(env.server.linkCount(), 0, '前置：雲端已清空');
  assert.equal(env.server.epoch.value(), 1, '前置：伺服器 epoch +1');
  env.server.grantToken('tok-seeded');
  assert.equal(env.storage.syncAuth().token, 'tok-seeded', '前置：本機 token 保留且仍有效');

  env.advance(60_000);
  await engine.syncNow();
  await settle();
  env.advance(60_000);
  await engine.syncNow();
  await settle();

  assert.ok(env.server.linkByPostKey(POST_A), 'srv-a（已 ack 過）重新上雲');
  assert.ok(env.server.linkByPostKey(POST_B), 'srv-b（已 ack 過）重新上雲');
  assert.ok(env.server.linkByPostKey(POST_C), 'loc-c 上雲');
  assert.equal(env.server.marks.count(), 2, '名單兩筆（已 ack 過）重新上雲');
});

// ============================================================================
// R4 回歸保護
// ============================================================================

test('R4 同批一筆正常 ack、一筆正常 rejected（版本皆未變）→ 兩筆都清 dirty，請求數不變', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    signedIn: true,
    history: [
      entry({ id: 'loc-a', url: POST_A, at: T0 - 60_000 }),
      entry({ id: 'loc-b', url: POST_B, at: T0 - 60_000 }),
    ],
    syncState: { cursor: String(T0 - 1000) },
  });
  env.server.seedTombstone(POST_B, 'srv-tomb-b', T0 - 30_000);
  const probe = delayNextLinksPost(env, async () => {});
  const engine = TCLSync.create(env.deps);

  await engine.syncNow();
  await settle();

  assert.equal(probe.hookRuns, 1, '延遲替身應攔到一次 links POST');
  assert.equal(env.syncPosts().length, 1, '第一輪只發一個 links POST');
  const sent = env.syncPosts()[0].body.upserts.map((u) => u.id).sort();
  assert.deepEqual(sent, ['loc-a', 'loc-b'], '兩筆同一批送出');
  assert.ok(env.server.linkByPostKey(POST_A), '前置：loc-a 被收下');
  assert.equal(env.server.linkByPostKey(POST_B), null, '前置：loc-b 被墓碑拒收');
  assert.equal(byId(env, 'loc-a').dirty, false, '正常 ack 清 dirty');
  assert.equal(byId(env, 'loc-b').dirty, false, '正常 rejected（版本未變）清 dirty');
  const marksFirst = env.server.requestsTo(MARKS_SYNC_PATH, 'POST').length;

  env.advance(60_000);
  await engine.syncNow();
  await settle();

  assert.equal(env.syncPosts().length, 2, '第二輪仍只發一個 links POST（純拉取）');
  assert.deepEqual(env.syncPosts()[1].body.upserts, [], '第二輪沒有任何重送');
  assert.equal(
    env.server.requestsTo(MARKS_SYNC_PATH, 'POST').length - marksFirst,
    marksFirst,
    'marks POST 每輪數量不變'
  );
});
