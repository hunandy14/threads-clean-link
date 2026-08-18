// options.js — options 頁(設定與淨化紀錄)的邏輯層。比照 popup.js 的模式:
// 可注入 document/storage/i18n 的純函式模組,不直接碰全域 chrome,離線可測;
// options-init.js 負責接上真的 chrome.*(見 options-init.js)。
//
// 純函式(filterEntries/mergeImportedEntries/buildExportPayload/aggregateStats)
// 獨立匯出,測試直接打;DOM 佈線集中在 createOptionsController。
(function (root) {
  'use strict';

  // 三顆開關的預設值。autoClean 與 popup.js、background.js、bridge.js 一致
  // (0.5.0 方案甲:預設改 false，配合另一車道調整 background.js 的預設值);
  // saveHistory 與 background.js 一致(guard/bridge 不下放);postCopyEnabled
  // 與 popup.js 鏡像(貼文互動列複製按鈕，見 post-icon.js，另一車道)。
  //
  // 【PM 審查後移除】notifySuccess(成功時顯示通知)整組:R1 同輪已把成功
  // 通知整套拆光，這顆開關合併後零讀取端，留著只會變成誤導使用者的死
  // UI——不是「另一車道尚未拆通知」，是已經拆完了，上一輪的保留理由是
  // 過期情報。
  var OPTIONS_DEFAULT_SETTINGS = {
    autoClean: false,
    saveHistory: true,
    postCopyEnabled: true,
  };
  var SETTING_IDS = ['autoClean', 'saveHistory', 'postCopyEnabled'];

  var HISTORY_KEY = 'history';
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
  //
  // 【審查修正，url 樣式統一】長度上限 60→80(handle/post id 各自)——這裡
  // 是全 repo 對「合法貼文網址長什麼樣」的單一權威定義，字元類本身不放寬
  // (仍是嚴格白名單，只調長度上限)。right-click(menu)寫入路徑走的是
  // background.js 自己的驗證，過去兩邊上限沒對齊，本頁讀取/整形寫回時
  // 就可能把 background 端認可、但超出這裡舊上限(60)的合法 menu 紀錄
  // 當「形狀不對」整筆濾掉，使用者會發現右鍵還原的紀錄「消失了」。runtime
  // 車道會讓 menu 寫入端跟進同一組上限(80)，兩邊數字一致之後這類誤刪
  // 才會真正根治;persistHistory 沿用既有「整形後寫回」慣例不變(entries
  // 進來時已經過 sanitizeEntries/mergeImportedEntries 的正規化，寫回
  // storage 的內容本來就是整形後的)。
  var POST_URL_PATTERN =
    /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/(@[A-Za-z0-9._]{1,80}\/post\/[A-Za-z0-9_-]{1,80}))\/?(?:[?#].*)?$/i;

  // 【審查修正】刪除每個 kind 項目的死欄位 icon(如 '#i-link')——badge 渲染
  // (buildEntryCard/openEntryDetail/buildTimelineRow)一律只用 .key 查
  // i18n 文案，純文字 pill 徽章，從沒有任何地方讀過 .icon 這個屬性畫過
  // SVG，是舊版圖示式徽章設計淘汰後留下的殘骸。
  var KINDS = {
    share: { key: 'opKindShare' },
    strip: { key: 'opKindStrip' },
    menu: { key: 'opKindMenu' },
    // 貼文互動列複製 icon(post-icon.js)寫入剪貼簿成功後的路徑。
    icon: { key: 'opKindIcon' },
  };

  // ---- 純函式 ----

  // 選填欄位截斷:非字串一律回傳 undefined(呼叫端據此決定整欄不寫入),
  // 字串則截斷至長度上限。author/handle/excerpt 共用同一份規則。
  //
  // 【審查修正】補空字串丟棄，與 background.js 的 sanitizeHistoryField
  // 對齊(該函式明文:「空字串比照非字串同樣丟棄，不落 author:'' 這種空
  // 欄位」)。原本這裡漏了這條，等於兩層對「合法值」的認定不一致——
  // background 端已經先擋掉空字串，options 端理論上收不到，但讀取/匯入
  // 階段是獨立信任邊界(縱深防禦，不假設寫入端永遠沒漏)，仍應該自己也擋。
  function sanitizeTextField(value, max) {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.slice(0, max);
  }

  // 紀錄去重合併(見 background.js 的 mergeHistoryEntry/sanitizeSeenList
  // 註解):seen[] 是「先前已經落盤的資料」，可能被匯入檔或未來版本的存放
  // 格式汙染，options.js 這側讀取(sanitizeEntries)與匯入
  // (mergeImportedEntries)都是獨立的資料入口，各自要逐筆 sanitize——at
  // 需為有限數字，不符就整筆丟棄(容忍陣列裡部分項目壞掉，不因此整個陣列
  // 作廢)。kind 是選填標籤:background.js 合併時若既有條目缺 seen，會照
  // 手機版語意補種一筆不帶 kind 的起始紀錄(對齊
  // `existing.seen ?? [{ at: existing.receivedAt }]`)，這裡要一併容忍，
  // 不能把合法的種子記錄當成損毀資料丟掉;kind 若有出現則需在白名單內
  // (直接沿用 KINDS，與 background.js 的 SEEN_KIND_WHITELIST 是同一組合
  // 法值)，不在白名單就整筆丟棄。順便裁到 SEEN_MAX 上限，與 background.js
  // 寫入時的裁切規則對齊(縱深防禦，不假設寫入端永遠沒漏)。輸入非陣列一
  // 律回傳空陣列。
  var SEEN_MAX = 50;
  function sanitizeSeenList(seenList) {
    if (!Array.isArray(seenList)) return [];
    var out = [];
    for (var i = 0; i < seenList.length; i++) {
      var record = seenList[i];
      if (!record || typeof record !== 'object') continue;
      if (typeof record.at !== 'number' || !isFinite(record.at)) continue;
      if (record.kind === undefined) {
        out.push({ at: record.at });
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(KINDS, record.kind)) continue;
      out.push({ at: record.at, kind: record.kind });
    }
    return out.slice(-SEEN_MAX);
  }

  // F 案(紀錄資料層補齊 original/removedParams，對齊手機 ShareHistoryItem):
  // original 選填欄位，規則同 sanitizeTextField(非字串/空字串整欄丟棄，
  // 字串截斷至長度上限)，額外多一條——截斷「前」若與該筆條目自己的 url
  // 完全相同就整欄丟棄:手機版語意是「取與 cleaned 不同者」，相同代表沒
  // 有額外資訊。與 background.js 的 sanitizeOriginalField 規則一致(縱深
  // 防禦，不依賴寫入端永遠沒漏)。
  var ENTRY_ORIGINAL_MAX = 2048;
  function sanitizeOriginalField(value, url) {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    if (value === url) return undefined;
    return value.slice(0, ENTRY_ORIGINAL_MAX);
  }

  // F 案:removedParams 選填欄位，型別對齊手機版 RemovedParam({ key, value },
  // 與 background.js 的 sanitizeRemovedParams 同一組門檻)。上限
  // REMOVED_PARAMS_MAX 筆，每筆 key 需為非空字串且 ≤ REMOVED_PARAM_KEY_MAX、
  // value 需為字串(可為空字串)且 ≤ REMOVED_PARAM_VALUE_MAX，任一不符就整
  // 筆丟棄(容忍陣列裡部分項目壞掉，不因此讓整個陣列作廢，寫法對齊
  // sanitizeSeenList)。輸入非陣列，或 sanitize 後一筆不剩，回傳
  // undefined(呼叫端據此整欄不寫入)。
  var REMOVED_PARAMS_MAX = 20;
  var REMOVED_PARAM_KEY_MAX = 64;
  var REMOVED_PARAM_VALUE_MAX = 512;
  function sanitizeRemovedParams(value) {
    if (!Array.isArray(value)) return undefined;
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (out.length >= REMOVED_PARAMS_MAX) break;
      var item = value[i];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.key !== 'string' || item.key.length === 0 || item.key.length > REMOVED_PARAM_KEY_MAX) continue;
      if (typeof item.value !== 'string' || item.value.length > REMOVED_PARAM_VALUE_MAX) continue;
      out.push({ key: item.key, value: item.value });
    }
    return out.length > 0 ? out : undefined;
  }

  // 從 storage 讀出的清單防禦性整形:非陣列→空;逐筆丟掉核心欄位形狀不對的
  // 項目——url 除了型別是字串，還要通過 POST_URL_PATTERN 的形狀驗證才收
  // (縱深防禦，PM 審查後補:上一輪收藏庫基座的 sanitizeFavorites 就有這道
  // url 形狀檢查，方案甲把收藏搬進 sanitizeEntries 時漏掉了，這裡補回來)。
  // 渲染層 buildEntryCard 的 openLink.href = e.url、剪貼簿複製都是 url
  // sink，不該仰賴「寫入端(background.js/匯入合併)永遠沒漏」這個假設，
  // 讀取階段就該把形狀不對的 url 整筆擋掉。選填欄位(author/handle/
  // excerpt,0.5.0 方案甲新增)型別不是字串就整欄丟棄、字串則截斷至長度
  // 上限，entry 本身仍保留(與核心欄位的「整筆丟棄」規則不同，見下方 map)。
  function sanitizeEntries(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function (e) {
        return (
          e &&
          typeof e.url === 'string' &&
          POST_URL_PATTERN.test(e.url) &&
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
        // 紀錄去重合併新增:seen[] 比照 author/handle/excerpt 的「缺席不落
        // 空值」慣例——sanitize 後真的有剩才寫入，全丟或本來就沒有都整欄
        // 不寫。這一行同時承擔驗證與保留兩職:sanitizeSeenList 逐筆丟掉
        // 形狀不對的項目(縱深防禦，同上面 url 的道理，不該仰賴寫入端永遠
        // 沒漏)，同時也是讓 seen 真正「路過」存活到渲染層的唯一關卡——
        // 少這一步，即使 storage 真的有 seen，渲染端也永遠讀不到，詳細
        // 視窗的「時間軸」鈕會變成永遠打不開的死功能。
        var seenList = sanitizeSeenList(e.seen);
        if (seenList.length > 0) out.seen = seenList;
        // F 案:original/removedParams 比照 author/handle/excerpt 的「缺席
        // 不落空值」慣例。original 的相同判斷用這筆條目自己的 url(out.url，
        // 此時已通過上面的形狀驗證)。
        var original = sanitizeOriginalField(e.original, out.url);
        if (original !== undefined) out.original = original;
        var removedParams = sanitizeRemovedParams(e.removedParams);
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

  // 0.5.0 方案甲:entries 只留三個核心欄位的年代已過去，author/handle/
  // excerpt 為字串時一併輸出(選填，沿用「非字串/缺席就整欄不寫」的慣例)。
  //
  // 【審查修正】補上 seen/original/removedParams 三欄，同一套「缺席不寫」
  // 慣例——先前只匯出 author/handle/excerpt，這三個較晚加入 schema 的
  // 欄位被漏掉，使用者匯出備份、換裝置/瀏覽器匯入回來時，時間軸與
  // 原始連結/追蹤參數資料會無聲消失(entries 本身還在，只是這幾欄丟了)。
  // 匯出值直接沿用 entry 已經 sanitize 過的形狀(entries 參數本身就是
  // sanitizeEntries 的輸出)，不必在這裡重新驗證。
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

  // 匯入合併:url 過 POST_URL_PATTERN 白名單並正規化(容忍尾隨斜線/query/
  // hash)、以正規化後的 url 與現有去重;kind 非白名單→'share',at 非有限
  // 數字→now;author/handle/excerpt 逐條 sanitize(型別+截斷，規則同
  // sanitizeEntries)。合併後新到舊排序。
  //
  // 【使用者拍板，紀錄不設上限】合併結果不再裁切——舊版在此 slice(0,
  // HISTORY_LIMIT) 到 1000 筆，現在移除，匯入多少留多少;HISTORY_LIMIT
  // 常數本身也一併移除(此檔內唯一用途就是這道截斷)。
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
      // 紀錄去重合併新增:匯入檔的 seen[] 屬外部輸入，同樣要逐筆 sanitize
      // (見 sanitizeSeenList 註解)，防止偽造/損毀的 at、kind 混進來。
      var seenList = sanitizeSeenList(raw && raw.seen);
      if (seenList.length > 0) entry.seen = seenList;
      // F 案:匯入檔的 original/removedParams 同屬外部輸入，逐欄 sanitize
      // (見 sanitizeOriginalField/sanitizeRemovedParams 註解)。original 的
      // 相同判斷用正規化後的 url(match[1])，不是匯入檔裡未正規化的原始
      // url 字串。
      var original = sanitizeOriginalField(raw && raw.original, url);
      if (original !== undefined) entry.original = original;
      var removedParams = sanitizeRemovedParams(raw && raw.removedParams);
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

  // 0.5.0:卡片詳細視窗長文判定，與手機版 history-detail-dialog.tsx 的
  // isLongExcerpt 對齊(EXCERPT_DIALOG_LINES=15):行數或字元量任一超標就
  // 顯示「展開全文」。字元量門檻沿用手機版估算(每行約 22 字，15*22=330)。
  var EXCERPT_DIALOG_LINES = 15;
  function isLongExcerpt(excerpt) {
    if (typeof excerpt !== 'string' || excerpt === '') return false;
    var lines = excerpt.split('\n').length;
    return lines > EXCERPT_DIALOG_LINES || Array.from(excerpt).length > EXCERPT_DIALOG_LINES * 22;
  }

  // UI 全面對齊手機任務:互動模型翻轉後卡片右上常駐的 ⋮ 選單整組移除
  // (見 options.html 的 .entry-card 註解)，buildEntryActions 是該選單
  // 專用的動作組成純函式，唯一呼叫端消失後這顆函式也一併移除(PM 授權
  // 「原 kebab 相關碼與測試移除」)。刪除動作收斂到只在詳細視窗做，底部
  // 動作列(detailCopyBtn/detailOpenLink/detailDeleteBtn)本來就是寫死的
  // 靜態 HTML，不經這顆函式生成，故移除它不影響底部動作列。

  // UI 全面對齊手機任務，work item 5/7:純函式:formatDisplayUrl——對齊
  // 手機版 lib/format-display-url.ts，把完整網址轉成適合顯示的精簡路徑
  // (去 scheme + 網域，只留 path+query+hash，去掉開頭斜線)。用於詳細
  // 視窗的「淨化後連結」與「原始連結」兩列的顯示值(複製仍用完整原始
  // 網址，只影響顯示)。解析失敗 fail-open 回傳原字串，非字串輸入回傳
  // 空字串(呼叫端已經先做過型別檢查，這裡是最後一道防線)。
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

  // UI 全面對齊手機任務，work item 7:純函式:buildDetailExtraRows——對齊
  // 手機版 CopyRow 的「原始連結」「追蹤參數 {name}」兩類列。
  //
  // 【審查修正】removedParams 元素的欄位名是 { key, value }，不是
  // { name, value }——權威來源是手機版 link-cleaner.ts:171 與
  // detail-dialog 的 p.key，也是 F 案(feat/record-origin)background.js
  // 的 sanitizeRemovedParams 實際落盤的形狀(見上面 REMOVED_PARAM_KEY_MAX
  // 那組門檻)。上一輪(feat/ui-align-mobile)寫成 p.name 是本分支自己的
  // fixture/實作誤植，兩邊 schema 沒對齊測試卻是綠的——因為測試 fixture
  // 也一起錯著寫，形成互相遮蔽的假綠燈。這裡讀 p.key，回傳物件本身仍用
  // `name` 這個 key(給下面 tf('opTrackingParamLabel', { name: row.name })
  // 這行的 i18n 樣板插值用，屬顯示層命名，跟資料層的 key/value 是两回事，
  // 不用跟著改)。
  //
  // entry.original 缺席/非字串/與 cleaned 相同(手機版:
  // item.original !== item.cleaned 才顯示)一律不產生該列；
  // entry.removedParams 缺席/非陣列/陣列內項目形狀不對(缺 key/value 或
  // 非字串)一律濾掉該筆，不因此整組作廢。回傳陣列供呼叫端逐筆建 DOM，
  // 每筆為 { type: 'original' | 'param', name?, display, copyValue }。
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

  // 0.5.0:「時間軸」顯示邏輯，對齊手機版 history-detail-dialog.tsx——
  // seen.length > 1 才顯示時間軸(單筆時主畫面的「記錄時間」已經夠用),
  // 新到舊排序。另一車道(fix/dedup-merge)才會把 seen:[{at,kind}] 加進
  // 條目 schema，本分支不含該變更，故防禦寫法:entry.seen 缺席、非陣列，
  // 或陣列內項目形狀不對(缺 at/at 非有限數字)一律當作不存在，回傳 null
  // (呼叫端據此決定要不要顯示時間軸鈕)，合併後自然接通不用再改一次。
  // 來源標籤用既有 KINDS 文案(短碼解析/剪除參數/右鍵還原/貼文按鈕),
  // 不是手機版的 share/clipboard 二分。
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
  // 次數(索引 13 = 今天)、最舊一筆時間戳。
  //
  // 【審查後補註】counts 算了 share/strip/menu/icon 四個 kind 的筆數，但
  // 統計磚版面(options.html 的 .stats)只給短碼解析/剪除參數/貼文按鈕
  // 三個 kind 各開一格(加上累計/本週共 5 格)，menu(右鍵還原)沒有對應
  // 磚——這是刻意的版面取捨，不是漏畫:右鍵還原是低頻的手動備援路徑，
  // 不特別佔一格版面。counts.menu 仍照算，一來維持四個 kind 算法一致不用
  // 特殊處理，二來日後若要幫它加磚，這裡不必再回頭補。
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

    // 刪除只在詳細視窗做(照手機版 DialogActions 的位置——手機版本來就
    // 沒有卡片層級的刪除入口，這輪互動模型翻轉撤掉 web 自製的常駐 ⋮ 選單
    // 後兩邊收斂一致)。沿用既有慣例等級:直接改 storage + toast，不另開
    // 確認框(「清除全部」這種一次清光的破壞性動作才走確認框;刪單筆歷來
    // 就是即時動作)。
    //
    // 【審查修正】改以 url 比對(不再疊 at)——紀錄以 url 去重合併之後，
    // 同一個 url 本來就只會有一筆，疊 at 反而是多餘的精準比對，一旦
    // detailEntry 手上拿的是切換條目前的舊物件(at 因別處寫入而更新過)
    // 就會比對失敗，刪不掉正在看的那筆。同時補上「有沒有真的命中」的判斷:
    // 沒命中(例如已經被別的分頁/storage 同步事件先刪掉)就不寫入、不動
    // 視窗、也不發「已刪除」的成功 toast——避免對使用者謊報一個沒發生的
    // 動作。
    function deleteEntry(e) {
      var hit = false;
      var next = entries.filter(function (x) {
        if (x.url === e.url) {
          hit = true;
          return false;
        }
        return true;
      });
      if (!hit) return;
      persistHistory(next);
      if (detailEntry && detailEntry.url === e.url) closeEntryDetail();
      renderAll();
      toast(tt('opToastDeleted'));
    }

    // 單張紀錄卡片:與手機版 history-card.tsx 逐項對齊——卡頭(kind 徽章 +
    // 相對時間)→ hasCardPreview 為真時顯示作者列(author 粗體 + @handle
    // 灰階，皆存在才顯示 handle)+ excerpt(兩行截斷);否則降級顯示網址
    // (比照舊版紀錄列樣式)。無縮圖(刻意，og:image 會過期)。
    //
    // UI 全面對齊手機任務(使用者拍板:互動照手機):照手機版的「選中態」
    // 取代上一輪自製的常駐 ⋮ 選單——手機版沒有 web 這種常駐選單，是
    // hover/press 時邊框轉主色、右上浮出複製/分享兩顆快捷 icon(Copy/
    // Share2)，web 用 :hover 與 :focus-within 模擬同一套視覺(見
    // options.html 的 .entry-card 註解)，快捷鈕映射複製連結/開啟貼文;
    // 點卡片本身(排除快捷鈕區)開詳細視窗，對齊手機版 onPress。刪除動作
    // 隨互動模型翻轉收斂到只在詳細視窗做，卡片層級不再有刪除入口。
    function buildEntryCard(e) {
      var card = document.createElement('div');
      card.className = 'entry-card';
      // 鍵盤可聚焦，讓 :focus-within 高亮態也能靠 Tab 觸發(不只滑鼠
      // hover);role="button" + Enter/Space 觸發，補上瀏覽器對原生
      // button/a 才有的鍵盤啟動行為(div 預設沒有)。
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'button');

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

      // 高亮態右上浮出的兩顆快捷鈕:複製連結(對應手機 Copy)、開啟貼文
      // (對應手機 Share2——web 沒有原生分享，PM 裁決這顆快捷鈕映射為
      // 開啟貼文;注意這跟詳細視窗底部動作列的「分享→複製」映射是兩件
      // 事，各自照各自的權威來源，不強行統一)。平時態靠 CSS display:none
      // 隱藏，兩顆按鈕都要 stopPropagation，否則點下去會被卡片自己的
      // click 冒泡到，順手把詳細視窗也開了。
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

    // ---- 詳細視窗(UI 全面對齊手機任務:結構/行為/間距/字級/圓角/按鈕
    // 樣式一律照手機版 history-detail-dialog.tsx + dialog-shell.tsx 的
    // 字面 token 值，唯一數值權威，LeafPage demo 已除名)----
    //
    // 版面:✕ 關閉鈕(右上，對齊 DialogCloseButton)→ 卡頭(徽章+相對時間)
    // → 作者列(16px/600 + 14px/500)→ excerpt(15 行截斷，對齊
    // EXCERPT_DIALOG_LINES)+ 超長時「展開全文」(主色+展開圖示)→ 淨化後
    // 連結 kv(標籤在上、數值+複製鈕在下一列，accent 強調，值為
    // formatDisplayUrl 後的正規路徑)→ 原始連結/追蹤參數 kv(有資料才畫，
    // 見 buildDetailExtraRows)→ 記錄時間 kv(seen 有多筆時多一顆「時間軸」
    // 鈕，點下去開子層視窗)→ 底部等寬動作列(複製/開啟/刪除，對齊
    // DialogActions/DialogButton:destructive 只變文字色，不是實心底色)。
    //
    // 手機版「展開全文」是巢狀開第二層 Modal，理由是「RN 在 iOS 不支援
    // 兄弟層 Modal 並開」——這是 iOS 平台限制，web 沒有這個問題，故改用
    // 原地展開(移除 line-clamp)取代巢狀第二個 overlay，行為等價但實作
    // 更簡單。「時間軸」則相反:PM 補充使用者提供的手機實機截圖後改回
    // 巢狀子層視窗(timelineOverlay)，因為手機版時間軸本來就是巢狀 Modal
    // (沒有 iOS 平台限制要迴避)，逐項對齊實機截圖比「展開全文」那條
    // web 化裁量更優先。
    function openEntryDetail(e) {
      detailEntry = e;
      var overlay = byId('detailOverlay');
      if (!overlay) return;

      // 每次開啟(含切換到別的條目)都把子層時間軸視窗收合，避免上一筆
      // 的展開態殘留到這一筆。
      closeTimelineOverlay();

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
        if (authorRow) authorRow.hidden = !hasAuthor;
        if (authorName) authorName.textContent = hasAuthor ? e.author : '';
        if (handleEl) {
          handleEl.hidden = !hasHandle;
          handleEl.textContent = hasHandle ? e.handle : '';
        }
        if (excerptEl) {
          excerptEl.hidden = !hasExcerpt;
          excerptEl.textContent = hasExcerpt ? e.excerpt : '';
          excerptEl.classList.remove('expanded');
        }
        if (expandBtn) expandBtn.hidden = !(hasExcerpt && isLongExcerpt(e.excerpt));
        if (urlFallback) {
          urlFallback.hidden = true;
          urlFallback.textContent = '';
        }
      } else {
        // 【審查修正】比照上面有預覽分支，四欄都要清空(不是只設 hidden)——
        // authorName/excerpt 的 textContent、handleEl 的 hidden 與
        // textContent 少清一步，上一筆的殘留文字就會在 hidden 失效(見上方
        // 全域 [hidden] 修正)或未來改版時露出，或被螢幕閱讀器讀到隱藏
        // 文字，兩個問題疊加正是「上一筆作者殘留到下一筆」的根治對象。
        if (authorRow) authorRow.hidden = true;
        if (authorName) authorName.textContent = '';
        if (handleEl) {
          handleEl.hidden = true;
          handleEl.textContent = '';
        }
        if (excerptEl) {
          excerptEl.hidden = true;
          excerptEl.textContent = '';
          excerptEl.classList.remove('expanded');
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

      // 原始連結/追蹤參數列:有資料才畫，見 buildDetailExtraRows 的防禦
      // 寫法(另一車道尚未把 schema 併進來時，這裡永遠是空陣列)。
      var extraRowsEl = byId('detailExtraRows');
      if (extraRowsEl) {
        extraRowsEl.textContent = '';
        buildDetailExtraRows(e).forEach(function (row) {
          extraRowsEl.appendChild(buildExtraRowEl(row));
        });
      }

      var recordedTimeEl = byId('detailRecordedTime');
      if (recordedTimeEl) recordedTimeEl.textContent = formatAbsoluteTime(e.at);

      // 時間軸鈕:另一車道(fix/dedup-merge)才會把 seen[] 加進 schema，本
      // 分支防禦寫法——buildSeenTimeline 對缺席/單筆資料一律回傳 null,
      // 此時不顯示「時間軸」鈕，主畫面的記錄時間(=at)已經夠用。鈕本身是
      // 純文字(次數改顯示在子層視窗的標題)，內容固定不隨資料變動，但仍
      // 沿用本檔一貫的「JS 端顯式賦值」慣例(不只靠 data-i18n 的靜態套用)
      // ——這個 controller smoke 測試組全程用最小 DOM stub，stub 的
      // querySelectorAll('[data-i18n]') 恆回傳空陣列，只有 JS 顯式賦值的
      // 文字才驗證得到。
      var timelineBtn = byId('detailTimelineBtn');
      if (timelineBtn) {
        timelineBtn.hidden = buildSeenTimeline(e) === null;
        timelineBtn.textContent = tt('opTimelineBtn');
      }

      var openLink = byId('detailOpenLink');
      if (openLink) openLink.href = e.url;

      overlay.hidden = false;
    }

    function closeEntryDetail() {
      var overlay = byId('detailOverlay');
      if (overlay) overlay.hidden = true;
      closeTimelineOverlay();
      detailEntry = null;
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
    function closeTimelineOverlay() {
      var timelineOverlay = byId('timelineOverlay');
      if (timelineOverlay) timelineOverlay.hidden = true;
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
        if (timelineOverlay) timelineOverlay.hidden = false;
      });
      on('timelineClose', 'click', closeTimelineOverlay);
      on('timelineOverlay', 'click', function (ev) {
        var timelineOverlay = byId('timelineOverlay');
        if (timelineOverlay && ev.target === timelineOverlay) closeTimelineOverlay();
      });
      on('detailCopyBtn', 'click', function () {
        if (detailEntry) copyEntryUrl(detailEntry);
      });
      on('detailDeleteBtn', 'click', function () {
        if (detailEntry) deleteEntry(detailEntry);
      });
      // Esc 關閉:兩個權威來源皆支援(手機版 DialogShell 用 Modal 的
      // onRequestClose,web 沒有對應原生事件，這裡用 keydown 補上同義
      // 行為)。時間軸子層視窗開著時 Esc 只關時間軸(比照手機版巢狀
      // Modal 逐層關閉的直覺)，沒開才輪到關詳細視窗本身。
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', function (ev) {
          if (!ev || ev.key !== 'Escape') return;
          var timelineOverlay = byId('timelineOverlay');
          if (timelineOverlay && !timelineOverlay.hidden) {
            closeTimelineOverlay();
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
        bindDetailDialog();
        bindChartTooltip();
        renderAll();
      });
    }

    // storage.onChanged(local 區)時由接線層呼叫,讓 background 新寫入的
    // 紀錄即時出現在開著的頁面上。
    //
    // 【審查修正】詳細視窗開著時，storage 被別處(background 新寫入、另一
    // 分頁刪除/清除/匯入)更新的整合:以 url 在新清單裡重新定位
    // detailEntry——找得到就用新資料刷新視窗內容(openEntryDetail 會重繪
    // 全部欄位，也會順手收合時間軸子層視窗，不留舊資料的展開態)；找不到
    // (這筆已經被刪除/清除)就關閉詳細視窗，不留著顯示一筆已經不存在的
    // 紀錄。detailEntry 為 null(視窗本來就沒開)時什麼都不做。
    function setHistory(list) {
      entries = sanitizeEntries(list);
      if (detailEntry) {
        var match = null;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].url === detailEntry.url) {
            match = entries[i];
            break;
          }
        }
        if (match) openEntryDetail(match);
        else closeEntryDetail();
      }
      renderAll();
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

    // 常開分頁的相對時間標籤刷新(回到分頁時，見 visibilitychange 接線)。
    // 直接重用 renderAll:entries 沒變，只是卡片重畫一次讓 relTime() 用
    // 當下時間重算;開銷小，visibilitychange 觸發頻率也低，不需要另外
    // 寫一條只更新時間文字的精簡路徑。
    function refresh() {
      renderAll();
    }

    return { init: init, setHistory: setHistory, setSyncSettings: setSyncSettings, refresh: refresh };
  }

  var api = {
    OPTIONS_DEFAULT_SETTINGS: OPTIONS_DEFAULT_SETTINGS,
    POST_URL_PATTERN: POST_URL_PATTERN,
    sanitizeEntries: sanitizeEntries,
    filterEntries: filterEntries,
    buildExportPayload: buildExportPayload,
    parseImportText: parseImportText,
    mergeImportedEntries: mergeImportedEntries,
    aggregateStats: aggregateStats,
    hasCardPreview: hasCardPreview,
    isLongExcerpt: isLongExcerpt,
    buildSeenTimeline: buildSeenTimeline,
    formatDisplayUrl: formatDisplayUrl,
    buildDetailExtraRows: buildDetailExtraRows,
    createOptionsController: createOptionsController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLOptions = api;
})(typeof window !== 'undefined' ? window : this);
