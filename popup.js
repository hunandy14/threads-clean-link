// popup.js — popup 控制頁的邏輯層。以可注入 document 與 storage 的純函式
// 模組實作，不直接碰全域 chrome，離線可測；popup-init.js 負責把真的
// chrome.storage.sync 接上（見 popup-init.js）。
(function (root) {
  'use strict';

  // R1-1 併開關：resolveShortcode 徹底移除，短碼解析與 ?xmt 剪參都收在
  // autoClean 這一顆之下。兩個設定鍵：autoClean 預設開啟，notifySuccess
  // 預設關閉，避免安裝後立刻被成功通知洗版。
  var DEFAULT_SETTINGS = {
    autoClean: true,
    notifySuccess: false,
  };

  // checkbox 的 id 與 chrome.storage.sync 的鍵同名。
  var SETTING_IDS = ['autoClean', 'notifySuccess'];

  function createPopupController(deps) {
    var document = deps.document;
    var storage = deps.storage;

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

    function init() {
      return Promise.resolve(storage.get(DEFAULT_SETTINGS)).then(function (settings) {
        SETTING_IDS.forEach(function (id) {
          var el = getCheckbox(id);
          if (!el) return;
          var hasValue = settings && Object.prototype.hasOwnProperty.call(settings, id);
          el.checked = hasValue ? settings[id] : DEFAULT_SETTINGS[id];
        });
        SETTING_IDS.forEach(bindChange);
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
