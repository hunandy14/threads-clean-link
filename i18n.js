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
      // 頁首下方的分頁列:總覽(統計磚＋圖表＋設定)／貼文(紀錄卡)／警示名單
      // (警示名單卡)。
      opTabOverview: '總覽',
      opTabPosts: '貼文',
      opTabFlags: '警示名單',
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
      // 極短版相對時間，格式照 Threads 自己的貼文時間:數字與單位之間不留空
      // 白、不帶「前」字。警示名單卡的作者列用這一組(時間緊貼帳號，完整語
      // 氣的「N 分鐘前」會把那一行撐長)。刻意與上面那組分開:上面那組是紀錄
      // 卡在用的，共用一份會讓改其中一邊悄悄動到另一邊。
      opRelNow: '剛剛',
      opRelMinutes: '{n}分鐘',
      opRelHours: '{n}小時',
      // 不叫 opRelDays:那顆已被紀錄卡的相對時間佔著（「{n} 天前」），改寫
      // 它會把紀錄卡的文案一起換掉。
      opRelDaysShort: '{n}天',

      // ---- options:頁首帳號入口(車道 B，消費 docs/cloud-sync.md 第 5
      // 節的 state 形狀;background 尚未實作前，任何無回應/形狀不對的
      // 狀態一律當 signed_out 顯示) ----
      opAccountSignIn: '登入',
      opAccountMenuLabel: '帳號選單',
      // 觸發鈕自身 aria-label 併入狀態文字用的樣板(見 options.js 的
      // renderAccount)——巢狀 statusDot 上的 aria-label 不會被讀屏器讀出
      // (aria-label 只認最近的可及性物件，這裡就是 button 本身)，狀態文字
      // 必須併進觸發鈕唯一的 aria-label 才唸得到。
      opAccountMenuLabelStatus: '{label}，{status}',
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
      // 登入失敗的一次性提示(L5)。取消不出聲，暫時性只說「再試一次」——錯誤
      // 碼對使用者沒有意義;設定錯誤重試無用，要讓他報得出這串碼。
      opAccountSignInFailed: '登入失敗，請稍後再試',
      opAccountSignInConfigError: '登入設定有誤，請回報錯誤碼：{code}',
      // 已登入時取代 opDeviceNote(「紀錄僅保存於這台裝置」)的文案。
      opDeviceNoteSynced: '已同步至你的 Google 帳號',
      // 刪除雲端資料是 fire-and-forget(sendSyncAction 不等回應)，送出當下
      // 先樂觀提示已完成;若下一次 stateChanged 帶回 lastError，改顯示
      // 錯誤 toast(沿用 opAccountErrorPrefix + lastError，不另造重複鍵)。
      opToastCloudDeleted: '已刪除雲端資料',

      // ---- 裝置管理(0.7 裝置歸屬):帳號選單入口與裝置對話框 ----
      // 選單項右側的台數只印數字＋量詞，0 台時整個 span 收掉不顯示。
      opAccountManageDevices: '管理裝置',
      opDeviceCount: '{n} 台',
      opDevicesTitle: '裝置',
      opDevicesSubtitle: '{n} 台裝置正在同步',
      // 裝置列第二行同時給「新增於」與「最後同步」，讓同名的兩台機器
      // 靠時間自行辨認(計畫 §10:不加序號、不做一次性提示)。
      opDeviceAddedOn: '新增於 {d}',
      opDeviceLastSync: '最後同步 {t}',
      opDeviceThisDevice: '這台裝置',
      opDeviceRename: '重新命名',
      // 行內改名的 input 沒有可見標籤，aria-label 補上。
      opDeviceNameAria: '裝置名稱',
      opDeviceRemove: '移除',
      // 正在使用的這台不可移除:垃圾桶停用，說明掛在外層 span 的 title
      // (停用的按鈕不觸發原生提示)。
      opDeviceRemoveDisabled: '無法移除正在使用的裝置',
      opDeviceRemoveTitle: '移除「{name}」？',
      // 講清楚移除只是從清單拿掉，不等於把那台裝置登出。
      opDeviceRemoveDesc: '這只會把它從裝置清單移除，不會將它登出。如果那台裝置仍然登入，下次同步時會再次出現。紀錄上的裝置名稱會保留。',
      opDeviceEmpty: '找不到裝置，同步一次即可註冊這台裝置',
      opDeviceRegisteredToast: '已將這台裝置加入清單',
      // 取清單失敗時的錯誤列:既有的列保留不清掉，只在上方加這一句。
      opDevicesLoadError: '無法取得裝置清單，請稍後再試',
      opDeviceRenameFailed: '重新命名失敗，請稍後再試',
      opDeviceRemoveFailed: '移除失敗，請稍後再試',
      // 紀錄側 join 到已移除的裝置時，接在原名後面的淡字標記。
      opDeviceRemovedTag: '已移除',
      // 紀錄的 seen 事件帶了 deviceId，但清單裡活躍與已移除都查不到那台裝置。
      opDeviceUnknown: '未知裝置',

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

      // ---- scam-guard:LINE 群組引導警示 ----
      // 詳情頁與河道共用的 .tcl-scam-tag:標籤文字與原生 tooltip(title)。
      scamTagLabel: 'LINE 群組引導',
      scamTagTooltip:
        '這串貼文含引導加入 LINE 或群組的字句，常見於投資招攬。請自行判斷，勿輕易加好友或提供個資。',
      // 某作者首次被判定命中、自動加入本機警示名單時的提示。
      scamFirstHitToast: '已把這個帳號加入本機警示名單，可在設定頁管理。',
      // 作者已在警示名單中(非本次命中)時，標籤顯示的理由。
      scamBlockedByList: '這個帳號曾發過引導加入 LINE 的串文，已在你的本機警示名單中。',
      // 選項頁設定卡的總開關 #scamGuardEnabled。功能名沿用貼文上那顆 pill
      // 的說法(scamTagLabel「LINE 群組引導」)，清單本身則一律叫警示名單。
      opScamGuardName: 'LINE 群組引導警示',
      opScamGuardDesc:
        '偵測引導加入 LINE 群組的串文並把作者加入本機警示名單；名單只存在這台裝置，不上雲。',
      // 設定卡內指向警示名單分頁的同頁錨點(a#scamManageLink[href="#flags"])。
      opScamManageLink: '管理警示名單 →',

      // ---- 選項頁:警示名單卡(警示名單分頁) ----
      opScamListTitle: '警示名單',
      opScamListCount: '{n} 位作者',
      // 標題列右側的小字:這位作者是什麼時候被標記的(條目的 addedAt)。
      // 「加入」聽起來像使用者主動加的，實際上是偵測命中後自動標記。
      opScamAddedAt: '標記於 {date}',
      // 保留鍵:同一個日期的舊文案。改版後標題列走 opScamAddedAt。
      opScamAddedOn: '加入於 {d}',
      // 保留鍵:貼文發布日期。標題列原本另外畫一段「貼文 YYYY-MM-DD」，但主
      // 卡只放最新一筆證據，證據列上已經有同一個日期連結，兩者重複，改版後
      // 只留證據列那一個(它只畫純日期，不套這句文案)。
      opScamPostedAt: '貼文 {date}',
      // 保留鍵:最近命中日期。改版後卡片只顯示貼文發布日期，這句已無人使
      // 用，留著以免日後又要重新定稿一次文案。
      opScamLastHit: '最近命中 {date}',
      // 標題列最右的 pill:這位作者留下幾筆證據。兩筆以上時可點，開證據對話
      // 框;對話框標題為「顯示名 @handle · 命中 N 篇」。
      opScamHitCount: '命中 {n} 篇',
      // 保留鍵:證據區小標。改版後證據區只放最新一筆，小標佔一行卻不帶資
      // 訊，已從版面拿掉。
      opScamEvidence: '證據',
      // 證據日期連結的無障礙名稱(連結文字只有一個日期，讀屏讀不出它連去哪)。
      opScamEvidencePost: '證據貼文 ↗',
      // 保留鍵:回串頭的連結。證據貼文連的就是錨點那一篇，回串頭是 Threads
      // 自己的事，卡上多一條連結只是把兩個去處擺在一起讓人猶豫;threadUrl
      // 照存不動，只是不畫。
      opScamEvidenceThread: '整串 ↗',
      // 保留鍵:同文異篇合併的篇數標示。改版後證據逐筆呈現不再合併。
      opScamSameText: '出現在 {n} 篇',
      // 保留鍵:訊號 chip(對應 detectScamPitch 的 signals 白名單)。那是判定
      // 的內部分類，使用者看片段本身就知道為什麼被標記，已從版面拿掉;
      // signals 照存不動，除錯與日後調參仍用得到。
      opScamSignalLink: '連結',
      opScamSignalLine: 'LINE',
      opScamSignalGroup: '群組',
      opScamSignalJoin: '加入',
      opScamSignalPitch: '話術',
      opScamRemove: '解除',
      opScamRemoveTitle: '解除「{name}」的警示？',
      // 講清楚解除是永久的:該作者進 allowlist，日後再命中也不會自動加回。
      opScamRemoveDesc: '解除後不會再自動加入警示名單；貼文上的標記會消失。',
      opScamRemoveFailed: '解除失敗，請稍後再試',
      opScamEmpty: '警示名單目前沒有作者',
      // 「已解除」小節:列出 allowlist，可一鍵復原回警示名單。
      opScamAllowlistTitle: '已解除',
      // 卡頭資訊鈕開的「這個功能怎麼運作」說明視窗:五段條列，每段是「粗體
      // 開頭句 ＋ 說明」。講清楚掃描時機、資料落在哪、以及判定會誤判——這
      // 是對真人帳號的負面標記，使用者有權知道它憑什麼下判斷。
      opScamInfoTitle: '這個功能怎麼運作',
      opScamInfo1:
        '只在你點進貼文時掃描。|打開一則貼文的詳情頁，擴充會在本機讀整串自回覆的文字，找「引導加 LINE 或群組」的字句（例如 LINE：xxx、賴：xxx、加我、拉你進群）。不會主動去爬河道。',
      opScamInfo2:
        '命中就掛標記並記下作者。|貼文作者列會出現「LINE 群組引導」標記，作者的數字 ID 會加入這台裝置的警示名單，並保存那一篇的片段當證據。用 ID 記，對方改帳號名也認得。',
      opScamInfo3:
        '河道只查表不掃文。|之後在河道看到名單裡的作者，他的貼文會直接掛標記，不用點進去。',
      opScamInfo4:
        '資料只在這台裝置。|名單與證據存在本機，不上傳、不同步、不與他人共享。頁面沒帶作者 ID 時，會對同一篇貼文發一次不帶登入的請求補查，24 小時內同一篇只發一次。',
      opScamInfo5:
        '判定是規則比對，可能誤判。|遇到誤判按「⋯ → 解除」，該作者不會再被自動加入；在「已解除」可以復原。標記只是提醒，請自行判斷。',
      opScamRestore: '復原',
      opScamRestoreFailed: '復原失敗，請稍後再試',
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
      opTabOverview: 'Overview',
      opTabPosts: 'Posts',
      opTabFlags: 'Warning list',
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
      opRelNow: 'now',
      opRelMinutes: '{n}m',
      opRelHours: '{n}h',
      opRelDaysShort: '{n}d',

      opAccountSignIn: 'Sign in',
      opAccountMenuLabel: 'Account menu',
      opAccountMenuLabelStatus: '{label}, {status}',
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
      opAccountSignInFailed: 'Sign-in failed, please try again later',
      opAccountSignInConfigError: 'Sign-in is misconfigured. Please report this code: {code}',
      opDeviceNoteSynced: 'Synced to your Google account',
      // Delete-cloud is fire-and-forget (sendSyncAction does not await a
      // reply): show an optimistic toast right away, and if the next
      // stateChanged carries a lastError, replace it with an error toast
      // (reuses opAccountErrorPrefix + lastError — no separate key).
      opToastCloudDeleted: 'Cloud data deleted',

      // ---- Device management (0.7 device attribution) ----
      // English has no measure word, so the menu count prints the bare
      // number; the span is hidden entirely at zero.
      opAccountManageDevices: 'Manage devices',
      opDeviceCount: '{n}',
      opDevicesTitle: 'Devices',
      // 台數是 1 的機率很高(第一次登入只有這台)，用不吃單複數的寫法。
      opDevicesSubtitle: 'Syncing {n} device(s)',
      opDeviceAddedOn: 'Added {d}',
      opDeviceLastSync: 'Last synced {t}',
      opDeviceThisDevice: 'This device',
      opDeviceRename: 'Rename',
      opDeviceNameAria: 'Device name',
      opDeviceRemove: 'Remove',
      opDeviceRemoveDisabled: 'You cannot remove the device you are using',
      opDeviceRemoveTitle: 'Remove "{name}"?',
      opDeviceRemoveDesc: 'This only removes it from the device list; it will not be signed out. If that device is still signed in, it will show up again on its next sync. Device names on your records are kept.',
      opDeviceEmpty: 'No devices found. Sync once to register this device.',
      opDeviceRegisteredToast: 'This device has been added to the list',
      opDevicesLoadError: 'Could not load your devices. Please try again later.',
      opDeviceRenameFailed: 'Rename failed. Please try again later.',
      opDeviceRemoveFailed: 'Remove failed. Please try again later.',
      opDeviceRemovedTag: 'Removed',
      opDeviceUnknown: 'Unknown device',

      ppSyncInactive: 'Cloud sync: off',
      ppSyncActive: 'Synced · {t}',

      iconTooltip: 'Copy original link',
      iconCopied: 'Original link copied',

      favContextLost: 'Extension updated — please refresh the page',

      scamTagLabel: 'LINE group funnel',
      scamTagTooltip:
        'This thread nudges readers to add a LINE contact or join a group, a pattern common in investment pitches. Use your own judgment and avoid sharing personal details.',
      scamFirstHitToast: 'Added this account to your local warning list. Manage it in Settings.',
      scamBlockedByList:
        'This account has posted threads that funnel readers to LINE. It is on your local warning list.',
      opScamGuardName: 'LINE group funnel warnings',
      opScamGuardDesc:
        'Detects threads that funnel readers into LINE groups and adds the author to your local warning list. The list stays on this device only.',
      opScamManageLink: 'Manage warning list →',

      opScamListTitle: 'Warning list',
      // 人數是 1 的機率很高(第一次命中只有一位)，用不吃單複數的寫法。
      opScamListCount: '{n} author(s)',
      opScamAddedAt: 'Flagged {date}',
      opScamAddedOn: 'Added {d}',
      opScamPostedAt: 'Posted {date}',
      opScamLastHit: 'Last hit {date}',
      // 篇數是 1 的機率很高，用不吃單複數的寫法(比照 opScamListCount)。
      opScamHitCount: '{n} hits',
      opScamEvidence: 'Evidence',
      opScamEvidencePost: 'Evidence post ↗',
      opScamEvidenceThread: 'Full thread ↗',
      opScamSameText: 'Seen in {n} posts',
      opScamSignalLink: 'Link',
      opScamSignalLine: 'LINE',
      opScamSignalGroup: 'Group',
      opScamSignalJoin: 'Join',
      opScamSignalPitch: 'Pitch',
      opScamRemove: 'Remove',
      opScamRemoveTitle: 'Remove “{name}” from the warning list?',
      opScamRemoveDesc:
        'They will not be added to the warning list again automatically; the badge on their posts disappears.',
      opScamRemoveFailed: 'Remove failed. Please try again later.',
      opScamEmpty: 'Warning list is empty',
      opScamAllowlistTitle: 'Removed',
      opScamInfoTitle: 'How this works',
      opScamInfo1:
        'It only scans when you open a post.|When you open a post page, the extension reads the whole self-reply thread locally and looks for lines that funnel you to LINE or a group (for example LINE: xxx, 賴: xxx, add me, I will pull you into the group). It never crawls your feed on its own.',
      opScamInfo2:
        'A hit gets a badge, and the author is recorded.|A “LINE group funnel” badge appears on the post author row, the author numeric ID is added to this device local warning list, and the matching snippet is kept as evidence. Recording by ID means a rename does not shake it off.',
      opScamInfo3:
        'In the feed it only checks the list.|When an author already on the list shows up in your feed, their posts get the badge right away, with no scanning and no need to open them.',
      opScamInfo4:
        'The data stays on this device.|The list and its evidence live in local storage only: never uploaded, never synced, never shared. If a page does not carry the author ID, one signed-out request is made for that same post to fill it in, at most once per post per 24 hours.',
      opScamInfo5:
        'It is rule matching, so it can be wrong.|If a call looks wrong, use “⋯ → Remove”; that author is never added automatically again, and you can undo it under “Removed”. A badge is a heads-up, not a verdict — judge for yourself.',
      opScamRestore: 'Undo',
      opScamRestoreFailed: 'Undo failed. Please try again later.',
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
