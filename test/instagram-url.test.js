// test/instagram-url.test.js — 0.12.0 車道 A 的 A1：tcl-core 的 URL 層認得
// Instagram 貼文（isCleanPostUrl／normalizePostUrl／extractPostId 與 postKeyOf
// 的一致性），鏡射手機 App 的 link-cleaner。
//
// 規則摘要：
//   - host 為 instagram.com 或其子網域（www、m），路徑 /(p|reel|reels|tv)/<code>/?，
//     code 字元 [A-Za-z0-9_-]；可帶使用者名稱前綴 /<user>/p/<code>/。
//   - isCleanPostUrl：無 query、無 hash、無使用者名稱前綴才算乾淨。
//   - normalizePostUrl：清掉全部 query 與 hash、去掉使用者名稱前綴；www 與尾斜線
//     原樣保留（有就留、沒有不補），scheme 統一 https。
//   - extractPostId 維持 Threads 專屬（唯一呼叫端是警示證據的代碼尾碼，屬 Threads
//     功能），Instagram 一律 null；跨站合併鍵走 postKeyOf。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

const THREADS_CLEAN = 'https://www.threads.com/@usera/post/AbC123_-xyz';

// ---- normalizePostUrl ----

// [輸入, 期望輸出]
const NORMALIZE_CASES = [
  // 規格範例
  ['https://www.instagram.com/reel/Db44wsMgVBI/?igsi=MXZzYWJjZGVm', 'https://www.instagram.com/reel/Db44wsMgVBI/'],
  ['https://instagram.com/reels/X?igsh=1', 'https://instagram.com/reels/X'],
  ['https://www.instagram.com/someone/p/ABC/?igsh=x', 'https://www.instagram.com/p/ABC/'],
  // 四種路徑類型
  ['https://www.instagram.com/p/Db44wsMgVBI/', 'https://www.instagram.com/p/Db44wsMgVBI/'],
  ['https://www.instagram.com/tv/Db44wsMgVBI/', 'https://www.instagram.com/tv/Db44wsMgVBI/'],
  // 尾斜線：有就留、沒有不補
  ['https://www.instagram.com/p/Db44wsMgVBI', 'https://www.instagram.com/p/Db44wsMgVBI'],
  // www：沒有不補
  ['https://instagram.com/p/Db44wsMgVBI/', 'https://instagram.com/p/Db44wsMgVBI/'],
  // hash 一併清掉
  ['https://www.instagram.com/p/Db44wsMgVBI/#comments', 'https://www.instagram.com/p/Db44wsMgVBI/'],
  ['https://www.instagram.com/p/Db44wsMgVBI/?igsh=abc&utm_source=ig_web_copy_link#x', 'https://www.instagram.com/p/Db44wsMgVBI/'],
  // shortcode 含底線與連字號
  ['https://www.instagram.com/p/a_B-c9/?igsh=z', 'https://www.instagram.com/p/a_B-c9/'],
  // 使用者名稱前綴（含句點與底線的帳號）
  ['https://www.instagram.com/some.user_1/p/ABC', 'https://www.instagram.com/p/ABC'],
  // scheme 統一 https
  ['http://www.instagram.com/p/ABC/', 'https://www.instagram.com/p/ABC/'],
];

for (const [input, expected] of NORMALIZE_CASES) {
  test(`IG-N normalizePostUrl(${input}) → ${expected}`, () => {
    assert.equal(C.normalizePostUrl(input), expected);
  });
}

test('IG-N normalizePostUrl：m.instagram.com 子網域放行，路徑與 shortcode 保留、scheme 為 https', () => {
  const out = C.normalizePostUrl('https://m.instagram.com/p/ABC/?igsh=1');
  assert.equal(typeof out, 'string', 'm 子網域必須放行');
  assert.ok(out.startsWith('https://'), 'scheme 統一 https');
  assert.ok(out.endsWith('instagram.com/p/ABC/'), '路徑與 shortcode 保留、query 清掉');
});

// 非貼文、非 http(s)、偽冒網域、超長：一律 null（與 Threads 一致）。
const NORMALIZE_NULL_CASES = [
  'https://www.instagram.com/some.profile/?igsh=abc',
  'https://www.instagram.com/some.profile/',
  'https://www.instagram.com/',
  'https://www.instagram.com/explore/',
  'https://www.instagram.com/explore/tags/cat/',
  'https://www.instagram.com/stories/someone/1234567890/',
  'https://www.instagram.com/p/',
  'https://www.instagram.com/p/ABC/extra',
  'https://www.instagram.com/p/AB%20C/',
  'https://www.instagram.com/p/ABC/ 帳號異常，請至 evil.example 重新登入',
  'ftp://www.instagram.com/p/ABC/',
  'javascript://www.instagram.com/p/ABC/',
  'https://instagram.com.evil.example/p/ABC/',
  'https://evilinstagram.com/p/ABC/',
  'https://www.instagram.com/p/' + 'A'.repeat(300) + '/',
  'https://www.instagram.com/share/p/AbCdEfGhI/',
  'https://www.instagram.com/share/reel/AbCdEfGhI/?igsh=1',
  'https://www.instagram.com/share/AbCdEfGhI/',
];

for (const input of NORMALIZE_NULL_CASES) {
  test(`IG-N normalizePostUrl 回 null：${input.slice(0, 80)}`, () => {
    assert.equal(C.normalizePostUrl(input), null);
  });
}

test('IG-N normalizePostUrl：Threads 既有行為不變（回歸釘子）', () => {
  assert.equal(C.normalizePostUrl(THREADS_CLEAN + '/?igsh=x#frag'), THREADS_CLEAN);
  assert.equal(C.normalizePostUrl('https://www.threads.com/share/AbCdEfGhI'), null);
  assert.equal(C.normalizePostUrl(12345), null);
});

// ---- isCleanPostUrl ----

const CLEAN_TRUE = [
  'https://www.instagram.com/p/Db44wsMgVBI/',
  'https://www.instagram.com/reel/Db44wsMgVBI/',
  'https://www.instagram.com/reels/Db44wsMgVBI',
  'https://instagram.com/tv/Db44wsMgVBI/',
  'https://www.instagram.com/p/a_B-c9',
];

for (const input of CLEAN_TRUE) {
  test(`IG-C isCleanPostUrl(${input}) === true`, () => {
    assert.equal(C.isCleanPostUrl(input), true);
  });
}

const CLEAN_FALSE = [
  'https://www.instagram.com/p/Db44wsMgVBI/?igsh=abc',
  'https://www.instagram.com/p/Db44wsMgVBI/?',
  'https://www.instagram.com/p/Db44wsMgVBI/#x',
  'https://www.instagram.com/someone/p/Db44wsMgVBI/',
  'https://www.instagram.com/some.profile/',
  'https://www.instagram.com/explore/',
  'https://www.instagram.com/stories/someone/1234567890/',
  'https://instagram.com.evil.example/p/ABC/',
  'https://www.instagram.com/p/ABC/ 帳號異常',
];

for (const input of CLEAN_FALSE) {
  test(`IG-C isCleanPostUrl(${input}) === false`, () => {
    assert.equal(C.isCleanPostUrl(input), false);
  });
}

test('IG-C isCleanPostUrl：normalizePostUrl 的輸出一律是乾淨網址（寫入端與讀取端的閉環）', () => {
  for (const [input] of NORMALIZE_CASES) {
    const out = C.normalizePostUrl(input);
    assert.equal(C.isCleanPostUrl(out), true, `normalize(${input}) = ${out} 應通過 isCleanPostUrl`);
  }
});

test('IG-C isCleanPostUrl：Threads 既有規則不變（回歸釘子）', () => {
  assert.equal(C.isCleanPostUrl(THREADS_CLEAN), true);
  assert.equal(C.isCleanPostUrl(THREADS_CLEAN + '/'), false);
  assert.equal(C.isCleanPostUrl(THREADS_CLEAN + '?xmt=1'), false);
});

// ---- postKeyOf 與 normalize 的一致性 ----

test('IG-K normalize 前後 postKeyOf 相同：/p/X/ 與 /reel/X/、帶前綴與不帶前綴都是同一把鍵', () => {
  const variants = [
    'https://www.instagram.com/p/Db44wsMgVBI/?igsh=1',
    'https://www.instagram.com/reel/Db44wsMgVBI/',
    'https://instagram.com/reels/Db44wsMgVBI',
    'https://www.instagram.com/someone/p/Db44wsMgVBI/?igsh=x',
  ];
  for (const v of variants) {
    const n = C.normalizePostUrl(v);
    assert.equal(C.postKeyOf(n), 'instagram:Db44wsMgVBI', `${v} 正規化後應得 instagram:Db44wsMgVBI`);
  }
});

// ---- extractPostId ----

test('IG-E extractPostId：Instagram 一律 null（Threads 專屬，跨站合併走 postKeyOf）', () => {
  assert.equal(C.extractPostId('https://www.instagram.com/p/Db44wsMgVBI/'), null);
  assert.equal(C.extractPostId('https://www.instagram.com/reel/Db44wsMgVBI'), null);
  assert.equal(C.extractPostId(THREADS_CLEAN), 'AbC123_-xyz', 'Threads 行為不變');
});

// ---- sanitizeOriginal：IG 剝參前的原網址要能入庫 ----

test('IG-O sanitizeOriginal：帶追蹤參數的 Instagram 原網址通過白名單、與 cleaned 相同時丟棄', () => {
  const cleaned = 'https://www.instagram.com/p/Db44wsMgVBI/';
  const original = cleaned + '?igsh=xyz&utm_source=a';
  assert.equal(C.sanitizeOriginal(original, cleaned), original);
  assert.equal(C.sanitizeOriginal(cleaned, cleaned), undefined);
  assert.equal(C.sanitizeOriginal('https://www.instagram.com/some.profile/?igsh=1', cleaned), undefined, '非貼文不收');
});

// ---- toSyncItem：IG 的 cleaned 原樣上雲（尾斜線不被吃掉） ----

test('IG-S toSyncItem：Instagram 條目的 cleaned 與 url 相同（尾斜線保留），removedParams 為 {key,value}', () => {
  const url = 'https://www.instagram.com/reel/Db44wsMgVBI/';
  const item = C.toSyncItem({
    id: 'ig-1',
    url,
    original: url + '?igsh=xyz&utm_source=a',
    receivedAt: 1000,
    removedParams: [
      { key: 'igsh', value: 'xyz' },
      { key: 'utm_source', value: 'a' },
    ],
    seen: [{ at: 1000, kind: 'icon' }],
  });
  assert.equal(item.cleaned, url);
  assert.deepEqual(item.removedParams, [
    { key: 'igsh', value: 'xyz' },
    { key: 'utm_source', value: 'a' },
  ]);
  // fromSyncItem 回程同樣保留 cleaned 原樣，postKey 為 instagram:<code>。
  const back = C.fromSyncItem(Object.assign({ updatedAt: 2000 }, item), null);
  assert.equal(back.url, url);
  assert.equal(back.postKey, 'instagram:Db44wsMgVBI');
});

// ---- 警示（Threads 專屬）不得吃進 Instagram 網址 ----

test('IG-G normalizeScamEvidence：postUrl 是 Instagram 的證據整筆丟棄；anchor／thread 是 Instagram 只剝該欄', () => {
  const ig = 'https://www.instagram.com/p/Db44wsMgVBI/';
  assert.equal(C.normalizeScamEvidence({ postUrl: ig, snippet: 's', at: 1 }), null);
  const out = C.normalizeScamEvidence({ postUrl: THREADS_CLEAN, snippet: 's', at: 1, anchorPostUrl: ig, threadUrl: ig });
  assert.ok(out, 'Threads 證據照收');
  assert.equal('anchorPostUrl' in out, false, 'Instagram anchorPostUrl 不得留下');
  assert.equal('threadUrl' in out, false, 'Instagram threadUrl 不得留下');
});

test('IG-G toScamMark：Instagram 錨點的證據不上雲；fromScamMark 收到 Instagram 錨點同樣剝除', () => {
  const ig = 'https://www.instagram.com/p/Db44wsMgVBI/';
  const mark = C.toScamMark('1001', {
    state: 'active',
    handle: 'alice',
    source: 'auto',
    addedAt: 1,
    updatedAt: 2,
    evidence: [
      { postUrl: ig, anchorPostUrl: ig, snippet: 's', at: 1 },
      { postUrl: THREADS_CLEAN, snippet: 's', at: 2, threadUrl: ig },
    ],
  });
  assert.equal(mark.key, 'threads:1001');
  assert.equal(JSON.stringify(mark).indexOf('instagram'), -1, 'mark 上雲 payload 不得出現 instagram');
  assert.equal(mark.evidence.length, 1);
  assert.equal(mark.evidence[0].threadUrl, null);

  const back = C.fromScamMark({
    key: 'threads:1001',
    state: 'active',
    handle: 'alice',
    source: 'auto',
    addedAt: 1,
    updatedAt: 2,
    evidence: [{ anchorPostUrl: ig, threadUrl: null, signals: [], at: 1 }],
  });
  const evidence = back && back.entry ? back.entry.evidence || [] : [];
  assert.equal(JSON.stringify(evidence).indexOf('instagram'), -1, '雲端回來的 Instagram 證據不得落地');
});

test('IG-G isPostDetailPath：Instagram 貼文路徑不算 Threads 貼文詳情頁（scam-guard 掃描範圍不擴張）', () => {
  assert.equal(C.isPostDetailPath('/p/Db44wsMgVBI/'), false);
  assert.equal(C.isPostDetailPath('/reel/Db44wsMgVBI/'), false);
  assert.equal(C.isPostDetailPath('/@usera/post/AbC123'), true);
});
