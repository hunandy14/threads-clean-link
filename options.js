// options.js — options 頁(設定與淨化紀錄)的邏輯層。比照 popup.js 的模式:
// 可注入 document/storage/i18n 的純函式模組，不直接碰全域 chrome，離線可測;
// options-init.js 負責接上真的 chrome.*(見 options-init.js)。
//
// 純函式(filterEntries/mergeImportedEntries/buildExportPayload/aggregateStats)
// 獨立匯出，測試直接打;DOM 佈線集中在 createOptionsController。
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
  // 帳號同步狀態(docs/cloud-sync.md 4.2)。options 只讀 userId 判斷登入
  // 態、只寫 clearedAt(清除全部的全域水位線)，其餘欄位由同步引擎維護。
  var SYNC_ACCOUNT_KEY = 'syncState';
  var DAY_MS = 86400000;
  var PAGE_SIZE_DEFAULT = 20;

  // 墓碑判定走 TCLCore.isTombstone:deletedAt 為有限數字代表本機已軟刪、等待
  // 伺服器 ack。墓碑必須留在 storage(它是待上傳的刪除意圖)，但一律不進畫面、
  // 統計、圖表與匯出。
  function liveEntries(list) {
    return list.filter(function (e) {
      return !TCLCore.isTombstone(e);
    });
  }

  function finiteOrNull(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }
  function nonEmptyString(value) {
    return typeof value === 'string' && value !== '' ? value : null;
  }
  // 條目的最早事件時間與 receivedAt 推導(TCLCore.entryEarliestAt /
  // TCLCore.resolveReceivedAt):seen 事件取最小 at(不是 seen[0].at，匯入檔不保
  // 證已排序)，一個可用事件都沒有時退回條目自身的 at;已持久化的 receivedAt 與
  // 推導值取較早者(只往前不往後)。與 background 寫入側共用同一份。

  // 貼文網址驗證/正規化走 TCLCore.normalizePostUrl(容尾正規化:白名單字元類 +
  // 長度上限，容忍尾隨斜線/查詢字串/hash，回傳正規化後的乾淨網址或 null)。
  // 長度上限與字元類與 background 寫入側共用同一份，漂移風險已由 TCLCore 收斂。

  // badge 渲染(buildEntryCard/openEntryDetail/buildTimelineRow)只用 .key
  // 查 i18n 文案，純文字 pill,KINDS 不需要 icon 欄位。KINDS 是 UI 關注點(kind→
  // i18n 顯示 key 的映射)，留在 options;seen[].kind 白名單改用 TCLCore.KIND_LIST
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
  // 獨立信任邊界，縱深防禦不依賴寫入端沒漏——與 background 寫入側共用同一份
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
        return keepSchemaFields(out, e);
      });
  }

  // 讀取端把雲端 schema 的七個欄位原樣帶過來(型別不對就退回該欄的安全預
  // 設，鍵仍保留)。**只保留、不補值**:缺席代表這筆還沒跑過 background 的
  // 遷移，補值是遷移與寫入路徑的職責。
  //
  // 這一步是刪除／匯入寫回 storage 那份陣列的來源，漏掉任一欄，使用者按一次
  // 刪除就會把整張表的 id 與待上傳的墓碑一起洗掉。墓碑本身不在這裡過濾——
  // 它必須留在陣列，不顯示是渲染層的事。
  function keepSchemaFields(out, source) {
    function has(field) {
      return Object.prototype.hasOwnProperty.call(source, field);
    }
    if (has('id')) out.id = nonEmptyString(source.id);
    if (has('postKey')) out.postKey = nonEmptyString(source.postKey);
    // original 已由 sanitizeOriginal 處理過(與 url 相同時視為沒有額外資訊而
    // 丟棄)。新 schema 下它是雲端必填欄位，值恰為 url 時同樣要留住。
    if (out.original === undefined && typeof source.original === 'string') {
      if (TCLCore.stripControlChars(source.original) === out.url) out.original = out.url;
    }
    if (has('receivedAt')) out.receivedAt = finiteOrNull(source.receivedAt);
    if (has('dirty')) out.dirty = source.dirty === true;
    if (has('serverUpdatedAt')) out.serverUpdatedAt = finiteOrNull(source.serverUpdatedAt);
    if (has('deletedAt')) out.deletedAt = finiteOrNull(source.deletedAt);
    return out;
  }

  // kind 過濾('all' 不過濾)+ 關鍵字過濾(比對整條網址，不分大小寫)。
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
  //
  // 雲端 schema 欄位只輸出 id／receivedAt／serverUpdatedAt 三個(cloud-sync.md
  // 4.1):
  //   - id 是這張卡在雲端的身分。不輸出的話，匯入端會為同一張卡生成新
  //     UUID，雲端就多出一張內容相同的孤兒卡。
  //   - receivedAt 是雲端必填的「第一次出現時間」。seen 被 SEEN_MAX 裁掉最舊
  //     幾筆之後，匯入端從 seen 推導只會得到較晚的時間，這張卡在雲端的起始
  //     時間會憑空往後跳。
  //   - serverUpdatedAt 是下一輪合併的判準，不帶會讓匯入回來的卡在下次同步
  //     被當成從未上傳過。
  // 其餘四欄刻意不輸出:deletedAt 不必(匯出來源已是 liveEntries，墓碑不進匯
  // 出檔)，postKey 與 dirty 皆可由匯入端推導(postKeyOf(url)、匯入一律標髒)。
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
        if (nonEmptyString(e.id) !== null) out.id = e.id;
        if (finiteOrNull(e.receivedAt) !== null) out.receivedAt = e.receivedAt;
        if (finiteOrNull(e.serverUpdatedAt) !== null) out.serverUpdatedAt = e.serverUpdatedAt;
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

  // 匯入檔的單筆整形:url 過 TCLCore.normalizePostUrl 白名單並正規化(容忍尾
  // 隨斜線/query/hash);kind 非白名單→'share'，at 非有限數字→now;
  // author/handle/excerpt/seen/original/removedParams 逐條 sanitize(規則同
  // sanitizeEntries——匯入檔是外部輸入，偽造/損毀資料不得混進來)。雲端 schema
  // 的七個欄位一併補齊:檔案帶了就沿用(id 尤其不得重新生成——那等於在雲端把
  // 同一張卡拆成兩張)，沒帶才補值。
  function buildImportedEntry(raw, url, now) {
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
    var seenList = TCLCore.sanitizeSeenList(raw && raw.seen);
    if (seenList.length > 0) entry.seen = seenList;
    // original 的相同判斷用正規化後的 url，不是匯入檔裡未正規化的原始字串。
    // 檔案帶了 original 就照既有規則消毒(與 url 相同即沒有額外資訊，整欄丟
    // 棄);整欄缺席才以 url 補(伺服器必填)。
    if (raw && typeof raw.original === 'string') {
      var original = TCLCore.sanitizeOriginal(raw.original, url);
      if (original !== undefined) entry.original = original;
    } else {
      entry.original = url;
    }
    var removedParams = TCLCore.sanitizeRemovedParams(raw && raw.removedParams);
    if (removedParams !== undefined) entry.removedParams = removedParams;

    entry.id = nonEmptyString(raw && raw.id) || TCLCore.randomUuid();
    entry.postKey = TCLCore.postKeyOf(url);
    entry.receivedAt = TCLCore.resolveReceivedAt(Object.assign({}, entry, { receivedAt: raw && raw.receivedAt }));
    // 匯入進來的資料(別台裝置的鏡像或本機舊匯出檔)在本機都是待上傳狀態。
    entry.dirty = true;
    entry.serverUpdatedAt = finiteOrNull(raw && raw.serverUpdatedAt);
    entry.deletedAt = null;
    return entry;
  }

  // 兩張同 postKey 的卡合成一張。新到舊的顯示欄位(url/kind/at 與選填欄位)以
  // at 較新的一張為主、缺席才由另一張補位;雲端身分欄位反過來以本機既有的為
  // 準(id 換一次等於在雲端另開一張卡，serverUpdatedAt 是伺服器的值)。
  // receivedAt 取兩者最早，seen 取聯集，deletedAt 清為 null——匯入同一篇貼文
  // 是明確的復活意圖。
  function mergeSamePostEntries(existing, incoming) {
    var primary = incoming.at >= existing.at ? incoming : existing;
    var secondary = primary === incoming ? existing : incoming;
    var out = { url: primary.url, kind: primary.kind, at: primary.at };
    TCLCore.MERGEABLE_FIELDS.forEach(function (field) {
      if (primary[field] !== undefined) out[field] = primary[field];
      else if (secondary[field] !== undefined) out[field] = secondary[field];
    });

    // seen 聯集走 TCLCore.unionSeen(同 at 只留一筆、按 at 升序、裁到 SEEN_MAX)
    // ——與 background 合併端、fromSyncItem 共用同一份實作。
    var seenList = TCLCore.unionSeen(existing.seen, incoming.seen);
    if (seenList.length > 0) out.seen = seenList;

    out.id = nonEmptyString(existing.id) || nonEmptyString(incoming.id) || TCLCore.randomUuid();
    out.postKey = TCLCore.postKeyOf(out.url);
    var earliest = [TCLCore.resolveReceivedAt(existing), TCLCore.resolveReceivedAt(incoming)].filter(function (v) {
      return v !== null;
    });
    out.receivedAt = earliest.length > 0 ? Math.min.apply(null, earliest) : null;
    out.dirty = true;
    out.serverUpdatedAt =
      finiteOrNull(existing.serverUpdatedAt) !== null
        ? existing.serverUpdatedAt
        : finiteOrNull(incoming.serverUpdatedAt);
    out.deletedAt = null;
    return out;
  }

  // 匯入合併:去重鍵是 postKey(D11)——作者改名後同一篇貼文的乾淨網址不同、
  // 正規化後仍不相等，以 url 去重會多開一張卡、雲端跟著分裂。同鍵不是「略
  // 過」而是合併語意(seen 聯集、receivedAt 取最早、墓碑復活)，計數上仍算
  // skipped(對使用者而言就是「沒有新增一筆」)。同一批匯入檔內部的同 postKey
  // 也先併起來，否則一次匯入就自己製造出兩張同文卡。合併後新到舊排序，最後過
  // TCLCore.capHistory 套上與 background 寫入側同一份儲存上限(位元組軟預算＋
  // 筆數硬保險，墓碑優先淘汰)——匯入是唯一能一口氣把 history 撐長的使用者操
  // 作，繞過裁切等於讓一份夠大的匯入檔直接把 storage 寫爆。裁切從尾端(最舊)
  // 起，added/skipped 仍是合併階段的計數(使用者關心的是「這次檔案裡有幾筆是
  // 新的」，不是裁切後剩幾筆)。
  function mergeImportedEntries(existing, imported, now) {
    var merged = existing.slice();
    var indexByKey = {};
    merged.forEach(function (e, i) {
      var key = TCLCore.postKeyOf(e.url);
      if (!Object.prototype.hasOwnProperty.call(indexByKey, key)) indexByKey[key] = i;
    });

    var added = 0;
    var skipped = 0;
    imported.forEach(function (raw) {
      var rawUrl = raw && typeof raw.url === 'string' ? raw.url.trim() : '';
      var url = TCLCore.normalizePostUrl(rawUrl);
      if (url === null) {
        skipped++;
        return;
      }
      var entry = buildImportedEntry(raw, url, now);
      if (Object.prototype.hasOwnProperty.call(indexByKey, entry.postKey)) {
        var idx = indexByKey[entry.postKey];
        merged[idx] = mergeSamePostEntries(merged[idx], entry);
        skipped++;
        return;
      }
      indexByKey[entry.postKey] = merged.length;
      merged.push(entry);
      added++;
    });
    merged.sort(function (a, b) {
      return b.at - a.at;
    });
    return { merged: TCLCore.capHistory(merged), added: added, skipped: skipped };
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
    // doc 由呼叫端傳入(controller 的注入 document)，不碰全域。
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

  // ---- 雲端同步(車道 E，消費 docs/cloud-sync.md 第 5 節的 state 形狀) ----

  // state.status 的合法枚舉，逐字照文件第 5.2 節。
  var SYNC_STATUSES = ['signed_out', 'signed_in', 'syncing', 'error'];

  // background 尚未實作同步引擎(車道 D)前的安全預設:未登入。也是
  // sync.getState 無回應／回應形狀不對時的退回值(見 fetchSyncState)。
  // displayName/avatarUrl 為車道 A 新增的兩欄(docs/cloud-sync.md 第 5.2
  // 節)，缺席一律視為 null——帳號入口的頭像/名字渲染需要備援到
  // email，見 renderAccount。
  //
  // 命名:DEFAULT_SYNC_CARD_STATE/normalizeSyncCardState 特意不叫
  // DEFAULT_SYNC_STATE/normalizeSyncState——TCLCore 已有同名的
  // normalizeSyncState(chrome.storage.local 的帳號同步狀態，車道 D6，形狀
  // 完全不同，見上面 syncAccount)，兩者撞名容易在呼叫端讀岔;這裡的
  // CardState 專指「頁首帳號卡片目前顯示的狀態」。
  var DEFAULT_SYNC_CARD_STATE = {
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  };

  // 權限描述子的 origin 來源:state.apiBase 尚未從 background 回來時的退回值。
  // production／staging 的 host 宣告在商店版 manifest 的
  // optional_host_permissions;local 只宣告在 tools/dev-browser.mjs 產出的
  // 開發用 manifest 副本裡，商店版沒有這一項，request 自然拿不到。
  var SYNC_API_BASE_FALLBACK = 'https://api.metalinkclearer.workers.dev';
  var SYNC_API_BASE_STAGING = 'https://api-staging.metalinkclearer.workers.dev';
  var SYNC_API_BASE_LOCAL = 'http://localhost:8787';

  // 頁面上兩處環境標籤共用同一份判斷邏輯(見 renderEnvBadge):頁首標題
  // 旁與「紀錄」卡頭旁,對應 options.html 的 #envBadge/#envBadgeHistory。
  var ENV_BADGE_IDS = ['envBadge', 'envBadgeHistory'];

  // apiBase 只有這三個合法值（D9）。這個值唯一的去處是權限描述子的 origin，
  // 照單全收等於讓 background 的任何一次形狀走樣（或訊息被冒名）變成「對任意
  // 網域請求權限」;夾到白名單內既安全，也不會讓 request 因為 origin 不在
  // 宣告內而直接失敗。
  function clampApiBase(value) {
    if (value === SYNC_API_BASE_STAGING) return SYNC_API_BASE_STAGING;
    if (value === SYNC_API_BASE_LOCAL) return SYNC_API_BASE_LOCAL;
    return SYNC_API_BASE_FALLBACK;
  }

  function isValidSyncState(state) {
    return !!state && typeof state === 'object' && SYNC_STATUSES.indexOf(state.status) !== -1;
  }

  // 防禦性整形，比照 sanitizeEntries 的慣例:形狀不對(非物件/status 不在
  // 白名單)一律退回 DEFAULT_SYNC_CARD_STATE;個別欄位型別不對就退回該欄位的
  // 安全預設，不整包丟棄——background 若只有某個欄位暫時給錯型別，UI 仍
  // 該顯示其餘正確欄位。
  function normalizeSyncCardState(state) {
    if (!isValidSyncState(state)) return DEFAULT_SYNC_CARD_STATE;
    return {
      status: state.status,
      email: typeof state.email === 'string' ? state.email : null,
      displayName: typeof state.displayName === 'string' ? state.displayName : null,
      avatarUrl: typeof state.avatarUrl === 'string' ? state.avatarUrl : null,
      lastSyncedAt: typeof state.lastSyncedAt === 'number' && isFinite(state.lastSyncedAt) ? state.lastSyncedAt : null,
      pendingCount: typeof state.pendingCount === 'number' && isFinite(state.pendingCount) ? state.pendingCount : 0,
      lastError: typeof state.lastError === 'string' ? state.lastError : null,
      apiBase: typeof state.apiBase === 'string' ? state.apiBase : '',
    };
  }

  // avatarUrl 縱深防禦(引擎端 sync.js 存入 syncState 前已用同一份 TCLCore
  // sanitize 過，這裡不信任那一層、自己在渲染端(DOM sink)再把關一次)。直接
  // 複用 TCLCore.sanitizeAvatarUrl(單一權威:https:// + host 以
  // googleusercontent.com 結尾，見 tcl-core.js)，不在本檔另養一份等價
  // 邏輯——兩處各自實作最容易在其中一處修正網釣變體時漏改另一處。
  function isTrustedAvatarUrl(url) {
    return TCLCore.sanitizeAvatarUrl(url) !== null;
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
    // runtime 是選配依賴(chrome.runtime 形狀:sendMessage({type,...}) →
    // Promise<response>)，車道 D 的同步引擎完成前接線層可能還沒注入，
    // 或注入了但 background 端沒有對應 handler——兩種情況下面的
    // fetchSyncState/sendSyncAction 都要優雅退回，不丟例外、不卡渲染。
    var runtime = deps.runtime || null;
    // permissions 是選配依賴(chrome.permissions 形狀:contains/request 回
    // Promise<boolean>)。identity 與後端 host 走 optional 權限(D8)，而
    // chrome.permissions.request 只能在使用者手勢中呼叫——service worker 自行
    // 發起一律失敗，所以「求權限」這一半只能落在登入按鈕的 click handler 裡。
    var permissionsApi = deps.permissions || null;

    var entries = [];
    var locale = 'zh';
    var langPref = null; // null = 未設定，跟隨瀏覽器
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
    // 確認框(confirmOverlay)當前掛的動作:清除全部 / 刪除這筆 / 雲端同步
    // 登入 / 刪除雲端資料共用同一個 modal，confirmOk 點擊時執行這顆(見
    // openConfirm/closeConfirm)。
    var confirmAction = null;
    // 雲端同步卡片目前顯示的狀態，預設未登入(見 DEFAULT_SYNC_CARD_STATE)。
    // init() 會非同步向 background 要一次真值(fetchSyncState)，接線層則
    // 透過 setSyncState 轉發 background 的 sync.stateChanged 廣播。
    var syncState = DEFAULT_SYNC_CARD_STATE;
    // 刪除雲端資料是 fire-and-forget:送出當下就樂觀顯示已完成的 toast，
    // 這顆旗標記著「下一次 setSyncState 要順便檢查 lastError，非 null
    // 就把樂觀 toast 蓋成錯誤訊息」，見 acctDeleteBtn 的 click handler 與
    // setSyncState。
    var pendingDeleteCloudToast = false;
    // chrome.storage.local.syncState 的帳號同步狀態(計劃 4.2，與上面那顆
    // 卡片狀態是兩回事)。刪除與清除全部依它的 userId 分流(D6:未登入行為與
    // 現況完全一致)。
    var syncAccount = TCLCore.normalizeSyncState(null);

    function isSignedIn() {
      return nonEmptyString(syncAccount.userId) !== null;
    }

    // 從 storage 重讀帳號同步狀態、併進 patch，回傳「要寫回去的整包」(整包
    // 寫回，不夾帶未知鍵)。實際落盤交給呼叫端，好與 history 併成同一次 set。
    //
    // 【競態】基底一定重讀，不用開頁快照:cursor／lastSyncedAt／lastError 由
    // service worker 的同步引擎持續維護，拿快照整包覆寫等於把頁面開著這段期間
    // 引擎推進的游標回捲，下一輪重拉一大段增量，最壞情況是把使用者早就刪掉的
    // 雲端資料又拉回來。重讀失敗才退回用快照。
    function nextSyncAccount(patch) {
      return Promise.resolve(localStore.get({ [SYNC_ACCOUNT_KEY]: null })).then(
        function (stored) {
          return TCLCore.normalizeSyncState(
            Object.assign({}, TCLCore.normalizeSyncState(stored && stored[SYNC_ACCOUNT_KEY]), patch)
          );
        },
        function () {
          return TCLCore.normalizeSyncState(Object.assign({}, syncAccount, patch));
        }
      );
    }

    // 畫面、統計、圖表與匯出共用的可見清單:墓碑留在 entries(它是待上傳的
    // 刪除意圖)，但四處一律看不到它——漏掉任一處就會出現「清單看不到、統計
    // 卻多一筆」的分岔。
    function visibleEntries() {
      return liveEntries(entries);
    }

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
      var stats = aggregateStats(visibleEntries(), now());
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
      // 無資料時 maxV 取 1，基線與格線仍可畫，不做除以零。
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

        // 命中帶:整欄高度，比 mark 本身大，滑鼠好命中。
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

    // 配額超限判斷走 TCLCore.isQuotaExceededError(與 background 寫入側、sync
    // 引擎共用同一份字串比對)。

    // 回傳 Promise 給呼叫端(成功/失敗都 resolve，不 reject):寫入前先記住
    // 現值，失敗(常見:storage.local 配額寫爆)時把記憶體 entries 回滾成
    // 寫入前的值，避免磁碟寫失敗、記憶體卻已經前進造成分岔。呼叫端據
    // res.ok 決定發成功/失敗 toast，res.quota 供挑配額/一般兩種失敗文案。
    // extraItems 會併進同一次 set:chrome.storage.local.set 一次提交多個鍵，
    // 要嘛一起落地要嘛都不落地。清除全部靠它把「雲端水位線」與「清空本機」寫
    // 成同一次原子寫入，不留「本機已清空、水位線沒寫」的半套狀態——那會讓下
    // 次同步把整份雲端資料原封不動拉回來。
    function persistHistory(list, extraItems) {
      var prev = entries;
      entries = list;
      return Promise.resolve()
        .then(function () {
          var items = Object.assign({}, extraItems || {});
          items[HISTORY_KEY] = list;
          return localStore.set(items);
        })
        .then(function () {
          return { ok: true };
        })
        .catch(function (err) {
          entries = prev;
          if (typeof console !== 'undefined') console.error('[threads-clean-link] 寫入紀錄失敗', err);
          return { ok: false, quota: TCLCore.isQuotaExceededError(err) };
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

    // ---- 共用確認框(清除全部 / 刪除這筆 / 登入)----
    // 複用同一個 confirmOverlay:opts.titleKey/okKey 是 i18n key，desc 是已
    // 組好的字串，action 是確認後要跑的函式。標題/確認鈕文案在 JS 端顯式
    // 覆寫(這兩顆有 data-i18n，renderAll 會重設，但確認框開著時不會觸發
    // renderAll，故安全)。
    //
    // opts.tone('danger'|'primary')/opts.icon('#i-xxx')決定標題圖示與確認
    // 鈕外觀:刪除類操作維持既有的垃圾桶圖示 + 紅底實心鈕，登入類操作(見
    // startSignInFlow)改成 Google G 圖示 + 品牌色實心鈕，不能沿用紅色——
    // 登入不是破壞性操作，紅底會誤導使用者以為按下去會刪東西。兩者都不給
    // 時保守預設回刪除類外觀，維持既有呼叫點(清除全部/刪單筆/刪雲端)行為
    // 不變。
    function openConfirm(opts) {
      var titleText = byId('confirmTitleText');
      if (titleText) titleText.textContent = tt(opts.titleKey);
      var descEl = byId('confirmDesc');
      if (descEl) descEl.textContent = opts.desc;
      var okBtn = byId('confirmOk');
      if (okBtn) okBtn.textContent = tt(opts.okKey);
      var isPrimary = opts.tone === 'primary';
      var iconHref = opts.icon || (isPrimary ? '#i-google' : '#i-trash');
      var iconEl = byId('confirmIcon');
      if (iconEl) iconEl.classList.toggle('danger-ink', !isPrimary);
      var iconUse = byId('confirmIconUse');
      if (iconUse) iconUse.setAttribute('href', iconHref);
      if (okBtn) {
        okBtn.classList.toggle('btn-danger-solid', !isPrimary);
        okBtn.classList.toggle('btn-primary', isPrimary);
      }
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

    // ---- 頁首帳號入口 ----

    // 跟 background 要一次目前狀態(頁面載入時呼叫一次)。runtime 未注入、
    // sendMessage 拋例外、或 background 端沒有對應 handler(MV3 對無人接聽
    // 的訊息一律 resolve(undefined) 或 reject)都退回 DEFAULT_SYNC_CARD_STATE，
    // 讓帳號入口優雅顯示未登入態，不因車道 D 還沒做完就卡住整頁。
    function fetchSyncState() {
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        return Promise.resolve(DEFAULT_SYNC_CARD_STATE);
      }
      var result;
      try {
        result = runtime.sendMessage({ type: 'sync.getState' });
      } catch (e) {
        return Promise.resolve(DEFAULT_SYNC_CARD_STATE);
      }
      return Promise.resolve(result).then(normalizeSyncCardState, function () {
        return DEFAULT_SYNC_CARD_STATE;
      });
    }

    // 觸發式動作(signIn/signOut/now/deleteCloud):fire-and-forget，後續
    // UI 更新一律等 background 廣播 sync.stateChanged(由接線層轉呼叫
    // setSyncState)，這裡不用回應值直接改畫面——避免兩條更新路徑互相
    // 打架。runtime 未注入或呼叫失敗時安靜吞掉，不丟例外。
    function sendSyncAction(message) {
      if (!runtime || typeof runtime.sendMessage !== 'function') return;
      try {
        var result = runtime.sendMessage(message);
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (e) {
        // 同上，優雅退回。
      }
    }

    // 顯示名字:displayName 優先，缺席退回 email 的 @ 前段;兩者皆缺回
    // 空字串(理論上不會發生——已登入態至少會有其中一個，防禦性寫法)。
    function accountDisplayName(s) {
      var name = nonEmptyString(s.displayName);
      if (name !== null) return name;
      var email = nonEmptyString(s.email);
      if (email === null) return '';
      var at = email.indexOf('@');
      return at > 0 ? email.slice(0, at) : email;
    }

    // 頭像首字母備援:優先取名字首字，缺席退回 email 首字，全域大寫。
    function accountInitial(s) {
      var name = accountDisplayName(s);
      if (name) return name.slice(0, 1).toUpperCase();
      var email = nonEmptyString(s.email);
      return email ? email.slice(0, 1).toUpperCase() : '';
    }

    // 三處頭像(頁首觸發鈕/選單頂部帳號列)共用同一份切換邏輯:img 與字母
    // 互斥顯示，img 只在 avatarUrl 通過白名單時才設 src(縱深防禦，引擎端
    // 也會白名單，見 isTrustedAvatarUrl)。img 載入失敗(onerror)一律退回
    // 字母，不留一顆破圖示。
    var AVATAR_INSTANCES = [
      { circle: 'avatarCircle', letter: 'avatarLetter', photo: 'avatarPhoto' },
      { circle: 'acctMenuAvatarCircle', letter: 'acctMenuAvatarLetter', photo: 'acctMenuAvatarPhoto' },
    ];
    function renderAvatars(initial, avatarUrl) {
      // 取 TCLCore 解析後的 href(已正規化，不含控制字元/前後空白)當實際要
      // 設進 img.src 的值，不是呼叫端傳進來的原始字串——通過驗證跟拿什麼值
      // 落地是同一次判斷，兩處各自取值容易在其中一處漏改。
      var safeUrl = TCLCore.sanitizeAvatarUrl(avatarUrl);
      var usePhoto = safeUrl !== null;
      AVATAR_INSTANCES.forEach(function (a) {
        var letterEl = byId(a.letter);
        var photoEl = byId(a.photo);
        var circleEl = byId(a.circle);
        if (letterEl) {
          letterEl.textContent = initial;
          letterEl.hidden = usePhoto;
        }
        if (photoEl) {
          photoEl.hidden = !usePhoto;
          photoEl.onerror = function () {
            // 大頭照載入失敗(網路問題/連結失效):退回字母，不留破圖。順手清
            // 掉 src——同一顆失效網址若原封不動再次指派給 img.src，瀏覽器
            // 會判定「值沒變」而不重新發起請求、onerror 也就不會再觸發，下
            // 次 renderAvatars 想重試就卡住;清空後下次指派必為一次真正的
            // 新賦值。
            photoEl.hidden = true;
            if (letterEl) letterEl.hidden = false;
            if (circleEl) circleEl.classList.remove('has-photo');
            if (typeof photoEl.removeAttribute === 'function') photoEl.removeAttribute('src');
          };
          if (usePhoto) photoEl.src = safeUrl;
          else if (typeof photoEl.removeAttribute === 'function') photoEl.removeAttribute('src');
        }
        if (circleEl) circleEl.classList.toggle('has-photo', usePhoto);
      });
    }

    // 帳號入口五態的顯示模式:登入過期是從 signed_out + lastError 推導出
    // 的 UI 概念(docs/cloud-sync.md 5.2 節的 status 枚舉本身沒有 expired)，
    // 且必須有 email/displayName 其中之一才能分辨——沒有這兩者，畫面上
    // 沒有帳號資訊可顯示「重新登入哪個帳號」，退回未登入外觀。
    function accountMode(s) {
      var hasIdentity = nonEmptyString(s.email) !== null || nonEmptyString(s.displayName) !== null;
      if (s.status === 'signed_out' && s.lastError === 'session_expired' && hasIdentity) return 'expired';
      if (s.status === 'signed_out') return 'signedOut';
      // 縱深:引擎在沒有 token 時只送 signed_out(sync.js 的 statusOf)，但真
      // 的收到無身分的 error 也不畫幽靈帳號卡片——沒有 email／displayName 就
      // 沒有帳號可重試，那張卡片的每一顆按鈕都是死的。
      if (s.status === 'error' && !hasIdentity) return 'signedOut';
      if (s.status === 'syncing') return 'syncing';
      if (s.status === 'error') return 'error';
      return 'signedIn';
    }

    // 純函式風格的更新器:只依 state 決定畫面，不讀寫其他外部狀態(entries
    // 除外——僅在登入確認框組文案時讀取，不在這裡改動)。未登入/其餘四態
    // 共用同一份觸發鈕與選單 DOM，用 hidden 切換;deviceNote 那一列(紀錄
    // 清單卡片頁尾)也在此一併更新，因為它的文案同樣隨登入態切換(見
    // options.html 的 #deviceNote 註解)。
    // 頁首標題(h1)與「紀錄」卡頭旁各一顆環境標籤(ENV_BADGE_IDS):狀態
    // 來源同 renderAccount 的 state.apiBase(docs/cloud-sync.md 5.2 節),
    // 跟登入態無關——未登入也要顯示,讓開發時誤連正式環境或忘記切換環境
    // 一眼可辨。只認 SYNC_API_BASE_STAGING/SYNC_API_BASE_LOCAL 這兩個白
    // 名單值,其餘(含正式環境、background 無回應時的空字串退回值)一律
    // 隱藏;顯示文字固定英文小寫、不經 i18n,且只印這兩顆常數字串,不把
    // apiBase 原始值印進 DOM(縱深防禦——即便 background 端形狀走樣,也
    // 不會有任意字串落地)。兩顆標籤同一份判斷結果,逐一套用,不會有其中
    // 一顆漏更新。
    function renderEnvBadge(apiBase) {
      var isStaging = apiBase === SYNC_API_BASE_STAGING;
      var isLocal = apiBase === SYNC_API_BASE_LOCAL;
      ENV_BADGE_IDS.forEach(function (id) {
        var badge = byId(id);
        if (!badge) return;
        badge.classList.toggle('env-badge-staging', isStaging);
        badge.classList.toggle('env-badge-local', isLocal);
        if (isStaging) {
          badge.textContent = 'staging';
          badge.title = '目前連線環境：staging';
          badge.hidden = false;
        } else if (isLocal) {
          badge.textContent = 'local';
          badge.title = '目前連線環境：local';
          badge.hidden = false;
        } else {
          badge.textContent = '';
          badge.removeAttribute('title');
          badge.hidden = true;
        }
      });
    }

    function renderAccount(state) {
      var s = state || DEFAULT_SYNC_CARD_STATE;
      var mode = accountMode(s);
      var signedOut = mode === 'signedOut';
      renderEnvBadge(s.apiBase);

      var signInBtn = byId('acctSignInBtn');
      var trigger = byId('acctTrigger');
      if (signInBtn) signInBtn.hidden = !signedOut;
      if (trigger) trigger.hidden = signedOut;

      if (signedOut) {
        if (trigger) {
          trigger.setAttribute('aria-expanded', 'false');
          // 觸發鈕的 aria-label 重設回不帶狀態的基本文字(見下方 signedIn
          // 分支併狀態文字進 aria-label 那段)——同一份防殘留邏輯:忘記先
          // renderAccount 就重新顯示時，不該唸出上一態的「同步錯誤」。
          trigger.setAttribute('aria-label', tt('opAccountMenuLabel'));
        }
        var menuEl = byId('acctMenu');
        if (menuEl) menuEl.hidden = true;
        var deviceNoteEl0 = byId('deviceNote');
        if (deviceNoteEl0) deviceNoteEl0.textContent = tt('opDeviceNote');

        // 完整重設(回歸:曾經提早 return，從 expired/error 切回真正登出時，
        // 狀態點顏色、錯誤/過期列、姓名/信箱等文字會殘留上一態的內容——觸發
        // 鈕雖然 hidden，但選單內容本身沒清，下次顯示前若有任何路徑忘記先
        // 呼叫 renderAccount 就會露出舊資料)。
        var headerNameEl0 = byId('acctHeaderName');
        if (headerNameEl0) headerNameEl0.textContent = '';
        var menuNameEl0 = byId('acctMenuName');
        if (menuNameEl0) menuNameEl0.textContent = '';
        var menuEmailEl0 = byId('acctMenuEmail');
        if (menuEmailEl0) menuEmailEl0.textContent = '';
        var menuSubEl0 = byId('acctMenuSub');
        if (menuSubEl0) menuSubEl0.textContent = '';

        // 頭像三件(字母/img/圓框)一併重設(真機實證回歸:登出後兩顆 img
        // 的 src 沒清，下次任何帳號改用同一顆 img 元素前若又先渲染一次
        // 「有大頭照」以外的中繼態，舊圖會先閃現)。renderAvatars 走的是
        // 「usePhoto 才設 src」的邏輯，這裡直接手動清，不繞回
        // renderAvatars(登出態沒有 initial/avatarUrl 可傳)。
        AVATAR_INSTANCES.forEach(function (a) {
          var letterEl = byId(a.letter);
          var photoEl = byId(a.photo);
          var circleEl = byId(a.circle);
          if (letterEl) {
            letterEl.textContent = '';
            letterEl.hidden = false;
          }
          if (photoEl) {
            photoEl.hidden = true;
            // 清 src 的 IDL 屬性與底層 attribute 都要動:.src 是實際觸發
            // 瀏覽器發請求/快取圖片的那一份，只清 attribute 不夠(真機
            // 實證回歸)。
            photoEl.src = '';
            if (typeof photoEl.removeAttribute === 'function') photoEl.removeAttribute('src');
          }
          if (circleEl) circleEl.classList.remove('has-photo');
        });

        var dot0 = byId('statusDot');
        if (dot0) {
          dot0.classList.remove('is-danger', 'is-warning');
          dot0.hidden = true;
        }

        var errorRow0 = byId('acctErrorRow');
        if (errorRow0) errorRow0.hidden = true;
        var errorText0 = byId('acctErrorText');
        if (errorText0) errorText0.textContent = '';

        var expiredRow0 = byId('acctExpiredRow');
        if (expiredRow0) expiredRow0.hidden = true;
        var expiredText0 = byId('acctExpiredText');
        if (expiredText0) expiredText0.textContent = '';

        return;
      }

      var name = accountDisplayName(s);
      renderAvatars(accountInitial(s), s.avatarUrl);

      var headerNameEl = byId('acctHeaderName');
      if (headerNameEl) headerNameEl.textContent = name;
      var menuNameEl = byId('acctMenuName');
      if (menuNameEl) menuNameEl.textContent = name;
      var menuEmailEl = byId('acctMenuEmail');
      if (menuEmailEl) menuEmailEl.textContent = s.email || '';

      var wrap = byId('avatarWrap');
      if (wrap) wrap.classList.toggle('is-syncing', mode === 'syncing');

      var dot = byId('statusDot');
      // 狀態文字的 aria 通道只掛在觸發鈕(button)自己的 aria-label，不掛在
      // 巢狀 statusDot span 上——aria-label 只認最近的可及性物件，button
      // 已有自己的 aria-label 時，子節點的 aria-label 不會被讀屏器讀到
      // (回歸:曾經掛在 statusDot 上，讀屏器一律只唸出「帳號選單」)。
      var statusAriaKey = null;
      if (dot) {
        dot.classList.remove('is-danger', 'is-warning');
        if (mode === 'error') {
          dot.hidden = false;
          dot.classList.add('is-danger');
          statusAriaKey = 'opAccountStatusError';
        } else if (mode === 'expired') {
          dot.hidden = false;
          dot.classList.add('is-warning');
          statusAriaKey = 'opAccountStatusExpired';
        } else if (mode === 'signedIn') {
          dot.hidden = false;
          statusAriaKey = 'opAccountStatusSynced';
        } else {
          // syncing:規格只要求外圈轉圈，不疊角標小圓點，避免視覺過雜。
          dot.hidden = true;
        }
      }
      if (trigger) {
        trigger.setAttribute(
          'aria-label',
          statusAriaKey
            ? tf('opAccountMenuLabelStatus', { label: tt('opAccountMenuLabel'), status: tt(statusAriaKey) })
            : tt('opAccountMenuLabel')
        );
      }

      var hasError = mode === 'error' && typeof s.lastError === 'string' && s.lastError !== '';
      var errorRow = byId('acctErrorRow');
      var errorText = byId('acctErrorText');
      if (errorRow) errorRow.hidden = !hasError;
      if (errorText) errorText.textContent = hasError ? tt('opAccountErrorPrefix') + s.lastError : '';

      var expiredRow = byId('acctExpiredRow');
      var expiredText = byId('acctExpiredText');
      if (expiredRow) expiredRow.hidden = mode !== 'expired';
      // 靜態文案理論上靠 data-i18n 就會套上，這裡仍顯式覆寫一次:此列剛從
      // hidden 切到顯示時不需要等下一輪語言切換才補上正確文字。
      if (expiredText) expiredText.textContent = tt('opAccountExpired');

      var subEl = byId('acctMenuSub');
      if (subEl) {
        var timeText = s.lastSyncedAt !== null ? relTime(s.lastSyncedAt) : tt('opSyncNever');
        subEl.textContent = tf('opAccountLastSync', { t: timeText }) + ' · ' + tf('opAccountPending', { n: s.pendingCount });
      }

      var syncBtn = byId('acctSyncNowBtn');
      var syncLabel = byId('acctSyncLabel');
      // 登入過期時必須先重新登入，「立即同步」停用，逼使用者走上方的
      // 「重新登入」;同步中本來就在跑，同樣停用避免重複觸發。
      var syncDisabled = mode === 'syncing' || mode === 'expired';
      if (syncBtn) syncBtn.disabled = syncDisabled;
      if (syncLabel) {
        syncLabel.textContent = tt(
          mode === 'syncing' ? 'opAccountSyncing' : mode === 'error' ? 'opAccountRetry' : 'opAccountSyncNow'
        );
      }

      // deviceNote:expired 態的同步實質上沒在跑(等待重新登入)，比照
      // signedOut 顯示「僅保存於這台裝置」，避免謊報已同步。
      var deviceSynced = mode === 'signedIn' || mode === 'syncing' || mode === 'error';
      var deviceNoteEl = byId('deviceNote');
      if (deviceNoteEl) deviceNoteEl.textContent = tt(deviceSynced ? 'opDeviceNoteSynced' : 'opDeviceNote');
    }

    // 接線層在收到 background 的 {type:"sync.stateChanged"} 廣播時呼叫
    // (比照 setHistory/setSyncSettings 的既有模式:controller 只暴露方法，
    // 訊息監聽掛在 -init.js)。
    /**
     * 這一次廣播帶的一次性登入失敗(L5)。分類由引擎給(sync.js 的
     * signInKindOf)，本頁只決定出不出聲:
     *
     *   cancelled 靜音——使用者自己按的取消，不必再被通知一次。唯一例外是
     *             permission_required:在瀏覽器權限對話框按拒絕之後畫面毫無
     *             動靜，需要一句話解釋為什麼什麼都沒發生(沿用既有文案)。
     *   transient 一句「請稍後再試」，不顯示錯誤碼(對使用者沒有意義)。
     *   config    重試無用，帶出錯誤碼讓使用者報得出來。
     */
    function reportSignInFailure(transient) {
      if (!transient || typeof transient !== 'object') return;
      var code = nonEmptyString(transient.code);
      if (code === null) return;
      if (transient.kind === 'cancelled') {
        if (code === 'permission_required') toast(tt('opSyncPermissionDenied'));
        return;
      }
      if (transient.kind === 'transient') {
        toast(tt('opAccountSignInFailed'));
        return;
      }
      toast(tf('opAccountSignInConfigError', { code: code }));
    }

    // 有沒有可用的雲端工作階段。未登入與登入過期都沒有 token，任何需要
    // Bearer 的動作(sync.now／sync.deleteCloud)送到 background 也只會直接
    // return——按鈕看起來能按、按下去什麼都沒有，比停用更糟(刪雲端那顆還會
    // 彈一句樂觀的「已刪除雲端資料」，等於謊報)。這一態唯一有意義的動作是
    // 重新登入。
    function hasCloudSession() {
      var mode = accountMode(syncState);
      return mode !== 'signedOut' && mode !== 'expired';
    }

    function setSyncState(state) {
      // transientError 只活在這一次廣播裡，normalizeSyncCardState 不留它
      // (它不屬於持久狀態形狀)，因此先取下來。
      var transient = state ? state.transientError : null;
      syncState = normalizeSyncCardState(state);
      renderAccount(syncState);
      // 刪除雲端資料送出後掛的旗標:這是送出後的第一次廣播，順便檢查
      // 有沒有失敗——deleteCloud 是 fire-and-forget，這裡是唯一能得知
      // 結果的管道(見 acctDeleteBtn 的 click handler)。
      if (pendingDeleteCloudToast) {
        pendingDeleteCloudToast = false;
        if (syncState.lastError) toast(tt('opAccountErrorPrefix') + syncState.lastError);
      }
      reportSignInFailure(transient);
    }

    // 登入前的權限關卡:先探(contains)，缺才求(request)。使用者拒絕就不送出
    // sync.signIn——SW 端拿不到權限只會把狀態轉成 error/permission_required，
    // 白跑一趟。
    function ensureSyncPermissions() {
      var base = clampApiBase(syncState.apiBase);
      var descriptor = { permissions: ['identity'], origins: [base + '/*'] };
      return Promise.resolve(permissionsApi.contains(descriptor)).then(function (granted) {
        if (granted) return true;
        if (typeof permissionsApi.request !== 'function') return false;
        return Promise.resolve(permissionsApi.request(descriptor)).then(function (accepted) {
          return accepted === true;
        });
      }, function () {
        return false;
      });
    }

    // 登入/重新登入共用的入口:一律從共用確認框(#confirmOverlay)重新
    // 開始，內容依 D3 告知本機現有筆數、free 方案雲端保留上限、可隨時
    // 登出或刪除，確認後才走權限關卡送出 sync.signIn。
    function startSignInFlow() {
      openConfirm({
        titleKey: 'opAccountSignIn',
        okKey: 'opSyncSignInConfirmDo',
        tone: 'primary',
        icon: '#i-google',
        desc: tf('opSyncSignInConfirmDesc', { n: visibleEntries().length }),
        action: function () {
          // 沒有注入 permissions 時維持原本的直接送出(權限由 SW 端把關)。
          if (!permissionsApi || typeof permissionsApi.contains !== 'function') {
            sendSyncAction({ type: 'sync.signIn' });
            return;
          }
          ensureSyncPermissions().then(function (granted) {
            if (!granted) {
              // 使用者在權限對話框按了拒絕:沒有這一則 toast，畫面就是「按了
              // 確定但什麼都沒發生」，使用者會以為是壞掉。
              toast(tt('opSyncPermissionDenied'));
              return;
            }
            sendSyncAction({ type: 'sync.signIn' });
          });
        },
      });
    }

    // ---- 帳號選單開合(a11y):[hidden] 是唯一的無障礙開關來源(從可及性
    // 樹移除、不能被 Tab 到);動畫只發生在 [hidden] 被移除之後、加上
    // .is-open 之前那一小段時間窗(見 options.html 的 .acct-menu 註解，
    // reduced-motion 由 CSS 媒體查詢負責讓過渡瞬間完成，這裡不用 JS 另外
    // 偵測)。開啟時焦點進第一個可用項目，關閉一律回觸發鈕(不論何種
    // 關閉方式:點外/Esc/選單內動作)。 ----
    var ACCT_MENU_ANIM_MS = 120;

    // 目前可見且可操作的選單項目，依 DOM 順序——錯誤/過期提示列的按鈕
    // 靠自己所在列的 hidden 判斷(按鈕本身不帶 hidden)，其餘靠自身
    // disabled/hidden。用節點參照比對，不比對 el.id(避免依賴瀏覽器把
    // HTML id 屬性反射到 .id 屬性這件事——一律走 getElementById 拿到的
    // 同一個節點參照才是唯一可信來源)。
    function acctMenuFocusableItems() {
      var errorRow = byId('acctErrorRow');
      var expiredRow = byId('acctExpiredRow');
      var retryBtn = byId('acctRetryBtn');
      var reSignInBtn = byId('acctReSignInBtn');
      var syncBtn = byId('acctSyncNowBtn');
      var signOutBtn = byId('acctSignOutBtn');
      var deleteBtn = byId('acctDeleteBtn');
      var list = [];
      if (retryBtn && errorRow && !errorRow.hidden) list.push(retryBtn);
      if (reSignInBtn && expiredRow && !expiredRow.hidden) list.push(reSignInBtn);
      if (syncBtn && !syncBtn.disabled) list.push(syncBtn);
      if (signOutBtn) list.push(signOutBtn);
      if (deleteBtn) list.push(deleteBtn);
      return list;
    }

    function openAcctMenu() {
      var menu = byId('acctMenu');
      if (!menu) return;
      menu.hidden = false;
      menu.classList.remove('is-open'); // 保險:萬一上一輪關閉動畫還沒清掉。
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { menu.classList.add('is-open'); });
      } else {
        menu.classList.add('is-open');
      }
      var trigger = byId('acctTrigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
      var items = acctMenuFocusableItems();
      if (items[0] && typeof items[0].focus === 'function') {
        try { items[0].focus(); } catch (e) {}
      }
    }
    function closeAcctMenu() {
      var menu = byId('acctMenu');
      if (!menu || menu.hidden) return;
      menu.classList.remove('is-open');
      setTimeout(function () { menu.hidden = true; }, ACCT_MENU_ANIM_MS);
      var trigger = byId('acctTrigger');
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        if (typeof trigger.focus === 'function') {
          try { trigger.focus(); } catch (e) {}
        }
      }
    }

    // popup 導向的 #cloud-sync hash 舊行為是捲到雲端同步卡片;卡片已移除，
    // 改為捲回頁首並嘗試開啟帳號選單(未登入時沒有選單可開，退回聚焦登入
    // 鈕)，接線層在 init() resolve 後呼叫(見 options-init.js)。
    function focusAccountArea() {
      var area = byId('acctArea');
      if (area && typeof area.scrollIntoView === 'function') {
        area.scrollIntoView({ block: 'start' });
      }
      var trigger = byId('acctTrigger');
      if (trigger && !trigger.hidden) {
        openAcctMenu();
        return;
      }
      var signInBtn = byId('acctSignInBtn');
      if (signInBtn && typeof signInBtn.focus === 'function') {
        try { signInBtn.focus(); } catch (e) {}
      }
    }

    function bindAccount() {
      on('acctTrigger', 'click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        var menu = byId('acctMenu');
        if (!menu) return;
        if (menu.hidden) openAcctMenu();
        else closeAcctMenu();
      });

      // 方向鍵在選單項目間移動(Tab 走瀏覽器原生順序，這裡只補方向鍵)。
      on('acctMenu', 'keydown', function (ev) {
        if (!ev || (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp')) return;
        var items = acctMenuFocusableItems();
        if (!items.length) return;
        if (ev.preventDefault) ev.preventDefault();
        var active = document && document.activeElement;
        var idx = items.indexOf(active);
        var nextIdx;
        if (ev.key === 'ArrowDown') nextIdx = idx < 0 ? 0 : (idx + 1) % items.length;
        else nextIdx = idx <= 0 ? items.length - 1 : idx - 1;
        var next = items[nextIdx];
        if (next && typeof next.focus === 'function') {
          try { next.focus(); } catch (e) {}
        }
      });

      if (typeof document.addEventListener === 'function') {
        // 點選單以外的地方關閉(比照 moreMenu/chipsRow 的既有模式)。
        document.addEventListener('click', function (ev) {
          var menu = byId('acctMenu');
          if (!menu || menu.hidden) return;
          var area = byId('acctArea');
          var target = ev && ev.target;
          var inside = !!area && typeof area.contains === 'function' && !!target && area.contains(target);
          if (!inside) closeAcctMenu();
        });
        // Esc 關閉選單(與既有對話框的 Esc 處理是獨立的兩條監聽，互不影響)。
        document.addEventListener('keydown', function (ev) {
          if (!ev || ev.key !== 'Escape') return;
          var menu = byId('acctMenu');
          if (menu && !menu.hidden) closeAcctMenu();
        });
      }

      on('acctSignInBtn', 'click', function () {
        startSignInFlow();
      });
      on('acctReSignInBtn', 'click', function () {
        closeAcctMenu();
        startSignInFlow();
      });
      on('acctRetryBtn', 'click', function () {
        closeAcctMenu();
        if (!hasCloudSession()) return;
        sendSyncAction({ type: 'sync.now' });
      });
      on('acctSyncNowBtn', 'click', function () {
        var btn = byId('acctSyncNowBtn');
        if (btn && btn.disabled) return;
        closeAcctMenu();
        if (!hasCloudSession()) return;
        sendSyncAction({ type: 'sync.now' });
      });
      on('acctSignOutBtn', 'click', function () {
        closeAcctMenu();
        sendSyncAction({ type: 'sync.signOut' });
      });
      // 刪除雲端資料一樣走確認框，措辭明講三件事:無法復原、本機保留、
      // 這些紀錄不會再上傳到雲端(避免與清除全部紀錄的本機刪除混淆)。
      on('acctDeleteBtn', 'click', function () {
        closeAcctMenu();
        if (!hasCloudSession()) return;
        openConfirm({
          titleKey: 'opAccountDeleteCloud',
          okKey: 'opSyncDeleteConfirmDo',
          tone: 'danger',
          icon: '#i-trash',
          desc: tt('opSyncDeleteConfirmDesc'),
          action: function () {
            sendSyncAction({ type: 'sync.deleteCloud' });
            // deleteCloud 是 fire-and-forget，送出當下先樂觀提示已完成；
            // 若下一次 stateChanged 帶回 lastError，setSyncState 會把這
            // 顆 toast 蓋成錯誤訊息(見 pendingDeleteCloudToast)。
            pendingDeleteCloudToast = true;
            toast(tt('opToastCloudDeleted'));
          },
        });
      });
    }

    // 網址拆解只為了視覺強調帳號段;一律 textContent/createTextNode，
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
    // 以 url+at 精準命中(不只比 url):background 已改為永久合併(同一篇貼文
    // 恆為一張卡，見 background.js 的紀錄合併區塊)，但匯入的資料可能夾帶同
    // url 的多筆舊紀錄，比 url+at 才保證「刪一筆只刪中一筆」。setHistory 已
    // 把 detailEntry 換成清單裡的新物件(見 refreshDetail)，at 不會過期，精
    // 準比對成立。
    //
    // 沒有真的命中(例如已被別的分頁/storage 同步事件、或「清除全部」先
    // 移除)就不寫入、不動視窗、也不發「已刪除」成功 toast，避免對使用者
    // 謊報一個沒發生的動作。寫入失敗(配額)走 onPersistFailed 回滾+失敗
    // toast，不謊報成功。
    //
    // 【依登入態分流】已登入時是軟刪:entry 留在陣列，寫下 deletedAt 墓碑 +
    // dirty，等伺服器 ack 才真的移除(墓碑不進畫面，見 visibleEntries)。未登
    // 入維持現況硬刪(D6:「僅保存於這台裝置」的承諾在未登入時必須成立)。
    // 兩條路徑都不換 id——伺服器要靠它認出刪的是哪一張卡。
    function deleteEntry(e) {
      var hit = false;
      var deletedAt = now();
      var next = [];
      entries.forEach(function (x) {
        var match = !hit && x.url === e.url && x.at === e.at;
        if (!match) {
          next.push(x);
          return;
        }
        hit = true;
        if (isSignedIn()) next.push(Object.assign({}, x, { deletedAt: deletedAt, dirty: true }));
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
        // 會把重複的 author 丟棄(只剩 handle)，列不能因此整個消失。
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
        // 同卡片端:author 被去重丟棄、只剩 handle 時，列仍要顯示。
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
          tone: 'danger',
          icon: '#i-trash',
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
      var matched = filterEntries(visibleEntries(), activeKind, query);
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
      // applyI18nDom 會用 data-i18n 重設 deviceNote 等文字，renderAccount
      // 必須排在它後面才能把已登入態的文案蓋回去。
      renderAccount(syncState);
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
        var payload = buildExportPayload(visibleEntries(), new Date(now()).toISOString());
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
          tone: 'danger',
          icon: '#i-trash',
          desc: tf('opClearConfirmDesc', { n: visibleEntries().length }),
          // 已登入時 entry 全數移除(不是逐筆轉墓碑——那會把整張表變成墓碑
          // 撐爆配額)，改寫 syncState.clearedAt 這條全域水位線，由同步引擎
          // 上傳。未登入不動 syncState。
          //
          // 【原子性】水位線與清空寫在同一次 set(見 persistHistory 的
          // extraItems)。分兩次寫的話，兩步之間分頁被關掉會留下「本機已清空、
          // 雲端水位線沒寫」，下次同步就把整份雲端資料拉回來，使用者眼中是
          // 「清了又自己長回來」。
          action: function () {
            var signedIn = isSignedIn();
            var prepared = signedIn ? nextSyncAccount({ clearedAt: now() }) : Promise.resolve(null);
            prepared
              .then(function (nextAccount) {
                var extra = null;
                if (nextAccount) {
                  extra = {};
                  extra[SYNC_ACCOUNT_KEY] = nextAccount;
                }
                return persistHistory([], extra).then(function (res) {
                  // 寫成功才更新記憶體快照，失敗時 persistHistory 已回滾
                  // entries，這裡一併保持 syncAccount 與 storage 一致。
                  if (res.ok && nextAccount) syncAccount = nextAccount;
                  return res;
                });
              })
              .then(function (res) {
                if (!res.ok) {
                  onPersistFailed(res);
                  return;
                }
                // 線上時立刻推一次:clearedAt 只是「待送出」旗標，等下一個週期
                // alarm 才送的話，這段空窗內寫入的新紀錄會被伺服器的 cleared_at
                // 連坐拒收(見 docs/cloud-sync.md 第 6 節已知限制)。
                if (signedIn) sendSyncAction({ type: 'sync.now' });
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
      var readLocal = Promise.resolve(localStore.get({ [HISTORY_KEY]: [], [SYNC_ACCOUNT_KEY]: null }));
      return Promise.all([readSync, readLocal]).then(function (results) {
        var settings = results[0] || {};
        var localData = results[1] || {};
        entries = sanitizeEntries(localData[HISTORY_KEY]);
        syncAccount = TCLCore.normalizeSyncState(localData[SYNC_ACCOUNT_KEY]);

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
        bindAccount();
        renderAll();

        // 雲端同步狀態非同步取得，先以 DEFAULT_SYNC_CARD_STATE(未登入)完成首次
        // 繪製(above 的 renderAll)，真值回來後才刷新。init() 等這步結束
        // 才 resolve，讓呼叫端 await controller.init() 後畫面已是最終狀態，
        // 不需另外猜測時序;runtime 未注入或 background 沒回應時
        // fetchSyncState 立即 resolve(見該函式)，不會拖慢 init()。
        return fetchSyncState().then(function (state) {
          syncState = state;
          renderAccount(syncState);
        });
      });
    }

    // storage.onChanged(local 區)時由接線層呼叫，讓 background 新寫入的
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

    return {
      init: init,
      setHistory: setHistory,
      setSyncSettings: setSyncSettings,
      refresh: refresh,
      setSyncState: setSyncState,
      focusAccountArea: focusAccountArea,
    };
  }

  var api = {
    OPTIONS_DEFAULT_SETTINGS: OPTIONS_DEFAULT_SETTINGS,
    DEFAULT_SYNC_CARD_STATE: DEFAULT_SYNC_CARD_STATE,
    normalizeSyncCardState: normalizeSyncCardState,
    isTrustedAvatarUrl: isTrustedAvatarUrl,
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
