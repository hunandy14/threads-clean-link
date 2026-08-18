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

  // 實際把淨化後內容寫入剪貼簿成功後，往 bridge.js 送一則通知，轉發給
  // background 寫進紀錄，收到就無條件記錄，沒有「要不要顯示」的把關。
  var CLEANED_NOTICE_TYPE = 'TCL_CLEANED_NOTICE';

  // kind 標示淨化來源('share' 短碼解析 / 'strip' 剪除追蹤參數),供
  // background 寫入紀錄時分類;白名單驗證在 background(信任邊界)。
  // original(選填)是使用者實際複製到/觸發時的原始連結(share 短碼原文，
  // 或 strip 剝參前的原網址)；removedParams(選填，僅 strip 分支算得出)
  // 是被剝除的查詢參數清單。這裡只做最基本的存在性判斷(與 cleanUrl 相同
  // 就不夾帶——沒有額外資訊，省一點 postMessage payload)，真正的型別/
  // 長度 sanitize 交給 background.js(信任邊界)。
  function notifyCleaned(cleanUrl, kind, original, removedParams) {
    try {
      var payload = { type: CLEANED_NOTICE_TYPE, cleanUrl: cleanUrl, kind: kind };
      if (typeof original === 'string' && original && original !== cleanUrl) {
        payload.original = original;
      }
      if (Array.isArray(removedParams) && removedParams.length > 0) {
        payload.removedParams = removedParams;
      }
      window.postMessage(payload, window.location.origin);
    } catch (e) {
      // 通知失敗不影響已經完成的寫入流程。
    }
  }

  // 常駐監聽 bridge.js 推播的 TCL_SETTINGS_PUSH，在收到第一次推播之前
  // 一律用預設值運作(autoClean=false 時自動淨化／短碼解析整段不啟用，
  // 與 bridge.js 的 SETTINGS_DEFAULTS 同步)。saveHistory:recordOnly
  // (autoClean 關閉)流程是「先原生寫入、事後 fire-and-forget 補發解析
  // 請求」，若 saveHistory 也關閉，解析結果反正不會被 background.js
  // 收下，直接省掉整個解析請求，不浪費一次網路往返(見下方 writeText／
  // write 的 recordOnly 分支)。預設 true，對齊 background.js 的
  // DEFAULT_SETTINGS.saveHistory。
  var SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
  var currentSettings = {
    autoClean: false,
    saveHistory: true,
  };

  // saveHistory 選填:缺席時視為尚未提供，套用時沿用既有值(見下方套用邏
  // 輯)，不讓整則推播因此被判定形狀不對；有提供就必須是布林值，否則整
  // 則推播視為形狀不對、完全忽略(與 autoClean 的既有驗證邏輯一致)。選
  // 填而非必填是為了不放大既有推播管道的耦合面——理論上 bridge.js 目前
  // 一定會同時給兩顆鍵，這裡的容忍純屬防禦性設計。
  function isValidSettingsPayload(settings) {
    if (!settings || typeof settings !== 'object') return false;
    if (typeof settings.autoClean !== 'boolean') return false;
    if (settings.saveHistory !== undefined && typeof settings.saveHistory !== 'boolean') return false;
    return true;
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
      saveHistory:
        typeof data.settings.saveHistory === 'boolean'
          ? data.settings.saveHistory
          : currentSettings.saveHistory,
    };
  });

  // 從 POST_URL_RE 第 2 組(可能是 ?query、#hash，或 ?query#hash)取出被剝
  // 除的查詢參數清單({key, value}[])。只看 query，hash 本身不是參數;
  // 沒有 query 部分回傳空陣列。任何解析例外一律回傳空陣列(fail-safe，
  // 不影響已經完成的剪貼簿寫入判斷)。
  //
  // 先以 '#' 切開取「hash 之前」的部分再找 '?'——hash 片段內容本身可以
  // 合法含有 '?' 字元(例如 '#x?y=1' 這種前端路由常見寫法)，若直接對整段
  // tail 做 indexOf('?')，會把 hash 裡的 '?y=1' 誤判成查詢字串，產生根本
  // 不存在的假參數。
  function parseRemovedParams(tail) {
    if (typeof tail !== 'string' || !tail) return [];
    var beforeHash = tail.split('#')[0];
    var qIndex = beforeHash.indexOf('?');
    if (qIndex === -1) return []; // hash 之前沒有 '?'，代表沒有查詢參數可剝
    var query = beforeHash.slice(qIndex + 1);
    if (!query) return [];
    try {
      var out = [];
      new URLSearchParams(query).forEach(function (value, key) {
        out.push({ key: key, value: value });
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  // 判斷字串是否需要淨化；不需要（含格式不符、沒有 query/hash 可剪）回傳
  // null，需要則回傳 { cleaned, original, removedParams }:cleaned 是去掉
  // query/hash 後的乾淨網址;original 是剝參前的完整原網址(trim 後)，供
  // 夾帶進 notifyCleaned;removedParams 是被剝除的查詢參數清單。
  function stripTrackedPostUrl(str) {
    if (typeof str !== 'string') return null;
    var trimmed = str.trim();
    var match = POST_URL_RE.exec(trimmed);
    if (!match) return null;
    // 第 2 組非空才代表原本帶了 query 或 hash，才有東西可剪。
    if (!match[2]) return null;
    return { cleaned: match[1], original: trimmed, removedParams: parseRemovedParams(match[2]) };
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
          // autoClean 只管「剪貼簿要不要被改寫」，偵測／解析管線一律照
          // 跑——「複製就記錄」的語意不該受 autoClean 影響。
          // recordOnly=true(autoClean 關閉)時:剪貼簿一律寫回使用者原本
          // 複製的內容，但解析成功仍會 notifyCleaned 供記錄；解析失敗則
          // 交給 bridge.js 的 recordOnly 分流靜默處理(不跳頁內 toast)。
          var recordOnly = !currentSettings.autoClean;

          if (isShareUrl(data)) {
            // share 分支只拿得到「短碼原文」當 original，沒有
            // removedParams——伺服器端重新導向前的網址帶了哪些查詢參數，
            // guard 這一層無從得知(那是 background.js 解析短碼時才看得到
            // 的資訊，這裡不硬造)。
            var shareOriginal = data.trim();

            if (recordOnly) {
              // autoClean 關閉時，剪貼簿要不要被改寫已經不取決於解析結果
              // (recordOnly 恆寫回原始 data)，沒有理由讓使用者等最多 2.5
              // 秒的橋接逾時、甚至因分頁失焦而 NotAllowedError——原生寫入
              // 立刻執行，成功後才「事後」發解析請求補記錄(fire-and-forget，
              // 不 await、不阻塞這次 writeText 的回傳)。saveHistory 也
              // 關閉時，解析結果反正不會被 background.js 的 recordHistory
              // 收下，直接省掉整個解析請求，不浪費一次網路往返。
              return Promise.resolve(nativeWriteText(data)).then(function (result) {
                if (currentSettings.saveHistory) {
                  // requestResolveShareUrl 設計上一律 resolve(成功給字
                  // 串、任何失敗／逾時給 null)，不會 reject，這裡不需要
                  // 額外的 rejection 處理。
                  requestResolveShareUrl(shareOriginal, true).then(function (cleanUrl) {
                    var resolved = typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl);
                    if (resolved) {
                      notifyCleaned(cleanUrl, 'share', shareOriginal);
                    } else {
                      console.warn('[threads-clean-link] recordOnly 解析失敗，不影響剪貼簿');
                    }
                  });
                }
                return result;
              });
            }

            // autoClean 開啟(recordOnly=false)時:先解析、解析成功才
            // 寫入乾淨網址。
            return requestResolveShareUrl(shareOriginal, false).then(function (cleanUrl) {
              // cleanUrl 需通過貼文網址格式驗證才信任，否則視同解析失敗。
              var resolved = typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl);
              if (resolved) {
                // 只有「實際寫入剪貼簿」才發通知——原生寫入先跑，
                // 成功之後(.then 的 onFulfilled)才 notifyCleaned，若原生
                // 寫入被拒(rejection)則不會進到這裡，也就不會誤發通知。
                // Promise.resolve 包一層:原生若回傳非 Promise，直接 .then
                // 會丟 TypeError 落到外層 catch，導致原生被「以未淨化的原文」
                // 再呼叫一次。包裝後 rejection 語意不變，仍原樣往外傳。
                return Promise.resolve(nativeWriteText(cleanUrl)).then(function (result) {
                  notifyCleaned(cleanUrl, 'share', shareOriginal);
                  return result;
                });
              }
              // 解析失敗或格式不符:剪貼簿一律用原始參數放行，不發通知。
              return nativeWriteText(data);
            });
          }

          var toWrite = data;
          var stripped = stripTrackedPostUrl(data);
          if (stripped !== null) {
            // ?xmt 剪參是同步、決定性的判斷(不經網路解析)，沒有「失敗」
            // 這個中間狀態:能剪就是能剪。recordOnly 時剪貼簿仍寫回原始
            // data，只是照樣 notifyCleaned 供記錄。
            toWrite = recordOnly ? data : stripped.cleaned;
            // ?xmt 剪參分支同樣只在原生寫入成功後才發通知。Promise.resolve
            // 包一層的理由同上(防非 Promise 回傳時重複呼叫原生)。
            return Promise.resolve(nativeWriteText(toWrite)).then(function (result) {
              notifyCleaned(stripped.cleaned, 'strip', stripped.original, stripped.removedParams);
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
          // autoClean 只管「剪貼簿要不要被改寫」，偵測／解析管線一律照
          // 跑，理由與 writeText 分支相同(見上方註解)。
          var recordOnly = !currentSettings.autoClean;

          var item = items[0];

          // 只有實際解析／剪參成功(代表真的判定出可記錄的乾淨網址)才需
          // 要在原生寫入成功後發通知；記錄「這次若成功要通知的 cleanUrl
          // 與其來源 kind」，fail-open／未改寫的路徑保持 null，不發通知。
          // recordOnly 時即使成功也不重建 ClipboardItem(剪貼簿維持原始
          // items)，但一樣要記下 cleanedUrlForNotice 供記錄。
          // cleanedOriginalForNotice／cleanedRemovedParamsForNotice 比照
          // 同一套「先記下，最後才在原生寫入成功後一併帶進 notifyCleaned」
          // 的模式，share 分支只填 original，strip 分支兩者都填。
          var cleanedUrlForNotice = null;
          var cleanedKindForNotice = null;
          var cleanedOriginalForNotice = null;
          var cleanedRemovedParamsForNotice = null;
          // recordOnly 情境下，share 分支不需要等解析結果就能決定要寫什麼
          // (恆為 items 不變)，這裡先記下短碼原文讓 decideWhatToWrite 立刻
          // 回傳、不阻塞 nativeWrite；解析改成 nativeWrite 成功後才發的
          // fire-and-forget，見下方呼叫端。
          var recordOnlyShareOriginal = null;

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
                // share 分支只拿得到「短碼原文」當 original，理由同
                // writeText 分支(見上方 shareOriginal 註解)。
                var shareOriginal = text.trim();

                if (recordOnly) {
                  recordOnlyShareOriginal = shareOriginal;
                  return items;
                }

                return requestResolveShareUrl(shareOriginal, false).then(function (cleanUrl) {
                  // cleanUrl 需通過貼文網址格式驗證才信任。
                  if (typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl)) {
                    cleanedUrlForNotice = cleanUrl;
                    cleanedKindForNotice = 'share';
                    cleanedOriginalForNotice = shareOriginal;
                    return [
                      new window.ClipboardItem({
                        'text/plain': new Blob([cleanUrl], { type: 'text/plain' }),
                      }),
                    ];
                  }
                  // fail-open:cleanUrl 缺失或格式不符，一律用原始 items。
                  return items;
                });
              }

              var stripped = stripTrackedPostUrl(text);
              if (stripped === null) {
                return items;
              }
              cleanedUrlForNotice = stripped.cleaned;
              cleanedKindForNotice = 'strip';
              cleanedOriginalForNotice = stripped.original;
              cleanedRemovedParamsForNotice = stripped.removedParams;
              if (recordOnly) return items;
              return [
                new window.ClipboardItem({
                  'text/plain': new Blob([stripped.cleaned], { type: 'text/plain' }),
                }),
              ];
            })
            .catch(function () {
              // 讀取／判斷／重建過程任何例外：原封不動用原始 items，且視同
              // 沒有發生任何淨化替換，不得發通知。
              cleanedUrlForNotice = null;
              cleanedKindForNotice = null;
              cleanedOriginalForNotice = null;
              cleanedRemovedParamsForNotice = null;
              recordOnlyShareOriginal = null;
              return items;
            });

          // 真正呼叫原生 write 的地方，刻意不包 catch：原生呼叫的 rejection
          // 要原樣傳回頁面，我們永不重試原生寫入，且只在這唯一一處呼叫。
          // notifyCleaned 只在 nativeWrite 的 Promise 成功(onFulfilled)
          // 且確實做了替換時才呼叫；原生寫入被拒(rejection)會跳過 onFulfilled，
          // 自然不會誤發通知，rejection 也原樣往外傳。
          return decideWhatToWrite.then(function (toWrite) {
            return nativeWrite(toWrite).then(function (result) {
              if (cleanedUrlForNotice !== null && cleanedKindForNotice !== null) {
                notifyCleaned(cleanedUrlForNotice, cleanedKindForNotice, cleanedOriginalForNotice, cleanedRemovedParamsForNotice);
              }
              // recordOnly 的 share 分支，解析請求在原生寫入成功後才發、
              // 不 await，理由同 writeText 分支。saveHistory 關閉時直接
              // 省掉整個解析請求。
              if (recordOnlyShareOriginal !== null && currentSettings.saveHistory) {
                requestResolveShareUrl(recordOnlyShareOriginal, true).then(function (cleanUrl) {
                  var resolved = typeof cleanUrl === 'string' && cleanUrl && POST_URL_RE.test(cleanUrl);
                  if (resolved) {
                    notifyCleaned(cleanUrl, 'share', recordOnlyShareOriginal);
                  } else {
                    console.warn('[threads-clean-link] recordOnly 解析失敗，不影響剪貼簿');
                  }
                });
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
