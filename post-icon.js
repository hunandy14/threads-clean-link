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
      // 元素做 hover 時的系統原生 tooltip，我們比照同一機制(見
      // createIconElement 的 applyIconTitle)，不再自己畫 hover tooltip。
      // <title> 留空字串，內容由 applyIconTitle() 用 textContent 動態填
      // 入語言字典值，innerHTML 本身仍只含靜態常數。
      var LINK_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<title></title>' +
        '<path d="M9 17H7a5 5 0 0 1 0-10h2"/>' +
        '<path d="M15 7h2a5 5 0 1 1 0 10h-2"/>' +
        '<line x1="8" y1="12" x2="16" y2="12"/>' +
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

      // i18n.js 理論上一定會在 post-icon.js 之前載入(manifest content_scripts
      // 陣列順序保證)，但防禦性地假設 TCLI18N 可能不存在或呼叫時丟例外：
      // 退回這份內建的英文字面值表，不要讓使用者看到原始 key 字串。
      var FALLBACK_STRINGS = {
        iconTooltip: 'Copy original link',
        iconCopied: 'Original link copied',
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
          '.' + ICON_CLASS + ' .' + SVG_WRAP_CLASS + '{display:inline-flex;pointer-events:none;}',
          // 點擊後「已複製原始連結」的自繪回饋氣泡:hover 提示已改用 SVG
          // 內建的原生 <title>(見 LINK_SVG/CHECK_SVG 與 createIconElement
          // 的 applyIconTitle)，這顆 tooltip 元素不再靠 :hover 觸發，只
          // 在點擊回饋時由 showCopiedFeedback() 加上
          // TOOLTIP_VISIBLE_CLASS 類別顯示，COPIED_RESET_MS 後自動移除。
          '.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '{position:absolute;top:calc(100% + 6px);left:50%;',
          'transform:translateX(-50%);padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.4;',
          'white-space:nowrap;background:#1c1c1c;color:#fff;opacity:0;pointer-events:none;',
          'transition:opacity .12s ease;z-index:1000;}',
          '@media (prefers-color-scheme: light){.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '{background:#e5e5e5;color:#050505;}}',
          '.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '.' + TOOLTIP_VISIBLE_CLASS + '{opacity:1;}',
        ].join('');
        (document.head || document.documentElement).appendChild(style);
      }

      // ---- 單顆 icon 元素:圖示、tooltip、點擊/鍵盤複製邏輯 ----
      function createIconElement() {
        var el = document.createElement('div');
        el.className = ICON_CLASS;
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', t('iconTooltip'));

        var iconWrap = document.createElement('span');
        iconWrap.className = SVG_WRAP_CLASS;
        iconWrap.innerHTML = LINK_SVG;
        el.appendChild(iconWrap);

        // 把目前語言的 iconTooltip 文字填進 SVG 內建的 <title> 子元素
        // (textContent，不是 innerHTML)，讓滑鼠停留在 icon 上時瀏覽器彈
        // 出跟原生互動列按鈕一樣的系統 tooltip。iconWrap.innerHTML 每次
        // 换圖示(LINK_SVG/CHECK_SVG 互換)都要重新呼叫一次，因為 <title>
        // 節點會跟著整個 innerHTML 一起被換掉。
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
        // 用原生 <title>，但原生 title 在 hover 中途不會即時刷新內容，
        // 只有這顆自繪氣泡能保證「點擊當下」立刻給使用者回饋。
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

        // 語言切換時(storage.onChanged)同步既有 icon 的 aria-label、SVG
        // <title> 與 tooltip 文字；aria-label／title 這種靜態常駐文案任
        // 何時候都可以立即刷新，但若正處於「已複製」的暫時狀態就不打斷
        // 自繪氣泡，等它自己復原後自然會用上新語言(resetTimer 內的 t()
        // 每次都即時查字典)。
        el._tclApplyLocale = function () {
          el.setAttribute('aria-label', t('iconTooltip'));
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

          var container = el.closest ? el.closest('[data-pressable-container]') : null;
          if (!container) {
            console.warn('[threads-clean-link] 找不到貼文容器，略過複製');
            return;
          }

          var anchors = container.querySelectorAll('a[href*="/post/"]');
          var hrefs = [];
          for (var i = 0; i < anchors.length; i++) {
            hrefs.push(anchors[i].getAttribute('href'));
          }

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
              })
              .catch(function (err) {
                console.warn('[threads-clean-link] 寫入剪貼簿失敗', err);
              });
          } catch (err) {
            console.warn('[threads-clean-link] 寫入剪貼簿時發生例外', err);
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
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TCLPostIcon = api;
  }
})(typeof window !== 'undefined' ? window : this);
