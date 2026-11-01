// test/post-icon-facebook.test.js — post-icon.js 的 Facebook 站點設定：單篇貼文
// （dialog）、Reel、相片頁三種頁型各自的頁型判斷、容器、permalink、互動列與
// 插入點、作者、內文、canonical 網址，以及整合層的注入、點擊、portal 晚到、
// Reel 捲動換網址、fail-closed 與 Trusted Types。
//
// 介面約定見 test/post-icon-sites.test.js 檔頭；Facebook 另有：
//   - ctx 多帶 search（location.search），pageType(pathname, search) 第二參數
//     可省略。
//   - labels.menu：Reel 直向欄「功能表」按鈕的 aria-label 開頭比對表。
//
// fixture（test/fixtures/facebook/*.html）由 2026-11-01 zh-Hant 實測 dump 以程
// 式裁剪、匿名化，層級原樣保留；各檔檔頭說明標了 id 的節點。版面以
// data-fx-top／data-fx-height stub（ig-dom 的 getBoundingClientRect 替身，無
// 此屬性的元素 rect 全 0），Facebook 的 0x0 重複互動列就是不帶它的那份。
//
// 條號 C1-1 起，與規格車道 C 第 10 點逐項對應。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  SVG_NS,
  FB_ORIGIN,
  readFbFixture,
  fbDocument,
  createFbEnv,
  clearRects,
  setRect,
  settle,
  assertSameNode,
} = require('./support/fb-dom');

const ORIGIN = FB_ORIGIN;
const FAKE_PFBID = 'pfbid0FXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POST_PATH = '/fx_user_a/posts/' + FAKE_PFBID;
const REEL_ID = '100000000000006';
const REEL_NEXT_ID = '100000000000007';
const REEL_PATH = '/reel/' + REEL_ID;
const PHOTO_FBID = '100000000000005';
const PHOTO_PATH = '/photo/';
const PHOTO_SEARCH = '?fbid=' + PHOTO_FBID;

const POST_CTX = { pageType: 'post', pathname: POST_PATH, search: '', origin: ORIGIN, innerHeight: 900 };
const REEL_CTX = { pageType: 'reel', pathname: REEL_PATH, search: '', origin: ORIGIN, innerHeight: 900 };
const PHOTO_CTX = { pageType: 'photo', pathname: PHOTO_PATH, search: PHOTO_SEARCH, origin: ORIGIN, innerHeight: 900 };

const POST_AUTHOR = '示意作者甲';
const REEL_AUTHOR = '示意作者乙';
const PHOTO_AUTHOR = '示意作者丙';
const REEL_CAPTION = '示意短片說明，這是一則合成的 Reel 說明文字。';
const PHOTO_CAPTION = '示意相片說明第一行，描述這張合成的照片。\n示意相片說明第二行。';

function facebook() {
  const api = require(path.join(__dirname, '..', 'post-icon.js'));
  assert.ok(api.__sites && api.__sites.facebook, 'post-icon 應匯出 __sites.facebook');
  return api.__sites.facebook;
}

function ids(list) {
  return Array.from(list).map((n) => n.id);
}

function childIds(node) {
  return node.children.map((c) => (c.className === 'tcl-copy-icon' ? '<icon>' : c.id || c.localName));
}

async function loadPage(fixture, pathname, extra) {
  const env = createFbEnv(Object.assign({ pathname, html: readFbFixture(fixture) }, extra || {})).loadPostIcon();
  await settle();
  return env;
}

function iconIn(env, id) {
  const node = env.byId(id);
  assert.ok(node, 'fixture 應有 #' + id);
  return node.querySelector('.tcl-copy-icon');
}

async function clickIcon(env, icon) {
  assert.ok(icon, '要點的按鈕必須存在');
  icon.fire('click');
  await settle();
}

// ============================================================
// 站點選擇與介面
// ============================================================

test('C1-1 站點選擇：www.facebook.com 與 facebook.com 選 facebook；m.／其他子網域、fb.watch、尾綴仿冒回 null', () => {
  const api = require(path.join(__dirname, '..', 'post-icon.js'));
  assert.equal(typeof api.__selectSite, 'function');
  ['www.facebook.com', 'facebook.com'].forEach((host) => {
    assert.equal(api.__selectSite(host), api.__sites.facebook, host);
  });
  ['m.facebook.com', 'web.facebook.com', 'fb.watch', 'facebook.com.evil.io', 'notfacebook.com', 'fb.com'].forEach(
    (host) => {
      assert.equal(api.__selectSite(host), null, host);
    }
  );
});

test('C1-2 介面：__sites.facebook 帶 id 與十個介面函式，labels.menu 為功能表比對表', () => {
  const fb = facebook();
  assert.equal(fb.id, 'facebook');
  [
    'matches',
    'pageType',
    'findContainers',
    'permalinkOf',
    'findActionRow',
    'insertionPoint',
    'author',
    'excerpt',
    'canonicalUrl',
    'observeRoot',
  ].forEach((name) => assert.equal(typeof fb[name], 'function', 'facebook.' + name + ' 應為函式'));
  assert.ok(fb.labels && Array.isArray(fb.labels.menu), 'facebook.labels.menu 應為陣列');
  assert.deepEqual(Array.from(fb.labels.menu), ['功能表', 'Menu', 'More options', 'More']);
});

test('C1-3 站點選擇：三站 matches 互不搶網域', () => {
  const api = require(path.join(__dirname, '..', 'post-icon.js'));
  const { threads, instagram, facebook: fb } = api.__sites;
  assert.equal(fb.matches('www.facebook.com'), true);
  assert.equal(fb.matches('www.instagram.com'), false);
  assert.equal(fb.matches('www.threads.com'), false);
  assert.equal(threads.matches('www.facebook.com'), false);
  assert.equal(instagram.matches('www.facebook.com'), false);
});

// ============================================================
// 純函式層：頁型、canonical、observeRoot
// ============================================================

test('C1-4 pageType：/<user>/posts/<id>、permalink.php?story_fbid=、story.php 是 post', () => {
  const fb = facebook();
  [
    [POST_PATH, ''],
    ['/fx_user_a/posts/100000000000001', ''],
    ['/fx_user_a/posts/' + FAKE_PFBID, '?__cft__[0]=AZfx&__tn__=%2CO%2CP-R'],
    ['/permalink.php', '?story_fbid=' + FAKE_PFBID + '&id=100000000000002'],
    ['/story.php', '?story_fbid=100000000000003&id=100000000000002'],
  ].forEach(([pathname, search]) => {
    assert.equal(fb.pageType(pathname, search), 'post', pathname + search);
  });
});

test('C1-5 pageType：^/reel/<digits> 是 reel；/photo/ 或 /photo.php 帶 fbid 是 photo；第二參數可省略', () => {
  const fb = facebook();
  assert.equal(fb.pageType(REEL_PATH, ''), 'reel');
  assert.equal(fb.pageType(REEL_PATH), 'reel', '不帶 search 也能判斷');
  assert.equal(fb.pageType('/photo/', PHOTO_SEARCH), 'photo');
  assert.equal(fb.pageType('/photo/', PHOTO_SEARCH + '&set=a.100000000000004'), 'photo');
  assert.equal(fb.pageType('/photo.php', PHOTO_SEARCH), 'photo');
  [
    ['/reel/', ''],
    ['/reel/', '?s=tab'],
    ['/reel/FXCODE', ''],
    ['/fx_user_a/reel/' + REEL_ID, ''],
    ['/photo/', ''],
    ['/photo/', '?set=a.100000000000004'],
  ].forEach(([pathname, search]) => {
    assert.equal(fb.pageType(pathname, search), null, pathname + search);
  });
});

test('C1-6 pageType：動態牆、watch、群組、個人檔案、share 短碼等其他路徑一律 null', () => {
  const fb = facebook();
  [
    ['/', ''],
    ['/', '?sk=h_chr'],
    ['/watch', ''],
    ['/watch/', '?v=100000000000008'],
    ['/groups/100000000000011/', ''],
    ['/groups/100000000000011/permalink/100000000000012/', ''],
    ['/fx_user_a', ''],
    ['/profile.php', '?id=100000000000002'],
    ['/permalink.php', ''],
    ['/share/p/FXSHARE01/', ''],
    ['/marketplace/', ''],
  ].forEach(([pathname, search]) => {
    assert.equal(fb.pageType(pathname, search), null, pathname + search);
  });
});

test('C1-7 canonicalUrl：post／reel 為 origin＋路徑，去 query 與 hash', () => {
  const fb = facebook();
  [
    [POST_PATH, ORIGIN + POST_PATH],
    [POST_PATH + '?__cft__[0]=AZfx&__tn__=%2CO%2CP-R#?xyz', ORIGIN + POST_PATH],
    [ORIGIN + POST_PATH + '?comment_id=100000000000013', ORIGIN + POST_PATH],
    [REEL_PATH, ORIGIN + REEL_PATH],
    [REEL_PATH + '?s=fb_shorts_tab#x', ORIGIN + REEL_PATH],
  ].forEach(([href, expected]) => {
    assert.equal(fb.canonicalUrl(href, ORIGIN), expected, href);
  });
});

test('C1-8 canonicalUrl：photo 只留 fbid 參數，其餘 query 與 hash 去掉', () => {
  const fb = facebook();
  const expected = ORIGIN + '/photo/?fbid=' + PHOTO_FBID;
  [
    '/photo/?fbid=' + PHOTO_FBID,
    '/photo/?fbid=' + PHOTO_FBID + '&set=a.100000000000004',
    '/photo/?set=pcb.100000000000004&fbid=' + PHOTO_FBID + '&__tn__=%2CO*F#?ibd',
  ].forEach((href) => {
    assert.equal(fb.canonicalUrl(href, ORIGIN), expected, href);
  });
});

test('C1-9 canonicalUrl：換域、protocol-relative、非常規 scheme、非字串回 null', () => {
  const fb = facebook();
  [
    'https://evil.example' + POST_PATH,
    '//evil.example' + POST_PATH,
    'javascript:alert(1)',
    123,
    null,
    undefined,
  ].forEach((href) => {
    assert.equal(fb.canonicalUrl(href, ORIGIN), null, String(href));
  });
});

test('C1-10 observeRoot：觀察 body（dialog 是掛在 body 下的 portal）', () => {
  const doc = fbDocument('post-dialog.html');
  assertSameNode(facebook().observeRoot(doc), doc.body);
});

// ============================================================
// 純函式層：單篇貼文（dialog）
// ============================================================

test('C1-11 post：容器限定 [role=dialog] 內的 [aria-posinset]，背景 feed 貼文不被選中', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  assert.equal(doc.querySelectorAll('[aria-posinset]').length, 2, '前提：背景 feed 與 dialog 各一則');
  assert.deepEqual(ids(fb.findContainers(doc, POST_CTX)), ['fx-post']);
});

test('C1-12 post：dialog 不存在時 0 個容器（背景 feed 不頂替）', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  const dialog = doc.getElementById('fx-dialog');
  dialog.parentNode.removeChild(dialog);
  assert.deepEqual(ids(fb.findContainers(doc, POST_CTX)), []);
});

test('C1-13 post：permalink 取 ctx.pathname，canonical 為 origin＋路徑', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  const post = doc.getElementById('fx-post');
  assert.equal(fb.permalinkOf(post, POST_CTX), POST_PATH);
  const ctx = Object.assign({}, POST_CTX, { pathname: '/permalink.php', search: '?story_fbid=100000000000003&id=100000000000002' });
  assert.equal(
    fb.permalinkOf(post, ctx),
    '/permalink.php?story_fbid=100000000000003&id=100000000000002',
    'permalink.php 頁保留 story_fbid 與 id，其餘 query 去掉'
  );
  assert.equal(
    fb.canonicalUrl(fb.permalinkOf(post, ctx), ORIGIN),
    ORIGIN + '/permalink.php?story_fbid=100000000000003&id=100000000000002'
  );
  assert.equal(fb.canonicalUrl(fb.permalinkOf(post, POST_CTX), ORIGIN), ORIGIN + POST_PATH);
});

test('C1-14 post：互動列從 like_button 往上找含 share_button 的列，0x0 重複列被過濾；插在分享欄之後、toolbar 之前', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  const post = doc.getElementById('fx-post');
  assert.ok(doc.getElementById('fx-post-ghost-row'), '前提：fixture 有 0x0 重複列，且在真列之前');
  const row = fb.findActionRow(post, POST_CTX);
  assert.ok(row, '應找到互動列');
  assert.equal(row.id, 'fx-post-row', '不得選到 0x0 重複列');
  const point = fb.insertionPoint(row, POST_CTX);
  assert.ok(point, '應有插入點');
  assertSameNode(point.parent, row, '插在互動列本身');
  assertSameNode(point.before, doc.getElementById('fx-post-toolbar-cell'), '插在 toolbar 外層之前（分享欄之後）');
});

test('C1-15 post：容器內只剩 0x0 重複列時找不到互動列', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  const row = doc.getElementById('fx-post-row');
  row.parentNode.removeChild(row);
  assert.equal(fb.findActionRow(doc.getElementById('fx-post'), POST_CTX) === null, true, '只剩 0x0 重複列時應回 null');
});

test('C1-16 post：toolbar 不存在時插在列尾（append）', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  const cell = doc.getElementById('fx-post-toolbar-cell');
  cell.parentNode.removeChild(cell);
  const row = fb.findActionRow(doc.getElementById('fx-post'), POST_CTX);
  assert.equal(row && row.id, 'fx-post-row');
  const point = fb.insertionPoint(row, POST_CTX);
  assertSameNode(point.parent, row);
  assertSameNode(point.before, null, '沒有 toolbar 就 append');
});

test('C1-17 post：作者取 profile_name 內第一個 a（不取打卡地點），/<user> 形狀給 handle', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  assert.ok(doc.getElementById('fx-post-place'), '前提：profile_name 內有第二個 a（打卡地點）');
  assert.deepEqual(fb.author(doc.getElementById('fx-post'), POST_CTX), { author: POST_AUTHOR, handle: 'fx_user_a' });
});

test('C1-18 post：profile.php?id= 與 /groups/…/user/… 只給 author、不給 handle', () => {
  const fb = facebook();
  [
    'https://www.facebook.com/profile.php?id=100000000000002&__cft__[0]=AZfx&__tn__=-UC%2CP-R',
    '/profile.php?id=100000000000002',
    'https://www.facebook.com/groups/100000000000011/user/100000000000002/?__cft__[0]=AZfx',
  ].forEach((href) => {
    const doc = fbDocument('post-dialog.html');
    doc.getElementById('fx-post-author').setAttribute('href', href);
    assert.deepEqual(fb.author(doc.getElementById('fx-post'), POST_CTX), { author: POST_AUTHOR }, href);
  });
});

test('C1-19 post：內文取 [data-ad-preview=message]，br 轉換行、略過「查看更多」，不含作者名與打卡地點', () => {
  const fb = facebook();
  const doc = fbDocument('post-dialog.html');
  const excerpt = fb.excerpt(doc.getElementById('fx-post'), POST_CTX);
  assert.equal(typeof excerpt, 'string');
  assert.ok(excerpt.startsWith('示意單篇內文第1行。\n示意單篇內文第1行之二。'), 'br 應轉為換行：' + excerpt);
  const second = excerpt.indexOf('示意單篇內文第2行。');
  const third = excerpt.indexOf('示意單篇內文第3行。');
  assert.ok(second > 0 && third > second, '內文各行依序收錄：' + excerpt);
  ['查看更多', POST_AUTHOR, '示意地點', '示意背景作者'].forEach((noise) => {
    assert.ok(!excerpt.includes(noise), '摘要不得含「' + noise + '」：' + excerpt);
  });
});

// ============================================================
// 純函式層：Reel
// ============================================================

test('C1-20 reel：只回傳作用中那一個項目（rect 涵蓋視窗中線），項目是 video 與功能表欄的共同祖先', () => {
  const fb = facebook();
  const doc = fbDocument('reel.html');
  const containers = Array.from(fb.findContainers(doc, REEL_CTX));
  assert.deepEqual(ids(containers), ['fx-reel-active']);
  assert.ok(containers[0].querySelector('video'), '容器內有 video');
  assert.ok(containers[0].contains(doc.getElementById('fx-reel-active-col')), '容器內有直向互動欄');
});

test('C1-21 reel：沒有版面時退回 video.paused === false 的那一個；兩者都判不出時回空', () => {
  const fb = facebook();
  const doc = fbDocument('reel.html');
  clearRects(doc.body);
  doc.getElementById('fx-reel-active').querySelector('video').paused = true;
  doc.getElementById('fx-reel-next').querySelector('video').paused = false;
  assert.deepEqual(ids(fb.findContainers(doc, REEL_CTX)), ['fx-reel-next']);

  doc.getElementById('fx-reel-next').querySelector('video').paused = true;
  assert.deepEqual(ids(fb.findContainers(doc, REEL_CTX)), []);
});

test('C1-22 reel：permalink 取網址列 /reel/<id>，canonical 為 origin＋/reel/<id>', () => {
  const fb = facebook();
  const doc = fbDocument('reel.html');
  const active = doc.getElementById('fx-reel-active');
  assert.equal(fb.permalinkOf(active, REEL_CTX), REEL_PATH);
  assert.equal(fb.canonicalUrl(fb.permalinkOf(active, REEL_CTX), ORIGIN), ORIGIN + REEL_PATH);
});

test('C1-23 reel：互動列是含「功能表」按鈕的直向欄，插在功能表之前（分享之後）', () => {
  const fb = facebook();
  const doc = fbDocument('reel.html');
  const row = fb.findActionRow(doc.getElementById('fx-reel-active'), REEL_CTX);
  assert.ok(row, '應找到直向欄');
  assert.equal(row.id, 'fx-reel-active-col');
  const point = fb.insertionPoint(row, REEL_CTX);
  assertSameNode(point.parent, row);
  assertSameNode(point.before, doc.getElementById('fx-reel-active-menu-cell'), '插在功能表那格之前');
});

test('C1-24 reel：英文介面的 Menu／More options 也認得；功能表找不到時 fail-closed 不給插入點', () => {
  const fb = facebook();
  ['Menu', 'More options'].forEach((label) => {
    const doc = fbDocument('reel.html');
    doc.getElementById('fx-reel-active-menu').setAttribute('aria-label', label);
    const row = fb.findActionRow(doc.getElementById('fx-reel-active'), REEL_CTX);
    assert.equal(row && row.id, 'fx-reel-active-col', label);
    assertSameNode(fb.insertionPoint(row, REEL_CTX).before, doc.getElementById('fx-reel-active-menu-cell'), label);
  });

  const doc = fbDocument('reel.html');
  doc.getElementById('fx-reel-active-menu').setAttribute('aria-label', '示意其他按鈕');
  const row = fb.findActionRow(doc.getElementById('fx-reel-active'), REEL_CTX);
  assert.ok(row === null || fb.insertionPoint(row, REEL_CTX) === null, '找不到功能表時不得給出插入點');
});

test('C1-25 reel：作者取 h2 a[href*=sk=reels_tab]，profile.php 不給 handle、/<user> 給；非作用中項目沒有作者', () => {
  const fb = facebook();
  const doc = fbDocument('reel.html');
  const active = doc.getElementById('fx-reel-active');
  assert.deepEqual(fb.author(active, REEL_CTX), { author: REEL_AUTHOR });
  doc.getElementById('fx-reel-author').setAttribute('href', '/fx_user_e?sk=reels_tab&__cft__[0]=AZfx&__tn__=fx');
  assert.deepEqual(fb.author(active, REEL_CTX), { author: REEL_AUTHOR, handle: 'fx_user_e' });
  assert.deepEqual(fb.author(doc.getElementById('fx-reel-next'), REEL_CTX), {});
});

test('C1-26 reel：內文取說明 span[dir=auto]，略過「查看更多」，不含作者名與互動欄計數', () => {
  const fb = facebook();
  const doc = fbDocument('reel.html');
  const excerpt = fb.excerpt(doc.getElementById('fx-reel-active'), REEL_CTX);
  assert.equal(typeof excerpt, 'string');
  assert.equal(excerpt.trim(), REEL_CAPTION);
  assert.equal(fb.excerpt(doc.getElementById('fx-reel-next'), REEL_CTX), undefined, '沒有說明的項目回 undefined');
});

// ============================================================
// 純函式層：相片頁
// ============================================================

test('C1-27 photo：容器是 [role=complementary]；permalink 為 /photo/?fbid=<id>（/photo.php 亦同）', () => {
  const fb = facebook();
  const doc = fbDocument('photo.html');
  const containers = Array.from(fb.findContainers(doc, PHOTO_CTX));
  assert.deepEqual(ids(containers), ['fx-photo-aside']);
  assert.equal(fb.permalinkOf(containers[0], PHOTO_CTX), '/photo/?fbid=' + PHOTO_FBID);
  const withSet = Object.assign({}, PHOTO_CTX, { search: PHOTO_SEARCH + '&set=a.100000000000004&__tn__=%2CO*F' });
  assert.equal(fb.permalinkOf(containers[0], withSet), '/photo/?fbid=' + PHOTO_FBID, '只留 fbid');
  const php = Object.assign({}, PHOTO_CTX, { pathname: '/photo.php' });
  assert.equal(fb.permalinkOf(containers[0], php), '/photo/?fbid=' + PHOTO_FBID);
  assert.equal(fb.canonicalUrl(fb.permalinkOf(containers[0], PHOTO_CTX), ORIGIN), ORIGIN + '/photo/?fbid=' + PHOTO_FBID);
});

test('C1-28 photo：互動列同單篇，插在分享欄之後、toolbar 之前', () => {
  const fb = facebook();
  const doc = fbDocument('photo.html');
  const row = fb.findActionRow(doc.getElementById('fx-photo-aside'), PHOTO_CTX);
  assert.equal(row && row.id, 'fx-photo-row');
  const point = fb.insertionPoint(row, PHOTO_CTX);
  assertSameNode(point.parent, row);
  assertSameNode(point.before, doc.getElementById('fx-photo-toolbar-cell'));
});

test('C1-29 photo：作者取 complementary 的 h2 a，profile.php 不給 handle、/<user> 給', () => {
  const fb = facebook();
  const doc = fbDocument('photo.html');
  const aside = doc.getElementById('fx-photo-aside');
  assert.deepEqual(fb.author(aside, PHOTO_CTX), { author: PHOTO_AUTHOR });
  doc.getElementById('fx-photo-author').setAttribute('href', 'https://www.facebook.com/fx_user_f?__tn__=-UC*F');
  assert.deepEqual(fb.author(aside, PHOTO_CTX), { author: PHOTO_AUTHOR, handle: 'fx_user_f' });
});

test('C1-30 photo：內文取相片說明（br 轉換行），不取較長的混淆時間戳、留言或作者名', () => {
  const fb = facebook();
  const doc = fbDocument('photo.html');
  const excerpt = fb.excerpt(doc.getElementById('fx-photo-aside'), PHOTO_CTX);
  assert.equal(typeof excerpt, 'string');
  assert.equal(excerpt.trim(), PHOTO_CAPTION);
});

// ============================================================
// 整合層
// ============================================================

test('C1-31 整合 post：dialog 內一顆按鈕，插在分享欄與 toolbar 之間；背景 feed 與 0x0 列不放；點擊複製 canonical', async () => {
  const env = await loadPage('post-dialog.html', POST_PATH + '?__cft__[0]=AZfx&__tn__=%2CO%2CP-R');
  assert.equal(env.icons().length, 1);
  const kids = childIds(env.byId('fx-post-row'));
  const at = kids.indexOf('<icon>');
  assert.ok(at > 0, '真互動列要有按鈕：' + kids);
  assert.equal(kids[at - 1], 'fx-post-share-col');
  assert.equal(kids[at + 1], 'fx-post-toolbar-cell');
  assert.ok(!iconIn(env, 'fx-feed-post'), '背景 feed 不放');
  assert.ok(!iconIn(env, 'fx-post-ghost-row'), '0x0 重複列不放');

  await clickIcon(env, iconIn(env, 'fx-post-row'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + POST_PATH]);
  const payloads = env.payloads();
  assert.equal(payloads.length, 1);
  const p = payloads[0];
  assert.equal(p.type, 'cleanedNotice');
  assert.equal(p.cleanUrl, ORIGIN + POST_PATH);
  assert.equal(p.kind, 'icon');
  assert.equal(p.author, POST_AUTHOR);
  assert.equal(p.handle, 'fx_user_a');
  assert.ok(typeof p.excerpt === 'string' && p.excerpt.startsWith('示意單篇內文第1行。'), '摘要：' + p.excerpt);
  assert.ok(!p.excerpt.includes('查看更多'));
});

test('C1-32 整合 post：toolbar 不存在時按鈕在互動列最後', async () => {
  const env = createFbEnv({ pathname: POST_PATH, html: readFbFixture('post-dialog.html') });
  const cell = env.byId('fx-post-toolbar-cell');
  cell.parentNode.removeChild(cell);
  env.loadPostIcon();
  await settle();
  assert.equal(env.icons().length, 1);
  assert.equal(env.byId('fx-post-row').lastElementChild.className, 'tcl-copy-icon');
});

test('C1-33 整合 post：dialog（portal）晚於腳本掛上 body 時照樣補上按鈕', async () => {
  const env = createFbEnv({ pathname: POST_PATH, html: readFbFixture('post-dialog.html') });
  const layer = env.byId('fx-dialog-layer');
  layer.parentNode.removeChild(layer);
  env.loadPostIcon();
  await settle();
  assert.equal(env.icons().length, 0, 'dialog 不在時不放（背景 feed 不頂替）');

  env.document.body.appendChild(layer);
  await settle();
  assert.equal(env.icons().length, 1);
  assert.ok(iconIn(env, 'fx-post-row'), '按鈕在 dialog 的互動列');
});

test('C1-34 整合：動態牆、watch、群組路徑不放按鈕（pageType 為 null）', async () => {
  for (const pathname of ['/', '/watch/?v=100000000000008', '/groups/100000000000011/']) {
    const env = await loadPage('post-dialog.html', pathname);
    assert.equal(env.icons().length, 0, pathname);
  }
});

test('C1-35 整合 reel：只有作用中項目有按鈕，插在功能表之前；點擊複製 /reel/<id>', async () => {
  const env = await loadPage('reel.html', REEL_PATH);
  assert.equal(env.icons().length, 1);
  const kids = childIds(env.byId('fx-reel-active-col'));
  const at = kids.indexOf('<icon>');
  assert.ok(at > 0, '作用中直向欄要有按鈕：' + kids);
  assert.equal(kids[at - 1], 'fx-reel-active-share-cell');
  assert.equal(kids[at + 1], 'fx-reel-active-menu-cell');
  assert.ok(!iconIn(env, 'fx-reel-next'), '非作用中項目不放');

  await clickIcon(env, iconIn(env, 'fx-reel-active'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + REEL_PATH]);
  const p = env.payloads()[0];
  assert.equal(p.cleanUrl, ORIGIN + REEL_PATH);
  assert.equal(p.author, REEL_AUTHOR);
  assert.equal(p.handle, undefined, 'profile.php 作者不給 handle');
  assert.equal(p.excerpt, REEL_CAPTION);
});

test('C1-36 整合 reel：捲到下一支（網址列換 id）後按鈕移到新的作用中項目，複製新 id', async () => {
  const env = await loadPage('reel.html', REEL_PATH);
  assert.ok(iconIn(env, 'fx-reel-active'), '前提：作用中項目有按鈕');

  env.setPathname('/reel/' + REEL_NEXT_ID);
  setRect(env.byId('fx-reel-active'), -632, 462);
  setRect(env.byId('fx-reel-next'), 280, 462);
  env.poke();
  await settle();

  assert.equal(env.icons().length, 1, '整頁仍只有一顆');
  assert.ok(!iconIn(env, 'fx-reel-active'), '捲走的項目收掉按鈕');
  const kids = childIds(env.byId('fx-reel-next-col'));
  const at = kids.indexOf('<icon>');
  assert.equal(kids[at + 1], 'fx-reel-next-menu-cell');

  await clickIcon(env, iconIn(env, 'fx-reel-next'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/reel/' + REEL_NEXT_ID]);
});

test('C1-37 整合 reel：功能表找不到時 fail-closed，不插按鈕', async () => {
  const env = createFbEnv({ pathname: REEL_PATH, html: readFbFixture('reel.html') });
  env.byId('fx-reel-active-menu').setAttribute('aria-label', '示意其他按鈕');
  env.loadPostIcon();
  await settle();
  assert.equal(env.icons().length, 0);
});

test('C1-38 整合 photo：complementary 互動列一顆按鈕，點擊複製 /photo/?fbid=<id>（網址列多餘參數不帶）', async () => {
  const env = await loadPage('photo.html', PHOTO_PATH + PHOTO_SEARCH + '&set=a.100000000000004&__tn__=%2CO*F');
  assert.equal(env.icons().length, 1);
  const kids = childIds(env.byId('fx-photo-row'));
  const at = kids.indexOf('<icon>');
  assert.equal(kids[at - 1], 'fx-photo-share-col');
  assert.equal(kids[at + 1], 'fx-photo-toolbar-cell');

  await clickIcon(env, iconIn(env, 'fx-photo-row'));
  const expected = ORIGIN + '/photo/?fbid=' + PHOTO_FBID;
  assert.deepEqual(env.clipboardWrites, [expected]);
  const p = env.payloads()[0];
  assert.equal(p.cleanUrl, expected);
  assert.equal(p.author, PHOTO_AUTHOR);
  assert.equal(p.excerpt, PHOTO_CAPTION);
});

test('C1-39 Trusted Types：createPolicy 會丟例外時三頁型仍插入按鈕，svg 以命名空間建立、點擊不炸', async () => {
  const pages = [
    ['post-dialog.html', POST_PATH, 'fx-post-row', ORIGIN + POST_PATH],
    ['reel.html', REEL_PATH, 'fx-reel-active', ORIGIN + REEL_PATH],
    ['photo.html', PHOTO_PATH + PHOTO_SEARCH, 'fx-photo-row', ORIGIN + '/photo/?fbid=' + PHOTO_FBID],
  ];
  for (const [fixture, pathname, holder, expected] of pages) {
    const env = await loadPage(fixture, pathname, { trustedTypes: 'throwing' });
    assert.equal(env.icons().length, 1, fixture);
    const svg = env.icons()[0].querySelector('svg');
    assert.ok(svg && svg.namespaceURI === SVG_NS, fixture + '：svg 以 createElementNS 建立');
    await clickIcon(env, iconIn(env, holder));
    assert.deepEqual(env.clipboardWrites, [expected], fixture);
    const noisy = env.consoleLog.warn
      .concat(env.consoleLog.error)
      .filter((line) => /TrustedHTML|innerHTML|createPolicy/.test(line));
    assert.deepEqual(noisy, [], fixture + '：不得有 Trusted Types 相關錯誤');
  }
});
