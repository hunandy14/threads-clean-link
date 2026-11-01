// test/media-kind.test.js — 0.13.0 車道 F 的 F-1：tcl-core 的 mediaKindOf(url)
// 從網址判斷貼文媒體種類，鏡射手機 App 的 src/lib/media-kind.ts。
//
// 規則摘要（回傳 'video' | 'photo' | null，只看網址、不連網、不猜）：
//   - facebook.com 與其子網域（www、m 等）：
//       影片：…/videos/<數字>/?、/reel/<數字>/?、/watch/? 帶非空 v。
//       相片：/photo/? 或 /photo.php 帶非空 fbid、…/photos/<段>/<數字>/?。
//       其餘（/posts/、permalink.php、/share/p/、/share/v/ 等）null。
//   - fb.watch（含子網域）：路徑去掉斜線後非空即影片，空路徑 null。
//   - instagram.com 與其子網域：/reel/、/reels/、/tv/<shortcode>/? 影片；
//     /p/<shortcode>/? 相片（F-1 例外：使用者拍板，App 端同步改）；其餘 null。
//   - Threads、其他平台、非字串、空字串、無法解析的字串一律 null。
//   - host 比對為「完全相同或為其子網域」，大小寫不敏感；路徑規則錨定結尾，
//     query 與 hash 不影響判斷。
//
// 測試資料的帳號名、數字 id、shortcode 皆為假值。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

// ---- F1-01～F1-26 照抄 App media-kind.test.ts ----

// [條號, 說明, 輸入, 期望]
const APP_CASES = [
  // 影片
  ['F1-01', 'FB /videos/<數字>', 'https://www.facebook.com/somepage/videos/1234567890', 'video'],
  ['F1-02', 'FB /videos/ 尾斜線', 'https://www.facebook.com/somepage/videos/1234567890/', 'video'],
  ['F1-03', 'FB /reel/<id>', 'https://www.facebook.com/reel/1234567890', 'video'],
  ['F1-04', 'FB /watch/?v=', 'https://www.facebook.com/watch/?v=1234567890', 'video'],
  ['F1-05', 'FB /watch?v=', 'https://www.facebook.com/watch?v=1234567890', 'video'],
  ['F1-06', 'm.facebook.com 影片', 'https://m.facebook.com/somepage/videos/1234567890', 'video'],
  ['F1-07', 'fb.watch 短網址', 'https://fb.watch/abcDEF123/', 'video'],
  ['F1-08', 'IG /reel/', 'https://www.instagram.com/reel/Cabc_123-x/', 'video'],
  ['F1-09', 'IG /reels/', 'https://www.instagram.com/reels/Cabc_123-x/', 'video'],
  ['F1-10', 'IG /tv/', 'https://www.instagram.com/tv/Cabc_123-x/', 'video'],
  // 相片
  ['F1-11', 'FB /photo.php?fbid=', 'https://www.facebook.com/photo.php?fbid=1234567890', 'photo'],
  ['F1-12', 'FB /photo/?fbid=', 'https://www.facebook.com/photo/?fbid=1234567890', 'photo'],
  ['F1-13', 'FB /photos/<album>/<數字>', 'https://www.facebook.com/somepage/photos/a.111/1234567890', 'photo'],
  ['F1-14', 'm.facebook.com 相片', 'https://m.facebook.com/photo.php?fbid=1234567890', 'photo'],
  // 不確定一律 null
  ['F1-15', 'FB /posts/', 'https://www.facebook.com/somepage/posts/1234567890', null],
  ['F1-16', 'FB permalink.php', 'https://www.facebook.com/permalink.php?story_fbid=123&id=456', null],
  ['F1-17', 'FB /share/p/', 'https://www.facebook.com/share/p/abcDEF123/', null],
  ['F1-18', 'FB /share/v/', 'https://www.facebook.com/share/v/abcDEF123/', null],
  ['F1-19', 'FB /watch 沒有 v', 'https://www.facebook.com/watch/', null],
  ['F1-20', 'FB /photo.php 沒有 fbid', 'https://www.facebook.com/photo.php', null],
  ['F1-21', 'fb.watch 空路徑', 'https://fb.watch/', null],
  // F-1 例外：使用者拍板 IG /p/（含輪播）標相片；App 現行測試期望 null，App 端會同步改。
  ['F1-22', 'IG /p/（F-1 例外：使用者拍板）', 'https://www.instagram.com/p/Cabc_123-x/', 'photo'],
  ['F1-23', 'Threads 貼文', 'https://www.threads.com/@someone/post/DLabc123', null],
  ['F1-24', '其他平台', 'https://example.com/videos/1234567890', null],
  ['F1-25', '無效字串', 'not a url', null],
  ['F1-26', '空字串', '', null],
];

// ---- F1-40～F1-67 插件端補充：非貼文網址、host 邊界、大小寫、query／hash ----

const EXTRA_CASES = [
  // 非貼文網址與其他站
  ['F1-40', 'Threads 首頁', 'https://www.threads.com/', null],
  ['F1-41', 'threads.net 貼文', 'https://www.threads.net/@someone/post/DLabc123', null],
  ['F1-42', 'FB 首頁', 'https://www.facebook.com/', null],
  ['F1-43', 'FB 個人頁', 'https://www.facebook.com/someone', null],
  ['F1-44', 'IG 首頁', 'https://www.instagram.com/', null],
  ['F1-45', 'IG 個人頁', 'https://www.instagram.com/someone/', null],
  ['F1-46', 'IG /explore/', 'https://www.instagram.com/explore/', null],
  // IG /p/ 其他形狀（F-1 例外延伸：輪播帶 img_index 仍是相片）
  ['F1-47', 'IG /p/ 無尾斜線', 'https://www.instagram.com/p/Cabc_123-x', 'photo'],
  ['F1-48', 'IG /p/ 輪播 ?img_index=', 'https://www.instagram.com/p/Cabc_123-x/?img_index=2', 'photo'],
  ['F1-49', 'IG 無 www 的 /p/', 'https://instagram.com/p/Cabc_123-x/', 'photo'],
  // 路徑錨定結尾：多一段就不認
  ['F1-50', 'IG /reel/ 後多一段', 'https://www.instagram.com/reel/Cabc_123-x/audio/', null],
  ['F1-51', 'FB /reel/ 非數字 id', 'https://www.facebook.com/reel/abcDEF', null],
  ['F1-52', 'FB /videos/ 後多一段', 'https://www.facebook.com/somepage/videos/1234567890/extra', null],
  ['F1-53', 'FB /watch/?v= 空值', 'https://www.facebook.com/watch/?v=', null],
  ['F1-54', 'FB /photo/?fbid= 空值', 'https://www.facebook.com/photo/?fbid=', null],
  // query／hash 不影響
  ['F1-55', 'FB /reel/ 帶 query 與 hash', 'https://www.facebook.com/reel/1234567890/?s=fb_shorts&mibextid=x#c', 'video'],
  ['F1-56', 'FB /videos/ 帶 hash', 'https://www.facebook.com/somepage/videos/1234567890#t=10', 'video'],
  ['F1-57', 'FB /photo/?fbid=&set=', 'https://www.facebook.com/photo/?fbid=1234567890&set=a.111', 'photo'],
  ['F1-58', 'IG /reel/ 帶 query 與 hash', 'https://www.instagram.com/reel/Cabc_123-x/?igsh=abc#x', 'video'],
  // host 大小寫與子網域邊界（App shared/platform-rules：完全相同或為其子網域）
  ['F1-59', 'FB 大寫 host', 'https://WWW.FaceBook.COM/reel/1234567890', 'video'],
  ['F1-60', 'IG 大寫 host', 'https://WWW.INSTAGRAM.COM/p/Cabc_123-x/', 'photo'],
  ['F1-61', 'fb.watch 大寫 host', 'https://FB.WATCH/abcDEF123', 'video'],
  ['F1-62', 'web.facebook.com 子網域', 'https://web.facebook.com/photo.php?fbid=1234567890', 'photo'],
  ['F1-63', '無 www 的 facebook.com', 'https://facebook.com/reel/1234567890', 'video'],
  ['F1-64', '偽冒網域 evilfacebook.com', 'https://evilfacebook.com/reel/1234567890', null],
  ['F1-65', '偽冒網域 facebook.com.evil.test', 'https://facebook.com.evil.test/reel/1234567890', null],
  ['F1-66', '偽冒網域 notinstagram.com', 'https://notinstagram.com/p/Cabc_123-x/', null],
  ['F1-67', 'fb.com 不在名單', 'https://fb.com/reel/1234567890', null],
];

const ALL_CASES = APP_CASES.concat(EXTRA_CASES);

for (const [no, name, input, expected] of ALL_CASES) {
  test(`${no} mediaKindOf：${name} → ${expected}`, () => {
    assert.equal(C.mediaKindOf(input), expected);
  });
}

test('F1-70 mediaKindOf：非字串輸入一律 null、不丟例外', () => {
  for (const input of [undefined, null, 0, 123, true, {}, [], () => {}]) {
    assert.equal(C.mediaKindOf(input), null, `輸入 ${String(input)}`);
  }
});

test('F1-71 mediaKindOf：回傳值只會是 video、photo 或 null', () => {
  const allowed = new Set(['video', 'photo', null]);
  for (const [, , input] of ALL_CASES) {
    assert.ok(allowed.has(C.mediaKindOf(input)), input);
  }
});
