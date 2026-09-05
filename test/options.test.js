// test/options.test.js — options 頁邏輯層(options.js)的行為契約。
// 純函式(過濾/匯入合併/匯出形狀/統計聚合)直接打;controller 以最小 DOM
// stub 做一條 smoke(整條 init 渲染跑得完、清單筆數與計數正確)，堵「區域
// 變數遮蔽翻譯函式、整頁渲染炸掉但語法全綠」這類執行期炸彈，不逐一測版面。
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

// settle() 原本是本檔逐字維護的一份牆鐘等待邏輯:controller 的每一條非同
// 步鏈路(讀設定 → 讀紀錄 → 渲染;或清除全部的「重讀 syncState → 寫回」)
// 都經 chrome.storage mock 的 setTimeout(0) 落盤，而 Windows 的計時器粒度
// 約 15.6ms，固定 ms 訂太小、鏈路多一次 storage 往返就會在斷言前還沒跑完;
// 連同其餘五份逐字或近乎逐字相同的版本收斂進 test/support/settle.js 一份
// 共用實作(原理與各項取捨的完整說明，包含本檔特有的「只等延遲不超過上限
// 的計時器」——用來排除 options.js toast 那顆 2200ms 自動隱藏計時器——見
// 該檔頭註解)。
const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

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

// 篩選 chip(options.html 的 #chips)與 filterEntries 共用同一份純函式，
// 這裡直接驗證 kind 過濾對 icon(貼文互動列複製按鈕)一樣生效，不用另外
// 搭 DOM 才能測。
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

test('parseImportText:非 JSON 與缺 entries 陣列各回報對應錯誤，合法時回傳 entries', () => {
  assert.deepEqual(options.parseImportText('not json'), { ok: false, error: 'badJson' });
  assert.deepEqual(options.parseImportText('{"app":"x"}'), { ok: false, error: 'noEntries' });

  const parsed = options.parseImportText(`{"entries":[{"url":"${URL_A}"}]}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
});

test('mergeImportedEntries:錨定驗證 url、以 url 去重、kind/at 非法時套預設，結果新到舊', () => {
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

// 紀錄不設上限:合併結果完全不裁切，HISTORY_LIMIT 這個常數與其 api 匯出
// 都已移除。這條鎖「不裁切」的正面斷言。
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

// 【斷言翻轉】原斷言為「entries 只留三欄」(url/kind/at)。依 docs/cloud-sync.md
// 4.1，匯出檔加帶 id／receivedAt／serverUpdatedAt——少了它們，匯出再匯入等於
// 在雲端把同一張卡拆成兩張、起始時間往後跳、合併判準歸零。未知欄位(extra)
// 仍然一律丟棄，這一點不變。
test('buildExportPayload:輸出 app/version/exportedAt/entries 形狀，entries 只留白名單欄位', () => {
  const payload = options.buildExportPayload(
    [{ url: URL_A, kind: 'share', at: 123, extra: 'junk', id: 'card-1', receivedAt: 100, serverUpdatedAt: 200 }],
    '2026-08-16T00:00:00.000Z'
  );

  assert.equal(payload.app, 'threads-clean-link');
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, '2026-08-16T00:00:00.000Z');
  assert.deepEqual(payload.entries, [
    { url: URL_A, kind: 'share', at: 123, id: 'card-1', receivedAt: 100, serverUpdatedAt: 200 },
  ]);

  // postKey／dirty／deletedAt 不輸出:前兩者匯入端可推導，deletedAt 的來源
  // (visibleEntries)已濾掉墓碑。
  const withSkipped = options.buildExportPayload(
    [{ url: URL_A, kind: 'share', at: 1, postKey: 'threads:x', dirty: true, deletedAt: 5 }],
    '2026-08-16T00:00:00.000Z'
  );
  assert.deepEqual(withSkipped.entries, [{ url: URL_A, kind: 'share', at: 1 }]);
});

// entries 擴充選填 author/handle/excerpt，為字串時才輸出，規則與
// sanitizeEntries/mergeImportedEntries 一致。
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

// buildExportPayload 輸出 seen/original/removedParams 三欄，沿用「缺席不寫」
// 慣例:seen 是空陣列或非陣列都不輸出、original 非字串不輸出、removedParams
// 是空陣列或非陣列都不輸出。
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

// 匯入的 url 額外容忍尾隨斜線/query/hash 並正規化，這裡驗證這個容忍度。
test('mergeImportedEntries:url 容忍尾隨斜線/query/hash 並正規化(前身收藏庫的網址驗證邏輯)', () => {
  const result = options.mergeImportedEntries([], [{ url: `${URL_A}/?xmt=AQGabc`, kind: 'share', at: 1 }], 1000);
  assert.equal(result.added, 1);
  assert.equal(result.merged[0].url, URL_A, 'url 應正規化為不含尾隨斜線/query 的乾淨網址');
});

// 匯入的 author/handle/excerpt 逐條 sanitize(截斷 100/100/2000，非字串
// 整欄丟棄)，規則與 background.js 落盤前的處理對齊。
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
  ['author', 'handle', 'excerpt'].forEach((f) => assert.equal(f in dropped, false, 'S4：非字串型別的選填欄位應整欄不寫入'));
});

// 匯入條目帶偽造 seen 的 sanitize。匯入檔是外部輸入，seen[] 逐筆過 at 有限
// 數字、kind 白名單，不合法的記錄整筆丟棄、不整組作廢;全部不合法時整欄
// 不寫入。上限 SEEN_MAX(50)一併裁切，防匯入檔夾帶超長偽造陣列。
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

// 匯入檔的 original/removedParams(對齊手機 ShareHistoryItem)屬外部輸入，
// 同樣要逐欄 sanitize，規則與 background.js 落盤前的處理對齊。

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
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime(); // 中午，避開日界線
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
  assert.deepEqual(stats.counts, { share: 3, strip: 1, menu: 1, icon: 0 });
  assert.equal(stats.week, 3, '滾動 7 天:今天兩筆 + 昨天一筆');
  assert.equal(stats.weekPrev, 1, '前一個 7 天:只有 13 天前那筆');
  assert.equal(stats.days[13], 2, '索引 13 = 今天');
  assert.equal(stats.days[12], 1, '昨天');
  assert.equal(stats.days[0], 1, '13 個日曆日前落在最左桶');
  assert.equal(stats.oldestAt, t0 - 14 * DAY - 3600e3);
});

// aggregateStats 的 counts 要能統計 kind:'icon' 的筆數(供 options.html
// 統計磚 #statIcon 使用;counts[e.kind]++ 對缺席鍵會產生 NaN 而不計數)，
// 且沒有 icon 來源紀錄時 counts.icon 應為 0 而非 undefined。
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

// sanitizeEntries 的白名單(靠 Object.prototype.hasOwnProperty.call(KINDS,
// e.kind))應收下 kind:'icon'，不當成未知 kind 丟棄。
test('sanitizeEntries:kind 為 icon(貼文按鈕)的項目應保留，不再被白名單丟棄', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'icon', at: 1 },
    { url: URL_B, kind: 'nope', at: 1 },
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// 縱深防禦:url 額外過 POST_URL_PATTERN 形狀驗證——渲染層 buildEntryCard 的
// openLink.href = e.url、複製到剪貼簿都是 url sink，讀取階段就該擋掉形狀
// 不對的 url，不依賴「寫入端永遠沒漏」的假設。
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

// entries 擴充選填 author/handle/excerpt。核心欄位(url/kind/at)合法時，
// 選填欄位為字串則截斷至長度上限，非字串則整欄丟棄(不影響核心欄位本身，
// entry 仍保留)——與 mergeImportedEntries 的 sanitizeTextField 規則一致，
// 縱深防禦不依賴 background.js 寫入端沒漏。
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

// seen[] 是「先前已經落盤的資料」，讀取階段(sanitizeEntries)同樣要逐筆
// sanitize，偽造/損毀的記錄(at 非數字、kind 不在白名單、非物件)逐筆丟棄，
// 不因此整個陣列作廢;真的沒有合法記錄剩下時整欄不寫入(缺席不落空陣列
// 佔位，與 author/handle/excerpt 的慣例一致)。kind 缺席的記錄(手機版語意
// 的起始種子紀錄，見 background.js 的 mergeHistoryEntry)須視為合法保留，
// 不得誤殺。seen 整欄本身非陣列(不是陣列內某一筆形狀不對，是整個欄位型別
// 就錯)同樣視為缺席，不輸出該欄。
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

// ---- 純函式:isLongExcerpt(對齊手機版 history-detail-dialog.tsx 的
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

// ---- 純函式:buildSeenTimeline(對齊手機版 history-detail-dialog.tsx 的
// 時間軸)——seen 缺席/非陣列/單筆一律回傳 null(呼叫端據此決定要不要顯示
// 時間軸鈕)，多筆才回傳新到舊排序的陣列 ----
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

// ---- 純函式:renderExcerptWithLinks(不可信文字進 a.href 的安全邊界) ----
//
// 摘要是頁面來源的不可信文字。這條釘住兩個安全性質:只有以 http(s):// 開頭
// 的片段能成為 a.href(javascript: 等其他協定連 split 都進不了連結分支，整
// 段當純文字);含省略號「…」的顯示層截斷網址維持純文字，不做成連結(殘缺
// 網址點下去會導向非預期目標)。makeNode/makeDocumentStub 為既有 DOM stub。
test('renderExcerptWithLinks:javascript: 協定不成連結、含省略號的截斷網址維持純文字，只有 http(s) 進 a.href', () => {
  const doc = makeDocumentStub();

  // javascript: 沒有 http(s):// 前綴，走快速路徑整段當純文字，不產生任何子節點。
  const el1 = makeNode('div');
  options.renderExcerptWithLinks(doc, el1, 'javascript:alert(1) 點我');
  assert.equal(el1.children.filter((c) => c.tag === 'a').length, 0, 'javascript: 不得成為連結');
  assert.equal(el1.textContent, 'javascript:alert(1) 點我', '整段維持純文字');

  // 含「…」的截斷網址:即便有 https:// 前綴，也維持純文字不做成 a。
  const el2 = makeNode('div');
  options.renderExcerptWithLinks(doc, el2, 'https://www.threads.com/@u/post/AbCd…');
  assert.equal(el2.children.filter((c) => c.tag === 'a').length, 0, '含…的殘缺網址不做成連結');

  // 對照組:乾淨 http(s) 連結才做成 a，且 href 必以 http(s):// 開頭。
  const el3 = makeNode('div');
  options.renderExcerptWithLinks(doc, el3, '看 https://example.com/x 這裡');
  const anchors = el3.children.filter((c) => c.tag === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'https://example.com/x');
  assert.ok(/^https?:\/\//.test(anchors[0].href), 'a.href 一定以 http(s):// 開頭');
});

// ---- 純函式:formatDisplayUrl(對齊手機版 lib/format-display-url.ts)----
test('formatDisplayUrl:去 scheme 與網域(含 www.)，只留 path+query+hash 並去掉開頭斜線', () => {
  assert.equal(options.formatDisplayUrl('https://www.threads.com/@usera/post/AbC123'), '@usera/post/AbC123');
  assert.equal(options.formatDisplayUrl('https://threads.net/@u/post/x?y=1#z'), '@u/post/x?y=1#z');
});
test('formatDisplayUrl:解析失敗 fail-open 回傳原字串;非字串輸入回傳空字串', () => {
  assert.equal(options.formatDisplayUrl('not a url'), 'not a url');
  assert.equal(options.formatDisplayUrl(undefined), '');
  assert.equal(options.formatDisplayUrl(null), '');
});

// ---- 純函式:buildDetailExtraRows——original/removedParams 兩列渲染的
// 資料準備:缺席/形狀不對就不產生該列 ----
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
// removedParams 元素的欄位名是 { key, value }(手機版 link-cleaner.ts:171、
// detail-dialog 的 p.key，也是 background.js sanitizeRemovedParams 實際落盤
// 的形狀)，不是 { name, value }。
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

// ---- 跨層釘住(表格驅動) ----
//
// 兩個權威來源(手機版 link-cleaner.ts:171 與 detail-dialog 的 p.key，
// 以及 background.js 的 sanitizeRemovedParams 實際落盤形狀)的欄位名/長度
// 上限必須與 options 讀取端一致。表格涵蓋 author/handle/excerpt/original/
// removedParams 五個選填欄位 + url 形狀案例，任一欄的欄位名/長度上限漂移
// 都能在這裡攔下。
//
// 每筆 case 把 message 餵給 background.js 真實的 extractHistoryExtraFields
// (vm sandbox 載入真實原始碼，不是重新複製一份邏輯抄在測試裡)，取得
// 「background 端真的會落盤的形狀」，原封不動餵給 options.sanitizeEntries
// (options 端真實讀取路徑)，斷言兩層對同一筆輸入的認定完全一致——比
// 「比對兩邊原始碼字面上寫的欄位名/數字」這種容易同步漂移的弱驗證更難被
// 同類回歸繞過。
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
    // original 需吻合白名單(SHARE 或容尾 POST);用合法 share 短連結，兩層都保留。
    field: 'original',
    label: '與 cleaned url 不同且吻合白名單(share 短連結)時應保留',
    message: { original: 'https://www.threads.com/share/abc' },
    expect: { original: 'https://www.threads.com/share/abc' },
  },
  {
    // 非白名單(偽造/畸形殘 URL)的 original 兩層都整欄丟棄。
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

// url 形狀邊界案例:handle/post id 長度上限各 80 字元(字元類與上限由
// TCLCore 的 NORMALIZE_POST_URL_PATTERN 單一權威定義，寫入側 background
// 與讀取側 options 共用同一份)。恰為 80 應保留、81 應整筆丟棄。
const CROSS_LAYER_URL_CASES = [
  {
    label: 'handle/post id 剛好 80 字元應保留',
    url: 'https://www.threads.com/@' + 'h'.repeat(80) + '/post/' + 'i'.repeat(80),
    expectSurvive: true,
  },
  {
    label: 'handle 81 字元應整筆丟棄',
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

// ---- 設定頁不再出現 notifySuccess 控件 ----
//
// 成功通知整組拆除後 notifySuccess 零讀取端。這裡從兩個角度釘住它不會
// 再出現:純函式層的 SETTING_IDS/OPTIONS_DEFAULT_SETTINGS 不含這顆鍵，以及
// options.html 原文不再有 id="notifySuccess" 的控件(靜態檢查)。
test('notifySuccess:OPTIONS_DEFAULT_SETTINGS/SETTING_IDS 不含這顆鍵，options.html 原文也不再有對應控件(成功通知已整組移除)', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(options.OPTIONS_DEFAULT_SETTINGS, 'notifySuccess'), false);

  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.equal(/\bid\s*=\s*["']notifySuccess["']/i.test(html), false, 'options.html 不應再有 notifySuccess 控件');
  assert.equal(/\bopNotify(Name|Desc)\b/.test(html), false, 'options.html 不應再引用 opNotifyName/opNotifyDesc');
});

// ---- 全域 [hidden] 規則 ----
//
// options.html 只有 .overlay[hidden]{display:none} 這一條窄規則，蓋不到
// 頁面內任何「自己有寫 display」的其他元素(detailAuthorRow/detailExcerpt/
// detailExpandBtn 都是——同 specificity 下自身樣式一律贏過瀏覽器 UA 樣式表
// 的 [hidden]{display:none}，JS 端設 el.hidden=true 完全沒有視覺效果)。
// 最小 DOM stub 不解析真實 CSS，測不出視覺效果，只能靜態原文檢查，鎖住
// 這條全域規則存在且用了 !important。
test('[hidden] 修正:options.html 應有全域 [hidden]{display:none!important} 規則', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(
    html,
    /^\s*\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/m,
    'options.html 應有全域 [hidden] 規則且帶 !important，才蓋得過同頁面其他元素自己的 display 宣告'
  );
});

// ---- #confirmOverlay 的 z-index ----
//
// 確認框(#confirmOverlay)在 options.html 的 DOM 順序寫在詳細視窗
// (#detailOverlay)前面，兩者同吃 .overlay 的 z-index:10 時，後出現的
// detail 依繪製順序蓋上來——「從詳細視窗按刪除這筆」開的確認框整個被
// 遮住:畫面看似沒反應、焦點靜默落在看不見的 #confirmCancel、點遮罩
// 關到的是 detail(留下孤兒 confirm)。confirm 需自帶更高 z-index。
//
// 最小 DOM stub 不解析真實 CSS，測不出繪製層級，只能靜態原文檢查。正則
// 以 ^ 行首錨定 + m 旗標，只認真正的 CSS 規則行——不加錨定的話，本檔/HTML
// 註解散文裡只要提到 #confirmOverlay 與 z-index 就會誤命中，變成鎖不住
// 東西的假釘。
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

function makeNode(tag, ownerDoc) {
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
      // 比照真實 DOM 的 classList.add/remove:可變參數，一次收多個
      // class(options.js 的 statusDot 重設就是 remove('is-danger',
      // 'is-warning') 一次兩個，只認單一參數會漏清第二個)。
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
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
    removeAttribute(k) {
      delete attrs[k];
    },
    contains(other) {
      // 淺層足夠:帳號選單的「點外關閉」只需要判斷目標是否為容器自身或
      // 其直接子節點(測試以 fire('click', { target }) 模擬，不會構造更深的
      // 巢狀節點)。
      if (other === node) return true;
      return node.children.indexOf(other) !== -1;
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
    // 帳號選單的鍵盤導覽/開合測試需要 focus 落點:owner document 存在時
    // 才記錄(比照真 DOM 的 document.activeElement)，沒有 owner 時(獨立
    // 建立的節點，如既有測試直接呼叫 makeNode() 者)安靜 no-op。
    focus() {
      if (ownerDoc) ownerDoc.activeElement = node;
    },
    blur() {
      if (ownerDoc && ownerDoc.activeElement === node) ownerDoc.activeElement = null;
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
  const docListeners = {};
  const doc = {
    ids: byId,
    documentElement: makeNode('html'),
    activeElement: null,
    getElementById(id) {
      if (!byId[id]) byId[id] = makeNode('#' + id, doc);
      return byId[id];
    },
    createElement(tag) {
      return makeNode(tag, doc);
    },
    createElementNS(ns, tag) {
      return makeNode(tag, doc);
    },
    createTextNode(text) {
      const n = makeNode('#text', doc);
      n.textContent = text;
      return n;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    // 帳號選單的「點外關閉」/Esc 監聽掛在 document 層級(見 options.js 的
    // bindAccount)，比照節點的 addEventListener/fire 慣例真的登記/派送，
    // 而不是像既有多數測試那樣留白 no-op——這兩個行為只能靠 document 層級
    // 事件驗證，其餘既有的對話框 Esc 處理仍是留白(見各處「由人工/CDP
    // 驗證」註解)，這裡只為帳號選單新增的兩條路徑補上最小可行的派送。
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    removeEventListener() {},
    fire(type, event) {
      (docListeners[type] || []).slice().forEach((fn) => fn(event || { type }));
    },
  };
  return doc;
}

test('controller smoke:init 讀兩區 storage、整條渲染跑完，清單與計數正確', async () => {
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
  // autoClean 預設值 false(popup/options 兩側鏡像同一個 fallback，
  // 對齊 background.js 的預設)。
  assert.equal(doc.ids.autoClean.checked, false, '設定未存值時應套新預設 false');

  controller.setHistory([]);
  assert.equal(doc.ids.rows.children.length, 0);
  assert.equal(doc.ids.empty.hidden, false, '清空後應顯示空狀態');
  assert.equal(doc.ids.countHint.textContent, '顯示 0 / 0 筆');
});

// renderList 的網域段須如實反映紀錄網域:來自 threads.net 的紀錄
// (POST_URL_PATTERN／KINDS 都同時允許 com 與 net)不得顯示成 .com。這裡
// 直接檢查渲染出來的三段文字節點(網域段／帳號段(<b>)／其餘路徑段)，
// 網域段須如實為 'threads.net/'。
test('renderList:threads.net 的紀錄如實顯示 .net，不誤植為 .com', async () => {
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
// 紀錄卡片牆——帶預覽 / 降級網址兩種形狀
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
  // excerpt → 高亮態快捷鈕組(互動照手機的選中態，平時態靠 CSS
  // display:none 隱藏，這裡的 DOM stub 不解析 CSS，所以節點一律存在，只
  // 驗證結構)。
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

// 卡片高亮態的兩顆快捷鈕(複製連結/開啟貼文)。這裡驗證快捷鈕本身的行為:
// 複製鈕點擊會 stopPropagation、不會順手把詳細視窗打開;開啟鈕是原生
// <a>，href 正確。
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

// 切到降級條目時，openEntryDetail 的無預覽分支必須清掉 authorName/handle/
// excerpt 的 textContent 並設 hidden，否則上一筆有 author/handle/excerpt
// 的條目文字會原地殘留露出來。
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
// 刪除先跳一道確認框(複用清除全部那套 confirmOverlay)，文案是「確定刪除
// 這筆紀錄?」/確認鈕「刪除」，確認後才刪。
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

// deleteEntry 以 url+at 精準命中。刻意讓 entries 裡出現兩筆相同 url、不同
// at 的資料(同一貼文在 5 分鐘視窗外各自獨立成筆的真實情境)，刪其中一筆時
// 只該刪中被點的那一筆，同 url 的另一筆必須留著(只比 url 會兩筆都誤刪)。
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

// deleteEntry 沒命中時不寫入、不動視窗、不發「已刪除」成功
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

// 詳細視窗開著時 storage 更新的整合(setHistory 由接線層在
// storage.onChanged(local 區)時呼叫，對齊 background 新寫入/另一分頁改動
// 的即時性):以 url 重新定位 detailEntry，找得到就用新資料刷新視窗內容。
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

// setHistory 帶來的新清單裡已經沒有 detailEntry 對應的 url(例如另一分頁
// 把這筆刪了)，應該關閉詳細視窗，不留著顯示一筆已經不存在的紀錄。
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

// setHistory 走「只刷新內容、不重置互動態」的路徑:使用者正開著時間軸
// 子層時，別處(background/另一分頁)寫入一筆無關的新紀錄，不該把使用者
// 正在看的時間軸子層關掉。
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

// storage 寫入失敗(配額)時:不謊報「已匯入」成功、發專屬失敗 toast，且
// entries 回滾成寫入前的值(記憶體/磁碟不分岔)。用會 reject 的自訂
// localStorage，不走 createChromeStorage(它 set 恆成功)。
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

// 刪除寫入失敗時同樣不謊報「已刪除」——沿用同一條 persistHistory 失敗
// 路徑，這裡最小驗證失敗 toast 取代成功 toast。
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

// 開啟對話框時焦點移入(關閉鈕)。makeNode 預設沒有 focus 方法(全程 typeof
// 守衛跳過)，這裡臨時掛上 focus spy 驗證焦點確實被移進對話框。Tab focus
// trap 需要真實 querySelectorAll，最小 DOM stub 表達不了，由人工/CDP 驗證
// (見 options.js trapTabInOverlay 註解)。
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

// aria-label 走 i18n:options.html 用 data-i18n-aria，applyI18nDom 有對應
// 通道，i18n 有 key(zh/en)。DOM stub 的 querySelectorAll 回空陣列測不到
// applyI18nDom 的實際套用，改用靜態原文 + 字典檢查。
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

// options 頁首 logo 用品牌盾牌鏈節 #i-brand(對齊工具列/商店 PNG)。靜態
// 鎖住 symbol 存在且 topbar logo 引用它。
test('PM 追加:options 頁首 logo 使用品牌盾牌 #i-brand symbol', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(html, /<symbol id="i-brand"[\s\S]*?<\/symbol>/, '應定義 #i-brand symbol');
  assert.match(html, /class="logo"><svg class="icon"><use href="#i-brand"/, 'topbar logo 應引用 #i-brand');
  assert.match(html, /fill="#e2925e"/, '#i-brand 應含品牌橘盾色(固定雙色，不跟 currentColor)');
});

// 詳細視窗照手機版:淨化後連結列——不論有沒有 author/excerpt 預覽都固定
// 顯示，值經 formatDisplayUrl 顯示正規路徑(@handle/post/ID)，不是完整
// 網址(對齊手機版 CopyRow 的顯示格式)。
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

// original/removedParams 有資料時，詳細視窗應在淨化後連結列與記錄時間列
// 之間畫出對應的 kv 列;沒資料時 detailExtraRows 容器保持空。
test('controller smoke:original/removedParams 有資料時詳細視窗畫出對應列，沒資料時容器為空', async () => {
  const historyWithExtra = [
    {
      url: CARD_URL_A,
      kind: 'share',
      at: 1000,
      // original 需吻合白名單(SHARE 或容尾 POST);用合法 share 短連結。
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

// 時間軸:單筆或 seen 缺席時不顯示時間軸鈕——見 buildSeenTimeline 註解。
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
// 開啟子層視窗(對齊手機版 showSeenHistory)，標題帶次數「解析時間軸
// (共 N 次)」，逐列新到舊顯示「時間 + 來源標籤」，軌道圓點最新一筆實心、
// 其餘空心，✕ 鈕關閉子層視窗。
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
// 常開頁面的即時性稽核——設定在 popup(或另一個 options 分頁)改動時，
// 常開的本頁要同步反映(controller.setSyncSettings，由接線層的
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

// 60s ticker / visibilitychange 回分頁時走的 refresh() 是輕量路徑:只逐一
// 改已登錄時間節點的 textContent，不呼叫 renderAll 整面重建卡片(全量重建
// 會偷走鍵盤焦點與文字選取)。這裡驗證兩件事:(1) 卡片 DOM 原地保留(不是
// 重建的新節點);(2) 相對時間文字有隨當下時間更新。now 用可變 closure
// 模擬時間前進。
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

// 詳細視窗開著時，ticker 也刷新視窗內的相對時間(detailTime)。
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

// ============================================================
// S4:options 直接操作 storage 的路徑對齊雲端 schema
// ------------------------------------------------------------
// 刪除／清空的語意依登入態分流(D6:未登入行為與現況完全一致):
//   - 已登入(syncState.userId 非 null):單筆刪除軟刪(寫 deletedAt 墓碑 +
//     dirty)，清除全部寫 syncState.clearedAt 這條全域水位線;
//   - 未登入:維持現況硬刪。
// 墓碑是「等待上傳的刪除意圖」，必須留在 storage，但一律不進畫面、統計、
// 圖表與匯出檔。匯入則改以 postKey 去重(D11)，並接受含／不含新欄位兩種格式。
// ============================================================

const S4_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const S4_NEW_FIELDS = ['id', 'postKey', 'original', 'receivedAt', 'dirty', 'serverUpdatedAt', 'deletedAt'];

// 已登入的 syncState(計劃 4.2 的形狀)。
function signedInState(overrides) {
  return Object.assign(
    { userId: 'user-1', email: 'a@example.com', cursor: null, lastSyncedAt: null, clearedAt: null, lastError: null },
    overrides || {}
  );
}
function signedOutState() {
  return { userId: null, email: null, cursor: null, lastSyncedAt: null, clearedAt: null, lastError: null };
}

// 一筆已具備新欄位的條目(S1 形狀)。
function s4Entry(url, at, overrides) {
  return Object.assign(
    {
      url: url,
      kind: 'share',
      at: at,
      seen: [{ at: at, kind: 'share' }],
      id: 'id-' + at,
      postKey: 'postkey-' + at,
      original: url,
      receivedAt: at,
      dirty: false,
      serverUpdatedAt: null,
      deletedAt: null,
    },
    overrides || {}
  );
}

function makeController(local, syncSeed) {
  const storage = createChromeStorage(Object.assign({ langPref: 'zh' }, syncSeed || {}), local);
  const doc = makeDocumentStub();
  const downloads = [];
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    download: (name, text) => downloads.push({ name, text }),
  });
  return { storage, doc, controller, downloads };
}

// S4:單筆刪除依登入態分流。同一份資料、同一個動作，登入與未登入的落盤結果
// 必須不同——把兩種情境放在同一條測試裡，才擋得住「兩邊都照現況硬刪」。
test('S4 刪除:已登入軟刪(deletedAt + dirty，entry 留在陣列)，未登入維持硬刪', async () => {
  const inCtx = makeController({ history: [s4Entry(URL_A, 1000)], syncState: signedInState() });
  await inCtx.controller.init();
  await settle();
  inCtx.doc.ids.rows.children[0].fire('click');
  inCtx.doc.ids.detailDeleteBtn.fire('click');
  inCtx.doc.ids.confirmOk.fire('click');
  await settle();

  const inHistory = inCtx.storage.localSnapshot().history;
  assert.equal(inHistory.length, 1, '已登入時軟刪:entry 仍留在陣列(墓碑要等伺服器 ack 才真刪)');
  assert.equal(typeof inHistory[0].deletedAt, 'number', 'deletedAt 應寫入刪除時戳');
  assert.ok(inHistory[0].deletedAt > 0);
  assert.equal(inHistory[0].dirty, true, '軟刪是待上傳的變更');
  assert.equal(inHistory[0].id, 'id-1000', '軟刪不得換 id(伺服器要靠它認出刪的是哪張卡)');
  assert.equal(inCtx.doc.ids.rows.children.length, 0, '墓碑不得留在畫面上');
  assert.equal(inCtx.doc.ids.toast.textContent, i18n.t('zh', 'opToastDeleted'), '照常回報已刪除');

  const outCtx = makeController({ history: [s4Entry(URL_A, 1000)], syncState: signedOutState() });
  await outCtx.controller.init();
  await settle();
  outCtx.doc.ids.rows.children[0].fire('click');
  outCtx.doc.ids.detailDeleteBtn.fire('click');
  outCtx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.deepEqual(outCtx.storage.localSnapshot().history, [], '未登入維持現況硬刪，不留墓碑');
});

// S4:清除全部。已登入時 entry 全數移除(不是逐筆轉墓碑——那會把整張表變成
// 墓碑撐爆配額)，改寫 syncState.clearedAt 這條全域水位線，由車道 D 上傳。
test('S4 清除全部:已登入時清空並寫 syncState.clearedAt，未登入不動 syncState', async () => {
  const inCtx = makeController(
    { history: [s4Entry(URL_A, 2000), s4Entry(URL_B, 1000)], syncState: signedInState() }
  );
  await inCtx.controller.init();
  await settle();
  inCtx.doc.ids.clearBtn.fire('click');
  inCtx.doc.ids.confirmOk.fire('click');
  await settle();

  const inLocal = inCtx.storage.localSnapshot();
  assert.deepEqual(inLocal.history, [], '所有 entry 移除');
  assert.equal(typeof inLocal.syncState.clearedAt, 'number', '應寫 syncState.clearedAt(雲端全域墓碑)');
  assert.ok(inLocal.syncState.clearedAt > 0);
  assert.equal(inLocal.syncState.userId, 'user-1', '清除紀錄不等於登出，userId 不得被清掉');
  assert.equal(inCtx.doc.ids.toast.textContent, i18n.t('zh', 'opToastCleared'));

  const outCtx = makeController({ history: [s4Entry(URL_A, 2000)], syncState: signedOutState() });
  await outCtx.controller.init();
  await settle();
  outCtx.doc.ids.clearBtn.fire('click');
  outCtx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.deepEqual(outCtx.storage.localSnapshot().history, []);
  assert.equal(outCtx.storage.localSnapshot().syncState.clearedAt, null, '未登入不寫雲端水位線');
});

// S4:墓碑一律不進畫面。清單、筆數提示、統計磚(statTotal)、14 天圖表的
// bar-label 四處都必須看不到它——四處共用同一份 entries，漏掉任一處就會出
// 現「清單看不到、統計卻多一筆」的分岔。
test('S4 墓碑:清單/筆數提示/統計磚/14 天圖表一律不計入', async () => {
  const now = Date.now();
  const ctx = makeController({
    history: [
      s4Entry(URL_A, now - 1000),
      s4Entry(URL_B, now - 2000),
      s4Entry(URL_C, now - 3000, { deletedAt: now - 500, dirty: true }),
    ],
    syncState: signedInState(),
  });
  // 圖表的「今天」以真實時鐘為準，這裡把 now 對齊真實時間。
  const ctl = options.createOptionsController({
    document: ctx.doc,
    syncStorage: ctx.storage.sync,
    localStorage: ctx.storage.local,
    i18n,
    now: () => now,
  });

  await ctl.init();
  await settle();

  assert.equal(ctx.doc.ids.rows.children.length, 2, '墓碑不得渲染成卡片');
  assert.equal(ctx.doc.ids.countHint.textContent, '顯示 2 / 2 筆');
  assert.equal(ctx.doc.ids.statTotal.textContent, '2', '統計磚總數不計墓碑');
  const barLabels = ctx.doc.ids.chart.children
    .filter((c) => c.getAttribute('class') === 'bar-label')
    .map((c) => c.textContent);
  assert.deepEqual(barLabels, ['2'], '14 天圖表今天那一柱只算 2 筆(墓碑不計)');
});

// S4:匯出檔是使用者換裝置時的完整鏡像，但墓碑是「已刪除」的意思，匯出去
// 再匯回來等於讓刪掉的紀錄復活。
test('S4 墓碑:匯出 JSON 不輸出墓碑', async () => {
  const ctx = makeController({
    history: [s4Entry(URL_A, 2000), s4Entry(URL_B, 1000, { deletedAt: 1500, dirty: true })],
    syncState: signedInState(),
  });
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.exportBtn.fire('click');
  await settle();

  assert.equal(ctx.downloads.length, 1, '應觸發一次下載');
  const payload = JSON.parse(ctx.downloads[0].text);
  assert.deepEqual(payload.entries.map((e) => e.url), [URL_A], '墓碑不得出現在匯出檔');
});

// S4:sanitizeEntries 是 options 讀取端的信任邊界，也是 persistHistory 寫回
// 去的那份陣列的來源——它丟掉的欄位會在下一次刪除／匯入時被永久寫掉。新欄
// 位必須原樣保留，墓碑也必須留在陣列裡(只是不顯示)，否則使用者一按刪除，
// 整張表的 id 與待上傳的墓碑就全部消失。
test('S4 讀取:sanitizeEntries 保留七個新欄位，墓碑不得在讀取階段被丟棄', () => {
  const entry = s4Entry(URL_A, 1000, { id: 'keep-id', postKey: 'threads:AbC123_-xyz', dirty: true, serverUpdatedAt: 777 });
  const out = options.sanitizeEntries([entry]);
  assert.equal(out.length, 1);
  S4_NEW_FIELDS.forEach((f) => assert.equal(f in out[0], true, `讀取後遺失新欄位 ${f}`));
  assert.equal(out[0].id, 'keep-id');
  assert.equal(out[0].postKey, 'threads:AbC123_-xyz');
  assert.equal(out[0].dirty, true);
  assert.equal(out[0].serverUpdatedAt, 777);

  const tomb = options.sanitizeEntries([s4Entry(URL_B, 1000, { deletedAt: 1500 })]);
  assert.equal(tomb.length, 1, '墓碑是待上傳狀態，讀取階段不得丟棄(不顯示是渲染層的事)');
  assert.equal(tomb[0].deletedAt, 1500);
});

// S4:匯入舊格式(v1 匯出檔，沒有任何新欄位)時比照 S2 補齊。
test('S4 匯入:不含新欄位的舊格式補齊七個新欄位', () => {
  const result = options.mergeImportedEntries([], [{ url: URL_A, kind: 'icon', at: 900, seen: [{ at: 400, kind: 'share' }] }], 1000);
  assert.equal(result.merged.length, 1);
  const e = result.merged[0];
  S4_NEW_FIELDS.forEach((f) => assert.equal(f in e, true, `匯入後缺新欄位 ${f}`));
  assert.match(e.id, S4_UUID_V4);
  assert.equal(e.postKey, 'threads:AbC123_-xyz', 'postKey 由正規化後的 url 算出');
  assert.equal(e.original, URL_A, 'original 缺席時以 url 補');
  assert.equal(e.receivedAt, 400, 'receivedAt 取 seen 最早事件');
  assert.equal(e.dirty, true, '匯入進來的資料尚未上傳');
  assert.equal(e.serverUpdatedAt, null);
  assert.equal(e.deletedAt, null);
});

// S4:去重鍵改為 postKey(D11)。作者改名後同一篇貼文的乾淨網址不同、正規化
// 後仍不相等，舊的 url 去重會多開一張卡，雲端跟著分裂。
test('S4 匯入:去重以 postKey 為鍵——改名前後的同一篇貼文合併，不新增一筆', () => {
  const existing = [
    s4Entry(URL_A, 500, { id: 'keep-id', postKey: 'threads:AbC123_-xyz', seen: [{ at: 500, kind: 'share' }], serverUpdatedAt: 321 }),
  ];
  const renamed = 'https://www.threads.com/@renamed.user/post/AbC123_-xyz';
  const result = options.mergeImportedEntries(existing, [{ url: renamed, kind: 'icon', at: 900, seen: [{ at: 900, kind: 'icon' }] }], 1000);

  assert.equal(result.merged.length, 1, '同 postKey 應合併，不新增一筆');
  const e = result.merged[0];
  assert.equal(e.id, 'keep-id', 'id 沿用既有');
  assert.equal(e.postKey, 'threads:AbC123_-xyz');
  assert.equal(e.receivedAt, 500, 'receivedAt 取兩者最小');
  assert.equal(e.dirty, true, '合併後有本機變更待上傳');
  assert.equal(e.serverUpdatedAt, 321, 'serverUpdatedAt 沿用既有');
  assert.deepEqual(e.seen.map((s) => s.at), [500, 900], 'seen 取聯集並按時間排序');
});

// S4:同一批匯入檔內部若有同 postKey 的兩筆(改名前後各匯出過一次)，批內也
// 要先併起來，否則一次匯入就自己製造出兩張同文卡。
test('S4 匯入:同一批匯入內部的同 postKey 也合併成一張', () => {
  const result = options.mergeImportedEntries(
    [],
    [
      { url: URL_A, kind: 'share', at: 500, seen: [{ at: 500, kind: 'share' }] },
      { url: 'https://www.threads.com/@renamed.user/post/AbC123_-xyz', kind: 'icon', at: 900, seen: [{ at: 900, kind: 'icon' }] },
    ],
    1000
  );

  assert.equal(result.merged.length, 1, '批內同 postKey 應先合併');
  assert.equal(result.merged[0].receivedAt, 500);
  assert.deepEqual(result.merged[0].seen.map((s) => s.at), [500, 900]);
});

// S4:匯入檔帶新欄位(手機匯出／另一台裝置的完整鏡像)時沿用其 id，重新生成
// 等於在雲端把同一張卡拆成兩張。
test('S4 匯入:含新欄位的格式沿用檔案裡的 id，不重新生成', () => {
  const result = options.mergeImportedEntries(
    [],
    [
      {
        url: URL_A,
        kind: 'share',
        at: 900,
        seen: [{ at: 900, kind: 'share' }],
        id: 'from-file-0000-4000-8000-000000000000',
        original: 'https://www.threads.com/share/AbCdEfGhI',
        receivedAt: 900,
      },
    ],
    1000
  );

  assert.equal(result.merged[0].id, 'from-file-0000-4000-8000-000000000000');
  assert.equal(result.merged[0].original, 'https://www.threads.com/share/AbCdEfGhI', '檔案裡的 original 不被 url 覆蓋');
  assert.equal(result.merged[0].dirty, true, '別台裝置來的資料在本機仍是待上傳');
});

// ============================================================
// 頁首帳號入口(車道 B，消費 docs/cloud-sync.md 第 5 節的 state 形狀，
// displayName/avatarUrl 為車道 A 新增的兩欄，缺席視為 null)
//
// background 的同步引擎(車道 D)尚未實作，這裡的測試只驗證 options 端
// 消費介面的行為:未注入 runtime／runtime 回應非法/reject 都要優雅退回
// signed_out;五態(未登入/已登入/同步中/錯誤/登入過期)渲染正確;頭像
// 三層備援(avatarUrl→displayName 首字→email 首字)與 img onerror 退回;
// 選單開合/鍵盤/點外關閉;登入前先跳確認框且文案帶本機筆數(D3);刪除
// 雲端資料二次確認;stateChanged 廣播(由接線層轉呼叫 setSyncState)更新
// 畫面;寬度切換與 XSS 縱深。
// ============================================================

// 測試專用假 runtime:handlers 依 message.type 分派，未登記的 type 一律
// resolve(undefined)，模擬 background 尚無對應 handler 的現況。
function makeFakeRuntime(handlers) {
  const calls = [];
  return {
    calls,
    sendMessage(message) {
      calls.push(message);
      const handler = handlers && handlers[message.type];
      if (!handler) return Promise.resolve(undefined);
      return Promise.resolve(handler(message));
    },
  };
}

test('雲端同步:normalizeSyncCardState 對非法/形狀不對的輸入一律退回 DEFAULT_SYNC_CARD_STATE，displayName/avatarUrl 隨狀態一併正規化', () => {
  assert.deepEqual(options.normalizeSyncCardState(undefined), options.DEFAULT_SYNC_CARD_STATE);
  assert.deepEqual(options.normalizeSyncCardState(null), options.DEFAULT_SYNC_CARD_STATE);
  assert.deepEqual(options.normalizeSyncCardState({}), options.DEFAULT_SYNC_CARD_STATE, 'status 缺席不在白名單內');
  assert.deepEqual(options.normalizeSyncCardState({ status: 'bogus' }), options.DEFAULT_SYNC_CARD_STATE);
  assert.equal(options.DEFAULT_SYNC_CARD_STATE.displayName, null);
  assert.equal(options.DEFAULT_SYNC_CARD_STATE.avatarUrl, null);

  const normalized = options.normalizeSyncCardState({
    status: 'signed_in',
    email: 'a@b.com',
    displayName: 'Ada',
    avatarUrl: 'https://lh3.googleusercontent.com/a/x',
    lastSyncedAt: 123,
    pendingCount: 4,
    lastError: null,
    apiBase: 'https://api.example/',
  });
  assert.deepEqual(normalized, {
    status: 'signed_in',
    email: 'a@b.com',
    displayName: 'Ada',
    avatarUrl: 'https://lh3.googleusercontent.com/a/x',
    lastSyncedAt: 123,
    pendingCount: 4,
    lastError: null,
    apiBase: 'https://api.example/',
  });

  // 型別不對的 displayName/avatarUrl 個別退回 null，不整包丟棄其餘欄位
  // (比照既有欄位的容錯慣例)。
  const badFields = options.normalizeSyncCardState({ status: 'signed_in', displayName: 123, avatarUrl: {} });
  assert.equal(badFields.displayName, null);
  assert.equal(badFields.avatarUrl, null);
});

test('isTrustedAvatarUrl:只信任 https:// 且 host 以 googleusercontent.com 結尾的網址', () => {
  assert.equal(options.isTrustedAvatarUrl('https://lh3.googleusercontent.com/a/abc'), true);
  assert.equal(options.isTrustedAvatarUrl('https://googleusercontent.com/x'), true);
  assert.equal(options.isTrustedAvatarUrl('http://lh3.googleusercontent.com/a/abc'), false, '非 https 一律拒絕');
  assert.equal(options.isTrustedAvatarUrl('https://evil.com/?u=googleusercontent.com'), false);
  assert.equal(options.isTrustedAvatarUrl('https://notgoogleusercontent.com/a'), false, '結尾比對需含分隔點，不可子字串命中');
  assert.equal(options.isTrustedAvatarUrl('javascript:alert(1)'), false);
  assert.equal(options.isTrustedAvatarUrl(''), false);
  assert.equal(options.isTrustedAvatarUrl(null), false);
});

test('帳號入口:未注入 runtime 時渲染未登入態(登入鈕顯示、頭像觸發鈕隱藏)，deviceNote 維持既有文案', async () => {
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

  assert.equal(doc.ids.acctSignInBtn.hidden, false, '未登入態登入鈕應顯示');
  assert.equal(doc.ids.acctTrigger.hidden, true, '未登入態頭像觸發鈕應隱藏');
  assert.equal(doc.ids.deviceNote.textContent, i18n.t('zh', 'opDeviceNote'), '未登入時裝置提示文案不變');
});

test('帳號入口:background 無回應(sendMessage reject)時，退回未登入態渲染', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => Promise.reject(new Error('Could not establish connection.')),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.acctSignInBtn.hidden, false);
  assert.equal(doc.ids.acctTrigger.hidden, true);
});

test('帳號入口:已登入時渲染頭像字母/名字/email/上次同步(相對時間)·待上傳筆數，狀態點為綠色，deviceNote 換成已同步文案', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const NOW = 1000000;
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: 'Hong',
      avatarUrl: null,
      lastSyncedAt: NOW - 5 * 60 * 1000, // 5 分鐘前
      pendingCount: 3,
      lastError: null,
      apiBase: 'https://api.example/',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => NOW,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.acctSignInBtn.hidden, true);
  assert.equal(doc.ids.acctTrigger.hidden, false);
  assert.equal(doc.ids.acctHeaderName.textContent, 'Hong');
  assert.equal(doc.ids.avatarLetter.textContent, 'H', '頭像備援首字取自 displayName');
  assert.equal(doc.ids.avatarPhoto.hidden, true, '無 avatarUrl 時不顯示 img');
  assert.equal(doc.ids.acctMenuName.textContent, 'Hong');
  assert.equal(doc.ids.acctMenuEmail.textContent, 'user@example.com');
  assert.equal(
    doc.ids.acctMenuSub.textContent,
    i18n.fmt('zh', 'opAccountLastSync', { t: i18n.fmt('zh', 'opRelMin', { n: 5 }) }) +
      ' · ' +
      i18n.fmt('zh', 'opAccountPending', { n: 3 }),
    '選單灰字一行含上次同步時間與待上傳筆數'
  );
  assert.equal(doc.ids.statusDot.hidden, false);
  assert.equal(doc.ids.statusDot.classList.contains('is-danger'), false);
  assert.equal(doc.ids.statusDot.classList.contains('is-warning'), false);
  assert.equal(doc.ids.deviceNote.textContent, i18n.t('zh', 'opDeviceNoteSynced'));
  // 狀態文字併進觸發鈕自身的 aria-label(不掛在巢狀 statusDot 上，讀屏器
  // 讀不到——見 options.js 的 renderAccount)。
  assert.equal(
    doc.ids.acctTrigger.getAttribute('aria-label'),
    i18n.fmt('zh', 'opAccountMenuLabelStatus', { label: i18n.t('zh', 'opAccountMenuLabel'), status: i18n.t('zh', 'opAccountStatusSynced') })
  );
});

test('帳號入口:頭像備援三層——avatarUrl 缺席時退回 displayName 首字，displayName 也缺席時退回 email 首字', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'nina@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.avatarLetter.textContent, 'N', 'displayName 缺席時退回 email 首字(大寫)');
  assert.equal(doc.ids.acctHeaderName.textContent, 'nina', '名字缺席時退回 email 的 @ 前段');
  assert.equal(doc.ids.acctMenuName.textContent, 'nina');
});

test('帳號入口:avatarUrl 通過白名單時顯示大頭照 img，字母備援隱藏；不通過(非 https/host 不符)時仍走字母備援', async () => {
  async function renderWith(avatarUrl) {
    const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
    const doc = makeDocumentStub();
    const runtime = makeFakeRuntime({
      'sync.getState': () => ({
        status: 'signed_in',
        email: 'user@example.com',
        displayName: 'Hong',
        avatarUrl,
        lastSyncedAt: null,
        pendingCount: 0,
        lastError: null,
        apiBase: '',
      }),
    });
    const controller = options.createOptionsController({
      document: doc,
      syncStorage: storage.sync,
      localStorage: storage.local,
      i18n,
      now: () => 100000,
      runtime,
    });
    await controller.init();
    await settle();
    return doc;
  }

  const trusted = await renderWith('https://lh3.googleusercontent.com/a/abc123');
  assert.equal(trusted.ids.avatarPhoto.hidden, false);
  assert.equal(trusted.ids.avatarPhoto.src, 'https://lh3.googleusercontent.com/a/abc123');
  assert.equal(trusted.ids.avatarLetter.hidden, true);
  assert.equal(trusted.ids.avatarCircle.classList.contains('has-photo'), true);

  const untrusted = await renderWith('http://lh3.googleusercontent.com/a/abc123');
  assert.equal(untrusted.ids.avatarPhoto.hidden, true, '非 https 不得設進 img.src');
  assert.equal(untrusted.ids.avatarLetter.hidden, false);
  assert.equal(untrusted.ids.avatarCircle.classList.contains('has-photo'), false);
});

test('帳號入口:大頭照 img 載入失敗(onerror)時退回字母備援，不留破圖', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: 'Hong',
      avatarUrl: 'https://lh3.googleusercontent.com/a/dead-link',
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();
  assert.equal(doc.ids.avatarPhoto.hidden, false, '前置:應先嘗試顯示大頭照');

  doc.ids.avatarPhoto.onerror();

  assert.equal(doc.ids.avatarPhoto.hidden, true);
  assert.equal(doc.ids.avatarLetter.hidden, false);
  assert.equal(doc.ids.avatarLetter.textContent, 'H');
  assert.equal(doc.ids.avatarCircle.classList.contains('has-photo'), false);
});

test('帳號入口:登出後兩顆大頭照 img(頁首/選單)的 src 都清空，不殘留上一個帳號的照片(真機實證回歸)', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: 'Hong',
      avatarUrl: 'https://lh3.googleusercontent.com/a/abc123',
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.avatarPhoto.src, 'https://lh3.googleusercontent.com/a/abc123', '前置:已登入應先顯示大頭照');
  assert.equal(doc.ids.acctMenuAvatarPhoto.src, 'https://lh3.googleusercontent.com/a/abc123');

  controller.setSyncState({
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  });

  assert.equal(doc.ids.avatarPhoto.src, '', '登出後頁首觸發鈕的大頭照 img 不應殘留 src');
  assert.equal(doc.ids.avatarPhoto.getAttribute('src'), null);
  assert.equal(doc.ids.avatarPhoto.hidden, true);
  assert.equal(doc.ids.acctMenuAvatarPhoto.src, '', '登出後選單頂部的大頭照 img 不應殘留 src');
  assert.equal(doc.ids.acctMenuAvatarPhoto.getAttribute('src'), null);
  assert.equal(doc.ids.acctMenuAvatarPhoto.hidden, true);
  assert.equal(doc.ids.avatarCircle.classList.contains('has-photo'), false);
  assert.equal(doc.ids.acctMenuAvatarCircle.classList.contains('has-photo'), false);
});

test('帳號入口:登入鈕先跳確認框，文案帶本機現有筆數(D3)，確認後才送 sync.signIn', async () => {
  const history = [
    { url: CARD_URL_A, kind: 'share', at: 1000 },
    { url: CARD_URL_B, kind: 'share', at: 2000 },
    { url: CARD_URL_NET, kind: 'share', at: 3000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  doc.ids.acctSignInBtn.fire('click');
  assert.equal(doc.ids.confirmOverlay.hidden, false, '登入前應先跳確認框');
  assert.equal(
    doc.ids.confirmDesc.textContent,
    i18n.fmt('zh', 'opSyncSignInConfirmDesc', { n: 3 }),
    '確認框文案應帶本機現有筆數'
  );

  const callsBefore = runtime.calls.length;
  doc.ids.confirmOk.fire('click');
  assert.equal(doc.ids.confirmOverlay.hidden, true, '確認後應關閉確認框');
  assert.equal(runtime.calls.length, callsBefore + 1);
  assert.deepEqual(runtime.calls[runtime.calls.length - 1], { type: 'sync.signIn' });
});

test('帳號入口:登入確認框不是破壞性操作，不該長得像刪除(回歸:曾經 OK 鈕與圖示寫死垃圾桶/紅色，登入跟刪除長一樣)', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  doc.ids.acctSignInBtn.fire('click');
  assert.equal(doc.ids.confirmOk.classList.contains('btn-danger-solid'), false, 'OK 鈕不該是破壞性紅色實心鈕');
  assert.equal(doc.ids.confirmOk.classList.contains('btn-primary'), true, 'OK 鈕應改為品牌色實心鈕');
  assert.notEqual(doc.ids.confirmIconUse.getAttribute('href'), '#i-trash', '標題圖示不該是垃圾桶');
  assert.equal(doc.ids.confirmIcon.classList.contains('danger-ink'), false, '標題圖示不該是危險紅');

  // 「清除全部」等既有的破壞性操作要維持原本外觀不變。
  doc.ids.confirmCancel.fire('click');
  doc.ids.clearBtn.fire('click');
  assert.equal(doc.ids.confirmOk.classList.contains('btn-danger-solid'), true, '清除全部應維持紅色實心鈕');
  assert.equal(doc.ids.confirmOk.classList.contains('btn-primary'), false);
  assert.equal(doc.ids.confirmIconUse.getAttribute('href'), '#i-trash', '清除全部應維持垃圾桶圖示');
  assert.equal(doc.ids.confirmIcon.classList.contains('danger-ink'), true);
});

test('帳號入口:取消登入確認框不送出 sync.signIn', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  doc.ids.acctSignInBtn.fire('click');
  doc.ids.confirmCancel.fire('click');

  assert.equal(doc.ids.confirmOverlay.hidden, true);
  assert.ok(
    runtime.calls.every((c) => c.type !== 'sync.signIn'),
    '取消後不應送出 sync.signIn'
  );
});

test('帳號入口:刪除雲端資料先跳二次確認框(講清楚無法復原/本機保留/這些紀錄不會再上傳)，確認後才送 sync.deleteCloud 並顯示已刪除 toast', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.match(doc.ids.acctMenuSub.textContent, /尚未同步/, '從未同步時 {t} 顯示對應文案');

  doc.ids.acctDeleteBtn.fire('click');
  assert.equal(doc.ids.confirmOverlay.hidden, false);
  const desc = doc.ids.confirmDesc.textContent;
  assert.equal(desc, i18n.t('zh', 'opSyncDeleteConfirmDesc'));
  assert.match(desc, /無法復原/);
  assert.match(desc, /這台裝置上的紀錄不受影響/);
  // 語意修正(伺服器對早於 cleared_at 的紀錄一律拒收，api-spec 4.4):刪除
  // 雲端後本機紀錄不會再自動上傳，舊文案「下次登入時會再次上傳」與後端
  // 實際行為矛盾。
  assert.match(desc, /不會再上傳到雲端/);

  const callsBefore = runtime.calls.length;
  doc.ids.confirmOk.fire('click');
  assert.equal(runtime.calls.length, callsBefore + 1);
  assert.deepEqual(runtime.calls[runtime.calls.length - 1], { type: 'sync.deleteCloud' });
  // deleteCloud 是 fire-and-forget，送出當下先樂觀顯示已完成的 toast。
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastCloudDeleted'));
});

test('帳號入口:刪除雲端資料送出後，下一次 stateChanged 若帶回 lastError，樂觀 toast 被改成錯誤 toast', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  doc.ids.acctDeleteBtn.fire('click');
  doc.ids.confirmOk.fire('click');
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastCloudDeleted'), '送出當下先樂觀顯示已完成');

  // 接線層轉呼叫的下一次廣播帶回失敗:樂觀 toast 該被蓋成錯誤訊息，
  // 不能讓使用者以為刪除已成功。
  controller.setSyncState({
    status: 'signed_in',
    email: 'user@example.com',
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: 'internal_error',
    apiBase: '',
  });
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opAccountErrorPrefix') + 'internal_error');
});

test('帳號入口:刪除雲端資料送出後，下一次 stateChanged 沒有 lastError 時，不覆蓋樂觀 toast', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  doc.ids.acctDeleteBtn.fire('click');
  doc.ids.confirmOk.fire('click');
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastCloudDeleted'));

  controller.setSyncState({
    status: 'signed_in',
    email: 'user@example.com',
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: 100,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  });
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opToastCloudDeleted'), '成功時樂觀 toast 維持原樣，不被覆蓋');

  // 再下一次廣播不該重複觸發旗標(pendingDeleteCloudToast 只消費一次)。
  controller.setSyncState({
    status: 'signed_in',
    email: 'user@example.com',
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: 200,
    pendingCount: 0,
    lastError: 'rate_limited',
    apiBase: '',
  });
  assert.equal(
    doc.ids.toast.textContent,
    i18n.t('zh', 'opToastCloudDeleted'),
    '旗標只消費一次，往後的 lastError 不再誤蓋刪除 toast'
  );
});

test('帳號入口:立即同步/登出從選單點下去直接送出對應訊息，不經確認框，且會關閉選單', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: 100,
      pendingCount: 1,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  doc.ids.acctTrigger.fire('click');
  assert.equal(doc.ids.acctMenu.hidden, false, '前置:選單應已開啟');

  // 立即同步/登出點下去直接送出訊息(不像登入/刪除雲端資料要先經
  // openConfirm)，這裡驗證的是「點擊後訊息立即出現在 calls 裡，不需要
  // 額外去點某個確認鈕才送出」，且點擊後會收合選單。
  const callsBefore = runtime.calls.length;
  doc.ids.acctSyncNowBtn.fire('click');
  assert.equal(runtime.calls.length, callsBefore + 1, '點擊應立即送出一則訊息，不待額外確認動作');
  assert.deepEqual(runtime.calls[runtime.calls.length - 1], { type: 'sync.now' });
  await settle();
  assert.equal(doc.ids.acctMenu.hidden, true, '動作後應收合選單');

  doc.ids.acctTrigger.fire('click');
  doc.ids.acctSignOutBtn.fire('click');
  assert.equal(runtime.calls.length, callsBefore + 2);
  assert.deepEqual(runtime.calls[runtime.calls.length - 1], { type: 'sync.signOut' });
});

test('帳號入口:status 為 syncing 時頭像外圈轉圈、狀態點隱藏，立即同步鈕 disabled 且文字換成同步中，登出/刪除鈕維持可點', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'syncing',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 2,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.avatarWrap.classList.contains('is-syncing'), true);
  assert.equal(doc.ids.statusDot.hidden, true, '同步中不疊角標小圓點');
  assert.equal(doc.ids.acctSyncNowBtn.disabled, true);
  assert.equal(doc.ids.acctSyncLabel.textContent, i18n.t('zh', 'opAccountSyncing'));
  assert.notEqual(doc.ids.acctSignOutBtn.disabled, true, '登出鈕不因同步中停用');
  assert.notEqual(doc.ids.acctDeleteBtn.disabled, true, '刪除雲端資料鈕不因同步中停用');
  // 同步中沒有對應的狀態文字(不疊角標小圓點)，觸發鈕 aria-label 維持
  // 不帶狀態的基本文字，不併「同步中」進去。
  assert.equal(doc.ids.acctTrigger.getAttribute('aria-label'), i18n.t('zh', 'opAccountMenuLabel'));
});

test('帳號入口:status 為 error 時選單顯示 lastError 一行(含前綴)與重試鈕，狀態點為紅色，重試會送 sync.now', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'error',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: 100,
      pendingCount: 2,
      lastError: 'rate_limited',
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.statusDot.classList.contains('is-danger'), true);
  assert.equal(doc.ids.acctErrorRow.hidden, false);
  assert.equal(doc.ids.acctErrorText.textContent, i18n.t('zh', 'opAccountErrorPrefix') + 'rate_limited');
  assert.equal(doc.ids.acctSyncNowBtn.disabled, false, '錯誤態的一般同步鈕不因此停用');
  assert.equal(
    doc.ids.acctSyncLabel.textContent,
    i18n.t('zh', 'opAccountRetry'),
    '錯誤態選單裡的「立即同步」項目文字比照 demo 改為「重試」'
  );
  assert.equal(
    doc.ids.acctTrigger.getAttribute('aria-label'),
    i18n.fmt('zh', 'opAccountMenuLabelStatus', { label: i18n.t('zh', 'opAccountMenuLabel'), status: i18n.t('zh', 'opAccountStatusError') })
  );

  doc.ids.acctTrigger.fire('click');
  const callsBefore = runtime.calls.length;
  doc.ids.acctRetryBtn.fire('click');
  assert.equal(runtime.calls.length, callsBefore + 1);
  assert.deepEqual(runtime.calls[runtime.calls.length - 1], { type: 'sync.now' });
});

test('帳號入口:登入過期(signed_out + lastError=session_expired 且有 email/displayName)時顯示黃色狀態點與重新登入列，同步鈕停用', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  controller.setSyncState({
    status: 'signed_out',
    email: 'hong@example.com',
    displayName: 'Hong',
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: 'session_expired',
    apiBase: '',
  });

  assert.equal(doc.ids.acctSignInBtn.hidden, true, '有足夠身分資訊時應顯示頭像觸發鈕而非登入鈕');
  assert.equal(doc.ids.acctTrigger.hidden, false);
  assert.equal(doc.ids.statusDot.classList.contains('is-warning'), true);
  assert.equal(doc.ids.acctExpiredRow.hidden, false);
  assert.equal(doc.ids.acctExpiredText.textContent, i18n.t('zh', 'opAccountExpired'));
  assert.equal(doc.ids.acctSyncNowBtn.disabled, true, '過期時應停用立即同步，逼使用者重新登入');
  assert.equal(doc.ids.deviceNote.textContent, i18n.t('zh', 'opDeviceNote'), '過期時同步實質未在跑，不謊報已同步');

  const callsBefore = runtime.calls.length;
  doc.ids.acctTrigger.fire('click');
  doc.ids.acctReSignInBtn.fire('click');
  assert.equal(doc.ids.confirmOverlay.hidden, false, '重新登入應走完整登入確認框流程');
  doc.ids.confirmOk.fire('click');
  assert.ok(runtime.calls.slice(callsBefore).some((c) => c.type === 'sync.signIn'));
});

test('帳號入口:從登入過期切到真正登出時，狀態點/錯誤過期列/姓名信箱等節點全部重設乾淨(回歸:曾提早 return，殘留上一態內容)', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  // 先進入登入過期態(status: signed_out + session_expired + 有身分資訊)，
  // 讓狀態點變黃、過期列顯示、姓名信箱等節點都填上內容。
  controller.setSyncState({
    status: 'signed_out',
    email: 'hong@example.com',
    displayName: 'Hong',
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: 'session_expired',
    apiBase: '',
  });
  assert.equal(doc.ids.statusDot.classList.contains('is-warning'), true, '前置條件:過期態應先是黃色狀態點');
  assert.equal(doc.ids.acctExpiredRow.hidden, false, '前置條件:過期列應先顯示');
  assert.equal(doc.ids.acctHeaderName.textContent, 'Hong', '前置條件:姓名應先被填入');
  assert.equal(doc.ids.acctMenuEmail.textContent, 'hong@example.com', '前置條件:信箱應先被填入');
  assert.equal(
    doc.ids.acctTrigger.getAttribute('aria-label'),
    i18n.fmt('zh', 'opAccountMenuLabelStatus', { label: i18n.t('zh', 'opAccountMenuLabel'), status: i18n.t('zh', 'opAccountStatusExpired') }),
    '前置條件:觸發鈕 aria-label 應先併上過期狀態文字'
  );

  // 再切到真正登出(沒有 email/displayName，lastError 也清空)。
  controller.setSyncState({
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  });

  assert.equal(doc.ids.acctSignInBtn.hidden, false, '真正登出應顯示登入鈕');
  assert.equal(doc.ids.acctTrigger.hidden, true);
  assert.equal(doc.ids.statusDot.classList.contains('is-warning'), false, '登出後狀態點不應殘留過期的黃色');
  assert.equal(doc.ids.statusDot.classList.contains('is-danger'), false, '登出後狀態點不應殘留錯誤的紅色');
  assert.equal(doc.ids.statusDot.hidden, true);
  // 規格翻轉:狀態文字不再掛在巢狀 statusDot 上(讀屏器讀不到，見
  // renderAccount 的 aria-label 註解)，改併進觸發鈕自身的 aria-label；
  // 登出後應重設回不帶狀態的基本文字，不殘留過期/錯誤字樣。
  assert.equal(
    doc.ids.acctTrigger.getAttribute('aria-label'),
    i18n.t('zh', 'opAccountMenuLabel'),
    '登出後觸發鈕 aria-label 應重設回基本文字，不殘留過期/錯誤狀態'
  );
  assert.equal(doc.ids.acctErrorRow.hidden, true);
  assert.equal(doc.ids.acctExpiredRow.hidden, true, '登出後過期列應重新隱藏');
  assert.equal(doc.ids.acctHeaderName.textContent, '', '登出後姓名不應殘留上一態的內容');
  assert.equal(doc.ids.acctMenuName.textContent, '');
  assert.equal(doc.ids.acctMenuEmail.textContent, '', '登出後信箱不應殘留上一態的內容');
  assert.equal(doc.ids.acctMenuSub.textContent, '');
});

test('帳號入口:登入過期但沒有 email/displayName 可辨識時，退回未登入外觀', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
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

  controller.setSyncState({
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: 'session_expired',
    apiBase: '',
  });

  assert.equal(doc.ids.acctSignInBtn.hidden, false, '資訊不足以分辨登入過期時應退回未登入外觀');
  assert.equal(doc.ids.acctTrigger.hidden, true);
});

test('帳號入口:setSyncState(接線層轉呼叫 background 的 sync.stateChanged 廣播)即時更新畫面', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
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
  assert.equal(doc.ids.acctSignInBtn.hidden, false, '前置:未注入 runtime，預設未登入');

  controller.setSyncState({
    status: 'signed_in',
    email: 'broadcast@example.com',
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: '',
  });

  assert.equal(doc.ids.acctSignInBtn.hidden, true);
  assert.equal(doc.ids.acctTrigger.hidden, false);
  assert.equal(doc.ids.acctMenuEmail.textContent, 'broadcast@example.com');

  // 廣播非法形狀時應退回 signed_out，不因 background 傳壞資料而炸掉畫面。
  controller.setSyncState({ status: 'nonsense' });
  assert.equal(doc.ids.acctSignInBtn.hidden, false);
  assert.equal(doc.ids.acctTrigger.hidden, true);
});

test('帳號入口:XSS 縱深——email 含 <img onerror> 字串只當純文字顯示，不解析成節點', async () => {
  const evilEmail = '<img src=x onerror=alert(1)>@evil.example';
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: evilEmail,
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.acctMenuEmail.textContent, evilEmail, '整串只當文字內容，不被拆解');
  assert.equal(doc.ids.acctMenuEmail.children.length, 0, '未曾組出子節點，證明走的是 textContent 不是 innerHTML');
  assert.equal(
    doc.ids.acctHeaderName.textContent,
    '<img src=x onerror=alert(1)>',
    'displayName 缺席時退回的 email @ 前段同樣只當文字(local part 本身就含這串)'
  );
  assert.equal(doc.ids.acctHeaderName.children.length, 0);
});

// ============================================================
// 環境標籤——頁首標題(envBadge)與「紀錄」卡頭(envBadgeHistory)各一顆,
// 由 renderEnvBadge 逐一套用同一份判斷結果,只認 staging/local 兩個
// 白名單 apiBase 值,顯示固定英文小寫;其餘(含正式環境、未知值、
// background 無回應)一律隱藏,且不把 apiBase 原始值印進 DOM。狀態來源
// 同帳號卡片的 state.apiBase,但跟登入態無關——未登入也要顯示。以下
// 測試以 envBadge 為主要斷言對象,並在每個情境額外驗證 envBadgeHistory
// 與其同步,不重複展開成兩倍測試數。
// ============================================================

test('環境標籤:apiBase 為 staging 時顯示 staging chip,套 env-badge-staging 樣式,未登入也顯示', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_out',
      email: null,
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: 'https://api-staging.metalinkclearer.workers.dev',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.acctSignInBtn.hidden, false, '前置:確實是未登入態');
  assert.equal(doc.ids.envBadge.hidden, false, '未登入也要顯示,跟登入態無關');
  assert.equal(doc.ids.envBadge.textContent, 'staging');
  assert.equal(doc.ids.envBadge.classList.contains('env-badge-staging'), true);
  assert.equal(doc.ids.envBadge.classList.contains('env-badge-local'), false);
  // 「紀錄」卡頭旁那顆(envBadgeHistory)跟頁首標題旁那顆同步,見
  // options.js 的 ENV_BADGE_IDS/renderEnvBadge。
  assert.equal(doc.ids.envBadgeHistory.hidden, false);
  assert.equal(doc.ids.envBadgeHistory.textContent, 'staging');
  assert.equal(doc.ids.envBadgeHistory.classList.contains('env-badge-staging'), true);
});

test('環境標籤:apiBase 為 local 時顯示 local chip,套 env-badge-local 樣式', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: 'http://localhost:8787',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.envBadge.hidden, false);
  assert.equal(doc.ids.envBadge.textContent, 'local');
  assert.equal(doc.ids.envBadge.classList.contains('env-badge-local'), true);
  assert.equal(doc.ids.envBadge.classList.contains('env-badge-staging'), false);
  assert.equal(doc.ids.envBadgeHistory.hidden, false, '兩顆環境標籤同步');
  assert.equal(doc.ids.envBadgeHistory.textContent, 'local');
  assert.equal(doc.ids.envBadgeHistory.classList.contains('env-badge-local'), true);
});

test('環境標籤:apiBase 為正式環境或非白名單值一律隱藏,不把原始字串印進 DOM(XSS 縱深)', async () => {
  async function renderWith(apiBase) {
    const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
    const doc = makeDocumentStub();
    const runtime = makeFakeRuntime({
      'sync.getState': () => ({
        status: 'signed_out',
        email: null,
        displayName: null,
        avatarUrl: null,
        lastSyncedAt: null,
        pendingCount: 0,
        lastError: null,
        apiBase,
      }),
    });
    const controller = options.createOptionsController({
      document: doc,
      syncStorage: storage.sync,
      localStorage: storage.local,
      i18n,
      now: () => 100000,
      runtime,
    });
    await controller.init();
    await settle();
    return doc;
  }

  const prod = await renderWith('https://api.metalinkclearer.workers.dev');
  assert.equal(prod.ids.envBadge.hidden, true, '正式環境不顯示標籤');
  assert.equal(prod.ids.envBadge.textContent, '');
  assert.equal(prod.ids.envBadgeHistory.hidden, true, '兩顆環境標籤同步隱藏');
  assert.equal(prod.ids.envBadgeHistory.textContent, '');

  const evil = '<img src=x onerror=alert(1)>';
  const xss = await renderWith(evil);
  assert.equal(xss.ids.envBadge.hidden, true, '不在白名單內一律隱藏');
  assert.equal(xss.ids.envBadge.textContent, '', '不把非白名單 apiBase 原始值印進 DOM,只印固定字串');
  assert.equal(xss.ids.envBadgeHistory.hidden, true);
  assert.equal(xss.ids.envBadgeHistory.textContent, '');
});

test('環境標籤:background 無回應(sendMessage reject)時隱藏', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => Promise.reject(new Error('Could not establish connection.')),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.envBadge.hidden, true);
  assert.equal(doc.ids.envBadgeHistory.hidden, true, '兩顆環境標籤同步隱藏');
});

test('環境標籤:setSyncState(stateChanged 廣播)即時切換 staging → local → 正式環境隱藏,舊 modifier class 會被清掉', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
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
  assert.equal(doc.ids.envBadge.hidden, true, '前置:未注入 runtime,退回值 apiBase 空字串應隱藏');
  assert.equal(doc.ids.envBadgeHistory.hidden, true);

  controller.setSyncState({
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: 'https://api-staging.metalinkclearer.workers.dev',
  });
  assert.equal(doc.ids.envBadge.hidden, false);
  assert.equal(doc.ids.envBadge.textContent, 'staging');
  assert.equal(doc.ids.envBadgeHistory.hidden, false, '兩顆環境標籤同步顯示');
  assert.equal(doc.ids.envBadgeHistory.textContent, 'staging');

  controller.setSyncState({
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: 'http://localhost:8787',
  });
  assert.equal(doc.ids.envBadge.hidden, false);
  assert.equal(doc.ids.envBadge.textContent, 'local');
  assert.equal(doc.ids.envBadge.classList.contains('env-badge-staging'), false, '切換環境時舊的 modifier class 要清掉');
  assert.equal(doc.ids.envBadgeHistory.hidden, false);
  assert.equal(doc.ids.envBadgeHistory.textContent, 'local');
  assert.equal(doc.ids.envBadgeHistory.classList.contains('env-badge-staging'), false);

  controller.setSyncState({
    status: 'signed_out',
    email: null,
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: null,
    apiBase: 'https://api.metalinkclearer.workers.dev',
  });
  assert.equal(doc.ids.envBadge.hidden, true);
  assert.equal(doc.ids.envBadge.classList.contains('env-badge-local'), false);
  assert.equal(doc.ids.envBadgeHistory.hidden, true, '兩顆環境標籤同步隱藏');
  assert.equal(doc.ids.envBadgeHistory.classList.contains('env-badge-local'), false);
});

test('帳號入口:寬度切換——options.html 在 720px 斷點以 CSS 隱藏名字文字(不靠 JS 判斷寬度)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(
    html,
    /@media \(max-width:\s*720px\)\s*\{[^}]*\.acc-name\s*\{[^}]*display:\s*none/,
    '寬度斷點應以 CSS 隱藏 .acc-name，不需要 JS 讀取 window 寬度即可測'
  );
});

// WCAG 相對亮度/對比度計算，僅供下面的 --warn 對比測試使用(不是產品
// 程式碼，測試自己算一份夠了，不需要另立共用模組)。公式抄 WCAG 2.x
// 定義:先把 sRGB 通道線性化，再用固定權重加總得相對亮度，最後取兩色
// 亮度較高/較低者相除。
function relLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(hexA, hexB) {
  const [la, lb] = [relLuminance(hexA), relLuminance(hexB)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

test('色票對比:淺色 --warn 對 --surface 至少 3:1(WCAG 非文字元素門檻，狀態點/提示列都是純色塊，沒有文字襯托)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const rootBlock = html.slice(html.indexOf(':root {'), html.indexOf('@media (prefers-color-scheme: dark)'));
  const warnMatch = /--warn:\s*(#[0-9a-fA-F]{6})/.exec(rootBlock);
  const surfaceMatch = /--surface:\s*(#[0-9a-fA-F]{6})/.exec(rootBlock);
  assert.ok(warnMatch && surfaceMatch, '淺色 :root 區塊應同時定義 --warn 與 --surface');
  const ratio = contrastRatio(warnMatch[1], surfaceMatch[1]);
  assert.ok(ratio >= 3, `淺色 --warn(${warnMatch[1]}) 對 --surface(${surfaceMatch[1]}) 的對比度應 ≥ 3:1，實測 ${ratio.toFixed(2)}:1`);
});

test('色票定義:--warn 在三處色票區塊(淺色 :root/深色媒體查詢/data-theme=dark)都要定義，缺一處就會有某個主題下讀到未定義變數', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const matches = html.match(/--warn:\s*#[0-9a-fA-F]{6};/g) || [];
  assert.equal(matches.length, 3, '--warn 應恰好在三處色票區塊各出現一次(淺色/深色媒體查詢/data-theme=dark)');
});

test('.acct-warn-row 語意色改用 --warn(登入過期是黃色第三態，不該跟 --accent 共用變數)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(html, /\.acct-warn-row\s*\{[^}]*background:\s*var\(--warn-soft\)[^}]*color:\s*var\(--warn\)/);
  assert.match(html, /\.acct-warn-row \.link-btn\s*\{[^}]*color:\s*var\(--warn\)/);
});

test('同步轉圈尊重 prefers-reduced-motion:.avatar-wrap.is-syncing::after 的 animation 只在 no-preference 媒體查詢內生效，reduce 時顯示靜態外圈', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const baseRuleMatch = /\.avatar-wrap\.is-syncing::after\s*\{([^}]*)\}/.exec(html);
  assert.ok(baseRuleMatch, '應有 .avatar-wrap.is-syncing::after 的基本規則(靜態外圈)');
  assert.doesNotMatch(baseRuleMatch[1], /animation/, '基本規則不該直接帶 animation，否則 reduce 時仍會轉動');
  assert.match(
    html,
    /@media \(prefers-reduced-motion:\s*no-preference\)\s*\{[^}]*\.avatar-wrap\.is-syncing::after\s*\{[^}]*animation:\s*acct-spin/,
    'animation 應收進 prefers-reduced-motion:no-preference 媒體查詢內'
  );
});

test('.avatar-circle.has-photo 底色透明(回歸:曾經是死類——JS 有 toggle 但 CSS 沒有對應規則)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(html, /\.avatar-circle\.has-photo\s*\{[^}]*background:\s*transparent/);
});

test('menu-item:disabled 有停用樣式(回歸:曾經完全沒有 :disabled 規則，同步中的 acctSyncNowBtn 看起來跟平常一樣可點)', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(
    html,
    /\.menu-item:disabled\s*\{[^}]*opacity:\s*0(\.\d+)?[^}]*cursor:\s*not-allowed/,
    '.menu-item:disabled 應同時降低透明度並改成禁用游標'
  );
  assert.match(
    html,
    /\.menu-item:disabled:hover\s*\{[^}]*background:\s*none/,
    '停用時 hover 不應換底色，否則看起來還能點'
  );
});

// ============================================================
// 帳號選單開合/鍵盤(車道 B):觸發鈕點擊切換 [hidden]、aria-expanded；
// 點選單以外的地方與 Esc 會關閉；方向鍵在可用項目間移動焦點。
// ============================================================

function makeMenuCtx() {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_in',
      email: 'user@example.com',
      displayName: 'Hong',
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });
  return { storage, doc, runtime, controller };
}

test('帳號選單:點觸發鈕開啟(hidden 移除、aria-expanded=true)，再點一次關閉(aria-expanded=false，延遲後 hidden)', async () => {
  const ctx = makeMenuCtx();
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctTrigger.fire('click');
  assert.equal(ctx.doc.ids.acctMenu.hidden, false);
  assert.equal(ctx.doc.ids.acctTrigger.getAttribute('aria-expanded'), 'true');

  ctx.doc.ids.acctTrigger.fire('click');
  assert.equal(ctx.doc.ids.acctTrigger.getAttribute('aria-expanded'), 'false', '關閉是同步發生的，不等動畫');
  await settle();
  assert.equal(ctx.doc.ids.acctMenu.hidden, true, '動畫延遲後才真的補上 hidden');
});

test('帳號選單:點選單以外的地方會關閉選單', async () => {
  const ctx = makeMenuCtx();
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctTrigger.fire('click');
  assert.equal(ctx.doc.ids.acctMenu.hidden, false);

  // rows(紀錄卡片牆容器)與帳號區完全無關，代表「點在選單以外」。
  ctx.doc.fire('click', { target: ctx.doc.getElementById('rows') });
  await settle();
  assert.equal(ctx.doc.ids.acctMenu.hidden, true);
});

test('帳號選單:Esc 關閉選單', async () => {
  const ctx = makeMenuCtx();
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctTrigger.fire('click');
  assert.equal(ctx.doc.ids.acctMenu.hidden, false);

  ctx.doc.fire('keydown', { key: 'Escape' });
  await settle();
  assert.equal(ctx.doc.ids.acctMenu.hidden, true);
});

test('帳號選單:開啟時焦點進第一個可用項目，方向鍵在項目間移動', async () => {
  const ctx = makeMenuCtx();
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctTrigger.fire('click');
  // 已登入/非錯誤/非過期態下，第一個可用項目是「立即同步」。
  assert.equal(ctx.doc.activeElement, ctx.doc.ids.acctSyncNowBtn, '開啟時焦點應落在第一個可用項目');

  ctx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(ctx.doc.activeElement, ctx.doc.ids.acctSignOutBtn, 'ArrowDown 移到下一項');

  ctx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(ctx.doc.activeElement, ctx.doc.ids.acctDeleteBtn);

  ctx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(ctx.doc.activeElement, ctx.doc.ids.acctSyncNowBtn, '到底後循環回第一項');

  ctx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(ctx.doc.activeElement, ctx.doc.ids.acctDeleteBtn, 'ArrowUp 從第一項循環到最後一項');
});

function makeMenuCtxWithState(state) {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({ 'sync.getState': () => state });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });
  return { storage, doc, runtime, controller };
}

test('帳號選單:syncing／expired 態下「立即同步」停用，方向鍵導覽應跳過它，不落焦點也不循環經過', async () => {
  // syncing:可用項目只剩登出/刪除雲端資料兩顆，開啟時第一個可用項目
  // 應直接是登出(略過停用的立即同步)。
  const syncingCtx = makeMenuCtxWithState({
    status: 'syncing',
    email: 'user@example.com',
    displayName: 'Hong',
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 2,
    lastError: null,
    apiBase: '',
  });
  await syncingCtx.controller.init();
  await settle();

  syncingCtx.doc.ids.acctTrigger.fire('click');
  assert.equal(
    syncingCtx.doc.activeElement,
    syncingCtx.doc.ids.acctSignOutBtn,
    'syncing 態開啟選單應直接聚焦登出(立即同步停用，不落焦點)'
  );

  syncingCtx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(syncingCtx.doc.activeElement, syncingCtx.doc.ids.acctDeleteBtn, 'ArrowDown 移到下一項(刪除雲端資料)');

  syncingCtx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(
    syncingCtx.doc.activeElement,
    syncingCtx.doc.ids.acctSignOutBtn,
    '循環回第一個可用項目，中途不曾停在停用的立即同步'
  );

  // expired:多一個「重新登入」可用項目(過期提示列)，立即同步仍停用、
  // 不在方向鍵導覽的循環內。
  const expiredCtx = makeMenuCtxWithState({
    status: 'signed_out',
    email: 'hong@example.com',
    displayName: 'Hong',
    avatarUrl: null,
    lastSyncedAt: null,
    pendingCount: 0,
    lastError: 'session_expired',
    apiBase: '',
  });
  await expiredCtx.controller.init();
  await settle();

  expiredCtx.doc.ids.acctTrigger.fire('click');
  assert.equal(
    expiredCtx.doc.activeElement,
    expiredCtx.doc.ids.acctReSignInBtn,
    'expired 態開啟選單應聚焦「重新登入」(立即同步停用，不落焦點)'
  );

  expiredCtx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(expiredCtx.doc.activeElement, expiredCtx.doc.ids.acctSignOutBtn);

  expiredCtx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(expiredCtx.doc.activeElement, expiredCtx.doc.ids.acctDeleteBtn);

  expiredCtx.doc.ids.acctMenu.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(
    expiredCtx.doc.activeElement,
    expiredCtx.doc.ids.acctReSignInBtn,
    '循環回第一個可用項目，立即同步全程不在導覽序列內'
  );
});

// ============================================================
// 雲端同步的 optional 權限請求(車道 D 接手清單第 1 條)
// ------------------------------------------------------------
// identity 與後端 host 走 optional 權限(D8),而 chrome.permissions.request
// 只能在使用者手勢中呼叫——service worker 自行發起一律失敗。因此「求權限」
// 這一半落在登入按鈕的 click handler 內:先 contains 探一次，缺才 request,
// 授予之後才送 sync.signIn。
// ============================================================

function makeFakePermissions(opts = {}) {
  const containsCalls = [];
  const requestCalls = [];
  return {
    containsCalls,
    requestCalls,
    contains(descriptor) {
      containsCalls.push(descriptor);
      return Promise.resolve(opts.granted === true);
    },
    request(descriptor) {
      requestCalls.push(descriptor);
      return Promise.resolve(opts.accepted !== false);
    },
  };
}

function makeSyncPermissionCtx(permissions, apiBase) {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime({
    'sync.getState': () => ({
      status: 'signed_out',
      email: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: apiBase || 'https://api.metalinkclearer.workers.dev',
    }),
  });
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
    permissions,
  });
  return { storage, doc, runtime, controller };
}

test('雲端同步權限:已授予時只 contains 不 request，直接送出 sync.signIn', async () => {
  const permissions = makeFakePermissions({ granted: true });
  const ctx = makeSyncPermissionCtx(permissions);
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctSignInBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(permissions.containsCalls.length, 1, '登入前必須先探一次權限');
  assert.deepEqual(permissions.requestCalls, [], '已授予就不該再彈一次權限對話框');
  assert.ok(
    ctx.runtime.calls.some((c) => c.type === 'sync.signIn'),
    '權限齊備時應送出 sync.signIn'
  );
});

test('雲端同步權限:缺權限時在手勢內 request，授予後才送 sync.signIn', async () => {
  const permissions = makeFakePermissions({ granted: false, accepted: true });
  const ctx = makeSyncPermissionCtx(permissions, 'https://api-staging.metalinkclearer.workers.dev');
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctSignInBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(permissions.requestCalls.length, 1);
  assert.deepEqual(
    permissions.requestCalls[0],
    {
      permissions: ['identity'],
      origins: ['https://api-staging.metalinkclearer.workers.dev/*'],
    },
    'origin 依 state.apiBase 組出，且落在 manifest 的 optional_host_permissions 內'
  );
  assert.ok(ctx.runtime.calls.some((c) => c.type === 'sync.signIn'));
});

test('雲端同步權限:使用者拒絕授權時不送出 sync.signIn', async () => {
  const permissions = makeFakePermissions({ granted: false, accepted: false });
  const ctx = makeSyncPermissionCtx(permissions);
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctSignInBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(permissions.requestCalls.length, 1);
  assert.ok(
    ctx.runtime.calls.every((c) => c.type !== 'sync.signIn'),
    '拒絕授權後送出登入只會讓 SW 端白跑一趟並轉成 permission_required'
  );
});

test('雲端同步權限:使用者拒絕授權時顯示 toast 說明，不留下「按了沒反應」', async () => {
  const permissions = makeFakePermissions({ granted: false, accepted: false });
  const ctx = makeSyncPermissionCtx(permissions);
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctSignInBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.equal(
    toastTextOf(ctx),
    i18n.t('zh', 'opSyncPermissionDenied'),
    '拒絕授權後畫面必須說明為什麼什麼都沒發生'
  );
});

test('雲端同步權限:apiBase 為 local 時，origin 夾成 http://localhost:8787/*', async () => {
  const permissions = makeFakePermissions({ granted: false, accepted: true });
  const ctx = makeSyncPermissionCtx(permissions, 'http://localhost:8787');
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctSignInBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.deepEqual(permissions.requestCalls[0], {
    permissions: ['identity'],
    origins: ['http://localhost:8787/*'],
  });
});

test('雲端同步權限:長得像 local 的近似值一律夾回 production，不逐前綴放行', async () => {
  // 夾值是逐字比對，不是前綴或子字串比對。換個埠、把 localhost 當成攻擊者
  // 網域的一段、換成等價的迴圈位址——任何一個被放行，都會變成向那個 origin
  // 要權限。
  const nearMisses = ['http://localhost:8788', 'http://localhost.evil', 'http://127.0.0.1:8787'];
  for (const value of nearMisses) {
    const permissions = makeFakePermissions({ granted: false, accepted: true });
    const ctx = makeSyncPermissionCtx(permissions, value);
    await ctx.controller.init();
    await settle();

    ctx.doc.ids.acctSignInBtn.fire('click');
    ctx.doc.ids.confirmOk.fire('click');
    await settle();

    assert.deepEqual(
      permissions.requestCalls[0],
      { permissions: ['identity'], origins: ['https://api.metalinkclearer.workers.dev/*'] },
      `${value} 只是長得像白名單值，必須夾回 production`
    );
  }
});

test('雲端同步權限:origin 一律夾到三個合法的後端 host，不跟著 background 傳來的值走', async () => {
  const permissions = makeFakePermissions({ granted: false, accepted: true });
  // background 若被冒名或形狀走樣傳來任意 apiBase，這個值會直接變成
  // permissions.request 的 origin;必須夾回白名單裡的三個之一。
  const ctx = makeSyncPermissionCtx(permissions, 'https://evil.example');
  await ctx.controller.init();
  await settle();

  ctx.doc.ids.acctSignInBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  assert.deepEqual(permissions.requestCalls[0], {
    permissions: ['identity'],
    origins: ['https://api.metalinkclearer.workers.dev/*'],
  });
});

test('S4 清除全部:水位線與清空寫在同一次 set，且以重讀的 syncState 為基底', async () => {
  const ctx = makeController({
    history: [s4Entry(URL_A, 2000)],
    syncState: { userId: 'user-1', email: 'a@example.com', cursor: null, lastSyncedAt: null, clearedAt: null, lastError: null },
  });
  await ctx.controller.init();
  await settle();

  // 頁面開著的期間，service worker 推進了游標並記下上次同步時間。開頁快照
  // 完全不知道這件事;拿快照整包覆寫會把游標回捲。
  await ctx.storage.local.set({
    syncState: {
      userId: 'user-1',
      email: 'a@example.com',
      cursor: '1700000000000~srv-9',
      lastSyncedAt: 99000,
      clearedAt: null,
      lastError: null,
    },
  });
  await settle();

  const setsBefore = ctx.storage.localCalls.set.length;
  ctx.doc.ids.clearBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();

  const written = ctx.storage.localCalls.set.slice(setsBefore);
  assert.equal(written.length, 1, '水位線與清空必須是同一次 set，不留半套狀態');
  assert.deepEqual(Object.keys(written[0]).sort(), ['history', 'syncState']);

  const snapshot = ctx.storage.localSnapshot();
  assert.deepEqual(snapshot.history, []);
  assert.equal(typeof snapshot.syncState.clearedAt, 'number');
  assert.equal(snapshot.syncState.cursor, '1700000000000~srv-9', '不得用開頁快照把引擎推進的游標回捲');
  assert.equal(snapshot.syncState.lastSyncedAt, 99000, 'lastSyncedAt 同理');
});

// ============================================================
// 匯出 → 匯入 round-trip（docs/cloud-sync.md 4.1）
// ============================================================

// 匯出檔帶了 id／receivedAt／serverUpdatedAt 才能原封不動繞回來。id 不保留
// 的話，匯入端會生成新 UUID——同一張卡在雲端變成兩張，原卡成孤兒;
// serverUpdatedAt 不保留則下一輪合併失去判準，整張表被當成從未上傳過。
test('匯出 → 匯入 round-trip:id 不變、serverUpdatedAt 保留、receivedAt 不往後跳', () => {
  const source = [
    {
      url: URL_A,
      kind: 'icon',
      at: 5000,
      author: 'Dafu',
      seen: [{ at: 3000, kind: 'share' }, { at: 5000, kind: 'icon' }],
      original: 'https://www.threads.com/share/AbCdEfGhI',
      id: 'cloud-card-1',
      postKey: 'threads:AbC123_-xyz',
      receivedAt: 3000,
      dirty: false,
      serverUpdatedAt: 4500,
      deletedAt: null,
    },
  ];

  const payload = options.buildExportPayload(source, '2026-09-04T00:00:00.000Z');
  const parsed = options.parseImportText(JSON.stringify(payload));
  assert.equal(parsed.ok, true);

  const result = options.mergeImportedEntries([], parsed.entries, 9000);
  assert.equal(result.added, 1);
  const back = result.merged[0];
  assert.equal(back.id, 'cloud-card-1', 'id 必須原封不動繞回來');
  assert.equal(back.serverUpdatedAt, 4500, 'serverUpdatedAt 保留，不得歸零');
  assert.equal(back.receivedAt, 3000, 'receivedAt 保留，不得被 now 或較晚的 seen 推後');
  assert.equal(back.url, URL_A);
  assert.equal(back.kind, 'icon');
  assert.equal(back.at, 5000);
  assert.equal(back.author, 'Dafu');
  // postKey 與 dirty 不在匯出檔內，由匯入端重算/重設。
  assert.equal(back.postKey, 'threads:AbC123_-xyz');
  assert.equal(back.dirty, true, '匯入回來的資料在本機一律是待上傳狀態');
  assert.equal(back.deletedAt, null);
});

// ============================================================
// 匯入的儲存上限（TCLCore.capHistory）
// ============================================================

// 匯入是唯一能一口氣把 history 撐長的使用者操作。原本 mergeImportedEntries
// 完全繞過 background 那套裁切，一份夠大的匯入檔就能把 storage.local 寫爆
// （寫入失敗只會吐配額 toast，整批匯入白做）。
test('mergeImportedEntries:12000 筆匯入檔被裁到筆數硬保險，保留最新的一批', () => {
  const MAX = 10000;
  const imported = Array.from({ length: 12000 }, (_, i) => ({
    url: `https://www.threads.com/@u/post/P${i}`,
    kind: 'share',
    // i 越大 at 越新，裁切必須從尾端（最舊，i 小）砍。
    at: 1700000000000 + i,
  }));

  const result = options.mergeImportedEntries([], imported, 1700000000000);
  assert.equal(result.merged.length, MAX, '結果被裁到 HISTORY_LIMITS.MAX_ENTRIES');
  assert.equal(result.added, 12000, 'added 是合併階段的計數，不受裁切影響');
  assert.equal(result.merged[0].url, 'https://www.threads.com/@u/post/P11999', '最新的一筆存活');
  assert.equal(result.merged[MAX - 1].url, 'https://www.threads.com/@u/post/P2000', '最舊的 2000 筆被裁掉');
});

// 裁切走的是與 background 同一份實作：墓碑（deletedAt 為有限數字）優先淘
// 汰，使用者真的看得到的最舊一筆必須存活。
test('mergeImportedEntries:超量時墓碑優先淘汰，一般最舊的一筆存活', () => {
  const existing = Array.from({ length: 10000 }, (_, i) => ({
    url: `https://www.threads.com/@u/post/Q${i}`,
    kind: 'share',
    at: 1700000000000 - i,
    id: `q-${i}`,
    postKey: `threads:Q${i}`,
    receivedAt: 1700000000000 - i,
    dirty: false,
    serverUpdatedAt: null,
    // 最舊的那一筆是墓碑，超量時它應該先被丟。
    deletedAt: i === 9999 ? 1600000000000 : null,
  }));

  const result = options.mergeImportedEntries(
    existing,
    [{ url: 'https://www.threads.com/@u/post/NEWCARD', kind: 'share', at: 1800000000000 }],
    1800000000000
  );

  assert.equal(result.merged.length, 10000);
  const urls = result.merged.map(function (e) {
    return e.url;
  });
  assert.equal(urls.indexOf('https://www.threads.com/@u/post/Q9999'), -1, '墓碑被優先淘汰');
  assert.ok(urls.indexOf('https://www.threads.com/@u/post/Q9998') !== -1, '一般最舊的一筆存活');
  assert.equal(urls[0], 'https://www.threads.com/@u/post/NEWCARD');
});

// ============================================================================
// L5／L6／L7 — 沒有帳號資訊時不得畫出幽靈帳號卡片
// ============================================================================
//
// 引擎端的 L1／L4 之外，設定頁自己也要有一道縱深:即使 background 送來
// status='error' 卻沒有 email／displayName(舊版引擎、訊息被冒名、或引擎某
// 天又走樣)，畫面上也不該出現「空白名字＋紅點＋同步失敗:」的幽靈帳號——
// 那張卡片的每一顆按鈕都是死的(重試送 sync.now 沒 token 直接 return，刪雲
// 端彈假的成功 toast)。
//
// 一次性的登入失敗改走 state.transientError({ code, kind })，由本頁決定要不
// 要出聲:cancelled 靜音(使用者自己按的取消)、transient 一句「請稍後再試」、
// config 帶錯誤碼請使用者回報。

/** 組一份沒有任何身分資訊的 state(引擎在沒有 token 時該送的形狀)。 */
function anonState(over) {
  return Object.assign(
    {
      status: 'signed_out',
      email: null,
      displayName: null,
      avatarUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      lastError: null,
      apiBase: '',
    },
    over
  );
}

/** toast 節點是懶建立的(doc stub 只在 getElementById 時才生節點):沒彈過就是空字串。 */
function toastTextOf(ctx) {
  const el = ctx.doc.ids.toast;
  return el ? el.textContent : '';
}

function makeAccountCtx(getState) {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime(getState ? { 'sync.getState': getState } : {});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    runtime,
  });
  return { storage, doc, runtime, controller };
}

test('L5 帳號入口:status=error 但沒有 email／displayName 時退回未登入卡片(縱深)', async () => {
  const ctx = makeAccountCtx(() => anonState({ status: 'error', lastError: 'sign_in_failed' }));
  await ctx.controller.init();
  await settle();

  assert.equal(ctx.doc.ids.acctSignInBtn.hidden, false, '沒有帳號資訊時只能顯示登入鈕');
  assert.equal(ctx.doc.ids.acctTrigger.hidden, true, '不得畫出頭像觸發鈕');
  assert.equal(ctx.doc.ids.acctMenu.hidden, true, '不得畫出帳號選單');
  assert.equal(ctx.doc.ids.statusDot.hidden, true, '不得亮紅點');
  assert.equal(ctx.doc.ids.acctErrorRow.hidden, true, '不得顯示「同步失敗:」錯誤列');
  assert.equal(ctx.doc.ids.acctHeaderName.textContent, '', '不得留下空白名字');
  assert.equal(ctx.doc.ids.deviceNote.textContent, i18n.t('zh', 'opDeviceNote'), '沒登入就不能說已同步');
});

test('L5 帳號入口:transientError 為 cancelled 時靜音(使用者自己取消的不算錯誤)', async () => {
  const ctx = makeAccountCtx();
  await ctx.controller.init();
  await settle();
  assert.equal(toastTextOf(ctx), '', '前置:尚未有任何 toast');

  ctx.controller.setSyncState(
    anonState({ transientError: { code: 'sign_in_cancelled', kind: 'cancelled' } })
  );

  assert.equal(toastTextOf(ctx), '', '關掉 Google 視窗不該跳任何提示');
  assert.equal(ctx.doc.ids.acctSignInBtn.hidden, false, '取消後仍是未登入卡片');
  assert.equal(ctx.doc.ids.acctMenu.hidden, true);
  assert.equal(ctx.doc.ids.statusDot.hidden, true);
});

test('L5 帳號入口:cancelled 的 permission_required 沿用既有的「未取得權限」toast', async () => {
  const ctx = makeAccountCtx();
  await ctx.controller.init();
  await settle();

  ctx.controller.setSyncState(
    anonState({ transientError: { code: 'permission_required', kind: 'cancelled' } })
  );

  assert.equal(
    toastTextOf(ctx),
    i18n.t('zh', 'opSyncPermissionDenied'),
    '權限被拒是唯一需要解釋「為什麼什麼都沒發生」的取消，沿用既有文案不另造鍵'
  );
  assert.equal(ctx.doc.ids.acctSignInBtn.hidden, false);
});

test('L5 帳號入口:transientError 為 transient 時提示「請稍後再試」，不顯示錯誤碼', async () => {
  for (const code of ['auth_page_unreachable', 'network_error', 'misconfigured', 'sign_in_failed']) {
    const ctx = makeAccountCtx();
    await ctx.controller.init();
    await settle();

    ctx.controller.setSyncState(anonState({ transientError: { code, kind: 'transient' } }));

    assert.equal(
      toastTextOf(ctx),
      i18n.t('zh', 'opAccountSignInFailed'),
      `${code}:暫時性失敗只需要「稍後再試」，錯誤碼對使用者沒有意義`
    );
    assert.equal(ctx.doc.ids.acctSignInBtn.hidden, false, `${code}:仍是未登入卡片`);
    assert.equal(ctx.doc.ids.acctMenu.hidden, true);
    assert.equal(ctx.doc.ids.statusDot.hidden, true);
  }
});

test('L5 帳號入口:transientError 為 config 時帶出錯誤碼請使用者回報', async () => {
  for (const code of ['redirect_mismatch', 'client_id_missing', 'oauth_config_error']) {
    const ctx = makeAccountCtx();
    await ctx.controller.init();
    await settle();

    ctx.controller.setSyncState(anonState({ transientError: { code, kind: 'config' } }));

    assert.equal(
      toastTextOf(ctx),
      i18n.fmt('zh', 'opAccountSignInConfigError', { code }),
      `${code}:設定錯誤重試無用，要讓使用者報得出這串碼`
    );
    assert.equal(ctx.doc.ids.acctSignInBtn.hidden, false, `${code}:仍是未登入卡片`);
    assert.equal(ctx.doc.ids.acctMenu.hidden, true);
    assert.equal(ctx.doc.ids.statusDot.hidden, true);
  }
});

test('L5 i18n:登入失敗的兩則文案兩語系齊備，設定錯誤那則帶 {code} 插值', () => {
  for (const locale of ['zh', 'en']) {
    const failed = i18n.STRINGS[locale].opAccountSignInFailed;
    const config = i18n.STRINGS[locale].opAccountSignInConfigError;
    assert.equal(typeof failed, 'string');
    assert.ok(failed && failed.length > 0, `${locale}:opAccountSignInFailed 不得為空`);
    assert.equal(typeof config, 'string');
    assert.ok(
      config && config.indexOf('{code}') !== -1,
      `${locale}:opAccountSignInConfigError 必須帶 {code} 插值，否則使用者報不出錯誤碼`
    );
  }
  assert.equal(i18n.t('zh', 'opAccountSignInFailed'), '登入失敗，請稍後再試');
});

test('L6 帳號入口:沒有 token 的任何狀態下，重試／立即同步都不得送 sync.now', async () => {
  // 兩種沒有 token 的狀態:引擎走樣送來的 error(無身分)，與登入過期卡片。
  const states = [
    anonState({ status: 'error', lastError: 'sign_in_failed' }),
    anonState({
      status: 'signed_out',
      lastError: 'session_expired',
      email: 'user@example.com',
      displayName: 'Hong',
    }),
  ];
  for (const state of states) {
    const ctx = makeAccountCtx(() => state);
    await ctx.controller.init();
    await settle();

    ctx.doc.ids.acctRetryBtn.fire('click');
    ctx.doc.ids.acctSyncNowBtn.fire('click');
    await settle();

    const nows = ctx.runtime.calls.filter((c) => c && c.type === 'sync.now');
    assert.deepEqual(
      nows,
      [],
      `${state.lastError}:沒有 token 時 sync.now 到了 background 也只會直接 return，等於按鈕壞掉`
    );
    // 這一態真的需要動作時，唯一有意義的訊息是重新登入。
    const others = ctx.runtime.calls.filter((c) => c && c.type !== 'sync.getState');
    assert.ok(
      others.every((c) => c.type === 'sync.signIn'),
      `${state.lastError}:這一態只允許送 sync.signIn，實收 ${JSON.stringify(others)}`
    );
  }
});

test('L7 帳號入口:沒有 token 時按刪雲端資料，不送 sync.deleteCloud 也不彈「已刪除」toast', async () => {
  const states = [
    anonState({ status: 'signed_out' }),
    anonState({ status: 'error', lastError: 'sign_in_failed' }),
    anonState({
      status: 'signed_out',
      lastError: 'session_expired',
      email: 'user@example.com',
      displayName: 'Hong',
    }),
  ];
  for (const state of states) {
    const ctx = makeAccountCtx(() => state);
    await ctx.controller.init();
    await settle();

    ctx.doc.ids.acctDeleteBtn.fire('click');
    if (!ctx.doc.ids.confirmOverlay.hidden) ctx.doc.ids.confirmOk.fire('click');
    await settle();

    assert.ok(
      ctx.runtime.calls.every((c) => c && c.type !== 'sync.deleteCloud'),
      `${state.status}/${state.lastError}:沒有 token 時刪雲端只會失敗，不該送出`
    );
    assert.notEqual(
      toastTextOf(ctx),
      i18n.t('zh', 'opToastCloudDeleted'),
      `${state.status}/${state.lastError}:不得謊報已刪除雲端資料`
    );
  }
});

test('L9 帳號入口:已登入的同步錯誤(有 email)維持 error 卡片，重試照舊送 sync.now', async () => {
  const ctx = makeAccountCtx(() => ({
    status: 'error',
    email: 'user@example.com',
    displayName: null,
    avatarUrl: null,
    lastSyncedAt: 100,
    pendingCount: 2,
    lastError: 'rate_limited',
    apiBase: '',
  }));
  await ctx.controller.init();
  await settle();

  assert.equal(ctx.doc.ids.acctSignInBtn.hidden, true, '有帳號資訊時仍是登入態卡片');
  assert.equal(ctx.doc.ids.acctErrorRow.hidden, false);
  assert.equal(ctx.doc.ids.statusDot.classList.contains('is-danger'), true);

  ctx.doc.ids.acctTrigger.fire('click');
  ctx.doc.ids.acctRetryBtn.fire('click');
  assert.deepEqual(ctx.runtime.calls[ctx.runtime.calls.length - 1], { type: 'sync.now' });
});

test('L5 帳號入口:status=syncing 但沒有 email／displayName 時同樣退回未登入卡片(縱深)', async () => {
  // 與 error 同一道守衛:沒有帳號就沒有東西可同步，轉圈的頭像框只會讓使用者
  // 以為自己登入著。
  const ctx = makeAccountCtx(() => anonState({ status: 'syncing' }));
  await ctx.controller.init();
  await settle();

  assert.equal(ctx.doc.ids.acctSignInBtn.hidden, false, '沒有帳號資訊時只能顯示登入鈕');
  assert.equal(ctx.doc.ids.acctTrigger.hidden, true, '不得畫出頭像觸發鈕');
  assert.equal(ctx.doc.ids.acctMenu.hidden, true, '不得畫出帳號選單');
  assert.equal(ctx.doc.ids.statusDot.hidden, true);
  assert.equal(ctx.doc.ids.acctHeaderName.textContent, '', '不得留下空白名字');
  assert.equal(ctx.doc.ids.deviceNote.textContent, i18n.t('zh', 'opDeviceNote'), '沒登入就不能說已同步');
});
