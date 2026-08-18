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

// cleanedNotice 專用的「錨定」樣式(比照 clipboard-guard.js 的 POST_URL_RE)。
// 該訊息的 cleanUrl 來自頁面腳本可自由 postMessage 的管道，內容會直接進到
// 使用者看到的通知訊息，因此必須「整串完全吻合」才採信。
//
// 這裡刻意用「白名單字元類 + 長度上限」而非排除法:排除法(如 [^/?#\s]+)
// 只擋得住帶空白的尾隨文字，中文釣魚句本來就不需要空白，
// 「合法前綴 + 帳號異常，請至 evil.example 重新登入」照樣整串吻合而過關;
// 純英數長串同理。Threads 的 handle 與 post id 實際上都只有 ASCII
// (handle 允許英數、底線、句點;post id 是 base64url 短碼)，收緊到實際
// 字母表不會誤殺，且誤殺的代價只是少一則通知，屬 fail-safe 方向。
// 通知路徑的 cleanUrl 一律是已淨化結果，本來就不帶 query 與 hash。
const NOTICE_CLEAN_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]{1,60}\/post\/[A-Za-z0-9_-]{1,60}$/i;

const CONTEXT_MENU_ID = 'threads-clean-link-resolve';
const NOTIFICATION_ICON = 'icons/icon128.png';

// 使用者變更設定規格:
//   - notifySuccess(成功類通知)整組移除——方案甲(歷史即收藏)之後，淨化
//     紀錄是唯一資料集，cleanedNotice 收到就無條件記錄，不再有「要不要
//     顯示成功通知」這道關卡。失敗／錯誤類通知不受影響，永遠觸發(右鍵
//     選單路徑維持系統通知；share/strip 自動路徑改頁內 toast，見
//     bridge.js／post-icon.js)。
//   - autoClean 預設值改為 false(關閉)。
// saveHistory(淨化紀錄功能鍵，只有 background 記錄時把關會讀，guard/
// bridge 不下放)維持 true。autoClean 的預設值需與 popup.js／bridge.js／
// clipboard-guard.js 同步改動。
const DEFAULT_SETTINGS = {
  autoClean: false,
  saveHistory: true,
};

// 淨化紀錄:存 chrome.storage.local(sync 的 100KB 總額與寫入配額撐不起
// 紀錄量),新到舊排列。使用者拍板:紀錄不設上限(移除原本 1000 筆的裁切)
// ——chrome.storage.local 沒有 unlimitedStorage 權限時仍有總容量配額，
// 寫入超限時走優雅降級(見 recordHistory 的 isQuotaExceededError 分
// 支)，不重試、不丟例外，只 console.warn，不影響複製/淨化等主功能。
// unlimitedStorage 權限之後再議，這裡不新增任何權限。
const HISTORY_KEY = 'history';

// 方案甲(歷史即收藏):淨化紀錄條目上，author/handle/excerpt 為選填欄
// 位，由複製 icon(post-icon.js)或 bridge.js(share/strip 路徑，經
// findContainerByCleanUrl 就地擷取)順手從貼文容器 DOM 附上。長度上限沿
// 用 0.5.0 貼文收藏庫基座原本替 favorites 訂的門檻(PM 核對手機 repo 後
// 裁決，與手機版 post-meta 的 EXCERPT_MAX_CHARS 對齊)，欄位改落在淨化
// 紀錄條目上，常數改名反映新用途。
const HISTORY_EXCERPT_MAX = 2000;
// author/handle 共用同一個長度上限;兩者性質相近(顯示名稱/帳號代稱)，
// 沒有各自訂上限的必要。
const HISTORY_AUTHOR_MAX = 100;

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

// R1-2 通知涵蓋自動路徑:clipboard-guard.js 實際把淨化後內容寫入剪貼簿後，
// 經 bridge.js 送來這則通知。方案甲(歷史即收藏)之後，這是淨化紀錄(唯
// 一資料集)的其中一條入筆路徑，收到合法通知就無條件記錄，不再有
// notifySuccess 這種「要不要顯示通知」的把關(已依使用者變更設定規格
// 整組移除)。
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

  let finalUrl;
  try {
    finalUrl = await resolveFinalUrl(shareUrl);
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
  // 一致;saveHistory 的把關在 recordHistory 內。使用者變更設定規格:
  // 成功類通知(notifySuccess)整組移除，右鍵路徑不再於此發送成功通知，
  // 失敗類通知(上面幾個 notifyByKey 呼叫)不受影響、維持系統通知。
  await recordHistory(cleanUrl, 'menu');
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

// 處理 R1-2 的 cleanedNotice:不信任呼叫端傳入的 cleanUrl，一律用錨定的
// NOTICE_CLEAN_URL_PATTERN 重新驗證整串內容，不符合就靜默忽略、不寫入
// 任何紀錄;紀錄只用驗證通過的字串，不夾帶原文的任何其餘部分。
// kind 同屬頁面可控輸入,白名單驗證(自動路徑只可能是 share/strip/icon),
// 非法即整則忽略——guard 與 background 同版本出貨,沒有相容性負擔,
// 形狀不對就是偽造或損毀,fail-safe 丟棄。'menu' 刻意不在此白名單內:
// 它只由 handleShareLinkClick(右鍵選單路徑)直接呼叫 recordHistory,
// 不透過本訊息通道,避免頁面腳本偽造 kind:'menu' 混充右鍵來源。
//
// 方案甲(歷史即收藏)：淨化紀錄是唯一資料集，成功類通知(notifySuccess)
// 已依使用者變更設定規格整組移除，這裡不再有「要不要顯示通知」的分支
// ——收到合法 notice 就無條件記錄一筆，author/handle/excerpt(複製
// icon／bridge.js 從貼文容器 DOM 順手擷取)為選填欄位，一併寫入。
async function handleCleanedNotice(message) {
  const cleanUrl = message && message.cleanUrl;
  if (typeof cleanUrl !== 'string' || !NOTICE_CLEAN_URL_PATTERN.test(cleanUrl)) {
    return;
  }
  const kind =
    message.kind === 'share' || message.kind === 'strip' || message.kind === 'icon'
      ? message.kind
      : null;
  if (!kind) {
    return;
  }

  recordHistory(cleanUrl, kind, extractHistoryExtraFields(message));
}

// author/handle/excerpt 為選填字串，同屬頁面可控輸入，不信任:型別不是
// string 的一律整欄丟棄(不寫進回傳物件，而非寫入 undefined/空字串)，
// 字串則截斷至各自長度上限。回傳值直接可以 Object.assign 進 history 條
// 目(見 recordHistory)。
function extractHistoryExtraFields(message) {
  const extra = {};
  const author = sanitizeHistoryField(message && message.author, HISTORY_AUTHOR_MAX);
  if (author !== undefined) extra.author = author;
  const handle = sanitizeHistoryField(message && message.handle, HISTORY_AUTHOR_MAX);
  if (handle !== undefined) extra.handle = handle;
  const excerpt = sanitizeHistoryField(message && message.excerpt, HISTORY_EXCERPT_MAX);
  if (excerpt !== undefined) extra.excerpt = excerpt;
  return extra;
}

// 非字串一律回傳 undefined(呼叫端據此整欄丟棄);空字串比照非字串同樣
// 丟棄(不落 author:'' 這種空欄位)；其餘字串截斷至 maxLen。原名
// sanitizeFavoriteField(0.5.0 貼文收藏庫基座)，方案甲重組後改給
// handleCleanedNotice 用，改名反映新用途，邏輯不變。
function sanitizeHistoryField(value, maxLen) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, maxLen);
}

// ---- 淨化紀錄 ----

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

// extra(選填):方案甲新增的 author/handle/excerpt 欄位物件，只有實際
// 擷取到的鍵才會出現(見 extractHistoryExtraFields)，Object.assign 進條
// 目時不會覆蓋 url/kind/at；右鍵選單路徑(handleShareLinkClick)不傳這個
// 參數，行為與新增前完全一致。
function recordHistory(url, kind, extra) {
  historyWriteChain = historyWriteChain
    .then(async () => {
      if (!hasStorageLocal()) return;
      const settings = await getSettings();
      if (!settings.saveHistory) return;
      const stored = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
      const list = Array.isArray(stored && stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
      // 不就地改動讀出的陣列(對呼叫端/測試 mock 都更不易踩雷)，組新陣列
      // (使用者拍板:紀錄不設上限，不再裁切)。extra 放在前面、核心欄位
      // 放在後面覆蓋:即使日後呼叫端不慎把 url/kind/at 也塞進 extra 物
      // 件，核心欄位仍會覆蓋回正確值，不會被外部輸入蓋掉(現況 extra 只
      // 可能是 extractHistoryExtraFields 的回傳值，不會有這三個鍵，此
      // 處屬防未來的加固)。
      const entry = Object.assign({}, extra, { url, kind, at: Date.now() });
      const next = [entry].concat(list);
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
          console.warn('[threads-clean-link] 淨化紀錄寫入超出儲存配額，本次略過(不影響複製/淨化功能)', err);
          return;
        }
        throw err;
      }
    })
    .catch((err) => {
      console.error('[threads-clean-link] 寫入淨化紀錄失敗', err);
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

  let finalUrl;
  try {
    finalUrl = await resolveFinalUrl(shareUrl);
  } catch (err) {
    console.error('[threads-clean-link] (bridge) 解析短連結失敗', err);
    return { ok: false, reason: 'network-error' };
  }

  const cleanUrl = extractCleanPostUrl(finalUrl);
  if (!cleanUrl) {
    return { ok: false, reason: 'format-error' };
  }

  return { ok: true, cleanUrl };
}

// 對短連結發一次匿名(不帶 cookie)請求並跟隨轉址，只取最終網址。
// 用 GET 而非 HEAD:匿名 HEAD 常不回傳 302、或會先跳驗證頁，
// GET + redirect:'follow' 較穩定。
async function resolveFinalUrl(shareUrl) {
  const response = await fetch(shareUrl, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
  });
  const finalUrl = response.url;

  // 取消未讀取的 body 串流以省流量；取消失敗不影響已取得的 finalUrl。
  try {
    await response.body?.cancel();
  } catch (err) {
    console.error('[threads-clean-link] 取消回應 body 失敗', err);
  }

  return finalUrl;
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
