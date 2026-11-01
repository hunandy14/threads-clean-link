// test/facebook-sw.test.js — 0.13.0 車道 A 的 A2（removedParams）與 A3（背景／同步）：
// Facebook 貼文複製後能寫歷史、能同步雲端，且**對 Facebook 零背景請求**。
//
// A2：
//   - diffRemovedParams 對 Facebook 原網址與乾淨網址只回報被剝掉的鍵（{key,value}），
//     保留的參數（fbid、set、story_fbid、id…）不出現。
// A3：
//   - handleCleanedNotice 對 Facebook cleanUrl（含 photo 的 ?fbid= 與保留參數）放行
//     寫歷史，postKey 為 facebook:<id>；不乾淨或不支援的 Facebook 網址不寫。
//   - sw-og 不對 Facebook fetch（fetch spy 0 次）。
//   - 歷史去重走 postKeyOf：同一個 id 的不同網址合成一張卡；站別前綴隔開同字串 id。
//   - 警示是 Threads 專屬：Facebook 網址不得進 scamBlocklist。
//   - 同步：Facebook 條目上行進 outbox、下行被接受並落地；marks 不送 facebook 字樣。
//
// fetch 與 chrome.* 全程替身，不發任何真實網路請求。測試資料的帳號名與 id 皆為假值。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');
const { loadSync, createSyncEnv, signedInState: baseSignedInState } = require('./support/sync-env');
const C = require('../tcl-core.js');

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 150 });
test.beforeEach(reset);

const EXT_ID = 'test-extension-id';
const OWN_SENDER = { id: EXT_ID };

const ID = '100000000000001';
const GID = '100000000000002';
const PHID = '100000000000003';
const PFBID = 'pfbid0FXAAAbbbCCCdddEEEfff';
const FB_POST = `https://www.facebook.com/fx_user_a/posts/${PFBID}`;
const FB_POST_ORIGINAL = FB_POST + '?fbclid=IwAR0fake&mibextid=fakeMib';
const FB_REEL = `https://www.facebook.com/reel/${ID}`;
const FB_VIDEO = `https://www.facebook.com/fx_page_b/videos/${ID}/`;
const FB_PHOTO = `https://www.facebook.com/photo/?fbid=${PHID}&set=a.${GID}`;
const FB_PHOTO_ORIGINAL = FB_PHOTO + '&fbclid=x&utm_source=y';
const THREADS_POST = 'https://www.threads.com/@usera/post/DbezfB0gYvP';

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
  const fetchImpl = async (url) => {
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

// 跨 realm 物件先 JSON 複製成本 realm 再深比對。
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

// ============================================================================
// A2 — removedParams
// ============================================================================

test('A2-1 diffRemovedParams：Facebook 貼文原網址對乾淨網址回報被剝的追蹤參數（{key,value}）', () => {
  const sw = makeSw();
  const diff = sw.global('diffRemovedParams');
  assert.deepEqual(plain(diff(FB_POST_ORIGINAL, FB_POST)), [
    { key: 'fbclid', value: 'IwAR0fake' },
    { key: 'mibextid', value: 'fakeMib' },
  ]);
});

test('A2-2 diffRemovedParams：相片頁保留的 fbid／set 不列入，只回報被剝的鍵', () => {
  const sw = makeSw();
  const diff = sw.global('diffRemovedParams');
  assert.equal(C.normalizePostUrl(FB_PHOTO_ORIGINAL), FB_PHOTO, '前置：normalize 只剝追蹤參數');
  assert.deepEqual(plain(diff(FB_PHOTO_ORIGINAL, FB_PHOTO)), [
    { key: 'fbclid', value: 'x' },
    { key: 'utm_source', value: 'y' },
  ]);
});

test('A2-3 diffRemovedParams：permalink.php 的 story_fbid／id 保留，notif_* 與 refsrc 回報', () => {
  const sw = makeSw();
  const diff = sw.global('diffRemovedParams');
  const clean = `https://www.facebook.com/permalink.php?story_fbid=${ID}&id=${GID}`;
  const original = `${clean}&refsrc=x&notif_id=1&notif_t=feedback`;
  assert.equal(C.normalizePostUrl(original), clean, '前置：normalize 只剝追蹤參數');
  assert.deepEqual(plain(diff(original, clean)), [
    { key: 'refsrc', value: 'x' },
    { key: 'notif_id', value: '1' },
    { key: 'notif_t', value: 'feedback' },
  ]);
});

test('A2-5 diffRemovedParams：大寫鍵名照原拼法回報；無值的鍵回報空字串', () => {
  const sw = makeSw();
  const diff = sw.global('diffRemovedParams');
  assert.equal(C.normalizePostUrl(FB_POST + '?FBCLID=x'), FB_POST, '前置：大寫鍵名同樣被剝');
  assert.deepEqual(plain(diff(FB_POST + '?FBCLID=x', FB_POST)), [{ key: 'FBCLID', value: 'x' }]);
  assert.deepEqual(plain(diff(FB_POST + '?fbclid', FB_POST)), [{ key: 'fbclid', value: '' }]);
});

test('A2-4 cleanedNotice：Facebook 的 original 與 removedParams（{key,value}）原樣入庫', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({
    cleanUrl: FB_POST,
    kind: 'icon',
    original: FB_POST_ORIGINAL,
    removedParams: [
      { key: 'fbclid', value: 'IwAR0fake' },
      { key: 'mibextid', value: 'fakeMib' },
    ],
  });
  await settle();

  const e = sw.history()[0];
  assert.ok(e, '前置：必須寫入');
  assert.equal(e.original, FB_POST_ORIGINAL);
  assert.deepEqual(plain(e.removedParams), [
    { key: 'fbclid', value: 'IwAR0fake' },
    { key: 'mibextid', value: 'fakeMib' },
  ]);
});

// ============================================================================
// A3 — handleCleanedNotice 放行 Facebook
// ============================================================================

const WRITE_CASES = [
  ['A3-1a', FB_POST, `facebook:${PFBID}`],
  ['A3-1b', FB_REEL, `facebook:${ID}`],
  ['A3-1c', FB_PHOTO, `facebook:${PHID}`],
  ['A3-1d', FB_VIDEO, `facebook:${ID}`],
  ['A3-1e', `https://www.facebook.com/permalink.php?story_fbid=${ID}&id=${GID}`, `facebook:${ID}`],
];

for (const [no, url, key] of WRITE_CASES) {
  test(`${no} cleanedNotice：Facebook cleanUrl（kind icon）寫入一筆歷史，postKey ${key}：${url}`, async () => {
    const sw = makeSw();
    sw.sendCleanedNotice({ cleanUrl: url, kind: 'icon' });
    await settle();

    const history = sw.history();
    assert.equal(history.length, 1, 'Facebook 貼文必須寫進歷史');
    assert.equal(history[0].url, url, 'url 原樣（保留參數與尾斜線不動）');
    assert.equal(history[0].kind, 'icon');
    assert.equal(history[0].postKey, key);
  });
}

test('A3-2 cleanedNotice：不乾淨（帶追蹤參數、http）或不支援的 Facebook 網址一律不寫', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: FB_POST_ORIGINAL, kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: FB_POST.replace('https:', 'http:'), kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: `https://m.facebook.com/fx_user_a/posts/${ID}`, kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: `https://www.facebook.com/groups/${GID}/permalink/${ID}/`, kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: 'https://www.facebook.com/share/p/AbC123fake/', kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: 'https://fb.watch/AbC123fake/', kind: 'icon' });
  await settle();
  assert.equal(sw.storage.localSnapshot().history, undefined, '不乾淨的 cleanUrl 不得留下紀錄');
  assert.deepEqual(sw.fetchCalls, []);
});

// ============================================================================
// A3 — sw-og 對 Facebook 零請求
// ============================================================================

test('A3-3 cleanedNotice：Facebook 落盤全程 fetch 0 次（og 補強不得打 Facebook）', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: FB_POST, kind: 'icon' });
  sw.sendCleanedNotice({ cleanUrl: FB_REEL, kind: 'strip' });
  sw.sendCleanedNotice({ cleanUrl: FB_PHOTO, kind: 'share' });
  await settle(2700);

  assert.equal(sw.history().length, 3, '前置：Facebook 必須真的走到落盤（否則 0 次是假綠燈）');
  assert.deepEqual(sw.fetchCalls, [], 'Facebook 路徑不得發出任何 fetch');
});

test('A3-4 fetchOgFieldsForLocalKind：Facebook 各頁型直接回 null、fetch 0 次；Threads 對照組照常 fetch', async () => {
  const sw = makeSw();
  const fetchOg = sw.global('fetchOgFieldsForLocalKind');
  for (const url of [FB_POST, FB_REEL, FB_PHOTO, FB_VIDEO, `https://facebook.com/reel/${ID}`]) {
    assert.equal(await fetchOg(url), null, `${url} 應直接回 null`);
  }
  assert.deepEqual(sw.fetchCalls, [], 'Facebook 不得 fetch');

  await fetchOg(THREADS_POST);
  assert.deepEqual(sw.fetchCalls, [THREADS_POST], '對照組：Threads 照常補一次 og fetch（證明 spy 有接上）');
});

test('A3-5 isOgFetchableUrl：Facebook 網址一律 false', () => {
  const sw = makeSw();
  const isOgFetchableUrl = sw.global('isOgFetchableUrl');
  for (const url of [FB_POST, FB_REEL, FB_PHOTO, FB_VIDEO]) {
    assert.equal(isOgFetchableUrl(url), false, url);
  }
  assert.equal(isOgFetchableUrl(THREADS_POST), true, '對照組');
});

// ============================================================================
// A3 — 歷史去重走 postKeyOf
// ============================================================================

test('A3-6 去重：同一個 id 的 /videos/<id>/ 與 /reel/<id> 合成同一張卡，url 取較新那次、seen 累計兩筆', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: FB_VIDEO, kind: 'icon' });
  await settle();
  sw.sendCleanedNotice({ cleanUrl: FB_REEL, kind: 'icon' });
  await settle();

  const history = sw.history();
  assert.equal(history.length, 1, '同一個 id 只能有一張卡');
  assert.equal(history[0].url, FB_REEL, 'cleaned 取較新那次');
  assert.equal(history[0].postKey, `facebook:${ID}`);
  assert.equal(history[0].seen.length, 2);
});

test('A3-7 去重：Facebook 與 Instagram／Threads 不互相合併（站別前綴隔開）', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: FB_REEL, kind: 'icon' });
  await settle();
  sw.sendCleanedNotice({ cleanUrl: 'https://www.instagram.com/p/Db44wsMgVBI/', kind: 'icon' });
  await settle();
  sw.sendCleanedNotice({ cleanUrl: THREADS_POST, kind: 'icon' });
  await settle();
  assert.equal(sw.history().length, 3);
});

// ============================================================================
// A3 — 警示是 Threads 專屬
// ============================================================================

test('A3-8 Facebook cleanedNotice 不觸發任何 scam 路徑：scamBlocklist 不被寫、不打任何請求', async () => {
  const sw = makeSw();
  sw.sendCleanedNotice({ cleanUrl: FB_POST, kind: 'icon', author: 'Fake Person', handle: 'fx_user_a', excerpt: '加 LINE：ab12cd 拉你進群組' });
  await settle(2700);

  assert.equal(sw.history().length, 1, '前置：Facebook 必須真的落盤');
  assert.equal(sw.storage.localSnapshot().scamBlocklist, undefined, 'cleanedNotice 不得碰 scamBlocklist');
  assert.deepEqual(sw.fetchCalls, []);
});

test('A3-9 handleScamHit：postUrl 是 Facebook 時拒收（bad_request），不 fetch、不寫名單', async () => {
  const sw = makeSw();
  const handleScamHit = sw.global('handleScamHit');
  const res = await handleScamHit({ handle: 'fx_user_a', postUrl: FB_POST, snippet: '加 LINE：ab12cd', at: Date.now() - 1000 });
  await settle();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad_request');
  assert.deepEqual(sw.fetchCalls, []);
  assert.equal(sw.storage.localSnapshot().scamBlocklist, undefined);
});

// ============================================================================
// A3 — 同步放行 Facebook
// ============================================================================

const T0 = 1_700_000_000_000;

async function syncSettle(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fbEntry(over = {}) {
  const at = T0 - 60_000;
  return Object.assign(
    {
      id: 'loc-fb',
      url: FB_PHOTO,
      postKey: C.postKeyOf(FB_PHOTO),
      original: FB_PHOTO_ORIGINAL,
      kind: 'icon',
      at,
      receivedAt: at,
      author: 'Fake Person',
      handle: 'fx_user_a',
      excerpt: '一段摘要',
      removedParams: [
        { key: 'fbclid', value: 'x' },
        { key: 'utm_source', value: 'y' },
      ],
      seen: [{ at, kind: 'icon' }],
      dirty: true,
      serverUpdatedAt: null,
      deletedAt: null,
    },
    over
  );
}

test('A3-10 toSyncItem／fromSyncItem：Facebook 相片條目的 cleaned 保留 ?fbid=&set=，回程 postKey 為 facebook:<id>', () => {
  const item = C.toSyncItem({
    id: 'fb-1',
    url: FB_PHOTO,
    original: FB_PHOTO_ORIGINAL,
    receivedAt: 1000,
    removedParams: [
      { key: 'fbclid', value: 'x' },
      { key: 'utm_source', value: 'y' },
    ],
    seen: [{ at: 1000, kind: 'icon' }],
  });
  assert.equal(item.cleaned, FB_PHOTO);
  assert.equal(item.original, FB_PHOTO_ORIGINAL);
  const back = C.fromSyncItem(Object.assign({ updatedAt: 2000 }, item), null);
  assert.equal(back.url, FB_PHOTO);
  assert.equal(back.postKey, `facebook:${PHID}`);
});

test('A3-11 上行：Facebook 條目進 outbox，item 欄位齊全且 ack 後清 dirty', async () => {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history: [fbEntry()] });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const upserts = [];
  env.syncPosts().forEach((r) => (r.body.upserts || []).forEach((u) => upserts.push(u)));
  const item = upserts.find((u) => u.id === 'loc-fb');
  assert.ok(item, 'Facebook 條目必須上傳');
  assert.equal(item.cleaned, FB_PHOTO, 'cleaned 原樣（保留參數不動）');
  assert.equal(item.original, FB_PHOTO_ORIGINAL);
  assert.equal(item.receivedAt, T0 - 60_000);
  assert.equal(item.author, 'Fake Person');
  assert.equal(item.handle, 'fx_user_a');
  assert.equal(item.excerpt, '一段摘要');
  assert.deepEqual(item.removedParams, [
    { key: 'fbclid', value: 'x' },
    { key: 'utm_source', value: 'y' },
  ]);
  assert.equal(item.seen.length, 1);

  const e = env.storage.history()[0];
  assert.equal(e.dirty, false, 'ack 後清 dirty（沒卡在 outbox 活鎖）');
});

test('A3-12 下行：雲端的 Facebook 項目被接受並落地（url 為正規化結果、postKey 為 facebook:<id>）', async () => {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history: [] });
  env.server.seed([
    {
      id: 'srv-fb',
      original: FB_POST_ORIGINAL,
      cleaned: FB_POST,
      receivedAt: T0 - 200_000,
      author: 'From Phone',
      seen: [{ at: T0 - 200_000, source: 'share' }],
    },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const e = env.storage.history().find((x) => x.id === 'srv-fb');
  assert.ok(e, '下行的 Facebook 項目必須落地');
  assert.equal(e.url, FB_POST);
  assert.equal(e.postKey, `facebook:${PFBID}`);
  assert.equal(e.author, 'From Phone');
});

test('A3-13 下行：雲端 cleaned 仍帶追蹤參數的 Facebook 項目，落地時 url 正規化（剝參、保留 fbid）', async () => {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history: [] });
  env.server.seed([
    {
      id: 'srv-fb-dirty',
      original: FB_PHOTO_ORIGINAL,
      cleaned: FB_PHOTO_ORIGINAL,
      receivedAt: T0 - 200_000,
      seen: [{ at: T0 - 200_000, source: 'share' }],
    },
  ]);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();

  const e = env.storage.history().find((x) => x.id === 'srv-fb-dirty');
  assert.ok(e, '下行的 Facebook 項目必須落地');
  assert.equal(e.url, FB_PHOTO);
  assert.equal(e.postKey, `facebook:${PHID}`);
});

// ---- marks 不得送 facebook ----

function marksSignedInState(over = {}) {
  return baseSignedInState(Object.assign({ marksCursor: null, marksEvicted: null, marksBackfillCursor: null }, over));
}

test('A3-14 marks 上行：證據夾 Facebook 網址時，送出的 marks 全是 threads: 鍵、payload 不含 facebook', async () => {
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
              { postUrl: THREADS_POST, snippet: 's', at: T0 - 4 * DAY, threadUrl: FB_POST },
              { postUrl: FB_POST, anchorPostUrl: FB_REEL, snippet: 's', at: T0 - 3 * DAY },
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
    assert.equal(JSON.stringify(req.body).indexOf('facebook'), -1, 'marks payload 不得出現 facebook');
  });
});
