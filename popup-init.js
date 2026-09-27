// popup-init.js — popup.html 的接線層。獨立成外部檔案，因為 MV3 的預設
// CSP（script-src 'self'）會靜默擋掉所有無 src 的內嵌 <script>：接線寫回
// popup.html 內嵌會讓開關永遠未勾選、切換不寫回 storage、版本號空白。
//
// 把真的 chrome.storage.sync 接上邏輯層；popup.js 本身不碰全域 chrome，
// 才能在 Node 測試環境離線測試（見 popup.js 檔頭）。
document.addEventListener('DOMContentLoaded', function () {
  var versionEl = document.getElementById('version');
  if (versionEl && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }
  var controller = createPopupController({
    document: document,
    storage: chrome.storage.sync,
    i18n: typeof TCLI18N !== 'undefined' ? TCLI18N : null,
    // 主題鏡像:邏輯層讀到 sync 的 themePref 後回寫 localStorage，供
    // head 裡的 theme-init.js 下次開頁同步套用(見 theme-init.js)。
    themeMirror: TCLTheme.remember,
    openOptionsPage:
      typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage
        ? function () {
            chrome.runtime.openOptionsPage();
          }
        : null,
  });
  controller.init();
});
