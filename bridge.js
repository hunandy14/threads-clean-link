// bridge.js — ISOLATED world content script,把 MAIN world(無 chrome.*
// API)的短碼解析請求經 postMessage 轉為 chrome.runtime.sendMessage 送給
// service worker,結果再 postMessage 回 MAIN world。
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
})();
