// clipboard-guard.js — 注入 threads.com / threads.net 頁面 MAIN world，
// 攔截官方複製連結寫入剪貼簿的內容，淨化後再放行。任何判斷或呼叫例外一律
// fallback 呼叫原生函式，不讓網站原本的複製功能因此損壞。
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

  // v1.1 設定規格 S6/S8：常駐監聽 bridge.js 推播的 TCL_SETTINGS_PUSH。
  // 在收到第一次推播之前一律用預設值（兩者皆開）運作，與現行(v1.0)行為
  // 完全一致，維持向下相容。
  var SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
  var currentSettings = {
    autoClean: true,
    resolveShortcode: true,
    notifySuccess: false,
  };

  function isValidSettingsPayload(settings) {
    return (
      settings &&
      typeof settings === 'object' &&
      typeof settings.autoClean === 'boolean' &&
      typeof settings.resolveShortcode === 'boolean' &&
      typeof settings.notifySuccess === 'boolean'
    );
  }

  // S8：來源驗證比照 TCL_RESOLVE_RES 同等級——只信任「本頁面自己發給
  // 自己」的訊息（event.source 必須是同一個 window）。驗證不過或形狀
  // 不符的推播完全忽略，不套用任何部分內容，也不影響既有設定。
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== SETTINGS_PUSH_TYPE) return;
    if (!isValidSettingsPayload(data.settings)) return;

    currentSettings = {
      autoClean: data.settings.autoClean,
      resolveShortcode: data.settings.resolveShortcode,
      notifySuccess: data.settings.notifySuccess,
    };
  });

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
          // S3：autoClean 關閉時，一切淨化與短碼解析全部略過，原樣放行。
          if (!currentSettings.autoClean) {
            return nativeWriteText(data);
          }

          if (isShareUrl(data)) {
            // S4：resolveShortcode 關閉時，短碼分支不發任何解析請求，
            // 原樣放行原文；?xmt 剪除分支（下方）不受此設定影響。
            if (!currentSettings.resolveShortcode) {
              return nativeWriteText(data);
            }
            // 雙參數 .then(onOk, onErr):onErr 只綁定 requestResolveShareUrl
            // 的 rejection，不會連 nativeWriteText 的 rejection 也接住，確保
            // 原生呼叫只被呼叫一次，其 rejection 原樣傳回呼叫端。
            return requestResolveShareUrl(data.trim()).then(
              function (cleanUrl) {
                // cleanUrl 需通過貼文網址格式驗證才信任，否則視同解析失敗。
                var toWrite =
                  typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl)
                    ? cleanUrl
                    : data;
                return nativeWriteText(toWrite);
              },
              function () {
                // fail-open:橋接／解析任何失敗，一律用原始參數放行。
                return nativeWriteText(data);
              }
            );
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
        // 只處理「單一 ClipboardItem 且只有 text/plain 單一格式」的情況；
        // 其餘格式或多個 items 一律原封不動交給原生函式。
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
          // S3：autoClean 關閉時，一切淨化與短碼解析全部略過，以原始 items
          // 參照原樣呼叫原生 write()，不讀取 blob、不重建陣列。
          if (!currentSettings.autoClean) {
            return nativeWrite(items);
          }

          var item = items[0];

          // decideWhatToWrite 只決定要寫入的內容(讀取 blob、判斷短碼／?xmt、
          // 橋接解析、重建 ClipboardItem)，任何步驟失敗都 fallback 回傳原始
          // items，但絕不呼叫 nativeWrite，確保原生呼叫只發生一次。
          var decideWhatToWrite = item
            .getType('text/plain')
            .then(function (blob) {
              return blob.text();
            })
            .then(function (text) {
              if (isShareUrl(text)) {
                // S4：resolveShortcode 關閉時，短碼分支不發任何解析請求，
                // 以原始 items 參照原樣放行；?xmt 剪除分支不受此設定影響。
                if (!currentSettings.resolveShortcode) {
                  return items;
                }
                return requestResolveShareUrl(text.trim()).then(
                  function (cleanUrl) {
                    // cleanUrl 需通過貼文網址格式驗證才信任。
                    if (typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl)) {
                      return [
                        new window.ClipboardItem({
                          'text/plain': new Blob([cleanUrl], { type: 'text/plain' }),
                        }),
                      ];
                    }
                    // fail-open:cleanUrl 缺失或格式不符，一律用原始 items。
                    return items;
                  },
                  function () {
                    // fail-open:橋接／解析任何失敗，一律用原始 items。
                    return items;
                  }
                );
              }

              var cleaned = sanitizeIfTrackedPostUrl(text);
              if (cleaned === null) {
                return items;
              }
              return [
                new window.ClipboardItem({
                  'text/plain': new Blob([cleaned], { type: 'text/plain' }),
                }),
              ];
            })
            .catch(function () {
              // 讀取／判斷／重建過程任何例外：原封不動用原始 items。
              return items;
            });

          // 真正呼叫原生 write 的地方，刻意不包 catch：原生呼叫的 rejection
          // 要原樣傳回頁面，我們永不重試原生寫入，且只在這唯一一處呼叫。
          return decideWhatToWrite.then(function (toWrite) {
            return nativeWrite(toWrite);
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
