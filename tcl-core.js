// tcl-core.js — 共用核心 lib:淨化紀錄的網址樣式、欄位消毒、常數。三種載入
// 環境(比照 i18n.js):
//   - service worker:background.js 以 importScripts('tcl-core.js') 載入(全域 self)
//   - 擴充功能頁面:popup.html / options.html 以 <script src> 載入(全域 window)
//   - Node 測試:CommonJS require,或 vm sandbox 直接執行原始碼(全域 this)
//
// 抽取動機:sanitize 與網址樣式原本在 background.js(寫入側)與 options.js
// (讀取/匯入側)各養一份鏡像,五版設定漂移一處即分裂。此檔是全 repo 對
// 「合法網址長什麼樣」「欄位怎麼消毒」的單一權威。**只給 SW + 擴充頁共用,
// 不動 content scripts,MAIN world 永不共用**(bridge.js 是 content script,
// 範圍外,自帶 SETTINGS_DEFAULTS)。
(function (root) {
  'use strict';

  // Threads 分享短連結格式,例如:https://www.threads.com/share/AbCdEfGhI
  // 容忍尾隨斜線/查詢字串/hash。原 background.js SHARE_URL_PATTERN。
  var SHARE_URL_PATTERN =
    /^https:\/\/(www\.)?threads\.(com|net)\/share\/[A-Za-z0-9_-]+\/?(\?[^\s]*)?(#[^\s]*)?$/i;

  // 錨定嚴格版乾淨貼文網址:白名單字元類(handle:英數/底線/句點;post id:
  // 英數/連字號/底線)各 1-80 字元,收尾錨定 $,不容尾隨內容。原 background.js
  // POST_URL_PATTERN——寫入前的權威把關(isCleanPostUrl)。刻意用白名單而非
  // 排除法:中文釣魚句不需要空白,「合法前綴 + 帳號異常,請至 evil.example
  // 重新登入」用排除法照樣整串吻合而過關,白名單收到實際字母表才擋得住。
  var STRICT_POST_URL_PATTERN =
    /^https:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]{1,80}\/post\/[A-Za-z0-9_-]{1,80}$/i;

  // 容尾正規化版:同一組白名單字元類與長度上限,但容忍尾隨斜線/查詢字串/
  // hash(匯入檔或頁面 DOM 擷取的 href 常帶這些),group 1 = 正規化後的乾淨
  // 網址(去掉整段 query/hash 與尾隨斜線)。原 options.js POST_URL_PATTERN——
  // 讀取/匯入用(normalizePostUrl)。
  var NORMALIZE_POST_URL_PATTERN =
    /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/(@[A-Za-z0-9._]{1,80}\/post\/[A-Za-z0-9_-]{1,80}))\/?(?:[?#].*)?$/i;

  // 控制字元剝除範圍。剝:C0(U+0000-001F,**保留 tab U+0009 與 newline
  // U+000A**)、C1(U+007F-009F)、bidi 控制字元(U+061C 阿拉伯字母標記、
  // U+200E/200F LRM/RLM、U+202A-202E 嵌入/覆寫、U+2066-2069 隔離)。**不剝**
  // ZWJ/ZWNJ(U+200C/200D)——emoji 組合序列必要,剝了家庭 emoji 會散成三個
  // 人;**不剝** FEFF(BOM/零寬不斷空格)。
  //
  // 【紀律】以碼位動態組出字元類,原始碼保持全 ASCII、不放裸控制/bidi 字元
  // ——裸控制字元會讓檔案被 git/編輯器當成 binary、diff 不可讀,也易被工具正
  // 規化掉。反斜線一律用 String.fromCharCode(92) 產生,避免逸出歧義。
  var CONTROL_CHARS_RE = (function () {
    var BS = String.fromCharCode(92); // 反斜線,組 \uXXXX 逸出文字用
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
  // 選單路徑,seen[] 裡是合法值)。原 background.js SEEN_KIND_WHITELIST /
  // options.js KINDS 的鍵集合。
  var KIND_LIST = ['share', 'strip', 'menu', 'icon'];

  // 自動落盤通知(cleanedNotice)可接受的 kind:'menu' 刻意排除——它只由右鍵
  // 選單路徑直接呼叫 recordHistory,不經 postMessage 通道,避免頁面腳本偽造
  // kind:'menu' 混充右鍵來源。原 background.js handleCleanedNotice 白名單。
  var NOTICE_KIND_LIST = ['share', 'strip', 'icon'];

  // 欄位長度與筆數上限。原 background.js / options.js 各自的常數,收斂於此。
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
  // 部。bridge.js 是 content script,範圍外,自帶 SETTINGS_DEFAULTS。
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

  // ---- 欄位消毒 ----

  // 剝除控制/bidi 字元(見 CONTROL_CHARS_RE 註解),獨立匯出供測試
  // 直打。非字串一律回傳空字串(呼叫端皆先過型別檢查,此處僅防呆)。
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
  //   4. 長度 > ORIGINAL_MAX→**整欄丟棄**(不截斷:截半的殘 URL 過不了白名單,
  //      不如整欄不留)
  //   5. **必須吻合 SHARE_URL_PATTERN 或容尾 POST 樣式**,否則 undefined
  // 三合法來源全通過:share(短碼分享網址,吻合 SHARE_URL_PATTERN)、strip(剝參
  // 前的貼文網址,帶追蹤 query,吻合容尾 POST 樣式)、menu(shareUrl)。只擋偽造
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

  // removedParams 消毒(取嚴版:掃描封頂 slice 前 REMOVED_PARAMS_MAX 筆,不是
  // 「收滿合法項目才停」——防呼叫端用超大 payload 夾帶大量畸形項目拖慢處
  // 理)。每筆 key/value 先過 stripControlChars,再驗長度上限:key 需為
  // 剝除後非空且 ≤ PARAM_KEY_MAX、value 需為剝除後 ≤ PARAM_VALUE_MAX,任一
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

  // seen[] 消毒:逐筆過濾——at 需為有限數字,不符整筆丟棄;kind 缺席保留(手機
  // 版補種的起始紀錄無來源標籤),kind 有值則需在 KIND_LIST 白名單內,否則整
  // 筆丟棄。非陣列回傳空陣列。裁到 SEEN_MAX 上限(**函式內裁切**,對 merge 端
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
    KIND_LIST: KIND_LIST,
    NOTICE_KIND_LIST: NOTICE_KIND_LIST,
    LIMITS: LIMITS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
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
