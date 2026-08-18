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

  // R1-2 通知涵蓋自動路徑：實際把淨化後內容寫入剪貼簿成功後，往 bridge.js
  // 送一則通知，轉發給 background 寫進紀錄(方案甲:歷史即收藏，唯一
  // 資料集)。成功類通知已依使用者變更設定規格整組移除，這則通知不再有
  // 「要不要顯示」的把關，background 收到就無條件記錄。
  var CLEANED_NOTICE_TYPE = 'TCL_CLEANED_NOTICE';

  // kind 標示淨化來源('share' 短碼解析 / 'strip' 剪除追蹤參數),供
  // background 寫入紀錄時分類;白名單驗證在 background(信任邊界)。
  function notifyCleaned(cleanUrl, kind) {
    try {
      window.postMessage(
        { type: CLEANED_NOTICE_TYPE, cleanUrl: cleanUrl, kind: kind },
        window.location.origin
      );
    } catch (e) {
      // 通知失敗不影響已經完成的寫入流程。
    }
  }

  // v1.1 設定規格 S6/S8：常駐監聽 bridge.js 推播的 TCL_SETTINGS_PUSH。
  // 在收到第一次推播之前一律用預設值運作。使用者變更設定規格:autoClean
  // 預設值改為 false(關閉)，在收到第一次推播之前，自動淨化／短碼解析
  // 整段不啟用，與 bridge.js 的 SETTINGS_DEFAULTS 同步改動。
  // R1-1 併開關：resolveShortcode 徹底移除，短碼解析與 ?xmt 剪參都收在
  // autoClean 這一顆之下。notifySuccess(成功類通知)已依使用者變更設定
  // 規格整組移除——這裡從未真正依它分支任何邏輯(只是存著轉發)，直接拿
  // 掉，不留死欄位。
  var SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
  var currentSettings = {
    autoClean: false,
  };

  function isValidSettingsPayload(settings) {
    return settings && typeof settings === 'object' && typeof settings.autoClean === 'boolean';
  }

  // S8：來源驗證比照 TCL_RESOLVE_RES 同等級——只信任「本頁面自己發給
  // 自己」的訊息（event.source 必須是同一個 window，event.origin 必須等於
  // 本頁面 origin，兩者比照 bridge.js 的同款驗證）。驗證不過或形狀不符的
  // 推播完全忽略，不套用任何部分內容，也不影響既有設定。
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== SETTINGS_PUSH_TYPE) return;
    if (!isValidSettingsPayload(data.settings)) return;

    currentSettings = {
      autoClean: data.settings.autoClean,
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
  //
  // recordOnly(記錄與淨化脫鉤，修正規格):autoClean 關閉時仍要照跑解析管
  // 線以便記錄，但剪貼簿不能被改寫，且解析失敗不該用頁內 toast 嚇使用者
  // (使用者的複製動作本身沒壞)。這個布林值原樣夾帶進 TCL_RESOLVE_REQ，
  // 讓 bridge.js 知道這次失敗該走 console.warn 還是既有的頁內 toast，見
  // bridge.js 的 recordOnly 分流。
  function requestResolveShareUrl(shareUrl, recordOnly) {
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
        // 只接受「本頁面自己發給自己」的回應：來源視窗必須是同一個 window，
        // 且 event.origin 必須等於本頁面 origin(比照 bridge.js:29-30 同款
        // 驗證)。
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
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
          { type: REQ_TYPE, requestId: requestId, url: shareUrl, recordOnly: !!recordOnly },
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
          // 修正規格(記錄與淨化脫鉤):autoClean 只管「剪貼簿要不要被改
          // 寫」，偵測／解析管線一律照跑，不再因 autoClean 關閉就整段早
          // 退——「複製就記錄」的語意(歷史即收藏)不該受 autoClean 影響。
          // recordOnly=true(autoClean 關閉)時:剪貼簿一律寫回使用者原本
          // 複製的內容，但解析成功仍會 notifyCleaned 供記錄；解析失敗則
          // 交給 bridge.js 的 recordOnly 分流靜默處理(不跳頁內 toast)。
          // autoClean 開啟(recordOnly=false)時行為與修正前完全一致。
          var recordOnly = !currentSettings.autoClean;

          if (isShareUrl(data)) {
            // 雙參數 .then(onOk, onErr):onErr 只綁定 requestResolveShareUrl
            // 的 rejection，不會連 nativeWriteText 的 rejection 也接住，確保
            // 原生呼叫只被呼叫一次，其 rejection 原樣傳回呼叫端。
            return requestResolveShareUrl(data.trim(), recordOnly).then(
              function (cleanUrl) {
                // cleanUrl 需通過貼文網址格式驗證才信任，否則視同解析失敗。
                var resolved = typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl);
                if (resolved) {
                  // R1-2：只有「實際寫入剪貼簿」才發通知——原生寫入先跑，
                  // 成功之後(.then 的 onFulfilled)才 notifyCleaned，若原生
                  // 寫入被拒(rejection)則不會進到這裡，也就不會誤發通知。
                  // recordOnly 時寫回原始 data(不改寫剪貼簿)，否則寫入
                  // 解析後的乾淨網址；無論哪種，記錄用的 cleanUrl 都是解
                  // 析後的版本，讓「歷史即收藏」拿到正確的乾淨網址。
                  // Promise.resolve 包一層:原生若回傳非 Promise，直接 .then
                  // 會丟 TypeError 落到外層 catch，導致原生被「以未淨化的原文」
                  // 再呼叫一次。包裝後 rejection 語意不變，仍原樣往外傳。
                  var toWrite = recordOnly ? data : cleanUrl;
                  return Promise.resolve(nativeWriteText(toWrite)).then(function (result) {
                    notifyCleaned(cleanUrl, 'share');
                    return result;
                  });
                }
                // 解析失敗或格式不符:剪貼簿一律用原始參數放行，不發通知。
                // recordOnly 情境的使用者可見提示(靜默 vs 頁內 toast)已交
                // 給 bridge.js 依請求帶的 recordOnly 分流，這裡只留一句
                // console.warn 方便除錯，不影響剪貼簿內容。
                if (recordOnly) {
                  console.warn('[threads-clean-link] recordOnly 解析失敗，不影響剪貼簿');
                }
                return nativeWriteText(data);
              },
              function () {
                // fail-open:橋接／解析任何失敗，一律用原始參數放行，不發通知。
                if (recordOnly) {
                  console.warn('[threads-clean-link] recordOnly 橋接失敗，不影響剪貼簿');
                }
                return nativeWriteText(data);
              }
            );
          }

          var toWrite = data;
          var cleaned = sanitizeIfTrackedPostUrl(data);
          if (cleaned !== null) {
            // ?xmt 剪參是同步、決定性的判斷(不經網路解析)，沒有「失敗」
            // 這個中間狀態:能剪就是能剪。recordOnly 時剪貼簿仍寫回原始
            // data，只是照樣 notifyCleaned 供記錄。
            toWrite = recordOnly ? data : cleaned;
            // R1-2：?xmt 剪參分支同樣只在原生寫入成功後才發通知。
            // Promise.resolve 包一層的理由同上(防非 Promise 回傳時重複呼叫原生)。
            return Promise.resolve(nativeWriteText(toWrite)).then(function (result) {
              notifyCleaned(cleaned, 'strip');
              return result;
            });
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
          // 修正規格(記錄與淨化脫鉤):autoClean 只管「剪貼簿要不要被改
          // 寫」，偵測／解析管線一律照跑，不再因 autoClean 關閉就整段早
          // 退，理由與 writeText 分支相同(見上方註解)。
          var recordOnly = !currentSettings.autoClean;

          var item = items[0];

          // R1-2：只有實際解析／剪參成功(代表真的判定出可記錄的乾淨網
          // 址)才需要在原生寫入成功後發通知；記錄「這次若成功要通知的
          // cleanUrl 與其來源 kind」，fail-open／未改寫的路徑保持 null，
          // 不發通知。recordOnly 時即使成功也不重建 ClipboardItem(剪貼簿
          // 維持原始 items)，但一樣要記下 cleanedUrlForNotice 供記錄。
          var cleanedUrlForNotice = null;
          var cleanedKindForNotice = null;

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
                return requestResolveShareUrl(text.trim(), recordOnly).then(
                  function (cleanUrl) {
                    // cleanUrl 需通過貼文網址格式驗證才信任。
                    if (typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl)) {
                      cleanedUrlForNotice = cleanUrl;
                      cleanedKindForNotice = 'share';
                      if (recordOnly) return items;
                      return [
                        new window.ClipboardItem({
                          'text/plain': new Blob([cleanUrl], { type: 'text/plain' }),
                        }),
                      ];
                    }
                    // fail-open:cleanUrl 缺失或格式不符，一律用原始 items。
                    if (recordOnly) {
                      console.warn('[threads-clean-link] recordOnly 解析失敗，不影響剪貼簿');
                    }
                    return items;
                  },
                  function () {
                    // fail-open:橋接／解析任何失敗，一律用原始 items。
                    if (recordOnly) {
                      console.warn('[threads-clean-link] recordOnly 橋接失敗，不影響剪貼簿');
                    }
                    return items;
                  }
                );
              }

              var cleaned = sanitizeIfTrackedPostUrl(text);
              if (cleaned === null) {
                return items;
              }
              cleanedUrlForNotice = cleaned;
              cleanedKindForNotice = 'strip';
              if (recordOnly) return items;
              return [
                new window.ClipboardItem({
                  'text/plain': new Blob([cleaned], { type: 'text/plain' }),
                }),
              ];
            })
            .catch(function () {
              // 讀取／判斷／重建過程任何例外：原封不動用原始 items，且視同
              // 沒有發生任何淨化替換，不得發通知。
              cleanedUrlForNotice = null;
              cleanedKindForNotice = null;
              return items;
            });

          // 真正呼叫原生 write 的地方，刻意不包 catch：原生呼叫的 rejection
          // 要原樣傳回頁面，我們永不重試原生寫入，且只在這唯一一處呼叫。
          // R1-2：notifyCleaned 只在 nativeWrite 的 Promise 成功(onFulfilled)
          // 且確實做了替換時才呼叫；原生寫入被拒(rejection)會跳過 onFulfilled，
          // 自然不會誤發通知，rejection 也原樣往外傳。
          return decideWhatToWrite.then(function (toWrite) {
            return nativeWrite(toWrite).then(function (result) {
              if (cleanedUrlForNotice !== null && cleanedKindForNotice !== null) {
                notifyCleaned(cleanedUrlForNotice, cleanedKindForNotice);
              }
              return result;
            });
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
