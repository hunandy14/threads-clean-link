// test/facebook-url.test.js — 0.13.0 車道 A 的 A1：tcl-core 的 URL 層認得
// Facebook 貼文（normalizeFacebookPostUrl／isFacebookPostUrl／normalizePostUrl／
// isCleanPostUrl／extractPostId），鏡射手機 App 的清理規則。
//
// 規則摘要：
//   - host 限 fb.com、www.fb.com、facebook.com 與其 www.、m.、mbasic.、web.、
//     mobile. 子網域（不分大小寫），輸出一律 www.facebook.com；其他子網域（l.、
//     business. 等）、fb.watch、fb.me、偽冒網域一律 null。
//   - scheme 統一 https；路徑必須讓 postKeyOf 取得到 facebook:<id>，否則 null。
//   - query 只剝 17 個鍵（fbclid, mibextid, rdid, share_url, sfnsn, wtsid, refid,
//     ref, refsrc, __tn__, __xts__, notif_t, notif_id, paipv, extid,
//     comment_tracking, __cft__）與所有 utm_*，鍵名解碼後去掉結尾 [數字] 索引、
//     大小寫不敏感；其他參數逐字保留且順序不變；全部剝光時不留 ?。hash 與路徑
//     （含尾斜線）原樣。
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
  // E-3 翻轉：原期望保留裸網域 https://facebook.com，現在統一為 www.facebook.com
  ['A1-1-05', `https://facebook.com/${USER}/posts/${ID}?fbclid=x`, `${FB}/${USER}/posts/${ID}`, `facebook:${ID}`],
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
  // E-3 翻轉：A1-2-06 至 A1-2-09（m.／web.／fb.com 的貼文網址）原斷言為 null，現在統一成
  // www.facebook.com 並回非 null，改由 E1-15、E1-16、E1-18 等案例涵蓋。
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

// E-3 翻轉（實為 E-1／E-2）：原斷言 __cft__[0] 保留，現在 __cft__ 入剝除清單且中括號索引被忽略，必須剝除
test('A1-3-3 __cft__[0] 與 __tn__ 一併剝除', () => {
  const input = `${FB}/${USER}/posts/${ID}?__cft__[0]=AZfake&__tn__=%2CO%2CP-R`;
  const out = C.normalizePostUrl(input);
  assert.equal(typeof out, 'string', '必須正規化成功');
  const u = new URL(out);
  assert.equal(u.pathname, `/${USER}/posts/${ID}`);
  assert.equal(u.searchParams.has('__cft__[0]'), false, '__cft__[0] 剝掉');
  assert.equal(u.searchParams.has('__tn__'), false, '__tn__ 剝掉');
});

// E-3 翻轉：原斷言裸網域 facebook.com 不補 www，現在統一為 www.facebook.com
test('A1-3-4 host 統一：裸網域補 www、www 原樣', () => {
  assert.equal(C.normalizePostUrl(`https://facebook.com/reel/${ID}`), `${FB}/reel/${ID}`);
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

// ============================================================================
// 車道 E（0.13.0）：鏡射手機 App 的 Facebook 清理新規則
//   E-1 剝除清單加 __cft__
//   E-2 鍵名比對前去掉結尾 [數字]（可重複）再不分大小寫查清單
//   E-3 網域統一：fb.com／facebook.com／m.／mbasic.／web.／mobile.facebook.com → https://www.facebook.com
//   E-4 /share/r/、/share/p、/share/p/<碼> 回 null（回歸）
// App 案例（link-cleaner.test.ts）逐字搬入處以「App:」標示；App 用的
// /groups/1/permalink/2/ 在插件端抽不出 id（A1-2-01 為 null），改用 /groups/<gid>/posts/<id>/。
// ============================================================================

const E_GP = `/groups/${GID}/posts/${ID}/`;

// [案號, 輸入, 期望輸出]
const E_NORMALIZE_CASES = [
  // E-2／E-1：中括號追蹤參數（App 的「Facebook 帶中括號的追蹤參數」）
  ['E1-01', `${FB}${E_GP}?__cft__[0]=AZX&__tn__=%2CO%2CP-R`, `${FB}${E_GP}`], // App: __cft__[0] 與 __tn__ 一併剝除
  ['E1-02', `${FB}${E_GP}?__xts__[0]=68.ARB`, `${FB}${E_GP}`], // App: __xts__[0] 被剝除
  ['E1-03', `${FB}${E_GP}?__CFT__[1]=x`, `${FB}${E_GP}`], // App: 大小寫與索引不影響比對
  ['E1-04', `${FB}/permalink.php?story_fbid=${ID}&id=${GID}&__cft__[0]=x`, `${FB}/permalink.php?story_fbid=${ID}&id=${GID}`], // App: 功能參數保留，只剝追蹤參數
  // E-2 補充
  ['E1-05', `${FB}/${USER}/posts/${ID}?__tn__[1]=x`, `${FB}/${USER}/posts/${ID}`],
  ['E1-06', `${FB}/${USER}/posts/${ID}?utm_source[2]=x`, `${FB}/${USER}/posts/${ID}`],
  ['E1-07', `${FB}/${USER}/posts/${ID}?__cft__[0][1]=x`, `${FB}/${USER}/posts/${ID}`],
  ['E1-08', `${FB}/${USER}/posts/${ID}?__cft__%5B0%5D=x`, `${FB}/${USER}/posts/${ID}`],
  ['E1-09', `${FB}/${USER}/posts/${ID}?__CFT__[0]=x&__cft__=y`, `${FB}/${USER}/posts/${ID}`],
  ['E1-10', `${FB}/${USER}/posts/${ID}?a[0]=1`, `${FB}/${USER}/posts/${ID}?a[0]=1`],
  ['E1-11', `${FB}/${USER}/posts/${ID}?fields[0]=1&__cft__[0]=x&b[1][2]=3`, `${FB}/${USER}/posts/${ID}?fields[0]=1&b[1][2]=3`],
  ['E1-12', `${FB}/${USER}/posts/${ID}?a%5B0%5D=1&__cft__%5B0%5D=x`, `${FB}/${USER}/posts/${ID}?a%5B0%5D=1`],
  ['E1-13', `${FB}/${USER}/posts/${ID}?__cft__[0]=x#c`, `${FB}/${USER}/posts/${ID}#c`],
  // 中括號不在結尾、或括號內非數字：不是追蹤鍵
  ['E1-14', `${FB}/${USER}/posts/${ID}?__cft__[a]=x&__cft__[0]x=y`, `${FB}/${USER}/posts/${ID}?__cft__[a]=x&__cft__[0]x=y`],
  // E-3：網域統一（App 的「Facebook 網域統一為 www.facebook.com」）
  ['E1-15', `https://fb.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`], // App: fb.com 改寫為 www.facebook.com
  ['E1-16', `http://m.facebook.com/story.php?story_fbid=${ID}&id=${GID}&fbclid=x`, `${FB}/story.php?story_fbid=${ID}&id=${GID}`], // App: m. 的 http 改 https 並剝追蹤參數
  ['E1-17', `https://mbasic.facebook.com${E_GP}`, `${FB}${E_GP}`], // App: mbasic 改寫為 www
  ['E1-18', `https://web.facebook.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`], // App: web 子網域改寫為 www
  ['E1-19', `https://facebook.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`], // App: 裸網域改寫為 www
  ['E1-20', `http://www.facebook.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`], // App: www 的 http 只改 protocol
  // E-3 補充
  ['E1-21', `https://www.fb.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`],
  ['E1-22', `https://mobile.facebook.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`],
  ['E1-23', `https://M.Facebook.com/${USER}/posts/${ID}`, `${FB}/${USER}/posts/${ID}`],
  ['E1-24', `http://FB.COM/${USER}/posts/${ID}?fbclid=x`, `${FB}/${USER}/posts/${ID}`],
  ['E1-25', `https://m.facebook.com/reel/${ID}/?fbclid=x&s=fakeS1#top`, `${FB}/reel/${ID}/?s=fakeS1#top`],
  ['E1-26', `https://m.facebook.com/photo/?fbid=${PHID}&set=a.${GID}&__tn__=EH-R`, `${FB}/photo/?fbid=${PHID}&set=a.${GID}`],
  ['E1-27', `https://mbasic.facebook.com/permalink.php?story_fbid=${ID}&id=${GID}&refsrc=x`, `${FB}/permalink.php?story_fbid=${ID}&id=${GID}`],
  ['E1-28', `http://web.facebook.com/${PAGE}/videos/${ID}/?__cft__[0]=x`, `${FB}/${PAGE}/videos/${ID}/`],
  ['E1-29', `https://fb.com/watch/?v=${ID}`, `${FB}/watch/?v=${ID}`],
  ['E1-30', `https://m.facebook.com/${USER}/posts/${PFBID}/`, `${FB}/${USER}/posts/${PFBID}/`],
];

for (const [no, input, expected] of E_NORMALIZE_CASES) {
  test(`${no} normalizeFacebookPostUrl(${input}) → ${expected}`, () => {
    assert.equal(C.normalizeFacebookPostUrl(input), expected);
    assert.equal(C.normalizePostUrl(input), expected, 'normalizePostUrl 一致');
  });
}

test('E1-31 E 系列輸出冪等且通過 isCleanPostUrl，輸入若與輸出不同則不算乾淨', () => {
  for (const [no, input, expected] of E_NORMALIZE_CASES) {
    assert.equal(C.normalizeFacebookPostUrl(expected), expected, `${no} 冪等`);
    assert.equal(C.isCleanPostUrl(expected), true, `${no} 輸出乾淨`);
    if (input !== expected) assert.equal(C.isCleanPostUrl(input), false, `${no} 輸入不乾淨`);
    assert.equal(C.isFacebookPostUrl(input), true, `${no} isFacebookPostUrl`);
  }
});

// 回 null：其他子網域、fb.watch、fb.me、抽不出 id、E-4 的 share 短碼
const E_NULL_CASES = [
  ['E1-32', 'https://l.facebook.com/l.php?u=x'], // App: l. 的 host 不動
  ['E1-33', `https://business.facebook.com/${USER}/posts/${ID}`],
  ['E1-34', `https://developers.facebook.com/${USER}/posts/${ID}`],
  ['E1-35', 'https://fb.watch/AbC123fake/'], // App: fb.watch 不動
  ['E1-36', `https://fb.me/${USER}/posts/${ID}`],
  ['E1-37', 'https://web.archive.org/x'], // App: web.archive.org 不動
  ['E1-38', 'https://example.com/a?__cft__[0]=x'], // App: 非 Facebook 網域保留（插件端不歸它管）
  ['E1-39', 'https://www.facebook.com/share/r/AbC123fake/'],
  ['E1-40', 'https://www.facebook.com/share/p/AbC123fake/'],
  ['E1-41', 'https://www.facebook.com/share/p'],
  ['E1-42', 'https://m.facebook.com/share/p/AbC123fake/?fbclid=x'],
  ['E1-43', 'https://fb.com/share/r/AbC123fake/'],
  ['E1-44', `https://m.facebook.com/${USER}`],
  ['E1-45', 'https://fb.com/'],
  ['E1-46', 'https://mbasic.facebook.com/groups/1/permalink/2/'], // App 有此案例；插件端 permalink 抽不出 id 仍為 null
  ['E1-47', 'https://www.facebook.com/permalink.php?id=5&__cft__[0]=x'], // App 有此案例；缺 story_fbid 抽不出 id
  ['E1-48', `https://m.facebook.com.evil.example/${USER}/posts/${ID}`],
  ['E1-49', `https://evil.example/m.facebook.com/${USER}/posts/${ID}`],
];

for (const [no, input] of E_NULL_CASES) {
  test(`${no} 回 null 且不算乾淨：${input}`, () => {
    assert.equal(C.normalizeFacebookPostUrl(input), null);
    assert.equal(C.normalizePostUrl(input), null);
    assert.equal(C.isCleanPostUrl(input), false);
    assert.equal(C.isFacebookPostUrl(input), false);
  });
}
