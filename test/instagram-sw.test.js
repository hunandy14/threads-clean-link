// test/instagram-sw.test.js — 0.12.0 車道 A 的 A2（背景）與 A3（同步）：
// Instagram 貼文複製後能寫歷史、能同步雲端，且**對 Instagram 零背景請求**。
//
// A2：
//   - handleCleanedNotice 對 Instagram cleanUrl 放行寫歷史（kind 'icon'）。
//   - sw-og 對非 threads host 一律不 fetch（host 白名單只允許 threads.com／
//     threads.net），Instagram 直接回 null 欄位。fetch spy 斷言 0 次呼叫。
//   - 歷史去重走 postKeyOf：/p/X/ 與 /reel/X/ 同一張卡，url 取較新那次。
//   - 警示（sw-scam）是 Threads 專屬：Instagram 網址不得進 scamBlocklist，
//     Instagram 的 cleanedNotice 不得觸發任何 scam 路徑。
// A3：
//   - isUploadable／acceptIncomingItem／repairMergedEntry 放行 Instagram：上行
//     進 outbox、下行被接受並落地。
//   - marks 同步不得送出任何 instagram 字樣。
//
// fetch 與 chrome.* 全程替身，不發任何真實網路請求。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');
const { loadSync, createSyncEnv, signedInState: baseSignedInState } = require('./support/sync-env');
const { postKeyOf } = require('../tcl-core.js');

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 150 });
test.beforeEach(reset);

const EXT_ID = 'test-extension-id';
const OWN_SENDER = { id: EXT_ID };

const IG_P = 'https://www.instagram.com/p/Db44wsMgVBI/';
const IG_REEL = 'https://www.instagram.com/reel/Db44wsMgVBI/';
const IG_ORIGINAL = IG_P + '?igsh=xyz&utm_source=a';
const THREADS_POST = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';

const NO_OG_HTML = '<html><head></head><body></body></html>';

// ---- SW 沙箱 ----

function makeSw() {
  const storage = createChromeStorage({ saveHistory: true });
  const onMessageListeners = [];
  const fetchCalls = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
      id: EXT_ID,
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1 },
    storage: storage.api,
  };
  const fetchImpl = async (url, init) => {
    fetchCalls.push(String(url));
    return { url: String(url), text: async () => NO_OG_HTML };
  };
  const sandbox = loadSwSources({
    chrome,
    fetch: fetchImpl,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
  });
  return {
    storage,
    fetchCalls,
    sandbox,
    global(name) {
      return vm.runInContext(name, sandbox);
    },
    sendCleanedNotice(message) {
      onMessageListeners.slice().forEach((fn) => fn(Object.assign({ type: 'cleanedNotice' }, message), OWN_SENDER, () => {}));
    },
    history() {
      return storage.localSnapshot().history || [];
    },
  };
}

function instagramFetches(calls) {
  return calls.filter((u) => /instagram/i.test(u));
}

// ============================================================================
// A2 — handleCleanedNotice 放行 Instagram
// ============================================================================

test('A2-1 cleanedNotice：Instagram cleanUrl（kind icon）寫入一筆歷史', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: IG_P, kind: 'icon' });
  await settle();

  const history = sw.history();
  assert.equal(history.length, 1, 'Instagram 貼文必須寫進歷史');
  assert.equal(history[0].url, IG_P);
  assert.equal(history[0].kind, 'icon');
  assert.equal(history[0].postKey, 'instagram:Db44wsMgVBI');
});

test('A2-2 cleanedNotice：Instagram 的 original 與 removedParams（{key,value}）原樣入庫', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({
    cleanUrl: IG_P,
    kind: 'icon',
    original: IG_ORIGINAL,
    removedParams: [
      { key: 'igsh', value: 'xyz' },
      { key: 'utm_source', value: 'a' },
    ],
  });
  await settle();

  const e = sw.history()[0];
  assert.ok(e, '前置：必須寫入');
  assert.equal(e.original, IG_ORIGINAL);
  assert.deepEqual(e.removedParams, [
    { key: 'igsh', value: 'xyz' },
    { key: 'utm_source', value: 'a' },
  ]);
});

test('A2-3 cleanedNotice：Instagram 非貼文（個人頁）或帶 query 的 cleanUrl 一律不寫', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: 'https://www.instagram.com/some.profile/', kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: IG_ORIGINAL, kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: 'https://www.instagram.com/someone/p/Db44wsMgVBI/', kind: 'icon' });
  await settle();
  assert.equal(sw.storage.localSnapshot().history, undefined, '不乾淨的 cleanUrl 不得留下紀錄');
  assert.equal(instagramFetches(sw.fetchCalls).length, 0);
});

test('A2-4 diffRemovedParams：Instagram 原網址對乾淨網址回報全部追蹤參數（{key,value} 形狀）', () => {
  const sw = makeSw();
  const diff = sw.global('diffRemovedParams');
  assert.deepEqual(JSON.parse(JSON.stringify(diff(IG_ORIGINAL, IG_P))), [
    { key: 'igsh', value: 'xyz' },
    { key: 'utm_source', value: 'a' },
  ]);
});

// ============================================================================
// A2 — sw-og 對 Instagram 零請求
// ============================================================================

test('A2-5 cleanedNotice：Instagram 落盤全程 fetch 0 次（og 補強不得打 Instagram）', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: IG_P, kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: IG_REEL, kind: 'strip' });
  sw.sendCleanedNotice({ cleanUrl: IG_P, kind: 'share' });
  await settle(2700);

  assert.equal(sw.history().length, 1, '前置：Instagram 必須真的走到落盤（否則 0 次是假綠燈）');
  assert.deepEqual(sw.fetchCalls, [], 'Instagram 路徑不得發出任何 fetch');
});

test('A2-6 fetchOgFieldsForLocalKind：Instagram（含 m／無 www）直接回 null、fetch 0 次；Threads 對照組照常 fetch', async () => {
  const sw = makeSw();
  const fetchOg = sw.global('fetchOgFieldsForLocalKind');
  for (const url of [IG_P, IG_REEL, 'https://instagram.com/p/ABC', 'https://m.instagram.com/reel/ABC/']) {
    assert.equal(await fetchOg(url), null, `${url} 應直接回 null`);
  }
  assert.deepEqual(sw.fetchCalls, [], 'Instagram 不得 fetch');

  await fetchOg(THREADS_POST);
  assert.deepEqual(sw.fetchCalls, [THREADS_POST], '對照組：Threads 照常補一次 og fetch（證明 spy 有接上）');
});

test('A2-7 fetchOgFieldsForLocalKind：host 白名單只認 threads.com／threads.net，其他任何網域都不 fetch', async () => {
  const sw = makeSw();
  const fetchOg = sw.global('fetchOgFieldsForLocalKind');
  for (const url of [
    'https://www.facebook.com/someone/posts/123',
    'https://evil.example/@u/post/ID',
    'https://www.threads.com.evil.example/@u/post/ID',
    'https://threads.net.evil.example/@u/post/ID',
  ]) {
    assert.equal(await fetchOg(url), null, `${url} 應直接回 null`);
  }
  assert.deepEqual(sw.fetchCalls, [], '白名單外的 host 一律不 fetch');

  await fetchOg('https://threads.net/@u/post/ABC');
  assert.equal(sw.fetchCalls.length, 1, 'threads.net 在白名單內');
});

// ============================================================================
// A2 — 歷史去重走 postKeyOf
// ============================================================================

test('A2-8 去重：/p/X/ 與 /reel/X/ 合成同一張卡，url 取較新那次、seen 累計兩筆', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: IG_P, kind: 'icon' });
  await settle();
  sw.sendCleanedNotice({ cleanUrl: IG_REEL, kind: 'icon' });
  await settle();

  const history = sw.history();
  assert.equal(history.length, 1, '同一個 shortcode 只能有一張卡');
  assert.equal(history[0].url, IG_REEL, 'cleaned 取較新那次');
  assert.equal(history[0].postKey, 'instagram:Db44wsMgVBI');
  assert.equal(history[0].seen.length, 2);
});

test('A2-9 去重：Instagram 與 Threads 同字串代碼不互相合併（站別前綴隔開）', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: 'https://www.instagram.com/p/DbezfB0gYvP/', kind: 'icon' });
  await settle();
  sw.sendCleanedNotice({ cleanUrl: THREADS_POST, kind: 'icon' });
  await settle();
  assert.equal(sw.history().length, 2);
});

// ============================================================================
// A2 — 警示是 Threads 專屬
// ============================================================================

test('A2-10 Instagram cleanedNotice 不觸發任何 scam 路徑：scamBlocklist 不被寫、不打任何作者 id 請求', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: IG_P, kind: 'icon', author: 'Someone', handle: 'someone', excerpt: '加 LINE：ab12cd 拉你進群組' });
  await settle(2700);

  assert.equal(sw.history().length, 1, '前置：Instagram 必須真的落盤');
  assert.equal(sw.storage.localSnapshot().scamBlocklist, undefined, 'cleanedNotice 不得碰 scamBlocklist');
  assert.deepEqual(sw.fetchCalls, []);
});

test('A2-11 handleScamHit：postUrl 是 Instagram 時拒收（bad_request），不 fetch、不寫名單', async () => {
  const sw = makeSw();
  const handleScamHit = sw.global('handleScamHit');
  const res = await handleScamHit({ handle: 'someone', postUrl: IG_P, snippet: '加 LINE：ab12cd', at: Date.now() - 1000 });
  await settle();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad_request');
  assert.deepEqual(sw.fetchCalls, [], 'Instagram 貼文不得觸發匿名取作者 id');
  assert.equal(sw.storage.localSnapshot().scamBlocklist, undefined);
});

test('A2-12 validateScamHit：anchorPostUrl／threadUrl 是 Instagram 時整筆拒收', () => {
  const sw = makeSw();
  const validate = sw.global('validateScamHit');
  const base = { handle: 'someone', postUrl: THREADS_POST, snippet: 's', at: 1, userId: '1001' };
  assert.ok(validate(base), '對照組：Threads 合法 payload 收下');
  assert.equal(validate(Object.assign({}, base, { anchorPostUrl: IG_P })), null);
  assert.equal(validate(Object.assign({}, base, { threadUrl: IG_REEL })), null);
});

// ============================================================================
// A3 — 同步放行 Instagram
// ============================================================================

const T0 = 1_700_000_000_000;

async function syncSettle(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function igEntry(over = {}) {
  const at = T0 - 60_000;
  return Object.assign(
    {
      id: 'loc-ig',
      url: IG_REEL,
      postKey: postKeyOf(IG_REEL),
      original: IG_REEL + '?igsh=xyz&utm_source=a',
      kind: 'icon',
      at,
      receivedAt: at,
      author: 'Someone',
      handle: 'someone',
      excerpt: '一段摘要',
      removedParams: [
        { key: 'igsh', value: 'xyz' },
        { key: 'utm_source', value: 'a' },
      ],
      seen: [{ at, kind: 'icon' }],
      dirty: true,
      serverUpdatedAt: null,
      deletedAt: null,
    },
    over
  );
}

test('A3-1 上行：Instagram 條目進 outbox，item 欄位齊全（id／cleaned／original／receivedAt／author／handle／excerpt／removedParams／seen）', async () => {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history: [igEntry()] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const upserts = [];
  env.syncPosts().forEach((r) => (r.body.upserts || []).forEach((u) => upserts.push(u)));
  const item = upserts.find((u) => u.id === 'loc-ig');
  assert.ok(item, 'Instagram 條目必須上傳');
  assert.equal(item.cleaned, IG_REEL, 'cleaned 原樣（尾斜線保留）');
  assert.equal(item.original, IG_REEL + '?igsh=xyz&utm_source=a');
  assert.equal(item.receivedAt, T0 - 60_000);
  assert.equal(item.author, 'Someone');
  assert.equal(item.handle, 'someone');
  assert.equal(item.excerpt, '一段摘要');
  assert.deepEqual(item.removedParams, [
    { key: 'igsh', value: 'xyz' },
    { key: 'utm_source', value: 'a' },
  ]);
  assert.equal(item.seen.length, 1);
  assert.equal(item.seen[0].source, 'clipboard', 'kind icon 依 D4 映射為 clipboard');
  assert.equal('kind' in item, false);

  const e = env.storage.history()[0];
  assert.equal(e.dirty, false, 'ack 後清 dirty（沒卡在 outbox 活鎖）');
});

test('A3-2 下行：雲端的 Instagram 項目被接受並落地（url 原樣、postKey 為 instagram:<code>）', async () => {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history: [] });
  env.server.seed([
    {
      id: 'srv-ig',
      original: IG_P + '?igsh=1',
      cleaned: IG_P,
      receivedAt: T0 - 200_000,
      author: 'From Phone',
      seen: [{ at: T0 - 200_000, source: 'share' }],
    },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const list = env.storage.history();
  const e = list.find((x) => x.id === 'srv-ig');
  assert.ok(e, '下行的 Instagram 項目必須落地');
  assert.equal(e.url, IG_P);
  assert.equal(e.postKey, 'instagram:Db44wsMgVBI');
  assert.equal(e.author, 'From Phone');
});

test('A3-3 下行合併：本機 /p/X/ 與雲端 /reel/X/ 是同一張卡（postKey 相同）', async () => {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history: [igEntry({ id: 'loc-ig', url: IG_P, postKey: postKeyOf(IG_P), dirty: false, serverUpdatedAt: T0 - 500_000 })] });
  env.server.seed([{ id: 'loc-ig', original: IG_REEL, cleaned: IG_REEL, receivedAt: T0 - 200_000, seen: [{ at: T0 - 200_000 }] }]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const list = env.storage.history().filter((x) => x.deletedAt == null);
  assert.equal(list.length, 1, '同一個 shortcode 不得分裂成兩張卡');
  assert.equal(list[0].postKey, 'instagram:Db44wsMgVBI');
  assert.notEqual(list[0].serverUpdatedAt, T0 - 500_000, '雲端那一版必須真的套用到本機卡（不是原封未動）');
});

// ---- marks 不得送 instagram ----

function marksSignedInState(over = {}) {
  return baseSignedInState(Object.assign({ marksCursor: null, marksEvicted: null, marksBackfillCursor: null }, over));
}

test('A3-4 marks 上行：證據夾 Instagram 網址時，送出的 marks 全是 threads: 鍵、payload 不含 instagram', async () => {
  const TCLSync = loadSync();
  const DAY = 24 * 60 * 60 * 1000;
  const env = createSyncEnv(
    {
      signedIn: true,
      scamGuardEnabled: true,
      blocklist: {
        version: 2,
        handleIndex: { alice: '1001' },
        entries: {
          1001: {
            state: 'active',
            handle: 'alice',
            source: 'auto',
            addedAt: T0 - 5 * DAY,
            updatedAt: T0 - 3 * DAY,
            dirty: true,
            dirtyAt: T0 - 3 * DAY,
            evidence: [
              { postUrl: THREADS_POST, snippet: 's', at: T0 - 4 * DAY, threadUrl: IG_P },
              { postUrl: IG_P, anchorPostUrl: IG_REEL, snippet: 's', at: T0 - 3 * DAY },
            ],
          },
        },
      },
    },
    { storage: { deepClone: true }, alarms: { stateful: false }, auth: { payloadName: null, payloadPicture: null }, signedInState: marksSignedInState }
  );
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const posts = env.server.requestsTo('/api/v1/marks/sync', 'POST');
  assert.ok(posts.length >= 1, '前置：marks 必須真的推送（否則斷言是假綠燈）');
  posts.forEach((req) => {
    ((req.body && req.body.upserts) || []).forEach((mark) => {
      assert.ok(String(mark.key).startsWith('threads:'), `mark key 必須是 threads:*，實得 ${mark.key}`);
    });
    assert.equal(JSON.stringify(req.body).indexOf('instagram'), -1, 'marks payload 不得出現 instagram');
  });
});
