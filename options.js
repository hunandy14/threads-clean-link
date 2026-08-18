// options.js — options 頁(設定與淨化紀錄)的邏輯層。比照 popup.js 的模式:
// 可注入 document/storage/i18n 的純函式模組,不直接碰全域 chrome,離線可測;
// options-init.js 負責接上真的 chrome.*(見 options-init.js)。
//
// 純函式(filterEntries/mergeImportedEntries/buildExportPayload/aggregateStats)
// 獨立匯出,測試直接打;DOM 佈線集中在 createOptionsController。
(function (root) {
  'use strict';

  // 三顆開關的預設值。autoClean/notifySuccess 與 popup.js、background.js、
  // bridge.js 一致;saveHistory 與 background.js 一致(guard/bridge 不下放)。
  var OPTIONS_DEFAULT_SETTINGS = {
    autoClean: true,
    notifySuccess: false,
    saveHistory: true,
  };
  var SETTING_IDS = ['autoClean', 'notifySuccess', 'saveHistory'];

  var HISTORY_KEY = 'history';
  var HISTORY_LIMIT = 1000;
  var DAY_MS = 86400000;
  var PAGE_SIZE_DEFAULT = 20;

  // 匯入資料的驗證樣式:與 background.js 的 NOTICE_CLEAN_URL_PATTERN 同一套
  // 白名單字元類——匯入檔是外部輸入,信任等級與頁面訊息相同,整串完全
  // 吻合才收。
  var POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]{1,60}\/post\/[A-Za-z0-9_-]{1,60}$/i;

  // 0.5.0 貼文收藏庫:storage.local key/上限/欄位長度上限，與 background.js
  // 的 FAVORITES_KEY/FAVORITES_LIMIT/FAVORITES_AUTHOR_MAX/
  // FAVORITES_EXCERPT_MAX 對齊——options.js 與 background.js 是各自獨立
  // 載入的腳本，常數無法共用模組，這裡照抄同一份數值，任一邊調整都要記得
  // 同步另一邊。
  var FAVORITES_KEY = 'favorites';
  var FAVORITES_LIMIT = 500;
  var FAVORITES_AUTHOR_MAX = 100;
  var FAVORITES_EXCERPT_MAX = 2000;

  // 收藏匯入的網址驗證/正規化樣式，與 background.js 的 FAVORITE_URL_PATTERN
  // 同一套規則(白名單字元類 + 長度上限，額外容忍尾隨斜線／query／hash);
  // group 1 = 正規化後的乾淨網址，group 2 = 導出的 id(@user/post/id)。
  var FAVORITE_URL_PATTERN =
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

  // 從 storage 讀出的清單防禦性整形:非陣列→空;逐筆丟掉形狀不對的項目。
  function sanitizeEntries(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (e) {
      return (
        e &&
        typeof e.url === 'string' &&
        typeof e.at === 'number' &&
        isFinite(e.at) &&
        Object.prototype.hasOwnProperty.call(KINDS, e.kind)
      );
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

  function buildExportPayload(entries, exportedAt) {
    return {
      app: 'threads-clean-link',
      version: 1,
      exportedAt: exportedAt,
      entries: entries.map(function (e) {
        return { url: e.url, kind: e.kind, at: e.at };
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

  // 匯入合併:url 過錨定白名單、與現有以 url 去重;kind 非白名單→'share',
  // at 非有限數字→now。合併後新到舊排序、裁到上限。
  function mergeImportedEntries(existing, imported, now) {
    var seen = {};
    existing.forEach(function (e) {
      seen[e.url] = true;
    });
    var merged = existing.slice();
    var added = 0;
    var skipped = 0;
    imported.forEach(function (raw) {
      var url = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!POST_URL_PATTERN.test(url) || seen[url]) {
        skipped++;
        return;
      }
      seen[url] = true;
      merged.push({
        url: url,
        kind: raw && Object.prototype.hasOwnProperty.call(KINDS, raw.kind) ? raw.kind : 'share',
        at: raw && typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : now,
      });
      added++;
    });
    merged.sort(function (a, b) {
      return b.at - a.at;
    });
    return { merged: merged.slice(0, HISTORY_LIMIT), added: added, skipped: skipped };
  }

  // ---- 0.5.0 貼文收藏庫:純函式 ----

  // 從 storage 讀出的收藏清單防禦性整形:非陣列→空;逐筆丟掉形狀不對的
  // 項目(id/url 非字串、at 非有限數字);選填欄位(author/handle/excerpt)
  // 若存在但型別不是字串，整筆捨棄——形狀不對的資料不強行修補，與
  // sanitizeEntries 的防禦原則一致。
  function sanitizeFavorites(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (e) {
      if (!e || typeof e.id !== 'string' || typeof e.url !== 'string') return false;
      if (typeof e.at !== 'number' || !isFinite(e.at)) return false;
      if (Object.prototype.hasOwnProperty.call(e, 'author') && typeof e.author !== 'string') return false;
      if (Object.prototype.hasOwnProperty.call(e, 'handle') && typeof e.handle !== 'string') return false;
      if (Object.prototype.hasOwnProperty.call(e, 'excerpt') && typeof e.excerpt !== 'string') return false;
      return true;
    });
  }

  // 選填欄位截斷:非字串一律回傳 undefined(呼叫端據此決定整欄不寫入),
  // 字串則截斷至長度上限，與 background.js 的 sanitizeFavoriteField 同規則。
  function sanitizeFavoriteField(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : undefined;
  }

  function buildFavoritesExportPayload(favorites, exportedAt) {
    return {
      app: 'threads-clean-link',
      version: 1,
      exportedAt: exportedAt,
      entries: favorites.map(function (e) {
        var out = { id: e.id, url: e.url, at: e.at };
        if (typeof e.author === 'string') out.author = e.author;
        if (typeof e.handle === 'string') out.handle = e.handle;
        if (typeof e.excerpt === 'string') out.excerpt = e.excerpt;
        return out;
      }),
    };
  }

  // 收藏匯入合併:url 過 FAVORITE_URL_PATTERN 白名單並正規化、id 一律從
  // url 重新導出(不信任匯入檔自帶的 id——id 是去重的唯一依據，信任外部
  // 提供的 id 等於開了偽造去重鍵的後門，與 background.js 的
  // handleFavoriteToggle 一致);依 id 與現有收藏去重。
  //
  // 上限策略(自行裁量，PM 覆核):採「拒收不擠掉既有收藏」，刻意不同於
  // 淨化紀錄 mergeImportedEntries 的「裁到上限、汰舊留新」——收藏是使用者
  // 主動典藏的清單，background.js 的 handleFavoriteToggle 對單筆新增的
  // 既定原則就是滿了直接拒收、絕不擠掉舊收藏，批次匯入延續同一原則:
  // 既有收藏一筆都不會被匯入內容擠掉，超出剩餘容量的匯入項目一律計入
  // skipped 並如實在 toast 回報，而非靜默截斷。
  function mergeImportedFavorites(existing, imported, now) {
    var seen = {};
    existing.forEach(function (e) {
      seen[e.id] = true;
    });
    var merged = existing.slice();
    var added = 0;
    var skipped = 0;

    imported.forEach(function (raw) {
      var rawUrl = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
      var match = FAVORITE_URL_PATTERN.exec(rawUrl);
      if (!match) {
        skipped++;
        return;
      }
      var cleanUrl = match[1];
      var id = match[2];
      if (seen[id] || merged.length >= FAVORITES_LIMIT) {
        skipped++;
        return;
      }

      var entry = {
        id: id,
        url: cleanUrl,
        at: raw && typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : now,
      };
      var author = sanitizeFavoriteField(raw && raw.author, FAVORITES_AUTHOR_MAX);
      if (author !== undefined) entry.author = author;
      var handle = sanitizeFavoriteField(raw && raw.handle, FAVORITES_AUTHOR_MAX);
      if (handle !== undefined) entry.handle = handle;
      var excerpt = sanitizeFavoriteField(raw && raw.excerpt, FAVORITES_EXCERPT_MAX);
      if (excerpt !== undefined) entry.excerpt = excerpt;

      seen[id] = true;
      merged.push(entry);
      added++;
    });

    merged.sort(function (a, b) {
      return b.at - a.at;
    });
    return { merged: merged, added: added, skipped: skipped };
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
    var favorites = [];
    var locale = 'zh';
    var langPref = null; // null = 未設定,跟隨瀏覽器
    var themePref = 'auto';
    var activeKind = 'all';
    var query = '';
    var pageSize = PAGE_SIZE_DEFAULT;
    var activeView = 'history'; // 'history' | 'favorites',與既有紀錄檢視並列的分頁

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
    // 網址內容源頭是頁面可控管道，禁 innerHTML。淨化紀錄列與收藏卡片的
    // 降級顯示(無 author/excerpt 時)共用同一份拆解邏輯。
    function buildUrlNode(url, cls) {
      var urlEl = document.createElement('div');
      urlEl.className = cls || 'url';
      // TLD(com/net)一併捕獲並如實顯示:網址本來就可能來自 threads.net
      // (POST_URL_PATTERN／FAVORITE_URL_PATTERN 皆同時允許 com 與 net)，
      // 不可硬寫死 'threads.com/'。
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

    function renderList() {
      var rowsEl = byId('rows');
      var emptyEl = byId('empty');
      var countHint = byId('countHint');
      if (!rowsEl) return;

      rowsEl.textContent = '';
      var matched = filterEntries(entries, activeKind, query);
      var visible = matched.slice(0, pageSize);

      visible.forEach(function (e) {
        var li = document.createElement('li');
        li.className = 'row';

        var kindEl = document.createElement('span');
        kindEl.className = 'kind';
        kindEl.title = tt(KINDS[e.kind].key);
        kindEl.appendChild(svgUse(KINDS[e.kind].icon));

        var main = document.createElement('div');
        main.className = 'main';
        var urlEl = buildUrlNode(e.url, 'url');

        var meta = document.createElement('div');
        meta.className = 'meta';
        var timeEl = document.createElement('span');
        timeEl.textContent = relTime(e.at);
        var dot = document.createElement('span');
        dot.className = 'dot';
        var src = document.createElement('span');
        src.className = 'src-label';
        src.textContent = tt(KINDS[e.kind].key);
        meta.appendChild(timeEl);
        meta.appendChild(dot);
        meta.appendChild(src);
        main.appendChild(urlEl);
        main.appendChild(meta);

        var actions = document.createElement('div');
        actions.className = 'row-actions';
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

        li.appendChild(kindEl);
        li.appendChild(main);
        li.appendChild(actions);
        rowsEl.appendChild(li);
      });

      if (emptyEl) emptyEl.hidden = visible.length > 0;
      if (countHint) countHint.textContent = tf('opShowing', { a: visible.length, b: matched.length });
    }

    // ---- 收藏卡片牆 ----

    function persistFavorites(list) {
      favorites = list;
      return Promise.resolve(localStore.set({ [FAVORITES_KEY]: list })).catch(function (err) {
        if (typeof console !== 'undefined') console.error('[threads-clean-link] 寫入收藏失敗', err);
      });
    }

    // 單張收藏卡片:有 author/handle 時顯示作者列(+ excerpt,兩行截斷);
    // 兩者皆無時降級顯示網址(比照紀錄列樣式)。無縮圖(刻意,og:image 會
    // 過期)。卡尾固定放相對時間 + 複製/開啟/移除三個動作。
    function buildFavoriteCard(e) {
      var card = document.createElement('div');
      card.className = 'fav-card';

      var hasAuthor = typeof e.author === 'string' && e.author !== '';
      var hasHandle = typeof e.handle === 'string' && e.handle !== '';
      var hasExcerpt = typeof e.excerpt === 'string' && e.excerpt !== '';

      if (hasAuthor || hasHandle) {
        var authorRow = document.createElement('div');
        authorRow.className = 'fav-author-row';
        if (hasAuthor) {
          var nameEl = document.createElement('span');
          nameEl.className = 'fav-author-name';
          nameEl.textContent = e.author;
          authorRow.appendChild(nameEl);
        }
        if (hasHandle) {
          var handleEl = document.createElement('span');
          handleEl.className = 'fav-handle';
          handleEl.textContent = e.handle;
          authorRow.appendChild(handleEl);
        }
        card.appendChild(authorRow);
        if (hasExcerpt) {
          var excerptEl = document.createElement('div');
          excerptEl.className = 'fav-excerpt';
          excerptEl.textContent = e.excerpt;
          card.appendChild(excerptEl);
        }
      } else {
        card.appendChild(buildUrlNode(e.url, 'fav-url'));
      }

      var foot = document.createElement('div');
      foot.className = 'fav-foot';
      var timeEl = document.createElement('span');
      timeEl.className = 'fav-time';
      timeEl.textContent = relTime(e.at);
      foot.appendChild(timeEl);

      var actions = document.createElement('div');
      actions.className = 'fav-actions';

      actions.appendChild(
        iconBtn('#i-copy', tt('favCopy'), '', function () {
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

      // 開啟貼文用 <a target="_blank" rel="noopener">,不是 button——真的
      // 交給瀏覽器處理開新分頁(可 ctrl/cmd+click 開背景分頁等原生行為)。
      var openLink = document.createElement('a');
      openLink.className = 'icon-btn';
      openLink.title = tt('favOpenPost');
      openLink.href = e.url;
      openLink.target = '_blank';
      openLink.rel = 'noopener';
      openLink.appendChild(svgUse('#i-external-link'));
      actions.appendChild(openLink);

      actions.appendChild(
        iconBtn('#i-trash', tt('favRemove'), 'del', function () {
          var next = favorites.filter(function (x) {
            return x.id !== e.id;
          });
          persistFavorites(next);
          renderFavorites();
          toast(tt('favRemoved'));
        })
      );

      foot.appendChild(actions);
      card.appendChild(foot);
      return card;
    }

    function renderFavorites() {
      var gridEl = byId('favGrid');
      var emptyEl = byId('favEmptyState');
      var countEl = byId('favCountHint');
      if (!gridEl) return;

      gridEl.textContent = '';
      favorites.forEach(function (e) {
        gridEl.appendChild(buildFavoriteCard(e));
      });

      if (emptyEl) emptyEl.hidden = favorites.length > 0;
      if (countEl) countEl.textContent = tf('favCount', { n: favorites.length, max: FAVORITES_LIMIT });
    }

    // ---- 分頁切換(淨化紀錄 / 收藏) ----

    function setView(view) {
      activeView = view === 'favorites' ? 'favorites' : 'history';
      var historyView = byId('historyView');
      var favoritesView = byId('favoritesView');
      if (historyView) historyView.hidden = activeView !== 'history';
      if (favoritesView) favoritesView.hidden = activeView !== 'favorites';
      var tabHistory = byId('tabHistory');
      var tabFavorites = byId('tabFavorites');
      if (tabHistory) tabHistory.classList.toggle('on', activeView === 'history');
      if (tabFavorites) tabFavorites.classList.toggle('on', activeView === 'favorites');
    }

    function renderAll() {
      applyI18nDom();
      var stats = renderStats();
      renderChart(stats);
      renderList();
      renderFavorites();
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

    // 收藏分頁的 ⋯ 選單(匯出/匯入)+ 匯入對話框，佈線模式照抄 bindToolbar
    // 對應段落(獨立的 DOM id,兩份選單/對話框互不干擾)。
    function bindFavoritesToolbar() {
      var favMoreBtn = byId('favMoreBtn');
      var favMoreMenu = byId('favMoreMenu');
      function closeFavMenu() {
        if (favMoreMenu) favMoreMenu.hidden = true;
        if (favMoreBtn) favMoreBtn.setAttribute('aria-expanded', 'false');
      }
      on('favMoreBtn', 'click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (!favMoreMenu) return;
        var opening = favMoreMenu.hidden;
        favMoreMenu.hidden = !opening;
        if (favMoreBtn) favMoreBtn.setAttribute('aria-expanded', String(opening));
      });
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('click', function (ev) {
          var wrap = ev.target && ev.target.closest ? ev.target.closest('.menu-wrap') : null;
          if (favMoreMenu && !favMoreMenu.hidden && (!wrap || !wrap.contains(favMoreMenu))) closeFavMenu();
        });
      }

      // 匯出:直接下載檔案。
      on('favExportBtn', 'click', function () {
        closeFavMenu();
        var payload = buildFavoritesExportPayload(favorites, new Date(now()).toISOString());
        download('threads-clean-link-favorites.json', JSON.stringify(payload, null, 2));
        toast(tt('favToastExported'));
      });

      // 匯入:對話框(選檔或貼上)。
      var favOverlay = byId('favOverlay');
      on('favImportBtn', 'click', function () {
        closeFavMenu();
        var textEl = byId('favModalText');
        if (textEl) textEl.value = '';
        if (favOverlay) favOverlay.hidden = false;
      });
      on('favModalClose', 'click', function () {
        if (favOverlay) favOverlay.hidden = true;
      });
      on('favOverlay', 'click', function (ev) {
        if (favOverlay && ev.target === favOverlay) favOverlay.hidden = true;
      });
      on('favModalFile', 'click', function () {
        var fileInput = byId('favFileInput');
        if (fileInput && typeof fileInput.click === 'function') fileInput.click();
      });
      on('favFileInput', 'change', function () {
        var fileInput = byId('favFileInput');
        var f = fileInput && fileInput.files && fileInput.files[0];
        if (!f || typeof FileReader === 'undefined') return;
        var reader = new FileReader();
        reader.onload = function () {
          var textEl = byId('favModalText');
          if (textEl) textEl.value = String(reader.result);
        };
        reader.readAsText(f);
        fileInput.value = '';
      });
      on('favModalPrimary', 'click', function () {
        var textEl = byId('favModalText');
        // 解析階段(JSON 格式 + entries 陣列存在)與淨化紀錄共用同一份純
        // 函式(parseImportText 不關心條目的內部形狀),形狀驗證留給
        // mergeImportedFavorites 逐條把關。
        var parsed = parseImportText(textEl ? String(textEl.value || '').trim() : '');
        if (!parsed.ok) {
          toast(tt(parsed.error === 'badJson' ? 'opToastBadJson' : 'opToastNoEntries'));
          return;
        }
        var result = mergeImportedFavorites(favorites, parsed.entries, now());
        persistFavorites(result.merged);
        renderFavorites();
        if (favOverlay) favOverlay.hidden = true;
        toast(
          result.skipped
            ? tf('favToastImportedSkip', { n: result.added, m: result.skipped })
            : tf('favToastImported', { n: result.added })
        );
      });
    }

    // 頂部分頁切換(淨化紀錄 / 收藏)。
    function bindViewTabs() {
      on('tabHistory', 'click', function () {
        setView('history');
      });
      on('tabFavorites', 'click', function () {
        setView('favorites');
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
      var readLocal = Promise.resolve(localStore.get({ [HISTORY_KEY]: [], [FAVORITES_KEY]: [] }));
      return Promise.all([readSync, readLocal]).then(function (results) {
        var settings = results[0] || {};
        var localData = results[1] || {};
        entries = sanitizeEntries(localData[HISTORY_KEY]);
        favorites = sanitizeFavorites(localData[FAVORITES_KEY]);

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
        bindFavoritesToolbar();
        bindViewTabs();
        bindChartTooltip();
        setView('history');
        renderAll();
      });
    }

    // storage.onChanged(local 區)時由接線層呼叫,讓 background 新寫入的
    // 紀錄即時出現在開著的頁面上。
    function setHistory(list) {
      entries = sanitizeEntries(list);
      renderAll();
    }

    // 同上，收藏庫版本:互動列書籤 icon 觸發的新增/移除即時反映到卡片牆。
    function setFavorites(list) {
      favorites = sanitizeFavorites(list);
      renderFavorites();
    }

    return { init: init, setHistory: setHistory, setFavorites: setFavorites };
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
    FAVORITES_LIMIT: FAVORITES_LIMIT,
    FAVORITE_URL_PATTERN: FAVORITE_URL_PATTERN,
    sanitizeFavorites: sanitizeFavorites,
    buildFavoritesExportPayload: buildFavoritesExportPayload,
    mergeImportedFavorites: mergeImportedFavorites,
    createOptionsController: createOptionsController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLOptions = api;
})(typeof window !== 'undefined' ? window : this);
