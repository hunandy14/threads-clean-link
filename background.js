// background.js — service worker 的進入點與接線。本體只負責：載入其餘 SW
// 腳本、onInstalled（右鍵選單、既開分頁重注入、紀錄遷移、舊鍵清理）、右鍵
// 選單與語言切換、訊息寄件者判準、雲端同步引擎接線與 alarm、runtime.onMessage
// 路由表、右鍵路徑的點擊流程，以及剪貼簿寫入與系統通知。
//
// 各功能的本體分散在以下 classic script，全部由本檔頂端依序 importScripts：
//   sw-history.js  紀錄寫入、合併、遷移，與 storage.local 唯一的讀改寫佇列
//   sw-device.js   本機裝置身分與裝置管理訊息
//   sw-og.js       短碼解析與貼文頁 og 資訊擷取、快取
//   sw-scam.js     投資詐騙警示名單的寫入與匿名取作者 id
// classic script 之間共用同一個全域詞法環境：頂層名稱整個 SW 必須唯一，任何
// 檔案的頂層程式只能讀先載入檔案宣告的名稱（後載檔案的名稱只准在函式內引用）。
'use strict';

// 共用 i18n 模組:SW 環境用 importScripts 載入;測試 sandbox 由測試端先把
// i18n.js 原始碼載進同一個 sandbox(TCLI18N 已存在)，此條件式便不執行。
if (typeof TCLI18N === 'undefined' && typeof importScripts === 'function') {
  importScripts('i18n.js');
}

// 共用核心 lib(網址樣式、欄位消毒、常數):SW 環境用 importScripts 載入;
// 測試 sandbox 由測試端先把 tcl-core.js 原始碼載進同一個 sandbox(TCLCore
// 已存在)，此條件式便不執行。SHARE_URL_PATTERN、乾淨貼文網址的權威判定
// (isCleanPostUrl)、sanitize 各函式、長度上限與預設值一律走 TCLCore，不在
// SW 各檔養鏡像:background 與 options 共用單一權威，漂移一處即分裂。
if (typeof TCLCore === 'undefined' && typeof importScripts === 'function') {
  importScripts('tcl-core.js');
}

// Google 登入模組(雲端同步):SW 環境用 importScripts 載入;測試 sandbox 由
// 測試端自行載入(TCLAuth 已存在)，此條件式便不執行。
if (typeof TCLAuth === 'undefined' && typeof importScripts === 'function') {
  importScripts('auth.js');
}

// 雲端同步引擎:同上。sync.js 依賴 tcl-core.js 與 auth.js，載入順序不可顛倒。
if (typeof TCLSync === 'undefined' && typeof importScripts === 'function') {
  importScripts('sync.js');
}

// SW 功能本體。每支一個單參數的 importScripts 呼叫(tools/manifest-files.mjs 與打包
// 測試的推導只認這個寫法)，順序即相依順序:sw-history 建立 storageQueue／
// mutate，sw-device 排進同一條佇列，sw-scam 用 sw-og 的 og 抓取常數與
// sw-device 的 readLocalDeviceId。測試沙箱沒有 importScripts，由測試端依同
// 一順序逐檔載入。
if (typeof importScripts === 'function') {
  importScripts('sw-history.js');
}
if (typeof importScripts === 'function') {
  importScripts('sw-device.js');
}
if (typeof importScripts === 'function') {
  importScripts('sw-og.js');
}
if (typeof importScripts === 'function') {
  importScripts('sw-scam.js');
}

const CONTEXT_MENU_ID = 'threads-clean-link-resolve';
const NOTIFICATION_ICON = 'icons/icon128.png';

// 事件監聽器一律註冊在檔案最外層：service worker 閒置會被終止，
// 監聽器需在每次喚醒時同步掛回去，不能包在非同步流程裡面。

chrome.runtime.onInstalled.addListener(() => {
  createContextMenu().catch((err) => {
    console.error('[threads-clean-link] 建立右鍵選單失敗', err);
  });
  // 重注入不分安裝原因(install/update/chrome_update)一律執行:首裝情境下
  // 既開的 threads 分頁本來就沒有任何 content script，這一次重注入等同
  // 「首次注入」，讓 icon/strip 兩條路徑不必重整就能用。唯一補不回來的是
  // share 攔截——clipboard-guard.js 走 MAIN world 且刻意不重注入(理由見
  // 下方註解)，老分頁的複製攔截仍需使用者自行重整才生效。行為與更新情境
  // 完全相同，不需要依 details.reason 分流。
  reinjectIntoOpenTabs().catch((err) => {
    console.warn('[threads-clean-link] 既開分頁的自癒重注入失敗', err);
  });
  // 紀錄整平成永久合併形狀的一次性遷移(見 migrateHistoryMerge)。同樣不分
  // 安裝原因一律執行:首裝時紀錄是空的、已整平過的資料再跑一次也不會有任
  // 何變化(冪等且不寫回)，用 details.reason 分流只會多一個會過時的假設。
  // 函式內部已接住所有錯誤(遷移失敗不影響任何主功能)，此處不需再補 catch。
  //
  // 【順序】merge 必須先於 schema:mergeHistoryGroup 整平多張卡時會重建物
  // 件，schema 先補的欄位會在整平後缺一角;先整平再補齊，整平後的卡片才帶
  // 得齊七個雲端欄位。兩支都排在同一條 storageQueue 上，串行執行。
  migrateHistoryMerge();
  migrateHistorySchema();
  removeLegacyGuardKeys();
});

// 舊版的兩把自清守衛鍵(D19／D41 舊語意)。清空水位線已由 D50 廢除，這兩把
// 鍵不再讀寫，這裡在 onInstalled 把舊版殘留清一次。
const LEGACY_GUARD_KEYS = ['syncClearGuard', 'syncMarksClearGuard'];

/**
 * 移除舊版殘留的守衛鍵。盡力而為:remove 缺席或失敗都只記 warn，不影響其他
 * onInstalled 工作;鍵本來就不存在時 remove 什麼也不做。
 */
function removeLegacyGuardKeys() {
  const local = chrome.storage && chrome.storage.local;
  if (!local || typeof local.remove !== 'function') return;
  try {
    Promise.resolve(local.remove(LEGACY_GUARD_KEYS)).catch((err) => {
      console.warn('[threads-clean-link] 移除舊版守衛鍵失敗', err);
    });
  } catch (err) {
    console.warn('[threads-clean-link] 移除舊版守衛鍵失敗', err);
  }
}

// ------------------------------------------------------------
// 擴充功能安裝/更新後的自癒重注入
// ------------------------------------------------------------
//
// 【問題】擴充功能更新(或開發時重載)後，Chrome 不會把已注入既開分頁的
// content script 移除，它們照樣在跑，但與擴充功能之間的連線已被切斷:
// chrome.runtime.id 變成 undefined，任何 sendMessage 都同步丟出「Extension
// context invalidated」。使用者看到的是「按鈕都在、複製也成功，但紀錄全部
// 靜默丟失」，而且非重新整理不能復原——沒人會知道要重新整理。
//
// 【解法】更新完成的當下，對每個既開的 threads 分頁重新注入 manifest 裡
// 全部的 ISOLATED world content script，讓分頁立刻換上帶有效
// chrome.runtime 的新實例。所需權限(scripting + threads 的
// host_permissions)全部既有，不新增任何權限。
//
// 【新舊實例交接】舊實例留在已失效的舊 ISOLATED world，新實例跑在新
// world，兩者只共用 DOM。新實例啟動時在 document 上派送交棒事件，舊實例
// 收到後自我退場(斷 observer、清計時器、收掉自己插入的節點);舊實例在
// 下一次要碰 chrome.runtime／chrome.storage 前也會先判活，發現自己是孤兒
// 就退場。兩層任一層生效，頁面上都只剩新實例在運作。
//
// 【MAIN world 的 clipboard-guard.js 不重注入】它是純頁面層的
// navigator.clipboard.writeText／copy 事件包裹，完全不碰 chrome.* API，擴
// 充功能重載不會讓它失效;它 postMessage 出來的 TCL_RESOLVE_REQ／
// TCL_CLEANED_NOTICE 由監聽 window message 的 bridge.js 接手，而 bridge 會
// 隨本清單重注入，整條管道因此自動接回來。反過來重注入 guard 才有害:舊
// 包裹還在，writeText 會被包第二層，一次複製可能觸發兩次淨化/兩次通知。
const REINJECT_MATCHES = ['https://*.threads.com/*', 'https://*.threads.net/*'];

// 重注入的檔案與順序等於 manifest.json content_scripts 裡 ISOLATED world
// 的 document_start 那組接 document_idle 那組:bridge.js(window message 橋
// 接)、i18n.js(文案來源)、tcl-core.js(scam-guard 的判定核心)、
// post-icon.js、scam-guard.js。後面的腳本依賴前面掛上的全域，少一支或順
// 序顛倒都會讓新實例缺件。
const REINJECT_FILES = ['bridge.js', 'i18n.js', 'tcl-core.js', 'post-icon.js', 'scam-guard.js'];

// 分頁 URL 的自我把關:tabs.query 的 url 篩選已經先擋一層，這裡再依同一組
// 主機規則過濾一次，確保就算查詢條件被忽略(不同瀏覽器版本對 url 篩選的
// 權限要求不一致)也不會把腳本注進非 threads 的分頁。對齊 manifest 的
// `https://*.threads.com/*`:主網域本身與任何子網域都算，其他 TLD 不算。
const THREADS_PAGE_PATTERN = /^https:\/\/([A-Za-z0-9-]+\.)*threads\.(com|net)(\/|$)/i;

function isThreadsPageUrl(url) {
  return typeof url === 'string' && THREADS_PAGE_PATTERN.test(url);
}

async function reinjectIntoOpenTabs() {
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function') return;
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: REINJECT_MATCHES });
  } catch (err) {
    console.warn('[threads-clean-link] 查詢既開分頁失敗，略過自癒重注入', err);
    return;
  }

  const targets = (tabs || []).filter(
    (tab) => tab && tab.id !== undefined && tab.id !== chrome.tabs.TAB_ID_NONE && isThreadsPageUrl(tab.url)
  );

  // 逐分頁獨立容錯:分頁可能已被凍結/丟棄、正在導向他站、或是 Chrome 不允
  // 許注入的狀態。一個分頁失敗不影響其他分頁，也不讓 onInstalled 變成未捕
  // 捉的 rejection——自癒是盡力而為，失敗最多退回「使用者自己重新整理」。
  await Promise.all(
    targets.map(async (tab) => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: REINJECT_FILES,
          world: 'ISOLATED',
        });
      } catch (err) {
        console.warn('[threads-clean-link] 分頁自癒重注入失敗(分頁 id:' + tab.id + ')', err);
      }
    })
  );
}

// 先清空舊選單再建立，避免重新安裝/更新時 id 重複觸發 lastError 雜訊。
// removeAll 失敗也不該擋住後續建立選單，故在此就地接住、只記錄不中斷。
async function createContextMenu() {
  try {
    await chrome.contextMenus.removeAll();
  } catch (err) {
    console.error('[threads-clean-link] 清除舊選單失敗', err);
  }

  const locale = await getLocale();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: TCLI18N.t(locale, 'bgMenuTitle'),
    contexts: ['link'],
    targetUrlPatterns: [
      'https://*.threads.com/share/*',
      'https://*.threads.net/share/*',
    ],
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // onClicked 的回呼是同步事件簽章，這裡用 .catch 包住整段非同步流程，
  // 確保任何錯誤都被攔截，不會變成未捕捉的 Promise rejection。
  handleShareLinkClick(info, tab).catch((err) => {
    console.error('[threads-clean-link] 未預期的錯誤', err);
    notifyByKey('threads-clean-link-unexpected', 'bgUnexpected');
  });
});

// 使用者在 options 頁切換語言時，同步右鍵選單標題(選單標題在建立時就
// 固定了，不會自己跟著語言變)。監聽器掛最外層，SW 喚醒時重新掛回。
if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes || !changes.langPref) return;
    if (!chrome.contextMenus || typeof chrome.contextMenus.update !== 'function') return;
    const locale = TCLI18N.resolveLocale(changes.langPref.newValue);
    try {
      // MV3 下不帶 callback 呼叫 update() 會回傳 Promise：同步 try/catch
      // 接不到非同步 rejection，比照 safeNotify(見檔尾)的 ?.catch() 模式，
      // 對回傳值另外補一次 .catch，兩者都只記錄、不外拋。
      const updating = chrome.contextMenus.update(CONTEXT_MENU_ID, { title: TCLI18N.t(locale, 'bgMenuTitle') });
      updating?.catch((err) => {
        console.error('[threads-clean-link] 更新右鍵選單標題失敗(非同步)', err);
      });
    } catch (err) {
      console.error('[threads-clean-link] 更新右鍵選單標題失敗', err);
    }
  });
}

// 訊息是否來自本擴充自己（content script 或擴充頁面皆可）。只看 sender.id
// ——content script 的 sender.url 是它所在網頁的網址，比對擴充前綴會把
// clipboard-guard 這條正常路徑整條擋掉。跨擴充訊息走的是 onMessageExternal，
// 進不了 runtime.onMessage；沒宣告 externally_connectable 時網頁也送不進來，因此
// sender.id 不等於自己就是不該回應的來源。
// 需要更嚴的判準（只准擴充自己的頁面）時用 isExtensionPageSender，見下方。
function isOwnExtensionSender(sender) {
  if (!sender) return false;
  const selfId = chrome.runtime && chrome.runtime.id;
  return typeof selfId === 'string' && selfId !== '' && sender.id === selfId;
}

// ------------------------------------------------------------
// 雲端同步接線(docs/cloud-sync.md 第 5 節)
// ------------------------------------------------------------
//
// 引擎本體在 sync.js，依賴全部由這裡注入:SW 隨時被殺，引擎不能自己抓全域
// chrome/fetch/Date，否則沒有任何辦法在 node 測試裡跑完整往返。
//
// storage.local 的讀改寫一律排進 storageQueue(定義於 sw-history.js):引擎、
// recordHistory、兩支遷移、警示名單與裝置身分共用同一條序列佇列，才不會互
// 相覆蓋 read-modify-write。

// 認證模組:SW 內由 importScripts 保證存在，測試沙箱可能只載了 background
// 本身，因此以 typeof 取值不讓接線在載入當下就丟 ReferenceError。
const syncAuthApi = typeof TCLAuth !== 'undefined' ? TCLAuth : null;

// 引擎只在依賴齊備時建立:sync.js 與 chrome.alarms 缺一(舊環境、未宣告
// alarms 權限、測試沙箱只測其他功能)就整組同步功能靜默停用，不影響主功能。
const syncEngine =
  typeof TCLSync !== 'undefined' && typeof TCLSync.create === 'function' && chrome.alarms
    ? TCLSync.create({
        storage: { local: storageAreaAdapter('local') },
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        alarms: {
          create: (name, info) => chrome.alarms.create(name, info),
          clear: (name) => Promise.resolve(chrome.alarms.clear(name)),
        },
        // 廣播給 options/popup。沒有任何頁面開著時 sendMessage 會 reject，
        // 那是常態不是錯誤，安靜吞掉。
        broadcast: (message) => {
          try {
            const result = chrome.runtime.sendMessage(message);
            if (result && typeof result.catch === 'function') result.catch(() => {});
          } catch (err) {
            // 無人接聽，忽略。
          }
        },
        auth: syncAuthApi,
        permissions: { contains: (descriptor) => syncAuthApi.containsPermissions(descriptor) },
        randomUUID: () => TCLCore.randomUuid(),
        // 本機裝置身分(§12):引擎組請求的 device 區塊與 currentDeviceId 都取
        // 自這裡，身分的產生與存放一律留在 background。
        getLocalDevice: () => getLocalDevice(),
        writeChain: storageQueue,
        // 拉取是唯一會把 history 變長的寫入路徑，套的是與 recordHistory 同一
        // 份容量上限(位元組軟預算＋筆數硬保險，優先淘汰墓碑)。
        capHistory: (list) => TCLCore.capHistory(list),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle),
        // 每個後端請求的逾時 signal(涵蓋到讀完回應本文)。
        timeoutSignal: (ms) => AbortSignal.timeout(ms),
        // 擴充功能版本，引擎據此帶 X-Client-Version 標頭。沒有 getManifest 的
        // 環境(部分測試沙箱)給空字串，引擎就不帶這個標頭。
        clientVersion: typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest().version : '',
      })
    : null;

// 訊息是否來自本擴充自己的頁面(options／popup)。
// 不能用 `!sender.tab` 當條件:manifest 的 options_ui.open_in_tab 為 true，設定頁
// 本身就是一個分頁，sender.tab 存在，五個 sync.* 會全被擋掉。改看 sender.url 前綴
// ——content script 的 sender.url 是它所在網頁的網址(https://www.threads.com/...)，
// 其他擴充走的是 onMessageExternal 進不了 runtime.onMessage，兩者都構不出
// chrome-extension://<自己的 id>/ 這個前綴。
// 本判準假設 manifest 沒有 web_accessible_resources 與 externally_connectable；
// 若日後新增 WAR，被網頁 iframe 的 WAR 頁面也會帶本擴充前綴，需回頭把判準收窄成
// 具名頁面(options.html／popup.html)或改用 sender.origin。
function isExtensionPageSender(sender) {
  if (!isOwnExtensionSender(sender)) return false;
  const selfId = chrome.runtime.id;
  return typeof sender.url === 'string' && sender.url.indexOf('chrome-extension://' + selfId + '/') === 0;
}

// 週期同步與去抖保底的 alarm 都轉進引擎，由它自己分辨名稱(D12)。
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!syncEngine) return;
    Promise.resolve(syncEngine.onAlarm(alarm)).catch((err) => {
      console.error('[threads-clean-link] 同步 alarm 處理失敗', err);
    });
  });
}

// SW 每次啟動驗一次 token:用 get-session 主動確認，不必等 /api/v1/* 打回
// 401 才發現失效(計劃第 3 節補充第 11 點)。
if (syncEngine) {
  Promise.resolve(syncEngine.verifySession()).catch((err) => {
    console.warn('[threads-clean-link] 啟動驗證同步工作階段失敗', err);
  });
}

// ------------------------------------------------------------
// 投資詐騙警示名單的寄件者判準(handler 本體見 sw-scam.js)
// ------------------------------------------------------------

// scam.hit 的合法來源：threads 網頁的 content script。判準是 sender.tab 存
// 在（擴充頁面沒有 tab）且 sender.url 落在 threads 來源——content script 的
// sender.url 是它所在網頁的網址。擴充自己的頁面與其他擴充一律不得借這條
// 入口寫黑名單，remove／restore 反過來只認 isExtensionPageSender。
const SCAM_PAGE_ORIGINS = [
  'https://www.threads.com/',
  'https://threads.com/',
  'https://www.threads.net/',
  'https://threads.net/',
];

function isScamContentScriptSender(sender) {
  if (!isOwnExtensionSender(sender) || !sender.tab) return false;
  if (typeof sender.url !== 'string') return false;
  for (let i = 0; i < SCAM_PAGE_ORIGINS.length; i++) {
    if (sender.url.indexOf(SCAM_PAGE_ORIGINS[i]) === 0) return true;
  }
  return false;
}

// ------------------------------------------------------------
// runtime.onMessage 路由表
// ------------------------------------------------------------
//
// 本擴充收的所有 runtime 訊息都在這張表。每條路由:
//   allow(sender)  寄件者判準，不過就不回應、不執行。
//   engine         true 表示需要同步引擎；引擎未建立時視同不認得這則訊息。
//   noReply        true 表示背景執行、不回應，例外只記 log。
//   run(message, engine)  回傳值(可為 Promise)原樣交給 sendResponse。
//   onError()      run 拋錯或 reject 時改回的內容，各路由沿用自己的失敗形狀。
//
// 寄件者判準分三級:isOwnExtensionSender(本擴充任何來源，含 content script)、
// isExtensionPageSender(只准 options／popup 等擴充頁)、isScamContentScriptSender
// (只准 threads 分頁上的 content script)。登入態、雲端資料與警示名單的使用者
// 操作屬敏感面，一律走擴充頁判準。
const ROUTES = {
  // clipboard-guard.js 經 bridge.js 送來的短碼解析請求。本路徑不寫剪貼簿、
  // 不發通知，只負責解析並回傳結果；失敗一律回 ok:false，由呼叫端自行決定
  // 要不要用原始短碼放行。
  resolveShare: {
    allow: isOwnExtensionSender,
    run: (message) => handleResolveShareMessage(message),
    onError: () => ({ ok: false, reason: 'internal-error' }),
  },
  // clipboard-guard.js 實際把淨化後內容寫入剪貼簿後送來的通知——紀錄的其中
  // 一條入筆路徑，收到合法通知就無條件記錄。紀錄是使用者資料，不接受本擴充
  // 以外的來源寫入。
  cleanedNotice: {
    allow: isOwnExtensionSender,
    noReply: true,
    run: (message) => handleCleanedNotice(message),
  },
  // options/popup → background 的同步訊息。引擎結果原樣透出，失敗碼是 UI
  // 分流的依據；例外時回 undefined。
  'sync.getState': syncRoute((engine) => engine.getState()),
  'sync.signIn': syncRoute((engine) => engine.signIn()),
  'sync.signOut': syncRoute((engine) => engine.signOut()),
  'sync.now': syncRoute((engine) => engine.syncNow()),
  'sync.deleteCloud': syncRoute((engine) => engine.deleteCloud()),
  'sync.devices.list': syncRoute((engine, message) => handleDevicesList(engine, message)),
  'sync.devices.rename': syncRoute((engine, message) => handleDevicesRename(engine, message)),
  'sync.devices.remove': syncRoute((engine, message) => handleDevicesRemove(engine, message)),
  // threads 分頁上的詐騙偵測命中回報。
  'scam.hit': {
    allow: isScamContentScriptSender,
    run: (message) => handleScamHit(message),
    onError: scamInternalError,
  },
  // 選項頁的解除／復原。網頁端不得借道動名單。
  'scam.blocklist.remove': {
    allow: isExtensionPageSender,
    run: (message) => handleScamBlocklistRemove(message),
    onError: scamInternalError,
  },
  'scam.blocklist.restore': {
    allow: isExtensionPageSender,
    run: (message) => handleScamBlocklistRestore(message),
    onError: scamInternalError,
  },
};

// 同步路由的共同外殼:只准擴充頁、需要引擎、例外回 undefined。handler 以
// (engine, message) 取參，與 handleDevices* 的簽名一致。
function syncRoute(handler) {
  return {
    allow: isExtensionPageSender,
    engine: true,
    run: (message, engine) => handler(engine, message),
    onError: () => undefined,
  };
}

function scamInternalError() {
  return { ok: false, code: 'internal_error' };
}

// 路由查找只認 ROUTES 自有鍵:'constructor'、'__proto__' 這類原型上的名字
// 不得命中。未知類型、寄件者被拒、需要引擎卻沒有引擎，一律回 false——不回應、
// 不佔用 sendResponse 通道。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (typeof type !== 'string' || !Object.hasOwn(ROUTES, type)) return false;
  const route = ROUTES[type];
  if (!route.allow(sender) || (route.engine && !syncEngine)) return false;

  let pending;
  try {
    pending = Promise.resolve(route.run(message, syncEngine));
  } catch (err) {
    pending = Promise.reject(err);
  }

  if (route.noReply) {
    pending.catch((err) => {
      console.error(`[threads-clean-link] ${type} 處理失敗`, err);
    });
    return false;
  }

  pending.then(sendResponse).catch((err) => {
    console.error(`[threads-clean-link] ${type} 處理失敗`, err);
    sendResponse(route.onError());
  });
  return true; // 非同步回應，保持訊息通道開啟直到 sendResponse 被呼叫。
});

// 核心流程

async function handleShareLinkClick(info, tab) {
  const shareUrl = info.linkUrl;

  if (!shareUrl || !TCLCore.SHARE_URL_PATTERN.test(shareUrl)) {
    notifyByKey('threads-clean-link-invalid', 'bgInvalid');
    return;
  }

  let finalUrl, ogFields;
  try {
    const resolved = await resolveFinalUrl(shareUrl);
    finalUrl = resolved.finalUrl;
    ogFields = resolved.ogFields;
  } catch (err) {
    console.error('[threads-clean-link] 解析短連結失敗', err);
    notifyByKey('threads-clean-link-network-error', 'bgNetworkError');
    return;
  }

  const cleanUrl = extractCleanPostUrl(finalUrl);
  if (!cleanUrl) {
    notifyByKey('threads-clean-link-format-error', 'bgFormatError');
    return;
  }

  if (!tab || tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) {
    notifyByKey('threads-clean-link-no-tab', 'bgNoTab', { url: cleanUrl });
    return;
  }

  try {
    await writeToClipboard(tab.id, cleanUrl);
  } catch (err) {
    console.error('[threads-clean-link] 寫入剪貼簿失敗', err);
    notifyByKey('threads-clean-link-clipboard-error', 'bgClipboardError', { url: cleanUrl });
    return;
  }

  // 只有實際寫入剪貼簿成功才留紀錄，與自動路徑的「寫入成功才記錄」語意
  // 一致;saveHistory 的把關在 recordHistory 內。右鍵路徑不經 guard/
  // bridge，original(shareUrl)與 removedParams(finalUrl 與 cleanUrl 的
  // 差集)background 自己手上就有。
  //
  // 寫入前用全 repo 單一權威的 TCLCore.isCleanPostUrl 錨定驗一次(見 sw-og.js
  // 的 CLEAN_POST_URL_PATTERN 註解:extractCleanPostUrl 用的樣式刻意寬鬆，寬
  // 鬆匹配到的內容不該不經檢查就流進 history);不符合就只略過記錄
  // (console.warn)，不影響已經完成的剪貼簿複製。
  if (TCLCore.isCleanPostUrl(cleanUrl)) {
    // menu 路徑把手上的 original(使用者右鍵點擊的短碼)與 removedParams
    // (finalUrl 淨化前後的查詢參數差集)組成與 cleanedNotice 同形的訊息物件，
    // 連同 resolveFinalUrl 同一 response 順手擷取到的 ogFields，一起餵給共用的
    // extractHistoryExtraFields。menu 不經 guard/bridge，沒有 DOM 擷取的
    // author/handle/excerpt，那三個鍵在訊息裡缺席，og 是這條路徑唯一的
    // 人名/摘要來源(merge 規則等同「og 有什麼就收下什麼」)。
    const menuMessage = {
      original: shareUrl,
      removedParams: diffRemovedParams(finalUrl, cleanUrl),
    };
    await recordHistory(cleanUrl, 'menu', extractHistoryExtraFields(menuMessage, cleanUrl, ogFields));
  } else {
    console.warn(
      '[threads-clean-link] 右鍵路徑解析出的網址不符嚴格白名單樣式，略過記錄(不影響已複製到剪貼簿的內容)',
      cleanUrl
    );
  }
}

// SW 沒有 DOM，寫剪貼簿要注入分頁執行；注入的函式內部自行 try/catch
// 並回傳 { ok, reason }，因為 writeText 失敗(如分頁未聚焦)不會讓
// executeScript 本身 reject，呼叫端要靠回傳值判斷是否該 throw。
async function writeToClipboard(tabId, text) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String((e && e.name) || e) };
      }
    },
    args: [text],
  });

  const result = injection && injection.result;
  if (!result || !result.ok) {
    throw new Error('剪貼簿寫入失敗:' + (result ? result.reason : '注入無回傳'));
  }
}

// 讀取語言偏好並解析成 'zh' | 'en'。防禦與容錯策略同 getSettings:
// storage 缺席或讀取失敗都退回環境偵測(chrome.i18n → navigator)。
async function getLocale() {
  if (!chrome.storage || !chrome.storage.sync || typeof chrome.storage.sync.get !== 'function') {
    return TCLI18N.resolveLocale(null);
  }
  try {
    const stored = await chrome.storage.sync.get({ langPref: null });
    return TCLI18N.resolveLocale(stored ? stored.langPref : null);
  } catch (err) {
    console.error('[threads-clean-link] 讀取語言設定失敗，改用預設語言', err);
    return TCLI18N.resolveLocale(null);
  }
}

// 以字典 key 發通知:每次事件重新解析語言(SW 會休眠，不快取)，組好字串
// 再交給 safeNotify。整段盡力而為，語言解析失敗只記錄、不影響呼叫端。
function notifyByKey(id, key, vars) {
  getLocale()
    .then((locale) => {
      safeNotify(id, TCLI18N.fmt(locale, key, vars || {}), TCLI18N.t(locale, 'bgNotifTitle'));
    })
    .catch((err) => {
      console.error('[threads-clean-link] 通知語言解析失敗', err);
    });
}

// 統一顯示通知，自身出錯不影響呼叫端流程。create() 未帶 callback 時
// 回傳 Promise，同步 try/catch 接不到非同步 rejection，因此另外對
// 回傳值補一次 .catch，兩者都只記錄、不外拋。
function safeNotify(id, message, title) {
  try {
    const creating = chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title: title || 'Threads Clean Link',
      message,
    });
    creating?.catch((err) => {
      console.error('[threads-clean-link] 建立通知失敗(非同步)', err);
    });
  } catch (err) {
    console.error('[threads-clean-link] 建立通知失敗', err);
  }
}
