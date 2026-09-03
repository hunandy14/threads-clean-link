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
// --env local 需要開發機自己跑著後端(wrangler dev，port 8787):啟動前先探
// /health，通了就沿用既有;不通且未帶 --no-backend 時，自動在後端目錄(預設
// ~/.threads-clean-link/api-local/api，可用環境變數 TCL_API_LOCAL_DIR 覆寫)
// 背景執行 npm run dev，等到 /health 通過(最多 60 秒)才繼續，逾時就殺掉剛
// 啟動的行程樹並非 0 結束。啟動的後端本腳本結束不會關掉(常駐)，之後重跑
// --env local 會直接沿用;要關閉用 --stop-backend(獨立旗標，不需要 --env)。
// --no-backend 維持舊行為:探活失敗就印手動啟動提示並非 0 結束，不碰後端。
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
//                                 [--no-backend] [--help]
//     node tools/dev-browser.mjs --stop-backend
import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
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

// --env local 自動帶起本機後端用的固定路徑與逾時參數。後端目錄本身可用
// TCL_API_LOCAL_DIR 環境變數覆寫(見 resolveBackendDir)——這三個路徑則固定
// 在使用者家目錄下，跨專案／跨 repo 都認得同一組 log／PID 檔。
const BACKEND_STATE_DIR = path.join(homedir(), '.threads-clean-link');
const BACKEND_LOG_PATH = path.join(BACKEND_STATE_DIR, 'api-local.log');
const BACKEND_PID_PATH = path.join(BACKEND_STATE_DIR, 'api-local.pid');

// wrangler dev 的預設埠，與 API_BASE.local 保持一致，不重複寫死一次。
const LOCAL_BACKEND_PORT = Number(new URL(API_BASE.local).port);

// 等後端 /health 回應的輪詢參數:60 秒內每 500ms 探一次。npm run dev(內部
// 跑 wrangler dev)首次啟動要編譯，比純 fetch 探活慢得多，因此逾時給得比
// HEALTH_TIMEOUT_MS 寬鬆非常多。
const BACKEND_HEALTH_POLL_TIMEOUT_MS = 60000;
const BACKEND_HEALTH_POLL_INTERVAL_MS = 500;

// --stop-backend 殺掉行程樹後，等埠真的釋放的輪詢參數。
const BACKEND_STOP_POLL_TIMEOUT_MS = 10000;
const BACKEND_STOP_POLL_INTERVAL_MS = 300;

// log 檔尾端要印的行數，逾時時給使用者判斷卡在哪一步用。
const BACKEND_LOG_TAIL_LINES = 20;

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
    noBackend: false,
    stopBackend: false,
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
      case '--no-backend':
        opts.noBackend = true;
        break;
      case '--stop-backend':
        opts.stopBackend = true;
        break;
      default:
        throw new Error(`不明參數:${arg}`);
    }
  }

  if (opts.help) return opts;

  // --stop-backend 是獨立動作(關掉本腳本先前啟動的後端)，跟「連線目標」
  // 這個維度無關，不需要 --env 也能單獨執行。
  if (opts.stopBackend) return opts;

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

// ---- --env local 自動帶起本機後端 ----

// 純函式:後端目錄的解析順序——環境變數 TCL_API_LOCAL_DIR 優先(跨 repo 的
// 後端路徑本來就因人而異，不該寫死)，否則預設 ~/.threads-clean-link/api-local/api。
// env 與 home 由呼叫端注入(process.env、homedir())，方便測試不必真的設
// 環境變數或動使用者家目錄。
function resolveBackendDir(env, home) {
  const override = env && typeof env.TCL_API_LOCAL_DIR === 'string' ? env.TCL_API_LOCAL_DIR.trim() : '';
  if (override) return override;
  return path.join(home, '.threads-clean-link', 'api-local', 'api');
}

// 純函式:根據探活結果與旗標，決定要不要啟動後端、用什麼指令。目錄是否
// 存在(dirExists／pkgJsonExists)由呼叫端查好再餵進來，這裡不做任何 I/O，
// 方便測試不必真的建立或刪除任何檔案。
function backendStartPlan({ healthy, noBackend, dirExists, pkgJsonExists, backendDir }) {
  if (healthy) return { action: 'skip', reason: 'healthy' };
  if (noBackend) return { action: 'skip', reason: 'no-backend' };
  if (!dirExists || !pkgJsonExists) return { action: 'missing-dir', dir: backendDir };
  return { action: 'start', command: 'npm', args: ['run', 'dev'], cwd: backendDir };
}

// 純函式:解析 PID 檔內容。格式不合法(非數字、非正整數)一律回 null，交由
// 呼叫端當成「PID 檔壞掉／不存在」處理，不丟例外。
function parsePidFile(content) {
  const n = Number(String(content).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 純函式:依平台決定關閉行程樹的方式。Windows 用 taskkill /T 連子行程一起
// 殺(npm/npx 啟動 wrangler 是父子兩層，只殺父行程子行程會被留下並重新把
// 埠佔住)；其他平台用負的 pid 對整個行程群組送信號，等同 process.kill(-pid)。
// 回傳描述而不是直接執行，方便測試斷言「該怎麼殺」而不必真的殺一個行程。
function killTreeCommand(pid, plat) {
  if (plat === 'win32') {
    return { type: 'exec', command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  }
  return { type: 'signal', pid: -pid, signal: 'SIGKILL' };
}

// 依 killTreeCommand 的描述真正執行關閉。exec 分支呼叫外部指令(taskkill)，
// signal 分支直接呼叫 process.kill(-pid)——注入 execFileFn／killFn 讓測試
// 能夠斷言呼叫發生過，不必真的動任何行程。
async function runKillTree(pid, plat, { execFileFn = execFileAsync, killFn = process.kill } = {}) {
  const info = killTreeCommand(pid, plat);
  if (info.type === 'exec') {
    await execFileFn(info.command, info.args);
  } else {
    killFn(info.pid, info.signal);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 純函式:取文字最後 n 行，不論混用 \n／\r\n。結尾的換行不算多一空行。
function tailLines(text, n) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

// 探本機端口是否有人在聽(不看回應內容，只看 TCP 連得上與否)。--stop-backend
// 用它輪詢埠是否真的釋放——比對 /health 更直接，行程被殺的瞬間 fetch 可能
// 收到連線重置以外的各種暫時性錯誤，容易誤判。
function isPortOpen(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// 純函式:決定實際要 spawn 的執行檔／參數／要不要外殼。
//
// Windows 上 npm 是 .cmd 批次檔，直接 spawn 需要 shell:true 才能解析；但
// 現場實測發現 shell:true 疊加 detached:true 時，log 檔永遠是空的——行程
// 本身正常在跑、/health 真的會通，但外殼(cmd.exe)轉手給 npm.cmd、npm.cmd
// 再轉手給實際執行 wrangler 的 node 行程，這兩層轉手讓我們傳給 spawn 的
// stdio 檔案描述子在 Windows 上跟丟(換過 fd 直傳與 cmd.exe 原生 `>` 重導向
// 兩種寫法結果一樣)。反覆比對之後，只有「不經過任何外殼、單一層 spawn 直達
// 目標執行檔」時，detached + fd 重導向才會正常運作(node.exe 本身、或
// cmd.exe 執行內建指令都算單一層，node.exe 再轉手一層 npm.cmd 就不算)。
//
// 因此 Windows 上改成直接用目前這顆 node.exe 執行 npm 自帶的 npm-cli.js
// (跳過 npm.cmd 這層外殼)，找得到才套用;找不到就退回原本的 npm + shell:true
// (行程仍會正常啟動，只是萬一逾時，log 尾段可能是空的)。npmCliExists 由
// 呼叫端查好餵進來，這裡不做任何 I/O。其他平台 npm 本身就是可直接執行的
// 檔案，不需要外殼，也不受這個問題影響。
function resolveBackendSpawnTarget({ command, args, plat, execPath, npmCliExists }) {
  if (command === 'npm' && plat === 'win32') {
    if (npmCliExists) {
      const npmCli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      return { file: execPath, args: [npmCli, ...args], shell: false };
    }
    return { file: command, args, shell: true };
  }
  return { file: command, args, shell: plat === 'win32' };
}

// --env local 主流程用:探活成功就沿用既有後端；失敗且未帶 --no-backend
// 就用 npm run dev 帶起來，等到 /health 通過再回傳。所有 I/O 都走注入的
// deps，預設值是真正的 node:fs／node:child_process／probeHealth，測試可以
// 整組換成假的，不必真的 spawn 一個行程或寫檔案。
async function ensureLocalBackend({ apiBase, noBackend, backendDir, logPath, pidPath, deps = {} }) {
  const {
    probeHealthFn = probeHealth,
    spawnFn = spawn,
    existsSyncFn = existsSync,
    openSyncFn = openSync,
    closeSyncFn = closeSync,
    writeFileSyncFn = writeFileSync,
    readFileSyncFn = readFileSync,
    unlinkSyncFn = unlinkSync,
    platformFn = platform,
    killTreeRunner = runKillTree,
    pollTimeoutMs = BACKEND_HEALTH_POLL_TIMEOUT_MS,
    pollIntervalMs = BACKEND_HEALTH_POLL_INTERVAL_MS,
    sleep = defaultSleep,
  } = deps;

  const healthy = await probeHealthFn(apiBase);

  // 健康或帶 --no-backend 時不必查後端目錄存不存在——省一次不必要的 I/O，
  // 測試也不必為這兩條路徑另外準備假目錄。
  let dirExists = true;
  let pkgJsonExists = true;
  const pkgPath = path.join(backendDir, 'package.json');
  if (!healthy && !noBackend) {
    dirExists = existsSyncFn(backendDir);
    pkgJsonExists = dirExists && existsSyncFn(pkgPath);
  }

  const plan = backendStartPlan({ healthy, noBackend, dirExists, pkgJsonExists, backendDir });

  if (plan.action === 'skip') {
    return { status: plan.reason === 'healthy' ? 'existing' : 'no-backend' };
  }
  if (plan.action === 'missing-dir') {
    return { status: 'missing-dir', dir: plan.dir };
  }

  const plat = platformFn();
  // npmCliExists 只在「命令是 npm 且平台是 win32」才有意義查，其他情況
  // 不必多一次不必要的 existsSyncFn 呼叫(見 resolveBackendSpawnTarget)。
  let npmCliExists = false;
  if (plan.command === 'npm' && plat === 'win32') {
    const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    npmCliExists = existsSyncFn(npmCliPath);
  }
  const target = resolveBackendSpawnTarget({
    command: plan.command,
    args: plan.args,
    plat,
    execPath: process.execPath,
    npmCliExists,
  });

  const logFd = openSyncFn(logPath, 'w');
  let child;
  try {
    child = spawnFn(target.file, target.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      shell: target.shell,
    });
  } finally {
    closeSyncFn(logFd);
  }
  child.unref();
  writeFileSyncFn(pidPath, String(child.pid));

  const deadline = Date.now() + pollTimeoutMs;
  let up = false;
  while (Date.now() < deadline) {
    if (await probeHealthFn(apiBase)) {
      up = true;
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (up) {
    return { status: 'started', pid: child.pid, log: logPath };
  }

  // 逾時:後端沒救了，把剛起的行程樹連根殺掉，不留下一個半死不活佔著埠的
  // wrangler，也不留下指向它的 PID 檔誤導下一次 --stop-backend。
  let tail = '';
  try {
    tail = tailLines(readFileSyncFn(logPath, 'utf8'), BACKEND_LOG_TAIL_LINES);
  } catch {
    // log 檔讀不到就算了，逾時本身已經是要回報的錯誤，缺一段尾巴不致命。
  }
  await killTreeRunner(child.pid, plat).catch(() => {});
  try {
    if (existsSyncFn(pidPath)) unlinkSyncFn(pidPath);
  } catch {
    // 清不掉就算了，不能蓋掉原本要回報的逾時錯誤。
  }

  return { status: 'timeout', log: logPath, tail, pid: child.pid };
}

// --stop-backend 主流程用:讀 PID 檔關掉本腳本先前啟動的後端，並等埠真的
// 釋放。PID 檔不存在時分兩種情況——埠還活著代表後端是別的方式起的，不歸
// 本腳本管；埠已經死了代表本來就沒在跑，兩者都不動任何行程。
async function stopBackend({ pidPath, port, deps = {} }) {
  const {
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    unlinkSyncFn = unlinkSync,
    isPortOpenFn = isPortOpen,
    platformFn = platform,
    killTreeRunner = runKillTree,
    pollTimeoutMs = BACKEND_STOP_POLL_TIMEOUT_MS,
    pollIntervalMs = BACKEND_STOP_POLL_INTERVAL_MS,
    sleep = defaultSleep,
  } = deps;

  const pidFileExists = existsSyncFn(pidPath);
  const pid = pidFileExists ? parsePidFile(readFileSyncFn(pidPath, 'utf8')) : null;

  if (pid === null) {
    const portAlive = await isPortOpenFn(port);
    return portAlive ? { status: 'not-owned' } : { status: 'already-stopped' };
  }

  try {
    await killTreeRunner(pid, platformFn());
  } catch {
    // pid 可能早就不存在(行程自己結束過，PID 檔沒來得及清)，視為已經達成
    // 「後端不在跑」這個目的，不當成失敗。
  }

  try {
    if (existsSyncFn(pidPath)) unlinkSyncFn(pidPath);
  } catch {
    // 刪不掉不影響「後端已關閉」這個結論，不因此中斷。
  }

  const deadline = Date.now() + pollTimeoutMs;
  let released = false;
  while (Date.now() < deadline) {
    if (!(await isPortOpenFn(port))) {
      released = true;
      break;
    }
    await sleep(pollIntervalMs);
  }

  return { status: released ? 'stopped' : 'stop-timeout', pid };
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
        啟動前會先探 /health;探不到且未帶 --no-backend 時，本腳本會自動用
        npm run dev 在後端目錄(預設 ~/.threads-clean-link/api-local/api，
        可用環境變數 TCL_API_LOCAL_DIR 覆寫)背景啟動 wrangler dev，等到
        /health 通過(最多 60 秒)才繼續;逾時會印出 log 檔最後 ${BACKEND_LOG_TAIL_LINES} 行、
        殺掉剛啟動的行程樹並非 0 結束。輸出導向 ${'~/.threads-clean-link/api-local.log'}
        (每次啟動覆寫)，PID 記在 ${'~/.threads-clean-link/api-local.pid'}。
        後端啟動後是常駐的:本腳本結束不會關掉它，之後重跑 --env local
        會直接探到 /health 沿用既有;要關閉用 npm run dev -- --stop-backend。
        找不到後端目錄或其 package.json 時，印現有的手動啟動提示並非 0 結束，
        不會啟動 Chrome。
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
    --no-backend       --env local 探活失敗時不自動啟動後端，維持舊行為:
                        印現有的手動啟動提示並非 0 結束，不會啟動 Chrome
    --stop-backend     關閉本腳本先前用 --env local 啟動的後端(讀 PID 檔、
                        Windows 用 taskkill /T 連子行程一起殺，其他平台對整
                        個行程群組送信號)，等埠釋放後印結果並結束(結束碼 0)。
                        獨立旗標，不需要搭配 --env，也不會啟動 Chrome。找不到
                        PID 檔但埠仍有人在聽，代表後端不是本腳本啟動的，印
                        提示並以非 0 結束，不會動那個行程
    --help, -h         顯示這份說明並結束(結束碼 0)

環境變數:
    TCL_API_LOCAL_DIR  覆寫 --env local 自動啟動後端時使用的目錄(預設
                        ~/.threads-clean-link/api-local/api)，供跨 repo 或
                        自訂路徑使用，不必修改本腳本

切換環境的副作用:
    寫入新的 syncApiBase 之前，若擴充目前指向的是另一個環境，會清掉舊的
    登入與同步狀態(syncAuth／syncState／syncVerifiedAt／syncBackoff 與
    session 的單飛旗標、去抖、nonce)並印一行提示。舊 token 是另一台伺服器
    簽的，留著只會讓同步一直失敗。三個環境互切都適用。

範例:
    node tools/dev-browser.mjs --env local
    node tools/dev-browser.mjs --env local --restart --no-open
    node tools/dev-browser.mjs --env local --no-backend
    node tools/dev-browser.mjs --stop-backend
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

function printBanner({ env, apiBase, profile, port, extensionId, buildCommit, loadPath, backend }) {
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
  // 只有 --env local 才有後端這一行(見 ensureLocalBackend)。不管是沿用既
  // 有還是本腳本剛啟動的，本腳本結束時都不會關掉它——這是刻意的常駐設計，
  // 讓後端跨多次 dev-browner 執行留著，需要關閉時用 --stop-backend。
  if (backend) {
    console.log(
      backend.mode === 'existing'
        ? `後端:        沿用既有（未由本腳本啟動，結束後也不會關閉）`
        : `後端:        已啟動（PID ${backend.pid}，log:${backend.log}；結束後仍會留著，關閉用 npm run dev -- --stop-backend）`
    );
  }
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

// 主流程。help / --stop-backend / 缺 --env / production 守門拒絕 / local
// 後端未就緒 / 載入路徑衝突都只設定 process.exitCode 並提早 return，不丟
// 例外——只有真正非預期的失敗(找不到 dev-build、Chrome 啟動失敗等)才用
// throw 交給外層 catch。
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

  // --stop-backend 是獨立動作，跟 Chrome／production 守門都無關，最先處理
  // 並直接結束，不往下走連線流程。
  if (opts.stopBackend) {
    const result = await stopBackend({ pidPath: BACKEND_PID_PATH, port: LOCAL_BACKEND_PORT });
    if (result.status === 'not-owned') {
      console.error(
        `後端不是本腳本啟動的，請自行關閉（找不到 PID 檔 ${BACKEND_PID_PATH}，但埠 ${LOCAL_BACKEND_PORT} 仍有服務在監聽）。`
      );
      process.exitCode = 1;
      return;
    }
    if (result.status === 'already-stopped') {
      console.log('本機後端目前沒有在執行，無需關閉。');
      process.exitCode = 0;
      return;
    }
    if (result.status === 'stopped') {
      console.log(`已關閉本機後端（PID ${result.pid}），埠 ${LOCAL_BACKEND_PORT} 已釋放。`);
      process.exitCode = 0;
      return;
    }
    // stop-timeout:已經送出關閉指令，但埠遲遲沒放開。
    console.error(
      `已對 PID ${result.pid} 送出關閉指令，但等待埠 ${LOCAL_BACKEND_PORT} 釋放逾時（${BACKEND_STOP_POLL_TIMEOUT_MS / 1000} 秒）。`
    );
    process.exitCode = 1;
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
  // 使用者的 Chrome。--no-backend 維持舊行為(探活失敗就印提示、非 0 結束、
  // 不碰後端)；否則沒帶 --no-backend 時自動用 npm run dev 帶起來，等到
  // /health 通過才繼續。啟動的後端本腳本結束時不會關掉(常駐)，見 printBanner
  // 與 --stop-backend。
  let backendBannerInfo = null;
  if (opts.env === 'local') {
    const result = await ensureLocalBackend({
      apiBase: API_BASE.local,
      noBackend: opts.noBackend,
      backendDir: resolveBackendDir(process.env, homedir()),
      logPath: BACKEND_LOG_PATH,
      pidPath: BACKEND_PID_PATH,
    });

    if (result.status === 'existing') {
      console.log(`本機後端就緒:${API_BASE.local}/health（沿用既有，非本腳本啟動）`);
      backendBannerInfo = { mode: 'existing' };
    } else if (result.status === 'no-backend') {
      console.error(`錯誤:本機後端 ${API_BASE.local}/health 沒有回應。`);
      console.error(START_LOCAL_BACKEND_HINT);
      process.exitCode = 1;
      return;
    } else if (result.status === 'missing-dir') {
      console.error(`錯誤:本機後端 ${API_BASE.local}/health 沒有回應，且找不到後端目錄:${result.dir}`);
      console.error(START_LOCAL_BACKEND_HINT);
      console.error('也可用環境變數 TCL_API_LOCAL_DIR 指向正確的 api-local/api 目錄。');
      process.exitCode = 1;
      return;
    } else if (result.status === 'timeout') {
      console.error(
        `錯誤:自動啟動的本機後端在 ${BACKEND_HEALTH_POLL_TIMEOUT_MS / 1000} 秒內未回應 ${API_BASE.local}/health。`
      );
      console.error(`log 檔（${result.log}）最後 ${BACKEND_LOG_TAIL_LINES} 行:`);
      console.error(result.tail);
      console.error(START_LOCAL_BACKEND_HINT);
      process.exitCode = 1;
      return;
    } else {
      // started
      console.log(`已自動啟動本機後端（PID ${result.pid}，log:${result.log}），已等到 ${API_BASE.local}/health 回應。`);
      backendBannerInfo = { mode: 'started', pid: result.pid, log: result.log };
    }
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
    backend: backendBannerInfo,
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
  BACKEND_STATE_DIR,
  BACKEND_LOG_PATH,
  BACKEND_PID_PATH,
  LOCAL_BACKEND_PORT,
  BACKEND_HEALTH_POLL_TIMEOUT_MS,
  BACKEND_HEALTH_POLL_INTERVAL_MS,
  BACKEND_STOP_POLL_TIMEOUT_MS,
  BACKEND_STOP_POLL_INTERVAL_MS,
  BACKEND_LOG_TAIL_LINES,
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
  resolveBackendDir,
  backendStartPlan,
  parsePidFile,
  killTreeCommand,
  runKillTree,
  resolveBackendSpawnTarget,
  tailLines,
  isPortOpen,
  ensureLocalBackend,
  stopBackend,
  printBanner,
};
