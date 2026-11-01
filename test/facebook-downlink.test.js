// test/facebook-downlink.test.js — 0.13.0 車道 D：Facebook 下行項目一律顯示。
//
// 手機 App 接受任何 *.facebook.com／fb.watch 頁面並保留原 host 與 scheme，擴充的
// normalizePostUrl 只收 facebook.com／www 且抽得出 id 的貼文。車道 D 不動
// normalizePostUrl／facebookId／postKeyOf，只在同步下行、讀取與顯示層放寬：
//
//   - tcl-core 新增 isDisplayableFacebookUrl(url)：可解析、http(s)、host 為
//     facebook.com 家族或 fb.watch 家族、無 userinfo、無非預設 port、無控制字元、
//     不超長。不改寫網址。
//   - isAcceptableHistoryUrl(url) = normalizePostUrl(url) !== null ||
//     isDisplayableFacebookUrl(url)。
//   - sync 的 acceptIncomingItem／repairMergedEntry／isUploadable 與 options 的
//     sanitizeEntries／mergeImportedEntries 改用 isAcceptableHistoryUrl。
//   - options 卡片的 Facebook 徽章改為 isFacebookPostUrl || isDisplayableFacebookUrl。
//   - 本機寫入路徑（isCleanPostUrl）維持嚴格，不在本檔範圍。
//
// 頁型代號：F1 可正規化的貼文、F3 社團 permalink、F7 /share/p|v|r 短碼、
// F8 m.／web.／mbasic. 子網域、F9 fb.watch。
//
// fetch 與 chrome.* 全程替身，不發任何真實網路請求。測試資料的帳號名與 id 皆為假值。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createChromeStorage } = require('./support/helpers');
const { makeDocumentStub } = require('./support/options-dom');
const { loadSync, createSyncEnv } = require('./support/sync-env');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));
const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

const ID = '100000000000001';
const GID = '100000000000002';
const PFBID = 'pfbid0FXAAAbbbCCCdddEEEfff';
const CODE = 'AbCdEfGh12';

const F1_POST = `https://www.facebook.com/fx_user_a/posts/${PFBID}`;
const F3_GROUP = `https://www.facebook.com/groups/${GID}/permalink/${ID}/`;
const F7_SHARE_P = `https://www.facebook.com/share/p/${CODE}/`;
const F7_SHARE_V = `https://www.facebook.com/share/v/${CODE}/`;
const F7_SHARE_R = `https://www.facebook.com/share/r/${CODE}/`;
const F8_M = `https://m.facebook.com/fx_user_a/posts/${ID}`;
const F8_WEB = `https://web.facebook.com/fx_user_a/posts/${ID}`;
const F8_MBASIC = `https://mbasic.facebook.com/story.php?story_fbid=${ID}&id=${GID}`;
const F9_WATCH = `https://fb.watch/${CODE}/`;
const HTTP_FB = `http://www.facebook.com/fx_user_a/posts/${PFBID}`;
const EVIL_SUFFIX = `https://facebook.com.evil.com/share/p/${CODE}/`;
const EVIL_PATH = `https://evil.com/facebook.com/share/p/${CODE}/`;
const THREADS_URL = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const IG_URL = 'https://www.instagram.com/p/Db44wsMgVBI/';

// 未實作前以 typeof 守門，讓失敗訊息直接指出缺的是哪個匯出，而不是 TypeError。
function displayable(url) {
  assert.equal(typeof C.isDisplayableFacebookUrl, 'function', 'tcl-core 必須匯出 isDisplayableFacebookUrl');
  return C.isDisplayableFacebookUrl(url);
}

function acceptable(url) {
  assert.equal(typeof C.isAcceptableHistoryUrl, 'function', 'tcl-core 必須匯出 isAcceptableHistoryUrl');
  return C.isAcceptableHistoryUrl(url);
}

function suffix(i) {
  return String.fromCharCode(97 + i);
}

// ============================================================================
// 單元：isDisplayableFacebookUrl／isAcceptableHistoryUrl
// ============================================================================

test('D1-01 tcl-core 匯出 isDisplayableFacebookUrl 與 isAcceptableHistoryUrl', () => {
  assert.equal(typeof C.isDisplayableFacebookUrl, 'function');
  assert.equal(typeof C.isAcceptableHistoryUrl, 'function');
});

const DISPLAYABLE_TRUE = [
  ['F3 社團 permalink', F3_GROUP],
  ['F7 /share/p', F7_SHARE_P],
  ['F7 /share/v', F7_SHARE_V],
  ['F7 /share/r', F7_SHARE_R],
  ['F8 m.', F8_M],
  ['F8 web.', F8_WEB],
  ['F8 mbasic.', F8_MBASIC],
  ['F9 fb.watch', F9_WATCH],
  ['F9 子網域 fb.watch', `https://www.fb.watch/${CODE}/`],
  ['http scheme', HTTP_FB],
  ['無 www 的 facebook.com', 'https://facebook.com/fx_user_a'],
  ['個人頁', 'https://www.facebook.com/fx_user_a'],
  ['帶追蹤參數照樣可顯示', `${F7_SHARE_P}?mibextid=fakeMib`],
  ['host 大寫', `https://WWW.FACEBOOK.COM/share/p/${CODE}/`],
  ['明寫預設 port 443', `https://www.facebook.com:443/share/p/${CODE}/`],
  ['F1 可正規化的貼文', F1_POST],
];

DISPLAYABLE_TRUE.forEach(([label, url], i) => {
  test(`D1-02${suffix(i)} isDisplayableFacebookUrl：${label} → true`, () => {
    assert.equal(displayable(url), true, url);
  });
});

const DISPLAYABLE_FALSE = [
  ['偽冒網域 facebook.com.evil.com', EVIL_SUFFIX],
  ['路徑夾 facebook.com', EVIL_PATH],
  ['同字尾非子網域 evilfacebook.com', `https://evilfacebook.com/share/p/${CODE}/`],
  ['同字尾非子網域 notfb.watch', `https://notfb.watch/${CODE}/`],
  ['fb.com 不在白名單', `https://fb.com/share/p/${CODE}/`],
  ['javascript:', 'javascript:alert(1)//www.facebook.com'],
  ['data:', 'data:text/html,https://www.facebook.com/'],
  ['ftp scheme', `ftp://www.facebook.com/share/p/${CODE}/`],
  ['含換行控制字元', `https://www.facebook.com/share/p/${CODE}/\n`],
  ['含 NUL 控制字元', `https://www.facebook.com/share/\u0000p/${CODE}/`],
  ['帶 userinfo', `https://fx_user_a@www.facebook.com/share/p/${CODE}/`],
  ['帶 userinfo（含密碼）', `https://fx_user_a:pw@www.facebook.com/share/p/${CODE}/`],
  ['非預設 port', `https://www.facebook.com:8443/share/p/${CODE}/`],
  ['無法解析', 'not a url'],
  ['空字串', ''],
  ['超長', `${F7_SHARE_P}?q=${'a'.repeat(10000)}`],
  ['Threads 網址', THREADS_URL],
  ['Instagram 網址', IG_URL],
];

DISPLAYABLE_FALSE.forEach(([label, url], i) => {
  test(`D1-03${suffix(i)} isDisplayableFacebookUrl：${label} → false`, () => {
    assert.equal(displayable(url), false, JSON.stringify(url).slice(0, 120));
  });
});

test('D1-04 isDisplayableFacebookUrl：非字串（null／undefined／數字／物件／陣列／URL 物件）一律 false，不拋錯', () => {
  for (const v of [null, undefined, 123, {}, [], new URL(F7_SHARE_P)]) {
    assert.equal(displayable(v), false, String(v));
  }
});

test('D1-05 isDisplayableFacebookUrl：長度上限以內的 Facebook 網址仍為 true（上限不誤殺一般長度）', () => {
  assert.equal(displayable(`${F7_SHARE_P}?q=${'a'.repeat(400)}`), true);
  // 有匯出 FACEBOOK_URL_MAX 時順帶釘住邊界。
  if (typeof C.FACEBOOK_URL_MAX === 'number') {
    const base = `${F7_SHARE_P}?q=`;
    const atMax = base + 'a'.repeat(C.FACEBOOK_URL_MAX - base.length);
    assert.equal(displayable(atMax), true, '恰等於上限 → true');
    assert.equal(displayable(atMax + 'a'), false, '超過上限一字 → false');
  }
});

test('D1-06 isAcceptableHistoryUrl：Threads／Instagram／F1 → true；isDisplayableFacebookUrl 對 Threads／Instagram 為 false', () => {
  assert.equal(acceptable(THREADS_URL), true);
  assert.equal(acceptable(IG_URL), true);
  assert.equal(acceptable(F1_POST), true);
  assert.equal(displayable(THREADS_URL), false);
  assert.equal(displayable(IG_URL), false);
});

test('D1-07 isAcceptableHistoryUrl：F3／F7／F8／F9／http 的 Facebook 網址 → true', () => {
  for (const url of [F3_GROUP, F7_SHARE_P, F7_SHARE_V, F7_SHARE_R, F8_M, F8_WEB, F8_MBASIC, F9_WATCH, HTTP_FB]) {
    assert.equal(acceptable(url), true, url);
  }
});

test('D1-08 isAcceptableHistoryUrl：偽冒網域、javascript:、空字串、非字串 → false', () => {
  for (const v of [EVIL_SUFFIX, EVIL_PATH, 'javascript:alert(1)', '', null, undefined, 42]) {
    assert.equal(acceptable(v), false, String(v));
  }
});

test('D1-09 回歸：normalizePostUrl 不放寬，F3／F7／F9 仍為 null（只放寬下行與顯示層）', () => {
  for (const url of [F3_GROUP, F7_SHARE_P, F9_WATCH]) {
    assert.equal(C.normalizePostUrl(url), null, url);
  }
  // E-3 翻轉：原斷言 F8_M（m. 貼文）為 null，現在統一成 www.facebook.com
  assert.equal(C.normalizePostUrl(F8_M), `https://www.facebook.com/fx_user_a/posts/${ID}`);
});

// ============================================================================
// 同步下行：acceptIncomingItem／repairMergedEntry
// ============================================================================

const T0 = 1_700_000_000_000;

async function syncSettle(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function runSync(history, seed) {
  const TCLSync = loadSync();
  const env = createSyncEnv({ signedIn: true, history });
  if (seed) env.server.seed(seed);
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  await syncSettle();
  return env;
}

function cloudItem(id, cleaned, at, over = {}) {
  return Object.assign({ id, original: cleaned, cleaned, receivedAt: at, seen: [{ at, source: 'share' }] }, over);
}

const DOWNLINK_CASES = [
  ['D1-10', 'F3 社團 permalink', F3_GROUP],
  ['D1-11', 'F7 /share/p', F7_SHARE_P],
  // E-3 翻轉：下行先過 normalizePostUrl，m.／web. 落地 url 改為 www 版本（path／query 不動），postKey 不變
  ['D1-12', 'F8 m. 子網域', F8_M, F8_M.replace('m.facebook', 'www.facebook')],
  ['D1-13', 'F9 fb.watch', F9_WATCH],
  ['D1-14', 'http scheme 的 F8 web.', F8_WEB.replace('https:', 'http:'), F8_WEB.replace('web.facebook', 'www.facebook')],
];

for (const [no, label, cleaned, landed = cleaned] of DOWNLINK_CASES) {
  test(`${no} 下行：${label} 的雲端項目落地進歷史，url 原樣、postKey 等於 postKeyOf(cleaned)、kind 為 share`, async () => {
    const id = `srv-${no}`;
    const env = await runSync([], [cloudItem(id, cleaned, T0 - 200_000, { author: 'From Phone' })]);
    const e = env.storage.history().find((x) => x.id === id);
    assert.ok(e, `下行的 ${label} 項目必須落地`);
    assert.equal(e.url, landed, 'url 原樣（不改 host、不改 scheme），E-3 例外：m.／web. 改寫為 https://www.facebook.com');
    assert.equal(e.postKey ?? null, C.postKeyOf(landed) ?? null, 'postKey 等於 postKeyOf(cleaned)');
    assert.equal(e.kind, 'share');
    assert.equal(e.author, 'From Phone');
  });
}

test('D1-15 下行回歸：F1 帶追蹤參數照舊正規化落地，postKey 為 facebook:<id>', async () => {
  const dirty = F1_POST + '?fbclid=IwAR0fake';
  const env = await runSync([], [cloudItem('srv-f1', dirty, T0 - 200_000)]);
  const e = env.storage.history().find((x) => x.id === 'srv-f1');
  assert.ok(e, 'F1 必須落地');
  assert.equal(e.url, F1_POST);
  assert.equal(e.postKey, `facebook:${PFBID}`);
});

test('D1-16 下行：同一輪中 F7 落地，偽冒網域與 javascript: 項目仍被拒（放寬不等於全收）', async () => {
  const env = await runSync(
    [],
    [
      cloudItem('srv-ok', F7_SHARE_V, T0 - 300_000),
      cloudItem('srv-evil', EVIL_SUFFIX, T0 - 200_000),
      cloudItem('srv-js', 'javascript:alert(1)', T0 - 100_000),
    ]
  );
  const ids = env.storage.history().map((x) => x.id);
  assert.ok(ids.includes('srv-ok'), 'F7 項目必須落地（證明下行確實走過放寬路徑）');
  assert.equal(ids.includes('srv-evil'), false, '偽冒網域不得落地');
  assert.equal(ids.includes('srv-js'), false, 'javascript: 不得落地');
});

test('D1-17 下行合併（repairMergedEntry）：本機已有同 id 的 F7 卡，雲端更新後卡片仍在、url 原樣、seen 聯集', async () => {
  const localAt = T0 - 500_000;
  const cloudAt = T0 - 200_000;
  const env = await runSync(
    [
      {
        id: 'srv-f7',
        url: F7_SHARE_R,
        postKey: C.postKeyOf(F7_SHARE_R),
        kind: 'share',
        at: localAt,
        receivedAt: localAt,
        seen: [{ at: localAt, kind: 'share' }],
        dirty: false,
        serverUpdatedAt: T0 - 900_000,
        deletedAt: null,
      },
    ],
    [cloudItem('srv-f7', F7_SHARE_R, cloudAt)]
  );
  const live = env.storage.history().filter((x) => x.deletedAt == null);
  assert.equal(live.length, 1, 'F7 卡不得在合併時被丟掉或分裂');
  assert.equal(live[0].id, 'srv-f7');
  assert.equal(live[0].url, F7_SHARE_R);
  const ats = live[0].seen.map((x) => x.at).sort((a, b) => a - b);
  assert.deepEqual(ats, [localAt, cloudAt], 'seen 取兩邊聯集');
});

// ============================================================================
// 同步上行：isUploadable
// ============================================================================

function f7Entry(over = {}) {
  const at = T0 - 60_000;
  return Object.assign(
    {
      id: 'loc-f7',
      url: F7_SHARE_P,
      postKey: C.postKeyOf(F7_SHARE_P),
      kind: 'share',
      at,
      receivedAt: at,
      author: 'From Phone',
      seen: [{ at, kind: 'share' }],
      dirty: true,
      serverUpdatedAt: T0 - 900_000,
      deletedAt: null,
    },
    over
  );
}

test('D1-20 上行（isUploadable）：本機編輯過的 F7 條目進 outbox，cleaned 原樣，ack 後清 dirty', async () => {
  const env = await runSync([f7Entry()]);
  const upserts = [];
  env.syncPosts().forEach((r) => (r.body.upserts || []).forEach((u) => upserts.push(u)));
  const item = upserts.find((u) => u.id === 'loc-f7');
  assert.ok(item, 'F7 條目必須上傳');
  assert.equal(item.cleaned, F7_SHARE_P, 'cleaned 原樣');
  const e = env.storage.history().find((x) => x.id === 'loc-f7');
  assert.equal(e.dirty, false, 'ack 後清 dirty（沒卡在 outbox 活鎖）');
});

test('D1-21 上行（isUploadable）：本機刪除的 F7 條目（墓碑）走 deletes 推上雲端', async () => {
  const env = await runSync([f7Entry({ deletedAt: T0 - 1000 })]);
  const deletes = [];
  env.syncPosts().forEach((r) => (r.body.deletes || []).forEach((d) => deletes.push(d)));
  assert.ok(deletes.includes('loc-f7'), 'F7 墓碑必須推上雲端，否則其他裝置刪不掉');
});

// ============================================================================
// options 讀取：sanitizeEntries／mergeImportedEntries
// ============================================================================

function entry(over) {
  return Object.assign({ kind: 'share', at: 90000, seen: [{ at: 90000, kind: 'share' }] }, over);
}

test('D1-30 sanitizeEntries：保留 F3 與 F7 條目，url 原樣', () => {
  const out = options.sanitizeEntries([entry({ url: F3_GROUP }), entry({ url: F7_SHARE_P, at: 89000 })]);
  assert.deepEqual(out.map((e) => e.url).sort(), [F3_GROUP, F7_SHARE_P].sort(), '下行的 F3／F7 條目不得在讀取端被整筆丟掉');
});

test('D1-31 sanitizeEntries：F8／F9／http 條目同樣保留；偽冒網域與 javascript: 照舊丟棄', () => {
  const out = options.sanitizeEntries([
    entry({ url: F8_M, at: 89000 }),
    entry({ url: F9_WATCH, at: 88000 }),
    entry({ url: HTTP_FB, at: 87000 }),
    entry({ url: EVIL_SUFFIX, at: 86000 }),
    entry({ url: 'javascript:alert(1)', at: 85000 }),
  ]);
  assert.deepEqual(out.map((e) => e.url).sort(), [F8_M, F9_WATCH, HTTP_FB].sort());
});

test('D1-32 mergeImportedEntries：匯入 F3／F7／F8／F9 條目全數保留，url 原樣（匯出再匯入不遺失）', () => {
  const imported = [
    { url: F3_GROUP, kind: 'share', at: 900 },
    { url: F7_SHARE_V, kind: 'share', at: 800 },
    { url: F8_MBASIC, kind: 'share', at: 700 },
    { url: F9_WATCH, kind: 'share', at: 600 },
  ];
  const result = options.mergeImportedEntries([], imported, 1000);
  assert.equal(result.added, 4);
  assert.deepEqual(
    result.merged.map((e) => e.url),
    // E-3 翻轉：F8_MBASIC 改寫為 www 版本
    [F3_GROUP, F7_SHARE_V, F8_MBASIC.replace('mbasic.facebook', 'www.facebook'), F9_WATCH]
  );
});

test('D1-33 mergeImportedEntries：F7 收下，路徑夾 facebook.com 的偽冒網址照舊略過', () => {
  const result = options.mergeImportedEntries(
    [],
    [
      { url: F7_SHARE_R, kind: 'share', at: 900 },
      { url: EVIL_PATH, kind: 'share', at: 800 },
    ],
    1000
  );
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.merged[0].url, F7_SHARE_R);
});

// ============================================================================
// options 卡片：Facebook 徽章
// ============================================================================

function walk(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

function classes(node) {
  return String(node.className || '').split(/\s+/);
}

function cards(doc) {
  return doc.ids.rows.children.filter((n) => classes(n).indexOf('entry-card') !== -1);
}

function siteBadges(card) {
  return walk(card).filter((n) => classes(n).indexOf('entry-site-badge') !== -1);
}

async function renderOne(url) {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [entry({ url })] });
  const doc = makeDocumentStub();
  ['rows', 'detailOverlay', 'timelineOverlay'].forEach((id) => doc.getElementById(id));
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime: { sendMessage: () => Promise.resolve(undefined) },
    download: () => {},
  });
  await controller.init();
  await settle();
  const list = cards(doc);
  assert.equal(list.length, 1, `前置：${url} 的卡片要畫出來`);
  return list[0];
}

for (const [no, label, url] of [
  ['D1-40', 'F3 社團 permalink', F3_GROUP],
  ['D1-41', 'F9 fb.watch', F9_WATCH],
]) {
  test(`${no} 卡片：${label} 掛唯一一個「Facebook」站別徽章`, async () => {
    const card = await renderOne(url);
    const badges = siteBadges(card);
    assert.equal(badges.length, 1, '一筆只會有一個站別徽章');
    assert.equal(badges[0].textContent, 'Facebook');
  });
}

// original 欄位在下行時原樣入庫，由讀取端 sanitizeEntries（sanitizeOriginal）決定
// 「原始連結」列留不留；以下兩條驗證下行落地後經讀取整形的結果。
function readAfterDownlink(env, id) {
  return options.sanitizeEntries(env.storage.history()).find((x) => x.id === id);
}

test('D1-50 下行：F7 項目帶 m.／fbclid 的 Facebook original，落地並經讀取整形後 original 原樣保留', async () => {
  const original = 'https://m.facebook.com/share/p/AbCdEfGh12/?fbclid=xyz';
  const env = await runSync([], [cloudItem('srv-d150', F7_SHARE_P, T0 - 200_000, { original })]);
  const e = readAfterDownlink(env, 'srv-d150');
  assert.ok(e, 'F7 項目必須落地且通過讀取整形');
  assert.equal(e.url, F7_SHARE_P);
  assert.equal(e.original, original, 'original 原樣保留');
});

test('D1-51 下行：F7 項目的 original 為 javascript: 時，讀取整形後整欄丟棄、卡片照常保留', async () => {
  const env = await runSync([], [cloudItem('srv-d151', F7_SHARE_P, T0 - 200_000, { original: 'javascript:alert(1)' })]);
  const e = readAfterDownlink(env, 'srv-d151');
  assert.ok(e, 'F7 項目必須落地且通過讀取整形');
  assert.equal(e.url, F7_SHARE_P);
  assert.equal(e.original, undefined, 'javascript: original 不得保留');
});
