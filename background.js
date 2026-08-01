'use strict';

// Threads 分享短連結格式,例如:https://www.threads.com/share/AbCdEfGhI
const SHARE_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/share\/.+/i;

// 乾淨貼文網址格式,例如:https://www.threads.com/@username/post/AbCd123EfGh
const CLEAN_POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[^/?#]+\/post\/[^/?#]+/i;

const CONTEXT_MENU_ID = 'threads-clean-link-resolve';
const NOTIFICATION_ICON = 'icons/icon128.png';

// --- 事件監聽器一律註冊在檔案最外層 ---
// SW 閒置幾十秒會被終止,狀態不能靠全域變數存活;
// 監聽器必須在每次喚醒時同步掛回去,不能包在其他非同步流程裡面。

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: '複製乾淨的 Threads 貼文連結',
    contexts: ['link'],
    targetUrlPatterns: [
      'https://www.threads.com/share/*',
      'https://www.threads.net/share/*',
    ],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // onClicked 的回呼是同步事件簽章,這裡用 .catch 包住整段非同步流程,
  // 確保任何錯誤都被攔截,不會變成未捕捉的 Promise rejection。
  handleShareLinkClick(info, tab).catch((err) => {
    console.error('[threads-clean-link] 未預期的錯誤', err);
    safeNotify('threads-clean-link-unexpected', '發生未預期的錯誤,請稍後再試一次。');
  });
});

// --- 核心流程 ---

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
      '解析短連結失敗,請確認網路連線後再試一次。'
    );
    return;
  }

  const cleanUrl = extractCleanPostUrl(finalUrl);
  if (!cleanUrl) {
    safeNotify(
      'threads-clean-link-format-error',
      '轉址結果不是貼文網址,短連結可能已失效或 Threads 網址格式已變動。'
    );
    return;
  }

  if (!tab || tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) {
    safeNotify(
      'threads-clean-link-no-tab',
      `已解析出乾淨網址,但找不到可寫入剪貼簿的分頁:${cleanUrl}`
    );
    return;
  }

  try {
    await writeToClipboard(tab.id, cleanUrl);
  } catch (err) {
    console.error('[threads-clean-link] 寫入剪貼簿失敗', err);
    safeNotify(
      'threads-clean-link-clipboard-error',
      `目前分頁無法寫入剪貼簿(可能是瀏覽器限制頁面),乾淨網址為:${cleanUrl}`
    );
    return;
  }

  safeNotify('threads-clean-link-success', `已複製乾淨網址:${cleanUrl}`);
}

// 對短連結發一次匿名(不帶 cookie)請求並跟隨轉址,只取最終網址。
// 用 GET 而非 HEAD(補強 1):匿名 HEAD 有時不給 302、或會先跳驗證頁,
// GET + redirect:'follow' 較穩;不需要讀取 body,省流量。
async function resolveFinalUrl(shareUrl) {
  const response = await fetch(shareUrl, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
  });
  return response.url;
}

// 最終網址符合貼文格式才回傳乾淨網址(去掉整段 query 與 hash),否則回傳 null。
function extractCleanPostUrl(finalUrl) {
  const match = CLEAN_POST_URL_PATTERN.exec(finalUrl);
  return match ? match[0] : null;
}

// SW 沒有 DOM,寫剪貼簿必須注入目前分頁執行。
// 若分頁是 chrome:// 等受限頁面,executeScript 會直接 reject,
// 交由呼叫端的 try/catch 轉成使用者看得懂的錯誤通知。
async function writeToClipboard(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (value) => navigator.clipboard.writeText(value),
    args: [text],
  });
}

// 成功回饋(補強 2)與錯誤處理(補強 3)統一走這裡,
// notifications API 本身出錯也不讓整個流程炸掉。
function safeNotify(id, message) {
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title: 'Threads 乾淨連結',
      message,
    });
  } catch (err) {
    console.error('[threads-clean-link] 建立通知失敗', err);
  }
}
