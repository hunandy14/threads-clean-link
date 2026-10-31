// test/post-icon-instagram.test.js — post-icon.js 的 Instagram 站點設定（C2）：
// 首頁動態（feed）、單篇貼文頁（post）、Reels 牆（reels）三種頁型各自的容器、
// permalink、互動列、插入點、作者、內文、canonical 網址、點擊通道，以及
// observer、SPA 切頁、dispose、孤兒自檢、Trusted Types。
//
// 介面約定見 test/post-icon-sites.test.js 檔頭。這裡分兩層：
//   - 純函式層：require('post-icon.js').__sites.instagram，餵迷你 DOM。
//   - 整合層：test/support/ig-dom.js 的 createSiteEnv 把 i18n／tcl-core／
//     post-icon 載進 sandbox，在 fixture 頁面上跑完整注入、點擊與退場。
//
// fixture（test/fixtures/instagram/*.html）手寫、匿名，層級比照 2026-11-01
// zh-tw 實測。Reels 牆上的項目沒有指向本則的錨點（真機證據：reels 無
// permalink 錨點；/reels/audio/<id>/ 是配樂縮圖連結），permalink 取網址列
// /reels/<code>/ 的 code 組成 /reel/<code>/；作用中那則靠位置判斷（rect 涵蓋
// 視窗中線，rect 全 0 時退回正在播放的 video），fixture 以 data-fx-top 屬性
// stub 版面。
//
// 整合層的環境預設開啟 Trusted Types 強制模式：對 innerHTML 指派一般字串會
// 丟 TypeError（Instagram 的 CSP 就是如此），所以按鈕的 svg 必須用
// createElementNS 建。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  SVG_NS,
  createDocument,
  parseFragment,
  readFixture,
  fixtureMainInner,
  createSiteEnv,
  settle,
  assertSameNode,
} = require('./support/ig-dom');

const ORIGIN = 'https://www.instagram.com';
const FEED_PATH = '/';
const POST_PATH = '/fx_author_c/p/FXPOST0001/';
const REELS_PATH = '/reels/FXREEL0001/';
const REELS_NEXT_PATH = '/reels/FXREEL0002/';
const REELS_CANONICAL = ORIGIN + '/reel/FXREEL0001/';

const FEED_CTX = { pageType: 'feed', pathname: FEED_PATH, origin: ORIGIN };
const POST_CTX = { pageType: 'post', pathname: POST_PATH, origin: ORIGIN };
const REELS_CTX = { pageType: 'reels', pathname: REELS_PATH, origin: ORIGIN, innerHeight: 900 };

const FEED_CAPTION = '示意動態內文第一段，這是一則合成的貼文說明，用來驗證摘要擷取。';
const POST_LINES = [
  '示意單篇內文第一行，介紹這間合成的房子。',
  '示意單篇內文第二行，交通與生活機能。',
  '示意單篇內文第三行，結尾。',
];
const ICON_TITLE_ZH = '複製原始連結';

function instagram() {
  const api = require(path.join(__dirname, '..', 'post-icon.js'));
  assert.ok(api.__sites && api.__sites.instagram, 'post-icon 應匯出 __sites.instagram');
  return api.__sites.instagram;
}

function fixtureDoc(name) {
  return createDocument(readFixture(name));
}

async function loadPage(fixture, pathname, extra) {
  const env = createSiteEnv(
    Object.assign({ origin: ORIGIN, pathname, html: readFixture(fixture) }, extra || {})
  ).loadPostIcon();
  await settle();
  return env;
}

function iconIn(env, id) {
  const node = env.byId(id);
  assert.ok(node, 'fixture 應有 #' + id);
  return node.querySelector('.tcl-copy-icon');
}

function childIds(node) {
  return node.children.map((c) => (c.className === 'tcl-copy-icon' ? '<icon>' : c.id || c.localName));
}

async function clickIcon(env, icon) {
  assert.ok(icon, '要點的按鈕必須存在');
  icon.fire('click');
  await settle();
}

// ============================================================
// 純函式層：標籤表、頁型、canonical
// ============================================================

test('C2 標籤表：aria-label 優先、title 備援的六組中英標籤', () => {
  assert.deepEqual(instagram().labels, {
    like: ['讚', 'Like'],
    comment: ['回應', '留言', 'Comment'],
    repost: ['轉發', 'Repost'],
    share: ['分享', 'Share'],
    save: ['儲存', 'Save'],
    more: ['更多選項', 'More options'],
  });
});

test('C2 pageType：/ 是 feed；/p／/reel（可帶使用者前綴）是 post；/reels/ 開頭是 reels；其他回 null', () => {
  const ig = instagram();
  const table = [
    ['/', 'feed'],
    ['/p/FXCODE/', 'post'],
    ['/fx_user/p/FXCODE/', 'post'],
    ['/reel/FXCODE/', 'post'],
    ['/fx_user/reel/FXCODE/', 'post'],
    ['/reels/FXCODE/', 'reels'],
    ['/reels/', 'reels'],
    ['/explore/', null],
    ['/fx_user/', null],
    ['/direct/inbox/', null],
    ['/p/FXCODE/liked_by/', null],
    ['/stories/fx_user/123/', null],
  ];
  table.forEach(([pathname, expected]) => {
    assert.equal(ig.pageType(pathname), expected, pathname);
  });
});

test('C2 canonicalUrl：去使用者前綴、去 query 與 hash，www 與尾斜線原樣保留', () => {
  const ig = instagram();
  const table = [
    ['/fx_user/p/FXCODE/', ORIGIN, ORIGIN + '/p/FXCODE/'],
    ['/p/FXCODE/?img_index=2#comments', ORIGIN, ORIGIN + '/p/FXCODE/'],
    ['/p/FXCODE', ORIGIN, ORIGIN + '/p/FXCODE'],
    ['/reel/FXCODE/', ORIGIN, ORIGIN + '/reel/FXCODE/'],
    ['/fx_user/reel/FXCODE/?utm_source=ig_web', ORIGIN, ORIGIN + '/reel/FXCODE/'],
    ['/reel/FXCODE/27857656860525429/', ORIGIN, ORIGIN + '/reel/FXCODE/'],
    ['/reel/FXCODE/27857656860525429/?a=1', ORIGIN, ORIGIN + '/reel/FXCODE/'],
    ['/reels/FXCODE/', ORIGIN, ORIGIN + '/reels/FXCODE/'],
    ['/tv/FXCODE/', ORIGIN, ORIGIN + '/tv/FXCODE/'],
    ['/p/FXCODE/', 'https://instagram.com', 'https://instagram.com/p/FXCODE/'],
    [ORIGIN + '/fx_user/p/FXCODE/?a=1', ORIGIN, ORIGIN + '/p/FXCODE/'],
  ];
  table.forEach(([href, origin, expected]) => {
    assert.equal(ig.canonicalUrl(href, origin), expected, href);
  });
});

test('C2 canonicalUrl：非 p／reel／reels／tv 的路徑、換域、非常規 scheme、非字串一律回 null', () => {
  const ig = instagram();
  [
    '/',
    '/fx_user/',
    '/explore/',
    '/fx_user/audio/1000000001/',
    '/stories/fx_user/123/',
    '/fx_user/FXCODE/',
    'https://evil.example/p/FXCODE/',
    '//evil.example/p/FXCODE/',
    'javascript:alert(1)',
    123,
    null,
    undefined,
  ].forEach((href) => {
    assert.equal(ig.canonicalUrl(href, ORIGIN), null, String(href));
  });
});

test('C2 observeRoot：觀察 main', () => {
  const doc = fixtureDoc('feed.html');
  assertSameNode(instagram().observeRoot(doc), doc.querySelector('main'));
});

// ============================================================
// 純函式層：feed
// ============================================================

test('C2 feed：容器是 main 內的 article；permalink 取 time 外層 a，廣告（無 time）回 null', () => {
  const ig = instagram();
  const doc = fixtureDoc('feed.html');
  const ids = Array.from(ig.findContainers(doc, FEED_CTX)).map((c) => c.id);
  assert.ok(ids.includes('fx-feed-normal') && ids.includes('fx-feed-reel'), '兩篇正常貼文都是容器：' + ids);
  ids.forEach((id) => assert.equal(doc.getElementById(id).localName, 'article'));

  const normal = ig.permalinkOf(doc.getElementById('fx-feed-normal'), FEED_CTX);
  assert.equal(ig.canonicalUrl(normal, ORIGIN), ORIGIN + '/p/FXFEED0001/', '取 time 的連結，不取媒體連結');
  const reel = ig.permalinkOf(doc.getElementById('fx-feed-reel'), FEED_CTX);
  assert.equal(ig.canonicalUrl(reel, ORIGIN), ORIGIN + '/reel/FXFEEDREEL1/');
  assert.equal(
    ig.permalinkOf(doc.getElementById('fx-feed-ad'), FEED_CTX),
    null,
    '廣告沒有 time，媒體上的 /p/ 連結不得頂替'
  );
});

test('C2 feed：互動列是含讚的 section，插入點是左組最後（分享之後），右組不動', () => {
  const ig = instagram();
  const doc = fixtureDoc('feed.html');
  const row = ig.findActionRow(doc.getElementById('fx-feed-normal'), FEED_CTX);
  assert.ok(row, '應找到互動列');
  assert.equal(row.id, 'fx-feed-normal-row');
  const point = ig.insertionPoint(row, FEED_CTX);
  assert.equal(point.parent.id, 'fx-feed-normal-left', '插在 section 的第一個子節點（左組）');
  assertSameNode(point.before, null, '左組最後，也就是分享之後');
});

test('C2 feed：作者取 section 之前第一個 /<user>/ 連結，排除 explore／reels／direct／accounts／stories', () => {
  const ig = instagram();
  const doc = fixtureDoc('feed.html');
  const article = doc.getElementById('fx-feed-normal');
  assert.deepEqual(ig.author(article, FEED_CTX), { author: 'fx_author_a', handle: 'fx_author_a' });

  const header = article.firstElementChild;
  parseFragment(
    doc,
    '<a href="/explore/" role="link">探索</a><a href="/reels/" role="link">Reels</a>' +
      '<a href="/direct/" role="link">訊息</a><a href="/accounts/" role="link">帳號</a>' +
      '<a href="/stories/" role="link">限動</a>'
  )
    .reverse()
    .forEach((node) => header.insertBefore(node, header.firstChild));
  assert.deepEqual(
    ig.author(article, FEED_CTX),
    { author: 'fx_author_a', handle: 'fx_author_a' },
    '導覽類路徑不是作者'
  );
});

test('C2 feed：內文取 section 之後最長的 span[dir=auto]，被「更多」截斷時仍取已顯示文字、不含按鈕字', () => {
  const ig = instagram();
  const doc = fixtureDoc('feed.html');
  const excerpt = ig.excerpt(doc.getElementById('fx-feed-normal'), FEED_CTX);
  assert.equal(typeof excerpt, 'string');
  assert.ok(excerpt.startsWith(FEED_CAPTION), '摘要應以已顯示的內文開頭：' + excerpt);
  assert.ok(!excerpt.includes('更多'), '「更多」按鈕字不入摘要：' + excerpt);
  assert.ok(!excerpt.includes('留言'), '留言入口不入摘要：' + excerpt);
});

// ============================================================
// 純函式層：post
// ============================================================

test('C2 post：容器是「同時含讚與儲存的 section」往上兩層，只有一個；permalink 由網址列去掉使用者前綴', () => {
  const ig = instagram();
  const doc = fixtureDoc('post.html');
  const containers = Array.from(ig.findContainers(doc, POST_CTX));
  assert.deepEqual(
    containers.map((c) => c.id),
    ['fx-post-info'],
    '留言區的讚、留言輸入 section、更多貼文都不是容器'
  );
  const permalink = ig.permalinkOf(containers[0], POST_CTX);
  assert.equal(ig.canonicalUrl(permalink, ORIGIN), ORIGIN + '/p/FXPOST0001/');
});

test('C2 post：互動列與插入點同 feed；作者是資訊欄第一個 handle；內文是完整 caption、不含留言與標頭', () => {
  const ig = instagram();
  const doc = fixtureDoc('post.html');
  const info = doc.getElementById('fx-post-info');
  const row = ig.findActionRow(info, POST_CTX);
  assert.equal(row && row.id, 'fx-post-row');
  const point = ig.insertionPoint(row, POST_CTX);
  assert.equal(point.parent.id, 'fx-post-left');
  assertSameNode(point.before, null);

  assert.deepEqual(ig.author(info, POST_CTX), { author: 'fx_author_c', handle: 'fx_author_c' });

  const excerpt = ig.excerpt(info, POST_CTX);
  assert.equal(typeof excerpt, 'string');
  POST_LINES.forEach((line) => assert.ok(excerpt.includes(line), '完整 caption 應含：' + line));
  ['示意留言', 'fx_commenter', '追蹤', '1週'].forEach((noise) => {
    assert.ok(!excerpt.includes(noise), '摘要不得含「' + noise + '」：' + excerpt);
  });
});

// ============================================================
// 純函式層：reels
// ============================================================

function reelsContainerOf(ig, doc, rowId) {
  const row = doc.getElementById(rowId);
  return Array.from(ig.findContainers(doc, REELS_CTX)).find((c) => c.contains(row)) || null;
}

test('C2 reels：只回傳作用中那一則（rect 涵蓋視窗中線），permalink 取網址列的 code', () => {
  const ig = instagram();
  const doc = fixtureDoc('reels.html');
  const containers = Array.from(ig.findContainers(doc, REELS_CTX));
  containers.forEach((c) => {
    assert.equal(c.querySelectorAll('svg[aria-label="儲存"]').length, 1, '一個容器一則 reel');
  });
  const active = reelsContainerOf(ig, doc, 'fx-reel-active-row');
  assert.ok(active, '作用中那一則要在容器清單裡');
  assert.equal(ig.canonicalUrl(ig.permalinkOf(active, REELS_CTX), ORIGIN), REELS_CANONICAL);

  assert.equal(containers.length, 1, '只有作用中那一則');
  ['fx-reel-prev-row', 'fx-reel-ad-row', 'fx-reel-next-row'].forEach((rowId) => {
    assert.equal(reelsContainerOf(ig, doc, rowId), null, rowId + ' 不是作用中');
  });
});

test('C2 reels：所有 rect 高度為 0（沒有版面）時，退回 video.paused === false 的那一則', () => {
  const ig = instagram();
  const doc = fixtureDoc('reels.html');
  doc.querySelectorAll('[data-fx-top]').forEach((n) => n.removeAttribute('data-fx-top'));
  doc.getElementById('fx-reel-active').querySelector('video').paused = true;
  doc.getElementById('fx-reel-next').querySelector('video').paused = false;
  const containers = Array.from(ig.findContainers(doc, REELS_CTX));
  assert.deepEqual(containers.map((c) => c.id), ['fx-reel-next']);
});

test('C2 reels：pathname 有 code 但判不出作用中（無版面、無播放中）時不回傳容器', () => {
  const ig = instagram();
  const doc = fixtureDoc('reels.html');
  doc.querySelectorAll('[data-fx-top]').forEach((n) => n.removeAttribute('data-fx-top'));
  doc.querySelectorAll('video').forEach((v) => {
    v.paused = true;
  });
  assert.deepEqual(Array.from(ig.findContainers(doc, REELS_CTX)), []);
});

test('C2 reels：/reels/audio/<id>/ 不是 reel code，不回傳容器、沒有 permalink', () => {
  const ig = instagram();
  const doc = fixtureDoc('reels.html');
  const ctx = { pageType: 'reels', pathname: '/reels/audio/1000000102/', origin: ORIGIN, innerHeight: 900 };
  assert.deepEqual(Array.from(ig.findContainers(doc, ctx)), []);
  assert.equal(ig.permalinkOf(doc.getElementById('fx-reel-active'), ctx), null);
});

test('C2 reels：互動列是直排欄，插入點在分享與儲存之間；作者連結形狀 /<user>/reels/', () => {
  const ig = instagram();
  const doc = fixtureDoc('reels.html');
  const active = reelsContainerOf(ig, doc, 'fx-reel-active-row');
  const row = ig.findActionRow(active, REELS_CTX);
  assert.equal(row && row.id, 'fx-reel-active-row');
  const point = ig.insertionPoint(row, REELS_CTX);
  assertSameNode(point.parent, row);
  assertSameNode(point.before, doc.getElementById('fx-reel-active-save'), '插在儲存之前（分享之後）');
  assert.deepEqual(ig.author(active, REELS_CTX), { author: 'fx_author_e', handle: 'fx_author_e' });
});

// ============================================================
// 整合層：三種頁型的注入與點擊
// ============================================================

test('C2 整合 feed：兩篇正常貼文各一顆按鈕，插在左組分享之後；廣告與右組不動', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  assert.equal(env.icons().length, 2);

  assert.deepEqual(childIds(env.byId('fx-feed-normal-left')).slice(-2), ['fx-feed-normal-share', '<icon>']);
  assert.ok(!env.byId('fx-feed-normal-right').querySelector('.tcl-copy-icon'), '右組（儲存）不動');
  assert.equal(env.byId('fx-feed-normal-row').children.length, 2, 'section 仍是左右兩組');
  assert.deepEqual(childIds(env.byId('fx-feed-reel-left')).slice(-2), ['fx-feed-reel-share', '<icon>']);
  assert.ok(!iconIn(env, 'fx-feed-ad'), '廣告不放按鈕');
});

test('C2 整合：按鈕外觀與 i18n 沿用 Threads（同 class、title／aria-label「複製原始連結」、帶注入者身分）', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  const icon = iconIn(env, 'fx-feed-normal');
  assert.ok(icon);
  assert.equal(icon.getAttribute('role'), 'button');
  assert.equal(icon.getAttribute('title'), ICON_TITLE_ZH);
  assert.equal(icon.getAttribute('aria-label'), ICON_TITLE_ZH);
  assert.ok(icon.getAttribute('data-tcl-owner'), '帶 data-tcl-owner，孤兒退場才清得到');
  const svg = icon.querySelector('svg');
  assert.ok(svg, '按鈕內有圖示 svg');
  assert.equal(svg.namespaceURI, SVG_NS, 'svg 以 SVG 命名空間建立');
});

test('C2 整合 feed：點擊複製 canonical 網址，cleanedNotice 帶 kind icon、作者＝handle（不帶 @）與摘要', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  await clickIcon(env, iconIn(env, 'fx-feed-normal'));

  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/p/FXFEED0001/']);
  const payloads = env.payloads();
  assert.equal(payloads.length, 1);
  const p = payloads[0];
  assert.equal(p.type, 'cleanedNotice');
  assert.equal(p.cleanUrl, ORIGIN + '/p/FXFEED0001/');
  assert.equal(p.kind, 'icon');
  assert.equal(p.author, 'fx_author_a');
  assert.equal(p.handle, 'fx_author_a');
  assert.ok(typeof p.excerpt === 'string' && p.excerpt.startsWith(FEED_CAPTION), '摘要：' + p.excerpt);
  assert.ok(!p.excerpt.includes('更多'));
});

test('C2 整合 feed：reel 貼文的 permalink 去掉使用者前綴與 query', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  await clickIcon(env, iconIn(env, 'fx-feed-reel'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/reel/FXFEEDREEL1/']);
  assert.equal(env.payloads()[0].handle, 'fx_author_b');
});

test('C2 整合 post：整頁只有本篇一顆按鈕，「更多貼文」區不放、不被當成本篇', async () => {
  const env = await loadPage('post.html', POST_PATH);
  assert.equal(env.icons().length, 1);
  assert.deepEqual(childIds(env.byId('fx-post-left')).slice(-2), ['fx-post-share', '<icon>']);
  assert.ok(!env.byId('fx-post-right').querySelector('.tcl-copy-icon'), '右組（儲存）不動');
  assert.ok(!iconIn(env, 'fx-post-more'), '更多貼文區不放按鈕');
  assert.ok(!iconIn(env, 'fx-post-comment'), '留言的讚不是互動列');

  await clickIcon(env, iconIn(env, 'fx-post-info'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/p/FXPOST0001/']);
  const p = env.payloads()[0];
  assert.equal(p.cleanUrl, ORIGIN + '/p/FXPOST0001/');
  assert.equal(p.kind, 'icon');
  assert.equal(p.author, 'fx_author_c');
  assert.equal(p.handle, 'fx_author_c');
  POST_LINES.forEach((line) => assert.ok(p.excerpt.includes(line), '摘要應含：' + line));
  assert.ok(!p.excerpt.includes('示意留言'));
});

test('C2 整合 reels：只有作用中那一則有按鈕，插在分享與儲存之間；點擊複製 /reel/<code>/', async () => {
  const env = await loadPage('reels.html', REELS_PATH);
  assert.equal(env.icons().length, 1);
  const ids = childIds(env.byId('fx-reel-active-row'));
  const at = ids.indexOf('<icon>');
  assert.ok(at > 0, '作用中那一則要有按鈕：' + ids);
  assert.equal(ids[at - 1], 'fx-reel-active-share');
  assert.equal(ids[at + 1], 'fx-reel-active-save');
  ['fx-reel-prev', 'fx-reel-ad', 'fx-reel-next'].forEach((id) => {
    assert.ok(!iconIn(env, id), id + ' 不是作用中');
  });

  await clickIcon(env, iconIn(env, 'fx-reel-active'));
  assert.deepEqual(env.clipboardWrites, [REELS_CANONICAL]);
  const p = env.payloads()[0];
  assert.equal(p.cleanUrl, REELS_CANONICAL);
  assert.equal(p.author, 'fx_author_e');
  assert.equal(p.handle, 'fx_author_e');
});

test('C2 整合 reels：捲到下一則（網址列改變）後按鈕跟著移過去，舊的那則不留按鈕', async () => {
  const env = await loadPage('reels.html', REELS_PATH);
  assert.ok(iconIn(env, 'fx-reel-active'), '前提：作用中那一則有按鈕');

  env.setPathname(REELS_NEXT_PATH);
  env.byId('fx-reel-active').setAttribute('data-fx-top', '-968');
  env.byId('fx-reel-next').setAttribute('data-fx-top', '0');
  env.poke();
  await settle();

  assert.equal(env.icons().length, 1, '整頁仍只有一顆');
  assert.ok(!iconIn(env, 'fx-reel-active'), '不再作用中的那則要收掉按鈕');
  const ids = childIds(env.byId('fx-reel-next-row'));
  const at = ids.indexOf('<icon>');
  assert.equal(ids[at - 1], 'fx-reel-next-share');
  assert.equal(ids[at + 1], 'fx-reel-next-save');

  await clickIcon(env, iconIn(env, 'fx-reel-next'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/reel/FXREEL0002/'], '複製網址列 code 組成的 /reel/<code>/');
});

test('C2 整合 reels：網址列是 /reels/audio/<id>/ 時不放按鈕', async () => {
  const env = await loadPage('reels.html', '/reels/audio/1000000102/');
  assert.equal(env.icons().length, 0);
});

test('C2 整合 reels：pathname 有 code 但判不出作用中那則時不放按鈕', async () => {
  const env = createSiteEnv({ origin: ORIGIN, pathname: REELS_PATH, html: readFixture('reels.html') });
  env.document.querySelectorAll('[data-fx-top]').forEach((n) => n.removeAttribute('data-fx-top'));
  env.document.querySelectorAll('video').forEach((v) => {
    v.paused = true;
  });
  env.loadPostIcon();
  await settle();
  assert.equal(env.icons().length, 0);
});

test('C2 標籤備援：svg 沒有 aria-label、只有英文 <title> 時照樣認出互動列', async () => {
  const toEnglish = {
    讚: 'Like',
    回應: 'Comment',
    轉發: 'Repost',
    分享: 'Share',
    儲存: 'Save',
    更多選項: 'More options',
  };
  const env = createSiteEnv({ origin: ORIGIN, pathname: FEED_PATH, html: readFixture('feed.html') });
  env.document.querySelectorAll('svg').forEach((svg) => {
    svg.removeAttribute('aria-label');
    const title = svg.querySelector('title');
    if (title && toEnglish[title.textContent]) title.textContent = toEnglish[title.textContent];
  });
  env.loadPostIcon();
  await settle();
  assert.equal(env.icons().length, 2);
  assert.deepEqual(childIds(env.byId('fx-feed-normal-left')).slice(-2), ['fx-feed-normal-share', '<icon>']);
});

// ============================================================
// 整合層：observer、SPA、虛擬化
// ============================================================

test('C2 observer：觀察 main（subtree），重複的 DOM 變動不會重複插入', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  const live = env.liveObservers();
  assert.equal(live.length, 1);
  assertSameNode(live[0].target, env.main(), 'Instagram 觀察 main');
  assert.equal(live[0].options.childList, true);
  assert.equal(live[0].options.subtree, true);

  env.poke();
  await settle();
  env.poke();
  await settle();
  assert.equal(env.icons().length, 2);
});

test('C2 observer：捲動卸載舊 article、掛上新 article，新貼文補上按鈕、舊按鈕隨節點消失', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  const old = env.byId('fx-feed-reel');
  old.parentNode.removeChild(old);
  const fresh = env.byId('fx-feed-normal').cloneNode(true);
  fresh.setAttribute('id', 'fx-feed-fresh');
  fresh.querySelectorAll('.tcl-copy-icon').forEach((n) => n.parentNode.removeChild(n));
  fresh.querySelector('time').closest('a').setAttribute('href', '/p/FXFEED0009/');
  env.byId('fx-feed-normal').parentNode.appendChild(fresh);
  await settle();

  assert.equal(env.icons().length, 2, '正常貼文＋新貼文各一顆');
  const icon = iconIn(env, 'fx-feed-fresh');
  assert.ok(icon, '新掛上的 article 要補按鈕');
  await clickIcon(env, icon);
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/p/FXFEED0009/']);
});

test('C2 SPA：feed 切到單篇貼文頁（main 保留、內容換掉），依新頁型重掃，不殘留孤兒按鈕', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  assert.equal(env.icons().length, 2);

  env.navigate(POST_PATH, fixtureMainInner('post.html'));
  await settle();

  const icons = env.icons();
  assert.equal(icons.length, 1, '只剩單篇貼文的一顆');
  assert.ok(env.byId('fx-post-left').contains(icons[0]));
  await clickIcon(env, icons[0]);
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/p/FXPOST0001/']);
});

test('C2 SPA：不支援的頁型（個人檔案）不放按鈕，切回首頁後才開始注入', async () => {
  const env = await loadPage('feed.html', '/fx_author_a/');
  assert.equal(env.icons().length, 0, 'pageType 為 null 的頁面不掃描');

  env.setPathname(FEED_PATH);
  env.poke();
  await settle();
  assert.equal(env.icons().length, 2);
});

// ============================================================
// 整合層：既有機制在 Instagram 照樣生效
// ============================================================

test('C2 Trusted Types：頁面有 trustedTypes、createPolicy 會丟例外，仍能插入按鈕且點擊回饋不炸', async () => {
  const env = await loadPage('feed.html', FEED_PATH, { trustedTypes: 'throwing' });
  assert.equal(env.icons().length, 2, '不得依賴 innerHTML 或自建 policy');
  env.icons().forEach((icon) => {
    const svg = icon.querySelector('svg');
    assert.ok(svg && svg.namespaceURI === SVG_NS, 'svg 以 createElementNS 建立');
    assert.ok(svg.querySelectorAll('*').length > 0, 'svg 內有圖形節點');
  });

  await clickIcon(env, iconIn(env, 'fx-feed-normal'));
  assert.deepEqual(env.clipboardWrites, [ORIGIN + '/p/FXFEED0001/']);
  const icon = iconIn(env, 'fx-feed-normal');
  assert.ok(icon.querySelector('svg'), '換成勾勾圖示後仍有 svg');
  const noisy = env.consoleLog.warn.concat(env.consoleLog.error).filter((line) => /TrustedHTML|innerHTML|createPolicy/.test(line));
  assert.deepEqual(noisy, [], '不得有 Trusted Types 相關錯誤');
});

test('C2 dispose：Instagram 站點下 __tclPostIconDispose 移除全部按鈕並斷開 observer，之後的變動不再注入', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  assert.equal(env.icons().length, 2);
  assert.equal(typeof env.window.__tclPostIconDispose, 'function');

  env.window.__tclPostIconDispose();
  assert.equal(env.icons().length, 0, '按鈕全數移除');
  assert.equal(env.liveObservers().length, 0, 'observer 已斷開');

  env.poke();
  await settle();
  assert.equal(env.icons().length, 0);
});

test('C2 孤兒自檢：Instagram 頁面上擴充功能情境失效後，下一輪掃描自我退場並清掉按鈕', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  assert.equal(env.icons().length, 2, '前提：孤兒化之前按鈕已注入');
  env.orphan();
  const added = env.document.createElement('div');
  env.main().appendChild(added);
  await settle();

  assert.equal(env.icons().length, 0);
  assert.equal(env.liveObservers().length, 0);
  assert.ok(env.consoleLog.warn.some((line) => line.includes('擴充功能情境已失效')));
});

test('C2 交棒事件：孤兒實例在 Instagram 頁面收到 handoff 事件立即退場', async () => {
  const env = await loadPage('feed.html', FEED_PATH);
  assert.equal(env.icons().length, 2, '前提：孤兒化之前按鈕已注入');
  env.orphan();
  env.document.dispatchEvent({ type: 'threads-clean-link:handoff', detail: { script: 'post-icon' } });
  assert.equal(env.icons().length, 0);
  assert.equal(env.liveObservers().length, 0);
});

test('C2 開關：postCopyEnabled 為 false 時 Instagram 也不放按鈕，切回 true 即補上', async () => {
  const env = await loadPage('feed.html', FEED_PATH, { sync: { langPref: 'zh', postCopyEnabled: false } });
  assert.equal(env.icons().length, 0);

  env.storage.emitChange({ postCopyEnabled: { oldValue: false, newValue: true } });
  await settle();
  assert.equal(env.icons().length, 2);
});
