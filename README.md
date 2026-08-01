# Threads Clean Link

Chrome MV3 擴充功能,將 Threads 分享短連結與官方「複製連結」結果轉換為不含追蹤參數的乾淨貼文網址。

## 功能

**右鍵還原分享短連結**:於 `/share/XXXX` 短連結上按右鍵,選擇「複製乾淨的 Threads 貼文連結」,解析後的乾淨網址自動寫入剪貼簿。不限定於 threads.com 分頁使用,操作手勢本身即臨時授權當下分頁執行寫入。

```
分享短連結  https://www.threads.com/share/AbCdEfGhI
轉址結果    https://www.threads.com/@username/post/AbCd123EfGh?xmt=AQGxxxxxxxx
乾淨網址    https://www.threads.com/@username/post/AbCd123EfGh
```

**自動淨化官方「複製連結」**:Threads 網頁版「複製連結」目前會寫入 `/share/XXXX` 短碼,或帶 `?xmt=` 追蹤參數的完整網址。本功能攔截該寫入動作,短碼自動解析、參數直接剪除,結果均為乾淨網址。解析逾時(2.5 秒)或失敗時,原內容原樣放行,不影響複製功能本身。

## 安裝

Chrome Web Store 上架審查中。目前提供兩種安裝方式:

1. 取得原始碼:`git clone https://github.com/hunandy14/threads-clean-link.git`,或於 [Releases](https://github.com/hunandy14/threads-clean-link/releases) 下載 CI 自動打包的 zip 並解壓縮。
2. Chrome 網址列輸入 `chrome://extensions`,開啟「開發人員模式」,選擇「載入未封裝項目」並指向上述資料夾。

## 運作原理與隱私

`/share/XXXX` 短碼是一次性代碼,對應關係僅存於 Meta 伺服器,不含可離線解析的資訊。還原短碼的唯一方式,是對該連結發出一次請求,讀取轉址後的最終網址。解析等同對該分享連結進行一次匿名開啟,分享者端的開啟計數可能因此增加。

| 情境 | 觸發方式 | 網路請求 | 讀取既有剪貼簿內容 |
|---|---|---|---|
| 右鍵還原分享短碼 | 使用者手動點選右鍵選單 | 1 次匿名 GET(`credentials: 'omit'`,不帶 cookie),隨轉址讀取最終網址 | 否 |
| 複製連結攔到短碼 | 使用者於已登入分頁按下官方「複製連結」時自動觸發 | 同上,1 次匿名 GET | 否 |
| 複製連結攔到帶追蹤參數的完整網址 | 同上,自動觸發 | 零,純本地字串處理(去除 query 與 hash) | 否 |

短碼解析請求皆不攜帶登入憑證,不會以使用者身分送出;但仍會讓 Threads 伺服器看到請求來源 IP 與瀏覽器特徵,以及可辨識為本擴充功能發出的 Origin 標頭,此為任何網路請求的固有限制。需要避免 IP 層級關聯者,可搭配 VPN,或僅使用右鍵功能而不依賴自動淨化。

「複製連結」觸發的解析請求,時間點緊接在使用者於已登入分頁按下官方複製鍵之後,時間與貼文的對應關係明確,IP 層級可關聯性高於右鍵還原;在意此點者建議優先使用右鍵功能。

本擴充功能不蒐集、不留存任何使用者資料,不讀取剪貼簿既有內容(僅攔截並改寫網站自身觸發的寫入),不含遠端程式碼。

與 ClearURLs 等參數清理工具的差異:此類工具剪除的是已知追蹤參數,網址本身在剪除前即完整可見,故可零請求運作。Threads 分享短碼並非參數,而是不含目標資訊的整條網址,無法以規則剪除,必須先向伺服器解析一次才能取得可清理的網址。

## 權限

| 權限 | 用途 |
|---|---|
| `contextMenus` | 於 `/share/` 連結加入右鍵選單項目 |
| `scripting` + `activeTab` | 於使用者點選右鍵選單的手勢下,臨時注入當前分頁執行 `navigator.clipboard.writeText` |
| `notifications` | 顯示還原結果通知 |
| `host_permissions`(`*.threads.com`、`*.threads.net`) | 發出短碼解析請求;於 Threads 頁面注入淨化邏輯 |

未宣告 `<all_urls>` 與 `clipboardRead`。

## 已知限制

- 淨化功能僅作用於 Chrome 載入的 Threads 網頁版分頁,不處理手機 App 或其他裝置產生的複製內容。
- 網域、`/share/` 路徑格式、轉址行為、貼文網址格式、複製連結寫入格式若有變動,對應功能會直接失效而非靜默出錯,修復通常僅需調整比對規則。

## 開發

執行測試:`node --test test/*.test.js`

## License

MIT License,詳見 [LICENSE](./LICENSE)。
