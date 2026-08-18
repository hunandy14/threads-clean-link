# Chrome Web Store 自動上傳草稿 —— 一次性憑證設定指南

這份文件只需要做**一次**。做完之後，`.github/workflows/release.yml` 就會在每次發版時，自動把打包好的 zip 上傳成商店的新版本草稿，並**自動呼叫 publish 送審**，過審後自動正式上架，不需要人工再上主控台按提交審查(新增權限的版本例外，見下方「運作方式」一節)。

## 整體流程總覽(先看這個，再照著做)

```
Google Cloud 建專案
  → 啟用 Chrome Web Store API
  → 設定 OAuth 同意畫面(External + 加自己為測試使用者)
  → 建立「桌面應用程式」類型的 OAuth 用戶端(拿到 Client ID / Client secret)
  → 用瀏覽器走一次 OAuth 授權流程，換到一組 refresh token
  → 到 Chrome Web Store 開發者主控台手動完成 v0.1.0 的第一次上架與送審
  → 拿到 Chrome Web Store 幫這個項目分配的 Item ID
  → 把 4 把憑證存進 GitHub Secrets
  → 之後每次 push 到 main 且版本號有變動，CI 就會自動把新版 zip 上傳成草稿並
    自動送審，過審後自動上架(新增權限的版本例外，改走手動送審)
```

**平台限制，務必先讀**:Chrome Web Store API **無法建立全新的商店項目**，只能更新「已經存在」的項目。也就是說 **v0.1.0 這第一個版本，一定要用手動方式在開發者主控台完成上架與送審**(zip 檔案、商店文案照 [store-listing.md](./store-listing.md) 填寫)，這一版通過審查、正式上架之後，這份文件描述的自動化流程才派得上用場——在那之前，API 呼叫一律會被拒收(通常是「item not found」之類的錯誤，因為項目根本還不存在)。

## 前置需求

- 一個 Google 帳號(建議用你日常管理 Chrome Web Store 開發者主控台的同一個帳號)
- 已經(或即將)在 [Chrome Web Store 開發者主控台](https://chrome.google.com/webstore/devconsole) 註冊過開發者身分(一次性 5 美元註冊費)
- 本機能執行 `curl`(Windows 可用 PowerShell 內建的 `curl.exe`，或 Git Bash)

## 步驟 1:Google Cloud 建立專案

1. 開 [Google Cloud Console](https://console.cloud.google.com/)。
2. 右上角專案選單 →「新增專案」。專案名稱隨意，例如 `threads-clean-link-cws`。
3. 建立完成後，確認畫面上方專案選單已切換到這個新專案(後續步驟都要在這個專案底下操作)。

## 步驟 2:啟用 Chrome Web Store API

1. 左側選單「API 和服務」→「已啟用的 API 和服務」→ 上方「+ 啟用 API 和服務」。
2. 搜尋 `Chrome Web Store API`，點進去，按「啟用」。

## 步驟 3:設定 OAuth 同意畫面(External + 測試使用者)

1. 「API 和服務」→「OAuth 同意畫面」(較新版主控台可能叫「OAuth 品牌設定」/「Audience」，選單文字如有調整，以你當下看到的為準)。
2. 使用者類型選 **External**(除非你的 Google 帳號屬於 Google Workspace 機構且該機構開放 Internal，否則個人 Gmail 帳號只能選 External)。
3. 應用程式名稱、支援電子郵件等基本欄位隨意填寫(僅供你自己辨識，不會有真實使用者看到)。
4. Scopes(範圍)這一步可以先跳過不加，實際請求範圍會在下一步取得 refresh token 時透過 URL 參數指定。
5. 加測試使用者(Test users):把你自己的 Google 帳號 email 加進去。**這一步不能省略**——應用程式在還沒送交 Google 驗證前處於「測試中」狀態，只有清單內的測試使用者能完成 OAuth 授權，其他帳號會被擋下。
6. 儲存。應用程式發布狀態維持在「測試中」即可，不需要送交 Google 驗證。

> **已知限制**:處於「測試中」狀態的應用程式，Google 對它核發的 refresh token 有效期限是 **7 天**，之後需要重新走一次授權流程換新的 refresh token。若這對你的發版頻率造成困擾，才需要考慮把應用程式發布狀態改成「正式」(Production)——但 `chromewebstore` 範圍是否會觸發 Google 的人工驗證審查，依 Google 當下政策而定，請在 Google Cloud Console 畫面上實際操作時以你看到的提示為準，這份文件不替你做這個判斷。

## 步驟 4:建立桌面型 OAuth 用戶端

1. 「API 和服務」→「憑證」→「+ 建立憑證」→「OAuth 用戶端 ID」。
2. 應用程式類型選 **「桌面應用程式」(Desktop app)**——這個類型會自動允許 `http://localhost` 與 `http://127.0.0.1` 開頭、任意連接埠的重新導向網址，不需要另外手動登記。
3. 名稱隨意，例如 `threads-clean-link-ci`。
4. 建立完成後，畫面會顯示 **Client ID** 與 **Client secret**，先複製起來備用(這兩個之後要存進 GitHub Secrets，也是取得 refresh token 時要用到的參數)。

## 步驟 5:取得 refresh token(具體指令)

以下把 `YOUR_CLIENT_ID`、`YOUR_CLIENT_SECRET` 換成步驟 4 拿到的值。

### 5-1. 組出授權網址，瀏覽器打開並登入授權

把下面這行網址貼進瀏覽器網址列(整行貼上即可，`YOUR_CLIENT_ID` 換成你的值):

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost:8080&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent
```

- 用步驟 3 加入測試使用者名單的那個 Google 帳號登入並同意授權。
- 因為 `localhost:8080` 這個位址根本沒有任何程式在監聽，瀏覽器授權完成後會顯示「無法連上這個網站」之類的錯誤畫面——**這是正常的，不用理會畫面內容**，重點是看**網址列**。
- 網址列此時會變成類似:
  ```
  http://localhost:8080/?code=4/0AX4XfW...一長串字元&scope=https://www.googleapis.com/auth/chromewebstore
  ```
  把 `code=` 後面、到 `&scope` 前面那一整段複製下來，這就是一次性的授權碼(authorization code)。

### 5-2. 用授權碼換 refresh token

```bash
curl -X POST https://oauth2.googleapis.com/token \
  -d "code=貼上剛才複製的授權碼" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=http://localhost:8080" \
  -d "grant_type=authorization_code"
```

回應會是一段 JSON，裡面的 `refresh_token` 欄位就是你要的值，例如:

```json
{
  "access_token": "ya29....(這組一小時內就會過期，不用管它)",
  "expires_in": 3599,
  "refresh_token": "1//0g....(這組才是要留下來的)",
  "scope": "https://www.googleapis.com/auth/chromewebstore",
  "token_type": "Bearer"
}
```

把 `refresh_token` 的值存下來——這是四把 CI 憑證之一，**只會在授權網址帶了 `prompt=consent` 且該帳號第一次(或撤銷重授權後第一次)同意這個應用程式時完整核發**，遺失了就整個步驟 5 重做一次即可，不影響已上架的版本。

## 步驟 6:取得 Chrome Web Store 項目 ID(CWS_EXTENSION_ID)

這一步的前提是**已經**依照本文件最上方「平台限制」段落，完成 v0.1.0 的手動上架。完成後:

1. 開 [Chrome Web Store 開發者主控台](https://chrome.google.com/webstore/devconsole)。
2. 點進這個擴充功能的項目頁面，網址列會長得像:
   ```
   https://chrome.google.com/webstore/devconsole/<你的帳號代碼>/<32 個小寫英文字母的 ID>/edit
   ```
   那串 32 個小寫英文字母就是 Item ID，也是 `CWS_EXTENSION_ID` 要填的值(同時也是使用者安裝頁的網址 `https://chromewebstore.google.com/detail/<Item ID>` 裡的那一段)。

## 步驟 7:在 GitHub 新增四個 Secrets

到這個 repo 的 GitHub 頁面:**Settings → Secrets and variables → Actions → Secrets 分頁 → New repository secret**，依序新增以下四筆(名稱需完全一致，`release.yml` 直接以這些名稱讀取):

| Secret 名稱 | 值 |
|---|---|
| `CWS_CLIENT_ID` | 步驟 4 的 Client ID |
| `CWS_CLIENT_SECRET` | 步驟 4 的 Client secret |
| `CWS_REFRESH_TOKEN` | 步驟 5 拿到的 refresh token |
| `CWS_EXTENSION_ID` | 步驟 6 拿到的 Item ID |

四筆都設定好之後，下一次符合條件的發版(main 分支 push 且 `manifest.json` 版本號對應的 tag 還不存在)就會自動觸發上傳。**四筆缺任何一筆，CI 會印出「未設定 CWS 憑證，跳過商店上傳」並正常結束，不會讓整個發版流程失敗**——這是刻意設計的優雅跳過，不設定憑證完全不影響既有的測試、打包、GitHub Release 三個步驟。

## 運作方式:CI 做什麼、你要做什麼

> **2026-08-18 更新，取代舊決策**:本節原文為「CI 只上傳草稿、送審永遠交給人工在主控台親自按下去」，該決定已翻案，改為下列自動送審流程。

- **CI(`release.yml`)自動做的事**:用 refresh token 換一次性的 access token，把該版本的 zip 用 `PUT` 上傳到 Chrome Web Store 成為**新版本草稿**;上傳成功後，緊接著呼叫 `publish` API 自動送審，過審後 Chrome Web Store 會自動正式上架。
- **為什麼改成自動送審**:發布把關的時機已經前移到 PR 合併進 main 那一刻——PR 審過、合併了就代表這個版本已經決定要發，主控台上再多一道「手動點提交審查」不再帶來額外的品質把關價值。
- **新增權限的版本會被自動攔下，不需要你自己記得勾選**:`skip_publish` 這個手動開關終究是「提醒」，push 觸發時根本沒有畫面可以勾——真正把關的是送審步驟前的「檢查是否新增權限」這一步:它抓上一個版本 tag 的 `manifest.json`，跟這次的 `manifest.json` 比對四個欄位——`permissions`、`host_permissions`、`optional_permissions`、`optional_host_permissions`——以及 `content_scripts[*].matches` 的聯集(比對邏輯見 `tools/check-new-permissions.py`)。只比對前兩個欄位曾經被滲透測試繞過:改 `optional_permissions`，或完全不動任何 permission 欄位、只在 `content_scripts` 裡新增 match pattern 擴大生效網域，都不會被舊版邏輯抓到，因此擴大成這五個比對面向。只要偵測到新增項目，就印出 `::warning::` 並自動跳過送審步驟(草稿仍會照常上傳，只是不會呼叫 `publish`)。這種情況下請至開發者主控台手動送審，並親自填寫新權限的使用理由文案——這段文案自動化沒辦法幫你編。第一次發版(沒有上一個 tag 可比對)時這一關會直接放行，不會誤擋。這一關刻意寫成 fail-closed:只有明確判定「無新增」時才放行送審，比對步驟若因故沒跑(output 是空值)一律視同有新權限、擋下送審，不會因為防線本身出狀況而誤放行。
- **`skip_publish` 仍然保留，用於你想自己控制上架時機**:用 `workflow_dispatch` 的 `skip_publish` 讓 CI 這一輪只更新草稿、略過自動送審，改天想送審時再到主控台手動按提交審查，跟是否新增權限無關。
- 所以現在看到 CI 印出「已成功送出審查」，代表這個版本已經進了 Google 的審查隊列，不需要你再做任何事;只有偵測到新權限、或你自己開了 `skip_publish` 這兩種情境才需要你上主控台手動操作。

## 重要限制與常見錯誤

- **v0.1.0 審查完成前，API 會拒收**:如本文件開頭所述，第一版必須手動上架。在那之前跑這個 CI 步驟(就算四把憑證都設好了)，上傳呼叫會失敗，錯誤訊息通常會指出項目不存在或沒有權限。
- **審查中無法上傳新草稿**:如果前一個版本正在 Google 審查中，此時再上傳新版本草稿可能會被 API 拒絕(常見錯誤訊息類似「目前無法更新這個項目，因為它正在審查中」)。這種情況等審查結果出來(不論通過或退回)再重新觸發一次即可，`release.yml` 會把這類錯誤挑選過的說明欄位印出來，不會吞掉。
- **重複送審(ITEM_PENDING_REVIEW)**:如果草稿上傳成功，但送審當下前一版本仍在審查隊列中，`publish` 回應的 status 會含 `ITEM_PENDING_REVIEW`。`release.yml` 把這種情況視為可重試、不算失敗——印出 `::warning::` 但不會讓整個 workflow 變紅，因為草稿本身已經上傳成功。補送方式:**前版審查通過後，手動執行 `workflow_dispatch` 的 `upload_only` 模式即可補送本版**(`skip_publish` 保持不勾，讓這次執行連同送審一起重跑)。
- **refresh token 過期**:見步驟 3 的已知限制，測試中狀態的應用程式核發的 refresh token 是 7 天效期，過期後需要重新走一次步驟 5。
- **安全性**:四把憑證只存在 GitHub Secrets 裡，`release.yml` 的 log 全程不會 `echo` 或印出 access token、client secret、refresh token 本身;失敗時只印挑選過的錯誤說明欄位，方便除錯又不外洩憑證。access token 由 refresh token 於 job 內即時換得，經 `::add-mask::` 遮罩後以 step output 在同一個 job 內供上傳、送審兩個步驟復用，生命週期僅止於該次 run，不會存成 secret 或跨 run 保留。
