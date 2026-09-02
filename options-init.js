// options-init.js — options.html 的接線層(MV3 CSP 禁內嵌 script，比照
// popup-init.js 獨立成檔)。把真的 chrome.storage 與檔案下載接上邏輯層;
// options.js 本身不碰全域 chrome，才能在 Node 測試環境離線測試。
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
    // 匯出:Blob + 暫時性 <a download>;revoke 延後一拍，等下載真的啟動。
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
    // 雲端同步(車道 E 消費、車道 D 實作 sync.js 的 runtime message 介面，
    // 見 docs/cloud-sync-plan.md 第 5.1 節):包成 Promise<response>，用
    // callback + chrome.runtime.lastError 判斷而非原生 Promise 簽名，跨
    // Chrome 版本都能在「background 沒有對應 handler」時穩定退回
    // undefined，不讓未捕捉的 rejection 噴到主控台。
    // 雲端同步的 optional 權限(identity ＋ 後端 host,D8):request 必須在使用
    // 者手勢中呼叫，因此由登入按鈕的 click handler 發起(見 options.js 的
    // ensureSyncPermissions)。callback 形式包成 Promise，與 runtime 同慣例。
    permissions: {
      contains: function (descriptor) {
        return new Promise(function (resolve) {
          try {
            chrome.permissions.contains(descriptor, function (granted) {
              resolve(!chrome.runtime.lastError && granted === true);
            });
          } catch (e) {
            resolve(false);
          }
        });
      },
      request: function (descriptor) {
        return new Promise(function (resolve) {
          try {
            chrome.permissions.request(descriptor, function (accepted) {
              resolve(!chrome.runtime.lastError && accepted === true);
            });
          } catch (e) {
            resolve(false);
          }
        });
      },
    },
    runtime: {
      sendMessage: function (message) {
        return new Promise(function (resolve) {
          try {
            chrome.runtime.sendMessage(message, function (response) {
              if (chrome.runtime.lastError) {
                resolve(undefined);
                return;
              }
              resolve(response);
            });
          } catch (e) {
            resolve(undefined);
          }
        });
      },
    },
  });

  controller.init().then(function () {
    // popup 的雲端同步狀態列會導向 options.html#cloud-sync；載入時若帶
    // 這個 hash 就捲到卡片(卡片本身 id="cloud-sync"，見 options.html)。
    if (typeof location !== 'undefined' && location.hash === '#cloud-sync') {
      var target = document.getElementById('cloud-sync');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    }
  });

  // background 在雲端同步狀態變化時廣播 {type:"sync.stateChanged", state}
  // (docs/cloud-sync-plan.md 第 5.3 節);options 頁常開時靠這個即時更新
  // 卡片，不需要輪詢 sync.getState。
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'sync.stateChanged') {
        controller.setSyncState(message.state);
      }
    });
  }

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
  //   - 單一共享 ticker(60 秒，對齊「x 分鐘前」的最小粒度)重算所有標籤，
  //     分頁隱藏時跳過，不做無人看見的重繪;
  //   - visibilitychange 切回分頁時立刻補刷一次，消除背景期間的凍結感。
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') controller.refresh();
    });
    setInterval(function () {
      if (document.visibilityState === 'visible') controller.refresh();
    }, 60 * 1000);
  }
});
