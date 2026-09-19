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
  // 線，各 1-80 字元）；本檔自帶一份而不沿用 tcl-core 的，是因為這裡需要
  // handle 與 code 兩個 capture group，而 tcl-core 的兩支樣式都不暴露——
  // STRICT_POST_URL_PATTERN 只捕 code，NORMALIZE_POST_URL_PATTERN 捕的是整
  // 段路徑。
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

  // 節點自己或任一祖先不渲染時為真：帶 hidden 屬性（UA 樣式即
  // display:none），或行內 style.display === 'none'。hidden 用
  // closest('[hidden]') 一次問完祖先鏈；行內 display 沒有對應的選擇器，沿
  // parentElement 逐層檢查——display:none 不繼承，但整棵子樹都不產生 box。
  //
  // 判準只讀屬性與行內樣式，不用 checkVisibility() 或 getComputedStyle()：
  // 前者 Chrome 105 才有（本擴充的下限是 103），後者要真正的排版引擎，Node
  // 測試環境給不出來。closest 缺席的環境由迴圈內的 hasAttribute 兜底。
  function isHiddenNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var hasClosest = typeof node.closest === 'function';
    if (hasClosest && node.closest('[hidden]')) return true;
    var cursor = node;
    while (cursor && cursor.nodeType === 1) {
      if (
        !hasClosest &&
        typeof cursor.hasAttribute === 'function' &&
        cursor.hasAttribute('hidden')
      ) {
        return true;
      }
      if (cursor.style && cursor.style.display === 'none') return true;
      cursor = cursor.parentElement || cursor.parentNode;
    }
    return false;
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
        // 隱藏子樹裡的容器是舊路由層的殘留，不是這一串的一篇。
        if (isHiddenNode(container)) continue;

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
    isHiddenNode: isHiddenNode,
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

      // 上一輪掃描的結果：{ key, tagged, mainCode, userId, handle }。key 為
      // 乾淨 pathname ＋ 本頁作者串各篇的「code:本文長度」——MutationObserver
      // 在 Threads 上每秒可觸發數十次，同一頁同一批內容只掃一次、只送一則
      // scam.hit；SPA 換頁、容器組成變動或本文被補齊才重掃。tagged／mainCode
      // 記住「這一鍵該有警示、掛在哪一篇」，同鍵的觸發才補得回被 React 沖掉
      // 的 tag；userId／handle 供解除封鎖時撤掉補回旗標（releaseAllowlistedScan）。
      //
      // 本文長度是鍵的一部分，展開長文、載入翻譯都會算出新鍵，判定整輪重跑、
      // 可能再送一次 scam.hit——這是預期行為：background 對同一篇 permalink 的
      // 證據去重，toast 另有本 session 的 toasted 旗標，重送不會多一張證據卡、
      // 也不會多跳一次 toast。
      var lastScan = null;

      // 本次 session 是否已經跳過「首次入黑名單」的 toast。
      var toasted = false;

      // 本機黑名單的記憶體快取，正規化後的 { entries, handleIndex, allowlist }
      // 形狀；沒有任何可查的作者時一律留 null，查表可以立刻收工、不走訪 DOM。
      // 只有 background 寫 chrome.storage.local.scamBlocklist，本段唯讀。
      var blocklist = null;

      // 已經查過表的貼文容器。河道的 MutationObserver 每秒可觸發數十次，同一
      // 張卡只需查一次；黑名單換過一版就整組丟掉重建，讓新增與解除都在下一次
      // 觸發反映。
      var listedContainers = newContainerSet();

      // 查表已經替它掛過 tag 的容器。tag 節點被 React 重繪沖掉時靠這組補回
      // ——容器沒換，只是警示不見了。
      var taggedContainers = newContainerSet();

      // 各容器連續取不到 permalink 的次數，達上限即併入 listedContainers。
      var permalinkMisses = newContainerMap();
      var PERMALINK_MISS_LIMIT = 3;

      // 查表對頁面唯一會寫的 tag 提示文案。
      var LIST_TAG_TITLE_KEY = 'scamBlockedByList';

      // 掃描已判定命中、正等 background 回應的主文卡。掃描的 tag 要等回應才
      // 掛得上，查表卻是同步的——不讓位的話冪等守衛會讓查表那顆先佔位，使用
      // 者就看不到資訊量較大的 scamTagTooltip。
      //
      // 讓位對象記的是容器節點：SPA 留下的隱藏舊卡與主文卡 code 相同，只比
      // code 會連可見主文卡一起讓掉，兩條路都不掛就沒人掛了；比容器也讓陳舊
      // 的 code 不會跨頁誤殺——返回河道時同一篇的河道卡是另一個節點，照樣查
      // 得到表。容器缺席時退回以 code 讓位：collectOwnContainers 這一輪沒收
      // 到對應節點，或認領的節點已被 React 換掉、不在本輪的容器清單裡。
      var claimedMainCode = null;
      var claimedMainContainer = null;

      // onChanged 是否已經送過黑名單。init 的 storage 讀取是非同步的，
      // background 可能在回呼結算前就把新名單寫好並廣播；回呼帶回的是「發出讀
      // 取當下」的舊快照，這面旗標擋下它把新名單蓋回去。
      var sawBlocklistChange = false;

      var scanScheduled = false;

      // i18n.js 依 manifest content_scripts 陣列順序必定先載入，這份字面值
      // 只是防禦性後備，避免 TCLI18N 缺席時使用者看到原始 key。
      var FALLBACK_STRINGS = {
        scamTagLabel: 'Possible investment scam',
        scamTagTooltip:
          'This thread pushes a LINE contact alongside investment pitches — a common scam funnel. Do not add them or share personal details.',
        scamBlockedByList: 'This account is on your blocklist',
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
      // [{ container, code, bodyLength }]（文件序）。冪等鍵就是由它算出來
      // 的，只讀 a[href] 與本文節點，不碰 script、不跑判定。巢狀容器（引用
      // 貼文）的排除方式與 extractThreadFromDom 一致，確保兩邊看到的是同一
      // 組容器。
      //
      // 隱藏子樹內的容器一律不收：由河道以 SPA 進入詳情頁時，Threads 把河道
      // 那一層留在文件裡（祖先帶 hidden 屬性與行內 display:none），同一則貼
      // 文因而有兩張 code 相同的卡，看不見的舊卡文件序還在可見主文卡之前。不
      // 濾掉的話冪等鍵會把舊卡的殘影算進去，警示也會掛進使用者看不到的那一
      // 張。
      //
      // bodyLength 是各容器本文的字元數，進冪等鍵當內容指紋。容器組成（路徑
      // ＋ code 集合）單獨當鍵擋不住 React 的兩段式渲染：容器先掛上、本文後
      // 補時兩輪的 code 集合完全相同，第一輪掃到的是空白本文，之後整串跳過
      // ——招攬篇的錨點永遠看不到。本文長度隨補齊而變，指紋跟著變，那一輪就
      // 會重掃。tag 節點不帶 dir="auto"，掛上或被沖掉都不動指紋；互動列計數
      // 在 readContainerBody 判為 stop，也不計入。----
      function collectOwnContainers(authorHandle) {
        var wanted = normalizeHandle(authorHandle);
        var out = [];
        if (!wanted) return out;
        var containers = document.querySelectorAll(CONTAINER_SELECTOR);
        for (var i = 0; i < containers.length; i++) {
          var container = containers[i];
          var parent = container.parentElement || container.parentNode;
          if (parent && parent.closest && parent.closest(CONTAINER_SELECTOR)) continue;
          if (isHiddenNode(container)) continue;
          var permalink = readContainerPermalink(container);
          if (!permalink || normalizeHandle(permalink.handle) !== wanted) continue;
          out.push({
            container: container,
            code: permalink.code,
            bodyLength: readContainerBody(container, wanted).length,
          });
        }
        return out;
      }

      // own 已經濾過隱藏容器，這裡再擋一次純粹是防呆：呼叫端換成別處來的清
      // 單時，警示照樣不會掛進看不見的卡。
      function containerOf(own, code) {
        for (var i = 0; i < own.length; i++) {
          if (own[i].code !== code) continue;
          if (isHiddenNode(own[i].container)) continue;
          return own[i].container;
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

      // ---- 在貼文卡的互動列「上方」插一顆警示 tag。文案一律以 textContent
      // 寫入（頁面上的文字不經 innerHTML）。找不到互動列時退為掛在容器末
      // 端，至少讓使用者看得到警示。冪等：容器內已有 tag 就不再插。
      //
      // titleKey 決定滑鼠提示要說哪一句：詳情頁掃描用預設的 scamTagTooltip
      // （這串貼文疑似詐騙），河道查表傳 scamBlockedByList（這個帳號在你的黑
      // 名單中）。----
      function insertTag(container, titleKey) {
        if (!container) return;
        try {
          if (container.querySelector && container.querySelector('.' + TAG_CLASS)) return;
          injectStyle();
          var tag = document.createElement('div');
          tag.className = TAG_CLASS;
          tag.setAttribute('role', 'note');
          tag.setAttribute('title', t(titleKey || 'scamTagTooltip'));
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
        // 河道與其他頁面整頁都是別人的貼文片段，不掃。離開詳情頁時一併鬆開
        // 認領：留著的 code 會讓河道上同一篇的卡片被查表讓掉，而掃描那條路
        // 已經不在詳情頁上，讓完就沒人掛了。lastScan 留著——返回同一篇時冪
        // 等鍵照樣命中，不重送 scam.hit。
        if (!pathInfo) {
          claimedMainCode = null;
          claimedMainContainer = null;
          return;
        }

        // 冪等判斷必須早於任何昂貴的取值（SSR script 的 JSON 走訪、串文判
        // 定）：MutationObserver 在 Threads 上每秒可觸發數十次，先用純 DOM
        // 的容器掃描算出鍵，同鍵直接收工。作者 handle 這裡一律取網址列的
        // ——SSR 還沒讀，而兩者只可能差在大小寫，normalizeHandle 已經抹平。
        var own = collectOwnContainers(pathInfo.handle);
        // 容器還沒渲染出來：不記冪等鍵，留給下一次 MutationObserver 重試。
        if (own.length === 0) return;

        // 鍵 = 乾淨路徑 ＋ 各容器的 `code:本文長度`。本文長度是內容指紋，讓
        // 「容器先掛上、本文後補」的兩段式渲染算成不同的一輪。
        var key =
          pathInfo.path +
          '|' +
          own
            .map(function (entry) {
              return entry.code + ':' + entry.bodyLength;
            })
            .join(',');

        if (lastScan && lastScan.key === key) {
          // React 重繪會把我們插進去的節點整個沖掉。頁面層的補回用上一輪的
          // 判定結果就夠，不重跑判定、更不重送 scam.hit。
          //
          // 「警示還在」只問主文卡自己：詳情頁的他人回覆卡也可能因查表掛上
          // 一顆 tag，拿全文件當證據的話，主文卡那顆被沖掉後仍被回覆卡那顆
          // 遮住，主文的警示就此永久消失。
          if (lastScan.tagged) {
            var main = containerOf(own, lastScan.mainCode);
            if (main) {
              // 容器可能已被 React 換成新節點，認領跟著拉回活節點：認領留
              // 在已離開文件的舊節點上，讓位就退化成比 code——同 code 的其
              // 他可見卡會被一起誤殺。
              claimedMainContainer = main;
              if (!main.querySelector('.' + TAG_CLASS)) insertTag(main);
            }
          }
          return;
        }

        var scanState = { key: key, tagged: false, mainCode: null, userId: null, handle: null };
        lastScan = scanState;
        claimedMainCode = null;
        claimedMainContainer = null;

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

        // 同步認領主文卡：同一輪稍後跑的查表要讓位給這一顆。
        claimedMainCode = items[0].code;
        claimedMainContainer = containerOf(own, items[0].code);

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
          // 這一輪已經作廢就整個收手：往返期間本文被改寫、SPA 換到別篇都會
          // 換一把冪等鍵、重跑判定，這則回應講的是上一輪的事。照掛的話會依
          // 一個已被推翻的判定補上警示，還會把認領釘回這張卡，讓查表該掛的
          // 那一顆也掛不上。
          if (lastScan !== scanState) return;

          // 使用者已在選項頁解除封鎖這個作者：照樣問過 background（白名單只
          // 有它知道），但頁面上不掛警示。
          if (response && response.allowlisted) return;

          // 記下「這一鍵該有警示」與主文卡的 code，之後同鍵的觸發才補得回被
          // React 沖掉的 tag。作者身分一併記下（userId 缺席時留 handle），
          // 使用者之後在選項頁解除封鎖時，setBlocklist 靠它撤掉補回旗標。
          scanState.tagged = true;
          scanState.mainCode = items[0].code;
          scanState.userId = payload.userId;
          scanState.handle = handle;

          // own 是送出訊息當下的容器清單，回應落地前 React 可能已經把主文卡
          // 換成新節點。這裡重查一次當下的容器再掛：沿用 own 的話 tag 會插
          // 進已離開文件的舊節點（containerOf 只濾隱藏，認不得「已不在文件
          // 裡」），使用者看到的是一段整頁零警示的空窗——要等下一次
          // MutationObserver 觸發才由冪等短路那條路補回，而那不知道什麼時候
          // 來。認領一併拉到活節點上，讓位才不會退化成比 code。容器根本還沒
          // 渲染出來時排下一輪重試。
          var target = containerOf(collectOwnContainers(handle), items[0].code);
          if (target) {
            claimedMainContainer = target;
            insertTag(target);
          } else {
            scheduleScan();
          }

          // 首次把作者寫進黑名單才提示，同一 session 只提示一次；既有作者
          // 只補證據（added:false）、寫入被拒或送訊息失敗都不提示。
          if (response && response.added === true && !toasted) {
            toasted = true;
            showToast(t('scamFirstHitToast'));
          }
        });
      }

      // ============================================================
      // 本機黑名單查表：河道（首頁 feed）與任何非詳情頁的貼文卡片，只要作者
      // 已在本機黑名單裡就掛同一顆 tag，讓使用者在點進去之前就看得到警示。
      // 純本機動作——不送訊息、不發請求、不跑串文判定。
      // ============================================================

      // 記錄已查表容器的集合。WeakSet 不留參照，React 換掉的卡片可以直接被回
      // 收；環境沒有 WeakSet 時退成「不記憶」，每次觸發重查一遍（insertTag 自
      // 帶冪等守衛，結果相同，只是多走訪幾次 DOM）。
      function newContainerSet() {
        return typeof WeakSet === 'function' ? new WeakSet() : null;
      }

      function newContainerMap() {
        return typeof WeakMap === 'function' ? new WeakMap() : null;
      }

      // 把 storage 讀到的原始值正規化成查表形狀，並清空兩份容器記憶讓整頁重
      // 掃：名單換版後，新增的作者要補掛，解除的作者不再被補回。TCLCore 缺席
      // 或正規化失敗時退成空名單：寧可不掛，也不拿未正規化的結構查表。
      function setBlocklist(raw) {
        var list = null;
        try {
          var core = root.TCLCore;
          if (core && typeof core.normalizeScamBlocklist === 'function') {
            list = core.normalizeScamBlocklist(raw);
          }
        } catch (e) {
          list = null;
        }
        // 沒有任何可查的作者時查表側留 null，可以立刻收工、不走訪 DOM；解除
        // 名單的檢查另外拿完整的 list，條目被移進 allowlist 後 handleIndex
        // 可能已經空了。
        blocklist =
          list && list.handleIndex && Object.keys(list.handleIndex).length > 0 ? list : null;
        listedContainers = newContainerSet();
        taggedContainers = newContainerSet();
        releaseAllowlistedScan(list);
      }

      // 掃描命中掛上的 tag 被 React 沖掉後，會由同鍵的下一次觸發補回。補回
      // 是還原上一輪判定，不是重新判定——使用者在選項頁解除封鎖之後那個判定
      // 已被否決，補回旗標必須跟著撤掉。已經掛在頁面上的 tag 不回收，與查表
      // 側一致：解除只影響之後的掛載。
      //
      // 比對主鍵是 userId；SSR 取不到而由 background 走匿名備援補查時本頁只
      // 有 handle，改以解除紀錄自己存的 handle 比對（解除會把條目移出
      // entries，handleIndex 那條路這時已經查不到）。
      function releaseAllowlistedScan(list) {
        if (!lastScan || !lastScan.tagged) return;
        if (!list || !list.allowlist) return;
        if (lastScan.userId) {
          if (Object.prototype.hasOwnProperty.call(list.allowlist, lastScan.userId)) {
            lastScan.tagged = false;
          }
          return;
        }
        var wanted = normalizeHandle(lastScan.handle);
        if (!wanted) return;
        var ids = Object.keys(list.allowlist);
        for (var i = 0; i < ids.length; i++) {
          if (normalizeHandle(list.allowlist[ids[i]].handle) === wanted) {
            lastScan.tagged = false;
            return;
          }
        }
      }

      // 一次 O(1) 查表：handle 小寫化後查 handleIndex 得 userId，userId 不在
      // allowlist（使用者已解除封鎖）才算命中。
      function isBlockedHandle(handle) {
        if (!blocklist) return false;
        var key = normalizeHandle(handle);
        if (!key || !Object.prototype.hasOwnProperty.call(blocklist.handleIndex, key)) return false;
        var userId = blocklist.handleIndex[key];
        return !Object.prototype.hasOwnProperty.call(blocklist.allowlist, userId);
      }

      // ---- 逐張卡片查表。
      //
      // 可見性先過：看不見的卡片一律整張跳過，兩份容器記憶都不得越過這一
      // 關。接著三段短路依序擋下重複工作：
      //   1. 已掛過 tag 的容器只檢查 tag 還在不在——React 重繪會把節點整個沖
      //      掉，容器本身卻沒換，「已查過表」的記憶不能連警示還在不在一起省
      //      掉（詳情頁掃描那條路的 lastScan.tagged 有同樣的保證）。
      //   2. 已查過表且未命中的容器不再走訪。
      //   3. 連續取不到 permalink 達上限的容器（廣告卡、推薦帳號卡這類版面本
      //      來就沒有貼文連結）併入第 2 類，不再重跑子樹查詢。
      //
      // 詳情頁的分工：同一串的自回覆由 scan() 代表（只掛主文卡一顆），這裡跳
      // 過，免得每一篇各掛一顆；但主文卡本身仍查表——作者已在黑名單、這一串卻
      // 沒踩到判定時，河道看得到警示、點進去卻沒有是更糟的體驗。掃描命中時它
      // 已經認領了主文卡那一張容器，查表對它讓位，讓資訊量較大的
      // scamTagTooltip 掛得上去。----
      function scanBlocklist() {
        if (!settingsReady || !scamGuardEnabled || !blocklist) return;

        var pathInfo = readPathInfo();
        var ownerHandle = pathInfo ? normalizeHandle(pathInfo.handle) : '';

        var containers = document.querySelectorAll(CONTAINER_SELECTOR);

        // 掃描認領的容器在本輪的容器清單裡找不到（React 已經把它換成新節
        // 點）時視同缺席，讓位退回比 code——否則新卡既不是認領的那一張、又
        // 拿不到掃描的 tag，兩條路都不掛。
        var claimedContainer = null;
        if (claimedMainContainer) {
          for (var c = 0; c < containers.length; c++) {
            if (containers[c] !== claimedMainContainer) continue;
            claimedContainer = claimedMainContainer;
            break;
          }
        }

        for (var i = 0; i < containers.length; i++) {
          var container = containers[i];

          // 隱藏子樹（SPA 收起來的舊路由層）裡的卡片使用者看不到，標了也是
          // 白標。這條必須排在補回捷徑之前：河道卡掛過 tag 之後被原地收起來
          // 時還是同一個節點，捷徑只問「標過沒有」，排在後面就會讓它在看不
          // 見的地方把 tag 無條件長回來。
          if (isHiddenNode(container)) continue;

          if (taggedContainers && taggedContainers.has(container)) {
            // 查表只掛 scamBlockedByList 這一種，補回時不必另外記 titleKey。
            if (!container.querySelector || !container.querySelector('.' + TAG_CLASS)) {
              insertTag(container, LIST_TAG_TITLE_KEY);
            }
            continue;
          }
          if (listedContainers && listedContainers.has(container)) continue;

          // 巢狀容器（引用貼文）不算獨立的一張卡，判準與 collectOwnContainers
          // 一致。被引用者是誰不影響外層卡的作者，兩邊都不該掛。
          var parent = container.parentElement || container.parentNode;
          if (parent && parent.closest && parent.closest(CONTAINER_SELECTOR)) continue;

          var permalink = readContainerPermalink(container);
          if (!permalink) {
            notePermalinkMiss(container);
            continue;
          }
          if (listedContainers) listedContainers.add(container);

          var handle = normalizeHandle(permalink.handle);
          if (ownerHandle && handle === ownerHandle && permalink.code !== pathInfo.code) continue;
          if (claimedContainer) {
            if (container === claimedContainer) continue;
          } else if (claimedMainCode && permalink.code === claimedMainCode) {
            continue;
          }
          if (!isBlockedHandle(handle)) continue;

          insertTag(container, LIST_TAG_TITLE_KEY);
          if (taggedContainers) taggedContainers.add(container);
        }
      }

      // 容器取不到 permalink 就幾乎永遠取不到。連續 PERMALINK_MISS_LIMIT 次之
      // 後併入已查表集合，之後不再對它重跑 querySelectorAll('a[href]')；給三次
      // 餘裕是因為 React 有可能先掛容器、下一批才補上連結。
      function notePermalinkMiss(container) {
        if (!permalinkMisses || !listedContainers) return;
        var misses = (permalinkMisses.get(container) || 0) + 1;
        permalinkMisses.set(container, misses);
        if (misses >= PERMALINK_MISS_LIMIT) listedContainers.add(container);
      }

      function safeScan() {
        try {
          scan();
        } catch (e) {
          console.warn('[threads-clean-link] 詐騙串文掃描失敗', e);
        }
        try {
          scanBlocklist();
        } catch (e) {
          console.warn('[threads-clean-link] 黑名單查表失敗', e);
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

      // ---- chrome.storage.local 的兩顆鍵一次讀回：總開關 scamGuardEnabled
      // （只有明確存成 false 才視為關閉；缺席、讀取失敗、storage 缺席一律視為
      // 開啟）與黑名單 scamBlocklist（缺席即空名單）。----
      function readSettings(callback) {
        var done = false;
        function finish(items) {
          if (done) return;
          done = true;
          var safe = items && typeof items === 'object' ? items : {};
          callback(safe.scamGuardEnabled === false ? false : true, safe.scamBlocklist);
        }
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.local ||
            typeof chrome.storage.local.get !== 'function'
          ) {
            finish(null);
            return;
          }
          var maybePromise = chrome.storage.local.get(
            { scamGuardEnabled: true, scamBlocklist: null },
            function (items) {
              finish(items);
            }
          );
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
              .then(function (items) {
                finish(items);
              })
              .catch(function () {
                finish(null);
              });
          }
        } catch (e) {
          finish(null);
        }
      }

      function watchSettingsChanges() {
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
            if (areaName !== 'local' || !changes) return;
            var dirty = false;
            if (changes.scamGuardEnabled) {
              scamGuardEnabled = changes.scamGuardEnabled.newValue === false ? false : true;
              // 關閉只影響之後的掃描：已經掛上的 tag 代表已經寫進黑名單的事
              // 實，不隨開關撤掉（撤銷在選項頁的黑名單卡片操作）。
              if (scamGuardEnabled) dirty = true;
            }
            if (changes.scamBlocklist) {
              // 名單換版：重建快取並清空容器記憶，新增的作者下一次觸發補掛，
              // 解除的作者不再新增（既有的 tag 不回收）。
              sawBlocklistChange = true;
              setBlocklist(changes.scamBlocklist.newValue);
              dirty = true;
            }
            if (dirty) scheduleScan();
          });
        } catch (e) {
          // 監聽註冊失敗只是設定不會即時生效，不影響已完成的掃描。
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
        watchSettingsChanges();

        // 與 post-icon 的「先用預設值立刻動作」相反：掃描會送訊息、會改頁
        // 面，必須等總開關與黑名單讀回來才做第一輪。
        readSettings(function (enabled, rawBlocklist) {
          scamGuardEnabled = enabled;
          // onChanged 已經送過更新的名單就不覆蓋：這裡拿到的是發出讀取當下的
          // 舊快照。
          if (!sawBlocklistChange) setBlocklist(rawBlocklist);
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
