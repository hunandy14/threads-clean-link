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
// 個 id 無害)。全程只印狀態，不印任何 chrome.storage 內容(可能含登入
// token)。
//
// 用法:
//     node tools/dev-browser.mjs [--ref <git ref>] [--api staging|production]
//                                 [--no-open] [--port <port>] [--profile <dir>]
//                                 [--build <dir>]
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXPECTED_EXTENSION_ID = 'hehokicokbgajpanjcajhmflaennnmdj';
const API_BASE = {
  staging: 'https://api-staging.metalinkclearer.workers.dev',
  production: 'https://api.metalinkclearer.workers.dev',
};

function parseArgs(argv) {
  const opts = {
    ref: null,
    api: 'staging',
    open: true,
    port: 9222,
    profile: path.join(homedir(), '.threads-clean-link', 'debug-profile'),
    build: path.join(homedir(), '.threads-clean-link', 'dev-build'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--ref':
        opts.ref = argv[++i];
        break;
      case '--api':
        opts.api = argv[++i];
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
      default:
        throw new Error(`不明參數:${arg}`);
    }
  }
  if (opts.api !== 'staging' && opts.api !== 'production') {
    throw new Error(`--api 只接受 staging 或 production，收到:${opts.api}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0) {
    throw new Error(`--port 必須是正整數，收到:${argv}`);
  }
  return opts;
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

// 對指定的 CDP WebSocket endpoint(browser 層級或單一 target 自己的
// webSocketDebuggerUrl)開一條連線，送出一個指令並等對應 id 的回覆，然後關閉。
function sendCdpCommand(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // 忽略關閉時的錯誤，收尾交給呼叫端的 exit timer。
      }
      fn(value);
    };

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
// endpoint，連上去即等同已 attach)。
async function configureApiEnv(port, extensionId, api) {
  let sw = await findServiceWorkerTarget(port, extensionId);
  if (!sw) {
    console.log('擴充 service worker 尚未上線，開啟 options 頁喚醒 ...');
    ({ sw } = await wakeServiceWorker(port, extensionId));
  }

  const expression =
    api === 'production'
      ? "chrome.storage.local.remove('syncApiBase')"
      : `chrome.storage.local.set({syncApiBase: ${JSON.stringify(API_BASE[api])}})`;

  await sendCdpCommand(sw.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `(async () => { ${expression}; })()`,
    awaitPromise: true,
  });

  console.log(
    api === 'production'
      ? '已設定 API 環境:production(移除 syncApiBase，使用預設值)'
      : `已設定 API 環境:staging(${API_BASE.staging})`
  );
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.build)) {
    throw new Error(`找不到 dev-build 目錄:${opts.build}`);
  }

  if (opts.ref) {
    await switchDevBuildRef(opts.build, opts.ref);
  }

  await ensureChromeRunning(opts);

  const extensionId = await loadUnpackedExtension(opts.port, opts.build);
  await configureApiEnv(opts.port, extensionId, opts.api);

  if (opts.open) {
    await openOptionsPage(opts.port, extensionId);
  }

  console.log('完成。');
}

main()
  .then(() => {
    // Node 在某些版本關閉 WebSocket 後偶爾觸發底層 assertion,
    // 延遲一拍再結束程序以避開。
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error(`錯誤:${err.message}`);
    setTimeout(() => process.exit(1), 100);
  });
