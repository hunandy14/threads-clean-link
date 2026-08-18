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

  // 0.5.0 貼文收藏庫:從一個「乾淨貼文網址」(buildPostUrl 的輸出，或任何
  // 同形狀的絕對網址)導出收藏用的正規路徑 id(如 @user/post/ABC123)，語
  // 意對齊 background.js 的 FAVORITE_URL_PATTERN group 2——去 domain、去尾
  // 隨斜線、去 query/hash。內容腳本用這個 id 對照 storage.local 讀出的
  // favorites 清單(條目已有 id 欄位)，判斷目前這篇貼文是否已收藏，藉此
  // 決定書籤 icon 顯示實心或空心。這裡的正則刻意比 background 的驗證正
  // 則寬鬆(background 才是最終權威，任何 toggle 都會在那邊重新驗證)，
  // 寬鬆比對的唯一代價是初始顯示狀態偶爾判斷不準，不影響資料正確性。url
  // 非字串或格式不符一律回傳 null，不丟例外。
  var FAVORITE_ID_PATTERN =
    /^https:\/\/(?:www\.)?threads\.(?:com|net)\/(@[^/?#]+\/post\/[^/?#]+)\/?(?:[?#].*)?$/i;
  function buildFavoriteId(url) {
    if (typeof url !== 'string') return null;
    var match = FAVORITE_ID_PATTERN.exec(url);
    return match ? match[1] : null;
  }

  // scope(貼文容器或互動列)內是否已經注入過我們的 icon，用來讓注入邏輯
  // 冪等，避免重複插入。scope 缺失或不是帶 querySelector 的物件一律回傳
  // false，不丟例外。
  function hasExistingIcon(scope) {
    if (!scope || typeof scope.querySelector !== 'function') return false;
    try {
      return !!scope.querySelector('.tcl-copy-icon');
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // DOM 注入層(瀏覽器整合層)。碰 document / MutationObserver 的邏輯全部
  // 收在這個守衛裡，Node 測試環境 require() 本檔時直接跳過整段，不執行、
  // 不丟例外。
  // ============================================================
  if (typeof document !== 'undefined') {
    (function () {
      var ICON_CLASS = 'tcl-copy-icon';
      // 0.5.0 貼文收藏庫:書籤 icon 的外層 wrapper class，與複製 icon 並排
      // 插在互動列最後，共用同一套樣式規則(見 injectStyle)、同一套
      // SVG_WRAP_CLASS／TOOLTIP_CLASS 內層結構、同一輪 scanAndInject 掃描。
      var FAV_ICON_CLASS = 'tcl-fav-icon';
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

      // 0.5.0 貼文收藏庫:書籤(Lucide bookmark)圖示，未收藏空心、已收藏實
      // 心——兩者共用同一個 path，差別只在 fill:none／currentColor，換圖
      // 示邏輯比照 LINK_SVG/CHECK_SVG 的 innerHTML 互換模式(見
      // createFavIconElement 的 render())。
      var BOOKMARK_OUTLINE_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<title></title>' +
        '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>' +
        '</svg>';
      var BOOKMARK_FILLED_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<title></title>' +
        '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>' +
        '</svg>';

      // 目前使用的語言，載入時由 chrome.storage.sync 的 langPref 解析；
      // storage.onChanged 觸發時即時更新既有 icon 的文案。
      var currentLocale = 'en';

      // i18n.js 理論上一定會在 post-icon.js 之前載入(manifest content_scripts
      // 陣列順序保證)，但防禦性地假設 TCLI18N 可能不存在或呼叫時丟例外：
      // 退回這份內建的英文字面值表，不要讓使用者看到原始 key 字串。
      // favContextLost 的 zh/en 兩個字面值由另一車道併入 i18n.js 字典(此
      // 分支刻意不動 i18n.js，避免合併衝突)；在該字典還沒有這個 key 的期
      // 間(例如本車道獨立測試、或分支尚未合併)，TCLI18N.t() 對不存在的
      // key 會直接回傳 key 本身字串(見 i18n.js 的 t() 實作)，不會丟例
      // 外，因此一般的 t(key) 掉不到下面的 FALLBACK_STRINGS——這裡才需要
      // favContextLost 專屬的 tContextLost()，見下方。
      var FALLBACK_STRINGS = {
        iconTooltip: 'Copy original link',
        iconCopied: 'Original link copied',
        favIconTooltip: 'Save post',
        favSaved: 'Saved',
        favRemoved: 'Removed from favorites',
        favFull: 'Favorites full (500 limit)',
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
      // key 本身字串，直接採用；字典還沒有這個 key(過渡期或本車道獨立測
      // 試)時，t() 會原樣把 key 字串傳回來，這裡改用
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

      // ---- 從貼文容器擷取「乾淨貼文網址」:複製 icon 與書籤 icon 共用同一
      // 套鏈(filterOwnContainerHrefs → pickPermalink → buildPostUrl)，抽成
      // 共用函式避免兩處各自維護一份。container 缺失或擷取任何一步失敗都
      // 回傳 null，不丟例外，由呼叫端決定要不要記警告訊息。----
      function extractContainerCleanUrl(container) {
        if (!container || typeof container.querySelectorAll !== 'function') return null;
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
        if (!permalink) return null;
        return buildPostUrl(permalink, root.location.origin);
      }

      // ---- 0.5.0 貼文收藏庫:從貼文容器 DOM 擷取 author/handle/excerpt，
      // 只在使用者實際點擊書籤 icon 時呼叫(初始收藏狀態只需要 url 導出
      // 的 id，不需要這三個欄位)。三者皆為選填，擷取不到就整欄不寫進回
      // 傳物件，由呼叫端決定要不要把該欄位放進 favoriteToggle 訊息——協
      // 定本來就允許缺席(background 端 sanitizeFavoriteField 只處理型別
      // 為 string 的欄位)。----

      // 相對時間戳記("18小時"／"4h"／"2026-4-29" 這類短字串)常以獨立
      // [dir="auto"] span 呈現，且緊跟在作者名之後、貼文內文之前，擷取內
      // 文時需要跳過，否則會把時間戳記誤當內文的第一段。涵蓋 zh/en 常見
      // 單位字與絕對日期(YYYY-M-D)格式；整串錨定(^...$)避免誤傷真正的
      // 貼文內文(內文極不可能整段就剛好是這種短樣式)。
      var RELATIVE_TIME_RE =
        /^(\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)|\d+\s*(秒|分鐘|小時|天|週|周)|\d{4}-\d{1,2}-\d{1,2}|now|Just now|現在|剛剛)$/i;

      // 讚數/回覆數/轉發數這類互動計數，實測格式包含純數字("97")、千分位
      // 逗號("2,440")、以及可能的 K/M/B 縮寫("1.2K")。內文若掃到這種計
      // 數字串，視為「內文區段已經結束、進入互動列的計數區」的邊界訊
      // 號，中止收集(見 extractExcerpt)。整串錨定，不影響內文中間出現的
      // 數字(例如「打了 97 折」不會整串只有數字，不會誤判)。
      var COUNT_LIKE_RE = /^[\d,.]+[KMB]?$/i;

      // 與 background.js 的 FAVORITES_EXCERPT_MAX 對齊(PM 核對手機 repo
      // 後裁決的上限)；這裡預先截斷一次，background 端仍會再做一次防禦
      // 性截斷(sanitizeFavoriteField)，兩處各自獨立不互相依賴。
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
      // 文本身不是)的候選;遇到計數字串(COUNT_LIKE_RE)視為內文結束的邊
      // 界訊號，立即停止收集;已收集到內容後若再遇到空字串，同樣視為邊
      // 界(部分版面沒有可見計數字串，用空字串兜底)。多段內文(部分貼文
      // 每行是獨立 span 而非同一個 span 內用 \n 分隔)用 '\n' 接起來。擷
      // 取不到任何內容回傳 undefined，由呼叫端決定要不要放進訊息。----
      function extractExcerpt(container) {
        try {
          var spans = container.querySelectorAll('[dir="auto"]');
          var parts = [];
          for (var i = 0; i < spans.length; i++) {
            var el = spans[i];
            if (el.closest && el.closest('div[data-pressable-container]') !== container) continue;
            if (el.closest && el.closest('a')) continue;
            var text = cleanElementText(el);
            if (COUNT_LIKE_RE.test(text)) break;
            if (!text) {
              if (parts.length) break;
              continue;
            }
            if (RELATIVE_TIME_RE.test(text)) continue;
            parts.push(text);
          }
          if (!parts.length) return undefined;
          return parts.join('\n').slice(0, EXCERPT_MAX);
        } catch (e) {
          return undefined;
        }
      }

      // ---- 樣式注入:hover 圓底高亮 + 點擊回饋氣泡，標 id 防重複注入 ----
      // 複製 icon 與書籤 icon 的外層 wrapper 結構(圓形點擊區、hover 圓
      // 底、內層 svg wrapper、氣泡 tooltip)完全相同，只有外層 class 名稱
      // 不同，這裡把原本針對 ICON_CLASS 寫死的規則改成對一組 class 名稱
      // 迴圈輸出，兩顆 icon 共用同一份樣式定義，內容與原本針對 ICON_CLASS
      // 的規則逐字相同(只是換了 class 名稱)，不影響既有複製 icon 的外觀。
      function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        var rules = [];
        var iconClasses = [ICON_CLASS, FAV_ICON_CLASS];
        for (var c = 0; c < iconClasses.length; c++) {
          var cls = iconClasses[c];
          rules.push(
            '.' + cls + '{position:relative;display:inline-flex;align-items:center;',
            'justify-content:center;width:36px;height:36px;border-radius:9999px;cursor:pointer;',
            'color:inherit;background-color:transparent;}',
            '.' + cls + ':focus-visible{outline:2px solid currentColor;outline-offset:1px;}',
            // hover 圓底:實機量測原生互動列按鈕的 hover 背景，深色主題是
            // rgb(30,30,30)、瞬間出現(無 transition)，這裡照抄精確值與行
            // 為。淺色主題同樣為實測值 rgb(245,245,245)(CDP 模擬
            // prefers-color-scheme 實測)。
            '@media (prefers-color-scheme: dark){.' + cls + ':hover{background-color:rgb(30,30,30);}}',
            '@media (prefers-color-scheme: light){.' + cls + ':hover{background-color:rgb(245, 245, 245);}}',
            // svg 設 pointer-events:none 讓滑鼠事件穿透到外層可互動的 div
            // (click/keydown 都綁在 el，見 createIconElement／
            // createFavIconElement)，副作用是游標永遠不會落在 svg 上，svg
            // 內 <title> 的原生 tooltip 因此永不觸發(原生互動列按鈕的 svg
            // 是 pointer-events:auto 所以有效)。原生 tooltip 改掛在外層 div
            // 的 title 屬性上才會觸發。
            '.' + cls + ' .' + SVG_WRAP_CLASS + '{display:inline-flex;pointer-events:none;}',
            // 點擊回饋自繪氣泡:hover 提示已改用外層 div 的原生 title 屬
            // 性，這顆 tooltip 元素不再靠 :hover 觸發，只在點擊回饋時由
            // showCopiedFeedback()／showBubble() 加上 TOOLTIP_VISIBLE_CLASS
            // 類別顯示，COPIED_RESET_MS 後自動移除。
            '.' + cls + ' .' + TOOLTIP_CLASS + '{position:absolute;top:calc(100% + 6px);left:50%;',
            'transform:translateX(-50%);padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.4;',
            'white-space:nowrap;background:#1c1c1c;color:#fff;opacity:0;pointer-events:none;',
            'transition:opacity .12s ease;z-index:1000;}',
            '@media (prefers-color-scheme: light){.' + cls + ' .' + TOOLTIP_CLASS + '{background:#e5e5e5;color:#050505;}}',
            '.' + cls + ' .' + TOOLTIP_CLASS + '.' + TOOLTIP_VISIBLE_CLASS + '{opacity:1;}'
          );
        }
        style.textContent = rules.join('');
        (document.head || document.documentElement).appendChild(style);
      }

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
                notifyBackgroundCleaned(url);
              })
              .catch(function (err) {
                console.warn('[threads-clean-link] 寫入剪貼簿失敗', err);
              });
          } catch (err) {
            console.warn('[threads-clean-link] 寫入剪貼簿時發生例外', err);
          }
        }

        // 把「已複製乾淨連結」這件事轉知 background，讓 options 頁的淨化
        // 紀錄能收進這條路徑(kind:'icon'，不冒用右鍵選單的 'menu')。純
        // 通知性質，整段吞例外——chrome.runtime 不存在(context 已失效／
        // 非擴充功能頁面)或 sendMessage 本身丟例外，都不得影響前面已經
        // 成功的複製與勾勾回饋。
        //
        // MV3 下不帶 callback 呼叫 sendMessage 會回傳 Promise：background
        // 的 cleanedNotice 監聽器 return false(同步處理完即關通道)，該
        // Promise 會以「message port closed」reject，若不接 .catch 就會在
        // 頁面 console 留下 unhandled promise rejection。回傳值先防禦性
        // 檢查是不是真的 Promise(舊瀏覽器 sendMessage 可能不回傳任何東西)
        // 再接空 .catch 吞掉。
        function notifyBackgroundCleaned(url) {
          try {
            if (
              typeof chrome === 'undefined' ||
              !chrome.runtime ||
              typeof chrome.runtime.sendMessage !== 'function'
            ) {
              return;
            }
            var maybePromise = chrome.runtime.sendMessage({
              type: 'cleanedNotice',
              cleanUrl: url,
              kind: 'icon',
            });
            if (maybePromise && typeof maybePromise.catch === 'function') {
              maybePromise.catch(function () {});
            }
          } catch (err) {
            console.warn('[threads-clean-link] 通知 background 記錄淨化紀錄失敗', err);
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

      // ---- 0.5.0 貼文收藏庫:目前已收藏貼文的 id 集合(buildFavoriteId 導
      // 出的正規路徑)，啟動時從 chrome.storage.local 的 favorites 讀入，
      // chrome.storage.onChanged 觸發時整份重建。書籤 icon 的初始實心／空
      // 心狀態、以及運行中即時更新，都靠查這個 Set。----
      var favoriteIds = new Set();

      function rebuildFavoriteIds(list) {
        var next = new Set();
        if (Array.isArray(list)) {
          for (var i = 0; i < list.length; i++) {
            if (list[i] && typeof list[i].id === 'string') next.add(list[i].id);
          }
        }
        favoriteIds = next;
      }

      // ---- 單顆書籤 icon 元素:互動列複製 icon 之後再插一顆，圖示／氣泡／
      // hover 圓底／冪等機制全部沿用複製 icon 同一套(見 createIconElement
      // 與 injectStyle)。與複製 icon 最大的差異:這顆有「已收藏／未收藏」
      // 兩種持久狀態(靠 fill 圖示切換，不是像複製 icon 那樣點擊後幾秒又
      // 復原)，且點擊要送 favoriteToggle 訊息並依回應決定新狀態，而不是
      // 直接寫剪貼簿。----
      function createFavIconElement(container) {
        var el = document.createElement('div');
        el.className = FAV_ICON_CLASS;
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', t('favIconTooltip'));
        el.setAttribute('title', t('favIconTooltip'));

        var iconWrap = document.createElement('span');
        iconWrap.className = SVG_WRAP_CLASS;
        el.appendChild(iconWrap);

        var tooltip = document.createElement('span');
        tooltip.className = TOOLTIP_CLASS;
        el.appendChild(tooltip);

        var saved = false;
        var bubbleResetTimer = null;

        function applyFavIconTitle() {
          var titleEl = iconWrap.querySelector('title');
          if (titleEl) titleEl.textContent = t('favIconTooltip');
        }

        function render() {
          iconWrap.innerHTML = saved ? BOOKMARK_FILLED_SVG : BOOKMARK_OUTLINE_SVG;
          applyFavIconTitle();
        }

        function setSaved(nextSaved) {
          saved = !!nextSaved;
          render();
        }

        // 初始狀態:依這篇貼文目前導出的 url/id 查 favoriteIds Set。id 存
        // 在 el 上(_tclFavId)，storage.onChanged 更新時直接用它比對，不
        // 需要重新掃一次 DOM。
        var initialUrl = extractContainerCleanUrl(container);
        el._tclFavId = initialUrl ? buildFavoriteId(initialUrl) : null;
        setSaved(el._tclFavId ? favoriteIds.has(el._tclFavId) : false);

        // 語言切換時同步 aria-label／title／svg <title>；持久狀態(實心／
        // 空心)與語言無關，不受影響。已顯示中的氣泡文字是一次性事件訊
        // 息，不因語言切換即時改寫(等它自然消失，比照複製 icon 對「已複
        // 製」暫時狀態的處理方式)。
        el._tclApplyLocale = function () {
          el.setAttribute('aria-label', t('favIconTooltip'));
          el.setAttribute('title', t('favIconTooltip'));
          applyFavIconTitle();
        };

        // storage.onChanged 觸發、favoriteIds 重建後呼叫，依目前這顆 icon
        // 對應的 id 是否還在集合內同步視覺狀態(涵蓋「別的分頁把它取消收
        // 藏」這類非本地操作觸發的變化)。
        el._tclSyncFavoriteState = function () {
          setSaved(el._tclFavId ? favoriteIds.has(el._tclFavId) : false);
        };

        function showBubble(text) {
          tooltip.textContent = text;
          tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
          if (bubbleResetTimer) clearTimeout(bubbleResetTimer);
          bubbleResetTimer = setTimeout(function () {
            bubbleResetTimer = null;
            tooltip.classList.remove(TOOLTIP_VISIBLE_CLASS);
          }, COPIED_RESET_MS);
        }

        // sendMessage 失敗時的錯誤分類:擴充功能更新/重載後，已注入頁面
        // 的舊 content script 呼叫 chrome.runtime.sendMessage 會丟出帶
        // 「Extension context invalidated」字樣的例外(孤兒情境，事故改
        // 進項目)——這種情況下重新整理頁面才能恢復，用 favContextLost 提
        // 示使用者，而不是靜默失敗或印一般性警告。其餘錯誤走一般警告。
        function handleSendError(err) {
          var msg = err && err.message ? err.message : String(err);
          if (/extension context invalidated/i.test(msg)) {
            showBubble(tContextLost());
          } else {
            console.warn('[threads-clean-link] 送出收藏切換訊息失敗', err);
          }
        }

        function handleResponse(url, response) {
          if (!response || response.ok !== true) {
            var reason = response && response.reason;
            if (reason === 'full') {
              showBubble(t('favFull'));
            } else {
              console.warn('[threads-clean-link] favoriteToggle 失敗', reason || '(unknown)');
            }
            return;
          }
          el._tclFavId = buildFavoriteId(url);
          setSaved(response.saved);
          showBubble(response.saved ? t('favSaved') : t('favRemoved'));
        }

        function handleActivate(event) {
          if (event) {
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            if (typeof event.preventDefault === 'function') event.preventDefault();
          }

          var liveContainer = el.closest ? el.closest('div[data-pressable-container]') : null;
          if (!liveContainer) {
            console.warn('[threads-clean-link] 找不到貼文容器，略過收藏');
            return;
          }

          var url = extractContainerCleanUrl(liveContainer);
          if (!url) {
            console.warn('[threads-clean-link] 找不到貼文永久連結，略過收藏');
            return;
          }

          if (
            typeof chrome === 'undefined' ||
            !chrome.runtime ||
            typeof chrome.runtime.sendMessage !== 'function'
          ) {
            console.warn('[threads-clean-link] 此環境不支援 chrome.runtime.sendMessage');
            return;
          }

          var info = extractAuthorHandle(liveContainer);
          var excerpt = extractExcerpt(liveContainer);
          var payload = { type: 'favoriteToggle', url: url };
          if (info.author !== undefined) payload.author = info.author;
          if (info.handle !== undefined) payload.handle = info.handle;
          if (excerpt !== undefined) payload.excerpt = excerpt;

          try {
            var maybePromise = chrome.runtime.sendMessage(payload);
            if (maybePromise && typeof maybePromise.then === 'function') {
              maybePromise
                .then(function (response) {
                  handleResponse(url, response);
                })
                .catch(handleSendError);
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
          var nativeSvg = row.querySelector('svg[aria-label]');
          if (!nativeSvg) return;
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

        // 0.5.0 貼文收藏庫:書籤 icon 緊接在複製 icon 之後插入，併入同一
        // 輪掃描、同一次冪等判斷(上面的 hasExistingIcon 檢查已經確保這個
        // container/row 只會走到這裡一次)，不另開 MutationObserver。icon
        // 為 null 時(insertBefore(el, null))效果等同 appendChild，此時
        // icon 剛插入、正是 row 的最後一個子元素，書籤圖示因此準確排在
        // 複製 icon 右邊。
        var favIcon = createFavIconElement(container);
        applyNativeColor(favIcon, row);
        row.insertBefore(favIcon, icon.nextSibling);

        if (scanFailCounts) scanFailCounts.delete(container);
        if (scanFailFirstAt) scanFailFirstAt.delete(container);
        if (injectedContainers) injectedContainers.add(container);
      }

      // ---- 全頁掃描:找出所有貼文容器並補注入 ----
      function scanAndInject() {
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

      // ---- 語言切換時，更新頁面上既有 icon 的文案(複製 icon 與書籤 icon
      // 都有 _tclApplyLocale，一併更新)----
      function applyLocaleToExistingIcons() {
        try {
          var icons = document.querySelectorAll('.' + ICON_CLASS + ', .' + FAV_ICON_CLASS);
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

      // ---- 0.5.0 貼文收藏庫:讀取 chrome.storage.local 的 favorites 清
      // 單，建初始 favoriteIds Set。防禦 callback 與 Promise 兩種
      // chrome.storage.local.get 形態，寫法比照 readLangPref。讀取失敗或
      // chrome.storage.local 缺席一律回傳空陣列，讓所有書籤 icon 落在
      // 「未收藏」的安全預設狀態。----
      function readFavorites(callback) {
        var done = false;
        function finish(list) {
          if (done) return;
          done = true;
          callback(Array.isArray(list) ? list : []);
        }
        try {
          if (
            typeof chrome === 'undefined' ||
            !chrome.storage ||
            !chrome.storage.local ||
            typeof chrome.storage.local.get !== 'function'
          ) {
            finish([]);
            return;
          }
          var maybePromise = chrome.storage.local.get({ favorites: [] }, function (items) {
            finish(items && items.favorites);
          });
          // 部分環境(Promise-only 的 storage 實作)不吃回呼引數，get() 本
          // 身回傳 Promise，改吃這個分支。
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise
              .then(function (items) {
                finish(items && items.favorites);
              })
              .catch(function () {
                finish([]);
              });
          }
        } catch (e) {
          finish([]);
        }
      }

      // ---- chrome.storage.onChanged:favorites 清單變動(使用者在別的分
      // 頁／options 收藏分頁增減收藏)時，重建 favoriteIds 並同步所有已注
      // 入書籤 icon 的實心／空心狀態。----
      function watchFavoritesChanges() {
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
            if (areaName !== 'local' || !changes || !changes.favorites) return;
            rebuildFavoriteIds(changes.favorites.newValue);
            applyFavoriteStateToExistingIcons();
          });
        } catch (e) {
          // 監聽註冊失敗不影響已注入的書籤運作，只是狀態不會跨分頁即時同步。
        }
      }

      // ---- favoriteIds 重建後，同步頁面上所有已注入書籤 icon 的視覺狀態
      // (實心／空心)。每顆 icon 的 _tclSyncFavoriteState 只讀自己身上存
      // 的 _tclFavId 比對，不重新掃 DOM。----
      function applyFavoriteStateToExistingIcons() {
        try {
          var icons = document.querySelectorAll('.' + FAV_ICON_CLASS);
          for (var i = 0; i < icons.length; i++) {
            if (icons[i]._tclSyncFavoriteState) icons[i]._tclSyncFavoriteState();
          }
        } catch (e) {
          // 更新既有書籤狀態失敗不影響其餘流程，下次重新整理會自然修正。
        }
      }

      function init() {
        // 不等 chrome.storage.sync 的回呼:先用 resolveLocaleSafe(null) 的
        // 預設語言(環境偵測)立刻掃描注入、啟動 observer，避免 storage 遲
        // 遲不回呼(甚至永遠不回呼，例如測試/沙箱環境的 mock 不完整)時
        // icon 整個出不來。langPref 讀到之後再透過 setLocale 補刷已注入
        // icon 的文案；storage 永不回呼時功能照常運作，只是文案停在預設
        // 語言。
        setLocale(resolveLocaleSafe(null));
        scanAndInject();
        startObserver();

        readLangPref(function (langPref) {
          setLocale(resolveLocaleSafe(langPref));
        });
        watchLangPrefChanges();

        // 0.5.0 貼文收藏庫:不等 chrome.storage.local 的回呼——書籤 icon 已
        // 在上面的 scanAndInject() 以「未收藏」(空心)的安全預設狀態注入；
        // favorites 清單讀到之後透過 applyFavoriteStateToExistingIcons 補
        // 刷正確的實心／空心狀態，理由與 langPref 的先掃描後補刷完全一致。
        readFavorites(function (list) {
          rebuildFavoriteIds(list);
          applyFavoriteStateToExistingIcons();
        });
        watchFavoritesChanges();
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
  }

  // ============================================================
  // 模組匯出
  // ============================================================
  var api = {
    pickPermalink: pickPermalink,
    buildPostUrl: buildPostUrl,
    hasExistingIcon: hasExistingIcon,
    pickActionRowIndex: pickActionRowIndex,
    filterOwnContainerHrefs: filterOwnContainerHrefs,
    buildFavoriteId: buildFavoriteId,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TCLPostIcon = api;
  }
})(typeof window !== 'undefined' ? window : this);
