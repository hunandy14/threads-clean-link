# Threads Clean Link(脆連結清潔工)

[![Chrome Web Store](https://img.shields.io/chrome-web-store-version/hehokicokbgajpanjcajhmflaennnmdj?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/threads-clean-link/hehokicokbgajpanjcajhmflaennnmdj)

Chrome MV3 擴充功能，將 Threads 分享短連結與官方「複製連結」結果轉換為不含追蹤參數的乾淨貼文網址。雙語名稱:英文「Threads Clean Link」、中文「脆連結清潔工」，依瀏覽器語言自動顯示。

## 功能

**右鍵還原分享短連結**:於 `/share/XXXX` 短連結上按右鍵，選擇「複製乾淨的 Threads 貼文連結」，解析後的乾淨網址自動寫入剪貼簿。不限定於 threads.com 分頁使用，操作手勢本身即臨時授權當下分頁執行寫入。

```
分享短連結  https://www.threads.com/share/AbCdEfGhI
轉址結果    https://www.threads.com/@username/post/AbCd123EfGh?xmt=AQGxxxxxxxx
乾淨網址    https://www.threads.com/@username/post/AbCd123EfGh
```

**自動淨化官方「複製連結」**:Threads 網頁版「複製連結」目前會寫入 `/share/XXXX` 短碼，或帶 `?xmt=` 追蹤參數的完整網址。本功能攔截該寫入動作，短碼自動解析、參數直接剪除，結果均為乾淨網址。解析逾時(2.5 秒)或失敗時，原內容原樣放行，不影響複製功能本身。

**Popup 控制頁**:點擊工具列圖示開啟設定面板，提供兩顆滑動 switch，設定即時生效(寫入 `chrome.storage.sync`，跨裝置同步):

| 設定項 | 預設值 | 說明 |
|---|---|---|
| 自動淨化分享按鈕 | 開啟 | 關閉後停用「自動淨化官方複製連結」，右鍵還原功能不受影響 |
| 成功時顯示通知 | 關閉 | 開啟後右鍵還原成功也會跳通知;失敗通知不受此設定影響，一律顯示 |

## 安裝

已上架 Chrome Web Store，建議直接安裝:

[Threads Clean Link — Chrome Web Store](https://chromewebstore.google.com/detail/threads-clean-link/hehokicokbgajpanjcajhmflaennnmdj)

開發者選項(手動載入未封裝版本):

1. 取得原始碼:`git clone https://github.com/hunandy14/threads-clean-link.git`，或於 [Releases](https://github.com/hunandy14/threads-clean-link/releases) 下載 CI 自動打包的 zip 並解壓縮。
2. Chrome 網址列輸入 `chrome://extensions`，開啟「開發人員模式」，選擇「載入未封裝項目」並指向上述資料夾。

## 運作原理與隱私

`/share/XXXX` 短碼僅 Meta 伺服器能對應，必須發出一次請求讀取轉址後的網址才能還原，此舉等同對該連結匿名開啟一次，分享者端開啟計數可能增加。

| 情境 | 觸發方式 | 網路請求 | 讀取既有剪貼簿內容 |
|---|---|---|---|
| 右鍵還原分享短碼 | 使用者手動點選右鍵選單 | 1 次匿名 GET(`credentials: 'omit'`，不帶 cookie)，隨轉址讀取最終網址 | 否 |
| 複製連結攔到短碼 | 使用者於已登入分頁按下官方「複製連結」時自動觸發 | 同上，1 次匿名 GET | 否 |
| 複製連結攔到帶追蹤參數的完整網址 | 同上，自動觸發 | 零，純本地字串處理(去除 query 與 hash) | 否 |

- 匿名 GET 不帶登入憑證，但會暴露來源 IP、瀏覽器特徵，及可辨識為本擴充功能的 Origin 標頭。
- 功能②於已登入分頁按下複製鍵時自動觸發解析，時間與貼文對應明確，IP 層級關聯性高於①。
- 不蒐集、不留存使用者資料，不含遠端程式碼。
- 與 ClearURLs 類工具的差異:短碼不是參數，整條網址不含目標，必須先兌換。

## 權限

| 權限 | 用途 |
|---|---|
| `contextMenus` | 於 `/share/` 連結加入右鍵選單項目 |
| `scripting` + `activeTab` | 於使用者點選右鍵選單的手勢下，臨時注入當前分頁執行 `navigator.clipboard.writeText` |
| `notifications` | 顯示還原結果通知 |
| `storage` | 僅儲存 popup 兩項開關設定(自動淨化分享按鈕、成功時顯示通知)於瀏覽器同步空間(`chrome.storage.sync`)，不蒐集、不外傳任何使用者資料 |
| `host_permissions`(`*.threads.com`、`*.threads.net`) | 發出短碼解析請求;於 Threads 頁面注入淨化邏輯 |

未宣告 `<all_urls>` 與 `clipboardRead`。

## 已知限制

- 淨化功能僅作用於 Chrome 載入的 Threads 網頁版分頁，不處理手機 App 或其他裝置產生的複製內容。
- 網域、`/share/` 路徑格式、轉址行為、貼文網址格式、複製連結寫入格式若有變動，對應功能會直接失效而非靜默出錯，修復通常僅需調整比對規則。

## 開發

執行測試:`node --test test/*.test.js`

## License

MIT License，詳見 [LICENSE](./LICENSE)。
