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

  // 取容器內最長的 [dir="auto"] 文字當本文；同樣只收屬於本容器本身的節
  // 點，作者名那種短節點自然會被長度比下去，引用卡片的內文則靠 closest 過
  // 濾擋掉（長度比不贏時不該當成過濾機制）。[dir="auto"] 會互相巢狀——外層
  // 包裝節點的 textContent 必定含作者名、時間戳記等雜訊且恆為最長，因此只
  // 取最內層（本身不再包含其他 [dir="auto"] 的節點）。
  function readContainerBody(container) {
    var nodes = container.querySelectorAll('[dir="auto"]');
    var best = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.closest && node.closest(CONTAINER_SELECTOR) !== container) continue;
      if (node.querySelector && node.querySelector('[dir="auto"]')) continue;
      var text = node.textContent || '';
      if (text.length > best.length) best = text;
    }
    return best;
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

        var body = readContainerBody(container);
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
  // DOM 注入層（瀏覽器整合層）。碰 document 的掃描與警示注入全部收在這個
  // 守衛裡，Node 測試環境 require() 本檔時直接跳過整段。
  //
  // 【接點】判定（話術正則）與警示注入尚未實作，接上時的取值順序為：
  //   1. document.querySelectorAll('script[type="application/json"]') 的
  //      textContent 收成陣列 → extractSsrRoot(texts, 網址列的 post code)
  //      取作者數字 id、串長、首篇。
  //   2. extractThreadFromDom(document, ssrRoot.username,
  //      ssrRoot.selfThreadLength) 取自回覆串各篇。
  //   3. buildThreadText() 串成全文 → 交給判定與黑名單寫入。
  // ============================================================
  if (typeof document !== 'undefined') {
    // 掃描與注入由後續實作接手。
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TCLScamGuard = api;
  }
})(typeof window !== 'undefined' ? window : this);
