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

  // 常開頁面的即時性:
  //   - local 區:background 在頁面開著時寫入新紀錄 → 即時刷新卡片牆與
  //     統計(既有接線)。
  //   - sync 區:popup 或另一個開著的 options 分頁改了設定(開關/語言/
  //     主題)→ 本頁同步反映，不留過期狀態。
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (!changes) return;
      if (areaName === 'local' && changes.history) {
        controller.setHistory(changes.history.newValue || []);
      } else if (areaName === 'sync') {
        controller.setSyncSettings(changes);
      }
    });
  }

  // 回到分頁時重算相對時間標籤。頁面留在背景分頁的期間不會
  // 即時跳動——這是刻意的範圍取捨:背景分頁沒有計時器持續刷新，只在
  // visibilitychange(切回來)這個時機點重算一次，避免常駐 interval 空耗
  // 資源;使用者實際會看到文字的時候(切回分頁)保證是最新的。
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') controller.refresh();
    });
  }
});
