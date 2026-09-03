// background.js — service worker:解析右鍵選單的分享短連結，並回應
// clipboard-guard.js 經 bridge.js 送來的短碼解析請求。
'use strict';

// 共用 i18n 模組:SW 環境用 importScripts 載入;測試 sandbox 由測試端先把
// i18n.js 原始碼載進同一個 sandbox(TCLI18N 已存在)，此條件式便不執行。
if (typeof TCLI18N === 'undefined' && typeof importScripts === 'function') {
  importScripts('i18n.js');
}

// 共用核心 lib(網址樣式、欄位消毒、常數):SW 環境用 importScripts 載入;
// 測試 sandbox 由測試端先把 tcl-core.js 原始碼載進同一個 sandbox(TCLCore
// 已存在)，此條件式便不執行。SHARE_URL_PATTERN、乾淨貼文網址的權威判定
// (isCleanPostUrl)、sanitize 各函式、長度上限與預設值一律走 TCLCore，不再
// 於本檔養一份鏡像(原本 background 與 options 各養一份，漂移一處即分裂)。
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

// 乾淨貼文網址格式，例如：https://www.threads.com/@username/post/AbCd123EfGh
// 刻意不錨定收尾：extractCleanPostUrl 仰賴它能從帶 query/hash 的轉址結果
// 「截」出前段乾淨網址，加上 $ 會讓截取失效。
const CLEAN_POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[^/?#]+\/post\/[^/?#]+/i;

// 全 repo 單一權威的乾淨貼文網址驗證走 TCLCore.isCleanPostUrl(錨定整串、
// 白名單字元類 + 長度上限)，與 options 讀取端共用同一份。cleanedNotice(見
// handleCleanedNotice)與 menu 路徑寫入 history 前(見 handleShareLinkClick)
// 都過同一份權威驗證——extractCleanPostUrl 用的 CLEAN_POST_URL_PATTERN 刻意
// 寬鬆(不錨定收尾)，寬鬆匹配到的內容不能不經 isCleanPostUrl 就直接流進 history。

const CONTEXT_MENU_ID = 'threads-clean-link-resolve';
const NOTIFICATION_ICON = 'icons/icon128.png';

// notifySuccess(成功類通知)不存在——紀錄是唯一資料集，cleanedNotice
// 收到就無條件記錄，沒有「要不要顯示成功通知」這道關卡。失敗／錯誤類
// 通知不受影響，永遠觸發(右鍵選單路徑維持系統通知；share/strip 自動
// 路徑改頁內 toast，見 bridge.js／post-icon.js)。saveHistory(只有
// background 記錄時把關，guard/bridge 不下放)與 autoClean 的預設值須
// 與 popup.js／bridge.js／clipboard-guard.js 同步。
// 預設值取自 TCLCore.DEFAULT_SETTINGS(全量三鍵的單一權威),background 只挑
// 自己把關的兩顆(autoClean/saveHistory;postCopyEnabled 是 popup/post-icon 的
// 事，background 不讀)。
const DEFAULT_SETTINGS = {
  autoClean: TCLCore.DEFAULT_SETTINGS.autoClean,
  saveHistory: TCLCore.DEFAULT_SETTINGS.saveHistory,
};

// 紀錄:存 chrome.storage.local(sync 的 100KB 總額與寫入配額撐不起
// 紀錄量），新到舊排列。上限由位元組軟預算 + 筆數硬保險把關(見
// capHistoryForStorage / STORAGE_SOFT_BUDGET / HISTORY_MAX_ENTRIES)，平時
// 就不長到撞配額;萬一仍寫入超限，再走 recordHistory 的 isQuotaExceededError
// 優雅降級(不重試、不丟例外，只 console.warn，不影響複製/淨化等主功能)。
const HISTORY_KEY = 'history';

// 選填欄位長度上限(author/handle/excerpt/original)、removedParams 筆數與
// 單筆 key/value 上限、seen[] 上限，一律走 TCLCore.LIMITS(單一權威，與 options
// 讀取端共用同一組值)。
// author/handle 共用 AUTHOR_MAX;excerpt 對齊手機版 post-meta EXCERPT_MAX_CHARS;
// original 對齊 bridge.js MAX_CLEAN_URL_LENGTH;removedParams 型別對齊手機版
// RemovedParam({ key, value })。

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
  // 得齊七個雲端欄位。兩支都掛在同一條 historyWriteChain 上，串行執行。
  migrateHistoryMerge();
  migrateHistorySchema();
});

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
// 【解法】更新完成的當下，對每個既開的 threads 分頁重新注入 ISOLATED world
// 的三支腳本，讓分頁立刻換上帶有效 chrome.runtime 的新實例。所需權限
// (scripting + threads 的 host_permissions)全部既有，不新增任何權限。
//
// 【MAIN world 的 clipboard-guard.js 刻意不重注入】它是純頁面層的
// navigator.clipboard.writeText／copy 事件包裹，完全不碰 chrome.* API，擴
// 充功能重載不會讓它失效;它 postMessage 出來的 TCL_RESOLVE_REQ／
// TCL_CLEANED_NOTICE 是靠「監聽 window message 的 bridge.js」接手，而 bridge
// 這一支我們重注入了(新身分、chrome.runtime 有效)，所以整條管道會自動接
// 回來——舊 guard 依賴的是「頁面上有人在聽 message」這件事，不是某個特定
// 的 bridge 實例。反過來重注入 guard 才有害:舊包裹還在，writeText 會被包
// 第二層，一次複製可能觸發兩次淨化/兩次通知。
const REINJECT_MATCHES = ['https://*.threads.com/*', 'https://*.threads.net/*'];

// 重注入的檔案與順序刻意對齊 manifest.json 的 content_scripts:bridge.js 先
// 上(它負責 window message 橋接)，接著 i18n.js(post-icon.js 的文案來源)，
// 最後 post-icon.js。少一支或順序顛倒都會讓新實例缺件。
const REINJECT_FILES = ['bridge.js', 'i18n.js', 'post-icon.js'];

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

// 回應 clipboard-guard.js 經 bridge.js 送來的短碼解析請求。本路徑不寫
// 剪貼簿、不發通知，只負責解析並回傳結果；失敗一律回傳 ok:false，由
// 呼叫端自行決定要不要用原始短碼放行。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'resolveShare') {
    return false; // 不是我們認得的訊息類型，不佔用 sendResponse 通道。
  }

  handleResolveShareMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[threads-clean-link] resolveShare 處理失敗', err);
      sendResponse({ ok: false, reason: 'internal-error' });
    });

  return true; // 非同步回應，保持訊息通道開啟直到 sendResponse 被呼叫。
});

// clipboard-guard.js 實際把淨化後內容寫入剪貼簿後，經 bridge.js 送來這則
// 通知——紀錄的其中一條入筆路徑，收到合法通知就無條件記錄，沒有「要不要
// 顯示通知」的把關。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'cleanedNotice') {
    return false; // 不是我們認得的訊息類型，不佔用 sendResponse 通道。
  }

  handleCleanedNotice(message).catch((err) => {
    console.error('[threads-clean-link] cleanedNotice 處理失敗', err);
  });

  return false; // 不需要回應，同步處理完就結束，不佔用非同步通道。
});

// ------------------------------------------------------------
// 雲端同步接線(docs/cloud-sync.md 第 5 節)
// ------------------------------------------------------------
//
// 引擎本體在 sync.js，依賴全部由這裡注入:SW 隨時被殺，引擎不能自己抓全域
// chrome/fetch/Date，否則沒有任何辦法在 node 測試裡跑完整往返。
//
// history 的寫入一律交給既有的 historyWriteChain(見 recordHistory):引擎與
// recordHistory、兩支遷移共用同一條序列鏈，才不會互相覆蓋 read-modify-write。

// chrome.storage 的區域轉接:一律以 Promise 呼叫。區域本身在函式內才取值，
// 沒有 chrome.storage.session 的環境(舊版瀏覽器/測試替身)不會在接線當下就炸。
function storageAreaAdapter(name) {
  function area() {
    const store = chrome.storage && chrome.storage[name];
    if (!store) throw new Error(`chrome.storage.${name} 不可用`);
    return store;
  }
  return {
    get: (keys) => Promise.resolve(area().get(keys)),
    set: (items) => Promise.resolve(area().set(items)),
    remove: (keys) => Promise.resolve(area().remove(keys)),
  };
}

// 認證模組:SW 內由 importScripts 保證存在，測試沙箱可能只載了 background
// 本身，因此以 typeof 取值不讓接線在載入當下就丟 ReferenceError。
const syncAuthApi = typeof TCLAuth !== 'undefined' ? TCLAuth : null;

// 引擎只在依賴齊備時建立:sync.js 與 chrome.alarms 缺一(舊環境、未宣告
// alarms 權限、測試沙箱只測其他功能)就整組同步功能靜默停用，不影響主功能。
const syncEngine =
  typeof TCLSync !== 'undefined' && typeof TCLSync.create === 'function' && chrome.alarms
    ? TCLSync.create({
        storage: { local: storageAreaAdapter('local'), session: storageAreaAdapter('session') },
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        alarms: {
          create: (name, info) => chrome.alarms.create(name, info),
          clear: (name) => Promise.resolve(chrome.alarms.clear(name)),
          get: (name) => Promise.resolve(chrome.alarms.get(name)),
          getAll: () => Promise.resolve(chrome.alarms.getAll()),
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
        writeChain: (fn) => enqueueHistoryWrite(fn),
        // 拉取是唯一會把 history 變長的寫入路徑，套的是與 recordHistory 同一
        // 份容量上限(位元組軟預算＋筆數硬保險，優先淘汰墓碑)。
        capHistory: (list) => capHistoryForStorage(list),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle),
      })
    : null;

// options/popup → background 的五個同步訊息。登入態與雲端資料是敏感面:
// 只接受本擴充自己的頁面(sender.url 是 chrome-extension://<自己的 id>/ 開頭)，
// content script 與其他擴充送來的一律不回應、不碰引擎。
const SYNC_MESSAGE_HANDLERS = {
  'sync.getState': (engine) => engine.getState(),
  'sync.signIn': (engine) => engine.signIn(),
  'sync.signOut': (engine) => engine.signOut(),
  'sync.now': (engine) => engine.syncNow(),
  'sync.deleteCloud': (engine) => engine.deleteCloud(),
};

// 訊息是否來自本擴充自己的頁面(options／popup)。
// 不能用 `!sender.tab` 當條件:manifest 的 options_ui.open_in_tab 為 true，設定頁
// 本身就是一個分頁，sender.tab 存在，五個 sync.* 會全被擋掉。改看 sender.url 前綴
// ——content script 的 sender.url 是它所在網頁的網址(https://www.threads.com/...)，
// 其他擴充走的是 onMessageExternal 進不了這個 listener，兩者都構不出
// chrome-extension://<自己的 id>/ 這個前綴。
// 本判準假設 manifest 沒有 web_accessible_resources 與 externally_connectable；
// 若日後新增 WAR，被網頁 iframe 的 WAR 頁面也會帶本擴充前綴，需回頭把判準收窄成
// 具名頁面(options.html／popup.html)或改用 sender.origin。
function isExtensionPageSender(sender) {
  if (!sender) return false;
  const selfId = chrome.runtime && chrome.runtime.id;
  if (typeof selfId !== 'string' || selfId === '' || sender.id !== selfId) return false;
  return typeof sender.url === 'string' && sender.url.indexOf('chrome-extension://' + selfId + '/') === 0;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const handler = SYNC_MESSAGE_HANDLERS[message.type];
  if (!handler) return false; // 不是我們認得的訊息類型，不佔用 sendResponse 通道。
  if (!isExtensionPageSender(sender) || !syncEngine) return false;

  Promise.resolve()
    .then(() => handler(syncEngine))
    .then(sendResponse)
    .catch((err) => {
      console.error(`[threads-clean-link] ${message.type} 處理失敗`, err);
      sendResponse(undefined);
    });

  return true; // 非同步回應，保持訊息通道開啟直到 sendResponse 被呼叫。
});

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
  // 寫入前用全 repo 單一權威的 TCLCore.isCleanPostUrl 錨定驗一次(見上方註解:
  // extractCleanPostUrl 用的 CLEAN_POST_URL_PATTERN 刻意寬鬆，寬鬆匹配
  // 到的內容不該不經檢查就流進 history);不符合就只略過記錄
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

// 讀取使用者設定。刻意放在點擊流程「內」呼叫，不在模組頂層同步觸碰
// chrome.storage：舊測試的 chrome mock 沒有 storage 屬性，頂層碰會讓
// 那些測試在 sandbox 載入階段就丟 TypeError。對 chrome.storage 缺席
// 或讀取失敗都容錯，一律退回預設值。
async function getSettings() {
  if (!chrome.storage || !chrome.storage.sync || typeof chrome.storage.sync.get !== 'function') {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  } catch (err) {
    console.error('[threads-clean-link] 讀取設定失敗，改用預設值', err);
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

// 處理 cleanedNotice:不信任呼叫端傳入的 cleanUrl，一律用錨定的
// POST_URL_PATTERN 重新驗證整串內容，不符合就靜默忽略、不寫入
// 任何紀錄;紀錄只用驗證通過的字串，不夾帶原文的任何其餘部分。
// kind 同屬頁面可控輸入，白名單驗證(自動路徑只可能是 share/strip/icon),
// 非法即整則忽略——guard 與 background 同版本出貨，沒有相容性負擔，
// 形狀不對就是偽造或損毀，fail-safe 丟棄。'menu' 刻意不在此白名單內:
// 它只由 handleShareLinkClick(右鍵選單路徑)直接呼叫 recordHistory,
// 不透過本訊息通道，避免頁面腳本偽造 kind:'menu' 混充右鍵來源。收到合法
// notice 就無條件記錄一筆，author/handle/excerpt 為選填欄位一併寫入。
//
// og 取得:所有 kind 一律走 fetchOgFieldsForLocalKind——它先 peek 快取。
// share 路徑會命中 handleResolveShareMessage 解析短碼時剛寫入的快取(零額外
// fetch);strip/icon 這兩條 kind 不像 share 那樣本來就會 fetch 貼文頁，快取
// 未命中時才真的補一次 fetch(見 fetchOgFieldsForLocalKind，含節流/逾時/失敗
// 回退)。剪貼簿/複製體感完全不受影響，那是 content script 端早就完成的事，
// 這裡只是延後「記錄」這個步驟——刻意不做「先落盤、og 到了再補寫」:紀錄是永
// 久合併的，二次寫入必然命中同一張卡，mergeHistoryEntry 會多長一筆假的 seen
// 事件(同一次複製動作被算成兩次解析)，污染時間軸。寧可讓記錄晚最多 2.5 秒落
// 盤，也不要污染資料。
async function handleCleanedNotice(message) {
  const cleanUrl = message && message.cleanUrl;
  if (!TCLCore.isCleanPostUrl(cleanUrl)) {
    return;
  }
  const kind =
    message && TCLCore.NOTICE_KIND_LIST.indexOf(message.kind) !== -1 ? message.kind : null;
  if (!kind) {
    return;
  }

  // 省請求閘:進 fetch 之前先讀一次設定，saveHistory 關閉時直接
  // return——連 recordHistory 都不呼叫，更不觸發 fetchOgFieldsForLocalKind
  // 那次為了補 og 而發的網路請求(解析結果反正會被 recordHistory 內部的
  // saveHistory 把關丟棄，先擋在這裡就省掉整個 fetch)。對齊 guard 端 share
  // 路徑已有的省請求閘(bridge.js 下放 saveHistory 讓 clipboard-guard.js 在
  // saveHistory 關閉時連 resolveShare 都不發)。recordHistory 內部仍保留各
  // 自的 saveHistory 權威把關(menu 路徑沒有這道前置閘，靠內部那道)，此處
  // 純粹是為了省掉 og 補強的 fetch。
  const settings = await getSettings();
  if (!settings.saveHistory) {
    return;
  }

  // 所有 kind 一律走 fetchOgFieldsForLocalKind:先 peek 快取(見 peekOgFields，
  // share 命中 resolveShare 剛寫入的快取，零額外 fetch)，strip/icon 未命中才
  // 真的 fetch 貼文頁。
  const ogFields = await fetchOgFieldsForLocalKind(cleanUrl);
  recordHistory(cleanUrl, kind, extractHistoryExtraFields(message, cleanUrl, ogFields));
}

// author/handle/excerpt/original/removedParams 皆為選填欄位，同屬頁面
// 可控輸入(除了右鍵路徑，其餘一律經 guard/bridge 這條 postMessage 管道
// 進來)，不信任:型別不是 string(或 removedParams 不是陣列)的一律整欄
// 丟棄(不寫進回傳物件，而非寫入 undefined/空字串)，字串則截斷至各自長
// 度上限。回傳值直接可以 Object.assign 進 history 條目(見 recordHistory)。
// url 參數是本次寫入的乾淨網址，供 sanitizeOriginalField 判斷 original
// 是否與 cleaned 相同(相同就不存)。
// ogFields(第三參數):og 一律由呼叫端先取好再傳進來，這裡不自己查快取。
// 四條落盤路徑的 og 來源各異但形狀一致——share 路徑來自快取 peek、strip/icon 來自貼文頁
// fetch(兩者都經 fetchOgFieldsForLocalKind，見 handleCleanedNotice)、menu
// 來自 resolveFinalUrl 同一 response(見 handleShareLinkClick)——統一從這
// 個參數進來(可能是 null/空物件，代表逾時/失敗/沒收穫，merge 端會容錯)。
function extractHistoryExtraFields(message, url, ogFields) {
  const extra = {};
  const domAuthor = TCLCore.sanitizeText(message && message.author, TCLCore.LIMITS.AUTHOR_MAX);
  const domHandle = TCLCore.sanitizeText(message && message.handle, TCLCore.LIMITS.AUTHOR_MAX);
  const domExcerpt = TCLCore.sanitizeText(message && message.excerpt, TCLCore.LIMITS.EXCERPT_MAX);

  // merge 結果不能直接信任，統一再過一次 sanitizeOgFields(見該函式註解：
  // 長度上限雙層防線)才寫進 extra。
  const merged = sanitizeOgFields(
    mergeOgIntoFields({ author: domAuthor, handle: domHandle, excerpt: domExcerpt }, ogFields)
  );
  if (merged.author !== undefined) extra.author = merged.author;
  if (merged.handle !== undefined) extra.handle = merged.handle;
  if (merged.excerpt !== undefined) extra.excerpt = merged.excerpt;

  // original 除了截斷/去重，還要吻合 SHARE 或容尾 POST 白名單、超長整欄丟棄
  // (不截半)，偽造/畸形殘 URL 不入庫(見 TCLCore.sanitizeOriginal)。
  const original = TCLCore.sanitizeOriginal(message && message.original, url);
  if (original !== undefined) extra.original = original;
  const removedParams = TCLCore.sanitizeRemovedParams(message && message.removedParams);
  if (removedParams !== undefined) extra.removedParams = removedParams;
  return extra;
}

// 右鍵路徑(menu)專用——對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/link-cleaner.ts:diffRemovedParams，比對淨化前後兩個網址，列出
// 被移除的 query 參數。cleanUrl(extractCleanPostUrl 的結果)一律不含
// query，afterParams 實際上恆為空集合，等同回報 finalUrl 的全部 query
// 參數;仍照抄手機版「比較後者鍵集合」的寫法，不自行簡化，未來若
// cleanUrl 的定義改變也不必回頭改這支函式。任一邊網址不合法(URL 建構
// 例外)一律回傳空陣列，不影響呼叫端(fail-safe，缺席不硬造)。
function diffRemovedParams(before, after) {
  try {
    const beforeParams = new URL(before).searchParams;
    const afterKeys = new Set(Array.from(new URL(after).searchParams.keys()).map((k) => k.toLowerCase()));
    const removed = [];
    beforeParams.forEach((value, key) => {
      if (!afterKeys.has(key.toLowerCase())) removed.push({ key, value });
    });
    return removed;
  } catch (err) {
    return [];
  }
}

// ---- og:description/og:title 擷取。實測 threads 貼文頁的 og:description
// 是全文且連結完整(DOM 顯示層才截斷);og:title 形如「かえで (@kaede.hong)
// on Threads」。短碼解析路徑(resolveFinalUrl，share 與右鍵路徑共用)本來就
// fetch 貼文頁，同一 response 順手撈，零額外請求。SW 沒有 DOMParser，自行用
// regex 抽取 + HTML entity 解碼，規則對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/post-meta.ts(ogContent／decodeHtmlEntities／parsePostMetaFromHtml
// 的 Threads 分支)，額外加上掃描長度上限防 ReDoS(手機版沒有這道防線，是本
// 檔案在 SW 環境下的加固)。----

// 掃描長度上限:只在 HTML 前段找 og meta 標籤(通常在 <head>，離文件開頭
// 很近)，避免對整份頁面(可能數百 KB)全文跑正則。
const OG_SCAN_LIMIT = 65536;

// 【語系鎖定】Threads 貼文頁的 og:title 會跟著 Accept-Language 換格式:
// 英文是「かえで (@kaede.hong) on Threads」(半形括號、帳號在名稱後)，
// 中文則是「Threads 上的かえで（@kaede.hong）」(全形括號、多一個前綴)。
// 解析規則(parseOgTitle)照抄手機版 post-meta.ts，只認半形括號那一式，
// 中文格式會整串被當成顯示名稱塞進 author。
//
// 與其讓解析器去追各語系的措辭變化(站方隨時可改，且語系數量無上限)，
// 不如把來源鎖成固定的一種:兩個抓貼文頁的 fetch 點一律帶
// Accept-Language: 'en'，og:title 恆為英文格式，解析規則不必變。SW 的
// fetch 不受使用者瀏覽器語系影響，這個 header 只影響我們自己這兩次背景
// 請求，不會改變使用者在 threads 頁面上看到的語言。
//
// 抓貼文頁的 fetch 點就這兩處(全庫已確認無第三處)，兩處共用本常數:
//   1. resolveFinalUrl —— share 自動路徑與右鍵選單路徑共用的短碼解析器
//      (右鍵路徑經 handleShareLinkClick 呼叫，不另開 fetch)。
//   2. fetchOgFieldsForLocalKind —— icon/strip 兩條本地路徑的 og 補強。
const OG_FETCH_HEADERS = { 'Accept-Language': 'en' };

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 從 HTML 文字擷取 <meta property="og:xxx" content="..."> 的 content 屬
// 性值，property 可能在 content 之前或之後(不同頁面產生器順序不一定)，
// 兩種順序都要能比對到。找不到回傳 null。正則沿用手機版 post-meta.ts 的
// ogContent 寫法，只多了掃描長度上限這一層(見上方常數註解)。
function extractOgMeta(html, property) {
  if (typeof html !== 'string' || !html) return null;
  const scanText = html.slice(0, OG_SCAN_LIMIT);
  const escaped = escapeRegExp(property);
  const re1 = new RegExp(`<meta[^>]+property="${escaped}"[^>]+content="([^"]*)"`, 'i');
  const re2 = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${escaped}"`, 'i');
  const match = re1.exec(scanText) || re2.exec(scanText);
  return match ? decodeHtmlEntities(match[1]) : null;
}

// 極簡 HTML entity 解碼，只處理 og:content 屬性值裡實際會出現的子集(SW
// 沒有 DOMParser，不用瀏覽器原生解碼器)。規則與順序照抄手機版
// post-meta.ts 的 decodeHtmlEntities(依序 amp/lt/gt/quot/#39/hex/十進
// 位，鏈式 replace)。解碼後的純文字只會流入 textContent 類的 sink(下游
// options.js 卡片渲染皆為 textContent，不是 innerHTML)，不得再進任何
// HTML sink——這裡的解碼純粹是把屬性值裡的逸出字元還原成使用者看得懂
// 的原文字元，不是要重新產生可執行的 HTML。
function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch (e) {
        return m;
      }
    })
    .replace(/&#(\d+);/g, (m, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch (e) {
        return m;
      }
    });
}

// og:title 常見樣式:「顯示名稱 (@handle) on Threads」。比對規則照抄手
// 機版 post-meta.ts 的 Threads 分支:非貪婪抓第一組「(@handle)」前的文
// 字當顯示名稱，不要求整串以「on Threads」結尾——顯示名稱本身含括號、
// @ 等邊角字元不影響，因為比對的是「第一個」(@…)出現的位置，不是整段
// 字串的格式。抓不到 (@handle) 形狀時，整串當顯示名稱、只去掉結尾的
// 「 on Threads」尾綴，不解析 handle(手機版同一套邏輯，涵蓋粉專等
// og:title 沒有帳號形狀的情況)。回傳 { author?, handle? }(handle 補回
// 開頭的 @，對齊本檔既有的 handle 儲存格式——手機版儲存不含 @，於渲染
// 層補上，本檔案渲染層直接吃已含 @ 的 handle，見 options.js)，皆缺席時
// 回傳 null。
//
// 【第二式:全形括號保底】兩個 fetch 點已鎖 Accept-Language: 'en'(見
// OG_FETCH_HEADERS)，正常情況 og:title 恆為英文格式，走不到這一式。它
// 存在是為了 header 失效的情境:站方改版忽略 Accept-Language、企業代理
// 改寫 header、或未來新增的呼叫點忘了帶。中文語系的樣式是「Threads 上
// 的かえで（@kaede.hong）」——全形括號，且顯示名稱前多一個「Threads 上
// 的」前綴。主式(半形)不成立時才試這一式，主式行為零改動。
//
// 【第三式:fallback 的髒字串防線】兩式都不成立時，沿用原本「整串當顯
// 示名稱、只剝掉英文尾綴」的手機版邏輯(涵蓋粉專等 og:title 本來就沒有
// 帳號形狀的情況);但結果若仍夾帶「(@」或「（@」殘片，代表這是某種我們
// 沒認得的帳號形狀樣式(例如又一種語系的新措辭)，整串塞進 author 只會產
// 生「Threads 上的某某（@someone）」這類髒資料——寧缺勿錯，整欄放棄，讓
// author 缺席即可(卡片自然只顯示 @handle)。
const OG_TITLE_FULLWIDTH_HANDLE = /^(.*?)\s*（@([^）]+)）/;
const OG_TITLE_LOCALE_PREFIX = /^Threads\s*上的\s*/;
const OG_TITLE_EN_SUFFIX = /\s+on Threads$/i;
const OG_TITLE_HANDLE_RESIDUE = /[(（]@/;

function parseOgTitle(ogTitle) {
  if (typeof ogTitle !== 'string' || !ogTitle) return null;
  const trimmed = ogTitle.trim();
  const match = /^(.*?)\s*\(@([^)]+)\)/.exec(trimmed);
  if (match) {
    return buildOgTitleResult(match[1], match[2]);
  }

  const fullwidth = OG_TITLE_FULLWIDTH_HANDLE.exec(trimmed);
  if (fullwidth) {
    // 括號前段才是顯示名稱的所在;再剝掉中文語系前綴，以及(理論上不會
    // 與全形樣式同時出現、但剝了無害的)英文尾綴。
    const name = fullwidth[1].replace(OG_TITLE_LOCALE_PREFIX, '').replace(OG_TITLE_EN_SUFFIX, '');
    return buildOgTitleResult(name, fullwidth[2]);
  }

  const fallbackAuthor = trimmed.replace(OG_TITLE_EN_SUFFIX, '').trim();
  if (!fallbackAuthor || OG_TITLE_HANDLE_RESIDUE.test(fallbackAuthor)) return null;
  return { author: fallbackAuthor };
}

// 前兩式共用的收尾:各自 trim、handle 補回開頭的 @，兩者皆空則回傳 null。
function buildOgTitleResult(rawAuthor, rawHandle) {
  const author = rawAuthor.trim();
  const handle = rawHandle.trim();
  const result = {};
  if (author) result.author = author;
  if (handle) result.handle = '@' + handle;
  return result.author || result.handle ? result : null;
}

// 從貼文頁 HTML 一次擷取 og:description(excerpt)與 og:title(拆
// author/handle)，擷取不到的欄位就缺席、不硬造。回傳值尚未經長度上限
// sanitize，呼叫端(resolveFinalUrl)統一過 sanitizeOgFields。
function extractOgFields(html) {
  const result = {};
  const description = extractOgMeta(html, 'og:description');
  if (description) result.excerpt = description;
  const title = extractOgMeta(html, 'og:title');
  const parsedTitle = title ? parseOgTitle(title) : null;
  if (parsedTitle) {
    if (parsedTitle.author !== undefined) result.author = parsedTitle.author;
    if (parsedTitle.handle !== undefined) result.handle = parsedTitle.handle;
  }
  return result;
}

// { author?, handle?, excerpt? } 形狀的三欄統一過長度上限，規則與既有
// author/handle/excerpt 完全一致。兩種輸入都會經過這裡:
//   1. resolveFinalUrl 擷取到的原始 og 資訊(extractOgFields 的回傳
//      值)，讓兩條呼叫路徑(menu 直接用、share 路徑經 og 快取轉一手)都
//      拿到同一份已經處理過的資料，不必各自重覆寫一次 sanitize。
//   2. mergeOgIntoFields 的合併結果:merge 只負責「挑值 + 去重比對」，不
//      保證輸出仍在長度上限內，任何一處疏漏都會讓超長字串直通入庫，故合
//      併後統一再過一次同一把尺——順序是「先在 mergeOgIntoFields 內完成
//      author===handle 去重比對，這裡才截斷」，避免截斷影響去重判斷的正
//      確性。
function sanitizeOgFields(rawOgFields) {
  const out = {};
  const excerpt = TCLCore.sanitizeText(rawOgFields && rawOgFields.excerpt, TCLCore.LIMITS.EXCERPT_MAX);
  if (excerpt !== undefined) out.excerpt = excerpt;
  const author = TCLCore.sanitizeText(rawOgFields && rawOgFields.author, TCLCore.LIMITS.AUTHOR_MAX);
  if (author !== undefined) out.author = author;
  const handle = TCLCore.sanitizeText(rawOgFields && rawOgFields.handle, TCLCore.LIMITS.AUTHOR_MAX);
  if (handle !== undefined) out.handle = handle;
  return out;
}

// og 資訊與既有欄位(DOM 擷取或缺席)的合併規則。web DOM 抓到的「作者」實為
// username——與 handle 同源、是錯值不是缺席，og:title 解析出的顯示名稱優先
// 蓋過，不是「新值優先、缺席才沿用」這種對等合併(手機版一律靠 og:title 解析、
// 從不做 DOM 擷取，不存在這個資料品質問題，故無對應防禦可抄，以下為本檔案針
// 對此問題的裁決):
//   - excerpt:og 版是全文(DOM 顯示層才截斷)，og 有值就蓋過既有版本;
//     og 缺席才維持既有版本。
//   - author:og 有解析出來就一定蓋過既有版本(既有的 DOM 版本本身就不
//     可信);og 缺席才維持既有版本。
//   - handle:反過來，DOM/URL 擷取的 handle 才是可靠來源，既有版本有值
//     就維持，og 版只在既有版本缺席時補位。
//   - 重複值防禦:合併後若 author 與 handle(去掉開頭 @ 比較)相同，視
//     同 author 缺席、不存重複值——通常是 og 解析也失敗、退回到與 DOM
//     版一樣的窘境(或 og:title 本身就只有帳號名沒有顯示名稱)。
function mergeOgIntoFields(existing, ogFields) {
  const hasOg = ogFields && typeof ogFields === 'object';
  let author = hasOg && ogFields.author !== undefined ? ogFields.author : existing.author;
  const handle = existing.handle !== undefined ? existing.handle : hasOg && ogFields.handle;
  const excerpt = hasOg && ogFields.excerpt !== undefined ? ogFields.excerpt : existing.excerpt;

  const normalizedHandle = typeof handle === 'string' ? handle.replace(/^@/, '') : handle;
  if (author !== undefined && author === normalizedHandle) {
    author = undefined;
  }

  const result = {};
  if (author !== undefined) result.author = author;
  if (handle) result.handle = handle;
  if (excerpt !== undefined) result.excerpt = excerpt;
  return result;
}

// og 資料橋接快取(share 路徑專用):resolveShare(handleResolveShareMessage)
// 解析短碼時已經拿到 og 資訊，但 share 路徑實際的 recordHistory 要等
// guard 之後另外送來的 cleanedNotice(見 handleCleanedNotice)才會發生
// ——兩者是不同時間點的訊息，用一個以 cleanUrl 為 key 的小快取橋接。取用
// 一律走 peekOgFields(窺視不刪，見下方);上限與 TTL 防止使用者複製後遲遲不
// 觸發 cleanedNotice 時無限累積或用到過期資料。menu 路徑不經這個快取，
// resolveFinalUrl 的回傳值直接同步使用。
const OG_CACHE_MAX = 20;
const OG_CACHE_TTL_MS = 60 * 1000;
// 負快取短 TTL:og 抓不到(空結果)存負快取，避免同一貼文每次事件都重跑
// 一次 2.5s fetch;但比正快取短很多，讓「站方稍後補上 og」或「暫時性抓取
// 失敗」有機會在不久後重試，不被卡滿整個 60 秒。
const OG_NEGATIVE_TTL_MS = 10 * 1000;
// 負快取標記:空結果不是「沒有這筆快取」，而是「查過了，確實沒有 og」。
// 用一個獨一無二的 sentinel 與正常 og 物件區分，peek 到它時呼叫端一律當
// 作 null(沒收穫)處理，但不會因此再發一次 fetch。
const OG_NEGATIVE = { __tclNegativeOg: true };
const ogFieldsCache = new Map();
// in-flight 去重:同一 cleanUrl 正在跑的 fetch promise，連點 icon 時第二
// 次事件直接接同一個 promise，不重複發 fetch。完成後(finally)就地移除。
const ogInflight = new Map();

// 空結果判定:三個 og 欄位全缺席即視為空(呼叫端據此落負快取)。
function isEmptyOgFields(ogFields) {
  return (
    !ogFields ||
    (ogFields.excerpt === undefined && ogFields.author === undefined && ogFields.handle === undefined)
  );
}

function cacheOgFields(cleanUrl, ogFields) {
  const empty = isEmptyOgFields(ogFields);
  // 真 LRU:set 前先 delete，讓「重新被碰到」的 key 移到 Map 迭代序尾端
  // (最新),size 超限時淘汰的 keys().next()(最舊)才是真正最久沒用到的
  // 那筆，而不是最早插入但可能剛被讀取過的那筆。
  ogFieldsCache.delete(cleanUrl);
  ogFieldsCache.set(cleanUrl, {
    at: Date.now(),
    ogFields: empty ? OG_NEGATIVE : ogFields,
    ttl: empty ? OG_NEGATIVE_TTL_MS : OG_CACHE_TTL_MS,
  });
  if (ogFieldsCache.size > OG_CACHE_MAX) {
    const oldestKey = ogFieldsCache.keys().next().value;
    ogFieldsCache.delete(oldestKey);
  }
}

// 窺視快取但不刪:同一個 cleanUrl 在 OG_CACHE_TTL_MS 視窗內的多次事件都能
// 重用同一份快取(見下方 fetchOgFieldsForLocalKind 的節流)，不能第一次讀到
// 就把快取清空。share
// 路徑的 cleanedNotice 命中的正是 resolveShare 剛寫入的這份快取——peek
// 到就零額外 fetch。負快取(空結果，見 fetchOgFieldsForLocalKind 的
// NEGATIVE_OG 標記)也一律先由這裡撈出，呼叫端據此判斷是否短路。
function peekOgFields(cleanUrl) {
  const entry = ogFieldsCache.get(cleanUrl);
  if (!entry) return null;
  const ttl = typeof entry.ttl === 'number' ? entry.ttl : OG_CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    // 過期就地清掉，不留給 LRU 慢慢淘汰，順手讓快取只保有有效項目。
    ogFieldsCache.delete(cleanUrl);
    return null;
  }
  return entry.ogFields; // 正常 og 物件，或 OG_NEGATIVE(負快取 sentinel)
}

// 本地路徑(icon/strip)專用的 og 補強逾時:貼文按鈕複製與 ?xmt 剪參都是
// 純本地判斷，原本不會觸發任何網路請求;這裡額外補一次 fetch 專門拿 og
// 資訊，逾時風格沿用 clipboard-guard.js 的 RESOLVE_TIMEOUT_MS(2.5 秒，
// 本檔案獨立維護同一個數值，兩處環境不同沒有共用單一來源的機制)。
const OG_LOCAL_FETCH_TIMEOUT_MS = 2500;

// 本地路徑(icon/strip)專用:貼文按鈕複製與 ?xmt 剪參的 web 動態牆 DOM
// 沒有個人顯示名稱(只有 username)，這兩條路徑原本 author 永遠等於
// handle、被既有的重複值防禦丟棄，卡片只剩 @handle；DOM 擷取的摘要還
// 可能吸到讚數等雜訊。這裡額外對 cleanUrl 補一次 fetch 擷取 og 資訊，
// 重用既有的 extractOgFields／sanitizeOgFields 全鏈(長度雙層防線不變)。
//
// 節流(三層):
//   1. 快取命中(peekOgFields，窺視不刪):同一 cleanUrl 在 TTL 內的正快取
//      直接回傳、不重複 fetch;負快取(OG_NEGATIVE)命中則回傳 null 但同樣
//      不 fetch——og 抓不到的貼文在短 TTL 內不再每次重跑 2.5s fetch。
//   2. in-flight 去重(ogInflight):同一 cleanUrl 已有 fetch 在跑，連點 icon
//      的第二次事件直接接同一個 promise，不發第二次 fetch;完成後就地換成
//      結果(靠快取)並從 ogInflight 移除。
//   3. 每次呼叫各自的逾時競速:即使接了別人的 in-flight promise，自己這次
//      事件仍最多等 OG_LOCAL_FETCH_TIMEOUT_MS 就 fail-open 回 null。
// 逾時或 fetch 失敗一律回傳 null，呼叫端 fail-open 退回 DOM 版欄位，離線也
// 不影響紀錄照常落盤——逾時之後 fetch 仍在背景跑完的話，結果照樣存回快取
// (正或負)供下一次事件重用(這次事件用不到，但沒有浪費)。
async function fetchOgFieldsForLocalKind(cleanUrl) {
  const cached = peekOgFields(cleanUrl);
  // 正快取回傳結果;負快取(sentinel)回傳 null(沒收穫但不再 fetch)。
  if (cached !== null) return cached === OG_NEGATIVE ? null : cached;

  // in-flight 去重:已有同 cleanUrl 的 fetch 在跑就共用，否則起一個新的並
  // 登記到 ogInflight。fetch 完成後把結果寫回快取(正或負)，供後續事件經
  // 第 1 層命中;無論成敗都在 finally 從 ogInflight 移除。
  let fetchOnce = ogInflight.get(cleanUrl);
  if (!fetchOnce) {
    fetchOnce = (async () => {
      try {
        const response = await fetch(cleanUrl, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'follow',
          // og:title 的語系鎖定，見 OG_FETCH_HEADERS。
          headers: OG_FETCH_HEADERS,
        });
        const text = await response.text();
        const ogFields = sanitizeOgFields(extractOgFields(text));
        // 空結果會被 cacheOgFields 收成負快取(短 TTL);非空則正快取。
        cacheOgFields(cleanUrl, ogFields);
        return isEmptyOgFields(ogFields) ? null : ogFields;
      } catch (err) {
        console.error('[threads-clean-link] 本地路徑(icon/strip)補強 og 資訊失敗', err);
        return null;
      } finally {
        ogInflight.delete(cleanUrl);
      }
    })();
    ogInflight.set(cleanUrl, fetchOnce);
  }

  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), OG_LOCAL_FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([fetchOnce, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

// ---- 紀錄永久合併(合併鍵 = post ID)----
//
// 同一篇貼文常見走多條路徑重複淨化(右鍵選單／自動偵測／貼文互動列複製
// icon)，也常見隔天再複製一次。紀錄一律合併為一張卡，讓使用者看到的歷史
// 是「一篇貼文一張卡、卡上記著每一次動作」，而不是同一篇貼文洗版。
//
// 【與手機版刻意分岔】手機版 hunandy14/meta-link-clearer 的
// src/lib/share-history-storage.ts 用「cleaned url + DEDUP_WINDOW_MS(5 分
// 鐘)」去重，視窗外的同一篇貼文會另開一張卡。本擴充改為**永久合併**:不設
// 任何時間視窗，同一篇貼文永遠合成同一張卡。兩邊的資料模型自此分岔，仍對
// 齊手機版的只剩合併後的欄位語意(浮頂、欄位新值優先、kind 記最近一次、
// seen[] 上限 50 裁最舊)。
//
// 【主鍵是 post ID，不是整條 url】handle 可以改名，同一篇貼文的乾淨網址會
// 跟著換樣子(/@old/post/ID → /@new/post/ID);post ID 則終身不變。以 ID 為
// 主鍵，改名前後的紀錄才仍認得是同一篇。
//
// 【合併鍵三層級聯】
//   1. **post key 主鍵**(historyDedupKey → TCLCore.postKeyOf):同一篇貼文
//      不論網址形狀如何變化(handle 改名、網域變體、尾斜線、query)，一律
//      取得同一個鍵(細節見 historyDedupKey 上方註解)。
//   2. **original 收編**(findOriginalAdoptIndex):本次落盤的 original 是短
//      碼原文時，把「當年解析失敗、以短碼原文入庫」的失敗卡一併收編進同文
//      卡——短碼在解析成功的那一刻才第一次與貼文對上號，這是唯一能把兩者
//      接起來的時機。
//   3. **失敗卡自鍵**:抽不出貼文代碼的 url(短碼原文等)退回正規化網址
//      當 fallback key(url:<host><path><query>，見 urlKey)。同一個短碼
//      重複入庫仍合成一張，不同短碼各自獨立。
// 不同短碼指向同一篇貼文的失敗卡彼此認不出來(短碼只有 Meta 伺服器能對應，
// 本機無從得知兩個短碼是同一篇)，此為自然極限，不另做補救。

// seen[] 上限(TCLCore.LIMITS.SEEN_MAX)與 kind 白名單(TCLCore.KIND_LIST，含
// 'menu')一律走 TCLCore;seen[] 逐筆消毒改用 TCLCore.sanitizeSeenList(與
// options 讀取/匯入端共用同一份，連 slice(-SEEN_MAX) 都在函式內完成)。

// 合併時「新值優先、新值缺席才沿用舊值」的選填欄位集合。三處共用同一份清
// 單:落盤合併(mergeHistoryEntry 逐欄寫開，語意同此)、失敗卡收編
// (adoptFailureEntry)、一次性遷移(mergeHistoryGroup)。
const MERGEABLE_FIELDS = ['author', 'handle', 'excerpt', 'original', 'removedParams'];

// 純函式:條目的合併鍵，走 TCLCore.postKeyOf(D11，與手機 postKeyOf 完全等
// 價)。同一篇貼文不論 handle 改名、網域變體(www./m./mobile.、threads.com/
// .net)、尾斜線、query，皆算出同一個 threads:<code> 之類的鍵;抽不出貼文
// 代碼的一律退回正規化後的網址當 fallback key(url:<host><path><query>)。
function historyDedupKey(url) {
  return TCLCore.postKeyOf(url);
}

// 純函式:在既有清單中找出合併鍵相同的條目 index，找不到回傳 -1。**全表比
// 對、不設時間視窗**(永久合併)。清單長度由 HISTORY_MAX_ENTRIES 封頂，全表
// 掃描的成本與原本的視窗掃描同為 O(n)。
function findDedupIndex(list, url) {
  if (!Array.isArray(list)) return -1;
  const key = historyDedupKey(url);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && typeof item.url === 'string' && historyDedupKey(item.url) === key) return i;
  }
  return -1;
}

// 純函式:本次的 original 是否有資格觸發失敗卡收編——必須是分享短碼原文。
//
// 【只認短碼原文】original 同屬頁面可控輸入(見 extractHistoryExtraFields):
// 若放行任意 original 值，惡意頁面只要把別篇貼文的乾淨網址當 original 送
// 進來，就能點名讓那張卡被吞掉。限定 TCLCore.SHARE_URL_PATTERN 之後，可被
// 收編的對象只剩「url 是短碼」的卡——正常落盤的貼文卡 url 恆為
// /@handle/post/ID 形狀，永遠不可能是短碼，收編的波及面因此封死在失敗卡這
// 一類。strip 路徑的 original(貼文網址帶追蹤參數)同樣不觸發收編:那條路
// 徑從來不會產生以原文入庫的失敗卡。
function isAdoptableOriginal(original) {
  return typeof original === 'string' && TCLCore.SHARE_URL_PATTERN.test(original);
}

// 純函式:找出「當年解析失敗、以短碼原文入庫」的失敗卡 index——它的 url 恰
// 為本次落盤條目的 original。skipIndex 是本次同文卡自己的 index(上一步已
// 命中合併)，不得重複收編。找不到回傳 -1。
function findOriginalAdoptIndex(list, original, skipIndex) {
  if (!Array.isArray(list) || !isAdoptableOriginal(original)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (i === skipIndex) continue;
    const item = list[i];
    if (item && item.url === original) return i;
  }
  return -1;
}

// 純函式:取出條目的 seen 事件序列。seen[] 存在就逐筆過
// TCLCore.sanitizeSeenList;缺席(schema 升級前寫入的舊資料)時照手機版語意
// (`existing.seen ?? [{ at: existing.receivedAt }]`)以條目自身的 at 補種一
// 筆起始紀錄，讓時間軸看得到它原本第一次出現的時間;種子紀錄不帶 kind(那
// 一刻沒有對應的來源事件，UI 時間軸端已容忍缺 kind 標籤)。at 不是有限數字
// 就連種子都不補(那筆時間本身就不可信)。
function entrySeenEvents(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.seen)) return TCLCore.sanitizeSeenList(entry.seen);
  return typeof entry.at === 'number' && isFinite(entry.at) ? [{ at: entry.at }] : [];
}

// 純函式:條目的最早事件時間(計劃 4.1 的 receivedAt)。取 seen 事件的**最小**
// at 而非 seen[0].at——真實資料在多次合併/匯入後未必已排序;一個可用事件都
// 沒有(seen 為空陣列、或 at 全是髒資料)時退回條目自身的 at。
function entryEarliestAt(entry) {
  const events = entrySeenEvents(entry);
  let earliest = null;
  for (let i = 0; i < events.length; i++) {
    if (earliest === null || events[i].at < earliest) earliest = events[i].at;
  }
  if (earliest !== null) return earliest;
  return entry && typeof entry.at === 'number' && isFinite(entry.at) ? entry.at : null;
}

// 純函式:條目已持久化的 receivedAt 與其事件序列推導值取較早者。receivedAt
// 是這張卡在雲端的「第一次出現時間」，只會往前不會往後——seen 裁到 SEEN_MAX
// 而丟掉最舊幾筆時，不得讓 receivedAt 跟著往後跳。
function resolveReceivedAt(entry) {
  const stored = entry && typeof entry.receivedAt === 'number' && isFinite(entry.receivedAt) ? entry.receivedAt : null;
  const derived = entryEarliestAt(entry);
  if (stored === null) return derived;
  if (derived === null) return stored;
  return Math.min(stored, derived);
}

// 純函式:條目是否為墓碑(已軟刪、等待上傳刪除意圖)。墓碑留在 storage 但不
// 進畫面，裁切時優先淘汰(見 capHistoryForStorage)。
function isTombstoneEntry(entry) {
  return !!entry && typeof entry === 'object' && typeof entry.deletedAt === 'number' && isFinite(entry.deletedAt);
}

// 純函式:多張卡的 seen 事件聯集——攤平後按 at 升序排列(卡與卡之間的事件
// 本來就交錯，不能直接接龍)，再裁到最新 SEEN_MAX 筆。at 相同的事件維持原
// 順序(Array#sort 穩定)。
function unionSeenEvents(lists) {
  const all = [];
  for (let i = 0; i < lists.length; i++) {
    for (let j = 0; j < lists[i].length; j++) all.push(lists[i][j]);
  }
  all.sort((a, b) => a.at - b.at);
  return all.slice(-TCLCore.LIMITS.SEEN_MAX);
}

// 純函式:把失敗卡收編進同文卡，回傳全新的條目物件(不改動任一輸入)。
//   - url/kind/at:一律維持同文卡的值。失敗卡只提供歷史，不改身分也不改
//     排序位置。
//   - 選填欄位:同文卡有值就維持，缺席才由失敗卡補位(失敗卡可能帶著當時
//     DOM 擷取到的 author/handle/excerpt)。
//   - seen[]:兩張卡的事件聯集(見 unionSeenEvents/entrySeenEvents)，失敗當
//     下那個時刻因此留在時間軸上。
function adoptFailureEntry(entry, failed) {
  const merged = Object.assign({}, entry);
  for (let i = 0; i < MERGEABLE_FIELDS.length; i++) {
    const field = MERGEABLE_FIELDS[i];
    if (merged[field] === undefined && failed && failed[field] !== undefined) {
      merged[field] = failed[field];
    }
  }
  merged.seen = unionSeenEvents([entrySeenEvents(entry), entrySeenEvents(failed)]);
  // 收編把失敗卡那一刻的事件併進時間軸，這張卡的最早事件因此可能往前——
  // receivedAt 跟著取兩張卡的較早者。id 一律維持同文卡的(失敗卡的 id 指向
  // 雲端另一張卡，換過去等於改身分)。
  const earliest = [resolveReceivedAt(entry), resolveReceivedAt(failed)].filter((v) => v !== null);
  if (earliest.length > 0) merged.receivedAt = Math.min.apply(null, earliest);
  return merged;
}

// seen[] 逐筆消毒走 TCLCore.sanitizeSeenList(見該檔註解:at 需為有限數字、
// kind 缺席保留、kind 有值需在 KIND_LIST 白名單內、裁到 SEEN_MAX)，與 options
// 讀取/匯入端共用同一份。唯一差異是 slice 位置——TCLCore 版在函式內就裁，對
// merge 端無行為差(concat 本次一筆後照樣再裁，見下方)。

// 純函式:把本次的 kind/extra 併入既有條目 existing，回傳全新的條目物件
// (不改動 existing，也不假設 existing 形狀完全乾淨——只挑用得到的欄
// 位，其餘未知欄位自然被丟棄，等同順手做了一次縱深防禦)。
//   - at 更新為 now(浮到最新，呼叫端負責把回傳的條目移到陣列最前)。
//   - kind 更新為本次來源(卡片徽章顯示最近一次解析路徑)。
//   - author/handle/excerpt/original/removedParams:本次 extra 有值就用
//     本次的，本次缺席才沿用 existing 的舊值(新值優先，但不能讓「這次
//     沒抓到」蓋掉「上次抓到的」)，五個欄位規則一致。
//   - url 更新為本次的乾淨網址:handle 改名後同一個 post ID 會帶來新的
//     網址，卡片顯示的應是最近一次看到的樣子。
//   - seen[]:既有事件序列走 entrySeenEvents(seen[] 存在就逐筆 sanitize，
//     缺席則以 existing.at 補種一筆起始紀錄)，再 append 本次
//     {at: now, kind}，裁到最新 SEEN_MAX 筆。本次事件必為最新，直接接在
//     尾端即可，不需要像 unionSeenEvents 那樣重排。
function mergeHistoryEntry(existing, url, kind, now, extra) {
  const author = extra && extra.author !== undefined ? extra.author : existing.author;
  const handle = extra && extra.handle !== undefined ? extra.handle : existing.handle;
  const excerpt = extra && extra.excerpt !== undefined ? extra.excerpt : existing.excerpt;
  const original = extra && extra.original !== undefined ? extra.original : existing.original;
  const removedParams =
    extra && extra.removedParams !== undefined ? extra.removedParams : existing.removedParams;
  const seen = entrySeenEvents(existing)
    .concat([{ at: now, kind }])
    .slice(-TCLCore.LIMITS.SEEN_MAX);

  const merged = { url, kind, at: now, seen };
  if (author !== undefined) merged.author = author;
  if (handle !== undefined) merged.handle = handle;
  if (excerpt !== undefined) merged.excerpt = excerpt;
  if (original !== undefined) merged.original = original;
  if (removedParams !== undefined) merged.removedParams = removedParams;
  return applyHistorySchema(merged, existing, now);
}

// 雲端 schema 的七個欄位(docs/cloud-sync.md 4.1)。遷移與寫入路徑共用
// 同一份清單，判斷「這筆是否已對齊」也以它為準。
const HISTORY_SCHEMA_FIELDS = ['id', 'postKey', 'original', 'receivedAt', 'dirty', 'serverUpdatedAt', 'deletedAt'];

// 純函式:把雲端 schema 的七個欄位補上 entry(就地改動傳入的 entry，呼叫端
// 傳的一律是剛建好的新物件)。previous 是這張卡合併前的樣子(新建路徑傳
// null)，now 是本次事件時間。
//   - id:沿用既有(它是雲端卡片的身分，換一次等於在雲端另開一張卡)，沒有
//     才生成 UUID v4。
//   - postKey:一律由本次的 url 重算(衍生欄位，handle 改名/子網域變體都算得
//     出同一個鍵)。
//   - original:本次/既有皆缺席時以 url 補(伺服器必填，缺席整筆被靜默丟棄)。
//   - receivedAt:既有值與事件序列推導值取較早者，只往前不往後。
//   - dirty:本機有新事件，一律標髒待上傳。
//   - serverUpdatedAt:伺服器的值，本機合併不得清掉。
//   - deletedAt:清為 null——刪過的貼文再次淨化即復活，就地改既有那張卡。
function applyHistorySchema(entry, previous, now) {
  const base = previous && typeof previous === 'object' ? previous : null;
  entry.id = base && typeof base.id === 'string' && base.id ? base.id : TCLCore.randomUuid();
  entry.postKey = TCLCore.postKeyOf(entry.url);
  if (entry.original === undefined) entry.original = entry.url;
  const earliest = [base === null ? null : resolveReceivedAt(base), typeof now === 'number' ? now : null].filter(
    (v) => v !== null
  );
  entry.receivedAt = earliest.length > 0 ? Math.min.apply(null, earliest) : null;
  entry.dirty = true;
  entry.serverUpdatedAt =
    base && typeof base.serverUpdatedAt === 'number' && isFinite(base.serverUpdatedAt) ? base.serverUpdatedAt : null;
  entry.deletedAt = null;
  return entry;
}

// ---- 紀錄 ----

function hasStorageLocal() {
  return !!(
    chrome.storage &&
    chrome.storage.local &&
    typeof chrome.storage.local.get === 'function' &&
    typeof chrome.storage.local.set === 'function'
  );
}

// ---- 儲存上限:位元組軟預算 + 筆數硬保險 ----
//
// chrome.storage.local 未申請 unlimitedStorage 權限時的總量配額約 10MB
// (QUOTA_BYTES = 10485760)。這裡設 8MB 軟預算，刻意留約 2MB 餘裕給 sync
// 設定的鏡像、options 匯入時的暫態、以及單次突發的較大 payload，不把配額
// 用滿到邊界。既有的 isQuotaExceededError 降級(見下方 set 的 catch)保留當
// 最後一道防線——軟預算是「平時就不長到那麼大」，配額降級是「萬一還是爆了
// 也不炸」。
const STORAGE_SOFT_BUDGET = 8 * 1024 * 1024;
// 筆數硬保險:即使每筆都很小、位元組遠不到軟預算，也不讓陣列無限長(渲染/
// 去重掃描都是 O(n))。10000 筆是「正常使用永遠碰不到、異常暴衝才會撞上」
// 的量級。軟預算與硬保險兩者取先觸發者:capHistoryForStorage 先砍筆數上
// 限、再用軟預算裁位元組，最終陣列同時滿足兩個約束。
const HISTORY_MAX_ENTRIES = 10000;

// 把待寫入的紀錄陣列(新到舊排列，index 0 最新)裁到儲存上限內:筆數超過
// HISTORY_MAX_ENTRIES 先從尾端(最舊)砍;再從最新往最舊累加估算序列化位元
// 組，超過 STORAGE_SOFT_BUDGET 就不再收更舊的條目(同樣等於從尾端裁)。位
// 元組以 JSON.stringify(...).length 近似(ASCII 相符;多位元組字元會低估，由
// 2MB 餘裕吸收)。永遠至少保留最新一筆，不會把本次剛寫入的紀錄也裁掉。
function capHistoryForStorage(list) {
  // 兩條裁切路徑(筆數、位元組)都先淘汰墓碑:墓碑是使用者早就刪掉、只等伺
  // 服器 ack 的空殼，純尾端裁切會為了留住它而砍掉使用者真的看得到的紀錄。
  let capped = evictTombstonesForCount(list);
  capped = capped.length > HISTORY_MAX_ENTRIES ? capped.slice(0, HISTORY_MAX_ENTRIES) : capped;
  capped = evictTombstonesForBudget(capped);

  // 單次 O(n) 前向累加，避免逐筆 pop + 重算整串 JSON 的 O(n^2)。
  const budgeted = [];
  let bytes = 2; // '[]' 外框
  for (let i = 0; i < capped.length; i++) {
    const itemBytes = JSON.stringify(capped[i]).length + 1; // +1 近似分隔逗號
    if (budgeted.length > 0 && bytes + itemBytes > STORAGE_SOFT_BUDGET) break;
    bytes += itemBytes;
    budgeted.push(capped[i]);
  }
  // 沒觸發任何裁切時回傳原陣列參照(常態路徑零額外配置;遷移的冪等短路也
  // 依賴這個參照相等)。
  return budgeted.length === list.length ? list : budgeted;
}

// 純函式:從尾端(最舊)往前丟棄墓碑，最多丟 count 筆，其餘原位保留。沒有丟
// 掉任何一筆時回傳原陣列參照。
function dropOldestTombstones(list, count) {
  if (count <= 0) return list;
  const dropped = new Set();
  for (let i = list.length - 1; i >= 0 && dropped.size < count; i--) {
    if (isTombstoneEntry(list[i])) dropped.add(i);
  }
  if (dropped.size === 0) return list;
  return list.filter((item, i) => !dropped.has(i));
}

// 筆數硬保險的墓碑優先淘汰:超量幾筆就先丟幾張最舊的墓碑，仍超量才由呼叫
// 端從尾端砍。
function evictTombstonesForCount(list) {
  if (list.length <= HISTORY_MAX_ENTRIES) return list;
  return dropOldestTombstones(list, list.length - HISTORY_MAX_ENTRIES);
}

// 位元組軟預算的墓碑優先淘汰:估算總量超標時，從最舊的墓碑開始丟到回到預
// 算內(或墓碑丟完為止);仍超標由呼叫端的前向累加從尾端裁。
function evictTombstonesForBudget(list) {
  // 沒有墓碑就沒有可優先淘汰的對象，省下整表估算(常態路徑)。
  let hasTombstone = false;
  for (let i = 0; i < list.length; i++) {
    if (isTombstoneEntry(list[i])) {
      hasTombstone = true;
      break;
    }
  }
  if (!hasTombstone) return list;

  let bytes = 2; // '[]' 外框
  const itemBytes = [];
  for (let i = 0; i < list.length; i++) {
    const size = JSON.stringify(list[i]).length + 1; // +1 近似分隔逗號
    itemBytes.push(size);
    bytes += size;
  }
  if (bytes <= STORAGE_SOFT_BUDGET) return list;

  const dropped = new Set();
  for (let i = list.length - 1; i >= 0 && bytes > STORAGE_SOFT_BUDGET; i--) {
    if (!isTombstoneEntry(list[i])) continue;
    dropped.add(i);
    bytes -= itemBytes[i];
  }
  if (dropped.size === 0) return list;
  return list.filter((item, i) => !dropped.has(i));
}

// 同一個 SW 內的 append 以 promise chain 序列化，避免兩筆同時 read-modify-write
// 互相覆蓋。options 頁的清除/刪除/匯入直接寫 storage.local，與這裡的競態只
// 發生在「清除的同時恰好完成一次淨化」，極罕見且後果僅是多留一筆，接受。
let historyWriteChain = Promise.resolve();

// history 序列鏈的對外入口:同步引擎(sync.js)的每一次讀改寫都掛在這條鏈上，
// 與 recordHistory、兩支遷移串行執行，不互相覆蓋。回傳的 promise 如實反映
// 這一次寫入的成敗(引擎要據此判定這一輪同步算不算成功);鏈本身另外接住錯誤，
// 一次失敗不得讓後續寫入排不進來。
function enqueueHistoryWrite(fn) {
  const run = historyWriteChain.then(fn);
  historyWriteChain = run.catch(() => {});
  return run;
}

// 新紀錄寫入後掛去抖同步(D12):2 秒內連續分享只同步一次，細節在 sync.js。
function notifySyncRecorded() {
  if (!syncEngine) return;
  Promise.resolve(syncEngine.notifyRecorded()).catch((err) => {
    console.warn('[threads-clean-link] 掛去抖同步失敗', err);
  });
}

// extra(選填):author/handle/excerpt/original/removedParams，只有實際
// 擷取到的鍵才會出現(自動路徑見 extractHistoryExtraFields，右鍵路徑組同形
// 訊息後同樣走它)，Object.assign 進條目時不會覆蓋 url/kind/at/seen。
function recordHistory(url, kind, extra) {
  let recorded = false;
  historyWriteChain = historyWriteChain
    .then(async () => {
      if (!hasStorageLocal()) return;
      const settings = await getSettings();
      if (!settings.saveHistory) return;
      const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
      const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
      const now = Date.now();

      // 永久合併(見上方紀錄合併區塊的註解):以 post ID 為鍵全表比對，命中
      // 就合併為一筆並浮到最前(不論相隔多久、不論 handle 是否改名);找不
      // 到同鍵條目才新增一筆。
      const dedupIndex = findDedupIndex(list, url);
      let entry;
      if (dedupIndex !== -1) {
        entry = mergeHistoryEntry(list[dedupIndex], url, kind, now, extra);
      } else {
        // 不就地改動讀出的陣列(對呼叫端/測試 mock 都更不易踩雷)，組新
        // 陣列。extra 放在前面、核心欄位放在後面覆蓋:即使日後呼叫端不慎
        // 把 url/kind/at/seen 也塞進 extra 物件，核心欄位仍會覆蓋回正確值
        // (防未來的加固)。新條目的 seen[] 由本次呼叫自行構造(信任來源，
        // 不需要再過 sanitizeSeenList)。上限裁切統一在下方 capHistoryForStorage
        // 處理。
        entry = applyHistorySchema(
          Object.assign({}, extra, { url, kind, at: now, seen: [{ at: now, kind }] }),
          null,
          now
        );
      }

      // 級聯第二步:失敗卡收編。本次的 original 若是短碼原文，且清單裡有一
      // 張以該短碼原文入庫的失敗卡(當年解析失敗的殘留)，把它併進本次的同
      // 文卡並就地刪除——短碼在這一刻才第一次與貼文對上號。與上一步的同文
      // 合併在同一次 historyWriteChain 內完成，只寫一次 storage。
      const adoptIndex = findOriginalAdoptIndex(list, entry.original, dedupIndex);
      if (adoptIndex !== -1) {
        entry = adoptFailureEntry(entry, list[adoptIndex]);
      }

      // 合併/收編掉的舊條目一律從原位移除(dedupIndex 為 -1 時不會命中任何
      // index，adoptIndex 同理)，本次的條目統一浮到最前。
      const rest = list.filter((item, i) => i !== dedupIndex && i !== adoptIndex);
      let next = [entry].concat(rest);
      // 儲存上限:寫入前把陣列裁到位元組軟預算 + 筆數硬保險內(從尾端/
      // 最舊裁，本次剛寫入的最新一筆永遠保留)。
      next = capHistoryForStorage(next);
      try {
        await chrome.storage.local.set({ [HISTORY_KEY]: next });
      } catch (err) {
        // 配額失敗優雅降級:紀錄不設上限之後，長期使用可能真的把
        // chrome.storage.local 的容量配額(未申請 unlimitedStorage 權限
        // 時仍有總量上限)寫爆。這種情況不重試、不丟例外，只
        // console.warn 留痕跡，本次這筆紀錄就此放棄——不影響複製/淨化
        // 等主功能持續運作。非配額類錯誤(例如 storage API 本身壞掉)
        // 則重新拋出，交給外層 catch 統一以 console.error 記錄，維持
        // 既有「非預期錯誤」的可見度。
        if (isQuotaExceededError(err)) {
          console.warn('[threads-clean-link] 紀錄寫入超出儲存配額，本次略過(不影響複製/淨化功能)', err);
          return;
        }
        throw err;
      }
      recorded = true;
    })
    .catch((err) => {
      console.error('[threads-clean-link] 寫入紀錄失敗', err);
    })
    .then(() => {
      // 真的寫進去才掛去抖:設定關閉、配額爆掉、寫入失敗都不該觸發一次同步。
      if (recorded) notifySyncRecorded();
    });
  return historyWriteChain;
}

// ---- 一次性遷移:既有紀錄整平成永久合併形狀 ----
//
// 【動機】舊版以「url + 5 分鐘視窗」去重，同一篇貼文在使用者手上很可能已
// 經散成好幾張卡(隔天再複製一次多一張、handle 改名前後又各一張、當年解析
// 失敗的短碼原文再一張)。改成永久合併之後，**新**寫入自然只會有一張卡，
// 但既有資料不會自己收斂——這支遷移在 onInstalled 跑一次，把舊資料整平。
//
// 【演算法】讀全表 → 依 historyDedupKey 分組(同一個 postKey 為一組，抽不
// 出貼文代碼的以正規化網址 url:<host><path><query> 自成一組)→ 組內以 at
// 最新的一筆為主卡，欄位新值優先(主卡
// 缺席才依序往較舊的卡取值)、seen[] 取各卡聯集(無 seen 的舊卡以自身 at 補
// 種一筆)按 at 升序裁到最新 SEEN_MAX、主卡的 url/kind/at 原樣保留 → 再掃一
// 輪失敗卡收編(文章卡.original === 失敗卡.url，見 findOriginalAdoptIndex)
// → 寫回。合併後的卡放在該組第一次出現的位置(紀錄是新到舊排列，第一次出
// 現的通常就是主卡本身)，整體時序不被打亂。
//
// 【冪等】已經整平過的資料再跑一次不會有任何變化:單卡組原樣保留(連物件
// 參照都不換)，失敗卡收編後原卡已刪除、第二輪掃不到配對。實作據此在「每
// 一筆都是原參照」時直接短路、連寫回都不做，避免每次更新都對 storage 做一
// 次無意義的整表寫入。
//
// 【競態】走既有的 historyWriteChain 串行，與 recordHistory 的
// read-modify-write 互斥——遷移讀到的必定是完整的表，也不會被同時落盤的新
// 紀錄覆蓋。寫回同樣先過 capHistoryForStorage(合併只會讓資料變少，這裡純
// 粹是不讓任何一條寫入路徑繞過儲存上限防線)。

// 純函式:比較兩筆條目的 at(新到舊)。at 不是有限數字者一律排到最後(那筆
// 時間本身就不可信，不該被選為主卡);刻意不用相減，避免兩個 -Infinity 相
// 減得到 NaN 讓排序結果未定義。
function compareEntryAtDesc(a, b) {
  const av = a && typeof a.at === 'number' && isFinite(a.at) ? a.at : -Infinity;
  const bv = b && typeof b.at === 'number' && isFinite(b.at) ? b.at : -Infinity;
  if (av === bv) return 0;
  return av < bv ? 1 : -1;
}

// 整平多張卡時必須帶過來的雲端身分欄位(見 mergeHistoryGroup)。
const MERGE_CARRY_FIELDS = ['id', 'serverUpdatedAt'];

// 純函式:把同一組(同合併鍵)的多張卡合成一張。單卡組由呼叫端直接原樣保
// 留，不會進到這裡。
function mergeHistoryGroup(group) {
  // Array#sort 穩定:at 相同時維持原陣列順序(新到舊排列下即較新者在前)。
  const ordered = group.slice().sort(compareEntryAtDesc);
  const primary = ordered[0];
  const merged = { url: primary.url, at: primary.at };
  if (primary.kind !== undefined) merged.kind = primary.kind;
  for (let f = 0; f < MERGEABLE_FIELDS.length; f++) {
    const field = MERGEABLE_FIELDS[f];
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i][field] !== undefined) {
        merged[field] = ordered[i][field];
        break;
      }
    }
  }
  // 雲端身分欄位一併帶過來:id 取最新一張有值的卡(整平時憑空換 id 等於在雲
  // 端另開一張卡)，serverUpdatedAt 同理。其餘五個欄位由 migrateHistorySchema
  // 在下一支遷移統一補齊(postKey/original/receivedAt 皆可由整平後的卡推導，
  // dirty 為 true、deletedAt 為 null)。
  for (let s = 0; s < MERGE_CARRY_FIELDS.length; s++) {
    const field = MERGE_CARRY_FIELDS[s];
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i][field] !== undefined) {
        merged[field] = ordered[i][field];
        break;
      }
    }
  }
  merged.seen = unionSeenEvents(ordered.map(entrySeenEvents));
  return merged;
}

// 純函式:整表分組合併。不是物件、或 url 不是字串的條目無從分組，原樣保
// 留在原位(遷移只做合併，不順手清資料;真正的形狀把關在 options 讀取端)。
function mergeHistoryByDedupKey(list) {
  const groups = new Map();
  const slots = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object' || typeof item.url !== 'string') {
      slots.push({ item });
      continue;
    }
    const key = historyDedupKey(item.url);
    const group = groups.get(key);
    if (group) {
      group.push(item);
      continue;
    }
    groups.set(key, [item]);
    slots.push({ key });
  }

  return slots.map((slot) => {
    if (slot.key === undefined) return slot.item;
    const group = groups.get(slot.key);
    // 單卡組原樣保留(同一個物件參照)，冪等短路據此判定。
    return group.length === 1 ? group[0] : mergeHistoryGroup(group);
  });
}

// 純函式:遷移的第二輪——失敗卡收編。文章卡的 original 是短碼原文，且表內
// 有一張 url 恰為該短碼的失敗卡時，把失敗卡併進文章卡並刪除。一張失敗卡
// 只會被收編一次(removed 記錄)。沒有任何配對時回傳原陣列參照，讓冪等短路
// 得以成立。
function adoptFailureEntriesInList(list) {
  const indexByUrl = new Map();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && typeof item.url === 'string' && !indexByUrl.has(item.url)) indexByUrl.set(item.url, i);
  }

  const removed = new Set();
  let next = null;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object' || !isAdoptableOriginal(item.original)) continue;
    const target = indexByUrl.get(item.original);
    if (target === undefined || target === i || removed.has(target)) continue;
    if (!next) next = list.slice();
    next[i] = adoptFailureEntry(next[i], list[target]);
    removed.add(target);
  }
  if (!next) return list;
  return next.filter((item, i) => !removed.has(i));
}

function migrateHistoryMerge() {
  historyWriteChain = historyWriteChain
    .then(async () => {
      if (!hasStorageLocal()) return;
      const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
      const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
      // 空表(首裝)與單卡表必然無可合併，連讀後計算都省。
      if (list.length < 2) return;

      const next = adoptFailureEntriesInList(mergeHistoryByDedupKey(list));
      // 冪等短路:每一筆都是原物件參照(沒有任何一組被合併、沒有任何一張失
      // 敗卡被收編)就不寫回。
      if (next.length === list.length && next.every((item, i) => item === list[i])) return;

      try {
        await chrome.storage.local.set({ [HISTORY_KEY]: capHistoryForStorage(next) });
      } catch (err) {
        // 配額失敗優雅降級，理由同 recordHistory:遷移失敗最多維持舊形狀的
        // 紀錄(仍可正常瀏覽)，不重試、不丟例外、不影響任何主功能。
        if (isQuotaExceededError(err)) {
          console.warn('[threads-clean-link] 紀錄遷移寫入超出儲存配額，本次略過(不影響既有紀錄與主功能)', err);
          return;
        }
        throw err;
      }
    })
    .catch((err) => {
      console.error('[threads-clean-link] 紀錄遷移失敗', err);
    });
  return historyWriteChain;
}

// ---- 一次性遷移:既有紀錄補齊雲端 schema 欄位 ----
//
// 【動機】計劃 4.1 為每筆紀錄新增七個欄位(id/postKey/original/receivedAt/
// dirty/serverUpdatedAt/deletedAt)。新寫入的紀錄由 applyHistorySchema 帶
// 齊，既有庫存則靠這支遷移在 onInstalled 補一次。
//
// 【只補缺席欄位】已具備的欄位一律原封不動——尤其 id(雲端卡片的身分，重新
// 生成等於每次更新都在雲端多開一張卡)與 dirty(dirty:false 代表已同步，重新
// 標髒會讓整表無謂重傳)。
//
// 【冪等】每一筆都已具備七個欄位時，逐筆回傳原物件參照，據此短路、連寫回都
// 不做。畸形條目(非物件、url 非字串)無從算 postKey，整筆原樣保留。
//
// 【競態】與 migrateHistoryMerge／recordHistory 共用 historyWriteChain 串行;
// 掛在 merge 之後執行，整平產生的新卡才補得到欄位。

// 純函式:補齊單筆條目缺席的 schema 欄位。無缺席時回傳原物件參照。
function fillHistorySchema(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') return entry;
  let missing = false;
  for (let i = 0; i < HISTORY_SCHEMA_FIELDS.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(entry, HISTORY_SCHEMA_FIELDS[i])) {
      missing = true;
      break;
    }
  }
  if (!missing) return entry;

  const next = Object.assign({}, entry);
  function fill(field, value) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) next[field] = value;
  }
  fill('id', TCLCore.randomUuid());
  fill('postKey', TCLCore.postKeyOf(next.url));
  fill('original', next.url);
  fill('receivedAt', entryEarliestAt(next));
  // 遷移補齊的資料尚未上傳過，一律標髒;已有 dirty 的條目不動(dirty:false
  // 是「已同步」，重新標髒會讓整表無謂重傳)。
  fill('dirty', true);
  fill('serverUpdatedAt', null);
  fill('deletedAt', null);
  return next;
}

function migrateHistorySchema() {
  historyWriteChain = historyWriteChain
    .then(async () => {
      if (!hasStorageLocal()) return;
      const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
      const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
      if (list.length === 0) return;

      const next = list.map(fillHistorySchema);
      // 冪等短路:每一筆都是原物件參照(沒有任何一筆缺欄位)就不寫回。
      if (next.every((item, i) => item === list[i])) return;

      try {
        await chrome.storage.local.set({ [HISTORY_KEY]: capHistoryForStorage(next) });
      } catch (err) {
        // 配額失敗優雅降級，理由同 migrateHistoryMerge:補欄位失敗最多維持
        // 舊形狀的紀錄(仍可正常瀏覽)，不重試、不丟例外、不影響主功能。
        if (isQuotaExceededError(err)) {
          console.warn('[threads-clean-link] 紀錄欄位遷移寫入超出儲存配額，本次略過(不影響既有紀錄與主功能)', err);
          return;
        }
        throw err;
      }
    })
    .catch((err) => {
      console.error('[threads-clean-link] 紀錄欄位遷移失敗', err);
    });
  return historyWriteChain;
}

// 判斷是否為 chrome.storage.local 配額超限的錯誤:Chrome 對總量配額
// (QUOTA_BYTES)與單筆配額(QUOTA_BYTES_PER_ITEM)超限，都會用開頭包含
// "QUOTA_BYTES" 字樣的錯誤訊息 reject storage.local.set() 回傳的
// Promise。用字串比對辨識而不依賴特定錯誤類別/物件形狀，避免不同瀏覽
// 器或版本的錯誤物件實作差異導致誤判漏接。
function isQuotaExceededError(err) {
  const message = (err && err.message) || String(err || '');
  return /QUOTA_BYTES/i.test(message);
}

// 不信任呼叫端傳入的 url，一律用 TCLCore.SHARE_URL_PATTERN 重新驗證，
// 不符合就直接拒絕、不對外發送任何請求。
async function handleResolveShareMessage(message) {
  const shareUrl = message && message.url;

  if (typeof shareUrl !== 'string' || !TCLCore.SHARE_URL_PATTERN.test(shareUrl)) {
    return { ok: false, reason: 'invalid-url' };
  }

  let finalUrl, ogFields;
  try {
    const resolved = await resolveFinalUrl(shareUrl);
    finalUrl = resolved.finalUrl;
    ogFields = resolved.ogFields;
  } catch (err) {
    console.error('[threads-clean-link] (bridge) 解析短連結失敗', err);
    return { ok: false, reason: 'network-error' };
  }

  const cleanUrl = extractCleanPostUrl(finalUrl);
  if (!cleanUrl) {
    return { ok: false, reason: 'format-error' };
  }

  // og 資訊透過快取橋接到之後才會抵達的 cleanedNotice(見
  // handleCleanedNotice → fetchOgFieldsForLocalKind → peekOgFields)，這條
  // 訊息通道的回應形狀不變，不需要多帶欄位、也不需要改動 guard/bridge 的
  // 訊息協定。
  cacheOgFields(cleanUrl, ogFields);

  return { ok: true, cleanUrl };
}

// 對短連結發一次匿名(不帶 cookie)請求並跟隨轉址，只取最終網址。
// 用 GET 而非 HEAD:匿名 HEAD 常不回傳 302、或會先跳驗證頁，
// GET + redirect:'follow' 較穩定。share 與右鍵路徑共用同一個 resolver，
// 回傳值除了 finalUrl，也附上這次順手從同一個 response 擷取到的 og 資
// 訊(見上方 og 擷取區塊)，兩條呼叫路徑各自決定怎麼用(menu 路徑直接把
// ogFields 餵給 extractHistoryExtraFields;share 路徑經
// handleResolveShareMessage 寫入 og 快取橋接)。
async function resolveFinalUrl(shareUrl) {
  const response = await fetch(shareUrl, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    // og:title 的語系鎖定，見 OG_FETCH_HEADERS。只影響本次背景請求擷取到
    // 的 og 內容，轉址跟隨(finalUrl)的行為不受影響。
    headers: OG_FETCH_HEADERS,
  });
  const finalUrl = response.url;

  // og:description/og:title(短碼解析路徑順手擷取，同一 response，零額
  // 外請求):讀取失敗(非文字回應、body 已消費等)一律容錯為空物件，不
  // 影響 finalUrl 本身的既有行為——og 擷取純屬錦上添花，絕不能讓解析流
  // 程本身失敗。改讀 response.text() 之後不再需要另外 cancel() 未讀取
  // 的 body 串流(body 已經被完整消費)。
  let ogFields = {};
  try {
    const text = await response.text();
    ogFields = sanitizeOgFields(extractOgFields(text));
  } catch (err) {
    console.error('[threads-clean-link] 讀取回應內容擷取 og 資訊失敗', err);
  }

  return { finalUrl, ogFields };
}

// 最終網址符合貼文格式才回傳乾淨網址(去掉整段 query 與 hash)，否則回傳 null。
function extractCleanPostUrl(finalUrl) {
  const match = CLEAN_POST_URL_PATTERN.exec(finalUrl);
  return match ? match[0] : null;
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
