// popup.js — popup 控制頁的邏輯層。以可注入 document 與 storage 的純函式
// 模組實作，不直接碰全域 chrome，離線可測；popup-init.js 負責把真的
// chrome.storage.sync 接上（見 popup-init.js）。
(function (root) {
  'use strict';

  // 共用核心 lib(此處只取預設值):擴充頁面環境靠 popup.html 的
  // <script src="tcl-core.js"> 先載入(全域 root.TCLCore);Node 測試則 require。
  var TCLCore =
    typeof module !== 'undefined' && module.exports ? require('./tcl-core.js') : root.TCLCore;

  // 短碼解析與 ?xmt 剪參都收在 autoClean 這一顆之下。預設值取自
  // TCLCore.DEFAULT_SETTINGS(全量三鍵的單一權威),popup 只挑自己有控件的兩顆:
  // autoClean(false)、postCopyEnabled(貼文複製按鈕，post-icon.js 的注入開關，
  // 預設 true)。saveHistory 不放 popup 快捷開關(完整設定收在 options 頁)。
  // 失敗通知(Threads 頁內 toast + 右鍵選單系統通知)不受任何開關影響，一律顯示。
  var DEFAULT_SETTINGS = {
    autoClean: TCLCore.DEFAULT_SETTINGS.autoClean,
    postCopyEnabled: TCLCore.DEFAULT_SETTINGS.postCopyEnabled,
  };

  // checkbox 的 id 與 chrome.storage.sync 的鍵同名。
  var SETTING_IDS = ['autoClean', 'postCopyEnabled'];

  // ---- 雲端同步狀態列(唯讀，車道 E 消費 docs/cloud-sync-plan.md 第 5 節
  // 的 state 形狀;popup 不放登入按鈕，只讀狀態並導向 options 頁) ----

  var SYNC_STATUSES = ['signed_out', 'signed_in', 'syncing', 'error'];

  // background 尚未實作同步引擎(車道 D)前的安全預設，也是 sync.getState
  // 無回應／回應形狀不對時的退回值——與 options.js 的同名邏輯各自獨立
  // 一份(兩檔案不共用模組，見車道 E 派工單的檔案白名單)。
  var DEFAULT_SYNC_STATE = {
    status: 'signed_out',
    email: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  };

  function isValidSyncState(state) {
    return !!state && typeof state === 'object' && SYNC_STATUSES.indexOf(state.status) !== -1;
  }

  function normalizeSyncState(state) {
    if (!isValidSyncState(state)) return DEFAULT_SYNC_STATE;
    return {
      status: state.status,
      email: typeof state.email === 'string' ? state.email : null,
      lastSyncedAt: typeof state.lastSyncedAt === 'number' && isFinite(state.lastSyncedAt) ? state.lastSyncedAt : null,
      pendingCount: typeof state.pendingCount === 'number' && isFinite(state.pendingCount) ? state.pendingCount : 0,
      lastError: typeof state.lastError === 'string' ? state.lastError : null,
      apiBase: typeof state.apiBase === 'string' ? state.apiBase : '',
    };
  }

  // 相對時間，對齊 options.js 的 relTime(同一份 opRel* 字典 key，兩檔各自
  // 一份純函式，不共用模組)。locale/nowTs 由呼叫端傳入，模組內不留狀態。
  function formatRelTime(i18n, locale, nowTs, ts) {
    var diff = Math.max(0, nowTs - ts);
    var m = Math.floor(diff / 60000);
    if (m < 1) return i18n.t(locale, 'opRelJust');
    if (m < 60) return i18n.fmt(locale, 'opRelMin', { n: m });
    var h = Math.floor(m / 60);
    if (h < 24) return i18n.fmt(locale, 'opRelHour', { n: h });
    var d = Math.floor(h / 24);
    if (d === 1) return i18n.t(locale, 'opRelYesterday');
    return i18n.fmt(locale, 'opRelDays', { n: d });
  }

  function createPopupController(deps) {
    var document = deps.document;
    var storage = deps.storage;
    // i18n 與 openOptionsPage 皆為選配:測試的假 document 沒有
    // querySelectorAll、也不見得注入這兩個 dep，缺席時對應功能靜默跳過，
    // 兩顆開關的核心行為不受影響。
    var i18n = deps.i18n || null;
    var openOptionsPage = typeof deps.openOptionsPage === 'function' ? deps.openOptionsPage : null;
    // 雲端同步狀態列點擊時導向 options 頁的雲端同步卡片
    // (options.html#cloud-sync);未注入專屬導向函式時退回一般的
    // openOptionsPage(至少能到 options 頁，只是不帶錨點)。
    var openCloudSyncSection =
      typeof deps.openCloudSyncSection === 'function' ? deps.openCloudSyncSection : openOptionsPage;
    var runtime = deps.runtime || null;
    var now = typeof deps.now === 'function' ? deps.now : function () {
      return Date.now();
    };

    var currentLocale = 'en';
    var syncState = DEFAULT_SYNC_STATE;

    function getCheckbox(id) {
      return document.getElementById(id);
    }

    function bindChange(id) {
      var el = getCheckbox(id);
      if (!el) return;
      el.addEventListener('change', function (event) {
        var checked = event && event.target ? event.target.checked : el.checked;
        var patch = {};
        patch[id] = checked;
        storage.set(patch);
      });
    }

    function applyI18n(locale) {
      if (!i18n || typeof document.querySelectorAll !== 'function') return;
      document.querySelectorAll('[data-i18n]').forEach(function (node) {
        node.textContent = i18n.t(locale, node.getAttribute('data-i18n'));
      });
      if (document.documentElement) {
        document.documentElement.lang = locale === 'zh' ? 'zh-Hant' : 'en';
      }
    }

    // 純函式風格的更新器，比照 options.js 的 renderSyncCard:只依 state 決
    // 定這一列文字，不讀寫其他外部狀態。i18n 缺席時(理論上不會發生，
    // popup-init.js 恆注入)保持空白，不丟例外。
    function updateSyncRow() {
      var textEl = getCheckbox('syncStatusText');
      if (!textEl || !i18n) return;
      if (syncState.status === 'signed_out') {
        textEl.textContent = i18n.t(currentLocale, 'ppSyncInactive');
        return;
      }
      var t =
        syncState.lastSyncedAt !== null
          ? formatRelTime(i18n, currentLocale, now(), syncState.lastSyncedAt)
          : i18n.t(currentLocale, 'opSyncNever');
      textEl.textContent = i18n.fmt(currentLocale, 'ppSyncActive', { t: t });
    }

    // 接線層在收到 background 的 {type:"sync.stateChanged"} 廣播時呼叫。
    function setSyncState(state) {
      syncState = normalizeSyncState(state);
      updateSyncRow();
    }

    // 頁面載入時跟 background 要一次目前狀態。runtime 未注入、呼叫失敗、
    // 或 background 沒有對應 handler(車道 D 完成前的必然狀態)都退回
    // DEFAULT_SYNC_STATE，讓狀態列優雅顯示未登入，不卡住 init()。
    function fetchSyncState() {
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        return Promise.resolve(DEFAULT_SYNC_STATE);
      }
      var result;
      try {
        result = runtime.sendMessage({ type: 'sync.getState' });
      } catch (e) {
        return Promise.resolve(DEFAULT_SYNC_STATE);
      }
      return Promise.resolve(result).then(normalizeSyncState, function () {
        return DEFAULT_SYNC_STATE;
      });
    }

    function init() {
      // 一次讀足:兩顆開關 + 語言偏好(langPref 未設定時為 null，交由
      // resolveLocale 依瀏覽器語言偵測)。
      var keys = Object.assign({ langPref: null }, DEFAULT_SETTINGS);
      return Promise.resolve(storage.get(keys)).then(function (settings) {
        SETTING_IDS.forEach(function (id) {
          var el = getCheckbox(id);
          if (!el) return;
          // 設定型別鏡像:對齊 options.js 的守衛——storage 值必須真的是
          // boolean 才採用，否則退回預設值(防損毀/偽造的非布林值直接綁上
          // checkbox.checked 造成非預期狀態)。
          var hasValue = settings && Object.prototype.hasOwnProperty.call(settings, id);
          el.checked = hasValue && typeof settings[id] === 'boolean' ? settings[id] : DEFAULT_SETTINGS[id];
        });
        SETTING_IDS.forEach(bindChange);

        var nav = getCheckbox('openOptions');
        if (nav && openOptionsPage) {
          nav.addEventListener('click', function () {
            openOptionsPage();
          });
        }

        currentLocale = i18n ? i18n.resolveLocale(settings ? settings.langPref : null) : 'en';
        if (i18n) applyI18n(currentLocale);

        var syncRow = getCheckbox('syncStatusRow');
        if (syncRow && openCloudSyncSection) {
          syncRow.addEventListener('click', function () {
            openCloudSyncSection();
          });
        }
        // 先以 DEFAULT_SYNC_STATE(未登入)畫出狀態列，真值回來後才刷新;
        // init() 等這步結束才 resolve，呼叫端 await 後畫面已是最終狀態
        // (比照 options.js 的 fetchSyncState 註解)。
        updateSyncRow();
        return fetchSyncState().then(function (state) {
          syncState = state;
          updateSyncRow();
        });
      });
    }

    return { init: init, setSyncState: setSyncState };
  }

  var api = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_SYNC_STATE: DEFAULT_SYNC_STATE,
    normalizeSyncState: normalizeSyncState,
    createPopupController: createPopupController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
    root.createPopupController = createPopupController;
  }
})(typeof window !== 'undefined' ? window : this);
