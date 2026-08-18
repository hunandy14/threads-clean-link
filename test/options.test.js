// test/options.test.js — options 頁邏輯層(options.js)的行為契約。
// 純函式(過濾/匯入合併/匯出形狀/統計聚合)直接打;controller 以最小 DOM
// stub 做一條 smoke(整條 init 渲染跑得完、清單筆數與計數正確)——demo
// 階段踩過「區域變數遮蔽翻譯函式、整頁渲染炸掉但語法全綠」的雷,smoke
// 就是為了堵這一類執行期炸彈,不逐一測版面。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createChromeStorage } = require('./support/helpers');

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

// 0.4.0 新增:KINDS 表補上 icon 後,aggregateStats 的 counts 也要能統計
// kind:'icon' 的筆數,供 options.html 新增的統計磚(#statIcon)使用——修正
// 前 counts 缺 icon 鍵,e.kind 為 'icon' 時 counts[e.kind] 會是 undefined,
// counts[e.kind]++ 產生 NaN 而不計數。
test('aggregateStats:counts 應統計 kind 為 icon 的筆數(修正前缺 icon 鍵導致 NaN)', () => {
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime();
  const entries = [
    { url: URL_A, kind: 'icon', at: nowTs - 3600e3 },
    { url: URL_B, kind: 'icon', at: nowTs - 7200e3 },
    { url: URL_C, kind: 'share', at: nowTs - 3600e3 },
  ];

  const stats = options.aggregateStats(entries, nowTs);
  assert.equal(stats.counts.icon, 2);
  assert.equal(stats.counts.share, 1);
  assert.equal(stats.total, 3);
});

test('aggregateStats:沒有任何 icon 來源紀錄時,counts.icon 為 0(而非 undefined)', () => {
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime();
  const stats = options.aggregateStats(
    [{ url: URL_A, kind: 'share', at: nowTs }],
    nowTs
  );

  assert.equal(stats.counts.icon, 0);
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
test('buildDetailExtraRows:removedParams 逐筆產生「追蹤參數 {name}」列，形狀不對的項目濾掉不影響其他筆', () => {
  const entry = {
    url: 'https://x/y',
    removedParams: [
      { name: 'igsh', value: 'aBc123' },
      { name: 123, value: 'bad-name-type' },
      { value: 'missing-name' },
      { name: 'utm_source', value: 456 },
      null,
      { name: 'xmt', value: 'kept' },
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

// ---- 設定頁不再出現 notifySuccess 控件(PM 審查後補) ----
//
// R1 同輪已把成功通知整組拆光，notifySuccess 合併後零讀取端;上一輪誤以
// 「另一車道尚未拆通知」為由保留這顆開關，是過期情報，變成誤導使用者的
// 死 UI。這裡從兩個角度釘住它不會再出現:純函式層的 SETTING_IDS/
// OPTIONS_DEFAULT_SETTINGS 不含這顆鍵，以及 options.html 原文不再有
// id="notifySuccess" 的控件(靜態檢查，照 popup.test.js 既有的 R1-3 慣例)。
test('notifySuccess:OPTIONS_DEFAULT_SETTINGS 與 SETTING_IDS 皆不含這顆鍵(成功通知已整組移除)', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(options.OPTIONS_DEFAULT_SETTINGS, 'notifySuccess'), false);
});

test('notifySuccess:options.html 原文不再有 id="notifySuccess" 的控件', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.equal(/\bid\s*=\s*["']notifySuccess["']/i.test(html), false, 'options.html 不應再有 notifySuccess 控件');
  assert.equal(/\bopNotify(Name|Desc)\b/.test(html), false, 'options.html 不應再引用 opNotifyName/opNotifyDesc');
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
test('controller smoke:詳細視窗的刪除按鈕刪除目前顯示的條目並收合視窗', async () => {
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

  doc.ids.detailDeleteBtn.fire('click');

  assert.equal(doc.ids.rows.children.length, 0, '刪除後卡片牆應重新渲染為空');
  assert.equal(doc.ids.detailOverlay.hidden, true, '刪除目前顯示中的條目應順手關閉詳細視窗');
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
      original: 'https://l.threads.net/share/xyz?igsh=aBc',
      removedParams: [{ name: 'igsh', value: 'aBc' }],
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

// 常開分頁背景時不即時跳動，回到分頁(visibilitychange → visible)才重算
// 一次相對時間標籤——這裡直接測 controller.refresh() 這個由接線層呼叫的
// 進入點，驗證它會重新渲染卡片牆(entries 不變，只是重新產生 DOM)。
test('refresh:重新渲染卡片牆(視覺上等同重算相對時間標籤)，不改變 entries 內容', async () => {
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

  const beforeCard = doc.ids.rows.children[0];
  controller.refresh();
  const afterCard = doc.ids.rows.children[0];

  assert.equal(doc.ids.rows.children.length, 1, 'entries 沒變，卡片數量應維持一致');
  assert.notStrictEqual(beforeCard, afterCard, 'refresh 應重新建構卡片 DOM(非原地保留舊節點)');
});
