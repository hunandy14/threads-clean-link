// options.js — options 頁(設定與淨化紀錄)的邏輯層。比照 popup.js 的模式:
// 可注入 document/storage/i18n 的純函式模組,不直接碰全域 chrome,離線可測;
// options-init.js 負責接上真的 chrome.*(見 options-init.js)。
//
// 純函式(filterEntries/mergeImportedEntries/buildExportPayload/aggregateStats)
// 獨立匯出,測試直接打;DOM 佈線集中在 createOptionsController。
(function (root) {
  'use strict';

  // 共用核心 lib(網址正規化、欄位消毒、常數):擴充頁面環境靠 options.html 的
  // <script src="tcl-core.js"> 先載入(全域 root.TCLCore);Node 測試則 require。
  // sanitize 各函式、長度上限、貼文網址正規化與預設值一律走 TCLCore，不在本檔
  // 養鏡像——background 寫入側與 options 讀取側共用單一權威，任一處漂移就分裂。
  var TCLCore =
    typeof module !== 'undefined' && module.exports ? require('./tcl-core.js') : root.TCLCore;

  // 三顆開關的預設值取自 TCLCore.DEFAULT_SETTINGS(全量三鍵的單一權威),options
  // 頁三顆全收(autoClean/saveHistory/postCopyEnabled)。
  var OPTIONS_DEFAULT_SETTINGS = {
    autoClean: TCLCore.DEFAULT_SETTINGS.autoClean,
    saveHistory: TCLCore.DEFAULT_SETTINGS.saveHistory,
    postCopyEnabled: TCLCore.DEFAULT_SETTINGS.postCopyEnabled,
  };
  var SETTING_IDS = ['autoClean', 'saveHistory', 'postCopyEnabled'];

  var HISTORY_KEY = 'history';
  var DAY_MS = 86400000;
  var PAGE_SIZE_DEFAULT = 20;

  // 貼文網址驗證/正規化走 TCLCore.normalizePostUrl(容尾正規化:白名單字元類 +
  // 長度上限,容忍尾隨斜線/查詢字串/hash,回傳正規化後的乾淨網址或 null)。
  // 長度上限與字元類與 background 寫入側共用同一份,漂移風險已由 TCLCore 收斂。

  // badge 渲染(buildEntryCard/openEntryDetail/buildTimelineRow)只用 .key
  // 查 i18n 文案,純文字 pill,KINDS 不需要 icon 欄位。KINDS 是 UI 關注點(kind→
  // i18n 顯示 key 的映射),留在 options;seen[].kind 白名單改用 TCLCore.KIND_LIST
  // (兩者鍵集合一致:share/strip/menu/icon)。
  var KINDS = {
    share: { key: 'opKindShare' },
    strip: { key: 'opKindStrip' },
    menu: { key: 'opKindMenu' },
    // 貼文互動列複製 icon(post-icon.js)寫入剪貼簿成功後的路徑。
    icon: { key: 'opKindIcon' },
  };

  // ---- 純函式 ----

  // sanitize 各函式(文字截斷、seen[]、original、removedParams)一律走 TCLCore
  // (見 tcl-core.js):讀取(sanitizeEntries)與匯入(mergeImportedEntries)都是
  // 獨立信任邊界,縱深防禦不依賴寫入端沒漏——與 background 寫入側共用同一份
  // 邏輯。original 白名單/控制字元剝除在讀取/匯入時一併追溯生效:既有庫存含
  // bidi/不合白名單 original 的欄位，讀取時做欄位級剝除/丟棄，整筆保留。

  // 從 storage 讀出的清單防禦性整形:非陣列→空;逐筆丟掉核心欄位形狀不對的
  // 項目——url 除了型別是字串，還要通過 TCLCore.normalizePostUrl 的形狀驗證才
  // 收。渲染層 buildEntryCard 的 openLink.href = e.url、剪貼簿複製都是 url
  // sink，不該仰賴「寫入端永遠沒漏」這個假設，讀取階段就該把形狀不對的
  // url 整筆擋掉。選填欄位(author/handle/excerpt)型別不是字串就整欄
  // 丟棄、字串則截斷至長度上限，entry 本身仍保留(與核心欄位的「整筆
  // 丟棄」規則不同，見下方 map)。
  function sanitizeEntries(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function (e) {
        return (
          e &&
          typeof e.url === 'string' &&
          TCLCore.normalizePostUrl(e.url) !== null &&
          typeof e.at === 'number' &&
          isFinite(e.at) &&
          Object.prototype.hasOwnProperty.call(KINDS, e.kind)
        );
      })
      .map(function (e) {
        var out = { url: e.url, kind: e.kind, at: e.at };
        var author = TCLCore.sanitizeText(e.author, TCLCore.LIMITS.AUTHOR_MAX);
        if (author !== undefined) out.author = author;
        var handle = TCLCore.sanitizeText(e.handle, TCLCore.LIMITS.AUTHOR_MAX);
        if (handle !== undefined) out.handle = handle;
        var excerpt = TCLCore.sanitizeText(e.excerpt, TCLCore.LIMITS.EXCERPT_MAX);
        if (excerpt !== undefined) out.excerpt = excerpt;
        // seen[] 比照 author/handle/excerpt 的「缺席不落空值」慣例。這一行
        // 同時承擔驗證與保留兩職——少了它，即使 storage 真的有 seen，渲染
        // 端也永遠讀不到，詳細視窗的「時間軸」鈕會變成永遠打不開的死功能。
        var seenList = TCLCore.sanitizeSeenList(e.seen);
        if (seenList.length > 0) out.seen = seenList;
        // original/removedParams 比照同一套「缺席不落空值」慣例。original
        // 的相同判斷用這筆條目自己的 url(out.url，此時已通過形狀驗證)。
        var original = TCLCore.sanitizeOriginal(e.original, out.url);
        if (original !== undefined) out.original = original;
        var removedParams = TCLCore.sanitizeRemovedParams(e.removedParams);
        if (removedParams !== undefined) out.removedParams = removedParams;
        return out;
      });
  }

  // kind 過濾('all' 不過濾)+ 關鍵字過濾(比對整條網址,不分大小寫)。
  function filterEntries(entries, kind, query) {
    var q = String(query || '').trim().toLowerCase();
    return entries.filter(function (e) {
      if (kind !== 'all' && e.kind !== kind) return false;
      if (!q) return true;
      return e.url.toLowerCase().indexOf(q) !== -1;
    });
  }

  // 匯出 entries 含所有選填欄位(author/handle/excerpt/seen/original/
  // removedParams)，沿用「非字串/缺席就整欄不寫」的慣例;漏掉任一欄，
  // 使用者換裝置/瀏覽器匯入回來時該欄資料會無聲消失。值直接沿用 entry
  // 已經 sanitize 過的形狀，不必在這裡重新驗證。
  function buildExportPayload(entries, exportedAt) {
    return {
      app: 'threads-clean-link',
      version: 1,
      exportedAt: exportedAt,
      entries: entries.map(function (e) {
        var out = { url: e.url, kind: e.kind, at: e.at };
        if (typeof e.author === 'string') out.author = e.author;
        if (typeof e.handle === 'string') out.handle = e.handle;
        if (typeof e.excerpt === 'string') out.excerpt = e.excerpt;
        if (Array.isArray(e.seen) && e.seen.length > 0) out.seen = e.seen;
        if (typeof e.original === 'string') out.original = e.original;
        if (Array.isArray(e.removedParams) && e.removedParams.length > 0) out.removedParams = e.removedParams;
        return out;
      }),
    };
  }

  // 解析匯入文字:回傳 { ok:true, entries } 或 { ok:false, error }。
  // error 為 i18n key 尾段:'badJson' | 'noEntries'。
  function parseImportText(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'badJson' };
    }
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { ok: false, error: 'noEntries' };
    }
    return { ok: true, entries: parsed.entries };
  }

  // 匯入合併:url 過 TCLCore.normalizePostUrl 白名單並正規化(容忍尾隨斜線/
  // query/hash)、以正規化後的 url 與現有去重;kind 非白名單→'share',at 非有限
  // 數字→now;author/handle/excerpt 逐條 sanitize(型別+截斷，規則同
  // sanitizeEntries)。合併後新到舊排序，結果不裁切(紀錄不設上限，匯入
  // 多少留多少)。
  function mergeImportedEntries(existing, imported, now) {
    var seen = {};
    existing.forEach(function (e) {
      seen[e.url] = true;
    });
    var merged = existing.slice();
    var added = 0;
    var skipped = 0;
    imported.forEach(function (raw) {
      var rawUrl = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
      var url = TCLCore.normalizePostUrl(rawUrl);
      if (url === null || seen[url]) {
        skipped++;
        return;
      }
      seen[url] = true;
      var entry = {
        url: url,
        kind: raw && Object.prototype.hasOwnProperty.call(KINDS, raw.kind) ? raw.kind : 'share',
        at: raw && typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : now,
      };
      var author = TCLCore.sanitizeText(raw && raw.author, TCLCore.LIMITS.AUTHOR_MAX);
      if (author !== undefined) entry.author = author;
      var handle = TCLCore.sanitizeText(raw && raw.handle, TCLCore.LIMITS.AUTHOR_MAX);
      if (handle !== undefined) entry.handle = handle;
      var excerpt = TCLCore.sanitizeText(raw && raw.excerpt, TCLCore.LIMITS.EXCERPT_MAX);
      if (excerpt !== undefined) entry.excerpt = excerpt;
      // 匯入檔的 seen[]/original/removedParams 皆屬外部輸入，同樣要逐筆
      // sanitize，防止偽造/損毀資料混進來。original 的相同判斷用正規化
      // 後的 url，不是匯入檔裡未正規化的原始 url 字串。
      var seenList = TCLCore.sanitizeSeenList(raw && raw.seen);
      if (seenList.length > 0) entry.seen = seenList;
      var original = TCLCore.sanitizeOriginal(raw && raw.original, url);
      if (original !== undefined) entry.original = original;
      var removedParams = TCLCore.sanitizeRemovedParams(raw && raw.removedParams);
      if (removedParams !== undefined) entry.removedParams = removedParams;
      merged.push(entry);
      added++;
    });
    merged.sort(function (a, b) {
      return b.at - a.at;
    });
    return { merged: merged, added: added, skipped: skipped };
  }

  // 帶預覽卡的判定式:與手機版 history-card.tsx 的 hasPreview 邏輯對齊
  // (author 或 excerpt 任一存在即算有預覽);純邏輯獨立成函式方便直接測，
  // 也供 buildEntryCard 判斷要渲染預覽區塊還是降級網址列。
  function hasCardPreview(entry) {
    return (
      (typeof entry.author === 'string' && entry.author !== '') ||
      (typeof entry.excerpt === 'string' && entry.excerpt !== '')
    );
  }

  // 卡片詳細視窗長文判定，與手機版 history-detail-dialog.tsx 的
  // isLongExcerpt 對齊(EXCERPT_DIALOG_LINES=15):行數或字元量任一超標就
  // 顯示「展開全文」。字元量門檻沿用手機版估算(每行約 22 字，15*22=330)。
  var EXCERPT_DIALOG_LINES = 15;
  function isLongExcerpt(excerpt) {
    if (typeof excerpt !== 'string' || excerpt === '') return false;
    var lines = excerpt.split('\n').length;
    return lines > EXCERPT_DIALOG_LINES || Array.from(excerpt).length > EXCERPT_DIALOG_LINES * 22;
  }

  // 對齊手機版:摘要內的 http(s) 連結渲染成可點的 <a>。摘要是頁面來源的
  // 不可信文字，這裡只做純 DOM 組裝(textContent + createElement)，href 由
  // 正則保證以 http(s):// 開頭，javascript: 等協定進不來;含省略號「…」的
  // 是 Threads 顯示層截斷的殘缺網址，維持純文字不做成連結。
  function renderExcerptWithLinks(doc, el, text) {
    // doc 由呼叫端傳入(controller 的注入 document),不碰全域。
    if (typeof text !== 'string' || text === '' || !/https?:\/\//.test(text)) {
      // 快速路徑:沒有連結的內文(多數情況)直接整段賦值。
      el.textContent = typeof text === 'string' ? text : '';
      return;
    }
    el.textContent = '';
    var parts = text.split(/(https?:\/\/[^\s]+)/);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '') continue;
      if (i % 2 === 1 && part.indexOf('…') === -1) {
        // 尾端黏著的標點不算連結本體，切回文字段
        var m = part.match(/[),.;:!?、。」』]+$/);
        var url = m ? part.slice(0, part.length - m[0].length) : part;
        var a = doc.createElement('a');
        a.className = 'excerpt-link';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = url;
        el.appendChild(a);
        if (m) el.appendChild(doc.createTextNode(m[0]));
      } else {
        el.appendChild(doc.createTextNode(part));
      }
    }
  }

  // 對齊手機版 lib/format-display-url.ts，把完整網址轉成適合顯示的精簡
  // 路徑(去 scheme + 網域，只留 path+query+hash，去掉開頭斜線)。用於
  // 詳細視窗的「淨化後連結」與「原始連結」兩列的顯示值(複製仍用完整
  // 原始網址，只影響顯示)。解析失敗 fail-open 回傳原字串。
  function formatDisplayUrl(url) {
    if (typeof url !== 'string') return '';
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return url;
    }
    var path = parsed.pathname + parsed.search + parsed.hash;
    var trimmed = path.replace(/^\/+/, '');
    return trimmed || url;
  }

  // 對齊手機版 CopyRow 的「原始連結」「追蹤參數 {name}」兩類列。
  // removedParams 元素的欄位名是 { key, value }(手機版 link-cleaner.ts:171
  // 與 background.js 的 sanitizeRemovedParams 皆同);回傳物件用 name 是
  // 顯示層/i18n 樣板插值命名(見下面 tf('opTrackingParamLabel', { name:
  // row.name })那行)，跟資料層的 key 是兩回事，不要混淆。entry.original
  // 缺席/非字串/與 cleaned 相同、entry.removedParams 缺席/非陣列/項目
  // 缺 key 或 value 皆不產生該列，逐筆容錯不因單筆壞掉波及整組。
  function buildDetailExtraRows(entry) {
    var rows = [];
    if (!entry) return rows;
    if (typeof entry.original === 'string' && entry.original !== '' && entry.original !== entry.url) {
      rows.push({ type: 'original', display: formatDisplayUrl(entry.original), copyValue: entry.original });
    }
    var params = Array.isArray(entry.removedParams) ? entry.removedParams : [];
    params.forEach(function (p) {
      if (!p || typeof p.key !== 'string' || p.key === '' || typeof p.value !== 'string') return;
      rows.push({ type: 'param', name: p.key, display: p.value, copyValue: p.value });
    });
    return rows;
  }

  // 詳細視窗的「記錄時間」用絕對時間(YYYY-MM-DD HH:mm)，與卡頭的相對時間
  // (relTime)分開顯示，對齊手機版 formatResolvedTime。
  function formatAbsoluteTime(ts) {
    var d = new Date(ts);
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  // 「時間軸」顯示邏輯，對齊手機版 history-detail-dialog.tsx——
  // seen.length > 1 才顯示時間軸(單筆時卡頭的相對時間已經夠用)，新到舊
  // 排序。防禦寫法:entry.seen 缺席、非陣列，或陣列內項目形狀不對(缺
  // at/at 非有限數字)一律當作不存在，回傳 null。來源標籤用既有 KINDS
  // 文案，不是手機版的 share/clipboard 二分。
  function buildSeenTimeline(entry) {
    var seen = entry && Array.isArray(entry.seen) ? entry.seen : [];
    var valid = seen.filter(function (r) {
      return r && typeof r.at === 'number' && isFinite(r.at);
    });
    if (valid.length <= 1) return null;
    return valid.slice().sort(function (a, b) {
      return b.at - a.at;
    });
  }

  // 統計聚合:總數、各來源數、本週/上週(滾動 7 天)、近 14 天逐「日曆日」
  // 次數(索引 13 = 今天)、最舊一筆時間戳。counts 算了 share/strip/menu/
  // icon 四個 kind，但統計磚版面(options.html 的 .stats)只給短碼解析/
  // 剪除參數/貼文按鈕三個各開一格——menu(右鍵還原)是刻意不佔版面的低頻
  // 手動路徑，counts.menu 仍照算是為了四個 kind 算法一致，不特殊處理。
  function aggregateStats(entries, nowTs) {
    var todayStart = new Date(nowTs);
    todayStart.setHours(0, 0, 0, 0);
    var t0 = todayStart.getTime();

    var days = [];
    for (var i = 0; i < 14; i++) days.push(0);
    var counts = { share: 0, strip: 0, menu: 0, icon: 0 };
    var week = 0;
    var weekPrev = 0;
    var oldestAt = null;

    entries.forEach(function (e) {
      if (counts[e.kind] !== undefined) counts[e.kind]++;
      var daysAgo = e.at >= t0 ? 0 : Math.floor((t0 - e.at) / DAY_MS) + 1;
      var idx = 13 - daysAgo;
      if (idx >= 0 && idx <= 13) days[idx]++;
      if (e.at >= nowTs - 7 * DAY_MS) week++;
      else if (e.at >= nowTs - 14 * DAY_MS) weekPrev++;
      if (oldestAt === null || e.at < oldestAt) oldestAt = e.at;
    });

    return {
      total: entries.length,
      counts: counts,
      week: week,
      weekPrev: weekPrev,
      days: days,
      oldestAt: oldestAt,
    };
  }

  // ---- 控制器 ----

  function createOptionsController(deps) {
    var document = deps.document;
    var syncStorage = deps.syncStorage;
    var localStore = deps.localStorage;
    var i18n = deps.i18n;
    var download = typeof deps.download === 'function' ? deps.download : function () {};
    var now = typeof deps.now === 'function' ? deps.now : function () {
      return Date.now();
    };

    var entries = [];
    var locale = 'zh';
    var langPref = null; // null = 未設定,跟隨瀏覽器
    var themePref = 'auto';
    var activeKind = 'all';
    var query = '';
    var pageSize = PAGE_SIZE_DEFAULT;
    // 目前詳細視窗顯示中的條目(複製/刪除按鈕靠它找到要操作的 entry)。
    var detailEntry = null;
    // 卡片相對時間節點的登錄簿(node + at):60s ticker 的輕量刷新只逐一
    // 改 textContent，不重建整面卡片，才不會偷走鍵盤焦點/文字選取(見
    // refresh)。renderList 每次重建卡片時重置。
    var timeNodes = [];
    // 對話框開啟前的 activeElement，關閉時還原焦點(a11y，見 rememberFocus/
    // restoreFocus)。以對話框 key 分槽，巢狀(詳細→時間軸/刪除確認)各記各的。
    var overlayPrevFocus = {};
    // 確認框(confirmOverlay)當前掛的動作:清除全部 / 刪除這筆共用同一個
    // modal，confirmOk 點擊時執行這顆(見 openConfirm/closeConfirm)。
    var confirmAction = null;

    // 注意:此模組內不得宣告名為 t 的區域變數，以免遮蔽翻譯函式。
    function tt(key) {
      return i18n.t(locale, key);
    }
    function tf(key, vars) {
      return i18n.fmt(locale, key, vars);
    }

    function byId(id) {
      return document.getElementById(id);
    }

    var NS = 'http://www.w3.org/2000/svg';

    function svgUse(href, cls) {
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', cls || 'icon');
      var use = document.createElementNS(NS, 'use');
      use.setAttribute('href', href);
      svg.appendChild(use);
      return svg;
    }

    function svgEl(tag, attrs) {
      var node = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
      return node;
    }

    // ---- toast ----
    var toastTimer = null;
    function toast(msg) {
      var el = byId('toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        el.classList.remove('show');
      }, 2200);
    }

    // ---- i18n 套用 ----
    function applyI18nDom() {
      if (typeof document.querySelectorAll !== 'function') return;
      document.querySelectorAll('[data-i18n]').forEach(function (node) {
        node.textContent = tt(node.getAttribute('data-i18n'));
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(function (node) {
        node.setAttribute('placeholder', tt(node.getAttribute('data-i18n-ph')));
      });
      document.querySelectorAll('[data-i18n-title]').forEach(function (node) {
        node.setAttribute('title', tt(node.getAttribute('data-i18n-title')));
      });
      // aria-label i18n 通道:兩顆關閉鈕與統計磚區塊的 aria-label 掛
      // data-i18n-aria，語言切換時一併更新，不卡在單一語言。
      document.querySelectorAll('[data-i18n-aria]').forEach(function (node) {
        node.setAttribute('aria-label', tt(node.getAttribute('data-i18n-aria')));
      });
      if (document.documentElement) {
        document.documentElement.lang = locale === 'zh' ? 'zh-Hant' : 'en';
      }
      var langBtn = byId('langBtn');
      if (langBtn) langBtn.textContent = locale === 'zh' ? '中文' : 'EN';
    }

    // ---- 主題 ----
    var THEME_ORDER = ['auto', 'light', 'dark'];
    var THEME_ICONS = { auto: '#i-monitor', light: '#i-sun', dark: '#i-moon' };

    function applyTheme() {
      if (document.documentElement) {
        if (themePref === 'auto') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = themePref;
      }
      var icon = byId('themeIcon');
      if (icon) icon.setAttribute('href', THEME_ICONS[themePref] || THEME_ICONS.auto);
    }

    // ---- 相對時間 ----
    function relTime(ts) {
      var diff = Math.max(0, now() - ts);
      var m = Math.floor(diff / 60000);
      if (m < 1) return tt('opRelJust');
      if (m < 60) return tf('opRelMin', { n: m });
      var h = Math.floor(m / 60);
      if (h < 24) return tf('opRelHour', { n: h });
      var d = Math.floor(h / 24);
      if (d === 1) return tt('opRelYesterday');
      return tf('opRelDays', { n: d });
    }

    function formatYearMonth(ts) {
      var dt = new Date(ts);
      var month = dt.getMonth() + 1;
      return dt.getFullYear() + '/' + (month < 10 ? '0' + month : month);
    }

    // ---- 統計磚 ----
    function renderStats() {
      var stats = aggregateStats(entries, now());
      var setText = function (id, text) {
        var el = byId(id);
        if (el) el.textContent = text;
      };

      setText('statTotal', String(stats.total));
      setText('statTotalMeta', stats.oldestAt !== null ? tf('opSince', { d: formatYearMonth(stats.oldestAt) }) : '');
      setText('statWeek', String(stats.week));

      var weekMeta = byId('statWeekMeta');
      if (weekMeta) {
        weekMeta.textContent = '';
        if (stats.weekPrev > 0) {
          var delta = Math.round(((stats.week - stats.weekPrev) / stats.weekPrev) * 100);
          var deltaEl = document.createElement('span');
          if (delta >= 0) deltaEl.className = 'delta-up';
          deltaEl.textContent = (delta >= 0 ? '▲ ' : '▼ ') + Math.abs(delta) + '%';
          weekMeta.appendChild(deltaEl);
          weekMeta.appendChild(document.createTextNode(' ' + tt('opVsLastWeek')));
        }
      }

      var pct = function (n) {
        return stats.total > 0 ? Math.round((n / stats.total) * 100) : 0;
      };
      setText('statShare', String(stats.counts.share));
      setText('statShareMeta', stats.total > 0 ? tf('opShareOfTotal', { p: pct(stats.counts.share) }) : '');
      setText('statStrip', String(stats.counts.strip));
      setText('statStripMeta', stats.total > 0 ? tf('opShareOfTotal', { p: pct(stats.counts.strip) }) : '');
      setText('statIcon', String(stats.counts.icon));
      setText('statIconMeta', stats.total > 0 ? tf('opShareOfTotal', { p: pct(stats.counts.icon) }) : '');

      return stats;
    }

    // ---- 長條圖 ----
    var chartCounts = [];
    var chartLabels = [];

    function renderChart(stats) {
      var chart = byId('chart');
      if (!chart) return;
      chart.textContent = '';

      chartCounts = stats.days;
      chartLabels = [];
      var nowTs = now();
      for (var d = 13; d >= 0; d--) {
        var dt = new Date(nowTs - d * DAY_MS);
        chartLabels.push(dt.getMonth() + 1 + '/' + dt.getDate());
      }

      var W = 560;
      var H = 230;
      var padL = 24;
      var padR = 8;
      var padT = 16;
      var padB = 24;
      var plotW = W - padL - padR;
      var plotH = H - padT - padB;
      // 無資料時 maxV 取 1,基線與格線仍可畫,不做除以零。
      var maxV = Math.max(1, Math.max.apply(null, chartCounts));
      var band = plotW / chartCounts.length;
      var barW = Math.min(24, band - 14);

      function y(v) {
        return padT + plotH * (1 - v / maxV);
      }

      [0, maxV].forEach(function (v) {
        chart.appendChild(
          svgEl('line', {
            x1: padL,
            x2: W - padR,
            y1: y(v),
            y2: y(v),
            class: v === 0 ? 'baseline' : 'gridline',
          })
        );
        var tickEl = svgEl('text', {
          x: padL - 6,
          y: y(v) + 3,
          'text-anchor': 'end',
          class: 'axis-text',
        });
        tickEl.textContent = String(v);
        chart.appendChild(tickEl);
      });

      var maxIdx = chartCounts.indexOf(Math.max.apply(null, chartCounts));

      chartCounts.forEach(function (v, i) {
        var cx = padL + band * i + band / 2;
        var x0 = cx - barW / 2;
        var h = plotH * (v / maxV);
        var top = y(v);
        var r = Math.min(4, h);

        // 命中帶:整欄高度,比 mark 本身大,滑鼠好命中。
        chart.appendChild(
          svgEl('rect', {
            x: padL + band * i,
            y: padT,
            width: band,
            height: plotH,
            class: 'bar-band',
            'data-i': i,
          })
        );

        if (v > 0) {
          // 頂端 4px 圓角、基線端方角。
          var dPath =
            'M' + x0 + ',' + (padT + plotH) +
            ' V' + (top + r) +
            ' Q' + x0 + ',' + top + ' ' + (x0 + r) + ',' + top +
            ' H' + (x0 + barW - r) +
            ' Q' + (x0 + barW) + ',' + top + ' ' + (x0 + barW) + ',' + (top + r) +
            ' V' + (padT + plotH) + ' Z';
          var bar = svgEl('path', { d: dPath, class: 'bar', 'data-bar': i });
          bar.style.pointerEvents = 'none';
          chart.appendChild(bar);
        }

        // 選擇性直接標示:只標最大值與今天(值為 0 不標)。
        if ((i === maxIdx || i === chartCounts.length - 1) && v > 0) {
          var lbl = svgEl('text', {
            x: cx,
            y: top - 5,
            'text-anchor': 'middle',
            class: 'bar-label',
          });
          lbl.textContent = String(v);
          chart.appendChild(lbl);
        }
        // X 軸:首、中、今天三個刻度。
        if (i === 0 || i === 7 || i === chartCounts.length - 1) {
          var isToday = i === chartCounts.length - 1;
          var xt = svgEl('text', {
            x: cx,
            y: H - 8,
            'text-anchor': 'middle',
            class: 'axis-text',
          });
          xt.textContent = isToday ? tt('opToday') : chartLabels[i];
          chart.appendChild(xt);
        }
      });
    }

    function hideChartTip() {
      var tip = byId('chartTip');
      var chart = byId('chart');
      if (tip) tip.classList.remove('show');
      if (chart && typeof chart.querySelectorAll === 'function') {
        chart.querySelectorAll('.bar.hot').forEach(function (b) {
          b.classList.remove('hot');
        });
      }
    }

    function bindChartTooltip() {
      var chart = byId('chart');
      var tip = byId('chartTip');
      var wrap = byId('chartWrap');
      if (!chart || !tip || !wrap || typeof chart.addEventListener !== 'function') return;

      chart.addEventListener('mousemove', function (ev) {
        var target = ev.target;
        if (!target || !target.classList || !target.classList.contains('bar-band')) {
          hideChartTip();
          return;
        }
        var i = Number(target.getAttribute('data-i'));
        var rect = target.getBoundingClientRect();
        var wrapRect = wrap.getBoundingClientRect();
        tip.textContent = chartLabels[i] + ' · ' + tf('opTimes', { n: chartCounts[i] });
        tip.style.left = rect.left - wrapRect.left + rect.width / 2 + 'px';
        tip.style.top = rect.top - wrapRect.top + 6 + 'px';
        tip.classList.add('show');
        if (typeof chart.querySelectorAll === 'function') {
          chart.querySelectorAll('.bar').forEach(function (b) {
            b.classList.toggle('hot', Number(b.getAttribute('data-bar')) === i);
          });
        }
      });
      chart.addEventListener('mouseleave', hideChartTip);
    }

    // ---- 紀錄清單 ----

    // 配額超限判斷，沿用 background 寫入側的字串比對(見 background.js 的
    // isQuotaExceededError):Chrome 對總量(QUOTA_BYTES)與單筆
    // (QUOTA_BYTES_PER_ITEM)超限，都以開頭含 "QUOTA_BYTES" 的訊息 reject。
    // 用字串比對而非錯誤類別，避免瀏覽器/版本差異誤判漏接。
    function isQuotaExceededError(err) {
      var message = (err && err.message) || String(err || '');
      return /QUOTA_BYTES/i.test(message);
    }

    // 回傳 Promise 給呼叫端(成功/失敗都 resolve，不 reject):寫入前先記住
    // 現值，失敗(常見:storage.local 配額寫爆)時把記憶體 entries 回滾成
    // 寫入前的值，避免磁碟寫失敗、記憶體卻已經前進造成分岔。呼叫端據
    // res.ok 決定發成功/失敗 toast，res.quota 供挑配額/一般兩種失敗文案。
    function persistHistory(list) {
      var prev = entries;
      entries = list;
      return Promise.resolve()
        .then(function () {
          return localStore.set({ [HISTORY_KEY]: list });
        })
        .then(function () {
          return { ok: true };
        })
        .catch(function (err) {
          entries = prev;
          if (typeof console !== 'undefined') console.error('[threads-clean-link] 寫入紀錄失敗', err);
          return { ok: false, quota: isQuotaExceededError(err) };
        });
    }

    // persistHistory 失敗的統一善後:回滾已在 persistHistory 內完成，這裡
    // 重繪回滾後的畫面並發專屬失敗 toast(配額/一般兩種文案)。
    function onPersistFailed(res) {
      renderAll();
      toast(tt(res && res.quota ? 'opToastStorageFull' : 'opToastSaveFailed'));
    }

    // ---- 對話框焦點管理(a11y) ----
    // 開啟前記住目前焦點，關閉時還原;把焦點移進對話框(關閉鈕或指定的
    // 首個可聚焦元素)。DOM stub 沒有 activeElement/focus，全程 typeof 守
    // 衛，測不到的部分由人工/CDP 驗證。
    function rememberFocus(key) {
      overlayPrevFocus[key] = (document && document.activeElement) || null;
    }
    function restoreFocus(key) {
      var prev = overlayPrevFocus[key];
      overlayPrevFocus[key] = null;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (e) {}
      }
    }
    function focusInto(overlayId, focusId) {
      var el = (focusId && byId(focusId)) || byId(overlayId);
      if (el && typeof el.focus === 'function') {
        try { el.focus(); } catch (e) {}
      }
    }

    // Tab focus trap:把 Tab/Shift+Tab 的焦點循環鎖在對話框內。真實 DOM
    // 靠 querySelectorAll 取可聚焦元素;DOM stub 回空陣列時整段 no-op。
    var FOCUSABLE_SEL = 'a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]';
    function trapTabInOverlay(overlayId, ev) {
      var overlay = byId(overlayId);
      if (!overlay || overlay.hidden || typeof overlay.querySelectorAll !== 'function') return;
      var nodes = overlay.querySelectorAll(FOCUSABLE_SEL);
      var focusables = [];
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i].hidden) focusables.push(nodes[i]);
      }
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var active = document.activeElement;
      var inside = typeof overlay.contains === 'function' ? overlay.contains(active) : true;
      if (ev.shiftKey) {
        if (!inside || active === first) {
          ev.preventDefault();
          if (typeof last.focus === 'function') last.focus();
        }
      } else if (!inside || active === last) {
        ev.preventDefault();
        if (typeof first.focus === 'function') first.focus();
      }
    }
    // 目前疊在最上層、開著的對話框(決定 Tab trap 的作用範圍):時間軸與
    // 刪除確認會疊在詳細視窗之上，匯入是獨立頂層框，優先序由上而下。
    function topmostOverlayId() {
      var order = ['timelineOverlay', 'confirmOverlay', 'overlay', 'detailOverlay'];
      for (var i = 0; i < order.length; i++) {
        var el = byId(order[i]);
        if (el && !el.hidden) return order[i];
      }
      return null;
    }

    // ---- 共用確認框(清除全部 / 刪除這筆)----
    // 複用同一個 confirmOverlay:opts.titleKey/okKey 是 i18n key，desc 是已
    // 組好的字串，action 是確認後要跑的函式。標題/確認鈕文案在 JS 端顯式
    // 覆寫(這兩顆有 data-i18n，renderAll 會重設，但確認框開著時不會觸發
    // renderAll，故安全)。
    function openConfirm(opts) {
      var titleText = byId('confirmTitleText');
      if (titleText) titleText.textContent = tt(opts.titleKey);
      var descEl = byId('confirmDesc');
      if (descEl) descEl.textContent = opts.desc;
      var okBtn = byId('confirmOk');
      if (okBtn) okBtn.textContent = tt(opts.okKey);
      confirmAction = typeof opts.action === 'function' ? opts.action : null;
      var confirmOverlay = byId('confirmOverlay');
      if (confirmOverlay) confirmOverlay.hidden = false;
      rememberFocus('confirm');
      // 焦點落在「取消」而非破壞性的確認鈕，避免一個 Enter 就誤刪/誤清。
      focusInto('confirmOverlay', 'confirmCancel');
    }
    function closeConfirm() {
      var confirmOverlay = byId('confirmOverlay');
      if (confirmOverlay) confirmOverlay.hidden = true;
      confirmAction = null;
      restoreFocus('confirm');
    }

    // 網址拆解只為了視覺強調帳號段;一律 textContent/createTextNode,
    // 網址內容源頭是頁面可控管道，禁 innerHTML。紀錄卡片降級顯示(無
    // author/excerpt 時)靠這份拆解邏輯。
    function buildUrlNode(url, cls) {
      var urlEl = document.createElement('div');
      urlEl.className = cls || 'url';
      // TLD(com/net)一併捕獲並如實顯示:網址本來就可能來自 threads.net
      // (POST_URL_PATTERN 同時允許 com 與 net)，不可硬寫死 'threads.com/'。
      var handleMatch = /^https:\/\/(?:www\.)?threads\.(com|net)\/(@[^/]+)\/(.*)$/.exec(url);
      if (handleMatch) {
        urlEl.appendChild(document.createTextNode('threads.' + handleMatch[1] + '/'));
        var handleEl = document.createElement('b');
        handleEl.textContent = handleMatch[2];
        urlEl.appendChild(handleEl);
        urlEl.appendChild(document.createTextNode('/' + handleMatch[3]));
      } else {
        urlEl.textContent = url;
      }
      return urlEl;
    }

    // 複製是卡片高亮態快捷鈕/詳細視窗/original-removedParams 附加列共用的
    // 動作，獨立成通用的「複製任意文字」函式(copyText)，copyEntryUrl 是
    // 針對 entry.url 的特化版本，避免每個呼叫端各自組 try/catch。
    // 「開啟」是原生 <a target=_blank>，不需要 JS 邏輯。
    function copyText(value) {
      var p;
      try {
        p = navigator.clipboard.writeText(value);
      } catch (err) {
        p = Promise.reject(err);
      }
      Promise.resolve(p).then(
        function () {
          toast(tt('opToastCopied'));
        },
        function () {
          toast(tt('opToastCopyFailed'));
        }
      );
    }

    function copyEntryUrl(e) {
      copyText(e.url);
    }

    // 刪除只在詳細視窗做(照手機版 DialogActions 的位置，卡片層級沒有
    // 刪除入口)，且經一道確認框(見 bindDetailDialog 的 detailDeleteBtn →
    // openConfirm)。
    //
    // 以 url+at 精準命中(不只比 url):只比 url 會把「同一貼文在 5 分鐘視窗
    // 外各自獨立成筆」的多筆紀錄一起誤刪。setHistory 已把 detailEntry 換成
    // 清單裡的新物件(見 refreshDetail)，at 不會過期，精準比對成立——刪一筆
    // 只刪中一筆。
    //
    // 沒有真的命中(例如已被別的分頁/storage 同步事件、或「清除全部」先
    // 移除)就不寫入、不動視窗、也不發「已刪除」成功 toast，避免對使用者
    // 謊報一個沒發生的動作。寫入失敗(配額)走 onPersistFailed 回滾+失敗
    // toast，不謊報成功。
    function deleteEntry(e) {
      var hit = false;
      var next = entries.filter(function (x) {
        if (!hit && x.url === e.url && x.at === e.at) {
          hit = true;
          return false;
        }
        return true;
      });
      if (!hit) return;
      if (detailEntry && detailEntry.url === e.url && detailEntry.at === e.at) closeEntryDetail();
      // persistHistory 先同步把 entries 換成 next，再 renderAll 才畫到新清單;
      // 寫入結果非同步回來，成功發「已刪除」，失敗回滾 + 失敗 toast。
      persistHistory(next).then(function (res) {
        if (res.ok) toast(tt('opToastDeleted'));
        else onPersistFailed(res);
      });
      renderAll();
    }

    // 單張紀錄卡片:與手機版 history-card.tsx 逐項對齊——卡頭(kind 徽章 +
    // 相對時間)→ hasCardPreview 為真時顯示作者列(author 粗體 + @handle
    // 灰階，皆存在才顯示 handle)+ excerpt(兩行截斷);否則降級顯示網址。
    // 無縮圖(刻意，og:image 會過期)。互動照手機版的「選中態」:
    // hover/press 時邊框轉主色、右上浮出複製/分享兩顆快捷 icon，web 用
    // :hover 與 :focus-within 模擬(見 options.html 的 .entry-card 註解);
    // 點卡片本身(排除快捷鈕區)開詳細視窗，對齊手機版 onPress。卡片層級
    // 沒有刪除入口。
    function buildEntryCard(e) {
      var card = document.createElement('div');
      card.className = 'entry-card';
      // 鍵盤可聚焦，讓 :focus-within 高亮態也能靠 Tab 觸發(不只滑鼠
      // hover);role="button" + Enter/Space 觸發，補上瀏覽器對原生
      // button/a 才有的鍵盤啟動行為(div 預設沒有)。
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'button');
      // 條目鍵(url|at):整面重建卡片時據此還原鍵盤焦點到同一條目。
      card.dataset.entryKey = e.url + '|' + e.at;

      var header = document.createElement('div');
      header.className = 'entry-header';
      var meta = document.createElement('div');
      meta.className = 'entry-meta';
      var badge = document.createElement('span');
      badge.className = 'entry-badge';
      badge.textContent = tt(KINDS[e.kind].key);
      var headTime = document.createElement('span');
      headTime.className = 'entry-time';
      headTime.textContent = relTime(e.at);
      // 掛 data-at 並登錄到 timeNodes:60s ticker 走輕量刷新(refresh)只逐一
      // 改這些節點的 textContent，不重建卡片，才不會偷走焦點/文字選取。
      headTime.setAttribute('data-at', String(e.at));
      timeNodes.push({ node: headTime, at: e.at });
      meta.appendChild(badge);
      meta.appendChild(headTime);
      header.appendChild(meta);
      card.appendChild(header);

      if (hasCardPreview(e)) {
        var hasAuthor = typeof e.author === 'string' && e.author !== '';
        var hasHandle = typeof e.handle === 'string' && e.handle !== '';
        // author 或 handle 任一存在就顯示作者列——author===handle 時入庫端
        // 會把重複的 author 丟棄(只剩 handle),列不能因此整個消失。
        if (hasAuthor || hasHandle) {
          var authorRow = document.createElement('div');
          authorRow.className = 'entry-author-row';
          if (hasAuthor) {
            var nameEl = document.createElement('span');
            nameEl.className = 'entry-author-name';
            nameEl.textContent = e.author;
            authorRow.appendChild(nameEl);
          }
          if (hasHandle) {
            var handleEl = document.createElement('span');
            handleEl.className = 'entry-handle';
            handleEl.textContent = e.handle;
            authorRow.appendChild(handleEl);
          }
          card.appendChild(authorRow);
        }
        if (typeof e.excerpt === 'string' && e.excerpt !== '') {
          var excerptEl = document.createElement('div');
          excerptEl.className = 'entry-excerpt';
          excerptEl.textContent = e.excerpt;
          card.appendChild(excerptEl);
        }
      } else {
        card.appendChild(buildUrlNode(e.url, 'entry-url'));
      }

      // 高亮態右上浮出的兩顆快捷鈕:複製連結(對應手機 Copy)、開啟貼文
      // (對應手機 Share2——web 沒有原生分享)。注意這跟詳細視窗底部動作列
      // 的「分享→複製」映射是兩件事，不強行統一。平時態靠 CSS
      // display:none 隱藏，兩顆按鈕都要 stopPropagation，否則點下去會被
      // 卡片自己的 click 冒泡到，順手把詳細視窗也開了。
      var quickWrap = document.createElement('div');
      quickWrap.className = 'entry-quick';

      var quickCopyBtn = document.createElement('button');
      quickCopyBtn.type = 'button';
      quickCopyBtn.className = 'entry-quick-btn';
      quickCopyBtn.title = tt('opQuickCopyTitle');
      quickCopyBtn.setAttribute('aria-label', tt('opQuickCopyTitle'));
      quickCopyBtn.appendChild(svgUse('#i-copy'));
      quickCopyBtn.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        copyEntryUrl(e);
      });
      quickWrap.appendChild(quickCopyBtn);

      var quickOpenBtn = document.createElement('a');
      quickOpenBtn.className = 'entry-quick-btn';
      quickOpenBtn.href = e.url;
      quickOpenBtn.target = '_blank';
      quickOpenBtn.rel = 'noopener';
      quickOpenBtn.title = tt('opOpenTitle');
      quickOpenBtn.setAttribute('aria-label', tt('opOpenTitle'));
      quickOpenBtn.appendChild(svgUse('#i-external-link'));
      quickOpenBtn.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        // 開啟交給瀏覽器原生 <a> 行為，這裡只需要擋掉冒泡。
      });
      quickWrap.appendChild(quickOpenBtn);

      card.appendChild(quickWrap);

      // 點卡片本身(排除快捷鈕區)開詳細視窗，對齊手機版 onPress。
      card.addEventListener('click', function (ev) {
        var target = ev && ev.target;
        if (target && target.closest && target.closest('.entry-quick')) return;
        openEntryDetail(e);
      });
      card.addEventListener('keydown', function (ev) {
        if (!ev || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        var target = ev.target;
        if (target && target.closest && target.closest('.entry-quick')) return;
        ev.preventDefault();
        openEntryDetail(e);
      });

      return card;
    }

    // ---- 詳細視窗:結構/間距/字級/圓角/按鈕樣式一律照手機版
    // history-detail-dialog.tsx + dialog-shell.tsx 的字面 token 值 ----
    //
    // 版面:✕ 關閉鈕 → 卡頭(徽章+相對時間)→ 作者列(16px/600 + 14px/500)
    // → excerpt(15 行截斷，對齊 EXCERPT_DIALOG_LINES)+ 超長時「展開全文」
    // → 淨化後連結 kv(accent 強調，值為 formatDisplayUrl 後的正規路徑)
    // → 原始連結/追蹤參數 kv(有資料才畫，見 buildDetailExtraRows)→
    // 記錄時間 kv(seen 有多筆時多一顆「時間軸」鈕，開子層視窗)→ 底部
    // 等寬動作列(複製/開啟/刪除，destructive 只變文字色)。
    //
    // 「展開全文」用原地展開(移除 line-clamp)取代手機版的巢狀第二層
    // Modal——手機版那樣做是為了繞過 RN 在 iOS 不支援兄弟層 Modal 並開的
    // 限制，web 沒有這個問題。「時間軸」則是巢狀子層視窗(timelineOverlay)，
    // 對齊手機版時間軸本來就是巢狀 Modal 的做法。
    // 只更新詳細視窗的「內容」欄位，不碰使用者互動態(時間軸子層開合、
    // excerpt 展開態)——供 openEntryDetail(完整開啟)與 refreshDetail
    // (storage 變動時原地刷新)共用。
    function renderDetailContent(e) {
      var badge = byId('detailBadge');
      if (badge) badge.textContent = tt(KINDS[e.kind].key);
      var timeEl = byId('detailTime');
      if (timeEl) timeEl.textContent = relTime(e.at);

      var authorRow = byId('detailAuthorRow');
      var authorName = byId('detailAuthorName');
      var handleEl = byId('detailHandle');
      var excerptEl = byId('detailExcerpt');
      var expandBtn = byId('detailExpandBtn');
      var urlFallback = byId('detailUrlFallback');

      var hasAuthor = typeof e.author === 'string' && e.author !== '';
      var hasHandle = typeof e.handle === 'string' && e.handle !== '';
      var hasExcerpt = typeof e.excerpt === 'string' && e.excerpt !== '';

      if (hasCardPreview(e)) {
        // 同卡片端:author 被去重丟棄、只剩 handle 時,列仍要顯示。
        if (authorRow) authorRow.hidden = !(hasAuthor || hasHandle);
        if (authorName) authorName.textContent = hasAuthor ? e.author : '';
        if (handleEl) {
          handleEl.hidden = !hasHandle;
          handleEl.textContent = hasHandle ? e.handle : '';
        }
        if (excerptEl) {
          excerptEl.hidden = !hasExcerpt;
          renderExcerptWithLinks(document, excerptEl, hasExcerpt ? e.excerpt : '');
        }
        if (expandBtn) expandBtn.hidden = !(hasExcerpt && isLongExcerpt(e.excerpt));
        if (urlFallback) {
          urlFallback.hidden = true;
          urlFallback.textContent = '';
        }
      } else {
        // 比照上面有預覽分支，四欄都要清空(不是只設 hidden)，否則上一筆
        // 的殘留文字會在 hidden 失效或未來改版時露出，或被螢幕閱讀器讀到。
        if (authorRow) authorRow.hidden = true;
        if (authorName) authorName.textContent = '';
        if (handleEl) {
          handleEl.hidden = true;
          handleEl.textContent = '';
        }
        if (excerptEl) {
          excerptEl.hidden = true;
          excerptEl.textContent = '';
        }
        if (expandBtn) expandBtn.hidden = true;
        if (urlFallback) {
          urlFallback.hidden = false;
          urlFallback.textContent = '';
          urlFallback.appendChild(buildUrlNode(e.url, 'entry-url'));
        }
      }

      // 淨化後連結 kv:值顯示正規路徑(formatDisplayUrl)，不是完整網址;
      // 複製仍用完整原始網址(detailUrlCopyBtn 的 handler 用 e.url)。
      var urlValueEl = byId('detailUrlValue');
      if (urlValueEl) urlValueEl.textContent = formatDisplayUrl(e.url);

      // 原始連結/追蹤參數列:有資料才畫，見 buildDetailExtraRows。
      var extraRowsEl = byId('detailExtraRows');
      if (extraRowsEl) {
        extraRowsEl.textContent = '';
        buildDetailExtraRows(e).forEach(function (row) {
          extraRowsEl.appendChild(buildExtraRowEl(row));
        });
      }

      var recordedTimeEl = byId('detailRecordedTime');
      if (recordedTimeEl) recordedTimeEl.textContent = formatAbsoluteTime(e.at);

      // 時間軸鈕:buildSeenTimeline 對缺席/單筆資料回傳 null 時不顯示，
      // 主畫面的記錄時間(=at)已經夠用。鈕文字固定不隨資料變動(次數改
      // 顯示在子層視窗標題)，仍在 JS 端顯式賦值——最小 DOM stub 的
      // querySelectorAll('[data-i18n]') 恆回傳空陣列，只有顯式賦值的
      // 文字才測得到。
      var timelineBtn = byId('detailTimelineBtn');
      if (timelineBtn) {
        timelineBtn.hidden = buildSeenTimeline(e) === null;
        timelineBtn.textContent = tt('opTimelineBtn');
      }

      var openLink = byId('detailOpenLink');
      if (openLink) openLink.href = e.url;
    }

    // 完整開啟(卡片點擊/鍵盤):設 detailEntry、重置互動態(收合時間軸
    // 子層、清掉 excerpt 展開態)、填內容、顯示，並把焦點移入對話框、記住
    // 開啟前的焦點來源(a11y，關閉時還原)。
    function openEntryDetail(e) {
      detailEntry = e;
      var overlay = byId('detailOverlay');
      if (!overlay) return;
      var alreadyOpen = overlay.hidden === false;

      // 每次完整開啟(含切換到別的條目)都把子層時間軸視窗收合、excerpt
      // 展開態清掉，避免上一筆的展開態殘留到這一筆。
      closeTimelineOverlay();
      var excerptEl = byId('detailExcerpt');
      if (excerptEl) excerptEl.classList.remove('expanded');

      renderDetailContent(e);
      overlay.hidden = false;
      // 只有從關閉態開啟才記住焦點來源(切換條目時保留最初那個)，focus
      // 一律移到關閉鈕。
      if (!alreadyOpen) rememberFocus('detail');
      focusInto('detailOverlay', 'detailClose');
    }

    // storage 變動(setHistory)時原地刷新:只把 detailEntry 換成清單裡的
    // 新物件並重畫內容，不重置使用者正在看的時間軸子層/excerpt 展開態
    // (別處寫入無關紀錄不該把使用者互動態打回原形)。detailEntry 換成新
    // 物件也讓 url+at 精準刪除拿到不過期的 at。
    function refreshDetail(e) {
      detailEntry = e;
      var overlay = byId('detailOverlay');
      if (!overlay) return;
      renderDetailContent(e);
      overlay.hidden = false;
    }

    function closeEntryDetail() {
      var overlay = byId('detailOverlay');
      if (overlay) overlay.hidden = true;
      closeTimelineOverlay();
      detailEntry = null;
      restoreFocus('detail');
    }

    // original/removedParams 附加列:與淨化後連結列同一套 kv/linkrow/
    // copy-btn 結構(照手機版同一個 CopyRow 元件)，差別只在標籤文案與
    // 沒有 accent 強調。複製鈕直接複製該列的原始值(copyValue)，不是
    // formatDisplayUrl 過的顯示值。
    function buildExtraRowEl(row) {
      var wrap = document.createElement('div');
      wrap.className = 'detail-kv';
      var keyEl = document.createElement('span');
      keyEl.className = 'detail-key';
      keyEl.textContent = row.type === 'original' ? tt('opOriginalLabel') : tf('opTrackingParamLabel', { name: row.name });
      wrap.appendChild(keyEl);
      var linkRow = document.createElement('div');
      linkRow.className = 'detail-linkrow';
      var valueEl = document.createElement('span');
      valueEl.className = 'detail-value ellipsis';
      valueEl.textContent = row.display;
      linkRow.appendChild(valueEl);
      var copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = tt('opCopyShort');
      copyBtn.addEventListener('click', function () {
        copyText(row.copyValue);
      });
      linkRow.appendChild(copyBtn);
      wrap.appendChild(linkRow);
      return wrap;
    }

    // 時間軸每一列:軌道+圓點(最新一筆實心主色，其餘空心)+ 時間(絕對
    // 時間，最新一筆用一般文字色，其餘 textSecondary)+「 · 」+ 來源標籤
    // (沿用既有 KINDS 文案;kind 不在白名單內就不附標籤，只顯示時間)。
    // isFirst/isLast 決定圓點是否填色、要不要接續軌道線。
    function buildTimelineRow(record, isFirst, isLast) {
      var row = document.createElement('div');
      row.className = 'timeline-row';

      var rail = document.createElement('div');
      rail.className = 'timeline-rail';
      var dot = document.createElement('div');
      dot.className = 'timeline-dot' + (isFirst ? ' filled' : '');
      rail.appendChild(dot);
      if (!isLast) {
        var line = document.createElement('div');
        line.className = 'timeline-line';
        rail.appendChild(line);
      }
      row.appendChild(rail);

      // 時間/來源標籤各自用獨立 span 直接賦值 textContent(不是拼接單一
      // 字串塞給 textEl)，比照本檔一貫寫法(見 buildEntryCard 的 badge/
      // headTime 等)——controller smoke 測試組的最小 DOM stub，.textContent
      // 的 getter 只讀直接賦值過的內部字串，不會遞迴聚合子節點內容，得
      // 靠這個結構才驗證得到。
      var textEl = document.createElement('div');
      textEl.className = 'timeline-text' + (isFirst ? '' : ' secondary');
      var timeSpan = document.createElement('span');
      timeSpan.textContent = formatAbsoluteTime(record.at);
      textEl.appendChild(timeSpan);
      if (Object.prototype.hasOwnProperty.call(KINDS, record.kind)) {
        var kindSpan = document.createElement('span');
        kindSpan.className = 'timeline-kind';
        kindSpan.textContent = '　· ' + tt(KINDS[record.kind].key);
        textEl.appendChild(kindSpan);
      }
      row.appendChild(textEl);
      return row;
    }

    // 時間軸子層視窗:收合(重置內容並隱藏)。openEntryDetail 切換條目時、
    // closeEntryDetail 關閉詳細視窗時都要呼叫，避免殘留上一筆的展開態。
    // 這是「純收合」路徑，不動焦點——用於重置情境(開別筆/關詳細視窗)。
    function closeTimelineOverlay() {
      var timelineOverlay = byId('timelineOverlay');
      if (timelineOverlay) timelineOverlay.hidden = true;
    }
    // 使用者主動關時間軸(✕/遮罩/Esc):收合並把焦點還回開啟前的元素。
    function dismissTimelineOverlay() {
      closeTimelineOverlay();
      restoreFocus('timeline');
    }

    function bindDetailDialog() {
      on('detailClose', 'click', closeEntryDetail);
      on('detailOverlay', 'click', function (ev) {
        var overlay = byId('detailOverlay');
        if (overlay && ev.target === overlay) closeEntryDetail();
      });
      on('detailExpandBtn', 'click', function () {
        var excerptEl = byId('detailExcerpt');
        var expandBtn = byId('detailExpandBtn');
        if (excerptEl) excerptEl.classList.add('expanded');
        if (expandBtn) expandBtn.hidden = true;
      });
      on('detailUrlCopyBtn', 'click', function () {
        if (detailEntry) copyEntryUrl(detailEntry);
      });
      // 時間軸鈕開子層視窗(照手機版巢狀 Modal 的 showSeenHistory 分支)，
      // 標題帶次數(opTimelineCount)，逐列新到舊渲染。
      on('detailTimelineBtn', 'click', function () {
        if (!detailEntry) return;
        var timeline = buildSeenTimeline(detailEntry) || [];
        var titleEl = byId('timelineTitle');
        if (titleEl) titleEl.textContent = tf('opTimelineCount', { n: timeline.length });
        var timelineSection = byId('detailTimeline');
        if (timelineSection) {
          timelineSection.textContent = '';
          timeline.forEach(function (record, i) {
            timelineSection.appendChild(buildTimelineRow(record, i === 0, i === timeline.length - 1));
          });
        }
        var timelineOverlay = byId('timelineOverlay');
        rememberFocus('timeline');
        if (timelineOverlay) timelineOverlay.hidden = false;
        focusInto('timelineOverlay', 'timelineClose');
      });
      on('timelineClose', 'click', dismissTimelineOverlay);
      on('timelineOverlay', 'click', function (ev) {
        var timelineOverlay = byId('timelineOverlay');
        if (timelineOverlay && ev.target === timelineOverlay) dismissTimelineOverlay();
      });
      on('detailCopyBtn', 'click', function () {
        if (detailEntry) copyEntryUrl(detailEntry);
      });
      // 刪除先過一道確認框(複用共用 confirmOverlay)，確認後才真的刪。捕捉
      // 當下的 detailEntry，即使確認期間 detailEntry 被別的路徑改動，也是刪
      // 使用者當初按下刪除的那一筆。
      on('detailDeleteBtn', 'click', function () {
        if (!detailEntry) return;
        var target = detailEntry;
        openConfirm({
          titleKey: 'opDeleteTitle',
          okKey: 'opDeleteConfirmDo',
          desc: tt('opDeleteConfirmDesc'),
          action: function () {
            deleteEntry(target);
          },
        });
      });
      // 對話框鍵盤:
      //   - Tab/Shift+Tab:把焦點循環鎖在最上層開著的對話框內(focus trap)。
      //   - Esc:逐層關閉。確認框最上層(刪除確認會疊在詳細視窗上)先關，
      //     再輪時間軸子層，最後才關詳細視窗本身(比照手機版巢狀 Modal
      //     逐層關閉的直覺;手機版 DialogShell 走 Modal 的 onRequestClose，
      //     web 沒有對應原生事件，這裡以 keydown 補同義行為)。
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', function (ev) {
          if (!ev) return;
          if (ev.key === 'Tab') {
            var topId = topmostOverlayId();
            if (topId) trapTabInOverlay(topId, ev);
            return;
          }
          if (ev.key !== 'Escape') return;
          var confirmOverlay = byId('confirmOverlay');
          if (confirmOverlay && !confirmOverlay.hidden) {
            closeConfirm();
            return;
          }
          var timelineOverlay = byId('timelineOverlay');
          if (timelineOverlay && !timelineOverlay.hidden) {
            dismissTimelineOverlay();
            return;
          }
          var overlay = byId('detailOverlay');
          if (overlay && !overlay.hidden) closeEntryDetail();
        });
      }
    }

    function renderList() {
      var rowsEl = byId('rows');
      var emptyEl = byId('empty');
      var countHint = byId('countHint');
      if (!rowsEl) return;

      // 卡片整批重建，先清空相對時間節點登錄簿，下面 buildEntryCard 逐一
      // 重新登錄(見 timeNodes / refresh)。
      timeNodes = [];
      rowsEl.textContent = '';
      var matched = filterEntries(entries, activeKind, query);
      var visible = matched.slice(0, pageSize);

      visible.forEach(function (e) {
        rowsEl.appendChild(buildEntryCard(e));
      });

      if (emptyEl) emptyEl.hidden = visible.length > 0;
      if (countHint) countHint.textContent = tf('opShowing', { a: visible.length, b: matched.length });
    }

    function renderAll() {
      applyI18nDom();
      var stats = renderStats();
      renderChart(stats);
      renderList();
    }

    // ---- 選單/對話框/工具列佈線 ----

    function on(id, event, handler) {
      var el = byId(id);
      if (el && typeof el.addEventListener === 'function') el.addEventListener(event, handler);
      return el;
    }

    function bindToolbar() {
      // 搜尋
      on('searchInput', 'input', function (ev) {
        var el = ev && ev.target ? ev.target : byId('searchInput');
        query = el && typeof el.value === 'string' ? el.value : '';
        renderList();
      });

      // 每頁筆數
      on('pageSizeSel', 'click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.ps') : null;
        if (!btn) return;
        pageSize = Number(btn.dataset.n) || PAGE_SIZE_DEFAULT;
        var sel = byId('pageSizeSel');
        if (sel && typeof sel.querySelectorAll === 'function') {
          sel.querySelectorAll('.ps').forEach(function (b) {
            b.classList.toggle('on', b === btn);
          });
        }
        renderList();
      });

      // 篩選下拉
      var filterBtn = byId('filterBtn');
      var chipsRow = byId('chipsRow');
      function closeFilter() {
        if (chipsRow) chipsRow.hidden = true;
        if (filterBtn) filterBtn.setAttribute('aria-expanded', 'false');
      }
      on('filterBtn', 'click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (!chipsRow) return;
        var opening = chipsRow.hidden;
        chipsRow.hidden = !opening;
        if (filterBtn) filterBtn.setAttribute('aria-expanded', String(opening));
      });
      on('chips', 'click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.chip') : null;
        if (!btn) return;
        activeKind = btn.dataset.kind || 'all';
        var chips = byId('chips');
        if (chips && typeof chips.querySelectorAll === 'function') {
          chips.querySelectorAll('.chip').forEach(function (c) {
            c.classList.toggle('on', c === btn);
          });
        }
        if (filterBtn) filterBtn.classList.toggle('active', activeKind !== 'all');
        closeFilter();
        renderList();
      });

      // ⋯ 選單
      var moreBtn = byId('moreBtn');
      var moreMenu = byId('moreMenu');
      function closeMenu() {
        if (moreMenu) moreMenu.hidden = true;
        if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
      }
      on('moreBtn', 'click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (!moreMenu) return;
        var opening = moreMenu.hidden;
        moreMenu.hidden = !opening;
        if (moreBtn) moreBtn.setAttribute('aria-expanded', String(opening));
      });
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('click', function (ev) {
          var wrap = ev.target && ev.target.closest ? ev.target.closest('.menu-wrap') : null;
          if (moreMenu && !moreMenu.hidden && (!wrap || !wrap.contains(moreMenu))) closeMenu();
          if (chipsRow && !chipsRow.hidden && (!wrap || !wrap.contains(chipsRow))) closeFilter();
        });
      }

      // 匯出:直接下載檔案。
      on('exportBtn', 'click', function () {
        closeMenu();
        var payload = buildExportPayload(entries, new Date(now()).toISOString());
        download('threads-clean-link-history.json', JSON.stringify(payload, null, 2));
        toast(tt('opToastExported'));
      });

      // 匯入:對話框(選檔或貼上)。
      var overlay = byId('overlay');
      function closeImport() {
        if (overlay) overlay.hidden = true;
        restoreFocus('import');
      }
      on('importBtn', 'click', function () {
        closeMenu();
        var textEl = byId('modalText');
        if (textEl) textEl.value = '';
        rememberFocus('import');
        if (overlay) overlay.hidden = false;
        focusInto('overlay', 'modalText');
      });
      on('modalClose', 'click', closeImport);
      on('overlay', 'click', function (ev) {
        if (overlay && ev.target === overlay) closeImport();
      });
      on('modalFile', 'click', function () {
        var fileInput = byId('fileInput');
        if (fileInput && typeof fileInput.click === 'function') fileInput.click();
      });
      on('fileInput', 'change', function () {
        var fileInput = byId('fileInput');
        var f = fileInput && fileInput.files && fileInput.files[0];
        if (!f || typeof FileReader === 'undefined') return;
        var reader = new FileReader();
        reader.onload = function () {
          var textEl = byId('modalText');
          if (textEl) textEl.value = String(reader.result);
        };
        reader.readAsText(f);
        fileInput.value = '';
      });
      on('modalPrimary', 'click', function () {
        var textEl = byId('modalText');
        var parsed = parseImportText(textEl ? String(textEl.value || '').trim() : '');
        if (!parsed.ok) {
          toast(tt(parsed.error === 'badJson' ? 'opToastBadJson' : 'opToastNoEntries'));
          return;
        }
        var result = mergeImportedEntries(entries, parsed.entries, now());
        // 成功才發「已匯入」toast 並關框;寫入失敗(配額)走回滾 + 失敗
        // toast，不謊報成功、也不關框(讓使用者可另存/重試)。
        persistHistory(result.merged).then(function (res) {
          if (!res.ok) {
            onPersistFailed(res);
            return;
          }
          renderAll();
          closeImport();
          toast(
            result.skipped
              ? tf('opToastImportedSkip', { n: result.added, m: result.skipped })
              : tf('opToastImported', { n: result.added })
          );
        });
      });

      // 清除全部:走共用確認框(openConfirm)，確認後才 persistHistory([])。
      on('clearBtn', 'click', function () {
        closeMenu();
        openConfirm({
          titleKey: 'opClearAll',
          okKey: 'opClearDo',
          desc: tf('opClearConfirmDesc', { n: entries.length }),
          action: function () {
            persistHistory([]).then(function (res) {
              if (!res.ok) {
                onPersistFailed(res);
                return;
              }
              renderAll();
              toast(tt('opToastCleared'));
            });
          },
        });
      });
      on('confirmCancel', 'click', closeConfirm);
      on('confirmOverlay', 'click', function (ev) {
        var confirmOverlay = byId('confirmOverlay');
        if (confirmOverlay && ev.target === confirmOverlay) closeConfirm();
      });
      on('confirmOk', 'click', function () {
        var act = confirmAction;
        closeConfirm();
        if (typeof act === 'function') act();
      });
    }

    function bindSettings() {
      SETTING_IDS.forEach(function (id) {
        var el = byId(id);
        if (!el || typeof el.addEventListener !== 'function') return;
        el.addEventListener('change', function (event) {
          var checked = event && event.target ? event.target.checked : el.checked;
          var patch = {};
          patch[id] = checked;
          syncStorage.set(patch);
        });
      });
    }

    function bindTopbar() {
      on('langBtn', 'click', function () {
        langPref = locale === 'zh' ? 'en' : 'zh';
        locale = langPref;
        syncStorage.set({ langPref: langPref });
        renderAll();
      });
      on('themeBtn', 'click', function () {
        themePref = THEME_ORDER[(THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length];
        syncStorage.set({ themePref: themePref });
        applyTheme();
      });
    }

    function init() {
      var keys = Object.assign({ langPref: null, themePref: 'auto' }, OPTIONS_DEFAULT_SETTINGS);
      var readSync = Promise.resolve(syncStorage.get(keys));
      var readLocal = Promise.resolve(localStore.get({ [HISTORY_KEY]: [] }));
      return Promise.all([readSync, readLocal]).then(function (results) {
        var settings = results[0] || {};
        var localData = results[1] || {};
        entries = sanitizeEntries(localData[HISTORY_KEY]);

        langPref = settings.langPref === 'zh' || settings.langPref === 'en' ? settings.langPref : null;
        locale = i18n.resolveLocale(langPref);
        themePref = THEME_ORDER.indexOf(settings.themePref) !== -1 ? settings.themePref : 'auto';

        SETTING_IDS.forEach(function (id) {
          var el = byId(id);
          if (!el) return;
          var hasValue = Object.prototype.hasOwnProperty.call(settings, id);
          el.checked = hasValue && typeof settings[id] === 'boolean' ? settings[id] : OPTIONS_DEFAULT_SETTINGS[id];
        });

        applyTheme();
        bindSettings();
        bindTopbar();
        bindToolbar();
        bindDetailDialog();
        bindChartTooltip();
        renderAll();
      });
    }

    // storage.onChanged(local 區)時由接線層呼叫,讓 background 新寫入的
    // 紀錄即時出現在開著的頁面上。詳細視窗開著時以 url 重新定位
    // detailEntry:找得到就「只刷新內容」(refreshDetail，不重置使用者正在
    // 看的時間軸子層/展開全文——別處寫入無關紀錄不該打斷正在閱讀的人)，
    // 找不到(已被刪除/清除)就關閉詳細視窗。條目真的換了(url 不同)才走
    // 完整重置 openEntryDetail;此處以 url 定位，理論上恆為同 url，保留分支
    // 只為語意清楚與防禦。renderAll 會整面重建卡片，順帶保存/還原鍵盤焦點
    // 對應的條目(見 captureFocusedEntryKey/restoreFocusedEntry)。
    function setHistory(list) {
      var focusKey = captureFocusedEntryKey();
      entries = sanitizeEntries(list);
      if (detailEntry) {
        var match = null;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].url === detailEntry.url) {
            match = entries[i];
            break;
          }
        }
        if (match) {
          if (detailEntry.url !== match.url) openEntryDetail(match);
          else refreshDetail(match);
        } else {
          closeEntryDetail();
        }
      }
      renderAll();
      restoreFocusedEntry(focusKey);
    }

    // 焦點保存:整面重建卡片前記下目前鍵盤焦點落在哪一條目(卡片本身
    // 或其內部快捷鈕)，重建後把焦點還回同一條目的新卡片。DOM stub 沒有
    // activeElement，回 null → restore 為 no-op;真實環境的效果由人工/CDP
    // 驗證。以 url|at 當條目鍵(與 buildEntryCard 的 dataset.entryKey 一致)。
    function captureFocusedEntryKey() {
      var active = document && document.activeElement;
      if (!active) return null;
      var card = null;
      if (typeof active.closest === 'function') card = active.closest('.entry-card');
      else if (active.dataset && active.dataset.entryKey) card = active;
      return card && card.dataset ? card.dataset.entryKey || null : null;
    }
    function restoreFocusedEntry(key) {
      if (!key) return;
      var rowsEl = byId('rows');
      if (!rowsEl || !rowsEl.children) return;
      for (var i = 0; i < rowsEl.children.length; i++) {
        var c = rowsEl.children[i];
        if (c && c.dataset && c.dataset.entryKey === key && typeof c.focus === 'function') {
          try { c.focus(); } catch (e) {}
          return;
        }
      }
    }

    // storage.onChanged(sync 區)時由接線層呼叫:popup 或另一個開著的
    // options 分頁改了設定(開關/語言/主題)，讓常開的本頁同步反映，不顯示
    // 過期狀態。直接設定 checkbox.checked(不觸發 change 事件)，不會迴圈
    // 寫回 storage;同一次變更是自己這頁寫的也會走到這裡，重複設同一個值
    // 是無害的 no-op。
    function setSyncSettings(changes) {
      if (!changes) return;
      SETTING_IDS.forEach(function (id) {
        if (!Object.prototype.hasOwnProperty.call(changes, id)) return;
        var el = byId(id);
        if (!el) return;
        var newValue = changes[id] && changes[id].newValue;
        el.checked = typeof newValue === 'boolean' ? newValue : OPTIONS_DEFAULT_SETTINGS[id];
      });
      var needsRender = false;
      if (Object.prototype.hasOwnProperty.call(changes, 'langPref')) {
        var newLangPref = changes.langPref && changes.langPref.newValue;
        langPref = newLangPref === 'zh' || newLangPref === 'en' ? newLangPref : null;
        locale = i18n.resolveLocale(langPref);
        needsRender = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'themePref')) {
        var newThemePref = changes.themePref && changes.themePref.newValue;
        themePref = THEME_ORDER.indexOf(newThemePref) !== -1 ? newThemePref : 'auto';
        applyTheme();
      }
      if (needsRender) renderAll();
    }

    // 常開分頁的相對時間標籤刷新(60s ticker 與 visibilitychange 回分頁時
    // 由接線層呼叫)。走輕量路徑:只逐一改已登錄時間節點的 textContent，
    // 不呼叫 renderAll 整面重建卡片——全量重建會偷走使用者的鍵盤焦點與
    // 文字選取。詳細視窗開著時，視窗內的相對時間(detailTime)也一併刷新。
    function refresh() {
      for (var i = 0; i < timeNodes.length; i++) {
        timeNodes[i].node.textContent = relTime(timeNodes[i].at);
      }
      if (detailEntry) {
        var timeEl = byId('detailTime');
        if (timeEl) timeEl.textContent = relTime(detailEntry.at);
      }
    }

    return { init: init, setHistory: setHistory, setSyncSettings: setSyncSettings, refresh: refresh };
  }

  var api = {
    OPTIONS_DEFAULT_SETTINGS: OPTIONS_DEFAULT_SETTINGS,
    sanitizeEntries: sanitizeEntries,
    filterEntries: filterEntries,
    buildExportPayload: buildExportPayload,
    parseImportText: parseImportText,
    mergeImportedEntries: mergeImportedEntries,
    aggregateStats: aggregateStats,
    hasCardPreview: hasCardPreview,
    isLongExcerpt: isLongExcerpt,
    buildSeenTimeline: buildSeenTimeline,
    renderExcerptWithLinks: renderExcerptWithLinks,
    formatDisplayUrl: formatDisplayUrl,
    buildDetailExtraRows: buildDetailExtraRows,
    createOptionsController: createOptionsController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLOptions = api;
})(typeof window !== 'undefined' ? window : this);
