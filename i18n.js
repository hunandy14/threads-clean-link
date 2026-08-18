// i18n.js — 共用雙語字典與語言解析。三種載入環境:
//   - service worker:background.js 以 importScripts('i18n.js') 載入(全域 self)
//   - 擴充功能頁面:popup.html / options.html 以 <script src> 載入(全域 window)
//   - Node 測試:CommonJS require,或 vm sandbox 直接執行原始碼(全域 this)
// 函式一律帶明確 locale 參數、不留全域狀態——SW 會被終止再喚醒,任何
// 快取的語言值都可能過期,每次事件重新解析才是唯一正確來源。
//
// Chrome 官方 _locales 機制只跟瀏覽器 UI 語言、無法讓使用者在頁面上切換,
// 因此僅保留給 manifest 的 extName/extDesc;其餘文案全部走本字典,語言偏好
// 存 chrome.storage.sync 的 langPref('zh' | 'en',未設定 = 依環境偵測)。
(function (root) {
  'use strict';

  var STRINGS = {
    zh: {
      // ---- background:右鍵選單與通知 ----
      bgMenuTitle: '複製乾淨的 Threads 貼文連結',
      bgNotifTitle: 'Threads 乾淨連結',
      bgInvalid: '這不是有效的 Threads 分享短連結。',
      bgNetworkError: '解析短連結失敗，請確認網路連線後再試一次。',
      bgFormatError: '轉址結果不是貼文網址，短連結可能已失效或 Threads 網址格式已變動。',
      bgNoTab: '已解析出乾淨網址，但找不到可寫入剪貼簿的分頁:{url}',
      bgClipboardError: '目前分頁無法寫入剪貼簿(可能是瀏覽器限制頁面)，乾淨網址為:{url}',
      bgSuccess: '已複製乾淨網址:{url}',
      bgAutoSuccess: '已自動淨化並複製乾淨網址:{url}',
      // kind:'icon'(貼文互動列複製按鈕，見 post-icon.js)本來就只複製貼文
      // 原始連結，沒有解析短碼或剪除追蹤參數這類「淨化」動作，沿用
      // bgAutoSuccess 的「已自動淨化」文案會謊稱做了淨化，故獨立一顆 key。
      bgIconSuccess: '已複製原始連結:{url}',
      bgUnexpected: '發生未預期的錯誤，請稍後再試一次。',

      // ---- popup ----
      ppAutoClean: '自動淨化分享按鈕',
      // 0.5.0 方案甲:popup 新增「貼文複製按鈕」開關(postCopyEnabled)，
      // 排在自動淨化之後、導航列之前。
      popPostCopyLabel: '貼文複製按鈕',
      ppHistorySettings: '紀錄與設定',
      ppFooter: '盡力而為，處理失敗不影響原功能。',

      // ---- options:頁首與統計 ----
      opSub: '脆連結清潔工 · 設定與淨化紀錄',
      opThemeTitle: '切換主題',
      opLangTitle: '語言 / Language',
      opTileTotal: '累計淨化',
      opSince: '自 {d} 以來',
      opTileWeek: '本週',
      opVsLastWeek: '較上週',
      opTileShare: '短碼解析',
      opTileStrip: '剪除追蹤參數',
      opShareOfTotal: '佔 {p}%',

      // ---- options:活動圖 ----
      opChartTitle: '近 14 天淨化活動',
      opChartUnit: '單位:次',
      opChartDesc: '近 14 天每日淨化次數',
      opToday: '今天',
      opTimes: '{n} 次',

      // ---- options:設定 ----
      opSettingsTitle: '設定',
      opAutoCleanName: '自動淨化分享按鈕',
      opAutoCleanDesc: '攔截官方「複製連結」，解析短碼、剪除追蹤參數',
      // 【PM 審查後移除】opNotifyName/opNotifyDesc(成功時顯示通知):R1
      // 同輪已把成功通知整組拆光，這顆開關合併後零讀取端，留著是誤導
      // 使用者的死 UI，不是「另一車道尚未拆通知」——上一輪的保留理由是
      // 過期情報。
      opSaveName: '保存淨化紀錄',
      opSaveDesc: '僅存於本機，上限 1,000 筆，自動汰舊',
      // 0.5.0 方案甲:與 popup 的 postCopyEnabled 鏡像，設定頁保留完整開關
      // 說明(popup 只留精簡標籤)。
      opPostCopyName: '貼文複製按鈕',
      opPostCopyDesc: '在貼文互動列顯示複製連結按鈕',

      // ---- options:紀錄清單 ----
      opHistoryTitle: '淨化紀錄',
      opMoreTitle: '更多動作',
      opFilterTitle: '依來源篩選',
      opExportJson: '匯出 JSON',
      opImportJson: '匯入 JSON',
      opClearAll: '清除全部紀錄',
      opClearDo: '確定清除',
      opCancel: '取消',
      opClearConfirmDesc: '將刪除全部 {n} 筆紀錄，且無法復原。確定要繼續嗎?',
      opSearchPh: '搜尋帳號或網址…',
      opChipAll: '全部',
      opKindShare: '短碼解析',
      opKindStrip: '剪除參數',
      opKindMenu: '右鍵還原',
      opKindIcon: '貼文按鈕',
      opPerPageA: '每頁',
      opPerPageB: '筆',
      opEmpty: '沒有符合條件的紀錄',
      opShowing: '顯示 {a} / {b} 筆',
      opDeviceNote: '紀錄僅保存於這台裝置',
      opCopyTitle: '複製乾淨網址',
      opDeleteTitle: '刪除這筆',
      // 0.5.0 方案甲:紀錄卡片化後新增「開啟貼文」動作(<a target=_blank
      // rel=noopener>)，複製/刪除沿用既有 opCopyTitle/opDeleteTitle。
      opOpenTitle: '開啟貼文',

      // ---- options:匯入對話框與 toast ----
      opImportTitle: '匯入紀錄',
      opImportDesc: '選擇先前匯出的 .json 檔，或直接貼上內容;與現有紀錄以網址去重合併。',
      opChooseFile: '選擇檔案',
      opDoImport: '匯入',
      opClose: '關閉',
      opToastCopied: '已複製乾淨網址',
      opToastCopyFailed: '複製失敗，請再試一次',
      opToastDeleted: '已刪除 1 筆紀錄',
      opToastCleared: '已清除全部紀錄',
      opToastExported: '已下載備份檔',
      opToastImported: '已匯入 {n} 筆',
      opToastImportedSkip: '已匯入 {n} 筆，略過 {m} 筆(重複或格式不符)',
      opToastBadJson: '無法解析:不是有效的 JSON',
      opToastNoEntries: '格式不正確:缺少 entries 陣列',

      // ---- options:相對時間 ----
      opRelJust: '剛剛',
      opRelMin: '{n} 分鐘前',
      opRelHour: '{n} 小時前',
      opRelYesterday: '昨天',
      opRelDays: '{n} 天前',

      // ---- post-icon:貼文互動列注入的複製連結 icon ----
      iconTooltip: '複製原始連結',
      iconCopied: '已複製原始連結',

      // ---- 0.5.0 方案甲(歷史即收藏，撤獨立收藏分頁):互動列書籤 icon
      // (post-icon.js，另一車道)仍在用 favIconTooltip/favSaved/favRemoved/
      // favFull，此檔刻意不動 post-icon.js，故保留這 4 個 key；favTabLabel/
      // favEmpty/favExport/favImport/favCount/favImportDesc/favToast*/
      // favCopy/favOpenPost/favRemove(options 收藏分頁專用)已隨分頁移除，
      // 一併刪除;favContextLost 為孤兒提示，移交複製路徑使用，保留。
      favIconTooltip: '收藏貼文',
      favSaved: '已加入收藏',
      favRemoved: '已取消收藏',
      favFull: '收藏已滿(500 筆上限)',
      // 擴充功能更新時，service worker 的舊連線會失效(context invalidated);
      // 頁面端呼叫 chrome.* API 失敗時顯示此提示，請使用者重新整理頁面。
      favContextLost: '擴充功能已更新，請重新整理頁面',
    },
    en: {
      bgMenuTitle: 'Copy clean Threads post link',
      bgNotifTitle: 'Threads Clean Link',
      bgInvalid: 'Not a valid Threads share link.',
      bgNetworkError: 'Failed to resolve the share link. Check your connection and try again.',
      bgFormatError: 'The redirect did not lead to a post URL; the link may be dead or the URL format changed.',
      bgNoTab: 'Resolved the clean URL, but no tab is available for the clipboard write: {url}',
      bgClipboardError: 'This tab cannot accept clipboard writes (possibly a restricted page). Clean URL: {url}',
      bgSuccess: 'Clean URL copied: {url}',
      bgAutoSuccess: 'Auto-cleaned and copied: {url}',
      bgIconSuccess: 'Original link copied: {url}',
      bgUnexpected: 'Unexpected error. Please try again later.',

      ppAutoClean: 'Auto-clean the share button',
      popPostCopyLabel: 'Post copy button',
      ppHistorySettings: 'History & settings',
      ppFooter: 'Best-effort — failures never break the original copy feature.',

      opSub: 'Threads Clean Link · Settings & history',
      opThemeTitle: 'Toggle theme',
      opLangTitle: 'Language / 語言',
      opTileTotal: 'Total cleaned',
      opSince: 'Since {d}',
      opTileWeek: 'This week',
      opVsLastWeek: 'vs last week',
      opTileShare: 'Short links resolved',
      opTileStrip: 'Tracking params stripped',
      opShareOfTotal: '{p}% of total',

      opChartTitle: 'Activity, last 14 days',
      opChartUnit: 'unit: cleanings',
      opChartDesc: 'Daily cleanings over the last 14 days',
      opToday: 'Today',
      opTimes: '{n}×',

      opSettingsTitle: 'Settings',
      opAutoCleanName: 'Auto-clean the share button',
      opAutoCleanDesc: 'Intercepts the official “Copy link”, resolves short codes and strips tracking params',
      opSaveName: 'Keep cleaning history',
      opSaveDesc: 'Local only, capped at 1,000 entries (oldest pruned)',
      opPostCopyName: 'Post copy button',
      opPostCopyDesc: 'Show a copy-link button on posts’ action row',

      opHistoryTitle: 'Cleaning history',
      opMoreTitle: 'More actions',
      opFilterTitle: 'Filter by source',
      opExportJson: 'Export JSON',
      opImportJson: 'Import JSON',
      opClearAll: 'Clear all history',
      opClearDo: 'Clear all',
      opCancel: 'Cancel',
      opClearConfirmDesc: 'This deletes all {n} entries and cannot be undone. Continue?',
      opSearchPh: 'Search handle or URL…',
      opChipAll: 'All',
      opKindShare: 'Resolved',
      opKindStrip: 'Stripped',
      opKindMenu: 'Context menu',
      opKindIcon: 'Post button',
      opPerPageA: 'Per page',
      opPerPageB: '',
      opEmpty: 'No matching entries',
      opShowing: 'Showing {a} / {b}',
      opDeviceNote: 'History never leaves this device',
      opCopyTitle: 'Copy clean URL',
      opDeleteTitle: 'Delete entry',
      opOpenTitle: 'Open post',

      opImportTitle: 'Import history',
      opImportDesc: 'Pick a previously exported .json file or paste its content; merged with existing entries, deduped by URL.',
      opChooseFile: 'Choose file',
      opDoImport: 'Import',
      opClose: 'Close',
      opToastCopied: 'Clean URL copied',
      opToastCopyFailed: 'Copy failed, please try again',
      opToastDeleted: 'Deleted 1 entry',
      opToastCleared: 'All history cleared',
      opToastExported: 'Backup file downloaded',
      opToastImported: 'Imported {n} entries',
      opToastImportedSkip: 'Imported {n}, skipped {m} (duplicate or invalid)',
      opToastBadJson: 'Not valid JSON',
      opToastNoEntries: 'Invalid format: missing entries array',

      opRelJust: 'just now',
      opRelMin: '{n} min ago',
      opRelHour: '{n} hr ago',
      opRelYesterday: 'yesterday',
      opRelDays: '{n} days ago',

      iconTooltip: 'Copy original link',
      iconCopied: 'Original link copied',

      favIconTooltip: 'Save post',
      favSaved: 'Saved',
      favRemoved: 'Removed from favorites',
      favFull: 'Favorites full (500 limit)',
      favContextLost: 'Extension updated — please refresh the page',
    },
  };

  // 任何非 zh 開頭(或無法辨識)的語言一律歸 en:目前只維護兩份字典,
  // en 是對外的安全預設。
  function normalizeLocale(raw) {
    return /^zh/i.test(String(raw || '')) ? 'zh' : 'en';
  }

  // pref 為使用者保存的明確偏好('zh' | 'en'),其餘值視為未設定,依環境
  // 偵測:chrome.i18n.getUILanguage(瀏覽器 UI 語言) → navigator.language。
  // fallbackLanguage 供測試注入,避免測試綁死於執行環境的語言。
  function resolveLocale(pref, fallbackLanguage) {
    if (pref === 'zh' || pref === 'en') return pref;
    var raw = fallbackLanguage;
    if (raw === undefined || raw === null) {
      try {
        if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
          raw = chrome.i18n.getUILanguage();
        }
      } catch (e) {
        // 取用失敗走下一層 fallback。
      }
      if ((raw === undefined || raw === null) && typeof navigator !== 'undefined') {
        raw = navigator.language;
      }
    }
    return normalizeLocale(raw);
  }

  // 查無 key 時退回 zh 字典,再退回 key 本身:寧可顯示原文/鍵名,不丟例外
  // 中斷通知或頁面渲染。
  function t(locale, key) {
    var dict = STRINGS[locale] || STRINGS.zh;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    if (Object.prototype.hasOwnProperty.call(STRINGS.zh, key)) return STRINGS.zh[key];
    return key;
  }

  // 樣板插值:{name} 逐一以 vars[name] 取代;缺對應值時保留原樣,便於除錯。
  function fmt(locale, key, vars) {
    return t(locale, key).replace(/\{(\w+)\}/g, function (match, name) {
      return vars && vars[name] !== undefined ? String(vars[name]) : match;
    });
  }

  var api = {
    STRINGS: STRINGS,
    resolveLocale: resolveLocale,
    t: t,
    fmt: fmt,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLI18N = api;
})(typeof self !== 'undefined' ? self : this);
