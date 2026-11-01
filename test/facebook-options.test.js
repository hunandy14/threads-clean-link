// test/facebook-options.test.js — 0.13.0 車道 A 的 A4：options 頁的歷史卡片
// 認得 Facebook 條目。
//
//   - 讀取端 sanitizeEntries 收下 Facebook 條目（含相片頁 ?fbid= 的保留參數）。
//   - 卡片對 Facebook 顯示純文字徽章「Facebook」（class entry-badge entry-site-badge，
//     不加圖示）；一筆只會有一個站別徽章，Threads／Instagram 卡片不出現「Facebook」。
//   - 詳情框「原始連結」只在 original≠cleaned 時出現。
//
// 測試資料的帳號名與 id 皆為假值。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createChromeStorage } = require('./support/helpers');
const { makeDocumentStub } = require('./support/options-dom');

const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

const ID = '100000000000001';
const GID = '100000000000002';
const PHID = '100000000000003';
const FB_POST = `https://www.facebook.com/fx_user_a/posts/pfbid0FXAAAbbbCCCdddEEEfff`;
const FB_POST_ORIGINAL = FB_POST + '?fbclid=x&mibextid=y';
const FB_REEL = `https://www.facebook.com/reel/${ID}`;
const FB_PHOTO = `https://www.facebook.com/photo/?fbid=${PHID}&set=a.${GID}`;
const IG_P = 'https://www.instagram.com/p/XYZ/';
const THREADS_URL = 'https://www.threads.com/@usera/post/AbC123_-xyz';

function makeCtx(history) {
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
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
  return { storage, doc, controller };
}

function walk(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

function allText(node) {
  return walk(node)
    .map((n) => n.textContent || '')
    .join('|');
}

function isSvg(node) {
  return node.tag === 'svg' || node.tag === 'use';
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

function entry(over) {
  return Object.assign({ kind: 'icon', at: 90000, seen: [{ at: 90000, kind: 'icon' }] }, over);
}

async function renderOne(url, over = {}) {
  const ctx = makeCtx([entry(Object.assign({ url }, over))]);
  await ctx.controller.init();
  await settle();
  const list = cards(ctx.doc);
  assert.equal(list.length, 1, `前置：${url} 的卡片要畫出來`);
  return { ctx, card: list[0] };
}

// ---- sanitizeEntries ----

test('A4-1 sanitizeEntries：Facebook 各頁型條目收下，original 與 removedParams 保留', () => {
  const out = options.sanitizeEntries([
    entry({
      url: FB_POST,
      original: FB_POST_ORIGINAL,
      removedParams: [
        { key: 'fbclid', value: 'x' },
        { key: 'mibextid', value: 'y' },
      ],
    }),
    entry({ url: FB_REEL, at: 89000 }),
    entry({ url: FB_PHOTO, at: 88000 }),
  ]);
  assert.equal(out.length, 3, 'Facebook 條目不得在讀取端被整筆丟掉');
  const post = out.find((e) => e.url === FB_POST);
  assert.ok(post, 'posts 條目 url 原樣');
  assert.equal(post.original, FB_POST_ORIGINAL);
  assert.equal(post.removedParams.length, 2);
  assert.ok(out.find((e) => e.url === FB_PHOTO), '相片頁的 ?fbid=&set= 原樣保留');
});

// 車道 D（D-4 A4-2）：下行項目一律顯示，可顯示的 Facebook 網址在讀取端保留、url 原樣。
test('A4-2 sanitizeEntries：無法正規化但可顯示的 Facebook 網址（m. 子網域、share 短碼、個人頁）整筆保留、url 原樣', () => {
  const urls = [
    `https://m.facebook.com/fx_user_a/posts/${ID}`,
    'https://www.facebook.com/share/p/AbCdEfGh12/',
    'https://www.facebook.com/fx_user_a',
  ];
  const out = options.sanitizeEntries(urls.map((url, i) => entry({ url, at: 90000 - i })));
  assert.deepEqual(out.map((e) => e.url).sort(), urls.slice().sort());
});

// ---- 站別徽章 ----

for (const [no, url] of [
  ['A4-3a', FB_POST],
  ['A4-3b', FB_REEL],
  ['A4-3c', FB_PHOTO],
]) {
  test(`${no} 卡片：Facebook 顯示純文字徽章「Facebook」（entry-badge entry-site-badge），徽章內沒有圖示：${url}`, async () => {
    const { card } = await renderOne(url);
    const badge = walk(card).find((n) => n.textContent === 'Facebook');
    assert.ok(badge, '卡片上要有文字恰為「Facebook」的徽章');
    assert.ok(classes(badge).indexOf('entry-badge') !== -1, 'class 含 entry-badge');
    assert.ok(classes(badge).indexOf('entry-site-badge') !== -1, 'class 含 entry-site-badge');
    assert.equal(walk(badge).some(isSvg), false, '徽章是純文字，不加圖示');
  });
}

test('A4-4 卡片：Facebook 卡片只有一個站別徽章，且不出現「Instagram」', async () => {
  const { card } = await renderOne(FB_POST);
  const badges = siteBadges(card);
  assert.equal(badges.length, 1, '一筆只會有一個站別徽章');
  assert.equal(badges[0].textContent, 'Facebook');
  assert.equal(allText(card).indexOf('Instagram'), -1);
});

test('A4-5 卡片：Instagram 卡片仍是「Instagram」徽章、不出現「Facebook」（對照組）', async () => {
  const { card } = await renderOne(IG_P);
  const badges = siteBadges(card);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, 'Instagram');
  assert.equal(allText(card).indexOf('Facebook'), -1);
});

test('A4-6 卡片：Threads 卡片沒有站別徽章、不出現「Facebook」（對照組）', async () => {
  const { card } = await renderOne(THREADS_URL);
  assert.equal(siteBadges(card).length, 0);
  assert.equal(allText(card).indexOf('Facebook'), -1);
});

test('A4-7 卡片：Facebook 有 author 或 excerpt 時照既有預覽顯示，徽章仍在', async () => {
  const { card } = await renderOne(FB_POST, { author: 'Fake Person', excerpt: '一段摘要' });
  const text = allText(card);
  assert.ok(text.indexOf('Fake Person') !== -1);
  assert.ok(text.indexOf('一段摘要') !== -1);
  assert.ok(walk(card).some((n) => n.textContent === 'Facebook'), '徽章仍在');
});

// ---- 詳情框原始連結 ----

test('A4-8 buildDetailExtraRows：Facebook original≠cleaned 時出現「原始連結」列；相同時不出現', () => {
  const rows = options.buildDetailExtraRows({ url: FB_POST, original: FB_POST_ORIGINAL });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'original');
  assert.equal(rows[0].copyValue, FB_POST_ORIGINAL);
  assert.deepEqual(options.buildDetailExtraRows({ url: FB_POST, original: FB_POST }), []);
});
