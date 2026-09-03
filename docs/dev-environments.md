# 開發環境切換慣例

本文記錄「開發用工具如何在多個後端環境之間切換」的慣例，供本專案與其他專案照抄。以 `tools/dev-browser.mjs` 為範例實作。

## 1. 原則

- **build 模式**與**連線目標**是兩個正交維度。build 模式回答「程式碼怎麼組出來」(開發版/正式版、有無 source map)；連線目標回答「這次跑起來要連哪個後端」(local/staging/production)。兩者常被混成一個旗標，之後想加第三個環境或第三種 build 模式就會卡死。
- 連線目標一律用 `--env`(對齊 Wrangler、Cypress；`--stage` 為同義備選，對齊 Serverless Framework)。
- 不用 `--mode`——那是 Vite／webpack 的 build 模式旗標，語意衝突。
- 不用 `--api`——查不到其他工具用這個字表達「環境」，讀者得靠猜。
- 不用 `NODE_ENV` 當環境名——Next.js、Expo 文件都明講反對:`NODE_ENV` 只該是 `development`/`production`/`test` 三個 Node 生態系保留值，塞入 `staging` 這類自訂值會讓一堆函式庫的內部判斷(它們常直接 `if (NODE_ENV === 'production')`)行為跑掉。

## 2. 三層與打字量梯度

環境按「打錯的後果有多嚴重」分三層，打字量刻意遞增，讓手滑的成本與後果成正比:

| 環境 | 捷徑 | 打字量 |
|---|---|---|
| local | `npm run dev` | 最短，預設捷徑(需先自行啟動本機後端，見 §3) |
| staging | `npm run dev:staging` | 冒號子指令，一步到位 |
| production | `npm run dev -- --env production` | 沒有捷徑，得手打完整旗標 |

捷徑只給「打錯也不會出事」的目標。production 特意不設 `dev:prod`——`npm run dev:prod` 打起來跟 `dev:staging` 一樣輕鬆，跟真正該有的「連正式環境」重量完全不成比例;手滑打成 `npm run dev:prod`(本來想打別的)比手滑在完整指令裡漏看 `--env production` 容易太多。connect-to-production 的心理門檻必須用打字量體現出來，見 Payload CMS 的 `dev:prod` 前車之鑑(§7)——它是「build 模式」的 prod，被很多人望文生義當成「連正式後端」。

## 3. npm scripts 範本與旗標範本

npm scripts(本專案 `package.json` 原文):

```json
"scripts": {
  "test": "node --test test/*.test.js",
  "dev": "node tools/dev-browser.mjs --env local",
  "dev:staging": "node tools/dev-browser.mjs --env staging",
  "verify-id": "node tools/verify-extension-id.mjs"
}
```

旗標範本(逐一對應 CLI 的職責):

- `--env <local|staging|production>`:必填，連線目標，無預設值——沒給就印 help 並非 0 退出，逼使用者每次都明確選。
- `--yes`:跳過 production 的互動確認，供 CI／腳本呼叫；警告文字仍照印，不悄悄跳過。
- `--fresh`:建全新臨時 profile／state，不沿用既有登入或快取，用於重現「全新使用者」情境。
- `--restart`:目標載入路徑與執行環境目前載入的不同時，先把它關掉再重開;不帶此旗標只印訊息並非 0 退出，不擅自關使用者手上開著的視窗。
- `--ref <git ref>`:切換要載入的建置版本(worktree HEAD)，跟 `--env` 正交——可以拿 staging build 連 local，也可以拿某個 PR 分支連 staging。
- `--no-open`:跑完不自動開啟畫面，供背景／CI 呼叫。
- `--profile <dir>`:指定要重複使用的 profile 路徑，通常搭配 `--fresh` 印出的路徑回填。
- `--build <dir>`:指定建置產物所在目錄。
- `--port <port>`:指定除錯協定埠，供多開實例時避免衝突。
- `--help` / `-h`:列出所有旗標、環境說明、範例，隨時可查，不必翻原始碼。

### local 的兩個額外要求

**(a) 前置探活。** local 依賴開發機自己跑著的後端，這件事工具無法代勞，但可以在動任何東西之前先確認。`--env local` 啟動前先 `GET http://localhost:8787/health`;不通就印出啟動指令並非 0 退出，**不碰瀏覽器**——後端沒起來的話後面每一步都是白做，還會留下一個連錯環境的瀏覽器要收拾。

```
錯誤:本機後端 http://localhost:8787/health 沒有回應。
請先啟動本機後端：cd ~/.threads-clean-link/api-local/api && npx wrangler dev --port 8787
```

**(b) 開發用權限與正式產物分家。** local 的後端是 `http://localhost:8787`，瀏覽器擴充要連它就得在 manifest 宣告該 host 權限;但這一項絕不能混進上架版。作法是**不改建置產物本身，而是複製一份**:`dev-build` 保持與版控一致，每次執行以它的內容重新同步出 `dev-build-local`，只在副本的 manifest 追加 `http://localhost:8787/*`。注入是純函式(輸入 manifest 物件與 host、輸出新物件、冪等、不動 `key` 與既有 host)，因此可以單獨測，不必啟動瀏覽器。

同一個擴充 ID 不能同時從兩個未封裝路徑載入，所以切換 local ↔ staging 會換載入路徑。工具會比對「瀏覽器目前載的路徑」與「這次要載的路徑」，不同時要求重啟，並把載入路徑印進狀態橫幅。

### 載入新產物後要強制重載一次

把新的產物指給執行環境，不等於它真的跑新的程式碼。瀏覽器擴充這邊的具體形態是:`Extensions.loadUnpacked` 讓 Chrome 重讀了 manifest，但 service worker 用 `importScripts` 拉進來的模組吃的是腳本快取，換過 `--ref` 之後 manifest 是新的、SW 裡的模組還是舊版。這個坑安靜到會讓人以為是自己程式碼寫錯，因此載入後固定再送一次 `chrome.runtime.reload()` 把註冊重建。

通則:凡是「換了產物路徑或內容」的步驟，後面就補一次該平台的強制重載，不要相信載入指令本身會連快取一起換掉。

### 切換環境必須清掉上一個環境的狀態

寫入新的連線目標之前，若目前指向的是另一個環境，先清掉舊的登入憑證與同步狀態(本專案是 `storage.local` 的 `syncAuth`／`syncState`／`syncVerifiedAt`／`syncBackoff`，加上 `storage.session` 的單飛旗標、去抖、nonce)，並印一行「已切換環境，清除舊登入狀態」。

理由是這些狀態全都綁在特定後端上:token 是另一台伺服器簽的，同步游標與清除水位線指向另一份資料庫。留著不會讓人「省一次登入」，只會讓同步一直失敗，而失敗訊息看起來像新環境的問題，於是查錯查半天。三個環境互切都適用，不是只有進出 local 才清。

## 4. production 守門範本

連 production 前必須:(a) 印一段醒目、講清楚後果的警告；(b) 要求輸入環境全名字串作確認(不是 `y`/`yes` 這種容易手滑通過的單鍵，比照 Terraform `apply` 要求打完整 `yes`)；(c) `--yes` 可跳過確認但警告一定印；(d) 非互動環境(non-TTY，例如 CI 或被其他腳本以管線呼叫)一律拒絕，除非帶了 `--yes`——非 TTY 代表沒有人在現場核對輸入，靜默通過等於沒有守門。

可照抄的純函式虛擬碼(把守門邏輯抽成純函式、不直接 `process.exit`，是為了能被測試 import 而不觸發真正的副作用):

```js
async function productionGuard({ env, yes, isTTY, readLine }) {
  if (env !== 'production') return { ok: true };

  console.warn(PRODUCTION_WARNING); // 講清楚:會動到什麼正式資料、誰看得到

  if (yes) return { ok: true };
  if (!isTTY) {
    return { ok: false, reason: '非互動環境且未提供 --yes，拒絕連線 production。' };
  }

  const answer = await readLine('請輸入完整字串 "production" 以確認: ');
  if (answer !== 'production') {
    return { ok: false, reason: `輸入不符，已取消。` };
  }
  return { ok: true };
}
```

呼叫端拿到 `{ ok: false }` 就印 `reason` 並以非 0 結束，且**不得**在守門之前碰任何真正連線的資源(啟動瀏覽器、建立連線)——守門必須是流程裡最早發生的檢查之一。

## 5. 狀態橫幅範本

每次成功執行的結尾，不管哪個環境，都印一份固定格式的狀態橫幅，讓使用者一眼確認「這次到底連到哪裡」，不必回頭翻旗標:

```
================ 狀態 ================
環境:        <local|staging|!! PRODUCTION !!>
API 網址:    <這次連的完整網址>
Profile/State: <用的是哪個 profile 或 state 目錄>
連線埠/連線資訊: <CDP 埠、DB 連線字串代稱等>
載入路徑:    <這次載的是哪個目錄的產物>
建置版本:    <目前程式碼是哪個 commit/ref>
========================================
```

production 的環境標示要跟 local/staging 明顯不同(例如加驚嘆號、全大寫)，避免橫幅被略讀時誤判。橫幅**不印任何 token、cookie、session 或其他 storage 內容**——它是給人核對「連到哪裡」，不是除錯用的資料傾印。

## 6. 套用到其他專案的檢查表

以本組織的 meta-link-clearer(行動版 app)為例，對照三層环境慣例落地時該長什麼樣:

| 項目 | 瀏覽器擴充(本專案) | 行動 app(Expo/EAS) |
|---|---|---|
| 連線目標旗標 | `--env local\|staging\|production` | 同樣用 `--env`(後端 API 目標) |
| build 變體旗標 | `--ref`(worktree HEAD)、`--build`(產物目錄) | EAS 用 `--profile`(`development`/`preview`/`production`，這是 EAS 既有慣例字，指 build 設定檔，語意不同於本文的「連線 profile」，別混用) |
| 後端本身 | Cloudflare Worker，已有 `wrangler dev`(local)/`--env staging`/`--env production` | 同一顆 Worker，行為不變 |
| production 守門 | 本文 §4 | 相同純函式邏輯搬過去，警告文字換成「會寫入使用者裝置可見的正式資料」 |
| 捷徑分佈 | `dev`(local)、`dev:staging`；無 `dev:prod` | 建議 `start`(local)、`start:staging`；避免 `start:prod` 捷徑 |

檢查表本身的重點：先確認目標專案的 build 工具是否已經有自己的一套環境字（如 EAS 的 `--profile`），本文的 `--env` 只管「連線目標」這個維度，不要跟該工具既有、語意不同的維度旗標打架——寧可在文件裡寫清楚兩者對照，也不要為了統一字面而覆蓋掉工具原生慣例。

## 7. 依據

- Wrangler environments — 官方多環境設定與 `--env` 用法：
  https://developers.cloudflare.com/workers/wrangler/environments/
- Vite:Env Variables and Modes(`--mode` 是 build 模式，非連線環境)：
  https://vite.dev/guide/env-and-mode
- Next.js:Non-Standard NODE_ENV(明講反對把 `NODE_ENV` 塞自訂值)：
  https://nextjs.org/docs/messages/non-standard-node-env
- Serverless Framework:`--stage` 作為環境切換旗標的先例：
  https://www.serverless.com/framework/docs/providers/aws/guide/deploying
- Terraform:`apply` 對破壞性操作要求輸入完整 `yes` 確認：
  https://developer.hashicorp.com/terraform/cli/commands/apply
- GitHub CLI:`gh repo delete` 要求輸入完整倉庫名稱確認的同款模式：
  https://cli.github.com/manual/gh_repo_delete
- Prisma:`migrate reset` 對破壞性操作的確認流程：
  https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production
- Supabase Studio:專案裡只見 `deploy:staging`，未見對稱的 `deploy:prod` 捷徑，呼應「捷徑只給安全目標」：
  https://supabase.com/docs/guides/deployment/managing-environments
- Payload CMS:`dev:prod` 實際是「以 production build 模式跑 dev server」，並非連正式後端——正是本文極力避免的旗標語意混淆的反例：
  https://payloadcms.com/docs/production/deployment
