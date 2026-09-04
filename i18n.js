// i18n.js — 共用雙語字典與語言解析。三種載入環境:
//   - service worker:background.js 以 importScripts('i18n.js') 載入(全域 self)
//   - 擴充功能頁面:popup.html / options.html 以 <script src> 載入(全域 window)
//   - Node 測試:CommonJS require，或 vm sandbox 直接執行原始碼(全域 this)
// 函式一律帶明確 locale 參數、不留全域狀態——SW 會被終止再喚醒，任何
// 快取的語言值都可能過期，每次事件重新解析才是唯一正確來源。
//
// Chrome 官方 _locales 機制只跟瀏覽器 UI 語言、無法讓使用者在頁面上切換，
// 因此僅保留給 manifest 的 extName/extDesc;其餘文案全部走本字典，語言偏好
// 存 chrome.storage.sync 的 langPref('zh' | 'en'，未設定 = 依環境偵測)。
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
      bgUnexpected: '發生未預期的錯誤，請稍後再試一次。',

      // ---- popup ----
      ppAutoClean: '自動淨化分享按鈕',
      popPostCopyLabel: '貼文複製按鈕',
      ppHistorySettings: '紀錄與設定',
      ppFooter: '盡力而為，處理失敗不影響原功能。',

      // ---- options:頁首與統計 ----
      opSub: '脆連結清潔工 · 設定與紀錄',
      opThemeTitle: '切換主題',
      opLangTitle: '語言 / Language',
      // 統計磚區塊的 aria-label(走 i18n，見 applyI18nDom 的 data-i18n-aria
      // 通道)。
      opStatsAria: '統計摘要',
      // 此磚統計的是 stats.total(entries.length，所有 kind 都算，不只
      // 淨化類的 share/strip)。
      opTileTotal: '累計紀錄',
      opSince: '自 {d} 以來',
      opTileWeek: '本週',
      opVsLastWeek: '較上週',
      opTileShare: '短碼解析',
      opTileStrip: '剪除追蹤參數',
      opShareOfTotal: '佔 {p}%',

      // ---- options:活動圖 ----
      opChartTitle: '近 14 天活動',
      opChartUnit: '單位:次',
      opChartDesc: '近 14 天每日活動次數',
      opToday: '今天',
      opTimes: '{n} 次',

      // ---- options:設定 ----
      opSettingsTitle: '設定',
      opAutoCleanName: '自動淨化分享按鈕',
      opAutoCleanDesc: '複製時自動換成乾淨網址；關閉仍照常寫入紀錄。',
      opSaveName: '保存紀錄',
      opSaveDesc: '僅存於本機',
      // 與 popup 的 postCopyEnabled 鏡像，設定頁保留完整開關說明(popup
      // 只留精簡標籤)。
      opPostCopyName: '貼文複製按鈕',
      opPostCopyDesc: '在貼文互動列顯示複製連結按鈕',

      // ---- options:紀錄清單 ----
      opHistoryTitle: '紀錄',
      opMoreTitle: '更多動作',
      opFilterTitle: '依來源篩選',
      opExportJson: '匯出 JSON',
      opImportJson: '匯入 JSON',
      opClearAll: '清除全部紀錄',
      opClearDo: '確定清除',
      opCancel: '取消',
      opClearConfirmDesc: '將刪除全部 {n} 筆紀錄，且無法復原。確定要繼續嗎?',
      // 詳細視窗「刪除這筆」的確認框(複用清除全部/匯入那套 confirm modal)。
      opDeleteConfirmDesc: '確定刪除這筆紀錄?',
      opDeleteConfirmDo: '刪除',
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
      opOpenTitle: '開啟貼文',
      // 卡片高亮態(hover/focus-within)右上浮出的兩顆快捷鈕之一;另一顆
      // (開啟貼文)沿用上面既有的 opOpenTitle。
      opQuickCopyTitle: '複製連結',

      // ---- options:卡片詳細視窗 ----
      // sr-only 標題，螢幕閱讀器用;視覺上詳細視窗直接從卡頭(徽章/時間)
      // 開始，不另外畫一條可見標題列。
      opDetailTitle: '紀錄詳細資訊',
      opExpandFull: '展開全文',
      opRecordedTime: '記錄時間',
      opUrlLabel: '淨化後連結',
      // 「原始連結」「追蹤參數 {name}」兩列缺席容忍——沒資料就不畫，不是
      // 恆常顯示。
      opOriginalLabel: '原始連結',
      opTrackingParamLabel: '追蹤參數 {name}',
      opCopyShort: '複製',
      // 「時間軸」觸發鈕純文字不帶次數——次數改到子層視窗的標題
      // (opTimelineCount)。
      opTimelineBtn: '時間軸',
      opTimelineCount: '解析時間軸(共 {n} 次)',

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
      // storage.local 寫入失敗的專屬回報:配額超限(QUOTA_BYTES)與一般
      // 寫入失敗分開文案，避免對使用者謊報「已匯入/已刪除」成功。
      opToastStorageFull: '儲存空間不足，變更未儲存',
      opToastSaveFailed: '儲存失敗，變更未套用',

      // ---- options:相對時間 ----
      opRelJust: '剛剛',
      opRelMin: '{n} 分鐘前',
      opRelHour: '{n} 小時前',
      opRelYesterday: '昨天',
      opRelDays: '{n} 天前',

      // ---- options:頁首帳號入口(車道 B，消費 docs/cloud-sync.md 第 5
      // 節的 state 形狀;background 尚未實作前，任何無回應/形狀不對的
      // 狀態一律當 signed_out 顯示) ----
      opAccountSignIn: '登入',
      opAccountMenuLabel: '帳號選單',
      // D3:首次綁定全量上傳並告知 free 方案雲端保留上限，{n} 為登入當下
      // 本機紀錄筆數。登入確認框與刪除雲端資料確認框沿用既有的共用
      // confirmOverlay，文案鍵維持原名不動。
      opSyncSignInConfirmDesc: '登入後將立即上傳本機目前的 {n} 筆紀錄。免費方案雲端僅保留最新 1000 筆，本機仍完整保留全部紀錄，可隨時登出或刪除雲端資料。',
      opSyncSignInConfirmDo: '確認登入',
      opSyncNever: '尚未同步',
      opAccountSyncNow: '立即同步',
      opAccountSyncing: '同步中…',
      opAccountSignOut: '登出',
      opAccountDeleteCloud: '刪除雲端資料',
      opAccountLastSync: '上次同步 {t}',
      opAccountPending: '待上傳 {n} 筆',
      opAccountErrorPrefix: '同步失敗：',
      opAccountRetry: '重試',
      opAccountExpired: '登入已過期，請重新登入',
      opAccountReSignIn: '重新登入',
      opAccountStatusSynced: '已同步',
      opAccountStatusError: '同步錯誤',
      opAccountStatusExpired: '登入已過期',
      // 三件事講清楚:無法復原、本機紀錄保留、這些紀錄不會再上傳到雲端
      // (伺服器對早於 cleared_at 的紀錄一律拒收，見 api-spec 4.4；之後
      // 新清理的連結則不受影響，仍會正常上傳)。
      opSyncDeleteConfirmDesc: '雲端保存的紀錄將永久刪除，無法復原。這台裝置上的紀錄不受影響，但不會再上傳到雲端；之後新清理的連結仍會正常同步。',
      opSyncDeleteConfirmDo: '確定刪除',
      // 使用者在瀏覽器的權限對話框按了拒絕:登入流程就此中止，需要讓他知道
      // 為什麼什麼都沒發生。
      opSyncPermissionDenied: '未取得權限，無法登入',
      // 已登入時取代 opDeviceNote(「紀錄僅保存於這台裝置」)的文案。
      opDeviceNoteSynced: '已同步至你的 Google 帳號',
      // 刪除雲端資料是 fire-and-forget(sendSyncAction 不等回應)，送出當下
      // 先樂觀提示已完成;若下一次 stateChanged 帶回 lastError，改顯示
      // 錯誤 toast(沿用 opAccountErrorPrefix + lastError，不另造重複鍵)。
      opToastCloudDeleted: '已刪除雲端資料',

      // ---- popup:雲端同步狀態列(唯讀，點擊導向 options 頁的雲端同步卡片) ----
      ppSyncInactive: '雲端同步：未啟用',
      ppSyncActive: '已同步 · {t}',

      // ---- post-icon:貼文互動列注入的複製連結 icon ----
      iconTooltip: '複製原始連結',
      iconCopied: '已複製原始連結',

      // 擴充功能更新時，service worker 的舊連線會失效(context invalidated);
      // 頁面端呼叫 chrome.* API 失敗時顯示此提示，請使用者重新整理頁面
      // (post-icon.js 的失敗 toast 使用)。
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
      bgUnexpected: 'Unexpected error. Please try again later.',

      ppAutoClean: 'Auto-clean the share button',
      popPostCopyLabel: 'Post copy button',
      ppHistorySettings: 'History & settings',
      ppFooter: 'Best-effort — failures never break the original copy feature.',

      opSub: 'Threads Clean Link · Settings & history',
      opThemeTitle: 'Toggle theme',
      opLangTitle: 'Language / 語言',
      opStatsAria: 'Statistics',
      opTileTotal: 'Total records',
      opSince: 'Since {d}',
      opTileWeek: 'This week',
      opVsLastWeek: 'vs last week',
      opTileShare: 'Short links resolved',
      opTileStrip: 'Tracking params stripped',
      opShareOfTotal: '{p}% of total',

      opChartTitle: 'Activity, last 14 days',
      opChartUnit: 'unit: entries',
      opChartDesc: 'Daily activity over the last 14 days',
      opToday: 'Today',
      opTimes: '{n}×',

      opSettingsTitle: 'Settings',
      opAutoCleanName: 'Auto-clean the share button',
      opAutoCleanDesc: 'Cleans copied links automatically; recording continues either way.',
      opSaveName: 'Keep history',
      opSaveDesc: 'Local only',
      opPostCopyName: 'Post copy button',
      opPostCopyDesc: 'Show a copy-link button on posts’ action row',

      opHistoryTitle: 'History',
      opMoreTitle: 'More actions',
      opFilterTitle: 'Filter by source',
      opExportJson: 'Export JSON',
      opImportJson: 'Import JSON',
      opClearAll: 'Clear all history',
      opClearDo: 'Clear all',
      opCancel: 'Cancel',
      opClearConfirmDesc: 'This deletes all {n} entries and cannot be undone. Continue?',
      opDeleteConfirmDesc: 'Delete this record?',
      opDeleteConfirmDo: 'Delete',
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
      opQuickCopyTitle: 'Copy link',

      opDetailTitle: 'Record details',
      opExpandFull: 'Show full text',
      opRecordedTime: 'Recorded at',
      opUrlLabel: 'Cleaned link',
      opOriginalLabel: 'Original link',
      opTrackingParamLabel: 'Tracking param {name}',
      opCopyShort: 'Copy',
      opTimelineBtn: 'Timeline',
      opTimelineCount: 'Timeline ({n})',

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
      opToastStorageFull: 'Storage full — changes not saved',
      opToastSaveFailed: 'Save failed — changes not applied',

      opRelJust: 'just now',
      opRelMin: '{n} min ago',
      opRelHour: '{n} hr ago',
      opRelYesterday: 'yesterday',
      opRelDays: '{n} days ago',

      opAccountSignIn: 'Sign in',
      opAccountMenuLabel: 'Account menu',
      opSyncSignInConfirmDesc: 'Signing in uploads your {n} local records right away. The free plan keeps only the latest 1000 in the cloud, and your device keeps every record. You can sign out or delete your cloud data anytime.',
      opSyncSignInConfirmDo: 'Confirm sign-in',
      opSyncNever: 'Not synced yet',
      opAccountSyncNow: 'Sync now',
      opAccountSyncing: 'Syncing…',
      opAccountSignOut: 'Sign out',
      opAccountDeleteCloud: 'Delete cloud data',
      opAccountLastSync: 'Last synced {t}',
      opAccountPending: '{n} pending',
      opAccountErrorPrefix: 'Sync failed: ',
      opAccountRetry: 'Retry',
      opAccountExpired: 'Your sign-in has expired. Please sign in again.',
      opAccountReSignIn: 'Sign in again',
      opAccountStatusSynced: 'Synced',
      opAccountStatusError: 'Sync error',
      opAccountStatusExpired: 'Sign-in expired',
      // Three things spelled out: cannot be undone, local history is kept,
      // and these records will not be re-uploaded (the server rejects any
      // record older than clearedAt, see api-spec 4.4; newly cleared links
      // after this point still sync normally).
      opSyncDeleteConfirmDesc: 'Records stored in the cloud will be permanently deleted and cannot be recovered. Your local history on this device is unaffected, but it will not be re-uploaded; links you clean afterward will still sync normally.',
      opSyncDeleteConfirmDo: 'Delete',
      opSyncPermissionDenied: 'Permission not granted, cannot sign in',
      opDeviceNoteSynced: 'Synced to your Google account',
      // Delete-cloud is fire-and-forget (sendSyncAction does not await a
      // reply): show an optimistic toast right away, and if the next
      // stateChanged carries a lastError, replace it with an error toast
      // (reuses opAccountErrorPrefix + lastError — no separate key).
      opToastCloudDeleted: 'Cloud data deleted',

      ppSyncInactive: 'Cloud sync: off',
      ppSyncActive: 'Synced · {t}',

      iconTooltip: 'Copy original link',
      iconCopied: 'Original link copied',

      favContextLost: 'Extension updated — please refresh the page',
    },
  };

  // 任何非 zh 開頭(或無法辨識)的語言一律歸 en:目前只維護兩份字典，
  // en 是對外的安全預設。
  function normalizeLocale(raw) {
    return /^zh/i.test(String(raw || '')) ? 'zh' : 'en';
  }

  // pref 為使用者保存的明確偏好('zh' | 'en')，其餘值視為未設定，依環境
  // 偵測:chrome.i18n.getUILanguage(瀏覽器 UI 語言) → navigator.language。
  // fallbackLanguage 供測試注入，避免測試綁死於執行環境的語言。
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

  // 查無 key 時退回 zh 字典，再退回 key 本身:寧可顯示原文/鍵名，不丟例外
  // 中斷通知或頁面渲染。
  function t(locale, key) {
    var dict = STRINGS[locale] || STRINGS.zh;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    if (Object.prototype.hasOwnProperty.call(STRINGS.zh, key)) return STRINGS.zh[key];
    return key;
  }

  // 樣板插值:{name} 逐一以 vars[name] 取代;缺對應值時保留原樣，便於除錯。
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
