// bridge.js — ISOLATED world content script，把 MAIN world(無 chrome.*
// API)的短碼解析請求經 postMessage 轉為 chrome.runtime.sendMessage 送給
// service worker，結果再 postMessage 回 MAIN world。
(function () {
  'use strict';

  var REQ_TYPE = 'TCL_RESOLVE_REQ';
  var RES_TYPE = 'TCL_RESOLVE_RES';

  // MAIN world(clipboard-guard.js)實際把淨化後內容寫入剪貼簿後，會送一
  // 則 TCL_CLEANED_NOTICE 過來，這裡原樣轉發成
  // chrome.runtime.sendMessage(cleanedNotice) 給 service worker，收到就
  // 無條件記錄一筆，沒有「要不要顯示通知」的把關。
  var NOTICE_TYPE = 'TCL_CLEANED_NOTICE';

  // cleanUrl 長度上限:這條管道的內容由頁面腳本自由指定，先在 bridge 擋掉
  // 超長 payload，不讓 100KB 等級的垃圾越過 content script → service worker
  // 的程序邊界。整串形狀的驗證由 background 以錨定樣式負責(信任邊界在該處)。
  var MAX_CLEAN_URL_LENGTH = 2048;

  // kind 標示淨化來源(share/strip)，這裡只做型別與長度把關，白名單驗證
  // 一樣交給 background。形狀不對整則丟棄，不轉發殘缺訊息。
  var MAX_KIND_LENGTH = 16;

  // removedParams 陣列筆數上限，與 background.js 的 REMOVED_PARAMS_MAX
  // 對齊(兩份常數各自獨立維護，本檔無建置系統可共用單一來源)。超過上限
  // 直接整欄丟棄，不逐筆截斷——bridge 這層只負責擋住超大 payload 越過
  // 程序邊界，細部 sanitize 交給 background.js。
  var MAX_REMOVED_PARAMS = 20;

  // share/strip 的短碼解析在 Threads 頁面內失敗時，改用頁內 toast 提示。
  // 真正的 toast 渲染邏輯(含文案 i18n 對應、樣式、自動消失)在
  // post-icon.js(同
  // ISOLATED world，document_idle 稍晚載入)，這裡只是執行期守衛後轉呼
  // 叫——TCLPostIcon 可能還沒初始化完成、或使用者的擴充功能是舊版沒有這
  // 個 API，兩種情況都靜默略過，不影響既有的 reply() 轉發流程。孤兒情境
  // (擴充功能已重載，Extension context invalidated)下，本函式呼叫點本
  // 身位於 chrome.runtime.sendMessage 失敗後的分支，理論上 window.TCLPostIcon
  // 這個純 DOM／JS 物件參照仍然存在且可呼叫(orphan 只斷了 chrome.runtime
  // 這條線，不影響同一頁面內已掛好的 window 屬性)，但這不是本車道測試
  // 得到保證的行為，如實記錄為已知限制，不承諾一定能顯示。
  // 孤兒 content script 偵測(錯誤訊息版):擴充功能更新／重載後，既開分頁
  // 裡的舊 content script 仍在跑，但 chrome.runtime 這條線已斷，
  // sendMessage 會同步丟出帶「Extension context invalidated」字樣的例外。
  // 只用來把 catch 到的錯誤分類成看得懂的警告文字，不改變控制流。
  function isContextInvalidated(err) {
    var msg = (err && err.message) || String(err);
    return /extension context invalidated/i.test(msg);
  }

  // 送 background 失敗時一律留下 console 訊號:這兩個 catch 原本是完全靜默
  // 的，孤兒情境下(擴充功能剛更新)使用者的複製照做、勾勾照亮、紀錄卻靜
  // 默丟失，連除錯時都找不到任何線索。孤兒與一般失敗分開措辭，孤兒明講
  // 「請重新整理頁面」——這是唯一的復原方式(不動作的話，background 的自
  // 癒重注入也會補上新的 content script，見 background.js 的
  // reinjectIntoOpenTabs)。
  function warnSendFailure(scope, err) {
    if (isContextInvalidated(err)) {
      console.warn(
        '[threads-clean-link] ' + scope + ':擴充功能情境已失效(擴充功能剛更新或重載)，這次沒有送達 background，請重新整理頁面',
        err
      );
    } else {
      console.warn('[threads-clean-link] ' + scope + ':送給 background 失敗', err);
    }
  }

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
        // guard 端(clipboard-guard.js)已經在自己那層決定要不要夾帶這兩
        // 個欄位(original 與 cleanUrl 相同就不夾、removedParams 空陣列
        // 就不夾)，這裡原樣照轉，缺席就是缺席，不硬造。
        //
        // 這裡仍要做「型別 + 邊界」這一層把關，不能只信任 undefined 判斷
        // ——這條 postMessage 管道內容由頁面腳本自由指定，一則刻意灌爆的
        // 假通知可能夾帶超長 original 字串或超大 removedParams 陣列，直
        // 接越過 content script → service worker 的程序邊界。original
        // 比照既有的 MAX_CLEAN_URL_LENGTH 做型別+長度檢查(與 cleanUrl 同
        // 一種「頁面可控字串」，用同一把尺);removedParams 檢查
        // Array.isArray + 筆數上限，超限就整欄丟棄(不做逐筆截斷——這裡
        // 只負責擋住超大 payload，逐筆欄位 sanitize 交給 background.js
        // 的 sanitizeRemovedParams)。
        if (
          typeof data.original === 'string' &&
          data.original &&
          data.original.length <= MAX_CLEAN_URL_LENGTH
        ) {
          payload.original = data.original;
        }
        if (Array.isArray(data.removedParams) && data.removedParams.length <= MAX_REMOVED_PARAMS) {
          payload.removedParams = data.removedParams;
        }
        // share/strip 這兩條自動路徑(clipboard-guard.js 經這裡轉發)原本
        // 沒有貼文容器可用(clipboard-guard.js 在 MAIN
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
        // 轉發失敗不影響其餘橋接流程：background 端的通知本來就是盡力而
        // 為。但不再靜默吞掉——留一則 console.warn，孤兒情境才有跡可循。
        warnSendFailure('轉發淨化通知(cleanedNotice)', e);
      }
      return;
    }

    if (data.type !== REQ_TYPE) return;
    if (typeof data.requestId !== 'string' || !data.requestId) return;
    if (typeof data.url !== 'string' || !data.url) return;

    var requestId = data.requestId;
    // 記錄與淨化脫鉤(修正規格):recordOnly 由 clipboard-guard.js 依
    // autoClean 是否關閉決定並隨請求帶上——true 代表這次解析純粹是為了
    // 記錄(剪貼簿不會被改寫，使用者的複製動作本身沒有壞掉)，解析失敗時
    // 不該用頁內 toast 嚇使用者，改成 console.warn 就好；autoClean 開啟
    // (recordOnly=false)時失敗 toast 維持現狀不變。非布林值一律視為
    // false(保守方向:預設仍是原本的「失敗要有頁內提示」)。
    var recordOnly = data.recordOnly === true;

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

    // 失敗時的信號分流:recordOnly 情境靜默(只留 console.warn 供除錯，不
    // 打斷使用者)，非 recordOnly(autoClean 開啟)維持既有的頁內失敗 toast。
    function handleFailure(reason) {
      if (recordOnly) {
        console.warn('[threads-clean-link] recordOnly 解析失敗(剪貼簿未受影響，僅略過記錄)', reason);
      } else {
        notifyResolveFailureToast(reason);
      }
    }

    try {
      chrome.runtime.sendMessage({ type: 'resolveShare', url: data.url }, function (response) {
        // lastError(SW 可能剛好休眠中被喚醒失敗、或訊息通
        // 道已關閉)與缺少有效回應(no-response)都屬「連線層」失敗，不是
        // 「解析層」真失敗——這種情境下使用者的複製動作本身通常已經成
        // 功，只是這次沒能順道解析／記錄，SW 冷啟時很常見。這兩種原因不
        // 在 post-icon.js 已知的三個解析失敗原因白名單內(invalid-url／
        // network-error／format-error)，若沿用既有的 handleFailure(非
        // recordOnly 時跳頁內 toast)，會落到 bgUnexpected(「未預期的錯
        // 誤」)這個嚇人但失真的文案，誤導使用者以為複製壞掉了。兩者一律
        // 只 console.warn，不呼叫 handleFailure(不論 recordOnly 與否都不
        // 跳 toast)；只有 SW 真的給出明確失敗原因(解析層真失敗)才維持既
        // 有的 handleFailure 分流(recordOnly 靜默 vs 頁內 toast)。
        var lastErr = chrome.runtime.lastError;
        if (lastErr) {
          var lastErrReason = String((lastErr && lastErr.message) || lastErr);
          reply({ ok: false, reason: lastErrReason });
          console.warn('[threads-clean-link] resolveShare 連線層失敗(不影響已複製的內容)', lastErrReason);
          return;
        }
        if (response && response.ok && typeof response.cleanUrl === 'string') {
          reply({ ok: true, cleanUrl: response.cleanUrl });
        } else if (response && typeof response.reason === 'string' && response.reason) {
          reply({ ok: false, reason: response.reason });
          handleFailure(response.reason);
        } else {
          reply({ ok: false, reason: 'no-response' });
          console.warn('[threads-clean-link] resolveShare 未收到有效回應(不影響已複製的內容)');
        }
      });
    } catch (e) {
      // sendMessage 同步丟例外（例如擴充功能情境已失效）：直接回報失敗，
      // 讓 MAIN world 立刻 fail-open(不必空等 2.5 秒逾時)，並留下 console
      // 訊號說明這次為什麼沒解析／沒記錄。
      reply({ ok: false, reason: 'bridge-exception' });
      warnSendFailure('轉發短碼解析請求(resolveShare)', e);
      handleFailure('bridge-exception');
    }
  });

  // ------------------------------------------------------------
  // v1.1 設定規格 S6：載入時讀一次 chrome.storage.sync，把設定經
  // postMessage 以 TCL_SETTINGS_PUSH 下放到 MAIN world（clipboard-guard.js
  // 沒有 chrome.* API，只能靠這條管道拿到設定）；chrome.storage.onChanged
  // 觸發時（例如使用者在 popup 切換開關）再次推播最新值。
  // ------------------------------------------------------------

  // 只下放 autoClean/saveHistory 兩顆鍵:postCopyEnabled 只影響 ISOLATED
  // world 的 post-icon.js 是否注入 icon，不需要下放給沒有 chrome.* API
  // 的 clipboard-guard.js。autoClean 預設值 false，clipboard-guard.js 的
  // 內建預設值需同步。saveHistory 讓 clipboard-guard.js 的 recordOnly
  // (autoClean 關閉)流程可以在 saveHistory 也關閉時直接省掉整個解析請
  // 求(解析結果反正不會被 background.js 的 recordHistory 收下)，不浪費
  // 一次網路往返。
  var SETTINGS_PUSH_TYPE = 'TCL_SETTINGS_PUSH';
  var SETTINGS_KEYS = ['autoClean', 'saveHistory'];
  var SETTINGS_DEFAULTS = {
    autoClean: false,
    saveHistory: true,
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
        saveHistory: lastKnownSettings.saveHistory,
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
