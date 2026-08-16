// post-icon.js — 在 Threads 貼文互動列(讚/回覆/轉發/分享那一排)注入一顆
// 「複製連結」icon，點擊後把貼文的乾淨網址(去 query/hash)寫入剪貼簿。
// ISOLATED world content script，比照 bridge.js 的 ES5 IIFE 風格。
//
// 純函式 pickPermalink / buildPostUrl / hasExistingIcon 供 Node 測試以
// require() 直接載入使用；模組頂層任何碰 document / MutationObserver 的
// DOM 注入邏輯一律用 `typeof document !== 'undefined'` 守衛包住，讓 Node
// 環境(無 document 全域)require() 時不丟例外、不產生副作用。
(function (root) {
  'use strict';

  // ============================================================
  // 純函式區(守衛外，Node 測試與瀏覽器共用)
  // ============================================================

  // 從貼文容器內收集到的候選 href(a[href*="/post/"])中挑出「貼文本體」
  // 的連結：排除以 /media 結尾者(那是圖片/影片檢視器連結，不是貼文本身)，
  // 取過濾後、依原陣列順序的第一個。全被排除、空陣列、非陣列輸入一律回
  // 傳 null，不丟例外。
  function pickPermalink(hrefs) {
    if (!Array.isArray(hrefs)) return null;
    for (var i = 0; i < hrefs.length; i++) {
      var href = hrefs[i];
      if (typeof href === 'string' && !/\/media$/.test(href)) {
        return href;
      }
    }
    return null;
  }

  // 以 href 為相對路徑、origin 為基底組出絕對 URL，並去除 query(?...)與
  // hash(#...)。href 非字串、origin 非合法絕對來源、或組不出合法 URL 等
  // 任何非法輸入一律回傳 null，不丟例外(URL 建構子的例外在這裡吞掉)。
  function buildPostUrl(href, origin) {
    if (typeof href !== 'string') return null;
    try {
      var url = new URL(href, origin);
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
      var SVG_WRAP_CLASS = 'tcl-copy-icon-svg';
      var COPIED_RESET_MS = 1500;
      var SCAN_DEBOUNCE_MS = 60;

      // 鏈結(link)圖示與勾勾(check)圖示：20px、stroke=currentColor、
      // fill=none，顏色繼承原生按鈕的灰(不自己指定顏色)。
      var LINK_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M9 17H7a5 5 0 0 1 0-10h2"/>' +
        '<path d="M15 7h2a5 5 0 1 1 0 10h-2"/>' +
        '<line x1="8" y1="12" x2="16" y2="12"/>' +
        '</svg>';
      var CHECK_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M20 6 9 17l-5-5"/>' +
        '</svg>';

      // 目前使用的語言，載入時由 chrome.storage.sync 的 langPref 解析；
      // storage.onChanged 觸發時即時更新既有 icon 的文案。
      var currentLocale = 'en';

      function t(key) {
        try {
          return root.TCLI18N.t(currentLocale, key);
        } catch (e) {
          return key;
        }
      }

      // ---- 樣式注入:hover 圓底高亮 + tooltip，標 id 防重複注入 ----
      function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '.' + ICON_CLASS + '{position:relative;display:inline-flex;align-items:center;',
          'justify-content:center;width:36px;height:36px;border-radius:9999px;cursor:pointer;',
          'color:inherit;background-color:transparent;transition:background-color .15s ease;}',
          '.' + ICON_CLASS + ':focus-visible{outline:2px solid currentColor;outline-offset:1px;}',
          '@media (prefers-color-scheme: dark){.' + ICON_CLASS + ':hover{background-color:rgba(255,255,255,0.1);}}',
          '@media (prefers-color-scheme: light){.' + ICON_CLASS + ':hover{background-color:rgba(0,0,0,0.05);}}',
          '.' + ICON_CLASS + ' .' + SVG_WRAP_CLASS + '{display:inline-flex;pointer-events:none;}',
          '.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '{position:absolute;top:calc(100% + 6px);left:50%;',
          'transform:translateX(-50%);padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.4;',
          'white-space:nowrap;background:#1c1c1c;color:#fff;opacity:0;pointer-events:none;',
          'transition:opacity .12s ease;z-index:1000;}',
          '@media (prefers-color-scheme: light){.' + ICON_CLASS + ' .' + TOOLTIP_CLASS + '{background:#e5e5e5;color:#050505;}}',
          // 停留約 300ms 後才浮出，離開立即用預設的無延遲 transition 淡出。
          '.' + ICON_CLASS + ':hover .' + TOOLTIP_CLASS + '{opacity:1;transition-delay:.3s;}',
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

        var tooltip = document.createElement('span');
        tooltip.className = TOOLTIP_CLASS;
        tooltip.textContent = t('iconTooltip');
        el.appendChild(tooltip);

        var resetTimer = null;

        function showCopiedFeedback() {
          iconWrap.innerHTML = CHECK_SVG;
          tooltip.textContent = t('iconCopied');
          if (resetTimer) clearTimeout(resetTimer);
          resetTimer = setTimeout(function () {
            resetTimer = null;
            iconWrap.innerHTML = LINK_SVG;
            tooltip.textContent = t('iconTooltip');
          }, COPIED_RESET_MS);
        }

        // 語言切換時(storage.onChanged)同步既有 icon 的 aria-label 與
        // tooltip 文字；若正處於「已複製」的暫時狀態就不打斷，等它自己
        // 復原後自然會用上新語言(resetTimer 內的 t() 每次都即時查字典)。
        el._tclApplyLocale = function () {
          el.setAttribute('aria-label', t('iconTooltip'));
          if (!resetTimer) {
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

      // ---- 找互動列:容器內某個 display:flex 的 div，直屬子元素 >=4 個，
      // 每個子元素內都有 [role="button"] 包著 svg[aria-label]（讚/回覆/
      // 轉發/分享四顆按鈕的 wrapper）----
      function findActionRow(container) {
        var candidates = container.querySelectorAll('div');
        for (var i = 0; i < candidates.length; i++) {
          var row = candidates[i];
          var children = row.children;
          if (!children || children.length < 4) continue;

          var style;
          try {
            style = root.getComputedStyle(row);
          } catch (e) {
            continue;
          }
          if (!style || style.display !== 'flex') continue;

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
          if (allMatch) return row;
        }
        return null;
      }

      // ---- 對單一貼文容器做冪等注入 ----
      function injectIntoContainer(container) {
        if (hasExistingIcon(container)) return;
        var row = findActionRow(container);
        if (!row || hasExistingIcon(row)) return;

        var lastWrapper = row.children[row.children.length - 1];
        if (!lastWrapper) return;

        var icon = createIconElement();
        row.insertBefore(icon, lastWrapper.nextSibling);
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
          return root.TCLI18N.resolveLocale(pref);
        } catch (e) {
          return 'en';
        }
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
        readLangPref(function (langPref) {
          setLocale(resolveLocaleSafe(langPref));
          scanAndInject();
          startObserver();
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
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TCLPostIcon = api;
  }
})(typeof window !== 'undefined' ? window : this);
