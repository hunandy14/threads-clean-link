// test/popup.test.js — v1.1 popup 控制頁邏輯層的行為契約(規格 S7，
// 並在此固定設定鍵的預設值)。
//
// ============================================================
// 【R1-1 開關合併】設定鍵砍為兩顆:autoClean、notifySuccess。resolveShortcode
// 徹底移除(設定形狀、popup 控件、縮排子項一併移除)，短碼解析與 ?xmt 剪參
// 都收在 autoClean 這一顆之下。原本 resolveShortcode 的禁用連動測試隨之刪除。
//
// 【設計約定(S7 明文允許)】
// 本專案測試環境是 Node 內建 test runner，沒有 DOM harness(無 jsdom、
// 不開瀏覽器)。因此 popup 的邏輯層約定實作為「可注入 document 與 storage
// 的純函式模組」popup.js，本檔的邏輯層測試不測 HTML 版面與樣式;版面與
// 外觀改用讀 popup.html 原文的靜態測試把關(見檔案末段 R1-3)。
//
// popup.js 對測試暴露的契約:
//   DEFAULT_SETTINGS
//     兩個設定鍵的預設值物件。
//   createPopupController({ document, storage }) → { init(): Promise }
//     - document 只透過 getElementById(id) 取控件，兩個 checkbox 的 id 為
//       'autoClean'、'notifySuccess'(與 chrome.storage.sync 的鍵同名)。
//     - storage 是 chrome.storage.sync 形狀的物件(get / set)，由外部注入，
//       popup 邏輯層不直接碰全域 chrome，才能離線測試。
//     - init() 依序:讀取設定 → 套用到兩個 checkbox 的 checked → 為兩個
//       checkbox 綁定 'change'。
//     - 使用者切換 checkbox 觸發 'change' 時，把新值寫回 storage。
//   模組以 CommonJS 匯出(popup.js 在瀏覽器端載入時需自行判斷 module 是否存在)。
//
// 【時序紀律】storage mock 的 get/set 一律延遲一個 tick 才結算
// (見 support/helpers.js)，不在同一個 tick 直接 resolve，避免同 tick 假綠燈。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createChromeStorage, createCheckboxDocument } = require('./support/helpers');

const IDS = ['autoClean', 'notifySuccess'];

// 尚未實作 popup.js 時 require 會丟 MODULE_NOT_FOUND:刻意延遲到各測試內部
// 才載入，讓紅燈落在個別測試上，而不是整個測試檔在載入階段就崩掉。
function loadPopup() {
  return require(path.join(__dirname, '..', 'popup.js'));
}

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(initial = {}) {
  const popup = loadPopup();
  const storage = createChromeStorage(initial);
  const doc = createCheckboxDocument(IDS);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync });
  return { popup, storage, doc, controller };
}

// ---- S7 / R1-1:兩個設定鍵與預設值 ----

test('S7:DEFAULT_SETTINGS 只有兩顆鍵，autoClean:true、notifySuccess:false', () => {
  const popup = loadPopup();

  assert.deepEqual(popup.DEFAULT_SETTINGS, {
    autoClean: true,
    notifySuccess: false,
  });
});

// ---- S7:兩開關讀 chrome.storage.sync ----

test('S7:init() 把 chrome.storage.sync 既有設定逐一套用到兩個 checkbox', async () => {
  const { storage, doc, controller } = setup({ autoClean: false, notifySuccess: true });

  await controller.init();
  await settle();

  assert.equal(doc.elements.autoClean.checked, false);
  assert.equal(doc.elements.notifySuccess.checked, true);
  assert.ok(storage.calls.get.length >= 1, 'popup 應向 chrome.storage.sync 讀取設定');
});

test('S7:storage 為空時，init() 以兩個預設值呈現兩個開關', async () => {
  const { doc, controller } = setup({});

  await controller.init();
  await settle();

  assert.equal(doc.elements.autoClean.checked, true);
  assert.equal(doc.elements.notifySuccess.checked, false);
});

// ---- S7:兩開關寫 chrome.storage.sync ----

test('S7:切換 notifySuccess 開關，新值寫回 chrome.storage.sync', async () => {
  const { storage, doc, controller } = setup({});
  await controller.init();
  await settle();

  doc.elements.notifySuccess.fireChange(true);
  await settle();

  assert.equal(storage.snapshot().notifySuccess, true);
  assert.ok(storage.calls.set.length >= 1, 'popup 應把新值寫回 chrome.storage.sync');
});

test('S7:切換 autoClean 開關，新值寫回 chrome.storage.sync', async () => {
  const { storage, doc, controller } = setup({ autoClean: true, notifySuccess: false });
  await controller.init();
  await settle();

  doc.elements.autoClean.fireChange(false);
  await settle();

  assert.equal(storage.snapshot().autoClean, false);
});

// ---- MV3 CSP:popup.html 不得有內嵌 script(靜態防回歸) ----
//
// 上面的測試全跑邏輯層，照不到 HTML 的載入方式。MV3 預設 CSP
// (script-src 'self') 會靜默擋掉無 src 的內嵌 <script>，接線一旦寫回
// popup.html 內嵌，popup 會整個失效卻仍然全綠。此測試改讀 popup.html
// 原文，確保每個 <script 標籤都帶 src。

test('MV3 CSP:popup.html 內所有 <script> 都必須帶 src，不得使用內嵌腳本', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');

  const openTags = html.match(/<script\b[^>]*>/gi) || [];

  assert.ok(openTags.length >= 1, 'popup.html 應至少載入一支外部腳本');
  for (const tag of openTags) {
    assert.ok(
      /\bsrc\s*=/i.test(tag),
      `popup.html 出現無 src 的內嵌 <script>，會被 MV3 預設 CSP 擋掉:${tag}`
    );
  }
});
