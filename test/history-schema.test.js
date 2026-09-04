// test/history-schema.test.js — history 資料層對齊雲端 schema 的行為契約
// （車道 C）。目標實作尚未存在，本檔為紅燈骨架。
//
// 規格出處（唯一真相源）：docs/cloud-sync.md 第 4 節資料模型（4.1 新
// 欄位、4.2 storage key、4.3 欄位映射）與第 2 節 D3／D4／D11。條號 S1-S6
// 對應派工單的規格分節，每個測試頂部註解標明所測條號。
//
// 本檔涵蓋：
//   - S1：entry 新欄位（id／postKey／original／receivedAt／dirty／
//     serverUpdatedAt／deletedAt）的型別與取值規則
//   - S2：一次性遷移 migrateHistorySchema()（onInstalled，先 merge 再
//     schema，同一條 historyWriteChain），含冪等與髒資料
//   - S5：syncState／syncAuth 預設值、normalizeSyncState、toSyncItem／
//     fromSyncItem 雙向映射
//   - S6：配額裁切時墓碑優先淘汰、配額錯誤優雅降級
// S3（recordHistory 寫入路徑）在 test/background.test.js，S4（options 的
// 刪除／清空／匯入匯出）在 test/options.test.js。
//
// 【realm 紀律】background.js 經 vm sandbox 載入，storage 內的物件與本檔
// 的字面量不同 realm，deepStrictEqual 會因 prototype 檢查誤判——涉及
// storage 內容一律逐欄比對，或先 Array.from 換回本 realm。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInSandbox, createChromeStorage } = require('./support/helpers');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

// background.js 依賴 i18n 與 tcl-core（真實環境靠 importScripts），測試把三
// 支腳本接在同一個 sandbox 全域內執行（同 test/background.test.js）。
const SRC =
  fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'tcl-core.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';
const OTHER_URL = 'https://www.threads.com/@other/post/OtherPostId';
const SHARE_URL = 'https://www.threads.com/share/AbCdEfGhI';
const NO_OG_HTML = '<html><head></head><body></body></html>';

// UUID v4 字串樣式（S1：id 為 UUID v4）。版本位固定 4、variant 位為
// 8/9/a/b，實作用 crypto.randomUUID() 或自製生成器都必須吻合。
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// S1 的七個新欄位，遷移／寫入路徑都以這一份為準。
const NEW_FIELDS = ['id', 'postKey', 'original', 'receivedAt', 'dirty', 'serverUpdatedAt', 'deletedAt'];

// settle() 原本用固定牆鐘等待非同步鏈路(遷移/寫入路徑經 chrome.storage
// mock 的 setTimeout(0) 落盤，og fetch 補強經 fetchOgFieldsForLocalKind 的
// setTimeout 逾時競速)跑完;機器忙時固定 ms 等不到鏈路跑完就斷言，閒時又
// 白等。改用計時器計數，作法逐字移植自 test/background.test.js 的同名
// helper——本檔經 runInSandbox 載入同一份 background.js(含 fetchOgFields-
// ForLocalKind 的長效逾時計時器與 TCLSync 引擎的 setTimeout 注入)，需要與
// background.test.js 一致的保護:全域 setTimeout/clearTimeout 包一層，同
// 時記錄(a)只增不減的「累計排程次數」與(b)「目前尚未觸發」的計時器集合，
// 任一有變化都算「還在動」，連續兩輪都沒有變化才視為鏈路真正跑完並穩定
// 下來。輪詢用原生 setTimeout(不可用 setImmediate，check phase 沒有其他
// I/O 時不會真的讓出，Date.now() 幾乎不動)，穩定後仍至少等原 ms 的一小部
// 分，逾時上限以 ms 為準再留緩衝，超時直接 resolve、不吞錯，讓原本的斷言
// 自己失敗。
let totalTimersScheduled = 0;
const pendingTimers = new Set();
const nativeSetTimeout = global.setTimeout;
const nativeClearTimeout = global.clearTimeout;
global.setTimeout = function trackedSetTimeout(fn, ms, ...args) {
  totalTimersScheduled++;
  const handle = nativeSetTimeout((...cbArgs) => {
    pendingTimers.delete(handle);
    return fn(...cbArgs);
  }, ms, ...args);
  pendingTimers.add(handle);
  return handle;
};
global.clearTimeout = function trackedClearTimeout(handle) {
  pendingTimers.delete(handle);
  return nativeClearTimeout(handle);
};
// pendingTimers 是整份檔案共用的單一集合，每個測試開始前清空，只保留「這
// 個測試自己造成的排程」，避免上一個測試留下的計時器干擾下一次 settle()。
test.beforeEach(() => {
  pendingTimers.clear();
});

function settle(ms = 150) {
  return new Promise((resolve) => {
    const start = Date.now();
    const floor = Math.max(Math.floor(ms / 5), 20);
    const cap = Math.max(ms + 500, 2000);
    let lastCount = totalTimersScheduled;
    let stableTicks = 0;

    function tick() {
      const countChanged = totalTimersScheduled !== lastCount;
      if (countChanged) lastCount = totalTimersScheduled;
      const stillPending = pendingTimers.size > 0;
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

// service worker 全域本來就有 crypto（randomUUID 是 SW 可用的 API），
// sandbox 一併注入，讓實作可以直接呼叫 crypto.randomUUID()。
function makeSandboxGlobals(chrome, fetchImpl) {
  return {
    chrome,
    fetch: fetchImpl,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
  };
}

// 只驅動 onInstalled（遷移）的載入器：比照 background.test.js 的
// loadBackgroundForMigration，另外注入 crypto。
// 本擴充自己的 id。訊息入口只認 sender.id（見 background.js 的
// isOwnExtensionSender），mock 與送出的 sender 都以這一枚為準。
const EXT_ID = 'test-extension-id';
// 自己人送來的 sender：content script（bridge.js）與擴充頁面都長這樣。
const OWN_SENDER = { id: EXT_ID };

function loadBackgroundForMigration(localHistory, localExtra) {
  const onInstalledListeners = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => onInstalledListeners.push(fn) },
      onMessage: { addListener: () => {} },
      // sender.id 的比對基準：訊息入口只接受本擴充自己送來的訊息。
      id: EXT_ID,
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{}] },
    tabs: { TAB_ID_NONE: -1, query: async () => [] },
  };
  const localSeed = Object.assign({}, localExtra || {});
  if (localHistory) localSeed.history = localHistory;
  const storage = createChromeStorage({ saveHistory: true }, localSeed);
  chrome.storage = storage.api;
  runInSandbox(
    SRC,
    makeSandboxGlobals(chrome, async () => {
      throw new Error('unexpected fetch');
    })
  );

  return {
    storage,
    fireInstalled(details) {
      onInstalledListeners.slice().forEach((fn) => fn(details || { reason: 'update' }));
    },
  };
}

// 只驅動 cleanedNotice（recordHistory）的載入器：S6 的裁切測試要走真正的
// 寫入路徑，不能只測遷移。
function loadBackgroundForRecord(localHistory) {
  const onMessageListeners = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
      // sender.id 的比對基準：訊息入口只接受本擴充自己送來的訊息。
      id: EXT_ID,
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1 },
  };
  const storage = createChromeStorage({ saveHistory: true }, localHistory ? { history: localHistory } : {});
  chrome.storage = storage.api;
  // cleanedNotice 一律經 fetchOgFieldsForLocalKind 對貼文頁補一次 og
  // fetch，這裡一律回無 og 的最小 HTML（欄位維持呼叫端傳入的值）。
  const fetchImpl = async (url) => ({ url, text: async () => NO_OG_HTML });
  runInSandbox(SRC, makeSandboxGlobals(chrome, fetchImpl));

  return {
    storage,
    sendRuntimeMessage(message) {
      onMessageListeners.slice().forEach((fn) => fn(message, OWN_SENDER, () => {}));
    },
  };
}

// 一筆「已完整具備新欄位」的條目（S1 形狀），供冪等／短路測試當基準。
function equippedEntry(url, at, overrides) {
  return Object.assign(
    {
      url: url,
      kind: 'share',
      at: at,
      seen: [{ at: at, kind: 'share' }],
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      postKey: C.postKeyOf(url),
      original: url,
      receivedAt: at,
      dirty: false,
      serverUpdatedAt: null,
      deletedAt: null,
    },
    overrides || {}
  );
}

// ============================================================
// S1 ＋ S2：一次性遷移 migrateHistorySchema()
// ============================================================

// S1／S2：缺新欄位的舊卡補齊七個新欄位，既有欄位（url/kind/at/seen/
// author/handle/excerpt/removedParams）原樣保留不動。
test('S1/S2 遷移:缺新欄位的舊卡補齊七個新欄位，既有欄位原樣保留', async () => {
  const base = 1700000000000;
  const old = {
    url: CLEAN_URL,
    kind: 'icon',
    at: base,
    seen: [{ at: base - 5000, kind: 'share' }, { at: base, kind: 'icon' }],
    author: 'Dafu Coding',
    handle: '@dafucoding',
    excerpt: '今天天氣真好',
    removedParams: [{ key: 'xmt', value: 'AQGabc' }],
  };
  const bg = loadBackgroundForMigration([old]);

  bg.fireInstalled({ reason: 'update' });
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '遷移不得改變筆數');
  const e = history[0];

  // 既有欄位原樣保留。
  assert.equal(e.url, CLEAN_URL);
  assert.equal(e.kind, 'icon');
  assert.equal(e.at, base);
  assert.equal(e.author, 'Dafu Coding');
  assert.equal(e.handle, '@dafucoding');
  assert.equal(e.excerpt, '今天天氣真好');
  assert.deepEqual(Array.from(e.seen, (s) => s.at), [base - 5000, base]);
  assert.equal(e.removedParams.length, 1);
  assert.equal(e.removedParams[0].key, 'xmt');

  // 新欄位補齊。
  assert.match(e.id, UUID_V4, 'id 應為 UUID v4 字串');
  assert.equal(e.postKey, C.postKeyOf(CLEAN_URL), 'postKey 應由 TCLCore.postKeyOf 算出並持久化');
  assert.equal(e.original, CLEAN_URL, 'original 缺席時以 url 補值（伺服器必填，缺席整筆會被靜默丟棄）');
  assert.equal(e.receivedAt, base - 5000, 'receivedAt 取 seen 最早事件的 at');
  assert.equal(e.dirty, true, '遷移補齊的資料尚未上傳，dirty 為 true');
  assert.equal(e.serverUpdatedAt, null);
  assert.equal(e.deletedAt, null);
  NEW_FIELDS.forEach((f) => assert.equal(f in e, true, `新欄位 ${f} 必須存在（不得只補一部分）`));
});

// S1／S2：既有 original 不得被 url 覆蓋——只有「缺席」才補 url。
test('S1/S2 遷移:既有 original 保留，不被 url 覆蓋', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    { url: CLEAN_URL, kind: 'share', at: base, original: SHARE_URL, seen: [{ at: base, kind: 'share' }] },
  ]);

  bg.fireInstalled();
  await settle();

  const e = bg.storage.localSnapshot().history[0];
  assert.equal(e.original, SHARE_URL, 'original 有值時原樣保留');
  assert.match(e.id, UUID_V4, '其餘新欄位照樣補齊（排除「整支遷移沒接上」的假綠燈）');
});

// S1／S2：receivedAt 的定義是「seen 最早事件的 at」，不是「seen[0].at」。
// 真實資料在多次合併／匯入之後 seen 未必已排序（unionSeenEvents 會排，但
// 匯入檔與手動編輯過的 storage 不保證），取 min 才符合「最早事件」。
test('S1/S2 遷移:receivedAt 取 seen 最早事件的 at（seen 未排序時取最小，不是 seen[0]）', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    {
      url: CLEAN_URL,
      kind: 'share',
      at: base,
      seen: [{ at: base, kind: 'icon' }, { at: base - 9000, kind: 'share' }, { at: base - 3000, kind: 'strip' }],
    },
  ]);

  bg.fireInstalled();
  await settle();

  assert.equal(bg.storage.localSnapshot().history[0].receivedAt, base - 9000);
});

// S2：seen 髒資料三態——缺席、空陣列、at 全非有限數字，一律退回 entry 的
// at（entrySeenEvents 對缺席會以 at 補種一筆，空陣列與全髒則沒有任何可用
// 事件，兩者都不能讓 receivedAt 變成 undefined／NaN）。
test('S2 遷移:seen 缺席／空陣列／at 全非數字時，receivedAt 等於 entry 的 at', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    { url: CLEAN_URL, kind: 'share', at: base }, // seen 缺席
    { url: OTHER_URL, kind: 'share', at: base - 1000, seen: [] }, // 空陣列
    {
      url: 'https://www.threads.com/@third/post/ThirdPostId',
      kind: 'share',
      at: base - 2000,
      seen: [{ at: 'x', kind: 'share' }, { at: Infinity }, null],
    },
  ]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 3);
  assert.equal(history[0].receivedAt, base, 'seen 缺席 → 取 entry 的 at');
  assert.equal(history[1].receivedAt, base - 1000, 'seen 為空陣列 → 取 entry 的 at');
  assert.equal(history[2].receivedAt, base - 2000, 'seen 全為髒資料 → 取 entry 的 at');
  history.forEach((e) => assert.equal(typeof e.receivedAt, 'number'));
});

// S2：seen 只有部分髒掉時只忽略壞的那幾筆，receivedAt 取剩餘事件的最早
// 一筆（不是整組作廢退回 at，也不是把 'x' 當 0）。
test('S2 遷移:seen 含非數字 at 的髒資料時只忽略該筆，receivedAt 取剩餘最早', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    {
      url: CLEAN_URL,
      kind: 'share',
      at: base,
      seen: [{ at: 'x', kind: 'share' }, { at: base - 4000, kind: 'share' }, { at: base, kind: 'icon' }],
    },
  ]);

  bg.fireInstalled();
  await settle();

  assert.equal(bg.storage.localSnapshot().history[0].receivedAt, base - 4000);
});

// S2 冪等：第二次執行零寫入，且第一次生成的 id 不得被重新生成——id 是雲端
// 卡片的身分，每次更新都換一次等於每次都在雲端多開一張卡。
test('S2 遷移冪等:第二次執行零寫入，且既有 id 不被重新生成', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    { url: CLEAN_URL, kind: 'share', at: base, seen: [{ at: base, kind: 'share' }] },
    { url: OTHER_URL, kind: 'icon', at: base - 1000, seen: [{ at: base - 1000, kind: 'icon' }] },
  ]);

  bg.fireInstalled();
  await settle();
  const firstWrites = bg.storage.localCalls.set.length;
  const afterFirst = bg.storage.localSnapshot().history;
  const ids = Array.from(afterFirst, (e) => e.id);
  assert.equal(firstWrites, 1, '缺新欄位的舊資料，第一次遷移應寫回一次');
  assert.equal(ids.length, 2);
  ids.forEach((id) => assert.match(id, UUID_V4));
  assert.notEqual(ids[0], ids[1], '兩筆各自生成不同的 id');

  bg.fireInstalled();
  await settle();

  const afterSecond = bg.storage.localSnapshot().history;
  assert.equal(bg.storage.localCalls.set.length, firstWrites, '第二次執行零寫入');
  assert.deepEqual(Array.from(afterSecond, (e) => e.id), ids, 'id 不得被重新生成');
  assert.deepEqual(Array.from(afterSecond, (e) => e.receivedAt), Array.from(afterFirst, (e) => e.receivedAt));
});

// S2：整表都已具備新欄位時，每一筆維持原物件參照，遷移據此短路、連寫回都
// 不做（沿用 migrateHistoryMerge 已有的「每筆皆原參照即短路」判定）。對照
// 組同時釘住「遷移確實接上了 onInstalled」，排除「整支沒接上所以當然不寫」
// 的假綠燈。
test('S2 遷移:已含全部新欄位的 entry 保留原物件參照，整表皆是時不寫回', async () => {
  const base = 1700000000000;
  const a = equippedEntry(CLEAN_URL, base, { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  const b = equippedEntry(OTHER_URL, base - 1000, { id: 'ffffffff-1111-4222-9333-444444444444' });
  const bg = loadBackgroundForMigration([a, b]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(bg.storage.localCalls.set.length, 0, '已是目標形狀時不得整表寫入');
  assert.equal(history[0], a, '原物件參照保留');
  assert.equal(history[1], b);
  assert.equal(history[0].dirty, false, 'dirty=false 的已同步條目不得被遷移重新標髒');

  // 對照組:同一個載入器、只差資料缺新欄位，就必須寫回一次。
  const stale = loadBackgroundForMigration([{ url: CLEAN_URL, kind: 'share', at: base, seen: [{ at: base, kind: 'share' }] }]);
  stale.fireInstalled();
  await settle();
  assert.equal(stale.storage.localCalls.set.length, 1, '缺新欄位的資料必須寫回（遷移確實接上 onInstalled）');
});

// S2：只缺一部分新欄位（例如上一版遷移到一半、或手機匯入的資料只帶 id）
// 時，既有 id 沿用、其餘補齊。整筆重建會讓已上雲的卡片換身分。
test('S2 遷移:只缺部分新欄位時既有 id 沿用，其餘欄位補齊', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    {
      url: CLEAN_URL,
      kind: 'share',
      at: base,
      seen: [{ at: base - 2000, kind: 'share' }],
      id: 'kept-id-0000-4000-8000-000000000000',
      serverUpdatedAt: 1699999999999,
    },
  ]);

  bg.fireInstalled();
  await settle();

  const e = bg.storage.localSnapshot().history[0];
  assert.equal(e.id, 'kept-id-0000-4000-8000-000000000000', '既有 id 不得被重新生成');
  assert.equal(e.serverUpdatedAt, 1699999999999, '既有 serverUpdatedAt 不得被清成 null');
  assert.equal(e.postKey, C.postKeyOf(CLEAN_URL));
  assert.equal(e.receivedAt, base - 2000);
  assert.equal(e.dirty, true);
  assert.equal(e.deletedAt, null);
});

// S2：遷移不得改變排序與筆數（新到舊排列是 UI 與裁切邏輯共同的前提）。
test('S2 遷移:不改變排序與筆數（混合已具備／缺新欄位的資料）', async () => {
  const base = 1700000000000;
  const urls = [
    CLEAN_URL,
    OTHER_URL,
    'https://www.threads.com/@third/post/ThirdPostId',
    'https://www.threads.com/@fourth/post/FourthPostId',
  ];
  const seed = [
    { url: urls[0], kind: 'share', at: base, seen: [{ at: base, kind: 'share' }] },
    equippedEntry(urls[1], base - 1000),
    { url: urls[2], kind: 'icon', at: base - 2000 },
    equippedEntry(urls[3], base - 3000, { id: 'ffffffff-1111-4222-9333-444444444444' }),
  ];
  const bg = loadBackgroundForMigration(seed);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 4, '筆數不變');
  assert.deepEqual(Array.from(history, (e) => e.url), urls, '排序不變');
  history.forEach((e, i) => {
    NEW_FIELDS.forEach((f) => assert.equal(f in e, true, `第 ${i} 筆缺新欄位 ${f}`));
  });
  assert.equal(history[1].id, seed[1].id, '本來就有 id 的條目沿用原值');
  assert.equal(history[3].id, seed[3].id);
});

// S2：onInstalled 內先跑 migrateHistoryMerge 再跑 migrateHistorySchema。順序
// 反過來的話，schema 先補的 id/postKey/dirty 會被 mergeHistoryGroup 重建物件
// 時整組丟掉（它只挑 url/at/kind/MERGEABLE_FIELDS/seen），整平後的卡片又缺
// 新欄位。這條同時釘住順序與「合併不得丟新欄位」。
test('S2 遷移:merge 先於 schema——需合併的舊卡整平後仍帶齊新欄位', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    { url: `${CLEAN_URL}?xmt=abc`, kind: 'share', at: base - 2000, seen: [{ at: base - 2000, kind: 'share' }] },
    { url: 'https://m.threads.com/@dafucoding/post/DbezfB0gYvP', kind: 'icon', at: base - 1000, seen: [{ at: base - 1000, kind: 'icon' }] },
  ]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '同一篇貼文的兩種網址形狀應先整平成一張卡');
  const e = history[0];
  NEW_FIELDS.forEach((f) => assert.equal(f in e, true, `整平後的卡片仍須帶有新欄位 ${f}`));
  assert.match(e.id, UUID_V4);
  assert.equal(e.postKey, 'threads:DbezfB0gYvP');
  assert.equal(e.receivedAt, base - 2000, 'receivedAt 取聯集後最早的事件');
  assert.equal(e.dirty, true);
});

// S2：畸形條目（非物件／url 非字串）在既有遷移就是「原位保留、不順手清
// 資料」，schema 遷移同樣不得對它們丟例外或憑空補欄位。
test('S2 遷移:畸形條目原樣保留、不丟例外', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    { url: CLEAN_URL, kind: 'share', at: base, seen: [{ at: base, kind: 'share' }] },
    null,
    { url: 12345, kind: 'share', at: base - 1000 },
    'junk',
  ]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 4, '畸形條目原位保留，筆數不變');
  assert.match(history[0].id, UUID_V4, '正常條目照樣補齊');
  assert.equal(history[1], null);
  assert.equal(history[2].url, 12345);
  assert.equal('id' in history[2], false, 'url 非字串的條目無從算 postKey，整筆不動');
  assert.equal(history[3], 'junk');
});

// ============================================================
// S6：配額與裁切
// ============================================================

// S6：筆數硬保險（HISTORY_MAX_ENTRIES=10000）觸發時，墓碑優先淘汰——先丟
// deletedAt 非 null 的最舊一筆，一般條目的最舊一筆必須存活。純尾端裁切會
// 誤丟 P9999（使用者真的看得到的紀錄），留下一張使用者早就刪掉的墓碑。
test('S6 裁切:筆數硬保險觸發時墓碑優先淘汰，一般最舊的一筆存活', async () => {
  const now = Date.now();
  const TOMB_URL = 'https://www.threads.com/@u/post/P5000';
  const seed = Array.from({ length: 10000 }, (_, i) => {
    const url = `https://www.threads.com/@u/post/P${i}`;
    const at = now - 1000 - i;
    const entry = equippedEntry(url, at, { id: `id-${i}`, kind: 'icon', seen: [{ at: at, kind: 'icon' }] });
    if (url === TOMB_URL) entry.deletedAt = now - 100000;
    return entry;
  });
  const bg = loadBackgroundForRecord(seed);

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEAN_URL, kind: 'icon' });
  await settle(900);

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 10000, '總筆數（10001）應被硬保險裁回 10000');
  assert.equal(history[0].url, CLEAN_URL, '本次最新一筆在最前');
  assert.equal(
    history.some((e) => e && e.url === TOMB_URL),
    false,
    '裁切時墓碑優先淘汰'
  );
  assert.equal(
    history[history.length - 1].url,
    'https://www.threads.com/@u/post/P9999',
    '一般條目的最舊一筆不得被裁掉（墓碑已先讓位）'
  );
});

// S6：位元組軟預算（8MB）觸發時同樣墓碑優先。墓碑刻意做得很大：先丟墓碑
// 就能讓所有一般條目都塞得進預算；純尾端裁切則會為了留住那張墓碑，砍掉幾
// 十筆使用者實際看得到的紀錄。
test('S6 裁切:位元組軟預算觸發時墓碑優先淘汰，一般條目全數存活', async () => {
  const now = Date.now();
  const normalExcerpt = 'x'.repeat(50000); // 約 50KB/筆，100 筆約 5MB
  const TOMB_URL = 'https://www.threads.com/@u/post/TOMBSTONE';
  const seed = Array.from({ length: 100 }, (_, i) => {
    const url = `https://www.threads.com/@u/post/Q${i}`;
    const at = now - 1000 - i;
    return equippedEntry(url, at, { id: `id-${i}`, kind: 'icon', excerpt: normalExcerpt, seen: [{ at: at, kind: 'icon' }] });
  });
  // 一張約 6MB 的巨大墓碑插在第 4 筆（很新，尾端裁切一定砍不到它）。
  seed.splice(3, 0, equippedEntry(TOMB_URL, now - 1500, {
    id: 'tombstone-id',
    kind: 'icon',
    excerpt: 'y'.repeat(6 * 1000 * 1000),
    seen: [{ at: now - 1500, kind: 'icon' }],
    deletedAt: now - 1200,
  }));
  const bg = loadBackgroundForRecord(seed);

  bg.sendRuntimeMessage({ type: 'cleanedNotice', cleanUrl: CLEAN_URL, kind: 'icon' });
  await settle(900);

  const history = bg.storage.localSnapshot().history;
  assert.ok(JSON.stringify(history).length <= 8 * 1024 * 1024, '序列化位元組應被裁到軟預算 8MB 內');
  assert.equal(
    history.some((e) => e && e.url === TOMB_URL),
    false,
    '超預算時墓碑優先淘汰'
  );
  assert.equal(history.length, 101, '墓碑讓位後，本次一筆加上 100 筆一般條目全數塞得進預算');
  assert.equal(history[0].url, CLEAN_URL);
});

// S6：schema 遷移寫入撞配額時優雅降級——console.warn、不重試、不丟例外，
// 既有紀錄維持原形狀仍可瀏覽（比照 migrateHistoryMerge 既有的降級行為）。
test('S6 配額:schema 遷移寫入超出配額時優雅降級——console.warn、不重試、不丟例外', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    { url: CLEAN_URL, kind: 'share', at: base, seen: [{ at: base, kind: 'share' }] },
    { url: OTHER_URL, kind: 'icon', at: base - 1000, seen: [{ at: base - 1000, kind: 'icon' }] },
  ]);
  let setCallCount = 0;
  bg.storage.local.set = () => {
    setCallCount += 1;
    return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
  };

  const warnCalls = [];
  const errorCalls = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => warnCalls.push(args);
  console.error = (...args) => errorCalls.push(args);
  try {
    bg.fireInstalled();
    await settle();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(setCallCount, 1, '配額失敗不得重試');
  assert.ok(
    warnCalls.some((args) => typeof args[0] === 'string' && args[0].includes('[threads-clean-link]') && args[0].includes('配額')),
    '應以 [threads-clean-link] 前綴 console.warn 配額訊息'
  );
  assert.deepEqual(errorCalls, [], '配額錯誤屬預期降級，不得升級成 console.error');
});

// ============================================================
// S5：syncState／syncAuth 與雲端 SyncItem 雙向映射
// ============================================================

// S5：兩個 storage key 的預設形狀（計劃 4.2）。欄位少一個、多一個，車道 D
// 的同步引擎就會讀到 undefined 而不是 null。
test('S5 常數:DEFAULT_SYNC_STATE / DEFAULT_SYNC_AUTH 形狀', () => {
  assert.deepEqual(C.DEFAULT_SYNC_STATE, {
    userId: null,
    email: null,
    // D15（車道 A）:帳號入口顯示用的名字與大頭照，見下方 sanitize 測試。
    displayName: null,
    avatarUrl: null,
    cursor: null,
    lastSyncedAt: null,
    clearedAt: null,
    lastError: null,
  });
  assert.deepEqual(C.DEFAULT_SYNC_AUTH, { token: null });
});

// S5：normalizeSyncState 缺欄位補預設、型別錯誤回預設。
test('S5 normalizeSyncState:缺欄位補預設、型別錯誤回該欄預設、合法值原樣保留', () => {
  const out = C.normalizeSyncState({
    userId: 'user-1',
    email: 'a@example.com',
    cursor: '1700000000000~abc',
    lastSyncedAt: 1700000000000,
    // clearedAt 缺席 → null
    lastError: 42, // 型別錯誤 → null
  });
  assert.equal(out.userId, 'user-1');
  assert.equal(out.email, 'a@example.com');
  assert.equal(out.cursor, '1700000000000~abc');
  assert.equal(out.lastSyncedAt, 1700000000000);
  assert.equal(out.clearedAt, null, '缺席欄位補預設');
  assert.equal(out.lastError, null, '型別錯誤回預設');

  // 數字欄位收到字串／非有限數字一律回預設（NaN 進 storage 會序列化成
  // null，但比較時處處要防，不如在正規化就擋掉）。
  const bad = C.normalizeSyncState({ userId: 7, email: [], cursor: {}, lastSyncedAt: '123', clearedAt: Infinity, lastError: null });
  assert.deepEqual(bad, C.DEFAULT_SYNC_STATE);
});

// S5：垃圾輸入一律回全預設，且每次回傳全新物件——回傳共用的
// DEFAULT_SYNC_STATE 參照時，呼叫端一改（例如寫入 userId）就污染了全域
// 預設值，之後所有「未登入」判定全部失準。
test('S5 normalizeSyncState:垃圾輸入回全預設，且每次回傳新物件、不含未知鍵', () => {
  [null, undefined, 'junk', 42, [], true].forEach((raw) => {
    assert.deepEqual(C.normalizeSyncState(raw), C.DEFAULT_SYNC_STATE, `normalizeSyncState(${JSON.stringify(raw)}) 應回全預設`);
  });

  const a = C.normalizeSyncState(null);
  const b = C.normalizeSyncState(null);
  assert.notEqual(a, b, '每次呼叫回傳新物件');
  assert.notEqual(a, C.DEFAULT_SYNC_STATE, '不得回傳共用的 DEFAULT_SYNC_STATE 參照');

  // 未知鍵不得夾帶進來（同步狀態會整包寫回 storage，夾帶的鍵會一路長存）。
  const extra = C.normalizeSyncState({ userId: 'u', evil: 'x' });
  assert.deepEqual(Object.keys(extra).sort(), Object.keys(C.DEFAULT_SYNC_STATE).sort());
});

// S5（車道 A，D15）：normalizeSyncState 對 displayName／avatarUrl 的垃圾輸入
// 一律回 null——這兩欄的合法值檢查（trim／80 字元上限／googleusercontent.com
// 白名單）委派給 sanitizeDisplayName／sanitizeAvatarUrl，這裡只驗 normalizeSyncState
// 確實把它們接進整形流程。
test('S5 normalizeSyncState:displayName／avatarUrl 型別錯誤或不合法值一律回 null', () => {
  const bad = C.normalizeSyncState({
    userId: 'user-1',
    displayName: 42,
    avatarUrl: ['https://lh3.googleusercontent.com/a/x'],
  });
  assert.equal(bad.displayName, null, '非字串回 null');
  assert.equal(bad.avatarUrl, null, '非字串回 null');

  const rejected = C.normalizeSyncState({
    displayName: '   ',
    avatarUrl: 'http://lh3.googleusercontent.com/a/x', // 非 https
  });
  assert.equal(rejected.displayName, null, '去頭尾空白後為空字串回 null');
  assert.equal(rejected.avatarUrl, null, '非 https 一律拒收');

  const ok = C.normalizeSyncState({
    displayName: '  Alice  ',
    avatarUrl: 'https://lh3.googleusercontent.com/a/legit',
  });
  assert.equal(ok.displayName, 'Alice', '合法值原樣（去空白後）保留');
  assert.equal(ok.avatarUrl, 'https://lh3.googleusercontent.com/a/legit');
});

// S5（車道 A，D15）：sanitizeDisplayName 純函式——去頭尾空白、上限 80 字元、
// 非字串或空字串一律回 null。
test('S5 sanitizeDisplayName:去頭尾空白、上限 80 字元、空字串與非字串回 null', () => {
  assert.equal(C.sanitizeDisplayName('  Alice  '), 'Alice');
  assert.equal(C.sanitizeDisplayName(''), null);
  assert.equal(C.sanitizeDisplayName('   '), null, '純空白去除後為空字串');
  assert.equal(C.sanitizeDisplayName(null), null);
  assert.equal(C.sanitizeDisplayName(undefined), null);
  assert.equal(C.sanitizeDisplayName(42), null);
  assert.equal(C.sanitizeDisplayName({}), null);

  const long = 'A'.repeat(120);
  const capped = C.sanitizeDisplayName(long);
  assert.equal(capped.length, 80, '超過上限要截斷，不是整欄丟棄');
  assert.equal(capped, 'A'.repeat(80));
});

// S5（車道 A，D15，審查追加）：換行/tab 等空白摺成單一半形空白，不是整
// 欄丟棄或原樣保留——顯示名字是帳號入口的單行 UI 元素。
test('S5 sanitizeDisplayName:內部換行/連續空白摺成單一半形空白', () => {
  assert.equal(C.sanitizeDisplayName('Ali\nce'), 'Ali ce');
  assert.equal(C.sanitizeDisplayName('Ali\r\nce'), 'Ali ce');
  assert.equal(C.sanitizeDisplayName('Ali\tce'), 'Ali ce');
  assert.equal(C.sanitizeDisplayName('Ali   ce'), 'Ali ce', '連續空白摺成一個');
  assert.equal(C.sanitizeDisplayName('  Ali\nce  '), 'Ali ce', '摺行與去頭尾空白疊加');
});

// S5（車道 A，D15，審查追加）：80 字元上限的截斷點若剛好落在 surrogate
// pair(例如 emoji)中間，不得留下孤立高位代理——用 String.isWellFormed()
// 驗證截斷結果是合法的 UTF-16 字串，不會被渲染成 U+FFFD 替代字元。
test('S5 sanitizeDisplayName:截斷不得留下孤立的高位代理(emoji 不切半)', () => {
  const long = 'A' + '\u{1F600}'.repeat(50); // 'A' + 50 個 😀(各佔 2 個 code unit)
  const capped = C.sanitizeDisplayName(long);
  assert.ok(capped.length <= 80, '截斷後長度不得超過上限');
  assert.equal(typeof capped.isWellFormed === 'function' ? capped.isWellFormed() : true, true, '不得含孤立代理');
  assert.equal(capped.indexOf('�'), -1, '不得含替代字元');
});

// S5（車道 A，D15）：sanitizeAvatarUrl 白名單——只接受 https 且 host 為
// googleusercontent.com 本身或其子網域，其餘一律回 null。含「@ 偽裝網址」
// 案例：new URL() 會把 `https://<誘餌>@evil.com/x` 解析成 hostname=evil.com，
// 判準必須是解析後的 hostname，不能是整串字串比對。
test('S5 sanitizeAvatarUrl:白名單只接受 https 的 googleusercontent.com（含子網域），其餘回 null', () => {
  assert.equal(
    C.sanitizeAvatarUrl('https://lh3.googleusercontent.com/a/ACg8ocJ'),
    'https://lh3.googleusercontent.com/a/ACg8ocJ',
    '合法子網域原樣保留'
  );
  assert.equal(
    C.sanitizeAvatarUrl('https://googleusercontent.com/a/x'),
    'https://googleusercontent.com/a/x',
    'apex 網域本身也接受'
  );

  assert.equal(
    C.sanitizeAvatarUrl('http://lh3.googleusercontent.com/a/x'),
    null,
    '非 https 一律拒收'
  );
  assert.equal(
    C.sanitizeAvatarUrl('https://evil.example.com/avatar.png'),
    null,
    '其他網域一律拒收'
  );
  assert.equal(
    C.sanitizeAvatarUrl('javascript:alert(1)'),
    null,
    '偽協定一律拒收'
  );
  assert.equal(
    C.sanitizeAvatarUrl('https://lh3.googleusercontent.com.evil.com/x'),
    null,
    '字尾偽裝(host 實際是 evil.com 的子網域)一律拒收'
  );
  assert.equal(
    C.sanitizeAvatarUrl('https://lh3.googleusercontent.com@evil.com/x'),
    null,
    '@ 偽裝(userinfo 塞合法網域，真正 host 是 evil.com)一律拒收'
  );
  assert.equal(C.sanitizeAvatarUrl('not a url'), null, '無法解析的字串回 null');
  assert.equal(C.sanitizeAvatarUrl(''), null);
  assert.equal(C.sanitizeAvatarUrl(null), null);
  assert.equal(C.sanitizeAvatarUrl(42), null);
});

// S5（車道 A，D15，審查追加）：長度上限——超長字串在丟進 new URL() 之前
// 就要被擋下，沿用 LIMITS.ORIGINAL_MAX 當同一把尺（防呆，不是嚴謹的網址
// 長度標準）。
test('S5 sanitizeAvatarUrl:超過長度上限一律回 null', () => {
  const okLength = 'https://lh3.googleusercontent.com/a/' + 'x'.repeat(C.LIMITS.ORIGINAL_MAX - 40);
  assert.ok(okLength.length <= C.LIMITS.ORIGINAL_MAX, '測資本身要落在上限內才有意義');
  assert.notEqual(C.sanitizeAvatarUrl(okLength), null, '上限內的合法網址仍應通過');

  const tooLong = 'https://lh3.googleusercontent.com/a/' + 'x'.repeat(2 * 1024 * 1024);
  assert.equal(C.sanitizeAvatarUrl(tooLong), null, '2MB 網址一律拒收，不進 new URL() 解析');
});

// S5（車道 A，D15，審查追加）：回傳值是 new URL(value).href（正規化後的網
// 址），不是原始輸入——WHATWG URL 解析會剝掉 ASCII tab/newline，並把 bidi
// 控制字元等落在路徑段的字元百分比編碼，兩者都不會原樣留在回傳值裡。
test('S5 sanitizeAvatarUrl:回傳值為 new URL(value).href，不含 CRLF／bidi 控制字元原文', () => {
  const withCrlf = 'https://lh3.googleusercontent.com/a/x\r\ny';
  const outCrlf = C.sanitizeAvatarUrl(withCrlf);
  assert.equal(outCrlf, new URL(withCrlf).href, '回傳值等於 new URL(...).href');
  assert.equal(outCrlf.indexOf('\r'), -1);
  assert.equal(outCrlf.indexOf('\n'), -1);

  const withBidi = 'https://lh3.googleusercontent.com/a/x‮y'; // U+202E RLO
  const outBidi = C.sanitizeAvatarUrl(withBidi);
  assert.equal(outBidi, new URL(withBidi).href, '回傳值等於 new URL(...).href');
  assert.equal(outBidi.indexOf('‮'), -1, 'bidi 控制字元不得以原始碼位留在回傳值');
});

// S5：entry → SyncItem（計劃 4.3）。seen[].source 依 D4 映射：share→share，
// strip／menu／icon→clipboard。
test('S5 toSyncItem:必填欄位映射、seen source 依 D4 映射', () => {
  const item = C.toSyncItem({
    url: CLEAN_URL,
    kind: 'icon',
    at: 9000,
    seen: [
      { at: 1000, kind: 'share' },
      { at: 2000, kind: 'strip' },
      { at: 3000, kind: 'menu' },
      { at: 4000, kind: 'icon' },
    ],
    author: 'Dafu Coding',
    handle: '@dafucoding',
    excerpt: '今天天氣真好',
    removedParams: [{ key: 'xmt', value: 'AQGabc' }],
    id: 'local-id-1',
    postKey: 'threads:DbezfB0gYvP',
    original: SHARE_URL,
    receivedAt: 1000,
    dirty: true,
    serverUpdatedAt: null,
    deletedAt: null,
  });

  assert.equal(item.id, 'local-id-1');
  assert.equal(item.cleaned, CLEAN_URL, 'cleaned 由 url 映射');
  assert.equal(item.original, SHARE_URL);
  assert.equal(item.receivedAt, 1000, 'receivedAt 用最早事件，不是本機顯示用的 at');
  assert.equal(item.author, 'Dafu Coding');
  assert.equal(item.handle, '@dafucoding');
  assert.equal(item.excerpt, '今天天氣真好');
  assert.deepEqual(item.removedParams, [{ key: 'xmt', value: 'AQGabc' }]);
  assert.deepEqual(item.seen, [
    { at: 1000, source: 'share' },
    { at: 2000, source: 'clipboard' },
    { at: 3000, source: 'clipboard' },
    { at: 4000, source: 'clipboard' },
  ]);
});

// S5：本機欄位一律不上雲（kind 依 D4 只留本機；dirty／deletedAt／
// serverUpdatedAt／postKey 是本機同步簿記），選填欄位缺席就不輸出鍵——
// 輸出 undefined 會被 JSON.stringify 丟掉，但輸出 null 會被伺服器當成「明
// 確清空」。
test('S5 toSyncItem:本機欄位不上雲，選填欄位缺席不輸出鍵', () => {
  const item = C.toSyncItem({
    url: CLEAN_URL,
    kind: 'share',
    at: 5000,
    id: 'local-id-2',
    postKey: 'threads:DbezfB0gYvP',
    original: SHARE_URL,
    receivedAt: 5000,
    dirty: true,
    serverUpdatedAt: 123,
    deletedAt: 456,
  });

  ['kind', 'dirty', 'deletedAt', 'serverUpdatedAt', 'postKey', 'at', 'url'].forEach((f) => {
    assert.equal(f in item, false, `${f} 不得出現在雲端 SyncItem`);
  });
  ['author', 'handle', 'excerpt', 'removedParams', 'seen'].forEach((f) => {
    assert.equal(f in item, false, `缺席的選填欄位 ${f} 不得輸出鍵`);
  });
  assert.deepEqual(Object.keys(item).sort(), ['cleaned', 'id', 'original', 'receivedAt']);
});

// S5：original 是伺服器必填欄位，缺席整筆會被靜默丟棄（計劃 4.3）。S1 的
// 遷移已保證持久化，這裡是上傳前的最後一道保險。
test('S5 toSyncItem:original 缺席時以 url 補（伺服器必填）', () => {
  const item = C.toSyncItem({ url: CLEAN_URL, kind: 'share', at: 5000, id: 'local-id-3', receivedAt: 5000 });
  assert.equal(item.original, CLEAN_URL);
});

// S5：seen 裡沒有 kind 的種子紀錄（schema 升級前的舊資料、遷移補種的那
// 筆）不對應任何來源事件，source 是選填，缺席就不輸出鍵；硬塞
// 'clipboard' 等於對雲端謊報一個沒發生過的來源。
test('S5 toSyncItem:seen 內缺 kind 的種子紀錄不輸出 source 鍵', () => {
  const item = C.toSyncItem({
    url: CLEAN_URL,
    kind: 'share',
    at: 5000,
    id: 'local-id-4',
    receivedAt: 1000,
    seen: [{ at: 1000 }, { at: 2000, kind: 'share' }],
  });
  assert.deepEqual(item.seen, [{ at: 1000 }, { at: 2000, source: 'share' }]);
});

// S5：SyncItem → entry。kind 保留既有（雲端沒有這個欄位，D4 已接受跨裝置
// 遺失），沒有既有條目時預設 'share'；seen[].kind 由 source 反映射，插件沒
// 有 clipboard 這個 kind，一律回 'share'。
test('S5 fromSyncItem:雲端欄位映射回本機，kind 沿用既有／預設 share', () => {
  const item = {
    id: 'cloud-id-1',
    original: SHARE_URL,
    cleaned: CLEAN_URL,
    receivedAt: 1000,
    author: 'Dafu Coding',
    handle: '@dafucoding',
    excerpt: '今天天氣真好',
    removedParams: [{ key: 'xmt', value: 'AQGabc' }],
    seen: [{ at: 1000, source: 'share' }, { at: 3000, source: 'clipboard' }],
  };

  const fresh = C.fromSyncItem(item, null);
  assert.equal(fresh.url, CLEAN_URL, 'url 由 cleaned 映射');
  assert.equal(fresh.id, 'cloud-id-1', 'id 以雲端（canonical）為準');
  assert.equal(fresh.postKey, C.postKeyOf(CLEAN_URL), 'postKey 由 cleaned 重算');
  assert.equal(fresh.original, SHARE_URL);
  assert.equal(fresh.receivedAt, 1000);
  assert.equal(fresh.kind, 'share', '沒有既有條目時預設 share');
  assert.equal(fresh.dirty, false, '剛從雲端拉下來的資料不是待上傳狀態');
  assert.equal(fresh.deletedAt, null);
  assert.equal(fresh.author, 'Dafu Coding');
  assert.equal(fresh.handle, '@dafucoding');
  assert.equal(fresh.excerpt, '今天天氣真好');
  assert.deepEqual(
    Array.from(fresh.seen, (s) => s.kind),
    ['share', 'share'],
    'source 反映射：share→share、clipboard→share（插件無 clipboard kind）'
  );

  const kept = C.fromSyncItem(item, { url: CLEAN_URL, kind: 'icon', at: 1, seen: [] });
  assert.equal(kept.kind, 'icon', '既有 kind（卡片徽章）保留，不被雲端抹掉');
});

// S5：at 是本機顯示用的「最後一次出現時間」，取 max(receivedAt, seen 最大
// at)。直接沿用 receivedAt 會讓卡片顯示成第一次看到的時間，排序整個錯位。
test('S5 fromSyncItem:at 取 max(receivedAt, seen 最大 at)', () => {
  const withLaterSeen = C.fromSyncItem(
    { id: 'c1', original: SHARE_URL, cleaned: CLEAN_URL, receivedAt: 1000, seen: [{ at: 500, source: 'share' }, { at: 7000, source: 'clipboard' }] },
    null
  );
  assert.equal(withLaterSeen.at, 7000);

  // seen 全都早於 receivedAt（或整個缺席）時退回 receivedAt。
  const noSeen = C.fromSyncItem({ id: 'c2', original: SHARE_URL, cleaned: CLEAN_URL, receivedAt: 9000 }, null);
  assert.equal(noSeen.at, 9000);
  const olderSeen = C.fromSyncItem(
    { id: 'c3', original: SHARE_URL, cleaned: CLEAN_URL, receivedAt: 9000, seen: [{ at: 100, source: 'share' }] },
    null
  );
  assert.equal(olderSeen.at, 9000);
});

// S5：雲端回來的活卡蓋掉本機墓碑＝復活（伺服器唯一索引蓋得到已軟刪的卡，
// 同一篇貼文再分享一次會復活原本那張，見手機 local-db/schema.ts）。不清
// 掉 deletedAt 的話，使用者在別台裝置重新分享的貼文在這台永遠看不到。
test('S5 fromSyncItem:既有墓碑被雲端活卡復活（deletedAt 清為 null）', () => {
  const out = C.fromSyncItem(
    { id: 'cloud-id-9', original: SHARE_URL, cleaned: CLEAN_URL, receivedAt: 1000, seen: [{ at: 1000, source: 'share' }] },
    { url: CLEAN_URL, kind: 'icon', at: 1000, id: 'local-old-id', deletedAt: 888, dirty: true, seen: [] }
  );
  assert.equal(out.deletedAt, null, '雲端仍存在的卡片必須復活');
  assert.equal(out.dirty, false);
  assert.equal(out.id, 'cloud-id-9', 'id 以雲端 canonical 為準（伺服器改名時就地改名）');
});

// ============================================================
// S2 補強：整平時的墓碑裁決與 id 不換
// ============================================================

// S2：同一組裡混著墓碑與活卡時，活卡優先——墓碑代表「當年刪過」，之後又
// 有一張活卡代表使用者後來重新淨化過同一篇貼文，那是明確的復活意圖（語意
// 與 fromSyncItem 的復活、匯入的 deletedAt 清空一致）。整平出來的卡不得帶
// 著 deletedAt 走，否則使用者眼前看得到的紀錄會在遷移後整批消失。
test('S2 遷移:同組含墓碑與活卡時活卡優先，deletedAt 清為 null', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    // 較新的活卡（handle 改名後的網址）。
    equippedEntry('https://www.threads.com/@newname/post/DbezfB0gYvP', base, {
      id: 'live-id',
      kind: 'icon',
      seen: [{ at: base, kind: 'icon' }],
    }),
    // 較舊的墓碑（同一篇貼文的舊網址）。
    equippedEntry(CLEAN_URL, base - 5000, {
      id: 'tomb-id',
      seen: [{ at: base - 5000, kind: 'share' }],
      deletedAt: base - 4000,
    }),
  ]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1, '同一篇貼文的兩張卡應整平成一張');
  assert.equal(history[0].deletedAt, null, '活卡優先，deletedAt 清為 null');
  assert.equal(history[0].id, 'live-id', 'id 取最新一張有值的卡，不憑空生成');
});

// S2：全組皆墓碑時保留墓碑身分，deletedAt 取 max——刪除意圖只會往後推移，
// 取最舊的那一刻會讓水位線比較把這張卡誤判成早該被 ack 的殘留。若整平時
// 整個把 deletedAt 丟掉，使用者刪掉的貼文會在遷移後全部復活。
test('S2 遷移:全組皆墓碑時保留墓碑，deletedAt 取 max', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    equippedEntry('https://www.threads.com/@newname/post/DbezfB0gYvP', base, {
      id: 'tomb-new',
      seen: [{ at: base, kind: 'share' }],
      deletedAt: base + 100,
    }),
    equippedEntry(CLEAN_URL, base - 5000, {
      id: 'tomb-old',
      seen: [{ at: base - 5000, kind: 'share' }],
      deletedAt: base + 900,
    }),
  ]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].deletedAt, base + 900, 'deletedAt 取組內最大值，不是主卡的值');
});

// S2：整平換 id 等於在雲端另開一張卡、原卡變孤兒。這條釘住「合併鍵相同的
// 多張卡整平後，id 必為組內既有的 id，絕不重新生成」。
test('S2 遷移:整平不換 id——沿用組內既有的 id', async () => {
  const base = 1700000000000;
  const bg = loadBackgroundForMigration([
    equippedEntry('https://www.threads.com/@newname/post/DbezfB0gYvP', base, {
      id: 'keep-me',
      seen: [{ at: base, kind: 'share' }],
    }),
    equippedEntry(CLEAN_URL, base - 5000, { id: 'older-id', seen: [{ at: base - 5000, kind: 'share' }] }),
  ]);

  bg.fireInstalled();
  await settle();

  const history = bg.storage.localSnapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, 'keep-me', 'id 沿用最新一張有值的卡，不生成新 UUID');
});
