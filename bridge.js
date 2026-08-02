// bridge.js — ISOLATED world content script，把 MAIN world(無 chrome.*
// API)的短碼解析請求經 postMessage 轉為 chrome.runtime.sendMessage 送給
// service worker，結果再 postMessage 回 MAIN world。
(function () {
  'use strict';

  var REQ_TYPE = 'TCL_RESOLVE_REQ';
  var RES_TYPE = 'TCL_RESOLVE_RES';

  window.addEventListener('message', function (event) {
    // 只信任「本頁面自己發給自己」的訊息：
    // - source 必須是同一個 window（排除子 iframe / 其他視窗轉發過來的訊息）
    // - origin 必須等於目前頁面的 origin
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    var data = event.data;
    if (!data || typeof data !== 'object') return;
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
          reply({ ok: false, reason: String((lastErr && lastErr.message) || lastErr) });
          return;
        }
        if (response && response.ok && typeof response.cleanUrl === 'string') {
          reply({ ok: true, cleanUrl: response.cleanUrl });
        } else {
          reply({ ok: false, reason: (response && response.reason) || 'no-response' });
        }
      });
    } catch (e) {
      // sendMessage 同步丟例外（例如擴充功能情境已失效）：直接回報失敗。
      reply({ ok: false, reason: 'bridge-exception' });
    }
  });

  // ------------------------------------------------------------
  // v1.1 設定規格 S6：載入時讀一次 chrome.storage.sync，把設定經
  // postMessage 以 TCL_SETTINGS_PUSH 下放到 MAIN world（clipboard-guard.js
  // 沒有 chrome.* API，只能靠這條管道拿到設定）；chrome.storage.onChanged
  // 觸發時（例如使用者在 popup 切換開關）再次推播最新值。
  // ------------------------------------------------------------

  var SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
  var SETTINGS_KEYS = ['autoClean', 'resolveShortcode', 'notifySuccess'];
  var SETTINGS_DEFAULTS = {
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
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
        resolveShortcode: lastKnownSettings.resolveShortcode,
        notifySuccess: lastKnownSettings.notifySuccess,
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
