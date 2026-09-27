// test/reinject-files.test.js — 決策 S1 的清單補齊（R2）：擴充功能更新時
// background.js 對既開 Threads 分頁重注入的檔案清單 REINJECT_FILES，必須等
// 於 manifest.json 裡 ISOLATED world 的 content script——document_start 那組
// 接 document_idle 那組，順序與 manifest 一致。MAIN world 的
// clipboard-guard.js 不在範圍內（重注入會把 writeText 包第二層）。
//
// 期望值從 manifest.json 推導，不在測試裡寫死第二份清單；另附一條寫死的
// 對照，讓 manifest 被改動時這裡也會提醒回頭檢查。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');

const ROOT_DIR = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8'));

const RUN_AT_ORDER = ['document_start', 'document_end', 'document_idle'];

// manifest 裡 ISOLATED world（未指定 world 即 ISOLATED）的 content script，
// 依 run_at 先後、同一 run_at 內依 manifest 陣列順序攤平。
function isolatedContentScripts() {
  const groups = (MANIFEST.content_scripts || []).filter(
    (entry) => (entry.world || 'ISOLATED') === 'ISOLATED'
  );
  const out = [];
  RUN_AT_ORDER.forEach((runAt) => {
    groups
      .filter((entry) => (entry.run_at || 'document_idle') === runAt)
      .forEach((entry) => (entry.js || []).forEach((file) => out.push(file)));
  });
  return out;
}

function mainWorldScripts() {
  const out = [];
  (MANIFEST.content_scripts || [])
    .filter((entry) => entry.world === 'MAIN')
    .forEach((entry) => (entry.js || []).forEach((file) => out.push(file)));
  return out;
}

function loadBackground() {
  const onInstalledListeners = [];
  const executeScriptCalls = [];
  const chrome = {
    runtime: {
      id: 'test-extension-id',
      onInstalled: { addListener: (fn) => onInstalledListeners.push(fn) },
      onMessage: { addListener: () => {} },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: () => {} },
    },
    notifications: { create: () => {} },
    tabs: {
      TAB_ID_NONE: -1,
      query: async () => [{ id: 7, url: 'https://www.threads.com/' }],
    },
    scripting: {
      executeScript: async (injection) => {
        executeScriptCalls.push(injection);
        return [{}];
      },
    },
    storage: createChromeStorage({}).api,
  };
  const sandbox = loadSwSources({
    chrome,
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
    console,
    URL,
    URLSearchParams,
    crypto,
    setTimeout,
    clearTimeout,
  });
  return {
    sandbox,
    executeScriptCalls,
    fireInstalled(details) {
      onInstalledListeners.slice().forEach((fn) => fn(details || { reason: 'update' }));
    },
  };
}

// 模組層 const 落在 vm context 的全域詞法環境，只能在 context 內求值；結
// 果搬回本 realm 再比對（跨 realm 的陣列 deepEqual 會失敗）。
function reinjectFiles(bg) {
  return Array.from(vm.runInContext('REINJECT_FILES', bg.sandbox));
}

test('R2 前提：manifest 的 ISOLATED content script 依序為 bridge、i18n、tcl-core、post-icon、scam-guard', () => {
  assert.deepEqual(
    isolatedContentScripts(),
    ['bridge.js', 'i18n.js', 'tcl-core.js', 'post-icon.js', 'scam-guard.js'],
    'manifest 若調整了 content_scripts，請一併檢查 REINJECT_FILES 與本檔'
  );
});

test('R2：REINJECT_FILES 等於 manifest 的 document_start＋document_idle ISOLATED 腳本，順序一致', () => {
  const bg = loadBackground();
  assert.deepEqual(
    reinjectFiles(bg),
    isolatedContentScripts(),
    '重注入清單缺 tcl-core.js／scam-guard.js 時，重注入的新實例會缺件（scam-guard 不會被補回）'
  );
});

test('R2：擴充功能更新時實際送出的 executeScript 檔案清單與 manifest 一致，且注入 ISOLATED world', async () => {
  const bg = loadBackground();
  bg.fireInstalled({ reason: 'update' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(bg.executeScriptCalls.length, 1, '前提：唯一的 threads 分頁被重注入一次');
  const call = bg.executeScriptCalls[0];
  assert.deepEqual(Array.from(call.files), isolatedContentScripts());
  assert.equal(call.world, 'ISOLATED');
});

test('R2（回歸）：MAIN world 的腳本不在重注入清單內，清單內的每支檔案都真實存在', () => {
  const bg = loadBackground();
  const files = reinjectFiles(bg);
  mainWorldScripts().forEach((file) => {
    assert.equal(files.includes(file), false, `${file} 是 MAIN world 腳本，不得重注入`);
  });
  files.forEach((file) => {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, file)), `${file} 不存在`);
  });
});
