// test/support/sw-sources.js — 在 vm 沙箱內依 service worker 的真實順序載入
// background.js 與它以 importScripts 拉進來的所有腳本。
//
// 載入順序從 background.js 解析：與 test/package.test.js、tools/manifest-files.mjs
// 同一條正則，只認單參數的 importScripts('x.js')。i18n.js 與 tcl-core.js 一律先載，
// 其餘依 background.js 內出現的順序逐檔執行，最後才執行 background.js 本體。
//
// 逐檔各自 vm.runInContext：每支檔案是獨立的 Script，重現 importScripts 的腳本
// 邊界——classic script 之間重複宣告 const／let 會在這裡當場 SyntaxError，頂層
// 引用尚未載入檔案的識別字會當場 ReferenceError，與真 SW 的行為一致。同一個
// context 內各 script 共用全域詞法環境，測試端 vm.runInContext('NAME', sandbox)
// 讀頂層 const 照舊可用。
//
// auth.js 與 sync.js 預設不載：background 的測試多半注入 TCLSync 替身或完全
// 不接引擎。realSync:true 時才把兩支真模組載進沙箱；沙箱已有 TCLSync 時一律
// 略過 sync.js。沙箱沒有 importScripts，SW 端各檔的 importScripts 守衛不會觸發。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const IMPORT_RE = /importScripts\(\s*['"]([^'"]+)['"]\s*\)/g;
const ENGINE_FILES = new Set(['auth.js', 'sync.js']);

function readSource(file) {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

// background.js 以 importScripts 載入的檔案，依出現順序、去重。
function importsOf(file) {
  const out = [];
  for (const m of readSource(file).matchAll(IMPORT_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// SW 的完整載入順序（不含 background.js 本體）。
function swLoadOrder() {
  const order = ['i18n.js', 'tcl-core.js'];
  importsOf('background.js').forEach((f) => {
    if (!order.includes(f)) order.push(f);
  });
  return order;
}

// SW 原生就有、vm 沙箱預設沒有的全域。每次呼叫時才取值：settle.js 會換掉
// 全域 setTimeout／clearTimeout，沙箱要拿到換過的那一份。
function baseGlobals() {
  return {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
    AbortSignal,
    AbortController,
  };
}

// 沙箱補齊 base 全域（呼叫端已給的鍵不覆寫）後建立 context。
function prepareSandbox(sandbox) {
  const base = baseGlobals();
  for (const k of Object.keys(base)) if (!(k in sandbox)) sandbox[k] = base[k];
  if (!vm.isContext(sandbox)) vm.createContext(sandbox);
  return sandbox;
}

// 依序載入 SW 所有腳本與 background.js 本體，回傳同一個 sandbox。
function loadSwSources(sandbox, { realSync = false } = {}) {
  prepareSandbox(sandbox);
  for (const f of swLoadOrder()) {
    if (ENGINE_FILES.has(f) && !realSync) continue;
    if (f === 'sync.js' && sandbox.TCLSync) continue;
    vm.runInContext(readSource(f), sandbox, { filename: f });
  }
  vm.runInContext(readSource('background.js'), sandbox, { filename: 'background.js' });
  return sandbox;
}

module.exports = {
  REPO_ROOT,
  IMPORT_RE,
  readSource,
  importsOf,
  swLoadOrder,
  baseGlobals,
  prepareSandbox,
  loadSwSources,
};
