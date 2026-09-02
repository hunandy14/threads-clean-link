// test/post-key.test.js — TCLCore.postKeyOf(手機 postKeyOf 逐字移植)的行為
// 契約。目標函式尚未實作，本檔為紅燈骨架。
//
// 規格出處:
//   - 手機端規則本體:C:\gitRepos\meta-link-clearer\src\lib\post-key.ts
//     (全檔;postKeyOf 本體第 52-72 行，hostnameEndsWith 第 11-14 行，
//     urlKey 第 41-46 行，THREADS_POST/INSTAGRAM_POST/FACEBOOK_* 第 17-28 行)
//   - 手機端既有測試(對照表案例的交叉核對來源):
//     C:\gitRepos\meta-link-clearer\src\lib\post-key.test.ts
//   - 每一組期望值皆用手機原始碼實際跑出(scratchpad 一次性腳本以 Node
//     type-stripping import 直接載入 post-key.ts，見任務對話紀錄)，不是手
//     打推算。
//   - 插件現況(將被取代/並存的舊行為):tcl-core.js 的 extractPostId(第
//     112-128 行，只認 STRICT_POST_URL_PATTERN——無尾斜線、無 query、僅
//     www. 可選前綴、handle 白名單字元類 [A-Za-z0-9._]{1,80}、code 上限
//     [A-Za-z0-9_-]{1,80})與 background.js 的 historyDedupKey(第 820 行，
//     `TCLCore.extractPostId(url) || url`)。
//   - 目標介面:TCLCore.postKeyOf(url)——純函式，ES5 IIFE 風格，SW 與擴充頁
//     共用，輸入輸出與手機 postKeyOf 完全等價。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

// ---- 對照表:輸入網址 → 期望 key(手機 postKeyOf 實際算出) ----
//
// 每一列 [input, expected]。分組對齊手機 post-key.test.ts 的分類(Threads/
// Instagram/Facebook/其他網址與異常輸入)，另加上插件舊 extractPostId 會分
// 裂但手機 postKeyOf 視為同一篇的邊界案例(見下方個別標註)。
const CASES = [
  // -- Threads:網域變體(threads.com/.net、www./裸網域/m.)都是同一篇 --
  ['https://www.threads.com/@abc/post/DLxyz_1-', 'threads:DLxyz_1-'],
  ['https://www.threads.net/@abc/post/DLxyz_1-', 'threads:DLxyz_1-'],
  ['https://threads.com/@abc/post/DLxyz_1-', 'threads:DLxyz_1-'],
  ['https://threads.net/@abc/post/DLxyz_1-', 'threads:DLxyz_1-'],
  // 【分裂案例】m. 子網域:舊 extractPostId 只認 www. 前綴，m. 落回整條 url
  // fallback key;postKeyOf 用 hostnameEndsWith，任何子網域都算數。
  ['https://m.threads.com/@abc/post/DLxyz_1-', 'threads:DLxyz_1-'],
  ['https://m.threads.net/@abc/post/DLxyz_1-', 'threads:DLxyz_1-'],
  // 【分裂案例】尾斜線:舊 extractPostId 錨定收尾不容尾斜線;postKeyOf 的
  // THREADS_POST 樣式尾端是 `\/?$`，容忍。
  ['https://www.threads.com/@abc/post/DLxyz_1-/', 'threads:DLxyz_1-'],
  // 作者改 handle，post ID 不變，仍是同一篇。
  ['https://www.threads.com/@renamed/post/DLxyz_1-/', 'threads:DLxyz_1-'],
  // handle 含點與底線。
  ['https://www.threads.com/@ab.c_d/post/CODE123', 'threads:CODE123'],
  ['https://www.threads.com/@a_b.c-d/post/Code_9-', 'threads:Code_9-'],
  // code 邊界:單一字元、混合連字號與底線。
  ['https://www.threads.com/@abc/post/A', 'threads:A'],
  ['https://www.threads.com/@abc/post/A-_9', 'threads:A-_9'],
  // 【分裂案例】帶 query:舊 extractPostId 錨定收尾不容 query;postKeyOf 用
  // parsed.pathname 比對(URL 已把 query 拆開)，不受影響。
  ['https://www.threads.com/@abc/post/DLxyz_1-?xmt=abc', 'threads:DLxyz_1-'],
  ['https://www.threads.com/@abc/post/DLxyz_1-/?igsh=xyz', 'threads:DLxyz_1-'],
  // 【分裂案例】怪 handle(含插件白名單字元類之外的 `~`):舊 extractPostId
  // 的 handle 類是 [A-Za-z0-9._]{1,80}，`~` 不在其中，落回整條 url fallback
  // key;postKeyOf 的 THREADS_POST handle 類是 [^/]+，不限字元。
  ['https://www.threads.com/@weird~handle/post/AbC123', 'threads:AbC123'],
  // 【分裂案例】code 超過插件舊上限 80 字元:extractPostId 的 code 類上限
  // {1,80}，超長回 null;postKeyOf 的 code 類 [A-Za-z0-9_-]+ 無上限。
  ['https://www.threads.com/@abc/post/' + 'A'.repeat(81), 'threads:' + 'A'.repeat(81)],
  // 非貼文路徑一律退回網址 key。
  ['https://www.threads.com/', 'url:threads.com/'],
  ['https://www.threads.com/login/', 'url:threads.com/login'],
  ['https://www.threads.com/share/ABC123', 'url:threads.com/share/ABC123'],
  ['https://m.threads.com/@abc/', 'url:threads.com/@abc'],

  // -- Instagram:/p、/reel、/reels、/tv 同一個 shortcode 是同一篇 --
  ['https://www.instagram.com/p/Db44wsMgVBI/', 'instagram:Db44wsMgVBI'],
  ['https://www.instagram.com/reel/Db44wsMgVBI/', 'instagram:Db44wsMgVBI'],
  ['https://www.instagram.com/reels/Db44wsMgVBI', 'instagram:Db44wsMgVBI'],
  ['https://www.instagram.com/tv/Db44wsMgVBI/', 'instagram:Db44wsMgVBI'],
  // 個人頁不是貼文，退回網址 key。
  ['https://www.instagram.com/some.profile/', 'url:instagram.com/some.profile'],

  // -- Facebook:路徑型與 query 型 --
  ['https://www.facebook.com/somepage/posts/123', 'facebook:123'],
  ['https://m.facebook.com/somepage/posts/123/', 'facebook:123'],
  ['https://www.facebook.com/groups/9/posts/pfbid02AbC_-/', 'facebook:pfbid02AbC_-'],
  ['https://www.facebook.com/somepage/videos/456/', 'facebook:456'],
  ['https://www.facebook.com/reel/789', 'facebook:789'],
  ['https://www.facebook.com/somepage/photos/a.1/222/', 'facebook:222'],
  ['https://www.facebook.com/permalink.php?story_fbid=123&id=999', 'facebook:123'],
  ['https://www.facebook.com/story.php?story_fbid=123&id=999', 'facebook:123'],
  ['https://www.facebook.com/photo/?fbid=321&set=a.1', 'facebook:321'],
  ['https://www.facebook.com/photo.php?fbid=321', 'facebook:321'],
  ['https://www.facebook.com/watch/?v=654', 'facebook:654'],
  // 未解析的 /share/ 短碼與 fb.watch 退回網址 key。
  ['https://www.facebook.com/share/p/AbC123/', 'url:facebook.com/share/p/AbC123'],
  ['https://fb.watch/abc/', 'url:fb.watch/abc'],

  // -- 其他網址:退回 url key，host 小寫去 www./m./mobile.、路徑去尾斜線、query 保留 --
  ['https://WWW.Example.com/page/', 'url:example.com/page'],
  ['https://m.example.com/a?x=1', 'url:example.com/a?x=1'],
  ['https://mobile.example.com/a/', 'url:example.com/a'],
  ['https://example.com', 'url:example.com/'],
  // 網域尾碼詐騙(host 只是「包含」threads.com 字串，不是以它結尾)不得誤判
  // 成 Threads 網域——hostnameEndsWith 用 endsWith('.' + suffix)，不是
  // includes，擋得住這種釣魚變體。
  ['https://sub.threads.com.evil.com/@abc/post/FAKE123', 'url:sub.threads.com.evil.com/@abc/post/FAKE123'],

  // -- 異常輸入:不丟例外，原樣包成 url key --
  ['not a url', 'url:not a url'],
  ['', 'url:'],
  // javascript: 這類非 http(s) scheme 仍會被 `new URL()` 成功解析
  // (hostname 為空字串、pathname 為 scheme 之後那段)，hostnameEndsWith 三
  // 項判定皆為 false，一路落到 urlKey 退回網址 key。
  ['javascript:alert(1)', 'url:alert(1)'],
];

test('postKeyOf:對照表——與手機 postKeyOf 逐一比對(含插件舊 extractPostId 會分裂的邊界案例)', () => {
  for (const [input, expected] of CASES) {
    assert.equal(C.postKeyOf(input), expected, `postKeyOf(${JSON.stringify(input)}) 應為 ${JSON.stringify(expected)}`);
  }
});

// ---- 分裂案例逐條命名斷言(對照表已涵蓋，這裡額外標註意圖，避免實作者只
// 挑對照表裡「看起來眼熟」的案例應付) ----

test('postKeyOf:尾斜線容忍——與無尾斜線版本算出同一個 key(舊 extractPostId 不容忍)', () => {
  const withSlash = C.postKeyOf('https://www.threads.com/@abc/post/DLxyz_1-/');
  const noSlash = C.postKeyOf('https://www.threads.com/@abc/post/DLxyz_1-');
  assert.equal(withSlash, noSlash);
  assert.equal(withSlash, 'threads:DLxyz_1-');
});

test('postKeyOf:m. 子網域與 www. 算出同一個 key(舊 extractPostId 只認 www.)', () => {
  const mSub = C.postKeyOf('https://m.threads.com/@abc/post/DLxyz_1-');
  const www = C.postKeyOf('https://www.threads.com/@abc/post/DLxyz_1-');
  assert.equal(mSub, www);
  assert.equal(mSub, 'threads:DLxyz_1-');
});

test('postKeyOf:handle 含插件白名單字元類之外的字元(~)仍取得出 post ID(舊 extractPostId 落回整條 url)', () => {
  assert.equal(C.postKeyOf('https://www.threads.com/@weird~handle/post/AbC123'), 'threads:AbC123');
});

test('postKeyOf:純函式、無副作用——同輸入重複呼叫、不同輸入互不影響結果', () => {
  const url = 'https://www.threads.com/@abc/post/DLxyz_1-';
  const first = C.postKeyOf(url);
  C.postKeyOf('https://www.facebook.com/somepage/posts/999');
  const second = C.postKeyOf(url);
  assert.equal(first, second);
});
