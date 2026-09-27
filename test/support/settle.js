// test/support/settle.js — 測試共用的假時間與收斂等待。各檔以
// installSettle() 掛載，取得 settle／advance／advanceUntil／now 四支等待工具與
// 每個測試開始時重新啟用假時間的 reset()。
//
// 【為什麼不用牆鐘】chrome.storage 替身每一步都以 setTimeout(0) 落盤、
// postMessage 派送也經 setTimeout 排程，牆鐘等待在 Windows 上兩頭不討好：作
// 業系統計時器顆粒約 15.6ms，每一步 0ms 計時器都可能吃掉一整格；og fetch
// 2.5 秒逾時競速、橋接 2500ms 逾時、sync 2 秒去抖這類長計時器更得真的等滿；
// 固定毫秒訂小了機器忙時等不完、訂大了閒時白等。這裡以 node:test 的
// mock.timers 接管 setTimeout／setInterval，時間改由本檔推進，「等計時器」
// 不再花牆鐘。
//
// 【虛擬時鐘】虛擬現在 = 牆鐘經過時間 + 累計跳躍量（整數毫秒），永遠不比牆
// 鐘慢：
//   - 不在任何等待工具裡時，到期的計時器照牆鐘節奏觸發（0ms 計時器立即觸
//     發）。測試直接 await storage.get() 之類的寫法與真實計時器行為相同，不
//     會卡住。
//   - settle／advance／advanceUntil 期間，下一顆計時器只要落在各自允許的窗
//     口內，時鐘就直接跳到它的到期點觸發，不等牆鐘。
// 延遲的相對先後完全保留：誰先到期誰先觸發。逾時競速、延遲 storage 撐開讀
// 改寫視窗這類競態仍由假時間的先後決定，不會被壓成同一個 tick。
//
// 【一次只觸發一顆】mock.timers.tick() 會把同一時點到期的計時器在同一個同
// 步迴圈裡連續呼叫，中間不清微任務；真實 Node 則每顆回呼之後都先清空微任
// 務。為保住這個時序，交給 mock 的回呼只負責把計時器排進就緒佇列，真正的
// 回呼由驅動迴圈逐顆執行，每顆之間以原生 setImmediate 讓出一次，微任務必
// 然清空；就緒後才被 clearTimeout 的計時器從佇列移除，不會誤觸發。
//
// 【settle(ms) 的收斂判準】累計排程次數有變、就緒佇列不空、或窗口內仍有待
// 觸發計時器都算「還在動」，連續三輪（每輪一次原生 setImmediate）都不動才收
// 尾。只看「目前還有沒有計時器」會漏掉在兩輪之間就排定又觸發完的 0ms 計時
// 器，所以累計次數與待觸發集合兩者都要看；純微任務的收尾工作在每輪
// setImmediate 之前必然清空，不需要額外的最短等待。
//   - 虛擬窗口 = ms + 500，只觸發到期點嚴格小於「進入 settle 時的虛擬現在 +
//     窗口」的計時器。窗口外的長計時器（toast 2200ms 自動隱藏、sync 2 秒去
//     抖等）不觸發，不屬於測試在等的那條鏈路；真要等長逾時的呼叫點把 ms 開
//     大即可（如 og 2.5 秒逾時競速用 settle(2700)）。
//   - 牆鐘上限 = max(ms + 500, 2000)，防止 0ms 計時器無窮自我重排時卡死；逾
//     時直接 resolve、不吞錯，讓原本的斷言自己失敗，不把逾時偽裝成成功。
//
// 【生命週期】reset()（各檔 test.beforeEach(reset)）在每個測試開始時重新啟
// 用 mock.timers；本檔自行註冊 afterEach／after 停用並丟棄殘留計時器，上一個
// 測試遺留的長計時器不會跨測試觸發。全域 setTimeout 等四支在安裝時就換成常
// 駐的分派函式，未啟用假時間時（測試之外）一律轉給原生計時器。每個呼叫檔
// 各自安裝一次，各檔的狀態互不干擾。
//
// 【限制】本檔只接管 setTimeout／setInterval，任何 realm 的 Date.now 都是牆
// 鐘，不隨虛擬時鐘跳躍；AbortSignal.timeout 走 Node 內部計時器，也不受影響。依賴真實 I/O（本機 HTTP 伺服器、非同步
// 檔案讀寫等）的檔案不應掛載本檔：settle() 看不到 I/O，會在回應抵達前就收
// 尾。
'use strict';

// installSettle({ defaultMs }) — defaultMs 是 settle() 不給參數時的 ms（各檔
// 沿用原本的預設值：background／history-schema 為 150，其餘為 30）。
// advanceUntil() 允許虛擬時鐘推進的上限（毫秒），超過即判定 promise 不會落地。
const ADVANCE_UNTIL_LIMIT_MS = 60000;

function installSettle({ defaultMs = 30 } = {}) {
  const nodeTest = require('node:test');
  const { mock } = nodeTest;
  const { performance } = require('node:perf_hooks');
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;
  const nativeSetInterval = global.setInterval;
  const nativeClearInterval = global.clearInterval;
  const nativeSetImmediate = global.setImmediate;
  const realNow = () => performance.now();
  const immediate = () => new Promise((resolve) => nativeSetImmediate(resolve));

  let active = false;
  // 每次啟用遞增；停用後仍在跑的舊驅動迴圈看到世代不符就退出。
  let generation = 0;
  let mockApi = null;
  // 已排程、尚未觸發的假計時器：handle → { due, interval, fn, args }。
  const timers = new Map();
  // mock 已判定到期、等待驅動迴圈逐顆執行的 handle。
  let ready = [];
  let totalScheduled = 0;
  // mock.timers 內部時鐘（相對啟用時點，毫秒）。
  let mockNow = 0;
  // 虛擬現在 = floor(realNow()) + offset，一律是整數毫秒（offset 與延遲都取
  // 整數），到期點與經過量的比較不受浮點誤差影響。
  let offset = 0;
  // settle() 期間允許直接跳過去觸發的虛擬時點上限（不含）。
  let horizon = -Infinity;
  let driving = false;
  let wake = null;

  const virtualNow = () => Math.floor(realNow()) + offset;

  function normalizeDelay(ms) {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // 把 mock 時鐘推到 to（不倒退）：途中到期的計時器依到期先後排進 ready。
  function advanceMock(to) {
    const delta = Math.max(0, to - mockNow);
    mock.timers.tick(delta);
    mockNow += delta;
  }

  function schedule(kind, fn, ms, args) {
    // 先把 mock 時鐘對齊虛擬現在，新計時器的到期點才以「此刻」起算，不會
    // 排到先前排定、實際更早到期的計時器前面。
    advanceMock(virtualNow());
    const delay = normalizeDelay(ms);
    totalScheduled++;
    const entry = { due: mockNow + delay, interval: kind === 'interval' ? delay : 0, fn, args };
    const onFire = () => {
      ready.push(handle);
      if (entry.interval) entry.due += entry.interval;
    };
    const handle =
      kind === 'interval' ? mockApi.setInterval(onFire, delay) : mockApi.setTimeout(onFire, delay);
    timers.set(handle, entry);
    kick();
    return handle;
  }

  function cancel(handle, kind) {
    if (timers.has(handle)) {
      timers.delete(handle);
      ready = ready.filter((h) => h !== handle);
      if (kind === 'interval') mockApi.clearInterval(handle);
      else mockApi.clearTimeout(handle);
      return undefined;
    }
    return kind === 'interval' ? nativeClearInterval(handle) : nativeClearTimeout(handle);
  }

  const dispatch = {
    setTimeout(fn, ms, ...args) {
      return active ? schedule('timeout', fn, ms, args) : nativeSetTimeout(fn, ms, ...args);
    },
    clearTimeout(handle) {
      return cancel(handle, 'timeout');
    },
    setInterval(fn, ms, ...args) {
      return active ? schedule('interval', fn, ms, args) : nativeSetInterval(fn, ms, ...args);
    },
    clearInterval(handle) {
      return cancel(handle, 'interval');
    },
  };
  function installDispatch() {
    global.setTimeout = dispatch.setTimeout;
    global.clearTimeout = dispatch.clearTimeout;
    global.setInterval = dispatch.setInterval;
    global.clearInterval = dispatch.clearInterval;
  }
  installDispatch();

  function earliestDue() {
    let min = null;
    timers.forEach((entry, handle) => {
      if (ready.includes(handle)) return;
      if (min === null || entry.due < min) min = entry.due;
    });
    return min;
  }

  function runOne(handle) {
    const entry = timers.get(handle);
    if (!entry) return;
    if (!entry.interval) timers.delete(handle);
    try {
      entry.fn(...entry.args);
    } catch (err) {
      // 與真實計時器一致：回呼丟出的例外成為未捕捉例外，由測試框架判紅。
      nativeSetImmediate(() => {
        throw err;
      });
    }
  }

  function kick() {
    if (wake) wake();
    if (!driving) drive();
  }

  // 以原生計時器睡到 ms 之後；kick() 可提早喚醒。
  function sleepReal(ms) {
    return new Promise((resolve) => {
      const timer = nativeSetTimeout(done, Math.max(1, Math.ceil(ms)));
      function done() {
        nativeClearTimeout(timer);
        if (wake === done) wake = null;
        resolve();
      }
      wake = done;
    });
  }

  // 驅動迴圈：逐顆執行就緒計時器；沒有就緒時，下一顆若已到期（牆鐘追上）或
  // 落在 settle 窗口內就推進 mock 時鐘觸發，否則以原生計時器睡到它到期（新
  // 排程或新的 settle 會提早喚醒重算）。沒有任何待觸發計時器就結束，下次排
  // 程再啟動。
  async function drive() {
    driving = true;
    const mine = generation;
    try {
      while (active && mine === generation) {
        await immediate();
        if (!active || mine !== generation) break;
        if (ready.length) {
          runOne(ready.shift());
          continue;
        }
        const next = earliestDue();
        if (next === null) break;
        const now = virtualNow();
        if (next <= now) {
          advanceMock(next);
          continue;
        }
        if (next < horizon) {
          offset += next - now;
          advanceMock(next);
          continue;
        }
        await sleepReal(next - now);
      }
    } finally {
      if (mine === generation) driving = false;
    }
  }

  function disable() {
    if (!active) return;
    active = false;
    generation++;
    driving = false;
    if (wake) wake();
    timers.clear();
    ready = [];
    horizon = -Infinity;
    mock.timers.reset();
    installDispatch();
  }

  function enable() {
    disable();
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    // enable() 把全域換成 mock 版本；取下來自用，全域換回常駐分派函式。
    mockApi = {
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
      setInterval: global.setInterval,
      clearInterval: global.clearInterval,
    };
    installDispatch();
    mockNow = 0;
    offset = -Math.floor(realNow());
    active = true;
  }

  nodeTest.afterEach(disable);
  nodeTest.after(disable);

  async function settle(ms = defaultMs) {
    const cap = Math.max(ms + 500, 2000);
    const span = ms + 500;
    if (!active) {
      // 測試之外（未啟用假時間）退回牆鐘等待。
      await new Promise((resolve) => nativeSetTimeout(resolve, ms));
      return;
    }
    const mine = generation;
    const realStart = realNow();
    const limit = virtualNow() + span;
    horizon = Math.max(horizon, limit);
    kick();
    let lastCount = totalScheduled;
    let stable = 0;
    try {
      while (active && mine === generation && realNow() - realStart < cap) {
        await immediate();
        const next = earliestDue();
        const busy =
          ready.length > 0 || (next !== null && next < limit) || totalScheduled !== lastCount;
        lastCount = totalScheduled;
        if (busy) {
          stable = 0;
          if (!driving) drive();
        } else if (++stable >= 3) {
          break;
        }
      }
    } finally {
      if (mine === generation && horizon === limit) horizon = -Infinity;
    }
  }

  // advance(ms)：假時間版的「睡 ms 毫秒」。虛擬時鐘恰好前進 ms，途中到期的
  // 計時器依先後逐顆觸發，時點之後的一顆都不動；對應牆鐘寫法
  // await new Promise((r) => setTimeout(r, ms))，但不花牆鐘。
  async function advance(ms) {
    if (!active) {
      await new Promise((resolve) => nativeSetTimeout(resolve, ms));
      return;
    }
    const mine = generation;
    let bound = -Infinity;
    try {
      await new Promise((resolve) => {
        const handle = schedule('timeout', resolve, ms, []);
        bound = timers.get(handle).due + 1;
        horizon = Math.max(horizon, bound);
        kick();
      });
    } finally {
      if (mine === generation && horizon === bound) horizon = -Infinity;
    }
  }

  // advanceUntil(promise)：等 promise 落地，期間下一顆計時器只要落在虛擬時間
  // 上限（ADVANCE_UNTIL_LIMIT_MS）內就直接跳過去觸發。供「呼叫本身就卡在內部
  // 逾時上」的寫法使用（例如 await 一個要等 2.5 秒逾時才 resolve 的 API）：牆
  // 鐘寫法是直接 await 它、真的等滿，這裡改成假時間推進到它落地為止。promise
  // 落地後（同一輪微任務內）窗口即撤銷，之後到期的計時器不會被順手觸發。
  // promise 永不落地時，虛擬時鐘推過上限、或上限內已沒有計時器可觸發，都會
  // 拋出帶訊息的錯誤，而不是一路掛到測試框架逾時。
  async function advanceUntil(promise) {
    if (!active) return promise;
    const mine = generation;
    const limit = virtualNow() + ADVANCE_UNTIL_LIMIT_MS;
    let settled = false;
    const tracked = Promise.resolve(promise).finally(() => {
      settled = true;
    });
    horizon = limit;
    kick();
    try {
      // 看門狗：每輪讓出一次，promise 未落地而上限內已無計時器可推進時判定卡死。
      const watchdog = (async () => {
        let idle = 0;
        while (!settled && mine === generation) {
          await immediate();
          if (settled) return;
          const next = earliestDue();
          const stuck = ready.length === 0 && (next === null || next >= limit);
          idle = stuck ? idle + 1 : 0;
          if (idle >= 3) {
            throw new Error(
              'advanceUntil：虛擬時間推進 ' + ADVANCE_UNTIL_LIMIT_MS + 'ms 內 promise 仍未落地'
            );
          }
        }
      })();
      return await Promise.race([tracked, watchdog.then(() => tracked)]);
    } finally {
      if (mine === generation && horizon === limit) horizon = -Infinity;
    }
  }

  // now()：虛擬現在（毫秒）。量測「某段呼叫花了多久」時取代 Date.now()，
  // 讀到的是假時間的經過量。
  function now() {
    return active ? virtualNow() : Date.now();
  }

  return { settle, reset: enable, advance, advanceUntil, now };
}

module.exports = { installSettle };
