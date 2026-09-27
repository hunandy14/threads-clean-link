# 雲端同步設計文件

本文件描述 threads-clean-link 插件對接雲端後端（開發者自營的 API 後端）時，插件端要遵守的設計與契約，範圍限於插件如何登入、如何送收資料、資料如何在本機儲存。

## 1. 目標與現況

讓使用者用 Google 帳號登入後，清理紀錄可在手機與瀏覽器之間雙向同步（本機 → 雲端、雲端 → 本機）。同步預設關閉，未登入時的行為與現況完全一致；登入是使用者的主動選擇。插件透過 `chrome.storage.local.syncApiBase` 在 production、staging、local 三個環境之間切換（見決策 D9），登入所需的 `identity` 權限與後端網域權限皆為 optional，登入當下才請求（見決策 D8）。

## 2. 決策紀錄

| 編號 | 決策 | 理由 | 日期 |
|---|---|---|---|
| D1 | 插件走 `Authorization: Bearer`，所有 fetch `credentials: "omit"`，只從 service worker 發請求 | 避開 cookie／CSRF 風險面，content script 不豁免 CORS，只有 SW 能跨源讀回應 | 2026-09-02 |
| D3 | 首次綁定全量上傳並告知使用者 free 方案雲端保留 1000 筆 | 剛上線不會頂到上限；比擋住首次同步或做複雜篩選成本低 | 2026-09-02 |
| D4 | `kind` 只留本機；上雲時 `share`→`share`，`strip`／`menu`／`icon`→`clipboard` | 雲端 `seen[].source` 白名單固定，改後端代價不成比例 | 2026-09-02 |
| D5 | Google client 依 API 環境對應（後端把 staging 與 production 的 Web client 分家）：production `https://api.metalinkclearer.workers.dev` → `17054024593-p003rp6cqmm9ks4r8mdphal1ahr3rhum.apps.googleusercontent.com`；staging `https://api-staging.metalinkclearer.workers.dev` → `17054024593-846tl3brfgd5f09ouavituflf5b7v6qi.apps.googleusercontent.com`；local `http://localhost:8787` → 同 production。三者皆為公開值，非機密；插件端存於 `sync.js` 的 `CLIENT_ID_BY_API_BASE` 對照表，`signIn` 依 `loadContext()` 解析出的 apiBase 取值，aud 驗證用同一個值。Console 已加 redirect URI `https://hehokicokbgajpanjcajhmflaennnmdj.chromiumapp.org/`（兩個 client 共用同一擴充 ID） | 後端拆分 client 後單一 ID 已無法同時通過兩個環境各自的 `aud` 檢查，插件必須依環境送對應的 client_id | 2026-09-02（2026-09-04 更新：staging 已分家） |
| D6 | 同步預設關閉，使用者主動登入才啟用；未登入行為與現況完全一致 | 「僅保存於這台裝置」的既有承諾在未登入時必須成立，登入是使用者的主動選擇 | 2026-09-02 |
| D7 | 擴充 ID 固定為 `hehokicokbgajpanjcajhmflaennnmdj`，manifest 加 `key`（值存於 `secrets/manifest-key.json`，非機密），dev build 與商店版同 ID | Google redirect URI 以擴充 ID 為準，ID 漂移會讓登入失效 | 2026-09-02 |
| D8 | `identity` 走 `optional_permissions`，後端網域走 `optional_host_permissions`（`https://api.metalinkclearer.workers.dev/*`、`https://api-staging.metalinkclearer.workers.dev/*`），登入當下才請求 | 常駐在 manifest 的必要權限會在更新時觸發 Chrome 自動停用擴充，等到登入才申請可避免 | 2026-09-02 |
| D9 | API base 預設 production，`chrome.storage.local.syncApiBase` 可覆寫為 staging 或 local（`http://localhost:8787`，開發用）；三值以外一律忽略 | 插件沒有 build-time 環境切換機制，用 storage 覆寫最小成本達成 dev/staging/local 測試。local 的 host 權限只宣告在 `tools/dev-browser.mjs` 產出的開發用 manifest 副本，商店版沒有這一項 | 2026-09-02 |
| D10 | bearer token 存 `chrome.storage.local.syncAuth`（需跨瀏覽器重啟保留登入），登出必打 sign-out 撤銷 | `chrome.storage.session` 重啟即清空，不符合「登入態應長期保留」的需求；登出即撤銷可縮短憑證外洩後的影響時間 | 2026-09-02 |
| D11 | post 身分鍵改用手機的 `postKeyOf` 規則（`threads:<code>`／`url:<正規化>`），history 合併鍵切換，並持久化為 `postKey` 欄位 | 插件現有 `extractPostId` 與手機規則在邊界情況（怪 handle、`m.threads.com`、尾斜線）不等價，會在雲端分裂成兩張卡；伺服器本來就自己算 `postKey`，插件對齊本機規則即可 | 2026-09-02 |
| D12 | 同步觸發：`chrome.alarms` 週期不低於 1 分鐘＋新紀錄 2 秒去抖＋options 開啟時一次（2026-09-20 修訂：popup 不再觸發，因同步狀態列已自 popup 移除）＋手動；退避曲線照手機 scheduler（30s→600s）。**2026-09-22 修訂（R3-13）**：警示名單的變更（命中、解除、復原）同樣掛這個 2 秒去抖，與新紀錄共用同一套去抖機制，不另開一條排程 | MV3 沒有「前景常駐計時器」概念，SW 隨時被殺，所有排程狀態必須可從 `chrome.storage` 復原；名單變更同樣是使用者剛做的決定，該跟清理紀錄一樣儘快同步出去，不必等到下一次 alarm | 2026-09-02（2026-09-20 修訂、2026-09-22 修訂） |
| D14 | 帳號入口移到設定頁頁首右上角，移除既有的雲端同步卡片（版型依核准的 demo） | 帳號狀態是使用者最常想確認的資訊，放頁首比埋在頁面中段的卡片更符合預期動線 | 2026-09-04 |
| D15 | 已登入時顯示使用者的名字與 Google 大頭照；缺席時備援 email 前段，再缺則備援首字母；大頭照網址僅接受 `googleusercontent.com`（或其子網域） | 帳號入口要讓使用者一眼確認「這是我的帳號」，備援序列確保任何欄位缺席都有合理顯示；大頭照白名單避免任意網址被當成 `<img src>` 載入 | 2026-09-04 |
| D16 | 帳號選單順序固定為：立即同步 → 管理裝置 → 登出 → 刪除雲端資料（帶二次確認） | 破壞性動作放最後、且需二次確認，降低誤觸機率；裝置管理屬帳號層級、非破壞性，因此置於登出之前 | 2026-09-04（2026-09-07 更新：加入「管理裝置」） |
| D17 | 帳號入口顯示五種狀態：未登入、已登入、同步中、錯誤、登入過期 | 涵蓋使用者會遇到的所有帳號狀態，避免中間狀態（例如 token 失效）顯示成看似正常的「已登入」 | 2026-09-04 |
| D18 | 新增警告色 token `--warn`（淺色 `#d9a441`／深色 `#e6b955`） | 「登入過期」「即將刪除雲端資料」等狀態需要有別於一般錯誤色（紅）與一般資訊色的視覺提示 | 2026-09-04 |
| D19 | ~~舊語意：「刪除雲端資料」後本機紀錄留在這台裝置且不再上傳，靠 `syncClearGuard` 三態守衛辨識這次清空是自己發動還是別台裝置發動的~~（**2026-09-23 修訂，由 D50 取代**：刪雲端＝清伺服器＋本機登出，重新登入即全量重傳重建鏡像，不再需要守衛辨識） | 守衛式清空在「刪雲端 → 登出 → 再登入」下曾把本機紀錄全滅（真機實證），改走登出＋重登全量重傳更簡單可靠 | 2026-09-04（2026-09-23 修訂，由 D50 取代） |
| D20 | 沒有 token 時 `status` 只可能是 `"signed_out"`，任何 `lastError` 都不例外。登入期的失敗分三類：**取消**（關掉授權視窗、同意頁按拒絕、瀏覽器權限對話框按拒絕）靜默不出聲——唯一例外是權限被拒，需一句話說明為什麼什麼都沒發生；**暫時性**（需要重新互動、授權頁載不起來、無痕視窗、斷網、id_token 過期、後端暫時不可用、限流、未歸類的未知失敗）提示「請稍後再試」，不顯示錯誤碼；**設定錯誤**（其餘一律歸此，重試無用）帶出錯誤碼請使用者回報。三類一律**不落地**——不寫 `syncState`（連把 `lastError` 清成 null 都不寫），改在該次廣播掛一次性的 `state.transientError = { code, kind }`，`getState()` 不帶，重整頁面即乾淨。已登入之後的同步錯誤與 `session_expired` 維持原行為（前者 `error` ＋ `lastError`，後者 `signed_out` ＋ `lastError` 的登入過期卡片）。分類的唯一來源是 `auth.js` 每條失敗路徑帶的 `err.code`，對照表為 `sync.js` 的 `SIGN_IN_CANCELLED`／`SIGN_IN_TRANSIENT`（兩份清單互斥，列不到的一律歸設定錯誤） | `lastError` 描述的是「已登入的同步出了事」；登入根本沒成功時寫進去，就成了一個沒有帳號的錯誤狀態——設定頁會畫出空白名字＋紅點＋「同步失敗:」的幽靈帳號卡片，上頭每一顆按鈕都是死的（重試送 `sync.now` 在沒有 token 時直接 return、刪雲端彈假的成功提示），popup 還會對根本沒登入的人顯示「已同步」。失敗又必須說得出所以然：使用者自己按的取消不該跳錯誤，設定錯誤不該叫他一直重試 | 2026-09-06 |
| D21 | deviceId 在第一次需要時才惰性產生，存 `chrome.storage.local.syncDevice`；登出、清除紀錄、刪除雲端資料、登入過期、換帳號與匯入一律不動這個 key（別台裝置的快取 `syncDevices` 反之，登出、刪除雲端資料、登入過期與換帳號登入時即清） | 裝置識別碼是「這台瀏覽器」的身分，不是帳號資料；跟著登出或清除紀錄被重設，同一台裝置就會在雲端清單上不斷分裂成新的一台。惰性產生（而非安裝時產生）才涵蓋得到從舊版升級上來的使用者 | 2026-09-07 |
| D22 | `seen[].deviceId` 為選填欄位，只有新產生的事件會帶，既有事件不回填；本機正規化只認 UUID 形狀（大小寫不敏感）並一律存成小寫，形狀不對只丟掉這個欄位、整筆事件照常保留 | 舊紀錄無從得知當初來自哪台裝置，猜測式回填等於捏造歸屬；統一小寫讓本機值與雲端讀回的值可以直接比對，不必兩邊都做大小寫折疊 | 2026-09-07 |
| D23 | 每一輪同步只在該輪第一個 `POST /api/v1/links/sync` 帶頂層 `device` 區塊，續頁請求不帶 | 這個區塊的用途是讓裝置在同步時順道報到，一輪送一次就足夠；續頁重複附帶只是多餘的請求負載 | 2026-09-07 |
| D24 | `PUT /api/v1/devices/:deviceId` 只在使用者改名時呼叫，絕不當心跳；首次註冊交給同步請求內嵌的 `device` 區塊完成 | 把 PUT 當心跳會憑空多出一條週期性請求，而「這台裝置最近有在同步」這件事本來就能從同步請求本身得知 | 2026-09-07 |
| D25 | 裝置清單只在三個時機取得：使用者開啟帳號選單、開啟裝置對話框，或同步回應帶回本機不認識的 deviceId（最後這項只設一個待刷新旗標，下次開框才強制重取，不當場發請求）。帳號選單開啟時只要有快取就直接用快取（不論新舊），完全沒有快取才取一次；對話框開啟時才依快取新鮮度決定要不要刷新。清單永遠不作為刪除任何本機資料的依據 | 清單是顯示層資料，不是真相來源。一旦讓它決定本機留什麼，一次讀取失敗或清單少了一台，就會連帶抹掉使用者的本機紀錄——而硬刪不可逆。帳號選單只需要顯示台數，拿既有快取就夠，不值得為它多打一次請求 | 2026-09-07 |
| D26 | 本機這台裝置的名稱一律以 `syncDevice.name` 為準，不從裝置清單反查 | 清單可能過期、也可能根本拿不到（離線、未登入）；本機名稱若跟著清單漂移，使用者會看到自己這台裝置忽然改名 | 2026-09-07 |
| D27 | 紀錄卡面不加裝置圖示或標籤；裝置資訊只出現在詳細視窗的「裝置」列與時間軸每一列；「裝置」列取該筆紀錄中最近一筆帶 `deviceId` 的事件，全部缺席就整列不畫，時間軸則逐事件各自顯示，`deviceId` 缺席的事件不畫裝置（也不寫「未知裝置」）；依裝置篩選紀錄延後到日後再評估 | 同類產品的活動紀錄一律把裝置放進展開後的細節，卡面加標籤會讓只有一台裝置的使用者（多數）看到一個零資訊量的重複標籤；歸屬缺席時留白比補一個假的來源誠實 | 2026-09-07 |
| D28 | 預設裝置名為 `Chrome on <OS>`，OS 由 `chrome.runtime.getPlatformInfo()` 映射（win→Windows、mac→macOS、linux→Linux、cros→ChromeOS、android→Android），拿不到或不在對照表時整個退成 `Chrome`（不寫 Unknown）。同名不加序號，也不在註冊前先讀清單消歧義；改以裝置列第二行的「新增於 <日期> · 最後同步 <相對時間>」讓使用者自行分辨。不做首次註冊的一次性改名提示，改名常駐於裝置對話框的行內編輯 | 調查十餘家同類產品：拿不到主機名的瀏覽器端，主流是「<瀏覽器>＋<OS>」的組合式敘述（敘述式或括號式），而且沒有任何一家消費級裝置清單為同名裝置加序號（唯一加序號的 Tailscale 是因為主機名要滿足 DNS 唯一性，與本案情境不同）。序號本身零資訊量，卻要多一次註冊前的清單讀取與隨之而來的競態；使用者實際用來分辨的線索是兩個時間，不是編號 | 2026-09-07 |
| D29 | 裝置「移除」改為軟刪除：移除只在雲端把那一台標記成已移除（帶 `removedAt`），清單仍會把已移除的裝置一起回傳。管理對話框只列出活躍裝置，已移除的不再出現；但紀錄詳細視窗 join 裝置名稱時活躍與已移除都查，已移除者顯示**原本的名稱**並加上淡字「已移除」標記，兩邊都查不到才退成「未知裝置」。被移除的裝置若仍在登入狀態，下一次同步會讓它復活、重新出現在管理清單上，且保留使用者取過的自訂名稱。移除鈕保留，圖示由垃圾桶改為 circle-minus，與紀錄刪除的垃圾桶區隔；確認框補一句「紀錄上的裝置名稱會保留」。已移除的裝置不做自動過期；Gmail 式的「復原」toast 留待軟刪除上線後再評估 | 歷史紀錄的來源不該因為清單整理而變成「未知裝置」——使用者移除的是清單上的一列，不是那台裝置做過的事；真抹除等於讓既有紀錄的歸屬憑空消失，而且不可逆。社群慣例一致指向同一種做法：Slack、Jira 停用成員時保留實體與歷史上的顯示名稱，Apple 的「從帳號移除」也明講不會把該裝置登出、仍在登入的裝置下次連網會再出現。圖示區隔則是避免「移除裝置」被誤讀成與「刪除紀錄」同等的破壞性動作 | 2026-09-09 |
| — | **D30–D40 為「LINE 群組引導警示」的決策。D30–D34 屬純本機的偵測與儲存設計，列於此表只是為了讓決策編號在單一序列上連續；其中 D30 的 2026-09-22 修訂與 D35–D40 則直接關乎雲端同步。** | 決策編號分散在多份文件會讓「下一號是幾號」無從判斷，重號的代價高於主題混列 | 2026-09-19（2026-09-22 修訂） |
| D30 | LINE 群組引導的警示名單（含證據與白名單）只寫 `chrome.storage.local`，備援請求的節流表只寫 `chrome.storage.session`（瀏覽器關閉即清），**皆不上雲**：不進同步佇列、不進 `syncState`、不進匯出／匯入檔，也不做任何跨使用者的共享名單 | 名單是對真人帳號的負面標記，誤判成本高且無從申訴；一旦上雲就等於由開發者代為散布指控，還會牽出審核責任與濫用風險。留在本機則始終是「這台裝置上的使用者自己的判斷」，隨時可整包清掉（2026-09-22 修訂：個人名單改為可隨雲端同步，見 D35–D40；仍不做跨使用者共享名單） | 2026-09-19（2026-09-22 修訂） |
| D31 | 作者數字 id 主路徑取自貼文詳情頁的伺服器預載資料（零請求）；僅在該處缺席時，才對同一篇貼文的永久連結發一次匿名請求（不帶登入憑證）作備援。備援的採信條件為文件身分：回應裡 og:url／al:android:url 的永久連結，經 HTML entity 還原與正規化後必須等於請求的那一篇（帳號不分大小寫），且回應內的作者 id 候選必須全部同值；身分標籤指向另一篇時一律否決，此否決優先於任何其他判準。回應沒有任何可正規化的身分標籤時，才退回舊判準「作者 id 前後各 2000 字內找得到相符的帳號名稱」。非 2xx 回應一律不採信。同一篇貼文 24 小時只發一次、另有每分鐘全域上限，總開關關閉時一律不發。取不到 id 時頁面照樣掛標記，但不寫入名單 | 頁面本來就已經把作者 id 送到瀏覽器，再去問一次是多餘的網路行為。備援不可省是因為缺了 id 就只剩帳號可認，改名即失聯；但備援必須受限——交叉驗證擋的是張冠李戴，節流與開關擋的是被誤用成爬蟲，「沒有 id 就不入名單」擋的是主鍵語意被破壞。改以文件身分當主錨點，是因為登出態的永久連結回應整份不帶帳號名稱欄位，舊判準對真機貼文永遠落空；而「這份 HTML 自稱是哪一篇」比「頁面某處出現過誰的名字」更難偽造。 | 2026-09-19（2026-09-20 修訂） |
| D32 | 使用者在選項頁「解除」某位作者，即把該筆條目標成**解除**狀態，之後再掃到同一位作者**永不自動加回**；反悔可在「已解除」小節按「復原」（v1 是把作者寫進獨立的白名單表；v2 起白名單不再獨立儲存，改由 `state: "dismissed"` 的條目派生出一份唯讀 `allowlist` 視圖供既有讀者相容，儲存本體只有 `state`，見 D36） | 解除是使用者對誤判的明確否決，自動加回等於當場推翻他的判斷，使用者會一路解除到關掉整個功能。白名單（v2 起即 dismissed 狀態）同時是誤報的沉默回報管道——它記下了規則在這台裝置上出過什麼錯 | 2026-09-19（2026-09-22 修訂） |
| D33 | 命中走三條路：（a）LINE 加好友／群組深連結（`line.me` 的 `ti/p`／`ti/g`、`lin.ee`、`linktr.ee`）單獨成立；（b）LINE 提及＋群組詞或加入詞的行動呼籲；（c）錨點＋至少一個強話術詞（既有路徑保留）。話術詞從門檻降為證據，弱詞不構成任何路徑；單字型 LINE 只認主動招攬詞（進群、拉進、拉你進、小群、加我、私訊我），並對「賴」前的信／依／無／仰／倚設負向邊界 | 以行動呼籲詞取代話術詞當門檻：招攬串的共通動作是「把人帶進群組或私訊」而不是話術本身，軟性招攬整串可以一個話術詞都不放，綁話術詞就整類漏抓；反過來日常的 LINE 提及（公司公告改用 LINE 群組發布、商家會員貼文）缺了行動呼籲一律不命中，誤標真人帳號的代價仍高於漏抓。單字型 LINE 另外收緊到主動招攬詞，是因為「群組」「社群」「加入」是名詞，正當貼文本來就會跟 LINE 同框；而「信賴：」這類句子常同時帶投資詞，話術詞的二次確認擋不住，必須從錨點本身排除 | 2026-09-19（2026-09-20 修訂） |
| D34 | `tcl-core.js` 加入 content_scripts 的 ISOLATED 陣列，載入順序為 `i18n.js` → `tcl-core.js` → `post-icon.js` → `scam-guard.js` | 偵測規則、名單正規化與裁切邏輯要由 content script、background、選項頁三邊共用同一份實作；複製一份到 content script 會讓規則隨時間分岔，而偵測與儲存形狀一旦不一致，寫進名單的東西就與頁面上標記的不是同一回事 | 2026-09-19 |
| D35 | 總開關 `scamGuardEnabled` 關閉時，警示名單**不拉也不推**，本機那一份原封保留不動；「警示名單」分頁維持可見、可編輯，頂端加一條狀態列「LINE 群組引導警示已關閉——名單不會同步，也不會在河道掛標記」並附一顆「開啟」鈕；貼文頁不掛 pill、河道不查表。關閉期間在本機解除或復原照常更新 `updatedAt`，重新開啟後依 D37 與雲端做 LWW 合併 | 依 disabled-vs-hidden 原則，暫時關閉的功能該用停用態＋一句說明，而不是把介面整塊藏起來：名單藏起來，使用者會以為資料已被刪掉，也失去把誤判解除掉的機會。狀態列把「為什麼現在什麼都沒發生」擺在他看得到的位置，一顆按鈕就能改回來。書籤與稍後閱讀類產品在同步關閉時同樣保留本機清單的管理能力 | 2026-09-22 |
| D36 | 本機名單升到 v2：`scamBlocklist = { version: 2, entries, handleIndex }`，每筆 entry 帶 `state`（`active`｜`dismissed`）、`dismissedAt?` 與 `updatedAt`；頂層 `allowlist` 不再獨立儲存，改由 `entries` 中 `state === "dismissed"` 的條目派生（正規化時掛唯讀視圖相容既有讀者，落盤只存三把鍵）。已解除的條目**保留證據**，並與 active 條目共用同一個 5,000 筆名額與 2 MB 預算，依 `updatedAt` 淘汰。v1 遷移規則：原 `entries` 一律轉成 `state: "active"`；原 `allowlist` 的每一把鍵轉成 `state: "dismissed"` 的條目（沒有證據，`dismissedAt` 取原本的 `at`）；`updatedAt` 缺席時以 `addedAt`／`at` 補 | 「解除」是使用者對誤判的明確決定，跨裝置必須一致。名單與白名單各存一邊時，同一位作者在雲端是兩筆互不相干的資料，LWW 根本沒有共同的比較對象；狀態併進同一個物件之後，一筆 mark 的最後更新時間就足以決定勝負。證據留著則讓「復原」當下立刻有內容可看，不必等下一次命中才長回來 | 2026-09-22 |
| D37 | 合併以一筆 mark 為單位：純量欄位（`state`／`dismissedAt`／`handle`／`displayName`／`source`）取 `updatedAt` 較新的一邊，兩邊相等時取本機；**`addedAt` 不走 LWW，一律取兩邊較小者**（首見時間只能往前——某台裝置晚一點才第一次掃到同一位作者，不代表他是那時候才被記下的）；`evidence` 不覆寫而是取**聯集**，去重鍵與本機正規化統一為 `anchorPostUrl ‖ postUrl`（錨點貼文優先，缺席才退回 `postUrl`；R3-10），再依 `at` 降冪保留 3 筆；本機有而雲端沒有的欄位（`snippet`／`anchorMatch`／`postUrl`）原封保留 | 兩台裝置各自在不同串命中同一位作者是常態，整筆覆蓋會讓後寫的一邊把另一邊的證據與命中篇數一起抹掉——而命中篇數正是使用者判斷「這個標記可不可信」的依據。純量欄位沒有這個問題：使用者最後一次的決定就是他現在的意思 | 2026-09-22 |
| D38 | 名單走自己的端點 `POST /api/v1/marks/sync`／`GET /api/v1/marks`，請求與回應形狀比照連結同步（`upserts`／`deletes`／`since`／`cursor` → `cursor`／`applied`／`changes`／`evicted`，各欄語意以 §3.1 為準：2026-09-22 R1 修訂後 `cursor` 恆回、`applied` 拆成 `upserts`／`rejectedIds`／`deletedIds`、`changes` 可為 `null`、`evicted` 是筆數而非 key 清單）；登入態、`chrome.alarms` 排程、退避曲線、推送批次上限 50 筆與 cursor 續頁一律沿用連結同步那一套；名單變更（命中、解除、復原）也比照新紀錄掛 2 秒去抖觸發一次同步（D12 2026-09-22 修訂，R3-13）。每輪只推**選批時戳**（`updatedAt` 與本機專有的 `pushAfter` 的較大者，CR-1）晚於上次推送水位線的條目（D56 起改為只推 `dirty` 的條目）；回應的 `evicted` 只代表雲端不再保留那麼多筆，本機**一筆都不動**；首次登入的全量上傳與免費額度提示沿用 D3。免費方案雲端保留 1,000 筆、依 `updatedAt` 由舊到新淘汰且**不寫墓碑**；使用者真正刪除的條目才寫墓碑，保留 90 天 | 名單與連結的生命週期不同（名單會被解除、復原，連結不會），塞進同一個端點會讓兩種資料的合併規則互相牽制。共用排程與退避則是因為同步的節奏由網路與後端決定，與資料種類無關，各排各的只會讓兩套時鐘互相打架。`evicted` 不動本機，是因為雲端額度是雲端的事：使用者沒有刪掉任何東西，本機就不該替他刪 | 2026-09-22（2026-09-22 修訂：官方 code review CR-1／CR-2／CR-3／CR-5／CR-10——被動再掃不推進 `updatedAt` 改走本機專有的 `pushAfter`、回填位置持久化成 `marksBackfillCursor`、批次邊界撞值時水位線只推到「最大值減一」、`deleteCloud` 兩條通道各自結算、回填與增量以後端 R4 的伺服器寫入位置接縫，逐條敘述見 §3.1） |
| D39 | 匯出／匯入檔仍**不含**警示名單，沿用 D30 的既有行為，不因名單可同步而改變 | 匯出檔是使用者會自己傳來傳去的檔案，落地之後就脫離插件的控制；名單是對真人帳號的負面標記，夾帶在一份可轉寄的 JSON 裡，與「這台裝置上的使用者自己的判斷」語意不合。雲端同步則是同一位使用者在自己帳號底下的跨裝置一致，兩者的風險不是同一回事 | 2026-09-22 |
| D40 | 商店隱私揭露照名單上雲的事實重填：登入並啟用雲端同步後，名單會把作者數字 id、帳號與顯示名快照、證據貼文網址、掃到的時間與貼文發布時間、判定訊號類別（`signals`：`link`／`line`／`group`／`join`／`pitch`，不含原文）、規則版本與回報裝置 id 上傳到開發者自營後端；**`postUrl` 欄位不送；缺錨點篇的舊證據以其 `postUrl` 充當 `anchorPostUrl`**（R3 縱深修訂），貼文文字片段（`snippet`／`anchorMatch`）一律不上傳。揭露表的 Website content 與 Web history 兩列改為勾選，並註明僅在使用者主動登入雲端同步時才發生、登出即停止；Personal communications 維持不勾 | 揭露表描述的是資料實際流到哪裡，不是功能的初衷。作者帳號與貼文網址一旦離開這台裝置，在 CWS 的定義下就是 Website content 與 Web history 的傳輸，不勾等於漏報。反過來把貼文文字片段留在本機，是讓「使用者讀到的內容」完全不出裝置——判定要用的識別資訊與人在看的內容，本來就該切在不同邊。`postUrl` 本來就不在上雲的七欄裡（見 §3.1／§4.5 的欄位映射），舊證據只有 `postUrl` 沒有 `anchorPostUrl` 時，映射早已用 `postUrl` 頂位當錨點篇上傳，這裡只是把措辭改得跟映射一致，不是新行為 | 2026-09-22（2026-09-22 R3 縱深修訂；2026-09-23 附註：規則 v4（D42–D46）在 `signals` 補了 `account`／`phrase`／`id`／`id-match` 四個新值，但後端 marks 契約零變動——既有白名單仍是 `link｜line｜group｜join｜pitch`，新值上雲時會被既有白名單剝除，**屬預期**，不是漏同步；日後真要保留才需要後端一併加白名單） |
| D41 | ~~舊語意：「刪除雲端資料」涵蓋警示名單，`sync.deleteCloud` 續打 `DELETE /api/v1/marks`，回應的 `clearedAt` 記進獨立的 `syncMarksClearGuard`，鏡射 links 的三態守衛，下行 `changes.clearedAt` 套四態裁決（`purge`／`skip`／`claim`／`invalid`）~~（**2026-09-23 修訂，由 D50 取代**：改打單一端點 `DELETE /api/v1/cloud-data`，links／marks 一次硬刪，不再區分兩支請求，也不再有守衛與四態裁決） | 同 D19：守衛式清空在登出重登下不可靠；單一端點與登出重傳模型不必分辨誰發動了清空 | 2026-09-22（2026-09-23 修訂，由 D50 取代） |
| — | **D42–D46 為「LINE ID 錨點與跨帳號命中」（規則 v4）的決策**，屬純本機的偵測與儲存設計，列於此表只是為了讓決策編號連續 | 同 D30 附註的理由：決策編號分散在多份文件會讓「下一號是幾號」無從判斷 | 2026-09-23 |
| D42 | 帳號型錨點的繫詞放寬成封閉清單（是｜ID｜帳號｜號｜號ID｜號碼），大小寫不拘、冒號前後容許空白（`\s` 本就認得全形空白 U+3000）；信賴／無賴一類的負向 lookbehind 原封不動 | 實際招攬句常寫「賴是：xxx」「LINE 帳號 : xxx」，只認裸冒號「賴：xxx」會整批漏抓；繫詞維持封閉清單（而非任意字）讓 `LINE Pay ID：abc123` 這類收款 ID 照舊不成立 | 2026-09-23 |
| D43 | `detectScamPitch` 多回一個 `lineId`（未命中也回報），擷取依序試帳號型錨點 → LINE／賴提及後 24 字內（審查修訂後由 80 收緊，自提及結尾起算、以匹配起點設限）的「ID／帳號＋冒號＋帳號段」（該步驟另有負向 lookbehind 黑名單，見下）→ 加好友深連結路徑段；抓到就把 `anchorMatch`／`snippet` 的中心改成 ID 本體 | 對方的 LINE ID 是招攬串裡辨識力最高的字串，比片語更適合當標亮與跨帳號比對的鍵；未命中照樣回報是因為 ID 跨帳號（D46）就是靠這一欄成立。視窗收緊到 24 字（約一句話）是審查發現 80 字會把不相干的 ID 欄位一起收進來 | 2026-09-23（審查修訂） |
| D44 | evidence 新增本機專有欄位 `lineId`（≤20 字小寫）：不上雲（`toScamMark` 不送、`fromScamMark` 不讀），`normalizeScamLineId` 只做寬鬆裁切（不像擷取時的 `normalizeLineIdValue` 還會剝尾、卡 3 字下限），跨裝置合併時保留本機值 | 對方帳號本體與貼文片段同屬「使用者讀到的內容」，不該離開這台裝置；驗證放寬是因為它是加值資訊，一個壞掉的 ID 不該讓整筆證據被拒收 | 2026-09-23 |
| D45 | 加入詞補「暗號」「通關密語」（審查修訂拿掉「密語」，見下）；另加兩條樣式抓「傳「177」給我」「留言【18】」這種把代碼包在引號裡的祈使句，代碼**一律限 2–8 位數字**、「留言」那一條另外強制要有括號，代碼是必要條件，單獨「給我」不算 | 招攬者不寫「加入群組」改叫人帶代碼私訊，好在對話一開始分辨來人是哪一篇來的；軟性招攬串常見這種寫法，只認詞表會整批漏抓。審查修訂：「密語」是「加密語音」的子字串會整批誤判故拿掉；代碼放行英數會把「傳 email 給我」「傳 LINE 給我」當成暗號句、「留言」不強制括號會把「留言 1 抽獎」當成暗號句，故雙雙收緊 | 2026-09-23（審查修訂） |
| D46 | `rebuildScamViews` 派生 `lineIdIndex`（`{ lineId → userId }`，只含 `state === 'active'` 的條目，掛成普通可列舉鍵、與 `allowlist` 同款，不落盤不上雲）；`scam-guard.js` 判定後查索引，索引指到的作者不是本篇作者時算命中（`signals` 補 `id-match`）。審查修訂加了兩側門檻：來源側 `indexScamLineIds` 只收證據 `signals` 含 `join`／`group`／`pitch`／`link` 之一、且 `lineId` 非純數字才進索引；目標側 `hasIdMatchAnchor` 要求本篇 `signals` 含 `account` 或 `link` | 同一個 ID 換一個帳號再招攬一次是同一組人，不必再等行動呼籲或話術詞；索引只含 active 是因為使用者解除過的作者不該再把別人拖下水。兩側門檻是審查發現「同一家店兩位員工各貼一次同一支客服 LINE ID」在無門檻時會互標——「這個人貼過這個帳號」離「這個帳號是一組人的招攬工具」還有一段距離 | 2026-09-23（審查修訂） |
| — | **D50–D53 為「刪除雲端資料改 Chrome 書籤同步模型」（R11）的決策**，取代 D19／D41 的舊語意，列於此表只是為了讓決策編號連續 | 同 D30 附註的理由：決策編號分散在多份文件會讓「下一號是幾號」無從判斷 | 2026-09-23 |
| D50 | 刪除雲端資料改走 Chrome 書籤同步模型：`sync.deleteCloud` 打單一端點 `DELETE /api/v1/cloud-data`（契約 R11），伺服器硬刪該帳號 links／marks／墓碑／devices 並撤銷所有 session；成功（2xx）即本機登出——清 token、`syncState` 整包重設、退避歸零、清別台裝置快取、停掉兩支 alarm、廣播 `signed_out`，以上一次寫入；本機 history 與名單一格不動，下次登入由 `finishSignIn` 統一標髒重傳；本機身分 `syncDevice` 不動。登出寫入失敗時回 `storage_write_failed`、token 保留。失敗（非 2xx／斷網）**不登出**，本機一格不動，只記 `lastError`；`401` 走既有 session 過期出口。登入（含重新登入、換帳號）重建鏡像：`finishSignIn` 每次重設 links／marks 游標＋`marksBackfillCursor`；本機沒有這個帳號的 `syncEpoch` 時把 history 全標髒、名單全部標 `dirty`（D56），全量重傳，有的話交給同步紀元比對（D57，§3.3）；伺服器 upsert 與墓碑冪等，重傳不長出重複資料。全量重傳的分輪節流與單次請求逾時見 §6 | 守衛式清空（D19／D41 舊語意）在「刪雲端 → 登出 → 再登入」下曾把本機紀錄全滅（真機實證）；改成清雲端當下即本機登出、重新登入無條件全量重傳重建鏡像，不必分辨這次清空是誰發動的，也不必再維護清空水位線與四態裁決 | 2026-09-23 |
| D51 | 文案：確認框標題「刪除雲端資料並登出」，說明「將刪除雲端上的紀錄與警示名單，並登出所有裝置。這台裝置與其他裝置上的資料都會保留，重新登入後會重新上傳。」；成功 toast「雲端資料已刪除，已登出」；帳號選單項同標題。英文對照同語意（`i18n.js` `opAccountDeleteCloud`／`opSyncDeleteConfirmDesc`／`opToastCloudDeletedSignedOut`） | 破壞性動作要讓使用者知道具體發生什麼：刪的是雲端而非本機，且會登出所有裝置，避免誤以為連本機資料一併刪除 | 2026-09-23 |
| D52 | 帳號卡在「上次同步」之後、`pendingCount > 0` 時附加「N 筆待上傳」，沿用既有「立即同步」鈕；`pendingCount` 取 history 中 `dirty === true` 的筆數。裝置徽章文案改為「已連線至你的 Google 帳號」（`opDeviceNoteSynced`），不再宣稱逐筆已同步 | 全量重傳期間本機與雲端有落差是常態（尤其大名單首輪），文案不該暗示「隨時逐筆同步」；`N = 0` 即本機與雲端一致，不必顯示 | 2026-09-23 |
| D53 | 選項頁「清除全部」改依登入態分流：已登入時每筆本機紀錄轉成墓碑（`id` 存在者寫 `deletedAt`／`dirty:true`，既有墓碑原樣保留、沒有 `id` 的舊資料直接移除），交由同步引擎以 `deletes[]` 分批送出（每批 ≤50），伺服器 ack 後才真正從本機移除，其他裝置經墓碑各自刪除，送出後立即觸發一次同步；未登入維持硬刪。不再呼叫任何清空端點，`syncState.clearedAt` 一併移除 | 清空水位線與四態裁決只服務「本機整批清空但不刪雲端」這一種特例語意；改走墓碑之後與一般的逐筆軟刪除是同一套機制，不必再維護第二套硬刪端點與拒收規則 | 2026-09-23 |
| D54 | 標髒只在 `finishSignIn`（D57 起另有 `resetForEpoch`，§3.3）；登出與刪雲端不標髒，也不碰名單。登入、session 過期、登出、刪雲端四條路徑收成 `resetAccount` 單表，帳號五鍵（`syncAuth`／`syncState`／`syncBackoff`／`syncVerifiedAt`／`syncDevices`）由同一次 `storage.local.set` 寫入；登入時退避歸零、`syncVerifiedAt` 記為登入當下。刪雲端遠端成功但帳號鍵寫入失敗時另落 `syncRebuildPending`，由下次登入或同步起跑標髒（D58） | 登入本來就會重建鏡像（D50），登出與刪雲端再標一次是重複寫入，而且把「標髒寫入失敗」變成登出的失敗條件；帳號鍵分多次寫會在中途失敗時留下半套狀態，單次 set 在 chrome.storage 是原子的 | 2026-09-27 |
| D55 | `idLabelled` 命中後的排除詞判斷改由 JS 端做:取命中起點前 16 字（`SCAM_ID_LABEL_LOOKBACK`）交 `idLabelExclude` 比對是否吻合，取代原本寫在正則本體的前置負向 lookbehind；規則版本維持 4（不視為新規則，只是既有排除邏輯換一種等價寫法） | 排除詞表越列越長時，正則裡的前置負向 lookbehind 會讓單一樣式本體暴增、難以維護與除錯；改成「逐位置找 `idLabelled` 命中→切前 16 字→另一個正則判斷是否吻合排除詞」拆成兩條各自簡單的正則，語意與原本的負向 lookbehind 等價（每個起點各判一次），只是排除判斷從正則引擎搬到 JS 迴圈 | 2026-09-27 |
| D56 | marks 上行改為每筆 `dirty`（S6）：名單條目新增本機專有欄位 `dirty`／`dirtyAt`，只送 `dirty` 的條目、依 `key` 切批，ack 時 `dirtyAt` 未變才清；`rejectedIds` 同樣清 `dirty`。`syncState` 刪除 `marksPushedAt`、`marksRejected`，條目刪除 `pushAfter`；舊版資料於升級後第一輪換算（§3.2）。對後端的請求形狀不變 | 單一條時戳水位線要表達的全是單筆的事——被動補證據不推進 `updatedAt`（`pushAfter`）、墓碑守衛要讓位（讓位下限、當場落地）、被拒要停送（被拒映射）、批尾撞值（`max-1`）——每一條都是在水位線上打補丁；逐筆記 dirty 之後這些補丁全部不需要，模型與 links 的 `dirty`／ack 版本比對同一套 | 2026-09-27 |
| D57 | 同步紀元（epoch，SW-4a，後端決策 36）：本機記 `syncEpoch = { userId, epoch }`（不進帳號五鍵，跨登出保留、換帳號覆寫）；已知時每個 links／marks POST 在 body 頂層帶 `epoch`，回應頂層 `epoch` 未知就採用、不同就 `resetForEpoch`；`409 epoch_mismatch` 走同一路徑。登入時本機沒有該帳號的 epoch 一律全量標髒（EP-A）；舊後端（回應無 `epoch` 鍵）不寫、不標髒（EP-B）；`GET /api/v1/marks` 不帶 epoch（後端不收、不回，EP-D）；刪雲端不動本機 epoch（EP-E）。細則見 §3.3 | 「登入一律全量重傳」只是因為插件分辨不出雲端有沒有被清過；伺服器每次清空把 epoch +1 之後，同帳號重新登入只在真的清過時才重傳（本機或別台裝置發動的皆同，第一個 POST 就撞 409）。首次（無 epoch）仍全量是為了守住 D25 換帳號全量上傳，升級後多傳一輪伺服器零寫入 | 2026-09-27 |
| D58 | 刪雲端遠端成功（雲端清空、epoch +1）但本機 `resetAccount` 寫入失敗時，以一次獨立的單鍵寫入落下 `syncRebuildPending: true`（這次寫入也失敗只記 warn）；`finishSignIn` 與 `runSync` 起跑看到旗標即視同本機沒有該帳號的 `syncEpoch`：history 全標髒、名單全部標 `dirty`、重設 links／marks 游標，並清掉 `syncEpoch` 與旗標（登入併入帳號鍵那一次 set），第一個 POST 不帶 epoch、採用回應的值，請求數不變 | 寫入失敗時本機若握著舊 epoch，下一次 POST 撞 409 會自行重建；但本機若本來就沒有 epoch（升級後尚未採用），下一輪會直接採用新 epoch，已 ack 過的舊卡與名單永遠不再上雲。旗標讓兩種情形都收斂到「全量重傳」，與 D57 的無 epoch 路徑合流 | 2026-09-28 |
| D59 | 一輪執行權杖：記憶體內的帳號世代 `accountGeneration` 由 `resetAccount` 每次轉場（登入、過期、登出、刪雲端）遞增，`request()` 每開一輪發一枚 `runToken = { gen, seq }` 隨 `ctx.runToken` 走完整條呼叫鏈；每個落地點（`syncState`／`syncAuth`／`syncBackoff`／`syncEpoch` 寫入、history 與名單的 mutate、alarm、廣播、401 轉進過期出口）先以 `isCurrent` 比對，世代不同或已被看門狗取代即靜默放棄（不寫、不排 alarm、不廣播、不退避，照常 resolve）。請求遇到世代已過期的在途一輪時照樣併入，但舊輪收尾即以新世代立刻補開一輪，登入後的首輪因此不會被一起作廢。`runVerify` 只比世代，落地前重讀 `syncState` 只合併身分四欄（`userId`／`email`／`displayName`／`avatarUrl`）。對後端的請求形狀與每輪 POST 上限不變 | 一輪同步可能跨越帳號轉場或被看門狗取代：舊輪遲到的回應曾用上一個帳號的 ack 清掉新帳號剛標的 `dirty`、把游標與 epoch 寫回上一個帳號、以 401 清掉新帳號的 token，或在登出後重建週期 alarm 讓帳號「復活」（PR #74 審查 F1／F2／D1）；`runVerify` 整包寫回啟動當下的 ctx 會讓游標倒退、帶回舊版 marks 欄位（D2）。逐一在落地點比對一枚權杖，比在每條路徑個別判斷「現在還是不是同一個帳號」單純，也涵蓋看門狗的並行兩輪 | 2026-09-28 |

## 3. 插件端契約

以下只寫插件對後端要送什麼、收什麼；後端內部如何防護不在此列。

- **登入**：`POST /api/auth/sign-in/social`，`Content-Type: application/json`，body `{"provider":"google","idToken":{"token":"<google id_token>","nonce":"<可選>"}}`（`nonce` 視 `launchWebAuthFlow` 流程決定是否帶）。id_token 由 `chrome.identity.launchWebAuthFlow` 取得；Console 需加 `https://<ext-id>.chromiumapp.org/` 為 redirect URI。
- **token 取得**：登入回應的 **`set-auth-token`** 回應標頭；任何回應只要帶這個標頭就覆寫本地存值。
- **帶入方式**：`Authorization: Bearer <token>`，套用於 `/api/v1/*` 與 `/api/auth/*`（含 sign-out）。所有 fetch 一律 `credentials: "omit"`，且必須從 service worker 發（content script 會被 CORS 擋）；`manifest.json` 的 `host_permissions` 需含後端網域。
- **登出**：`POST /api/auth/sign-out` 帶 Bearer；成功後立即清本地 token。
- **驗證 session**：`GET /api/auth/get-session` 帶 Bearer 回目前 session，插件啟動時用它驗 token 是否仍有效，不必等到 `/api/v1/*` 打回 401 才發現失效。
- **顯示用個人資料**（D15）：登入回應與 `get-session` 回應的 `user` 物件若帶 `name`／`image`，插件用來更新 `syncState.displayName`／`avatarUrl`；兩者缺席時登入當下改用 id_token payload 的 `name`／`picture` claim 補位。`image` 進本機前先過白名單（只接受 `https://` 且 host 為 `googleusercontent.com` 或其子網域），不合白名單一律存 `null`。
- **同步端點**：`POST /api/v1/links/sync` 必須帶 `Content-Type: application/json`，否則回 415；`seen.source` 只接受既有枚舉值（映射見決策 D4）。
- **刪除雲端資料**（D50，契約 R11）：`DELETE /api/v1/cloud-data` 帶 Bearer，單一端點硬刪該帳號雲端的連結紀錄／警示名單／墓碑／裝置，並撤銷該帳號全部 session（含請求方）；回 `{ ok: true, revokedSessions: number }`。之後用同一枚 token 打任何端點（含再打一次這支）一律 `401`；重新登入換得新 token 再打則正常回 `200`，語意冪等。舊版 `DELETE /api/v1/links`、`DELETE /api/v1/marks` 一律回 `410 { "error": "gone", "replacement": "/api/v1/cloud-data" }`。
- **插件需處理的錯誤碼**：
  - `401 unauthorized`：token 失效，清本地 token、導回未登入態重新登入。刪除雲端資料成功後，同一枚 token 的任何後續請求皆屬此類。
  - `403 forbidden_origin`：沒帶 Bearer 或來源不對，屬程式錯誤，不重試。
  - `415 unsupported_media_type`：request 缺 `Content-Type: application/json`。
  - `429 rate_limited`：回應附 `Retry-After`，插件收到就退避到下一個時間窗，不立即重試。
  - `503 misconfigured`：後端設定問題，插件顯示錯誤狀態，不重試。

### 3.1 警示名單（mark）同步

LINE 群組引導警示的名單自 D35–D40 起隨雲端同步，走與連結同步分開的一組端點：

- **推送**：`POST /api/v1/marks/sync`，`Content-Type: application/json`（缺就回 415），body 的 `upserts`／`deletes` **必帶**（沒有東西要推時送空陣列，不可省略鍵），`since`／`cursor` 選填（首次同步兩者都不帶即為全量）；回應形狀見下。
- **拉取**：`GET /api/v1/marks`，依**伺服器寫入位置**升冪分頁（後端 R4 修訂；此前是 `updatedAt` 升冪），`limit` 預設 50、最多 100（超出即夾到 100）；以 `since`／`cursor` 續頁，回應形狀 `{ items: [Mark], nextCursor, cursor }`（`items` 為固定九欄的 Mark；`nextCursor` 為 `null` 即最後一頁；頂層 `cursor` 是這一頁末端的伺服器位置，見下方「回填與增量的接縫」）。升冪是為了讓中斷後的續傳有意義——位置只會往前推，重跑一次不會漏掉中間那幾筆；改走寫入位置則讓回填與增量落在同一條時間線上。
- **共用的部分**（D38）：Bearer 登入態、`credentials: "omit"`、只從 service worker 發請求、`chrome.alarms` 排程與退避曲線、推送批次上限 50 筆、cursor 續頁，以及第 3 節列出的共用錯誤碼（401／403／415／429／503），全部沿用連結同步那一套。
- **每筆 dirty 與批次**（D56）：名單條目的本機專有欄位 `dirty: true` 代表這一筆有改動還沒上雲，`dirtyAt` 是標髒當下的版本戳。每輪只送 `dirty` 的條目，依 `key` 排序後每 50 筆切一批，切批時記下每筆送出當下的 `dirtyAt`。ack 回來時，`applied.upserts` 與 `applied.rejectedIds` 裡的 key 若本機 `dirtyAt` **仍等於**送出那一版才清 `dirty`——往返期間又改過的保持 `dirty`，下一輪送最新內容；被拒的那一版同樣清掉（原樣重送只會每一輪再撞一次），本機之後真的又動過那一筆、再標髒才會重送。清 `dirty` 與同一頁 `changes` 的合併走**同一次**名單寫入，每批一次。中途某一批失敗時，沒送出的條目仍是 `dirty`，下一輪自然補送，不必另外記錄「送到哪一批」。
- **什麼時候標 dirty**：命中新建條目或補進新證據（重複證據不寫也不標）、解除、復原、墓碑守衛留下的條目（見下）、登入全量重傳（`finishSignIn` 把整份名單標 `dirty`，D50）。已經 `dirty` 的條目再改一次，`dirtyAt` 也換新（至少前進 1），ack 才認得出送出去的不是最新版。
- **被動再掃到已列名的作者不推進 `updatedAt`**（CR-1）：背景掃描又命中一位已經在名單上的作者時，只把那一篇證據併進去並標 `dirty`，`updatedAt` 與 `state` **一格不動**——`updatedAt` 是跨裝置 LWW 的唯一判準，推進它等於讓一次背景掃描勝過別台裝置更早做的解除，使用者按掉的標記會自己長回來；去重之後沒有新證據時連 storage 都不寫、也不觸發同步。`mergeScamEntry` 保留本機的 `dirty`／`dirtyAt`（純量落敗也照留，遠端帶來的一律不採信）。頁面端送來的 `at` 在 `validateScamHit` 就夾成 `min(at, now)`：它是證據排序的依據，一個偽造的未來時戳會永遠霸佔榜首、把真正的新證據擠出上限，也會讓新建條目的 `addedAt`／`updatedAt` 在跨裝置 LWW 裡永遠勝出。
- **下行墓碑（對稱處理，見 D37）**：回應 `changes.deleted` 的每一列 `{ key, deletedAt }` 是雲端（可能是另一台裝置）發動的刪除；插件逐筆比較本機該筆 entry 的 `updatedAt`：**本機 `updatedAt` ≤ `deletedAt`** 才真的把這一筆從 `entries` 刪掉；本機較新（代表使用者在別台裝置刪除之後、又在這台動過同一筆）或 `deletedAt` 讀不出來（形狀不明，一律當成「無限早」）時**保留**本機那一份並標 `dirty`，與這一頁的合併、這一批的清 `dirty` 同一次寫入落地——同一輪後面那批斷線也不會丟。下一輪因此會重新推送這一筆，伺服器收到比 `deletedAt` 新的 `updatedAt` 即撤銷墓碑。
- **回填**：`marksBackfillCursor` 不是 `null`（上一輪停在分頁中段），或 `marksCursor` 為 `null`（尚未回填過，或剛被清空重設）時，這一輪先整份回填：改走 `GET /api/v1/marks`，每頁固定 `limit=100`，以 `nextCursor` 續頁，單輪最多翻 **20 頁**。20 頁翻完仍沒到最後一頁（`nextCursor` 還不是 `null`）時，這一輪**整輪收手**：不推也不拉，`marksCursor` 維持 `null`，下一頁的位置記進 **`syncState.marksBackfillCursor`**，下一輪從那裡接著填——不再從第一頁重來：雲端筆數一旦多過單輪翻得完的量，從頭重來的回填永遠到不了底，marks 通道就卡在回填、一筆都推不出去。回填到底時 `marksBackfillCursor` 清回 `null`。只有整份回填到底的那一輪，才會接著做推拉往返。
- **回填與增量的接縫**（CR-10，後端 R4）：`GET /api/v1/marks` 的排序、`nextCursor` 與頂層 `cursor` 全部走**伺服器蓋章的寫入位置**，與增量同一條時間線；`cursor` 是那一頁末端的位置，最後一頁帶的就是伺服器當下的位置。回填到底時把**最後一頁**的 `cursor` 寫進 `marksCursor`，回填後的第一個 `POST` 因此帶得出 `since`——回填途中寫進雲端的條目位置必然落在時間線末端，不是出現在後面的頁，就是排在最後一頁的 `cursor` 之後，兩段之間沒有縫隙（重疊的部分由 LWW 吸收）。舊後端不回這一欄時 `marksCursor` 維持 `null`，行為與加這一格之前相同：第一個 `POST` 不帶 `since`，游標改由 `POST` 的回應建立，少一欄不是錯誤、不記 `lastError`。
- **逐欄相同的重送即 no-op**（後端 R5）：沒有更多資料時伺服器回的 `cursor` 是 `now-1`，同毫秒併發寫入的列因此會在下一次增量再下來一次。插件合併後逐欄比對（鍵序不計），與本機現存那一份一模一樣時**整段不寫 `scamBlocklist`**——白寫一次除了燒 storage 配額，還會讓所有 `storage.onChanged` 的讀者（選項頁的名單）為一件沒發生的事重畫一次。
- **墓碑（本機發動的刪除）**：使用者真正刪除的條目才進 `deletes`，墓碑保留 90 天。
- **雲端淘汰**：回應的 `evicted` 只是這一輪雲端淘汰的筆數，插件在 `syncState.marksEvicted` 做**累記**（跨輪加總，不是單輪快照）並**夾上限**（防止長期累加把數字撐到失真），沒有發生過淘汰時維持 `null`；選項頁「警示名單」卡頭的提示在這個值 `> 0` 時**常駐顯示**。**歸零的條件是這一輪同時滿足四點**（R3-7）：無例外（整輪 promise 鏈沒有被 reject）、回填到底（`marksCursor` 為 `null` 觸發的整份回填有跑完，沒被 20 頁上限攔下）、這一輪的 `rejectedIds` 全空（沒有任何一筆被拒）、這一輪的 `evicted` 為 `0`——四點缺一都不歸零，因為那些情況下「這輪到底有沒有額度」根本沒問清楚，誤讀成「夠用」只會讓使用者錯過真正還在被淘汰的警訊。刪除雲端資料時 `marksEvicted` 隨 `syncState` 整包重設為 `null`（D50），不是這條歸零規則的一部分，也沒有中途裁決要處理。詳見 `docs/scam-guard.md` 第 5 節。
- **總開關**：`scamGuardEnabled` 關閉時這兩支端點一律不呼叫（D35）。
- **清空**：見 D50——「刪除雲端資料」改打單一端點 `DELETE /api/v1/cloud-data`（§3），marks 與 links 一次硬刪並登出，不再有獨立的 marks 清空端點、清空水位線或守衛；`POST /api/v1/marks/sync` 的增量回應本版仍可能帶 `changes.clearedAt` 鍵，但恆為 `null`，插件不讀取、不套用任何裁決，下一版後端移除此鍵後插件不受影響。使用者真正刪除單一筆 mark 的既有墓碑規則（見上）不變。

**同步回應形狀**（R1 修訂，與連結同步對齊）：

```
{
  cursor: string,            // 不透明字串，恆回：這一輪有沒有增量都會帶。
                             //   插件原封存下來當下一輪的續傳位置，不解析、不比較大小
  applied: {                 // 這一次請求的處理結果，三個陣列都是 key（"threads:<id>"）
    upserts: string[],       //   實際寫入的
    rejectedIds: string[],   //   被拒收的（形狀不合、key 不合法等）
    deletedIds: string[],    //   實際刪除的
  },
  changes: null | {          // null 代表這一輪沒有增量（不是空物件，也不是空陣列）
    marks: Mark[],           //   異動的完整 Mark（見下方固定九欄）
    deleted: [{ key, deletedAt }],   // 墓碑：只有這兩個欄位
    clearedAt: number | null,  // 舊後端清空水位線的殘留鍵。本版恆為 null，插件忽略
                               //   （不套用任何裁決）；下一版後端移除此鍵（D50）
    hasMore: boolean,        //   true 代表還有下一頁，立刻帶新 cursor 再拉一次
  },
  evicted: number,           // 筆數，不是清單：這一輪雲端淘汰了幾筆
}
```

- **`cursor` 恆回**：插件一律把回應的 `cursor` 寫回本機水位線，不論 `changes` 是不是 `null`；游標是不透明字串，插件端不得從裡面推算時間或筆數。
- **空字串游標視同缺席**（後端 R6）：`since` 與 `?cursor=` 改走嚴格驗證，空字串／純空白／負數一律回 `400 bad_since`。插件端把空游標與「沒有游標」當成同一件事：`normalizeSyncState` 讀進來時就把 `cursor`／`marksCursor`／`marksBackfillCursor` 的空字串與純空白抹成 `null`，伺服器回應裡的空游標也不寫回水位線；marks 只在游標為**非空字串**時帶 `since`／`?cursor=`，links 則比照首輪退回 `since: "0"`（`0` 是合法的純數字游標）。寧可下一輪重新回填，也不留下一個每輪原地撞 400 的值。
- **`applied`**：只有出現在 `applied.upserts`／`applied.deletedIds` 的 key 才算推送成功、才可以清掉本機的待推標記；`rejectedIds` 不算成功，也**不無限重送**——那代表兩端版本對不上，重送只會每輪再撞一次。
- **`changes` 與增量分頁**：增量**單頁 200 筆**（`marks` 與 `deleted` 合計），`hasMore` 為 `true` 時用同一輪回應的 `cursor` 續拉，直到 `hasMore` 為 `false`。
- **`evicted`**：是**筆數**而非 key 清單，只說明雲端這一輪淘汰了幾筆（免費方案 1,000 筆依 `updatedAt` 由舊到新淘汰、不寫墓碑），**本機一筆都不動**；插件拿它做提示用，不得據以刪除本機條目。
- **同輪撞 key**：同一次請求裡 `deletes` 與 `upserts` 出現同一把 key 時**刪除勝**——那把 key 直接進 `applied.deletedIds`，`upserts` 那一筆算 `rejectedIds`。刪除是使用者較不可回復的意思表示，兩者同輪抵達時把它擺後面才不會讓一筆背景寫入把明確的刪除蓋掉。

**R2 澄清**（請求驗證與拒收語意）：

- **批次上限**：`upserts` 或 `deletes` 超過 50 筆一律回 `422`，形狀為 `{ "error": "too_many_mark_upserts" | "too_many_mark_deletes", "max": 50 }`。不截斷、不部分處理——截斷會讓插件以為整批都送成功，沒上雲的那幾筆被清掉 `dirty` 就再也補不回來。
- **`signals` 恆為陣列**：伺服器一律回陣列，輸入的 `null` 視同 `[]`；插件端不必分辨「沒有訊號」與「欄位缺席」。
- **`rejectedIds` 的三個來源**：①mark 本身驗證不過（key 是字串但形狀不合、必填欄位缺漏或不合法、枚舉值不對）——唯 `key` **非字串**時無識別可回報，該筆**整筆靜默丟棄、不進任何陣列**（`rejectedIds` 回的是 key，連 key 都不成立就沒有東西可回報，硬塞只會讓插件拿到一個對不上任何本機條目的值；這種 payload 代表客戶端送出前就壞了，該在本機正規化那一關擋下）；②同批被 `deletes` 撞掉（見上）；③**不晚於**墓碑——`updatedAt <= deletedAt` 時**不復活**（相等同樣不復活：同一毫秒的刪除與更新分不出先後，往「不復活」倒才不會讓一筆背景寫入把明確的刪除翻回來），整筆拒收。以上都是整筆進 `rejectedIds`。
- **evidence 的拒收粒度不同**：`evidence` 陣列裡單筆不合法**只剝那一筆**，mark 照常寫入；一個壞掉的 `threadUrl` 不該讓整位作者的標記進不了雲端（與本機正規化「形狀不合只剝該欄」同一個取向）。
- **欄位補值**：`displayName` 缺席一律回 `null`（不以 `handle` 充當）；`dismissedAt` 在 `state === "active"` 時由**伺服器強制寫成 `null`**，不信任客戶端送上來的殘值；`source` 落在枚舉外時退回 `"auto"`，不拒收整筆。
- **`addedAt`**：**必填且須合法**，不合法整筆進 `rejectedIds`（它不是可補值的欄位——猜一個時間等於竄改「這位作者是什麼時候被記下的」）。更新既有列時伺服器一律**保留原本的 `addedAt`、忽略傳入值**：加入時間只在第一次寫入時決定，之後每一輪同步都帶著它上來，讓後到的裝置有機會把它往後改就等於讓最晚同步的那一台改寫歷史。**插件端本機合併時則取兩邊較小者**（`mergeScamEntry`，見 D37）——兩者相容：伺服器留下的那個值就是最早成功上傳的那一個，本機再往小的一邊收斂，兩端都只會讓 `addedAt` 往前、不會往後。
- **`handle`**：**必填且須合法**（`^[A-Za-z0-9._]{1,80}$`），`null`／缺席／形狀不合皆整筆進 `rejectedIds`（R3-11，實測確認）。插件端在推送前先自行擋下同一條規則：`planMarkBatches` 逐條檢查 `entry.handle`，缺席或形狀不合的條目**直接不選入這一輪的推送批**——送上去必然被拒、被拒還會清掉 `dirty`（要等本機再改動那一筆才會再送），不如提前不送，`dirty` 原樣留著等 `handle` 補上；讀回側（`fromScamMark`）`handle` 為 `null` 時**視為缺席**、正常受理（不因此丟棄整筆 mark），本機不落 `handle` 鍵——這是為了相容規則收緊前就已存在、`handle` 本來就是 `null` 的舊 mark。

**Mark 固定九欄**（`key`／`state`／`dismissedAt`／`handle`／`displayName`／`source`／`evidence`／`addedAt`／`updatedAt`）：九個鍵一律出現，**可空的以 `null` 表示，不省略鍵**——唯獨 `handle` 例外，見下（R3-11）。

```
{
  key: "threads:<作者數字 id>",   // 主鍵，與本機 entries 的鍵同源
  state: "active" | "dismissed",  // dismissed 即使用者解除過（取代 v1 的 allowlist）
  dismissedAt: number | null,     // state 為 active 時為 null
  handle: string,                 // 帳號快照（不帶 @），**必填**，須合
                                   //   /^[A-Za-z0-9._]{1,80}$/；`null`／缺席／形狀
                                   //   不合，後端整筆拒收進 rejectedIds（R3-11）
  displayName: string | null,     // 顯示名快照，上限 80 字元；缺席回 null（不以 handle 充當）
  source: "auto" | "manual",
  evidence: Evidence[],           // 上限 3 筆，依 at 降冪；沒有證據時為空陣列
  addedAt: number,
  updatedAt: number,              // LWW 判準（D37）
}
```

**Evidence 固定七欄**（`anchorPostUrl`／`threadUrl`／`signals`／`at`／`postedAt`／`rulesVersion`／`deviceId`）：同樣七個鍵一律出現，**可空的以 `null` 表示，不省略鍵**——本機那一份是「缺席就不寫鍵」（`docs/scam-guard.md` 第 4 節），兩邊在送出與讀回時各做一次轉換。

```
{
  anchorPostUrl: string,          // 含錨點那一篇的永久連結
  threadUrl: string | null,       // 串頭永久連結
  signals: string[],              // link｜line｜group｜join｜pitch；沒有就空陣列
  at: number,                     // 掃到的時間
  postedAt: number | null,        // 貼文發布時間
  rulesVersion: number | null,    // 命中當下的規則版本（`SCAM_RULES.version`，數字）
  deviceId: string | null,        // 回報這筆證據的裝置（UUID 形狀）
}
```

`snippet`、`anchorMatch` 兩個欄位**不在這份契約裡**，插件不送、後端也收不到（D40）。`postUrl` 同樣不是契約裡的鍵——雲端 Evidence 沒有 `postUrl` 這一格——但缺 `anchorPostUrl` 的舊證據會以它的**值**頂位充當 `anchorPostUrl` 送出（見 §4.5 的欄位映射表），並非整包留在本機；差別在「這一欄不送」與「這個值一定不上雲」是兩回事。

### 3.2 舊版升級遷移（D56）

D56 之前，marks 的上行靠 `syncState` 的推送水位線 `marksPushedAt`、被拒映射 `marksRejected` 與條目的本機提示 `pushAfter` 選批。升級後第一輪同步把它們換算成每筆 `dirty`：

- **判準**：`loadContext` 另外保留原始 `syncState`，原始物件**帶 `marksPushedAt` 這個鍵**（值為 `null` 也算——舊版正規化會把每個鍵都寫出來）就是舊版。
- **換算**：`runRound` 開頭、本輪任何請求之前（因此早於任何 epoch 採用，§3.3），不看警示總開關，用一次名單寫入依舊規則標髒：`sel = max(updatedAt, pushAfter)`，`(marksPushedAt === null || sel > marksPushedAt) && marksRejected[key] !== sel` 的條目標 `dirty`（與 0.10.0 的選批一致：被拒的那一版不論水位線是否為 `null` 都跳過）；同一次寫入刪掉所有 `pushAfter`。遷移只標髒不清髒。
- **清除時機**：換算落地後，下一次寫回 `syncState` 就不再帶這兩格（新的正規化不輸出它們）。換算落地之前的寫回（例如換算寫入本身失敗的一輪、`verifySession`）會把兩格原樣帶回去，不會在遷移之前被洗掉。
- **冪等**：換算落地之後、`syncState` 寫回之前被殺，下一輪舊判準再算一次；`pushAfter` 已刪，重算的集合只會更小，已標的不會被洗回乾淨，至多多推一次，伺服器對逐欄相同的資料是零寫入。
- **登出態**：未登入不跑同步，不遷移；`syncState` 在登入時整包重設成新形狀，舊的兩格隨之消失。遷移已在登入前的任一輪落地；本機沒有該帳號 `syncEpoch` 的登入另外全量標髒（D50／D57）。殘留的 `pushAfter` 已無讀者，下一個 minor 由正規化剝除。
- **移除時程**：遷移程式碼（`migrateLegacyMarks`、`loadContext` 的 `legacyMarks`、`saveState` 帶回兩格、`normalizeBlocklistEntry` 保留 `pushAfter`）於下一個 minor 移除。

### 3.3 同步紀元（epoch，D57）

後端（決策 36）為每個帳號記一個 `epoch`：非負整數，只增不減，從未刪過雲端＝0，`DELETE /api/v1/cloud-data` 每次 +1，links 與 marks 共用。`POST /api/v1/links/sync`、`POST /api/v1/marks/sync`、`GET /api/v1/links` 的 200 回應頂層一律帶 `epoch`；請求可選帶（POST 放 body 頂層，GET 放 query），不帶＝不校驗，壞值 `400 bad_epoch`，不符 `409 { error:"epoch_mismatch", epoch }` 且零寫入。

- **本機紀錄**：`storage.local.syncEpoch = { userId, epoch }`（§4.2）。只認 `syncState.userId` 這個帳號的值，其餘一律視為未知；不屬於 `resetAccount` 的帳號五鍵，登出、過期、刪雲端都不清。
- **請求**：本機已知時，每個 links／marks POST 在 body 頂層帶 `epoch`（整數）；未知就不帶（`null` 或缺鍵對後端都是不校驗）。`GET /api/v1/marks` 的回填**不帶 epoch**：該端點不在後端契約的 epoch 端點之列，不收也不回（EP-D）；插件不打 `GET /api/v1/links`。每輪 POST 上限不變。
- **回應**：頂層沒有合法 `epoch`（舊後端）一律不動——不寫 `syncEpoch`、不標髒、不排續跑（EP-B）。本機未知就採用並寫成 `{ userId, epoch }`；已知且相同照常；已知且不同走 `resetForEpoch`。
- **`resetForEpoch(newEpoch)`**（EP-C）：`409 epoch_mismatch` 與「回應 epoch ≠ 本機已知」同一路徑。history 全部標髒（`serverUpdatedAt` 歸 `null`）、名單全部標 `dirty`、`cursor` 設 `'0'`、`marksCursor` 與 `marksBackfillCursor` 歸 `null`、寫回新 epoch，本輪不再發任何請求，以 `continue` 30 秒後續跑。觸發的那一次回應不落地；409 那一批視為未送出（dirty 不清），不計入退避失敗，`lastError` 不記。寫入順序為標髒 → `syncState` → `syncEpoch`，中途被殺時本機仍是舊 epoch，下一輪撞 409 再來一次。
- **登入**（EP-A）：本機沒有這個 `userId` 的 epoch（升級後首次、換帳號、全新安裝、舊後端）→ 一次性全量標髒並重設游標，第一趟不帶 epoch，採用回應的值。有的話不標髒，第一個 POST 就帶本機值；雲端若被清過會撞 409 走 `resetForEpoch`。
- **刪雲端**（EP-E）：成功後本機 `syncEpoch` 不動；下次同帳號登入第一個 POST 帶舊值撞 409，走 `resetForEpoch` 全量重傳。

## 4. 資料模型

### 4.1 history entry 新增欄位

在既有 `chrome.storage.local.history` 每筆 entry 上新增：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string（UUID v4） | 首次遷移時為既有每筆紀錄生成一次，之後新紀錄建立時同步生成 |
| `postKey` | string | 依 D11 的 `postKeyOf` 規則計算（`threads:<code>` 或 `url:<正規化>`），取代現行 `extractPostId` 作為合併鍵 |
| `original` | string | 缺席時以 `url` 補值（上雲前補；伺服器 `original` 為必填，缺席整筆會被靜默丟棄） |
| `receivedAt` | number | 取 `seen` 陣列最早一筆事件的 `at`；`seen` 為空則取 entry 的 `at` |
| `dirty` | boolean | 待上傳標記，ack 後清除 |
| `serverUpdatedAt` | number \| null | 伺服器回傳的最後更新時間，用於合併判準 |
| `deletedAt` | number \| null | 軟刪墓碑；本機標記刪除但尚未被伺服器 ack 前保留，ack 後才真正從 storage 移除 |
| `seen[].deviceId` | string（UUID v4），選填 | 這筆事件發生在哪一台裝置（D22）。缺席時整個欄位不寫入（不寫 `null`），既有事件不回填；值一律存成小寫，形狀不對只丟這個欄位 |

既有欄位不動：`url`、`kind`、`at`、`seen`（僅在事件上新增上表的選填 `deviceId` 子欄位）、`author`、`handle`、`excerpt`、`removedParams`。`kind` 依 D4 只留本機、不上雲。

### 4.2 新 storage key

```
chrome.storage.local.syncState = {
  userId: string | null,
  email: string | null,
  displayName: string | null,  // D15：帳號入口顯示用，去頭尾空白、上限 80 字元
  avatarUrl: string | null,    // D15：僅接受 https 且 host 為 googleusercontent.com（或其子網域）
  cursor: string | null,
  lastSyncedAt: number | null,
  lastError: string | null,
  // D38：警示名單（marks）通道自己的下行狀態，與上面 links 通道的欄位各自獨立，
  // 權威敘述在 §3.1「警示名單（mark）同步」。上行待推記在名單條目的 dirty 上（D56），
  // 沒有推送水位線與被拒映射；也沒有清空水位線——「刪除雲端資料」改走單一端點＋
  // 本機登出（D50），不再需要守衛或裁決。
  marksCursor: string | null,        // 增量游標；回填到底時以最後一頁的 cursor 建立，null 代表尚未回填過
  marksEvicted: number | null,       // 雲端淘汰累計筆數（夾上限，見 §3.1「雲端淘汰」）
  marksBackfillCursor: string | null,  // 回填的續填位置；單輪翻不完時記下停在哪一頁，
                                       //   到底後清回 null（CR-2，見 §3.1「回填」）
}

chrome.storage.local.syncAuth = {
  token: string | null,
}

chrome.storage.local.syncEpoch = {   // D57：本機最後確認的雲端同步紀元（§3.3）
  userId: string,                    // 屬於哪個帳號；與 syncState.userId 不同即視為未知
  epoch: number,                     // 非負整數
}                                    // 不進 resetAccount：登出、過期、刪雲端不清，換帳號採用時整筆覆寫

chrome.storage.local.syncRebuildPending = true | null   // D58：刪雲端遠端成功但本機寫入失敗；
                                     // 下次登入或同步起跑消化後與 syncEpoch 一併清掉

// 舊版兩把自清守衛鍵 syncClearGuard／syncMarksClearGuard（D19／D41 舊語意）已廢除：
// 「刪除雲端資料」改走單一端點＋本機登出（D50），不再需要辨識「這次清空是誰發動
// 的」。兩把鍵的殘留值由 background 於 onInstalled（install 與 update）清一次，
// sync.js 不再讀寫。

chrome.storage.local.syncDevice = {   // D21：這台裝置的身分，惰性產生
  deviceId: string,                  // UUID v4，小寫
  name?: string,                     // 缺席代表沿用預設名（D28）
  platform: "chrome_extension",
  createdAt: number,
}

chrome.storage.local.syncDevices = {  // D25：別台裝置的清單快取，純顯示層
  fetchedAt: number,
  devices: [{
    deviceId, name, platform, createdAt, lastSeenAt,
    removedAt: number | null,        // D29：非 null（毫秒）代表這一台已被移除
  }],
  stale?: boolean,                    // 同步回應帶回快取裡沒有的 deviceId 時立起（D25）；
                                      // 旗標與快取同一個物件，SW 被回收也還在，
                                      // 下一次讀取視同 force 並清掉旗標
}

chrome.storage.local.syncApiBase = string  // 可選，覆寫預設 production base，只接受 staging／local 兩個值（D9）
```

快取存的是端點回傳的整個陣列，**已移除的項目照樣留著**、不在寫入時濾掉：紀錄詳細視窗要靠它把已移除裝置的原名 join 回來（D29）。要「只看活躍裝置」是顯示層的事，由管理對話框自己濾掉 `removedAt` 非 null 的項目。

清除規則：`syncDevices` 在登出、刪除雲端資料、**登入過期（401）與換帳號登入**時清空——它描述的是「這個帳號底下有哪些裝置」，而過期後重新登入的可能是另一個帳號，留著就會在下一位使用者眼前先閃出上一位的裝置名（同一個帳號重新登入不清：那不是換人）；`syncDevice` 在登出、清除紀錄、刪除雲端資料、登入過期、換帳號與匯入時一律保留不動（D21）。

帳號切換時（`syncState.userId` 變更）需清空本機同步鏡像欄位（`postKey`／`dirty`／`serverUpdatedAt`／`deletedAt`），比照手機端 `sync/active-owner.ts` 的處理方式。

### 4.3 欄位映射表（entry → 雲端 `SyncItem`）

| 雲端 `SyncItem` | 插件現況 | 對齊方式 |
|---|---|---|
| `id`（必填） | 無 | 首次同步時為每筆生成 `crypto.randomUUID()` 並寫回 entry；伺服器若回 `canonicalId` 則就地改名 |
| `cleaned`（必填） | `url` | 直接映射（送出前先過 `normalizePostUrl`） |
| `original`（必填） | 選填 `original` | 缺席時以 `url` 填入，否則整筆被伺服器靜默丟棄 |
| `receivedAt`（必填） | `at`（最後更新時間） | 語意不同：改用 `seen[0].at`（最早事件）當 `receivedAt`，`at` 保留為本機顯示用 |
| `seen[].at` / `.source` | `seen[].kind` | `share`→`share`；`strip`／`menu`／`icon`→`clipboard`。原 `kind` 另存本機欄位，不上雲 |
| `seen[].deviceId`（選填） | `seen[].deviceId`（選填） | 直接映射，只送 UUID 形狀的值，缺席時整個欄位不送。讀回時同樣只採 UUID 形狀；`unionSeen` 維持第一參數優先，而雲端事件排在第一參數，因此同一時間點的事件以伺服器記錄的歸屬為準 |
| `author`／`handle`／`excerpt` | 同名 | 直接映射 |
| `removedParams` | `{key,value}[]` | 已一致，零改動 |
| `failReason` | 無 | 不送 |
| — | `kind`（卡片徽章） | 雲端無對應欄位，跨裝置必然遺失（D4 已接受） |

### 4.4 裝置端點

以下只寫插件觀察得到的請求與回應形狀，後端如何存放與維護裝置不在此列。

- **取清單**：`GET /api/v1/devices` → `{ "devices": [{ "deviceId", "name", "platform", "createdAt", "lastSeenAt", "removedAt" }] }`，不分頁。`removedAt` 是毫秒時間戳或 `null`，`null` 即活躍；活躍與已移除的裝置**混在同一個陣列**裡回傳（依 `lastSeenAt` 由新到舊），要分流由客戶端自己做（D29）。呼叫時機受 D25 限制。
- **改名**：`PUT /api/v1/devices/:deviceId`，需 `Content-Type: application/json`，body `{ "name": string, "platform"?: string }`（`platform` 在建立時必填、單純改名時可省略）→ `{ "device": { ...同上各欄 } }`。依 D24 只在使用者改名時呼叫。指到的若是一台已被移除的裝置，這次呼叫會讓它復活（`removedAt` 清回 `null`）並照常套用 PUT 的語意，帶了 `name` 就同時改名（D29）。
- **移除**：`DELETE /api/v1/devices/:deviceId` → `{ "ok": true }`。語意是**標記移除**而不是抹除：那一台被標上 `removedAt`，之後仍會出現在 GET 清單裡（D29）。冪等：裝置不存在也算成功（不會因此憑空建出一台），已經移除過的再刪一次同樣成功、且保留最初那個 `removedAt` 不被覆寫；插件把 2xx 與 404 一律當成功。移除不會動到已上傳事件上的 `seen[].deviceId`，也不會把那台裝置登出。
- **同步時順道報到**：`POST /api/v1/links/sync` 的 body 頂層可帶 `device` 區塊 `{ "deviceId", "name", "platform" }`（依 D23 只掛每輪第一個請求）。若 `deviceId` 指到一台已被移除的裝置，這個區塊會讓它復活（`removedAt` 清回 `null`）並**保留原本的自訂名稱**（D29）。整個區塊若無效會被伺服器**靜默忽略**，連結同步照常完成、不會回錯；同步回應**不帶** `devices`，要清單一律另打 GET。
- **`platform` 枚舉**：`android`／`ios`／`chrome_extension`，插件固定送 `chrome_extension`。
- **`name` 規則**：去掉控制字元、去頭尾空白後長度 1–80 code point（emoji 算 1），超出截斷；正規化後為空即視為無效。
- **裝置端點專屬錯誤碼**（HTTP 422，回應形狀 `{ "error": "<code>" }`）：
  - `bad_device_id`：路徑上的 deviceId 不是 UUID 形狀。驗證先於冪等，所以爛 id 的 DELETE 也回 422，不會被當成「不存在」吞掉。
  - `bad_device_platform`：`platform` 缺席（建立時）或不在枚舉內。
  - `bad_device_name`：`name` 正規化後為空。
  - 第 3 節的共用錯誤碼（401／403／415／429／503）同樣適用於這三個端點。
- `seen[].deviceId` 上雲時同樣必須是 UUID 形狀，否則該事件被當成沒有裝置歸屬收下（整筆事件不會因此被拒）。

### 4.5 警示名單（mark）資料模型

本機形狀升到 v2（D36），欄位與上限的權威敘述在 `docs/scam-guard.md` 第 4 節，這裡只寫與雲端有關的部分：

```
chrome.storage.local.scamBlocklist = {
  version: 2,
  entries: {
    [userId]: {                 // userId 為作者數字 id（純數字字串，1–20 位）
      state: "active" | "dismissed",
      dismissedAt?: number,     // state 為 active 時不寫這個鍵
      handle, displayName, source, addedAt,
      updatedAt: number,        // 任何欄位變動都更新，LWW 判準
      dirty?: true,             // D56：本機專有的待推旗標，有改動還沒上雲時才落鍵，**永不上雲**
      dirtyAt?: number,         // 標髒當下的版本戳；ack 回來時仍是送出那一版才清 dirty
      evidence: [{ postUrl, snippet, at, anchorPostUrl?, threadUrl?, anchorMatch?, signals?, postedAt?, rulesVersion?, deviceId?, lineId? }],
    },
  },
  handleIndex: {},              // handle 小寫 → userId，一律由 entries 重建，不上雲；
                                //   只收 state === 'active' 的條目，dismissed 不進索引
}
```

v1 的頂層 `allowlist` 在 v2 不再是儲存狀態，改由 `state === "dismissed"` 的條目派生（`normalizeScamBlocklist` 會掛一份同名的唯讀視圖供既有讀者相容，落盤前拿掉，見 `docs/scam-guard.md` 第 4 節）；遷移規則見 D36。`handleIndex` 是本機派生的反查表，只由 `state === "active"` 的條目重建，與 `version` 一樣不進同步。

本機與雲端的差異在於三個永不離開本機的證據欄位：`snippet`（120 字證據片段）、`anchorMatch`（錨點本體，40 字）與 `lineId`（對方的 LINE 帳號本體，v4／D44），這三項留在本機，永不上傳（D40／D44）。`postUrl` 這個**欄位**同樣不送——雲端 Evidence 沒有 `postUrl` 這一鍵——但它的**值**在缺 `anchorPostUrl` 的舊證據上仍會頂位充當 `anchorPostUrl` 送出（見下方欄位映射表），並非整包留在本機。`signals`（判定訊號類別）、`rulesVersion` 與 `deviceId` 三欄本機與雲端都有且會上傳，本機原有的舊證據可能缺席；`signals` 本機是九類值（見 `docs/scam-guard.md` 2.6），後端白名單仍是五類，新值上雲時被剝除屬預期（D40 附註）。條目層另有兩個永不上雲的欄位 `dirty`／`dirtyAt`（D56）：本機有改動還沒推上去的條目帶 `dirty: true`，`dirtyAt` 是標髒當下的版本戳，`toScamMark` 不送、`fromScamMark` 不讀回，九欄契約一欄不多。舊版的 `pushAfter` 只剩升級遷移會讀（§3.2）。

兩邊對「沒有值」的表示法不同，映射時必須各做一次轉換：**本機缺席就不寫鍵**（`docs/scam-guard.md` 第 4 節的正規化規則），**雲端 Mark 固定九欄、Evidence 固定七欄，缺值一律寫 `null`**（§3.1 R1）。送出時把缺席的鍵補成 `null`，讀回時把 `null` 的鍵整個拿掉，不要在本機留下一排 `null`——選項頁靠「鍵在不在」決定要不要畫那一行。

**欄位映射表（本機 entry ↔ 雲端 Mark）**

| 雲端 Mark（固定九欄） | 本機 | 對齊方式 |
|---|---|---|
| `key` | `entries` 的鍵 | 送出時前綴：`threads:` ＋ userId；讀回時剝掉前綴，前綴不符的整筆丟棄 |
| `state` | `state` | 直接映射；v1 遷上來的條目依 D36 決定初值 |
| `dismissedAt` | `dismissedAt`（`state` 為 `active` 時本機不寫這個鍵；`state` 為 `dismissed` 時一定有值——缺席正規化時補 0，見 `docs/scam-guard.md` 第 4 節） | `state` 為 `active` 時送 `null`；`dismissed` 時本機一定有值，直接送出。讀回 `null` 時不寫這個鍵，讀回有值時依上述規則寫入 |
| `handle` | 同名（缺席即不寫鍵） | **必填，須合 `^[A-Za-z0-9._]{1,80}$`**；後端對 `null`／形狀不合整筆拒收（R3-11）。插件推送側先自行擋下：`entry.handle` 缺席或形狀不合的條目**不選入推送批**（不消耗 `rejectedIds`，等本機那筆補上合法 `handle` 才會被重新選中）。讀回側 `null` 視為缺席、不落鍵（相容於這條規則收緊前就已存在的舊 mark） |
| `displayName` | 同名 | 直接映射，可空；送出前裁到 80 字元 |
| `source` | 同名 | 直接映射 |
| `addedAt` | 同名 | 送出照送；讀回合併時**取兩邊較小者**（D37），不走 LWW。伺服器更新既有列時保留它原本的值、忽略傳入值（§3.1），兩端規則不同但方向一致：`addedAt` 只會往前 |
| `evidence` | `evidence` | 陣列本身必回，沒有證據時為空陣列（不是 `null`）；上限 3 筆、依 `at` 降冪 |
| `updatedAt` | `updatedAt` | 直接映射，LWW 判準（推不推送看本機的 `dirty`，與它無關，D56） |

| 雲端 Evidence（固定七欄） | 本機 | 對齊方式 |
|---|---|---|
| `anchorPostUrl` | `anchorPostUrl ‖ postUrl` | 本機缺 `anchorPostUrl` 時以 `postUrl` 補位（去重鍵本來就是這個組合）；這一欄不可為 `null`，兩者都缺的證據不送 |
| `threadUrl`／`postedAt`／`rulesVersion`／`deviceId` | 同名（缺席即不寫鍵） | 缺席時送 `null`；讀回 `null` 時不寫這個鍵 |
| `signals` | `signals`（缺席即不寫鍵） | 陣列必回，沒有訊號時送空陣列；讀回空陣列時本機不寫這個鍵（留空陣列會讓證據卡畫出一排沒有 chip 的空白） |
| `at` | `at` | 直接映射，不可為 `null` |
| — | `snippet`／`anchorMatch`／`postUrl`／`lineId` | **不送**：貼文文字片段、使用者當時開的頁面網址與對方的 LINE 帳號本體一律留在本機（D40／D44）。讀回的證據因此沒有片段本文，選項頁該筆不畫本文、也沒有高亮；`lineIdIndex` 這張跨裝置反查表也就只由本機自己的證據派生，不含其他裝置同步回來的 ID |
| — | `handleIndex`／`version`／`lineIdIndex` | 本機派生，不送 |

## 5. 模組介面

新模組檔名 `sync.js`（SW 內 `importScripts`，與 `tcl-core.js` 同風格 IIFE，掛 `TCLSync`）。此模組是同步引擎與 UI 之間唯一的協議邊界，打包白名單（`tools/build-release.ps1` 的檔案陣列）需加入此檔。

### 5.1 runtime message（options → background）

| type | 用途 |
|---|---|
| `{type:"sync.getState"}` | 取目前同步狀態，回傳見 5.2 |
| `{type:"sync.signIn"}` | 觸發 `launchWebAuthFlow` 登入流程 |
| `{type:"sync.signOut"}` | 登出（呼叫 sign-out 並清本地 token） |
| `{type:"sync.now"}` | 手動觸發一次同步 |
| `{type:"sync.deleteCloud"}` | 刪除雲端資料（`DELETE /api/v1/cloud-data`，見 §3／D50；成功即本機登出，流程見 §5.4） |
| `{type:"sync.devices.list", force?:boolean}` | 取裝置清單（含快取與節流） |
| `{type:"sync.devices.rename", deviceId, name}` | 改某一台裝置的名稱 |
| `{type:"sync.devices.remove", deviceId}` | 把某一台裝置從清單移除 |

裝置三則訊息與其他 `sync.*` 一樣走 `isExtensionPageSender` 檢查，回應一律是 `{ ok: true, ... }` 或 `{ ok: false, code }`：

- `sync.devices.list` → `{ ok:true, devices:[{deviceId,name,platform,createdAt,lastSeenAt,removedAt}], currentDeviceId, defaultName, fetchedAt }`。`devices` 原封轉出端點的回應，**含已移除的項目**（`removedAt` 非 null），要列出哪些由 UI 自己決定（D29）。`defaultName` 是本機這台的預設名（D28），UI 在使用者把名稱清空時用它回退；別台裝置清空則回退成原本的名字。未帶 `force` 且快取仍新鮮時直接回快取；帳號選單只為了顯示台數而呼叫時，有快取就用快取、完全沒有快取才取一次；同步回應帶回本機不認識的 deviceId 時，下一次開框視同 `force`（D25）。失敗回 `signed_out`（未登入時零請求直接回），其餘一律沿用第 3 節的共用錯誤碼（`network_error`／`rate_limited`／`session_expired`／`misconfigured` 等），不另造裝置專屬碼；任何失敗都**不清掉既有快取**（`session_expired` 例外：那不是這一支端點失敗而是整枚 token 死了，轉進統一的過期處理，快取依 4.2 的清除規則一併清掉）。
- `sync.devices.rename` → `{ ok:true, device }`。handler 自驗參數：`deviceId` 需為 UUID 形狀、`name` 去頭尾空白後 1–80 code point，空值回 `bad_device_name`（UI 會先把空值回退成預設名再送）。改的若是本機這台，成功後同時寫回 `syncDevice.name`（D26）。
- `sync.devices.remove` → `{ ok:true }`。`deviceId` 等於本機這台時直接回 `{ ok:false, code:"current_device" }`，不發請求；伺服器回 2xx 或 404 皆視為成功。成功之後，快取裡的那一台是被**標上 `removedAt`**，而不是從 `syncDevices.devices` 拿掉——紀錄詳細視窗還要靠它顯示原本的名稱（D29）。
- 未登入或離線時：`list` 回 `{ ok:false, code }` 但保留既有快取；`rename`／`remove` 不做事並提示使用者，沒有離線佇列。

### 5.2 state 形狀

```
{
  status: "signed_out" | "signed_in" | "syncing" | "error",
  email: string | null,
  displayName: string | null,  // D15
  avatarUrl: string | null,    // D15
  lastSyncedAt: number | null,
  pendingCount: number,
  lastError: string | null,
  apiBase: string,
  // D38：marks 通道的三格原樣帶出（與 syncState 同形狀，見 §4.2）。
  // marksEvicted 是 UI 出「雲端額度滿了」提示的唯一來源；其餘兩格是診斷用的
  // 游標，UI 不直接顯示（state 是唯一的對外形狀，少 marksBackfillCursor 就沒有任何管道
  // 看得出這個帳號卡在回填第幾頁）。上行待推記在名單條目的 dirty 上，不在這裡（D56）
  marksCursor: string | null,
  marksEvicted: number | null,
  marksBackfillCursor: string | null,
}
```

`lastError` 只在有 token 時足以把 `status` 推成 `"error"`（D20）。

另有 `transientError: { code, kind }`（`kind` 為 `"cancelled"`｜`"transient"`｜`"config"`）——**僅廣播欄位**：只掛在登入失敗那一次的 `sync.stateChanged` 上，不落 `chrome.storage`，`sync.getState` 的回應也不帶（D20）。

state 不新增裝置相關欄位：裝置台數與清單一律由 `sync.devices.list` 供給，UI 自行決定何時取用。

### 5.3 廣播

background 在 state 變化時廣播 `{type:"sync.stateChanged", state}`，options 頁監聽此訊息即時更新 UI，不需輪詢 `sync.getState`。

popup 不顯示同步狀態（健康或錯誤狀態都不顯示），狀態只在設定頁帳號區；popup 因此不監聽此廣播，也不呼叫 `sync.getState`。

### 5.4 刪除雲端資料與清除全部（D50／D53）

- **`sync.deleteCloud`**：background 收到後先打 `DELETE /api/v1/cloud-data`；成功才本機登出（一次寫入）：清 `syncAuth.token`、`syncState` 整包重設、退避歸零、清 `syncDevices`、停用兩支 alarm，然後廣播 `signed_out`。登出寫入失敗時回 `storage_write_failed`、token 保留，並另以單鍵寫入 `syncRebuildPending: true`：下次登入或同步起跑視同本機沒有該帳號的 epoch，全量標髒重傳（D58）。失敗（非 2xx／斷網）**不登出**，本機一格不動，只記 `lastError`；`401`（`session_expired`）走既有登入過期出口。
- **登入＝重建鏡像**：`finishSignIn` 每次成功登入都重設 links／marks 游標、淘汰計數與 `marksBackfillCursor`；本機沒有這個帳號的 `syncEpoch`（首次、換帳號、升級後首次）時再把 history 全標髒、名單全部標 `dirty`（警示總開關關閉時也標，重新開啟時推得出去），觸發全量重傳。有的話不標髒：雲端若已被本機或別台裝置的 `deleteCloud` 清空，epoch 已 +1，第一個 POST 撞 409 由 `resetForEpoch` 標髒重傳（D57，§3.3）。伺服器端 upsert 與墓碑冪等，重傳不會長出重複資料。登出與刪雲端不標髒（D54）。
- **清除全部**（options 頁「清除全部」按鈕）依登入態分流：已登入時每筆本機紀錄轉成墓碑（有 `id` 者寫 `deletedAt`／`dirty:true`，既有墓碑原樣保留，沒有 `id` 的舊資料直接移除），交由同步引擎以 `deletes[]` 分批送出（每批 ≤50），伺服器 ack 後才真正從本機移除，其他裝置經墓碑各自刪除；動作送出後立刻觸發一次 `sync.now`，不必等下一個 alarm 週期。未登入維持硬刪（沒有雲端可同步）。不再呼叫任何清空端點，也不用清空水位線。
- **帳號卡待上傳與立即同步**（D52）：`buildState` 依 history 中 `dirty === true` 的筆數算出 `pendingCount`；帳號選單只在 `pendingCount > 0` 時，在「上次同步」之後附加「N 筆待上傳」，並保留既有「立即同步」鈕供手動觸發。
- **toast 時序**：按下確認鈕當下先樂觀顯示「已刪除雲端資料」（`opToastCloudDeleted`），同時立起 `pendingDeleteCloudToast` 並記下 `sendSyncAction` 回傳的 `reply` promise。**定案以 `reply` 為準**：`reply` 解出 `sync.deleteCloud` 的回應 `{ ok, signedOut?, code? }`（形狀為物件且 `ok` 是布林）時立刻蓋成定案 toast 並清掉旗標——`ok:true`／`signedOut:true` 顯示「雲端資料已刪除，已登出」（`opToastCloudDeletedSignedOut`），`ok:true` 但 `signedOut` 不為 `true` 時退回樂觀那句原文；`ok:false` 時依 `code` 顯示錯誤：`session_expired` 走既有登入過期文案（`opAccountExpired`），其餘碼以「同步失敗：」前綴帶出。**回應形狀不明時才退回廣播判讀**：`reply` 因訊息失敗、SW 被回收等原因解不出上述形狀（`sendSyncAction` 一律吞例外回傳 `undefined`）時旗標留著，改由下一次 `sync.stateChanged` 廣播定案，且**略過 `status === 'syncing'` 的廣播**（那一輪的 `lastError` 可能是上一輪殘留，不能拿來判讀）：帶 `lastError` 即錯誤 toast，狀態轉為 `signed_out` 即成功 toast。

## 6. 已知限制（插件側）

- 跨裝置讀回的紀錄，`seen[].source` 一律反映射為 `share`，無法還原上傳前的原始 `kind`（`strip`／`menu`／`icon`）。
- 匯出檔案格式含既有欄位加上 `id`／`receivedAt`／`serverUpdatedAt`（4.1）；`postKey` 與 `dirty` 不輸出（匯入端由 `postKeyOf(url)` 重算、一律標髒），`deletedAt` 不輸出（匯出來源已濾掉墓碑）。
- 「清除全部」到下一輪同步真正送出之間有短暫空窗，這段時間內新記下的貼文可能不會被這次清除動作正確處理；已登入時會在清除當下立即觸發一次同步以縮小空窗，但不保證完全消除。
- 把一台裝置從清單移除，只是把它標記成已移除，**不會**把那台裝置登出，也不會抹掉它的名稱：既有紀錄仍會顯示它原本的名稱（在紀錄詳細視窗裡標成「已移除」）。只要它仍是登入狀態，下一次同步就會讓它復活、重新出現在管理清單上，連使用者取過的自訂名稱也一併保留（D29）。
- `seen` 事件以毫秒時間戳合併，落在同一毫秒的兩筆事件會被併成一筆，裝置歸屬由先進入合併結果的那一筆決定。
- **回填進行中只有一格可觀測**：沒翻到底的一輪，`lastError` 仍是 `null`，外觀與「成功但沒有新東西」一致；唯一看得出來的是 `sync.getState` 帶出的 `marksBackfillCursor` 不是 `null`（CR-2 之後回填可以跨輪接續，不再每輪從第一頁重來），UI 沒有對應的顯示。
- **後端：evidence 聯集不推進 `updatedAt`，免費額度已滿時同請求即淘汰**：較舊的裝置對同一位作者送出 upsert 時，伺服器會把證據做聯集寫入，但 `updatedAt` **不變**——其他裝置要等到下一次真正的純量欄位更新（例如解除／復原）才能透過增量拉到這批補上的證據。免費額度已滿時，同一個請求裡新寫入的那一筆若超出額度，伺服器會在**當場**把它淘汰：`applied.upserts` 仍然列出這個 key，`evicted` 計數也會加一，但 `changes`（給別台裝置的增量）不會顯示被淘汰的這一筆——它進來又被擠出去，其他裝置永遠看不到。
- **本機容量上限淘汰的條目，雲端仍在，會被併回本機**：本機警示名單撞到 5,000 筆或 2 MB 軟預算（`docs/scam-guard.md` 第 4 節）而淘汰的條目，只是從本機 `entries` 移除，**不會**進 marks 的 `deletes`——本機的容量限制是這台裝置自己的事，不代表使用者要刪掉這位作者。雲端那一份因此原封不動；下一次整份回填，或增量剛好拉到同一位作者的更新，都會把它重新併回本機，使用者可能會看到一位剛被本機淘汰的作者又出現。
- **marks 通道失敗會讓整輪算失敗，即使 links 已落地**：一輪同步裡 links 收完才輪到 marks（§3.1），marks 失敗時 links 的推拉結果已經寫進 storage，但整條 promise 鏈仍會往上拋錯，讓 `runSync` 落在失敗分支——`syncState.lastSyncedAt` **這一輪不更新**（即使 links 其實成功了），`lastError` 與 links 共用同一格，插件端無法從 `lastError` 單獨分辨這次失敗是 links 還是 marks 那一段。
- **時鐘落後的裝置，落後期間新增的標記會被拒收**：別台裝置刪掉某一筆之後，伺服器以自己的時鐘寫下墓碑（`deletedAt`，伺服器蓋章、刪除優先，見 D50 定稿）；一台時鐘落後的裝置在那之後新增的標記，`updatedAt` 仍落在 `deletedAt` 之前，`POST /api/v1/marks/sync` 會把它整筆放進 `rejectedIds`，那個標記就同步不出去（本機還在，只是推不上雲）。與清理紀錄那一側是同一個 LWW 取捨：判準只有時間戳一個，要嘛信它、要嘛讓「刪除」失效，兩者取前者。裝置時鐘校正後本機再動過那一筆（`updatedAt` 前進）就會重新被選中、推得上去。
- **沒有 epoch 的登入仍全量重傳**：D57 起，同帳號重新登入只在雲端 epoch 變過（被清空過）時才全量重傳；本機沒有該帳號 `syncEpoch` 時（升級後首次、換帳號、全新安裝、後端尚未回報 epoch）仍一律全部標髒重傳。伺服器對逐欄相同的內容是零寫入（見上方「逐欄相同的重送即 no-op」），代價是這幾種登入後的首輪同步請求數會明顯變多，直到全部批次送完。`resetForEpoch` 觸發時同樣全量重傳，而且觸發的那一輪不再送出，重傳從下一輪（30 秒後）開始。
- **全量重傳分輪，額度用完排 30 秒續跑**：單輪同步的 POST 上限是 **12**（`links/sync` 與 `marks/sync` 合計，回填用的 `GET /api/v1/marks` 不計入這個額度）；批次數超過額度時，這一輪送滿 12 個 POST 就結束，以 30 秒保底 alarm（沿用去抖用的 `DEBOUNCE_ALARM_NAME`）排下一輪續跑，直到沒有待推批次為止——名單越大，（重新）登入後重傳到齊所需的輪數越多。單次請求 30 秒逾時視為 `network_error`，走既有退避曲線，不會讓整輪卡死在一個不回應的連線上。單飛只在 SW 記憶體；一輪受 `ROUND_DEADLINE_MS = 12×30 秒` 約束，超過 7 分鐘視為被遺棄；跨重啟的續接交給游標與冪等 ack。
- **一輪執行權杖：作廢的一輪靜默放棄落地（D59）**：帳號轉場（登入、過期、登出、刪雲端）會遞增記憶體內的帳號世代，看門狗開新一輪會換掉當前序號；在途的舊一輪之後每一次落地（寫 `syncState`／`syncAuth`／`syncBackoff`／`syncEpoch`、history 與名單的讀改寫、排 alarm、廣播、把 401 轉進過期出口）都先比對自己的權杖，不符就整輪靜默結束。代價是舊一輪已經送出、伺服器也已收下的那一批，本機不會記下 ack——同帳號（看門狗）下一輪會以相同內容重送，伺服器冪等零寫入；換帳號時那一批本來就屬於上一個帳號。登入當下若舊一輪仍在途，新帳號的首輪要等舊一輪結算（至多一次請求逾時，30 秒）才起跑，兩輪不並行。權杖只在 SW 記憶體，SW 重啟時舊一輪連同閉包一起消失，不需要跨重啟比對。
- **刪雲端後，其他裝置要等下一次同步撞到 401 才會登出**：`DELETE /api/v1/cloud-data` 撤銷的是伺服器端的 session，不會主動通知其他已登入裝置；那些裝置在下一次呼叫 `/api/v1/*` 撞到 401 之前，本機照常運作（可以繼續新增紀錄、觸發同步嘗試），撞到 401 才會走既有的登入過期／登出處理。
- **墓碑時戳由伺服器蓋章、刪除優先**：`deletedAt` 一律以伺服器收到刪除請求當下的時間為準，插件不得送自己的時戳頂替；同一筆記錄同時收到刪除與更新時，刪除視為較新（即使更新請求的本機時戳看起來更晚），這與 R2 的 upsert-vs-delete 拒收規則同一個取向。
- **舊版升級：「已按清除全部但清空意圖尚未送出」的那一份會被丟棄**：D53 之前的清除全部走清空水位線，若使用者在升級當下剛好卡在已按下清除全部、清空意圖還沒送出的空窗，升級到 D53 之後這個舊版意圖不會被接續執行也不會轉成新版墓碑；游標不會因此被歸零，下一輪只拉增量，不是整份重新比對，影響有限。
