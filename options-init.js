// options-init.js — options.html 的接線層(MV3 CSP 禁內嵌 script,比照
// popup-init.js 獨立成檔)。把真的 chrome.storage 與檔案下載接上邏輯層;
// options.js 本身不碰全域 chrome,才能在 Node 測試環境離線測試。
document.addEventListener('DOMContentLoaded', function () {
  var versionEl = document.getElementById('version');
  if (versionEl && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  var controller = TCLOptions.createOptionsController({
    document: document,
    syncStorage: chrome.storage.sync,
    localStorage: chrome.storage.local,
    i18n: TCLI18N,
    now: function () {
      return Date.now();
    },
    // 匯出:Blob + 暫時性 <a download>;revoke 延後一拍,等下載真的啟動。
    download: function (filename, text) {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    },
  });

  controller.init();

  // background 在頁面開著時寫入新紀錄 → 即時刷新清單與統計。
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes || !changes.history) return;
      controller.setHistory(changes.history.newValue || []);
    });
  }
});
