// test/popup.test.js — v1.1 popup 控制頁邏輯層的行為契約(規格 S7，
// 並在此固定三個設定鍵的預設值)。
//
// ============================================================
// 【設計約定(S7 明文允許)】
// 本專案測試環境是 Node 內建 test runner，沒有 DOM harness(無 jsdom、
// 不開瀏覽器)。因此 popup 的邏輯層約定實作為「可注入 document 與 storage
// 的純函式模組」popup.js，本檔只測邏輯層，不測 HTML 版面與樣式。
//
// popup.js 對測試暴露的契約:
//   DEFAULT_SETTINGS
//     三個設定鍵的預設值物件。
//   createPopupController({ document, storage }) → { init(): Promise }
//     - document 只透過 getElementById(id) 取控件，三個 checkbox 的 id 為
//       'autoClean'、'resolveShortcode'、'notifySuccess'(與 chrome.storage
//       .sync 的鍵同名)。
//     - storage 是 chrome.storage.sync 形狀的物件(get / set)，由外部注入，
//       popup 邏輯層不直接碰全域 chrome，才能離線測試。
//     - init() 依序:讀取設定 → 套用到三個 checkbox 的 checked → 依 autoClean
//       更新 resolveShortcode 的 disabled → 為三個 checkbox 綁定 'change'。
//     - 使用者切換 checkbox 觸發 'change' 時，把新值寫回 storage，並即時更新
//       resolveShortcode 的禁用狀態。
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

const IDS = ['autoClean', 'resolveShortcode', 'notifySuccess'];

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

// ---- S7:三個設定鍵與預設值 ----

test('S7:DEFAULT_SETTINGS 為 autoClean:true、resolveShortcode:true、notifySuccess:false', () => {
  const popup = loadPopup();

  assert.deepEqual(popup.DEFAULT_SETTINGS, {
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
  });
});

// ---- S7:三開關讀 chrome.storage.sync ----

test('S7:init() 把 chrome.storage.sync 既有設定逐一套用到三個 checkbox', async () => {
  const { storage, doc, controller } = setup({
    autoClean: true,
    resolveShortcode: false,
    notifySuccess: true,
  });

  await controller.init();
  await settle();

  assert.equal(doc.elements.autoClean.checked, true);
  assert.equal(doc.elements.resolveShortcode.checked, false);
  assert.equal(doc.elements.notifySuccess.checked, true);
  assert.ok(storage.calls.get.length >= 1, 'popup 應向 chrome.storage.sync 讀取設定');
});

test('S7:storage 為空時，init() 以三個預設值呈現三個開關', async () => {
  const { doc, controller } = setup({});

  await controller.init();
  await settle();

  assert.equal(doc.elements.autoClean.checked, true);
  assert.equal(doc.elements.resolveShortcode.checked, true);
  assert.equal(doc.elements.notifySuccess.checked, false);
});

// ---- S7:三開關寫 chrome.storage.sync ----

test('S7:切換 notifySuccess 開關，新值寫回 chrome.storage.sync', async () => {
  const { storage, doc, controller } = setup({});
  await controller.init();
  await settle();

  doc.elements.notifySuccess.fireChange(true);
  await settle();

  assert.equal(storage.snapshot().notifySuccess, true);
  assert.ok(storage.calls.set.length >= 1, 'popup 應把新值寫回 chrome.storage.sync');
});

test('S7:切換 resolveShortcode 開關，新值寫回 chrome.storage.sync', async () => {
  const { storage, doc, controller } = setup({ autoClean: true, resolveShortcode: true });
  await controller.init();
  await settle();

  doc.elements.resolveShortcode.fireChange(false);
  await settle();

  assert.equal(storage.snapshot().resolveShortcode, false);
});

// ---- S7:autoClean=false 時 resolveShortcode 控件禁用 ----

test('S7:autoClean=false 時，resolveShortcode 控件呈禁用狀態', async () => {
  const { doc, controller } = setup({ autoClean: false, resolveShortcode: true });

  await controller.init();
  await settle();

  assert.equal(doc.elements.resolveShortcode.disabled, true);
});

test('S7:autoClean=true 時，resolveShortcode 控件不禁用', async () => {
  const { doc, controller } = setup({ autoClean: true, resolveShortcode: true });

  await controller.init();
  await settle();

  assert.equal(doc.elements.resolveShortcode.disabled, false);
});

test('S7:autoClean 由 false 切為 true，resolveShortcode 即時解除禁用且新值寫回 storage', async () => {
  const { storage, doc, controller } = setup({ autoClean: false, resolveShortcode: true });
  await controller.init();
  await settle();
  assert.equal(doc.elements.resolveShortcode.disabled, true);

  doc.elements.autoClean.fireChange(true);
  await settle();

  assert.equal(doc.elements.resolveShortcode.disabled, false);
  assert.equal(storage.snapshot().autoClean, true);
});

test('S7:autoClean 由 true 切為 false，resolveShortcode 即時進入禁用狀態', async () => {
  const { storage, doc, controller } = setup({ autoClean: true, resolveShortcode: true });
  await controller.init();
  await settle();
  assert.equal(doc.elements.resolveShortcode.disabled, false);

  doc.elements.autoClean.fireChange(false);
  await settle();

  assert.equal(doc.elements.resolveShortcode.disabled, true);
  assert.equal(storage.snapshot().autoClean, false);
});
