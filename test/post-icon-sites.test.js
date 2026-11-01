// test/post-icon-sites.test.js — post-icon.js「站點設定」架構的 C1 契約：站點
// 選擇、設定物件的介面形狀，以及 Threads 設定與重構前行為等價的少量對照。
//
// 真正的 Threads 等價保證是 test/post-icon.test.js 等既有測試零改動照綠；
// 這裡只釘住「設定物件存在、介面對、每個函式回傳的東西跟舊流程一樣」。
//
// ============================================================
// 【站點設定介面（實作者照做）】
// require('post-icon.js') 與 window.TCLPostIcon 都要帶：
//   __sites: { threads: SiteConfig, instagram: SiteConfig, facebook: SiteConfig }
//   __selectSite(hostname: string) → SiteConfig | null
//     threads.com／threads.net（含 www）→ __sites.threads；instagram.com 及
//     其子網域 → __sites.instagram；其他（含 instagram.com.evil.io 這種尾綴
//     仿冒）→ null，post-icon 不啟動。
//
// SiteConfig（純函式，不讀全域 document／location；需要網址資訊一律從
// ctx 拿，ctx = { pageType, pathname, origin }）：
//   id: 'threads' | 'instagram' | 'facebook'
//   matches(hostname) → boolean
//   pageType(pathname) → string | null
//     threads 一律回 'default'；instagram 回 'feed'／'post'／'reels'，其他
//     路徑回 null（不掃描）。
//   findContainers(root, ctx) → Element[]          root 是 document 或元素
//   permalinkOf(container, ctx) → string | null    相對或絕對 href
//   findActionRow(container, ctx) → Element | null
//   insertionPoint(actionRow, ctx) → { parent: Element, before: Node|null } | null
//     按鈕以 parent.insertBefore(button, before) 插入。
//   author(container, ctx) → { author?: string, handle?: string }
//   excerpt(container, ctx) → string | undefined
//   canonicalUrl(href, origin) → string | null
//   observeRoot(document) → Element | null          MutationObserver 的觀察目標
// instagram 另帶 labels：{ like, comment, repost, share, save, more } 標籤表。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDocument, createSiteEnv, settle, assertSameNode } = require('./support/ig-dom');

function loadPostIcon() {
  return require(path.join(__dirname, '..', 'post-icon.js'));
}

function sites() {
  const api = loadPostIcon();
  assert.ok(api.__sites && typeof api.__sites === 'object', 'post-icon 應匯出 __sites');
  return api.__sites;
}

const SITE_FUNCTIONS = [
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
];

const THREADS_CTX = { pageType: 'default', pathname: '/', origin: 'https://www.threads.com' };

// ---- Threads 迷你頁面：一顆主文容器，內含 /media 連結、巢狀引用貼文、影片
// 工具列與真正的互動列（四顆按鈕只有 svg > title，比照 2026-09 改版） ----
function threadsActionRow(id, labels) {
  return (
    '<div' +
    (id ? ' id="' + id + '"' : '') +
    '>' +
    labels
      .map(
        (label) =>
          '<div><div role="button"><svg role="img"><title>' + label + '</title></svg></div></div>'
      )
      .join('') +
    '</div>'
  );
}

const THREADS_PAGE =
  '<div id="barcelona-page-layout"><div data-pressable-container="true" id="tc-main">' +
  '<div><a href="/@author_a" role="link"><span dir="auto"><span>author_a</span></span></a></div>' +
  '<span dir="auto"><a href="/@author_a/post/POSTCODE/media" role="link"><time>17小時</time></a></span>' +
  '<a href="/@author_a/post/POSTCODE" role="link"><span>permalink</span></a>' +
  '<div><span dir="auto"><span>內文第一行</span></span></div>' +
  '<div data-pressable-container="true" id="tc-quoted">' +
  '<a href="/@quoted_b" role="link"><span dir="auto">quoted_b</span></a>' +
  '<a href="/@quoted_b/post/QUOTED" role="link"><span>q</span></a>' +
  '<span dir="auto">被引用的內文</span>' +
  threadsActionRow('tc-quoted-row', ['讚', '回覆', '轉發', '分享']) +
  '</div>' +
  threadsActionRow('tc-toolbar', ['追蹤', '更多', '已靜音', '排序']) +
  threadsActionRow('tc-row', ['讚', '回覆', '轉發', '分享']) +
  '</div></div>';

// ============================================================
// 站點選擇
// ============================================================

// C1-40 核准翻轉：站點清單加入 facebook（Facebook 細節見 test/post-icon-facebook.test.js）。
test('C1 站點設定：__sites.threads、__sites.instagram 與 __sites.facebook 都存在，且帶齊十個介面函式', () => {
  const all = sites();
  ['threads', 'instagram', 'facebook'].forEach((id) => {
    const site = all[id];
    assert.ok(site && typeof site === 'object', `__sites.${id} 應存在`);
    assert.equal(site.id, id, `__sites.${id}.id 應為 '${id}'`);
    SITE_FUNCTIONS.forEach((name) => {
      assert.equal(typeof site[name], 'function', `__sites.${id}.${name} 應為函式`);
    });
  });
});

test('C1 站點選擇：threads.com／threads.net（含 www）選 threads，instagram.com 與子網域選 instagram，其他回 null', () => {
  const api = loadPostIcon();
  assert.equal(typeof api.__selectSite, 'function', 'post-icon 應匯出 __selectSite(hostname)');
  ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].forEach((host) => {
    assert.equal(api.__selectSite(host), api.__sites.threads, host);
  });
  ['instagram.com', 'www.instagram.com', 'help.instagram.com'].forEach((host) => {
    assert.equal(api.__selectSite(host), api.__sites.instagram, host);
  });
  [
    'example.com',
    'instagram.com.evil.io',
    'notinstagram.com',
    'threads.com.evil.io',
    'notthreads.net',
    '',
    undefined,
    null,
  ].forEach((host) => {
    assert.equal(api.__selectSite(host), null, String(host));
  });
});

test('C1 站點選擇：matches 與 __selectSite 一致，兩站互不搶網域', () => {
  const { threads, instagram } = sites();
  assert.equal(threads.matches('www.threads.com'), true);
  assert.equal(threads.matches('www.instagram.com'), false);
  assert.equal(instagram.matches('www.instagram.com'), true);
  assert.equal(instagram.matches('www.threads.com'), false);
  assert.equal(instagram.matches('instagram.com.evil.io'), false);
});

// ============================================================
// Threads 設定與重構前行為等價
// ============================================================

test('C1 Threads 等價：pageType 不分頁型，一律回 default', () => {
  const { threads } = sites();
  ['/', '/@author_a', '/@author_a/post/POSTCODE', '/search'].forEach((p) => {
    assert.equal(threads.pageType(p), 'default', p);
  });
});

test('C1 Threads 等價：canonicalUrl 與既有 buildPostUrl 逐筆相同（去 query／hash、擋換域與非常規 scheme）', () => {
  const api = loadPostIcon();
  const { threads } = api.__sites;
  const origin = 'https://www.threads.com';
  [
    '/@author_a/post/POSTCODE',
    '/@author_a/post/POSTCODE?xmt=abc#top',
    '/@author_a/post/POSTCODE/',
    'javascript:alert(1)',
    '//evil.example/x',
    'https://evil.example/@a/post/X',
    123,
    null,
  ].forEach((href) => {
    assert.equal(threads.canonicalUrl(href, origin), api.buildPostUrl(href, origin), String(href));
  });
  assert.equal(threads.canonicalUrl('/@a/post/X', 'not a url'), null);
});

test('C1 Threads 等價：findContainers 取 div[data-pressable-container]（含巢狀引用），permalinkOf 排除 /media 與引用貼文的連結', () => {
  const { threads } = sites();
  const doc = createDocument(THREADS_PAGE);
  const containers = threads.findContainers(doc, THREADS_CTX);
  assert.deepEqual(
    Array.from(containers).map((c) => c.id),
    ['tc-main', 'tc-quoted'],
    '與舊的 document.querySelectorAll(div[data-pressable-container]) 同一組、同順序'
  );
  assert.equal(threads.permalinkOf(doc.getElementById('tc-main'), THREADS_CTX), '/@author_a/post/POSTCODE');
  assert.equal(threads.permalinkOf(doc.getElementById('tc-quoted'), THREADS_CTX), '/@quoted_b/post/QUOTED');
});

test('C1 Threads 等價：findActionRow 在影片工具列與真互動列之間選對、不搶引用貼文的列；insertionPoint 是列尾', () => {
  const { threads } = sites();
  const doc = createDocument(THREADS_PAGE);
  const row = threads.findActionRow(doc.getElementById('tc-main'), THREADS_CTX);
  assert.ok(row, '應找到互動列');
  assert.equal(row.id, 'tc-row');
  assert.equal(threads.findActionRow(doc.getElementById('tc-quoted'), THREADS_CTX).id, 'tc-quoted-row');

  const point = threads.insertionPoint(row, THREADS_CTX);
  assert.ok(point, 'insertionPoint 應回傳插入位置');
  assertSameNode(point.parent, row, '插在互動列本身');
  assertSameNode(point.before, null, '插在最後一顆按鈕之後（lastWrapper.nextSibling）');
});

test('C1 Threads 等價：author 取第一個非 /post/ 的 /@ 連結（handle 帶 @），excerpt 跳過時間戳記與引用內文', () => {
  const { threads } = sites();
  const doc = createDocument(THREADS_PAGE);
  const main = doc.getElementById('tc-main');
  assert.deepEqual(threads.author(main, THREADS_CTX), { author: 'author_a', handle: '@author_a' });
  assert.equal(threads.excerpt(main, THREADS_CTX), '內文第一行');
});

test('C1 Threads 等價：observeRoot 是 document.body（沒有 body 時退回 documentElement）', () => {
  const { threads } = sites();
  const doc = createDocument('<main></main>');
  assertSameNode(threads.observeRoot(doc), doc.body);
  const bare = { body: null, documentElement: { nodeType: 1 } };
  assertSameNode(threads.observeRoot(bare), bare.documentElement);
});

// ============================================================
// 整合層：站點選擇決定是否啟動
// ============================================================

test('C1 整合：Threads 網域照舊注入一顆 icon 到互動列尾，observer 觀察 body', async () => {
  const env = createSiteEnv({
    origin: 'https://www.threads.com',
    pathname: '/@author_a/post/POSTCODE',
    html: THREADS_PAGE,
    trustedTypes: 'none',
  }).loadPostIcon();
  await settle();

  const row = env.byId('tc-row');
  const icons = env.icons();
  assert.equal(icons.length, 2, '主文與引用貼文各一顆（與重構前相同）');
  assert.equal(row.lastElementChild.className, 'tcl-copy-icon', '主文的 icon 在互動列最後');
  assert.ok(!env.byId('tc-toolbar').querySelector('.tcl-copy-icon'), '影片工具列不注入');
  const live = env.liveObservers();
  assert.equal(live.length, 1);
  assertSameNode(live[0].target, env.document.body);
  assert.equal(live[0].options.subtree, true);
});

test('C1 整合：location 只有 origin、沒有 hostname 時（既有測試替身的形狀），由 origin 推出 threads 照常啟動', async () => {
  const env = createSiteEnv({
    origin: 'https://www.threads.com',
    pathname: '/@author_a/post/POSTCODE',
    html: THREADS_PAGE,
    trustedTypes: 'none',
  });
  delete env.location.hostname;
  delete env.location.host;
  env.loadPostIcon();
  await settle();
  assert.equal(env.icons().length, 2, '缺 hostname 不得讓 Threads 停擺');
});

test('C1 整合：不支援的網域不啟動——不注入、不留活 observer', async () => {
  const env = createSiteEnv({
    origin: 'https://www.example.com',
    pathname: '/',
    html: THREADS_PAGE,
    trustedTypes: 'none',
  }).loadPostIcon();
  await settle();
  env.poke();
  await settle();
  assert.equal(env.icons().length, 0);
  assert.equal(env.liveObservers().length, 0);
});
