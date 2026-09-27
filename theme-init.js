// theme-init.js — 主題鏡像的同步套用，options.html 與 popup.html 在 head 裡
// 載入的第一支 script。
//
// 主題偏好的權威值在擴充同步儲存區(storage.sync)的 themePref，但那是非同步 API，等它
// 回來第一幀早已畫完，深色偏好會先閃一下淺色。所以另存一份鏡像在同源的
// localStorage（兩頁同屬 chrome-extension://<id>，共用一份），這裡在 CSS 套用
// 前同步讀出並設 <html data-theme>；theme.css 依 data-theme 切 color-scheme。
// 邏輯層讀到 sync 的 themePref 後經注入的 themeMirror（即 TCLTheme.remember）
// 回寫鏡像並校正當頁。MV3 CSP 禁內嵌 script，所以獨立成檔。
(function () {
  'use strict';

  var KEY = 'tcl.themePref';

  // light／dark 設 data-theme；其餘（auto、system、未設定、損毀值）一律拿掉，
  // 跟系統深淺色走。
  function apply(pref) {
    var el = document.documentElement;
    if (pref === 'light' || pref === 'dark') el.dataset.theme = pref;
    else delete el.dataset.theme;
  }

  // localStorage 可能被停用或拋 SecurityError；讀不到就跟系統走。
  try {
    apply(localStorage.getItem(KEY));
  } catch (e) {}

  self.TCLTheme = {
    KEY: KEY,
    apply: apply,
    // 套用到當頁並回寫鏡像；非 light／dark 移除鏡像。寫入失敗不影響當頁。
    remember: function (pref) {
      apply(pref);
      try {
        if (pref === 'light' || pref === 'dark') localStorage.setItem(KEY, pref);
        else localStorage.removeItem(KEY);
      } catch (e) {}
    },
  };
})();
