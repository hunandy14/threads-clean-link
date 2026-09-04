// test/support/settle.js — 六份測試檔(background/clipboard-guard/bridge/
// history-schema/popup/options)曾經各自維護一份逐字相同(僅預設 ms 不同)
// 的 settle() 收斂成這裡一份共用實作，供各檔用 installSettle() 掛載。
//
// 【為什麼不能用固定牆鐘等待】原本的寫法是 await new Promise(r =>
// setTimeout(r, ms))，等一段固定毫秒指望非同步鏈路(chrome.storage mock
// 的 setTimeout(0) 落盤、postMessage 派送、og fetch 逾時競速等)跑完。這
// 在 Windows 上兩頭不討好:作業系統計時器顆粒約 15.6ms，固定 ms 訂太小,
// 機器忙、事件迴圈被其他工作餓死時鏈路還沒跑完就斷言，變成看機器心情的
// 假紅燈；訂太大,鏈路早就跑完了每個 settle() 還是白等到底，整個檔案的
// 耗時被不成比例地放大。
//
// 【改用計時器計數】全域 setTimeout/clearTimeout 包一層，同時記錄兩件
// 事:
//   (a) 只增不減的「累計排程次數」(totalTimersScheduled)。
//   (b) 「目前尚未觸發」的計時器與其排定延遲(pendingTimers: Map<handle,
//       delay>)。
// 兩者缺一不可:
//   - 只看(a)：像 og fetch 逾時競速、toast 自動隱藏這類一開始就排好、
//     中途不會再新增排程的長效計時器，兩輪之間次數不會變，會被誤判成
//     「已經沒事在跑」而提早收尾，等不到它真正觸發。
//   - 只看(b)：0ms 延遲的計時器常常在下一輪輪詢前就已經觸發並從集合中
//     移除，若只看「目前存活」會整個錯過那個瞬間、誤判成從未發生過排程。
// 兩者任一有變化(次數增加，或仍有計時器待觸發)都算「還在動」，連續兩輪
// 都沒有變化才視為鏈路真正跑完並穩定下來——若整條鏈路在 settle() 開始輪
// 詢前就已經跑完(純同步分支、或呼叫端已自行 await 過一次的收尾流程)，
// 兩輪都天生穩定，一樣算數，不強求「這次一定要親眼看到活動」。
//
// 【只等延遲不超過上限的計時器】pendingTimers 記的是「延遲」而不只是
// 「有沒有」，判定「還在動」時只看延遲不超過本次 settle(ms) 逾時上限
// (cap)的那些——這是相對於最早、逐字複製自 background.test.js 的版本
// (用 Set，不分延遲長短一律當「還在動」)的加強:options.js 的 toast 會
// 排一顆 2200ms 的自動隱藏計時器，若不分長短一律當成「還在動」，等於保
// 證等不到、讓每一個發過 toast 的 settle() 白白吃滿上限。這種長效計時器
// 本來就不屬於測試在等的那條鏈路，排除它不影響判準:需要真的等滿長逾時
// 的呼叫點只要把 ms 開大，cap 跟著放大就會重新納入判準。background.js
// 的 og fetch 2.5 秒逾時競速同理，用這個過濾後 settle() 能更快收斂，不
// 必陪它硬等到底。
//
// 【settle(ms) 的時間語意】
//   floor = max(floor(ms / 5), 20) — 穩定後仍至少等這麼久，吸收未經計
//     時器、純微任務完成的收尾工作。
//   cap   = max(ms + 500, 2000)    — 逾時上限，以 ms 為準再留緩衝，涵蓋
//     需要真的等滿內部逾時競速的呼叫點(如 settle(2700))；逾時直接
//     resolve、不吞錯，讓原本的斷言自己失敗，不把逾時偽裝成成功。
//
// 【輪詢用原生 setTimeout】要用 patch 前捕獲的原生 setTimeout 排程，不
// 可用 setImmediate:check phase 在沒有其他 I/O 時不會真的讓出，會在同一
// 個牆鐘毫秒內狂打數十萬次、Date.now() 幾乎不動，必須靠 setTimeout 讓每
// 輪真的推進時間。(曾嘗試用 async_hooks 側錄「目前存活的 Timeout 資
// 源」，但它對全域每一個 Promise/tick 都會觸發回呼，整檔跑下來拖慢兩成
// 以上，改包 setTimeout 本身開銷小得多。)
'use strict';

// installSettle({ defaultMs }) — 在呼叫檔案的全域環境 patch setTimeout /
// clearTimeout(每個呼叫檔各自呼叫一次，各自的 pendingTimers/計數互不
// 干擾)，回傳 { settle(ms), reset() }。defaultMs 對應各檔原本 settle()
// 的預設值(background/history-schema 原為 150，其餘為 30)，讓既有呼叫
// 點 settle()／settle(ms) 的簽名維持不變。reset() 供各檔
// test.beforeEach(reset) 使用:pendingTimers 是整份檔案共用的單一集合，
// 若測試留下一顆未等到的長效計時器(逾時競速、toast 自動隱藏之類)就結
// 束，下一個測試呼叫 settle() 時會誤把這顆與自己無關的舊計時器當成
// 「還在動」，每個測試開始前清空，只保留「這個測試自己造成的排程」。
function installSettle({ defaultMs = 30 } = {}) {
  let totalTimersScheduled = 0;
  const pendingTimers = new Map();
  const nativeSetTimeout = global.setTimeout;
  const nativeClearTimeout = global.clearTimeout;

  global.setTimeout = function trackedSetTimeout(fn, ms, ...args) {
    totalTimersScheduled++;
    const handle = nativeSetTimeout((...cbArgs) => {
      pendingTimers.delete(handle);
      return fn(...cbArgs);
    }, ms, ...args);
    pendingTimers.set(handle, typeof ms === 'number' && isFinite(ms) ? ms : 0);
    return handle;
  };
  global.clearTimeout = function trackedClearTimeout(handle) {
    pendingTimers.delete(handle);
    return nativeClearTimeout(handle);
  };

  function reset() {
    pendingTimers.clear();
  }

  function settle(ms = defaultMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const floor = Math.max(Math.floor(ms / 5), 20);
      const cap = Math.max(ms + 500, 2000);
      let lastCount = totalTimersScheduled;
      let stableTicks = 0;

      function tick() {
        const countChanged = totalTimersScheduled !== lastCount;
        if (countChanged) lastCount = totalTimersScheduled;
        let stillPending = false;
        pendingTimers.forEach((delay) => {
          if (delay <= cap) stillPending = true;
        });
        if (countChanged || stillPending) {
          stableTicks = 0;
        } else {
          stableTicks++;
        }
        const elapsed = Date.now() - start;
        const settled = stableTicks >= 2 && elapsed >= floor;
        if (settled || elapsed >= cap) {
          resolve();
          return;
        }
        nativeSetTimeout(tick, 4);
      }
      nativeSetTimeout(tick, 4);
    });
  }

  return { settle, reset };
}

module.exports = { installSettle };
