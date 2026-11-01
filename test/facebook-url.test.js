// test/facebook-url.test.js — 0.13.0 車道 A 的 A1：tcl-core 的 URL 層認得
// Facebook 貼文（normalizeFacebookPostUrl／isFacebookPostUrl／normalizePostUrl／
// isCleanPostUrl／extractPostId），鏡射手機 App 的清理規則。
//
// 規則摘要：
//   - host 限 facebook.com 與 www.facebook.com；其他子網域（m、web）、fb.watch、
//     fb.com、偽冒網域一律 null。
//   - scheme 統一 https；路徑必須讓 postKeyOf 取得到 facebook:<id>，否則 null。
//   - query 只剝 16 個鍵（fbclid, mibextid, rdid, share_url, sfnsn, wtsid, refid,
//     ref, refsrc, __tn__, __xts__, notif_t, notif_id, paipv, extid,
//     comment_tracking）與所有 utm_*，鍵名大小寫不敏感；其他參數保留且順序不變；
//     全部剝光時不留 ?。hash 保留；host 與路徑（含尾斜線）原樣。
//   - isCleanPostUrl：Facebook 網址等於自身正規化結果才算乾淨。
//   - isFacebookPostUrl：可正規化的 Facebook 貼文網址（帶追蹤參數亦是）。
//   - extractPostId 維持 Threads 專屬，Facebook 一律 null；警示路徑不吃 Facebook。
//   - Threads／Instagram 既有對照表（A1-G）逐筆零變動。
//
// 測試資料的帳號名、數字 id、pfbid 皆為假值。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

const FB = 'https://www.facebook.com';
const USER = 'fx_user_a';
const PAGE = 'fx_page_b';
const ID = '100000000000001';
const GID = '100000000000002';
const PHID = '100000000000003';
const PFBID = 'pfbid0FXAAAbbbCCCdddEEEfff';
const THREADS_CLEAN = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const IG_CLEAN = 'https://www.instagram.com/p/Db44wsMgVBI/';

// ---- A1-1 normalizeFacebookPostUrl／normalizePostUrl 對照表 ----

// [條號, 輸入, 期望輸出, 期望 postKey]
const NORMALIZE_CASES = [
  // posts（數字 id 與 pfbid）
  ['A1-1-01', `${FB}/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`, `facebook:${ID}`],
  ['A1-1-02', `${FB}/${USER}/posts/${PFBID}?fbclid=IwAR0fake`, `${FB}/${USER}/posts/${PFBID}`, `facebook:${PFBID}`],
  ['A1-1-03', `${FB}/${USER}/posts/${PFBID}/?mibextid=abc&rdid=xyz`, `${FB}/${USER}/posts/${PFBID}/`, `facebook:${PFBID}`],
  ['A1-1-04', `http://www.facebook.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`, `facebook:${ID}`],
  ['A1-1-05', `https://facebook.com/${USER}/posts/${ID}?fbclid=x`, `https://facebook.com/${USER}/posts/${ID}`, `facebook:${ID}`],
  ['A1-1-06', `${FB}/groups/${GID}/posts/${ID}/?__tn__=R`, `${FB}/groups/${GID}/posts/${ID}/`, `facebook:${ID}`],
  ['A1-1-07', `${FB}/${USER}/posts/${ID}/`, `${FB}/${USER}/posts/${ID}/`, `facebook:${ID}`],
  // reel
  ['A1-1-08', `${FB}/reel/${ID}`, `${FB}/reel/${ID}`, `facebook:${ID}`],
  ['A1-1-09', `${FB}/reel/${ID}/?fbclid=x&s=fakeS1`, `${FB}/reel/${ID}/?s=fakeS1`, `facebook:${ID}`],
  ['A1-1-10', `${FB}/reel/${ID}?mibextid=x#top`, `${FB}/reel/${ID}#top`, `facebook:${ID}`],
  // photo?fbid（set 不在剝除清單，保留）
  ['A1-1-11', `${FB}/photo/?fbid=${PHID}`, `${FB}/photo/?fbid=${PHID}`, `facebook:${PHID}`],
  ['A1-1-12', `${FB}/photo/?fbid=${PHID}&set=a.${GID}`, `${FB}/photo/?fbid=${PHID}&set=a.${GID}`, `facebook:${PHID}`],
  ['A1-1-13', `${FB}/photo/?fbid=${PHID}&set=a.${GID}&__tn__=EH-R`, `${FB}/photo/?fbid=${PHID}&set=a.${GID}`, `facebook:${PHID}`],
  ['A1-1-14', `${FB}/photo.php?fbid=${PHID}&set=a.${GID}&type=3`, `${FB}/photo.php?fbid=${PHID}&set=a.${GID}&type=3`, `facebook:${PHID}`],
  ['A1-1-15', `http://www.facebook.com/photo/?fbid=${PHID}&fbclid=x`, `${FB}/photo/?fbid=${PHID}`, `facebook:${PHID}`],
  // /photos/<album>/<id>
  ['A1-1-16', `${FB}/${PAGE}/photos/a.${GID}/${PHID}/`, `${FB}/${PAGE}/photos/a.${GID}/${PHID}/`, `facebook:${PHID}`],
  ['A1-1-17', `${FB}/${PAGE}/photos/a.${GID}/${PHID}/?refid=8&ref=page_internal`, `${FB}/${PAGE}/photos/a.${GID}/${PHID}/`, `facebook:${PHID}`],
  // permalink.php／story.php（story_fbid、id 保留且順序不變）
  ['A1-1-18', `${FB}/permalink.php?story_fbid=${ID}&id=${GID}`, `${FB}/permalink.php?story_fbid=${ID}&id=${GID}`, `facebook:${ID}`],
  [
    'A1-1-19',
    `${FB}/permalink.php?story_fbid=${ID}&id=${GID}&refsrc=x&notif_id=1&notif_t=feedback_reaction_generic`,
    `${FB}/permalink.php?story_fbid=${ID}&id=${GID}`,
    `facebook:${ID}`,
  ],
  ['A1-1-20', `${FB}/story.php?story_fbid=${ID}&id=${GID}&mibextid=fakeMib`, `${FB}/story.php?story_fbid=${ID}&id=${GID}`, `facebook:${ID}`],
  ['A1-1-21', `${FB}/story.php?id=${GID}&story_fbid=${ID}`, `${FB}/story.php?id=${GID}&story_fbid=${ID}`, `facebook:${ID}`],
  [
    'A1-1-22',
    `${FB}/permalink.php?fbclid=x&story_fbid=${ID}&utm_x=1&id=${GID}`,
    `${FB}/permalink.php?story_fbid=${ID}&id=${GID}`,
    `facebook:${ID}`,
  ],
  // videos
  ['A1-1-23', `${FB}/${PAGE}/videos/${ID}/`, `${FB}/${PAGE}/videos/${ID}/`, `facebook:${ID}`],
  ['A1-1-24', `${FB}/${PAGE}/videos/${ID}/?__xts__=x&paipv=0&extid=y`, `${FB}/${PAGE}/videos/${ID}/`, `facebook:${ID}`],
  // watch?v
  ['A1-1-25', `${FB}/watch/?v=${ID}`, `${FB}/watch/?v=${ID}`, `facebook:${ID}`],
  ['A1-1-26', `${FB}/watch?v=${ID}&ref=sharing`, `${FB}/watch?v=${ID}`, `facebook:${ID}`],
  ['A1-1-27', `${FB}/watch/?v=${ID}&utm_source=a&utm_medium=b&utm_campaign=c`, `${FB}/watch/?v=${ID}`, `facebook:${ID}`],
  // 其餘剝除鍵一次到齊
  [
    'A1-1-28',
    `${FB}/${USER}/posts/${ID}?wtsid=x&sfnsn=y&share_url=z&comment_tracking=q`,
    `${FB}/${USER}/posts/${ID}`,
    `facebook:${ID}`,
  ],
  // 鍵名大小寫不敏感
  ['A1-1-29', `${FB}/${USER}/posts/${ID}?FBCLID=x`, `${FB}/${USER}/posts/${ID}`, `facebook:${ID}`],
  ['A1-1-30', `${FB}/reel/${ID}?Utm_Source=a&MIBEXTID=b&ReF=c`, `${FB}/reel/${ID}`, `facebook:${ID}`],
  // 無值的剝除鍵
  ['A1-1-31', `${FB}/${USER}/posts/${ID}?fbclid`, `${FB}/${USER}/posts/${ID}`, `facebook:${ID}`],
  // 未知參數保留、順序不變
  [
    'A1-1-32',
    `${FB}/${USER}/posts/${ID}?comment_id=7&fbclid=x&reply_comment_id=8`,
    `${FB}/${USER}/posts/${ID}?comment_id=7&reply_comment_id=8`,
    `facebook:${ID}`,
  ],
  // 只認完整鍵名：utm（無底線）、xfbclid、reference 都不是剝除鍵
  ['A1-1-33', `${FB}/${USER}/posts/${ID}?utm=1&xfbclid=2&reference=3`, `${FB}/${USER}/posts/${ID}?utm=1&xfbclid=2&reference=3`, `facebook:${ID}`],
  // hash 保留
  ['A1-1-34', `${FB}/${USER}/posts/${ID}#comments`, `${FB}/${USER}/posts/${ID}#comments`, `facebook:${ID}`],
  ['A1-1-35', `${FB}/${USER}/posts/${ID}?fbclid=x&mibextid=y#c`, `${FB}/${USER}/posts/${ID}#c`, `facebook:${ID}`],
  ['A1-1-36', `${FB}/photo/?fbid=${PHID}&set=a.${GID}#x`, `${FB}/photo/?fbid=${PHID}&set=a.${GID}#x`, `facebook:${PHID}`],
];

for (const [no, input, expected] of NORMALIZE_CASES) {
  test(`${no} normalizeFacebookPostUrl(${input}) → ${expected}`, () => {
    assert.equal(typeof C.normalizeFacebookPostUrl, 'function', 'tcl-core 必須匯出 normalizeFacebookPostUrl');
    assert.equal(C.normalizeFacebookPostUrl(input), expected);
  });
  test(`${no} normalizePostUrl 對 Facebook 與 normalizeFacebookPostUrl 一致：${input}`, () => {
    assert.equal(C.normalizePostUrl(input), expected);
  });
}

// ---- A1-2 回 null 的網址 ----

const NORMALIZE_NULL_CASES = [
  ['A1-2-01', `${FB}/groups/${GID}/permalink/${ID}/`],
  ['A1-2-02', `${FB}/share/p/AbC123fake/`],
  ['A1-2-03', `${FB}/share/r/AbC123fake/`],
  ['A1-2-04', `${FB}/share/v/AbC123fake/?mibextid=x`],
  ['A1-2-05', `https://fb.watch/AbC123fake/`],
  ['A1-2-06', `https://m.facebook.com/${USER}/posts/${ID}`],
  ['A1-2-07', `https://m.facebook.com/story.php?story_fbid=${ID}&id=${GID}`],
  ['A1-2-08', `https://web.facebook.com/${USER}/posts/${ID}`],
  ['A1-2-09', `https://fb.com/${USER}/posts/${ID}`],
  ['A1-2-10', `https://www.facebook.com.evil.example/${USER}/posts/${ID}`],
  ['A1-2-11', `https://evilfacebook.com/${USER}/posts/${ID}`],
  ['A1-2-12', `${FB}/`],
  ['A1-2-13', `${FB}/${USER}`],
  ['A1-2-14', `${FB}/profile.php?id=${ID}`],
  ['A1-2-15', `${FB}/permalink.php?id=${GID}`],
  ['A1-2-16', `${FB}/photo/?set=a.${GID}`],
  ['A1-2-17', `${FB}/watch/`],
  ['A1-2-18', `${FB}/reel/AbCfake`],
  ['A1-2-19', `${FB}/${PAGE}/videos/notdigits/`],
  ['A1-2-20', `ftp://www.facebook.com/${USER}/posts/${ID}`],
  ['A1-2-21', `javascript://www.facebook.com/${USER}/posts/${ID}`],
  ['A1-2-22', `${FB}/${USER}/posts/${ID} 帳號異常，請至 evil.example 重新登入`],
  ['A1-2-23', `${FB}/${USER}/posts/`],
];

for (const [no, input] of NORMALIZE_NULL_CASES) {
  test(`${no} normalizeFacebookPostUrl／normalizePostUrl 回 null：${input.slice(0, 80)}`, () => {
    assert.equal(typeof C.normalizeFacebookPostUrl, 'function', 'tcl-core 必須匯出 normalizeFacebookPostUrl');
    assert.equal(C.normalizeFacebookPostUrl(input), null);
    assert.equal(C.normalizePostUrl(input), null);
  });
}

test('A1-2-24 normalizeFacebookPostUrl：非字串輸入回 null、不丟例外', () => {
  assert.equal(typeof C.normalizeFacebookPostUrl, 'function');
  for (const v of [null, undefined, 12345, {}, [], '']) {
    assert.equal(C.normalizeFacebookPostUrl(v), null);
  }
});

test('A1-2-25 normalizeFacebookPostUrl：Threads 與 Instagram 網址不歸它管，回 null', () => {
  assert.equal(typeof C.normalizeFacebookPostUrl, 'function');
  assert.equal(C.normalizeFacebookPostUrl(THREADS_CLEAN), null);
  assert.equal(C.normalizeFacebookPostUrl(IG_CLEAN), null);
});

test('A1-2-26 normalizeFacebookPostUrl：路徑、query、hash 任一處含控制字元或 bidi 控制字元，回 null 且不算乾淨', () => {
  const NUL = String.fromCharCode(0);
  const RLO = String.fromCharCode(0x202e);
  const cases = [
    ['NUL 在路徑', FB + '/' + USER + '/posts/' + ID + NUL],
    ['NUL 在 hash', FB + '/' + USER + '/posts/' + ID + '#a' + NUL],
    ['RLO 在 query', FB + '/permalink.php?story_fbid=' + ID + '&x=' + RLO + 'gpj'],
    ['RLO 在 hash', FB + '/reel/' + ID + '#' + RLO + 'gpj'],
  ];
  for (const [label, url] of cases) {
    assert.equal(C.normalizeFacebookPostUrl(url), null, label);
    assert.equal(C.normalizePostUrl(url), null, label);
    assert.equal(C.isCleanPostUrl(url), false, label);
  }
});

// ---- A1-3 規則的性質 ----

test('A1-3-1 正規化是冪等的：normalize(normalize(x)) === normalize(x)', () => {
  for (const [no, input] of NORMALIZE_CASES) {
    const once = C.normalizePostUrl(input);
    assert.ok(once, `${no} 前置：必須正規化成功`);
    assert.equal(C.normalizePostUrl(once), once, `${no}：${input}`);
  }
});

test('A1-3-2 正規化前後 postKeyOf 相同，且為 facebook:<id>', () => {
  for (const [no, input, , key] of NORMALIZE_CASES) {
    const out = C.normalizePostUrl(input);
    assert.ok(out, `${no} 前置：必須正規化成功`);
    assert.equal(C.postKeyOf(out), key, `${no}：${out}`);
    assert.equal(C.postKeyOf(input), key, `${no}：${input}`);
  }
});

test('A1-3-3 未列入的參數鍵 __cft__[0] 照契約保留（不自行擴充剝除清單）', () => {
  const input = `${FB}/${USER}/posts/${ID}?__cft__[0]=AZfake&__tn__=%2CO%2CP-R`;
  const out = C.normalizePostUrl(input);
  assert.equal(typeof out, 'string', '必須正規化成功');
  const u = new URL(out);
  assert.equal(u.pathname, `/${USER}/posts/${ID}`);
  assert.equal(u.searchParams.get('__cft__[0]'), 'AZfake', '__cft__[0] 保留');
  assert.equal(u.searchParams.has('__tn__'), false, '__tn__ 剝掉');
});

test('A1-3-4 host 原樣：www 有就留、沒有不補', () => {
  assert.equal(C.normalizePostUrl(`https://facebook.com/reel/${ID}`), `https://facebook.com/reel/${ID}`);
  assert.equal(C.normalizePostUrl(`${FB}/reel/${ID}`), `${FB}/reel/${ID}`);
});

// ---- A1-4 isCleanPostUrl ----

test('A1-4-1 isCleanPostUrl：normalizePostUrl 的 Facebook 輸出一律是乾淨網址（寫入端與讀取端閉環）', () => {
  for (const [no, input] of NORMALIZE_CASES) {
    const out = C.normalizePostUrl(input);
    assert.ok(out, `${no} 前置：必須正規化成功`);
    assert.equal(C.isCleanPostUrl(out), true, `${no}：normalize(${input}) = ${out} 應通過 isCleanPostUrl`);
  }
});

test('A1-4-2 isCleanPostUrl：帶剝除鍵或 http 的 Facebook 網址不算乾淨', () => {
  for (const [no, input, expected] of NORMALIZE_CASES) {
    if (input === expected) continue;
    assert.equal(C.isCleanPostUrl(input), false, `${no}：${input}`);
  }
});

test('A1-4-3 isCleanPostUrl：回 null 的 Facebook 網址不算乾淨', () => {
  for (const [no, input] of NORMALIZE_NULL_CASES) {
    assert.equal(C.isCleanPostUrl(input), false, `${no}：${input}`);
  }
});

// ---- A1-5 isFacebookPostUrl ----

test('A1-5-1 isFacebookPostUrl：可正規化的 Facebook 貼文網址（含帶追蹤參數者）為 true', () => {
  assert.equal(typeof C.isFacebookPostUrl, 'function', 'tcl-core 必須匯出 isFacebookPostUrl');
  for (const [no, input] of NORMALIZE_CASES) {
    assert.equal(C.isFacebookPostUrl(input), true, `${no}：${input}`);
  }
});

test('A1-5-2 isFacebookPostUrl：不支援的 Facebook 網址、Threads、Instagram、非字串一律 false', () => {
  assert.equal(typeof C.isFacebookPostUrl, 'function', 'tcl-core 必須匯出 isFacebookPostUrl');
  for (const [no, input] of NORMALIZE_NULL_CASES) {
    assert.equal(C.isFacebookPostUrl(input), false, `${no}：${input}`);
  }
  assert.equal(C.isFacebookPostUrl(THREADS_CLEAN), false);
  assert.equal(C.isFacebookPostUrl(IG_CLEAN), false);
  assert.equal(C.isFacebookPostUrl(null), false);
  assert.equal(C.isFacebookPostUrl(42), false);
});

test('A1-5-3 isInstagramPostUrl：Facebook 網址一律 false（站別判斷互斥）', () => {
  for (const [no, input] of NORMALIZE_CASES) {
    assert.equal(C.isInstagramPostUrl(input), false, `${no}：${input}`);
  }
});

// ---- A1-6 extractPostId 與警示路徑（Threads 專屬） ----

test('A1-6-1 extractPostId：Facebook 一律 null；Threads 行為不變', () => {
  for (const [no, input, expected] of NORMALIZE_CASES) {
    assert.equal(C.extractPostId(input), null, `${no}：${input}`);
    assert.equal(C.extractPostId(expected), null, `${no}：${expected}`);
  }
  assert.equal(C.extractPostId(THREADS_CLEAN), 'AbC123_-xyz');
});

test('A1-6-2 normalizeThreadsPostUrl：Facebook 網址一律 null（警示路徑零變動）', () => {
  for (const [no, input] of NORMALIZE_CASES) {
    assert.equal(C.normalizeThreadsPostUrl(input), null, `${no}：${input}`);
  }
});

test('A1-6-3 normalizeScamEvidence：postUrl 是 Facebook 的證據整筆丟棄；anchor／thread 是 Facebook 只剝該欄', () => {
  const fb = `${FB}/${USER}/posts/${ID}`;
  assert.equal(C.normalizeScamEvidence({ postUrl: fb, snippet: 's', at: 1 }), null);
  const out = C.normalizeScamEvidence({ postUrl: THREADS_CLEAN, snippet: 's', at: 1, anchorPostUrl: fb, threadUrl: fb });
  assert.ok(out, 'Threads 證據照收');
  assert.equal('anchorPostUrl' in out, false, 'Facebook anchorPostUrl 不得留下');
  assert.equal('threadUrl' in out, false, 'Facebook threadUrl 不得留下');
});

test('A1-6-4 isPostDetailPath：Facebook 貼文路徑不算 Threads 貼文詳情頁', () => {
  assert.equal(C.isPostDetailPath(`/${USER}/posts/${ID}`), false);
  assert.equal(C.isPostDetailPath(`/reel/${ID}`), false);
});

// ---- A1-7 sanitizeOriginal：Facebook 剝參前的原網址可入庫 ----

test('A1-7-1 sanitizeOriginal：帶追蹤參數的 Facebook 原網址通過、與 cleaned 相同時丟棄、可顯示的非貼文網址保留', () => {
  const cleaned = `${FB}/${USER}/posts/${ID}`;
  const original = cleaned + '?fbclid=x&mibextid=y';
  assert.equal(C.sanitizeOriginal(original, cleaned), original);
  assert.equal(C.sanitizeOriginal(cleaned, cleaned), undefined);
  assert.equal(C.sanitizeOriginal(`${FB}/${USER}?fbclid=x`, cleaned), `${FB}/${USER}?fbclid=x`, '可顯示的 Facebook 非貼文網址保留原樣');
});

// ---- A1-G Threads／Instagram 既有對照零變動（守門） ----
//
// [輸入, normalizePostUrl, isCleanPostUrl, normalizeThreadsPostUrl, isInstagramPostUrl]
// 期望值為 0.12.0（8d9be05）的實際輸出，Facebook 支援上線後必須逐筆相同。
const GOLDEN = [
  ['https://www.threads.com/@usera/post/AbC123_-xyz', 'https://www.threads.com/@usera/post/AbC123_-xyz', true, 'https://www.threads.com/@usera/post/AbC123_-xyz', false],
  ['https://www.threads.com/@usera/post/AbC123_-xyz/', 'https://www.threads.com/@usera/post/AbC123_-xyz', false, 'https://www.threads.com/@usera/post/AbC123_-xyz', false],
  ['https://www.threads.com/@usera/post/AbC123_-xyz?xmt=1', 'https://www.threads.com/@usera/post/AbC123_-xyz', false, 'https://www.threads.com/@usera/post/AbC123_-xyz', false],
  ['https://www.threads.com/@usera/post/AbC123_-xyz/?igsh=x#frag', 'https://www.threads.com/@usera/post/AbC123_-xyz', false, 'https://www.threads.com/@usera/post/AbC123_-xyz', false],
  ['https://threads.com/@usera/post/AbC123_-xyz', 'https://threads.com/@usera/post/AbC123_-xyz', true, 'https://threads.com/@usera/post/AbC123_-xyz', false],
  ['https://www.threads.net/@usera/post/AbC123_-xyz', 'https://www.threads.net/@usera/post/AbC123_-xyz', true, 'https://www.threads.net/@usera/post/AbC123_-xyz', false],
  ['https://threads.net/@usera/post/AbC123_-xyz?slof=1', 'https://threads.net/@usera/post/AbC123_-xyz', false, 'https://threads.net/@usera/post/AbC123_-xyz', false],
  ['http://www.threads.com/@usera/post/AbC123_-xyz', null, false, null, false],
  ['https://www.threads.com/@user.a_b/post/AbC123', 'https://www.threads.com/@user.a_b/post/AbC123', true, 'https://www.threads.com/@user.a_b/post/AbC123', false],
  ['https://www.threads.com/@usera/post/AbC123/media', null, false, null, false],
  ['https://www.threads.com/@usera', null, false, null, false],
  ['https://www.threads.com/', null, false, null, false],
  ['https://www.threads.com/share/AbCdEfGhI', null, false, null, false],
  ['https://www.threads.com/@usera/post/AbC123 帳號異常', null, false, null, false],
  ['https://www.threads.com.evil.example/@usera/post/AbC123', null, false, null, false],
  ['https://evilthreads.com/@usera/post/AbC123', null, false, null, false],
  ['ftp://www.threads.com/@usera/post/AbC123', null, false, null, false],
  ['https://www.threads.com/@usera/post/AbC%20123', null, false, null, false],
  ['https://m.threads.com/@usera/post/AbC123', null, false, null, false],
  ['https://www.threads.com/@usera/post/' + 'A'.repeat(300), null, false, null, false],
  ['https://www.threads.com/@usera/post/AbC123#x', 'https://www.threads.com/@usera/post/AbC123', false, 'https://www.threads.com/@usera/post/AbC123', false],
  ['https://www.threads.com/@usera/post/AbC123?', 'https://www.threads.com/@usera/post/AbC123', false, 'https://www.threads.com/@usera/post/AbC123', false],
  ['https://www.threads.com/@usera/post/AbC123)', null, false, null, false],
  ['https://www.threads.com/@usera/post/AbC123.', null, false, null, false],
  ['https://www.threads.com/t/AbC123', null, false, null, false],
  ['https://www.instagram.com/reel/Db44wsMgVBI/?igsi=MXZzYWJjZGVm', 'https://www.instagram.com/reel/Db44wsMgVBI/', false, null, true],
  ['https://instagram.com/reels/X?igsh=1', 'https://instagram.com/reels/X', false, null, true],
  ['https://www.instagram.com/someone/p/ABC/?igsh=x', 'https://www.instagram.com/p/ABC/', false, null, true],
  ['https://www.instagram.com/p/Db44wsMgVBI/', 'https://www.instagram.com/p/Db44wsMgVBI/', true, null, true],
  ['https://www.instagram.com/tv/Db44wsMgVBI/', 'https://www.instagram.com/tv/Db44wsMgVBI/', true, null, true],
  ['https://www.instagram.com/p/Db44wsMgVBI', 'https://www.instagram.com/p/Db44wsMgVBI', true, null, true],
  ['https://instagram.com/p/Db44wsMgVBI/', 'https://instagram.com/p/Db44wsMgVBI/', true, null, true],
  ['https://www.instagram.com/p/Db44wsMgVBI/#comments', 'https://www.instagram.com/p/Db44wsMgVBI/', false, null, true],
  ['https://www.instagram.com/p/Db44wsMgVBI/?igsh=abc&utm_source=ig_web_copy_link#x', 'https://www.instagram.com/p/Db44wsMgVBI/', false, null, true],
  ['https://www.instagram.com/p/a_B-c9/?igsh=z', 'https://www.instagram.com/p/a_B-c9/', false, null, true],
  ['https://www.instagram.com/some.user_1/p/ABC', 'https://www.instagram.com/p/ABC', false, null, true],
  ['http://www.instagram.com/p/ABC/', 'https://www.instagram.com/p/ABC/', false, null, true],
  ['https://m.instagram.com/p/ABC/?igsh=1', 'https://m.instagram.com/p/ABC/', false, null, true],
  ['https://www.instagram.com/some.profile/', null, false, null, false],
  ['https://www.instagram.com/', null, false, null, false],
  ['https://www.instagram.com/explore/', null, false, null, false],
  ['https://www.instagram.com/stories/someone/1234567890/', null, false, null, false],
  ['https://www.instagram.com/p/', null, false, null, false],
  ['https://www.instagram.com/p/ABC/extra', null, false, null, false],
  ['https://www.instagram.com/p/AB%20C/', null, false, null, false],
  ['https://instagram.com.evil.example/p/ABC/', null, false, null, false],
  ['https://evilinstagram.com/p/ABC/', null, false, null, false],
  ['https://www.instagram.com/share/p/AbCdEfGhI/', null, false, null, false],
  ['https://www.instagram.com/reel/Db44wsMgVBI/?fbclid=abc&mibextid=x', 'https://www.instagram.com/reel/Db44wsMgVBI/', false, null, true],
  ['https://www.instagram.com/p/Db44wsMgVBI/?', 'https://www.instagram.com/p/Db44wsMgVBI/', false, null, true],
  ['', null, false, null, false],
];

GOLDEN.forEach(([input, norm, clean, threads, ig], i) => {
  const no = `A1-G-${String(i + 1).padStart(2, '0')}`;
  test(`${no} Threads／IG 既有對照零變動：${input.slice(0, 80) || '(空字串)'}`, () => {
    assert.equal(C.normalizePostUrl(input), norm, 'normalizePostUrl');
    assert.equal(C.isCleanPostUrl(input), clean, 'isCleanPostUrl');
    assert.equal(C.normalizeThreadsPostUrl(input), threads, 'normalizeThreadsPostUrl');
    assert.equal(C.isInstagramPostUrl(input), ig, 'isInstagramPostUrl');
    if (typeof C.isFacebookPostUrl === 'function') {
      assert.equal(C.isFacebookPostUrl(input), false, 'isFacebookPostUrl 對 Threads／IG 一律 false');
    }
  });
});
