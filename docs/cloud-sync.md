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
| D12 | 同步觸發：`chrome.alarms` 週期不低於 1 分鐘＋新紀錄 2 秒去抖＋options／popup 開啟時一次＋手動；退避曲線照手機 scheduler（30s→600s） | MV3 沒有「前景常駐計時器」概念，SW 隨時被殺，所有排程狀態必須可從 `chrome.storage` 復原 | 2026-09-02 |
| D14 | 帳號入口移到設定頁頁首右上角，移除既有的雲端同步卡片（版型依核准的 demo） | 帳號狀態是使用者最常想確認的資訊，放頁首比埋在頁面中段的卡片更符合預期動線 | 2026-09-04 |
| D15 | 已登入時顯示使用者的名字與 Google 大頭照；缺席時備援 email 前段，再缺則備援首字母；大頭照網址僅接受 `googleusercontent.com`（或其子網域） | 帳號入口要讓使用者一眼確認「這是我的帳號」，備援序列確保任何欄位缺席都有合理顯示；大頭照白名單避免任意網址被當成 `<img src>` 載入 | 2026-09-04 |
| D16 | 帳號選單順序固定為：立即同步 → 登出 → 刪除雲端資料（帶二次確認） | 破壞性動作放最後、且需二次確認，降低誤觸機率 | 2026-09-04 |
| D17 | 帳號入口顯示五種狀態：未登入、已登入、同步中、錯誤、登入過期 | 涵蓋使用者會遇到的所有帳號狀態，避免中間狀態（例如 token 失效）顯示成看似正常的「已登入」 | 2026-09-04 |
| D18 | 新增警告色 token `--warn`（淺色 `#d9a441`／深色 `#e6b955`） | 「登入過期」「即將刪除雲端資料」等狀態需要有別於一般錯誤色（紅）與一般資訊色的視覺提示 | 2026-09-04 |
| D19 | 「刪除雲端資料」之後本機紀錄留在這台裝置、且**不會**再被上傳（entry 一律 `dirty:false`）；發動清空的裝置把伺服器寫下的 `cleared_at` 記進獨立的 `chrome.storage.local.syncClearGuard`，之後拉回**自己**那一次的 `changes.clearedAt` 時不清本機，比守衛更新的水位線（別台裝置清的）照舊硬刪。兩個邊界一律往「不刪」倒（硬刪不可逆）：回應沒帶 `clearedAt` 時記成**待定**守衛（`{ pending: true }`，不拿本機時間當水位線），由下一次拉回來的 `changes.clearedAt` 認領；守衛讀不懂（降級／被寫壞）時本輪**跳過**硬刪、記 `lastError = 'clear_guard_invalid'` 廣播讓使用者知情，並把守衛重置成待定等下一輪認領 | 伺服器對清空只有一條廣播管道（`changes.clearedAt`），發動的裝置也會拉回自己寫下的水位線；不記下來就分不出「別台清的」與「我自己剛清的」，於是「刪雲端 → 登出 → 再登入」會把本機紀錄全滅（真機實證）。守衛刻意不放 `syncState`——登出與 session 過期會把 `syncState` 整包重設，放進去等於撐不過那一輪。又因伺服器對早於 `cleared_at` 的 `receivedAt` 一律拒收（api-spec 4.3 規則 2），留在本機的紀錄本來就上不去，「刪雲端但留本機」的語意與手機端 `deleteAccount`（本機一列不動）一致 | 2026-09-04 |

## 3. 插件端契約

以下只寫插件對後端要送什麼、收什麼；後端內部如何防護不在此列。

- **登入**：`POST /api/auth/sign-in/social`，`Content-Type: application/json`，body `{"provider":"google","idToken":{"token":"<google id_token>","nonce":"<可選>"}}`（`nonce` 視 `launchWebAuthFlow` 流程決定是否帶）。id_token 由 `chrome.identity.launchWebAuthFlow` 取得；Console 需加 `https://<ext-id>.chromiumapp.org/` 為 redirect URI。
- **token 取得**：登入回應的 **`set-auth-token`** 回應標頭；任何回應只要帶這個標頭就覆寫本地存值。
- **帶入方式**：`Authorization: Bearer <token>`，套用於 `/api/v1/*` 與 `/api/auth/*`（含 sign-out）。所有 fetch 一律 `credentials: "omit"`，且必須從 service worker 發（content script 會被 CORS 擋）；`manifest.json` 的 `host_permissions` 需含後端網域。
- **登出**：`POST /api/auth/sign-out` 帶 Bearer；成功後立即清本地 token。
- **驗證 session**：`GET /api/auth/get-session` 帶 Bearer 回目前 session，插件啟動時用它驗 token 是否仍有效，不必等到 `/api/v1/*` 打回 401 才發現失效。
- **顯示用個人資料**（D15）：登入回應與 `get-session` 回應的 `user` 物件若帶 `name`／`image`，插件用來更新 `syncState.displayName`／`avatarUrl`；兩者缺席時登入當下改用 id_token payload 的 `name`／`picture` claim 補位。`image` 進本機前先過白名單（只接受 `https://` 且 host 為 `googleusercontent.com` 或其子網域），不合白名單一律存 `null`。
- **同步端點**：`POST /api/v1/links/sync` 必須帶 `Content-Type: application/json`，否則回 415；`seen.source` 只接受既有枚舉值（映射見決策 D4）。
- **插件需處理的錯誤碼**：
  - `401 unauthorized`：token 失效，清本地 token、導回未登入態重新登入。
  - `403 forbidden_origin`：沒帶 Bearer 或來源不對，屬程式錯誤，不重試。
  - `415 unsupported_media_type`：request 缺 `Content-Type: application/json`。
  - `429 rate_limited`：回應附 `Retry-After`，插件收到就退避到下一個時間窗，不立即重試。
  - `503 misconfigured`：後端設定問題，插件顯示錯誤狀態，不重試。

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

既有欄位不動：`url`、`kind`、`at`、`seen`、`author`、`handle`、`excerpt`、`removedParams`。`kind` 依 D4 只留本機、不上雲。

### 4.2 新 storage key

```
chrome.storage.local.syncState = {
  userId: string | null,
  email: string | null,
  displayName: string | null,  // D15：帳號入口顯示用，去頭尾空白、上限 80 字元
  avatarUrl: string | null,    // D15：僅接受 https 且 host 為 googleusercontent.com（或其子網域）
  cursor: string | null,
  lastSyncedAt: number | null,
  clearedAt: number | null,
  lastError: string | null,
}

chrome.storage.local.syncAuth = {
  token: string | null,
}

chrome.storage.local.syncClearGuard = {   // D19：本機自己發動的雲端清空
  userId: string | null,                 // 發動當下的帳號；換人之後守衛不沿用
  clearedAt: number | null,              // 伺服器回應的 clearedAt；缺席時為 null（待定）
  pending?: true,                        // 待定：等下一次 changes.clearedAt 認領
  sentAt?: number,                       // 待定時的 DELETE 發出時間，僅供診斷，不參與比較
}

chrome.storage.local.syncApiBase = string  // 可選，覆寫預設 production base，只接受 staging／local 兩個值（D9）
```

帳號切換時（`syncState.userId` 變更）需清空本機同步鏡像欄位（`postKey`／`dirty`／`serverUpdatedAt`／`deletedAt`），比照手機端 `sync/active-owner.ts` 的處理方式。

### 4.3 欄位映射表（entry → 雲端 `SyncItem`）

| 雲端 `SyncItem` | 插件現況 | 對齊方式 |
|---|---|---|
| `id`（必填） | 無 | 首次同步時為每筆生成 `crypto.randomUUID()` 並寫回 entry；伺服器若回 `canonicalId` 則就地改名 |
| `cleaned`（必填） | `url` | 直接映射（送出前先過 `normalizePostUrl`） |
| `original`（必填） | 選填 `original` | 缺席時以 `url` 填入，否則整筆被伺服器靜默丟棄 |
| `receivedAt`（必填） | `at`（最後更新時間） | 語意不同：改用 `seen[0].at`（最早事件）當 `receivedAt`，`at` 保留為本機顯示用 |
| `seen[].at` / `.source` | `seen[].kind` | `share`→`share`；`strip`／`menu`／`icon`→`clipboard`。原 `kind` 另存本機欄位，不上雲 |
| `author`／`handle`／`excerpt` | 同名 | 直接映射 |
| `removedParams` | `{key,value}[]` | 已一致，零改動 |
| `failReason` | 無 | 不送 |
| — | `kind`（卡片徽章） | 雲端無對應欄位，跨裝置必然遺失（D4 已接受） |

## 5. 模組介面

新模組檔名 `sync.js`（SW 內 `importScripts`，與 `tcl-core.js` 同風格 IIFE，掛 `TCLSync`）。此模組是同步引擎與 UI 之間唯一的協議邊界，打包白名單（`tools/build-release.ps1` 的檔案陣列）需加入此檔。

### 5.1 runtime message（options／popup → background）

| type | 用途 |
|---|---|
| `{type:"sync.getState"}` | 取目前同步狀態，回傳見 5.2 |
| `{type:"sync.signIn"}` | 觸發 `launchWebAuthFlow` 登入流程 |
| `{type:"sync.signOut"}` | 登出（呼叫 sign-out 並清本地 token） |
| `{type:"sync.now"}` | 手動觸發一次同步 |
| `{type:"sync.deleteCloud"}` | 刪除雲端資料（`DELETE /api/v1/account` 或對應端點） |

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
}
```

### 5.3 廣播

background 在 state 變化時廣播 `{type:"sync.stateChanged", state}`，options／popup 監聽此訊息即時更新 UI，不需輪詢 `sync.getState`。

## 6. 已知限制（插件側）

- 跨裝置讀回的紀錄，`seen[].source` 一律反映射為 `share`，無法還原上傳前的原始 `kind`（`strip`／`menu`／`icon`）。
- 匯出檔案格式含既有欄位加上 `id`／`receivedAt`／`serverUpdatedAt`（4.1）；`postKey` 與 `dirty` 不輸出（匯入端由 `postKeyOf(url)` 重算、一律標髒），`deletedAt` 不輸出（匯出來源已濾掉墓碑）。
- 「清除全部」到下一輪同步真正送出之間有短暫空窗，這段時間內新記下的貼文可能不會被這次清除動作正確處理；已登入時會在清除當下立即觸發一次同步以縮小空窗，但不保證完全消除。
