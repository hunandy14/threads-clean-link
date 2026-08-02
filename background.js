// background.js — service worker:解析右鍵選單的分享短連結，並回應
// clipboard-guard.js 經 bridge.js 送來的短碼解析請求。
'use strict';

// Threads 分享短連結格式，例如：https://www.threads.com/share/AbCdEfGhI
const SHARE_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/share\/[A-Za-z0-9_-]+\/?(\?[^\s]*)?(#[^\s]*)?$/i;

// 乾淨貼文網址格式，例如：https://www.threads.com/@username/post/AbCd123EfGh
// 刻意不錨定收尾：extractCleanPostUrl 仰賴它能從帶 query/hash 的轉址結果
// 「截」出前段乾淨網址，加上 $ 會讓截取失效。
const CLEAN_POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[^/?#]+\/post\/[^/?#]+/i;

// cleanedNotice 專用的「錨定」樣式(比照 clipboard-guard.js 的 POST_URL_RE)。
// 該訊息的 cleanUrl 來自頁面腳本可自由 postMessage 的管道，內容會直接進到
// 使用者看到的通知訊息，因此必須「整串完全吻合」才採信：收尾 $ 且字元類
// 排除 \s，否則「合法貼文網址開頭 + 尾隨任意文字」會通過驗證，等同讓頁面
// 操控通知內容。通知路徑的 cleanUrl 一律是已淨化結果，本來就不帶 query
// 與 hash，故此處也不放行 ?/# 尾段。
const NOTICE_CLEAN_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[^/?#\s]+\/post\/[^/?#\s]+$/i;

const CONTEXT_MENU_ID = 'threads-clean-link-resolve';
const NOTIFICATION_ICON = 'icons/icon128.png';

// v1.1 設定規格 S2:成功類通知由 notifySuccess 把關，失敗／錯誤類通知
// 永遠觸發、不受設定影響。R1-1 併開關後只剩兩鍵，預設值與
// popup.js／bridge.js 一致。
const DEFAULT_SETTINGS = {
  autoClean: true,
  notifySuccess: false,
};

// R1-2:自動路徑(clipboard-guard.js 經 bridge.js)成功淨化後的通知，用
// 獨立的通知 id，避免跟右鍵路徑的 threads-clean-link-success 撞 id 被
// Chrome 同 id 互相取代(PM 裁決)。
const AUTOCLEAN_SUCCESS_NOTIFICATION_ID = 'threads-clean-link-autoclean-success';

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

  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: '複製乾淨的 Threads 貼文連結',
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
    safeNotify('threads-clean-link-unexpected', '發生未預期的錯誤，請稍後再試一次。');
  });
});

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
// 經 bridge.js 送來這則通知。background 是唯一同時看得到設定與「右鍵」
// 「自動」兩條成功路徑的地方，notifySuccess 的把關統一放在這裡；guard／
// bridge 端不重複判斷 notifySuccess，只單純轉發「已淨化成功」這件事。
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
    safeNotify('threads-clean-link-invalid', '這不是有效的 Threads 分享短連結。');
    return;
  }

  let finalUrl;
  try {
    finalUrl = await resolveFinalUrl(shareUrl);
  } catch (err) {
    console.error('[threads-clean-link] 解析短連結失敗', err);
    safeNotify(
      'threads-clean-link-network-error',
      '解析短連結失敗，請確認網路連線後再試一次。'
    );
    return;
  }

  const cleanUrl = extractCleanPostUrl(finalUrl);
  if (!cleanUrl) {
    safeNotify(
      'threads-clean-link-format-error',
      '轉址結果不是貼文網址，短連結可能已失效或 Threads 網址格式已變動。'
    );
    return;
  }

  if (!tab || tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) {
    safeNotify(
      'threads-clean-link-no-tab',
      `已解析出乾淨網址，但找不到可寫入剪貼簿的分頁:${cleanUrl}`
    );
    return;
  }

  try {
    await writeToClipboard(tab.id, cleanUrl);
  } catch (err) {
    console.error('[threads-clean-link] 寫入剪貼簿失敗', err);
    safeNotify(
      'threads-clean-link-clipboard-error',
      `目前分頁無法寫入剪貼簿(可能是瀏覽器限制頁面)，乾淨網址為:${cleanUrl}`
    );
    return;
  }

  const settings = await getSettings();
  if (settings.notifySuccess) {
    safeNotify('threads-clean-link-success', `已複製乾淨網址:${cleanUrl}`);
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

// 處理 R1-2 的 cleanedNotice:不信任呼叫端傳入的 cleanUrl，一律用錨定的
// NOTICE_CLEAN_URL_PATTERN 重新驗證整串內容，不符合就靜默忽略、不發任何
// 通知;通知訊息只用驗證通過的字串，不夾帶原文的任何其餘部分。
// notifySuccess 為 false 時整個函式什麼都不做。
async function handleCleanedNotice(message) {
  const cleanUrl = message && message.cleanUrl;
  if (typeof cleanUrl !== 'string' || !NOTICE_CLEAN_URL_PATTERN.test(cleanUrl)) {
    return;
  }

  const settings = await getSettings();
  if (settings.notifySuccess) {
    safeNotify(AUTOCLEAN_SUCCESS_NOTIFICATION_ID, `已自動淨化並複製乾淨網址:${cleanUrl}`);
  }
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

// 統一顯示通知，自身出錯不影響呼叫端流程。create() 未帶 callback 時
// 回傳 Promise，同步 try/catch 接不到非同步 rejection，因此另外對
// 回傳值補一次 .catch，兩者都只記錄、不外拋。
function safeNotify(id, message) {
  try {
    const creating = chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title: 'Threads 乾淨連結',
      message,
    });
    creating?.catch((err) => {
      console.error('[threads-clean-link] 建立通知失敗(非同步)', err);
    });
  } catch (err) {
    console.error('[threads-clean-link] 建立通知失敗', err);
  }
}
