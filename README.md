# Threads Clean Link(脆連結清潔工)

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hehokicokbgajpanjcajhmflaennnmdj?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/threads-clean-link/hehokicokbgajpanjcajhmflaennnmdj)
[![CI](https://github.com/hunandy14/threads-clean-link/actions/workflows/release.yml/badge.svg)](https://github.com/hunandy14/threads-clean-link/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/github/license/hunandy14/threads-clean-link)](./LICENSE)

Chrome MV3 擴充功能，將 Threads 分享短連結與官方「複製連結」結果轉換為不含追蹤參數的乾淨貼文網址。雙語名稱:英文「Threads Clean Link」、中文「脆連結清潔工」，依瀏覽器語言自動顯示;介面、通知與右鍵選單文字支援中英文，預設跟隨瀏覽器語言，可於「紀錄與設定」頁手動切換。

## 功能

**右鍵還原分享短連結**:於 `/share/XXXX` 短連結上按右鍵，選擇「複製乾淨的 Threads 貼文連結」，解析後的乾淨網址自動寫入剪貼簿。不限定於 threads.com 分頁使用，操作手勢本身即臨時授權當下分頁執行寫入。

```
分享短連結  https://www.threads.com/share/AbCdEfGhI
轉址結果    https://www.threads.com/@username/post/AbCd123EfGh?xmt=AQGxxxxxxxx
乾淨網址    https://www.threads.com/@username/post/AbCd123EfGh
```

**自動淨化官方「複製連結」**:Threads 網頁版「複製連結」目前會寫入 `/share/XXXX` 短碼，或帶 `?xmt=` 追蹤參數的完整網址。本功能攔截該寫入動作，短碼自動解析、參數直接剪除，結果均為乾淨網址。解析逾時(2.5 秒)或失敗時，原內容原樣放行，不影響複製功能本身。

**貼文互動列「複製原始連結」按鈕**:於每篇貼文的互動列(分享按鈕旁)新增一顆鏈節圖示，點擊即複製該貼文的乾淨網址(不含追蹤參數、非短碼)。外觀比照原生按鈕(顏色自動跟隨、hover 提示為原生 tooltip)，文字支援中英文並跟隨介面語言設定。

**Popup 控制頁**:點擊工具列圖示開啟設定面板，提供兩顆滑動 switch 與「紀錄與設定」頁入口，設定即時生效(寫入 `chrome.storage.sync`，跨裝置同步):

| 設定項 | 預設值 | 說明 |
|---|---|---|
| 自動淨化分享按鈕 | 開啟 | 關閉後停用「自動淨化官方複製連結」，右鍵還原功能不受影響 |
| 成功時顯示通知 | 關閉 | 開啟後右鍵還原成功也會跳通知;失敗通知不受此設定影響，一律顯示 |

**紀錄與設定頁(options page)**:由 popup 第三列或擴充功能管理頁進入。每次淨化成功的乾淨網址會留下一筆紀錄(標示來源:短碼解析／剪除參數／右鍵還原)，提供搜尋、來源篩選、每頁筆數切換、單筆複製與刪除、全部清除(確認對話框)、JSON 匯出與匯入(以網址去重合併);上方有累計統計磚與近 14 天活動圖，皆由本機紀錄即時聚合。紀錄存於 `chrome.storage.local`，**預設僅保存在本機、不會外傳(除非另行啟用下方「雲端同步」選用功能並登入)**，上限 1,000 筆自動汰舊，可用「保存淨化紀錄」開關(預設開啟)停用。頁面另提供介面語言(中文/EN)與深淺色主題切換。

**雲端同步(選用，需 Google 登入)**:預設關閉，於「紀錄與設定」頁主動點擊「使用 Google 帳號登入」後才會啟用。登入後，清理紀錄(清理前後的網址、被移除的追蹤參數、貼文作者名稱與帳號、貼文摘要、清理時間)會同步到開發者自營伺服器，並與手機版「Meta Link Clearer」App 共用同一份紀錄;不同步瀏覽紀錄、cookie 或 Threads 帳號密碼。免費方案雲端保留最新 1,000 筆，本機紀錄不受影響、仍完整保留。可隨時在同一頁登出、清除雲端紀錄，或刪除帳號(伺服器端立即永久刪除)。未登入時，本擴充功能不會連線到任何自建伺服器。詳見下方[運作原理與隱私](#運作原理與隱私)。

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
- 不蒐集、不上傳任何使用者資料，不含遠端程式碼。淨化紀錄僅寫入 `chrome.storage.local`，預設只存在這台裝置、不隨帳號同步、不經任何伺服器(除非另行啟用下方「雲端同步」選用功能並登入)，且可一鍵清除或整個停用。
- 與 ClearURLs 類工具的差異:短碼不是參數，整條網址不含目標，必須先兌換。

### 雲端同步(選用)

- 預設關閉，不會自動連線任何自建伺服器。只有使用者在「紀錄與設定」頁主動點擊「使用 Google 帳號登入」，才會啟用同步;未登入狀態下，本擴充功能的網路行為與上表完全相同，不會多發生任何連線。
- 登入採 Google OAuth(透過 `identity` 權限)，本擴充功能只會取得 Google 回傳的身分權杖，用它向後端建立工作階段——**不會取得你的 Google 密碼**，也不會存取 Gmail、聯絡人或任何其他 Google 資料。請求的授權範圍(scope)僅 `openid`、`email`、`profile` 三項。
- 後端是開發者自營的伺服器，也是手機版 App「Meta Link Clearer」共用的同一套帳號與資料，讓兩邊的清理紀錄互相同步。
- 同步的資料僅限清理紀錄本身:清理前後的網址、被移除的追蹤參數、貼文作者名稱與帳號、貼文摘要、清理時間。**不會**同步瀏覽紀錄、cookie、Threads 帳號密碼，或任何未經清理的頁面內容。
- 免費方案雲端保留最新 1,000 筆;本機紀錄不受影響，一律完整保留(不隨雲端上限被裁切)。
- 可隨時在「紀錄與設定」頁登出、清除雲端紀錄，或直接刪除帳號——刪除帳號為伺服器端立即永久刪除，不可復原。
- 資料傳輸全程 HTTPS。伺服器不投放廣告、不販售資料、不分析使用者行為。

## 權限

| 權限 | 用途 |
|---|---|
| `contextMenus` | 於 `/share/` 連結加入右鍵選單項目 |
| `scripting` + `activeTab` | 於使用者點選右鍵選單的手勢下，臨時注入當前分頁執行 `navigator.clipboard.writeText` |
| `notifications` | 顯示還原結果通知 |
| `storage` | 同步空間(`chrome.storage.sync`)存開關設定與語言/主題偏好;本機空間(`chrome.storage.local`)存淨化紀錄(上限 1,000 筆，僅本機、可停用可清除)。均不蒐集、不外傳任何使用者資料 |
| `host_permissions`(`*.threads.com`、`*.threads.net`) | 發出短碼解析請求;於 Threads 頁面注入淨化邏輯 |

未宣告 `<all_urls>` 與 `clipboardRead`。

各權限的實際觸發情境見[運作原理與隱私](#運作原理與隱私)。

### 選用權限(雲端同步，登入當下才請求)

| 權限 | 用途 |
|---|---|
| `identity`(選用) | 透過 Google OAuth 登入流程，換取用於建立雲端同步工作階段的身分權杖(scope 僅 `openid`、`email`、`profile`);僅在使用者主動點擊「使用 Google 帳號登入」時才會請求，不登入永遠不會被詢問 |
| `host_permissions`(選用，`api.metalinkclearer.workers.dev`、測試用 `api-staging.metalinkclearer.workers.dev`) | 傳輸/讀取雲端同步的清理紀錄;僅在登入後使用，且僅連線至這兩個網域 |

上述兩項為 `optional_permissions`／`optional_host_permissions`，安裝當下不會要求，未登入狀態下不會被請求，也不會有任何相關網路連線。

## 已知限制

- 淨化功能僅作用於 Chrome 載入的 Threads 網頁版分頁，不處理手機 App 或其他裝置產生的複製內容。
- 網域、`/share/` 路徑格式、轉址行為、貼文網址格式、複製連結寫入格式若有變動，對應功能會直接失效而非靜默出錯，修復通常僅需調整比對規則。

## 開發

執行測試:`node --test test/*.test.js`

## License

MIT License，詳見 [LICENSE](./LICENSE)。
