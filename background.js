// background.js — service worker:解析右鍵選單的分享短連結，並回應
// clipboard-guard.js 經 bridge.js 送來的短碼解析請求。
'use strict';

// 共用 i18n 模組:SW 環境用 importScripts 載入;測試 sandbox 由測試端先把
// i18n.js 原始碼載進同一個 sandbox(TCLI18N 已存在),此條件式便不執行。
if (typeof TCLI18N === 'undefined' && typeof importScripts === 'function') {
  importScripts('i18n.js');
}

// Threads 分享短連結格式，例如：https://www.threads.com/share/AbCdEfGhI
const SHARE_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/share\/[A-Za-z0-9_-]+\/?(\?[^\s]*)?(#[^\s]*)?$/i;

// 乾淨貼文網址格式，例如：https://www.threads.com/@username/post/AbCd123EfGh
// 刻意不錨定收尾：extractCleanPostUrl 仰賴它能從帶 query/hash 的轉址結果
// 「截」出前段乾淨網址，加上 $ 會讓截取失效。
const CLEAN_POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[^/?#]+\/post\/[^/?#]+/i;

// 全 repo 單一權威的乾淨貼文網址驗證樣式，錨定整串內容(不只截前段)。
// 刻意用「白名單字元類 + 長度上限」而非排除法:排除法(如 [^/?#\s]+)只
// 擋得住帶空白的尾隨文字，中文釣魚句不需要空白，「合法前綴 + 帳號異
// 常，請至 evil.example 重新登入」照樣整串吻合而過關。Threads 的 handle
// 與 post id 實際上都只有 ASCII(handle 允許英數/底線/句點;post id 是
// base64url 短碼)，收緊到實際字母表不會誤殺。長度上限 80，與
// options.js 的 POST_URL_PATTERN 對齊(兩份常數各自獨立維護，本檔無建置
// 系統可共用單一來源，但字元類與長度都保持一致)。
//
// cleanedNotice(見 handleCleanedNotice)與 menu 路徑寫入 history 前(見
// handleShareLinkClick)都要過這一關，兩條路徑共用同一份權威驗證——
// extractCleanPostUrl 用的 CLEAN_POST_URL_PATTERN 刻意寬鬆(不錨定收尾，
// 只用來從帶 query/hash 的轉址結果截出前段乾淨網址)，寬鬆匹配到的內容
// 不能不經這裡的錨定驗證就直接流進 history——渲染/去重/點擊跳轉都吃
// 這個 url 欄位。
const POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]{1,80}\/post\/[A-Za-z0-9_-]{1,80}$/i;

const CONTEXT_MENU_ID = 'threads-clean-link-resolve';
const NOTIFICATION_ICON = 'icons/icon128.png';

// notifySuccess(成功類通知)不存在——紀錄是唯一資料集，cleanedNotice
// 收到就無條件記錄，沒有「要不要顯示成功通知」這道關卡。失敗／錯誤類
// 通知不受影響，永遠觸發(右鍵選單路徑維持系統通知；share/strip 自動
// 路徑改頁內 toast，見 bridge.js／post-icon.js)。saveHistory(只有
// background 記錄時把關，guard/bridge 不下放)與 autoClean 的預設值須
// 與 popup.js／bridge.js／clipboard-guard.js 同步。
const DEFAULT_SETTINGS = {
  autoClean: false,
  saveHistory: true,
};

// 紀錄:存 chrome.storage.local(sync 的 100KB 總額與寫入配額撐不起
// 紀錄量），新到舊排列。上限由 R5 的位元組軟預算 + 筆數硬保險把關(見
// capHistoryForStorage / STORAGE_SOFT_BUDGET / HISTORY_MAX_ENTRIES)，平時
// 就不長到撞配額;萬一仍寫入超限,再走 recordHistory 的 isQuotaExceededError
// 優雅降級(不重試、不丟例外，只 console.warn，不影響複製/淨化等主功能)。
const HISTORY_KEY = 'history';

// 紀錄條目上，author/handle/excerpt 為選填欄位，由複製 icon
// (post-icon.js)或 bridge.js(share/strip 路徑，經 findContainerByCleanUrl
// 就地擷取)順手從貼文容器 DOM 附上。長度上限與手機版 post-meta 的
// EXCERPT_MAX_CHARS 對齊。
const HISTORY_EXCERPT_MAX = 2000;
// author/handle 共用同一個長度上限;兩者性質相近(顯示名稱/帳號代稱)，
// 沒有各自訂上限的必要。
const HISTORY_AUTHOR_MAX = 100;

// original 是使用者實際複製到/觸發時的原始連結(share 短碼原文，或 strip
// 剝參前的原網址)，上限沿用 bridge.js 既有的 MAX_CLEAN_URL_LENGTH 門檻
// (同一種「頁面可控字串」，用同一把尺)。removedParams 是被剝除的追蹤查
// 詢參數清單，型別對齊手機版 hunandy14/meta-link-clearer 的 RemovedParam
// ({ key, value }，實測 gh api 讀 src/lib/link-cleaner.ts:171 確認)。上限
// 與單筆長度沿用一般追蹤參數(如 xmt/utm_*)的合理範圍，防惡意超長
// payload。
const HISTORY_ORIGINAL_MAX = 2048;
const REMOVED_PARAMS_MAX = 20;
const REMOVED_PARAM_KEY_MAX = 64;
const REMOVED_PARAM_VALUE_MAX = 512;

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
// (此依賴關係已於 0.5.0 以 CDP 實機驗證:重載擴充功能後只重注入
// bridge/i18n/post-icon，舊 guard 的 share/strip 路徑照常記錄成功。)
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
// 固定了,不會自己跟著語言變)。監聽器掛最外層,SW 喚醒時重新掛回。
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

// 核心流程

async function handleShareLinkClick(info, tab) {
  const shareUrl = info.linkUrl;

  if (!shareUrl || !SHARE_URL_PATTERN.test(shareUrl)) {
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
  // 寫入前用全 repo 單一權威的 POST_URL_PATTERN 錨定驗一次(見上方註解:
  // extractCleanPostUrl 用的 CLEAN_POST_URL_PATTERN 刻意寬鬆，寬鬆匹配
  // 到的內容不該不經檢查就流進 history);不符合就只略過記錄
  // (console.warn)，不影響已經完成的剪貼簿複製。
  if (POST_URL_PATTERN.test(cleanUrl)) {
    // R2-b 四路徑落盤收斂:menu 路徑把手上的 original(使用者右鍵點擊的短
    // 碼)與 removedParams(finalUrl 淨化前後的查詢參數差集)組成與
    // cleanedNotice 同形的訊息物件，連同 resolveFinalUrl 同一 response 順手
    // 擷取到的 ogFields，一起餵給共用的組裝函式 extractHistoryExtraFields
    // ——share/strip/icon/menu 四條路徑收斂成「一個組裝函式 +一個
    // recordHistory 入口」。menu 不經 guard/bridge，沒有 DOM 擷取的
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
// kind 同屬頁面可控輸入,白名單驗證(自動路徑只可能是 share/strip/icon),
// 非法即整則忽略——guard 與 background 同版本出貨,沒有相容性負擔,
// 形狀不對就是偽造或損毀,fail-safe 丟棄。'menu' 刻意不在此白名單內:
// 它只由 handleShareLinkClick(右鍵選單路徑)直接呼叫 recordHistory,
// 不透過本訊息通道，避免頁面腳本偽造 kind:'menu' 混充右鍵來源。收到合法
// notice 就無條件記錄一筆，author/handle/excerpt 為選填欄位一併寫入。
//
// og 取得統一(R2-a，刪雙策略):所有 kind 一律走 fetchOgFieldsForLocalKind
// ——它先 peek 快取。share 路徑會命中 handleResolveShareMessage 解析短碼時
// 剛寫入的快取(零額外 fetch);strip/icon 這兩條 kind 不像 share 那樣本來
// 就會 fetch 貼文頁，快取未命中時才真的補一次 fetch(見
// fetchOgFieldsForLocalKind，含節流/逾時/失敗回退)。剪貼簿/複製體感完全
// 不受影響，那是 content script 端(clipboard-guard.js／post-icon.js)早就
// 完成的事，這裡只是延後「記錄」這個步驟——刻意不做「先落盤、og 到了再補
// 寫」:二次寫入會落在同一個去重視窗內，mergeHistoryEntry 會多長一筆假的
// seen 事件(同一次複製動作被算成兩次解析)，污染時間軸。寧可讓記錄晚最多
// 2.5 秒落盤，也不要污染資料。
async function handleCleanedNotice(message) {
  const cleanUrl = message && message.cleanUrl;
  if (typeof cleanUrl !== 'string' || !POST_URL_PATTERN.test(cleanUrl)) {
    return;
  }
  const kind =
    message.kind === 'share' || message.kind === 'strip' || message.kind === 'icon'
      ? message.kind
      : null;
  if (!kind) {
    return;
  }

  // cr中1 省請求閘:進 fetch 之前先讀一次設定,saveHistory 關閉時直接
  // return——連 recordHistory 都不呼叫,更不觸發 fetchOgFieldsForLocalKind
  // 那次為了補 og 而發的網路請求(解析結果反正會被 recordHistory 內部的
  // saveHistory 把關丟棄,先擋在這裡就省掉整個 fetch)。對齊 guard 端 share
  // 路徑已有的省請求閘(bridge.js 下放 saveHistory 讓 clipboard-guard.js 在
  // saveHistory 關閉時連 resolveShare 都不發)。recordHistory 內部仍保留各
  // 自的 saveHistory 權威把關(menu 路徑沒有這道前置閘,靠內部那道),此處
  // 純粹是為了省掉 og 補強的 fetch。
  const settings = await getSettings();
  if (!settings.saveHistory) {
    return;
  }

  // R2-a og 取得統一(刪雙策略):所有 kind 一律走 fetchOgFieldsForLocalKind
  // ——它先 peek 快取,share 路徑會命中 handleResolveShareMessage 剛寫入的
  // 快取(零額外 fetch);strip/icon 快取未命中才真的 fetch 貼文頁。快取一
  // 律 peek+TTL(見 peekOgFields),不再有「share 走 takeOgFields、local 走
  // preloadedOgFields」的雙策略。share 複製後超過 TTL 才觸發 notice 的極端
  // 情況,從「不補 og」變成「補一次 fetch」(變好)。
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
// ogFields(R2-a 統一後的第三參數):og 一律由呼叫端先取好再傳進來，這裡
// 不自己查快取(takeOgFields 已隨雙策略一併刪除)。四條落盤路徑的 og 來
// 源各異但形狀一致——share 路徑來自快取 peek、strip/icon 來自貼文頁
// fetch(兩者都經 fetchOgFieldsForLocalKind，見 handleCleanedNotice)、menu
// 來自 resolveFinalUrl 同一 response(見 handleShareLinkClick)——統一從這
// 個參數進來(可能是 null/空物件，代表逾時/失敗/沒收穫，merge 端會容錯)。
function extractHistoryExtraFields(message, url, ogFields) {
  const extra = {};
  const domAuthor = sanitizeHistoryField(message && message.author, HISTORY_AUTHOR_MAX);
  const domHandle = sanitizeHistoryField(message && message.handle, HISTORY_AUTHOR_MAX);
  const domExcerpt = sanitizeHistoryField(message && message.excerpt, HISTORY_EXCERPT_MAX);

  // code review 修正(FAIL 打回):merge 結果不能直接信任，統一再過一次
  // sanitizeOgFields(見該函式註解)，才寫進 extra。
  const merged = sanitizeOgFields(
    mergeOgIntoFields({ author: domAuthor, handle: domHandle, excerpt: domExcerpt }, ogFields)
  );
  if (merged.author !== undefined) extra.author = merged.author;
  if (merged.handle !== undefined) extra.handle = merged.handle;
  if (merged.excerpt !== undefined) extra.excerpt = merged.excerpt;

  const original = sanitizeOriginalField(message && message.original, HISTORY_ORIGINAL_MAX, url);
  if (original !== undefined) extra.original = original;
  const removedParams = sanitizeRemovedParams(message && message.removedParams);
  if (removedParams !== undefined) extra.removedParams = removedParams;
  return extra;
}

// 非字串一律回傳 undefined(呼叫端據此整欄丟棄);空字串比照非字串同樣
// 丟棄(不落 author:'' 這種空欄位)；其餘字串截斷至 maxLen。
function sanitizeHistoryField(value, maxLen) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, maxLen);
}

// original 選填欄位，規則同 sanitizeHistoryField，額外多一條——截斷
// 「前」若與本次寫入的 cleaned url 完全相同就整欄丟棄:手機版語意是
// 「取與 cleaned 不同者」，相同代表沒有額外資訊(guard 端已經先擋過一
// 次，這裡是信任邊界上的權威判斷，不能只靠上游自律)。
function sanitizeOriginalField(value, maxLen, url) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value === url) return undefined;
  return value.slice(0, maxLen);
}

// removedParams 選填欄位，型別對齊手機版 RemovedParam({ key, value })。
// 上限 REMOVED_PARAMS_MAX 筆，每筆 key 需為非空字串且 ≤
// REMOVED_PARAM_KEY_MAX、value 需為字串(可為空字串)且 ≤
// REMOVED_PARAM_VALUE_MAX，任一不符就整筆丟棄(容忍陣列裡部分項目壞掉，
// 寫法對齊 sanitizeSeenList)。輸入非陣列，或 sanitize 後一筆不剩，回傳
// undefined。
//
// 走訪次數本身也封頂，不是「收滿 REMOVED_PARAMS_MAX 筆合法項目就
// break」——輸入陣列若夾帶大量畸形項目、合法項目很晚才出現，只靠收穫量
// 封頂會把整個超大陣列掃過一輪才停下，等同讓呼叫端能用超大 payload 拖
// 慢處理時間(bridge.js 已在自己那層擋過，這裡仍是縱深防禦，不假設呼叫
// 端一定有先過濾)。用索引界定的迴圈，最多只看前 REMOVED_PARAMS_MAX 筆
// 原始項目，掃描量與收穫量同時封頂在同一個常數。
function sanitizeRemovedParams(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  const scanLimit = Math.min(value.length, REMOVED_PARAMS_MAX);
  for (let i = 0; i < scanLimit; i++) {
    const item = value[i];
    if (!item || typeof item !== 'object') continue;
    if (typeof item.key !== 'string' || item.key.length === 0 || item.key.length > REMOVED_PARAM_KEY_MAX) continue;
    if (typeof item.value !== 'string' || item.value.length > REMOVED_PARAM_VALUE_MAX) continue;
    out.push({ key: item.key, value: item.value });
  }
  return out.length > 0 ? out : undefined;
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

// ---- og:description/og:title 擷取(解析路徑摘要升級，使用者拍板混合
// 制)。實測 threads 貼文頁的 og:description 是全文且連結完整(DOM 顯示
// 層才截斷);og:title 形如「かえで (@kaede.hong) on Threads」。短碼解析
// 路徑(resolveFinalUrl，share 與右鍵路徑共用)本來就 fetch 貼文頁，同一
// response 順手撈，零額外請求。SW 沒有 DOMParser，自行用 regex 抽取 +
// HTML entity 解碼，規則對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/post-meta.ts(ogContent／decodeHtmlEntities／
// parsePostMetaFromHtml 的 Threads 分支，gh api 讀取確認)，額外加上掃描
// 長度上限防 ReDoS(手機版沒有這道防線，是本檔案在 SW 環境下的加固)。----

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

// 前兩式共用的收尾:各自 trim、handle 補回開頭的 @，兩者皆空則回傳
// null(行為與修改前的主式內嵌寫法完全一致)。
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
// author/handle/excerpt 完全一致(沿用 sanitizeHistoryField)。兩種輸入
// 都會經過這裡:
//   1. resolveFinalUrl 擷取到的原始 og 資訊(extractOgFields 的回傳
//      值)，讓兩條呼叫路徑(menu 直接用、share 路徑經 og 快取轉一手)都
//      拿到同一份已經處理過的資料，不必各自重覆寫一次 sanitize。
//   2. code review 修正(FAIL 打回，成因:mergeOgIntoFields 的合併結果
//      沒有再過 sanitizeHistoryField，og 來源的 excerpt/author 可能繞
//      過長度上限直通入庫)：mergeOgIntoFields 只負責「挑值 + 去重比
//      對」，不保證輸出仍在長度上限內——它的兩個輸入理論上都已經各自
//      sanitize 過，但函式本身沒有自我保證，屬於「相信呼叫端」的隱性
//      假設，任何一處疏漏都會讓超長字串直通入庫。四條落盤路徑共用的
//      extractHistoryExtraFields 呼叫 mergeOgIntoFields 後，統一再把結
//      果丟回這裡過一次同一把尺——順序是「先在 mergeOgIntoFields 內完
//      成 author===handle 去重比對，這裡才截斷」，避免截斷影響去重判
//      斷的正確性。
function sanitizeOgFields(rawOgFields) {
  const out = {};
  const excerpt = sanitizeHistoryField(rawOgFields && rawOgFields.excerpt, HISTORY_EXCERPT_MAX);
  if (excerpt !== undefined) out.excerpt = excerpt;
  const author = sanitizeHistoryField(rawOgFields && rawOgFields.author, HISTORY_AUTHOR_MAX);
  if (author !== undefined) out.author = author;
  const handle = sanitizeHistoryField(rawOgFields && rawOgFields.handle, HISTORY_AUTHOR_MAX);
  if (handle !== undefined) out.handle = handle;
  return out;
}

// og 資訊與既有欄位(DOM 擷取或缺席)的合併規則。使用者拍板混合制，PM
// 追查手機實作(gh api 讀 src/lib/post-meta.ts 確認手機沒有這個問題:
// 手機從不做 DOM 擷取，一律靠 og:title 解析，不存在「DOM 版作者其實是
// username」這個本檔案獨有的資料品質問題，故手機端無對應防禦可抄，以下
// 為本檔案針對此問題的裁決)後追加修訂:web DOM 抓到的「作者」實為
// username——與 handle 同源、是錯值不是缺席，og:title 解析出的顯示名稱
// 優先蓋過，不是「新值優先、缺席才沿用」這種對等合併:
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
// 一律走 peekOgFields(窺視不刪，見下方，R2-a 統一為 peek+TTL 後不再有
// takeOgFields 那種取用即刪的路徑);上限與 TTL 防止使用者複製後遲遲不觸
// 發 cleanedNotice 時無限累積或用到過期資料。menu 路徑不經這個快取，
// resolveFinalUrl 的回傳值直接同步使用。
const OG_CACHE_MAX = 20;
const OG_CACHE_TTL_MS = 60 * 1000;
// F3 負快取短 TTL:og 抓不到(空結果)存負快取,避免同一貼文每次事件都重跑
// 一次 2.5s fetch;但比正快取短很多,讓「站方稍後補上 og」或「暫時性抓取
// 失敗」有機會在不久後重試,不被卡滿整個 60 秒。
const OG_NEGATIVE_TTL_MS = 10 * 1000;
// F3 負快取標記:空結果不是「沒有這筆快取」,而是「查過了,確實沒有 og」。
// 用一個獨一無二的 sentinel 與正常 og 物件區分,peek 到它時呼叫端一律當
// 作 null(沒收穫)處理,但不會因此再發一次 fetch。
const OG_NEGATIVE = { __tclNegativeOg: true };
const ogFieldsCache = new Map();
// F3 in-flight 去重:同一 cleanUrl 正在跑的 fetch promise,連點 icon 時第二
// 次事件直接接同一個 promise,不重複發 fetch。完成後(finally)就地移除。
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
  // 真 LRU:set 前先 delete,讓「重新被碰到」的 key 移到 Map 迭代序尾端
  // (最新),size 超限時淘汰的 keys().next()(最舊)才是真正最久沒用到的
  // 那筆,而不是最早插入但可能剛被讀取過的那筆。
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

// 窺視快取但不刪(R2-a 統一後,share/strip/icon 全部經由
// fetchOgFieldsForLocalKind 走這個 peek 入口):同一個 cleanUrl 在
// OG_CACHE_TTL_MS 視窗內的多次事件都能重用同一份快取(見下方
// fetchOgFieldsForLocalKind 的節流)，不能第一次讀到就把快取清空。share
// 路徑的 cleanedNotice 命中的正是 resolveShare 剛寫入的這份快取——peek
// 到就零額外 fetch。負快取(空結果,見 fetchOgFieldsForLocalKind 的
// NEGATIVE_OG 標記)也一律先由這裡撈出,呼叫端據此判斷是否短路。
function peekOgFields(cleanUrl) {
  const entry = ogFieldsCache.get(cleanUrl);
  if (!entry) return null;
  const ttl = typeof entry.ttl === 'number' ? entry.ttl : OG_CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    // 過期就地清掉,不留給 LRU 慢慢淘汰,順手讓快取只保有有效項目。
    ogFieldsCache.delete(cleanUrl);
    return null;
  }
  return entry.ogFields; // 正常 og 物件,或 OG_NEGATIVE(負快取 sentinel)
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
// 節流(三層,F3 加固):
//   1. 快取命中(peekOgFields，窺視不刪):同一 cleanUrl 在 TTL 內的正快取
//      直接回傳、不重複 fetch;負快取(OG_NEGATIVE)命中則回傳 null 但同樣
//      不 fetch——og 抓不到的貼文在短 TTL 內不再每次重跑 2.5s fetch。
//   2. in-flight 去重(ogInflight):同一 cleanUrl 已有 fetch 在跑,連點 icon
//      的第二次事件直接接同一個 promise,不發第二次 fetch;完成後就地換成
//      結果(靠快取)並從 ogInflight 移除。
//   3. 每次呼叫各自的逾時競速:即使接了別人的 in-flight promise,自己這次
//      事件仍最多等 OG_LOCAL_FETCH_TIMEOUT_MS 就 fail-open 回 null。
// 逾時或 fetch 失敗一律回傳 null，呼叫端 fail-open 退回 DOM 版欄位，離線也
// 不影響紀錄照常落盤——逾時之後 fetch 仍在背景跑完的話，結果照樣存回快取
// (正或負)供下一次事件重用(這次事件用不到，但沒有浪費)。
async function fetchOgFieldsForLocalKind(cleanUrl) {
  const cached = peekOgFields(cleanUrl);
  // 正快取回傳結果;負快取(sentinel)回傳 null(沒收穫但不再 fetch)。
  if (cached !== null) return cached === OG_NEGATIVE ? null : cached;

  // in-flight 去重:已有同 cleanUrl 的 fetch 在跑就共用,否則起一個新的並
  // 登記到 ogInflight。fetch 完成後把結果寫回快取(正或負),供後續事件經
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

// ---- 紀錄去重合併(語意對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/share-history-storage.ts:DEDUP_WINDOW_MS／mergeDuplicateItem)。
// 同一次分享常見走多條路徑(右鍵選單／自動偵測／貼文互動列複製 icon)，
// 以「乾淨網址在時間視窗內重複寫入」合併為一筆，讓使用者看到的歷史永遠
// 只有一筆，而不是同一篇貼文洗版。----

// 去重視窗:與手機版 DEDUP_WINDOW_MS 對齊，5 分鐘內同一個 url 視為同一
// 次分享。
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// seen[] 上限:防單一熱門連結無限累積解析紀錄，與手機版 SEEN_AT_MAX
// 對齊。
const SEEN_MAX = 50;

// seen[].kind 白名單，與淨化紀錄本身的 kind 白名單同一組('menu' 屬右鍵
// 選單路徑，額外算進來——handleCleanedNotice 的白名單不含 'menu' 是因為
// 那條路徑不經這個訊息通道，但 kind 值本身在 seen[] 裡是合法的)。
const SEEN_KIND_WHITELIST = ['share', 'strip', 'icon', 'menu'];

// 純函式:在既有清單中找出「同一個 url 且在去重視窗內」的條目 index，
// 找不到回傳 -1。與手機版 mergeDuplicateItem 內的 findIndex 對齊(手機版
// 比對 cleaned，這裡的 url 是同一個概念——recordHistory 呼叫端一律已傳
// 入驗證通過的乾淨網址)。
function findDedupIndex(list, url, now) {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && item.url === url && typeof item.at === 'number' && now - item.at <= DEDUP_WINDOW_MS) {
      return i;
    }
  }
  return -1;
}

// 純函式:seen[] 逐筆 sanitize——at 需為有限數字，任一不符就整筆丟棄(容
// 忍陣列裡部分項目壞掉，不因此讓整個陣列作廢)。kind 是選填標籤:缺席時
// 直接保留(只剩 at)，因為手機版「補種起始紀錄」的種子記錄
// (`{ at: existing.receivedAt }`，見 mergeHistoryEntry)本來就沒有來
// 源標籤，UI 時間軸端已經容忍這種缺 kind 的記錄——kind 若有出現則必須
// 在白名單內，不在白名單就整筆丟棄。輸入非陣列一律回傳空陣列。寫入
// storage 前(合併路徑，見 mergeHistoryEntry)與 options.js 的匯入合併
// 都要過這關，防止偽造/損毀的 seen 資料混進去——seen 來源是「先前已經
// 落盤的資料」，可能被匯入檔或未來版本的存放格式汙染，不能照單全收。
function sanitizeSeenList(seen) {
  if (!Array.isArray(seen)) return [];
  const out = [];
  for (const record of seen) {
    if (!record || typeof record !== 'object') continue;
    if (typeof record.at !== 'number' || !Number.isFinite(record.at)) continue;
    if (record.kind === undefined) {
      out.push({ at: record.at });
      continue;
    }
    if (typeof record.kind !== 'string' || SEEN_KIND_WHITELIST.indexOf(record.kind) === -1) continue;
    out.push({ at: record.at, kind: record.kind });
  }
  return out;
}

// 純函式:把本次的 kind/extra 併入既有條目 existing，回傳全新的條目物件
// (不改動 existing，也不假設 existing 形狀完全乾淨——只挑用得到的欄
// 位，其餘未知欄位自然被丟棄，等同順手做了一次縱深防禦)。
//   - at 更新為 now(浮到最新，呼叫端負責把回傳的條目移到陣列最前)。
//   - kind 更新為本次來源(卡片徽章顯示最近一次解析路徑)。
//   - author/handle/excerpt/original/removedParams:本次 extra 有值就用
//     本次的，本次缺席才沿用 existing 的舊值(新值優先，但不能讓「這次
//     沒抓到」蓋掉「上次抓到的」)，五個欄位規則一致。
//   - seen[]:existing.seen 若已存在就照樣過 sanitizeSeenList;existing.seen
//     缺席(schema 升級前寫入的舊資料)時，照手機版語意
//     (`existing.seen ?? [{ at: existing.receivedAt }]`)補種一筆起始
//     紀錄 [{ at: existing.at }]，讓時間軸看得到條目原本第一次出現的
//     時間;種子記錄不帶 kind(那一刻沒有對應的來源事件，UI 時間軸端已
//     容忍缺 kind 標籤)，再 append 本次 {at: now, kind}，裁到最新
//     SEEN_MAX 筆。
function mergeHistoryEntry(existing, url, kind, now, extra) {
  const author = extra && extra.author !== undefined ? extra.author : existing.author;
  const handle = extra && extra.handle !== undefined ? extra.handle : existing.handle;
  const excerpt = extra && extra.excerpt !== undefined ? extra.excerpt : existing.excerpt;
  const original = extra && extra.original !== undefined ? extra.original : existing.original;
  const removedParams =
    extra && extra.removedParams !== undefined ? extra.removedParams : existing.removedParams;
  const priorSeen = Array.isArray(existing.seen)
    ? sanitizeSeenList(existing.seen)
    : [{ at: existing.at }];
  const seen = priorSeen.concat([{ at: now, kind }]).slice(-SEEN_MAX);

  const merged = { url, kind, at: now, seen };
  if (author !== undefined) merged.author = author;
  if (handle !== undefined) merged.handle = handle;
  if (excerpt !== undefined) merged.excerpt = excerpt;
  if (original !== undefined) merged.original = original;
  if (removedParams !== undefined) merged.removedParams = removedParams;
  return merged;
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

// ---- R5 儲存上限(PM 代決方案):位元組軟預算 + 筆數硬保險 ----
//
// chrome.storage.local 未申請 unlimitedStorage 權限時的總量配額約 10MB
// (QUOTA_BYTES = 10485760)。這裡設 8MB 軟預算,刻意留約 2MB 餘裕給 sync
// 設定的鏡像、options 匯入時的暫態、以及單次突發的較大 payload,不把配額
// 用滿到邊界。既有的 isQuotaExceededError 降級(見下方 set 的 catch)保留當
// 最後一道防線——軟預算是「平時就不長到那麼大」,配額降級是「萬一還是爆了
// 也不炸」。
const STORAGE_SOFT_BUDGET = 8 * 1024 * 1024;
// 筆數硬保險:即使每筆都很小、位元組遠不到軟預算,也不讓陣列無限長(渲染/
// 去重掃描都是 O(n))。10000 筆是「正常使用永遠碰不到、異常暴衝才會撞上」
// 的量級。軟預算與硬保險兩者取先觸發者:capHistoryForStorage 先砍筆數上
// 限、再用軟預算裁位元組,最終陣列同時滿足兩個約束。
const HISTORY_MAX_ENTRIES = 10000;

// 把待寫入的紀錄陣列(新到舊排列,index 0 最新)裁到儲存上限內:筆數超過
// HISTORY_MAX_ENTRIES 先從尾端(最舊)砍;再從最新往最舊累加估算序列化位元
// 組,超過 STORAGE_SOFT_BUDGET 就不再收更舊的條目(同樣等於從尾端裁)。位
// 元組以 JSON.stringify(...).length 近似(ASCII 相符;多位元組字元會低估,由
// 2MB 餘裕吸收)。永遠至少保留最新一筆,不會把本次剛寫入的紀錄也裁掉。
function capHistoryForStorage(list) {
  const capped = list.length > HISTORY_MAX_ENTRIES ? list.slice(0, HISTORY_MAX_ENTRIES) : list;

  // 單次 O(n) 前向累加,避免逐筆 pop + 重算整串 JSON 的 O(n^2)。
  const budgeted = [];
  let bytes = 2; // '[]' 外框
  for (let i = 0; i < capped.length; i++) {
    const itemBytes = JSON.stringify(capped[i]).length + 1; // +1 近似分隔逗號
    if (budgeted.length > 0 && bytes + itemBytes > STORAGE_SOFT_BUDGET) break;
    bytes += itemBytes;
    budgeted.push(capped[i]);
  }
  // 沒觸發任何裁切時回傳原陣列參照(常態路徑零額外配置)。
  return budgeted.length === list.length ? list : budgeted;
}

// 同一個 SW 內的 append 以 promise chain 序列化,避免兩筆同時 read-modify-write
// 互相覆蓋。options 頁的清除/刪除/匯入直接寫 storage.local,與這裡的競態只
// 發生在「清除的同時恰好完成一次淨化」,極罕見且後果僅是多留一筆,接受。
let historyWriteChain = Promise.resolve();

// extra(選填):author/handle/excerpt/original/removedParams，只有實際
// 擷取到的鍵才會出現(自動路徑見 extractHistoryExtraFields，右鍵路徑組同形
// 訊息後同樣走它)，Object.assign 進條目時不會覆蓋 url/kind/at/seen。
function recordHistory(url, kind, extra) {
  historyWriteChain = historyWriteChain
    .then(async () => {
      if (!hasStorageLocal()) return;
      const settings = await getSettings();
      if (!settings.saveHistory) return;
      const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
      const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
      const now = Date.now();

      // 去重合併(語意對齊手機版，見上方 findDedupIndex/mergeHistoryEntry
      // 註解):同一個 url 在 DEDUP_WINDOW_MS 內重複寫入，合併為一筆並浮
      // 到最前;視窗外或找不到同 url 條目才新增一筆。
      const dedupIndex = findDedupIndex(list, url, now);
      let next;
      if (dedupIndex !== -1) {
        const mergedEntry = mergeHistoryEntry(list[dedupIndex], url, kind, now, extra);
        next = [mergedEntry].concat(list.slice(0, dedupIndex), list.slice(dedupIndex + 1));
      } else {
        // 不就地改動讀出的陣列(對呼叫端/測試 mock 都更不易踩雷)，組新
        // 陣列。extra 放在前面、核心欄位放在後面覆蓋:即使日後呼叫端不慎
        // 把 url/kind/at/seen 也塞進 extra 物件，核心欄位仍會覆蓋回正確值
        // (防未來的加固)。新條目的 seen[] 由本次呼叫自行構造(信任來源，
        // 不需要再過 sanitizeSeenList)。上限裁切統一在下方 capHistoryForStorage
        // 處理(R5)。
        const entry = Object.assign({}, extra, { url, kind, at: now, seen: [{ at: now, kind }] });
        next = [entry].concat(list);
      }
      // R5 儲存上限:寫入前把陣列裁到位元組軟預算 + 筆數硬保險內(從尾端/
      // 最舊裁,本次剛寫入的最新一筆永遠保留)。
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
    })
    .catch((err) => {
      console.error('[threads-clean-link] 寫入紀錄失敗', err);
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

// 不信任呼叫端傳入的 url，一律用 SHARE_URL_PATTERN 重新驗證，
// 不符合就直接拒絕、不對外發送任何請求。
async function handleResolveShareMessage(message) {
  const shareUrl = message && message.url;

  if (typeof shareUrl !== 'string' || !SHARE_URL_PATTERN.test(shareUrl)) {
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

// 以字典 key 發通知:每次事件重新解析語言(SW 會休眠,不快取),組好字串
// 再交給 safeNotify。整段盡力而為,語言解析失敗只記錄、不影響呼叫端。
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
