// sw-history.js — service worker 的紀錄(history)本體，由 background.js 以
// importScripts 載入。
//
// 本檔負責:使用者設定的讀取、cleanedNotice 的受理、紀錄條目的欄位擷取、
// 永久合併(合併鍵 = post ID)、雲端 schema 欄位、寫入(recordHistory)與兩支
// 一次性遷移;以及 storage.local 唯一的讀改寫佇列(storageQueue)與單鍵讀改寫
// 模板(mutate)——引擎、紀錄、警示名單與裝置身分全部共用這一條。
//
// 對外提供的全域名稱:
//   storageAreaAdapter、storageQueue、mutate、HISTORY_KEY、DEFAULT_SETTINGS、
//   getSettings、handleCleanedNotice、extractHistoryExtraFields、
//   recordHistory、notifySyncRecorded、migrateHistoryMerge、migrateHistorySchema
//
// 依賴:前載的 tcl-core.js(TCLCore)與 chrome。函式內另外引用後載檔案的名稱
// ——sw-device.js 的 ensureDevice、sw-og.js 的 og 擷取函式、background.js 的
// syncEngine——只在呼叫時才解析，頂層不碰。
'use strict';

// notifySuccess(成功類通知)不存在——紀錄是唯一資料集，cleanedNotice
// 收到就無條件記錄，沒有「要不要顯示成功通知」這道關卡。失敗／錯誤類
// 通知不受影響，永遠觸發(右鍵選單路徑維持系統通知；share/strip 自動
// 路徑改頁內 toast，見 bridge.js／post-icon.js)。saveHistory(只有
// background 記錄時把關，guard/bridge 不下放)與 autoClean 的預設值須
// 與 popup.js／bridge.js／clipboard-guard.js 同步。
// 預設值取自 TCLCore.DEFAULT_SETTINGS(全量三鍵的單一權威)，background 只挑
// 自己把關的兩顆(autoClean/saveHistory;postCopyEnabled 是 popup/post-icon 的
// 事，background 不讀)。
const DEFAULT_SETTINGS = {
  autoClean: TCLCore.DEFAULT_SETTINGS.autoClean,
  saveHistory: TCLCore.DEFAULT_SETTINGS.saveHistory,
};

// 紀錄:存 chrome.storage.local(sync 的 100KB 總額與寫入配額撐不起
// 紀錄量），新到舊排列。上限由位元組軟預算 + 筆數硬保險把關(見
// TCLCore.capHistory 與 TCLCore.HISTORY_LIMITS)，平時
// 就不長到撞配額;萬一仍寫入超限，再走 recordHistory 的 TCLCore.isQuotaExceededError
// 優雅降級(不重試、不丟例外，只 console.warn，不影響複製/淨化等主功能)。
const HISTORY_KEY = 'history';

// 選填欄位長度上限(author/handle/excerpt/original)、removedParams 筆數與
// 單筆 key/value 上限、seen[] 上限，一律走 TCLCore.LIMITS(單一權威，與 options
// 讀取端共用同一組值)。
// author/handle 共用 AUTHOR_MAX;excerpt 對齊手機版 post-meta EXCERPT_MAX_CHARS;
// original 對齊 bridge.js MAX_CLEAN_URL_LENGTH;removedParams 型別對齊手機版
// RemovedParam({ key, value })。

// chrome.storage 的區域轉接:一律以 Promise 呼叫。區域本身在函式內才取值，
// 沒有 chrome.storage 的環境(測試替身)不會在接線當下就炸。
function storageAreaAdapter(name) {
  function area() {
    const store = chrome.storage && chrome.storage[name];
    if (!store) throw new Error(`chrome.storage.${name} 不可用`);
    return store;
  }
  return {
    get: (keys) => Promise.resolve(area().get(keys)),
    set: (items) => Promise.resolve(area().set(items)),
    remove: (keys) => Promise.resolve(area().remove(keys)),
  };
}

// storage.local 唯一的讀改寫佇列與單鍵讀改寫模板(TCLCore.createMutator)。
// 引擎以 writeChain 注入同一條佇列、自建一份 mutate。區域經 storageAreaAdapter
// 在每次呼叫時才取值，載入當下不碰 chrome.storage。
// 【死鎖守則】佇列上的工作(含 mutate 的 fn)內不得再排進 storageQueue——
// ensureDevice／getLocalDevice 都會排隊，要用的值在排隊之前先取好。
const storageQueue = TCLCore.createSerialQueue();
const mutate = TCLCore.createMutator({ area: storageAreaAdapter('local'), enqueue: storageQueue });

// history 讀出後的正規化:不是陣列一律當空表。
function normalizeHistoryList(raw) {
  return Array.isArray(raw) ? raw : [];
}

// history 的寫入參數:撞配額先收緊(多淘汰舊紀錄，墓碑優先)再寫一次，仍失敗
// 才放棄——紀錄是附屬功能，放棄時只留 console.warn，不影響複製/淨化。
const HISTORY_MUTATE_OPTS = { normalize: normalizeHistoryList, cap: TCLCore.capHistoryAt, onQuota: 'skip' };

// 讀取使用者設定。刻意放在點擊流程「內」呼叫，不在模組頂層同步觸碰
// chrome.storage：舊測試的 chrome mock 沒有 storage 屬性，頂層碰會讓
// 那些測試在 sandbox 載入階段就丟 TypeError。對 chrome.storage 缺席
// 或讀取失敗都容錯，一律退回預設值。
async function getSettings() {
  if (!chrome.storage || !chrome.storage.sync || typeof chrome.storage.sync.get !== 'function') {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  } catch (err) {
    console.error('[threads-clean-link] 讀取設定失敗，改用預設值', err);
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

// 處理 cleanedNotice:不信任呼叫端傳入的 cleanUrl，一律用錨定的
// POST_URL_PATTERN 重新驗證整串內容，不符合就靜默忽略、不寫入
// 任何紀錄;紀錄只用驗證通過的字串，不夾帶原文的任何其餘部分。
// kind 同屬頁面可控輸入，白名單驗證(自動路徑只可能是 share/strip/icon)，
// 非法即整則忽略——guard 與 background 同版本出貨，沒有相容性負擔，
// 形狀不對就是偽造或損毀，fail-safe 丟棄。'menu' 刻意不在此白名單內:
// 它只由 handleShareLinkClick(右鍵選單路徑)直接呼叫 recordHistory，
// 不透過本訊息通道，避免頁面腳本偽造 kind:'menu' 混充右鍵來源。收到合法
// notice 就無條件記錄一筆，author/handle/excerpt 為選填欄位一併寫入。
//
// og 取得:所有 kind 一律走 fetchOgFieldsForLocalKind——它先 peek 快取。
// share 路徑會命中 handleResolveShareMessage 解析短碼時剛寫入的快取(零額外
// fetch);strip/icon 這兩條 kind 不像 share 那樣本來就會 fetch 貼文頁，快取
// 未命中時才真的補一次 fetch(見 fetchOgFieldsForLocalKind，含節流/逾時/失敗
// 回退)。剪貼簿/複製體感完全不受影響，那是 content script 端早就完成的事，
// 這裡只是延後「記錄」這個步驟——刻意不做「先落盤、og 到了再補寫」:紀錄是永
// 久合併的，二次寫入必然命中同一張卡，mergeHistoryEntry 會多長一筆假的 seen
// 事件(同一次複製動作被算成兩次解析)，污染時間軸。寧可讓記錄晚最多 2.5 秒落
// 盤，也不要污染資料。
async function handleCleanedNotice(message) {
  const cleanUrl = message && message.cleanUrl;
  if (!TCLCore.isCleanPostUrl(cleanUrl)) {
    return;
  }
  const kind =
    message && TCLCore.NOTICE_KIND_LIST.indexOf(message.kind) !== -1 ? message.kind : null;
  if (!kind) {
    return;
  }

  // 省請求閘:進 fetch 之前先讀一次設定，saveHistory 關閉時直接
  // return——連 recordHistory 都不呼叫，更不觸發 fetchOgFieldsForLocalKind
  // 那次為了補 og 而發的網路請求(解析結果反正會被 recordHistory 內部的
  // saveHistory 把關丟棄，先擋在這裡就省掉整個 fetch)。對齊 guard 端 share
  // 路徑已有的省請求閘(bridge.js 下放 saveHistory 讓 clipboard-guard.js 在
  // saveHistory 關閉時連 resolveShare 都不發)。recordHistory 內部仍保留各
  // 自的 saveHistory 權威把關(menu 路徑沒有這道前置閘，靠內部那道)，此處
  // 純粹是為了省掉 og 補強的 fetch。
  const settings = await getSettings();
  if (!settings.saveHistory) {
    return;
  }

  // 所有 kind 一律走 fetchOgFieldsForLocalKind:先 peek 快取(見 peekOgFields，
  // share 命中 resolveShare 剛寫入的快取，零額外 fetch)，strip/icon 未命中才
  // 真的 fetch 貼文頁。
  const ogFields = await fetchOgFieldsForLocalKind(cleanUrl);
  recordHistory(cleanUrl, kind, extractHistoryExtraFields(message, cleanUrl, ogFields));
}

// author/handle/excerpt/original/removedParams 皆為選填欄位，同屬頁面
// 可控輸入(除了右鍵路徑，其餘一律經 guard/bridge 這條 postMessage 管道
// 進來)，不信任:型別不是 string(或 removedParams 不是陣列)的一律整欄
// 丟棄(不寫進回傳物件，而非寫入 undefined/空字串)，字串則截斷至各自長
// 度上限。回傳值直接可以 Object.assign 進 history 條目(見 recordHistory)。
// url 參數是本次寫入的乾淨網址，供 sanitizeOriginalField 判斷 original
// 是否與 cleaned 相同(相同就不存)。
// ogFields(第三參數):og 一律由呼叫端先取好再傳進來，這裡不自己查快取。
// 四條落盤路徑的 og 來源各異但形狀一致——share 路徑來自快取 peek、strip/icon 來自貼文頁
// fetch(兩者都經 fetchOgFieldsForLocalKind，見 handleCleanedNotice)、menu
// 來自 resolveFinalUrl 同一 response(見 handleShareLinkClick)——統一從這
// 個參數進來(可能是 null/空物件，代表逾時/失敗/沒收穫，merge 端會容錯)。
function extractHistoryExtraFields(message, url, ogFields) {
  const extra = {};
  const domAuthor = TCLCore.sanitizeText(message && message.author, TCLCore.LIMITS.AUTHOR_MAX);
  const domHandle = TCLCore.sanitizeText(message && message.handle, TCLCore.LIMITS.AUTHOR_MAX);
  const domExcerpt = TCLCore.sanitizeText(message && message.excerpt, TCLCore.LIMITS.EXCERPT_MAX);

  // merge 結果不能直接信任，統一再過一次 sanitizeOgFields(見該函式註解：
  // 長度上限雙層防線)才寫進 extra。
  const merged = sanitizeOgFields(
    mergeOgIntoFields({ author: domAuthor, handle: domHandle, excerpt: domExcerpt }, ogFields)
  );
  if (merged.author !== undefined) extra.author = merged.author;
  if (merged.handle !== undefined) extra.handle = merged.handle;
  if (merged.excerpt !== undefined) extra.excerpt = merged.excerpt;

  // original 除了截斷/去重，還要吻合 SHARE 或容尾 POST 白名單、超長整欄丟棄
  // (不截半)，偽造/畸形殘 URL 不入庫(見 TCLCore.sanitizeOriginal)。
  const original = TCLCore.sanitizeOriginal(message && message.original, url);
  if (original !== undefined) extra.original = original;
  const removedParams = TCLCore.sanitizeRemovedParams(message && message.removedParams);
  if (removedParams !== undefined) extra.removedParams = removedParams;
  return extra;
}

// ---- 紀錄永久合併(合併鍵 = post ID)----
//
// 同一篇貼文常見走多條路徑重複淨化(右鍵選單／自動偵測／貼文互動列複製
// icon)，也常見隔天再複製一次。紀錄一律合併為一張卡，讓使用者看到的歷史
// 是「一篇貼文一張卡、卡上記著每一次動作」，而不是同一篇貼文洗版。
//
// 【與手機版刻意分岔】手機版 hunandy14/meta-link-clearer 的
// src/lib/share-history-storage.ts 用「cleaned url + DEDUP_WINDOW_MS(5 分
// 鐘)」去重，視窗外的同一篇貼文會另開一張卡。本擴充改為**永久合併**:不設
// 任何時間視窗，同一篇貼文永遠合成同一張卡。兩邊的資料模型自此分岔，仍對
// 齊手機版的只剩合併後的欄位語意(浮頂、欄位新值優先、kind 記最近一次、
// seen[] 上限 50 裁最舊)。
//
// 【主鍵是 post ID，不是整條 url】handle 可以改名，同一篇貼文的乾淨網址會
// 跟著換樣子(/@old/post/ID → /@new/post/ID);post ID 則終身不變。以 ID 為
// 主鍵，改名前後的紀錄才仍認得是同一篇。
//
// 【合併鍵三層級聯】
//   1. **post key 主鍵**(historyDedupKey → TCLCore.postKeyOf):同一篇貼文
//      不論網址形狀如何變化(handle 改名、網域變體、尾斜線、query)，一律
//      取得同一個鍵(細節見 historyDedupKey 上方註解)。
//   2. **original 收編**(findOriginalAdoptIndex):本次落盤的 original 是短
//      碼原文時，把「當年解析失敗、以短碼原文入庫」的失敗卡一併收編進同文
//      卡——短碼在解析成功的那一刻才第一次與貼文對上號，這是唯一能把兩者
//      接起來的時機。
//   3. **失敗卡自鍵**:抽不出貼文代碼的 url(短碼原文等)退回正規化網址
//      當 fallback key(url:<host><path><query>，見 urlKey)。同一個短碼
//      重複入庫仍合成一張，不同短碼各自獨立。
// 不同短碼指向同一篇貼文的失敗卡彼此認不出來(短碼只有 Meta 伺服器能對應，
// 本機無從得知兩個短碼是同一篇)，此為自然極限，不另做補救。

// seen[] 上限(TCLCore.LIMITS.SEEN_MAX)與 kind 白名單(TCLCore.KIND_LIST，含
// 'menu')一律走 TCLCore;seen[] 逐筆消毒改用 TCLCore.sanitizeSeenList(與
// options 讀取/匯入端共用同一份，連 slice(-SEEN_MAX) 都在函式內完成)。

// 純函式:條目的合併鍵，走 TCLCore.postKeyOf(D11，與手機 postKeyOf 完全等
// 價)。同一篇貼文不論 handle 改名、網域變體(www./m./mobile.、threads.com/
// .net)、尾斜線、query，皆算出同一個 threads:<code> 之類的鍵;抽不出貼文
// 代碼的一律退回正規化後的網址當 fallback key(url:<host><path><query>)。
function historyDedupKey(url) {
  return TCLCore.postKeyOf(url);
}

// 純函式:在既有清單中找出合併鍵相同的條目 index，找不到回傳 -1。**全表比
// 對、不設時間視窗**(永久合併)。清單長度由 TCLCore.HISTORY_LIMITS 封頂，全表
// 掃描的成本與原本的視窗掃描同為 O(n)。
function findDedupIndex(list, url) {
  if (!Array.isArray(list)) return -1;
  const key = historyDedupKey(url);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && typeof item.url === 'string' && historyDedupKey(item.url) === key) return i;
  }
  return -1;
}

// ---- 失敗卡收編(isAdoptableOriginal / findOriginalAdoptIndex /
//      adoptFailureEntry / adoptFailureEntriesInList) ----
//
// 【現況】收編的對象是「當年解析失敗、以短碼原文入庫」的卡。這種卡在 0.3.0
// 起已無法由任何入口產生(所有寫入路徑都先取得乾淨貼文網址才落盤)，這整區
// 因此只服務 0.3.0 之前留下的庫存。保留至 0.7 評估移除——移除前要先確認實
// 際使用者庫存已無此類殘留，本波不動。

// 純函式:本次的 original 是否有資格觸發失敗卡收編——必須是分享短碼原文。
//
// 【只認短碼原文】original 同屬頁面可控輸入(見 extractHistoryExtraFields):
// 若放行任意 original 值，惡意頁面只要把別篇貼文的乾淨網址當 original 送
// 進來，就能點名讓那張卡被吞掉。限定 TCLCore.SHARE_URL_PATTERN 之後，可被
// 收編的對象只剩「url 是短碼」的卡——正常落盤的貼文卡 url 恆為
// /@handle/post/ID 形狀，永遠不可能是短碼，收編的波及面因此封死在失敗卡這
// 一類。strip 路徑的 original(貼文網址帶追蹤參數)同樣不觸發收編:那條路
// 徑從來不會產生以原文入庫的失敗卡。
function isAdoptableOriginal(original) {
  return typeof original === 'string' && TCLCore.SHARE_URL_PATTERN.test(original);
}

// 純函式:找出「當年解析失敗、以短碼原文入庫」的失敗卡 index——它的 url 恰
// 為本次落盤條目的 original。skipIndex 是本次同文卡自己的 index(上一步已
// 命中合併)，不得重複收編。找不到回傳 -1。
function findOriginalAdoptIndex(list, original, skipIndex) {
  if (!Array.isArray(list) || !isAdoptableOriginal(original)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (i === skipIndex) continue;
    const item = list[i];
    if (item && item.url === original) return i;
  }
  return -1;
}

// seen 事件序列(entrySeenEvents)、最早事件時間(entryEarliestAt)、已持久化
// 值與推導值取較早者(resolveReceivedAt)、墓碑判定(isTombstone)一律走
// TCLCore——四支都是純函式，options 讀取/匯入端與 sync 引擎用的是同一份。

// 純函式:多張卡的 seen 事件聯集，逐份併入 TCLCore.unionSeen(同 at 去重、按
// at 升序、裁到最新 SEEN_MAX)。lists 由新到舊排列，同一時刻的事件以較新那張
// 卡的為準。去重規則與 options 匯入端、fromSyncItem 共用同一份實作。
function unionSeenEvents(lists) {
  let out = [];
  for (let i = 0; i < lists.length; i++) out = TCLCore.unionSeen(out, lists[i]);
  return out;
}

// 純函式:把失敗卡收編進同文卡，回傳全新的條目物件(不改動任一輸入)。
//   - url/kind/at:一律維持同文卡的值。失敗卡只提供歷史，不改身分也不改
//     排序位置。
//   - 選填欄位:同文卡有值就維持，缺席才由失敗卡補位(失敗卡可能帶著當時
//     DOM 擷取到的 author/handle/excerpt)。
//   - seen[]:兩張卡的事件聯集(見 unionSeenEvents/entrySeenEvents)，失敗當
//     下那個時刻因此留在時間軸上。
function adoptFailureEntry(entry, failed) {
  const merged = Object.assign({}, entry);
  for (let i = 0; i < TCLCore.MERGEABLE_FIELDS.length; i++) {
    const field = TCLCore.MERGEABLE_FIELDS[i];
    if (merged[field] === undefined && failed && failed[field] !== undefined) {
      merged[field] = failed[field];
    }
  }
  merged.seen = unionSeenEvents([TCLCore.entrySeenEvents(entry), TCLCore.entrySeenEvents(failed)]);
  // 收編把失敗卡那一刻的事件併進時間軸，這張卡的最早事件因此可能往前——
  // receivedAt 跟著取兩張卡的較早者。id 一律維持同文卡的(失敗卡的 id 指向
  // 雲端另一張卡，換過去等於改身分)。
  const earliest = [TCLCore.resolveReceivedAt(entry), TCLCore.resolveReceivedAt(failed)].filter((v) => v !== null);
  if (earliest.length > 0) merged.receivedAt = Math.min.apply(null, earliest);
  return merged;
}

// seen[] 逐筆消毒走 TCLCore.sanitizeSeenList(見該檔註解:at 需為有限數字、
// kind 缺席保留、kind 有值需在 KIND_LIST 白名單內、裁到 SEEN_MAX)，與 options
// 讀取/匯入端共用同一份。唯一差異是 slice 位置——TCLCore 版在函式內就裁，對
// merge 端無行為差(concat 本次一筆後照樣再裁，見下方)。

// 本次事件的 seen 條目。deviceId 拿不到時整個鍵不輸出——schema 是選填欄位，
// 硬塞 null 會被消毒剝掉，還讓「沒有歸屬」與「歸屬給 null」混在一起。
function seenEvent(now, kind, deviceId) {
  const event = { at: now, kind };
  if (typeof deviceId === 'string' && deviceId !== '') event.deviceId = deviceId;
  return event;
}

// 純函式:把本次的 kind/extra 併入既有條目 existing，回傳全新的條目物件
// (不改動 existing，也不假設 existing 形狀完全乾淨——只挑用得到的欄
// 位，其餘未知欄位自然被丟棄，等同順手做了一次縱深防禦)。
//   - at 更新為 now(浮到最新，呼叫端負責把回傳的條目移到陣列最前)。
//   - kind 更新為本次來源(卡片徽章顯示最近一次解析路徑)。
//   - author/handle/excerpt/original/removedParams:本次 extra 有值就用
//     本次的，本次缺席才沿用 existing 的舊值(新值優先，但不能讓「這次
//     沒抓到」蓋掉「上次抓到的」)，五個欄位規則一致。
//   - url 更新為本次的乾淨網址:handle 改名後同一個 post ID 會帶來新的
//     網址，卡片顯示的應是最近一次看到的樣子。
//   - seen[]:既有事件序列走 TCLCore.entrySeenEvents(seen[] 存在就逐筆 sanitize，
//     缺席則以 existing.at 補種一筆起始紀錄)，再 append 本次
//     {at: now, kind, deviceId?}，裁到最新 SEEN_MAX 筆。本次事件必為最新，直接
//     接在尾端即可，不需要像 unionSeenEvents 那樣重排。deviceId 只掛在本次這
//     一筆:舊事件可能根本不是這台裝置產生的，回填等於竄改歸屬。
function mergeHistoryEntry(existing, url, kind, now, extra, deviceId) {
  const author = extra && extra.author !== undefined ? extra.author : existing.author;
  const handle = extra && extra.handle !== undefined ? extra.handle : existing.handle;
  const excerpt = extra && extra.excerpt !== undefined ? extra.excerpt : existing.excerpt;
  const original = extra && extra.original !== undefined ? extra.original : existing.original;
  const removedParams =
    extra && extra.removedParams !== undefined ? extra.removedParams : existing.removedParams;
  const seen = TCLCore.entrySeenEvents(existing)
    .concat([seenEvent(now, kind, deviceId)])
    .slice(-TCLCore.LIMITS.SEEN_MAX);

  const merged = { url, kind, at: now, seen };
  if (author !== undefined) merged.author = author;
  if (handle !== undefined) merged.handle = handle;
  if (excerpt !== undefined) merged.excerpt = excerpt;
  if (original !== undefined) merged.original = original;
  if (removedParams !== undefined) merged.removedParams = removedParams;
  return applyHistorySchema(merged, existing, now);
}

// 雲端 schema 的七個欄位(docs/cloud-sync.md 4.1)。遷移與寫入路徑共用
// 同一份清單，判斷「這筆是否已對齊」也以它為準。
const HISTORY_SCHEMA_FIELDS = ['id', 'postKey', 'original', 'receivedAt', 'dirty', 'serverUpdatedAt', 'deletedAt'];

// 純函式:把雲端 schema 的七個欄位補上 entry(就地改動傳入的 entry，呼叫端
// 傳的一律是剛建好的新物件)。previous 是這張卡合併前的樣子(新建路徑傳
// null)，now 是本次事件時間。
//   - id:沿用既有(它是雲端卡片的身分，換一次等於在雲端另開一張卡)，沒有
//     才生成 UUID v4。
//   - postKey:一律由本次的 url 重算(衍生欄位，handle 改名/子網域變體都算得
//     出同一個鍵)。
//   - original:本次/既有皆缺席時以 url 補(伺服器必填，缺席整筆被靜默丟棄)。
//   - receivedAt:既有值與事件序列推導值取較早者，只往前不往後。
//   - dirty:本機有新事件，一律標髒待上傳。
//   - serverUpdatedAt:伺服器的值，本機合併不得清掉。
//   - deletedAt:清為 null——刪過的貼文再次淨化即復活，就地改既有那張卡。
function applyHistorySchema(entry, previous, now) {
  const base = previous && typeof previous === 'object' ? previous : null;
  entry.id = base && typeof base.id === 'string' && base.id ? base.id : TCLCore.randomUuid();
  entry.postKey = TCLCore.postKeyOf(entry.url);
  if (entry.original === undefined) entry.original = entry.url;
  const earliest = [base === null ? null : TCLCore.resolveReceivedAt(base), typeof now === 'number' ? now : null].filter(
    (v) => v !== null
  );
  entry.receivedAt = earliest.length > 0 ? Math.min.apply(null, earliest) : null;
  entry.dirty = true;
  entry.serverUpdatedAt =
    base && typeof base.serverUpdatedAt === 'number' && isFinite(base.serverUpdatedAt) ? base.serverUpdatedAt : null;
  entry.deletedAt = null;
  return entry;
}

// ---- 儲存上限 ----
//
// 位元組軟預算(8MB)＋筆數硬保險(10000 筆)、墓碑優先淘汰的完整實作在
// TCLCore.capHistory(見 tcl-core.js 的儲存上限區塊)，寫入/遷移/同步拉取與
// options 匯入共用同一份。本檔四條寫入路徑一律經它，沒有任何一條繞得過去。

// 同一個 SW 內的讀改寫一律走 storageQueue／mutate(見本檔上方的佇列註解)，避免兩
// 筆同時 read-modify-write 互相覆蓋。options 頁的清除/刪除/匯入直接寫
// storage.local，與這裡的競態只發生在「清除的同時恰好完成一次淨化」，極罕見
// 且後果僅是多留一筆，接受。

// 新紀錄寫入後掛去抖同步(D12):2 秒內連續分享只同步一次，細節在 sync.js。
function notifySyncRecorded() {
  if (!syncEngine) return;
  Promise.resolve(syncEngine.notifyRecorded()).catch((err) => {
    console.warn('[threads-clean-link] 掛去抖同步失敗', err);
  });
}

// extra(選填):author/handle/excerpt/original/removedParams，只有實際
// 擷取到的鍵才會出現(自動路徑見 extractHistoryExtraFields，右鍵路徑組同形
// 訊息後同樣走它)，Object.assign 進條目時不會覆蓋 url/kind/at/seen。
function recordHistory(url, kind, extra) {
  // 【死鎖守則】ensureDevice 自己也佔一段 storageQueue，必須在 mutate 排隊之前
  // 呼叫:呼叫在此、await 在 fn 內，身分初始化因此永遠排在本次寫入前面。
  const devicePending = ensureDevice();
  return mutate(
    HISTORY_KEY,
    async (list) => {
      const settings = await getSettings();
      if (!settings.saveHistory) return undefined;
      const device = await devicePending;
      const deviceId = device && typeof device.deviceId === 'string' ? device.deviceId : undefined;
      const now = Date.now();

      // 永久合併(見上方紀錄合併區塊的註解):以 post ID 為鍵全表比對，命中
      // 就合併為一筆並浮到最前(不論相隔多久、不論 handle 是否改名);找不
      // 到同鍵條目才新增一筆。
      const dedupIndex = findDedupIndex(list, url);
      let entry;
      if (dedupIndex !== -1) {
        entry = mergeHistoryEntry(list[dedupIndex], url, kind, now, extra, deviceId);
      } else {
        // 不就地改動讀出的陣列(對呼叫端/測試 mock 都更不易踩雷)，組新
        // 陣列。extra 放在前面、核心欄位放在後面覆蓋:即使日後呼叫端不慎
        // 把 url/kind/at/seen 也塞進 extra 物件，核心欄位仍會覆蓋回正確值
        // (防未來的加固)。新條目的 seen[] 由本次呼叫自行構造(信任來源，
        // 不需要再過 sanitizeSeenList)。上限裁切由 mutate 的 cap 處理。
        entry = applyHistorySchema(
          Object.assign({}, extra, { url, kind, at: now, seen: [seenEvent(now, kind, deviceId)] }),
          null,
          now
        );
      }

      // 級聯第二步:失敗卡收編。本次的 original 若是短碼原文，且清單裡有一
      // 張以該短碼原文入庫的失敗卡(當年解析失敗的殘留)，把它併進本次的同
      // 文卡並就地刪除——短碼在這一刻才第一次與貼文對上號。與上一步的同文
      // 合併在同一次讀改寫內完成，只寫一次 storage。
      const adoptIndex = findOriginalAdoptIndex(list, entry.original, dedupIndex);
      if (adoptIndex !== -1) {
        entry = adoptFailureEntry(entry, list[adoptIndex]);
      }

      // 合併/收編掉的舊條目一律從原位移除(dedupIndex 為 -1 時不會命中任何
      // index，adoptIndex 同理)，本次的條目統一浮到最前。儲存上限由 cap 從
      // 尾端(最舊)裁，本次剛寫入的最新一筆永遠保留。
      const rest = list.filter((item, i) => i !== dedupIndex && i !== adoptIndex);
      return { next: [entry].concat(rest) };
    },
    HISTORY_MUTATE_OPTS
  )
    .then((out) => {
      // 配額失敗優雅降級:收緊後仍寫不下，本次這筆紀錄就此放棄，不丟例外，
      // 不影響複製/淨化等主功能。
      if (out.quota) {
        console.warn('[threads-clean-link] 紀錄寫入超出儲存配額，本次略過(不影響複製/淨化功能)', out.cause);
        return;
      }
      // 真的寫進去才掛去抖:設定關閉、配額爆掉、寫入失敗都不該觸發一次同步。
      if (out.written) notifySyncRecorded();
    })
    .catch((err) => {
      console.error('[threads-clean-link] 寫入紀錄失敗', err);
    });
}

// ---- 一次性遷移:既有紀錄整平成永久合併形狀 ----
//
// 【用途】以「url + 5 分鐘視窗」去重時期留下的資料，同一篇貼文可能散成好
// 幾張卡;新寫入已永久合併，這支遷移在 onInstalled 跑一次把既有資料整平。
//
// 【演算法】讀全表 → 依 historyDedupKey 分組(同一個 postKey 為一組，抽不
// 出貼文代碼的以正規化網址 url:<host><path><query> 自成一組)→ 組內以 at
// 最新的一筆為主卡，欄位新值優先(主卡
// 缺席才依序往較舊的卡取值)、seen[] 取各卡聯集(無 seen 的舊卡以自身 at 補
// 種一筆)按 at 升序裁到最新 SEEN_MAX、主卡的 url/kind/at 原樣保留 → 再掃一
// 輪失敗卡收編(文章卡.original === 失敗卡.url，見 findOriginalAdoptIndex)
// → 寫回。合併後的卡放在該組第一次出現的位置(紀錄是新到舊排列，第一次出
// 現的通常就是主卡本身)，整體時序不被打亂。
//
// 【冪等】已經整平過的資料再跑一次不會有任何變化:單卡組原樣保留(連物件
// 參照都不換)，失敗卡收編後原卡已刪除、第二輪掃不到配對。實作據此在「每
// 一筆都是原參照」時直接短路、連寫回都不做，避免每次更新都對 storage 做一
// 次無意義的整表寫入。
//
// 【競態】走 mutate(storageQueue)串行，與 recordHistory 的 read-modify-write
// 互斥——遷移讀到的必定是完整的表，也不會被同時落盤的新紀錄覆蓋。寫回同樣
// 過 capHistory(合併只會讓資料變少，這裡純粹是不讓任何一條寫入路徑繞過儲存
// 上限防線)。配額失敗比照 recordHistory:收緊再寫一次，仍失敗最多維持舊形
// 狀的紀錄(仍可正常瀏覽)，不丟例外、不影響任何主功能。

// 純函式:比較兩筆條目的 at(新到舊)。at 不是有限數字者一律排到最後(那筆
// 時間本身就不可信，不該被選為主卡);刻意不用相減，避免兩個 -Infinity 相
// 減得到 NaN 讓排序結果未定義。
function compareEntryAtDesc(a, b) {
  const av = a && typeof a.at === 'number' && isFinite(a.at) ? a.at : -Infinity;
  const bv = b && typeof b.at === 'number' && isFinite(b.at) ? b.at : -Infinity;
  if (av === bv) return 0;
  return av < bv ? 1 : -1;
}

// 整平多張卡時必須帶過來的雲端身分欄位(見 mergeHistoryGroup)。deletedAt 也在
// 列:少了它，一組裡混著墓碑與活卡時整平出來的卡永遠沒有 deletedAt 鍵，待上傳
// 的刪除意圖會在遷移中無聲蒸發(全組皆墓碑時尤其明顯——使用者刪掉的貼文會整批
// 復活)。實際取值另有墓碑裁決，見 mergeHistoryGroup。
const MERGE_CARRY_FIELDS = ['id', 'serverUpdatedAt', 'deletedAt'];

// 純函式:把同一組(同合併鍵)的多張卡合成一張。單卡組由呼叫端直接原樣保
// 留，不會進到這裡。
function mergeHistoryGroup(group) {
  // Array#sort 穩定:at 相同時維持原陣列順序(新到舊排列下即較新者在前)。
  const ordered = group.slice().sort(compareEntryAtDesc);
  const primary = ordered[0];
  const merged = { url: primary.url, at: primary.at };
  if (primary.kind !== undefined) merged.kind = primary.kind;
  for (let f = 0; f < TCLCore.MERGEABLE_FIELDS.length; f++) {
    const field = TCLCore.MERGEABLE_FIELDS[f];
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i][field] !== undefined) {
        merged[field] = ordered[i][field];
        break;
      }
    }
  }
  // 雲端身分欄位一併帶過來:id 取最新一張有值的卡(整平時憑空換 id 等於在雲
  // 端另開一張卡)，serverUpdatedAt 同理。其餘五個欄位由 migrateHistorySchema
  // 在下一支遷移統一補齊(postKey/original/receivedAt 皆可由整平後的卡推導，
  // dirty 為 true、deletedAt 為 null)。
  for (let s = 0; s < MERGE_CARRY_FIELDS.length; s++) {
    const field = MERGE_CARRY_FIELDS[s];
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i][field] !== undefined) {
        merged[field] = ordered[i][field];
        break;
      }
    }
  }
  // 墓碑裁決:同一組裡混著墓碑與活卡時，活卡優先、deletedAt 取 null——墓碑代
  // 表「當年刪過」，之後又有一張活卡出現代表使用者後來重新淨化過同一篇貼文，
  // 那是明確的復活意圖(語意與 fromSyncItem 的復活、匯入的 deletedAt 清空一
  // 致)。全組皆墓碑才保留墓碑身分，deletedAt 取 max——刪除意圖只會往後推移，
  // 取最舊的那一刻會讓水位線比較時把這張卡誤判成早該被 ack 的殘留。
  let anyTombstone = false;
  let anyLive = false;
  let latestDeletedAt = null;
  for (let i = 0; i < ordered.length; i++) {
    if (TCLCore.isTombstone(ordered[i])) {
      anyTombstone = true;
      if (latestDeletedAt === null || ordered[i].deletedAt > latestDeletedAt) {
        latestDeletedAt = ordered[i].deletedAt;
      }
    } else {
      anyLive = true;
    }
  }
  if (anyTombstone) merged.deletedAt = anyLive ? null : latestDeletedAt;
  merged.seen = unionSeenEvents(ordered.map((e) => TCLCore.entrySeenEvents(e)));
  return merged;
}

// 純函式:整表分組合併。不是物件、或 url 不是字串的條目無從分組，原樣保
// 留在原位(遷移只做合併，不順手清資料;真正的形狀把關在 options 讀取端)。
function mergeHistoryByDedupKey(list) {
  const groups = new Map();
  const slots = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object' || typeof item.url !== 'string') {
      slots.push({ item });
      continue;
    }
    const key = historyDedupKey(item.url);
    const group = groups.get(key);
    if (group) {
      group.push(item);
      continue;
    }
    groups.set(key, [item]);
    slots.push({ key });
  }

  return slots.map((slot) => {
    if (slot.key === undefined) return slot.item;
    const group = groups.get(slot.key);
    // 單卡組原樣保留(同一個物件參照)，冪等短路據此判定。
    return group.length === 1 ? group[0] : mergeHistoryGroup(group);
  });
}

// 純函式:遷移的第二輪——失敗卡收編。文章卡的 original 是短碼原文，且表內
// 有一張 url 恰為該短碼的失敗卡時，把失敗卡併進文章卡並刪除。一張失敗卡
// 只會被收編一次(removed 記錄)。沒有任何配對時回傳原陣列參照，讓冪等短路
// 得以成立。
function adoptFailureEntriesInList(list) {
  const indexByUrl = new Map();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && typeof item.url === 'string' && !indexByUrl.has(item.url)) indexByUrl.set(item.url, i);
  }

  const removed = new Set();
  let next = null;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object' || !isAdoptableOriginal(item.original)) continue;
    const target = indexByUrl.get(item.original);
    if (target === undefined || target === i || removed.has(target)) continue;
    if (!next) next = list.slice();
    next[i] = adoptFailureEntry(next[i], list[target]);
    removed.add(target);
  }
  if (!next) return list;
  return next.filter((item, i) => !removed.has(i));
}

function migrateHistoryMerge() {
  return mutate(
    HISTORY_KEY,
    (list) => {
      // 空表(首裝)與單卡表必然無可合併，連讀後計算都省。
      if (list.length < 2) return undefined;
      const next = adoptFailureEntriesInList(mergeHistoryByDedupKey(list));
      // 冪等短路:每一筆都是原物件參照(沒有任何一組被合併、沒有任何一張失
      // 敗卡被收編)就不寫回。
      if (next.length === list.length && next.every((item, i) => item === list[i])) return undefined;
      return { next };
    },
    HISTORY_MUTATE_OPTS
  )
    .then((out) => {
      if (out.quota) {
        console.warn('[threads-clean-link] 紀錄遷移寫入超出儲存配額，本次略過(不影響既有紀錄與主功能)', out.cause);
      }
    })
    .catch((err) => {
      console.error('[threads-clean-link] 紀錄遷移失敗', err);
    });
}

// ---- 一次性遷移:既有紀錄補齊雲端 schema 欄位 ----
//
// 【動機】計劃 4.1 為每筆紀錄新增七個欄位(id/postKey/original/receivedAt/
// dirty/serverUpdatedAt/deletedAt)。新寫入的紀錄由 applyHistorySchema 帶
// 齊，既有庫存則靠這支遷移在 onInstalled 補一次。
//
// 【只補缺席欄位】已具備的欄位一律原封不動——尤其 id(雲端卡片的身分，重新
// 生成等於每次更新都在雲端多開一張卡)與 dirty(dirty:false 代表已同步，重新
// 標髒會讓整表無謂重傳)。
//
// 【seen 一併消毒】seen[] 過 TCLCore.sanitizeSeenList:遷移前的庫存可能是舊
// 版寫入的、或使用者匯入過的資料，長度不受 SEEN_MAX 約束、也可能夾著髒項。
// 不在這裡收斂的話，上雲時 toSyncItem 會把超量的 seen 整串送出去，本機的
// receivedAt 推導也會被髒項牽動。
//
// 【冪等】每一筆都已具備七個欄位、seen 也不需要收斂時，逐筆回傳原物件參照，
// 據此短路、連寫回都不做。畸形條目(非物件、url 非字串)無從算 postKey，整筆
// 原樣保留。
//
// 【競態】與 migrateHistoryMerge／recordHistory 共用 storageQueue 串行;排在
// merge 之後執行，整平產生的新卡才補得到欄位。配額失敗的處理同 merge。

// 消毒結果與原事件是否完全一致(鍵集合與值都相同)。fillHistorySchema 的冪等
// 短路判準。
function sameSeenEvent(sanitized, original) {
  if (!original || typeof original !== 'object') return false;
  const keys = Object.keys(sanitized);
  if (keys.length !== Object.keys(original).length) return false;
  return keys.every((key) => sanitized[key] === original[key]);
}

// 純函式:補齊單筆條目缺席的 schema 欄位並收斂 seen[]。無事可做時回傳原物件
// 參照。
function fillHistorySchema(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') return entry;
  let missing = false;
  for (let i = 0; i < HISTORY_SCHEMA_FIELDS.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(entry, HISTORY_SCHEMA_FIELDS[i])) {
      missing = true;
      break;
    }
  }
  // 消毒前後**逐筆**比較:只比陣列長度會漏掉「筆數不變但某一筆被剝掉一個
  // 欄位」的情形(髒 deviceId 正是如此)，髒值於是躲過遷移繼續留在 storage、
  // 之後照樣上雲。完全相同才維持原陣列參照，讓冪等短路成立。
  let seen = null;
  if (Array.isArray(entry.seen)) {
    const sanitized = TCLCore.sanitizeSeenList(entry.seen);
    const unchanged =
      sanitized.length === entry.seen.length &&
      sanitized.every((event, i) => sameSeenEvent(event, entry.seen[i]));
    if (!unchanged) seen = sanitized;
  }
  if (!missing && seen === null) return entry;

  const next = Object.assign({}, entry);
  if (seen !== null) next.seen = seen;
  function fill(field, value) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) next[field] = value;
  }
  fill('id', TCLCore.randomUuid());
  fill('postKey', TCLCore.postKeyOf(next.url));
  fill('original', next.url);
  fill('receivedAt', TCLCore.entryEarliestAt(next));
  // 遷移補齊的資料尚未上傳過，一律標髒;已有 dirty 的條目不動(dirty:false
  // 是「已同步」，重新標髒會讓整表無謂重傳)。
  fill('dirty', true);
  fill('serverUpdatedAt', null);
  fill('deletedAt', null);
  return next;
}

function migrateHistorySchema() {
  return mutate(
    HISTORY_KEY,
    (list) => {
      if (list.length === 0) return undefined;
      const next = list.map(fillHistorySchema);
      // 冪等短路:每一筆都是原物件參照(沒有任何一筆缺欄位)就不寫回。
      if (next.every((item, i) => item === list[i])) return undefined;
      return { next };
    },
    HISTORY_MUTATE_OPTS
  )
    .then((out) => {
      if (out.quota) {
        console.warn('[threads-clean-link] 紀錄欄位遷移寫入超出儲存配額，本次略過(不影響既有紀錄與主功能)', out.cause);
      }
    })
    .catch((err) => {
      console.error('[threads-clean-link] 紀錄欄位遷移失敗', err);
    });
}
