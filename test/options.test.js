// test/options.test.js — options 頁邏輯層(options.js)的行為契約。
// 純函式(過濾/匯入合併/匯出形狀/統計聚合)直接打;controller 以最小 DOM
// stub 做一條 smoke(整條 init 渲染跑得完、清單筆數與計數正確)——demo
// 階段踩過「區域變數遮蔽翻譯函式、整頁渲染炸掉但語法全綠」的雷,smoke
// 就是為了堵這一類執行期炸彈,不逐一測版面。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createChromeStorage, runInSandbox } = require('./support/helpers');

const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const URL_B = 'https://www.threads.com/@user.b/post/DeF456';
const URL_C = 'https://threads.net/@user_c/post/GhI789';

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 純函式 ----

test('filterEntries:kind 過濾與關鍵字過濾(不分大小寫)可併用', () => {
  const entries = [
    { url: URL_A, kind: 'share', at: 3 },
    { url: URL_B, kind: 'strip', at: 2 },
    { url: URL_C, kind: 'menu', at: 1 },
  ];

  assert.equal(options.filterEntries(entries, 'all', '').length, 3);
  assert.deepEqual(
    options.filterEntries(entries, 'strip', '').map((e) => e.url),
    [URL_B]
  );
  assert.deepEqual(
    options.filterEntries(entries, 'all', 'USERA').map((e) => e.url),
    [URL_A]
  );
  assert.equal(options.filterEntries(entries, 'share', 'user_c').length, 0);
});

// 0.4.0 新增:貼文互動列複製 icon(post-icon.js)的紀錄 kind:'icon'——
// 篩選 chip(options.html 的 #chips)與 filterEntries 共用同一份純函式,
// 這裡直接驗證 kind 過濾對新 kind 一樣生效,不用另外搭 DOM 才能測。
test('filterEntries:kind 為 icon 時可單獨篩出貼文按鈕來源的紀錄', () => {
  const entries = [
    { url: URL_A, kind: 'share', at: 3 },
    { url: URL_B, kind: 'icon', at: 2 },
    { url: URL_C, kind: 'menu', at: 1 },
  ];

  assert.deepEqual(
    options.filterEntries(entries, 'icon', '').map((e) => e.url),
    [URL_B]
  );
  assert.equal(options.filterEntries(entries, 'all', '').length, 3);
});

test('parseImportText:非 JSON 與缺 entries 陣列各回報對應錯誤,合法時回傳 entries', () => {
  assert.deepEqual(options.parseImportText('not json'), { ok: false, error: 'badJson' });
  assert.deepEqual(options.parseImportText('{"app":"x"}'), { ok: false, error: 'noEntries' });

  const parsed = options.parseImportText(`{"entries":[{"url":"${URL_A}"}]}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
});

test('mergeImportedEntries:錨定驗證 url、以 url 去重、kind/at 非法時套預設,結果新到舊', () => {
  const NOW = 1000000;
  const existing = [{ url: URL_A, kind: 'share', at: 500 }];
  const imported = [
    { url: URL_A, kind: 'strip', at: 600 }, // 與現有重複 → 略過
    { url: URL_B, kind: 'evil-kind', at: 900 }, // kind 非白名單 → 'share'
    { url: URL_C, kind: 'menu' }, // at 缺失 → now
    { url: URL_B + '/extra', kind: 'share', at: 1 }, // 尾隨路徑 → 略過
    { url: 'https://evil.example/@x/post/y', kind: 'share', at: 1 }, // 網域不符 → 略過
    { notUrl: true }, // 形狀不對 → 略過
  ];

  const result = options.mergeImportedEntries(existing, imported, NOW);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 4);
  assert.deepEqual(
    result.merged.map((e) => e.url),
    [URL_C, URL_B, URL_A],
    '合併結果應新到舊排序(URL_C 的 at 補 now 最大)'
  );
  assert.equal(result.merged[1].kind, 'share', '非白名單 kind 應退回 share');
  assert.equal(result.merged[0].at, NOW, 'at 缺失應補 now');
});

// 【使用者拍板，規格翻轉】紀錄不設上限:舊版在此裁到 HISTORY_LIMIT(1000)
// 筆、汰舊留新;新版合併結果完全不裁切，連同 HISTORY_LIMIT 這個常數與其
// api 匯出都一併移除(此檔內唯一用途就是這道截斷)。這裡改寫成鎖「不裁切」
// 的正面斷言，而非單純刪除，讓新行為有測試覆蓋。
test('mergeImportedEntries:合併結果不裁切，超過舊版上限(1000)也全數保留', () => {
  const existing = Array.from({ length: 999 }, (_, i) => ({
    url: `https://www.threads.com/@u/post/E${i}`,
    kind: 'share',
    at: 10000 + i,
  }));
  const imported = [
    { url: URL_A, kind: 'share', at: 99999 },
    { url: URL_B, kind: 'share', at: 1 }, // 舊版會被裁掉的最舊一筆，新版應保留
  ];

  const result = options.mergeImportedEntries(existing, imported, 50000);
  assert.equal(result.merged.length, 1001, '999 + 2 筆全數保留，不裁切');
  assert.equal(result.merged[0].url, URL_A, '新到舊排序，最新的在最前');
  assert.equal(
    result.merged.some((e) => e.url === URL_B),
    true,
    '舊版會被上限裁掉的最舊一筆，新版應保留'
  );
  assert.equal(options.HISTORY_LIMIT, undefined, 'HISTORY_LIMIT 常數已隨上限移除一併撤除');
});

test('buildExportPayload:輸出 app/version/exportedAt/entries 形狀,entries 只留三欄', () => {
  const payload = options.buildExportPayload(
    [{ url: URL_A, kind: 'share', at: 123, extra: 'junk' }],
    '2026-08-16T00:00:00.000Z'
  );

  assert.equal(payload.app, 'threads-clean-link');
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, '2026-08-16T00:00:00.000Z');
  assert.deepEqual(payload.entries, [{ url: URL_A, kind: 'share', at: 123 }]);
});

// 0.5.0 方案甲(歷史即收藏):entries 擴充選填 author/handle/excerpt，為字串
// 時才輸出，規則與 sanitizeEntries/mergeImportedEntries 一致。
test('buildExportPayload:author/handle/excerpt 為字串時一併輸出，非字串或缺席則不輸出該欄', () => {
  const payload = options.buildExportPayload(
    [
      { url: URL_A, kind: 'share', at: 1, author: 'Dafu', handle: '@dafucoding', excerpt: 'hi' },
      { url: URL_B, kind: 'strip', at: 2, author: 12345 },
    ],
    '2026-08-18T00:00:00.000Z'
  );

  assert.deepEqual(payload.entries[0], {
    url: URL_A,
    kind: 'share',
    at: 1,
    author: 'Dafu',
    handle: '@dafucoding',
    excerpt: 'hi',
  });
  assert.deepEqual(payload.entries[1], { url: URL_B, kind: 'strip', at: 2 }, '非字串的 author 不輸出該欄');
});

// 【審查修正】buildExportPayload 先前漏了 seen/original/removedParams
// 三欄，使用者匯出備份、換裝置/瀏覽器匯入回來時這三欄資料會無聲消失。
// 補上後沿用同一套「缺席不寫」慣例:seen 是空陣列或非陣列都不輸出、
// original 非字串不輸出、removedParams 是空陣列或非陣列都不輸出。
test('buildExportPayload:seen/original/removedParams 有資料時一併輸出，缺席/空陣列則不輸出該欄', () => {
  const payload = options.buildExportPayload(
    [
      {
        url: URL_A,
        kind: 'share',
        at: 1,
        seen: [{ at: 1, kind: 'share' }, { at: 2, kind: 'strip' }],
        original: 'https://l.threads.net/share/abc',
        removedParams: [{ key: 'igsh', value: 'aBc' }],
      },
      { url: URL_B, kind: 'strip', at: 2, seen: [], original: 123, removedParams: [] },
    ],
    '2026-08-19T00:00:00.000Z'
  );

  assert.deepEqual(payload.entries[0], {
    url: URL_A,
    kind: 'share',
    at: 1,
    seen: [{ at: 1, kind: 'share' }, { at: 2, kind: 'strip' }],
    original: 'https://l.threads.net/share/abc',
    removedParams: [{ key: 'igsh', value: 'aBc' }],
  });
  assert.deepEqual(
    payload.entries[1],
    { url: URL_B, kind: 'strip', at: 2 },
    '空陣列的 seen/removedParams 與非字串的 original 都不輸出該欄'
  );
});

// 0.5.0 方案甲:匯入的 url 額外容忍尾隨斜線/query/hash 並正規化(前身是
// 收藏庫基座的 FAVORITE_URL_PATTERN，方案甲改名為通用的貼文 url 驗證);
// 這裡直接驗證這個新增的容忍度，不影響既有「嚴格格式才收」的斷言。
test('mergeImportedEntries:url 容忍尾隨斜線/query/hash 並正規化(前身收藏庫的網址驗證邏輯)', () => {
  const result = options.mergeImportedEntries([], [{ url: `${URL_A}/?xmt=AQGabc`, kind: 'share', at: 1 }], 1000);
  assert.equal(result.added, 1);
  assert.equal(result.merged[0].url, URL_A, 'url 應正規化為不含尾隨斜線/query 的乾淨網址');
});

// 0.5.0 方案甲:匯入的 author/handle/excerpt 逐條 sanitize(截斷 100/100/
// 2000，非字串整欄丟棄)，規則與 background.js 落盤前的處理對齊。
test('mergeImportedEntries:author/handle 截斷至 100 字元、excerpt 截斷至 2000 字元，非字串欄位整欄丟棄', () => {
  const result = options.mergeImportedEntries(
    [],
    [
      {
        url: URL_A,
        kind: 'share',
        at: 1,
        author: 'A'.repeat(150),
        handle: 'H'.repeat(150),
        excerpt: 'E'.repeat(2500),
      },
      {
        url: URL_B,
        kind: 'share',
        at: 1,
        author: 12345,
        handle: ['@x'],
        excerpt: { text: 'hi' },
      },
    ],
    1000
  );

  assert.equal(result.added, 2);
  const truncated = result.merged.find((e) => e.url === URL_A);
  assert.equal(truncated.author.length, 100);
  assert.equal(truncated.author, 'A'.repeat(100));
  assert.equal(truncated.handle.length, 100);
  assert.equal(truncated.excerpt.length, 2000);

  const dropped = result.merged.find((e) => e.url === URL_B);
  assert.deepEqual(Object.keys(dropped).sort(), ['at', 'kind', 'url'], '非字串型別的選填欄位應整欄不寫入');
});

// 紀錄去重合併新增(PM 明列測項):匯入條目帶偽造 seen 的 sanitize。匯入檔
// 是外部輸入，seen[] 逐筆過 at 有限數字、kind 白名單，不合法的記錄整筆丟
// 棄、不整組作廢；全部不合法時整欄不寫入。上限 SEEN_MAX(50)一併裁切，防
// 匯入檔夾帶超長偽造陣列。
test('mergeImportedEntries:匯入條目帶偽造 seen 時逐筆 sanitize，且裁到上限 50 筆', () => {
  const oversized = Array.from({ length: 60 }, (_, i) => ({ at: i, kind: 'share' }));
  const result = options.mergeImportedEntries(
    [],
    [
      {
        url: URL_A,
        kind: 'share',
        at: 1,
        seen: [
          { at: 10, kind: 'share' }, // 合法
          { at: 'forged', kind: 'share' }, // at 非數字 → 丟棄
          { at: 20, kind: 'not-a-real-kind' }, // kind 不在白名單 → 丟棄
          null, // 非物件 → 丟棄
          { at: 30, kind: 'icon' }, // 合法
        ],
      },
      { url: URL_B, kind: 'share', at: 1, seen: [{ at: 'x', kind: 'evil' }] },
      { url: URL_C, kind: 'share', at: 1, seen: oversized },
    ],
    1000
  );

  const withSeen = result.merged.find((e) => e.url === URL_A);
  assert.deepEqual(withSeen.seen, [
    { at: 10, kind: 'share' },
    { at: 30, kind: 'icon' },
  ]);

  const allDropped = result.merged.find((e) => e.url === URL_B);
  assert.equal('seen' in allDropped, false, 'seen[] 全部不合法時，整欄不寫入');

  const capped = result.merged.find((e) => e.url === URL_C);
  assert.equal(capped.seen.length, 50, '匯入的 seen[] 應裁到上限 50 筆');
  assert.equal(capped.seen[0].at, oversized[10].at, '裁切保留最新的 50 筆(捨棄最舊的 10 筆)');
  assert.equal(capped.seen[49].at, oversized[59].at);
});

// F 案(紀錄資料層補齊 original/removedParams，對齊手機 ShareHistoryItem):
// 匯入檔的 original/removedParams 屬外部輸入，同樣要逐欄 sanitize，規則
// 與 background.js 落盤前的處理對齊。

test('mergeImportedEntries:匯入條目帶合法的 original/removedParams 時原樣寫入；original 與(正規化後的)url 相同時整欄丟棄', () => {
  const result = options.mergeImportedEntries(
    [],
    [
      {
        url: URL_A,
        kind: 'strip',
        at: 1,
        original: `${URL_A}?xmt=AQGabc`,
        removedParams: [{ key: 'xmt', value: 'AQGabc' }],
      },
      {
        // url 帶尾隨 query，正規化後等於 URL_B;original 與正規化後的
        // url(URL_B)相同 → 沒有額外資訊，應整欄丟棄。
        url: `${URL_B}?xmt=AQGabc`,
        kind: 'share',
        at: 1,
        original: URL_B,
      },
    ],
    1000
  );

  const withOriginal = result.merged.find((e) => e.url === URL_A);
  assert.equal(withOriginal.original, `${URL_A}?xmt=AQGabc`);
  assert.deepEqual(withOriginal.removedParams, [{ key: 'xmt', value: 'AQGabc' }]);

  const sameAsUrl = result.merged.find((e) => e.url === URL_B);
  assert.equal('original' in sameAsUrl, false, '與正規化後的 url 相同的 original 不存');
});

test('mergeImportedEntries:匯入條目帶偽造 removedParams(key 缺席/超長、value 超長、型別不符)時逐筆 sanitize，且裁到上限 20 筆', () => {
  const oversized = Array.from({ length: 25 }, (_, i) => ({ key: `p${i}`, value: `v${i}` }));
  const result = options.mergeImportedEntries(
    [],
    [
      {
        url: URL_A,
        kind: 'strip',
        at: 1,
        removedParams: [
          { key: 'xmt', value: 'AQGabc' }, // 合法
          { key: '', value: 'x' }, // key 空字串 → 丟棄
          { key: 'k'.repeat(70), value: 'x' }, // key 超過 64 字 → 丟棄
          { key: 'v', value: 'v'.repeat(600) }, // value 超過 512 字 → 丟棄
          { key: 123, value: 'x' }, // key 非字串 → 丟棄
          'not-an-object', // 非物件 → 丟棄
        ],
      },
      { url: URL_B, kind: 'strip', at: 1, removedParams: 'not-an-array' },
      { url: URL_C, kind: 'strip', at: 1, removedParams: oversized },
    ],
    1000
  );

  const withParams = result.merged.find((e) => e.url === URL_A);
  assert.deepEqual(withParams.removedParams, [{ key: 'xmt', value: 'AQGabc' }]);

  const notArray = result.merged.find((e) => e.url === URL_B);
  assert.equal('removedParams' in notArray, false, '非陣列的 removedParams 整欄不寫入');

  const capped = result.merged.find((e) => e.url === URL_C);
  assert.equal(capped.removedParams.length, 20, '應裁到上限 20 筆');
  assert.deepEqual(capped.removedParams[0], oversized[0]);
  assert.deepEqual(capped.removedParams[19], oversized[19]);
});

test('aggregateStats:總數、來源計數、本週/上週、近 14 天日曆日分桶、最舊時間戳', () => {
  const DAY = 86400000;
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime(); // 中午,避開日界線
  const t0 = new Date(2026, 7, 10, 0, 0, 0).getTime();
  const entries = [
    { url: URL_A, kind: 'share', at: nowTs - 3600e3 }, // 今天
    { url: URL_B, kind: 'share', at: nowTs - 7200e3 }, // 今天
    { url: URL_C, kind: 'strip', at: t0 - 3600e3 }, // 昨天
    { url: URL_A, kind: 'menu', at: t0 - 12 * DAY - 3600e3 }, // 13 個日曆日前
    { url: URL_B, kind: 'share', at: t0 - 14 * DAY - 3600e3 }, // 圖表範圍外
  ];

  const stats = options.aggregateStats(entries, nowTs);
  assert.equal(stats.total, 5);
  // 【規格衝突,如實記錄】counts 補上 icon:0(本輪修正項目 2)後,這個既有的
  // 整形斷言必然要跟著加上 icon 鍵才能繼續通過——與「既有測試斷言一字不准
  // 動」的紀律直接衝突,屬修正 counts 缺 icon 鍵這個 bug 本身必然牽動的
  // 唯一一處,並非另外收緊或弱化判斷,故在此保留機械性更新,PM 覆核。
  assert.deepEqual(stats.counts, { share: 3, strip: 1, menu: 1, icon: 0 });
  assert.equal(stats.week, 3, '滾動 7 天:今天兩筆 + 昨天一筆');
  assert.equal(stats.weekPrev, 1, '前一個 7 天:只有 13 天前那筆');
  assert.equal(stats.days[13], 2, '索引 13 = 今天');
  assert.equal(stats.days[12], 1, '昨天');
  assert.equal(stats.days[0], 1, '13 個日曆日前落在最左桶');
  assert.equal(stats.oldestAt, t0 - 14 * DAY - 3600e3);
});

// KINDS 表補上 icon 後，aggregateStats 的 counts 要能統計 kind:'icon' 的
// 筆數(供 options.html 統計磚 #statIcon 使用，修正前 counts[e.kind]++ 對
// 缺席鍵會產生 NaN 而不計數)，且沒有 icon 來源紀錄時 counts.icon 應為 0
// 而非 undefined。
test('aggregateStats:counts 應統計 kind 為 icon 的筆數;無 icon 來源時 counts.icon 為 0(而非 undefined)', () => {
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime();
  const stats = options.aggregateStats(
    [
      { url: URL_A, kind: 'icon', at: nowTs - 3600e3 },
      { url: URL_B, kind: 'icon', at: nowTs - 7200e3 },
      { url: URL_C, kind: 'share', at: nowTs - 3600e3 },
    ],
    nowTs
  );
  assert.equal(stats.counts.icon, 2);
  assert.equal(stats.counts.share, 1);
  assert.equal(stats.total, 3);

  const noIcon = options.aggregateStats([{ url: URL_A, kind: 'share', at: nowTs }], nowTs);
  assert.equal(noIcon.counts.icon, 0);
});

test('sanitizeEntries:非陣列→空;形狀不對的項目逐筆丟棄', () => {
  assert.deepEqual(options.sanitizeEntries(null), []);
  assert.deepEqual(options.sanitizeEntries('junk'), []);

  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'share', at: 1 },
    { url: 42, kind: 'share', at: 1 },
    { url: URL_B, kind: 'nope', at: 1 },
    { url: URL_C, kind: 'menu', at: 'NaN' },
    null,
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// 0.4.0 新增:KINDS 表補上 icon 後,sanitizeEntries 的白名單(靠
// Object.prototype.hasOwnProperty.call(KINDS, e.kind))應收下 kind:'icon',
// 不再像先前那樣被當成未知 kind 丟棄。
test('sanitizeEntries:kind 為 icon(貼文按鈕)的項目應保留,不再被白名單丟棄', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'icon', at: 1 },
    { url: URL_B, kind: 'nope', at: 1 },
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// 縱深防禦(PM 審查後補):url 額外過 POST_URL_PATTERN 形狀驗證——渲染層
// buildEntryCard 的 openLink.href = e.url、複製到剪貼簿都是 url sink,
// 讀取階段就該擋掉形狀不對的 url，不依賴「寫入端永遠沒漏」的假設。上一輪
// 收藏庫基座的 sanitizeFavorites 有這道檢查，方案甲把收藏搬進
// sanitizeEntries 時漏了，這裡補回來。
test('sanitizeEntries:url 形狀不對(非 threads 網域、缺 /post/ 區段、夾帶非法字元等)的條目整筆丟棄', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'share', at: 1 }, // 合法
    { url: 'https://www.evil.com/@evil/post/x', kind: 'share', at: 1 }, // 非 threads 網域
    { url: 'https://www.threads.com/@user/post', kind: 'share', at: 1 }, // 缺貼文 id
    { url: 'not-a-url', kind: 'share', at: 1 }, // 完全不是網址
    { url: 'https://www.threads.com/@user/post/x<y>', kind: 'share', at: 1 }, // 夾帶非法字元
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// 【審查修正，url 樣式統一】長度上限 60→80(handle/post id 各自)，字元類
// 不變——釘住新邊界值的表格驅動測試見下方「跨層釘住(表格驅動)[url 形狀]」
// (work item 8 把這個獨立案例併進同一組表格驅動寫法，不重複維護兩份)。

// 0.5.0 方案甲(歷史即收藏):entries 擴充選填 author/handle/excerpt。核心
// 欄位(url/kind/at)合法時，選填欄位為字串則截斷至長度上限，非字串則整欄
// 丟棄(不影響核心欄位本身，entry 仍保留)——與 mergeImportedEntries 的
// sanitizeTextField 規則一致，縱深防禦不依賴 background.js 寫入端沒漏。
test('sanitizeEntries:author/handle/excerpt 為字串時截斷至長度上限，非字串則整欄丟棄(entry 仍保留)', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'share', at: 1, author: 'A'.repeat(150), handle: 'H'.repeat(150), excerpt: 'E'.repeat(2500) },
    { url: URL_B, kind: 'share', at: 1, author: 12345, handle: ['@x'], excerpt: { text: 'hi' } },
  ]);

  assert.equal(cleaned[0].author.length, 100);
  assert.equal(cleaned[0].handle.length, 100);
  assert.equal(cleaned[0].excerpt.length, 2000);

  assert.deepEqual(Object.keys(cleaned[1]).sort(), ['at', 'kind', 'url'], '非字串型別的選填欄位應整欄不寫入，但 entry 本身仍保留');
});

// 【審查修正】sanitizeTextField 補空字串丟棄，與 background.js 的
// sanitizeHistoryField 對齊(該函式明文「空字串比照非字串同樣丟棄」)。
test('sanitizeEntries:author/handle/excerpt 為空字串時比照非字串整欄丟棄，不落空字串佔位', () => {
  const cleaned = options.sanitizeEntries([{ url: URL_A, kind: 'share', at: 1, author: '', handle: '', excerpt: '' }]);
  assert.deepEqual(Object.keys(cleaned[0]).sort(), ['at', 'kind', 'url'], '空字串的選填欄位應整欄不寫入');
});

// 紀錄去重合併新增:seen[] 是「先前已經落盤的資料」，讀取階段(sanitizeEntries)
// 同樣要逐筆 sanitize，偽造/損毀的記錄(at 非數字、kind 不在白名單、非物件)
// 逐筆丟棄，不因此整個陣列作廢;真的沒有合法記錄剩下時整欄不寫入(缺席不落
// 空陣列佔位，與 author/handle/excerpt 的慣例一致)。kind 缺席的記錄(手機
// 版語意的起始種子紀錄，見 background.js 的 mergeHistoryEntry)須視為合法
// 保留，不得誤殺。另外併入 fix/detail-mimic 車道的獨有案例:seen 整欄本身
// 非陣列(不是陣列內某一筆形狀不對，是整個欄位型別就錯)同樣視為缺席，不
// 輸出該欄。
test('sanitizeEntries:seen[] 逐筆 sanitize，偽造/損毀的記錄丟棄、缺 kind 的種子紀錄視為合法保留；全丟或整欄非陣列時都不寫入', () => {
  const cleaned = options.sanitizeEntries([
    {
      url: URL_A,
      kind: 'share',
      at: 1,
      seen: [
        { at: 50 }, // 合法(手機版語意的起始種子紀錄，無 kind)
        { at: 100, kind: 'share' }, // 合法
        { at: 'NaN', kind: 'share' }, // at 非數字 → 丟棄
        { at: 200, kind: 'evil' }, // kind 不在白名單 → 丟棄
        'not-an-object', // 非物件 → 丟棄
        { at: 300, kind: 'icon' }, // 合法
      ],
    },
    { url: URL_B, kind: 'share', at: 1, seen: [{ at: 'NaN', kind: 'evil' }] },
    { url: URL_C, kind: 'share', at: 1 },
    { url: 'https://www.threads.com/@userd/post/JkL012', kind: 'share', at: 1, seen: 'not-an-array' },
  ]);

  const withSeen = cleaned.find((e) => e.url === URL_A);
  assert.deepEqual(withSeen.seen, [
    { at: 50 },
    { at: 100, kind: 'share' },
    { at: 300, kind: 'icon' },
  ]);

  const allDropped = cleaned.find((e) => e.url === URL_B);
  assert.equal('seen' in allDropped, false, 'seen[] 全部不合法時，整欄不寫入');

  const noSeen = cleaned.find((e) => e.url === URL_C);
  assert.equal('seen' in noSeen, false, '原本就沒有 seen 欄位的舊資料，讀取後也不憑空生出來');

  const notArray = cleaned.find((e) => e.url === 'https://www.threads.com/@userd/post/JkL012');
  assert.equal('seen' in notArray, false, 'seen 整欄非陣列(不是陣列內某一筆形狀不對)同樣視為缺席，不輸出該欄');
});

// F 案(紀錄資料層補齊 original/removedParams，對齊手機 ShareHistoryItem):
// 讀取階段(sanitizeEntries)同樣要逐欄 sanitize original/removedParams，
// 規則與 mergeImportedEntries 那組測試一致。

// F1 取嚴(原「超長截斷至 2048」→「超長整欄丟棄」;新增白名單:original 需吻合
// SHARE 或容尾 POST 樣式,偽造/畸形殘 URL 一律丟棄)。見 TCLCore.sanitizeOriginal。
test('sanitizeEntries(F1):original 白名單通過者原樣保留,與 url 相同/非字串/空字串/超長/畸形一律整欄丟棄', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'strip', at: 1, original: `${URL_A}?xmt=AQGabc` }, // 合法(容尾 POST)
    { url: URL_B, kind: 'share', at: 1, original: URL_B }, // 與自己的 url 相同 → 丟棄
    { url: URL_C, kind: 'share', at: 1, original: 12345 }, // 非字串 → 丟棄
    {
      url: 'https://www.threads.com/@userd/post/JkL012',
      kind: 'share',
      at: 1,
      original: `x${'a'.repeat(2100)}`,
    }, // 超長且非白名單 → 整欄丟棄(F1:不再截斷)
  ]);

  assert.equal(cleaned.find((e) => e.url === URL_A).original, `${URL_A}?xmt=AQGabc`);
  assert.equal('original' in cleaned.find((e) => e.url === URL_B), false, '與自己的 url 相同不存');
  assert.equal('original' in cleaned.find((e) => e.url === URL_C), false, '非字串整欄丟棄');
  assert.equal(
    'original' in cleaned.find((e) => e.url === 'https://www.threads.com/@userd/post/JkL012'),
    false,
    'F1:超長/畸形 original 整欄丟棄,不截斷'
  );
});

test('sanitizeEntries:removedParams 逐筆 sanitize，畸形項目丟棄、非陣列整欄丟棄、全丟時整欄不寫入', () => {
  const cleaned = options.sanitizeEntries([
    {
      url: URL_A,
      kind: 'strip',
      at: 1,
      removedParams: [
        { key: 'xmt', value: 'AQGabc' }, // 合法
        { key: '', value: 'x' }, // key 空字串 → 丟棄
        { key: 'k'.repeat(70), value: 'x' }, // key 超長 → 丟棄
        { key: 'v', value: 'v'.repeat(600) }, // value 超長 → 丟棄
      ],
    },
    { url: URL_B, kind: 'strip', at: 1, removedParams: 'not-an-array' },
    { url: URL_C, kind: 'strip', at: 1, removedParams: [{ key: '', value: 'x' }] },
  ]);

  assert.deepEqual(cleaned.find((e) => e.url === URL_A).removedParams, [{ key: 'xmt', value: 'AQGabc' }]);
  assert.equal('removedParams' in cleaned.find((e) => e.url === URL_B), false, '非陣列整欄丟棄');
  assert.equal('removedParams' in cleaned.find((e) => e.url === URL_C), false, '全丟時整欄不寫入');
});

// ---- 純函式:hasCardPreview ----
//
// 與手機版 history-card.tsx 的 hasPreview 邏輯對齊(author 或 excerpt 任一
// 存在即算有預覽，單獨 handle 不算);紀錄卡片渲染(帶/不帶預覽兩形狀)靠
// 這個判定式決定要畫作者列+excerpt，還是降級成網址列。
test('hasCardPreview:author 或 excerpt 任一存在即為 true;皆缺席或僅有 handle 時為 false', () => {
  assert.equal(options.hasCardPreview({ author: 'Dafu' }), true);
  assert.equal(options.hasCardPreview({ excerpt: 'hello' }), true);
  assert.equal(options.hasCardPreview({ author: 'Dafu', excerpt: 'hello' }), true);
  assert.equal(options.hasCardPreview({}), false);
  assert.equal(options.hasCardPreview({ handle: '@onlyhandle' }), false, '單獨 handle 不算有預覽，對齊手機版邏輯');
  assert.equal(options.hasCardPreview({ author: '' }), false, '空字串視同缺席');
});

// ---- 純函式:isLongExcerpt(0.5.0，對齊手機版 history-detail-dialog.tsx 的
// EXCERPT_DIALOG_LINES=15 長文判定)----
test('isLongExcerpt:行數超過 15 行，或字元量超過 15*22=330，任一超標即為長文', () => {
  assert.equal(options.isLongExcerpt('短短一句'), false);
  assert.equal(options.isLongExcerpt('A'.repeat(330)), false, '剛好等於門檻不算超標');
  assert.equal(options.isLongExcerpt('A'.repeat(331)), true, '字元量超標');
  assert.equal(options.isLongExcerpt(Array(16).fill('line').join('\n')), true, '16 行，行數超標(> 15 行)');
  assert.equal(options.isLongExcerpt(Array(15).fill('line').join('\n')), false, '剛好 15 行不算超標');
  assert.equal(options.isLongExcerpt(''), false, '空字串不是長文');
  assert.equal(options.isLongExcerpt(undefined), false, '非字串輸入不丟例外，回傳 false');
});

// ---- 純函式:buildSeenTimeline(0.5.0，對齊手機版 history-detail-dialog.tsx
// 的時間軸——另一車道 fix/dedup-merge 才會把 seen:[{at,kind}] 加進條目
// schema，本分支防禦寫法:seen 缺席/非陣列/單筆一律回傳 null(呼叫端據此
// 決定要不要顯示時間軸鈕)，多筆才回傳新到舊排序的陣列)----
test('buildSeenTimeline:seen 缺席、非陣列或只有一筆時回傳 null(單筆時主畫面的記錄時間已經夠用)', () => {
  assert.equal(options.buildSeenTimeline({}), null, 'seen 缺席');
  assert.equal(options.buildSeenTimeline({ seen: 'not-an-array' }), null, 'seen 非陣列');
  assert.equal(options.buildSeenTimeline({ seen: [] }), null, 'seen 空陣列');
  assert.equal(options.buildSeenTimeline({ seen: [{ at: 100, kind: 'share' }] }), null, 'seen 只有一筆');
});

test('buildSeenTimeline:多筆有效紀錄回傳新到舊排序的陣列，形狀不對(缺 at/at 非有限數字)的項目濾掉', () => {
  const entry = {
    seen: [
      { at: 100, kind: 'share' },
      { at: 300, kind: 'menu' },
      { at: 200, kind: 'strip' },
      { at: 'not-a-number', kind: 'share' },
      { kind: 'share' },
      null,
    ],
  };
  const timeline = options.buildSeenTimeline(entry);
  assert.deepEqual(
    timeline.map((r) => r.at),
    [300, 200, 100],
    '新到舊排序，且濾掉 at 非有限數字/缺席與 null 項目'
  );
});

// ---- 純函式:buildEntryActions 已隨 UI 全面對齊手機任務移除(卡片 ⋮ 選單
// 整組撤掉，唯一呼叫端消失，見 options.js 的移除說明註解，PM 授權「原
// kebab 相關碼與測試移除」)。原本這裡鎖的動作組成不再有意義，改由下方
// 「卡片 hover 快捷鈕」與詳細視窗底部動作列(靜態 HTML，本來就不經這顆
// 函式生成)的 controller smoke 測試覆蓋等效行為。----

// ---- 純函式:formatDisplayUrl(UI 全面對齊手機任務，對齊手機版
// lib/format-display-url.ts)----
test('formatDisplayUrl:去 scheme 與網域(含 www.)，只留 path+query+hash 並去掉開頭斜線', () => {
  assert.equal(options.formatDisplayUrl('https://www.threads.com/@usera/post/AbC123'), '@usera/post/AbC123');
  assert.equal(options.formatDisplayUrl('https://threads.net/@u/post/x?y=1#z'), '@u/post/x?y=1#z');
});
test('formatDisplayUrl:解析失敗 fail-open 回傳原字串;非字串輸入回傳空字串', () => {
  assert.equal(options.formatDisplayUrl('not a url'), 'not a url');
  assert.equal(options.formatDisplayUrl(undefined), '');
  assert.equal(options.formatDisplayUrl(null), '');
});

// ---- 純函式:buildDetailExtraRows(UI 全面對齊手機任務 work item 7，
// original/removedParams 兩列渲染的資料準備——另一車道正把這兩個欄位存進
// schema，本分支防禦寫法:缺席/形狀不對就不產生該列)----
test('buildDetailExtraRows:original 存在且與 url 不同才產生「原始連結」列，值經 formatDisplayUrl', () => {
  const entry = { url: 'https://www.threads.com/@u/post/x', original: 'https://l.threads.net/share/abc?x=1' };
  const rows = options.buildDetailExtraRows(entry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'original');
  assert.equal(rows[0].display, 'share/abc?x=1');
  assert.equal(rows[0].copyValue, entry.original, '複製值用完整原始網址，不是 formatDisplayUrl 過的顯示值');
});
test('buildDetailExtraRows:original 缺席/非字串/與 url 相同時都不產生「原始連結」列', () => {
  assert.equal(options.buildDetailExtraRows({ url: 'https://x/y' }).length, 0, '缺席');
  assert.equal(options.buildDetailExtraRows({ url: 'https://x/y', original: 123 }).length, 0, '非字串');
  assert.equal(options.buildDetailExtraRows({ url: 'https://x/y', original: 'https://x/y' }).length, 0, '與 url 相同');
});
// 【審查修正】removedParams 元素的欄位名是 { key, value }(手機版
// link-cleaner.ts:171、detail-dialog 的 p.key，也是 background.js
// sanitizeRemovedParams 實際落盤的形狀)，不是 { name, value }——這裡的
// fixture 曾經寫錯欄位名，單分支測試因為連 fixture 帶實作一起錯而全綠，
// 合併後才會被另一車道的真實資料打穿(見 buildDetailExtraRows 上方註解)。
test('buildDetailExtraRows:removedParams 逐筆產生「追蹤參數 {name}」列，形狀不對的項目濾掉不影響其他筆', () => {
  const entry = {
    url: 'https://x/y',
    removedParams: [
      { key: 'igsh', value: 'aBc123' },
      { key: 123, value: 'bad-key-type' },
      { value: 'missing-key' },
      { key: 'utm_source', value: 456 },
      null,
      { key: 'xmt', value: 'kept' },
    ],
  };
  const rows = options.buildDetailExtraRows(entry);
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, display: r.display })),
    [
      { name: 'igsh', display: 'aBc123' },
      { name: 'xmt', display: 'kept' },
    ]
  );
  assert.ok(rows.every((r) => r.type === 'param'));
});
test('buildDetailExtraRows:removedParams 缺席或非陣列時不產生任何追蹤參數列', () => {
  assert.equal(options.buildDetailExtraRows({ url: 'https://x/y' }).length, 0);
  assert.equal(options.buildDetailExtraRows({ url: 'https://x/y', removedParams: 'nope' }).length, 0);
});

// ---- 【審查修正】跨層釘住，改造成表格驅動(work item 8) ----
//
// 【背景】UI 全面對齊手機任務把 buildDetailExtraRows 的 removedParams
// fixture 寫成 { name, value }，但兩個權威來源(手機版 link-cleaner.ts:171
// 與 detail-dialog 的 p.key，以及 F 案 background.js 的 sanitizeRemovedParams
// 實際落盤形狀)都是 { key, value }——單分支測試因為連 fixture 都一起寫
// 錯而全綠，合併後才會被另一車道的真實資料打穿，兩列變死功能。原本只有
// removedParams 一欄有這條跨層釘住，這次擴大成表格驅動，涵蓋
// author/handle/excerpt/original/removedParams 五個選填欄位 + url 形狀
// 案例，同一類欄位名/長度上限漂移，任一欄未來再犯都能在這裡攔下來，不
// 用每個欄位各自重新發明一次跨層測試。
//
// 每筆 case 把 message 餵給 background.js 真實的 extractHistoryExtraFields
// (vm sandbox 載入真實原始碼，不是重新複製一份邏輯抄在測試裡)，取得
// 「background 端真的會落盤的形狀」，原封不動餵給 options.sanitizeEntries
// (options 端真實讀取路徑)，斷言兩層對同一筆輸入的認定完全一致——這比
// 「比對兩邊原始碼字面上寫的欄位名/數字」這種容易同步漂移的弱驗證更難被
// 同類回歸繞過。
//
// 原本 buildDetailExtraRows 那條單獨的 removedParams 跨層釘住測試由這裡
// 取代(移除)，不重複維護兩份。
function loadBackgroundSandboxForCrossLayer() {
  const bgSrc =
    fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(__dirname, '..', 'tcl-core.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  // 最小 chrome mock:只滿足 background.js 檔案最外層註冊監聽器所需的
  // 呼叫面(見 background.test.js 的 makeChrome 同一組道理)，不需要完整
  // 還原每個 API，這裡只是借殼跑幾顆頂層 sanitize 函式。
  const chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
    },
    contextMenus: { onClicked: { addListener: () => {} } },
  };
  return runInSandbox(bgSrc, { chrome, console });
}

const CROSS_LAYER_BASE_URL = URL_A;

// 五個選填欄位的跨層案例。expect 是「兩層走完全程後，應該存活的欄位」;
// 不列的欄位代表該欄應該被兩層一起丟棄(整欄不寫入)。
const CROSS_LAYER_FIELD_CASES = [
  { field: 'author', label: '合法字串應原樣保留', message: { author: 'Dafu' }, expect: { author: 'Dafu' } },
  { field: 'author', label: '空字串兩層都應整欄丟棄', message: { author: '' }, expect: {} },
  {
    field: 'author',
    label: '超長字串應截斷到同一個上限(100)，兩層數字要對得上',
    message: { author: 'A'.repeat(150) },
    expect: { author: 'A'.repeat(100) },
  },
  { field: 'handle', label: '合法字串應原樣保留', message: { handle: '@dafucoding' }, expect: { handle: '@dafucoding' } },
  { field: 'handle', label: '空字串兩層都應整欄丟棄', message: { handle: '' }, expect: {} },
  { field: 'excerpt', label: '合法字串應原樣保留', message: { excerpt: 'hello world' }, expect: { excerpt: 'hello world' } },
  { field: 'excerpt', label: '空字串兩層都應整欄丟棄', message: { excerpt: '' }, expect: {} },
  {
    field: 'excerpt',
    label: '超長字串應截斷到同一個上限(2000)，兩層數字要對得上',
    message: { excerpt: 'E'.repeat(2500) },
    expect: { excerpt: 'E'.repeat(2000) },
  },
  {
    // F1:original 需吻合白名單(SHARE 或容尾 POST);用合法 share 短連結,兩層都保留。
    field: 'original',
    label: '與 cleaned url 不同且吻合白名單(share 短連結)時應保留',
    message: { original: 'https://www.threads.com/share/abc' },
    expect: { original: 'https://www.threads.com/share/abc' },
  },
  {
    // F1 取嚴:非白名單(偽造/畸形殘 URL)的 original 兩層都整欄丟棄。
    field: 'original',
    label: 'F1:非白名單 original 兩層都整欄丟棄',
    message: { original: 'https://evil.example/@u/post/ID' },
    expect: {},
  },
  {
    field: 'original',
    label: '與 cleaned url 相同時兩層都整欄丟棄',
    message: { original: CROSS_LAYER_BASE_URL },
    expect: {},
  },
  {
    field: 'removedParams',
    label: '合法 {key,value} 應原樣保留(審查 FAIL 的原始案例)',
    message: { removedParams: [{ key: 'igsh', value: 'aBc123' }] },
    expect: { removedParams: [{ key: 'igsh', value: 'aBc123' }] },
  },
  {
    field: 'removedParams',
    label: '缺 key 的項目應被兩層一起濾掉，陣列變空、整欄不寫入',
    message: { removedParams: [{ value: 'no-key' }] },
    expect: {},
  },
];

CROSS_LAYER_FIELD_CASES.forEach(({ field, label, message, expect: expected }) => {
  test('跨層釘住(表格驅動)[' + field + ']:' + label, () => {
    const sandbox = loadBackgroundSandboxForCrossLayer();
    assert.equal(
      typeof sandbox.extractHistoryExtraFields,
      'function',
      'background.js 應在頂層(非閉包內)宣告 extractHistoryExtraFields，測試才拿得到'
    );

    // background 端真實的欄位抽取+sanitize，取得「background 端真的會
    // 落盤的形狀」。sandbox 內建立的物件跑在 vm context 內，直接跟這裡
    // 的字面物件 deepEqual 比對會因「跨 realm」的 Object.prototype 不同
    // 判不相等，JSON 序列化一輪換成本地 realm 的一般物件，繞開這個純屬
    // vm 隔離機制的假陽性。
    const bgExtra = JSON.parse(JSON.stringify(sandbox.extractHistoryExtraFields(message, CROSS_LAYER_BASE_URL)));

    // 原封不動餵給 options 端的讀取路徑(sanitizeEntries)。
    const entry = Object.assign({ url: CROSS_LAYER_BASE_URL, kind: 'share', at: 1 }, bgExtra);
    const cleaned = options.sanitizeEntries([entry])[0];
    const cleanedExtra = {};
    if (Object.prototype.hasOwnProperty.call(cleaned, field)) cleanedExtra[field] = cleaned[field];

    assert.deepEqual(
      cleanedExtra,
      expected,
      'options.sanitizeEntries 讀到的 ' + field + ' 應與 background 端產出的形狀一致(存活的值相同、該丟的一起丟)'
    );
  });
});

// url 形狀案例(表格驅動風格一致，但不經 background sandbox——
// background.js 自己的 url 驗證上限尚未跟進本輪的 60→80，那是 runtime
// 車道的後續工作;現在拿兩層互比只會得到「預期中的不一致」，不是這裡要
// 攔的 bug，故獨立成 options 端自己的邊界值案例，仍是同一組表格驅動寫
// 法)。
const CROSS_LAYER_URL_CASES = [
  {
    label: 'handle/post id 剛好 80 字元應保留',
    url: 'https://www.threads.com/@' + 'h'.repeat(80) + '/post/' + 'i'.repeat(80),
    expectSurvive: true,
  },
  {
    label: 'handle 81 字元應整筆丟棄(不是舊版的 60 上限)',
    url: 'https://www.threads.com/@' + 'h'.repeat(81) + '/post/' + 'i'.repeat(80),
    expectSurvive: false,
  },
  {
    label: 'post id 81 字元應整筆丟棄',
    url: 'https://www.threads.com/@' + 'h'.repeat(80) + '/post/' + 'i'.repeat(81),
    expectSurvive: false,
  },
];

CROSS_LAYER_URL_CASES.forEach(({ label, url, expectSurvive }) => {
  test('跨層釘住(表格驅動)[url 形狀]:' + label, () => {
    const cleaned = options.sanitizeEntries([{ url: url, kind: 'share', at: 1 }]);
    assert.equal(cleaned.length, expectSurvive ? 1 : 0);
  });
});

// ---- 設定頁不再出現 notifySuccess 控件(PM 審查後補) ----
//
// R1 同輪已把成功通知整組拆光，notifySuccess 合併後零讀取端;上一輪誤以
// 「另一車道尚未拆通知」為由保留這顆開關，是過期情報，變成誤導使用者的
// 死 UI。這裡從兩個角度釘住它不會再出現:純函式層的 SETTING_IDS/
// OPTIONS_DEFAULT_SETTINGS 不含這顆鍵，以及 options.html 原文不再有
// id="notifySuccess" 的控件(靜態檢查，照 popup.test.js 既有的 R1-3 慣例)。
test('notifySuccess:OPTIONS_DEFAULT_SETTINGS/SETTING_IDS 不含這顆鍵，options.html 原文也不再有對應控件(成功通知已整組移除)', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(options.OPTIONS_DEFAULT_SETTINGS, 'notifySuccess'), false);

  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.equal(/\bid\s*=\s*["']notifySuccess["']/i.test(html), false, 'options.html 不應再有 notifySuccess 控件');
  assert.equal(/\bopNotify(Name|Desc)\b/.test(html), false, 'options.html 不應再引用 opNotifyName/opNotifyDesc');
});

// ---- 【審查修正】全域 [hidden] 規則(PM 審查後補) ----
//
// options.html 只有 .overlay[hidden]{display:none} 這一條窄規則，蓋不到
// 頁面內任何「自己有寫 display」的其他元素(detailAuthorRow/detailExcerpt/
// detailExpandBtn 都是——同 specificity 下 author 樣式表一律贏過瀏覽器
// UA 樣式表的 [hidden]{display:none}，JS 端設 el.hidden=true 完全沒有
// 視覺效果)。這裡是純 CSS 修正，controller smoke 的最小 DOM stub 不解析
// 真實 CSS 規則，測不出視覺效果，只能做靜態原文檢查(照上面 notifySuccess
// 的既有慣例)，鎖住這條全域規則存在且用了 !important。
test('[hidden] 修正:options.html 應有全域 [hidden]{display:none!important} 規則', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(
    html,
    /^\s*\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/m,
    'options.html 應有全域 [hidden] 規則且帶 !important，才蓋得過同頁面其他元素自己的 display 宣告'
  );
});

// ---- 【審查 FAIL 修正】#confirmOverlay 的 z-index(PM 打回，審查 CDP 已驗) ----
//
// 確認框(#confirmOverlay)在 options.html 的 DOM 順序寫在詳細視窗
// (#detailOverlay)前面，兩者同吃 .overlay 的 z-index:10 時，後出現的
// detail 依繪製順序蓋上來——「從詳細視窗按刪除這筆」開的確認框整個被
// 遮住:畫面看似沒反應、焦點靜默落在看不見的 #confirmCancel、點遮罩
// 關到的是 detail(留下孤兒 confirm)。#timelineOverlay 早就為同一類
// 疊層情境拉過 z-index:11，這次 confirm-over-detail 是新情境。
//
// 純 CSS 修正，最小 DOM stub 不解析真實 CSS，測不出繪製層級，只能做
// 靜態原文檢查(照上面 [hidden] 的既有慣例)。正則以 ^ 行首錨定 + m
// 旗標，只認真正的 CSS 規則行——不加錨定的話，本檔/HTML 註解散文裡
// 只要提到 #confirmOverlay 與 z-index 就會誤命中，變成鎖不住東西的
// 假釘(前輪教訓)。
test('確認框疊層:options.html 應有 #confirmOverlay 的 z-index 規則(疊在詳細視窗之上)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(
    html,
    /^\s*#confirmOverlay\s*\{[^}]*z-index[^}]*\}/m,
    '#confirmOverlay 需自帶 z-index，否則與 #detailOverlay 同層時會被 DOM 順序在後的 detail 蓋住'
  );
});

// ---- controller smoke(最小 DOM stub) ----

function makeNode(tag) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  let text = '';
  const node = {
    tag: tag || 'div',
    children: [],
    style: {},
    dataset: {},
    hidden: false,
    value: '',
    title: '',
    checked: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const next = force === undefined ? !classes.has(c) : force;
        if (next) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    appendChild(n) {
      this.children.push(n);
      return n;
    },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener() {},
    // 測試專用(比照 support/helpers.js 的 createCheckboxDocument):派送
    // 任意型別的事件給已註冊的監聽器，用來模擬使用者點擊卡片動作按鈕。
    fire(type, event) {
      (listeners[type] || []).slice().forEach((fn) => fn(event || { type, target: node }));
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
    click() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 10, height: 10 };
    },
  };
  // 比照真 DOM:對 textContent 賦值會清空既有子節點(renderList 靠這個清單)。
  Object.defineProperty(node, 'textContent', {
    get() {
      return text;
    },
    set(v) {
      text = String(v);
      node.children.length = 0;
    },
  });
  return node;
}

function makeDocumentStub() {
  const byId = {};
  return {
    ids: byId,
    documentElement: makeNode('html'),
    getElementById(id) {
      if (!byId[id]) byId[id] = makeNode('#' + id);
      return byId[id];
    },
    createElement(tag) {
      return makeNode(tag);
    },
    createElementNS(ns, tag) {
      return makeNode(tag);
    },
    createTextNode(text) {
      const n = makeNode('#text');
      n.textContent = text;
      return n;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
  };
}

test('controller smoke:init 讀兩區 storage、整條渲染跑完,清單與計數正確', async () => {
  const storage = createChromeStorage(
    { langPref: 'zh' },
    {
      history: [
        { url: URL_A, kind: 'share', at: 2000 },
        { url: URL_B, kind: 'strip', at: 1000 },
        { url: 999, kind: 'share', at: 1 }, // 防禦性整形應丟棄這筆
      ],
    }
  );
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.rows.children.length, 2, '兩筆合法紀錄都應渲染成列');
  assert.equal(doc.ids.countHint.textContent, '顯示 2 / 2 筆');
  assert.equal(doc.ids.empty.hidden, true);
  assert.equal(doc.ids.statTotal.textContent, '2');
  // 0.5.0 方案甲:autoClean 預設值改 false(配合另一車道調整
  // background.js 的預設，popup/options 兩側鏡像同一個 fallback)。
  assert.equal(doc.ids.autoClean.checked, false, '設定未存值時應套新預設 false');

  controller.setHistory([]);
  assert.equal(doc.ids.rows.children.length, 0);
  assert.equal(doc.ids.empty.hidden, false, '清空後應顯示空狀態');
  assert.equal(doc.ids.countHint.textContent, '顯示 0 / 0 筆');
});

// 修正前 renderList 的網域段一律硬寫死 'threads.com/'，來自 threads.net 的
// 紀錄(POST_URL_PATTERN／KINDS 都同時允許 com 與 net)會被顯示成錯誤網域。
// 這裡直接檢查渲染出來的三段文字節點(網域段／帳號段(<b>)／其餘路徑段)，
// 網域段須如實為 'threads.net/'。
//
// 【必然的結構性更新，PM 覆核】0.5.0 方案甲把紀錄清單從 <li class="row">
// 改渲染成 <div class="entry-card">，原本 li → main → urlEl 的巢狀路徑不
// 復存在;這筆條目沒有 author/excerpt(hasCardPreview 為 false)，降級網址
// 節點現在是卡片(entry-header 之後)的直接子節點。行為斷言(三段文字节点
// 拆解結果)完全不變，只是 DOM 路徑跟著新結構調整，並非放寬或收緊判斷。
test('renderList:threads.net 的紀錄如實顯示 .net,不誤植為 .com', async () => {
  const NET_URL = 'https://www.threads.net/@user_net/post/AbC123';
  const storage = createChromeStorage(
    { langPref: 'zh' },
    { history: [{ url: NET_URL, kind: 'share', at: 1000 }] }
  );
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  const card = doc.ids.rows.children[0];
  const urlEl = card.children[1];
  assert.equal(urlEl.className, 'entry-url');
  const textParts = urlEl.children.map((c) => c.textContent);
  assert.deepEqual(textParts, ['threads.net/', '@user_net', '/post/AbC123']);
});

// ============================================================
// 0.5.0 方案甲(歷史即收藏):紀錄卡片牆——帶預覽 / 降級網址兩種形狀
// ============================================================

const CARD_URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const CARD_URL_B = 'https://www.threads.com/@user.b/post/DeF456';
const CARD_URL_NET = 'https://www.threads.net/@user_net/post/AbC123';

test('controller smoke:紀錄卡片牆渲染——帶預覽(author+handle+excerpt)與降級網址兩種形狀', async () => {
  const history = [
    {
      url: CARD_URL_A,
      kind: 'icon',
      author: 'Dafu',
      handle: '@dafucoding',
      excerpt: 'hello world',
      at: 3000,
    },
    { url: CARD_URL_NET, kind: 'share', at: 1000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.rows.children.length, 2);

  // 卡片一:有預覽(author+handle+excerpt)——卡頭(徽章+時間)→ 作者列 →
  // excerpt → 高亮態快捷鈕組(取代舊版常駐 ⋮ 選單，見 buildEntryCard；
  // UI 全面對齊手機任務:互動照手機的選中態，平時態靠 CSS display:none
  // 隱藏，這裡的 DOM stub 不解析 CSS，所以節點一律存在，只驗證結構)。
  const card0 = doc.ids.rows.children[0];
  assert.equal(card0.className, 'entry-card');
  const header0 = card0.children[0];
  assert.equal(header0.className, 'entry-header');
  const meta0 = header0.children[0];
  assert.equal(meta0.children[0].className, 'entry-badge');
  assert.equal(meta0.children[0].textContent, '貼文按鈕', 'kind:icon 的徽章文案沿用既有 opKindIcon');
  assert.equal(meta0.children[1].className, 'entry-time');

  const authorRow0 = card0.children[1];
  assert.equal(authorRow0.className, 'entry-author-row');
  assert.equal(authorRow0.children[0].textContent, 'Dafu');
  assert.equal(authorRow0.children[1].textContent, '@dafucoding');
  const excerptEl0 = card0.children[2];
  assert.equal(excerptEl0.className, 'entry-excerpt');
  assert.equal(excerptEl0.textContent, 'hello world');

  const quickWrap0 = card0.children[3];
  assert.equal(quickWrap0.className, 'entry-quick');
  assert.equal(quickWrap0.children.length, 2, '兩顆快捷鈕:複製連結/開啟貼文，對應手機 Copy/Share2');
  const [quickCopy0, quickOpen0] = quickWrap0.children;
  assert.equal(quickCopy0.tag, 'button');
  assert.equal(quickOpen0.tag, 'a', '開啟貼文用原生 <a>，不是 button');
  assert.equal(quickOpen0.href, CARD_URL_A);
  assert.equal(quickOpen0.target, '_blank');
  assert.equal(quickOpen0.rel, 'noopener');

  // 卡片二:無 author/excerpt → 降級顯示網址(threads.net 如實顯示，不誤植 .com)。
  const card1 = doc.ids.rows.children[1];
  const urlEl1 = card1.children[1];
  assert.equal(urlEl1.className, 'entry-url');
  assert.deepEqual(
    urlEl1.children.map((c) => c.textContent),
    ['threads.net/', '@user_net', '/post/AbC123']
  );
});

// UI 全面對齊手機任務:互動模型翻轉——卡片右上常駐 ⋮ 選單整組撤掉，刪除
// 動作收斂到只在詳細視窗做(已有獨立測試覆蓋)，卡片層級改成高亮態的兩顆
// 快捷鈕(複製連結/開啟貼文)。這裡驗證快捷鈕本身的行為:複製鈕點擊會
// stopPropagation、不會順手把詳細視窗打開;開啟鈕是原生 <a>，href 正確。
test('controller smoke:卡片高亮態快捷鈕——複製鈕不冒泡開啟詳細視窗，開啟鈕 href 正確', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  const card = doc.ids.rows.children[0];
  const [quickCopy, quickOpen] = card.children[card.children.length - 1].children;

  assert.equal(quickOpen.href, CARD_URL_A);
  assert.equal(quickOpen.target, '_blank');
  assert.equal(quickOpen.rel, 'noopener');

  // DOM stub 的 fire() 不模擬真實冒泡，所以「不冒泡」這件事改用行為驗證:
  // openEntryDetail 是唯一會寫 detailUrlValue 的地方，點擊快捷複製鈕後
  // 這格應該仍是初始空字串——如果冒泡到卡片誤開了詳細視窗，這格就會被
  // 填成 CARD_URL_A 的 formatDisplayUrl 值。navigator.clipboard 在這個
  // 最小 DOM stub 環境不存在，copyEntryUrl 本身用 try/catch 吞掉並改走
  // 失敗 toast，這裡不驗證複製成功與否，只驗證點擊不會讓整條渲染炸掉、
  // 也不會誤開詳細視窗。
  assert.doesNotThrow(() => quickCopy.fire('click'));
  // DOM stub 的 getElementById 是懶建立(第一次被查詢才生節點)，直接用
  // getElementById 查(而非既有的 doc.ids.detailUrlValue 捷徑)確保節點
  // 一定存在，不會因為 openEntryDetail 從未被呼叫過而炸 undefined。
  assert.equal(doc.getElementById('detailUrlValue').textContent, '', '點快捷複製鈕不應觸發卡片本身的 click(開詳細視窗)');
});

// 點卡片本身(非 ⋮ 選單區)開詳細視窗，對齊手機版 history-card.tsx 的
// onPress;詳細視窗版面(帶預覽/降級網址、展開全文)另見下方獨立測試。
test('controller smoke:點卡片本身開啟詳細視窗，顯示卡頭/作者列/excerpt 與記錄時間', async () => {
  const history = [
    { url: CARD_URL_A, kind: 'share', author: 'Dafu', handle: '@dafucoding', excerpt: 'hello world', at: 3000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  // 注意:DOM stub 的節點預設 hidden:false(不解析真實 HTML 的 hidden
  // 屬性)，初始收合狀態由瀏覽器端的 hidden 屬性把關，這裡不驗初始值，
  // 只驗點擊後的開啟/關閉轉換。
  const card = doc.ids.rows.children[0];
  card.fire('click');

  assert.equal(doc.ids.detailOverlay.hidden, false);
  assert.equal(doc.ids.detailBadge.textContent, '短碼解析');
  assert.equal(doc.ids.detailAuthorRow.hidden, false);
  assert.equal(doc.ids.detailAuthorName.textContent, 'Dafu');
  assert.equal(doc.ids.detailHandle.textContent, '@dafucoding');
  assert.equal(doc.ids.detailExcerpt.hidden, false);
  assert.equal(doc.ids.detailExcerpt.textContent, 'hello world');
  assert.equal(doc.ids.detailExpandBtn.hidden, true, '短內文不顯示展開全文');
  assert.equal(doc.ids.detailUrlFallback.hidden, true);
  // 絕對時間用本機時區格式化(new Date().getFullYear() 等皆為本機時區),
  // 不能硬編 UTC 換算後的字串(換執行機器時區就會炸)，改驗格式。
  assert.match(doc.ids.detailRecordedTime.textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '絕對時間格式 YYYY-MM-DD HH:mm');
  assert.equal(doc.ids.detailOpenLink.href, CARD_URL_A);

  doc.ids.detailClose.fire('click');
  assert.equal(doc.ids.detailOverlay.hidden, true, '關閉按鈕應收合詳細視窗');
});

// 降級網址條目(無 author/excerpt)開詳細視窗:比照卡片一樣降級顯示網址，
// 不畫作者列/excerpt。
test('controller smoke:降級網址條目的詳細視窗顯示網址列，不顯示作者列/excerpt', async () => {
  const history = [{ url: CARD_URL_NET, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  assert.equal(doc.ids.detailAuthorRow.hidden, true);
  assert.equal(doc.ids.detailExcerpt.hidden, true);
  assert.equal(doc.ids.detailUrlFallback.hidden, false);
  assert.deepEqual(
    doc.ids.detailUrlFallback.children[0].children.map((c) => c.textContent),
    ['threads.net/', '@user_net', '/post/AbC123']
  );
});

// 【審查修正】openEntryDetail 的無預覽分支先前只設 hidden，沒清
// textContent(handleEl 連 hidden 都沒設)——先開一筆有 author/handle/
// excerpt 的條目，再切到一筆降級條目，若無預覽分支沒清乾淨，這幾個欄位
// 的舊文字會原地殘留(且 hidden 修正前，[hidden] 對這幾個元素完全沒視覺
// 效果，殘留文字會直接露出來)。
test('controller smoke:切換到降級網址條目時，上一筆的 authorName/handle/excerpt 應清空，不殘留到這一筆', async () => {
  const history = [
    { url: CARD_URL_A, kind: 'share', author: 'Dafu', handle: '@dafucoding', excerpt: 'hello world', at: 3000 },
    { url: CARD_URL_NET, kind: 'share', at: 1000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  assert.equal(doc.ids.detailAuthorName.textContent, 'Dafu');
  assert.equal(doc.ids.detailHandle.textContent, '@dafucoding');
  assert.equal(doc.ids.detailExcerpt.textContent, 'hello world');

  doc.ids.rows.children[1].fire('click');
  assert.equal(doc.ids.detailAuthorRow.hidden, true);
  assert.equal(doc.ids.detailAuthorName.textContent, '', '上一筆的作者名稱不應殘留');
  assert.equal(doc.ids.detailHandle.hidden, true, 'handle 應一併設 hidden(先前漏設)');
  assert.equal(doc.ids.detailHandle.textContent, '', '上一筆的 handle 不應殘留');
  assert.equal(doc.ids.detailExcerpt.textContent, '', '上一筆的 excerpt 不應殘留');
});

// 長內文(超過 15 行或字元量門檻)開詳細視窗時顯示「展開全文」，點擊後
// 原地移除截斷(見 openEntryDetail 註解:web 版不像手機版開巢狀第二層
// Modal，那是 iOS 平台限制，web 沒有這個問題)。
test('controller smoke:長內文顯示「展開全文」，點擊後移除截斷 class', async () => {
  const longExcerpt = 'A'.repeat(400); // 超過 15*22=330 字元門檻
  const history = [{ url: CARD_URL_A, kind: 'share', author: 'Dafu', excerpt: longExcerpt, at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  assert.equal(doc.ids.detailExpandBtn.hidden, false, '長內文應顯示展開全文按鈕');
  assert.equal(doc.ids.detailExcerpt.classList.contains('expanded'), false);

  doc.ids.detailExpandBtn.fire('click');

  assert.equal(doc.ids.detailExcerpt.classList.contains('expanded'), true, '點擊後應加上 expanded class 原地展開');
  assert.equal(doc.ids.detailExpandBtn.hidden, true, '展開後按鈕本身收合');
});

// 詳細視窗底部的複製/刪除按鈕操作目前顯示中的 entry(見 detailEntry)。
// 【R4-新 使用者 2026-08-19 要求】刪除先跳一道確認框(複用清除全部那套
// confirmOverlay)，文案是「確定刪除這筆紀錄?」/確認鈕「刪除」，確認後才刪。
test('controller smoke:詳細視窗刪除鈕先跳確認框，確認後刪除目前條目並收合視窗', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  assert.equal(doc.ids.detailOverlay.hidden, false);

  // 點刪除鈕:不直接刪，先開確認框，且套的是刪除文案(不是清除全部)。
  doc.ids.detailDeleteBtn.fire('click');
  assert.equal(doc.ids.confirmOverlay.hidden, false, '刪除鈕應先開確認框，不直接刪');
  assert.equal(doc.ids.rows.children.length, 1, '尚未確認，紀錄仍在');
  assert.equal(doc.ids.confirmDesc.textContent, i18n.t('zh', 'opDeleteConfirmDesc'));
  assert.equal(doc.ids.confirmOk.textContent, i18n.t('zh', 'opDeleteConfirmDo'), '確認鈕文案應為「刪除」，不是「確定清除」');

  // 確認後才真的刪:卡片牆重畫為空、詳細視窗收合。
  doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(doc.ids.rows.children.length, 0, '確認後卡片牆應重新渲染為空');
  assert.equal(doc.ids.detailOverlay.hidden, true, '刪除目前顯示中的條目應順手關閉詳細視窗');
  assert.equal(doc.ids.confirmOverlay.hidden, true, '確認框關閉');
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastDeleted'), '寫入成功才發已刪除 toast');
});

// 確認框「取消」不刪:點刪除鈕開框後按取消，紀錄應原封不動、確認框收合。
test('controller smoke:刪除確認框按取消不刪除紀錄', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  doc.ids.detailDeleteBtn.fire('click');
  assert.equal(doc.ids.confirmOverlay.hidden, false);

  doc.ids.confirmCancel.fire('click');
  await settle();

  assert.equal(doc.ids.confirmOverlay.hidden, true, '取消後確認框收合');
  assert.equal(doc.ids.rows.children.length, 1, '取消不刪，紀錄仍在');
  assert.equal(doc.ids.detailOverlay.hidden, false, '取消後詳細視窗仍開著');
});

// 【R4-a 回歸釘 使用者/PM 覆核】deleteEntry 改回 url+at 精準命中(撤銷
// PM 第五輪 9e7353f 只比 url 的未預期副作用)。刻意讓 entries 裡出現兩筆
// 相同 url、不同 at 的資料(同一貼文在 5 分鐘視窗外各自獨立成筆的真實
// 情境)，刪其中一筆時「只該刪中被點的那一筆」，同 url 的另一筆必須留著。
// 這條就是那個誤刪 bug 的直接回歸釘:一旦 deleteEntry 退回只比 url，這裡
// 會變成兩筆都被刪、斷言立刻紅。
test('controller smoke:刪除以 url+at 精準命中，同 url 不同 at 兩筆只刪中被點的那一筆', async () => {
  const history = [
    { url: CARD_URL_A, kind: 'share', at: 3000 },
    { url: CARD_URL_A, kind: 'strip', at: 1000 },
    { url: CARD_URL_B, kind: 'share', at: 2000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.rows.children.length, 3);
  doc.ids.rows.children[0].fire('click'); // 開第一筆(CARD_URL_A, at:3000)的詳細視窗
  doc.ids.detailDeleteBtn.fire('click'); // 開刪除確認框
  doc.ids.confirmOk.fire('click'); // 確認刪除
  await settle(); // storage mock 的 set() 用 setTimeout(0) 延遲落地，要等一輪才能查快照。

  assert.equal(doc.ids.rows.children.length, 2, '只刪中被點的那一筆(A@3000)，同 url 的 A@1000 與 B 都留著');
  const snap = storage.localSnapshot().history;
  assert.equal(snap.length, 2);
  const remaining = snap.map((e) => `${e.url}|${e.at}`).sort();
  assert.deepEqual(
    remaining,
    [`${CARD_URL_A}|1000`, `${CARD_URL_B}|2000`].sort(),
    '留下的應是同 url 的另一筆(A@1000)與 B@2000，被刪的只有 A@3000'
  );
});

// 【審查修正】deleteEntry 沒命中時不寫入、不動視窗、不發「已刪除」成功
// toast——模擬使用者開著詳細視窗時，storage 被「清除全部」這類不經
// setHistory 重新定位的路徑改掉(persistHistory 直接改 entries，detailEntry
// 仍是舊物件的參照)，此時點刪除鈕應該安靜地什麼都不做，不能誤發成功
// 訊息讓使用者以為又刪掉了一筆。
test('controller smoke:詳細視窗開著時若條目已被別處(如清除全部)先行移除，刪除鈕不再誤發成功 toast', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  assert.equal(doc.ids.detailOverlay.hidden, false);

  // 「清除全部」走 clearBtn → 確認框 → confirmOk → persistHistory([]) +
  // renderAll，不經 setHistory 的 detailEntry 重新定位邏輯，detailEntry
  // 變成指向已經不在 entries 裡的舊物件。
  doc.ids.clearBtn.fire('click');
  doc.ids.confirmOk.fire('click');
  await settle();
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastCleared'));
  const setCallsBefore = storage.localCalls.set.length;

  // 再點刪除鈕 → 開刪除確認框 → 確認:deleteEntry 以 url+at 找，entries
  // 已空、沒命中 → 不寫入、不發成功 toast。
  doc.ids.detailDeleteBtn.fire('click');
  doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(storage.localCalls.set.length, setCallsBefore, '沒命中不該再寫一次 storage');
  assert.equal(
    doc.ids.toast.textContent,
    i18n.t('zh', 'opToastCleared'),
    '沒命中的刪除不該覆寫成「已刪除」toast，文字應該還停在「已清除全部紀錄」'
  );
});

// 【審查修正】詳細視窗開著時 storage 更新的整合(setHistory 由接線層在
// storage.onChanged(local 區)時呼叫，對齊 background 新寫入/另一分頁改動
// 的即時性)：以 url 重新定位 detailEntry，找得到就用新資料刷新視窗內容。
test('controller smoke:詳細視窗開著時 setHistory 帶來同 url 的新資料，應原地刷新視窗內容(不需要使用者手動關再開)', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', author: 'Dafu', excerpt: 'old excerpt', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  assert.equal(doc.ids.detailExcerpt.textContent, 'old excerpt');

  controller.setHistory([{ url: CARD_URL_A, kind: 'share', author: 'Dafu', excerpt: 'new excerpt after live update', at: 1000 }]);

  assert.equal(doc.ids.detailOverlay.hidden, false, '同 url 找得到，視窗應該保持開啟');
  assert.equal(doc.ids.detailExcerpt.textContent, 'new excerpt after live update', '視窗內容應刷新成新資料，不是停在舊快照');
});

// 【審查修正】setHistory 帶來的新清單裡已經沒有 detailEntry 對應的
// url(例如另一分頁把這筆刪了)，應該關閉詳細視窗，不留著顯示一筆已經
// 不存在的紀錄。
test('controller smoke:詳細視窗開著時 setHistory 帶來的新清單已無對應 url，應關閉詳細視窗', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  assert.equal(doc.ids.detailOverlay.hidden, false);

  controller.setHistory([]);

  assert.equal(doc.ids.detailOverlay.hidden, true, '找不到對應 url 時應關閉詳細視窗');
});

// 【R4-b 回歸釘 cr low5 + UI 中2】setHistory 走「只刷新內容、不重置互動態」
// 的路徑:使用者正開著時間軸子層時，別處(background/另一分頁)寫入一筆
// 無關的新紀錄，不該把使用者正在看的時間軸子層關掉。修正前 setHistory →
// openEntryDetail 無條件 closeTimelineOverlay，任何無關寫入都會把子層重置。
test('controller smoke:別處寫入無關紀錄(setHistory)時，使用者正開著的時間軸子層不被關掉', async () => {
  const seen = [
    { at: 1000, kind: 'strip' },
    { at: 3000, kind: 'share' },
  ];
  const history = [{ url: CARD_URL_A, kind: 'share', at: 3000, seen }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click'); // 開詳細視窗
  doc.ids.detailTimelineBtn.fire('click'); // 開時間軸子層
  assert.equal(doc.ids.timelineOverlay.hidden, false, '前置:時間軸子層已開');

  // 別處寫入:同 detailEntry 那筆仍在，外加一筆無關的 CARD_URL_B。
  controller.setHistory([
    { url: CARD_URL_B, kind: 'share', at: 5000 },
    { url: CARD_URL_A, kind: 'share', at: 3000, seen },
  ]);

  assert.equal(doc.ids.detailOverlay.hidden, false, '詳細視窗仍開著');
  assert.equal(
    doc.ids.timelineOverlay.hidden,
    false,
    '正在看的時間軸子層不應被無關寫入重置關掉(setHistory 走 refreshDetail，不重置互動態)'
  );
  // 卡片牆已更新為兩筆(證明 setHistory 確實刷新了清單，不是什麼都沒做)。
  assert.equal(doc.ids.rows.children.length, 2, '卡片牆應反映新清單的兩筆');
});

// 【R5 安全F2 + UI 中1】storage 寫入失敗(配額)時:不謊報「已匯入」成功、
// 發專屬失敗 toast，且 entries 回滾成寫入前的值(記憶體/磁碟不分岔)。
// 用會 reject 的自訂 localStorage，不走 createChromeStorage(它 set 恆成功)。
test('R5:匯入寫入失敗(配額)時不發成功 toast、改發失敗 toast，且 entries 回滾', async () => {
  const doc = makeDocumentStub();
  const quotaErr = new Error('QUOTA_BYTES quota exceeded');
  const localStore = {
    get() {
      return Promise.resolve({ history: [{ url: CARD_URL_A, kind: 'share', at: 1000 }] });
    },
    set() {
      return Promise.reject(quotaErr);
    },
  };
  const syncStore = {
    get() {
      return Promise.resolve({ langPref: 'zh' });
    },
    set() {
      return Promise.resolve();
    },
  };
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: syncStore,
    localStorage: localStore,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();
  assert.equal(doc.ids.rows.children.length, 1, '前置:初始一筆');

  // 貼上一筆新 url 的匯入內容，點匯入 → localStore.set 會 reject。
  // getElementById 懶建立節點(直接用 doc.ids.modalText 時它還沒被建過)。
  doc.getElementById('modalText').value = JSON.stringify({ entries: [{ url: CARD_URL_B, kind: 'share', at: 2000 }] });
  doc.getElementById('modalPrimary').fire('click');
  await settle();

  assert.equal(
    doc.ids.toast.textContent,
    i18n.t('zh', 'opToastStorageFull'),
    '配額失敗應發專屬失敗 toast，不謊報「已匯入」'
  );
  assert.notEqual(
    doc.ids.toast.textContent,
    i18n.fmt('zh', 'opToastImported', { n: 1 }),
    '絕不可顯示已匯入成功文案'
  );
  assert.equal(doc.ids.rows.children.length, 1, '寫入失敗應回滾，卡片牆維持原本一筆(未把 CARD_URL_B 併進去)');
});

// 【R5】刪除寫入失敗時同樣不謊報「已刪除」——沿用同一條 persistHistory
// 失敗路徑，這裡最小驗證失敗 toast 取代成功 toast。
test('R5:刪除寫入失敗時發失敗 toast、不發已刪除，且回滾', async () => {
  const doc = makeDocumentStub();
  const quotaErr = new Error('QUOTA_BYTES_PER_ITEM exceeded');
  const localStore = {
    get() {
      return Promise.resolve({ history: [{ url: CARD_URL_A, kind: 'share', at: 1000 }] });
    },
    set() {
      return Promise.reject(quotaErr);
    },
  };
  const syncStore = {
    get() {
      return Promise.resolve({ langPref: 'zh' });
    },
    set() {
      return Promise.resolve();
    },
  };
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: syncStore,
    localStorage: localStore,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  doc.ids.detailDeleteBtn.fire('click');
  doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastStorageFull'), '刪除寫入失敗發失敗 toast');
  assert.notEqual(doc.ids.toast.textContent, i18n.t('zh', 'opToastDeleted'), '不可謊報已刪除');
  assert.equal(doc.ids.rows.children.length, 1, '失敗回滾，那一筆仍在');
});

// 【R7 a11y cr low8 + UI low5】開啟對話框時焦點移入(關閉鈕)。makeNode 預設
// 沒有 focus 方法(全程 typeof 守衛跳過)，這裡臨時掛上 focus spy 驗證焦點
// 確實被移進對話框。Tab focus trap 需要真實 querySelectorAll，最小 DOM stub
// 表達不了，由人工/CDP 驗證(見 options.js trapTabInOverlay 註解)。
test('R7 a11y:開啟詳細視窗時焦點移入關閉鈕', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  let closeFocused = 0;
  doc.ids.detailClose.focus = () => {
    closeFocused++;
  };

  doc.ids.rows.children[0].fire('click');
  assert.equal(closeFocused, 1, '開啟詳細視窗時焦點應移到關閉鈕');
});

// 【R7 a11y】硬編中文 aria-label 改走 i18n:options.html 用 data-i18n-aria，
// applyI18nDom 有對應通道，i18n 有新 key(zh/en)。DOM stub 的 querySelectorAll
// 回空陣列測不到 applyI18nDom 的實際套用，改用靜態原文 + 字典檢查(照本檔
// [hidden] 那條既有慣例)。
test('R7 a11y:關閉鈕/統計磚的 aria-label 改走 data-i18n-aria(不再硬編中文)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(html, /id="detailClose"[^>]*data-i18n-aria="opClose"/, '詳細視窗關閉鈕改掛 data-i18n-aria');
  assert.match(html, /id="timelineClose"[^>]*data-i18n-aria="opClose"/, '時間軸關閉鈕改掛 data-i18n-aria');
  assert.match(html, /class="stats"[^>]*data-i18n-aria="opStatsAria"/, '統計磚區塊改掛 data-i18n-aria');

  const js = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  assert.match(js, /\[data-i18n-aria\]/, 'applyI18nDom 應處理 data-i18n-aria 通道');

  assert.equal(i18n.t('zh', 'opStatsAria'), '統計摘要');
  assert.equal(i18n.t('en', 'opStatsAria'), 'Statistics');
});

// 【PM 追加 純視覺】options 頁首 logo 改用品牌盾牌鏈節 #i-brand(對齊工具列/
// 商店 PNG)，不再是 sparkles。靜態鎖住 symbol 存在且 topbar logo 引用它。
test('PM 追加:options 頁首 logo 使用品牌盾牌 #i-brand symbol', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(html, /<symbol id="i-brand"[\s\S]*?<\/symbol>/, '應定義 #i-brand symbol');
  assert.match(html, /class="logo"><svg class="icon"><use href="#i-brand"/, 'topbar logo 應引用 #i-brand');
  assert.match(html, /fill="#e2925e"/, '#i-brand 應含品牌橘盾色(固定雙色，不跟 currentColor)');
});

// 詳細視窗照手機版:淨化後連結列——不論有沒有 author/excerpt 預覽都固定
// 顯示，值經 formatDisplayUrl 顯示正規路徑(@handle/post/ID)，不是完整
// 網址(UI 全面對齊手機任務 work item 5，authored update:上一輪詳細視窗
// 仿造時這格顯示完整 URL，這次改用手機版 CopyRow 的顯示格式)。
test('controller smoke:詳細視窗固定顯示淨化後連結列(正規路徑，非完整網址)，複製按鈕點擊不丟例外', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  assert.equal(doc.ids.detailUrlValue.textContent, '@usera/post/AbC123_-xyz', '顯示值是 formatDisplayUrl 後的正規路徑');
  // navigator.clipboard 在這個最小 DOM stub 環境不存在，copyEntryUrl 本身
  // 用 try/catch 吞掉並改走失敗 toast，這裡只驗證點擊不會讓整條渲染炸掉。
  assert.doesNotThrow(() => doc.ids.detailUrlCopyBtn.fire('click'));
});

// UI 全面對齊手機任務 work item 7:original/removedParams 有資料時，詳細
// 視窗應在淨化後連結列與記錄時間列之間畫出對應的 kv 列;沒資料時
// detailExtraRows 容器保持空。
test('controller smoke:original/removedParams 有資料時詳細視窗畫出對應列，沒資料時容器為空', async () => {
  const historyWithExtra = [
    {
      url: CARD_URL_A,
      kind: 'share',
      at: 1000,
      // F1:original 需吻合白名單(SHARE 或容尾 POST);用合法 share 短連結。
      original: 'https://www.threads.com/share/xyz',
      removedParams: [{ key: 'igsh', value: 'aBc' }],
    },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history: historyWithExtra });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  const rows = doc.ids.detailExtraRows.children;
  assert.equal(rows.length, 2, '原始連結 + 一筆追蹤參數');
  assert.equal(rows[0].children[0].textContent, i18n.t('zh', 'opOriginalLabel'));
  assert.equal(rows[1].children[0].textContent, i18n.fmt('zh', 'opTrackingParamLabel', { name: 'igsh' }));
});

test('controller smoke:original/removedParams 缺席時 detailExtraRows 容器保持空', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  assert.equal(doc.ids.detailExtraRows.children.length, 0);
});

// 時間軸:單筆(或 seen 缺席，因為本分支還沒接 fix/dedup-merge 的 schema
// 變更)不顯示時間軸鈕——見 buildSeenTimeline 註解。
test('controller smoke:seen 缺席或只有一筆時，詳細視窗不顯示時間軸鈕', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  assert.equal(doc.ids.detailTimelineBtn.hidden, true, 'seen 缺席時不顯示時間軸鈕');
});

// 時間軸:seen 有多筆時顯示時間軸鈕(純文字「時間軸」，不帶次數)，點擊後
// 開啟子層視窗(PM 補充使用者提供的手機實機截圖後，從上一輪的原地展開
// 改回巢狀 Modal，逐項對齊手機版 showSeenHistory 分支)，標題帶次數
// 「解析時間軸(共 N 次)」，逐列新到舊顯示「時間 + 來源標籤」，軌道圓點
// 最新一筆實心、其餘空心，✕ 鈕關閉子層視窗。
test('controller smoke:seen 有多筆時顯示時間軸鈕，點擊開啟子層視窗，逐列顯示軌道圓點與時間/來源標籤', async () => {
  const history = [
    {
      url: CARD_URL_A,
      kind: 'share',
      at: 3000,
      seen: [
        { at: 1000, kind: 'strip' },
        { at: 3000, kind: 'share' },
        { at: 2000, kind: 'menu' },
      ],
    },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');

  assert.equal(doc.ids.detailTimelineBtn.hidden, false, 'seen 有多筆時應顯示時間軸鈕');
  assert.equal(doc.ids.detailTimelineBtn.textContent, i18n.t('zh', 'opTimelineBtn'), '觸發鈕是純文字，不帶次數(次數改顯示在子層視窗標題)');

  doc.ids.detailTimelineBtn.fire('click');

  assert.equal(doc.ids.timelineOverlay.hidden, false, '點擊時間軸鈕應開啟子層視窗');
  assert.equal(doc.ids.timelineTitle.textContent, i18n.fmt('zh', 'opTimelineCount', { n: 3 }), '子層視窗標題帶次數');

  const rows = doc.ids.detailTimeline.children;
  assert.equal(rows.length, 3);

  // 軌道圓點:最新一筆(index 0)實心，其餘空心;非最後一筆才接續軌道線。
  assert.equal(rows[0].children[0].children[0].className, 'timeline-dot filled', '最新一筆圓點實心');
  assert.equal(rows[1].children[0].children[0].className, 'timeline-dot', '其餘圓點空心');
  assert.equal(rows[2].children[0].children[0].className, 'timeline-dot', '其餘圓點空心');
  assert.equal(rows[0].children[0].children.length, 2, '非最後一筆有 dot+line 兩個子節點');
  assert.equal(rows[2].children[0].children.length, 1, '最後一筆(最舊)只有 dot，沒有軌道線');

  // 絕對時間用本機時區格式化(比照上面「絕對時間格式」的既有慣例，不能
  // 硬編換算後的字串，換執行機器時區就會炸)，只驗格式與相對新舊排序。
  // 時間/來源標籤是 textEl 底下兩個獨立的直接子節點(children[0]=時間，
  // children[1]=來源標籤)，不是拼在同一個節點的字串。
  rows.forEach((row) => assert.match(row.children[1].children[0].textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '每列時間格式 YYYY-MM-DD HH:mm'));
  assert.deepEqual(
    rows.map((row) => row.children[1].children[1].textContent),
    [
      '　· ' + i18n.t('zh', 'opKindShare'),
      '　· ' + i18n.t('zh', 'opKindMenu'),
      '　· ' + i18n.t('zh', 'opKindStrip'),
    ],
    '每列的來源標籤依 kind 對應既有 KINDS 文案，新到舊排序'
  );

  doc.ids.timelineClose.fire('click');
  assert.equal(doc.ids.timelineOverlay.hidden, true, '✕ 鈕應收合時間軸子層視窗');
});

// 切換條目(或關閉詳細視窗)時，時間軸子層視窗要一併收合，避免上一筆的
// 展開態殘留到下一筆。
test('controller smoke:關閉詳細視窗時一併收合已開啟的時間軸子層視窗', async () => {
  const history = [
    {
      url: CARD_URL_A,
      kind: 'share',
      at: 3000,
      seen: [
        { at: 1000, kind: 'strip' },
        { at: 3000, kind: 'share' },
      ],
    },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  doc.ids.detailTimelineBtn.fire('click');
  assert.equal(doc.ids.timelineOverlay.hidden, false);

  doc.ids.detailClose.fire('click');
  assert.equal(doc.ids.timelineOverlay.hidden, true, '關閉詳細視窗應順手收合還開著的時間軸子層視窗');
});

// ============================================================
// 0.5.0:常開頁面的即時性稽核——設定在 popup(或另一個 options 分頁)
// 改動時，常開的本頁要同步反映(controller.setSyncSettings，由接線層的
// chrome.storage.onChanged 監聽器在 areaName==='sync' 時呼叫)。
// ============================================================

test('setSyncSettings:別處變更的開關值同步套用到本頁 checkbox，不觸發寫回(不呼叫 syncStorage.set)', async () => {
  const storage = createChromeStorage({ langPref: 'zh', autoClean: false, postCopyEnabled: true }, {});
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  const setCallsBefore = storage.calls.set.length;
  controller.setSyncSettings({ autoClean: { newValue: true, oldValue: false } });

  assert.equal(doc.ids.autoClean.checked, true, '別處把 autoClean 改成 true，本頁 checkbox 應同步');
  assert.equal(storage.calls.set.length, setCallsBefore, '同步別處的變更不應再寫回 storage(避免迴圈)');
});

test('setSyncSettings:langPref 變更時同步語言並重新渲染卡片文案;themePref 變更時套用主題', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  // 換語言前:卡片徽章是中文(短碼解析)。data-i18n 靜態節點的翻譯要靠
  // document.querySelectorAll 掃描更新，DOM stub 的 querySelectorAll 是
  // no-op 掃不到，所以改驗證會重新渲染的卡片(badge 直接用 tt() 設
  // textContent，不靠 data-i18n 掃描)，一樣能證明 locale 真的切換了。
  const badgeBefore = doc.ids.rows.children[0].children[0].children[0].children[0];
  assert.equal(badgeBefore.textContent, '短碼解析');

  controller.setSyncSettings({ langPref: { newValue: 'en', oldValue: 'zh' } });

  const badgeAfter = doc.ids.rows.children[0].children[0].children[0].children[0];
  assert.equal(badgeAfter.textContent, 'Resolved', '別處把語言改成 en，重新渲染後卡片徽章應變成英文');

  controller.setSyncSettings({ themePref: { newValue: 'dark', oldValue: 'auto' } });
  assert.equal(doc.documentElement.dataset.theme, 'dark', '別處把主題改成 dark，本頁應套用');
});

// 【R6 併發中3 + cr low6 + UI 效能建議a】60s ticker / visibilitychange 回
// 分頁時走的 refresh() 改成輕量路徑:只逐一改已登錄時間節點的 textContent，
// 不呼叫 renderAll 整面重建卡片(全量重建會偷走鍵盤焦點與文字選取)。
// 這裡驗證兩件事:(1) 卡片 DOM 原地保留(不是重建的新節點);(2) 相對時間
// 文字有隨當下時間更新。now 用可變 closure 模擬時間前進。
test('refresh:輕量刷新——原地保留卡片節點，只更新相對時間文字，不重建卡片牆', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  let clock = 1000 + 61 * 1000; // at 之後 61 秒 → 「1 分鐘前」
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => clock,
  });

  await controller.init();
  await settle();

  const beforeCard = doc.ids.rows.children[0];
  const timeEl = beforeCard.children[0].children[0].children[1]; // header > meta > [badge, headTime]
  assert.equal(timeEl.textContent, i18n.fmt('zh', 'opRelMin', { n: 1 }));

  clock = 1000 + 3 * 60 * 1000 + 61 * 1000; // 再往前推，約 4 分鐘前
  controller.refresh();

  const afterCard = doc.ids.rows.children[0];
  assert.strictEqual(beforeCard, afterCard, 'refresh 應原地保留舊卡片節點(不重建)，才不會偷走焦點');
  assert.equal(doc.ids.rows.children.length, 1, 'entries 沒變，卡片數量維持');
  assert.equal(timeEl.textContent, i18n.fmt('zh', 'opRelMin', { n: 4 }), '相對時間文字應原地更新到當下');
});

// R6 附帶(UI 低8):詳細視窗開著時，ticker 也刷新視窗內的相對時間
// (detailTime)。
test('refresh:詳細視窗開著時一併刷新視窗內相對時間(detailTime)', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  let clock = 1000 + 61 * 1000;
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => clock,
  });

  await controller.init();
  await settle();

  doc.ids.rows.children[0].fire('click');
  assert.equal(doc.ids.detailTime.textContent, i18n.fmt('zh', 'opRelMin', { n: 1 }));

  clock = 1000 + 9 * 60 * 1000 + 61 * 1000; // 約 10 分鐘前
  controller.refresh();

  assert.equal(doc.ids.detailTime.textContent, i18n.fmt('zh', 'opRelMin', { n: 10 }), '視窗內相對時間應一併刷新');
});
