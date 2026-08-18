// popup.js — popup 控制頁的邏輯層。以可注入 document 與 storage 的純函式
// 模組實作，不直接碰全域 chrome，離線可測；popup-init.js 負責把真的
// chrome.storage.sync 接上（見 popup-init.js）。
(function (root) {
  'use strict';

  // R1-1 併開關：resolveShortcode 徹底移除，短碼解析與 ?xmt 剪參都收在
  // autoClean 這一顆之下。
  //
  // 0.5.0 方案甲(使用者拍板三條設定變更):
  //   - 移除「成功時顯示通知」開關(notifySuccess)整組——底層設定鍵仍在
  //     background.js 使用(另一車道尚未拆通知)，只是 popup 不再放快捷
  //     開關，完整設定收在 options 頁(opNotifyName/opNotifyDesc 那列)。
  //   - autoClean 預設值改 false，配合 background.js(另一車道)同步調整
  //     的新預設，popup 這側的初始渲染 fallback 要跟著改，否則使用者第
  //     一次開 popup 看到的開關狀態會跟 background 實際行為不一致。
  //   - 新增 postCopyEnabled(貼文複製按鈕，post-icon.js 的複製按鈕注入
  //     開關，另一車道讀取)，預設 true。
  var DEFAULT_SETTINGS = {
    autoClean: false,
    postCopyEnabled: true,
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
          var hasValue = settings && Object.prototype.hasOwnProperty.call(settings, id);
          el.checked = hasValue ? settings[id] : DEFAULT_SETTINGS[id];
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
