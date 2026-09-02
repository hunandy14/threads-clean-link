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
    openOptionsPage:
      typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage
        ? function () {
            chrome.runtime.openOptionsPage();
          }
        : null,
    // 雲端同步狀態列的導向:chrome.runtime.openOptionsPage() 不支援帶
    // hash，改用 chrome.tabs.create 直接開 options.html#cloud-sync(見
    // manifest.json 的 options_ui.open_in_tab:true——options 頁本來就是
    // 獨立分頁，效果等價)。chrome.tabs.create 不需要宣告 "tabs" 權限
    // (只有讀取既有分頁清單／敏感欄位才需要)。
    openCloudSyncSection:
      typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create
        ? function () {
            chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#cloud-sync' });
          }
        : null,
    // 同一份 runtime.sendMessage 包裝，見 options-init.js 的對應註解。
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
  controller.init();

  // background 廣播 sync.stateChanged 時即時更新狀態列(docs/
  // cloud-sync-plan.md 第 5.3 節)，popup 每次開啟都是新分頁環境，這裡
  // 主要是防禦 popup 開著時 background 剛好推送。
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'sync.stateChanged') {
        controller.setSyncState(message.state);
      }
    });
  }
});
