// scam-guard.js — 在 Threads 貼文詳情頁辨識「自回覆長串＋末篇招攬」的詐騙
// 話術串文，並對作者掛上警示。ISOLATED world content script，比照
// post-icon.js 的 ES5 IIFE 風格。
//
// 取值段的純函式 extractSsrRoot / stripPositionBadge / extractThreadFromDom /
// buildThreadText 供 Node 測試以 require() 直接載入使用；模組頂層任何碰
// document 的掃描與注入邏輯一律用 `typeof document !== 'undefined'` 守衛包
// 住，讓 Node 環境（無 document 全域）require() 時不丟例外、不產生副作用。
(function (root) {
  'use strict';

  // ============================================================
  // 純函式區（守衛外，Node 測試與瀏覽器共用）
  // ============================================================

  // 貼文詳情頁 permalink 的路徑樣式。字元類與長度上限比照 tcl-core 的
  // STRICT_POST_URL_PATTERN（handle 英數/底線/句點、code 英數/連字號/底
  // 線，各 1-80 字元）；本檔自帶一份而不 require tcl-core，是因為 content
  // script 以獨立腳本載入，測試沙箱也不保證有 tcl-core 在場。
  // group 1 = handle（不含 '@'），group 2 = post code。尾段容忍尾隨斜線與
  // 整段 query／hash，對齊 tcl-core 的 NORMALIZE_POST_URL_PATTERN——實機
  // href 常帶 `?xmt=` 之類的追蹤參數。
  var POST_PATH_PATTERN =
    /^(?:https:\/\/(?:www\.)?threads\.(?:com|net))?\/@([A-Za-z0-9._]{1,80})\/post\/([A-Za-z0-9_-]{1,80})\/?(?:[?#].*)?$/i;

  // 串文徽章「N / M」由三個相鄰節點組成：取 textContent 時它們直接黏成
  // `1/6`，取 innerText 時版面換行會被算進去而成為 `\n1\n/\n6`。正則兩種形
  // 狀都吃，尾端也容忍版面留下的空白。
  var POSITION_BADGE_PATTERN = /\s*\n?(\d+)\n?\/\n?(\d+)\s*$/;

  // 徽章位置的合理範圍。純靠正則會把「活動到 2026/9/19」這種句尾日期當成
  // 徽章，加上範圍檢查才擋得住；上限取 50 是因為自回覆串長度不會到這個量
  // 級，超過的十之八九是誤判。
  var MAX_THREAD_LENGTH = 50;

  var CONTAINER_SELECTOR = 'div[data-pressable-container]';

  // 遞迴 walk 的深度與節點數上限。SSR payload 是頁面餵進來的任意 JSON，沒
  // 有上限的話畸形（或刻意加深）的結構會把主執行緒卡住；深度上限取 100 是
  // 為了留給 Relay 包裝層加深的餘裕。
  var WALK_MAX_DEPTH = 100;
  var WALK_MAX_NODES = 200000;

  function isObjectLike(value) {
    return value !== null && typeof value === 'object';
  }

  // 對 JSON.parse 出來的結構做深度優先走訪，回傳第一個讓 predicate 為真的
  // 物件節點；沒有命中回傳 null。陣列只負責往下走、本身不參與判定，超出深
  // 度或節點上限即止。
  function walkJson(value, predicate) {
    var visited = 0;

    function visit(node, depth) {
      if (!isObjectLike(node)) return null;
      if (depth > WALK_MAX_DEPTH) return null;
      if (++visited > WALK_MAX_NODES) return null;
      var isArray = Array.isArray(node);
      if (!isArray && predicate(node)) return node;
      var keys = isArray ? null : Object.keys(node);
      var length = isArray ? node.length : keys.length;
      for (var i = 0; i < length; i++) {
        var hit = visit(isArray ? node[i] : node[keys[i]], depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    return visit(value, 0);
  }

  // 從詳情頁所有 script[type="application/json"] 的文字取出串文根節點資訊。
  // 逐筆 JSON.parse（失敗者略過、不丟例外），對解析成功的結構遞迴找出任何
  // 帶非空 `thread_items` 陣列、且首項有 post 物件的節點——刻意不綁固定路
  // 徑，因為 Threads 的 RelayPrefetchedStreamCache 外層包裝每版都在變。
  // 給 expectedCode（通常取自網址列的貼文 code）時，只收 post.code 相符的節
  // 點，不符就繼續往下找——詳情頁的 SSR payload 會同時帶進推薦貼文等其他
  // 串，光取第一個命中的節點可能拿到隔壁貼文。
  // 回傳 { code, userId, username, displayName, captionText, selfThreadLength,
  // position }；找不到、輸入非陣列或為空，一律回傳 null。
  function extractSsrRoot(scriptTexts, expectedCode) {
    if (!Array.isArray(scriptTexts) || scriptTexts.length === 0) return null;
    var wantedCode = typeof expectedCode === 'string' && expectedCode ? expectedCode : null;

    for (var i = 0; i < scriptTexts.length; i++) {
      var raw = scriptTexts[i];
      if (typeof raw !== 'string' || !raw) continue;
      // 詳情頁有數十份 SSR script，絕大多數與串文無關。先用字串比對預篩，
      // 省掉對大塊 JSON 做無謂的 parse 與遞迴走訪。
      if (raw.indexOf('thread_items') === -1) continue;

      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        continue;
      }

      var node = walkJson(parsed, function (candidate) {
        var items = candidate.thread_items;
        if (
          !Array.isArray(items) ||
          items.length === 0 ||
          !isObjectLike(items[0]) ||
          !isObjectLike(items[0].post)
        ) {
          return false;
        }
        return wantedCode === null || items[0].post.code === wantedCode;
      });
      if (!node) continue;

      var post = node.thread_items[0].post;
      var user = isObjectLike(post.user) ? post.user : {};
      var caption = isObjectLike(post.caption) ? post.caption : {};
      // self_thread_info 實測掛在 post.text_post_app_info 之下，同樣不綁死
      // 路徑，在 post 節點內遞迴找即可。
      var holder =
        walkJson(post, function (candidate) {
          return isObjectLike(candidate.self_thread_info);
        }) || {};
      var threadInfo = isObjectLike(holder.self_thread_info) ? holder.self_thread_info : {};

      return {
        code: post.code,
        userId: user.id,
        username: user.username,
        displayName: user.full_name,
        captionText: caption.text,
        selfThreadLength: threadInfo.self_thread_length,
        position: threadInfo.post_position_in_self_thread,
      };
    }

    return null;
  }

  // 剝掉 DOM 文字尾端的「N/M」串文徽章，回傳 { text, position, total }。沒
  // 有徽章時 text 原樣回傳、position 與 total 皆為 null；非字串輸入回傳空
  // 字串與兩個 null，不丟例外。
  function stripPositionBadge(text) {
    if (typeof text !== 'string') return { text: '', position: null, total: null };

    var match = POSITION_BADGE_PATTERN.exec(text);
    if (!match) return { text: text, position: null, total: null };

    return {
      text: text.slice(0, match.index),
      position: parseInt(match[1], 10),
      total: parseInt(match[2], 10),
    };
  }

  // 把 handle 正規化成可比對的形式：去掉 '@' 前綴並轉小寫。
  // post-icon.extractAuthorHandle 回傳的是帶 '@' 的形式，SSR 取到的則沒
  // 有，兩種都要能對上。
  function normalizeHandle(handle) {
    if (typeof handle !== 'string') return '';
    var trimmed = handle.trim();
    if (trimmed.charAt(0) === '@') trimmed = trimmed.slice(1);
    return trimmed.toLowerCase();
  }

  // post-icon.js 的純函式在本檔直接複用：內文候選分類
  // （classifyExcerptCandidate）與互動列的標籤讀法／候選消歧
  // （readActionLabel、pickActionRowIndex）。瀏覽器裡兩支 content script 載
  // 入同一個 world 且 post-icon 先載入，取 root.TCLPostIcon 即可；Node 測試
  // 環境沒有全域 window，改以 require 取同一份匯出——判準只留一份，不在本
  // 檔另外維護第二套。取不到時各呼叫端自帶退路。
  var postIconModule = null;
  function postIcon() {
    if (root && root.TCLPostIcon) return root.TCLPostIcon;
    if (postIconModule) return postIconModule;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        postIconModule = require('./post-icon.js');
      } catch (e) {
        postIconModule = null;
      }
    }
    return postIconModule;
  }

  // 取容器內「屬於本容器本身」的第一個 permalink 連結，回傳
  // { handle, code }；找不到回傳 null。引用貼文會把另一個
  // data-pressable-container 包在外層容器內，其連結不算本容器的，判斷方式
  // 沿用 post-icon.extractExcerpt 的 closest 比對。
  function readContainerPermalink(container) {
    var anchors = container.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      if (anchor.closest && anchor.closest(CONTAINER_SELECTOR) !== container) continue;
      var match = POST_PATH_PATTERN.exec(anchor.getAttribute('href') || '');
      if (match) return { handle: match[1], code: match[2] };
    }
    return null;
  }

  // 取容器內的本文：收集所有葉 [dir="auto"] 節點（本身不再包含其他
  // [dir="auto"] 者），逐段以 post-icon 的 classifyExcerptCandidate 決定收
  // 下（push）、跳過（skip）或就此打住（stop），再以 \n 串接。
  //
  // 一篇貼文常被拆成多個各自獨立的葉 span，招攬那一行往往是最短的一段，只
  // 取最長的一段會把 LINE 錨點整個丟掉，串文判定必漏——因此全段都要收。
  //
  // 同一個容器內有三類 [dir="auto"] 不是本文：
  //   - 作者名與時間戳記：包在 <a> 裡（作者頁連結、permalink）。
  //   - 與作者 handle 逐字相同的節點：版面把作者名獨立成段、且不帶連結時。
  //   - 互動列計數（「92」「3,440」）：classifyExcerptCandidate 判為 stop，
  //     本文區段到此結束。
  // 引用卡片的內文則靠 closest 比對擋掉，不算本容器的段落。
  function readContainerBody(container, authorHandle) {
    var nodes = container.querySelectorAll('[dir="auto"]');
    var icon = postIcon();
    var classify =
      icon && typeof icon.classifyExcerptCandidate === 'function'
        ? icon.classifyExcerptCandidate
        : null;
    var wanted = normalizeHandle(authorHandle);
    var parts = [];

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.closest && node.closest(CONTAINER_SELECTOR) !== container) continue;
      if (node.querySelector && node.querySelector('[dir="auto"]')) continue;
      // 連結內的文字（作者名、時間戳記）不是本文。只認屬於本容器的 <a>，
      // 容器本身被包在連結裡時不該整篇被吃掉。
      var anchor = node.closest ? node.closest('a') : null;
      if (anchor && (!anchor.closest || anchor.closest(CONTAINER_SELECTOR) === container)) {
        continue;
      }

      var text = node.textContent || '';
      if (wanted && normalizeHandle(text) === wanted) continue;

      var verdict = classify ? classify(text, parts.length > 0) : 'push';
      if (verdict === 'stop') break;
      if (verdict === 'skip') continue;
      parts.push(text);
    }

    return parts.join('\n');
  }

  // 徽章解析結果的健全性檢查：位置要落在 1..total、total 不得超過合理串長
  // 上限；給 expectedTotal 時再要求 total 與串長相符。不通過就視為沒有徽
  // 章，由呼叫端以收集順序補位。
  function isSaneBadge(stripped, expectedTotal) {
    if (stripped.position === null || stripped.total === null) return false;
    if (stripped.position < 1 || stripped.position > stripped.total) return false;
    if (stripped.total > MAX_THREAD_LENGTH) return false;
    if (typeof expectedTotal === 'number' && stripped.total !== expectedTotal) return false;
    return true;
  }

  // 從詳情頁 DOM 取出作者自己的自回覆串，回傳 [{ code, text, position }]，
  // 依 position 升冪。只收 handle 等於 authorHandle（不分大小寫、'@' 前綴
  // 可有可無）且非巢狀的容器；末篇實測無徽章，以收集順序補 position。給
  // expectedTotal（通常取自 SSR 的 selfThreadLength）時，只認 total 相符的
  // 徽章，擋掉句尾日期之類的誤判。
  // root 缺失、authorHandle 缺失或沒有任何貼文容器時回傳空陣列，不丟例外。
  function extractThreadFromDom(root, authorHandle, expectedTotal) {
    var wanted = normalizeHandle(authorHandle);
    if (!root || typeof root.querySelectorAll !== 'function' || !wanted) return [];

    var items = [];
    try {
      var containers = root.querySelectorAll(CONTAINER_SELECTOR);
      for (var i = 0; i < containers.length; i++) {
        var container = containers[i];
        // 巢狀容器（引用貼文）不得另外計為一篇：從父節點往上還找得到容
        // 器，就代表它被包在另一篇裡面。
        var parent = container.parentElement || container.parentNode;
        if (parent && parent.closest && parent.closest(CONTAINER_SELECTOR)) continue;

        var permalink = readContainerPermalink(container);
        if (!permalink || normalizeHandle(permalink.handle) !== wanted) continue;

        var body = readContainerBody(container, wanted);
        var stripped = stripPositionBadge(body);
        var sane = isSaneBadge(stripped, expectedTotal);
        items.push({
          code: permalink.code,
          // 徽章不可信時連帶不剝——被誤認的那段是本文的一部分。
          text: sane ? stripped.text : body,
          position: sane ? stripped.position : items.length + 1,
        });
      }
    } catch (e) {
      return [];
    }

    // Array.prototype.sort 在 Node 與各家瀏覽器皆為穩定排序，position 相同
    // 時維持 DOM 收集順序。
    return items.sort(function (a, b) {
      return a.position - b.position;
    });
  }

  // 以空行串接所有 item.text，供後續正則掃描。非陣列／空陣列回傳 ''。
  function buildThreadText(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    return items
      .map(function (item) {
        return item && typeof item.text === 'string' ? item.text : '';
      })
      .join('\n\n');
  }

  // ============================================================
  // api 在 DOM 守衛「外」宣告，Node 測試環境 require() 本檔時不會進入守
  // 衛，api 上就只會有這裡列出的純函式。
  // ============================================================
  var api = {
    extractSsrRoot: extractSsrRoot,
    stripPositionBadge: stripPositionBadge,
    extractThreadFromDom: extractThreadFromDom,
    buildThreadText: buildThreadText,
  };

  // ============================================================
  // DOM 注入層（瀏覽器整合層）。碰 document / MutationObserver 的掃描與警
  // 示注入全部收在這個守衛裡，Node 測試環境 require() 本檔時直接跳過整段。
  //
  // 取值順序：
  //   1. document.querySelectorAll('script[type="application/json"]') 的
  //      textContent 收成陣列 → extractSsrRoot(texts, 網址列的 post code)
  //      取作者數字 id、帳號、顯示名與串長。
  //   2. extractThreadFromDom(document, 作者 handle, 串長) 取自回覆串各篇。
  //   3. buildThreadText() 串成全文 → TCLCore.detectScamPitch 判定。
  //   4. 命中 → 送 scam.hit 給 background 寫入黑名單 → 主文卡掛警示 tag。
  // ============================================================
  if (typeof document !== 'undefined') {
    (function () {
      var TAG_CLASS = 'tcl-scam-tag';
      var STYLE_ID = 'tcl-scam-guard-style';
      // MutationObserver 觸發後的合併掃描延遲，與 post-icon 的掃描節奏一致。
      var SCAN_DEBOUNCE_MS = 60;

      // 目前使用的語言，載入時由 chrome.storage.sync 的 langPref 解析。tag
      // 只在命中時建立一次、之後不重繪，語言切換不追蹤既有 tag。
      var currentLocale = 'en';

      // 總開關 chrome.storage.local.scamGuardEnabled，缺席視為開啟。讀到值
      // 之前一律不掃（settingsReady）——掃描會送訊息、會改頁面，寧可晚一個
      // tick 也不能在使用者已關閉的情況下先做一輪。
      var scamGuardEnabled = true;
      var settingsReady = false;

      // 上一輪掃描的結果：{ key, tagged, mainCode }。key 為乾淨 pathname ＋
      // 本頁作者串各篇的 code 集合——MutationObserver 在 Threads 上每秒可觸
      // 發數十次，同一頁同一組容器只掃一次、只送一則 scam.hit；SPA 換頁
      // （pathname 或容器組成變動）才重掃。tagged／mainCode 記住「這一鍵該
      // 有警示、掛在哪一篇」，同鍵的觸發才補得回被 React 沖掉的 tag。
      var lastScan = null;

      // 本次 session 是否已經跳過「首次入黑名單」的 toast。
      var toasted = false;

      var scanScheduled = false;

      // i18n.js 依 manifest content_scripts 陣列順序必定先載入，這份字面值
      // 只是防禦性後備，避免 TCLI18N 缺席時使用者看到原始 key。
      var FALLBACK_STRINGS = {
        scamTagLabel: 'Possible investment scam',
        scamTagTooltip:
          'This thread pushes a LINE contact alongside investment pitches — a common scam funnel. Do not add them or share personal details.',
        scamFirstHitToast: 'Added this account to your local blocklist. Manage it in Settings.',
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

      // 頁內 toast 一律複用 post-icon 的實作（root.TCLPostIcon.showToast），
      // 不自繪第二套：同一頁上兩份 toast 會互相蓋掉，樣式也難保一致。
      function showToast(text) {
        try {
          if (root.TCLPostIcon && typeof root.TCLPostIcon.showToast === 'function') {
            root.TCLPostIcon.showToast(text);
          }
        } catch (e) {
          console.warn('[threads-clean-link] 顯示詐騙警示 toast 失敗', e);
        }
      }

      // ---- 樣式注入：標 id 防重複注入。配色走 CSS 變數，深色主題是
      // Threads 的預設外觀，因此變數的預設值即深色值，淺色由 media query
      // 覆寫；瀏覽器不支援 prefers-color-scheme 時落在深色值上，不會無色。
      function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          ':root{--tcl-warn-fg:#ffb454;--tcl-warn-bg:rgba(255,180,84,0.12);',
          '--tcl-warn-border:rgba(255,180,84,0.45);}',
          '@media (prefers-color-scheme: light){:root{--tcl-warn-fg:#8a4b00;',
          '--tcl-warn-bg:rgba(255,180,84,0.18);--tcl-warn-border:rgba(138,75,0,0.35);}}',
          '.' + TAG_CLASS + '{display:inline-flex;align-items:center;margin:4px 0 8px;',
          'padding:4px 10px;border-radius:9999px;font-size:13px;line-height:1.4;font-weight:600;',
          'color:var(--tcl-warn-fg,#ffb454);background:var(--tcl-warn-bg,rgba(255,180,84,0.12));',
          'border:1px solid var(--tcl-warn-border,rgba(255,180,84,0.45));}',
        ].join('');
        (document.head || document.documentElement).appendChild(style);
      }

      // ---- 網址列的貼文座標；非詳情頁回傳 null ----
      function readPathInfo() {
        var pathname = (root.location && root.location.pathname) || '';
        var core = root.TCLCore;
        var isDetail =
          core && typeof core.isPostDetailPath === 'function'
            ? core.isPostDetailPath(pathname)
            : POST_PATH_PATTERN.test(pathname);
        if (!isDetail) return null;
        var match = POST_PATH_PATTERN.exec(pathname);
        if (!match) return null;
        return {
          handle: match[1],
          code: match[2],
          // 去 query／hash 的乾淨路徑，供冪等鍵與 postUrl 共用。
          path: '/@' + match[1] + '/post/' + match[2],
        };
      }

      function collectSsrTexts() {
        var out = [];
        try {
          var nodes = document.querySelectorAll('script[type="application/json"]');
          for (var i = 0; i < nodes.length; i++) {
            out.push(nodes[i].textContent || '');
          }
        } catch (e) {
          // 取不到 SSR script 時退回純 DOM 取值，不中斷掃描。
        }
        return out;
      }

      // ---- 列出本頁屬於該作者、且非巢狀的貼文容器，回傳
      // [{ container, code }]（文件序）。只讀 a[href]，不碰 script 與本文節
      // 點，便宜到可以每次 MutationObserver 觸發都跑一遍——冪等鍵就是由它算
      // 出來的。巢狀容器（引用貼文）的排除方式與 extractThreadFromDom 一
      // 致，確保兩邊看到的是同一組容器。----
      function collectOwnContainers(authorHandle) {
        var wanted = normalizeHandle(authorHandle);
        var out = [];
        if (!wanted) return out;
        var containers = document.querySelectorAll(CONTAINER_SELECTOR);
        for (var i = 0; i < containers.length; i++) {
          var container = containers[i];
          var parent = container.parentElement || container.parentNode;
          if (parent && parent.closest && parent.closest(CONTAINER_SELECTOR)) continue;
          var permalink = readContainerPermalink(container);
          if (!permalink || normalizeHandle(permalink.handle) !== wanted) continue;
          out.push({ container: container, code: permalink.code });
        }
        return out;
      }

      function containerOf(own, code) {
        for (var i = 0; i < own.length; i++) {
          if (own[i].code === code) return own[i].container;
        }
        return null;
      }

      // ---- 找互動列（讚／回覆／轉發／分享那一排）：容器內直屬子元素 >=4
      // 個、每個子元素內都有 [role="button"] 包著 svg 的 div。判準與
      // post-icon 的 collectActionRowCandidates 相同，但 post-icon 的版本宣
      // 告在它自己的 DOM 守衛內、不在匯出的 api 上，這裡自帶一份最小實作。
      //
      // 結構條件不保證唯一：影片貼文會多一條「追蹤／更多／已靜音／排序／附
      // 加影音內容」的播放器工具列，它與互動列的文件序前後皆有可能，光看順
      // 序會挑錯。消歧一律交給 post-icon 匯出的 readActionLabel（先
      // aria-label、缺席讀 svg > title）＋ pickActionRowIndex（標籤白名單交
      // 集 >= 3）；取不到那兩支純函式時才退回文件序最後一個候選。----
      function collectActionRowCandidates(container) {
        var divs = container.querySelectorAll('div');
        var rows = [];
        for (var i = 0; i < divs.length; i++) {
          var row = divs[i];
          var children = row.children;
          if (!children || children.length < 4) continue;

          var allMatch = true;
          for (var j = 0; j < children.length; j++) {
            var hit = children[j].querySelector
              ? children[j].querySelector('[role="button"] svg')
              : null;
            if (!hit) {
              allMatch = false;
              break;
            }
          }
          if (!allMatch) continue;
          // 巢狀容器防護：候選列最近的貼文容器祖先必須就是本容器。
          if (row.closest && row.closest(CONTAINER_SELECTOR) !== container) continue;
          rows.push(row);
        }
        return rows;
      }

      function findActionRow(container) {
        var rows = collectActionRowCandidates(container);
        if (rows.length === 0) return null;

        var icon = postIcon();
        if (
          !icon ||
          typeof icon.readActionLabel !== 'function' ||
          typeof icon.pickActionRowIndex !== 'function'
        ) {
          return rows[rows.length - 1];
        }

        var labelsList = [];
        for (var i = 0; i < rows.length; i++) {
          var children = rows[i].children;
          var labels = [];
          for (var j = 0; j < children.length; j++) {
            labels.push(icon.readActionLabel(children[j].querySelector('[role="button"] svg')));
          }
          labelsList.push(labels);
        }

        var index = icon.pickActionRowIndex(labelsList);
        return index === null ? null : rows[index];
      }

      // ---- 在主文卡的互動列「上方」插一顆警示 tag。文案一律以 textContent
      // 寫入（頁面上的文字不經 innerHTML）。找不到互動列時退為掛在容器末
      // 端，至少讓使用者看得到警示。冪等：容器內已有 tag 就不再插。----
      function insertTag(container) {
        if (!container) return;
        try {
          if (container.querySelector && container.querySelector('.' + TAG_CLASS)) return;
          injectStyle();
          var tag = document.createElement('div');
          tag.className = TAG_CLASS;
          tag.setAttribute('role', 'note');
          tag.setAttribute('title', t('scamTagTooltip'));
          tag.textContent = t('scamTagLabel');

          var row = findActionRow(container);
          if (row && row.parentNode) {
            row.parentNode.insertBefore(tag, row);
          } else {
            container.appendChild(tag);
          }
        } catch (e) {
          console.warn('[threads-clean-link] 注入詐騙警示 tag 失敗', e);
        }
      }

      // ---- 送 scam.hit 給 background。callback 與 Promise 兩種
      // chrome.runtime.sendMessage 形態都撐住；分頁在擴充功能更新後會拿到已
      // 失效的 runtime，任何失敗一律以 null 回呼，不丟例外、不影響頁面上已
      // 經掛好的警示。----
      function sendHit(payload, callback) {
        var done = false;
        function finish(response) {
          if (done) return;
          done = true;
          callback(response);
        }
        try {
          if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
            finish(null);
            return;
          }
          var maybePromise = chrome.runtime.sendMessage(payload, function (response) {
            if (chrome.runtime.lastError) {
              finish(null);
              return;
            }
            finish(response || null);
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
              .then(function (response) {
                finish(response || null);
              })
              .catch(function () {
                finish(null);
              });
          }
        } catch (e) {
          finish(null);
        }
      }

      // ---- SSR 取值依 pathname 快取：同一頁重掃不必再把數十份 script 的
      // textContent 收成字串陣列（等於整包 JSON 複製一次）。取不到根節點時
      // 不寫進快取——SSR script 可能還沒解析完，下一輪（容器組成變動時）要
      // 有機會重讀。----
      var ssrCache = { path: null, root: null };

      function readSsrRoot(pathInfo) {
        if (ssrCache.path === pathInfo.path && ssrCache.root) return ssrCache.root;
        var value = extractSsrRoot(collectSsrTexts(), pathInfo.code);
        if (value) {
          ssrCache.path = pathInfo.path;
          ssrCache.root = value;
        }
        return value;
      }

      // ---- 以 SSR 補救主文卡：第一篇的 DOM 本文為空（版面還沒渲染出文
      // 字），或整個容器都還沒掛上時，改用 SSR 的 captionText。SSR 已經帶著
      // 這篇全文，錨點常常就在第一篇，漏掉它等於整串判定失準。----
      function applySsrFallback(items, ssrRoot) {
        if (!ssrRoot || typeof ssrRoot.captionText !== 'string' || !ssrRoot.captionText) {
          return items;
        }
        for (var i = 0; i < items.length; i++) {
          if (items[i].code !== ssrRoot.code) continue;
          if (!items[i].text) items[i].text = ssrRoot.captionText;
          return items;
        }
        items.unshift({
          code: ssrRoot.code,
          text: ssrRoot.captionText,
          position: typeof ssrRoot.position === 'number' ? ssrRoot.position : 1,
        });
        return items;
      }

      // ---- 一輪掃描 ----
      function scan() {
        if (!settingsReady || !scamGuardEnabled) return;

        var core = root.TCLCore;
        if (!core || typeof core.detectScamPitch !== 'function') return;

        var pathInfo = readPathInfo();
        // 河道與其他頁面整頁都是別人的貼文片段，不掃。
        if (!pathInfo) return;

        // 冪等判斷必須早於任何昂貴的取值：MutationObserver 在 Threads 上每
        // 秒可觸發數十次，先用便宜的容器掃描（只讀 a[href]）算出鍵，同鍵直
        // 接收工。作者 handle 這裡一律取網址列的——SSR 還沒讀，而兩者只可能
        // 差在大小寫，normalizeHandle 已經抹平。
        var own = collectOwnContainers(pathInfo.handle);
        // 容器還沒渲染出來：不記冪等鍵，留給下一次 MutationObserver 重試。
        if (own.length === 0) return;

        var key =
          pathInfo.path +
          '|' +
          own
            .map(function (entry) {
              return entry.code;
            })
            .join(',');

        if (lastScan && lastScan.key === key) {
          // React 重繪會把我們插進去的節點整個沖掉。頁面層的補回用上一輪的
          // 判定結果就夠，不重跑判定、更不重送 scam.hit。
          if (lastScan.tagged && !document.querySelector('.' + TAG_CLASS)) {
            insertTag(containerOf(own, lastScan.mainCode));
          }
          return;
        }

        var scanState = { key: key, tagged: false, mainCode: null };
        lastScan = scanState;

        var ssrRoot = readSsrRoot(pathInfo);
        // 作者 handle 以 SSR 為準（大小寫與網址列可能不同），SSR 缺席時退回
        // 網址列——DOM 取值只需要 handle，沒有 SSR 照樣掃得動。
        var handle =
          ssrRoot && typeof ssrRoot.username === 'string' && ssrRoot.username
            ? ssrRoot.username
            : pathInfo.handle;
        var items = applySsrFallback(
          extractThreadFromDom(document, handle, ssrRoot ? ssrRoot.selfThreadLength : undefined),
          ssrRoot
        );
        if (items.length === 0) return;

        var detection = core.detectScamPitch(buildThreadText(items));
        if (!detection || !detection.hit) return;

        var payload = {
          type: 'scam.hit',
          // 比對主鍵是數字 user id；SSR 取不到時送 null，由 background 走匿
          // 名備援補查。
          userId: ssrRoot && ssrRoot.userId ? String(ssrRoot.userId) : null,
          handle: handle,
          displayName:
            ssrRoot && typeof ssrRoot.displayName === 'string' ? ssrRoot.displayName : '',
          postUrl: ((root.location && root.location.origin) || '') + pathInfo.path,
          snippet: detection.snippet,
          anchorMatch: detection.anchorMatch,
          pitchMatches: detection.pitchMatches,
          at: Date.now(),
        };

        sendHit(payload, function (response) {
          // 使用者已在選項頁解除封鎖這個作者：照樣問過 background（白名單只
          // 有它知道），但頁面上不掛警示。
          if (response && response.allowlisted) return;

          // 記下「這一鍵該有警示」與主文卡的 code，之後同鍵的觸發才補得回被
          // React 沖掉的 tag。
          scanState.tagged = true;
          scanState.mainCode = items[0].code;
          insertTag(containerOf(own, items[0].code));

          // 首次把作者寫進黑名單才提示，同一 session 只提示一次；既有作者
          // 只補證據（added:false）、寫入被拒或送訊息失敗都不提示。
          if (response && response.added === true && !toasted) {
            toasted = true;
            showToast(t('scamFirstHitToast'));
          }
        });
      }

      function safeScan() {
        try {
          scan();
        } catch (e) {
          console.warn('[threads-clean-link] 詐騙串文掃描失敗', e);
        }
      }

      function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        setTimeout(function () {
          scanScheduled = false;
          safeScan();
        }, SCAN_DEBOUNCE_MS);
      }

      // ---- 動態頁面：詳情頁的貼文容器是 React 逐批渲染的，SPA 路由切換也
      // 不重載腳本。比照 post-icon 監聽整個 body，debounce 後重掃；冪等靠
      // lastScan 的冪等鍵。----
      function startObserver() {
        if (typeof MutationObserver === 'undefined') return;
        try {
          var target = document.body || document.documentElement;
          if (!target) return;
          var observer = new MutationObserver(function () {
            scheduleScan();
          });
          observer.observe(target, { childList: true, subtree: true });
        } catch (e) {
          console.warn('[threads-clean-link] 啟動詐騙警示 MutationObserver 失敗', e);
        }
      }

      // ---- 總開關：chrome.storage.local 的 scamGuardEnabled，只有明確存成
      // false 才視為關閉；缺席、讀取失敗、storage 缺席一律視為開啟。----
      function readEnabled(callback) {
        var done = false;
        function finish(value) {
          if (done) return;
          done = true;
          callback(value === false ? false : true);
        }
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.local ||
            typeof chrome.storage.local.get !== 'function'
          ) {
            finish(true);
            return;
          }
          var maybePromise = chrome.storage.local.get({ scamGuardEnabled: true }, function (items) {
            finish(items && typeof items === 'object' ? items.scamGuardEnabled : true);
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
              .then(function (items) {
                finish(items && typeof items === 'object' ? items.scamGuardEnabled : true);
              })
              .catch(function () {
                finish(true);
              });
          }
        } catch (e) {
          finish(true);
        }
      }

      function watchEnabledChanges() {
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
            if (areaName !== 'local' || !changes || !changes.scamGuardEnabled) return;
            scamGuardEnabled = changes.scamGuardEnabled.newValue === false ? false : true;
            // 關閉只影響之後的掃描：已經掛上的 tag 代表已經寫進黑名單的事
            // 實，不隨開關撤掉（撤銷在選項頁的黑名單卡片操作）。
            if (scamGuardEnabled) scheduleScan();
          });
        } catch (e) {
          // 監聽註冊失敗只是開關不會即時生效，不影響已完成的掃描。
        }
      }

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

      function init() {
        // 語言先用環境偵測值頂著，讀到 langPref 再補正；tag 要等 storage 的
        // 總開關回來才可能建立，屆時語言早已就位。
        currentLocale = resolveLocaleSafe(null);
        readLangPref(function (langPref) {
          currentLocale = resolveLocaleSafe(langPref);
        });

        startObserver();
        watchEnabledChanges();

        // 與 post-icon 的「先用預設值立刻動作」相反：掃描會送訊息、會改頁
        // 面，必須等總開關讀回來才做第一輪。
        readEnabled(function (enabled) {
          scamGuardEnabled = enabled;
          settingsReady = true;
          if (enabled) safeScan();
        });
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TCLScamGuard = api;
  }
})(typeof window !== 'undefined' ? window : this);
