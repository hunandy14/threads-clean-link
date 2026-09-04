# Chrome Web Store 上架文案

給開發者主控台(Chrome Web Store Developer Dashboard)逐欄位填寫用，標題即欄位名稱，內文都是可直接複製貼上的文字。所有隱私相關表述均與 [README.md](../README.md) 的〈運作原理與隱私〉一節保持一致，不得在此加碼、也不得弱化。

> **範例網址一律使用虛構佔位字串**:`https://www.threads.com/share/AbCdEfGhI`、`https://www.threads.com/@username/post/AbCd123EfGh`。這兩條是刻意做成「格式擬真但明顯是佔位」的假資料(大小寫混合、`@username`)，不對應任何真實帳號或真實短碼，與 background.js 註解、README 範例區塊用的是同一組。

---

## 1. 商品名稱(Extension name)

```
Threads Clean Link
```

備註:v1.1(0.2.0)起已改用 `_locales/zh_TW/messages.json` + `_locales/en/messages.json`，搭配 `manifest.json` 的 `"name": "__MSG_extName__"` 做 i18n(`default_locale` 為 `en`)，依瀏覽器語言自動顯示雙語名稱:中文「脆連結清潔工」、英文「Threads Clean Link」。

備註:0.4.0 起，工具列與擴充功能圖示(`icons/icon16.png`／`icon48.png`／`icon128.png`)已更新為透明背景的橘色盾牌+黑色鏈節圖案，與行動版 App 圖示視覺一致，上架主控台的 Store icon(128×128)請改用最新版素材重新上傳。

---

## 2. 簡短描述(Short description，上限 132 字元)

**繁體中文版**(49 字元):

```
一鍵把 Threads 分享短碼還原成乾淨貼文網址，並自動淨化網頁版「複製連結」的短碼與追蹤參數。
```

**英文版**(110 字元):

```
Restore Threads /share/ links to clean post URLs, and auto-clean tracking codes from the web Copy Link button.
```

字元數以 JS 字串長度(UTF-16 code unit，與商店表單計數方式一致)實測皆遠低於 132 上限。

---

## 3. 詳細描述(Detailed description)

商店描述欄位只吃純文字與簡單斷行，**不要**把下面的 Markdown 語法(`##`、`**`)貼進去，貼「內容」就好;項目符號 `•` 是純文字符號，可以直接用。

### 繁體中文版(主要語言，直接複製貼上)

```
一鍵把 Threads 的分享連結和「複製連結」結果，都變成不帶追蹤參數的乾淨貼文網址;貼文互動列也新增了一鍵複製按鈕。

【三大功能】
• 右鍵還原分享短連結:在 /share/XXXX 這種 Threads 分享短連結上按右鍵，選擇「複製乾淨的 Threads 貼文連結」，一鍵解析並複製到剪貼簿。不限定要在 threads.com 分頁上使用，不管連結出現在哪個網站都能用。

• 自動淨化網頁版「複製連結」:Threads 網頁版官方「複製連結」按鈕寫入剪貼簿的內容，不管是 /share/ 短碼還是帶 ?xmt= 追蹤參數的完整網址，都會被自動處理成乾淨貼文網址，無感完成，不需要額外操作。

• 貼文互動列新增「複製原始連結」按鈕:在 Threads 每篇貼文的互動列(分享按鈕旁)多一顆鏈節圖示，點一下就把該貼文的乾淨網址複製到剪貼簿——不含追蹤參數、也不是短碼。外觀比照原生按鈕(顏色自動跟隨、hover 提示採原生 tooltip)，文字支援中英文並跟隨介面語言設定。

【Popup 設定面板】點擊工具列圖示即可開關兩項設定，即時生效:「自動淨化分享按鈕」(預設開啟)、「成功時顯示通知」(預設關閉，關閉後失敗通知仍會照常顯示)。

【紀錄與設定頁】每次淨化成功可留下一筆紀錄(可搜尋、篩選來源、JSON 匯出/匯入、一鍵清除)，並有累計統計與近 14 天活動圖。紀錄預設僅保存在你的裝置上(chrome.storage.local)，不會上傳(除非另行啟用「雲端同步」並以 Google 帳號登入)，上限 1,000 筆自動汰舊，也可以用「保存淨化紀錄」開關整個停用。介面、通知與右鍵選單支援繁體中文與英文，預設跟隨瀏覽器語言，可手動切換。

【雲端同步(選用)】在「紀錄與設定」頁使用 Google 帳號登入後，清理紀錄可額外同步到雲端、並與手機版 App 互通;不登入則完全不受影響，行為與現在一樣。已登入時，設定頁會從 Google 載入你的帳號大頭照(僅顯示，不儲存於伺服器)。

【誠實隱私聲明(節錄，完整版請見下方 GitHub README)】
兩個功能只要攔到的是 /share/ 短碼，都會向 threads.com / threads.net 發出一次不帶 cookie 的匿名 GET 請求，藉此把短碼換成乾淨網址——這是短碼問題「必須向伺服器問一次」的技術本質決定的，沒有繞過的辦法。這次請求不帶登入憑證，但仍會讓 Threads 看到你的來源 IP 與瀏覽器特徵，在意這點的話，請優先使用右鍵方式手動處理，或搭配 VPN。若攔到的內容已經是完整貼文網址、只帶追蹤參數，則是純文字處理，零網路請求。

未啟用雲端同步時，本擴充功能不蒐集、不儲存、不上傳任何使用者資料；啟用並登入後，只同步你自己的清理紀錄與 Google 帳號的基本身分（email、名稱、大頭照網址）到開發者自營伺服器，詳見 README。無論是否登入，都不讀取剪貼簿裡原本的內容，不含任何遠端程式碼，也不會取得 <all_urls> 這種瀏覽所有網站的權限。

開源(MIT License)，原始碼與完整說明:
https://github.com/hunandy14/threads-clean-link
```

### 英文精簡版(附加語言)

```
Threads Clean Link turns Threads share links and "Copy Link" results into clean, tracker-free post URLs — and now adds a one-click copy button right on each post.

THREE FEATURES
• Right-click resolve: Right-click a Threads share link (/share/XXXX) and choose "Copy clean Threads post link" to resolve it and copy the clean post URL — works on any site's tab, not just threads.com.
• Auto-clean "Copy Link": Threads' official web "Copy Link" button now writes either a /share/ short code or a full URL with tracking parameters. This extension handles both automatically, so what you paste is always clean.
• "Copy original link" button on every post: A link icon is added to each Threads post's action row (next to the share button). One click copies that post's clean URL — no tracking parameters, no short code — to your clipboard. It matches the native buttons in appearance (color follows the page, native hover tooltip), and its label follows your interface language.

POPUP SETTINGS
Click the toolbar icon to toggle two settings that take effect instantly: "Auto-clean the share button" (on by default) and "Notify on success" (off by default; failure notifications always show regardless of this setting).

HISTORY & SETTINGS PAGE
Every successful cleaning can leave a local history entry (searchable, filterable by source, JSON export/import, one-click clear), with totals and a 14-day activity chart. History is stored only on your device (chrome.storage.local) by default and never uploaded unless you separately sign in with Google to enable Cloud Sync on the History & Settings page, capped at 1,000 entries, and can be disabled entirely with the "Keep cleaning history" switch. The UI, notifications and context menu support Traditional Chinese and English — following your browser language by default, switchable manually.

CLOUD SYNC (OPTIONAL)
Sign in with Google on the History & Settings page to additionally sync your cleaning history to the cloud and across your other devices running the companion app; if you don't sign in, nothing changes. Once signed in, the settings page loads your Google account avatar to display it (it is not stored on the server).

HONEST PRIVACY NOTE
Whenever either feature has to resolve a /share/ short code, it sends one anonymous GET request (no cookies) to threads.com/threads.net to look up the real destination — that's the only way to resolve a short code, and it's disclosed in full on the project README. This request carries no login credentials, but Threads will still see your source IP and browser fingerprint; if that matters to you, prefer the manual right-click flow or use a VPN. When the content is already a full post URL with only tracking parameters attached, cleaning is pure local string processing with zero network requests.

Unless Cloud Sync is enabled, this extension collects no user data. Once enabled and signed in, it syncs only your own cleaning history and basic Google account identity (email, name, avatar URL) to the developer's own backend — see the README for details. Either way, it never reads existing clipboard contents, contains no remote code, and never requests <all_urls>.

Open source (MIT). Source & full details:
https://github.com/hunandy14/threads-clean-link
```

---

## 4. 類別與語言建議

| 欄位 | 建議值 | 備註 |
|---|---|---|
| Category(類別) | Workflow & Planning(或當下主控台裡最接近「工具類」的選項，例如 Developer Tools) | Chrome Web Store 類別清單會不定期調整，送出前請以主控台當下的下拉選單為準，找不到 Workflow & Planning 就選語意最接近「生產力工具」的項目 |
| Language(項目語言) | 主要語言:zh-TW(繁體中文) | UI、通知、右鍵選單自 0.3.0 起完整雙語(自帶字典，依瀏覽器語言或使用者選擇切換) |
| 補充語言 | en(建議勾選) | 0.3.0 起英文為完整支援語言(介面/通知/右鍵選單皆有英文字串)，可安心勾選 |

---

## 5. 單一用途聲明(Single purpose statement，審查必填，英文)

```
This extension's single purpose is to convert Threads (threads.com/threads.net) share-link short codes and tracking-parameter post URLs into clean post URLs, either on demand via a right-click menu action or automatically when a Threads web page writes a link to the clipboard.
```

繁中對照(內部核對用，不必填入表單):

```
本擴充功能的單一用途，是把 Threads(threads.com/threads.net)的分享短碼與帶追蹤參數的貼文網址，轉換成乾淨貼文網址——可透過右鍵選單手動觸發，也可以在 Threads 網頁自己把連結寫入剪貼簿時自動觸發。
```

---

## 6. 權限理由逐項(Permission justification，審查表單逐項必填)

表單通常要求英文作答;下面每項先給送審用英文，再附繁中對照方便內部核對意思是否有跑掉。五個 `permissions` 加 host permissions，對應 `manifest.json` 目前的宣告:`contextMenus`、`scripting`、`notifications`、`activeTab`、`storage`、`https://*.threads.com/*`、`https://*.threads.net/*`。

「雲端同步」功能上線後，`manifest.json` 另於 `optional_permissions`／`optional_host_permissions` 宣告三項選用權限:`identity`、`https://api.metalinkclearer.workers.dev/*`、`https://api-staging.metalinkclearer.workers.dev/*`。這三項**安裝當下不會要求**，只在使用者於「紀錄與設定」頁主動點擊「使用 Google 帳號登入」的那一刻才會跳出授權提示;理由見下方對應小節。

### contextMenus

**English:**
```
Used to add a single right-click menu item on Threads share links (matching https://*.threads.com/share/* and https://*.threads.net/share/*), letting the user manually trigger resolving a share short code into a clean post URL.
```

**繁中對照:**
```
用於在 Threads 分享短連結(符合 https://*.threads.com/share/* 與 https://*.threads.net/share/* 的連結)上加入一個右鍵選單項目，讓使用者可以手動觸發把分享短碼還原成乾淨貼文網址。
```

### scripting + activeTab(合併說明，兩者只在同一個使用者手勢下一起使用)

**English:**
```
scripting and activeTab are used together, and only at the exact moment the user clicks the right-click menu item: activeTab grants a one-time, gesture-scoped permission on the current tab; scripting then injects a short function into that tab whose only action is calling navigator.clipboard.writeText() with the already-resolved clean URL. The injected function does not read, parse, or otherwise access any content of the page — it only writes.
```

**繁中對照:**
```
scripting 與 activeTab 是配套使用的，而且只在使用者點擊右鍵選單項目的那個操作手勢當下才會用到:activeTab 讓當下分頁取得一次性、僅限這個手勢的臨時授權;scripting 接著注入一段極短的函式，唯一動作是呼叫 navigator.clipboard.writeText() 寫入已經解析好的乾淨網址。注入的函式不會讀取、解析或以任何方式存取頁面內容——只負責寫入。
```

### notifications

**English:**
```
Used to show a single basic notification after a right-click resolve action completes, confirming success (clean URL copied) or failure (e.g. invalid link, network error), so the user knows the outcome without having to check the clipboard manually.
```

**繁中對照:**
```
用於在右鍵還原動作完成後顯示一則基本通知，告知成功(已複製乾淨網址)或失敗(例如連結無效、網路錯誤)，讓使用者不必手動檢查剪貼簿就知道結果。
```

### storage

**English:**
```
chrome.storage.sync persists the user's preference toggles (auto-clean on/off, success notification on/off, keep-history on/off, interface language and theme) so choices follow the signed-in user across their Chrome devices. chrome.storage.local optionally keeps a device-only history of the clean URLs this extension itself produced (capped at 1,000 entries, oldest pruned), shown on the options page with export/clear controls; it can be disabled with a switch and, unless Cloud Sync is separately enabled via Google sign-in, is never transmitted anywhere. No page content and no pre-existing clipboard content is ever stored.
```

**繁中對照:**
```
chrome.storage.sync 保存使用者的偏好開關(自動淨化、成功通知、保存紀錄、介面語言與主題)，讓選擇跨 Chrome 裝置同步。chrome.storage.local 則(可選地)保存本擴充功能自己產出的乾淨網址紀錄——僅存於這台裝置，上限 1,000 筆自動汰舊，顯示於 options 頁並提供匯出與清除，可用開關整個停用，除非另行以 Google 帳號登入啟用「雲端同步」，否則絕不傳輸到任何地方。不會儲存頁面內容，也不會儲存剪貼簿裡原本的內容。
```

### alarms

**English:**
```
Used to schedule the periodic execution of Cloud Sync (a recurring alarm that wakes the background service worker to push/pull the user's own cleaning-history records) and to schedule retry-with-backoff after a failed sync attempt, since chrome.alarms is the only mechanism available to a Manifest V3 service worker for delayed or periodic work after it has been unloaded. This is a non-intrusive permission — it never triggers any visible alert, popup, or notification on its own. If the user never signs in to Cloud Sync, no alarm of any kind is ever created.
```

**繁中對照:**
```
用於排程雲端同步的週期執行(定期喚醒背景 service worker，推送/拉取使用者自己的清理紀錄)，以及同步失敗後的退避重試排程——因為 Manifest V3 的 service worker 被卸載後，chrome.alarms 是唯一能延遲或週期執行工作的機制。這是非警示型權限，本身不會觸發任何可見的提示、彈窗或通知。使用者若從未登入雲端同步，就不會建立任何 alarm。
```

### Host permissions:`https://*.threads.com/*`、`https://*.threads.net/*`

**English:**
```
Host permissions are limited to these two Threads domains and used for exactly two purposes:
(1) The background service worker sends one anonymous GET request (credentials: 'omit', no cookies) to a Threads share URL to follow its redirect and read the resolved destination — equivalent to Threads recording one anonymous click, with no user identity attached.
(2) A content script is injected only on these two domains to intercept the site's own navigator.clipboard.writeText()/write() calls, so tracking parameters or share short codes can be stripped or resolved before the content reaches the clipboard. The content script does not read pre-existing clipboard contents and does not run on, or send data to, any other website.
```

**繁中對照:**
```
host permissions 限定在這兩個 Threads 網域，只用於兩件事:
①背景 service worker 對 Threads 分享短連結發出一次不帶 cookie 的匿名 GET 請求(credentials: 'omit')，跟隨轉址讀出最終網址——效果等同 Threads 記錄一次匿名點擊，不會關聯到使用者身分。
②content script 只注入這兩個網域的頁面，攔截網站自己呼叫的 navigator.clipboard.writeText()/write()，在追蹤參數或分享短碼進入剪貼簿前先行剪除或解析。這個 content script 不會讀取剪貼簿裡原本的內容，也不會在其他任何網站上執行或傳送資料。
```

### Remote code(遠端程式碼)

**English:**
```
None. This extension does not download, fetch, or execute any remote code. All logic ships inside the packaged extension. Unless Cloud Sync is separately enabled via Google sign-in, the only network requests it makes are the anonymous GET requests to Threads described above, used solely to resolve a share short code into its final URL — the response is read for its resolved URL only and is never executed as code. When Cloud Sync is enabled, the extension additionally exchanges JSON data with its own backend as described in the Host permissions section above; that data is likewise never executed as code.
```

**繁中對照:**
```
無。本擴充功能不下載、抓取或執行任何遠端程式碼，所有邏輯都包在安裝包內。除非另行以 Google 帳號登入啟用「雲端同步」，否則唯一的網路請求就是上面說明的、對 Threads 發出的匿名 GET，目的僅是把分享短碼解析成最終網址——回應內容只拿來讀取解析後的網址，絕不會被當成程式碼執行。啟用雲端同步後，本擴充功能會額外與自己的後端交換 JSON 資料(如上方 Host permissions 小節所述)，該資料同樣絕不會被當成程式碼執行。
```

### identity(選用權限，僅登入當下請求)

**English:**
```
Optional permission, off by default and never requested at install time. It is requested only at the exact moment the user clicks "Sign in with Google" on the History & Settings page, to run the standard Chrome identity / Google OAuth flow. The extension only receives the identity token Google returns and uses it solely to establish a session with the developer's own sync backend — it never has access to the user's Google password, and never touches Gmail, Contacts, or any other Google data. The OAuth scope requested is limited to openid, email and profile. If the user never signs in, this permission is never used and no related network request is ever made.
```

**繁中對照:**
```
選用權限，安裝當下不會要求，只有使用者在「紀錄與設定」頁主動點擊「使用 Google 帳號登入」的那一刻，才會觸發標準的 Chrome identity／Google OAuth 流程。本擴充功能只會取得 Google 回傳的身分權杖，並僅用它向開發者自營的同步後端建立工作階段——不會取得使用者的 Google 密碼，也不會碰 Gmail、聯絡人或其他任何 Google 資料。請求的 OAuth 授權範圍(scope)僅限 openid、email、profile。使用者若從未登入，這項權限就永遠不會被使用，也不會有任何相關網路請求。
```

### Host permissions(選用):`https://api.metalinkclearer.workers.dev/*`、`https://api-staging.metalinkclearer.workers.dev/*`

**English:**
```
Optional host permissions, off by default and never requested at install time — requested together with identity only when the user signs in on the History & Settings page. Used for exactly one purpose: syncing the user's own cleaning-history records (URL before and after cleaning, removed tracking parameters, post author name/handle, post summary text, and cleaning timestamp) with the developer's own backend server, which is shared with the developer's companion mobile app so the same history stays consistent across the user's devices. No browsing history, cookies, Threads credentials, or uncleaned page content is ever sent. All traffic is HTTPS. api-staging.metalinkclearer.workers.dev is the developer's own pre-release testing endpoint for this same sync feature. If the user never signs in, neither domain is ever contacted.
```

**繁中對照:**
```
選用 host permissions，安裝當下不會要求，只有使用者在「紀錄與設定」頁登入時，才會與 identity 一起被請求。用途單一:把使用者自己的清理紀錄(清理前後的網址、被移除的追蹤參數、貼文作者名稱與帳號、貼文摘要、清理時間)同步到開發者自營的後端伺服器，這套伺服器與開發者自製的手機 App 共用，讓同一份紀錄在使用者的裝置間保持一致。不會傳送瀏覽紀錄、cookie、Threads 帳號密碼，或任何未清理的頁面內容。所有傳輸皆為 HTTPS。api-staging.metalinkclearer.workers.dev 是開發者針對同一項同步功能的上線前測試端點。使用者若從未登入，這兩個網域都不會被連線。
```

---

## 7. 資料使用揭露(Privacy practices 表單勾選指引)

Chrome Web Store 開發者主控台的 Privacy practices 分頁通常包含「資料類型」核取清單與三個認證聲明，逐題對照本擴充功能的實際行為填寫如下。

### 資料類型清單

0.6.0 起「雲端同步」隨插件出貨(預設關閉，需使用者主動登入才會啟用)，下表已反映這個現況，而非只反映未登入時的行為。

| 資料類型 | 是否勾選 | 用途說明 |
|---|---|---|
| Personally identifiable information | **勾選** | 使用者主動於「紀錄與設定」頁點擊「使用 Google 帳號登入」後才會取得:Google 帳號 email、名稱與大頭照網址，用途是識別使用者身分、維持雲端同步跨裝置一致(App functionality)。未登入者不涉及。<br>Collected only after the user actively signs in with Google on the History & Settings page — email, name, and avatar URL — used to identify the user and keep cloud sync consistent across devices (App functionality). Not collected if the user never signs in. |
| Health information | 不勾 | 無關 |
| Financial and payment information | 不勾 | 無關 |
| Authentication information | **勾選** | 僅在使用者主動點擊「使用 Google 帳號登入」後才會取得(Google OAuth 身分權杖)，唯一用途是向開發者自營後端建立/維持雲端同步的登入工作階段(App functionality)。不用於廣告或分析，不轉讓、不出售給第三方，不取得或儲存使用者的 Google 密碼。<br>Obtained only after the user actively clicks "Sign in with Google" (a Google OAuth identity token); its sole purpose is establishing/maintaining the cloud-sync login session with the developer's own backend (App functionality). Not used for ads or analytics, not shared or sold to third parties; the user's Google password is never obtained or stored. |
| Personal communications | 不勾 | 不讀取頁面內容、不讀取剪貼簿既有內容 |
| Location | 不勾 | 不存取地理位置 |
| Web history | 不勾 | 不記錄、不上傳瀏覽紀錄;唯一送出的請求對象是使用者主動觸發還原/複製的那一條 Threads 連結本身，且不回傳給開發者，只在本機使用。「淨化紀錄」同理:只記本擴充功能自己產出的乾淨網址，未登入時預設只存 chrome.storage.local、不傳輸給任何一方(含開發者)，依 CWS 定義不構成蒐集;登入後的同步行為改列於本表 User activity 一列 |
| User activity | **勾選** | 僅登入後才會發生:同步使用者自己觸發的清理動作所產生的紀錄(貼文網址、被移除的參數、貼文作者與摘要、清理時間)，唯一用途是讓同一使用者的清理紀錄跨裝置(含手機版 App)保持一致(App functionality)。不用於分析全體使用者行為、不用於廣告、不轉讓、不出售給第三方。<br>Occurs only after sign-in: syncs the cleaning-history records the user's own actions generate (post URL, removed tracking parameters, post author and summary, cleaning timestamp), solely to keep that user's own cleaning history consistent across devices, including the companion mobile app (App functionality). Not used to analyze aggregate user behavior, not used for ads, not shared or sold to third parties. |
| Website content | 不勾 | content script 只「寫入」剪貼簿寫入呼叫的攔截與改寫，不讀取頁面 DOM 內容、不擷取頁面資料 |

**「單一用途」聲明相容性說明**:雲端同步是既有「保存清理紀錄」子功能的延伸——把原本只存在本機的同一份紀錄，改為選用地額外存一份到使用者自己的雲端帳號，讓同一位使用者可以跨裝置(含手機版 App)看到同一份紀錄;沒有新增與「Threads 連結淨化」無關的目的，因此第 5 節的單一用途聲明文字不需要修改。

### 三項認證聲明 —— 全部勾選(皆為真)

- 「I do not sell or transfer user data to third parties, outside of the approved use cases」→ **勾選**(沒有任何資料可賣，也未傳輸給第三方)
- 「I do not use or transfer user data for purposes unrelated to the item's single purpose」→ **勾選**(短碼解析是核心網路請求；雲端同步(選用，登入後)的同步請求服務同一單一用途，見上方「單一用途」聲明相容性說明，沒有為無關用途使用或轉讓資料)
- 「I do not use or transfer user data to determine creditworthiness or for lending purposes」→ **勾選**(完全無關)

### 為什麼「發網路請求」不等於「蒐集資料」

這裡容易被誤解，先講清楚:①右鍵還原與②淨化功能攔到短碼時，都會對 Threads 發出一次匿名 GET——但這是「擴充功能代替使用者向 Threads 詢問一條連結指向哪裡」，資料流向是「使用者瀏覽器 → Threads 伺服器」，不會經過開發者的任何伺服器，開發者端沒有蒐集、沒有留存、也沒有能力事後查詢任何一次請求。因此在 Chrome 的資料揭露定義裡，這兩個匿名 GET 請求本身不構成蒐集使用者資料;上表 Web history 維持不勾是正確的，也與 Personally identifiable information、Authentication information、User activity 三項的勾選互不影響——那三項對應的是使用者主動登入雲端同步後的行為，與這裡未登入即可用的匿名短碼解析請求是兩回事。

---

## 8. 隱私權政策 URL

```
https://github.com/hunandy14/threads-clean-link#運作原理與隱私
```

**驗證結果(已實測，非推測)**:直接 `curl` 抓取 `https://github.com/hunandy14/threads-clean-link/blob/main/README.md` 的渲染後 HTML，確認 GitHub 為〈運作原理與隱私〉這個 `##` 標題產出了:

```html
<a id="user-content-運作原理與隱私" class="anchor"
   aria-label="Permalink: 運作原理與隱私"
   href="#運作原理與隱私">
```

`href` 值與上面這個 anchor URL 的 `#` 後半段完全一致，是 GitHub 標題錨點的標準做法(`href="#slug"` 對應 `id="user-content-slug"`)，點擊會正確捲動到隱私聲明段落。**此連結可直接使用，不需要改用 README 頂部連結。**

若之後 README 標題文字有任何調動，錨點會跟著變，屆時需要重新用同樣方式驗證一次。

---

## 9. 截圖拍攝清單(3 張，1280×800)

Chrome Web Store 建議尺寸 1280×800(或 640×400)，以下皆用前者。**所有截圖一律使用測試帳號、測試貼文與虛構範例網址，不得出現任何真實使用者的帳號名稱、頭像、貼文內容或真實短碼**——這點與這次程式碼/README 消毒的原則一致，截圖是最容易被忽略但最容易外流真實個資的地方，務必比照辦理。

### Shot 1 — `01-context-menu-gmail.png`:在其他網站對 share 連結按右鍵

- 場景:開一個**非 threads.com** 的頁面(範例用 Gmail，也可以用任何聊天室/論壇測試頁)，內文貼一段可點擊的 Threads 分享短連結，連結文字直接用範例假短碼 `https://www.threads.com/share/AbCdEfGhI`(**不要**用任何真實貼文產生的短碼)。
- 瀏覽器視窗裁切或縮放到 1280×800。
- 滑鼠對著該連結按右鍵，截圖時完整保留右鍵選單，「複製乾淨的 Threads 貼文連結」這個選單項目文字要清楚可讀、置中或靠上皆可，重點是可讀性。
- 畫面其餘部分(寄件者、主旨、聊天對象等)一律用測試帳號或占位文字(例如 `test@example.com`、「測試信件主旨」)，不得出現任何真實聯絡人或真實信件內容。

### Shot 2 — `02-success-notification.png`:成功通知 + 貼上乾淨網址

- 承接 Shot 1 的情境，點擊選單項目後立刻截圖，畫面需同時看到:
  - Chrome 系統通知(`chrome.notifications`)顯示「已複製乾淨網址:…」的內容
  - 背景視窗貼上(Ctrl+V)到記事本或網址列的乾淨網址
- 通知與貼上結果裡出現的網址一律使用範例假網址 `https://www.threads.com/@username/post/AbCd123EfGh`，不得貼真實貼文網址。
- 若一張截圖很難同時清楚呈現通知與貼上結果，可以拍兩張再合成一張左右對照圖，但仍算「一張成品」計入 3 張額度。

### Shot 3 — `03-before-after-clean-copy.png`:網頁版複製連結，淨化前後對比

- 用**測試帳號**登入 threads.com 網頁版，開一則**測試貼文**(不得使用任何真實第三方使用者的貼文)。
- 先暫時停用擴充功能，點官方「複製連結」按鈕、貼到記事本，截一張「淨化前」(內容會是短碼或帶 `?xmt=` 的網址);重新啟用擴充功能後再點一次「複製連結」、貼到記事本，截一張「淨化後」(內容是乾淨網址)。
- 把兩張結果左右並排或上下並排，加簡單文字標註「淨化前 / 淨化後」，合成這一張對比圖。
- 畫面中出現的帳號名稱、頭像、貼文內容一律使用測試資料，網址同樣以範例假網址呈現(如需要展示「短碼」樣式，用 `https://www.threads.com/share/AbCdEfGhI`)。

### 共通事項

- 一律存 PNG，檔名照上面建議命名，方便主控台上傳順序對應。
- 截圖前確認書籤列、分頁列、通知歷史等其他區域沒有殘留真實帳號、真實網址或其他敏感資訊。
- 若使用作業系統/瀏覽器语言為非 zh-TW，請切回 zh-TW 再拍，確保選單與通知文字與商店文案語言一致。
