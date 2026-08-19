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

  // 相對時間標籤刷新，比照 GitHub <relative-time> 的通行做法:
  //   - 單一共享 ticker(60 秒,對齊「x 分鐘前」的最小粒度)重算所有標籤,
  //     分頁隱藏時跳過,不做無人看見的重繪;
  //   - visibilitychange 切回分頁時立刻補刷一次,消除背景期間的凍結感。
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') controller.refresh();
    });
    setInterval(function () {
      if (document.visibilityState === 'visible') controller.refresh();
    }, 60 * 1000);
  }
});
