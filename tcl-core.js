// tcl-core.js — 共用核心 lib:淨化紀錄的網址樣式、欄位消毒、常數。三種載入
// 環境(比照 i18n.js):
//   - service worker:background.js 以 importScripts('tcl-core.js') 載入(全域 self)
//   - 擴充功能頁面:popup.html / options.html 以 <script src> 載入(全域 window)
//   - Node 測試:CommonJS require，或 vm sandbox 直接執行原始碼(全域 this)
//
// 抽取動機:sanitize 與網址樣式原本在 background.js(寫入側)與 options.js
// (讀取/匯入側)各養一份鏡像，五版設定漂移一處即分裂。此檔是全 repo 對
// 「合法網址長什麼樣」「欄位怎麼消毒」的單一權威。**只給 SW + 擴充頁共用，
// 不動 content scripts,MAIN world 永不共用**(bridge.js 是 content script,
// 範圍外，自帶 SETTINGS_DEFAULTS)。
(function (root) {
  'use strict';

  // Threads 分享短連結格式，例如:https://www.threads.com/share/AbCdEfGhI
  // 容忍尾隨斜線/查詢字串/hash。原 background.js SHARE_URL_PATTERN。
  var SHARE_URL_PATTERN =
    /^https:\/\/(www\.)?threads\.(com|net)\/share\/[A-Za-z0-9_-]+\/?(\?[^\s]*)?(#[^\s]*)?$/i;

  // 錨定嚴格版乾淨貼文網址:白名單字元類(handle:英數/底線/句點;post id:
  // 英數/連字號/底線)各 1-80 字元，收尾錨定 $，不容尾隨內容。原 background.js
  // POST_URL_PATTERN——寫入前的權威把關(isCleanPostUrl)。刻意用白名單而非
  // 排除法:中文釣魚句不需要空白，「合法前綴 + 帳號異常，請至 evil.example
  // 重新登入」用排除法照樣整串吻合而過關，白名單收到實際字母表才擋得住。
  //
  // group 3 = post ID 段(`/post/` 之後的識別碼)，供 extractPostId 取用;字元
  // 類與長度上限維持原樣，加上括號純粹是把已經比對到的段落露出來，判定行為
  // 零改動(isCleanPostUrl 仍只用 test)。
  var STRICT_POST_URL_PATTERN =
    /^https:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]{1,80}\/post\/([A-Za-z0-9_-]{1,80})$/i;

  // 容尾正規化版:同一組白名單字元類與長度上限，但容忍尾隨斜線/查詢字串/
  // hash(匯入檔或頁面 DOM 擷取的 href 常帶這些),group 1 = 正規化後的乾淨
  // 網址(去掉整段 query/hash 與尾隨斜線)。原 options.js POST_URL_PATTERN——
  // 讀取/匯入用(normalizePostUrl)。
  var NORMALIZE_POST_URL_PATTERN =
    /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/(@[A-Za-z0-9._]{1,80}\/post\/[A-Za-z0-9_-]{1,80}))\/?(?:[?#].*)?$/i;

  // 控制字元剝除範圍。剝:C0(U+0000-001F,**保留 tab U+0009 與 newline
  // U+000A**)、C1(U+007F-009F)、bidi 控制字元(U+061C 阿拉伯字母標記、
  // U+200E/200F LRM/RLM、U+202A-202E 嵌入/覆寫、U+2066-2069 隔離)。**不剝**
  // ZWJ/ZWNJ(U+200C/200D)——emoji 組合序列必要，剝了家庭 emoji 會散成三個
  // 人;**不剝** FEFF(BOM/零寬不斷空格)。
  //
  // 【紀律】以碼位動態組出字元類，原始碼保持全 ASCII、不放裸控制/bidi 字元
  // ——裸控制字元會讓檔案被 git/編輯器當成 binary、diff 不可讀，也易被工具正
  // 規化掉。反斜線一律用 String.fromCharCode(92) 產生，避免逸出歧義。
  var CONTROL_CHARS_RE = (function () {
    var BS = String.fromCharCode(92); // 反斜線，組 \uXXXX 逸出文字用
    function u(code) {
      return BS + 'u' + ('0000' + code.toString(16).toUpperCase()).slice(-4);
    }
    function range(lo, hi) {
      return lo === hi ? u(lo) : u(lo) + '-' + u(hi);
    }
    var cls =
      range(0x0000, 0x0008) + // C0(0x0009 tab / 0x000A newline 保留)
      range(0x000b, 0x001f) +
      range(0x007f, 0x009f) + // C1
      range(0x061c, 0x061c) + // ALM
      range(0x200e, 0x200f) + // LRM/RLM
      range(0x202a, 0x202e) + // 嵌入/覆寫
      range(0x2066, 0x2069); // 隔離
    return new RegExp('[' + cls + ']', 'g');
  })();

  // kind 白名單。淨化紀錄本身與 seen[].kind 共用同一組合法值('menu' 屬右鍵
  // 選單路徑，seen[] 裡是合法值)。原 background.js SEEN_KIND_WHITELIST /
  // options.js KINDS 的鍵集合。
  var KIND_LIST = ['share', 'strip', 'menu', 'icon'];

  // 自動落盤通知(cleanedNotice)可接受的 kind:'menu' 刻意排除——它只由右鍵
  // 選單路徑直接呼叫 recordHistory，不經 postMessage 通道，避免頁面腳本偽造
  // kind:'menu' 混充右鍵來源。原 background.js handleCleanedNotice 白名單。
  var NOTICE_KIND_LIST = ['share', 'strip', 'icon'];

  // 欄位長度與筆數上限。原 background.js / options.js 各自的常數，收斂於此。
  var LIMITS = {
    AUTHOR_MAX: 100,
    EXCERPT_MAX: 2000,
    ORIGINAL_MAX: 2048,
    REMOVED_PARAMS_MAX: 20,
    PARAM_KEY_MAX: 64,
    PARAM_VALUE_MAX: 512,
    SEEN_MAX: 50,
  };

  // 三顆開關的預設值全量集合(單一權威)。各端挑自己要的:background 取
  // autoClean/saveHistory;popup 取 autoClean/postCopyEnabled;options 取三顆全
  // 部。bridge.js 是 content script，範圍外，自帶 SETTINGS_DEFAULTS。
  var DEFAULT_SETTINGS = {
    autoClean: false,
    saveHistory: true,
    postCopyEnabled: true,
  };

  // ---- 網址判定 ----

  // 嚴格錨定判定:寫入前的權威把關。非字串一律 false。
  function isCleanPostUrl(url) {
    return typeof url === 'string' && STRICT_POST_URL_PATTERN.test(url);
  }

  // 容尾正規化:通過白名單就回傳正規化後的乾淨網址(去 query/hash/尾斜線),
  // 否則 null。讀取/匯入時的形狀驗證與去重鍵都吃這個回傳值。
  function normalizePostUrl(url) {
    if (typeof url !== 'string') return null;
    var match = NORMALIZE_POST_URL_PATTERN.exec(url);
    return match ? match[1] : null;
  }

  // 抽出貼文識別碼(`/post/` 之後那一段)，抽不出回傳 null。
  //
  // 【用途】紀錄的永久合併以 post ID 為主鍵(見 background.js 的紀錄合併區
  // 塊):handle 可以改名，同一篇貼文的乾淨網址會跟著換樣子
  // (/@old/post/ID → /@new/post/ID)，post ID 則終身不變，只有它能讓改名前
  // 後的紀錄仍認得是同一篇。
  //
  // 【只認嚴格樣式】刻意走 STRICT_POST_URL_PATTERN(錨定整串、白名單字元
  // 類、長度上限)而非容尾版:合併鍵是資料歸屬的依據，寧可對帶 query/尾隨內
  // 容的網址回 null(呼叫端退回整條 url 當 fallback key，最多分成兩張卡),
  // 也不要讓寬鬆匹配把兩篇不同貼文算成同一篇。分享短碼(/share/XXXX)本來就
  // 抽不出 ID——短碼只有 Meta 伺服器能對應，本機無從得知它指向哪一篇。
  function extractPostId(url) {
    if (typeof url !== 'string') return null;
    var match = STRICT_POST_URL_PATTERN.exec(url);
    return match ? match[3] : null;
  }

  // ---- 跨裝置合併鍵(postKeyOf) ----

  // 逐字移植自手機 C:\gitRepos\meta-link-clearer\src\lib\post-key.ts 的
  // postKeyOf，輸入輸出與其完全等價(見 docs/cloud-sync-plan.md D11)。純函
  // 式、無副作用，SW 與擴充頁共用，雲端同步以此為 history 的合併鍵，取代
  // extractPostId 只認嚴格樣式(無尾斜線/query，handle 白名單字元類)的局
  // 限。extractPostId 保留給顯示用途，行為不變。

  // host 是否為 suffix 本身，或其任一子網域(以 '.' + suffix 結尾)。大小寫
  // 不敏感;用 endsWith 而非 includes，避免 sub.threads.com.evil.com 這種
  // 「字串包含但非同網域」的釣魚變體被誤判。
  function hostnameEndsWith(hostname, suffix) {
    var h = hostname.toLowerCase();
    return h === suffix || h.slice(-(suffix.length + 1)) === '.' + suffix;
  }

  // Threads:/@handle/post/<code>;handle 會變，只取 code。
  var THREADS_POST = /^\/@[^/]+\/post\/([A-Za-z0-9_-]+)\/?$/;
  // Instagram:/p、/reel、/reels、/tv 後面都是同一種 shortcode。
  var INSTAGRAM_POST = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/;
  // Facebook 路徑型:.../posts/<id>(數字或 pfbid…)、.../videos/<id>、
  // /reel/<id>、.../photos/<album>/<id>。
  var FACEBOOK_POSTS = /\/posts\/([A-Za-z0-9_-]+)\/?$/;
  var FACEBOOK_VIDEOS = /\/videos\/([0-9]+)\/?$/;
  var FACEBOOK_REEL = /^\/reel\/([0-9]+)\/?$/;
  var FACEBOOK_PHOTOS = /\/photos\/[^/]+\/([0-9]+)\/?$/;
  // Facebook query 型:permalink.php／story.php 用 story_fbid、
  // photo(.php) 用 fbid、watch 用 v。
  var FACEBOOK_STORY_PAGES = /^\/(?:permalink|story)\.php$/;
  var FACEBOOK_PHOTO_PAGES = /^\/photo(?:\.php)?\/?$/;
  var FACEBOOK_WATCH_PAGES = /^\/watch\/?$/;

  // 從已解析的 Facebook URL 抽貼文/影片/相片識別碼，抽不出回傳 null。
  function facebookId(parsed) {
    var path = parsed.pathname;
    var m =
      FACEBOOK_POSTS.exec(path) ||
      FACEBOOK_VIDEOS.exec(path) ||
      FACEBOOK_REEL.exec(path) ||
      FACEBOOK_PHOTOS.exec(path);
    if (m) return m[1];
    if (FACEBOOK_STORY_PAGES.test(path)) return parsed.searchParams.get('story_fbid');
    if (FACEBOOK_PHOTO_PAGES.test(path)) return parsed.searchParams.get('fbid');
    if (FACEBOOK_WATCH_PAGES.test(path)) return parsed.searchParams.get('v');
    return null;
  }

  // 退回網址本身當鍵:host 小寫並去掉 www./m./mobile. 前綴，路徑去尾斜線，
  // query 照留(呼叫端傳入的網址已剝過追蹤參數)。
  function urlKey(parsed) {
    var host = parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
    var path = parsed.pathname.replace(/\/+$/, '') || '/';
    return 'url:' + host + path + parsed.search;
  }

  // 回傳形如 threads:DLxxxx、instagram:Cxxxx、facebook:123456 或
  // url:host/path 的字串。無法解析的輸入回傳 url:<原字串>，永遠不丟例外。
  function postKeyOf(cleaned) {
    var parsed;
    try {
      parsed = new URL(cleaned);
    } catch (e) {
      return 'url:' + cleaned;
    }
    var hostname = parsed.hostname;

    if (hostnameEndsWith(hostname, 'threads.com') || hostnameEndsWith(hostname, 'threads.net')) {
      var threadsMatch = THREADS_POST.exec(parsed.pathname);
      if (threadsMatch) return 'threads:' + threadsMatch[1];
    } else if (hostnameEndsWith(hostname, 'instagram.com')) {
      var instagramMatch = INSTAGRAM_POST.exec(parsed.pathname);
      if (instagramMatch) return 'instagram:' + instagramMatch[1];
    } else if (hostnameEndsWith(hostname, 'facebook.com')) {
      var fbId = facebookId(parsed);
      if (fbId) return 'facebook:' + fbId;
    }
    return urlKey(parsed);
  }

  // ---- 雲端同步:storage 形狀與雙向映射(docs/cloud-sync-plan.md 4.2/4.3) ----

  // chrome.storage.local.syncState 的預設形狀。欄位齊備是同步引擎的前提:
  // 少一個鍵，讀到的是 undefined 而不是 null，各處「未登入」判定會失準。
  var DEFAULT_SYNC_STATE = {
    userId: null,
    email: null,
    cursor: null,
    lastSyncedAt: null,
    clearedAt: null,
    lastError: null,
  };

  // chrome.storage.local.syncAuth 的預設形狀(D10:bearer token 明文存 local)。
  var DEFAULT_SYNC_AUTH = { token: null };

  function optionalString(value) {
    return typeof value === 'string' ? value : null;
  }
  function optionalFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  // syncState 防禦性整形:缺席欄位補預設、型別不對的欄位回該欄預設、未知鍵
  // 一律丟棄(整包會寫回 storage，夾帶的鍵會一路長存)。**每次回傳全新物件**
  // ——回傳共用的 DEFAULT_SYNC_STATE 參照時，呼叫端一改就污染全域預設值。
  function normalizeSyncState(state) {
    var raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    return {
      userId: optionalString(raw.userId),
      email: optionalString(raw.email),
      cursor: optionalString(raw.cursor),
      lastSyncedAt: optionalFiniteNumber(raw.lastSyncedAt),
      clearedAt: optionalFiniteNumber(raw.clearedAt),
      lastError: optionalString(raw.lastError),
    };
  }

  // UUID v4 生成器。service worker 與擴充頁面的全域都有 crypto.randomUUID,
  // 沒有時(舊環境/受限 context)以 getRandomValues 或 Math.random 補位，版本位
  // 與 variant 位照 RFC 4122 固定，輸出格式一致。
  function randomUuid() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var j = 0; j < 16; j++) hex.push(('0' + bytes[j].toString(16)).slice(-2));
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }

  // seen[].kind → 雲端 seen[].source(D4):share→share，strip/menu/icon→
  // clipboard。kind 缺席的種子紀錄不對應任何來源事件，回 undefined 讓呼叫端
  // 整個 source 鍵不輸出——硬塞 clipboard 等於對雲端謊報沒發生過的來源。
  function seenSourceOf(kind) {
    if (kind === undefined) return undefined;
    return kind === 'share' ? 'share' : 'clipboard';
  }

  // 雲端 seen[].source → 本機 kind。插件沒有 clipboard 這個 kind，一律回
  // 'share';source 缺席時同樣回 undefined(維持無標籤的種子紀錄)。
  function seenKindOf(source) {
    if (source === undefined) return undefined;
    return 'share';
  }

  // entry → 雲端 SyncItem(計劃 4.3)。只輸出雲端有的欄位:kind(D4)、dirty、
  // deletedAt、serverUpdatedAt、postKey、at、url 全屬本機簿記，一律不上雲。
  // 選填欄位缺席時整個鍵不輸出——輸出 null 會被伺服器當成「明確清空」。
  function toSyncItem(entry) {
    var cleaned = normalizePostUrl(entry.url) || entry.url;
    var item = {
      id: entry.id,
      cleaned: cleaned,
      // original 是伺服器必填欄位，缺席整筆會被靜默丟棄，上傳前最後補一次。
      original: typeof entry.original === 'string' && entry.original ? entry.original : cleaned,
      receivedAt: entry.receivedAt,
    };
    if (typeof entry.author === 'string') item.author = entry.author;
    if (typeof entry.handle === 'string') item.handle = entry.handle;
    if (typeof entry.excerpt === 'string') item.excerpt = entry.excerpt;
    if (Array.isArray(entry.removedParams) && entry.removedParams.length > 0) {
      item.removedParams = entry.removedParams.map(function (p) {
        return { key: p.key, value: p.value };
      });
    }
    if (Array.isArray(entry.seen) && entry.seen.length > 0) {
      item.seen = entry.seen.map(function (s) {
        var source = seenSourceOf(s.kind);
        return source === undefined ? { at: s.at } : { at: s.at, source: source };
      });
    }
    return item;
  }

  // 雲端 SyncItem → entry。existing 是本機同一張卡(沒有則傳 null):
  //   - id 以雲端(canonical)為準——伺服器改名時就地改名。
  //   - kind 沿用既有(雲端無此欄位，D4 已接受跨裝置遺失)，沒有既有卡時預設
  //     'share'。
  //   - seen 取雲端與本機的聯集(同 at 去重)，按 at 升序裁到 SEEN_MAX。
  //   - at 是本機顯示用的最後出現時間，取 max(receivedAt, seen 最大 at)。
  //   - dirty 清為 false(剛從雲端拉下來)、deletedAt 清為 null(雲端仍存在的
  //     卡片必須復活，否則別台裝置重新分享的貼文在這台永遠看不到)。
  function fromSyncItem(item, existing) {
    var base = existing && typeof existing === 'object' ? existing : null;
    var url = normalizePostUrl(item.cleaned) || item.cleaned;
    var receivedAt = optionalFiniteNumber(item.receivedAt);

    var events = [];
    var seenAt = {};
    function pushSeen(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var record = list[i];
        if (!record || typeof record !== 'object') continue;
        if (typeof record.at !== 'number' || !isFinite(record.at)) continue;
        if (Object.prototype.hasOwnProperty.call(seenAt, record.at)) continue;
        seenAt[record.at] = true;
        var kind = record.kind !== undefined ? record.kind : seenKindOf(record.source);
        events.push(kind === undefined ? { at: record.at } : { at: record.at, kind: kind });
      }
    }
    pushSeen(item.seen);
    pushSeen(base && base.seen);
    events.sort(function (a, b) {
      return a.at - b.at;
    });
    events = events.slice(-LIMITS.SEEN_MAX);

    var latest = receivedAt === null ? null : receivedAt;
    for (var k = 0; k < events.length; k++) {
      if (latest === null || events[k].at > latest) latest = events[k].at;
    }

    var entry = {
      url: url,
      kind: base && typeof base.kind === 'string' ? base.kind : 'share',
      at: latest === null ? optionalFiniteNumber(base && base.at) : latest,
      seen: events,
      id: item.id,
      postKey: postKeyOf(url),
      original: typeof item.original === 'string' && item.original ? item.original : url,
      receivedAt: receivedAt,
      dirty: false,
      // serverUpdatedAt 取雲端本次回傳值，缺席則沿用既有(不得憑空清成 null,
      // 它是下一輪合併的判準)。
      serverUpdatedAt:
        optionalFiniteNumber(item.updatedAt) !== null
          ? optionalFiniteNumber(item.updatedAt)
          : optionalFiniteNumber(base && base.serverUpdatedAt),
      deletedAt: null,
    };

    var author = typeof item.author === 'string' ? item.author : base && base.author;
    if (typeof author === 'string') entry.author = author;
    var handle = typeof item.handle === 'string' ? item.handle : base && base.handle;
    if (typeof handle === 'string') entry.handle = handle;
    var excerpt = typeof item.excerpt === 'string' ? item.excerpt : base && base.excerpt;
    if (typeof excerpt === 'string') entry.excerpt = excerpt;
    var removedParams = Array.isArray(item.removedParams)
      ? item.removedParams
      : base && base.removedParams;
    if (Array.isArray(removedParams) && removedParams.length > 0) entry.removedParams = removedParams;
    return entry;
  }

  // ---- 欄位消毒 ----

  // 剝除控制/bidi 字元(見 CONTROL_CHARS_RE 註解)，獨立匯出供測試
  // 直打。非字串一律回傳空字串(呼叫端皆先過型別檢查，此處僅防呆)。
  function stripControlChars(value) {
    if (typeof value !== 'string') return '';
    return value.replace(CONTROL_CHARS_RE, '');
  }

  // 選填文字欄位消毒:非字串→undefined;剝控制字元→若成空字串則丟棄→截斷
  // 至 maxLen(**先剝後截**)。回傳 undefined 時呼叫端整欄不寫入(不落空值)。
  function sanitizeText(value, maxLen) {
    if (typeof value !== 'string') return undefined;
    var stripped = stripControlChars(value);
    if (stripped.length === 0) return undefined;
    return stripped.slice(0, maxLen);
  }

  // original 欄位消毒。cleanUrl 為本筆已驗證的乾淨網址。
  //   1. 非字串/空→undefined
  //   2. 剝控制字元;剝完成空→undefined
  //   3. === cleanUrl→undefined(與 cleaned 相同代表沒有額外資訊)
  //   4. 長度 > ORIGINAL_MAX→**整欄丟棄**(不截斷:截半的殘 URL 過不了白名單，
  //      不如整欄不留)
  //   5. **必須吻合 SHARE_URL_PATTERN 或容尾 POST 樣式**，否則 undefined
  // 三合法來源全通過:share(短碼分享網址，吻合 SHARE_URL_PATTERN)、strip(剝參
  // 前的貼文網址，帶追蹤 query，吻合容尾 POST 樣式)、menu(shareUrl)。只擋偽造
  // /畸形殘 URL。
  function sanitizeOriginal(value, cleanUrl) {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    var stripped = stripControlChars(value);
    if (stripped.length === 0) return undefined;
    if (stripped === cleanUrl) return undefined;
    if (stripped.length > LIMITS.ORIGINAL_MAX) return undefined;
    if (!SHARE_URL_PATTERN.test(stripped) && normalizePostUrl(stripped) === null) return undefined;
    return stripped;
  }

  // removedParams 消毒(取嚴版:掃描封頂 slice 前 REMOVED_PARAMS_MAX 筆，不是
  // 「收滿合法項目才停」——防呼叫端用超大 payload 夾帶大量畸形項目拖慢處
  // 理)。每筆 key/value 先過 stripControlChars，再驗長度上限:key 需為
  // 剝除後非空且 ≤ PARAM_KEY_MAX、value 需為剝除後 ≤ PARAM_VALUE_MAX，任一
  // 不符整筆丟棄(容忍陣列裡部分項目壞掉)。非陣列或一筆不剩回傳 undefined。
  function sanitizeRemovedParams(value) {
    if (!Array.isArray(value)) return undefined;
    var out = [];
    var scanLimit = Math.min(value.length, LIMITS.REMOVED_PARAMS_MAX);
    for (var i = 0; i < scanLimit; i++) {
      var item = value[i];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.key !== 'string' || typeof item.value !== 'string') continue;
      var key = stripControlChars(item.key);
      var val = stripControlChars(item.value);
      if (key.length === 0 || key.length > LIMITS.PARAM_KEY_MAX) continue;
      if (val.length > LIMITS.PARAM_VALUE_MAX) continue;
      out.push({ key: key, value: val });
    }
    return out.length > 0 ? out : undefined;
  }

  // seen[] 消毒:逐筆過濾——at 需為有限數字，不符整筆丟棄;kind 缺席保留(手機
  // 版補種的起始紀錄無來源標籤),kind 有值則需在 KIND_LIST 白名單內，否則整
  // 筆丟棄。非陣列回傳空陣列。裁到 SEEN_MAX 上限(**函式內裁切**，對 merge 端
  // 無行為差:concat 後照樣再裁)。
  function sanitizeSeenList(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i++) {
      var record = value[i];
      if (!record || typeof record !== 'object') continue;
      if (typeof record.at !== 'number' || !isFinite(record.at)) continue;
      if (record.kind === undefined) {
        out.push({ at: record.at });
        continue;
      }
      if (typeof record.kind !== 'string' || KIND_LIST.indexOf(record.kind) === -1) continue;
      out.push({ at: record.at, kind: record.kind });
    }
    return out.slice(-LIMITS.SEEN_MAX);
  }

  var api = {
    SHARE_URL_PATTERN: SHARE_URL_PATTERN,
    isCleanPostUrl: isCleanPostUrl,
    normalizePostUrl: normalizePostUrl,
    extractPostId: extractPostId,
    postKeyOf: postKeyOf,
    KIND_LIST: KIND_LIST,
    NOTICE_KIND_LIST: NOTICE_KIND_LIST,
    LIMITS: LIMITS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_SYNC_STATE: DEFAULT_SYNC_STATE,
    DEFAULT_SYNC_AUTH: DEFAULT_SYNC_AUTH,
    normalizeSyncState: normalizeSyncState,
    randomUuid: randomUuid,
    toSyncItem: toSyncItem,
    fromSyncItem: fromSyncItem,
    stripControlChars: stripControlChars,
    sanitizeText: sanitizeText,
    sanitizeOriginal: sanitizeOriginal,
    sanitizeRemovedParams: sanitizeRemovedParams,
    sanitizeSeenList: sanitizeSeenList,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLCore = api;
})(typeof self !== 'undefined' ? self : this);
