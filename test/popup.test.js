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
// 雲端同步狀態列(車道 E，消費 docs/cloud-sync.md 第 5 節的 state
// 形狀)。popup 只讀狀態、不放登入按鈕(登入在 options 頁的雲端同步卡片
// 做)，點擊導向 options.html#cloud-sync。background 的同步引擎(車道 D)
// 尚未實作，這裡驗證的是「runtime 缺席/回應非法都優雅退回未登入態」
// 這條 UI 契約，不測真的同步行為。
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

const SYNC_IDS = [...IDS, 'openOptions', 'syncStatusRow', 'syncStatusText'];

test('雲端同步狀態列:popup.html 有 id=syncStatusRow 的 button(不是 checkbox)', () => {
  const html = readPopupHtml();
  assert.ok(
    /<button\b[^>]*\bid\s*=\s*["']syncStatusRow["']/i.test(html),
    'popup.html 應有 id=syncStatusRow 的 button'
  );
});

test('雲端同步卡片狀態:normalizeSyncCardState/DEFAULT_SYNC_CARD_STATE 命名不撞 TCLCore.normalizeSyncState(帳號同步狀態，形狀不同)；popup 不渲染 displayName/avatarUrl，但形狀仍與 options.js 的卡片狀態對齊', () => {
  const popup = loadPopup();
  assert.equal(popup.DEFAULT_SYNC_CARD_STATE.displayName, null);
  assert.equal(popup.DEFAULT_SYNC_CARD_STATE.avatarUrl, null);
  const normalized = popup.normalizeSyncCardState({
    status: 'signed_in',
    email: 'a@b.com',
    displayName: 'Ada',
    avatarUrl: 'https://lh3.googleusercontent.com/a/x',
    lastSyncedAt: 123,
    pendingCount: 4,
    lastError: null,
    apiBase: 'https://api.example/',
  });
  assert.equal(normalized.displayName, 'Ada');
  assert.equal(normalized.avatarUrl, 'https://lh3.googleusercontent.com/a/x');
  // 型別不對時個別欄位退回 null，不整包丟棄(比照既有欄位的容錯慣例，
  // 見 options.js 的 normalizeSyncCardState)。
  const badFields = popup.normalizeSyncCardState({ status: 'signed_in', displayName: 123, avatarUrl: {} });
  assert.equal(badFields.displayName, null);
  assert.equal(badFields.avatarUrl, null);
});

const i18n = require(path.join(__dirname, '..', 'i18n.js'));

test('雲端同步狀態列:未注入 runtime 時顯示「未啟用」文案', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync, i18n });

  await controller.init();
  await settle();

  assert.equal(doc.elements.syncStatusText.textContent, i18n.t('zh', 'ppSyncInactive'));
});

test('雲端同步狀態列:background 無回應(sendMessage reject)時，退回未啟用文案', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  const runtime = makeFakeRuntime({
    'sync.getState': () => Promise.reject(new Error('Could not establish connection.')),
  });
  const controller = popup.createPopupController({ document: doc, storage: storage.sync, i18n, runtime });

  await controller.init();
  await settle();

  assert.equal(doc.elements.syncStatusText.textContent, i18n.t('zh', 'ppSyncInactive'));
});

test('雲端同步狀態列:已登入時顯示「已同步 · 相對時間」', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  const NOW = 1000000;
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      lastSyncedAt: NOW - 2 * 60 * 1000, // 2 分鐘前
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    i18n,
    runtime,
    now: () => NOW,
  });

  await controller.init();
  await settle();

  assert.equal(
    doc.elements.syncStatusText.textContent,
    i18n.fmt('zh', 'ppSyncActive', { t: i18n.fmt('zh', 'opRelMin', { n: 2 }) })
  );
});

test('雲端同步狀態列:點擊呼叫 openCloudSyncSection(帶 #cloud-sync 錨點的導向)，不呼叫一般 openOptionsPage', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  let cloudOpened = 0;
  let optionsOpened = 0;
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    i18n,
    openOptionsPage: () => {
      optionsOpened++;
    },
    openCloudSyncSection: () => {
      cloudOpened++;
    },
  });

  await controller.init();
  await settle();

  doc.elements.syncStatusRow.fire('click');
  assert.equal(cloudOpened, 1, '應呼叫專屬的雲端同步導向函式');
  assert.equal(optionsOpened, 0, '不應誤呼叫一般 openOptionsPage(兩者是不同 dep)');
});

test('雲端同步狀態列:未注入 openCloudSyncSection 時，退回一般 openOptionsPage(至少能到 options 頁)', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  let optionsOpened = 0;
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    i18n,
    openOptionsPage: () => {
      optionsOpened++;
    },
  });

  await controller.init();
  await settle();

  doc.elements.syncStatusRow.fire('click');
  assert.equal(optionsOpened, 1);
});

test('雲端同步狀態列:setSyncState(接線層轉呼叫 background 的 sync.stateChanged 廣播)即時更新文案', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync, i18n, now: () => 1000000 });

  await controller.init();
  await settle();
  assert.equal(doc.elements.syncStatusText.textContent, i18n.t('zh', 'ppSyncInactive'), '前置:未注入 runtime，預設未登入');

  controller.setSyncState({
    status: 'signed_in',
    email: 'broadcast@example.com',
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  });

  assert.equal(
    doc.elements.syncStatusText.textContent,
    i18n.fmt('zh', 'ppSyncActive', { t: i18n.t('zh', 'opSyncNever') })
  );

  // 廣播非法形狀時應退回未啟用文案，不因 background 傳壞資料而炸掉畫面。
  controller.setSyncState({ status: 'nonsense' });
  assert.equal(doc.elements.syncStatusText.textContent, i18n.t('zh', 'ppSyncInactive'));
});

// ============================================================================
// L8 — 沒有帳號資訊就是「未啟用」，不論 status
// ============================================================================
//
// 調查報告的最後一格:登入失敗後引擎送來 status='error'(舊行為)，popup 的
// 狀態列只認 'signed_out'，於是走到「已同步 · …」那條分支，對一個根本沒登入
// 的使用者顯示「已同步」。判準改成看有沒有帳號:沒有 email 也沒有 displayName
// 就沒有帳號可同步，這比 status 更難被上游的形狀走樣騙過(縱深)。

const PP_NOW = 1000000;

function makeSyncRowCtx() {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    i18n,
    now: () => PP_NOW,
  });
  return { popup, doc, controller };
}

test('L8 雲端同步狀態列:沒有 email／displayName 時一律顯示未啟用，不論 status', async () => {
  const ctx = makeSyncRowCtx();
  await ctx.controller.init();
  await settle();

  for (const status of ['signed_in', 'syncing', 'error', 'signed_out']) {
    ctx.controller.setSyncState({
      status,
      email: null,
      displayName: null,
      avatarUrl: null,
      // 上一位使用者留下的時間戳:沒有帳號時它不代表任何東西，更不該被
      // 拿去組「已同步 · 2 分鐘前」。
      lastSyncedAt: PP_NOW - 2 * 60 * 1000,
      pendingCount: 0,
      lastError: status === 'error' ? 'sign_in_failed' : null,
      apiBase: '',
    });

    assert.equal(
      ctx.doc.elements.syncStatusText.textContent,
      i18n.t('zh', 'ppSyncInactive'),
      `status=${status} 但沒有帳號資訊，不得顯示「已同步」`
    );
  }
});

test('L8 雲端同步狀態列:登入失敗(sync.getState 回 error 且無帳號)時顯示未啟用', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ langPref: 'zh' });
  const doc = createCheckboxDocument(SYNC_IDS);
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'error',
      email: null,
      displayName: null,
      lastSyncedAt: PP_NOW - 60 * 1000,
      pendingCount: 0,
      lastError: 'sign_in_failed',
      apiBase: '',
    }),
  });
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    i18n,
    runtime,
    now: () => PP_NOW,
  });

  await controller.init();
  await settle();

  assert.equal(doc.elements.syncStatusText.textContent, i18n.t('zh', 'ppSyncInactive'));
});

test('L8 雲端同步狀態列:有帳號時仍照常顯示「已同步 · 相對時間」(不得誤殺)', async () => {
  const ctx = makeSyncRowCtx();
  await ctx.controller.init();
  await settle();

  // displayName 單獨存在也算有帳號(後端沒回 email 的邊角情況)。
  for (const identity of [{ email: 'user@example.com', displayName: null }, { email: null, displayName: 'Hong' }]) {
    ctx.controller.setSyncState(
      Object.assign(
        {
          status: 'signed_in',
          avatarUrl: null,
          lastSyncedAt: PP_NOW - 2 * 60 * 1000,
          pendingCount: 0,
          lastError: null,
          apiBase: '',
        },
        identity
      )
    );

    assert.equal(
      ctx.doc.elements.syncStatusText.textContent,
      i18n.fmt('zh', 'ppSyncActive', { t: i18n.fmt('zh', 'opRelMin', { n: 2 }) })
    );
  }
});
