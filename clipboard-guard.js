// threads-clean-link — clipboard-guard.js
//
// 官方複製連結攔截淨化。注入到 threads.com / threads.net 頁面的 MAIN world，
// 在頁面呼叫 navigator.clipboard.writeText / navigator.clipboard.write 寫入剪貼簿
// 的瞬間檢查內容：
//
//   1. 帶追蹤參數（?xmt=...）的貼文網址 → 去掉 query／hash 再放行（零網路請求）。
//   2. 分享短碼（/share/XXXX）→ 經 bridge.js 橋接請 background 解析成乾淨貼文
//      網址後再放行；橋接逾時／失敗／任何例外一律 fail-open，原始參數照樣寫入，
//      絕不讓複製功能因此卡住或失敗。
//
// 設計立場：此檔只存在於 threads 網域頁面內，經過本包裝層的寫入必然是該網站
// 自己發起的，因此不做、也不需要任何「來源判斷」。
//
// 安全原則：任何非預期情況（內容不符、判斷邏輯例外、原生呼叫例外、橋接逾時
// 或失敗）一律以「呼叫原生函式」收尾，絕不讓網站原本的複製功能因此中斷或損壞。
(function () {
  'use strict';

  var clipboard = navigator && navigator.clipboard;
  if (!clipboard) return;

  // 貼文網址規則：https://(www.)threads.(com|net)/@handle/post/id [?query][#hash]
  // 第 1 組：不含 query/hash 的乾淨網址本體。
  // 第 2 組：query 與 hash 的原始尾段（可能不存在）。
  var POST_URL_RE = /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/@[^/?#\s]+\/post\/[^/?#\s]+)([?#]\S*)?$/;

  // 分享短碼規則：https://(www.)threads.(com|net)/share/XXXX，容忍尾斜線與可能
  // 附帶的 query/hash。這裡只判斷「是不是短碼」，不嘗試本地解析——短碼本身不含
  // 任何可離線解碼的資訊，必須交給 background 問一次伺服器。
  var SHARE_URL_RE = /^https:\/\/(www\.)?threads\.(com|net)\/share\/[^/?#\s]+\/?([?#]\S*)?$/;

  var RESOLVE_TIMEOUT_MS = 2500;
  var REQ_TYPE = 'TCL_RESOLVE_REQ';
  var RES_TYPE = 'TCL_RESOLVE_RES';

  // 判斷字串是否需要淨化；不需要（含格式不符、沒有 query/hash 可剪）回傳 null，
  // 需要則回傳去掉 query/hash 後的乾淨網址字串。
  function sanitizeIfTrackedPostUrl(str) {
    if (typeof str !== 'string') return null;
    var trimmed = str.trim();
    var match = POST_URL_RE.exec(trimmed);
    if (!match) return null;
    // 第 2 組非空才代表原本帶了 query 或 hash，才有東西可剪。
    if (!match[2]) return null;
    return match[1];
  }

  // 判斷字串（trim 後整體）是不是分享短碼網址。
  function isShareUrl(str) {
    if (typeof str !== 'string') return false;
    return SHARE_URL_RE.test(str.trim());
  }

  function makeRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (e) {
      // 忽略，走下面的備援 ID 產生方式。
    }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // 經由 bridge.js（ISOLATED world）橋接請 background 解析短碼。
  // 一律回傳 Promise<string|null>：成功給乾淨網址字串，任何失敗／逾時給 null，
  // 呼叫端收到 null 就等同「沒解析出來」，走 fail-open 用原始參數放行。
  function requestResolveShareUrl(shareUrl) {
    return new Promise(function (resolve) {
      var requestId = makeRequestId();
      var settled = false;
      var timer = null;

      function cleanup() {
        window.removeEventListener('message', onMessage);
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function onMessage(event) {
        // 只接受「本頁面自己發給自己」的回應：來源視窗必須是同一個 window。
        if (event.source !== window) return;
        var data = event.data;
        if (!data || data.type !== RES_TYPE || data.requestId !== requestId) return;
        if (data.ok && typeof data.cleanUrl === 'string' && data.cleanUrl) {
          finish(data.cleanUrl);
        } else {
          finish(null);
        }
      }

      try {
        window.addEventListener('message', onMessage);
        timer = setTimeout(function () {
          finish(null);
        }, RESOLVE_TIMEOUT_MS);
        window.postMessage(
          { type: REQ_TYPE, requestId: requestId, url: shareUrl },
          window.location.origin
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  // ---- navigator.clipboard.writeText ----
  if (typeof clipboard.writeText === 'function') {
    var nativeWriteText = clipboard.writeText.bind(clipboard);

    clipboard.writeText = function (data) {
      try {
        if (typeof data === 'string') {
          if (isShareUrl(data)) {
            return requestResolveShareUrl(data.trim())
              .then(function (cleanUrl) {
                var toWrite = typeof cleanUrl === 'string' && cleanUrl ? cleanUrl : data;
                return nativeWriteText(toWrite);
              })
              .catch(function () {
                // fail-open：橋接／解析任何失敗，一律用原始參數放行。
                return nativeWriteText(data);
              });
          }

          var toWrite = data;
          var cleaned = sanitizeIfTrackedPostUrl(data);
          if (cleaned !== null) {
            toWrite = cleaned;
          }
          return nativeWriteText(toWrite);
        }
        return nativeWriteText(data);
      } catch (e) {
        // 包裝層任何例外：以原始參數呼叫原函式，確保複製功能不因我們而壞。
        return nativeWriteText(data);
      }
    };
  }

  // ---- navigator.clipboard.write ----
  if (typeof clipboard.write === 'function') {
    var nativeWrite = clipboard.write.bind(clipboard);

    clipboard.write = function (items) {
      try {
        // 只處理「單一 ClipboardItem、且該 item 只有 text/plain 單一格式」的情況，
        // 對應規格的「寫入內容為單一字串」；其餘一律原封不動交給原生函式。
        if (
          Array.isArray(items) &&
          items.length === 1 &&
          items[0] &&
          typeof items[0].getType === 'function' &&
          Array.isArray(items[0].types) &&
          items[0].types.length === 1 &&
          items[0].types[0] === 'text/plain' &&
          typeof window.ClipboardItem === 'function'
        ) {
          var item = items[0];
          return item
            .getType('text/plain')
            .then(function (blob) {
              return blob.text();
            })
            .then(function (text) {
              if (isShareUrl(text)) {
                return requestResolveShareUrl(text.trim())
                  .then(function (cleanUrl) {
                    if (typeof cleanUrl === 'string' && cleanUrl) {
                      var resolvedItem = new window.ClipboardItem({
                        'text/plain': new Blob([cleanUrl], { type: 'text/plain' }),
                      });
                      return nativeWrite([resolvedItem]);
                    }
                    // fail-open：橋接／解析任何失敗，一律用原始 items 放行。
                    return nativeWrite(items);
                  })
                  .catch(function () {
                    return nativeWrite(items);
                  });
              }

              var cleaned = sanitizeIfTrackedPostUrl(text);
              if (cleaned === null) {
                return nativeWrite(items);
              }
              var newItem = new window.ClipboardItem({
                'text/plain': new Blob([cleaned], { type: 'text/plain' }),
              });
              return nativeWrite([newItem]);
            })
            .catch(function () {
              // 讀取／重建 ClipboardItem 過程任何例外：原封不動放行原始 items。
              return nativeWrite(items);
            });
        }

        return nativeWrite(items);
      } catch (e) {
        // 包裝層任何例外：以原始參數呼叫原函式，確保複製功能不因我們而壞。
        return nativeWrite(items);
      }
    };
  }
})();
