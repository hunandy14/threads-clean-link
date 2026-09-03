// tools/dev-browser.mjs — 一鍵啟動除錯用 Chrome 並載入開發版擴充。
//
// 前提:專用 profile(預設 ~/.threads-clean-link/debug-profile)必須先手動
// 登入過 Google 測試帳號，本腳本不處理登入。dev-build(預設
// ~/.threads-clean-link/dev-build)是主 repo 的另一個 git worktree，本腳本
// 只在指定 --ref 時切換其 HEAD，不建立或初始化該 worktree。
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
//                                 [--build <dir>] [--fresh] [--yes] [--help]
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXPECTED_EXTENSION_ID = 'hehokicokbgajpanjcajhmflaennnmdj';

// 連線目標三選一。local 本波尚未建置，但在解析/help/橫幅裡都當成正式枚舉值
// 列出——之後補齊 local 只需拿掉執行階段的擋下，不必改任何介面。
const ENVIRONMENTS = ['local', 'staging', 'production'];

const API_BASE = {
  staging: 'https://api-staging.metalinkclearer.workers.dev',
  production: 'https://api.metalinkclearer.workers.dev',
};

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
    throw new Error(`--port 必須是正整數，收到:${argv}`);
  }

  return opts;
}

// local 環境本波尚未建置:後端沒有 wrangler dev、dev-build 的 manifest 沒
// 注入 localhost 權限、擴充的 apiBase 白名單也還沒加 local。回傳帶 code 的
// Error，呼叫端據以非 0 結束，不觸碰 Chrome。
function localNotBuiltError() {
  const err = new Error(
    'local 環境尚未建置（需後端 wrangler dev、dev-build manifest 注入 localhost 權限、' +
      '擴充 apiBase 白名單加 local），請先用 `npm run dev:staging`'
  );
  err.code = 'ENV_NOT_BUILT';
  return err;
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

環境說明:
    local
        本波尚未建置。指定後直接印訊息並以非 0 結束，不會啟動 Chrome。
    staging
        寫入 chrome.storage.local.syncApiBase 指向 staging API(${API_BASE.staging})。
        目前唯一可直接跑的環境，對應 npm run dev:staging。
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
    --yes              跳過 production 的互動確認(仍會印警告)
    --help, -h         顯示這份說明並結束(結束碼 0)

範例:
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

// 對指定的 CDP WebSocket endpoint(browser 層級或單一 target 自己的
// webSocketDebuggerUrl)開一條連線，送出一個指令並等對應 id 的回覆，然後關閉。
// WebSocket 開了但對端不回覆(target 已消失、CDP 卡住)時，逾時強制 reject,
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
      finish(reject, new Error(`CDP WebSocket 錯誤:${event.message || event}`));
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

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const sw = await findServiceWorkerTarget(port, extensionId);
    if (sw) return { sw, wakeTargetId: wakeTarget.id };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待擴充 service worker 上線逾時(5 秒)');
}

// 連到 service worker target 自己的 webSocketDebuggerUrl 執行 Runtime.evaluate,
// 不需要額外走 Target.attachToTarget(每個 target 在 /json 裡自帶專屬 debugger
// endpoint，連上去即等同已 attach)。env 只會是 staging 或 production——local
// 在 main() 更早就已經擋下，不會流到這裡。
//
// 回傳值:若本次為了喚醒 SW 開了暫時分頁，回傳該分頁的 target id,讓呼叫端
// 決定是收尾關掉(--no-open)還是沿用成 options 頁;SW 原本就在線則回傳
// undefined。
async function configureApiEnv(port, extensionId, env, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  let sw = await findServiceWorkerTarget(port, extensionId);
  let wakeTargetId;
  if (!sw) {
    console.log('擴充 service worker 尚未上線，開啟 options 頁喚醒 ...');
    ({ sw, wakeTargetId } = await wakeServiceWorker(port, extensionId));
  }

  try {
    // CDP 對「剛啟動」的 service worker 預設會暫停等除錯器接手(即使沒人真
    // 的要下中斷點)，之後送的指令(含 Runtime.evaluate)全部卡在佇列裡，直到
    // 收到 Runtime.runIfWaitingForDebugger 才會繼續執行——這是 sendCdpCommand
    // 逐次開關連線也不受影響的目標層級狀態，對「原本就在線」的 SW 呼叫則是
    // 無害的 no-op，因此不論是否剛喚醒都送一次。
    await sendCdpCommand(sw.webSocketDebuggerUrl, 'Runtime.runIfWaitingForDebugger', {}, timeoutMs);

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
        ? '已設定 API 環境:production(移除 syncApiBase，使用預設值)'
        : `已設定 API 環境:staging(${API_BASE.staging})`
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
//   - open === false:不開頁。若本次為了喚醒 SW 開了暫時分頁，用完即關,
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

function printBanner({ env, apiBase, profile, port, extensionId, buildCommit }) {
  const envLabel = env === 'production' ? '!! PRODUCTION !!' : env;
  console.log('');
  console.log('================ dev-browser 狀態 ================');
  console.log(`環境:        ${envLabel}`);
  console.log(`API 網址:    ${apiBase}`);
  console.log(`Profile:     ${profile}`);
  console.log(`CDP 埠:      ${port}`);
  console.log(`擴充 ID:     ${extensionId}`);
  console.log(`dev-build:   ${buildCommit}`);
  console.log('====================================================');
}

// 主流程。help / 缺 --env / local / production 守門拒絕都只設定
// process.exitCode 並提早 return，不丟例外——只有真正非預期的失敗
// (找不到 dev-build、Chrome 啟動失敗等)才用 throw 交給外層 catch。
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

  if (opts.env === 'local') {
    const err = localNotBuiltError();
    console.error(`錯誤:${err.message}`);
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

  if (!existsSync(opts.build)) {
    throw new Error(`找不到 dev-build 目錄:${opts.build}`);
  }

  if (opts.ref) {
    await switchDevBuildRef(opts.build, opts.ref);
  }

  await ensureChromeRunning(opts);

  const extensionId = await loadUnpackedExtension(opts.port, opts.build);
  await configureApiEnvAndCleanup(opts.port, extensionId, opts.env, opts.open);

  const buildCommit = await getBuildCommit(opts.build);
  printBanner({
    env: opts.env,
    apiBase: API_BASE[opts.env],
    profile: opts.profile,
    port: opts.port,
    extensionId,
    buildCommit,
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
      // Node 在某些版本關閉 WebSocket 後偶爾觸發底層 assertion,
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
  resolveEnv,
  parseArgs,
  productionGuard,
  localNotBuiltError,
  freshProfileDir,
  helpText,
  sendCdpCommand,
  closeTarget,
  configureApiEnv,
  configureApiEnvAndCleanup,
  openOptionsPage,
};
