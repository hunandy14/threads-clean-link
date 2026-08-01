// threads-clean-link — clipboard-guard.js
//
// 官方複製連結攔截淨化。注入到 threads.com / threads.net 頁面的 MAIN world，
// 在頁面呼叫 navigator.clipboard.writeText / navigator.clipboard.write 寫入剪貼簿
// 的瞬間檢查內容，若是帶追蹤參數（?xmt=...）的貼文網址，去掉 query／hash 再放行。
//
// 設計立場：零網路請求、零讀取剪貼簿。此檔只存在於 threads 網域頁面內，
// 經過本包裝層的寫入必然是該網站自己發起的，因此不做、也不需要任何「來源判斷」。
//
// 安全原則：任何非預期情況（內容不符、判斷邏輯例外、原生呼叫例外）一律
// 以「呼叫原生函式」收尾，絕不讓網站原本的複製功能因此中斷或損壞。
(function () {
  'use strict';

  var clipboard = navigator && navigator.clipboard;
  if (!clipboard) return;

  // 貼文網址規則：https://(www.)threads.(com|net)/@handle/post/id [?query][#hash]
  // 第 1 組：不含 query/hash 的乾淨網址本體。
  // 第 2 組：query 與 hash 的原始尾段（可能不存在）。
  var POST_URL_RE = /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/@[^/?#]+\/post\/[^/?#]+)([?#].*)?$/;

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

  // ---- navigator.clipboard.writeText ----
  if (typeof clipboard.writeText === 'function') {
    var nativeWriteText = clipboard.writeText.bind(clipboard);

    clipboard.writeText = function (data) {
      try {
        var toWrite = data;
        var cleaned = sanitizeIfTrackedPostUrl(data);
        if (cleaned !== null) {
          toWrite = cleaned;
        }
        return nativeWriteText(toWrite);
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
