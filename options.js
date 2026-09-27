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

  // 取 pages 含 'options' 的開關，細節見 TCLCore.SETTINGS_SCHEMA。
  var SETTINGS = TCLCore.SETTINGS_SCHEMA.filter(function (s) {
    return s.pages.indexOf('options') !== -1;
  });
  function settingDefaults(area) {
    return Object.fromEntries(
      SETTINGS.filter(function (s) { return s.area === area; }).map(function (s) { return [s.key, s.def]; })
    );
  }
  var OPTIONS_DEFAULT_SETTINGS = settingDefaults('sync');

  // storage 值必須真的是 boolean 才採用，否則退回 schema 的 def(防損毀或
  // 偽造的非布林值直接綁上 checkbox;被整顆移除時也走這條)。
  function settingValue(value, def) {
    return typeof value === 'boolean' ? value : def;
  }

  var HISTORY_KEY = 'history';
  // 投資詐騙黑名單(v1 計畫 §5):純本機、只有 background 寫，本頁讀＋監聽
  // onChanged。
  var SCAM_BLOCKLIST_KEY = 'scamBlocklist';
  // 帳號同步狀態(docs/cloud-sync.md 4.2)。options 只讀 userId 判斷登入
  // 態，不寫入;全部欄位由同步引擎維護。
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
        var url = TCLCore.trimEndChars(part, '),.;:!?、。」』');
        var a = doc.createElement('a');
        a.className = 'excerpt-link';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = url;
        el.appendChild(a);
        if (url.length < part.length) el.appendChild(doc.createTextNode(part.slice(url.length)));
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
  // 與 tcl-core.js 的 sanitizeRemovedParams 皆同);回傳物件用 name 是
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
    return formatDateOnly(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // 裝置列的「新增於」只取日期(YYYY-MM-DD):註冊時分對辨認哪一台沒有幫助，
  // 而且第二行還要並排「最後同步 <相對時間>」，塞不下完整時間戳。
  function formatDateOnly(ts) {
    var d = new Date(ts);
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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

  // ---- 雲端同步(消費 docs/cloud-sync.md 第 5 節的 state 形狀) ----

  // state.status 的合法枚舉，逐字照文件第 5.2 節。
  var SYNC_STATUSES = ['signed_out', 'signed_in', 'syncing', 'error'];

  // 帳號卡片的安全預設:未登入。也是 sync.getState 無回應／回應形狀不對時
  // 的退回值(見 fetchSyncState)。displayName/avatarUrl(docs/cloud-sync.md
  // 第 5.2 節)缺席一律視為 null——帳號入口的頭像/名字渲染需要備援到
  // email，見 renderAccount。
  //
  // 命名:DEFAULT_SYNC_CARD_STATE/normalizeSyncCardState 特意不叫
  // DEFAULT_SYNC_STATE/normalizeSyncState——TCLCore 已有同名的
  // normalizeSyncState(chrome.storage.local 的帳號同步狀態，形狀完全不同，
  // 見上面 syncAccount)，兩者撞名容易在呼叫端讀岔;這裡的
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
    // 雲端配額用罄而被淘汰(未上傳)的警示名單筆數。
    // 警示名單卡頭以小字提示，見 renderScamEvictedHint。
    marksEvicted: 0,
  };

  // 權限描述子的 origin 來源:state.apiBase 尚未從 background 回來時的退回值。
  // production／staging 的 host 宣告在商店版 manifest 的
  // optional_host_permissions;local 只宣告在 tools/dev-browser.mjs 產出的
  // 開發用 manifest 副本裡，商店版沒有這一項，request 自然拿不到。
  var SYNC_API_BASE_FALLBACK = TCLCore.API_BASE_PRODUCTION;
  var SYNC_API_BASE_STAGING = TCLCore.API_BASE_STAGING;
  var SYNC_API_BASE_LOCAL = TCLCore.API_BASE_LOCAL;

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
      marksEvicted:
        typeof state.marksEvicted === 'number' && isFinite(state.marksEvicted) && state.marksEvicted > 0
          ? state.marksEvicted
          : 0,
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
    // Promise<response>)。未注入或 background 端沒有對應 handler 時，下面的
    // fetchSyncState/sendSyncAction 都要優雅退回，不丟例外、不卡渲染。
    var runtime = deps.runtime || null;
    // permissions 是選配依賴(chrome.permissions 形狀:contains/request 回
    // Promise<boolean>)。identity 與後端 host 走 optional 權限(D8)，而
    // chrome.permissions.request 只能在使用者手勢中呼叫——service worker 自行
    // 發起一律失敗，所以「求權限」這一半只能落在登入按鈕的 click handler 裡。
    var permissionsApi = deps.permissions || null;
    // 分頁路由要碰的瀏覽器物件。本檔刻意不碰全域(見檔頭註解)，window 與
    // location 一律由呼叫端注入;兩者缺席時 bindTabs 靜默停用，其餘功能不受
    // 影響(舊測試的 DOM stub 沒有分頁列也走這條)。
    var win = deps.window || null;
    var loc = deps.location || (win ? win.location : null);

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
    // 確認框(confirmOverlay)當前掛的動作:清除全部 / 刪除這筆 / 雲端同步
    // 登入 / 刪除雲端資料共用同一個 modal，confirmOk 點擊時執行這顆(見
    // openConfirm 與 confirmOverlay 的 close 善後)。
    var confirmAction = null;
    // 雲端同步卡片目前顯示的狀態，預設未登入(見 DEFAULT_SYNC_CARD_STATE)。
    // init() 會非同步向 background 要一次真值(fetchSyncState)，接線層則
    // 透過 setSyncState 轉發 background 的 sync.stateChanged 廣播。
    var syncState = DEFAULT_SYNC_CARD_STATE;
    // 刪除雲端資料送出當下先顯示「正在刪除」的 toast，最後依 sync.deleteCloud
    // 的回應定案。回應形狀不明時以這顆旗標退回廣播判讀:
    // 下一則非 syncing 的 setSyncState 若帶 lastError 就蓋成錯誤訊息，轉成已
    // 登出就換成「已刪除、已登出」。見 acctDeleteBtn 的 click handler 與
    // setSyncState。
    var pendingDeleteCloudToast = false;
    // 退路旗標已經顯示過的定案文字。回應隨後抵達、結論相同時不再重複顯示。
    var deleteCloudFallbackText = null;
    // 裝置清單快取(純顯示層，計畫 §4):{ devices, currentDeviceId, defaultName }。
    // null 代表「還沒有任何清單」——與「取到 0 台」是兩回事，後者要畫空狀態。
    // 取清單失敗一律不清這份快取(§12)，只把 devicesLoadError 立起來。
    var deviceCache = null;
    var devicesLoadError = false;
    // 裝置列的節點登錄簿(deviceId → { row, nameRow, nameBtn, pill, renameBtn,
    // input })。最小 DOM stub 沒有 querySelector，行內改名要改哪幾顆節點全
    // 靠這份登錄簿定位;renderDevices 每次重建列時整份重置。
    var deviceRowRefs = {};
    // 清單往返的節流(§12 增補「台數來源」):一次往返同時服務「開選單看台數」
    // 與「開對話框看清單」兩件事——第一次開選單時完全沒有清單可顯示，先打一
    // 次把台數填上;之後每次開對話框才再打一次刷新(30 秒節流在引擎端)，同一
    // 輪「開選單→開對話框」不重複往返。
    var devicesEverFetched = false;
    var devicesFetchedThisMenu = false;
    // chrome.storage.local.syncState 的帳號同步狀態(計劃 4.2，與上面那顆
    // 卡片狀態是兩回事)。刪除與清除全部依它的 userId 分流(D6:未登入行為與
    // 現況完全一致)。
    var syncAccount = TCLCore.normalizeSyncState(null);
    // chrome.storage.local.scamBlocklist 的正規化複本(見 readScamBlocklist)。
    // init 讀一次，之後由 onStorageChanged 整包換新。
    var scamBlocklist = readScamBlocklist(null);

    function isSignedIn() {
      return nonEmptyString(syncAccount.userId) !== null;
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

    // HTML 元素工廠:建立 tag，依 props 設定屬性與事件，再依序掛上 children。
    // 規則(與測試的最小 DOM stub 相容，違反會出現假紅或假綠):
    // - 值為 null/undefined 的 prop 略過;false 照樣賦值(disabled/hidden
    //   需要明確的 false)。children 裡的 null/undefined/false 略過，供條件節點用。
    // - 單一文字一律走 text prop(textContent)，不當字串 child 傳:stub 的
    //   textContent getter 不彙總子節點。只有文字與元素混排才用字串 child。
    //   text 先於 children 設定，因為對 textContent 賦值會清空既有子節點。
    // - class → className;dataset → 併入 el.dataset;onXxx → addEventListener('xxx')，
    //   stopPropagation 等語意寫在 handler 內。
    // - aria-*、data-*、role、tabindex 走 setAttribute(測試以 getAttribute 讀);
    //   其餘(type/title/href/target/rel/disabled/hidden/value)直接屬性賦值。
    // - 不處理 SVG namespace，圖示一律用 svgUse/svgEl 產生後當 child 傳入。
    function h(tag, props, ...children) {
      var el = document.createElement(tag);
      var p = props || {};
      Object.keys(p).forEach(function (k) {
        var v = p[k];
        if (v == null) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (/^(aria-|data-)/.test(k) || k === 'role' || k === 'tabindex') el.setAttribute(k, String(v));
        else el[k] = v;
      });
      children.forEach(function (c) {
        if (c == null || c === false) return;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
      return el;
    }

    // 純圖示按鈕:type=button，title 與 aria-label 同為 label，內含單一 svgUse 圖示。
    // extra 可覆寫或補上任何 prop(例如 aria-label 需要附帶對象名稱時)。
    function iconButton(cls, href, label, onclick, extra) {
      var props = { type: 'button', class: cls, title: label, 'aria-label': label, onclick: onclick };
      return h('button', Object.assign(props, extra), svgUse(href, 'icon'));
    }

    // 外開文字連結:一律新分頁;rel 預設 noopener noreferrer(證據連到的是詐騙招攬
    // 貼文，不讓對方頁面拿到 window.opener 與來源)。title、ariaLabel 為空時不設。
    function externalLink(cls, href, text, opts) {
      var o = opts || {};
      return h('a', {
        class: cls, href: href, target: '_blank', rel: o.rel || 'noopener noreferrer', text: text,
        title: o.title || null, 'aria-label': o.ariaLabel || null,
      });
    }

    // ---- toast ----
    var toastTimer = null;
    // #toast 是 manual popover。每次都先 hidePopover 再 showPopover，讓它重新
    // 排到 top layer 最上層:對話框開著時才疊得到遮罩之上。淡出只移除 .show，
    // 元素留在 top layer 直到下一次顯示。
    function toast(msg) {
      var el = byId('toast');
      if (!el) return;
      el.textContent = msg;
      if (typeof el.showPopover === 'function') {
        hidePop(el);
        el.showPopover();
      }
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        el.classList.remove('show');
      }, 2200);
    }

    // ---- i18n 套用 ----
    // 靜態文案交給 i18n.applyDom(四組 data-i18n 屬性與 html lang)，本頁只
    // 補語言鈕自己的標示。
    function applyI18nDom() {
      i18n.applyDom(document, locale);
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
      // 回寫 localStorage 的主題鏡像（theme-init.js 的 TCLTheme.remember），
      // 下次開頁由 head 裡的 theme-init.js 同步套用，第一幀就是正確配色。
      deps.themeMirror?.(themePref);
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
          var up = delta >= 0;
          var deltaText = (up ? '▲ ' : '▼ ') + Math.abs(delta) + '%';
          weekMeta.appendChild(h('span', { class: up ? 'delta-up' : null, text: deltaText }));
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
    function persistHistory(list) {
      var prev = entries;
      entries = list;
      return Promise.resolve()
        .then(function () {
          var items = {};
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
    // 重繪回滾後的紀錄視圖並發專屬失敗 toast(配額/一般兩種文案)。
    function onPersistFailed(res) {
      render(['history']);
      toast(tt(res && res.quota ? 'opToastStorageFull' : 'opToastSaveFailed'));
    }

    // ---- 對話框(原生 <dialog> + showModal) ----
    // 7 個對話框都是 <dialog class="dlg">。showModal 負責 top layer 疊放(依開啟
    // 順序)、底層 inert、Esc 只關最上層、焦點移到 autofocus 節點，關閉時把焦點
    // 還給開啟前的元素。判斷開著沒有一律讀 dialog.open。
    //
    // 善後(清狀態、補焦點落點)一律寫在 close 事件，不寫在 cancel:Chrome 120
    // 起 Esc 走 CloseWatcher，頁面沒有使用者互動時 cancel 可能不派送或不可取
    // 消，cancel 不可靠;close 則是 ✕、點遮罩、Esc、程式呼叫 close() 每一種關
    // 法都會到。close 事件由瀏覽器另排 task 派送，比 close() 晚一拍，所以善後
    // 清狀態前要再確認 dialog 沒被重新打開。
    //
    // 開啟前的焦點另記一份(dialogOpeners):點遮罩關閉時，mousedown 落在
    // dialog 本身會先把焦點移出對話框，瀏覽器的焦點還原只在焦點仍在對話框
    // 內時才發生，焦點因此掉到 body，要由 close 善後補還。
    var dialogOpeners = {};
    function showDialog(id) {
      var d = byId(id);
      if (d && !d.open && typeof d.showModal === 'function') {
        dialogOpeners[id] = document.activeElement || null;
        d.showModal();
      }
      return d;
    }
    function closeDialog(id) {
      var d = byId(id);
      if (d && d.open) d.close();
    }
    function isDialogOpen(id) {
      var d = byId(id);
      return !!(d && d.open);
    }
    // 接上關閉鈕、點遮罩與 close 善後。內容畫在內層 .modal，dialog 本身沒有
    // padding，所以點擊目標是 dialog 自己時就是點在 ::backdrop 上(closedby 要
    // Chrome 134 才有，這裡自己判斷)。
    function bindDialog(id, closeBtnId, onClose) {
      var d = byId(id);
      if (!d || typeof d.addEventListener !== 'function') return;
      if (closeBtnId) {
        on(closeBtnId, 'click', function () {
          closeDialog(id);
        });
      }
      d.addEventListener('click', function (ev) {
        if (ev && ev.target === d) closeDialog(id);
      });
      d.addEventListener('close', function () {
        if (d.open) return;
        var opener = dialogOpeners[id];
        dialogOpeners[id] = null;
        if (focusIsLost() && isRendered(opener)) focusNode(opener);
      });
      if (onClose) d.addEventListener('close', onClose);
    }
    // 還在文件裡且有版面(沒被 hidden／display:none 收掉)才聚焦得到。
    function isRendered(el) {
      return !!el && el.isConnected === true && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    }
    // 關閉後焦點是否掉到 body:開啟前的元素已不可聚焦(被重畫換掉、隱藏)時，
    // 瀏覽器還原不了，焦點就落在 body。
    function focusIsLost() {
      var a = document.activeElement;
      return !a || a === document.body;
    }
    function focusNode(el) {
      if (el && typeof el.focus === 'function') {
        try { el.focus(); } catch (e) {}
      }
    }

    // ---- 選單(Popover API) ----
    // 4 個選單(⋯ 紀錄選單、篩選、帳號、警示名單列 ⋯)都是 auto popover:點觸發
    // 鈕開關、點外 light dismiss、Esc 關閉、aria-expanded 都由瀏覽器依
    // popoverTargetElement 處理，開別的 auto popover 或 showModal 時自動收起。
    // Chrome 123 沒有 CSS anchor positioning(125 起)，也沒有隱式錨點(133
    // 起)，popover 進 top layer 後脫離 .menu-wrap 的定位脈絡，所以在
    // beforetoggle 依觸發鈕位置寫入 top/right(position:absolute 的包含區塊
    // 是初始包含區塊，要加上捲動量)。
    function wirePopover(trigger, pop, onToggle) {
      if (!trigger || !pop || typeof pop.addEventListener !== 'function') return;
      trigger.popoverTargetElement = pop;
      pop.addEventListener('beforetoggle', function (ev) {
        if (!ev || ev.newState !== 'open') return;
        var r = trigger.getBoundingClientRect();
        var sx = win ? win.scrollX || 0 : 0;
        var sy = win ? win.scrollY || 0 : 0;
        var cw = document.documentElement ? document.documentElement.clientWidth : 0;
        pop.style.top = r.bottom + 6 + sy + 'px';
        pop.style.right = cw - r.right - sx + 'px';
      });
      if (onToggle) pop.addEventListener('toggle', onToggle);
    }
    // 選單內的動作要收起選單時一律走這支。腳本 hidePopover 會在焦點位於選單
    // 裡時把焦點還給觸發鈕，接著開的對話框記下的開啟前焦點才會是觸發鈕。
    function hidePop(pop) {
      if (pop && typeof pop.matches === 'function' && pop.matches(':popover-open')) pop.hidePopover();
    }

    // ---- 共用確認框(清除全部 / 刪除這筆 / 登入)----
    // 複用同一個 confirmOverlay:opts.titleKey/okKey 是 i18n key，desc 是已
    // 組好的字串，action 是確認後要跑的函式。標題/確認鈕文案在 JS 端顯式
    // 覆寫(這兩顆有 data-i18n，只有 i18n 視圖會重設它們，那只在 init 與切換
    // 語言時才跑，紀錄等其他 storage 變動不會觸發)。
    //
    // opts.tone('danger'|'primary')/opts.icon('#i-xxx')決定標題圖示與確認
    // 鈕外觀:刪除類操作維持既有的垃圾桶圖示 + 紅底實心鈕，登入類操作(見
    // startSignInFlow)改成 Google G 圖示 + 品牌色實心鈕，不能沿用紅色——
    // 登入不是破壞性操作，紅底會誤導使用者以為按下去會刪東西。兩者都不給
    // 時保守預設回刪除類外觀，維持既有呼叫點(清除全部/刪單筆/刪雲端)行為
    // 不變。
    function openConfirm(opts) {
      var titleText = byId('confirmTitleText');
      // 標題多數是靜態 i18n key(titleKey)，但移除裝置那一句要把裝置名插進
      // 去，改由呼叫端組好字面字串經 opts.title 傳進來。
      if (titleText) titleText.textContent = typeof opts.title === 'string' ? opts.title : tt(opts.titleKey);
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
      // autofocus 在「取消」而非破壞性的確認鈕，避免一個 Enter 就誤刪/誤清。
      showDialog('confirmOverlay');
    }

    // ---- 頁首帳號入口 ----

    // 跟 background 要一次目前狀態(頁面載入時呼叫一次)。runtime 未注入、
    // sendMessage 拋例外、或 background 端沒有對應 handler(MV3 對無人接聽
    // 的訊息一律 resolve(undefined) 或 reject)都退回 DEFAULT_SYNC_CARD_STATE，
    // 讓帳號入口優雅顯示未登入態，不卡住整頁。
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
    // setSyncState)，不用回應值改畫面——避免兩條更新路徑互相打架;唯一例外
    // 是刪除雲端資料的結果 toast，依回應定案。runtime 未注入或呼叫失敗時安靜
    // 吞掉，不丟例外，回傳的 Promise 一律 resolve(失敗時為 undefined)。
    function sendSyncAction(message) {
      if (!runtime || typeof runtime.sendMessage !== 'function') return Promise.resolve(undefined);
      try {
        var result = runtime.sendMessage(message);
        if (result && typeof result.then === 'function') {
          return result.then(null, function () {
            return undefined;
          });
        }
      } catch (e) {
        // 同上，優雅退回。
      }
      return Promise.resolve(undefined);
    }

    // 同步錯誤碼的文案(帳號選單的錯誤列與 toast 共用)，依 TCLCore.errorCategoryOf
    // 的類別挑選:auth 走登入過期文案，quota／rate_limit／network 各有專屬文案，
    // server 帶出原始碼，unknown 以錯誤前綴帶出錯誤碼。
    var SYNC_ERROR_KEY_BY_CATEGORY = {
      auth: 'opAccountExpired',
      quota: 'opSyncErrQuota',
      rate_limit: 'opSyncErrRateLimit',
      network: 'opSyncErrNetwork',
    };

    function syncErrorText(code) {
      var category = TCLCore.errorCategoryOf(code).category;
      if (Object.prototype.hasOwnProperty.call(SYNC_ERROR_KEY_BY_CATEGORY, category)) {
        return tt(SYNC_ERROR_KEY_BY_CATEGORY[category]);
      }
      if (category === 'server') return tf('opSyncErrServer', { code: code });
      return tt('opAccountErrorPrefix') + code;
    }

    // 刪除雲端資料的定案 toast，依 sync.deleteCloud 的回應 { ok, signedOut, code }。
    function deleteCloudToastText(res) {
      if (res.ok) return tt(res.signedOut === true ? 'opToastCloudDeletedSignedOut' : 'opToastCloudDeleted');
      return syncErrorText(typeof res.code === 'string' && res.code ? res.code : 'internal_error');
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
          if (usePhoto) {
            photoEl.src = safeUrl;
          } else {
            // IDL 屬性與底層 attribute 都要清:.src 才是實際觸發瀏覽器發請求／
            // 快取圖片的那一份，只清 attribute 會讓下一個帳號先閃出舊圖。
            photoEl.src = '';
            if (typeof photoEl.removeAttribute === 'function') photoEl.removeAttribute('src');
          }
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
      // syncing 同理:沒有帳號就沒有東西可同步，轉圈的頭像框只會讓使用者以為
      // 自己登入著。
      if (s.status === 'syncing' && !hasIdentity) return 'signedOut';
      if (s.status === 'syncing') return 'syncing';
      if (s.status === 'error') return 'error';
      return 'signedIn';
    }

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

    // 未登入態每一欄都給明確的重設值:觸發鈕雖然 hidden，任何路徑下次顯示前
    // 都不會露出上一態的舊資料。devices:'reset' 丟掉裝置快取(帳號沒了)，
    // 'refetch' 只標記下次要重打(同一帳號 token 過期，快取留給紀錄詳細 join
    // 裝置名)。
    function accountView(s) {
      var mode = accountMode(s);
      var signedOut = mode === 'signedOut';
      var base = tt('opAccountMenuLabel');
      if (signedOut) {
        return {
          mode: mode,
          signedOut: true,
          text: {
            acctHeaderName: '', acctMenuName: '', acctMenuEmail: '', acctMenuSub: '', acctErrorText: '', acctExpiredText: '',
          },
          hidden: {
            acctSignInBtn: false, acctTrigger: true, acctErrorRow: true, acctExpiredRow: true,
            acctManageDevicesBtn: true, statusDot: true,
          },
          disabled: { acctManageDevicesBtn: false },
          avatar: { initial: '', url: null },
          dotClass: '',
          syncing: false,
          // 觸發鈕的 aria-label 重設回不帶狀態的基本文字，重新顯示時不會唸出
          // 上一態的「同步錯誤」。
          triggerAria: base,
          syncLabelKey: null,
          deviceNoteKey: 'opDeviceNote',
          devices: 'reset',
          closeDevices: true,
          closeMenu: true,
        };
      }

      var name = accountDisplayName(s);
      var hasError = mode === 'error' && typeof s.lastError === 'string' && s.lastError !== '';
      // 待上傳筆數只在 N>0 時附上(D52);N=0 就是雲端與本機一致，不必顯示。
      var sub = tf('opAccountLastSync', { t: s.lastSyncedAt !== null ? relTime(s.lastSyncedAt) : tt('opSyncNever') });
      if (s.pendingCount > 0) sub += ' · ' + tf('opAccountPending', { n: s.pendingCount });
      // 狀態文字只併進觸發鈕(button)自己的 aria-label，不掛在巢狀 statusDot
      // 上——button 有 aria-label 時，讀屏器不讀子節點的 aria-label。
      // syncing 只要求外圈轉圈，不疊角標小圓點，避免視覺過雜。
      var statusKey = {
        error: 'opAccountStatusError', expired: 'opAccountStatusExpired', signedIn: 'opAccountStatusSynced',
      }[mode] || null;
      return {
        mode: mode,
        signedOut: false,
        text: {
          acctHeaderName: name,
          acctMenuName: name,
          acctMenuEmail: s.email || '',
          acctMenuSub: sub,
          acctErrorText: hasError ? syncErrorText(s.lastError) : '',
          // 靜態文案理論上靠 data-i18n 就會套上，仍顯式覆寫:此列剛從 hidden
          // 切到顯示時不必等下一輪語言切換才補上正確文字。
          acctExpiredText: tt('opAccountExpired'),
        },
        hidden: {
          acctSignInBtn: true, acctTrigger: false, acctErrorRow: !hasError, acctExpiredRow: mode !== 'expired',
          // 登入過期沒有可用的工作階段(清單一定拉不到)，比照未登入收掉管理
          // 裝置，只留「重新登入」這條有意義的路。
          acctManageDevicesBtn: mode === 'expired',
          statusDot: statusKey === null,
        },
        disabled: {
          // 過期時必須先重新登入;同步中本來就在跑，同樣停用避免重複觸發。
          acctSyncNowBtn: mode === 'syncing' || mode === 'expired',
          // 同步中這一輪可能正在註冊／更新裝置，進去改名或移除只會拿到馬上被
          // 蓋掉的結果。
          acctManageDevicesBtn: mode === 'syncing',
        },
        avatar: { initial: accountInitial(s), url: s.avatarUrl },
        dotClass: mode === 'error' ? 'is-danger' : mode === 'expired' ? 'is-warning' : '',
        syncing: mode === 'syncing',
        triggerAria: statusKey ? tf('opAccountMenuLabelStatus', { label: base, status: tt(statusKey) }) : base,
        syncLabelKey: mode === 'syncing' ? 'opAccountSyncing' : mode === 'error' ? 'opAccountRetry' : 'opAccountSyncNow',
        // expired 的同步實質上沒在跑(等待重新登入)，比照未登入顯示「僅保存於
        // 這台裝置」，避免謊報已同步。
        deviceNoteKey: mode === 'expired' ? 'opDeviceNote' : 'opDeviceNoteSynced',
        devices: mode === 'expired' ? 'refetch' : null,
        closeDevices: mode === 'expired',
        closeMenu: false,
      };
    }

    function setEach(table, prop) {
      Object.keys(table).forEach(function (id) {
        var el = byId(id);
        if (el) el[prop] = table[id];
      });
    }

    // 把 accountView 的結果寫進 DOM。deviceNote(紀錄卡片頁尾那一列)的文案同
    // 樣隨登入態切換，一併在這裡更新(見 options.html 的 #deviceNote 註解)。
    function applyAccountView(v) {
      setEach(v.hidden, 'hidden');
      setEach(v.text, 'textContent');
      setEach(v.disabled, 'disabled');
      var trigger = byId('acctTrigger');
      if (trigger) trigger.setAttribute('aria-label', v.triggerAria);
      if (v.closeMenu) hidePop(byId('acctMenu'));
      renderAvatars(v.avatar.initial, v.avatar.url);
      var wrap = byId('avatarWrap');
      if (wrap) wrap.classList.toggle('is-syncing', v.syncing);
      var dot = byId('statusDot');
      if (dot) {
        dot.classList.remove('is-danger', 'is-warning');
        if (v.dotClass) dot.classList.add(v.dotClass);
      }
      var syncLabel = byId('acctSyncLabel');
      if (syncLabel && v.syncLabelKey) syncLabel.textContent = tt(v.syncLabelKey);

      if (v.devices === 'reset') {
        deviceCache = null;
        devicesLoadError = false;
      }
      if (v.devices) devicesEverFetched = false;
      renderDeviceCount();
      // 觸發鈕這時已隱藏或入口已收起，焦點落點見 bindDevices 的 close 善後。
      if (v.closeDevices) closeDialog('devicesOverlay');
      var deviceNote = byId('deviceNote');
      if (deviceNote) deviceNote.textContent = tt(v.deviceNoteKey);
    }

    function renderAccount(state) {
      var s = state || DEFAULT_SYNC_CARD_STATE;
      renderEnvBadge(s.apiBase);
      applyAccountView(accountView(s));
    }

    // 接線層在收到 background 的 {type:"sync.stateChanged"} 廣播時呼叫
    // (比照 onStorageChanged 的模式:controller 只暴露方法，
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
    // 彈一句「正在刪除雲端資料…」，等於謊報)。這一態唯一有意義的動作是
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
      renderScamEvictedHint(syncState);
      // 刪除雲端資料送出後掛的旗標(回應定案前的退路):syncing 廣播只是過
      // 程，帶的 lastError 可能是上一輪留下的，不拿來判讀。
      if (pendingDeleteCloudToast && syncState.status !== 'syncing') {
        pendingDeleteCloudToast = false;
        if (syncState.lastError) deleteCloudFallbackText = syncErrorText(syncState.lastError);
        else if (accountMode(syncState) === 'signedOut') deleteCloudFallbackText = tt('opToastCloudDeletedSignedOut');
        if (deleteCloudFallbackText !== null) toast(deleteCloudFallbackText);
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

    // ---- 帳號選單(auto popover，接線見 bindAccount):開啟時焦點進第一個可用
    // 項目，淡入動畫由 CSS 的 @starting-style 處理。 ----

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
      var manageDevicesBtn = byId('acctManageDevicesBtn');
      var signOutBtn = byId('acctSignOutBtn');
      var deleteBtn = byId('acctDeleteBtn');
      var list = [];
      if (retryBtn && errorRow && !errorRow.hidden) list.push(retryBtn);
      if (reSignInBtn && expiredRow && !expiredRow.hidden) list.push(reSignInBtn);
      if (syncBtn && !syncBtn.disabled) list.push(syncBtn);
      // 管理裝置(D16):排在立即同步之後、登出之前。隱藏(未登入/登入過期)
      // 與停用(同步中)兩態都必須跟著退出導覽序列——無條件納入會讓方向鍵停
      // 在看不見或按不動的項目上，畫面看起來就是「按了方向鍵焦點消失」。
      if (manageDevicesBtn && !manageDevicesBtn.hidden && !manageDevicesBtn.disabled) {
        list.push(manageDevicesBtn);
      }
      if (signOutBtn) list.push(signOutBtn);
      if (deleteBtn) list.push(deleteBtn);
      return list;
    }

    // 選單開啟後(toggle 事件，newState 為 open):聚焦第一個可用項目，並在第一
    // 次開啟時取一次裝置清單。
    function onAcctMenuToggle(ev) {
      if (!ev || ev.newState !== 'open') return;
      focusNode(acctMenuFocusableItems()[0]);
      // 「管理裝置」右側的台數要有東西可顯示，第一次開選單先取一次清單
      // (不 force，引擎有快取就直接回快取)。之後每次開對話框才再刷新一次，
      // 開選單本身不再往返——選單開合遠比裝置變動頻繁。
      devicesFetchedThisMenu = false;
      if (!devicesEverFetched && canLoadDevices()) {
        devicesFetchedThisMenu = true;
        loadDevices(false);
      }
    }

    // popup 導向的 #cloud-sync hash:捲回頁首並嘗試開啟帳號選單(未登入時
    // 沒有選單可開，退回聚焦登入鈕)，接線層在 init() resolve 後呼叫(見
    // options-init.js)。
    function focusAccountArea() {
      var area = byId('acctArea');
      if (area && typeof area.scrollIntoView === 'function') {
        area.scrollIntoView({ block: 'start' });
      }
      var trigger = byId('acctTrigger');
      var menu = byId('acctMenu');
      if (trigger && !trigger.hidden && menu && typeof menu.showPopover === 'function') {
        if (!menu.matches(':popover-open')) menu.showPopover();
        return;
      }
      focusNode(byId('acctSignInBtn'));
    }

    // 帳號區目前看得到的控制項:已登入是觸發鈕，登出態是登入鈕。
    function focusAccountControl() {
      var trigger = byId('acctTrigger');
      focusNode(trigger && !trigger.hidden ? trigger : byId('acctSignInBtn'));
    }

    function bindAccount() {
      var acctMenu = byId('acctMenu');
      wirePopover(byId('acctTrigger'), acctMenu, onAcctMenuToggle);

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

      on('acctSignInBtn', 'click', function () {
        startSignInFlow();
      });
      on('acctReSignInBtn', 'click', function () {
        hidePop(acctMenu);
        startSignInFlow();
      });
      on('acctRetryBtn', 'click', function () {
        hidePop(acctMenu);
        if (!hasCloudSession()) return;
        sendSyncAction({ type: 'sync.now' });
      });
      on('acctSyncNowBtn', 'click', function () {
        var btn = byId('acctSyncNowBtn');
        if (btn && btn.disabled) return;
        hidePop(acctMenu);
        if (!hasCloudSession()) return;
        sendSyncAction({ type: 'sync.now' });
      });
      on('acctSignOutBtn', 'click', function () {
        hidePop(acctMenu);
        sendSyncAction({ type: 'sync.signOut' });
      });
      // 刪除雲端資料一樣走確認框，措辭明講三件事(D51):刪除雲端並登出所有
      // 裝置、各裝置本機資料保留、重新登入後會重新上傳。
      on('acctDeleteBtn', 'click', function () {
        hidePop(acctMenu);
        if (!hasCloudSession()) return;
        openConfirm({
          titleKey: 'opAccountDeleteCloud',
          okKey: 'opSyncDeleteConfirmDo',
          tone: 'danger',
          icon: '#i-trash',
          desc: tt('opSyncDeleteConfirmDesc'),
          action: function () {
            var reply = sendSyncAction({ type: 'sync.deleteCloud' });
            // 送出當下先顯示進行中提示，回應回來再定案(見 pendingDeleteCloudToast)。
            pendingDeleteCloudToast = true;
            deleteCloudFallbackText = null;
            toast(tt('opToastCloudDeleted'));
            reply.then(function (res) {
              if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') return;
              pendingDeleteCloudToast = false;
              var text = deleteCloudToastText(res);
              // 廣播已先顯示同一個結論(引擎先廣播再回應)時不再顯示第二次;結論
              // 不同(廣播帶的是舊 lastError)才由回應更正。
              var shown = deleteCloudFallbackText;
              deleteCloudFallbackText = null;
              if (shown === text) return;
              toast(text);
            });
          },
        });
      });
    }

    // ---- 裝置管理(0.7 裝置歸屬:帳號選單入口 + 裝置對話框)----
    //
    // UI 只透過三則訊息與 background 往來(計畫 §12):sync.devices.list /
    // rename / remove，回應一律 { ok:true, ... } 或 { ok:false, code }。
    // 清單純粹是顯示層與 join 用的快取，不參與 history/seen 的任何寫入。

    // 名稱上限 80 code point(§12);handler 端會再驗一次，這裡只是先擋住
    // 使用者打超過。**不掛 input.maxLength**:那顆屬性以 UTF-16 單位計數，
    // 設成 80 等於讓使用者打到第 41 個 emoji 就被瀏覽器擋住，而合法上限是
    // 80 個 code point。長度改由送出前的 clampDeviceName 把關。
    var DEVICE_NAME_MAX = 80;

    // 以 code point 截到上限。走 Array.from 的 iterator，不會切在代理對中間
    // 切出半顆 emoji;handler 端以同一個單位驗，超長直接送過去只會被回
    // bad_device_name，使用者只看得到一句「重新命名失敗」。
    function clampDeviceName(name) {
      var points = Array.from(name);
      return points.length <= DEVICE_NAME_MAX ? name : points.slice(0, DEVICE_NAME_MAX).join('');
    }
    var DEVICE_PLATFORM_ICONS = {
      chrome_extension: '#i-chrome',
      android: '#i-smartphone',
      ios: '#i-smartphone',
    };
    function devicePlatformIcon(platform) {
      return Object.prototype.hasOwnProperty.call(DEVICE_PLATFORM_ICONS, platform)
        ? DEVICE_PLATFORM_ICONS[platform]
        : '#i-monitor-smartphone';
    }

    // 清單「從未取得過」(deviceCache 為 null)與「取到了但這個 id 不在裡面」
    // 是兩回事:前者不該畫任何歸屬，後者才是「未知裝置」。使用者只要沒開過
    // 帳號選單或裝置對話框就一定落在前者。
    function hasDeviceList() {
      return deviceCache !== null;
    }

    function deviceById(deviceId) {
      if (!deviceCache) return null;
      for (var i = 0; i < deviceCache.devices.length; i++) {
        if (deviceCache.devices[i].deviceId === deviceId) return deviceCache.devices[i];
      }
      return null;
    }
    function isCurrentDevice(device) {
      return !!(deviceCache && device && device.deviceId === deviceCache.currentDeviceId);
    }
    // 已移除的裝置(§13):清單回應把活躍與已移除混在同一個陣列，removedAt 非
    // null 就是已移除。本機這台例外——名稱與存在與否一律以本機為準(D26)，
    // 被別台移除也照樣顯示、照樣算進台數，下一次同步就會復活。
    function isRemovedDevice(device) {
      if (!device || finiteOrNull(device.removedAt) === null) return false;
      return !isCurrentDevice(device);
    }
    // 管理清單與台數只認活躍的;紀錄側 join 名稱走 deviceById，兩者都查得到。
    function activeDevices() {
      if (!deviceCache) return [];
      return deviceCache.devices.filter(function (device) {
        return !isRemovedDevice(device);
      });
    }
    // 已移除裝置在紀錄側的淡字標記:接在原名後面，不取代原名——移除的本意
    // 只是整理清單，不該讓舊紀錄的來源變成「未知裝置」。
    function removedTagNode() {
      return h('span', { class: 'device-removed-tag', text: tt('opDeviceRemovedTag') });
    }
    // 本機這台從未改過名時 syncDevice.name 缺席，預設名由 background 隨清單
    // 回應以頂層 defaultName 帶回(§12 增補)——UI 端算不出 OS，只能拿它。別台
    // 的名字只有伺服器給得出來，給不出來就真的無從得知;把使用者正在用的這台
    // 標成「未知裝置」則是這一頁最不該出現的字。
    function deviceDisplayName(device) {
      if (!device) return tt('opDeviceUnknown');
      var name = nonEmptyString(device.name);
      if (name !== null) return name;
      if (isCurrentDevice(device)) {
        var fallback = deviceCache ? nonEmptyString(deviceCache.defaultName) : null;
        if (fallback !== null) return fallback;
      }
      return tt('opDeviceUnknown');
    }
    // 行內改名把名稱清空時要送什麼:本機這台退回清單回應頂層的 defaultName
    // (§10 的 Chrome on <OS>，UI 端算不出 OS)，別台沒有預設名可算，退回原名
    // ——空字串送到 handler 只會被回 bad_device_name(§12)。
    function fallbackDeviceName(device) {
      if (isCurrentDevice(device)) {
        var shared = deviceCache ? nonEmptyString(deviceCache.defaultName) : null;
        if (shared !== null) return shared;
      }
      return deviceDisplayName(device);
    }

    function canLoadDevices() {
      return hasCloudSession() && !!runtime && typeof runtime.sendMessage === 'function';
    }
    // 頁面對 background 的送出通道(裝置三則、黑名單解除/復原):回應原樣送回
    // (含 { ok:false })，runtime 缺席/拋例外/沒人接聽一律退成 null，由呼叫端當失敗處理。
    function sendBackgroundMessage(message) {
      if (!runtime || typeof runtime.sendMessage !== 'function') return Promise.resolve(null);
      var result;
      try {
        result = runtime.sendMessage(message);
      } catch (e) {
        return Promise.resolve(null);
      }
      return Promise.resolve(result).then(
        function (res) {
          return res;
        },
        function () {
          return null;
        }
      );
    }

    function applyDeviceList(res) {
      if (res && res.ok === true && Array.isArray(res.devices)) {
        deviceCache = {
          devices: res.devices.slice(),
          currentDeviceId: nonEmptyString(res.currentDeviceId),
          defaultName: nonEmptyString(res.defaultName),
        };
        devicesLoadError = false;
      } else {
        // 失敗不清既有快取(§12):這次拉不到不代表那些裝置沒了，清掉只會讓
        // 開著的對話框整片消失。
        devicesLoadError = true;
      }
      renderDeviceCount();
      renderDevices();
    }

    function loadDevices(force) {
      if (!canLoadDevices()) return Promise.resolve();
      devicesEverFetched = true;
      var message = { type: 'sync.devices.list' };
      if (force) message.force = true;
      return sendBackgroundMessage(message).then(applyDeviceList);
    }

    // 帳號選單「管理裝置」右側的台數:0 台時整個 span 收掉，不顯示「0 台」。
    function renderDeviceCount() {
      var el = byId('acctDeviceCount');
      if (!el) return;
      var n = activeDevices().length;
      el.hidden = n === 0;
      el.textContent = n === 0 ? '' : tf('opDeviceCount', { n: n });
    }

    // 本機這台置頂，其餘 lastSeenAt 由新到舊;已移除的不列。
    function sortedDevices() {
      return activeDevices().sort(function (a, b) {
        var aCurrent = isCurrentDevice(a);
        var bCurrent = isCurrentDevice(b);
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
        return (finiteOrNull(b.lastSeenAt) || 0) - (finiteOrNull(a.lastSeenAt) || 0);
      });
    }

    function buildDeviceRow(device) {
      var current = isCurrentDevice(device);
      var name = deviceDisplayName(device);
      var rename = function () {
        startDeviceRename(device.deviceId);
      };
      var refs = {};

      // 名稱本身就是改名的入口(點名稱＝改名)，外觀維持純文字。
      refs.nameBtn = h('button', {
        type: 'button', class: 'device-name', dataset: { act: 'rename' }, text: name, onclick: rename,
      });
      if (current) refs.pill = h('span', { class: 'device-pill', text: tt('opDeviceThisDevice') });
      refs.nameRow = h('div', { class: 'device-name-row' }, refs.nameBtn, refs.pill);

      // 第二行:「新增於 <日期> · 最後同步 <相對時間>」(§10)。相對時間開框
      // 時算一次就好，不進 60 秒 ticker。
      var addedEl = h('span', { text: tf('opDeviceAddedOn', { d: formatDateOnly(device.createdAt) }) });
      var lastEl = h('span', { text: tf('opDeviceLastSync', { t: relTime(device.lastSeenAt) }) });
      var sub = h('div', { class: 'device-sub' }, addedEl, h('span', { text: ' · ' }), lastEl);

      // 右側兩顆 ghost 圖示鈕，浮現規則比照紀錄卡的 .entry-quick。
      var renameLabel = tt('opDeviceRename');
      refs.renameBtn = iconButton('device-quick-btn', '#i-pencil', renameLabel, rename, {
        dataset: { act: 'rename' },
        'aria-label': renameLabel + ' ' + name,
      });
      // 正在使用的這台不可移除:按鈕 disabled，說明同時掛在外層 span 的
      // title(停用的按鈕不觸發原生提示)。
      var trashTitle = current ? tt('opDeviceRemoveDisabled') : tt('opDeviceRemove');
      var remove = function () {
        requestDeviceRemove(device.deviceId);
      };
      var removeBtn = iconButton('device-quick-btn danger', '#i-circle-minus', trashTitle, remove, {
        dataset: { act: 'remove' }, disabled: current,
      });
      var slot = h('span', { class: 'device-action-slot', title: trashTitle }, removeBtn);

      deviceRowRefs[device.deviceId] = refs;
      return h(
        'div',
        { class: 'device-row', dataset: { id: device.deviceId } },
        h('span', { class: 'device-platform-icon' }, svgUse(devicePlatformIcon(device.platform), 'icon')),
        h('div', { class: 'device-text' }, refs.nameRow, sub),
        h('div', { class: 'device-actions' }, refs.renameBtn, slot)
      );
    }

    // 空狀態的圖示/文案/按鈕由 JS 重建:#deviceEmptySyncBtn 是靜態節點，
    // 清空容器後再掛回去，事件繫結因此不會掉。
    function renderDeviceEmpty() {
      var emptyEl = byId('deviceEmpty');
      if (!emptyEl) return;
      var syncBtn = byId('deviceEmptySyncBtn');
      emptyEl.textContent = '';
      emptyEl.appendChild(svgUse('#i-monitor-smartphone', 'icon'));
      emptyEl.appendChild(h('span', { text: tt('opDeviceEmpty') }));
      if (syncBtn) emptyEl.appendChild(syncBtn);
    }

    function renderDevices() {
      var errorEl = byId('devicesError');
      if (errorEl) {
        errorEl.hidden = !devicesLoadError;
        errorEl.textContent = devicesLoadError ? tt('opDevicesLoadError') : '';
      }

      var rows = sortedDevices();
      var hintEl = byId('devicesHint');
      if (hintEl) hintEl.textContent = rows.length === 0 ? '' : tf('opDevicesSubtitle', { n: rows.length });

      var listEl = byId('deviceList');
      if (listEl) {
        deviceRowRefs = {};
        listEl.textContent = '';
        rows.forEach(function (device) {
          listEl.appendChild(buildDeviceRow(device));
        });
        listEl.hidden = rows.length === 0;
      }

      var emptyEl = byId('deviceEmpty');
      if (emptyEl) {
        // 取清單失敗時不畫空狀態:上面已經有一句錯誤，再說「找不到裝置」
        // 會被讀成裝置真的沒了。
        emptyEl.hidden = rows.length !== 0 || devicesLoadError;
        if (!emptyEl.hidden) renderDeviceEmpty();
      }
    }

    function openDevicesDialog() {
      if (!byId('devicesOverlay')) return;
      renderDevices();
      showDialog('devicesOverlay');
      // 這一輪開選單時已經取過清單就不重複往返(見 devicesFetchedThisMenu)。
      if (!devicesFetchedThisMenu) loadDevices(false);
      devicesFetchedThisMenu = false;
    }

    // 行內改名:名稱位置換成 <input>(預填目前名稱)，Enter/失焦送出，Esc 還原
    // 不送;長度上限見 clampDeviceName。收尾只改這一列，不整份重畫——重畫會在
    // mousedown→blur 之後把節點換掉，接著那一下 click 就落空。
    function startDeviceRename(deviceId) {
      var refs = deviceRowRefs[deviceId];
      var device = deviceById(deviceId);
      if (!refs || !device || refs.input) return;

      var input = h('input', {
        type: 'text', class: 'device-name-input', value: deviceDisplayName(device),
        'aria-label': tt('opDeviceNameAria'),
      });
      refs.input = input;
      refs.nameBtn.hidden = true;
      if (refs.pill) refs.pill.hidden = true;
      refs.nameRow.insertBefore(input, refs.nameBtn);

      var done = false;
      function finish(save, refocus) {
        if (done) return;
        done = true;
        var raw = typeof input.value === 'string' ? input.value : '';
        if (input.parentNode) input.parentNode.removeChild(input);
        refs.input = null;
        refs.nameBtn.hidden = false;
        if (refs.pill) refs.pill.hidden = false;
        if (refocus && typeof refs.nameBtn.focus === 'function') {
          try { refs.nameBtn.focus(); } catch (e) {}
        }
        if (!save) return;
        var next = raw.trim();
        submitDeviceRename(device, next === '' ? fallbackDeviceName(device) : clampDeviceName(next));
      }

      input.addEventListener('keydown', function (ev) {
        if (!ev) return;
        if (ev.key === 'Enter') {
          if (ev.preventDefault) ev.preventDefault();
          finish(true, true);
        } else if (ev.key === 'Escape') {
          // 擋掉冒泡:這顆 Esc 是「取消編輯」，不該順手把裝置對話框也關掉。
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          finish(false, true);
        }
      });
      input.addEventListener('blur', function () {
        finish(true, false);
      });

      if (typeof input.focus === 'function') {
        try { input.focus(); } catch (e) {}
      }
      if (typeof input.select === 'function') {
        try { input.select(); } catch (e) {}
      }
    }

    // 樂觀更新 → 送出 → 失敗還原並 toast(§5)。只動這一列的節點與快取，
    // 不重畫整份清單。
    function submitDeviceRename(device, name) {
      var previous = deviceDisplayName(device);
      var refs = deviceRowRefs[device.deviceId];
      setDeviceRowName(device, refs, name);
      sendBackgroundMessage({ type: 'sync.devices.rename', deviceId: device.deviceId, name: name }).then(
        function (res) {
          if (res && res.ok === true) {
            var confirmed = res.device ? nonEmptyString(res.device.name) : null;
            if (confirmed !== null) setDeviceRowName(device, refs, confirmed);
            return;
          }
          setDeviceRowName(device, refs, previous);
          toast(tt('opDeviceRenameFailed'));
        }
      );
    }
    function setDeviceRowName(device, refs, name) {
      device.name = name;
      if (!refs) return;
      if (refs.nameBtn) refs.nameBtn.textContent = name;
      if (refs.renameBtn) refs.renameBtn.setAttribute('aria-label', tt('opDeviceRename') + ' ' + name);
    }

    // 移除:先跳共用確認框，講明「只是從清單移除，不等於登出」。
    function requestDeviceRemove(deviceId) {
      var device = deviceById(deviceId);
      if (!device || isCurrentDevice(device)) return;
      openConfirm({
        title: tf('opDeviceRemoveTitle', { name: deviceDisplayName(device) }),
        okKey: 'opDeviceRemove',
        tone: 'danger',
        icon: '#i-circle-minus',
        desc: tt('opDeviceRemoveDesc'),
        action: function () {
          submitDeviceRemove(device);
        },
      });
    }
    function submitDeviceRemove(device) {
      sendBackgroundMessage({ type: 'sync.devices.remove', deviceId: device.deviceId }).then(function (res) {
        if (!(res && res.ok === true)) {
          // 失敗不樂觀刪:那一列留著，只用 toast 說明。
          toast(tt('opDeviceRemoveFailed'));
          return;
        }
        // 軟刪除(§13):快取保留那一列、只標上 removedAt，管理清單靠 filter
        // 讓它消失。紀錄側 join 得到的還是原名，不會整片變成「未知裝置」。
        if (deviceCache) {
          var removedAt = now();
          deviceCache.devices = deviceCache.devices.map(function (d) {
            if (d.deviceId !== device.deviceId || finiteOrNull(d.removedAt) !== null) return d;
            return Object.assign({}, d, { removedAt: removedAt });
          });
        }
        renderDeviceCount();
        renderDevices();
      });
    }

    // ---- 紀錄側的裝置顯示(詳細視窗 kv 列 + 時間軸列尾)----
    //
    // 三守則(計畫 §4):清單只用於 join;join 不到顯示「未知裝置」;deviceId
    // 整個缺席(0.6.x 寫進來的早期事件)就不畫，不假裝有歸屬。卡面一律不加
    // 任何裝置標示(D27)。

    // 單一 seen 事件的來源裝置:回 { name, removed }，沒帶 deviceId、或本頁
    // 根本還沒取過裝置清單時回 null(不畫)。後者是關鍵:清單沒到手時每一筆都
    // join 不到，全標成「未知裝置」等於告訴使用者那些裝置都已經不在了。
    // 活躍與已移除都查(§13)，兩者都查不到才是「未知裝置」——那時不掛已移除
    // 標記，「查不到」與「已移除」是兩件事。
    function seenDeviceInfo(record) {
      var deviceId = record ? nonEmptyString(record.deviceId) : null;
      if (deviceId === null) return null;
      if (!hasDeviceList()) return null;
      var device = deviceById(deviceId);
      if (!device) return { name: tt('opDeviceUnknown'), removed: false };
      return { name: deviceDisplayName(device), removed: isRemovedDevice(device) };
    }

    // 詳細視窗那一列取「最近一筆帶 deviceId 的 seen 事件」(§12 增補):條目
    // 本身沒有裝置欄位，最後一次在哪台機器上碰到它才是使用者想知道的。
    function latestSeenDeviceId(entry) {
      var seen = entry && Array.isArray(entry.seen) ? entry.seen : [];
      var bestAt = null;
      var bestId = null;
      seen.forEach(function (record) {
        if (!record || typeof record.at !== 'number' || !isFinite(record.at)) return;
        var deviceId = nonEmptyString(record.deviceId);
        if (deviceId === null) return;
        if (bestAt === null || record.at > bestAt) {
          bestAt = record.at;
          bestId = deviceId;
        }
      });
      return bestId;
    }

    // 平台圖示會隨裝置變動，整列內容每次重建;#detailDeviceName 是靜態節點，
    // 清空容器後再掛回去(其餘 kv 列的取值方式因此不受影響)。
    function renderDetailDeviceRow(entry) {
      var row = byId('detailDeviceRow');
      var nameEl = byId('detailDeviceName');
      if (!row || !nameEl) return;
      var deviceId = latestSeenDeviceId(entry);
      // 沒有歸屬、或清單一次都沒取過(join 不出任何名字)都走不畫的路徑。
      if (deviceId === null || !hasDeviceList()) {
        // 不畫的路徑不得清空容器:#detailDeviceName 是掛在這一列裡的靜態
        // 節點，清掉就永久移出文件樹，之後 byId 一律回 null，下一筆有歸屬
        // 的紀錄會連整列一起不見(只要看過一筆 0.6.x 的舊紀錄就會踩到)。
        nameEl.textContent = '';
        row.hidden = true;
        return;
      }
      var device = deviceById(deviceId);
      nameEl.textContent = device ? deviceDisplayName(device) : tt('opDeviceUnknown');
      // 平台圖示隨裝置變動，整列重建;#detailDeviceName 上面已經取到手，
      // 清空後再掛回去。
      row.textContent = '';

      var icon = svgUse(devicePlatformIcon(device ? device.platform : null), 'icon');
      var removedTag = isRemovedDevice(device) && removedTagNode();
      row.appendChild(h('span', { class: 'detail-key', text: tt('opDevicesTitle') }));
      row.appendChild(h('div', { class: 'detail-value detail-device-value' }, icon, nameEl, removedTag));
      row.hidden = false;
    }

    function bindDevices() {
      on('acctManageDevicesBtn', 'click', function () {
        var btn = byId('acctManageDevicesBtn');
        if (btn && btn.disabled) return;
        // 先收選單，焦點回帳號觸發鈕，對話框關閉時才還得回去。
        hidePop(byId('acctMenu'));
        openDevicesDialog();
      });
      // 登出或登入過期時由 renderAccount 關閉，觸發鈕已隱藏、還原不了焦點，
      // 改落在帳號區當時看得到的控制項(登出態是登入鈕)。
      bindDialog('devicesOverlay', 'devicesClose', function () {
        if (focusIsLost()) focusAccountControl();
      });
      // 空狀態的「立即同步」:同步一次讓這台註冊上去，再強制重取清單。
      on('deviceEmptySyncBtn', 'click', function () {
        if (!canLoadDevices()) return;
        var hadNone = activeDevices().length === 0;
        sendBackgroundMessage({ type: 'sync.now' })
          .then(function () {
            return loadDevices(true);
          })
          .then(function () {
            if (hadNone && activeDevices().length > 0) {
              toast(tt('opDeviceRegisteredToast'));
            }
          });
      });
    }

    // ---- 投資詐騙黑名單卡(v1 計畫 §5 UI 段／§14 訊息協議)----
    //
    // 資料是 chrome.storage.local.scamBlocklist，登入後隨 marks 通道雲端同步
    // (D35-D40)。寫入端只有 background，本頁只讀 storage ＋ 監聽 onChanged(見
    // onStorageChanged)，解除/復原一律經 runtime 訊息請 background 代寫。
    // displayName 與證據片段都是他人貼文帶進來的字串:整張卡逐一
    // createElement ＋ textContent，不走 innerHTML。

    // storage 讀回的黑名單直接取 TCLCore.normalizeScamBlocklist 的結果(與
    // background 寫入側共用同一把尺)。「已解除」小節從 entries 挑 dismissed
    // 條目來畫，entries 的 handle 是他人帳號帶進來的字串，清洗尺度只能有一
    // 把——本頁若另讀一份，摺疊空白與截長的規則就會與 core 漂移，髒 handle
    // 一路畫到「已解除」小節上。
    function readScamBlocklist(raw) {
      return TCLCore.normalizeScamBlocklist(raw);
    }

    // 名單依 addedAt 降冪:最近被標記的在最前。只列 state==='active' 的條
    // 目——v2 的 entries 把已解除的條目留在原地(state 翻成 dismissed)，不
    // 再整筆刪掉，名單列因此得自己篩掉它們(見 buildScamAllowRow 那份走
    // dismissed 的視圖)。
    function sortedScamEntries() {
      var map = scamBlocklist.entries;
      return Object.keys(map)
        .filter(function (userId) {
          return map[userId].state !== 'dismissed';
        })
        .map(function (userId) {
          return { userId: userId, entry: map[userId] };
        })
        .sort(function (a, b) {
          return b.entry.addedAt - a.entry.addedAt;
        });
    }

    // 已解除的清單依解除時間降冪;缺解除時間的紀錄 at 退成 0，一律排在最後
    // (buildScamAllowRow 對 at<=0 另有「不明時不畫日期」的處理)。直接掃
    // entries 挑 state==='dismissed'(與 sortedScamEntries 挑 active 對稱)，
    // 不讀 scamBlocklist.allowlist 那份衍生視圖，解除／復原兩處也就不必手
    // 工同步那張表(見 submitScamRemove/submitScamRestore)。
    function sortedScamAllow() {
      var map = scamBlocklist.entries;
      return Object.keys(map)
        .filter(function (userId) {
          return map[userId].state === 'dismissed';
        })
        .map(function (userId) {
          var entry = map[userId];
          return { userId: userId, at: finiteOrNull(entry.dismissedAt) || 0, handle: entry.handle };
        })
        .sort(function (a, b) {
          return b.at - a.at;
        });
    }

    // handle 一律以 @ 開頭顯示;解除紀錄缺 handle 時退成「@?」，不把
    // undefined 畫進畫面。
    function scamHandleLabel(handle) {
      var value = nonEmptyString(handle);
      if (value === null) return '@?';
      return value.charAt(0) === '@' ? value : '@' + value;
    }

    // 確認框標題與 aria-label 用的作者稱呼:沒有 displayName 就用 @handle。
    function scamAuthorLabel(entry) {
      var name = entry ? nonEmptyString(entry.displayName) : null;
      return name === null ? scamHandleLabel(entry && entry.handle) : name;
    }

    // 作者頁網址。handle 走 encodeURIComponent:名單裡的 handle 只過
    // sanitizeDisplayName(摺空白、截長)，字元集沒有收斂，直接串進網址會被
    // 斜線或 query 字元拆成別的路徑。
    function scamAuthorUrl(handle) {
      var value = nonEmptyString(handle);
      if (value === null) return null;
      return 'https://www.threads.com/@' + encodeURIComponent(value);
    }

    // 一筆證據的「證據貼文」網址:錨點篇優先，舊證據(沒有 anchorPostUrl)退回
    // postUrl。兩者都缺時回 null，該筆不畫連結。
    function scamEvidencePostUrl(evidence) {
      return nonEmptyString(evidence.anchorPostUrl) || nonEmptyString(evidence.postUrl);
    }

    // 一筆證據要顯示的日期:貼文發布時間優先，缺席(舊證據)退回 at。at 是
    // 「掃到的時間」——只反映使用者什麼時候剛好滑到那一頁，但有個日期仍然比
    // 整欄空著好。
    function scamEvidenceDateAt(evidence) {
      var posted = finiteOrNull(evidence.postedAt);
      return posted === null ? finiteOrNull(evidence.at) : posted;
    }

    // 貼文代碼尾 6 碼。同一位作者的多筆證據常是同文異篇(同一段招攬文案貼了
    // 好幾篇)，片段一模一樣時只剩代碼分得出各篇;代碼走 TCLCore.extractPostId
    // (嚴格樣式)，抽不出來時(分享短碼等)回空字串。
    function scamEvidenceCode(url) {
      var postId = url === null ? null : TCLCore.extractPostId(url);
      return postId === null ? '' : postId.slice(-6);
    }

    // 證據上的時間文字，格式照 Threads 自己的貼文時間:一週內是極短的相對
    // 時間(「剛剛」「38分鐘」「3小時」「5天」——數字與單位之間不留空白、也
    // 不帶「前」字)，滿七天改絕對日期。
    //
    // 不沿用紀錄卡的 relTime:那支是「N 分鐘前／昨天／N 天前」的完整語氣，
    // 放進作者列會把一行字撐長，而這裡的時間是緊貼帳號的一小段註記。兩套各
    // 有各的 key，改其中一邊不會動到另一邊。
    function formatScamDate(ts) {
      var at = finiteOrNull(ts);
      if (at === null) return '';
      var diff = Math.max(0, now() - at);
      if (diff >= 7 * DAY_MS) return formatDateOnly(at);
      var m = Math.floor(diff / 60000);
      if (m < 1) return tt('opRelNow');
      if (m < 60) return tf('opRelMinutes', { n: m });
      var h = Math.floor(m / 60);
      if (h < 24) return tf('opRelHours', { n: h });
      return tf('opRelDaysShort', { n: Math.floor(h / 24) });
    }

    // 作者列的名字塊:顯示名 ＋ @handle，整塊連到作者頁。沒有 displayName 時
    // 只留 @handle 一段，不用 handle 充當顯示名再重複一次(§14)。handle 缺席
    // 時沒有作者頁可連，退回不可點的 <span>，名字照樣顯示。
    function buildScamNameLink(entry) {
      var displayName = nonEmptyString(entry.displayName);
      var authorUrl = scamAuthorUrl(entry.handle);
      var nameEl = displayName !== null && h('span', { class: 'scam-name', text: displayName });
      var handleEl = h('span', {
        class: displayName === null ? 'scam-name' : 'scam-handle', text: scamHandleLabel(entry.handle),
      });
      if (authorUrl === null) return h('span', { class: 'scam-name-link' }, nameEl, handleEl);
      var linkProps = { class: 'scam-name-link', href: authorUrl, target: '_blank', rel: 'noopener noreferrer' };
      return h('a', linkProps, nameEl, handleEl);
    }

    // 作者列:顯示名、@handle，緊接著那篇的時間——時間本身就是永久連結，比照
    // Threads 自己的貼文排法。連結文字是相對時間，絕對日期與貼文代碼尾碼留
    // 在 title 上(相對時間看不出是哪一天，同文異篇也分不出各篇)。連結文字只
    // 有一個時間，讀屏讀不出它連去哪，另補 aria-label。
    function buildScamEvidenceHead(entry, evidence) {
      var at = scamEvidenceDateAt(evidence);
      var href = scamEvidencePostUrl(evidence);
      var code = scamEvidenceCode(href);
      var dateNode = null;
      if (at !== null) {
        var absolute = formatDateOnly(at);
        var suffix = code === '' ? '' : ' ' + code;
        dateNode =
          href === null
            ? h('span', { class: 'scam-evidence-date', text: formatScamDate(at), title: absolute })
            : externalLink('scam-evidence-date', href, formatScamDate(at), {
                title: code === '' ? absolute : absolute + ' · ' + code,
                ariaLabel: tt('opScamEvidencePost') + suffix,
              });
      }
      // 作者列尾端的標記 pill，文案與貼文上那顆完全相同(scamTagLabel):使用
      // 者在 Threads 上看到的是這顆，名單裡再看到同一顆才認得出是同一件事。
      var tag = h('span', { class: 'scam-post-tag', text: tt('scamTagLabel'), title: tt('scamTagTooltip') });
      return h('div', { class: 'scam-evidence-head' }, buildScamNameLink(entry), dateNode, tag);
    }

    // 片段本體。完整呈現不截斷(儲存端已保證 ≤120 字)，anchorMatch 在片段裡
    // 找得到時以 mark.scam-anchor 包住:以 indexOf 切前中後三段各自建文字節
    // 點，全程零 innerHTML——片段是他人貼文帶進來的字串。
    //
    // 雲端同步來的證據沒有 snippet(片段只留在掃到它的那台裝置);鍵缺席與
    // 存成空字串(TCLCore.normalizeScamEvidence 把缺席補成空字串是實作細節)
    // 兩種都算「沒有片段」，一律改掛 span.scam-evidence-missing 的灰字說
    // 明，不留一個空白的 <p>。
    function buildScamEvidenceText(evidence) {
      var cls = 'scam-evidence-text';
      var snippet = typeof evidence.snippet === 'string' ? evidence.snippet : '';
      if (snippet === '') {
        return h('p', { class: cls }, h('span', { class: 'scam-evidence-missing', text: tt('opScamEvidenceMissing') }));
      }
      var anchor = nonEmptyString(evidence.anchorMatch);
      var at = anchor === null ? -1 : snippet.indexOf(anchor);
      if (at === -1) return h('p', { class: cls, text: snippet });
      var tail = snippet.slice(at + anchor.length);
      var mark = h('mark', { class: 'scam-anchor', text: anchor });
      return h('p', { class: cls }, at > 0 && snippet.slice(0, at), mark, tail !== '' && tail);
    }

    // 一筆證據 ＝ 一則貼文的樣子，就兩列:作者列(名字、時間連結、標記 pill)
    // 與本文。
    //
    // threadUrl 與 signals 照存但不畫:證據貼文連的就是錨點那一篇，回串頭
    // 是 Threads 自己的事;signals 是判定的內部分類，使用者看片段本身就知道
    // 為什麼被標記。兩者留作除錯與日後調參之用。
    //
    // 主卡上的那一筆與「命中 N 篇」對話框裡的每一筆都走這支，兩邊的結構與
    // class 因此逐一相同——證據長什麼樣只有一個定義，改版時不會有一邊被漏掉。
    function buildScamPostItem(entry, evidence) {
      var head = buildScamEvidenceHead(entry, evidence);
      return h('div', { class: 'scam-evidence-item' }, head, buildScamEvidenceText(evidence));
    }

    // 條目的證據依 at 降冪(最新在前)。storage 的正規化不保證順序。
    function sortedScamEvidence(entry) {
      return entry.evidence.slice().sort(function (a, b) {
        return (finiteOrNull(b.at) || 0) - (finiteOrNull(a.at) || 0);
      });
    }

    // 對話框標題左半:「顯示名 @handle」;沒有顯示名時只留 @handle 一段。
    function scamAuthorTitle(entry) {
      var name = nonEmptyString(entry.displayName);
      var handle = scamHandleLabel(entry.handle);
      return name === null ? handle : name + ' ' + handle;
    }

    // ---- 「命中 N 篇」證據對話框 ----
    //
    // 主卡只放最新一筆(一張卡上同時擺三段完整片段太重)，全部證據在這裡逐筆
    // 疊成一串貼文。對話框開著時記下是哪一位作者(scamHitsUserId)，名單變動
    // 時就地重畫(見 renderScamList)。scamHitPills 是目前各作者列上的 pill，
    // 名單整份重畫後舊 pill 離開文件，關閉時焦點改落在同一位作者的新 pill。
    var scamHitsUserId = null;
    var scamHitPills = {};

    function renderScamHits(entry) {
      var titleEl = byId('scamHitsTitle');
      if (titleEl) {
        titleEl.textContent =
          scamAuthorTitle(entry) + ' · ' + tf('opScamHitCount', { n: entry.evidence.length });
      }
      var listEl = byId('scamHitsList');
      if (!listEl) return;
      listEl.textContent = '';
      sortedScamEvidence(entry).forEach(function (evidence) {
        listEl.appendChild(buildScamPostItem(entry, evidence));
      });
    }

    function openScamHits(userId) {
      var entry = scamBlocklist.entries[userId];
      if (!entry || !byId('scamHitsOverlay')) return;
      renderScamHits(entry);
      scamHitsUserId = userId;
      showDialog('scamHitsOverlay');
    }

    function onScamHitsClose() {
      if (isDialogOpen('scamHitsOverlay')) return;
      var userId = scamHitsUserId;
      scamHitsUserId = null;
      if (userId && focusIsLost()) focusNode(scamHitPills[userId]);
    }

    // ---- 卡頭資訊鈕:「這個功能怎麼運作」說明視窗 ----
    //
    // 五段條列都是 i18n 字串，每一段以 '|' 分成「粗體開頭句」與「說明」兩
    // 段:開頭句本身就是重點，粗體讓人掃得動;沒有分隔符時整句當說明。文案裡
    // 不放任何標記語言，全程 textContent——這段說的是擴充怎麼判人，內容本身
    // 不該有被注入的餘地。
    var SCAM_INFO_KEYS = [
      'opScamInfo1',
      'opScamInfo2',
      'opScamInfo3',
      'opScamInfo4',
      'opScamInfo5',
    ];

    function renderScamInfo() {
      // 標題在 HTML 裡就帶 data-i18n(首次開啟前也是對的語言)，這裡再寫一次
      // 是為了讓「開著的時候切語言」也跟著換——applyI18nDom 掃得到它，但重畫
      // 條列時一併更新比較不容易漏。
      var titleEl = byId('scamInfoTitle');
      if (titleEl) titleEl.textContent = tt('opScamInfoTitle');
      var listEl = byId('scamInfoList');
      if (!listEl) return;
      listEl.textContent = '';
      SCAM_INFO_KEYS.forEach(function (key) {
        var text = tt(key);
        var at = text.indexOf('|');
        listEl.appendChild(
          at === -1
            ? h('li', { text: text })
            : h('li', null, h('span', { class: 'scam-info-lead', text: text.slice(0, at) }), ' ' + text.slice(at + 1))
        );
      });
    }

    function openScamInfo() {
      if (!byId('scamInfoOverlay')) return;
      // 每次開都重畫:切語言時不必另外掛一條刷新路徑。
      renderScamInfo();
      showDialog('scamInfoOverlay');
    }

    // ---- 每一列右上角的 ⋯ 選單 ----
    //
    // 名單的列是動態產生的，選單跟著各列走:以 IDL 設成 auto popover，再用
    // popoverTargetElement 接到該列的 ⋯ 鈕，不需要 id。整份重畫時列被移出
    // 文件，開著的選單由瀏覽器自動隱藏。
    // 列右上角的命中篇數與 ⋯ 選項鈕:兩者一起排在列的右緣，與作者列同一條水
    // 平線(.scam-row 是 align-items:flex-start)。選單目前只有「解除」一項
    // (破壞性動作，走 danger 色與既有的二次確認);圖示與 .menu/.menu-item
    // 樣式沿用紀錄卡那一套。
    //
    // 命中篇數刻意不放進 buildScamPostItem:那支是「一筆證據」的定義，主卡與
    // 對話框共用，而篇數講的是整位作者，對話框裡逐筆重複一次毫無意義。
    function buildScamActions(item) {
      var entry = item.entry;
      var author = scamAuthorLabel(entry);

      // 兩筆以上才畫——只有一筆時對話框裡看到的就是卡上那一筆，一顆點了沒變
      // 化的按鈕只會讓人以為壞了。
      var n = entry.evidence.length;
      var hitCount =
        n > 1 &&
        h('button', {
          type: 'button', class: 'scam-hit-count', 'aria-haspopup': 'dialog', text: tf('opScamHitCount', { n: n }),
          onclick: function () {
            openScamHits(item.userId);
          },
        });
      if (hitCount) scamHitPills[item.userId] = hitCount;

      var removeLabel = tt('opScamRemove');
      var removeBtn = h(
        'button',
        {
          type: 'button', class: 'menu-item danger', dataset: { act: 'remove' }, role: 'menuitem',
          title: removeLabel, 'aria-label': removeLabel + ' ' + author,
          onclick: function () {
            hidePop(menu);
            requestScamRemove(item.userId);
          },
        },
        svgUse('#i-circle-minus', 'icon'),
        h('span', { text: removeLabel })
      );
      var menu = h('div', { class: 'menu scam-menu', role: 'menu', popover: 'auto' }, removeBtn);

      var moreLabel = tt('opMoreTitle');
      var btn = iconButton('scam-menu-btn', '#i-more', moreLabel, null, {
        'aria-haspopup': 'menu', 'aria-label': moreLabel + ' ' + author,
      });
      wirePopover(btn, menu);

      return h('div', { class: 'scam-actions menu-wrap' }, hitCount, btn, menu);
    }

    function buildScamRow(item) {
      var entry = item.entry;
      var evidence = sortedScamEvidence(entry);
      var latest = evidence.length > 0 ? evidence[0] : null;
      // 主卡就是最新那一筆證據的貼文樣子(作者列、本文、整串與訊號)，其餘證
      // 據在「命中 N 篇」對話框裡。證據一筆都沒有時仍要看得到是誰，退回只畫
      // 作者列。
      var evidenceNode = latest
        ? buildScamPostItem(entry, latest)
        : h('div', { class: 'scam-evidence-head' }, buildScamNameLink(entry));
      return h(
        'div',
        { class: 'scam-row', dataset: { id: item.userId } },
        h('div', { class: 'scam-text' }, h('div', { class: 'scam-evidence' }, evidenceNode)),
        buildScamActions(item)
      );
    }

    function buildScamAllowRow(item) {
      // 解除時間:格式與算式同證據列上的時間(formatScamDate)，一週內相對
      // 時間、滿七天改絕對日期;絕對日期另留在 title。dismissedAt 缺席時
      // TCLCore 補成 0(見 finiteOr)，0 代表「解除時間不明」而非真的發生在
      // 1970 年——formatScamDate(0) 會照樣算出一個滿七天前的絕對日期，誤
      // 導使用者以為那是真實的解除時間，不明時乾脆不畫這個節點。
      var dismissedAt = finiteOrNull(item.at);
      var dateEl =
        dismissedAt !== null &&
        dismissedAt > 0 &&
        h('span', { class: 'scam-allow-date', text: formatScamDate(dismissedAt), title: formatDateOnly(dismissedAt) });
      var handleEl = h('span', { class: 'scam-handle', text: scamHandleLabel(item.handle) });
      var info = h('span', { class: 'scam-allow-info' }, handleEl, dateEl);
      var restoreBtn = h('button', {
        type: 'button', class: 'link-btn', dataset: { act: 'restore' }, text: tt('opScamRestore'),
        onclick: function () {
          submitScamRestore(item.userId);
        },
      });
      return h('div', { class: 'scam-allow-row', dataset: { id: item.userId } }, info, restoreBtn);
    }

    // 空狀態的圖示與文案由 JS 重建(容器每次重畫都清空)，比照 renderDeviceEmpty。
    function renderScamEmpty() {
      var emptyEl = byId('scamEmpty');
      if (!emptyEl) return;
      emptyEl.textContent = '';
      emptyEl.appendChild(svgUse('#i-shield-check', 'icon'));
      emptyEl.appendChild(h('div', { text: tt('opScamEmpty') }));
    }

    function renderScamList() {
      // 整份重畫會把列(連同它的 ⋯ 選單與 pill)整個換掉;開著的 ⋯ 選單隨舊列
      // 離開文件自動隱藏。命中對話框開著時，條目仍在就地重畫內容，被解除才關。
      scamHitPills = {};
      var rows = sortedScamEntries();
      var countEl = byId('scamCount');
      // 0 位也照常顯示計數(§14)，不像裝置台數那樣整個收掉。
      if (countEl) countEl.textContent = tf('opScamListCount', { n: rows.length });

      var listEl = byId('scamList');
      if (listEl) {
        listEl.textContent = '';
        rows.forEach(function (item) {
          listEl.appendChild(buildScamRow(item));
        });
        listEl.hidden = rows.length === 0;
      }

      var emptyEl = byId('scamEmpty');
      if (emptyEl) {
        emptyEl.hidden = rows.length !== 0;
        if (!emptyEl.hidden) renderScamEmpty();
      }

      if (scamHitsUserId && isDialogOpen('scamHitsOverlay')) {
        var hitsEntry = scamBlocklist.entries[scamHitsUserId];
        if (hitsEntry && hitsEntry.state !== 'dismissed') renderScamHits(hitsEntry);
        else closeDialog('scamHitsOverlay');
      }
    }

    // 「已解除」小節:小標與列都是 JS 產生的，allowlist 為空時整節隱藏。
    function renderScamAllowlist() {
      var sectionEl = byId('scamAllowlist');
      if (!sectionEl) return;
      var rows = sortedScamAllow();
      sectionEl.textContent = '';
      sectionEl.hidden = rows.length === 0;
      if (rows.length === 0) return;

      sectionEl.appendChild(h('div', { class: 'scam-allow-title', text: tt('opScamAllowlistTitle') }));
      rows.forEach(function (item) {
        sectionEl.appendChild(buildScamAllowRow(item));
      });
    }

    // 總開關(#scamGuardEnabled)關閉時卡頭下方的狀態列:說明「關了會怎樣」
    // ＋就地開啟鈕，內容由 JS 逐一 createElement 產生(比照整張卡零
    // innerHTML 的慣例)，開關為 true 時整條 hidden。點開啟鈕直接寫
    // scamGuardEnabled=true 到 local 區(與設定卡同一顆鍵，見
    // TCLCore.SETTINGS_SCHEMA)，不吃二次確認——這不是破壞性動作，名單本身完全
    // 不受影響。
    function renderScamDisabledBar() {
      var bar = byId('scamDisabledBar');
      if (!bar) return;
      var toggle = byId('scamGuardEnabled');
      var enabled = toggle ? !!toggle.checked : true;
      bar.textContent = '';
      if (enabled) {
        bar.hidden = true;
        return;
      }
      bar.hidden = false;

      var label = tt('opScamEnable');
      var enable = function () {
        localStore.set({ scamGuardEnabled: true });
        if (toggle) toggle.checked = true;
        renderScamDisabledBar();
      };
      bar.appendChild(h('span', { text: tt('opScamDisabledBar') }));
      bar.appendChild(h('button', {
        type: 'button', class: 'scam-enable-btn', dataset: { act: 'enable' },
        text: label, title: label, onclick: enable,
      }));
    }

    // 雲端配額用罄而被淘汰(未上傳)的警示名單筆數(syncState.marksEvicted)，
    // 卡頭小字說明，0 或缺席時收起。呼叫端一律傳目前的 syncState(帳號卡片
    // 的同一份狀態，見 setSyncState/fetchSyncState)。
    function renderScamEvictedHint(state) {
      var el = byId('scamEvictedHint');
      if (!el) return;
      var s = state || DEFAULT_SYNC_CARD_STATE;
      var n = typeof s.marksEvicted === 'number' && isFinite(s.marksEvicted) && s.marksEvicted > 0
        ? s.marksEvicted
        : 0;
      if (n === 0) {
        el.hidden = true;
        el.textContent = '';
        return;
      }
      el.hidden = false;
      el.textContent = tf('opScamEvictedHint', { n: n });
    }

    function bindScamDialogs() {
      bindDialog('scamHitsOverlay', 'scamHitsClose', onScamHitsClose);
      on('scamInfoBtn', 'click', openScamInfo);
      bindDialog('scamInfoOverlay', 'scamInfoClose');
    }

    // 解除是破壞性動作(日後再命中也不會自動加回)，先開確認框。
    function requestScamRemove(userId) {
      var entry = scamBlocklist.entries[userId];
      if (!entry) return;
      openConfirm({
        title: tf('opScamRemoveTitle', { name: scamAuthorLabel(entry) }),
        okKey: 'opScamRemove',
        tone: 'danger',
        icon: '#i-circle-minus',
        desc: tt('opScamRemoveDesc'),
        action: function () {
          submitScamRemove(userId);
        },
      });
    }

    // v2 的解除不整筆刪掉:entry 留在 entries 裡，state 翻成 dismissed、
    // dismissedAt 記下時間，證據原地保留(「已解除」小節要顯示 handle，復原
    // 也要保留證據，見 submitScamRestore)。
    function submitScamRemove(userId) {
      var entry = scamBlocklist.entries[userId];
      if (!entry || entry.state === 'dismissed') return;
      // 帶上這一列的帳號快照：名單裡沒有這一筆時 background 會補建一筆空的
      // dismissed 條目，缺 handle 的 mark 上雲必被後端整筆拒收，那次解除從此
      // 同步不出去。
      var payload = { type: 'scam.blocklist.remove', userId: userId };
      if (typeof entry.handle === 'string' && entry.handle) payload.handle = entry.handle;
      if (typeof entry.displayName === 'string' && entry.displayName) payload.displayName = entry.displayName;
      sendBackgroundMessage(payload).then(function (res) {
        if (!(res && res.ok === true)) {
          // 失敗不樂觀改:那一列留著，只用 toast 說明。
          toast(tt('opScamRemoveFailed'));
          return;
        }
        // background 寫回 storage 後的 onChanged 才是權威;本地先做同一件事
        // (state 翻成 dismissed、退出 handleIndex)，畫面不必等一次 storage
        // 往返。已解除小節直接掃 entries 的 state(見 sortedScamAllow)，這
        // 裡不必再手工同步一份 allowlist 視圖。
        var handleKey = typeof entry.handle === 'string' ? entry.handle.toLowerCase() : null;
        if (handleKey !== null && scamBlocklist.handleIndex[handleKey] === userId) {
          delete scamBlocklist.handleIndex[handleKey];
        }
        entry.state = 'dismissed';
        entry.dismissedAt = now();
        render(['scam']);
      });
    }

    // 復原不做二次確認:它是「誤解除」的補救動作，本身不破壞任何資料。v2
    // 的復原是把 state 翻回 active，entry 本體(含證據)原地留著——不像 v1
    // 的 allowlist 只存 { at, handle }，復原一次就把證據丟掉。
    function submitScamRestore(userId) {
      var entry = scamBlocklist.entries[userId];
      if (!entry || entry.state !== 'dismissed') return;
      sendBackgroundMessage({ type: 'scam.blocklist.restore', userId: userId }).then(function (res) {
        if (!(res && res.ok === true)) {
          toast(tt('opScamRestoreFailed'));
          return;
        }
        entry.state = 'active';
        delete entry.dismissedAt;
        // 手工把 handle 寫回 handleIndex 得自己重刻一份鍵安全檢查(擋
        // `__proto__` 之類的髒鍵)，容易與 core 那把尺(isUnsafeMapKey／
        // isScamUserIdKey)漂移;重跑一次 readScamBlocklist 讓 core 從
        // entries 整份重建 handleIndex／allowlist 兩張衍生表，同一把尺，
        // 也不留舊 allowlist 視圖的殘影。
        scamBlocklist = readScamBlocklist(scamBlocklist);
        render(['scam']);
      });
    }

    // 網址拆解只為了視覺強調帳號段;一律 textContent/createTextNode，
    // 網址內容源頭是頁面可控管道，禁 innerHTML。紀錄卡片降級顯示(無
    // author/excerpt 時)靠這份拆解邏輯。
    function buildUrlNode(url, cls) {
      var className = cls || 'url';
      // TLD(com/net)一併捕獲並如實顯示:網址本來就可能來自 threads.net
      // (POST_URL_PATTERN 同時允許 com 與 net)，不可硬寫死 'threads.com/'。
      var handleMatch = /^https:\/\/(?:www\.)?threads\.(com|net)\/(@[^/]+)\/(.*)$/.exec(url);
      if (!handleMatch) return h('div', { class: className, text: url });
      var handleEl = h('b', { text: handleMatch[2] });
      return h('div', { class: className }, 'threads.' + handleMatch[1] + '/', handleEl, '/' + handleMatch[3]);
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
    // 以 url+at 精準命中(不只比 url):background 永久合併(同一篇貼文恆為一
    // 張卡，見 sw-history.js 的紀錄合併區塊)，但匯入的資料可能夾帶同
    // url 的多筆舊紀錄，比 url+at 才保證「刪一筆只刪中一筆」。onStorageChanged 已
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
      // persistHistory 先同步把 entries 換成 next，再重畫紀錄視圖才畫到
      // 新清單;寫入結果非同步回來，成功發「已刪除」，失敗回滾 + 失敗 toast。
      persistHistory(next).then(function (res) {
        if (res.ok) toast(tt('opToastDeleted'));
        else onPersistFailed(res);
      });
      render(['history']);
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
      // 掛 data-at 並登錄到 timeNodes:60s ticker 走輕量刷新(refresh)只逐一
      // 改這些節點的 textContent，不重建卡片，才不會偷走焦點/文字選取。
      var headTime = h('span', { class: 'entry-time', text: relTime(e.at), 'data-at': String(e.at) });
      timeNodes.push({ node: headTime, at: e.at });
      var badge = h('span', { class: 'entry-badge', text: tt(KINDS[e.kind].key) });

      var body = [];
      if (hasCardPreview(e)) {
        var hasAuthor = typeof e.author === 'string' && e.author !== '';
        var hasHandle = typeof e.handle === 'string' && e.handle !== '';
        // author 或 handle 任一存在就顯示作者列——author===handle 時入庫端
        // 會把重複的 author 丟棄(只剩 handle)，列不能因此整個消失。
        if (hasAuthor || hasHandle) {
          var nameEl = hasAuthor && h('span', { class: 'entry-author-name', text: e.author });
          var handleEl = hasHandle && h('span', { class: 'entry-handle', text: e.handle });
          body.push(h('div', { class: 'entry-author-row' }, nameEl, handleEl));
        }
        if (typeof e.excerpt === 'string' && e.excerpt !== '') {
          body.push(h('div', { class: 'entry-excerpt', text: e.excerpt }));
        }
      } else {
        body.push(buildUrlNode(e.url, 'entry-url'));
      }

      // 高亮態右上浮出的兩顆快捷鈕:複製連結(對應手機 Copy)、開啟貼文
      // (對應手機 Share2——web 沒有原生分享)。注意這跟詳細視窗底部動作列
      // 的「分享→複製」映射是兩件事，不強行統一。平時態靠 CSS
      // display:none 隱藏，兩顆按鈕都要 stopPropagation，否則點下去會被
      // 卡片自己的 click 冒泡到，順手把詳細視窗也開了。開啟鈕交給瀏覽器原生
      // <a> 行為，handler 只擋冒泡。
      var stop = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
      };
      var quickCopyBtn = iconButton('entry-quick-btn', '#i-copy', tt('opQuickCopyTitle'), function (ev) {
        stop(ev);
        copyEntryUrl(e);
      });
      var openLabel = tt('opOpenTitle');
      var openProps = {
        class: 'entry-quick-btn', href: e.url, target: '_blank', rel: 'noopener',
        title: openLabel, 'aria-label': openLabel, onclick: stop,
      };
      var quickOpenBtn = h('a', openProps, svgUse('#i-external-link'));

      // 點卡片本身(排除快捷鈕區)開詳細視窗，對齊手機版 onPress;Enter/Space
      // 同樣觸發。
      var fromQuick = function (target) {
        return !!(target && target.closest && target.closest('.entry-quick'));
      };
      // 鍵盤可聚焦，讓 :focus-within 高亮態也能靠 Tab 觸發(不只滑鼠 hover);
      // role="button" 補上瀏覽器對原生 button/a 才有的鍵盤啟動行為(div 預設
      // 沒有)。dataset.entryKey 是條目鍵(url|at)，整面重建卡片時據此還原鍵盤
      // 焦點到同一條目。
      var cardProps = {
        class: 'entry-card', tabindex: '0', role: 'button', dataset: { entryKey: e.url + '|' + e.at },
        onclick: function (ev) {
          if (!fromQuick(ev && ev.target)) openEntryDetail(e);
        },
        onkeydown: function (ev) {
          if (!ev || (ev.key !== 'Enter' && ev.key !== ' ') || fromQuick(ev.target)) return;
          ev.preventDefault();
          openEntryDetail(e);
        },
      };
      var header = h('div', { class: 'entry-header' }, h('div', { class: 'entry-meta' }, badge, headTime));
      var quickWrap = h('div', { class: 'entry-quick' }, quickCopyBtn, quickOpenBtn);
      return h('div', cardProps, header, ...body, quickWrap);
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

      renderDetailDeviceRow(e);

      var recordedTimeEl = byId('detailRecordedTime');
      if (recordedTimeEl) recordedTimeEl.textContent = formatAbsoluteTime(e.at);

      // 時間軸鈕:buildSeenTimeline 對缺席/單筆資料回傳 null 時不顯示，
      // 主畫面的記錄時間(=at)已經夠用。鈕文字固定不隨資料變動(次數改
      // 顯示在子層視窗標題)，仍在 JS 端顯式賦值——最小 DOM stub 的
      // querySelectorAll 恆回傳空陣列(i18n.applyDom 掃不到)，只有顯式賦值的
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
    // 子層、清掉 excerpt 展開態)、填內容、以 showModal 顯示。已開著時(切換
    // 條目)只換內容，關閉後焦點仍回最初開啟它的元素。
    function openEntryDetail(e) {
      detailEntry = e;
      if (!byId('detailOverlay')) return;

      // 每次完整開啟(含切換到別的條目)都把子層時間軸視窗收合、excerpt
      // 展開態清掉，避免上一筆的展開態殘留到這一筆。
      closeDialog('timelineOverlay');
      var excerptEl = byId('detailExcerpt');
      if (excerptEl) excerptEl.classList.remove('expanded');

      renderDetailContent(e);
      showDialog('detailOverlay');
    }

    // 原地刷新詳細視窗內容，見 relocateDetailEntry。detailEntry 換成新物件也
    // 讓 url+at 精準刪除拿到不過期的 at。只在開著時重畫，不得重新開啟。
    function refreshDetail(e) {
      if (!isDialogOpen('detailOverlay')) return;
      detailEntry = e;
      renderDetailContent(e);
    }

    // 程式主動關閉(紀錄被刪):先關時間軸子層再關詳細，焦點歸還鏈才正確。
    // detailEntry 在 close 善後清掉(見 bindDetailDialog)。
    function closeEntryDetail() {
      closeDialog('timelineOverlay');
      closeDialog('detailOverlay');
    }

    // original/removedParams 附加列:與淨化後連結列同一套 kv/linkrow/
    // copy-btn 結構(照手機版同一個 CopyRow 元件)，差別只在標籤文案與
    // 沒有 accent 強調。複製鈕直接複製該列的原始值(copyValue)，不是
    // formatDisplayUrl 過的顯示值。
    function buildExtraRowEl(row) {
      var label = row.type === 'original' ? tt('opOriginalLabel') : tf('opTrackingParamLabel', { name: row.name });
      var copyBtn = h('button', {
        class: 'copy-btn',
        text: tt('opCopyShort'),
        onclick: function () {
          copyText(row.copyValue);
        },
      });
      var valueEl = h('span', { class: 'detail-value ellipsis', text: row.display });
      var linkRow = h('div', { class: 'detail-linkrow' }, valueEl, copyBtn);
      return h('div', { class: 'detail-kv' }, h('span', { class: 'detail-key', text: label }), linkRow);
    }

    // 時間軸每一列:軌道+圓點(最新一筆實心主色，其餘空心)+ 時間(絕對
    // 時間，最新一筆用一般文字色，其餘 textSecondary)+「 · 」+ 來源標籤
    // (沿用既有 KINDS 文案;kind 不在白名單內就不附標籤，只顯示時間)。
    // isFirst/isLast 決定圓點是否填色、要不要接續軌道線。
    function buildTimelineRow(record, isFirst, isLast) {
      var hasKind = Object.prototype.hasOwnProperty.call(KINDS, record.kind);
      // 該筆事件的來源裝置(§12 增補:時間軸逐事件各自顯示)。缺 deviceId 的
      // 早期事件不畫這個 span，不寫「未知裝置」(D27)。
      var deviceInfo = seenDeviceInfo(record);
      var dot = h('div', { class: 'timeline-dot' + (isFirst ? ' filled' : '') });
      var rail = h('div', { class: 'timeline-rail' }, dot, !isLast && h('div', { class: 'timeline-line' }));
      // 時間/來源標籤各自用獨立 span 直接賦值 textContent(不是拼接單一字串)——
      // controller smoke 測試組的最小 DOM stub，.textContent 的 getter 只讀直接
      // 賦值過的內部字串，不會遞迴聚合子節點內容，得靠這個結構才驗證得到。
      // 已移除標記掛在 .timeline-device 之內，不另加兄弟節點:整列的結構
      // (時間 / kind / 裝置)維持不變。
      var textEl = h(
        'div',
        { class: 'timeline-text' + (isFirst ? '' : ' secondary') },
        h('span', { text: formatAbsoluteTime(record.at) }),
        hasKind && h('span', { class: 'timeline-kind', text: '　· ' + tt(KINDS[record.kind].key) }),
        deviceInfo !== null &&
          h('span', { class: 'timeline-device', text: deviceInfo.name }, deviceInfo.removed && removedTagNode())
      );
      return h('div', { class: 'timeline-row' }, rail, textEl);
    }

    function bindDetailDialog() {
      // ✕ 走 closeEntryDetail，時間軸子層若還開著一併先關。
      on('detailClose', 'click', closeEntryDetail);
      bindDialog('detailOverlay', null, function () {
        if (!isDialogOpen('detailOverlay')) detailEntry = null;
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
        showDialog('timelineOverlay');
      });
      bindDialog('timelineOverlay', 'timelineClose');
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

    // ---- 視圖分派 ----
    // 每個視圖只依賴一份狀態，狀態變了只重畫吃它的視圖。
    var VIEWS = {
      i18n: function () { applyI18nDom(); }, // ← locale:data-i18n 靜態文案與語言鈕
      history: function () { renderChart(renderStats()); renderList(); }, // ← entries
      scam: function () { renderScamList(); renderScamAllowlist(); }, // ← scamBlocklist
      scamBar: function () { renderScamDisabledBar(); }, // ← scamGuardEnabled 開關
      account: function () { renderAccount(syncState); renderScamEvictedHint(syncState); }, // ← syncState 廣播
      devices: function () { if (isDialogOpen('devicesOverlay')) renderDevices(); }, // 只在開著時重畫
    };
    // 同一輪畫多個視圖時的固定順序。i18n 必須最先:它用 data-i18n 初值重設
    // 靜態文字(deviceNote 等)，account 排在它之後才能把登入態文案蓋回去;
    // 其餘 JS 產生的區塊也排在 i18n 之後，切語言時一律拿到新語言。
    var VIEW_ORDER = ['i18n', 'history', 'scam', 'scamBar', 'account', 'devices'];

    // 重畫指定視圖的聯集，每個視圖至多一次，依 VIEW_ORDER 排序。
    function render(names) {
      var wanted = new Set(names);
      VIEW_ORDER.forEach(function (name) {
        if (wanted.has(name)) VIEWS[name]();
      });
    }

    // 整頁重畫:只給首次繪製(init)與切換語言用。
    function renderAll() {
      render(VIEW_ORDER);
    }

    // syncState 不重畫:只換刪除分流(軟刪／硬刪)用的 syncAccount，帳號區畫的是
    // background 廣播的卡片狀態(setSyncState)。themePref 不重畫:applyTheme
    // 只改 data-theme 與主題鈕圖示。
    var KEY_VIEWS = {
      local: { history: ['history'], scamBlocklist: ['scam'], syncState: [] },
      sync: { langPref: VIEW_ORDER, themePref: [] },
    };

    // 詳細視窗開著時，紀錄換新後以 url 重新定位 detailEntry:找得到就只刷新
    // 內容(refreshDetail，不重置使用者正在看的時間軸子層／展開全文——別處
    // 寫入無關紀錄不該打斷正在閱讀的人)，找不到(已被刪除／清除)就關閉。
    function relocateDetailEntry() {
      if (!detailEntry || !isDialogOpen('detailOverlay')) return;
      var url = detailEntry.url;
      var match = entries.find(function (e) { return e.url === url; });
      if (match) refreshDetail(match);
      else closeEntryDetail();
    }

    // chrome.storage.onChanged 的單一入口(options-init.js 原封轉交 changes
    // 與 areaName)。先把這批變動全部寫進狀態，再把受影響視圖的聯集畫一次:
    // 同一批帶多個鍵時，每個視圖至多重畫一次。開關直接設 checkbox.checked
    // (不觸發 change 事件)，不會迴圈寫回 storage;本頁自己寫的變更回彈到
    // 這裡，重設同一個值是無害的 no-op。
    function onStorageChanged(changes, area) {
      var keyViews = KEY_VIEWS[area];
      if (!changes || !keyViews) return;
      var has = function (key) { return Object.hasOwn(changes, key); };
      var next = function (key) { return changes[key] && changes[key].newValue; };
      var names = [];
      var focusKey = null;

      if (area === 'local') {
        if (has(HISTORY_KEY)) {
          // 紀錄牆整面重建會換掉卡片節點:先記下鍵盤焦點所在的條目，畫完還回去。
          focusKey = captureFocusedEntryKey();
          entries = sanitizeEntries(next(HISTORY_KEY) || []);
          relocateDetailEntry();
        }
        if (has(SCAM_BLOCKLIST_KEY)) scamBlocklist = readScamBlocklist(next(SCAM_BLOCKLIST_KEY));
        if (has(SYNC_ACCOUNT_KEY)) syncAccount = TCLCore.normalizeSyncState(next(SYNC_ACCOUNT_KEY));
      } else {
        if (has('langPref')) {
          var lp = next('langPref');
          langPref = lp === 'zh' || lp === 'en' ? lp : null;
          locale = i18n.resolveLocale(langPref);
        }
        if (has('themePref')) {
          var tp = next('themePref');
          themePref = THEME_ORDER.indexOf(tp) !== -1 ? tp : 'auto';
          applyTheme();
        }
      }
      SETTINGS.forEach(function (s) {
        if (s.area !== area || !has(s.key)) return;
        var el = byId(s.key);
        if (el) el.checked = settingValue(next(s.key), s.def);
        if (s.view) names.push(s.view);
      });

      Object.keys(changes).forEach(function (key) {
        if (Object.hasOwn(keyViews, key)) names.push.apply(names, keyViews[key]);
      });
      render(names);
      refocusEntryCard(focusKey);
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

      // 篩選下拉(auto popover)
      var filterBtn = byId('filterBtn');
      var chipsRow = byId('chipsRow');
      wirePopover(filterBtn, chipsRow);
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
        hidePop(chipsRow);
        renderList();
      });

      // ⋯ 選單(auto popover)。項目要開對話框時先收選單，焦點回 ⋯ 鈕，對話框
      // 關閉後才還得回去。
      var moreMenu = byId('moreMenu');
      wirePopover(byId('moreBtn'), moreMenu);

      // 匯出:直接下載檔案。
      on('exportBtn', 'click', function () {
        hidePop(moreMenu);
        var payload = buildExportPayload(visibleEntries(), new Date(now()).toISOString());
        download('threads-clean-link-history.json', JSON.stringify(payload, null, 2));
        toast(tt('opToastExported'));
      });

      // 匯入:對話框(選檔或貼上)。
      on('importBtn', 'click', function () {
        hidePop(moreMenu);
        var textEl = byId('modalText');
        if (textEl) textEl.value = '';
        showDialog('overlay');
      });
      bindDialog('overlay', 'modalClose');
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
          render(['history']);
          closeDialog('overlay');
          toast(
            result.skipped
              ? tf('opToastImportedSkip', { n: result.added, m: result.skipped })
              : tf('opToastImported', { n: result.added })
          );
        });
      });

      // 清除全部:走共用確認框(openConfirm)，確認後才寫入。
      on('clearBtn', 'click', function () {
        hidePop(moreMenu);
        openConfirm({
          titleKey: 'opClearAll',
          okKey: 'opClearDo',
          tone: 'danger',
          icon: '#i-trash',
          desc: tf('opClearConfirmDesc', { n: visibleEntries().length }),
          // 【依登入態分流】(D53)已登入時逐筆轉墓碑:id 不變、寫下 deletedAt
          // 與 dirty，由同步引擎以 deletes[] 分批送出(每批 ≤50)，伺服器 ack
          // 後才從本機移除，其他裝置經墓碑各自刪除。既有墓碑原樣保留(刪除時戳
          // 不動);沒有 id 的舊資料送不上雲，直接移除。未登入維持硬刪。
          // 只寫 history 一個鍵，syncState 由同步引擎獨佔維護。
          action: function () {
            var signedIn = isSignedIn();
            var next = [];
            if (signedIn) {
              var deletedAt = now();
              entries.forEach(function (x) {
                if (TCLCore.isTombstone(x)) {
                  next.push(x);
                  return;
                }
                if (typeof x.id !== 'string' || !x.id) return;
                next.push(Object.assign({}, x, { deletedAt: deletedAt, dirty: true }));
              });
            }
            persistHistory(next).then(function (res) {
              if (!res.ok) {
                onPersistFailed(res);
                return;
              }
              // 線上時立刻推一次，墓碑不必等下一個週期 alarm 才傳到其他裝置。
              if (signedIn) sendSyncAction({ type: 'sync.now' });
              render(['history']);
              toast(tt('opToastCleared'));
            });
          },
        });
      });
      // close 事件比 close() 晚一拍，動作若又開了新的確認框，不能把新掛上的
      // confirmAction 清掉。
      bindDialog('confirmOverlay', 'confirmCancel', function () {
        if (!isDialogOpen('confirmOverlay')) confirmAction = null;
      });
      on('confirmOk', 'click', function () {
        var act = confirmAction;
        confirmAction = null;
        closeDialog('confirmOverlay');
        if (typeof act === 'function') act();
      });
    }

    // 每顆開關的 change 寫回 schema 指定的 storage 區;帶 view 的(總開關的
    // 狀態列)順手立即重畫，不必等 storage.onChanged 往返。
    function bindSettings() {
      SETTINGS.forEach(function (s) {
        on(s.key, 'change', function (event) {
          var el = event && event.target ? event.target : byId(s.key);
          (s.area === 'local' ? localStore : syncStorage).set({ [s.key]: el.checked });
          if (s.view) render([s.view]);
        });
      });
    }

    // ---- 分頁列(總覽／貼文／標記) ----

    // 分頁狀態的唯一權威是 location.hash:#overview／#posts／#flags，缺席或
    // 未知一律退回 overview。切分頁只改寫 hash(不走 location.assign／
    // replace／reload——那會重載整頁)，外部改 hash(上一頁、手打網址、設定卡
    // 的「管理名單 →」錨點)則由 hashchange 同步回畫面。
    var TAB_NAMES = ['overview', 'posts', 'flags'];
    var TAB_DEFAULT = 'overview';

    function queryAll(selector) {
      if (typeof document.querySelectorAll !== 'function') return [];
      return Array.prototype.slice.call(document.querySelectorAll(selector) || []);
    }

    function tabFromHash(hash) {
      var name = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
      return TAB_NAMES.indexOf(name) !== -1 ? name : TAB_DEFAULT;
    }

    // 冪等:同一個分頁套第二次不留痕跡。真實瀏覽器裡「點 tab 改 hash」會再
    // 發一次 hashchange，這個函式因此每次切換都會跑兩遍。
    function applyTab(name) {
      var target = TAB_NAMES.indexOf(name) !== -1 ? name : TAB_DEFAULT;
      queryAll('[role="tab"]').forEach(function (btn) {
        // 未選中的分頁顯式寫 "false" 而非移除屬性:讀螢幕器要靠它判定整列
        // 的選中狀態。
        btn.setAttribute(
          'aria-selected',
          btn.getAttribute('data-tab') === target ? 'true' : 'false'
        );
      });
      queryAll('[data-panel]').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-panel') !== target;
      });
    }

    function bindTabs() {
      var tabs = queryAll('[role="tab"]');
      if (tabs.length === 0) return;
      tabs.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.getAttribute('data-tab');
          if (TAB_NAMES.indexOf(name) === -1) return;
          if (loc) loc.hash = '#' + name;
          applyTab(name);
        });
      });
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('hashchange', function () {
          applyTab(tabFromHash(loc ? loc.hash : ''));
        });
      }
      // 載入時讀一次 hash，重新整理才停得住原分頁。hash 缺席時不補寫
      // '#overview'，網址維持乾淨。
      applyTab(tabFromHash(loc ? loc.hash : ''));
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
      var localKeys = Object.assign(
        { [HISTORY_KEY]: [], [SYNC_ACCOUNT_KEY]: null, [SCAM_BLOCKLIST_KEY]: null },
        settingDefaults('local')
      );
      var readLocal = Promise.resolve(localStore.get(localKeys));
      return Promise.all([readSync, readLocal]).then(function (results) {
        var settings = results[0] || {};
        var localData = results[1] || {};
        entries = sanitizeEntries(localData[HISTORY_KEY]);
        syncAccount = TCLCore.normalizeSyncState(localData[SYNC_ACCOUNT_KEY]);
        scamBlocklist = readScamBlocklist(localData[SCAM_BLOCKLIST_KEY]);

        langPref = settings.langPref === 'zh' || settings.langPref === 'en' ? settings.langPref : null;
        locale = i18n.resolveLocale(langPref);
        themePref = THEME_ORDER.indexOf(settings.themePref) !== -1 ? settings.themePref : 'auto';

        var byArea = { sync: settings, local: localData };
        SETTINGS.forEach(function (s) {
          var el = byId(s.key);
          if (el) el.checked = settingValue(byArea[s.area][s.key], s.def);
        });

        applyTheme();
        bindSettings();
        bindTopbar();
        bindToolbar();
        bindDetailDialog();
        bindChartTooltip();
        bindAccount();
        bindDevices();
        bindScamDialogs();
        bindTabs();
        renderAll();

        // 雲端同步狀態非同步取得，先以 DEFAULT_SYNC_CARD_STATE(未登入)完成首次
        // 繪製(above 的 renderAll)，真值回來後才刷新。init() 等這步結束
        // 才 resolve，讓呼叫端 await controller.init() 後畫面已是最終狀態，
        // 不需另外猜測時序;runtime 未注入或 background 沒回應時
        // fetchSyncState 立即 resolve(見該函式)，不會拖慢 init()。
        return fetchSyncState().then(function (state) {
          syncState = state;
          render(['account']);
        });
      });
    }

    // setHistory／setSyncSettings／setLocalSettings:onStorageChanged 的薄包
    // 裝，保留給既有呼叫端(測試直接打)。setLocalSettings 不轉交 history 鍵:
    // 那一鍵歸 setHistory，舊式接線(先 setHistory 再整包 setLocalSettings)
    // 才不會讓同一批紀錄被處理兩次。
    function setHistory(list) {
      onStorageChanged({ [HISTORY_KEY]: { newValue: list } }, 'local');
    }
    function setSyncSettings(changes) {
      onStorageChanged(changes, 'sync');
    }
    function setLocalSettings(changes) {
      if (!changes) return;
      var rest = Object.assign({}, changes);
      delete rest[HISTORY_KEY];
      onStorageChanged(rest, 'local');
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
    function refocusEntryCard(key) {
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
      setLocalSettings: setLocalSettings,
      onStorageChanged: onStorageChanged,
      accountView: accountView,
      applyAccountView: applyAccountView,
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
