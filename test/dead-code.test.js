// test/dead-code.test.js — 死碼清理的常駐守門（決策 S5：死碼一律刪除）。
//
// 這裡的斷言分兩類：
//   - 原始碼掃描（DC1、DC3、DC4、DC6、DC7）：直接讀產品檔文字，找出沒有讀
//     者的定義或只為舊替身存在的守衛。
//   - 行為（DC2、DC5）：載入 UMD 模組看匯出形狀，或抽出單支函式在隔離環境
//     驗查表語意。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

// 擴充功能實際出貨、會引用字典鍵或承載守衛的產品檔。
const PRODUCT_JS = [
  'background.js',
  'sw-history.js',
  'sw-device.js',
  'sw-og.js',
  'sw-scam.js',
  'options.js',
  'popup.js',
  'options-init.js',
  'popup-init.js',
  'post-icon.js',
  'scam-guard.js',
  'bridge.js',
  'clipboard-guard.js',
  'sync.js',
  'auth.js',
  'tcl-core.js',
];
const PRODUCT_HTML = ['options.html', 'popup.html'];

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ---- DC1：字典每個鍵都要在產品檔有字面引用 ----
//
// 字面引用＝以單引號、雙引號或反引號完整包住鍵名（JS 的 t('key')、HTML 的
// data-i18n="key" 都算）。產品碼沒有前綴拼接的動態組鍵，因此不設白名單；
// 日後若出現，拼接處應改成列出完整鍵名的對照表，讓這條繼續有效。
test('DC1 字典鍵：zh 與 en 鍵集合相等，且每個鍵都在產品檔有字面引用（S5）', () => {
  const I18N = require(path.join(ROOT, 'i18n.js'));
  const zhKeys = Object.keys(I18N.STRINGS.zh).sort();
  const enKeys = Object.keys(I18N.STRINGS.en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh 與 en 兩份字典的鍵集合必須相等');

  const corpus = PRODUCT_JS.concat(PRODUCT_HTML).map(readSource).join('\n');
  const unreferenced = zhKeys.filter(
    (key) => !['\'', '"', '`'].some((quote) => corpus.includes(quote + key + quote))
  );
  assert.deepEqual(unreferenced, [], '以下字典鍵在產品檔沒有任何字面引用，應自 i18n.js 刪除');
});

// ---- DC2：沒有讀者的 UMD 匯出不得存在 ----
test('DC2 UMD 匯出：清單指名的死匯出與 SCAM_LIMITS.MAX_ALLOWLIST 已移除（CS-2）', () => {
  const TCLCore = require(path.join(ROOT, 'tcl-core.js'));
  const TCLSync = require(path.join(ROOT, 'sync.js'));
  const TCLAuth = require(path.join(ROOT, 'auth.js'));

  const leftovers = [];
  const expectAbsent = (name, api, key) => {
    if (Object.prototype.hasOwnProperty.call(api, key)) leftovers.push(name + '.' + key);
  };
  expectAbsent('TCLCore', TCLCore, 'DEFAULT_SYNC_AUTH');
  ['signInKindOf', 'MAX_UPSERTS', 'MAX_DELETES', 'MAX_SEEN_ROWS'].forEach((key) =>
    expectAbsent('TCLSync', TCLSync, key)
  );
  ['SCOPE', 'codeForLastError'].forEach((key) => expectAbsent('TCLAuth', TCLAuth, key));
  expectAbsent('TCLCore.SCAM_LIMITS', TCLCore.SCAM_LIMITS, 'MAX_ALLOWLIST');

  assert.deepEqual(leftovers, [], '以下匯出在產品碼沒有讀者，應移除匯出');
  // 內部仍在用的上限不因拿掉匯出鍵而消失。
  assert.equal(typeof TCLCore.SCAM_LIMITS.MAX_ENTRIES, 'number', 'SCAM_LIMITS.MAX_ENTRIES 仍須存在');
});

// ---- DC3：options.html 的每個 symbol 都要有人 use ----
//
// 引用有兩種形態：options.html 內的 <use href="#id">，以及 options.js 以字
// 串 '#id' 動態組出的 use（主題圖示、確認窗標題圖示、裝置種類圖示等）。
test('DC3 SVG sprite：options.html 每個 <symbol id> 都有對應的 use 引用', () => {
  const html = readSource('options.html');
  const js = readSource('options.js');
  const ids = Array.from(html.matchAll(/<symbol\s+[^>]*\bid="([^"]+)"/g), (m) => m[1]);
  assert.ok(ids.length > 0, '前提：options.html 內有 symbol sprite');

  const unused = ids.filter((id) => {
    const ref = '#' + id;
    if (html.includes('href="' + ref + '"')) return false;
    return !['\'', '"', '`'].some((quote) => js.includes(quote + ref + quote));
  });
  assert.deepEqual(unused, [], '以下 symbol 沒有任何 use 引用，應自 options.html 刪除');
});

// ---- DC4：同步引擎的 alarms 依賴只剩 create／clear ----
//
// sync.js 從不呼叫 alarms.get／getAll；background.js 仍替它注入這兩支。兩
// 邊都不得再出現，注入與使用端一起收乾淨。
test('DC4 alarms 依賴：background.js 與 sync.js 不再引用 alarms.get／alarms.getAll', () => {
  const offenders = [];
  ['background.js', 'sync.js'].forEach((file) => {
    const src = readSource(file);
    const hits = src.match(/alarms\.get(?:All)?\s*\(/g) || [];
    if (hits.length) offenders.push(file + '：' + hits.join('、'));
  });
  assert.deepEqual(offenders, [], '同步引擎用不到的 alarms.get／getAll 注入應刪除');
});

// ---- DC5：isBlockedHandle 只看 handleIndex，不依賴 allowlist ----
//
// handleIndex 由 TCLCore.rebuildScamViews 建出，只含 state 為 active 的條
// 目，dismissed 條目天生不在裡面；查表不需要再翻 allowlist。這裡把
// scam-guard.js 的 isBlockedHandle 與 normalizeHandle 原文抽出，在隔離環境
// 以 v2 形狀的名單直接驗。
function extractFunction(src, name) {
  const head = 'function ' + name + '(';
  const start = src.indexOf(head);
  assert.notEqual(start, -1, 'scam-guard.js 找不到 ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的大括號不成對');
}

function loadIsBlockedHandle(blocklist) {
  const src = readSource('scam-guard.js');
  const code =
    extractFunction(src, 'normalizeHandle') +
    '\n' +
    extractFunction(src, 'isBlockedHandle') +
    '\nisBlockedHandle;';
  const context = vm.createContext({ blocklist });
  return vm.runInContext(code, context);
}

const DC5_ACTIVE_ID = '1001';
const DC5_DISMISSED_ID = '1002';

function buildV2Blocklist() {
  const TCLCore = require(path.join(ROOT, 'tcl-core.js'));
  const entry = (overrides) =>
    Object.assign(
      {
        state: 'active',
        handle: 'someone',
        displayName: 'Someone',
        evidence: [],
        addedAt: 1,
        updatedAt: 1,
        source: 'auto',
      },
      overrides
    );
  return TCLCore.normalizeScamBlocklist({
    version: 2,
    entries: {
      [DC5_ACTIVE_ID]: entry({ handle: 'Active_Author' }),
      [DC5_DISMISSED_ID]: entry({ handle: 'dismissed_author', state: 'dismissed', dismissedAt: 2, updatedAt: 2 }),
    },
  });
}

test('DC5 isBlockedHandle：active 回 true、dismissed 回 false（v2 形狀）', () => {
  const list = buildV2Blocklist();
  assert.equal(list.entries[DC5_DISMISSED_ID].state, 'dismissed', '前提：正規化後 dismissed 條目仍在 entries');
  const isBlockedHandle = loadIsBlockedHandle(list);
  assert.equal(isBlockedHandle('Active_Author'), true, 'active 條目的 handle 要命中');
  assert.equal(isBlockedHandle('@active_author'), true, '帶 @、大小寫不同仍是同一人');
  assert.equal(isBlockedHandle('dismissed_author'), false, 'dismissed 條目不得命中');
  assert.equal(isBlockedHandle('nobody'), false, '不在名單上的 handle 不得命中');
});

test('DC5 isBlockedHandle：名單不帶 allowlist 視圖時判定不變（不依賴 allowlist）', () => {
  const list = buildV2Blocklist();
  delete list.allowlist;
  const isBlockedHandle = loadIsBlockedHandle(list);
  assert.equal(isBlockedHandle('Active_Author'), true, '判定只靠 handleIndex，active 要命中');
  assert.equal(isBlockedHandle('dismissed_author'), false, 'dismissed 不在 handleIndex，不得命中');
});

// ---- DC6：只為舊替身存在的守衛計數歸零 ----
//
// maybePromise 是「帶 callback 呼叫又接 Promise 分支」的暫存變數，實際寫法
// 是 var maybePromise = …; if (maybePromise && …)，沒有 maybePromise( 這種
// 呼叫形，故以識別字整字計數；hasStorageLocal 同樣以識別字計（定義與呼叫
// 一起算）。
test('DC6 舊替身守衛：maybePromise／hasStorageLocal／typeof MutationObserver 在產品檔出現 0 次', () => {
  const needles = [
    ['maybePromise', /\bmaybePromise\b/g],
    ['hasStorageLocal', /\bhasStorageLocal\b/g],
    ['typeof MutationObserver', /typeof\s+MutationObserver\b/g],
  ];
  const found = [];
  PRODUCT_JS.forEach((file) => {
    const src = readSource(file);
    needles.forEach(([label, pattern]) => {
      const n = (src.match(pattern) || []).length;
      if (n > 0) found.push(file + ' ' + label + ' ×' + n);
    });
  });
  assert.deepEqual(found, [], 'Chrome MV3 下恆成立或恆不跑的守衛應刪除');
});

// ---- DC7：API base URL 只定義一處 ----
//
// 以帶引號的完整網址字面值計數（'…'／"…"／`…`），帶路徑萬用字元的 host
// 權限樣式（'http://localhost:8787/*'）不算。掃描範圍涵蓋現有三處定義
// （sync.js、options.js、tools/dev-browser.mjs）與可能的新落點
// （tcl-core.js、background.js）：每個網址合計恰好出現一次，其餘地方一律
// 改讀同一常數。
const API_BASES = [
  'https://api.metalinkclearer.workers.dev',
  'https://api-staging.metalinkclearer.workers.dev',
  'http://localhost:8787',
];
const API_BASE_SCAN = ['sync.js', 'options.js', 'tools/dev-browser.mjs', 'tcl-core.js', 'background.js'];

test('DC7 API base URL：production／staging／local 網址字面值合計只定義一次', () => {
  const sources = API_BASE_SCAN.map((file) => [file, readSource(file)]);
  const report = [];
  API_BASES.forEach((url) => {
    const where = [];
    let total = 0;
    sources.forEach(([file, src]) => {
      const n = ['\'', '"', '`'].reduce((sum, quote) => sum + countOccurrences(src, quote + url + quote), 0);
      if (n > 0) where.push(file + ' ×' + n);
      total += n;
    });
    if (total !== 1) report.push(url + ' 出現 ' + total + ' 次（' + (where.join('、') || '無') + '）');
  });
  assert.deepEqual(report, [], '每個 API base 網址只能有一處字面定義，其他地方引用同一常數');
});
