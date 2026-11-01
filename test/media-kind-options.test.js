// test/media-kind-options.test.js — 0.13.0 車道 F 的 F-3：options 頁歷史卡片的
// 影片／相片徽章。
//
//   - 站點徽章（entry-site-badge）之後掛一顆 class 為 entry-badge entry-media-badge
//     的徽章，文案 zh「影片」「相片」、en「Video」「Photo」。
//   - 種類由 TCLCore.mediaKindOf(url) 讀取時計算，回 null 時不掛，不寫入任何欄位。
//   - 徽章順序：kind 徽章、站點徽章、媒體徽章。
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
const FB_POST = 'https://www.facebook.com/fx_user_a/posts/pfbid0FXAAAbbbCCCdddEEEfff';
const FB_POST_NUMERIC = `https://www.facebook.com/fx_user_a/posts/${ID}`;
const FB_REEL = `https://www.facebook.com/reel/${ID}`;
const FB_PHOTO = `https://www.facebook.com/photo/?fbid=${PHID}&set=a.${GID}`;
const IG_P = 'https://www.instagram.com/p/XYZ/';
const IG_REEL = 'https://www.instagram.com/reel/XYZ/';
const THREADS_URL = 'https://www.threads.com/@usera/post/AbC123_-xyz';

function makeCtx(history, langPref) {
  const storage = createChromeStorage({ langPref }, { history });
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

function hasClass(node, name) {
  return String(node.className || '').split(/\s+/).indexOf(name) !== -1;
}

function cards(doc) {
  return doc.ids.rows.children.filter((n) => hasClass(n, 'entry-card'));
}

function mediaBadges(card) {
  return walk(card).filter((n) => hasClass(n, 'entry-media-badge'));
}

function entry(over) {
  return Object.assign({ kind: 'icon', at: 90000, seen: [{ at: 90000, kind: 'icon' }] }, over);
}

async function renderOne(url, langPref = 'zh') {
  const ctx = makeCtx([entry({ url })], langPref);
  await ctx.controller.init();
  await settle();
  const list = cards(ctx.doc);
  assert.equal(list.length, 1, `前置：${url} 的卡片要畫出來`);
  return { ctx, card: list[0] };
}

// ---- 有種類的卡片掛媒體徽章 ----

for (const [no, name, url, text] of [
  ['F2-01', 'FB reel', FB_REEL, '影片'],
  ['F2-02', 'FB /photo/?fbid=', FB_PHOTO, '相片'],
  ['F2-03', 'IG /p/', IG_P, '相片'],
  ['F2-04', 'IG /reel/', IG_REEL, '影片'],
]) {
  test(`${no} 卡片：${name} 掛一顆「${text}」徽章（entry-badge entry-media-badge）`, async () => {
    const { card } = await renderOne(url);
    const badges = mediaBadges(card);
    assert.equal(badges.length, 1, '一筆只會有一顆媒體徽章');
    assert.ok(hasClass(badges[0], 'entry-badge'), 'class 含 entry-badge');
    assert.equal(badges[0].textContent, text);
  });
}

// ---- 無法判斷的不掛 ----

for (const [no, name, url] of [
  ['F2-05', 'FB /<user>/posts/<pfbid>', FB_POST],
  ['F2-06', 'FB /<user>/posts/<數字>', FB_POST_NUMERIC],
  ['F2-07', 'Threads 貼文', THREADS_URL],
]) {
  test(`${no} 卡片：${name} 無法判斷媒體種類，不掛媒體徽章`, async () => {
    const { card } = await renderOne(url);
    assert.equal(mediaBadges(card).length, 0);
    const texts = walk(card).map((n) => n.textContent);
    assert.equal(texts.indexOf('影片'), -1);
    assert.equal(texts.indexOf('相片'), -1);
  });
}

// ---- 英文介面 ----

for (const [no, name, url, text] of [
  ['F2-08', 'FB reel', FB_REEL, 'Video'],
  ['F2-09', 'IG /p/', IG_P, 'Photo'],
  ['F2-10', 'FB /photo/?fbid=', FB_PHOTO, 'Photo'],
  ['F2-11', 'IG /reel/', IG_REEL, 'Video'],
]) {
  test(`${no} 卡片：langPref en 時 ${name} 的媒體徽章顯示「${text}」`, async () => {
    const { card } = await renderOne(url, 'en');
    const badges = mediaBadges(card);
    assert.equal(badges.length, 1);
    assert.equal(badges[0].textContent, text);
  });
}

// ---- 順序 ----

for (const [no, name, url] of [
  ['F2-12', 'FB reel', FB_REEL],
  ['F2-13', 'IG /p/', IG_P],
]) {
  test(`${no} 卡片：${name} 的徽章順序為 kind 徽章、站點徽章、媒體徽章，媒體徽章緊接站點徽章`, async () => {
    const { card } = await renderOne(url);
    const badges = walk(card).filter((n) => hasClass(n, 'entry-badge'));
    assert.equal(badges.length, 3, 'kind、站點、媒體各一顆');
    assert.ok(
      !hasClass(badges[0], 'entry-site-badge') && !hasClass(badges[0], 'entry-media-badge'),
      '第一顆是 kind 徽章',
    );
    assert.ok(hasClass(badges[1], 'entry-site-badge'), '第二顆是站點徽章');
    assert.ok(hasClass(badges[2], 'entry-media-badge'), '第三顆是媒體徽章');
    const parent = walk(card).find((n) => (n.children || []).indexOf(badges[1]) !== -1);
    assert.ok(parent, '前置：找得到站點徽章的父節點');
    assert.equal(
      parent.children.indexOf(badges[2]),
      parent.children.indexOf(badges[1]) + 1,
      '媒體徽章與站點徽章同層且緊接其後',
    );
  });
}

// ---- 不寫入任何欄位（F-4） ----

test('F2-14 卡片：畫出媒體徽章後，本機歷史條目不出現媒體種類欄位', async () => {
  const { ctx } = await renderOne(FB_REEL);
  assert.equal(mediaBadges(ctx.doc.ids.rows).length, 1, '前置：媒體徽章已畫出');
  const got = await ctx.storage.local.get('history');
  for (const e of (got && got.history) || []) {
    const keys = Object.keys(e).filter((k) => /media|kindOf/i.test(k));
    assert.deepEqual(keys, [], '歷史條目不得新增媒體種類欄位');
  }
});
