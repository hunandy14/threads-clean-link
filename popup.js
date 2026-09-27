// popup.js — popup 控制頁的邏輯層。以可注入 document 與 storage 的純函式
// 模組實作，不直接碰全域 chrome，離線可測；popup-init.js 負責把真的
// chrome.storage.sync 接上（見 popup-init.js）。
(function (root) {
  'use strict';

  // 共用核心 lib(此處只取預設值):擴充頁面環境靠 popup.html 的
  // <script src="tcl-core.js"> 先載入(全域 root.TCLCore);Node 測試則 require。
  var TCLCore =
    typeof module !== 'undefined' && module.exports ? require('./tcl-core.js') : root.TCLCore;

  // popup 的開關取自 TCLCore.SETTINGS_SCHEMA 裡 pages 含 'popup' 的項目
  // (autoClean、postCopyEnabled，皆在 sync 區);checkbox 的 id 即 storage 鍵。
  // saveHistory 與 scamGuardEnabled 只在 options 頁。失敗通知(Threads 頁內
  // toast + 右鍵選單系統通知)不受任何開關影響，一律顯示。
  var SETTINGS = TCLCore.SETTINGS_SCHEMA.filter(function (s) {
    return s.pages.indexOf('popup') !== -1;
  });
  var DEFAULT_SETTINGS = Object.fromEntries(
    SETTINGS.filter(function (s) { return s.area === 'sync'; }).map(function (s) { return [s.key, s.def]; })
  );

  // popup 不呈現雲端同步狀態:帳號與同步狀態(含同步失敗)一律只在 options
  // 頁的帳號區顯示，popup 因此不讀 syncState／syncAuth、不監聽
  // sync.stateChanged，也不帶 #cloud-sync 錨點的導向。

  function createPopupController(deps) {
    var document = deps.document;
    var storage = deps.storage;
    // i18n 與 openOptionsPage 皆為選配:測試的假 document 沒有
    // querySelectorAll、也不見得注入這兩個 dep，缺席時對應功能靜默跳過，
    // 兩顆開關的核心行為不受影響。
    var i18n = deps.i18n || null;
    var openOptionsPage = typeof deps.openOptionsPage === 'function' ? deps.openOptionsPage : null;
    // themeMirror 為選配:接線層注入 TCLTheme.remember(theme-init.js)，
    // 以 chrome.storage.sync 的 themePref 校正 localStorage 的主題鏡像與當頁
    // data-theme。popup 開啟時間短，不監聽之後的 themePref 變更。
    var themeMirror = typeof deps.themeMirror === 'function' ? deps.themeMirror : null;

    function getCheckbox(id) {
      return document.getElementById(id);
    }

    // popup 的開關都在 sync 區，change 直接寫回 storage(注入的 sync 區)。
    function bindChange(s) {
      var el = getCheckbox(s.key);
      if (!el) return;
      el.addEventListener('change', function (event) {
        var checked = event && event.target ? event.target.checked : el.checked;
        storage.set({ [s.key]: checked });
      });
    }

    function init() {
      // 一次讀足:兩顆開關 + 語言偏好(langPref 未設定時為 null，交由
      // resolveLocale 依瀏覽器語言偵測)+ 主題偏好(未設定時為 'auto')。
      var keys = Object.assign({ langPref: null, themePref: 'auto' }, DEFAULT_SETTINGS);
      return Promise.resolve(storage.get(keys)).then(function (settings) {
        SETTINGS.forEach(function (s) {
          var el = getCheckbox(s.key);
          if (!el) return;
          // 型別守衛同 options.js:storage 值必須真的是 boolean 才採用，否則
          // 退回 schema 的 def(防損毀/偽造的非布林值直接綁上 checkbox)。
          var value = settings ? settings[s.key] : undefined;
          el.checked = typeof value === 'boolean' ? value : s.def;
        });
        SETTINGS.forEach(bindChange);

        var nav = getCheckbox('openOptions');
        if (nav && openOptionsPage) {
          nav.addEventListener('click', function () {
            openOptionsPage();
          });
        }

        if (i18n) i18n.applyDom(document, i18n.resolveLocale(settings ? settings.langPref : null));

        // 非 light／dark 一律當 auto:鏡像被清掉，當頁跟系統深淺色走。
        // 沒有 documentElement 的文件(測試的最小 stub)不需要主題，略過。
        if (themeMirror && document.documentElement) {
          var pref = settings ? settings.themePref : null;
          themeMirror(pref === 'light' || pref === 'dark' ? pref : 'auto');
        }
      });
    }

    return { init: init };
  }

  var api = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    createPopupController: createPopupController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
    root.createPopupController = createPopupController;
  }
})(typeof window !== 'undefined' ? window : this);
