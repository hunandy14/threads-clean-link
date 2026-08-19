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
// 紀錄量），新到舊排列，不設上限——chrome.storage.local 沒有
// unlimitedStorage 權限時仍有總容量配額，寫入超限時走優雅降級(見
// recordHistory 的 isQuotaExceededError 分支)，不重試、不丟例外，只
// console.warn，不影響複製/淨化等主功能。
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
});

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
  // 差集)background 自己手上就有，見 buildMenuHistoryExtra。
  //
  // 寫入前用全 repo 單一權威的 POST_URL_PATTERN 錨定驗一次(見上方註解:
  // extractCleanPostUrl 用的 CLEAN_POST_URL_PATTERN 刻意寬鬆，寬鬆匹配
  // 到的內容不該不經檢查就流進 history);不符合就只略過記錄
  // (console.warn)，不影響已經完成的剪貼簿複製。
  if (POST_URL_PATTERN.test(cleanUrl)) {
    await recordHistory(cleanUrl, 'menu', buildMenuHistoryExtra(shareUrl, finalUrl, cleanUrl, ogFields));
  } else {
    console.warn(
      '[threads-clean-link] 右鍵路徑解析出的網址不符嚴格白名單樣式，略過記錄(不影響已複製到剪貼簿的內容)',
      cleanUrl
    );
  }
}

// 右鍵路徑(menu)專用的 extra 建構:不經 guard/bridge，original(使用者
// 右鍵點擊的短碼連結)與 removedParams(finalUrl 淨化前後的查詢參數差
// 集)background 自身就有，sanitize 規則與 extractHistoryExtraFields
// (自動路徑)共用同一組函式(sanitizeOriginalField/sanitizeRemovedParams)。
// author/handle/excerpt:右鍵路徑不經 guard/bridge，沒有任何 DOM 擷取
// 來源可用，og 資訊(resolveFinalUrl 同一個 response 順手擷取)是這條路
// 徑的唯一來源——existing 傳空物件，merge 規則等同「og 有什麼就收下什
// 麼」(見 mergeOgIntoFields 註解)。
function buildMenuHistoryExtra(shareUrl, finalUrl, cleanUrl, ogFields) {
  const extra = {};
  const original = sanitizeOriginalField(shareUrl, HISTORY_ORIGINAL_MAX, cleanUrl);
  if (original !== undefined) extra.original = original;
  const removedParams = sanitizeRemovedParams(diffRemovedParams(finalUrl, cleanUrl));
  if (removedParams !== undefined) extra.removedParams = removedParams;

  const merged = mergeOgIntoFields({}, ogFields);
  if (merged.author !== undefined) extra.author = merged.author;
  if (merged.handle !== undefined) extra.handle = merged.handle;
  if (merged.excerpt !== undefined) extra.excerpt = merged.excerpt;
  return extra;
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

  recordHistory(cleanUrl, kind, extractHistoryExtraFields(message, cleanUrl));
}

// author/handle/excerpt/original/removedParams 皆為選填欄位，同屬頁面
// 可控輸入(除了右鍵路徑，其餘一律經 guard/bridge 這條 postMessage 管道
// 進來)，不信任:型別不是 string(或 removedParams 不是陣列)的一律整欄
// 丟棄(不寫進回傳物件，而非寫入 undefined/空字串)，字串則截斷至各自長
// 度上限。回傳值直接可以 Object.assign 進 history 條目(見 recordHistory)。
// url 參數是本次寫入的乾淨網址，供 sanitizeOriginalField 判斷 original
// 是否與 cleaned 相同(相同就不存)，也用來查 og 快取(見下方)。
function extractHistoryExtraFields(message, url) {
  const extra = {};
  const domAuthor = sanitizeHistoryField(message && message.author, HISTORY_AUTHOR_MAX);
  const domHandle = sanitizeHistoryField(message && message.handle, HISTORY_AUTHOR_MAX);
  const domExcerpt = sanitizeHistoryField(message && message.excerpt, HISTORY_EXCERPT_MAX);

  // share 路徑若剛好有 resolveShare 階段快取到的 og 資訊(見
  // handleResolveShareMessage／cacheOgFields)，在這裡撈出來合併；
  // strip/icon 兩條 kind 從未觸發過 resolveShare，這個 cleanUrl 對應不
  // 到任何快取條目，takeOgFields 恆回傳 null，merge 結果自然等同「維持
  // DOM 版」，不影響既有行為。
  const ogFields = takeOgFields(url);
  const merged = mergeOgIntoFields({ author: domAuthor, handle: domHandle, excerpt: domExcerpt }, ogFields);
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
function parseOgTitle(ogTitle) {
  if (typeof ogTitle !== 'string' || !ogTitle) return null;
  const trimmed = ogTitle.trim();
  const match = /^(.*?)\s*\(@([^)]+)\)/.exec(trimmed);
  if (match) {
    const author = match[1].trim();
    const handle = match[2].trim();
    const result = {};
    if (author) result.author = author;
    if (handle) result.handle = '@' + handle;
    return result.author || result.handle ? result : null;
  }
  const fallbackAuthor = trimmed.replace(/\s+on Threads$/i, '').trim();
  return fallbackAuthor ? { author: fallbackAuthor } : null;
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

// og 擷取結果統一在這裡過長度上限，規則與既有 author/handle/excerpt 完
// 全一致(沿用 sanitizeHistoryField)，讓兩條呼叫路徑(menu 直接用、share
// 路徑經 og 快取轉一手)都拿到同一份已經處理過的資料，不必各自重覆寫一
// 次 sanitize。
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
// ——兩者是不同時間點的訊息，用一個以 cleanUrl 為 key 的小快取橋接。用
// 過即丟(同一 cleanUrl 短時間內只消費一次，避免累積後被不相關的後續記
// 錄事件誤用);上限與 TTL 防止使用者複製後遲遲不觸發 cleanedNotice 時
// 無限累積或用到過期資料。menu 路徑不經這個快取，resolveFinalUrl 的回
// 傳值直接同步使用。
const OG_CACHE_MAX = 20;
const OG_CACHE_TTL_MS = 60 * 1000;
const ogFieldsCache = new Map();

function cacheOgFields(cleanUrl, ogFields) {
  if (
    !ogFields ||
    (ogFields.excerpt === undefined && ogFields.author === undefined && ogFields.handle === undefined)
  ) {
    return;
  }
  ogFieldsCache.set(cleanUrl, { at: Date.now(), ogFields });
  if (ogFieldsCache.size > OG_CACHE_MAX) {
    const oldestKey = ogFieldsCache.keys().next().value;
    ogFieldsCache.delete(oldestKey);
  }
}

function takeOgFields(cleanUrl) {
  const entry = ogFieldsCache.get(cleanUrl);
  if (!entry) return null;
  ogFieldsCache.delete(cleanUrl);
  if (Date.now() - entry.at > OG_CACHE_TTL_MS) return null;
  return entry.ogFields;
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

// 同一個 SW 內的 append 以 promise chain 序列化,避免兩筆同時 read-modify-write
// 互相覆蓋。options 頁的清除/刪除/匯入直接寫 storage.local,與這裡的競態只
// 發生在「清除的同時恰好完成一次淨化」,極罕見且後果僅是多留一筆,接受。
let historyWriteChain = Promise.resolve();

// extra(選填):author/handle/excerpt/original/removedParams，只有實際
// 擷取到的鍵才會出現(自動路徑見 extractHistoryExtraFields，右鍵路徑見
// buildMenuHistoryExtra)，Object.assign 進條目時不會覆蓋 url/kind/at/seen。
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
        // 陣列，不裁切(紀錄不設上限)。extra 放在前面、核心欄位放在後面
        // 覆蓋:即使日後呼叫端不慎把 url/kind/at/seen 也塞進 extra 物件，
        // 核心欄位仍會覆蓋回正確值(防未來的加固)。新條目的 seen[] 由本次
        // 呼叫自行構造(信任來源，不需要再過 sanitizeSeenList)。
        const entry = Object.assign({}, extra, { url, kind, at: now, seen: [{ at: now, kind }] });
        next = [entry].concat(list);
      }
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
  // handleCleanedNotice／takeOgFields)，這條訊息通道的回應形狀不變，不
  // 需要多帶欄位、也不需要改動 guard/bridge 的訊息協定。
  cacheOgFields(cleanUrl, ogFields);

  return { ok: true, cleanUrl };
}

// 對短連結發一次匿名(不帶 cookie)請求並跟隨轉址，只取最終網址。
// 用 GET 而非 HEAD:匿名 HEAD 常不回傳 302、或會先跳驗證頁，
// GET + redirect:'follow' 較穩定。share 與右鍵路徑共用同一個 resolver，
// 回傳值除了 finalUrl，也附上這次順手從同一個 response 擷取到的 og 資
// 訊(見上方 og 擷取區塊)，兩條呼叫路徑各自決定怎麼用(見
// buildMenuHistoryExtra／handleResolveShareMessage)。
async function resolveFinalUrl(shareUrl) {
  const response = await fetch(shareUrl, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
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
