// test/instagram-options.test.js — 0.12.0 車道 A 的 A4：options 頁的歷史卡片
// 與詳情框認得 Instagram 條目。
//
//   - 讀取端 sanitizeEntries 收下 Instagram 條目（original 帶追蹤參數也保留）。
//   - 卡片對 Instagram 顯示純文字徽章「Instagram」（不加圖示）；Threads 卡片不出現。
//   - author／excerpt 皆無時，卡片顯示去 scheme 與網域的路徑（如 p/XYZ/）。
//   - 詳情框「原始連結」只在 original≠cleaned 時出現（既有 buildDetailExtraRows
//     邏輯，這裡補 Instagram 案例）。
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

const IG_P = 'https://www.instagram.com/p/XYZ/';
const IG_ORIGINAL = IG_P + '?igsh=xyz&utm_source=a';
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

// 子樹的全部文字（textContent 自身 + 子節點），供「卡片上看得到什麼字」斷言。
function allText(node) {
  return walk(node)
    .map((n) => n.textContent || '')
    .join('|');
}

function isSvg(node) {
  return node.tag === 'svg' || node.tag === 'use';
}

function cards(doc) {
  return doc.ids.rows.children.filter((n) => String(n.className || '').split(/\s+/).indexOf('entry-card') !== -1);
}

function entry(over) {
  return Object.assign({ kind: 'icon', at: 90000, seen: [{ at: 90000, kind: 'icon' }] }, over);
}

test('IG-O1 sanitizeEntries：Instagram 條目收下，original（帶 igsh）與 removedParams 保留', () => {
  const out = options.sanitizeEntries([
    entry({
      url: IG_P,
      original: IG_ORIGINAL,
      removedParams: [
        { key: 'igsh', value: 'xyz' },
        { key: 'utm_source', value: 'a' },
      ],
    }),
  ]);
  assert.equal(out.length, 1, 'Instagram 條目不得在讀取端被整筆丟掉');
  assert.equal(out[0].url, IG_P);
  assert.equal(out[0].original, IG_ORIGINAL);
  assert.equal(out[0].removedParams.length, 2);
});

test('IG-O2 sanitizeEntries：Instagram 非貼文網址（個人頁）照舊整筆丟棄', () => {
  const out = options.sanitizeEntries([entry({ url: 'https://www.instagram.com/some.profile/' })]);
  assert.equal(out.length, 0);
});

test('IG-O3 卡片：Instagram 顯示純文字徽章「Instagram」，徽章內沒有圖示', async () => {
  const ctx = makeCtx([entry({ url: IG_P })]);
  await ctx.controller.init();
  await settle();

  const list = cards(ctx.doc);
  assert.equal(list.length, 1, '前置：Instagram 卡片要畫出來');
  const badge = walk(list[0]).find((n) => n.textContent === 'Instagram');
  assert.ok(badge, '卡片上要有文字恰為「Instagram」的徽章');
  assert.equal(walk(badge).some(isSvg), false, '徽章是純文字，不加圖示');
});

test('IG-O4 卡片：Threads 卡片不出現「Instagram」徽章（對照組）', async () => {
  const ctx = makeCtx([entry({ url: THREADS_URL })]);
  await ctx.controller.init();
  await settle();

  const list = cards(ctx.doc);
  assert.equal(list.length, 1);
  assert.equal(allText(list[0]).indexOf('Instagram'), -1);
});

test('IG-O5 卡片：author／excerpt 皆無時顯示去 scheme 與網域的路徑（p/XYZ/），不露出完整網址', async () => {
  const ctx = makeCtx([entry({ url: IG_P })]);
  await ctx.controller.init();
  await settle();

  const card = cards(ctx.doc)[0];
  assert.ok(card, '前置：Instagram 卡片要畫出來');
  const texts = walk(card).map((n) => n.textContent || '');
  assert.ok(texts.indexOf('p/XYZ/') !== -1, `卡片要顯示 p/XYZ/，實得 ${JSON.stringify(texts.filter(Boolean))}`);
  assert.equal(texts.some((t) => t.indexOf('https://') !== -1 || t.indexOf('instagram.com') !== -1), false, '不顯示 scheme 與網域');
});

test('IG-O6 卡片：Instagram 有 author 或 excerpt 時照既有預覽顯示（不退回路徑）', async () => {
  const ctx = makeCtx([entry({ url: IG_P, author: 'Someone', excerpt: '一段摘要' })]);
  await ctx.controller.init();
  await settle();

  const card = cards(ctx.doc)[0];
  assert.ok(card, '前置：Instagram 卡片要畫出來');
  const text = allText(card);
  assert.ok(text.indexOf('Someone') !== -1);
  assert.ok(text.indexOf('一段摘要') !== -1);
  assert.equal(text.indexOf('p/XYZ/'), -1);
});

test('IG-O7 buildDetailExtraRows：Instagram original≠cleaned 時出現「原始連結」列（顯示去網域路徑）', () => {
  const rows = options.buildDetailExtraRows({ url: IG_P, original: IG_ORIGINAL });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'original');
  assert.equal(rows[0].copyValue, IG_ORIGINAL);
  assert.equal(rows[0].display, 'p/XYZ/?igsh=xyz&utm_source=a');
});

test('IG-O8 buildDetailExtraRows：Instagram original===cleaned 時不出現「原始連結」列', () => {
  assert.deepEqual(options.buildDetailExtraRows({ url: IG_P, original: IG_P }), []);
});

test('IG-O9 詳情框：從 storage 開啟 Instagram 卡片，原始連結列與兩個追蹤參數列都畫出來', async () => {
  const ctx = makeCtx([
    entry({
      url: IG_P,
      original: IG_ORIGINAL,
      removedParams: [
        { key: 'igsh', value: 'xyz' },
        { key: 'utm_source', value: 'a' },
      ],
    }),
  ]);
  await ctx.controller.init();
  await settle();

  const card = cards(ctx.doc)[0];
  assert.ok(card, '前置：Instagram 卡片要畫出來');
  card.fire('click');
  await settle();
  const extra = ctx.doc.getElementById('detailExtraRows');
  assert.equal(extra.children.length, 3, '原始連結 1 列 + 追蹤參數 2 列');
  assert.equal(ctx.doc.getElementById('detailUrlValue').textContent, 'p/XYZ/');
});
