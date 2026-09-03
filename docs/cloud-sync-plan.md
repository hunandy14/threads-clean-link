# 雲端同步計劃文件

本文件是 threads-clean-link 插件對接 meta-link-clearer 雲端後端（Cloudflare Workers ＋ D1 ＋ Better Auth）的唯一真相源。所有車道（A～F）以此文件為準；素材來源見文末引用的
`tmp/db-sync-feasibility.md`（可行性調查）與 `tmp/backend-changes-for-extension.md`（後端變更規格）。

## 1. 目標與範圍

**目標**：讓插件對齊手機 app 使用的同一套後端，使用者用 Google 帳號登入後，清理紀錄可在手機與瀏覽器之間雙向同步。

**MVP 範圍**：
- Google 登入（`chrome.identity.launchWebAuthFlow` 取 id_token → bearer token）。
- 清理紀錄雙向同步：本機 → 雲端（outbox／dirty 標記）、雲端 → 本機（游標拉取）。
- 帳號登出、刪除雲端資料。
- 首次綁定全量上傳並告知使用者 free 方案雲端保留上限。
- options／popup 顯示同步狀態（登入態、上次同步時間、手動同步）。

**非範圍**（本次不做）：
- `seen[].source` 白名單放寬（`strip`／`menu`／`icon` 不會新增雲端欄位，見決策 D4）。
- pro 方案／付費相關 UI 或邏輯。
- 即時推送（沒有 WebSocket／Push，一律輪詢＋去抖）。

---

## 2. 決策紀錄

| 編號 | 決策 | 理由 | 日期 |
|---|---|---|---|
| D1 | 後端加 `bearer()` plugin，插件走 `Authorization: Bearer`，所有 fetch `credentials: "omit"`，只從 service worker 發請求 | 避開 cookie／CSRF 風險面，content script 不豁免 CORS，只有 SW 能跨源讀回應 | 2026-09-02 |
| D2 | CSRF 補強由後端做（獨立於 CORS 的 `Sec-Fetch-Site`／`Origin` 檢查），插件不依賴 cookie | `/api/v1/links` 原本唯一屏障是 CORS allowlist，插件加入後風險面擴大，補強不能只靠插件端 | 2026-09-02 |
| D3 | 首次綁定全量上傳並告知使用者 free 方案雲端保留 1000 筆 | 剛上線不會頂到上限；比擋住首次同步或做複雜篩選成本低 | 2026-09-02 |
| D4 | `kind` 只留本機；上雲時 `share`→`share`，`strip`／`menu`／`icon`→`clipboard` | 雲端 `seen[].source` 白名單寫死在 D1 CHECK 約束，改後端代價不成比例 | 2026-09-02 |
| D5 | Google client 依 API 環境對應（後端把 staging 與 production 的 Web client 分家）：production `https://api.metalinkclearer.workers.dev` → `17054024593-p003rp6cqmm9ks4r8mdphal1ahr3rhum.apps.googleusercontent.com`；staging `https://api-staging.metalinkclearer.workers.dev` → `17054024593-846tl3brfgd5f09ouavituflf5b7v6qi.apps.googleusercontent.com`；local `http://localhost:8787` → 同 production（本機後端的 `.dev.vars` 用舊 Web client）。三者皆為公開值，非機密；插件端存於 `sync.js` 的 `CLIENT_ID_BY_API_BASE` 對照表，`signIn` 依 `loadContext()` 解析出的 apiBase 取值，aud 驗證用同一個值。Console 已加 redirect URI `https://hehokicokbgajpanjcajhmflaennnmdj.chromiumapp.org/`（兩個 client 共用同一擴充 ID） | 後端拆分 client 後單一 ID 已無法同時通過兩個環境各自的 `aud` 檢查，插件必須依環境送對應的 client_id | 2026-09-02（2026-09-04 更新：staging 已分家） |
| D6 | 同步預設關閉，使用者主動登入才啟用；未登入行為與現況完全一致 | 「僅保存於這台裝置」的既有承諾在未登入時必須成立，登入是使用者的主動選擇 | 2026-09-02 |
| D7 | 擴充 ID 固定為 `hehokicokbgajpanjcajhmflaennnmdj`，manifest 加 `key`（值存於 `secrets/manifest-key.json`，非機密），dev build 與商店版同 ID | Google redirect URI 與後端 `EXTENSION_ORIGINS` 都以擴充 ID 為準，ID 漂移會讓登入與 CSRF allowlist 同時失效 | 2026-09-02 |
| D8 | `identity` 走 `optional_permissions`，後端網域走 `optional_host_permissions`（`https://api.metalinkclearer.workers.dev/*`、`https://api-staging.metalinkclearer.workers.dev/*`），登入當下才請求 | 常駐在 manifest 的必要權限會在更新時觸發 Chrome 自動停用擴充，等到登入才申請可避免 | 2026-09-02 |
| D9 | API base 預設 production，`chrome.storage.local.syncApiBase` 可覆寫為 staging 或 local（`http://localhost:8787`，開發用）；三值以外一律忽略 | 插件沒有 build-time 環境切換機制，用 storage 覆寫最小成本達成 dev/staging/local 測試。local 的 host 權限只宣告在 `tools/dev-browser.mjs` 產出的開發用 manifest 副本，商店版沒有這一項 | 2026-09-02 |
| D10 | bearer token 存 `chrome.storage.local.syncAuth`（需跨瀏覽器重啟保留登入），風險已知：明文，登出必打 sign-out 撤銷 | `chrome.storage.session` 重啟即清空，不符合「登入態應長期保留」的需求；明文風險以「登出即撤銷」對沖 | 2026-09-02 |
| D11 | post 身分鍵改用手機的 `postKeyOf` 規則（`threads:<code>`／`url:<正規化>`），history 合併鍵切換，並持久化為 `postKey` 欄位 | 插件現有 `extractPostId` 與手機規則在邊界情況（怪 handle、`m.threads.com`、尾斜線）不等價，會在雲端分裂成兩張卡；伺服器本來就自己算 `postKey`，插件對齊本機規則即可 | 2026-09-02 |
| D12 | 同步觸發：`chrome.alarms` 週期不低於 1 分鐘＋新紀錄 2 秒去抖＋options／popup 開啟時一次＋手動；退避曲線照手機 scheduler（30s→600s） | MV3 沒有「前景常駐計時器」概念，SW 隨時被殺，所有排程狀態必須可從 `chrome.storage` 復原 | 2026-09-02 |
| D13 | 整合分支 `agent/feature/cloud-sync`，車道 PR 以它為 base，收尾一次總 PR 到 main 給使用者親審。在 mock 伺服器上開發，後端通知 bearer 可用後才接 staging | 多車道平行開發需要共同基準；後端變更尚未部署，插件端不能等待，先用 mock 伺服器解耦 | 2026-09-02 |

---

## 3. 後端契約

以下整段抄自 `tmp/backend-changes-for-extension.md` 第 8 節「給插件端的契約摘要」，並在文末補兩條插件端需要但原文未列出的細節。

> 1. 登入：`POST /api/auth/sign-in/social`，`Content-Type: application/json`，body `{"provider":"google","idToken":{"token":"<google id_token>"}}`（沿用既有 Web client ID）。
> 2. id_token 用 `chrome.identity.launchWebAuthFlow` 取得；Console 需加 `https://<ext-id>.chromiumapp.org/` 為 redirect URI。
> 3. token 取得位置：登入回應的 **`set-auth-token`** 回應標頭；**任何**回應只要有這個標頭就覆寫本地存值。
> 4. header 格式：`Authorization: Bearer <token>`，套用於 `/api/v1/*` 與 `/api/auth/*`（含 sign-out）。
> 5. 所有 fetch 一律 **`credentials: "omit"`**，且**必須從 service worker 發**（content script 會被 CORS 擋）；`manifest.json` 的 `host_permissions` 需含 `https://api.metalinkclearer.workers.dev/*`。
> 6. 登出：`POST /api/auth/sign-out` 帶 Bearer；伺服器刪 session 列，token 立刻作廢。
> 7. 錯誤碼：`401 unauthorized`（token 失效 → 清本地 token 重新登入）、`403 forbidden_origin`（沒帶 Bearer 且來源不對 → 程式錯誤，別重試）、`415 unsupported_media_type`、`429 rate_limited`、`503 misconfigured`。
> 8. Rate limit：每使用者 60 次／60 秒，超過回 `429 { "error":"rate_limited","retryAfter":60 }` 附 `Retry-After: 60`；收到就退避到下一個時間窗，不要立即重試。
> 9. Session 壽命 90 天滑動（若採用 §5.1 建議，擴充客戶端為 30 天滑動）。
> 10. `seen.source` 枚舉不放寬，沿用現有值；`POST /api/v1/links/sync` 必須帶 `Content-Type: application/json`，否則 415。

補充（插件端需要，原文未列）：

11. `GET /api/auth/get-session` 帶 Bearer 回目前 session，插件啟動時用它驗 token 是否仍有效（不必等到 `/api/v1/*` 打回 401 才發現失效）。
12. sign-in 的 idToken body 完整形狀為 `{"provider":"google","idToken":{"token":"<id_token>","nonce":"<可選>"}}`——`nonce` 欄位可選，`launchWebAuthFlow` 走隱含流程時若帶了 nonce 需一併傳入，未帶則整個 `nonce` 鍵可省略。

> 注意（見第 8 節）：契約第 9 點「30 天滑動」的前提是後端採用 §5.1 的 bearer 短壽命建議（後端原文件的 D1），目前後端 PM 尚未採納此建議（只採納 A1／B1-B3／C2／D3），因此**實際行為是 90 天滑動，不是 30 天**。同步引擎車道（D）實作前應以 `get-session` 回傳的過期時間為準，不要寫死 30 天假設。

---

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
  cursor: string | null,
  lastSyncedAt: number | null,
  clearedAt: number | null,
  lastError: string | null,
}

chrome.storage.local.syncAuth = {
  token: string | null,
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

---

## 5. 模組介面（車道 D 實作、車道 E 消費）

新模組檔名 `sync.js`（SW 內 `importScripts`，與 `tcl-core.js` 同風格 IIFE，掛 `TCLSync`）。此模組是車道 D 與 E 之間唯一的協議邊界，打包白名單（`tools/build-release.ps1` 的檔案陣列）需加入此檔。

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
  lastSyncedAt: number | null,
  pendingCount: number,
  lastError: string | null,
  apiBase: string,
}
```

### 5.3 廣播

background 在 state 變化時廣播 `{type:"sync.stateChanged", state}`，options／popup 監聽此訊息即時更新 UI，不需輪詢 `sync.getState`。

---

## 6. 車道與依賴

```
第 0 波：計劃文件（本文件）
第 1 波（可平行）：
  A（manifest key ＋ optional permissions ＋ 認證 spike，opus）
  B（postKeyOf 移植，sonnet）
  F（隱私與送審文案，sonnet）
第 2 波（可平行，依賴上一波）：
  C（資料層遷移，opus，依賴 B）
  E（UI／i18n，sonnet，對 stub 狀態開發，不等 D）
第 3 波：
  D（同步引擎＋認證狀態機＋alarms＋mock 伺服器，opus，依賴 C 與 A 的結論）
收尾：全套測試、打包、總 PR
```

車道 E 在第 2 波即可開工，因為它消費的是第 5 節定義的 state 形狀與 message 協議（stub 實作即可對接），不需等車道 D 的真實同步引擎完成。

---

## 7. 風險與對策

| 嚴重度 | 問題 | 對策 |
|---|---|---|
| 阻斷 | `/api/v1/links` 原本唯一 CSRF 屏障是 CORS allowlist | 後端補獨立 Origin／`Sec-Fetch-Site` 檢查（D2），插件走 bearer 不帶 cookie |
| 阻斷 | 首次綁定把本機最多 10000 筆推上雲，free 只保留 1000 筆且靜默滾動淘汰 | 首次同步前告知筆數與方案上限（D3：全量上傳＋告知） |
| 高 | UI 明文承諾「紀錄僅保存於這台裝置」與雲端同步衝突 | 文案、README、store-listing 三處同步改寫，登入前後顯示不同說明（車道 F） |
| 高 | 擴充套件 ID 必須固定；dev build 與 CWS build ID 原本不同 | manifest 加 `key`，dev build 與商店版同 ID（D7） |
| 高 | 新增 `identity` ＋ host permission 觸發 CI 手動送審閘門 | 走 `optional_permissions`／`optional_host_permissions`，登入當下才請求（D8）；先備妥權限理由文案 |
| 中 | MV3 SW 隨時被殺，同步中途中斷留下半套狀態 | 所有狀態落 `chrome.storage`；`dirty` 只在收到 ack 後清除 |
| 中 | 插件的 `kind` 在雲端沒有欄位，跨裝置遺失 | 接受此損失（D4） |
| 中 | 兩邊清理規則與 post key 規則各自演進、無共用套件 | 把 `postKeyOf` 逐字移植進 `tcl-core.js` 並加對照測試（車道 B） |
| 中 | 60 次／60 秒 per user 限流由手機＋插件共用同一桶 | alarm 週期不低於 1 分鐘（D12）；首次回填分批並在 429 時看 `Retry-After` 退避 |
| 低 | local／staging／production 三套環境，插件沒有切換概念 | `chrome.storage.local.syncApiBase` 可覆寫（D9），預設 production |
| 中 | 「清除全部」是先寫本機 `syncState.clearedAt` 旗標、下一輪同步才打 `DELETE /api/v1/links`；伺服器據此寫 `cleared_at` 並拒收早於它的資料，因此清空到送出之間新記下的貼文（以及被拒收後標為已處理的那批）會被連坐丟失 | 已登入時在清除當下就立刻觸發一次 `syncNow`，把窗口壓到一次往返；MVP 接受殘餘窗口（SW 剛好被回收、或當下離線）造成的丟失，不做本機補償佇列 |
| 低 | 合併語意差異：插件「新值優先、缺席沿用」，雲端以 `max(receivedAt, seen.at)` 判新舊 | 插件端改用雲端判準當唯一權威 |
| 低 | 鏡像加欄位撐大體積，逼近 8MB 軟預算 | 調降本機保留筆數，或視需要申請 `unlimitedStorage` |

---

## 8. 後端配合狀態

後端 PM 已採納：A1（啟用 `bearer()` plugin）、B1-B3（CSRF middleware 新檔＋掛載＋錯誤碼文件）、C2（新增 `EXTENSION_ORIGINS` 到 `[vars]`）、D3（`secure-headers` ＋ `Cache-Control: no-store`）。**未採納**：D1（bearer 客戶端較短 session 壽命）、D2（限流桶改 per user+client）、D4（過期 session 清理 Cron）——同步引擎實作時不可假設這幾項已生效（見第 3 節「注意」段落）。

`EXTENSION_ORIGINS` 兩環境（production／staging）皆使用同一值 `chrome-extension://hehokicokbgajpanjcajhmflaennnmdj`，與 D7 的固定擴充 ID 決策一致。

部署流程：測試先行（`api/src/csrf.test.ts` 等）→ 實作 → 部署 staging → **log-only 觀察**（先記錄不拒絕，用真機／插件流量確認零 would-reject）→ 轉正式拒絕 → 部署 production。整段流程完成後後端會通知插件端；在此之前，車道 D 的同步引擎在 mock 伺服器上開發（D13），不接 staging。

---

## 附：素材來源

- 可行性調查：`tmp/db-sync-feasibility.md`
- 後端變更規格：`tmp/backend-changes-for-extension.md`
