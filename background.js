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
  createContextMenu().catch((err) => {
    console.error('[threads-clean-link] 建立右鍵選單失敗', err);
  });
});

// 先清空舊選單再建立,避免重新安裝/更新時 id 重複觸發 lastError 雜訊。
// removeAll 失敗也不該擋住後續建立選單,故在此就地接住、只記錄不中斷。
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
  // onClicked 的回呼是同步事件簽章,這裡用 .catch 包住整段非同步流程,
  // 確保任何錯誤都被攔截,不會變成未捕捉的 Promise rejection。
  handleShareLinkClick(info, tab).catch((err) => {
    console.error('[threads-clean-link] 未預期的錯誤', err);
    safeNotify('threads-clean-link-unexpected', '發生未預期的錯誤,請稍後再試一次。');
  });
});

// 車道②:網頁版「複製連結」現在寫的是 /share/ 短碼(不再是帶 ?xmt= 的貼文
// 網址),既有的字串淨化濾網對短碼無用武之地。clipboard-guard.js(MAIN world)
// 經 bridge.js(ISOLATED world)把短碼送來這裡解析,解析完把乾淨網址回傳,
// 由 MAIN world 端自行決定寫入什麼——本路徑不寫剪貼簿、不發通知,純粹是
// 「幫忙問一次伺服器」,靜默升級複製體驗,失敗一律回傳 ok:false 讓對方
// fail-open 用原始短碼放行,不需要在這裡額外做使用者提示。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'resolveShare') {
    return false; // 不是我們認得的訊息類型,不佔用 sendResponse 通道。
  }

  handleResolveShareMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[threads-clean-link] resolveShare 處理失敗', err);
      sendResponse({ ok: false, reason: 'internal-error' });
    });

  return true; // 非同步回應,保持訊息通道開啟直到 sendResponse 被呼叫。
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

// resolveShare 訊息的處理邏輯:不信任 content script 傳來的 url,一律用
// SHARE_URL_PATTERN 在 SW 端重新驗證,不符合就直接拒絕、不對外發任何請求。
// 這把「頁面能透過橋接觸發什麼」壓縮到「對已驗證格式的 threads 短連結做一次
// 匿名解析」,不接受任意網址,詳見 README/回報中的安全評估。
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

// 對短連結發一次匿名(不帶 cookie)請求並跟隨轉址,只取最終網址。
// 用 GET 而非 HEAD(補強 1):匿名 HEAD 有時不給 302、或會先跳驗證頁,
// GET + redirect:'follow' 較穩。只需要 response.url,取到後嘗試主動
// 取消尚未讀取的 body 串流以省流量;取消失敗不影響已經拿到的網址。
async function resolveFinalUrl(shareUrl) {
  const response = await fetch(shareUrl, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
  });
  const finalUrl = response.url;

  try {
    await response.body?.cancel();
  } catch (err) {
    // 取消失敗不影響已取得的 finalUrl,僅記錄。
    console.error('[threads-clean-link] 取消回應 body 失敗', err);
  }

  return finalUrl;
}

// 最終網址符合貼文格式才回傳乾淨網址(去掉整段 query 與 hash),否則回傳 null。
function extractCleanPostUrl(finalUrl) {
  const match = CLEAN_POST_URL_PATTERN.exec(finalUrl);
  return match ? match[0] : null;
}

// SW 沒有 DOM,寫剪貼簿必須注入目前分頁執行。
// 若分頁是 chrome:// 等受限頁面,executeScript 會直接 reject;
// 但注入成功不代表頁面內的 clipboard.writeText 就成功(例如分頁未聚焦
// 時會丟 NotAllowedError),那不保證讓 executeScript 本身 reject,所以
// 注入函式內部要自己 try/catch 並回傳結果物件,由呼叫端檢查後決定是否
// throw,交由既有的錯誤路徑統一處理。
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

// 成功回饋(補強 2)與錯誤處理(補強 3)統一走這裡,
// notifications API 本身出錯也不讓整個流程炸掉。
// create() 未帶 callback 時回傳 Promise,同步 try/catch 接不到非同步
// rejection,因此額外對回傳值補 .catch,兩者都只記錄不外拋。
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
