// post-icon.js — 在 Threads 貼文互動列(讚/回覆/轉發/分享那一排)注入一顆
// 「複製連結」icon，點擊後把貼文的乾淨網址(去 query/hash)寫入剪貼簿。
// ISOLATED world content script，比照 bridge.js 的 ES5 IIFE 風格。
//
// 純函式 pickPermalink / buildPostUrl / hasExistingIcon / pickActionRowIndex
// 供 Node 測試以 require() 直接載入使用；模組頂層任何碰 document /
// MutationObserver 的 DOM 注入邏輯一律用 `typeof document !== 'undefined'`
// 守衛包住，讓 Node 環境(無 document 全域)require() 時不丟例外、不產生
// 副作用。
(function (root) {
  'use strict';

  // ============================================================
  // 純函式區(守衛外，Node 測試與瀏覽器共用)
  // ============================================================

  // 互動列消歧用的白名單：貼文容器內符合「直屬子元素 >=4 個、每個都有
  // [role="button"] svg[aria-label]」這個結構條件的候選列，不一定只有
  // 一個——例如影片貼文會多一條「追蹤/更多/已靜音/排序/附加影音內容」的
  // 播放器工具列，結構上也符合，但那不是讚/回覆/轉發/分享的互動列。有
  // 多個候選時，優先用這份白名單比對候選列內各按鈕的 aria-label，交集
  // >= 3 視為命中真正的互動列(本擴充功能 UI 只支援 zh/en，頁面語言主力
  // 也是這兩種，先覆蓋主場，語言無關性因此「降級為後備」而非放棄)；白
  // 名單以外的語言全不中時，見 pickActionRowIndex 內的後備規則。
  var ACTION_ROW_LABEL_WHITELIST = ['讚', '回覆', '轉發', '分享', 'Like', 'Reply', 'Repost', 'Share'];

  // 從多個互動列候選(每個候選是一份「依子元素順序排列的 aria-label 陣列」
  // 組成的清單)中挑出真正的互動列，回傳選中的 index；候選清單為空或非陣
  // 列一律回傳 null，不丟例外。
  //   - 只有 1 個候選：直接選它，不需要消歧。
  //   - 多個候選：依文件序找第一個與 ACTION_ROW_LABEL_WHITELIST 交集
  //     >= 3 的候選(讚/回覆/轉發/分享或 Like/Reply/Repost/Share 命中
  //     3 個以上，才夠有把握判定是真的互動列，避免誤判)。
  //   - 全不中(頁面語言不在白名單覆蓋範圍內)：退回語言無關的結構後備規
  //     則——取文件序最後一個候選。實測影片工具列在互動列「之前」，互
  //     動列本身貼在貼文內容最底部，所以文件序最後一個就會是真正的互動
  //     列。
  function pickActionRowIndex(candidateLabelsList) {
    if (!Array.isArray(candidateLabelsList) || candidateLabelsList.length === 0) return null;
    if (candidateLabelsList.length === 1) return 0;

    for (var i = 0; i < candidateLabelsList.length; i++) {
      var labels = candidateLabelsList[i];
      if (!Array.isArray(labels)) continue;
      // 用 Set 去重後再數：命中的是「相異標籤數」而非「命中次數」，避免
      // 同一顆按鈕的 aria-label 因某種原因重複出現在陣列中(例如
      // ['分享','分享','分享','x'])，光靠次數就假性湊到門檻。
      var hitLabels = new Set();
      for (var j = 0; j < labels.length; j++) {
        if (ACTION_ROW_LABEL_WHITELIST.indexOf(labels[j]) !== -1) hitLabels.add(labels[j]);
      }
      if (hitLabels.size >= 3) return i;
    }

    return candidateLabelsList.length - 1;
  }

  // 從貼文容器內收集到的候選 href(a[href*="/post/"])中挑出「貼文本體」
  // 的連結：排除以 /media 結尾者(那是圖片/影片檢視器連結，不是貼文本身)，
  // 取過濾後、依原陣列順序的第一個。全被排除、空陣列、非陣列輸入一律回
  // 傳 null，不丟例外。
  function pickPermalink(hrefs) {
    if (!Array.isArray(hrefs)) return null;
    for (var i = 0; i < hrefs.length; i++) {
      var href = hrefs[i];
      if (typeof href === 'string' && !/\/media$/i.test(href)) {
        return href;
      }
    }
    return null;
  }

  // 從貼文容器內收集到的候選(每個候選帶 href 與「是否直屬本容器」布林
  // ownContainer)中，過濾出「確實屬於本容器」的 href，依原陣列順序保留。
  // 排除巢狀在容器內的引用/回覆貼文所貼出的候選(ownContainer 為 false)，
  // 避免引用貼文誤取到被引文的 permalink——比照 collectActionRowCandidates
  // 的 closest('div[data-pressable-container]') 巢狀容器防護，同一套判斷
  // 邏輯搬到純函式讓兩處共用同一個不變量。輸入非陣列、候選形狀不對(缺
  // href 或非字串 href)一律略過該筆，不丟例外；輸入非陣列直接回傳空陣列。
  function filterOwnContainerHrefs(candidates) {
    if (!Array.isArray(candidates)) return [];
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && c.ownContainer && typeof c.href === 'string') out.push(c.href);
    }
    return out;
  }

  // 以 href 為相對路徑、origin 為基底組出絕對 URL，並去除 query(?...)與
  // hash(#...)。href 非字串、origin 非合法絕對來源、或組不出合法 URL 等
  // 任何非法輸入一律回傳 null，不丟例外(URL 建構子的例外在這裡吞掉)。
  // 組出的 URL 一律要求與 origin 同源：href 可能是 'javascript:...'(origin
  // 為 'null')或 '//evil.com/x' 這類協定相對輸入(換掉 host)，用 origin
  // 全等檢查一次擋掉，避免非常規 scheme 或換域結果被寫進剪貼簿；真正的
  // 貼文 permalink 都是 '/@user/post/ID' 這類同源相對路徑，不受影響。
  function buildPostUrl(href, origin) {
    if (typeof href !== 'string') return null;
    try {
      var url = new URL(href, origin);
      // Threads permalink 現皆同源相對路徑;若日後出現跨子網域/跨 TLD 絕
      // 對連結,此檢查會靜默擋下,屆時需放寬為 host 白名單。
      if (url.origin !== new URL(origin).origin) return null;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  // 擷取內文摘要(extractExcerpt)時，逐一判斷候選文字段落要 push(當
  // 內文)、skip(跳過但繼續看下一個候選)、還是 stop(視為內文區段已結
  // 束，中止收集)。抽成純函式方便測試，DOM 層的 extractExcerpt 只負責
  // 收集候選文字、呼叫這裡做決策。
  //
  // 相對時間戳記("18小時"／"4h"／"2026-4-29" 這類短字串)常以獨立
  // [dir="auto"] span 呈現，且緊跟在作者名之後、貼文內文之前，擷取內文
  // 時需要跳過，否則會把時間戳記誤當內文的第一段。僅在「尚未收集到任何
  // 內文」時才套用這條過濾——時間戳記依版面必定出現在內文之前，一旦已
  // 經開始收集內文，之後若再出現形似「3天」「2026-4-29」的字串，那是
  // 使用者自己寫的內文(單獨成行)，不該被誤判成時間戳記丟棄。涵蓋 zh/en
  // 常見單位字與絕對日期(YYYY-M-D)格式；整串錨定(^...$)避免誤傷更長的
  // 真實內文。
  var RELATIVE_TIME_RE =
    /^(\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)|\d+\s*(秒|分鐘|小時|天|週|周)|\d{4}-\d{1,2}-\d{1,2}|now|Just now|現在|剛剛)$/i;

  // 讚數/回覆數/轉發數這類互動計數，實測格式包含純數字("97")、千分位逗
  // 號("2,440")、以及可能的 K/M/B 縮寫("1.2K")。內文若掃到這種計數字
  // 串，視為「內文區段已經結束、進入互動列的計數區」的邊界訊號，中止收
  // 集。要求以數字開頭(`^\d`)，避免內文中單獨成行的純標點(例如
  // 「...」)被誤判成計數而提早截斷。
  var COUNT_LIKE_RE = /^\d[\d,.]*[KMB]?$/i;

  // hasContent:目前是否已經收集到至少一段內文(parts.length > 0)，用來
  // 決定 RELATIVE_TIME_RE 要不要套用(見上方註解)。text 非字串一律視為空
  // 字串處理。
  function classifyExcerptCandidate(text, hasContent) {
    var normalized = typeof text === 'string' ? text : '';
    if (COUNT_LIKE_RE.test(normalized)) return 'stop';
    if (!normalized) return hasContent ? 'stop' : 'skip';
    if (!hasContent && RELATIVE_TIME_RE.test(normalized)) return 'skip';
    return 'push';
  }

  // postCopyEnabled(貼文複製按鈕開關)預設 true，只有明確存成 false 才視
  // 為關閉；其餘(true／undefined／未設定過／其他型別的雜訊值)一律視為啟
  // 用。正規化邏輯抽成純函式，讀取 storage 的 fallback 與
  // storage.onChanged 收到新值時都呼叫這裡，行為保證一致。
  function resolvePostCopyEnabled(rawValue) {
    return rawValue === false ? false : true;
  }

  // share/strip 解析在 Threads 頁面內失敗時(bridge.js 收到 resolveShare
  // 的 ok:false 回應或同義訊號)，用頁內 toast 提示使用者。文字沿用
  // background.js 右鍵路徑既有的失敗文案 i18n key，
  // 三個已知原因(來自 background.js 的 handleResolveShareMessage)逐一
  // 對應；其餘原因(bridge/guard 自身的連線層失敗，如逾時、通道關閉、
  // sendMessage 例外)一律 fallback 到 bgUnexpected，比照右鍵路徑「未預
  // 期錯誤」的既有處理方式。純函式，供 Node 測試與瀏覽器共用。
  var RESOLVE_FAILURE_KEY_MAP = {
    'invalid-url': 'bgInvalid',
    'network-error': 'bgNetworkError',
    'format-error': 'bgFormatError',
  };
  function resolveFailureToastKey(reason) {
    if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(RESOLVE_FAILURE_KEY_MAP, reason)) {
      return RESOLVE_FAILURE_KEY_MAP[reason];
    }
    return 'bgUnexpected';
  }

  // bridge.js 收到 TCL_CLEANED_NOTICE 轉發給 background 前，需要在目前
  // 頁面 DOM 找出「這個乾淨網址對應的貼文容器」，才能就地補
  // author/handle/excerpt。findContainerByCleanUrl(見下)的比對核心抽成
  // 這兩個純函式，供 Node 測試直接載入。
  //
  // 從絕對或相對的網址／href 字串擷取「path 段」：去 query(?...)、去
  // hash(#...)、去尾隨斜線，其餘原樣保留(不動大小寫——Threads 的
  // handle／post id 大小寫有意義，不該被這裡的比對邏輯抹平)。用 URL 建
  // 構子搭配佔位 base(相對路徑也能解析出 pathname，佔位 base 本身不影
  // 響結果)取代自己刻正則剖析 host，同時複用瀏覽器與 Node 都內建的 URL
  // 全域。輸入非字串、空字串、或組不出合法 URL 一律回傳 null，不丟例外。
  function extractPostPath(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      var url = new URL(value, 'http://tcl-path-placeholder.invalid');
      var pathname = url.pathname.replace(/\/+$/, '');
      return pathname || '/';
    } catch (e) {
      return null;
    }
  }

  // 比較兩個網址／href 字串是否指向「同一篇貼文」：只比對 path 段(見
  // extractPostPath)，容忍尾隨斜線與 query/hash 差異、也容忍其中一個是
  // 絕對網址、另一個是頁面 DOM 上常見的相對路徑(如 '/@user/post/ID')。
  // 任一邊解析失敗一律回傳 false，不丟例外。
  function isSamePostPath(a, b) {
    var pathA = extractPostPath(a);
    var pathB = extractPostPath(b);
    return !!pathA && !!pathB && pathA === pathB;
  }

  // 輸入一個乾淨貼文網址，在目前頁面 DOM 找出對應的貼文容器：掃過
  // document 內所有 a[href*="/post/"]，用 isSamePostPath 逐一比對，命中
  // 後 climb 最近的 div[data-pressable-container] 祖先並回傳。找不到、
  // 輸入不合法、或任何一步丟例外一律回傳 null。碰 document 的邏輯用
  // `typeof document !== 'undefined'` 守衛包住(Node 測試環境直接回傳
  // null，不丟例外)，因此雖然定義在守衛外的純函式區，仍是給 Node 測試
  // 用的安全 no-op；真正的 DOM 行為由瀏覽器整合層驗證(bridge.js 呼叫
  // root.TCLPostIcon.findContainerByCleanUrl)。
  function findContainerByCleanUrl(url) {
    if (typeof document === 'undefined' || typeof url !== 'string' || !url) return null;
    try {
      var anchors = document.querySelectorAll('a[href*="/post/"]');
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute('href');
        if (isSamePostPath(url, href)) {
          var container = anchors[i].closest ? anchors[i].closest('div[data-pressable-container]') : null;
          if (container) return container;
        }
      }
    } catch (e) {
      // 找不到就回傳 null，不丟例外。
    }
    return null;
  }

  // 擴充功能情境(chrome.runtime)是否已經失效——「孤兒 content script」偵測。
  //
  // 擴充功能更新／重載／停用後，既開分頁裡的舊 content script 不會被移除，
  // 它照樣在跑、照樣抓得到 DOM，但 chrome.runtime.id 會變成 undefined，之
  // 後任何 chrome.runtime.sendMessage 都會同步丟出「Extension context
  // invalidated」。以 chrome.runtime.id 當唯一判準:它是同步、無副作用、不
  // 必真的送出一則訊息就問得到的信號，因此可以在「點擊當下、寫剪貼簿之
  // 前」就先問一次，不留下「會複製但不會記錄」的假按鈕。
  //
  // chrome 本身缺席(非擴充功能環境、Node 測試 sandbox)也一律視為已失效
  // ——這種環境下訊息本來就送不出去，行為上與孤兒等價，保守方向一致。
  function isExtensionContextLost(chromeRef) {
    if (!chromeRef || !chromeRef.runtime) return true;
    var id = chromeRef.runtime.id;
    return id === undefined || id === null || id === '';
  }

  // scope(貼文容器或互動列)內是否已經注入過我們的 icon，用來讓注入邏輯
  // 冪等，避免重複插入。scope 缺失或不是帶 querySelector 的物件一律回傳
  // false，不丟例外。
  //
  // 【孤兒陷阱】這個冪等檢查只看 DOM 上有沒有 .tcl-copy-icon 節點，看不出
  // 那顆 icon 是「本次載入的腳本注入的」還是「擴充功能更新前、已孤兒化的舊
  // 腳本留下的」。自癒重注入(background.js 的 reinjectIntoOpenTabs)因此必
  // 須在新腳本啟動時先清掉既有 icon 節點(見 DOM 守衛內 init() 開頭的
  // removeAllIcons())，否則新腳本會在這裡誤判「已經注入過」而整頁跳過，頁
  // 面上只剩一排點了不會記錄的假 icon。
  function hasExistingIcon(scope) {
    if (!scope || typeof scope.querySelector !== 'function') return false;
    try {
      return !!scope.querySelector('.tcl-copy-icon');
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // 模組匯出(宣告在 DOM 守衛「外」，因為裡面全是純函式，Node 測試環境也
  // 用得到)。DOM 守衛內若定義了需要碰 document 的 API(findContainerByCleanUrl
  // 已經自帶守衛，屬例外；extractPostInfo／showResolveFailureToast 這類
  // 真正需要 document/t()/樣式基礎設施的函式，改在守衛內對這個物件用
  // `api.xxx = xxx` 掛上去)，掛的動作發生在守衛內、但 api 變數本身在守衛
  // 外宣告——閉包讓守衛內的程式碼能直接讀寫外層這個變數。Node 環境永遠
  // 不會進入守衛，api 上就只會有這裡列出的純函式。
  // ============================================================
  var api = {
    pickPermalink: pickPermalink,
    buildPostUrl: buildPostUrl,
    hasExistingIcon: hasExistingIcon,
    pickActionRowIndex: pickActionRowIndex,
    filterOwnContainerHrefs: filterOwnContainerHrefs,
    classifyExcerptCandidate: classifyExcerptCandidate,
    isSamePostPath: isSamePostPath,
    resolveFailureToastKey: resolveFailureToastKey,
    resolvePostCopyEnabled: resolvePostCopyEnabled,
    findContainerByCleanUrl: findContainerByCleanUrl,
    isExtensionContextLost: isExtensionContextLost,
  };

  // ============================================================
  // DOM 注入層(瀏覽器整合層)。碰 document / MutationObserver 的邏輯全部
  // 收在這個守衛裡，Node 測試環境 require() 本檔時直接跳過整段，不執行、
  // 不丟例外。
  // ============================================================
  if (typeof document !== 'undefined') {
    (function () {
      var ICON_CLASS = 'tcl-copy-icon';
      var STYLE_ID = 'tcl-post-icon-style';
      var TOOLTIP_CLASS = 'tcl-copy-icon-tooltip';
      var TOOLTIP_VISIBLE_CLASS = 'tcl-copy-icon-tooltip--visible';
      var SVG_WRAP_CLASS = 'tcl-copy-icon-svg';
      var COPIED_RESET_MS = 1500;
      var SCAN_DEBOUNCE_MS = 60;
      // 氣泡淡出動畫(見 TOOLTIP_CLASS 的 transition:opacity .12s)跑完後才
      // 還原文字，避免文字在淡出過程中(仍看得見)跳變。留一點緩衝，比
      // .12s 稍長。
      var TOOLTIP_TEXT_RESET_DELAY_MS = 150;

      // ---- 本次載入的腳本實例身分(自癒重注入用)----
      //
      // 擴充功能更新後，background 會對既開的 threads 分頁重新注入本腳本
      // (見 background.js 的 reinjectIntoOpenTabs)。此時同一個頁面上可能
      // 同時存在兩個實例:已孤兒化的舊實例(chrome.runtime 已失效，但
      // MutationObserver 還在跑)與剛注入的新實例。每顆 icon 掛上注入者的
      // 實例編號，讓「孤兒退場」只收掉自己那批死 icon，不會順手把新實例剛
      // 補上的活 icon 一起清掉(那會讓自癒白做一場——新實例的 WeakSet 已記
      // 下「這個容器注入過了」，不會再補回來)。
      // 值只用時間戳與亂數(英數與連字號)，可以安全地放進屬性選擇器。
      var OWNER_ATTR = 'data-tcl-owner';
      var INSTANCE_ID = 'tcl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

      // 本實例是否已經退場(偵測到自己是孤兒)。退場後掃描注入全面停擺，
      // MutationObserver 也會斷開，不再對頁面產生任何副作用。
      var disposed = false;
      var observerRef = null;

      function contextLost() {
        return isExtensionContextLost(typeof chrome !== 'undefined' ? chrome : null);
      }

      // 實例退場:斷開 observer、清掉自己注入的 icon，並讓後續掃描一律短
      // 路。冪等，重複呼叫安全。兩種呼叫時機:(1)孤兒自檢通過(擴充功能更
      // 新後 chrome.runtime 失效);(2)冪等交棒——同頁載入的下一個新實例透過
      // root.__tclPostIconDispose 叫本實例先退場再接手(見 init)。
      function retireOrphanInstance() {
        if (disposed) return;
        disposed = true;
        try {
          if (observerRef && typeof observerRef.disconnect === 'function') observerRef.disconnect();
        } catch (e) {
          // 斷不開就算了，disposed 旗標本身已足以讓掃描短路。
        }
        observerRef = null;
        removeOwnIcons();
      }

      // 鏈結(link)圖示與勾勾(check)圖示：20px、stroke=currentColor、
      // fill=none，顏色繼承原生按鈕的灰(不自己指定顏色)。內建一個空的
      // <title> 子元素:原生互動列每顆 svg[aria-label] 內都有 <title> 子
      // 元素，仿照同一結構保留無障礙語意(見 createIconElement 的
      // applyIconTitle)；但實際觸發 hover 原生 tooltip 的是外層 div 的
      // title 屬性，不是這顆 svg <title>——svg 設了 pointer-events:none
      // (見 injectStyle 的 SVG_WRAP_CLASS 規則)，游標永遠不會落在 svg
      // 上，svg 內 <title> 因此不會觸發瀏覽器原生 tooltip。<title> 留空
      // 字串，內容由 applyIconTitle() 用 textContent 動態填入語言字典
      // 值，innerHTML 本身仍只含靜態常數。
      var LINK_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<title></title>' +
        '<path d="M9 17H7A5 5 0 0 1 7 7h2"/>' +
        '<path d="M15 7h2a5 5 0 1 1 0 10h-2"/>' +
        '<path d="M8 12h8"/>' +
        '</svg>';
      var CHECK_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<title></title>' +
        '<path d="M20 6 9 17l-5-5"/>' +
        '</svg>';

      // 目前使用的語言，載入時由 chrome.storage.sync 的 langPref 解析；
      // storage.onChanged 觸發時即時更新既有 icon 的文案。
      var currentLocale = 'en';

      // postCopyEnabled(貼文複製按鈕開關)。讀取完成前的預設值就是最終預
      // 設值 true(見 resolvePostCopyEnabled)，讀取
      // 失敗也維持這個值——與 langPref 的「先假設預設值立刻動作、讀到後
      // 再補正」策略一致。
      var postCopyEnabled = true;

      // i18n.js 理論上一定會在 post-icon.js 之前載入(manifest content_scripts
      // 陣列順序保證)，但防禦性地假設 TCLI18N 可能不存在或呼叫時丟例外：
      // 退回這份內建的英文字面值表，不要讓使用者看到原始 key 字串。
      // TCLI18N.t() 對不存在的 key 會直接回傳 key 本身字串(見 i18n.js 的
      // t() 實作)，不會丟例外，一般的 t(key) 掉不到下面的
      // FALLBACK_STRINGS——favContextLost(掛在複製 icon 的
      // notifyBackgroundCleaned 失敗路徑)才需要專屬的 tContextLost()，見
      // 下方。
      var FALLBACK_STRINGS = {
        iconTooltip: 'Copy original link',
        iconCopied: 'Original link copied',
        favContextLost: {
          zh: '擴充功能已更新，請重新整理頁面',
          en: 'Extension updated — please refresh the page',
        },
      };

      function t(key) {
        try {
          if (root.TCLI18N && typeof root.TCLI18N.t === 'function') {
            return root.TCLI18N.t(currentLocale, key);
          }
        } catch (e) {
          // 掉到下面的內建 fallback。
        }
        return FALLBACK_STRINGS[key] || key;
      }

      // favContextLost 專屬查詢:字典若真的有這個 key，回傳的值不會等於
      // key 本身字串，直接採用；字典還沒有這個 key 時，t() 會原樣把 key
      // 字串傳回來，這裡改用
      // FALLBACK_STRINGS.favContextLost 依目前語言取值，不讓使用者看到原
      // 始 key。
      function tContextLost() {
        try {
          if (root.TCLI18N && typeof root.TCLI18N.t === 'function') {
            var value = root.TCLI18N.t(currentLocale, 'favContextLost');
            if (value && value !== 'favContextLost') return value;
          }
        } catch (e) {
          // 掉到下面的內建 fallback。
        }
        var fallback = FALLBACK_STRINGS.favContextLost || {};
        return fallback[currentLocale] || fallback.en || 'favContextLost';
      }

      // ---- 從貼文容器 DOM 擷取 author/handle/excerpt，在複製 icon 成功
      // 寫入剪貼簿後呼叫(見 notifyBackgroundCleaned)，附進 cleanedNotice
      // 訊息讓 background 記錄進淨化紀錄。bridge.js 的 share/strip 路徑
      // 透過 root.TCLPostIcon.findContainerByCleanUrl 找到容器後，也是
      // 呼叫這兩個函式取得同一組欄位。三者皆為選填，擷取不到就整欄不寫
      // 進回傳物件(background 端的欄位驗證只處理型別為 string 的值)。
      // RELATIVE_TIME_RE／COUNT_LIKE_RE／classifyExcerptCandidate 定義在
      // 檔案頂部的純函式區，供 Node 測試直接載入，這裡只呼叫。----

      // 與 background.js 的長度上限對齊；這裡預先截斷一次，background 端
      // 仍會再做一次防禦性截斷，兩處各自獨立不互相依賴。
      var EXCERPT_MAX = 2000;

      // 複製一份節點、移除所有 [role="button"] 子孫(內文常見的「查看翻
      // 譯」按鈕就是這種結構，混在內文 span 尾端)後再取 textContent，把
      // 這類互動按鈕的文字從內文中過濾掉。用 cloneNode 而非直接改動原節
      // 點，不影響頁面實際顯示。
      function cleanElementText(el) {
        var clone = el.cloneNode(true);
        var buttons = clone.querySelectorAll ? clone.querySelectorAll('[role="button"]') : [];
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].parentNode) buttons[i].parentNode.removeChild(buttons[i]);
        }
        return (clone.textContent || '').trim();
      }

      // ---- 擷取作者顯示名／帳號代稱:取容器內第一個「屬於本容器本身」
      // (巢狀引用貼文防護，同 filterOwnContainerHrefs 的判斷)、且 href
      // 不含 /post/ 的 a[href^="/@"](排除時間戳記那顆會連到貼文本身permalink
      // 的 /@user/post/ID 連結)。實機探勘 3 種情境(feed／單篇貼文頁／引
      // 用貼文)皆只看到 handle 本身，沒有另外呈現的「顯示名稱」節點，故
      // author 與 handle 目前實測內容相同;handle 額外補上 '@' 前綴(取自
      // href)，author 用可見文字(不含 '@')。若擷取不到就整欄不回傳。----
      function extractAuthorHandle(container) {
        var result = {};
        try {
          var anchors = container.querySelectorAll('a[href^="/@"]');
          for (var i = 0; i < anchors.length; i++) {
            var anchor = anchors[i];
            var href = anchor.getAttribute('href') || '';
            if (href.indexOf('/post/') !== -1) continue;
            var ownContainer = anchor.closest
              ? anchor.closest('div[data-pressable-container]') === container
              : true;
            if (!ownContainer) continue;
            var text = cleanElementText(anchor);
            if (text) {
              result.author = text;
              result.handle = href.charAt(0) === '/' ? href.slice(1) : href;
            }
            break;
          }
        } catch (e) {
          // 擷取失敗不影響其餘欄位，整欄略過即可(協定允許欄位缺席)。
        }
        return result;
      }

      // ---- 擷取貼文內文摘要:依文件序掃過容器內所有 [dir="auto"] span，
      // 只收「屬於本容器本身」(排除巢狀引用貼文自己的內文)、「不在任何
      // <a> 內」(作者名／時間戳記／引用卡片標題都是整串包在 <a> 裡，內
      // 文本身不是)的候選，交給純函式 classifyExcerptCandidate 決定
      // push／skip／stop(規則見該函式註解)。多段內文(部分貼文每行是獨
      // 立 span 而非同一個 span 內用 \n 分隔)用 '\n' 接起來。擷取不到任
      // 何內容回傳 undefined，由呼叫端決定要不要放進訊息。----
      function extractExcerpt(container) {
        try {
          var spans = container.querySelectorAll('[dir="auto"]');
          var parts = [];
          for (var i = 0; i < spans.length; i++) {
            var el = spans[i];
            if (el.closest && el.closest('div[data-pressable-container]') !== container) continue;
            if (el.closest && el.closest('a')) continue;
            var text = cleanElementText(el);
            var action = classifyExcerptCandidate(text, parts.length > 0);
            if (action === 'stop') break;
            if (action === 'skip') continue;
            parts.push(text);
          }
          if (!parts.length) return undefined;
          return parts.join('\n').slice(0, EXCERPT_MAX);
        } catch (e) {
          return undefined;
        }
      }

      // ---- 合併 extractAuthorHandle／extractExcerpt 成單一呼叫，回傳可
      // 以直接展開進 cleanedNotice payload 的物件(只含實際擷取到的欄
      // 位)。複製 icon 自己的 notifyBackgroundCleaned 與 bridge.js(經
      // root.TCLPostIcon.extractPostInfo)共用同一份邏輯，避免兩處各自組
      // 一次「author/handle/excerpt 挑非 undefined 欄位」的判斷。----
      function extractPostInfo(container) {
        var info = extractAuthorHandle(container) || {};
        var excerpt = extractExcerpt(container);
        var result = {};
        if (info.author !== undefined) result.author = info.author;
        if (info.handle !== undefined) result.handle = info.handle;
        if (excerpt !== undefined) result.excerpt = excerpt;
        return result;
      }
      api.extractPostInfo = extractPostInfo;

      // ---- 樣式注入:hover 圓底高亮 + 點擊回饋氣泡，標 id 防重複注入 ----
      function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '.' + ICON_CLASS + '{position:relative;display:inline-flex;align-items:center;',
          'justify-content:center;width:36px;height:36px;border-radius:9999px;cursor:pointer;',
          'color:inherit;background-color:transparent;}',
          '.' + ICON_CLASS + ':focus-visible{outline:2px solid currentColor;outline-offset:1px;}',
          // hover 圓底:實機量測原生互動列按鈕的 hover 背景，深色主題是
          // rgb(30,30,30)、瞬間出現(無 transition)，這裡照抄精確值與行
          // 為。淺色主題同樣為實測值 rgb(245,245,245)(CDP 模擬
          // prefers-color-scheme 實測)。
          '@media (prefers-color-scheme: dark){.' + ICON_CLASS + ':hover{background-color:rgb(30,30,30);}}',
          '@media (prefers-color-scheme: light){.' + ICON_CLASS + ':hover{background-color:rgb(245, 245, 245);}}',
          // svg 設 pointer-events:none 讓滑鼠事件穿透到外層可互動的 div
          // (click/keydown 都綁在 el，見 createIconElement)，副作用是游
          // 標永遠不會落在 svg 上，svg 內 <title> 的原生 tooltip 因此永
          // 不觸發(原生互動列按鈕的 svg 是 pointer-events:auto 所以有
          // 效)。原生 tooltip 改掛在外層 div 的 title 屬性上才會觸發，見
          // createIconElement 的 el.title 設定。
          '.' + ICON_CLASS + ' .' + SVG_WRAP_CLASS + '{display:inline-flex;pointer-events:none;}',
          // 點擊後「已複製原始連結」的自繪回饋氣泡:hover 提示已改用外層
          // div 的原生 title 屬性(見 createIconElement 開頭的 el.title
          // 設定)，這顆 tooltip 元素不再靠 :hover 觸發，只在點擊回饋時
          // 由 showCopiedFeedback() 加上 TOOLTIP_VISIBLE_CLASS 類別顯
          // 示，COPIED_RESET_MS 後自動移除。
          '.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '{position:absolute;top:calc(100% + 6px);left:50%;',
          'transform:translateX(-50%);padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.4;',
          'white-space:nowrap;background:#1c1c1c;color:#fff;opacity:0;pointer-events:none;',
          'transition:opacity .12s ease;z-index:1000;}',
          '@media (prefers-color-scheme: light){.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '{background:#e5e5e5;color:#050505;}}',
          '.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '.' + TOOLTIP_VISIBLE_CLASS + '{opacity:1;}',
        ].join('');
        (document.head || document.documentElement).appendChild(style);
      }

      // ---- 頁內失敗 toast(share/strip 解析在 Threads 頁面內失敗時顯
      // 示)。固定定位在畫面底部置中，視覺語言比照複製 icon
      // 的自繪氣泡(同款深/淺主題配色、圓角、字級)，3 秒後自動淡出。單一
      // 常駐節點、重複呼叫會直接覆蓋文字並重新計時，不會疊出多個 toast。
      var TOAST_ID = 'tcl-toast';
      var TOAST_STYLE_ID = 'tcl-toast-style';
      var TOAST_VISIBLE_CLASS = 'tcl-toast--visible';
      var TOAST_DURATION_MS = 3000;
      var toastHideTimer = null;

      function injectToastStyle() {
        if (document.getElementById(TOAST_STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = TOAST_STYLE_ID;
        style.textContent = [
          '#' + TOAST_ID + '{position:fixed;left:50%;bottom:24px;',
          'transform:translateX(-50%) translateY(8px);padding:8px 16px;border-radius:8px;',
          'font-size:13px;line-height:1.4;max-width:min(80vw,420px);text-align:center;',
          'background:#1c1c1c;color:#fff;opacity:0;pointer-events:none;',
          'transition:opacity .15s ease,transform .15s ease;z-index:2147483647;}',
          '@media (prefers-color-scheme: light){#' + TOAST_ID + '{background:#e5e5e5;color:#050505;}}',
          '#' + TOAST_ID + '.' + TOAST_VISIBLE_CLASS + '{opacity:1;transform:translateX(-50%) translateY(0);}',
        ].join('');
        (document.head || document.documentElement).appendChild(style);
      }

      function showToast(text) {
        try {
          injectToastStyle();
          var el = document.getElementById(TOAST_ID);
          if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            (document.body || document.documentElement).appendChild(el);
          }
          el.textContent = text;
          el.classList.add(TOAST_VISIBLE_CLASS);
          if (toastHideTimer) clearTimeout(toastHideTimer);
          toastHideTimer = setTimeout(function () {
            toastHideTimer = null;
            el.classList.remove(TOAST_VISIBLE_CLASS);
          }, TOAST_DURATION_MS);
        } catch (e) {
          console.warn('[threads-clean-link] 顯示頁內 toast 失敗', e);
        }
      }

      // ---- 給 bridge.js 呼叫(root.TCLPostIcon.showResolveFailureToast):
      // share/strip 的短碼解析在 Threads 頁面內失敗時，顯示對應失敗文案
      // 的 toast。reason 依 resolveFailureToastKey(純函式區)對應到 i18n
      // key，文字沿用既有的 bgInvalid/bgNetworkError/bgFormatError/
      // bgUnexpected，不需要新增 i18n key。----
      function showResolveFailureToast(reason) {
        showToast(t(resolveFailureToastKey(reason)));
      }
      api.showResolveFailureToast = showResolveFailureToast;

      // ---- 單顆 icon 元素:圖示、tooltip、點擊/鍵盤複製邏輯 ----
      function createIconElement() {
        var el = document.createElement('div');
        el.className = ICON_CLASS;
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', t('iconTooltip'));
        // 原生 hover tooltip 掛在外層 div 的 title 屬性上(而不是 svg 內
        // 的 <title>):svg 設了 pointer-events:none 讓事件穿透到這顆可
        // 互動的 div，游標因此永遠不會落在 svg 上，svg 內 <title> 的原生
        // tooltip 不會觸發(原生按鈕的 svg 是 pointer-events:auto 才有
        // 效)。實機驗證掛在這顆 div 的 title 屬性可正常浮出 tooltip。
        el.setAttribute('title', t('iconTooltip'));
        // 注入者身分(見 INSTANCE_ID 註解):孤兒退場時只清自己這批。
        el.setAttribute(OWNER_ATTR, INSTANCE_ID);

        var iconWrap = document.createElement('span');
        iconWrap.className = SVG_WRAP_CLASS;
        iconWrap.innerHTML = LINK_SVG;
        el.appendChild(iconWrap);

        // 把目前語言的 iconTooltip 文字填進 SVG 內建的 <title> 子元素
        // (textContent，不是 innerHTML)。這顆 <title> 不會觸發瀏覽器原
        // 生 tooltip(見上方 el.title 一帶的說明)，純粹是仿照原生互動列
        // 按鈕結構保留的無障礙語意。iconWrap.innerHTML 每次换圖示
        // (LINK_SVG/CHECK_SVG 互換)都要重新呼叫一次，因為 <title> 節點
        // 會跟著整個 innerHTML 一起被換掉。
        function applyIconTitle() {
          var titleEl = iconWrap.querySelector('title');
          if (titleEl) titleEl.textContent = t('iconTooltip');
        }
        applyIconTitle();

        var tooltip = document.createElement('span');
        tooltip.className = TOOLTIP_CLASS;
        tooltip.textContent = t('iconTooltip');
        el.appendChild(tooltip);

        var resetTimer = null;
        var textResetTimer = null;

        function clearFeedbackTimers() {
          if (resetTimer) {
            clearTimeout(resetTimer);
            resetTimer = null;
          }
          if (textResetTimer) {
            clearTimeout(textResetTimer);
            textResetTimer = null;
          }
        }

        // 點擊複製成功後的回饋:swap 成勾勾圖示，並顯示自繪的「已複製原
        // 始連結」氣泡(TOOLTIP_VISIBLE_CLASS 觸發顯示)——hover 提示已改
        // 用外層 div 的原生 title 屬性，但原生 title 在 hover 中途不會
        // 即時刷新內容，只有這顆自繪氣泡能保證「點擊當下」立刻給使用者
        // 回饋。
        function showCopiedFeedback() {
          iconWrap.innerHTML = CHECK_SVG;
          applyIconTitle();
          tooltip.textContent = t('iconCopied');
          tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
          clearFeedbackTimers();
          resetTimer = setTimeout(function () {
            resetTimer = null;
            iconWrap.innerHTML = LINK_SVG;
            applyIconTitle();
            tooltip.classList.remove(TOOLTIP_VISIBLE_CLASS);
            // 移除 TOOLTIP_VISIBLE_CLASS 只是觸發淡出(opacity transition
            // .12s)，文字若同一 tick 就還原，淡出過程中仍看得見文字從
            // 「已複製原始連結」跳成「複製原始連結」。延後到動畫跑完後
            // 再還原，畫面上就只看得到淡出、看不到文字跳變。
            textResetTimer = setTimeout(function () {
              textResetTimer = null;
              tooltip.textContent = t('iconTooltip');
            }, TOOLTIP_TEXT_RESET_DELAY_MS);
          }, COPIED_RESET_MS);
        }

        // 收掉「已複製」的成功回饋:勾勾換回鏈結圖示、氣泡立即收起並還原
        // 文字。用在孤兒情境——複製雖然寫進剪貼簿了，但紀錄沒落盤，畫面
        // 上再留著勾勾與「已複製原始連結」會與實際結果矛盾(信號矛盾:勾
        // 勾說成功、紀錄其實丟了)。這裡不排 timer、直接同步還原，接著由
        // 呼叫端改用底部 toast(3 秒，見 showToast)講清楚「需要重新整理頁
        // 面」——這類非重新整理不能復原的錯誤，1.5 秒的小氣泡太容易被錯
        // 過。
        function revertCopiedFeedback() {
          clearFeedbackTimers();
          iconWrap.innerHTML = LINK_SVG;
          applyIconTitle();
          tooltip.classList.remove(TOOLTIP_VISIBLE_CLASS);
          tooltip.textContent = t('iconTooltip');
        }

        // 語言切換時(storage.onChanged)同步既有 icon 的 aria-label、外層
        // div 的原生 title 屬性(實際觸發 hover tooltip 的地方)、SVG
        // <title>(無障礙語意用途)與自繪 tooltip 文字；aria-label／title
        // 這種靜態常駐文案任何時候都可以立即刷新，但若正處於「已複製」
        // 的暫時狀態就不打斷自繪氣泡，等它自己復原後自然會用上新語言
        // (resetTimer 內的 t() 每次都即時查字典)。
        el._tclApplyLocale = function () {
          el.setAttribute('aria-label', t('iconTooltip'));
          el.setAttribute('title', t('iconTooltip'));
          applyIconTitle();
          if (!resetTimer && !textResetTimer) {
            tooltip.textContent = t('iconTooltip');
          }
        };

        function handleActivate(event) {
          if (event) {
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            if (typeof event.preventDefault === 'function') event.preventDefault();
          }

          // 孤兒偵測退場:擴充功能更新／重載後，這顆 icon 屬於已經孤兒化
          // 的舊 content script——剪貼簿照樣寫得進去，但 sendMessage 一
          // 定同步失敗，紀錄會靜默丟失。與其留一顆「會複製但不會記錄」的
          // 假按鈕，不如當場退場:清掉自己這批 icon 並用 toast 告訴使用者
          // 重新整理頁面(重新整理後 content script 會以新身分重新載入;
          // 使用者不動作的話，background 的自癒重注入也會補上新 icon)。
          // 判斷放在寫剪貼簿「之前」，不製造「複製成功但紀錄消失」的落差。
          if (contextLost()) {
            console.warn(
              '[threads-clean-link] 擴充功能情境已失效(擴充功能剛更新或重載)，此頁面的舊複製 icon 已停用，請重新整理頁面'
            );
            showToast(tContextLost());
            retireOrphanInstance();
            return;
          }

          var container = el.closest ? el.closest('div[data-pressable-container]') : null;
          if (!container) {
            console.warn('[threads-clean-link] 找不到貼文容器，略過複製');
            return;
          }

          // 巢狀容器防護:引用/回覆貼文會巢狀在本容器內，它自己的
          // a[href*="/post/"] 也會被 querySelectorAll 掃到，若不過濾，
          // 引用貼文可能誤取到被引文的 permalink。比照
          // collectActionRowCandidates 的同款判斷:錨點最近的貼文容器
          // 祖先必須就是目前這個 container 本身才算數。
          var anchors = container.querySelectorAll('a[href*="/post/"]');
          var candidates = [];
          for (var i = 0; i < anchors.length; i++) {
            var anchor = anchors[i];
            var ownContainer = anchor.closest
              ? anchor.closest('div[data-pressable-container]') === container
              : true;
            candidates.push({ href: anchor.getAttribute('href'), ownContainer: ownContainer });
          }
          var hrefs = filterOwnContainerHrefs(candidates);

          var permalink = pickPermalink(hrefs);
          if (!permalink) {
            console.warn('[threads-clean-link] 找不到貼文永久連結，略過複製');
            return;
          }

          var url = buildPostUrl(permalink, root.location.origin);
          if (!url) {
            console.warn('[threads-clean-link] 組不出合法的貼文網址，略過複製');
            return;
          }

          if (!root.navigator || !root.navigator.clipboard || typeof root.navigator.clipboard.writeText !== 'function') {
            console.warn('[threads-clean-link] 此環境不支援 clipboard.writeText');
            return;
          }

          try {
            root.navigator.clipboard
              .writeText(url)
              .then(function () {
                showCopiedFeedback();
                notifyBackgroundCleaned(url, container);
              })
              .catch(function (err) {
                console.warn('[threads-clean-link] 寫入剪貼簿失敗', err);
              });
          } catch (err) {
            console.warn('[threads-clean-link] 寫入剪貼簿時發生例外', err);
          }
        }

        // sendMessage 失敗時的錯誤分類:辨識「Extension context invalidated」
        // 類錯誤(孤兒情境)走專屬處理——先 console.warn 留下可查的訊號(否
        // 則紀錄靜默丟失時無從察覺)，收掉與事實矛盾的勾勾回饋，改用 3 秒
        // 底部 toast 說明需要重新整理，最後把自己這批已經失效的 icon 收乾
        // 淨。其餘錯誤(background 暫時無回應等)維持原本的 console.warn，不
        // 打斷已經成功的複製與勾勾回饋。
        function handleSendError(err) {
          var msg = err && err.message ? err.message : String(err);
          if (/extension context invalidated/i.test(msg)) {
            console.warn(
              '[threads-clean-link] 擴充功能情境已失效(擴充功能剛更新或重載)，這次複製沒有寫進淨化紀錄，請重新整理頁面',
              err
            );
            revertCopiedFeedback();
            showToast(tContextLost());
            retireOrphanInstance();
          } else {
            console.warn('[threads-clean-link] 通知 background 記錄淨化紀錄失敗', err);
          }
        }

        // 把「已複製乾淨連結」這件事轉知 background，讓淨化紀錄能收進這
        // 條路徑(kind:'icon'，不冒用右鍵選單的 'menu')。同時從貼文容器
        // DOM 順手擷取 author/handle/excerpt
        // 附進同一則訊息，讓這筆紀錄之後能在 options 頁的卡片牆呈現作者
        // 與內文摘要——三者皆為選填，擷取不到就整欄不放進 payload(協定
        // 允許缺席，background 端只認型別為 string 的值)。整段吞例外(除
        // 了轉給 handleSendError 分類)——chrome.runtime 不存在(context 已
        // 失效／非擴充功能頁面)或 sendMessage 本身丟例外，都不得影響前
        // 面已經成功的複製與勾勾回饋。
        //
        // MV3 下不帶 callback 呼叫 sendMessage 會回傳 Promise：background
        // 的 cleanedNotice 監聽器 return false(同步處理完即關通道)，該
        // Promise 會以「message port closed」reject，若不接 .catch 就會在
        // 頁面 console 留下 unhandled promise rejection。回傳值先防禦性
        // 檢查是不是真的 Promise(舊瀏覽器 sendMessage 可能不回傳任何東西)
        // 再接 .catch 交給 handleSendError 分類。
        function notifyBackgroundCleaned(url, container) {
          try {
            if (
              typeof chrome === 'undefined' ||
              !chrome.runtime ||
              typeof chrome.runtime.sendMessage !== 'function'
            ) {
              return;
            }
            var payload = { type: 'cleanedNotice', cleanUrl: url, kind: 'icon' };
            var info = extractPostInfo(container);
            if (info.author !== undefined) payload.author = info.author;
            if (info.handle !== undefined) payload.handle = info.handle;
            if (info.excerpt !== undefined) payload.excerpt = info.excerpt;

            var maybePromise = chrome.runtime.sendMessage(payload);
            if (maybePromise && typeof maybePromise.catch === 'function') {
              maybePromise.catch(handleSendError);
            }
          } catch (err) {
            handleSendError(err);
          }
        }

        el.addEventListener('click', handleActivate);
        el.addEventListener('keydown', function (event) {
          if (event && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')) {
            handleActivate(event);
          }
        });

        return el;
      }

      // ---- 找互動列候選:容器內每個 div，直屬子元素 >=4 個，每個子元素內
      // 都有 [role="button"] 包著 svg[aria-label]（按鈕 wrapper）。純結構
      // 判斷，不再額外查 getComputedStyle(display:flex)——這個掃描是熱路
      // 徑(MutationObserver 每次 debounce 後對全頁貼文重跑一輪)，
      // getComputedStyle 會強制觸發同步版面計算，犯不著多付這筆效能。
      //
      // 注意:結構條件不保證唯一——例如影片貼文會多一條「追蹤/更多/已靜
      // 音/排序/附加影音內容」的播放器工具列，結構上也符合，但那不是讚/
      // 回覆/轉發/分享的互動列。所以這裡收集「全部」候選，交給
      // pickActionRowIndex 消歧，不在第一個符合結構的候選就短路回傳。----
      function collectActionRowCandidates(container) {
        var candidates = container.querySelectorAll('div');
        var rows = [];
        for (var i = 0; i < candidates.length; i++) {
          var row = candidates[i];
          var children = row.children;
          if (!children || children.length < 4) continue;

          var allMatch = true;
          for (var j = 0; j < children.length; j++) {
            var hit = children[j].querySelector
              ? children[j].querySelector('[role="button"] svg[aria-label]')
              : null;
            if (!hit) {
              allMatch = false;
              break;
            }
          }
          if (!allMatch) continue;

          // 巢狀容器防護:候選 row 最近的貼文容器祖先必須就是目前掃描的
          // container 本身，否則代表這顆 row 其實屬於巢狀在裡面的引用/
          // 回覆貼文，不該被外層容器搶走。
          if (row.closest && row.closest('div[data-pressable-container]') !== container) continue;

          rows.push(row);
        }
        return rows;
      }

      // ---- 從候選列中挑出真正的互動列:只有 1 個候選直接用；多個候選交
      // 給 pickActionRowIndex(見純函式區)用 aria-label 白名單消歧，白名
      // 單全不中則退回文件序最後一個候選。----
      function findActionRow(container) {
        var rows = collectActionRowCandidates(container);
        if (rows.length === 0) return null;

        var labelsList = rows.map(function (row) {
          var labels = [];
          for (var j = 0; j < row.children.length; j++) {
            var svg = row.children[j].querySelector('[role="button"] svg[aria-label]');
            labels.push(svg ? svg.getAttribute('aria-label') : null);
          }
          return labels;
        });

        var idx = pickActionRowIndex(labelsList);
        return idx === null ? null : rows[idx];
      }

      // ---- 從同一列的原生按鈕取色，套到我們的 icon 上(currentColor 會自動
      // 跟上)。原生按鈕的實際顏色由 Threads 自己的樣式表決定，不同主題、
      // 不同版面都可能有些微差異，直接取樣比我們自己猜一組色票準確，也不
      // 用另外寫 dark/light 色票。取樣失敗(找不到、值為空)就靜默放棄，
      // 讓 icon 維持原本的 color:inherit，不丟例外。
      function applyNativeColor(icon, row) {
        try {
          // 取「最後一顆」原生 icon(分享小飛機)當色樣,不取第一顆——
          // 第一顆是愛心,按過讚會變紅,取樣到紅色整顆 icon 會跟著紅。
          // 本函式在插入我們的 icon 之前呼叫,此時列尾必為原生按鈕。
          var svgs = row.querySelectorAll('svg[aria-label]');
          if (!svgs.length) return;
          var nativeSvg = svgs[svgs.length - 1];
          var color = root.getComputedStyle(nativeSvg).color;
          if (color) icon.style.color = color;
        } catch (e) {
          // 取色失敗不影響注入，icon 仍會用 CSS 的 color:inherit 兜底。
        }
      }

      // ---- 掃描快取:避免每次 debounce 重掃全頁時，對「已經注入成功」或
      // 「找不到互動列」的容器一再重複跑 querySelectorAll('div') 這種昂貴
      // 操作。WeakMap/WeakSet 以容器節點本身當 key，節點被移除(feed 虛擬
      // 化卸載)後會自然被回收，不會累積記憶體。
      //   - injectedContainers:已成功注入的容器，快速跳過(hasExistingIcon
      //     的 querySelector 冪等檢查仍保留當保險，兩者互為備援)。
      //   - skippedContainers:連續 MAX_SCAN_FAILURES 次找不到互動列「且」
      //     距該容器第一次失敗已過 MAX_SCAN_FAILURES_MIN_AGE_MS 的容器，判
      //     定為「這個容器結構上就不會有互動列」而永久跳過；沒有立刻永久
      //     跳過是因為 React 可能晚渲染，貼文容器先掛載、互動列稍後才補
      //     上，太早放棄會漏掉這類貼文。純看次數不夠:debounce 掃描間隔只
      //     有 SCAN_DEBOUNCE_MS，3 輪掃描可能在 ~180ms 內就跑完，早於
      //     React 晚渲染完成的時間，必須額外加時間閘才不會判死太早。
      //   - scanFailCounts:每個容器目前連續失敗次數，成功注入後歸零。
      //   - scanFailFirstAt:每個容器「第一次」失敗的時間戳(Date.now())，
      //     成功注入後連同 scanFailCounts 一併歸零；只有在達到次數門檻
      //     「且」超過時間門檻時才會被判定永久跳過。
      var hasWeakCollections = typeof WeakMap !== 'undefined' && typeof WeakSet !== 'undefined';
      var injectedContainers = hasWeakCollections ? new WeakSet() : null;
      var skippedContainers = hasWeakCollections ? new WeakSet() : null;
      var scanFailCounts = hasWeakCollections ? new WeakMap() : null;
      var scanFailFirstAt = hasWeakCollections ? new WeakMap() : null;
      var MAX_SCAN_FAILURES = 3;
      var MAX_SCAN_FAILURES_MIN_AGE_MS = 2000;

      // ---- 對單一貼文容器做冪等注入 ----
      function injectIntoContainer(container) {
        if (injectedContainers && injectedContainers.has(container)) return;
        if (skippedContainers && skippedContainers.has(container)) return;

        if (hasExistingIcon(container)) {
          if (injectedContainers) injectedContainers.add(container);
          return;
        }

        var row = findActionRow(container);
        if (!row) {
          if (scanFailCounts) {
            var failCount = (scanFailCounts.get(container) || 0) + 1;
            scanFailCounts.set(container, failCount);
            if (scanFailFirstAt && !scanFailFirstAt.has(container)) {
              scanFailFirstAt.set(container, Date.now());
            }
            // 次數與時間都要達標才永久跳過:只看次數的話，debounce 掃描
            // 間隔短，3 輪很可能在 React 晚渲染完成前就跑完，會把還沒補
            // 上互動列的貼文誤判死。
            var firstFailAt = scanFailFirstAt ? scanFailFirstAt.get(container) : undefined;
            if (
              failCount >= MAX_SCAN_FAILURES &&
              skippedContainers &&
              typeof firstFailAt === 'number' &&
              Date.now() - firstFailAt >= MAX_SCAN_FAILURES_MIN_AGE_MS
            ) {
              skippedContainers.add(container);
            }
          }
          return;
        }
        if (hasExistingIcon(row)) {
          if (injectedContainers) injectedContainers.add(container);
          return;
        }

        var lastWrapper = row.children[row.children.length - 1];
        if (!lastWrapper) return;

        var icon = createIconElement();
        applyNativeColor(icon, row);
        row.insertBefore(icon, lastWrapper.nextSibling);

        if (scanFailCounts) scanFailCounts.delete(container);
        if (scanFailFirstAt) scanFailFirstAt.delete(container);
        if (injectedContainers) injectedContainers.add(container);
      }

      // ---- 全頁掃描:找出所有貼文容器並補注入。postCopyEnabled 關閉時整
      // 個跳過(不注入新 icon)——MutationObserver 的 debounce 掃描仍會不
      // 斷觸發呼叫，靠這裡單一入口把關比每個呼叫端各自判斷簡單、不會漏
      // 判。開關本身的切換(移除既有 icon／恢復掃描)由 watchPostCopyEnabledChanges
      // 與 init() 呼叫 removeAllIcons()／scanAndInject() 處理，不在這裡。----
      function scanAndInject() {
        if (disposed) return;
        // 孤兒自檢:擴充功能更新後，舊實例的 MutationObserver 還活著，會繼
        // 續往新渲染的貼文塞「點了不會記錄」的假 icon，而且會跟剛注入的新
        // 實例搶同一個容器(冪等檢查先到先贏)。每輪掃描前先問一次
        // chrome.runtime.id，發現自己已經是孤兒就整個退場，把場地讓給新實
        // 例。判斷成本是一次同步屬性存取，可以放在這條熱路徑上。
        if (contextLost()) {
          console.warn(
            '[threads-clean-link] 擴充功能情境已失效(擴充功能剛更新或重載)，舊的貼文 icon 注入器已停止運作，請重新整理頁面'
          );
          retireOrphanInstance();
          return;
        }
        if (!postCopyEnabled) return;
        try {
          injectStyle();
          var containers = document.querySelectorAll('div[data-pressable-container]');
          for (var i = 0; i < containers.length; i++) {
            injectIntoContainer(containers[i]);
          }
        } catch (e) {
          console.warn('[threads-clean-link] 掃描貼文並注入 icon 失敗', e);
        }
      }

      // ---- 語言切換時，更新頁面上既有 icon 的文案 ----
      function applyLocaleToExistingIcons() {
        try {
          var icons = document.querySelectorAll('.' + ICON_CLASS);
          for (var i = 0; i < icons.length; i++) {
            if (icons[i]._tclApplyLocale) icons[i]._tclApplyLocale();
          }
        } catch (e) {
          // 更新既有 icon 文案失敗不影響其餘流程，下次重新整理會自然修正。
        }
      }

      function setLocale(locale) {
        currentLocale = locale === 'zh' ? 'zh' : 'en';
        applyLocaleToExistingIcons();
      }

      // ---- 讀取語言偏好:chrome.storage.sync 的 langPref，讀取失敗一律
      // fallback resolveLocale(null)(未設定時 resolveLocale 會自動偵測瀏
      // 覽器語言)。防禦 callback 與 Promise 兩種 chrome.storage.sync.get
      // 形態，任何一種都不能讓整段流程炸掉。----
      function readLangPref(callback) {
        var done = false;
        function finish(value) {
          if (done) return;
          done = true;
          callback(value);
        }
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.sync ||
            typeof chrome.storage.sync.get !== 'function'
          ) {
            finish(null);
            return;
          }
          var maybePromise = chrome.storage.sync.get({ langPref: null }, function (items) {
            finish(items && typeof items === 'object' ? items.langPref : null);
          });
          // 部分環境(例如 Promise-only 的 storage 實作)不吃回呼引數，
          // get() 本身回傳 Promise，改吃這個分支。
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
              .then(function (items) {
                finish(items && typeof items === 'object' ? items.langPref : null);
              })
              .catch(function () {
                finish(null);
              });
          }
        } catch (e) {
          finish(null);
        }
      }

      function resolveLocaleSafe(pref) {
        try {
          if (root.TCLI18N && typeof root.TCLI18N.resolveLocale === 'function') {
            return root.TCLI18N.resolveLocale(pref);
          }
        } catch (e) {
          // 掉到下面回傳預設語言。
        }
        return 'en';
      }

      // ---- 動態 feed:Threads feed 是虛擬化的，貼文捲出畫面 DOM 即卸載，
      // 捲回來又是全新節點。用 MutationObserver 監聽整個 body，debounce
      // 後重掃全頁補注入；冪等靠 hasExistingIcon。SPA 路由切換也靠同一個
      // observer 覆蓋。----
      var scanScheduled = false;
      function scheduleScan() {
        if (disposed) return;
        if (scanScheduled) return;
        scanScheduled = true;
        setTimeout(function () {
          scanScheduled = false;
          scanAndInject();
        }, SCAN_DEBOUNCE_MS);
      }

      function startObserver() {
        if (typeof MutationObserver === 'undefined') return;
        try {
          var target = document.body || document.documentElement;
          if (!target) return;
          var observer = new MutationObserver(function () {
            scheduleScan();
          });
          observer.observe(target, { childList: true, subtree: true });
          // 留住參照，孤兒退場時要 disconnect(見 retireOrphanInstance)。
          observerRef = observer;
        } catch (e) {
          console.warn('[threads-clean-link] 啟動 MutationObserver 失敗', e);
        }
      }

      // ---- chrome.storage.onChanged:即時更新頁面上既有 icon 的語言 ----
      function watchLangPrefChanges() {
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.onChanged ||
            typeof chrome.storage.onChanged.addListener !== 'function'
          ) {
            return;
          }
          chrome.storage.onChanged.addListener(function (changes, areaName) {
            if (areaName !== 'sync' || !changes || !changes.langPref) return;
            setLocale(resolveLocaleSafe(changes.langPref.newValue));
          });
        } catch (e) {
          // 監聽註冊失敗不影響已注入的 icon 運作，只是語言不會即時跟著變。
        }
      }

      // ---- 使用者設定:postCopyEnabled(貼文複製按鈕開關，預設 true)。讀
      // 取邏輯比照 readLangPref——防禦 callback 與 Promise 兩種
      // chrome.storage.sync.get 形態，讀取失敗或 chrome.storage.sync 缺席
      // 一律 fallback true(開)，避免設定讀取異常時整個功能悄悄消失。----
      function readPostCopyEnabled(callback) {
        var done = false;
        function finish(value) {
          if (done) return;
          done = true;
          callback(resolvePostCopyEnabled(value));
        }
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.sync ||
            typeof chrome.storage.sync.get !== 'function'
          ) {
            finish(true);
            return;
          }
          var maybePromise = chrome.storage.sync.get({ postCopyEnabled: true }, function (items) {
            finish(items && typeof items === 'object' ? items.postCopyEnabled : true);
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
              .then(function (items) {
                finish(items && typeof items === 'object' ? items.postCopyEnabled : true);
              })
              .catch(function () {
                finish(true);
              });
          }
        } catch (e) {
          finish(true);
        }
      }

      // ---- 依選擇器移除頁面上的複製 icon 節點，並清空掃描快取
      // (WeakSet/WeakMap)——讓之後恢復掃描時不會被「已經注入過」的舊快取
      // 擋下，能重新掃描補回 icon。掃描移除，冪等:重複呼叫或頁面上本來
      // 就沒有 icon 都安全。----
      function removeIconsBySelector(selector) {
        try {
          var icons = document.querySelectorAll(selector);
          for (var i = 0; i < icons.length; i++) {
            if (icons[i].parentNode) icons[i].parentNode.removeChild(icons[i]);
          }
          if (hasWeakCollections) {
            injectedContainers = new WeakSet();
            skippedContainers = new WeakSet();
            scanFailCounts = new WeakMap();
            scanFailFirstAt = new WeakMap();
          }
        } catch (e) {
          console.warn('[threads-clean-link] 移除已注入 icon 失敗', e);
        }
      }

      // ---- 移除頁面上「所有」複製 icon:postCopyEnabled 關閉時呼叫(使用
      // 者要求全數消失，包含孤兒實例殘留的那批)，以及自癒重注入啟動時清
      // 場(見 init())。----
      function removeAllIcons() {
        removeIconsBySelector('.' + ICON_CLASS);
      }

      // ---- 只移除「本實例注入」的 icon:孤兒退場時用。不能用
      // removeAllIcons()——自癒重注入後，頁面上可能同時有新實例剛補上的活
      // icon，孤兒退場時把它們一起清掉，等於把自癒成果抹掉(新實例的
      // WeakSet 已記下該容器注入過了，不會再補回來)。----
      function removeOwnIcons() {
        removeIconsBySelector('.' + ICON_CLASS + '[' + OWNER_ATTR + '="' + INSTANCE_ID + '"]');
      }

      // ---- chrome.storage.onChanged:postCopyEnabled 切換時即時反應——關
      // 閉就移除頁面上所有已注入的 icon，重新打開就恢復掃描注入。----
      function watchPostCopyEnabledChanges() {
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.onChanged ||
            typeof chrome.storage.onChanged.addListener !== 'function'
          ) {
            return;
          }
          chrome.storage.onChanged.addListener(function (changes, areaName) {
            if (areaName !== 'sync' || !changes || !changes.postCopyEnabled) return;
            postCopyEnabled = resolvePostCopyEnabled(changes.postCopyEnabled.newValue);
            if (postCopyEnabled) {
              scanAndInject();
            } else {
              removeAllIcons();
            }
          });
        } catch (e) {
          // 監聽註冊失敗不影響已注入的 icon 運作，只是開關不會即時跟著變。
        }
      }

      function init() {
        // 冪等交棒(必須排在最前):同一 ISOLATED world 若已有本腳本的舊實例
        // (手動 F5 × 自癒重注入的毫秒級競態,或更新後的重注入),先透過
        // root.__tclPostIconDispose 讓舊實例退場(斷 observer、清掉它那批帶
        // 舊 OWNER_ATTR 的 icon、後續掃描短路),再由本新實例接手。消除「雙
        // MutationObserver → 雙落盤 → 時間軸假事件」。post-icon 因為有 DOM
        // 狀態(icon 節點、observer)要乾淨交接,用 retireOrphanInstance 做這
        // 件事。首次載入時 hook 尚未存在,等同 no-op。
        if (typeof root.__tclPostIconDispose === 'function') {
          try {
            root.__tclPostIconDispose();
          } catch (e) {
            // 舊實例退場失敗不影響新實例接手。
          }
        }
        root.__tclPostIconDispose = retireOrphanInstance;

        // 自癒重注入的清場(必須排在所有掃描之前):擴充功能更新後，
        // background 會把本腳本重新注入既開的 threads 分頁(見 background.js
        // 的 reinjectIntoOpenTabs)，但頁面上還留著孤兒實例注入的
        // .tcl-copy-icon 節點——冪等檢查 hasExistingIcon 只看節點在不在，
        // 會把那些死 icon 當成「本實例已經注入過」而整頁跳過，自癒等於白
        // 做。啟動時先無條件清掉頁面上所有既有 icon 節點:一般的首次載入
        // 頁面上本來就沒有 icon，等同 no-op;重注入時則把場地清乾淨，讓下
        // 面的 scanAndInject 以新身分重新注入(新 icon 會帶上本實例的
        // OWNER_ATTR)。
        removeAllIcons();

        // 不等 chrome.storage.sync 的回呼:先用 resolveLocaleSafe(null) 的
        // 預設語言(環境偵測)、postCopyEnabled 的模組層預設值(true)立刻
        // 掃描注入、啟動 observer，避免 storage 遲遲不回呼(甚至永遠不回
        // 呼，例如測試/沙箱環境的 mock 不完整)時 icon 整個出不來。
        // langPref／postCopyEnabled 讀到之後再補刷/補正；storage 永不回
        // 呼時功能照常運作，只是停在預設狀態。
        setLocale(resolveLocaleSafe(null));
        scanAndInject();
        startObserver();

        readLangPref(function (langPref) {
          setLocale(resolveLocaleSafe(langPref));
        });
        watchLangPrefChanges();

        readPostCopyEnabled(function (enabled) {
          postCopyEnabled = enabled;
          if (postCopyEnabled) {
            // 讀取期間可能有新貼文渲染出來但還沒注入，補掃一次；已注入
            // 的容器靠 hasExistingIcon 冪等，不會重複插入。
            scanAndInject();
          } else {
            removeAllIcons();
          }
        });
        watchPostCopyEnabledChanges();
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
  }

  // api 已在 DOM 守衛「外」宣告(見上方)，守衛內若有掛上 extractPostInfo／
  // showResolveFailureToast，這裡匯出的就是補完後的完整版本。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TCLPostIcon = api;
  }
})(typeof window !== 'undefined' ? window : this);
