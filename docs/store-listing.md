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

【LINE 群組引導警示】點進貼文詳情頁時，會就地辨識「長篇投資心得＋末篇引導加 LINE」的招攬串文。命中有三條路:(1)貼文裡出現 LINE 加好友／加群組的深連結(line.me、lin.ee、linktr.ee)即成立;(2)出現 LINE 帳號或「加 LINE」這類字句，且同時有群組或加入的行動呼籲(例如拉你進群、加入、私訊我);(3)出現 LINE 帳號並搭配投資話術詞(黑馬股、報明牌、代操等)。命中就在貼文上掛一枚標記，並把該作者記進警示名單，之後在首頁時間軸上再遇到同一位作者也會標記。判定為規則比對，正當的社團或商家招攬也可能被標記，使用者可一鍵解除，解除後不再自動標記。頁面本身沒帶作者識別碼時，會對同一篇貼文發一次不帶登入的請求補查。警示名單可在「紀錄與設定」頁管理(附證據連結)，預設只存在你這台裝置、不會上傳;登入下方的「雲端同步」之後，警示名單會跟著你的帳號一起同步到其他裝置(只同步作者帳號、證據貼文的連結與時間，貼文文字不會上傳)，登出即停止。無論是否登入，都不與其他使用者共享;不想用可以用總開關整個關掉。

【Popup 設定面板】點擊工具列圖示即可開關兩項設定，即時生效:「自動淨化分享按鈕」(預設開啟)、「成功時顯示通知」(預設關閉，關閉後失敗通知仍會照常顯示)。

【紀錄與設定頁】每次淨化成功可留下一筆紀錄(可搜尋、篩選來源、JSON 匯出/匯入、一鍵清除)，並有累計統計與近 14 天活動圖。紀錄預設僅保存在你的裝置上(chrome.storage.local)，不會上傳(除非另行啟用「雲端同步」並以 Google 帳號登入)，上限 1,000 筆自動汰舊，也可以用「保存淨化紀錄」開關整個停用。介面、通知與右鍵選單支援繁體中文與英文，預設跟隨瀏覽器語言，可手動切換。

【雲端同步(選用)】在「紀錄與設定」頁使用 Google 帳號登入後，清理紀錄可額外同步到雲端、並與手機版 App 互通;LINE 群組引導警示的名單同樣會跟著同步(不含貼文文字)。不登入則完全不受影響，行為與現在一樣。已登入時，設定頁會從 Google 載入你的帳號大頭照(僅顯示，不儲存於伺服器)。紀錄的詳細資料會顯示每筆紀錄來自哪台裝置，裝置名稱可自行修改，也可把不再使用的裝置從清單移除。

【誠實隱私聲明(節錄，完整版請見下方 GitHub README)】
兩個功能只要攔到的是 /share/ 短碼，都會向 threads.com / threads.net 發出一次不帶 cookie 的匿名 GET 請求，藉此把短碼換成乾淨網址——這是短碼問題「必須向伺服器問一次」的技術本質決定的，沒有繞過的辦法。這次請求不帶登入憑證，但仍會讓 Threads 看到你的來源 IP 與瀏覽器特徵，在意這點的話，請優先使用右鍵方式手動處理，或搭配 VPN。若攔到的內容已經是完整貼文網址、只帶追蹤參數，則是純文字處理，零網路請求。

未啟用雲端同步時，本擴充功能不蒐集、不儲存、不上傳任何使用者資料；啟用並登入後，只同步你自己的清理紀錄、警示名單（作者帳號與證據貼文的連結、時間，不含貼文文字）與 Google 帳號的基本身分（email、名稱、大頭照網址）到開發者自營伺服器，詳見 README。無論是否登入，都不讀取剪貼簿裡原本的內容，不含任何遠端程式碼，也不會取得 <all_urls> 這種瀏覽所有網站的權限。

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

LINE GROUP FUNNEL FLAGS
When you open a Threads post, the extension checks on-device whether the thread follows the "long investment story, then add me on LINE" solicitation pattern. A post is flagged on any one of three paths: (1) it carries a LINE add-friend or add-group deep link (line.me, lin.ee, linktr.ee); (2) it shows a LINE account or an "add me on LINE" phrase together with a group-or-join call to action (for example "I'll pull you into the group", "join", "DM me"); (3) it shows a LINE account alongside investment pitch wording (hot stock tips, paid stock picks, managed trading and the like). On a match it flags the post and adds that author to your flagged list, so the same author is flagged on your feed too. The check is plain rule matching, so a legitimate club, study group or shop solicitation can be flagged too — one click unflags it, and it is never flagged automatically again. When the page itself does not carry the author's identifier, one logged-out request is sent for that same post to look it up. The flagged list lives in the History & Settings page (with evidence links). By default it stays on this device only and is never uploaded; if you sign in for Cloud Sync (see below), the flagged list syncs to your other devices along with your account — only the author handle and the evidence posts' links and timestamps, never the post text — and signing out stops it. Either way it is never shared with other users; a single switch turns the whole feature off.

POPUP SETTINGS
Click the toolbar icon to toggle two settings that take effect instantly: "Auto-clean the share button" (on by default) and "Notify on success" (off by default; failure notifications always show regardless of this setting).

HISTORY & SETTINGS PAGE
Every successful cleaning can leave a local history entry (searchable, filterable by source, JSON export/import, one-click clear), with totals and a 14-day activity chart. History is stored only on your device (chrome.storage.local) by default and never uploaded unless you separately sign in with Google to enable Cloud Sync on the History & Settings page, capped at 1,000 entries, and can be disabled entirely with the "Keep cleaning history" switch. The UI, notifications and context menu support Traditional Chinese and English — following your browser language by default, switchable manually.

CLOUD SYNC (OPTIONAL)
Sign in with Google on the History & Settings page to additionally sync your cleaning history to the cloud and across your other devices running the companion app; your LINE group funnel flagged list syncs too (never the post text). If you don't sign in, nothing changes. Once signed in, the settings page loads your Google account avatar to display it (it is not stored on the server). Each history entry also shows which device it came from; devices can be renamed or removed from the same page.

HONEST PRIVACY NOTE
Whenever either feature has to resolve a /share/ short code, it sends one anonymous GET request (no cookies) to threads.com/threads.net to look up the real destination — that's the only way to resolve a short code, and it's disclosed in full on the project README. This request carries no login credentials, but Threads will still see your source IP and browser fingerprint; if that matters to you, prefer the manual right-click flow or use a VPN. When the content is already a full post URL with only tracking parameters attached, cleaning is pure local string processing with zero network requests.

Unless Cloud Sync is enabled, this extension collects no user data. Once enabled and signed in, it syncs only your own cleaning history, your flagged list (author handles plus the evidence posts' links and timestamps — never the post text) and basic Google account identity (email, name, avatar URL) to the developer's own backend — see the README for details. Either way, it never reads existing clipboard contents, contains no remote code, and never requests <all_urls>.

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
Host permissions are limited to these two Threads domains and used for exactly three purposes:
(1) The background service worker sends one anonymous GET request (credentials: 'omit', no cookies) to a Threads URL, with no user identity attached. For a share short link it follows the redirect and reads the resolved destination — equivalent to Threads recording one anonymous click. For the LINE group funnel check fallback it requests that post's own permalink and does not follow redirects (redirect: 'error'); it only reads the author identifier out of the response.
(2) A content script is injected only on these two domains to intercept the site's own navigator.clipboard.writeText()/write() calls, so tracking parameters or share short codes can be stripped or resolved before the content reaches the clipboard. The content script does not read pre-existing clipboard contents and does not run on, or send data to, any other website.
(3) The same content script also runs the on-device LINE group funnel check on a post detail page the user opens: it reads that page's own public post text locally to decide whether to show a flag badge. Nothing is transmitted — the result and a 120-character evidence snippet are stored only in chrome.storage.local. When the page itself does not carry the author's numeric id, the background service worker sends one additional anonymous GET (credentials: 'omit', no cookies) to that same post's permalink to read it, at most once per post per 24 hours, subject to a global rate limit, and never when the feature's master switch is off.
```

**繁中對照:**
```
host permissions 限定在這兩個 Threads 網域，只用於三件事:
①背景 service worker 對 Threads 網址發出一次不帶 cookie 的匿名 GET 請求(credentials: 'omit')，不會關聯到使用者身分:分享短連結會跟隨轉址讀出最終網址——效果等同 Threads 記錄一次匿名點擊;LINE 群組引導警示的備援請求則是對該篇貼文的永久連結本身發出，不跟隨轉址(redirect: 'error')，只讀取回應中的作者識別碼。
②content script 只注入這兩個網域的頁面，攔截網站自己呼叫的 navigator.clipboard.writeText()/write()，在追蹤參數或分享短碼進入剪貼簿前先行剪除或解析。這個 content script 不會讀取剪貼簿裡原本的內容，也不會在其他任何網站上執行或傳送資料。
③同一支 content script 也會在使用者開啟的貼文詳情頁上執行本機 LINE 群組引導判定:只在本機讀取該頁自己的公開貼文內文，決定要不要掛上標記。判定結果與一段 120 字的證據片段只寫入 chrome.storage.local，不對外傳輸。當頁面本身沒有帶出作者的數字識別碼時，背景 service worker 會對同一篇貼文的永久連結額外發出一次不帶 cookie 的匿名 GET(credentials: 'omit')來取得該識別碼，同一篇貼文 24 小時內至多一次，並受全域請求限流約束;功能總開關關閉時完全不發。
```

### Remote code(遠端程式碼)

**English:**
```
None. This extension does not download, fetch, or execute any remote code. All logic ships inside the packaged extension. Unless Cloud Sync is separately enabled via Google sign-in, the only network requests it makes are the anonymous GET requests to Threads described above, used either to resolve a share short code into its final URL or (for the on-device LINE group funnel check) to read a post's own author id from its HTML — in both cases the response is parsed as text only and never executed as code. When Cloud Sync is enabled, the extension additionally exchanges JSON data with its own backend as described in the Host permissions section above; that data is likewise never executed as code.
```

**繁中對照:**
```
無。本擴充功能不下載、抓取或執行任何遠端程式碼，所有邏輯都包在安裝包內。除非另行以 Google 帳號登入啟用「雲端同步」，否則唯一的網路請求就是上面說明的、對 Threads 發出的匿名 GET，目的是把分享短碼解析成最終網址，或(在本機 LINE 群組引導判定時)從貼文 HTML 讀出該貼文自己的作者識別碼——兩種情況下回應都只當成文字解析，絕不會被當成程式碼執行。啟用雲端同步後，本擴充功能會額外與自己的後端交換 JSON 資料(如上方 Host permissions 小節所述)，該資料同樣絕不會被當成程式碼執行。
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
Optional host permissions, off by default and never requested at install time — requested together with identity only when the user signs in on the History & Settings page. Used for exactly one purpose: syncing the user's own cleaning-history records (URL before and after cleaning, removed tracking parameters, post author name/handle, post summary text, and cleaning timestamp), plus the user's own flagged list (author numeric identifier, handle and display-name snapshot, evidence post URLs, detection timestamp and post timestamp, detection signal categories such as link/line/group/join/pitch — never the matched wording itself, rules version, and reporting device identifier; never the post text snippet), with the developer's own backend server, which is shared with the developer's companion mobile app so the same history stays consistent across the user's devices. No browsing history or tab list (only the permalinks of flagged posts themselves are uploaded), cookies, Threads credentials, or uncleaned page content is ever sent. All traffic is HTTPS. api-staging.metalinkclearer.workers.dev is the developer's own pre-release testing endpoint for this same sync feature. If the user never signs in, neither domain is ever contacted.
```

**繁中對照:**
```
選用 host permissions，安裝當下不會要求，只有使用者在「紀錄與設定」頁登入時，才會與 identity 一起被請求。用途單一:把使用者自己的清理紀錄(清理前後的網址、被移除的追蹤參數、貼文作者名稱與帳號、貼文摘要、清理時間)，以及警示名單(作者數字識別碼、帳號與顯示名快照、證據貼文網址、掃到時間與貼文時間、判定訊號類別如 link／line／group／join／pitch——不含命中的原文、規則版本、回報裝置識別碼;不含貼文文字片段)同步到開發者自營的後端伺服器，這套伺服器與開發者自製的手機 App 共用，讓同一份紀錄在使用者的裝置間保持一致。不會傳送使用者的瀏覽紀錄或分頁清單(上傳的僅限被標記貼文本身的永久連結)、cookie、Threads 帳號密碼，或任何未清理的頁面內容。所有傳輸皆為 HTTPS。api-staging.metalinkclearer.workers.dev 是開發者針對同一項同步功能的上線前測試端點。使用者若從未登入，這兩個網域都不會被連線。
```

---

## 7. 資料使用揭露(Privacy practices 表單勾選指引)

Chrome Web Store 開發者主控台的 Privacy practices 分頁通常包含「資料類型」核取清單與三個認證聲明，逐題對照本擴充功能的實際行為填寫如下。

> **送審時需以本版 §7 重填隱私分頁**:警示名單改為可隨雲端同步之後，Website content 與 Web history 兩列由「不勾」改為「勾選」。CWS 的隱私分頁只有勾選框、沒有逐項說明欄位，勾選異動不會自動沿用上一版的填答，下一次送審必須依本節逐列重新確認一次(見 `docs/cws-publish-setup.md` 的送審流程)。

### 資料類型清單

0.6.0 起「雲端同步」隨插件出貨(預設關閉，需使用者主動登入才會啟用)，下表已反映這個現況，而非只反映未登入時的行為。警示名單自 `docs/cloud-sync.md` 決策 D35–D40 起也納入同步範圍，同屬「登入後才發生」的那一類。

| 資料類型 | 是否勾選 | 用途說明 |
|---|---|---|
| Personally identifiable information | **勾選** | 使用者主動於「紀錄與設定」頁點擊「使用 Google 帳號登入」後才會取得:Google 帳號 email、名稱與大頭照網址，用途是識別使用者身分、維持雲端同步跨裝置一致(App functionality)。未登入者不涉及。<br>Collected only after the user actively signs in with Google on the History & Settings page — email, name, and avatar URL — used to identify the user and keep cloud sync consistent across devices (App functionality). Not collected if the user never signs in. |
| Health information | 不勾 | 無關 |
| Financial and payment information | 不勾 | 無關 |
| Authentication information | **勾選** | 僅在使用者主動點擊「使用 Google 帳號登入」後才會取得(Google OAuth 身分權杖)，唯一用途是向開發者自營後端建立/維持雲端同步的登入工作階段(App functionality)。不用於廣告或分析，不轉讓、不出售給第三方，不取得或儲存使用者的 Google 密碼。<br>Obtained only after the user actively clicks "Sign in with Google" (a Google OAuth identity token); its sole purpose is establishing/maintaining the cloud-sync login session with the developer's own backend (App functionality). Not used for ads or analytics, not shared or sold to third parties; the user's Google password is never obtained or stored. |
| Personal communications | 不勾 | 不讀取剪貼簿既有內容;LINE 群組引導警示讀取的是使用者自己開啟的**公開貼文內文**，不是收件匣、私訊、電子郵件或任何私人通訊。該內文只在本機判定，命中時留下的 120 字證據片段(`snippet`)與錨點字串(`anchorMatch`)**只寫在這台裝置、一律不上傳**——啟用雲端同步後也不上傳，因此本項維持不勾。<br>No existing clipboard content is read. The LINE group funnel check reads public post content the user opened themselves — not an inbox, DM, email or any private communication. That content is evaluated on-device, and the 120-character evidence snippet it stores never leaves the device, including when Cloud Sync is enabled. |
| Location | 不勾 | 不存取地理位置 |
| Web history | **勾選**(僅在使用者主動登入雲端同步時) | 未登入時不勾的理由不變:不記錄、不上傳瀏覽紀錄;送出的請求對象一律是使用者自己觸發的那一條 Threads 連結本身(還原/複製為手動觸發;LINE 群組引導警示的作者識別碼備援請求由使用者開啟貼文頁自動觸發，對象仍只限使用者當下正在看的那一篇貼文)，且不回傳給開發者，只在本機使用。**使用者主動以 Google 帳號登入雲端同步後**，警示名單會把命中的**證據貼文網址**(`anchorPostUrl`／`threadUrl`，即被標記的那一篇公開貼文的永久連結)上傳到開發者自營後端——這是使用者在 Threads 上造訪過的頁面網址，依 CWS 對 Web history 的定義屬於本類，因此改為勾選。用途只有一個:讓同一位使用者在另一台裝置上點得回證據來源(App functionality)。**不上傳**使用者當時開的那一頁網址(`postUrl`)、也不上傳任何非 Threads 網域的瀏覽紀錄或分頁清單。不登入即不發生;隨時可在「紀錄與設定」頁登出停止，登出後不再上傳。「淨化紀錄」的網址同理:未登入時只存 chrome.storage.local、不傳輸給任何一方，登入後的同步行為另見本表 User activity 一列。<br>Not applicable unless the user signs in. Once the user actively signs in with Google to enable Cloud Sync, the flagged list uploads the permanent links of the flagged public posts (the evidence posts) to the developer's own backend, so the same user can open the evidence from another device (App functionality). The URL of the page the user happened to be viewing is not uploaded, and no browsing history outside Threads is ever collected. Signing out stops it. |
| User activity | **勾選** | 僅登入後才會發生:同步使用者自己觸發的清理動作所產生的紀錄(貼文網址、被移除的參數、貼文作者與摘要、清理時間)，唯一用途是讓同一使用者的清理紀錄跨裝置(含手機版 App)保持一致(App functionality)。登入後另同步一組隨機裝置識別碼與可自訂的裝置名稱，用於標示紀錄來源裝置。不用於分析全體使用者行為、不用於廣告、不轉讓、不出售給第三方。<br>Occurs only after sign-in: syncs the cleaning-history records the user's own actions generate (post URL, removed tracking parameters, post author and summary, cleaning timestamp), solely to keep that user's own cleaning history consistent across devices, including the companion mobile app (App functionality). Signing in also syncs a randomly generated device identifier and a user-editable device name, used to label which device a record came from. Not used to analyze aggregate user behavior, not used for ads, not shared or sold to third parties. |
| Website content | **勾選**(僅在使用者主動登入雲端同步時) | 連結淨化的 content script 只做剪貼簿寫入呼叫的攔截與改寫。LINE 群組引導警示會讀取使用者當下開啟的貼文內文做判定，**判定與片段留存都只發生在這台裝置上**(120 字證據片段寫 `chrome.storage.local`，不上傳)。但**使用者主動登入雲端同步後**，警示名單會把取自 Threads 頁面的**作者帳號與顯示名稱快照**，連同命中的貼文網址一併上傳到開發者自營後端;這些欄位取自網站頁面內容，依 CWS 對 Website content 的定義屬於本類，因此改為勾選。用途只有一個:讓同一位使用者的警示名單在自己的裝置之間保持一致(App functionality)。**不上傳貼文內文**(證據片段與錨點字串一律留在本機)，不上傳頁面截圖、DOM 或任何未經判定的頁面內容;不用於廣告或分析，不轉讓、不出售給第三方。不登入即不發生，登出即停止。<br>Not applicable unless the user signs in. Once the user actively signs in with Google to enable Cloud Sync, the flagged list uploads the author handle and display-name snapshot taken from the Threads page, together with the flagged posts' links, to the developer's own backend, solely to keep that user's own flagged list consistent across their own devices (App functionality). Post text is never uploaded — the evidence snippet stays on the device — and no page screenshots, DOM or other page content is collected. Not used for ads or analytics, not shared or sold to third parties. Signing out stops it. |

**刪除雲端資料**:帳號選單的「刪除雲端資料並登出」會登出所有裝置，本機資料保留，重新登入後會重新上傳(見 `docs/cloud-sync.md` D50)。<br>**Delete cloud data**: "Delete cloud data & sign out" in the account menu signs out every device; data on this and other devices stays, and is re-uploaded after signing in again (see `docs/cloud-sync.md` D50).

**LINE 群組引導警示對本表的影響**:功能剛上線(0.8.0)時名單純屬本機，三列皆維持不勾;名單改為可隨雲端同步之後(見 `docs/cloud-sync.md` 決策 D35–D40)，**Website content 與 Web history 兩列改為勾選**，Personal communications 維持不勾。分界點是「資料有沒有離開這台裝置」:

- **偵測本身仍全在本機**:讀取使用者當下主動開啟的那一頁貼文內文，命中時留下作者資料與一段證據片段，未登入時一律只寫 `chrome.storage.local`(備援請求的節流表寫 `chrome.storage.session`，瀏覽器關閉即清)，不傳輸給任何一方，依 CWS 定義不構成蒐集。
- **登入雲端同步後才會上傳**、且只上傳這些欄位:作者數字 id、帳號與顯示名快照、證據貼文網址、掃到的時間與貼文發布時間、判定訊號類別(link／line／group／join／pitch，不含命中的原文)、規則版本、回報裝置 id。其中帳號與顯示名屬 Website content，證據貼文網址屬 Web history，兩列因此勾選。
- **貼文文字片段(`snippet`)、錨點字串(`anchorMatch`)一律不上傳**，留在本機;`postUrl` 這個**欄位**同樣不上傳，但缺錨點篇的舊證據會以它的**值**充當證據貼文網址一併上傳(見 `docs/cloud-sync.md` D40)，並非整包留在本機。Personal communications 據此維持不勾——上傳的欄位裡沒有任何一項是通訊內容。
- **全程以使用者的主動行為為條件**:不登入就不會發生，登出即停止上傳;總開關關閉時名單既不拉也不推。

少數情況下(貼文頁本身沒帶作者識別碼)，會對**使用者當下正在看的同一篇貼文**發一次匿名請求取得該識別碼:不帶 cookie 與登入憑證、同一篇 24 小時內只發一次、資料不經過也不回傳給開發者，總開關關閉即完全不發。這一項與登入與否無關，也不改變上述任何一列的勾選。

功能本身也屬既有單一用途的延伸——同樣是針對使用者正在看的這一則 Threads 貼文提供保護，沒有引入無關目的;名單改為可同步之後仍然是「同一位使用者的同一份判斷在自己的裝置之間保持一致」，與雲端同步既有的定位相同。

**「單一用途」聲明相容性說明**:雲端同步是既有「保存清理紀錄」子功能的延伸——把原本只存在本機的同一份紀錄，改為選用地額外存一份到使用者自己的雲端帳號，讓同一位使用者可以跨裝置(含手機版 App)看到同一份紀錄;沒有新增與「Threads 連結淨化」無關的目的，因此第 5 節的單一用途聲明文字不需要修改。

### 三項認證聲明 —— 全部勾選(皆為真)

- 「I do not sell or transfer user data to third parties, outside of the approved use cases」→ **勾選**(沒有任何資料可賣，也未傳輸給第三方)
- 「I do not use or transfer user data for purposes unrelated to the item's single purpose」→ **勾選**(短碼解析是核心網路請求；雲端同步(選用，登入後)的同步請求服務同一單一用途，見上方「單一用途」聲明相容性說明，沒有為無關用途使用或轉讓資料)
- 「I do not use or transfer user data to determine creditworthiness or for lending purposes」→ **勾選**(完全無關)

### 為什麼「發網路請求」不等於「蒐集資料」

這裡容易被誤解，先講清楚:①右鍵還原與②淨化功能攔到短碼時，都會對 Threads 發出一次匿名 GET——但這是「擴充功能代替使用者向 Threads 詢問一條連結指向哪裡」，資料流向是「使用者瀏覽器 → Threads 伺服器」，不會經過開發者的任何伺服器，開發者端沒有蒐集、沒有留存、也沒有能力事後查詢任何一次請求。因此在 Chrome 的資料揭露定義裡，這兩個匿名 GET 請求本身不構成蒐集使用者資料;警示名單的作者識別碼備援請求同理。上表 Website content 與 Web history 兩列會勾選，是因為**登入雲端同步後名單確實把作者帳號與證據貼文網址送到開發者的後端**，與這裡的匿名 GET 無關——後者未登入即可用，資料流向是「使用者瀏覽器 → Threads 伺服器」，不經過開發者。Personally identifiable information、Authentication information、User activity 三項同屬前者那一類:對應的都是使用者主動登入之後的行為。

---

## 8. 隱私權政策 URL

```
https://metalinkclearer.com/privacy/#browser-extension
```

備援連結(GitHub README 錨點):

```
https://github.com/hunandy14/threads-clean-link#運作原理與隱私
```

**0.6.0 送審狀態說明**:本擴充功能 0.6.0 版送審時，Chrome Web Store 表單填寫的隱私權政策 URL 暫時仍是上方「備援連結」(README 錨點);待這個版本過審上架後，才切換成官網連結作為正式 URL，屆時 README 錨點改列為備援。

**驗證結果(已實測，非推測)**:對官網連結執行

```
curl -sIL https://metalinkclearer.com/privacy/
```

實際回應依序是:

```
HTTP/1.1 302 Found
Location: https://metalinkclearer.com/zh-tw/privacy/

HTTP/1.1 200 OK
```

確認該連結會先 302 導向繁中版隱私權政策頁，最終回 200，頁面存在且可正常存取。該頁面內有 `id="browser-extension"` 的錨點，對應〈瀏覽器擴充(Threads Clean Link)〉這一節，也就是本擴充功能專屬的隱私權說明段落;URL 中 `#browser-extension` 這段與此錨點 id 完全一致，點擊會正確捲動到該段落。

若之後官網該節的錨點 id 有任何調動，需要重新用同樣方式驗證一次。

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
