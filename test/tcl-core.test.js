// test/tcl-core.test.js — 共用核心 lib(tcl-core.js)的行為契約。
//
// tcl-core.js 是 background(寫入側)與 options(讀取/匯入側)原本各養一份
// sanitize/網址樣式鏡像的收斂單一權威。此檔專測 lib 本體:
//   - 網址判定:isCleanPostUrl(嚴格錨定)、normalizePostUrl(容尾正規化)、
//     extractPostId(永久合併的主鍵來源)
//   - F5:stripControlChars(控制/bidi 剝除，**含 emoji ZWJ 保留**)
//   - F1:sanitizeOriginal(白名單三合法來源全通過、偽造擋下、超長整欄丟棄)
//   - sanitizeText / sanitizeRemovedParams / sanitizeSeenList
//   - 常數:LIMITS / KIND_LIST / NOTICE_KIND_LIST / DEFAULT_SETTINGS
//   - 三 context 可載入煙霧測試(SW self / 擴充頁 window / Node this-fallback)
//
// 【紀律】測試裡的控制/bidi/零寬字元一律用 cp()(String.fromCodePoint)由碼位
// 組出，原始碼全 ASCII、不放裸不可見字元——裸控制字元在原始碼裡不可見、會被
// 編輯器/工具正規化掉，是已知的踩雷來源。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

// 由碼位組字串，原始碼保持全 ASCII。
const cp = (...codes) => String.fromCodePoint(...codes);
// 具名的控制/bidi/零寬字元。
const NUL1 = cp(0x0001); // C0(非 tab/newline)
const C1 = cp(0x009f); // C1
const ALM = cp(0x061c); // 阿拉伯字母標記
const LRM = cp(0x200e);
const RLM = cp(0x200f);
const LRE = cp(0x202a);
const PDF = cp(0x202c);
const RLO = cp(0x202e); // right-to-left override(釣魚常用)
const LRI = cp(0x2066);
const PDI = cp(0x2069);
const ZWNJ = cp(0x200c); // 零寬非連接子——**不剝**
const ZWJ = cp(0x200d); // 零寬連接子(emoji 組合)——**不剝**
const FEFF = cp(0xfeff); // BOM/零寬不斷空格——**不剝**

const CLEAN_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';
const SHARE_URL = 'https://www.threads.com/share/AbCdEfGhI';

// ---- 網址判定 ----

test('isCleanPostUrl:嚴格錨定——乾淨貼文網址通過，帶 query/尾隨內容/非字串一律 false', () => {
  assert.equal(C.isCleanPostUrl(CLEAN_URL), true);
  assert.equal(C.isCleanPostUrl('https://threads.net/@user_c/post/GhI789'), true);
  // 錨定收尾:帶 query/hash/尾隨內容都不算「乾淨」(那是 normalizePostUrl 的事)。
  assert.equal(C.isCleanPostUrl(CLEAN_URL + '?xmt=abc'), false);
  assert.equal(C.isCleanPostUrl(CLEAN_URL + '/'), false);
  // 中文釣魚句(白名單字元類擋下，不需要空白也擋得住)。
  assert.equal(C.isCleanPostUrl('https://www.threads.com/@u/post/ID' + cp(0x5e10) + 'evil'), false);
  assert.equal(C.isCleanPostUrl(SHARE_URL), false);
  assert.equal(C.isCleanPostUrl(12345), false);
  assert.equal(C.isCleanPostUrl(null), false);
});

test('normalizePostUrl:容尾正規化——回傳去 query/hash/尾斜線後的乾淨網址，不合則 null', () => {
  assert.equal(C.normalizePostUrl(CLEAN_URL), CLEAN_URL);
  assert.equal(C.normalizePostUrl(CLEAN_URL + '?xmt=abc'), CLEAN_URL);
  assert.equal(C.normalizePostUrl(CLEAN_URL + '/'), CLEAN_URL);
  assert.equal(C.normalizePostUrl(CLEAN_URL + '/?igsh=x#frag'), CLEAN_URL);
  assert.equal(
    C.normalizePostUrl('https://threads.net/@user_c/post/GhI789?a=1'),
    'https://threads.net/@user_c/post/GhI789'
  );
  assert.equal(C.normalizePostUrl(SHARE_URL), null);
  assert.equal(C.normalizePostUrl('https://evil.example/@u/post/ID'), null);
  assert.equal(C.normalizePostUrl(12345), null);
});

// extractPostId 是紀錄永久合併的主鍵來源(見 background.js 的紀錄合併區
// 塊):handle 可改名、post ID 終身不變，改名前後的網址靠它認出是同一篇。三
// 案分別釘住:合法貼文網址抽得出 ID(且與 handle 無關)、分享短碼抽不出
// (短碼只有 Meta 伺服器能對應)、畸形/帶尾隨內容一律 null(呼叫端據此退回整
// 條 url 當 fallback key，寧可多分一張卡也不要把兩篇算成同一篇)。
test('extractPostId:合法貼文網址抽出 ID，與 handle 無關', () => {
  assert.equal(C.extractPostId(CLEAN_URL), 'DbezfB0gYvP');
  // 同一個 post ID、不同 handle(改名前後)必須抽出同一個值——永久合併成立
  // 的前提。
  assert.equal(
    C.extractPostId('https://threads.net/@renamed.user/post/DbezfB0gYvP'),
    C.extractPostId(CLEAN_URL)
  );
  assert.equal(C.extractPostId('https://threads.com/@u/post/Dbez-fB0_gYvP'), 'Dbez-fB0_gYvP');
});

test('extractPostId:分享短碼沒有貼文 ID，一律 null', () => {
  assert.equal(C.extractPostId(SHARE_URL), null);
  assert.equal(C.extractPostId('https://www.threads.com/share/AbCdEfGhI/?x=1'), null);
});

test('extractPostId:畸形/尾隨內容/非字串一律 null(不放行寬鬆匹配)', () => {
  assert.equal(C.extractPostId(CLEAN_URL + '?xmt=abc'), null);
  assert.equal(C.extractPostId(CLEAN_URL + '/'), null);
  assert.equal(C.extractPostId(CLEAN_URL + cp(0x5e10) + 'evil'), null);
  assert.equal(C.extractPostId('https://evil.example/@u/post/ID'), null);
  assert.equal(C.extractPostId('https://www.threads.com/@u/post/'), null);
  assert.equal(C.extractPostId(12345), null);
  assert.equal(C.extractPostId(null), null);
});

// ---- F5:stripControlChars ----

test('F5 stripControlChars:剝除 C0(保留 tab/newline)、C1、bidi', () => {
  // C0:剝 U+0001，保留 \t(U+0009)與 \n(U+000A)。
  assert.equal(C.stripControlChars('a' + NUL1 + 'bc'), 'abc');
  assert.equal(JSON.stringify(C.stripControlChars('a\tb\nc')), JSON.stringify('a\tb\nc'));
  // \r(U+000D)不在保留名單 → 剝除。
  assert.equal(C.stripControlChars('a\rb'), 'ab');
  // C1(U+007F-009F)。
  assert.equal(C.stripControlChars('a' + C1 + 'bc'), 'abc');
  // bidi:U+061C、U+200E/200F、U+202A-202E、U+2066-2069。
  assert.equal(C.stripControlChars('a' + ALM + 'b'), 'ab');
  assert.equal(C.stripControlChars('a' + LRM + 'b' + RLM + 'c'), 'abc');
  assert.equal(C.stripControlChars('a' + LRE + 'b' + RLO + 'c'), 'abc');
  assert.equal(C.stripControlChars('a' + LRI + 'b' + PDI + 'c'), 'abc');
  // 非字串防呆回傳空字串。
  assert.equal(C.stripControlChars(123), '');
});

test('F5 stripControlChars:**保留** emoji ZWJ 序列(家庭 emoji 不散架)、ZWNJ、FEFF', () => {
  // 男+ZWJ+女+ZWJ+女孩(U+200D 連接)，剝了會散成三個獨立的人。
  const family = cp(0x1f468) + ZWJ + cp(0x1f469) + ZWJ + cp(0x1f467);
  assert.equal(C.stripControlChars(family), family);
  // ZWNJ(U+200C)不剝。
  assert.equal(C.stripControlChars('a' + ZWNJ + 'b'), 'a' + ZWNJ + 'b');
  // FEFF(BOM/零寬不斷空格)不剝。
  assert.equal(C.stripControlChars('a' + FEFF + 'b'), 'a' + FEFF + 'b');
});

// ---- sanitizeText ----

test('sanitizeText:非字串→undefined;先剝後截;剝完成空→undefined', () => {
  assert.equal(C.sanitizeText(123, 100), undefined);
  assert.equal(C.sanitizeText('', 100), undefined);
  // 全 bidi/控制字元 → 剝完成空 → undefined(追溯消毒)。
  assert.equal(C.sanitizeText(LRE + PDF + RLM, 100), undefined);
  // 先剝(bidi)後截。
  assert.equal(C.sanitizeText('a' + RLO + 'b', 100), 'ab');
  assert.equal(C.sanitizeText('A'.repeat(150), 100), 'A'.repeat(100));
  assert.equal(C.sanitizeText('hello', 100), 'hello');
});

// ---- F1:sanitizeOriginal ----

test('F1 sanitizeOriginal:三合法來源(share/strip 帶 query/menu=share)全通過', () => {
  // share:短碼分享網址(吻合 SHARE_URL_PATTERN)。
  assert.equal(C.sanitizeOriginal(SHARE_URL, CLEAN_URL), SHARE_URL);
  // strip:剝參前貼文網址(帶追蹤 query，吻合容尾 POST 樣式)，原樣保留含 query。
  const stripOriginal = CLEAN_URL + '?xmt=AQGabc&igsh=xyz';
  assert.equal(C.sanitizeOriginal(stripOriginal, CLEAN_URL), stripOriginal);
  // menu:shareUrl(另一個網域也算合法 share)。
  assert.equal(
    C.sanitizeOriginal('https://threads.net/share/ZZZ', CLEAN_URL),
    'https://threads.net/share/ZZZ'
  );
});

test('F1 sanitizeOriginal:偽造/畸形殘 URL 擋下，非字串/空/===cleanUrl/超長丟棄', () => {
  // 偽造網域。
  assert.equal(C.sanitizeOriginal('https://evil.example/@u/post/ID', CLEAN_URL), undefined);
  // 合法前綴 + 空白尾隨釣魚句(空白不屬 [?#].* 的起手，整串不吻合)。
  assert.equal(C.sanitizeOriginal('https://www.threads.com/@u/post/ID ' + cp(0x5e33) + 'x', CLEAN_URL), undefined);
  // 非字串/空。
  assert.equal(C.sanitizeOriginal(12345, CLEAN_URL), undefined);
  assert.equal(C.sanitizeOriginal('', CLEAN_URL), undefined);
  // 與 cleaned url 相同(沒有額外資訊)。
  assert.equal(C.sanitizeOriginal(CLEAN_URL, CLEAN_URL), undefined);
  // 超長:整欄丟棄，不截斷(即便前綴合法)。
  assert.equal(C.sanitizeOriginal(CLEAN_URL + '?' + 'a'.repeat(2100), CLEAN_URL), undefined);
});

test('F1 sanitizeOriginal:先剝 F5 控制字元，剝後仍須吻合白名單', () => {
  // 網址中夾 bidi(U+202E)，剝除後吻合 SHARE_URL_PATTERN → 保留剝除後的乾淨字串。
  assert.equal(
    C.sanitizeOriginal('https://www.threads.com/share/AB' + RLO + 'CD', CLEAN_URL),
    'https://www.threads.com/share/ABCD'
  );
  // 全控制字元 → 剝完成空 → undefined。
  assert.equal(C.sanitizeOriginal(LRE + PDF, CLEAN_URL), undefined);
});

// ---- sanitizeRemovedParams ----

test('sanitizeRemovedParams:掃描封頂前 20 筆(取嚴)，超過的合法項目不再收', () => {
  // 前 20 筆全畸形，第 21 筆才合法 → 掃描封頂使其收不到，回 undefined。
  const arr = [];
  for (let i = 0; i < 20; i++) arr.push({ key: '', value: 'x' }); // 畸形(空 key)
  arr.push({ key: 'late', value: 'ok' }); // 第 21 筆合法但掃描已封頂
  assert.equal(C.sanitizeRemovedParams(arr), undefined);
});

test('sanitizeRemovedParams:key/value 過 F5 剝除 + 長度上限，畸形逐筆丟棄', () => {
  const out = C.sanitizeRemovedParams([
    { key: 'xmt' + RLO, value: 'a' + RLM + 'b' }, // bidi 剝除後 {xmt, ab}
    { key: '', value: 'x' }, // 空 key → 丟
    { key: 'k'.repeat(70), value: 'x' }, // key 超長 → 丟
    { key: 'v', value: 'v'.repeat(600) }, // value 超長 → 丟
    { key: 'igsh', value: '' }, // value 空字串合法
    { key: 'nope', value: 12 }, // value 非字串 → 丟
  ]);
  assert.deepEqual(out, [
    { key: 'xmt', value: 'ab' },
    { key: 'igsh', value: '' },
  ]);
  assert.equal(C.sanitizeRemovedParams('not-array'), undefined);
  assert.equal(C.sanitizeRemovedParams([{ key: '', value: 'x' }]), undefined);
});

// ---- sanitizeSeenList ----

test('sanitizeSeenList:at 驗證、kind 白名單(含 menu)、缺 kind 保留、裁到 50', () => {
  const out = C.sanitizeSeenList([
    { at: 1, kind: 'share' },
    { at: 2, kind: 'menu' }, // menu 在 KIND_LIST 內
    { at: 3 }, // 缺 kind 的種子紀錄 → 保留
    { at: 'x', kind: 'share' }, // at 非數字 → 丟
    { at: 4, kind: 'bogus' }, // kind 不在白名單 → 丟
    null, // 非物件 → 丟
  ]);
  assert.deepEqual(out, [{ at: 1, kind: 'share' }, { at: 2, kind: 'menu' }, { at: 3 }]);
  assert.deepEqual(C.sanitizeSeenList('nope'), []);
  // 裁到 SEEN_MAX(50):取最後 50 筆。
  const many = Array.from({ length: 60 }, (_, i) => ({ at: i, kind: 'share' }));
  const capped = C.sanitizeSeenList(many);
  assert.equal(capped.length, 50);
  assert.equal(capped[0].at, 10);
  assert.equal(capped[49].at, 59);
});

// ---- 常數 ----

test('常數:LIMITS / KIND_LIST / NOTICE_KIND_LIST / DEFAULT_SETTINGS', () => {
  assert.deepEqual(C.LIMITS, {
    AUTHOR_MAX: 100,
    EXCERPT_MAX: 2000,
    ORIGINAL_MAX: 2048,
    REMOVED_PARAMS_MAX: 20,
    PARAM_KEY_MAX: 64,
    PARAM_VALUE_MAX: 512,
    SEEN_MAX: 50,
  });
  assert.deepEqual(C.KIND_LIST, ['share', 'strip', 'menu', 'icon']);
  // NOTICE_KIND_LIST 刻意排除 'menu'(右鍵路徑不經 postMessage 通道)。
  assert.deepEqual(C.NOTICE_KIND_LIST, ['share', 'strip', 'icon']);
  assert.equal(C.NOTICE_KIND_LIST.indexOf('menu'), -1);
  assert.deepEqual(C.DEFAULT_SETTINGS, { autoClean: false, saveHistory: true, postCopyEnabled: true });
});

// ---- 三 context 可載入煙霧測試 ----

const TCL_CORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'tcl-core.js'), 'utf8');

function loadIn(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(TCL_CORE_SRC, sandbox);
  return sandbox;
}

test('三 context 載入:SW(self 全域)——TCLCore 掛上 self', () => {
  const sandbox = {};
  sandbox.self = sandbox; // service worker 的全域即 self
  loadIn(sandbox);
  assert.equal(typeof sandbox.TCLCore, 'object');
  assert.equal(typeof sandbox.TCLCore.isCleanPostUrl, 'function');
  assert.equal(sandbox.TCLCore.isCleanPostUrl(CLEAN_URL), true);
});

test('三 context 載入:擴充頁(window 全域)——TCLCore 掛上全域', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox; // 瀏覽器頁面 self === window
  loadIn(sandbox);
  assert.equal(typeof sandbox.TCLCore, 'object');
  assert.equal(typeof sandbox.TCLCore.sanitizeText, 'function');
});

test('三 context 載入:Node(this fallback，無 self/window/module)——TCLCore 掛上全域物件', () => {
  const sandbox = {}; // 無 self、無 window、無 module → 走 this 分支
  loadIn(sandbox);
  assert.equal(typeof sandbox.TCLCore, 'object');
  assert.equal(typeof sandbox.TCLCore.stripControlChars, 'function');
});

test('三 context 載入:CommonJS require 得到同形 api', () => {
  assert.equal(typeof C.normalizePostUrl, 'function');
  assert.equal(typeof C.sanitizeOriginal, 'function');
  assert.ok(C.SHARE_URL_PATTERN instanceof RegExp);
});

// ---- unionSeen(三處鏡像收斂的單一實作) ----

// 同 at 只留一筆:原本 background 的 unionSeenEvents 沒去重，同一篇貼文反覆
// 合併(落盤合併、失敗卡收編、遷移整平各走一次)時同一個時刻會疊出好幾筆，
// 還把 SEEN_MAX 的額度吃掉，真正較舊的事件反而被裁掉。
test('unionSeen:同 at 只留一筆(前一份優先)，按 at 升序', () => {
  const out = C.unionSeen(
    [{ at: 300, kind: 'icon' }, { at: 100, kind: 'share' }],
    [{ at: 100, kind: 'strip' }, { at: 200, kind: 'menu' }]
  );
  assert.deepEqual(out, [
    { at: 100, kind: 'share' },
    { at: 200, kind: 'menu' },
    { at: 300, kind: 'icon' },
  ]);
});

// 裁到 SEEN_MAX 時保留**最新**的那一批（slice(-max)，不是 slice(0, max)）。
test('unionSeen:裁到 SEEN_MAX 且保留最新的一批', () => {
  const a = Array.from({ length: 40 }, (_, i) => ({ at: i, kind: 'share' }));
  const b = Array.from({ length: 40 }, (_, i) => ({ at: 40 + i, kind: 'icon' }));
  const out = C.unionSeen(a, b);
  assert.equal(out.length, C.LIMITS.SEEN_MAX);
  assert.equal(out[0].at, 30, '最舊的 30 筆被裁掉');
  assert.equal(out[out.length - 1].at, 79);
});

// max 參數可覆寫上限;髒項（at 非有限數字、kind 不在白名單）逐筆丟棄。
test('unionSeen:max 可覆寫、髒項逐筆丟棄、非陣列當空集合', () => {
  assert.equal(C.unionSeen([{ at: 1 }, { at: 2 }, { at: 3 }], null, 2).length, 2);
  assert.deepEqual(
    C.unionSeen([{ at: 1, kind: 'share' }, { at: NaN }, { at: 2, kind: 'nope' }, 'junk'], undefined),
    [{ at: 1, kind: 'share' }]
  );
  assert.deepEqual(C.unionSeen(null, undefined), []);
});

// ---- capHistory(儲存上限:位元組軟預算 + 筆數硬保險) ----

// 沒觸發任何裁切時回傳**原陣列參照**——background 兩支遷移的冪等短路(「每
// 一筆都是原物件參照就不寫回」)直接依賴這個相等性。
test('capHistory:未超限時回傳原陣列參照', () => {
  const list = [{ url: 'a', at: 2 }, { url: 'b', at: 1 }];
  assert.equal(C.capHistory(list), list);
  assert.deepEqual(C.capHistory('junk'), []);
});

test('capHistory:筆數硬保險從尾端(最舊)砍，最新一筆必留', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ url: 'u' + i, at: 1000 - i }));
  const out = C.capHistory(list, { maxEntries: 10 });
  assert.equal(out.length, 10);
  assert.equal(out[0].url, 'u0');
  assert.equal(out[9].url, 'u9');
});

// 位元組軟預算:從最新往最舊累加，超標就不再收更舊的條目;預算再小也至少
// 保留最新一筆（不會把本次剛寫入的紀錄也裁掉）。
test('capHistory:位元組軟預算從尾端裁，且永遠至少保留最新一筆', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ url: 'u' + i, at: 1000 - i }));
  const one = JSON.stringify(list[0]).length + 1;
  const out = C.capHistory(list, { softBudget: 2 + one * 3 });
  assert.equal(out.length, 3);
  assert.equal(out[0].url, 'u0');
  assert.equal(C.capHistory(list, { softBudget: 1 }).length, 1, '預算不足一筆仍保留最新一筆');
});

// 墓碑優先淘汰:兩條裁切路徑都先丟墓碑，使用者真的看得到的最舊一筆才留得住。
test('capHistory:超限時墓碑優先淘汰(筆數與位元組兩路徑)', () => {
  const byCount = [
    { url: 'live-new', at: 3 },
    { url: 'tomb', at: 2, deletedAt: 1 },
    { url: 'live-old', at: 1 },
  ];
  assert.deepEqual(
    C.capHistory(byCount, { maxEntries: 2 }).map((e) => e.url),
    ['live-new', 'live-old'],
    '筆數超量先丟墓碑，一般最舊的一筆存活'
  );

  const byBudget = [
    { url: 'live-new', at: 3 },
    { url: 'tomb', at: 2, deletedAt: 1 },
    { url: 'live-old', at: 1 },
  ];
  const budget = 2 + byBudget.reduce((sum, e) => sum + JSON.stringify(e).length + 1, 0) - 1;
  assert.deepEqual(
    C.capHistory(byBudget, { softBudget: budget }).map((e) => e.url),
    ['live-new', 'live-old'],
    '位元組超標同樣先丟墓碑'
  );
});

// ---- 裝置歸屬(0.7):seen[].deviceId 透傳與預設裝置名 ----
//
// 契約:cloud-sync-plan-full §9、device-attribution-plan §2／§10。
//   - seen[] schema 擴成 { at, kind?, deviceId? }，deviceId 缺席就缺席，
//     **不得補 null**(輸出 null 會被伺服器當成「明確清空」)。
//   - deviceId 需 UUID 形狀:大小寫不敏感、不驗版本位、全零合法。髒值只丟
//     該欄位，事件本身照樣保留(歸屬不明的事件仍是使用者看得到的紀錄)。
//   - 衝突規則不新增:unionSeen 維持 a 優先，fromSyncItem 把雲端那份排 a，
//     等於伺服器歸屬勝出。SEEN_MAX 裁切行為不變。
//   - defaultDeviceName 是純函式對照表，拿不到 OS 退成 'Chrome'，
//     **不得出現 Unknown**。

// UUID 形狀樣本:標準 v4、大寫、非 v4 版本位、全零。
const DEV_A = '11111111-2222-4333-8444-555555555555';
const DEV_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DEV_UPPER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const DEV_V1 = '11111111-2222-1333-c444-555555555555'; // 版本位與 variant 皆非 v4
const DEV_ZERO = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('裝置歸屬:seen[].deviceId 透傳', () => {
  test('sanitizeSeenList:合法 UUID 形狀保留(含大寫／非 v4 版本位／全零)', () => {
    const out = C.sanitizeSeenList([
      { at: 1, kind: 'share', deviceId: DEV_A },
      { at: 2, deviceId: DEV_UPPER }, // 缺 kind 的種子紀錄也帶得動 deviceId
      { at: 3, kind: 'menu', deviceId: DEV_V1 }, // 不驗版本位
      { at: 4, kind: 'icon', deviceId: DEV_ZERO }, // 全零亦視為合法格式
    ]);
    assert.deepEqual(out, [
      { at: 1, kind: 'share', deviceId: DEV_A },
      { at: 2, deviceId: DEV_UPPER },
      { at: 3, kind: 'menu', deviceId: DEV_V1 },
      { at: 4, kind: 'icon', deviceId: DEV_ZERO },
    ]);
  });

  test('sanitizeSeenList:deviceId 髒值只丟該欄位，事件本身保留', () => {
    const out = C.sanitizeSeenList([
      { at: 1, kind: 'share', deviceId: 12345 }, // 非字串
      { at: 2, kind: 'share', deviceId: null },
      { at: 3, kind: 'share', deviceId: { id: DEV_A } },
      { at: 4, kind: 'share', deviceId: '' },
      { at: 5, kind: 'share', deviceId: 'not-a-uuid' },
      { at: 6, kind: 'share', deviceId: '111111112222433384445555555555555' }, // 缺連字號
      { at: 7, kind: 'share', deviceId: DEV_A + '-extra' }, // 尾隨內容
      { at: 8, kind: 'share', deviceId: ' ' + DEV_A + ' ' }, // 前後空白不 trim，形狀不合
      { at: 9, kind: 'share', deviceId: DEV_A.replace('1', 'g') }, // 非 hex
    ]);
    assert.equal(out.length, 9, '事件本身一筆都不丟');
    for (const record of out) {
      assert.deepEqual(record, { at: record.at, kind: 'share' });
      assert.equal(
        Object.prototype.hasOwnProperty.call(record, 'deviceId'),
        false,
        'at=' + record.at + ' 的髒 deviceId 應整個鍵不輸出'
      );
    }
  });

  test('sanitizeSeenList:deviceId 缺席就缺席，不得補 null', () => {
    const out = C.sanitizeSeenList([{ at: 1, kind: 'share' }, { at: 2 }]);
    assert.deepEqual(out, [{ at: 1, kind: 'share' }, { at: 2 }]);
    assert.equal(Object.prototype.hasOwnProperty.call(out[0], 'deviceId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out[1], 'deviceId'), false);
  });

  // 衝突規則不新增:同 at 一律取前一份(a)那筆的完整內容，包含它有沒有 deviceId。
  test('unionSeen:同 at 衝突維持 a 優先(deviceId 跟著 a 那筆整筆走)', () => {
    assert.deepEqual(
      C.unionSeen(
        [{ at: 100, kind: 'share', deviceId: DEV_A }],
        [{ at: 100, kind: 'menu', deviceId: DEV_B }]
      ),
      [{ at: 100, kind: 'share', deviceId: DEV_A }],
      '兩邊都有 deviceId → 取 a'
    );
    assert.deepEqual(
      C.unionSeen([{ at: 100, kind: 'share', deviceId: DEV_A }], [{ at: 100, kind: 'menu' }]),
      [{ at: 100, kind: 'share', deviceId: DEV_A }],
      'a 有、b 無 → 取 a'
    );
    const bOnly = C.unionSeen(
      [{ at: 100, kind: 'share' }],
      [{ at: 100, kind: 'menu', deviceId: DEV_B }]
    );
    assert.deepEqual(bOnly, [{ at: 100, kind: 'share' }], 'a 無、b 有 → 仍取 a，不從 b 補欄位');
    assert.equal(Object.prototype.hasOwnProperty.call(bOnly[0], 'deviceId'), false);
  });

  test('unionSeen:SEEN_MAX 裁切行為不因 deviceId 改變', () => {
    const a = Array.from({ length: 40 }, (_, i) => ({ at: i, kind: 'share', deviceId: DEV_A }));
    const b = Array.from({ length: 40 }, (_, i) => ({ at: 40 + i, kind: 'icon', deviceId: DEV_B }));
    const out = C.unionSeen(a, b);
    assert.equal(out.length, C.LIMITS.SEEN_MAX);
    assert.equal(out[0].at, 30, '最舊的 30 筆仍被裁掉');
    assert.equal(out[out.length - 1].at, 79);
    assert.equal(out[0].deviceId, DEV_A);
    assert.equal(out[out.length - 1].deviceId, DEV_B);
  });
});

test.describe('裝置歸屬:toSyncItem／fromSyncItem 的 deviceId 往返', () => {
  const baseEntry = () => ({
    id: 'entry-1',
    url: CLEAN_URL,
    original: SHARE_URL,
    receivedAt: 1000,
  });

  test('toSyncItem:seen[].deviceId 透傳，kind→source 映射不變', () => {
    const item = C.toSyncItem(
      Object.assign(baseEntry(), {
        seen: [
          { at: 1000, kind: 'share', deviceId: DEV_A },
          { at: 2000, kind: 'menu', deviceId: DEV_B },
          { at: 3000, deviceId: DEV_ZERO }, // 缺 kind → 不輸出 source，但 deviceId 照出
        ],
      })
    );
    assert.deepEqual(item.seen, [
      { at: 1000, source: 'share', deviceId: DEV_A },
      { at: 2000, source: 'clipboard', deviceId: DEV_B },
      { at: 3000, deviceId: DEV_ZERO },
    ]);
  });

  test('toSyncItem:seen[] 無 deviceId 時不輸出該鍵(不輸出 null)', () => {
    const item = C.toSyncItem(
      Object.assign(baseEntry(), { seen: [{ at: 1000, kind: 'share' }, { at: 2000 }] })
    );
    assert.deepEqual(item.seen, [{ at: 1000, source: 'share' }, { at: 2000 }]);
    assert.equal(Object.prototype.hasOwnProperty.call(item.seen[0], 'deviceId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(item.seen[1], 'deviceId'), false);
  });

  test('fromSyncItem:雲端 seen[].deviceId 映射回本機 seen[].deviceId', () => {
    const entry = C.fromSyncItem(
      {
        id: 'entry-1',
        cleaned: CLEAN_URL,
        original: SHARE_URL,
        receivedAt: 1000,
        seen: [
          { at: 1000, source: 'share', deviceId: DEV_A },
          { at: 2000, source: 'clipboard', deviceId: DEV_UPPER },
        ],
      },
      null
    );
    assert.deepEqual(entry.seen, [
      { at: 1000, kind: 'share', deviceId: DEV_A },
      { at: 2000, kind: 'share', deviceId: DEV_UPPER },
    ]);
  });

  test('fromSyncItem:雲端 deviceId 為 null 或缺席 → 本機缺席', () => {
    const entry = C.fromSyncItem(
      {
        id: 'entry-1',
        cleaned: CLEAN_URL,
        original: SHARE_URL,
        receivedAt: 1000,
        seen: [
          { at: 1000, source: 'share', deviceId: null }, // 舊事件伺服器回 null
          { at: 2000, source: 'share' }, // 整個鍵缺席
        ],
      },
      null
    );
    assert.deepEqual(entry.seen, [{ at: 1000, kind: 'share' }, { at: 2000, kind: 'share' }]);
    assert.equal(Object.prototype.hasOwnProperty.call(entry.seen[0], 'deviceId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry.seen[1], 'deviceId'), false);
  });

  // fromSyncItem 把雲端那份排 unionSeen 的 a:同一毫秒以伺服器的歸屬為準。
  test('fromSyncItem:同 at 時雲端歸屬勝出(雲端排 a)', () => {
    const entry = C.fromSyncItem(
      {
        id: 'entry-1',
        cleaned: CLEAN_URL,
        original: SHARE_URL,
        receivedAt: 1000,
        seen: [{ at: 1000, source: 'share', deviceId: DEV_A }],
      },
      {
        url: CLEAN_URL,
        kind: 'menu',
        at: 1000,
        seen: [{ at: 1000, kind: 'menu', deviceId: DEV_B }],
      }
    );
    assert.deepEqual(entry.seen, [{ at: 1000, kind: 'share', deviceId: DEV_A }]);
  });

  test('fromSyncItem:雲端缺 deviceId 時不從本機同 at 事件補回', () => {
    const entry = C.fromSyncItem(
      {
        id: 'entry-1',
        cleaned: CLEAN_URL,
        original: SHARE_URL,
        receivedAt: 1000,
        seen: [{ at: 1000, source: 'share' }],
      },
      {
        url: CLEAN_URL,
        kind: 'menu',
        at: 1000,
        seen: [{ at: 1000, kind: 'menu', deviceId: DEV_B }],
      }
    );
    assert.deepEqual(entry.seen, [{ at: 1000, kind: 'share' }]);
    assert.equal(Object.prototype.hasOwnProperty.call(entry.seen[0], 'deviceId'), false);
  });

  // 匯出→匯入往返:kind→source→kind 的失真是 D4 已接受的既有行為，此處只釘
  // deviceId 一路不變。
  test('toSyncItem → fromSyncItem 往返:deviceId 不變', () => {
    const item = C.toSyncItem(
      Object.assign(baseEntry(), { seen: [{ at: 1500, kind: 'menu', deviceId: DEV_A }] })
    );
    const entry = C.fromSyncItem(item, null);
    assert.equal(entry.seen.length, 1);
    assert.equal(entry.seen[0].at, 1500);
    assert.equal(entry.seen[0].deviceId, DEV_A);
  });
});

test.describe('裝置歸屬:defaultDeviceName 與 randomUuid', () => {
  // getPlatformInfo().os 五個已知值 → 'Chrome on <OS>';其餘一律退成
  // 'Chrome'(命名規則 §10 拍板:不寫 Unknown、不加序號)。
  test('defaultDeviceName:五個已知 os 值的對照表', () => {
    assert.equal(typeof C.defaultDeviceName, 'function', 'defaultDeviceName 應掛在 TCLCore 匯出');
    assert.equal(C.defaultDeviceName('win'), 'Chrome on Windows');
    assert.equal(C.defaultDeviceName('mac'), 'Chrome on macOS');
    assert.equal(C.defaultDeviceName('linux'), 'Chrome on Linux');
    assert.equal(C.defaultDeviceName('cros'), 'Chrome on ChromeOS');
    assert.equal(C.defaultDeviceName('android'), 'Chrome on Android');
  });

  test('defaultDeviceName:未知／缺席／非字串一律 Chrome，不得出現 Unknown', () => {
    assert.equal(typeof C.defaultDeviceName, 'function', 'defaultDeviceName 應掛在 TCLCore 匯出');
    const fallbacks = ['openbsd', 'fuchsia', '', 'WIN', 'windows', undefined, null, 123, {}, []];
    for (const os of fallbacks) {
      const name = C.defaultDeviceName(os);
      assert.equal(name, 'Chrome', JSON.stringify(String(os)) + ' 應退成 Chrome');
      assert.equal(/unknown/i.test(name), false, '不得出現 Unknown');
    }
    assert.equal(C.defaultDeviceName(), 'Chrome', '無引數也退成 Chrome');
  });

  // deviceId 的來源:形狀必須是小寫 UUID——伺服器存小寫，PUT／DELETE 以它當路徑參數。
  test('randomUuid:回傳小寫 UUID 形狀且不重複', () => {
    const id = C.randomUuid();
    assert.match(id, UUID_RE);
    assert.equal(id, id.toLowerCase());
    assert.notEqual(C.randomUuid(), id);
  });
});
