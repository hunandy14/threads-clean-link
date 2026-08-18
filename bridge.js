// bridge.js — ISOLATED world content script，把 MAIN world(無 chrome.*
// API)的短碼解析請求經 postMessage 轉為 chrome.runtime.sendMessage 送給
// service worker，結果再 postMessage 回 MAIN world。
(function () {
  'use strict';

  var REQ_TYPE = 'TCL_RESOLVE_REQ';
  var RES_TYPE = 'TCL_RESOLVE_RES';

  // R1-2 通知涵蓋自動路徑：MAIN world(clipboard-guard.js)實際把淨化後
  // 內容寫入剪貼簿後，會送一則 TCL_CLEANED_NOTICE 過來，這裡原樣轉發成
  // chrome.runtime.sendMessage(cleanedNotice) 給 service worker。方案甲
  // (歷史即收藏)之後，淨化紀錄是唯一資料集，background 收到就無條件記
  // 錄一筆(不再有 notifySuccess 這種「要不要顯示通知」的把關——成功類
  // 通知已依使用者變更設定規格整組移除，見 background.js)。
  var NOTICE_TYPE = 'TCL_CLEANED_NOTICE';

  // cleanUrl 長度上限:這條管道的內容由頁面腳本自由指定，先在 bridge 擋掉
  // 超長 payload，不讓 100KB 等級的垃圾越過 content script → service worker
  // 的程序邊界。整串形狀的驗證由 background 以錨定樣式負責(信任邊界在該處)。
  var MAX_CLEAN_URL_LENGTH = 2048;

  // kind 標示淨化來源(share/strip)，這裡只做型別與長度把關，白名單驗證
  // 一樣交給 background。形狀不對整則丟棄，不轉發殘缺訊息。
  var MAX_KIND_LENGTH = 16;

  // 使用者變更設定規格:share/strip 的短碼解析在 Threads 頁面內失敗時，
  // 改用頁內 toast 提示(取代原本完全靜默的 fail-open)。真正的 toast 渲
  // 染邏輯(含文案 i18n 對應、樣式、自動消失)在 post-icon.js(同
  // ISOLATED world，document_idle 稍晚載入)，這裡只是執行期守衛後轉呼
  // 叫——TCLPostIcon 可能還沒初始化完成、或使用者的擴充功能是舊版沒有這
  // 個 API，兩種情況都靜默略過，不影響既有的 reply() 轉發流程。孤兒情境
  // (擴充功能已重載，Extension context invalidated)下，本函式呼叫點本
  // 身位於 chrome.runtime.sendMessage 失敗後的分支，理論上 window.TCLPostIcon
  // 這個純 DOM／JS 物件參照仍然存在且可呼叫(orphan 只斷了 chrome.runtime
  // 這條線，不影響同一頁面內已掛好的 window 屬性)，但這不是本車道測試
  // 得到保證的行為，如實記錄為已知限制，不承諾一定能顯示。
  function notifyResolveFailureToast(reason) {
    try {
      if (window.TCLPostIcon && typeof window.TCLPostIcon.showResolveFailureToast === 'function') {
        window.TCLPostIcon.showResolveFailureToast(reason);
      }
    } catch (e) {
      // 顯示失敗不影響其餘橋接流程。
    }
  }

  window.addEventListener('message', function (event) {
    // 只信任「本頁面自己發給自己」的訊息：
    // - source 必須是同一個 window（排除子 iframe / 其他視窗轉發過來的訊息）
    // - origin 必須等於目前頁面的 origin
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === NOTICE_TYPE) {
      if (typeof data.cleanUrl !== 'string' || !data.cleanUrl) return;
      if (data.cleanUrl.length > MAX_CLEAN_URL_LENGTH) return;
      if (typeof data.kind !== 'string' || !data.kind || data.kind.length > MAX_KIND_LENGTH) return;
      try {
        var payload = {
          type: 'cleanedNotice',
          cleanUrl: data.cleanUrl,
          kind: data.kind,
        };
        // 方案甲(歷史即收藏):share/strip 這兩條自動路徑(clipboard-guard.js
        // 經這裡轉發)原本沒有貼文容器可用(clipboard-guard.js 在 MAIN
        // world，不碰 chrome.* API，也不做 DOM 擷取)。轉發前，若
        // post-icon.js(同 ISOLATED world，document_idle 稍晚載入)已經把
        // TCLPostIcon 掛上 window，就地用 findContainerByCleanUrl 找出這
        // 個乾淨網址對應的貼文容器，再用 extractPostInfo 補
        // author/handle/excerpt 進 payload——執行期守衛:TCLPostIcon 理
        // 論上一定會在 bridge.js 之後才完成初始化(manifest content_scripts
        // 陣列順序保證載入順序，但 document_idle 的執行時機不保證），防禦
        // 性地整段包在存在性檢查與 try/catch 裡；找不到容器、擷取不到欄
        // 位、或任何一步丟例外，一律靜默省略，絕不影響既有的轉發流程。
        try {
          if (window.TCLPostIcon && typeof window.TCLPostIcon.findContainerByCleanUrl === 'function') {
            var container = window.TCLPostIcon.findContainerByCleanUrl(data.cleanUrl);
            if (container && typeof window.TCLPostIcon.extractPostInfo === 'function') {
              var info = window.TCLPostIcon.extractPostInfo(container) || {};
              if (info.author !== undefined) payload.author = info.author;
              if (info.handle !== undefined) payload.handle = info.handle;
              if (info.excerpt !== undefined) payload.excerpt = info.excerpt;
            }
          }
        } catch (e) {
          // 擷取失敗不影響轉發，payload 保持只有 cleanUrl/kind 的最小形狀。
        }

        // MV3 下不帶 callback 呼叫 sendMessage 會回傳 Promise：background
        // 的 cleanedNotice 監聽器 return false(同步處理完即關通道)，該
        // Promise 會以「message port closed」reject，不接 .catch 就會在
        // 頁面 console 留下 unhandled promise rejection。回傳值先防禦性
        // 檢查是不是真的 Promise 再接空 .catch 吞掉。
        var maybePromise = chrome.runtime.sendMessage(payload);
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(function () {});
        }
      } catch (e) {
        // 轉發失敗不影響其餘橋接流程：background 端的通知本來就是盡力而為。
      }
      return;
    }

    if (data.type !== REQ_TYPE) return;
    if (typeof data.requestId !== 'string' || !data.requestId) return;
    if (typeof data.url !== 'string' || !data.url) return;

    var requestId = data.requestId;

    function reply(result) {
      try {
        window.postMessage(
          {
            type: RES_TYPE,
            requestId: requestId,
            ok: !!result.ok,
            cleanUrl: result.cleanUrl,
            reason: result.reason,
          },
          window.location.origin
        );
      } catch (e) {
        // 回傳失敗就不回傳；MAIN world 端會在逾時後自行 fail-open。
      }
    }

    try {
      chrome.runtime.sendMessage({ type: 'resolveShare', url: data.url }, function (response) {
        // chrome.runtime.lastError：SW 可能剛好休眠中被喚醒失敗、或訊息通道已
        // 關閉，這不是致命錯誤，單純視為這次解析失敗，交給 MAIN world fail-open。
        var lastErr = chrome.runtime.lastError;
        if (lastErr) {
          var lastErrReason = String((lastErr && lastErr.message) || lastErr);
          reply({ ok: false, reason: lastErrReason });
          notifyResolveFailureToast(lastErrReason);
          return;
        }
        if (response && response.ok && typeof response.cleanUrl === 'string') {
          reply({ ok: true, cleanUrl: response.cleanUrl });
        } else {
          var reason = (response && response.reason) || 'no-response';
          reply({ ok: false, reason: reason });
          notifyResolveFailureToast(reason);
        }
      });
    } catch (e) {
      // sendMessage 同步丟例外（例如擴充功能情境已失效）：直接回報失敗。
      reply({ ok: false, reason: 'bridge-exception' });
      notifyResolveFailureToast('bridge-exception');
    }
  });

  // ------------------------------------------------------------
  // v1.1 設定規格 S6：載入時讀一次 chrome.storage.sync，把設定經
  // postMessage 以 TCL_SETTINGS_PUSH 下放到 MAIN world（clipboard-guard.js
  // 沒有 chrome.* API，只能靠這條管道拿到設定）；chrome.storage.onChanged
  // 觸發時（例如使用者在 popup 切換開關）再次推播最新值。
  // ------------------------------------------------------------

  // R1-1 併開關：resolveShortcode 徹底移除。使用者變更設定規格:
  // notifySuccess(成功類通知)整組移除，clipboard-guard.js 從未真正依它
  // 分支任何邏輯(只是存著)，這裡不再推播這顆鍵；設定只剩 autoClean 一
  // 顆需要下放給 MAIN world(postCopyEnabled 只影響 ISOLATED world 的
  // post-icon.js 是否注入 icon，不需要下放給沒有 chrome.* API 的
  // clipboard-guard.js)。autoClean 預設值改為 false(使用者變更設定規
  // 格)，clipboard-guard.js 的內建預設值需同步改動，見該檔。
  var SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
  var SETTINGS_KEYS = ['autoClean'];
  var SETTINGS_DEFAULTS = {
    autoClean: false,
  };

  // 上一次成功推播的設定快取，供 onChanged 增量更新使用（見下方說明）。
  var lastKnownSettings = null;

  // chrome.storage 為防禦性存取：部分測試 sandbox（以及理論上任何未授予
  // storage 權限的載入情境）的 chrome mock 沒有 storage 屬性，碰到就直接
  // 略過整段設定推播邏輯，不影響既有的短碼解析橋接功能。
  function hasStorageSync() {
    return !!(
      typeof chrome !== 'undefined' &&
      chrome.storage &&
      chrome.storage.sync &&
      typeof chrome.storage.sync.get === 'function'
    );
  }

  function broadcast(settings) {
    lastKnownSettings = settings;
    try {
      window.postMessage({ type: SETTINGS_PUSH_TYPE, settings: settings }, window.location.origin);
    } catch (e) {
      // 推播失敗不影響其餘橋接流程；MAIN world 端本來就有預設值可用。
    }
  }

  function pushSettings() {
    if (!hasStorageSync()) return;
    try {
      // 把 SETTINGS_DEFAULTS 當 keys 傳給 get()：chrome.storage 的既定語意
      // 是「查無此鍵時用傳入值當預設值」，回呼收到的 items 已是三鍵補齊
      // 預設值後的完整物件，直接沿用即可，不再另外組一個新物件——避免
      // （在測試環境下）產生 vm sandbox 另一個 realm 的物件，讓外部以
      // deepEqual 比對整個 settings 物件時被判定「結構相同但非同一個
      // realm」而失敗；正規化型別時也用就地覆寫、不建立新物件。
      chrome.storage.sync.get(SETTINGS_DEFAULTS, function (items) {
        var settings = items && typeof items === 'object' ? items : {};
        SETTINGS_KEYS.forEach(function (key) {
          if (typeof settings[key] !== 'boolean') settings[key] = SETTINGS_DEFAULTS[key];
        });
        broadcast(settings);
      });
    } catch (e) {
      // chrome.storage 存取失敗：不影響其餘橋接流程。
    }
  }

  pushSettings();

  if (
    hasStorageSync() &&
    chrome.storage.onChanged &&
    typeof chrome.storage.onChanged.addListener === 'function'
  ) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'sync') return;

      // 增量套用 changes 裡的新值再推播，不再另外打一次 chrome.storage.get：
      // changes 本身就是權威的最新值，多一趟非同步往返純屬多餘且拉長延遲。
      // 只有在還沒有基底快取時（理論上不會發生，因為載入時已讀過一次）才
      // 退回完整重讀。
      if (!lastKnownSettings) {
        pushSettings();
        return;
      }

      var next = {
        autoClean: lastKnownSettings.autoClean,
      };
      var mutated = false;
      SETTINGS_KEYS.forEach(function (key) {
        if (changes && Object.prototype.hasOwnProperty.call(changes, key)) {
          next[key] = changes[key].newValue;
          mutated = true;
        }
      });
      if (mutated) broadcast(next);
    });
  }
})();
