// tools/dev-browser.mjs — 一鍵啟動除錯用 Chrome 並載入開發版擴充。
//
// 前提:專用 profile(預設 ~/.threads-clean-link/debug-profile)必須先手動
// 登入過 Google 測試帳號，本腳本不處理登入。dev-build(預設
// ~/.threads-clean-link/dev-build)是主 repo 的另一個 git worktree，本腳本
// 只在指定 --ref 時切換其 HEAD，不建立或初始化該 worktree。
//
// 實際載入的一律是 dev-build 的副本 dev-build-loaded（每次執行重新同步），
// 三個環境共用這一個路徑:同一個擴充 ID 不能並存兩個 unpacked 路徑，載入
// 路徑跟著環境走就代表每次切環境都得關掉重開 Chrome。副本的 manifest 只有
// --env local 會多注入 http://localhost:8787/*，其餘環境與 dev-build 的
// 逐字相同;dev-build worktree 本身永遠不被改動，商店版 manifest 也就不會
// 夾帶開發用權限。
//
// --env local 另外需要開發機自己跑著後端(wrangler dev，port 8787):啟動前
// 先探 /health，不通就直接非 0 結束，不碰 Chrome。
//
// Chrome 152 起 --load-extension 命令列參數被忽略，改用 CDP
// Extensions.loadUnpacked 載入未封裝擴充;重開 Chrome 後先前載入的擴充不會
// 自動恢復，因此每次啟動都會再載一次(對已載入的擴充重複 loadUnpacked 回同一
// 個 id 無害)。全程只印狀態，不印任何 chrome.storage 內容或憑證(可能含登入
// token)。
//
// 連線目標用 --env 這一個必填旗標(local/staging/production 三選一)，
// 與擴充是否重新建置(--build/--ref)是兩個正交維度——理由與其他專案的套用
// 方式見 docs/dev-environments.md。
//
// 用法:
//     node tools/dev-browser.mjs --env <local|staging|production> [--ref <git ref>]
//                                 [--no-open] [--port <port>] [--profile <dir>]
//                                 [--build <dir>] [--fresh] [--restart] [--yes]
//                                 [--help]
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXPECTED_EXTENSION_ID = 'hehokicokbgajpanjcajhmflaennnmdj';

// 連線目標三選一，與 sync.js 的 apiBase 白名單(D9)逐字對應。
const ENVIRONMENTS = ['local', 'staging', 'production'];

const API_BASE = {
  local: 'http://localhost:8787',
  staging: 'https://api-staging.metalinkclearer.workers.dev',
  production: 'https://api.metalinkclearer.workers.dev',
};

// 只注入 dev-build-local 副本 manifest 的 host 權限。商店版 manifest 不含
// 這一項，上架版因此連向本機請求權限都做不到。
const LOCAL_HOST_PERMISSION = 'http://localhost:8787/*';

// 本機後端探活的逾時:localhost 不通就是不通，不值得久等。
const HEALTH_TIMEOUT_MS = 3000;

const START_LOCAL_BACKEND_HINT =
  `請先啟動本機後端：cd ~/.threads-clean-link/api-local/api && npx wrangler dev --port 8787`;

// 切換環境時要清掉的舊狀態。token 是另一台伺服器簽的，游標與水位線指向
// 另一份資料庫，留著只會讓同步拿舊憑證去打新後端，再把失敗當成新環境的
// 問題查半天。
const STALE_LOCAL_KEYS = ['syncAuth', 'syncState', 'syncVerifiedAt', 'syncBackoff'];
const STALE_SESSION_KEYS = ['syncInflight', 'syncNonce', 'syncDebounce'];

const DEFAULT_PORT = 9222;
const FRESH_DEFAULT_PORT = 9223;

const PRODUCTION_WARNING = [
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  '!! 警告:即將連線 production 環境。',
  '!! 這會連上正式資料庫——同步的清理紀錄會寫入正式 D1，並出現在使用者手機上。',
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
].join('\n');

// 驗證 --env 的值是三個合法環境之一，否則丟出可讀的錯誤訊息。
function resolveEnv(name) {
  if (!ENVIRONMENTS.includes(name)) {
    throw new Error(`--env 只接受 ${ENVIRONMENTS.join('、')}，收到:${name}`);
  }
  return name;
}

// 純函式:只解析與驗證，不做任何 I/O，方便測試 import 後直接呼叫。
// 同一旗標出現多次時後者覆蓋前者(對應 `npm run dev -- --env production`
// 這種在既有 script 的 --env local 後面再疊加旗標的用法)。
function parseArgs(argv) {
  const opts = {
    help: false,
    env: null,
    ref: null,
    open: true,
    port: null,
    profile: path.join(homedir(), '.threads-clean-link', 'debug-profile'),
    build: path.join(homedir(), '.threads-clean-link', 'dev-build'),
    yes: false,
    fresh: false,
    restart: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--env':
        opts.env = argv[++i];
        break;
      case '--ref':
        opts.ref = argv[++i];
        break;
      case '--no-open':
        opts.open = false;
        break;
      case '--port':
        opts.port = Number(argv[++i]);
        break;
      case '--profile':
        opts.profile = argv[++i];
        break;
      case '--build':
        opts.build = argv[++i];
        break;
      case '--yes':
        opts.yes = true;
        break;
      case '--fresh':
        opts.fresh = true;
        break;
      case '--restart':
        opts.restart = true;
        break;
      default:
        throw new Error(`不明參數:${arg}`);
    }
  }

  if (opts.help) return opts;

  if (!opts.env) {
    throw new Error('缺少必填旗標 --env(local|staging|production)');
  }
  resolveEnv(opts.env);

  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port <= 0)) {
    throw new Error(`--port 必須是正整數，收到:${opts.port}`);
  }

  return opts;
}

// 實際載入的副本目錄:與 dev-build 同層、名字加 -loaded 後綴。--build 換
// 路徑時副本跟著換，兩者不會分家。三個環境共用這一個路徑——同一個擴充 ID
// 不能並存兩個 unpacked 路徑，載入路徑跟著環境走的話，每次切環境都得關掉
// 重開 Chrome。
function loadedBuildDirFor(buildDir) {
  const normalized = buildDir.replace(/[\\/]+$/, '');
  const basename = path.basename(normalized);
  if (!basename) throw new Error(`--build 路徑取不出目錄名:${buildDir}`);
  return path.join(path.dirname(normalized), `${basename}-loaded`);
}

// 純函式:回傳追加 host 權限後的新 manifest，不改動輸入物件。已含同一項時
// 只回傳淺複製(冪等)，key 與既有 host 一律原樣保留——ID 由 key 推導，動到
// 就等於換一個擴充，OAuth redirect URI 會全部對不上。
function withHostPermission(manifest, hostPattern) {
  const existing = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
  if (existing.indexOf(hostPattern) !== -1) return { ...manifest };
  return { ...manifest, optional_host_permissions: [...existing, hostPattern] };
}

// 探本機後端是否已就緒。逾時／連不上／非 2xx 一律視為未就緒，錯誤細節對
// 使用者沒有意義——要做的事都是同一件:先把 wrangler dev 跑起來。
async function probeHealth(apiBase, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok === true;
  } catch {
    return false;
  }
}

// rmSync 是這支腳本唯一會刪東西的地方，刪之前先確認目標真的是「dev-build
// 的兄弟目錄」:呼叫端傳錯路徑（例如把 --build 指到磁碟根目錄）時，遞迴
// 刪除的後果無法挽回。
function assertSiblingCopy(buildDir, loadedDir) {
  const from = path.resolve(buildDir);
  const to = path.resolve(loadedDir);
  if (!path.basename(to)) throw new Error(`副本路徑的目錄名不得為空:${loadedDir}`);
  if (from === to) throw new Error(`副本路徑不得等於 dev-build 本身:${loadedDir}`);
  if (path.dirname(from) !== path.dirname(to)) {
    throw new Error(`副本路徑必須與 dev-build 同層:${loadedDir}（dev-build:${buildDir}）`);
  }
}

// 以 dev-build 的內容重建副本。hostPattern 有給才把該 host 注入副本的
// manifest（只有 --env local 會給）；不給時副本的 manifest 與 dev-build
// 的逐字相同。
//
// 每次先刪再整包複製:dev-build 刪掉的檔案不該在副本裡陰魂不散。.git 排除
// 在外——那是 worktree 的中繼資料，複製過去只會讓副本被當成另一個 worktree。
function syncLoadedBuild(buildDir, loadedDir, hostPattern = null) {
  assertSiblingCopy(buildDir, loadedDir);
  rmSync(loadedDir, { recursive: true, force: true });
  cpSync(buildDir, loadedDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });
  if (hostPattern) {
    const manifestPath = path.join(loadedDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const json = JSON.stringify(withHostPermission(manifest, hostPattern), null, 2);
    writeFileSync(manifestPath, json + '\n');
  }
  return loadedDir;
}

// 讀 profile 裡 Chrome 記下的「這個擴充 ID 目前載自哪個路徑」。同一個 ID
// 的兩個 unpacked 路徑不能同時載入，換路徑前得先知道現在載的是哪一個。
// 讀不到(檔案不存在／格式變了／該 ID 沒載過)一律回 null，交由呼叫端當成
// 「無從判斷」放行——這是輔助檢查，不是守門。
function readLoadedExtensionPath(profileDir, extensionId) {
  for (const file of ['Secure Preferences', 'Preferences']) {
    try {
      const prefs = JSON.parse(readFileSync(path.join(profileDir, 'Default', file), 'utf8'));
      const entry = prefs.extensions && prefs.extensions.settings && prefs.extensions.settings[extensionId];
      if (entry && typeof entry.path === 'string' && entry.path) return entry.path;
    } catch {
      // 檔案不存在或不是合法 JSON:換下一個候選，全部落空就回 null。
    }
  }
  return null;
}

// 路徑比較前的正規化:大小寫、分隔符與尾隨斜線的差異都不算換路徑。
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// production 守門:純邏輯，isTTY/readLine 由呼叫端注入以便測試。
// 回傳 { ok: true } 或 { ok: false, reason }，不做任何 process.exit。
async function productionGuard({ env, yes, isTTY, readLine: ask }) {
  if (env !== 'production') return { ok: true };

  console.warn(PRODUCTION_WARNING);

  if (yes) return { ok: true };

  if (!isTTY) {
    return {
      ok: false,
      reason: '非互動環境(non-TTY)且未提供 --yes，拒絕連線 production。',
    };
  }

  const answer = await ask('請輸入完整字串 "production" 以確認: ');
  if (answer !== 'production') {
    return {
      ok: false,
      reason: `輸入不符(收到:${JSON.stringify(answer)})，已取消。`,
    };
  }
  return { ok: true };
}

// 真正互動用的 readLine 實作，包成注入函式讓 productionGuard 保持純邏輯。
function createReadLine() {
  return (promptText) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
}

// --fresh:在系統暫存目錄建立一個帶時間戳的新 profile 目錄，不沿用既有登入
// 狀態。目錄本身由 Chrome 啟動時的 --user-data-dir 建立，這裡只給路徑。
function freshProfileDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(tmpdir(), `threads-clean-link-profile-${stamp}`);
}

function helpText() {
  return `一鍵啟動除錯用 Chrome 並載入開發版擴充。

用法:
    node tools/dev-browser.mjs --env <local|staging|production> [其他旗標]

必填旗標:
    --env <local|staging|production>
        連線目標環境，沒有預設值，必須指定。

載入的產物:
    三個環境都載 dev-build 的副本(${'<--build>'}-loaded)，每次執行以
    dev-build 的內容重新同步。共用同一個載入路徑是刻意的——同一個擴充 ID
    不能並存兩個 unpacked 路徑，載入路徑跟著環境走就代表每次切環境都要關掉
    重開 Chrome。
    每次執行都會送一次 chrome.runtime.reload()(不這樣做，service worker 會
    吃到舊的腳本快取)，已經開著的擴充頁面(options／popup)會跟著被關掉。

環境說明:
    local
        連開發機自己跑的後端(${API_BASE.local})，對應 npm run dev。
        前置:先在另一個終端機跑起後端——
            cd ~/.threads-clean-link/api-local/api && npx wrangler dev --port 8787
        啟動前會先探 /health，不通就非 0 結束，不會啟動 Chrome。
        副本的 manifest 會多注入 ${LOCAL_HOST_PERMISSION} 權限;dev-build
        本身與商店版 manifest 都不受影響。
    staging
        寫入 chrome.storage.local.syncApiBase 指向 staging API(${API_BASE.staging})。
        對應 npm run dev:staging。
    production
        連正式環境(${API_BASE.production})。啟動前印醒目警告，並要求互動
        輸入完整字串 "production" 確認(比照 terraform apply 的 yes 確認)；
        非 TTY 或輸入不符則中止，不會啟動 Chrome。--yes 可跳過互動確認，
        但警告仍會印出。

其他旗標:
    --ref <git ref>    切換 dev-build worktree 的 HEAD 到指定 ref 再啟動
    --no-open          不自動開啟擴充的 options 頁
    --port <port>      指定 CDP 埠(預設 ${DEFAULT_PORT}，--fresh 時預設 ${FRESH_DEFAULT_PORT})
    --profile <dir>    指定 Chrome user-data-dir(預設 ~/.threads-clean-link/debug-profile)
    --build <dir>      指定 dev-build worktree 路徑(預設 ~/.threads-clean-link/dev-build)
    --fresh            在系統暫存目錄建立全新 profile(不沿用既有登入狀態)，
                        結尾印出路徑，之後可用 --profile <路徑> 重複使用
    --restart          目標載入路徑與 Chrome 目前載入的不同時，先關閉 Chrome
                        再重開(同一個擴充 ID 的兩個 unpacked 路徑不能並存)。
                        三個環境共用副本路徑之後，只有「Chrome 裡還載著舊版
                        直接指向 dev-build 的擴充」這個一次性過渡用得到。
                        不帶此旗標時只印建議並非 0 結束，不會動使用者的視窗
    --yes              跳過 production 的互動確認(仍會印警告)
    --help, -h         顯示這份說明並結束(結束碼 0)

切換環境的副作用:
    寫入新的 syncApiBase 之前，若擴充目前指向的是另一個環境，會清掉舊的
    登入與同步狀態(syncAuth／syncState／syncVerifiedAt／syncBackoff 與
    session 的單飛旗標、去抖、nonce)並印一行提示。舊 token 是另一台伺服器
    簽的，留著只會讓同步一直失敗。三個環境互切都適用。

範例:
    node tools/dev-browser.mjs --env local
    node tools/dev-browser.mjs --env local --restart --no-open
    node tools/dev-browser.mjs --env staging
    node tools/dev-browser.mjs --env staging --ref my-branch --no-open
    node tools/dev-browser.mjs --env production
    node tools/dev-browser.mjs --env production --yes
    node tools/dev-browser.mjs --env staging --fresh
`;
}

// 依平台常見安裝路徑找 chrome 執行檔，找不到就丟出清楚錯誤。
function findChromeExecutable() {
  const plat = platform();
  if (plat === 'win32') {
    const candidates = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'],
    ]
      .filter(Boolean)
      .map((base) => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
    throw new Error(
      `找不到 chrome.exe，已檢查:\n${candidates.join('\n')}\n請確認 Chrome 已安裝，或用其他方式手動指定。`
    );
  }
  if (plat === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(macPath)) return macPath;
    throw new Error(`找不到 Chrome:${macPath}`);
  }
  // Linux:交給 PATH 解析，找不到就讓 spawn 失敗時的錯誤說明狀況。
  return 'google-chrome';
}

async function cdpVersion(port) {
  const res = await fetch(`http://localhost:${port}/json/version`);
  if (!res.ok) throw new Error(`CDP /json/version 回應非 200:${res.status}`);
  return res.json();
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await cdpVersion(port);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

// --restart:透過 CDP 請 Chrome 自己收工(Browser.close 是正常關閉流程，不會
// 留下「Chrome 未正確關閉」的還原提示)，再等 CDP 埠真的斷線。只在使用者明
// 確帶 --restart 時呼叫——關掉的是使用者手上開著的除錯瀏覽器。
async function closeChrome(port, timeoutMs = 15000) {
  const version = await cdpVersion(port);
  // Browser.close 會在瀏覽器結束前後把連線切掉，回覆常常收不到;這裡不把
  // 「沒等到回覆」當失敗，真正的判準是下面的 CDP 是否斷線。
  await sendCdpCommand(version.webSocketDebuggerUrl, 'Browser.close', {}, timeoutMs).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillUp = await cdpVersion(port).then(
      () => true,
      () => false
    );
    if (!stillUp) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待 Chrome(port ${port})關閉逾時(${timeoutMs / 1000} 秒)`);
}

async function ensureChromeRunning(opts) {
  const alreadyUp = await cdpVersion(opts.port).then(
    () => true,
    () => false
  );
  if (alreadyUp) {
    console.log(`Chrome 已在執行且 CDP(port ${opts.port})可連，跳過啟動。`);
    return;
  }

  const chromeExe = findChromeExecutable();
  console.log(`啟動 Chrome:${chromeExe}`);
  const child = spawn(
    chromeExe,
    [
      `--user-data-dir=${opts.profile}`,
      `--remote-debugging-port=${opts.port}`,
      '--no-first-run',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  const ok = await waitForCdp(opts.port, 15000);
  if (!ok) {
    throw new Error(`等待 Chrome CDP(port ${opts.port})上線逾時(15 秒)`);
  }
  console.log('Chrome 已啟動，CDP 就緒。');
}

const CDP_COMMAND_TIMEOUT_MS = 10000;

// 連線層斷掉（endpoint 已死）與對端不回覆（endpoint 活著但卡住）是兩件事:
// 前者換一個 target 重試就好，後者重試只是再等一輪逾時。用 code 區分。
const CDP_DISCONNECTED = 'CDP_DISCONNECTED';

function disconnected(message) {
  const err = new Error(message);
  err.code = CDP_DISCONNECTED;
  return err;
}

// reload 後等舊 service worker target 退場的上限。等不到就照常往下走——
// 後續步驟自己也有逾時，不值得為此中斷整個流程。
const SW_RETIRE_TIMEOUT_MS = 5000;

// 對指定的 CDP WebSocket endpoint(browser 層級或單一 target 自己的
// webSocketDebuggerUrl)開一條連線，送出一個指令並等對應 id 的回覆，然後關閉。
// WebSocket 開了但對端不回覆(target 已消失、CDP 卡住)時，逾時強制 reject，
// 不讓呼叫端永遠掛住。
function sendCdpCommand(wsUrl, method, params, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // 忽略關閉時的錯誤，收尾交給呼叫端的 exit timer。
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`${method} 逾時:${timeoutMs}ms 內未收到回覆`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.id !== id) return;
      if (msg.error) {
        finish(reject, new Error(`${method} 失敗:${msg.error.message}`));
      } else if (msg.result && msg.result.exceptionDetails) {
        finish(reject, new Error(`${method} 執行時擲出例外:${msg.result.exceptionDetails.text}`));
      } else {
        finish(resolve, msg.result);
      }
    });
    ws.addEventListener('error', (event) => {
      finish(reject, disconnected(`${method} 的 CDP WebSocket 連不上:${event.message || event.type}`));
    });
    // 對端在回覆前把連線切掉（target 被關、擴充 reload 掉整個 service
    // worker）時只會收到 close，沒有 error;不接這一則就要空等到逾時。
    // 已經結算過的 finish 是 no-op，因此自家 ws.close() 觸發的 close
    // 不會蓋掉正常結果。
    ws.addEventListener('close', () => {
      finish(reject, disconnected(`${method} 的 CDP 連線在收到回覆前就關閉了`));
    });
  });
}

async function switchDevBuildRef(buildDir, ref) {
  console.log(`切換 dev-build worktree 至 ${ref} ...`);
  await execFileAsync('git', ['-C', buildDir, 'checkout', '--detach', ref]);
  console.log('切換完成。');
}

async function loadUnpackedExtension(port, buildDir) {
  const version = await cdpVersion(port);
  const buildPathForCdp = buildDir.replace(/\\/g, '/');
  const result = await sendCdpCommand(version.webSocketDebuggerUrl, 'Extensions.loadUnpacked', {
    path: buildPathForCdp,
  });
  const id = result && result.id;
  console.log(`已載入未封裝擴充，id = ${id}`);
  if (id !== EXPECTED_EXTENSION_ID) {
    console.warn(
      `警告:載入回傳的 id(${id})與預期的固定 ID(${EXPECTED_EXTENSION_ID})不符，OAuth redirect URI 可能對不上。`
    );
  }
  return id;
}

async function findExtensionTargets(port) {
  const res = await fetch(`http://localhost:${port}/json`);
  if (!res.ok) throw new Error(`CDP /json 回應非 200:${res.status}`);
  return res.json();
}

async function findServiceWorkerTarget(port, extensionId) {
  const targets = await findExtensionTargets(port);
  return targets.find(
    (t) => t.type === 'service_worker' && t.url && t.url.includes(extensionId)
  );
}

// 開一個分頁喚醒擴充的 service worker，再等它出現在 /json 清單。
async function wakeServiceWorker(port, extensionId) {
  const res = await fetch(
    `http://localhost:${port}/json/new?chrome-extension://${extensionId}/options.html`,
    { method: 'PUT' }
  );
  if (!res.ok) throw new Error(`喚醒 service worker 用的分頁開啟失敗:${res.status}`);
  const wakeTarget = await res.json();

  // 分頁已經開出來了，從這裡開始的任何失敗都得自己收掉它;等待逾時是最常
  // 見的一條——SW 沒上線時把分頁留著，--no-open 形同虛設。
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const sw = await findServiceWorkerTarget(port, extensionId);
      if (sw) return { sw, wakeTargetId: wakeTarget.id };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('等待擴充 service worker 上線逾時(5 秒)');
  } catch (err) {
    await closeTarget(port, wakeTarget.id).catch(() => {});
    throw err;
  }
}

// 讀回擴充目前指向的後端。三種結果分得很清楚:
//   - 讀到字串     → 就是那個值
//   - 讀到 null    → 鍵不存在，等同擴充的預設值 production
//   - 回傳形狀不對 → null，代表「讀不出來」，呼叫端一律當成必須清舊狀態
// 最後一種寧可誤判成需要切換而多清一次，也不要把舊 token 留給新後端。
async function readCurrentApiBase(swWsUrl, timeoutMs) {
  const result = await sendCdpCommand(
    swWsUrl,
    'Runtime.evaluate',
    {
      expression:
        '(async () => { const got = await chrome.storage.local.get({ syncApiBase: null }); return got.syncApiBase; })()',
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs
  );
  if (!result || !result.result || !('value' in result.result)) return null;
  const value = result.result.value;
  if (typeof value === 'string' && value) return value;
  return value === null ? API_BASE.production : null;
}

// 清掉上一個環境留下的登入與同步狀態(storage.local 四鍵 ＋ storage.session
// 的單飛旗標／去抖／nonce)。三個環境互切都適用。
async function clearStaleSyncState(swWsUrl, timeoutMs) {
  const expression = [
    '(async () => {',
    `  await chrome.storage.local.remove(${JSON.stringify(STALE_LOCAL_KEYS)});`,
    `  if (chrome.storage.session) await chrome.storage.session.remove(${JSON.stringify(STALE_SESSION_KEYS)});`,
    '})()',
  ].join('\n');
  await sendCdpCommand(swWsUrl, 'Runtime.evaluate', { expression, awaitPromise: true }, timeoutMs);
}

// 連到 service worker target 自己的 webSocketDebuggerUrl 執行 Runtime.evaluate，
// 不需要額外走 Target.attachToTarget(每個 target 在 /json 裡自帶專屬 debugger
// endpoint，連上去即等同已 attach)。
//
// 回傳值:若本次為了喚醒 SW 開了暫時分頁，回傳該分頁的 target id，讓呼叫端
// 決定是收尾關掉(--no-open)還是沿用成 options 頁;SW 原本就在線則回傳
// undefined。
async function ensureServiceWorker(port, extensionId) {
  const sw = await findServiceWorkerTarget(port, extensionId);
  if (sw) return { sw, wakeTargetId: undefined };
  console.log('擴充 service worker 尚未上線，開啟 options 頁喚醒 ...');
  return wakeServiceWorker(port, extensionId);
}

// 等指定的 service worker target 從 /json 清單退場（消失或換了 id）。
//
// 終止一個 SW 之後它不會立刻從清單消失，而那段期間連上去的 endpoint 已經
// 死了:輕則收到 close，重則接受連線但永遠不回覆，呼叫端只能等到逾時。
// 現場兩次都踩到——一次在 chrome.runtime.reload() 之後，一次在對已載入的
// 擴充再跑一次 Extensions.loadUnpacked（那等同重載）之後。
//
// old 為 null（本來就沒有 SW）時直接回。等不到就照常往下走，後續步驟自己
// 也有逾時與重試，不值得為此中斷整個流程。
async function waitForServiceWorkerRetire(port, extensionId, old) {
  if (!old) return;
  const deadline = Date.now() + SW_RETIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await findServiceWorkerTarget(port, extensionId);
    if (!current || current.id !== old.id) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// 取得一個「真的連得上」的 service worker endpoint，並解除它的除錯暫停。
//
// /json 清單可能還留著剛被 loadUnpacked／reload 終止的舊 target:連上去會
// 當場被切斷（現場踩過:連跑兩次時第二次直接炸在 WebSocket 錯誤）。連線層
// 斷掉就重查一次拿新的;對端活著但不回覆則照原樣往上丟，重試只是再等一輪
// 逾時。
async function attachToServiceWorker(port, extensionId, timeoutMs, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const attached = await ensureServiceWorker(port, extensionId);
    try {
      // CDP 對「剛啟動」的 service worker 預設會暫停等除錯器接手(即使沒人
      // 真的要下中斷點)，之後送的指令全部卡在佇列裡，直到收到這道指令才會
      // 繼續執行——對「原本就在線」的 SW 則是無害的 no-op。
      await sendCdpCommand(
        attached.sw.webSocketDebuggerUrl,
        'Runtime.runIfWaitingForDebugger',
        {},
        timeoutMs
      );
      return attached;
    } catch (err) {
      if (attached.wakeTargetId) await closeTarget(port, attached.wakeTargetId).catch(() => {});
      if (err.code !== CDP_DISCONNECTED) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

// Extensions.loadUnpacked 會讓 Chrome 重讀 manifest，但 service worker 以
// importScripts 拉進來的檔案(tcl-core.js／auth.js／sync.js)吃的是腳本快取，
// 換過 --ref 之後 manifest 是新的、SW 裡的模組卻還是舊版——現場驗證踩過這
// 個坑，而且它安靜到會讓人以為程式碼沒生效是自己寫錯。chrome.runtime.reload()
// 重建註冊，快取才真的失效。
async function reloadExtension(port, extensionId, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  const { sw, wakeTargetId } = await attachToServiceWorker(port, extensionId, timeoutMs);
  try {
    // reload() 當場終止這個 SW，回覆多半收不到;收不到不算失敗。
    await sendCdpCommand(
      sw.webSocketDebuggerUrl,
      'Runtime.evaluate',
      { expression: 'chrome.runtime.reload()' },
      timeoutMs
    ).catch(() => {});
  } finally {
    // reload 會把擴充頁面一起收掉，這個分頁多半已經自己消失;關不掉不算錯。
    if (wakeTargetId) await closeTarget(port, wakeTargetId).catch(() => {});
  }

  await waitForServiceWorkerRetire(port, extensionId, sw);

  console.log('已重新載入擴充(清掉 service worker 的舊腳本快取)。');
}

async function configureApiEnv(port, extensionId, env, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  const { sw, wakeTargetId } = await attachToServiceWorker(port, extensionId, timeoutMs);

  try {
    // 寫新的 syncApiBase 之前先比對舊值:換了環境就把舊登入狀態清乾淨。
    const current = await readCurrentApiBase(sw.webSocketDebuggerUrl, timeoutMs);
    if (current !== API_BASE[env]) {
      await clearStaleSyncState(sw.webSocketDebuggerUrl, timeoutMs);
      console.log('已切換環境，清除舊登入狀態。');
    }

    const expression =
      env === 'production'
        ? "chrome.storage.local.remove('syncApiBase')"
        : `chrome.storage.local.set({syncApiBase: ${JSON.stringify(API_BASE[env])}})`;

    await sendCdpCommand(
      sw.webSocketDebuggerUrl,
      'Runtime.evaluate',
      { expression: `(async () => { ${expression}; })()`, awaitPromise: true },
      timeoutMs
    );

    console.log(
      env === 'production'
        ? `已設定 API 環境:production(移除 syncApiBase，使用預設值 ${API_BASE.production})`
        : `已設定 API 環境:${env}(${API_BASE[env]})`
    );
  } catch (err) {
    // 喚醒後的步驟失敗，暫時分頁沒人會再用到，盡量收尾關掉，不讓錯誤路徑
    // 也洩漏分頁;關閉本身失敗就算了，不能蓋掉原本的錯誤。
    if (wakeTargetId) {
      await closeTarget(port, wakeTargetId).catch(() => {});
    }
    throw err;
  }

  return wakeTargetId;
}

// 關閉指定的 CDP target(走 browser 層級連線送 Target.closeTarget)。用於
// 收掉 wakeServiceWorker 開的暫時分頁——不關的話 --no-open 形同虛設，CDP
// 的 /json 清單會一直多一個分頁。
async function closeTarget(port, targetId) {
  const version = await cdpVersion(port);
  await sendCdpCommand(version.webSocketDebuggerUrl, 'Target.closeTarget', { targetId });
}

// configureApiEnv 之後的收尾:
//   - open === true:照常開 options 頁。若本次喚醒 SW 已經開了一個
//     options.html 分頁，openOptionsPage 會在 /json 清單裡找到它並直接
//     沿用，不會重複開兩個。
//   - open === false:不開頁。若本次為了喚醒 SW 開了暫時分頁，用完即關，
//     維持「不開頁就不留任何多的分頁」的承諾。
async function configureApiEnvAndCleanup(port, extensionId, env, open) {
  const wakeTargetId = await configureApiEnv(port, extensionId, env);

  if (open) {
    await openOptionsPage(port, extensionId);
    return;
  }

  if (wakeTargetId) {
    await closeTarget(port, wakeTargetId);
    console.log('已關閉喚醒 service worker 用的暫時分頁。');
  }
}

async function openOptionsPage(port, extensionId) {
  const targets = await findExtensionTargets(port);
  const existing = targets.find(
    (t) => t.type === 'page' && t.url && t.url === `chrome-extension://${extensionId}/options.html`
  );
  if (existing) {
    console.log('options 頁已開啟，不重複開新分頁。');
    return;
  }
  const res = await fetch(
    `http://localhost:${port}/json/new?chrome-extension://${extensionId}/options.html`,
    { method: 'PUT' }
  );
  if (!res.ok) throw new Error(`開啟 options 頁失敗:${res.status}`);
  console.log('已開啟 options 頁。');
}

// dev-build worktree 目前指向的 commit，只用於狀態橫幅顯示，取不到就標
// unknown，不因此中斷主流程。
async function getBuildCommit(buildDir) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', buildDir, 'rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function printBanner({ env, apiBase, profile, port, extensionId, buildCommit, loadPath }) {
  const envLabel = env === 'production' ? '!! PRODUCTION !!' : env;
  console.log('');
  console.log('================ dev-browser 狀態 ================');
  console.log(`環境:        ${envLabel}`);
  console.log(`API 網址:    ${apiBase}`);
  console.log(`Profile:     ${profile}`);
  console.log(`CDP 埠:      ${port}`);
  console.log(`擴充 ID:     ${extensionId}`);
  console.log(`載入路徑:    ${loadPath}（dev-build 的副本）`);
  console.log(`dev-build:   ${buildCommit}`);
  console.log('====================================================');
}

// 同一個擴充 ID 不能同時從兩個 unpacked 路徑載入:Chrome 已經在跑、而且它
// 記著的載入路徑與這次要載的不同時，得先關掉 Chrome 才能換過去。
//
// 三個環境共用副本路徑之後，這只會在「Chrome 裡還載著舊版直接指向 dev-build
// 的擴充」這個一次性過渡發生，日常切環境不會再撞上。--restart 才會真的關;
// 否則印出建議並設 exitCode，不動使用者的視窗。
async function ensureLoadPathSwitchable(opts, loadPath) {
  const alreadyUp = await cdpVersion(opts.port).then(
    () => true,
    () => false
  );
  if (!alreadyUp) return;

  const loaded = readLoadedExtensionPath(opts.profile, EXPECTED_EXTENSION_ID);
  if (!loaded || samePath(loaded, loadPath)) return;

  if (!opts.restart) {
    console.error('提示:Chrome 目前載入的擴充路徑與這次要載的不同，同一個擴充 ID 不能並存兩個路徑。');
    console.error(`  目前載入:${loaded}`);
    console.error(`  這次要載:${loadPath}`);
    console.error('建議加上 --restart 讓本腳本關閉 Chrome 再重開，或自己關掉這個除錯用 Chrome 後重跑。');
    console.error('這是切到共用副本路徑的一次性過渡，之後三個環境都載同一個路徑，不會再要求重啟。');
    process.exitCode = 1;
    return;
  }

  console.log(`載入路徑改變(${loaded} → ${loadPath})，--restart:關閉 Chrome 後重開 ...`);
  await closeChrome(opts.port);
  console.log('Chrome 已關閉。');
}

// 主流程。help / 缺 --env / production 守門拒絕 / local 後端未就緒 / 載入
// 路徑衝突都只設定 process.exitCode 並提早 return，不丟例外——只有真正非
// 預期的失敗(找不到 dev-build、Chrome 啟動失敗等)才用 throw 交給外層 catch。
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`錯誤:${err.message}`);
    console.error('');
    console.error(helpText());
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    console.log(helpText());
    process.exitCode = 0;
    return;
  }

  const guard = await productionGuard({
    env: opts.env,
    yes: opts.yes,
    isTTY: Boolean(process.stdin.isTTY),
    readLine: createReadLine(),
  });
  if (!guard.ok) {
    console.error(`錯誤:${guard.reason}`);
    process.exitCode = 1;
    return;
  }

  if (opts.fresh) {
    opts.profile = freshProfileDir();
  }
  if (opts.port === null) {
    opts.port = opts.fresh ? FRESH_DEFAULT_PORT : DEFAULT_PORT;
  }

  // 本機後端探活擺在最前面:不通的話後面每一步都是白做，而且不該為此動到
  // 使用者的 Chrome。
  if (opts.env === 'local') {
    const healthy = await probeHealth(API_BASE.local);
    if (!healthy) {
      console.error(`錯誤:本機後端 ${API_BASE.local}/health 沒有回應。`);
      console.error(START_LOCAL_BACKEND_HINT);
      process.exitCode = 1;
      return;
    }
    console.log(`本機後端就緒:${API_BASE.local}/health`);
  }

  if (!existsSync(opts.build)) {
    throw new Error(`找不到 dev-build 目錄:${opts.build}`);
  }

  if (opts.ref) {
    await switchDevBuildRef(opts.build, opts.ref);
  }

  // 三個環境都載同一份副本，只有 local 這一次會多注入 localhost 權限。
  // 共用路徑是刻意的:同一個擴充 ID 不能並存兩個 unpacked 路徑，載入路徑
  // 跟著環境走就代表每次切環境都得關掉重開 Chrome。實測(Chrome 152)確認
  // 同路徑就地重載時，已授予的 identity 與其他 host 權限完整保留;只有
  // 「manifest 不再宣告」的那一項會被撤銷（切回 local 時重按一次授權）。
  // --ref 永遠作用在 dev-build worktree，同步到副本是這一步。
  const loadPath = loadedBuildDirFor(opts.build);
  syncLoadedBuild(opts.build, loadPath, opts.env === 'local' ? LOCAL_HOST_PERMISSION : null);
  console.log(
    opts.env === 'local'
      ? `已同步 dev-build 至副本並注入 ${LOCAL_HOST_PERMISSION}:${loadPath}`
      : `已同步 dev-build 至副本（manifest 未改動）:${loadPath}`
  );

  await ensureLoadPathSwitchable(opts, loadPath);
  if (process.exitCode) return;

  await ensureChromeRunning(opts);

  // 對「已載入」的擴充再跑一次 loadUnpacked 等同重載，舊的 SW 當場被終止。
  // 先記下它，載完等它退場，否則下一步會連上一個已死的 endpoint。
  const previousSw = await findServiceWorkerTarget(opts.port, EXPECTED_EXTENSION_ID);
  const extensionId = await loadUnpackedExtension(opts.port, loadPath);
  await waitForServiceWorkerRetire(opts.port, extensionId, previousSw);

  await reloadExtension(opts.port, extensionId);
  await configureApiEnvAndCleanup(opts.port, extensionId, opts.env, opts.open);

  const buildCommit = await getBuildCommit(opts.build);
  printBanner({
    env: opts.env,
    apiBase: API_BASE[opts.env],
    profile: opts.profile,
    port: opts.port,
    extensionId,
    buildCommit,
    loadPath,
  });

  if (opts.fresh) {
    console.log('');
    console.log(`已使用全新 profile:${opts.profile}`);
    console.log('之後可用 --profile <上面路徑> 重複使用此 profile(免重新登入)。');
  }

  console.log('');
  console.log('完成。');
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main()
    .then(() => {
      // Node 在某些版本關閉 WebSocket 後偶爾觸發底層 assertion，
      // 延遲一拍再結束程序以避開。
      setTimeout(() => process.exit(process.exitCode ?? 0), 100);
    })
    .catch((err) => {
      console.error(`錯誤:${err.message}`);
      setTimeout(() => process.exit(1), 100);
    });
}

export {
  ENVIRONMENTS,
  API_BASE,
  DEFAULT_PORT,
  FRESH_DEFAULT_PORT,
  CDP_COMMAND_TIMEOUT_MS,
  LOCAL_HOST_PERMISSION,
  STALE_LOCAL_KEYS,
  STALE_SESSION_KEYS,
  resolveEnv,
  parseArgs,
  productionGuard,
  withHostPermission,
  loadedBuildDirFor,
  syncLoadedBuild,
  samePath,
  probeHealth,
  readLoadedExtensionPath,
  freshProfileDir,
  helpText,
  sendCdpCommand,
  closeTarget,
  reloadExtension,
  configureApiEnv,
  configureApiEnvAndCleanup,
  openOptionsPage,
};
