// test/popup.test.js — popup 控制頁邏輯層的行為契約(規格 S7，
// 並在此固定設定鍵的預設值)。
//
// ============================================================
// popup 只有兩顆設定鍵:autoClean(預設 false)與 postCopyEnabled(貼文複製
// 按鈕，預設 true)。短碼解析與 ?xmt 剪參都收在 autoClean 之下。notifySuccess
// 的底層設定鍵仍在 background.js 使用，只是不放 popup 快捷開關，完整設定
// 收在 options 頁。
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
//       'autoClean'、'postCopyEnabled'(與 chrome.storage.sync 的鍵同名)。
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

const IDS = ['autoClean', 'postCopyEnabled'];

// require 刻意延遲到各測試內部才載入(而非檔案頂層):載入失敗(如
// MODULE_NOT_FOUND)時紅燈落在個別測試上，而不是整個測試檔在載入階段就崩掉。
function loadPopup() {
  return require(path.join(__dirname, '..', 'popup.js'));
}

// settle() 原本是本檔逐字維護的一份牆鐘等待邏輯，機器忙時固定 ms 等不到
// 非同步鏈路(storage get/set 皆經 chrome.storage mock 的 setTimeout(0) 落
// 盤)跑完就斷言、閒時又白等，兩頭不討好;連同其餘五份逐字或近乎逐字相同
// 的版本收斂進 test/support/settle.js 一份共用實作(原理與各項取捨的完整
// 說明見該檔頭註解)。popup.js 以 require() 直接載入同一個 Node realm(不
// 經 vm sandbox)，本身不含任何 setTimeout，不像 background.js 有需要排除
// 的長效逾時計時器，但共用實作已一併過濾延遲超過上限的計時器，行為不受
// 影響。
const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

function setup(initial = {}) {
  const popup = loadPopup();
  const storage = createChromeStorage(initial);
  const doc = createCheckboxDocument(IDS);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync });
  return { popup, storage, doc, controller };
}

// ---- S7:兩個設定鍵與預設值 ----

test('S7:DEFAULT_SETTINGS 只有兩顆鍵，autoClean:false、postCopyEnabled:true', () => {
  const popup = loadPopup();

  assert.deepEqual(popup.DEFAULT_SETTINGS, {
    autoClean: false,
    postCopyEnabled: true,
  });
});

// ---- S7:兩開關讀 chrome.storage.sync ----

test('S7:init() 把 chrome.storage.sync 既有設定逐一套用到兩個 checkbox', async () => {
  const { storage, doc, controller } = setup({ autoClean: true, postCopyEnabled: false });

  await controller.init();
  await settle();

  assert.equal(doc.elements.autoClean.checked, true);
  assert.equal(doc.elements.postCopyEnabled.checked, false);
  assert.ok(storage.calls.get.length >= 1, 'popup 應向 chrome.storage.sync 讀取設定');
});

test('S7:storage 為空時，init() 以兩個預設值呈現兩個開關', async () => {
  const { doc, controller } = setup({});

  await controller.init();
  await settle();

  assert.equal(doc.elements.autoClean.checked, false, '新預設 false，配合 background.js 同步調整');
  assert.equal(doc.elements.postCopyEnabled.checked, true);
});

// ---- S7:兩開關寫 chrome.storage.sync ----

test('S7:切換任一開關，新值寫回 chrome.storage.sync', async () => {
  const cases = [
    { key: 'postCopyEnabled', next: false },
    { key: 'autoClean', next: true },
  ];

  for (const { key, next } of cases) {
    const { storage, doc, controller } = setup({ autoClean: false, postCopyEnabled: true });
    await controller.init();
    await settle();

    doc.elements[key].fireChange(next);
    await settle();

    assert.equal(storage.snapshot()[key], next, `${key} 的新值應寫回 storage`);
    assert.ok(storage.calls.set.length >= 1, 'popup 應把新值寫回 chrome.storage.sync');
  }
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

// ============================================================
// popup.html 版面靜態把關:兩列開關 + 現代滑動 switch。
//
// 邏輯層測試照不到版面與外觀，這裡改讀 popup.html 原文做靜態把關:
//   - 兩列開關(autoClean、notifySuccess)，id 不變，縮排子項整列移除
//   - DOM 仍是 input[type=checkbox](邏輯與測試介面不變)，外觀改用 CSS
//     實現的滑動 switch:取消原生打勾外觀、有 :checked 開啟態、有滑動過場
//   - 深淺色都要成立:深色區塊仍在，且 switch 的顏色一律走 CSS 變數，
//     不得在 input/switch 規則裡硬編色碼(硬編就等於只有一種主題成立)
//   - footer 文案不變
// 樣式「好不好看」無法自動化，本區塊只擋掉會讓 switch 明確不成立的寫法。
// ============================================================

const fsR13 = require('node:fs');

function readPopupHtml() {
  return fsR13.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
}

function readPopupStyle() {
  const html = readPopupHtml();
  const match = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return match ? match[1] : '';
}

test('R1-3:popup.html 只有兩個開關控件，id 為 autoClean 與 postCopyEnabled', () => {
  const html = readPopupHtml();

  const checkboxes = html.match(/<input\b[^>]*type\s*=\s*["']checkbox["'][^>]*>/gi) || [];
  assert.equal(checkboxes.length, 2, 'R1-1 併開關後應只剩兩個開關控件');

  const ids = checkboxes.map((tag) => {
    const m = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
    return m ? m[1] : null;
  });
  assert.deepEqual(ids.sort(), ['autoClean', 'postCopyEnabled']);
});

test('R1-3:popup.html 不得再有 resolveShortcode 控件與縮排子項', () => {
  const html = readPopupHtml();

  assert.equal(/resolveShortcode/.test(html), false, 'resolveShortcode 應徹底移除');
  assert.equal(/\bindent\b/.test(html), false, '縮排子項整列移除後不應再有 indent 樣式');
});

test('R1-3:開關以 CSS 滑動 switch 呈現，取消 checkbox 原生打勾外觀', () => {
  const style = readPopupStyle();

  assert.ok(
    /(^|[^-\w])appearance\s*:\s*none/i.test(style),
    'switch 外觀需以 appearance:none 取消原生打勾框，再自行畫軌道與滑塊'
  );
});

test('R1-3:switch 具備開啟狀態樣式與滑動過場', () => {
  const style = readPopupStyle();

  assert.ok(/:checked/.test(style), 'switch 需有 :checked 的開啟態樣式');
  assert.ok(/transition\s*:/i.test(style), '滑動 switch 需有 transition 過場，滑塊才會滑動');
});

test('R1-3:深色主題仍成立，且 switch 顏色一律走 CSS 變數不得硬編色碼', () => {
  const style = readPopupStyle();

  assert.ok(
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i.test(style),
    '深色主題區塊不得在改版時弄丟'
  );

  // 逐條規則檢查:凡選擇器明確指向 input／switch 的規則，宣告區塊內不得
  // 出現硬編十六進位色碼——硬編就代表該顏色只有一種主題會成立。
  const offenders = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(style)) !== null) {
    const selector = match[1];
    const body = match[2];
    if (!/\binput\b|switch/i.test(selector)) continue;
    if (/#[0-9a-f]{3,8}\b/i.test(body)) offenders.push(selector.trim());
  }

  assert.deepEqual(offenders, [], `switch 相關規則出現硬編色碼:${offenders.join(' / ')}`);
});

test('R1-3:footer 文案不變', () => {
  const html = readPopupHtml();

  assert.ok(
    html.includes('盡力而為，處理失敗不影響原功能。'),
    'footer 文案在改版中必須維持原樣'
  );
});

// ============================================================
// 紀錄與設定導航列(options 頁入口):第三列是 button 不是開關(上面的
// 「只有兩個 checkbox」測試同時把關了這一點)，點擊呼叫注入的
// openOptionsPage。openOptionsPage 與 i18n 都是選配 dep，未注入時
// controller 照常運作(向下相容，本檔既有測試即為證明)。
// ============================================================

test('導航列:popup.html 有 button#openOptions，點擊呼叫 openOptionsPage', async () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.ok(
    /<button\b[^>]*\bid\s*=\s*["']openOptions["']/i.test(html),
    'popup.html 應有 id=openOptions 的 button(不得是 checkbox)'
  );

  const popup = loadPopup();
  const storage = createChromeStorage({});
  const doc = createCheckboxDocument([...IDS, 'openOptions']);
  let opened = 0;
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    openOptionsPage: () => {
      opened++;
    },
  });

  await controller.init();
  await settle();

  doc.elements.openOptions.fire('click');
  assert.equal(opened, 1, '點擊導航列應呼叫 openOptionsPage 一次');
});

// 導航列箭頭定案為 Lucide arrow-up-right inline SVG(↗，「開新分頁」語意)，
// 靜態讀 popup.html 原文把關，避免日後退回純文字符號或舊 chevron。
test('導航列:nav-chev 為 Lucide arrow-up-right inline SVG(↗ 開新分頁語意)', () => {
  const html = readPopupHtml();

  assert.equal(html.includes('›'), false, 'popup.html 不應再含舊箭頭字元「›」');
  assert.ok(
    /<svg\b[^>]*class="nav-chev"[^>]*>[\s\S]*?<path d="M7 7h10v10"\/><path d="M7 17 17 7"\/>[\s\S]*?<\/svg>/.test(html),
    'nav-chev 應為 Lucide arrow-up-right 的 inline SVG(M7 7h10v10 + M7 17 17 7)'
  );
});

// ============================================================
// popup 不顯示同步狀態(使用者裁決:同步狀態列整個移除)。
//
// 健康或錯誤狀態都不在 popup 呈現，帳號與同步狀態只在設定頁的帳號區。
// popup 因此不再跟 background 要同步狀態(syncState／syncAuth)、不監聽
// sync.stateChanged，也不再有帶 #cloud-sync 錨點的專屬導向;「紀錄與設定」
// 這一列(openOptionsPage)與兩顆開關完全不受影響。
// ============================================================

function makeFakeRuntime(handlers) {
  const calls = [];
  return {
    calls,
    sendMessage(message) {
      calls.push(message);
      const handler = handlers && handlers[message.type];
      if (!handler) return Promise.resolve(undefined);
      return Promise.resolve(handler(message));
    },
  };
}

const i18n = require(path.join(__dirname, '..', 'i18n.js'));

test('無同步狀態列:popup.html 不得再有 syncStatusRow／syncStatusText 節點', () => {
  const html = readPopupHtml();

  assert.equal(/\bid\s*=\s*["']syncStatusRow["']/i.test(html), false, '同步狀態列節點應整個移除');
  assert.equal(/\bid\s*=\s*["']syncStatusText["']/i.test(html), false, '狀態列文字節點應整個移除');
  assert.equal(/cloud-sync/.test(html), false, 'popup 不再導向 options.html#cloud-sync');
});

test('無同步狀態列:popup.html 不含同步狀態文案，樣式也不留同步列專屬規則', () => {
  const html = readPopupHtml();

  assert.equal(/已同步|雲端同步/.test(html), false, 'popup 不顯示任何同步狀態文案');
  assert.equal(/sync/i.test(readPopupStyle()), false, '同步狀態列的專屬樣式應一併移除');
});

test('無同步狀態列:導航列只剩「紀錄與設定」一列', () => {
  const html = readPopupHtml();

  const navRows = html.match(/<button\b[^>]*class="[^"]*\bnav-row\b[^"]*"[^>]*>/gi) || [];
  assert.equal(navRows.length, 1, '移除同步狀態列後只剩紀錄與設定一列');
  assert.ok(/\bid\s*=\s*["']openOptions["']/i.test(navRows[0]), '留下的那一列是 openOptions');
});

test('popup 不讀同步狀態:init() 不向 background 送任何 sync.* 訊息', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument([...IDS, 'openOptions']);
  const runtime = makeFakeRuntime({});
  const controller = popup.createPopupController({ document: doc, storage: storage.sync, i18n, runtime });

  await controller.init();
  await settle();

  assert.deepEqual(runtime.calls, [], 'popup 不再跟 background 要 syncState／syncAuth');
});

test('popup 不讀同步狀態:storage 只讀兩顆開關與語言偏好', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument([...IDS, 'openOptions']);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync, i18n });

  await controller.init();
  await settle();

  const requested = [];
  for (const keys of storage.calls.get) {
    if (keys && typeof keys === 'object' && !Array.isArray(keys)) requested.push(...Object.keys(keys));
    else if (keys) requested.push(...[].concat(keys));
  }
  assert.deepEqual(
    requested.sort(),
    ['autoClean', 'langPref', 'postCopyEnabled'],
    'popup 的 storage 讀取不得含 syncState／syncAuth'
  );
});

test('popup 不讀同步狀態:模組不再匯出同步列的狀態契約，controller 不再有 setSyncState', async () => {
  const popup = loadPopup();

  assert.equal('DEFAULT_SYNC_CARD_STATE' in popup, false, '同步卡片狀態的預設值應隨狀態列一起移除');
  assert.equal('normalizeSyncCardState' in popup, false, '同步卡片狀態的正規化應隨狀態列一起移除');

  const storage = createChromeStorage({});
  const doc = createCheckboxDocument([...IDS, 'openOptions']);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync });
  await controller.init();
  await settle();

  assert.equal(typeof controller.setSyncState, 'undefined', '不再有同步狀態廣播的入口');
});

test('無同步狀態列:popup-init.js 不再接同步導向、runtime 與 stateChanged 監聽', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'popup-init.js'), 'utf8');

  assert.equal(/openCloudSyncSection/.test(src), false, '#cloud-sync 專屬導向應移除');
  assert.equal(
    /sync\.getState|sync\.stateChanged|setSyncState/.test(src),
    false,
    'popup 不再跟 background 交換同步狀態'
  );
  assert.ok(/openOptionsPage/.test(src), '「紀錄與設定」入口不受影響');
});

test('無同步狀態列:i18n 不再有 popup 同步列專用的 ppSync* 文案', () => {
  for (const locale of ['zh', 'en']) {
    const dict = i18n.STRINGS[locale];
    assert.equal('ppSyncInactive' in dict, false, `${locale} 不應再有 ppSyncInactive`);
    assert.equal('ppSyncActive' in dict, false, `${locale} 不應再有 ppSyncActive`);
  }
});
