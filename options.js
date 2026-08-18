// options.js — options 頁(設定與淨化紀錄)的邏輯層。比照 popup.js 的模式:
// 可注入 document/storage/i18n 的純函式模組,不直接碰全域 chrome,離線可測;
// options-init.js 負責接上真的 chrome.*(見 options-init.js)。
//
// 純函式(filterEntries/mergeImportedEntries/buildExportPayload/aggregateStats)
// 獨立匯出,測試直接打;DOM 佈線集中在 createOptionsController。
(function (root) {
  'use strict';

  // 四顆開關的預設值。autoClean 與 popup.js、background.js、bridge.js 一致
  // (0.5.0 方案甲:預設改 false，配合另一車道調整 background.js 的預設值);
  // notifySuccess 沿用既有預設;saveHistory 與 background.js 一致(guard/
  // bridge 不下放);postCopyEnabled 與 popup.js 鏡像(貼文互動列複製按鈕，
  // 見 post-icon.js，另一車道)。
  var OPTIONS_DEFAULT_SETTINGS = {
    autoClean: false,
    notifySuccess: false,
    saveHistory: true,
    postCopyEnabled: true,
  };
  var SETTING_IDS = ['autoClean', 'notifySuccess', 'saveHistory', 'postCopyEnabled'];

  var HISTORY_KEY = 'history';
  var HISTORY_LIMIT = 1000;
  var DAY_MS = 86400000;
  var PAGE_SIZE_DEFAULT = 20;

  // 0.5.0 方案甲(歷史即收藏，撤獨立收藏分頁):淨化紀錄欄位長度上限，選填的
  // author/handle/excerpt 由 background.js(另一車道)落盤，options.js 這側
  // 在讀取/匯入時再做一次防禦性截斷(縱深防禦，不依賴寫入端永遠沒漏)。
  var ENTRY_AUTHOR_MAX = 100;
  var ENTRY_EXCERPT_MAX = 2000;

  // 貼文網址驗證/正規化樣式:白名單字元類(handle:英數/底線/句點;post id:
  // 英數/連字號/底線，皆有長度上限)，額外容忍尾隨斜線／查詢字串／hash——
  // 匯入檔或頁面 DOM 擷取的 href 常帶這些，不應因此整筆拒收。group 1 = 正
  // 規化後的乾淨網址(不含尾隨斜線/query/hash)。
  //
  // 前身是 0.5.0 收藏庫基座的 FAVORITE_URL_PATTERN;方案甲撤了獨立收藏，
  // 這裡改名為通用的貼文 url 驗證，供 mergeImportedEntries 使用(取代原本
  // 較嚴格、不容忍尾綴的舊版 POST_URL_PATTERN)。
  var POST_URL_PATTERN =
    /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/(@[A-Za-z0-9._]{1,60}\/post\/[A-Za-z0-9_-]{1,60}))\/?(?:[?#].*)?$/i;

  var KINDS = {
    share: { key: 'opKindShare', icon: '#i-link' },
    strip: { key: 'opKindStrip', icon: '#i-scissors' },
    menu: { key: 'opKindMenu', icon: '#i-mouse' },
    // 貼文互動列複製 icon(post-icon.js)寫入剪貼簿成功後的路徑，沿用既有
    // #i-copy 符號(options.html 已定義，opCopyTitle 那顆複製鈕也用它)，
    // 不必為此另刻一顆 SVG。
    icon: { key: 'opKindIcon', icon: '#i-copy' },
  };

  // ---- 純函式 ----

  // 選填欄位截斷:非字串一律回傳 undefined(呼叫端據此決定整欄不寫入),
  // 字串則截斷至長度上限。author/handle/excerpt 共用同一份規則。
  function sanitizeTextField(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : undefined;
  }

  // 從 storage 讀出的清單防禦性整形:非陣列→空;逐筆丟掉核心欄位(url/kind/
  // at)形狀不對的項目。選填欄位(author/handle/excerpt,0.5.0 方案甲新增)
  // 型別不是字串就整欄丟棄、字串則截斷至長度上限——縱深防禦，不依賴寫入端
  // (background.js)永遠沒漏，呼應 buildEntryCard 的 openLink.href = e.url
  // 等 sink 只該接收形狀乾淨的資料。
  function sanitizeEntries(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function (e) {
        return (
          e &&
          typeof e.url === 'string' &&
          typeof e.at === 'number' &&
          isFinite(e.at) &&
          Object.prototype.hasOwnProperty.call(KINDS, e.kind)
        );
      })
      .map(function (e) {
        var out = { url: e.url, kind: e.kind, at: e.at };
        var author = sanitizeTextField(e.author, ENTRY_AUTHOR_MAX);
        if (author !== undefined) out.author = author;
        var handle = sanitizeTextField(e.handle, ENTRY_AUTHOR_MAX);
        if (handle !== undefined) out.handle = handle;
        var excerpt = sanitizeTextField(e.excerpt, ENTRY_EXCERPT_MAX);
        if (excerpt !== undefined) out.excerpt = excerpt;
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

  // 0.5.0 方案甲:entries 只留三個核心欄位的年代已過去，author/handle/
  // excerpt 為字串時一併輸出(選填，沿用「非字串/缺席就整欄不寫」的慣例)。
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

  // 匯入合併:url 過 POST_URL_PATTERN 白名單並正規化(容忍尾隨斜線/query/
  // hash)、以正規化後的 url 與現有去重;kind 非白名單→'share',at 非有限
  // 數字→now;author/handle/excerpt 逐條 sanitize(型別+截斷，規則同
  // sanitizeEntries)。合併後新到舊排序、裁到上限。
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
      var match = POST_URL_PATTERN.exec(rawUrl);
      if (!match || seen[match[1]]) {
        skipped++;
        return;
      }
      var url = match[1];
      seen[url] = true;
      var entry = {
        url: url,
        kind: raw && Object.prototype.hasOwnProperty.call(KINDS, raw.kind) ? raw.kind : 'share',
        at: raw && typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : now,
      };
      var author = sanitizeTextField(raw && raw.author, ENTRY_AUTHOR_MAX);
      if (author !== undefined) entry.author = author;
      var handle = sanitizeTextField(raw && raw.handle, ENTRY_AUTHOR_MAX);
      if (handle !== undefined) entry.handle = handle;
      var excerpt = sanitizeTextField(raw && raw.excerpt, ENTRY_EXCERPT_MAX);
      if (excerpt !== undefined) entry.excerpt = excerpt;
      merged.push(entry);
      added++;
    });
    merged.sort(function (a, b) {
      return b.at - a.at;
    });
    return { merged: merged.slice(0, HISTORY_LIMIT), added: added, skipped: skipped };
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

  // 統計聚合:總數、各來源數、本週/上週(滾動 7 天)、近 14 天逐「日曆日」
  // 次數(索引 13 = 今天)、最舊一筆時間戳。
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

    // 注意:此模組內不得宣告名為 t 的區域變數,以免遮蔽翻譯函式
    // (demo 階段真踩過:var t = createElement(...) 讓整頁渲染炸掉)。
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

    function persistHistory(list) {
      entries = list;
      return Promise.resolve(localStore.set({ [HISTORY_KEY]: list })).catch(function (err) {
        if (typeof console !== 'undefined') console.error('[threads-clean-link] 寫入紀錄失敗', err);
      });
    }

    function iconBtn(href, title, extraCls, onClick) {
      var b = document.createElement('button');
      b.className = 'icon-btn' + (extraCls ? ' ' + extraCls : '');
      b.title = title;
      b.appendChild(svgUse(href));
      b.addEventListener('click', onClick);
      return b;
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

    // 單張紀錄卡片:與手機版 history-card.tsx 逐項對齊——卡頭(kind 徽章 +
    // 相對時間)→ hasCardPreview 為真時顯示作者列(author 粗體 + @handle
    // 灰階，皆存在才顯示 handle)+ excerpt(兩行截斷);否則降級顯示網址
    // (比照舊版紀錄列樣式)。無縮圖(刻意，og:image 會過期)。動作(複製/
    // 開啟/刪除)常駐於 DOM，但 CSS 預設 opacity:0,hover/focus-within 才
    // 浮現(手機版是「選中時右上浮出」,web 沒有選取態，改用 hover 對應)。
    function buildEntryCard(e) {
      var card = document.createElement('div');
      card.className = 'entry-card';

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
      meta.appendChild(badge);
      meta.appendChild(headTime);
      header.appendChild(meta);
      card.appendChild(header);

      if (hasCardPreview(e)) {
        var hasAuthor = typeof e.author === 'string' && e.author !== '';
        if (hasAuthor) {
          var authorRow = document.createElement('div');
          authorRow.className = 'entry-author-row';
          var nameEl = document.createElement('span');
          nameEl.className = 'entry-author-name';
          nameEl.textContent = e.author;
          authorRow.appendChild(nameEl);
          if (typeof e.handle === 'string' && e.handle !== '') {
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

      var actions = document.createElement('div');
      actions.className = 'entry-actions';

      actions.appendChild(
        iconBtn('#i-copy', tt('opCopyTitle'), '', function () {
          var p;
          try {
            p = navigator.clipboard.writeText(e.url);
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
        })
      );

      // 開啟貼文用 <a target="_blank" rel="noopener">，不是 button——真的
      // 交給瀏覽器處理開新分頁(可 ctrl/cmd+click 開背景分頁等原生行為)。
      var openLink = document.createElement('a');
      openLink.className = 'icon-btn';
      openLink.title = tt('opOpenTitle');
      openLink.href = e.url;
      openLink.target = '_blank';
      openLink.rel = 'noopener';
      openLink.appendChild(svgUse('#i-external-link'));
      actions.appendChild(openLink);

      actions.appendChild(
        iconBtn('#i-trash', tt('opDeleteTitle'), 'del', function () {
          var next = entries.filter(function (x) {
            return !(x.url === e.url && x.at === e.at);
          });
          persistHistory(next);
          renderAll();
          toast(tt('opToastDeleted'));
        })
      );

      card.appendChild(actions);
      return card;
    }

    function renderList() {
      var rowsEl = byId('rows');
      var emptyEl = byId('empty');
      var countHint = byId('countHint');
      if (!rowsEl) return;

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
      on('importBtn', 'click', function () {
        closeMenu();
        var textEl = byId('modalText');
        if (textEl) textEl.value = '';
        if (overlay) overlay.hidden = false;
      });
      on('modalClose', 'click', function () {
        if (overlay) overlay.hidden = true;
      });
      on('overlay', 'click', function (ev) {
        if (overlay && ev.target === overlay) overlay.hidden = true;
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
        persistHistory(result.merged);
        renderAll();
        if (overlay) overlay.hidden = true;
        toast(
          result.skipped
            ? tf('opToastImportedSkip', { n: result.added, m: result.skipped })
            : tf('opToastImported', { n: result.added })
        );
      });

      // 清除全部:確認對話框。
      var confirmOverlay = byId('confirmOverlay');
      on('clearBtn', 'click', function () {
        closeMenu();
        var desc = byId('confirmDesc');
        if (desc) desc.textContent = tf('opClearConfirmDesc', { n: entries.length });
        if (confirmOverlay) confirmOverlay.hidden = false;
      });
      on('confirmCancel', 'click', function () {
        if (confirmOverlay) confirmOverlay.hidden = true;
      });
      on('confirmOverlay', 'click', function (ev) {
        if (confirmOverlay && ev.target === confirmOverlay) confirmOverlay.hidden = true;
      });
      on('confirmOk', 'click', function () {
        persistHistory([]);
        renderAll();
        if (confirmOverlay) confirmOverlay.hidden = true;
        toast(tt('opToastCleared'));
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
        bindChartTooltip();
        renderAll();
      });
    }

    // storage.onChanged(local 區)時由接線層呼叫,讓 background 新寫入的
    // 紀錄即時出現在開著的頁面上。
    function setHistory(list) {
      entries = sanitizeEntries(list);
      renderAll();
    }

    return { init: init, setHistory: setHistory };
  }

  var api = {
    OPTIONS_DEFAULT_SETTINGS: OPTIONS_DEFAULT_SETTINGS,
    HISTORY_LIMIT: HISTORY_LIMIT,
    POST_URL_PATTERN: POST_URL_PATTERN,
    sanitizeEntries: sanitizeEntries,
    filterEntries: filterEntries,
    buildExportPayload: buildExportPayload,
    parseImportText: parseImportText,
    mergeImportedEntries: mergeImportedEntries,
    aggregateStats: aggregateStats,
    hasCardPreview: hasCardPreview,
    createOptionsController: createOptionsController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLOptions = api;
})(typeof window !== 'undefined' ? window : this);
