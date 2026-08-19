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
  // autoClean(false)、postCopyEnabled(貼文複製按鈕,post-icon.js 的注入開關,
  // 預設 true)。saveHistory 不放 popup 快捷開關(完整設定收在 options 頁)。
  // 失敗通知(Threads 頁內 toast + 右鍵選單系統通知)不受任何開關影響,一律顯示。
  var DEFAULT_SETTINGS = {
    autoClean: TCLCore.DEFAULT_SETTINGS.autoClean,
    postCopyEnabled: TCLCore.DEFAULT_SETTINGS.postCopyEnabled,
  };

  // checkbox 的 id 與 chrome.storage.sync 的鍵同名。
  var SETTING_IDS = ['autoClean', 'postCopyEnabled'];

  function createPopupController(deps) {
    var document = deps.document;
    var storage = deps.storage;
    // i18n 與 openOptionsPage 皆為選配:測試的假 document 沒有
    // querySelectorAll、也不見得注入這兩個 dep,缺席時對應功能靜默跳過,
    // 兩顆開關的核心行為不受影響。
    var i18n = deps.i18n || null;
    var openOptionsPage = typeof deps.openOptionsPage === 'function' ? deps.openOptionsPage : null;

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

    function init() {
      // 一次讀足:兩顆開關 + 語言偏好(langPref 未設定時為 null,交由
      // resolveLocale 依瀏覽器語言偵測)。
      var keys = Object.assign({ langPref: null }, DEFAULT_SETTINGS);
      return Promise.resolve(storage.get(keys)).then(function (settings) {
        SETTING_IDS.forEach(function (id) {
          var el = getCheckbox(id);
          if (!el) return;
          // F6 設定型別鏡像:對齊 options.js 的守衛——storage 值必須真的是
          // boolean 才採用,否則退回預設值(防損毀/偽造的非布林值直接綁上
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

        if (i18n) {
          applyI18n(i18n.resolveLocale(settings ? settings.langPref : null));
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
