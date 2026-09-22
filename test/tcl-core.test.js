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
//   - 詐騙串文偵測:detectScamPitch / isPostDetailPath / 黑名單正規化與裁切
//     (見檔尾「詐騙串文偵測」各區塊的說明)
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
// 契約:docs/cloud-sync.md 4.1、4.4 與 D22／D28。
//   - seen[] schema 擴成 { at, kind?, deviceId? }，deviceId 缺席就缺席，
//     **不得補 null**(輸出 null 會被伺服器當成「明確清空」)。
//   - deviceId 需 UUID 形狀:大小寫不敏感、不驗版本位、全零合法。髒值只丟
//     該欄位，事件本身照樣保留(歸屬不明的事件仍是使用者看得到的紀錄)。
//   - 形狀通過後**一律正規化為小寫**(伺服器存小寫)。自產與伺服器回傳
//     本來就是小寫，只有匯入檔可能帶大寫;本機不對齊的話，顯示時拿 deviceId
//     去 join 裝置清單會落空，同一台裝置變成「未知裝置」。
//   - 衝突規則不新增:unionSeen 維持 a 優先，fromSyncItem 把雲端那份排 a，
//     等於伺服器歸屬勝出。SEEN_MAX 裁切行為不變。
//   - defaultDeviceName 是純函式對照表，拿不到 OS 退成 'Chrome'，
//     **不得出現 Unknown**。

// UUID 形狀樣本:標準 v4、大寫、非 v4 版本位、全零。
const DEV_A = '11111111-2222-4333-8444-555555555555';
const DEV_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DEV_UPPER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const DEV_UPPER_LOWER = DEV_UPPER.toLowerCase(); // 正規化後的期望值
const DEV_V1 = '11111111-2222-1333-c444-555555555555'; // 版本位與 variant 皆非 v4
const DEV_ZERO = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('裝置歸屬:seen[].deviceId 透傳', () => {
  test('sanitizeSeenList:合法 UUID 形狀保留並正規化為小寫(不驗版本位、全零合法)', () => {
    const out = C.sanitizeSeenList([
      { at: 1, kind: 'share', deviceId: DEV_A },
      { at: 2, deviceId: DEV_UPPER }, // 缺 kind 的種子紀錄也帶得動 deviceId
      { at: 3, kind: 'menu', deviceId: DEV_V1 }, // 不驗版本位
      { at: 4, kind: 'icon', deviceId: DEV_ZERO }, // 全零亦視為合法格式
    ]);
    assert.deepEqual(out, [
      { at: 1, kind: 'share', deviceId: DEV_A },
      // 大寫進、小寫出:形狀驗證大小寫不敏感，存下來的一律小寫。
      { at: 2, deviceId: DEV_UPPER_LOWER },
      { at: 3, kind: 'menu', deviceId: DEV_V1 },
      { at: 4, kind: 'icon', deviceId: DEV_ZERO },
    ]);
    for (const record of out) assert.match(record.deviceId, UUID_RE);
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
    // 兩份各 per 筆，per 取 0.8×SEEN_MAX——同時滿足 per < SEEN_MAX(裁切後開頭
    // 仍落在 a)與 2×per > SEEN_MAX(確實裁掉東西)，deviceId 才驗得到沒在裁切
    // 邊界上錯位。
    const max = C.LIMITS.SEEN_MAX;
    const per = Math.ceil(max * 0.8);
    const dropped = 2 * per - max;
    const a = Array.from({ length: per }, (_, i) => ({ at: i, kind: 'share', deviceId: DEV_A }));
    const b = Array.from({ length: per }, (_, i) => ({
      at: per + i,
      kind: 'icon',
      deviceId: DEV_B,
    }));
    const out = C.unionSeen(a, b);
    assert.equal(out.length, max);
    assert.equal(out[0].at, dropped, '最舊的 ' + dropped + ' 筆仍被裁掉');
    assert.equal(out[out.length - 1].at, 2 * per - 1);
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

  // 伺服器存的本來就是小寫;這裡餵一筆大寫是防匯入檔／舊資料經雲端往返後
  // 漏掉正規化——本機一律以小寫落地才 join 得到裝置清單。
  test('fromSyncItem:雲端 seen[].deviceId 映射回本機並正規化為小寫', () => {
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
      { at: 2000, kind: 'share', deviceId: DEV_UPPER_LOWER },
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

// ---- 詐騙串文偵測(scam guard)的純函式契約 ----
//
// 對應內部可行性評估(docs/scam-guard.md)的 v1 實作計畫:詐騙帳號用中文文字引導
// 到 LINE(「賴：ex01abc」「加我的賴」「lin.ee/」)，domain 規則命中率 0，判定
// 只能靠「LINE 錨點 + 投資話術」的二次確認。此區塊釘住五支純函式:
//   - detectScamPitch:錨點/話術/片段的命中契約，**負例是本體**(賴床、賴皮、
//     信賴、賴清德、無賴不得誤殺)
//   - isPostDetailPath:詳情頁 pathname 判定(河道不掃全文，只有詳情頁掃)
//   - normalizeScamBlocklist / capScamBlocklist:storage 形狀與上限裁切
//   - makeBlocklistEntry / mergeBlocklistEvidence:條目建立與證據合併
//
// 【紀律】每個 test 先斷言函式掛上 TCLCore 匯出——未實作時吐可讀的斷言失敗，
// 而不是 TypeError crash 把整支測試檔打斷。

const SCAM_POST_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';

// 招攬篇的句型範例(含前文的三個話術詞)——合成字串，句型比照內部可行性評估。
const SCAM_POST_TEXT = [
  '我自己做波段黑馬股很多年，這裡只分享操作心得。',
  '不報明牌、不收費、不代操，純粹交流。',
  '有興趣加我 賴：ex01abc，說「yy」我就知道是你',
].join('\n');

test.describe('詐騙偵測:detectScamPitch', () => {
  test('detectScamPitch:招攬篇句型——錨點 + 話術命中，回傳四欄形狀', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const res = C.detectScamPitch(SCAM_POST_TEXT);
    assert.equal(res.hit, true, '詐騙招攬句型必須命中');
    assert.equal(typeof res.anchorMatch, 'string', 'anchorMatch 是命中的錨點原文');
    assert.equal(res.anchorMatch.includes('ex01abc'), true, '錨點應涵蓋帳號本體');
    assert.equal(Array.isArray(res.pitchMatches), true, 'pitchMatches 是陣列');
    assert.equal(res.pitchMatches.includes('黑馬股'), true);
    assert.equal(res.pitchMatches.length >= 1, true, '命中規則要求 PITCH >= 1');
    assert.equal(typeof res.snippet, 'string');
  });

  // 錨點的四種形式(賴/籟＋冒號＋帳號、LINE ID、加入我的 LINE、連結)，各配一
  // 個話術詞。全形/半形冒號、冒號前後空白、大小寫都要吃。
  test('detectScamPitch:ANCHOR 四種形式 × 話術 → 命中', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const positives = [
      '波段黑馬股分享，賴：ex01abc',
      '想學就找我，賴: abc_123，帶單實績公開',
      '籟：xyz789 教你抓飆股',
      'LINE ID：wolf_88 免費教學抓黑馬股',
      'LINE  ID: wolf88，穩賺不賠',
      '加入我的LINE，每日獲利分享',
      '加我的賴，黑馬股消息先給你',
      '加入賴，我這邊有代操名額',
      'line id: abc123 報明牌',
    ];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
  });

  // 連結型錨點是唯一可以單獨成立的:已經是 LINE 加好友連結，不必再等話術詞。
  test('detectScamPitch:連結型 ANCHOR 單獨成立，不需話術詞', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const links = [
      '一起討論 https://line.me/ti/g/AbCdEf01 歡迎',
      '群組 https://line.me/R/ti/g/AbCdEf01',
      '點這 https://lin.ee/abc123',
      '全部連結在 https://linktr.ee/someone',
      // PM 裁決:ti/p 是一對一加好友深連結，與 ti/g 同屬引導私訊的白名單路徑。
      '看這篇 https://line.me/R/ti/p/@abc',
    ];
    for (const text of links) {
      const res = C.detectScamPitch(text);
      assert.equal(res.hit, true, JSON.stringify(text) + ' 連結型錨點應單獨命中');
      assert.deepEqual(res.pitchMatches, [], '連結型命中時沒有話術詞也成立');
    }
  });

  // 【負例是本體】中文「賴」是姓氏也是常用動詞，誤殺成本遠高於漏抓:錨點正則
  // 要求「賴」後面接冒號＋至少 3 位英數，或是明確的「加入…賴」動詞片語。
  test('detectScamPitch:賴字負例——信賴／依賴／賴床／賴皮／賴清德／無賴不得誤殺', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const negatives = [
      '這個分析我很信賴',
      '我百分之百信賴他的判斷',
      '他太依賴技術分析了，成天追飆股',
      '他每天賴床到中午才起來',
      '不要賴皮好嗎',
      '賴清德總統今天發表談話',
      '這種人根本是無賴',
      '信賴：這家店開很久了',
      '加賴床時間也沒用，黑馬股還是抓不到',
      '加賴皮的人只會害你，代操都是騙局',
      '加賴帳號的很多都是詐騙，說什麼黑馬股',
    ];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤殺');
    }
  });

  test('detectScamPitch:只有話術沒錨點、只有錨點沒話術——都不命中', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    // 話術詞全上陣，沒有任何 LINE 錨點:正當的投資討論長文長這樣。
    const pitchOnly =
      '黑馬股、報明牌、明牌、代操、帶單、飆股、免費教學、不收費、穩賺、獲利分享、內線，這些字眼都要小心。';
    assert.equal(C.detectScamPitch(pitchOnly).hit, false, '只有話術不成立');
    // 錨點有、投資話術零:純交友不是詐騙偵測的範圍。
    assert.equal(C.detectScamPitch('加我賴 ex01abc 聊天，晚上一起打球').hit, false, '只有錨點不成立');
    assert.equal(C.detectScamPitch('賴：ex01abc，明天見').hit, false, '只有錨點不成立');
    assert.equal(C.detectScamPitch('LINE ID：wolf_88，有空聊').hit, false, '只有錨點不成立');
  });

  // 帳號段至少 3 位英數:「賴：」後面接中文或 1-2 個字元的，是標點誤判不是帳號。
  test('detectScamPitch:帳號段少於 3 位英數不算錨點', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    assert.equal(C.detectScamPitch('賴：ab 有黑馬股').hit, false);
    assert.equal(C.detectScamPitch('賴：這檔是黑馬股').hit, false);
    assert.equal(C.detectScamPitch('賴：abc 有黑馬股').hit, true, '滿 3 位就算');
  });

  // 連結白名單只收加好友(ti/p)/群組(ti/g)路徑:line.me 的其他路徑(官網首
  // 頁、分享頁)不是引導私訊的入口，單獨不成立。
  test('detectScamPitch:非白名單 LINE 路徑不算連結型錨點', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    assert.equal(C.detectScamPitch('官網 https://line.me/').hit, false);
    assert.equal(C.detectScamPitch('圖在 https://linktree.example/someone').hit, false);
  });

  test('detectScamPitch:snippet 取錨點前後各 40 字、總長 <= 120', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const text = '黑馬股' + 'A'.repeat(100) + '賴：ex01abc' + 'B'.repeat(100);
    const res = C.detectScamPitch(text);
    assert.equal(res.hit, true);
    assert.equal(res.snippet.length <= 120, true, 'snippet 總長上限 120，實得 ' + res.snippet.length);
    assert.equal(res.snippet.includes('ex01abc'), true, 'snippet 必須含錨點本體');
    assert.equal(res.snippet.includes('A'.repeat(41)), false, '錨點前最多 40 字');
    assert.equal(res.snippet.includes('B'.repeat(41)), false, '錨點後最多 40 字');
    assert.equal(res.snippet.includes('黑馬股'), false, '超過 40 字的前文不進 snippet');
  });

  // snippet 會進 storage 也會進選項頁 DOM:控制/bidi 字元必須在此剝除，不能把
  // RLO 這類偽裝字元原封帶進黑名單卡片。
  test('detectScamPitch:snippet 剝除控制字元與 bidi', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const text = '黑馬股介紹' + NUL1 + '加我 賴' + RLO + '：ex01abc' + C1 + LRM + ' 謝謝';
    const res = C.detectScamPitch(text);
    assert.equal(res.hit, true, '控制字元不得讓錨點失效');
    for (const ch of [NUL1, C1, ALM, LRM, RLM, LRE, PDF, RLO, LRI, PDI]) {
      assert.equal(res.snippet.includes(ch), false, '控制/bidi 字元應被剝除');
    }
  });

  test('detectScamPitch:非字串輸入回 { hit: false }，不拋錯', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    for (const bad of [null, undefined, 123, {}, [], true, () => {}]) {
      const res = C.detectScamPitch(bad);
      assert.equal(res.hit, false, JSON.stringify(String(bad)) + ' 應回 hit:false');
      assert.equal(!res.snippet, true, '非字串不產 snippet');
    }
    assert.equal(C.detectScamPitch('').hit, false, '空字串不命中');
  });
});

// ---- 詐騙偵測:LINE 提及 ＋ 群組／加入詞（PM 規則改版）----
//
// 【改版理由】原判準是「錨點 ＋ 至少一個強話術詞」，漏掉整類「軟性招攬」:
// 前六篇寫勵志故事、末篇只留一句「加 LINE：xxx，我把你拉進群組」，一個投資
// 話術詞都不放。這類串文的共同結構不是話術詞，而是「把人帶去 LINE 群組」。
//
// 【新判準】命中 = 連結型錨點單獨成立，或 LINE 提及 ＋（群組詞 或 加入
// 詞），或既有的 錨點 ＋ 強話術詞。強／弱話術詞仍列入 pitchMatches 當證
// 據，但不再是門檻。
//
// 【LINE 提及】LINE 單字（前後不接英文字母）、LINE：xxx／LINE:xxx、
// LINE ID：xxx、賴：xxx、籟：xxx（信/依/無/仰/倚 的負向 lookbehind 保
// 留）、片語「加(入)?(我的)?(賴|籟|LINE)」與「加 LINE」、line.me／lin.ee／
// linktr.ee 連結。「賴」「籟」單獨出現不算提及。
// 【群組詞】群組、社群、群裡、進群、拉進、拉你進、小群。
// 【加入詞】加入、加我、加 LINE／加LINE、私訊我。
//
// 【訊號必須各自獨立】群組／加入詞要另外成立，不能就是提及本體的那幾個
// 字:「加入我的LINE」整句只是一個片語型提及，不得自己拿「加入」再湊成命
// 中——否則「烘焙免費教學，加入LINE官方帳號領取食譜」這類正當商家貼文會
// 整批誤報（見本檔「誤報防線」區塊的既有負例）。

// fixture 的末篇＝軟性招攬的判定靶，與 test/scam-guard.test.js 端到端用的
// 是同一份檔案，規則與端到端不會各自漂移。
const SOFT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'scam-thread-soft.json'), 'utf8')
);
const SOFT_PITCH_TEXT = SOFT_FIXTURE.posts[SOFT_FIXTURE.posts.length - 1].captionText;
const SOFT_THREAD_TEXT = SOFT_FIXTURE.posts.map((post) => post.captionText).join('\n\n');

test.describe('詐騙偵測:LINE 提及 ＋ 群組／加入詞', () => {
  // 招攬篇一個話術詞都沒有:命中完全由「LINE 提及 ＋ 群組詞」撐起，
  // pitchMatches 是空陣列也要 hit。
  test('detectScamPitch:軟性招攬篇——零話術詞，LINE 提及＋群組詞即命中', () => {
    const res = C.detectScamPitch(SOFT_PITCH_TEXT);
    assert.equal(res.hit, true, '軟性招攬句必須命中:' + JSON.stringify(SOFT_PITCH_TEXT));
    assert.deepEqual(res.pitchMatches, [], '這句沒有任何話術詞，門檻不得再依賴它');
    // 【斷言翻轉｜D43】v3 標亮整段「LINE：ab12cd」;v4 改標 ID 本體——證據卡
    // 要讓使用者一眼看到對方的 LINE 帳號，而不是「LINE：」那三個字。
    assert.equal(res.anchorMatch, 'ab12cd', 'anchorMatch 取 ID 本體(D43)');
    assert.equal(res.snippet.includes('LINE：ab12cd'), true, 'snippet 以 LINE 提及為中心');
    // 回傳形狀不變:四個欄位照舊（signals 之類的新欄位可加，但不得少欄位）。
    for (const key of ['hit', 'anchorMatch', 'pitchMatches', 'snippet']) {
      assert.equal(Object.prototype.hasOwnProperty.call(res, key), true, '回傳應保留 ' + key);
    }
    // 整串七篇串起來掃也要命中（端到端送進來的就是這份全文）。
    assert.equal(C.detectScamPitch(SOFT_THREAD_TEXT).hit, true, '七篇全文照樣命中');
  });

  test('detectScamPitch:LINE 提及 ＋ 群組詞 → 命中', () => {
    const positives = [
      '想進群的加入我們 LINE 群組',
      '我的 LINE：grp001，晚點拉你進群組',
      '賴：grp002，直接拉進群裡一起討論',
      '籟：grp003，小群人不多，聊得比較深',
      'LINE ID：grp004，社群裡每天都有人分享',
      '留言 1 我私訊你進群，LINE:grp005',
    ];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
  });

  test('detectScamPitch:LINE 提及 ＋ 加入詞 → 命中', () => {
    const positives = [
      '有興趣私訊我，LINE:xyz123',
      '私訊我拿資料，賴：join001',
      'LINE ID：join002，想聽的加入就好',
      '加我，LINE：join003',
    ];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
  });

  // 帳號型提及不再需要「ID」兩個字:實際招攬句寫的就是「LINE：帳號」。
  test('detectScamPitch:LINE：帳號 不必帶 ID 兩字，半形冒號、無空白、全形都算', () => {
    const forms = [
      'LINE：form001，我拉你進群組',
      'LINE:form002，我拉你進群組',
      'LINE ：form003，我拉你進群組',
      '想進群組的加LINE',
      '想進群組的加 LINE：form004',
      'ＬＩＮＥ：ａｂ１２ｃｄ，我拉你進群組',
    ];
    for (const text of forms) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
    // 全形帳號的原文全形要保留，證據卡才看得出對方用了規避字元。
    const wide = C.detectScamPitch('ＬＩＮＥ：ａｂ１２ｃｄ，我拉你進群組');
    assert.equal(
      wide.anchorMatch.includes('ａｂ１２ｃｄ') || wide.snippet.includes('ａｂ１２ｃｄ'),
      true,
      '全形帳號不得被正規化成半形寫進證據'
    );
  });

  // 帳號型錨點的繫詞(是／ID／帳號)可選:真實招攬句常補上繫詞再接冒號，不只
  // 是「賴：xxx」這種裸冒號寫法。
  test('detectScamPitch:帳號型錨點的繫詞(是／ID／帳號)可選，繫詞在前也算', () => {
    const positives = [
      '想來的朋友，我的賴是：ab12cd，加入後傳訊「63」，我拉你進群組。',
      'LINE 帳號：ab12cd，私訊我拉你進群',
      '賴帳號：ab12cd 加入群組',
    ];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
    const withCopula = C.detectScamPitch('想來的朋友，我的賴是：ab12cd，加入後傳訊「63」，我拉你進群組。');
    // 【斷言翻轉｜D43】繫詞照舊要吃得下(命中就是證明),但標亮位置改成 ID 本體。
    assert.equal(withCopula.anchorMatch, 'ab12cd', 'anchorMatch 取 ID 本體(D43)');
  });

  // 【負例是本體】LINE 是英文詞的常見結尾:ONLINE／deadline／LINEUP 都不是
  // LINE 提及，前後接英文字母時一律不算。
  test('detectScamPitch:ONLINE／deadline／LINEUP 不算 LINE 提及', () => {
    const negatives = [
      'ONLINE 課程加入群組',
      'deadline 前加入社群',
      '先看 LINEUP 再決定要不要加入群組',
      '我們的 headline 是加入社群一起讀',
    ];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤殺');
    }
  });

  // 「賴」「籟」單獨出現不算提及:姓氏（賴清德）、動詞（賴床）、既有的
  // 信/依/無/仰/倚 負向邊界，配上群組詞照樣不得命中。
  test('detectScamPitch:賴／籟 單獨出現配群組詞仍不命中', () => {
    const negatives = [
      '賴清德加入群組',
      '我信賴：Apple 的產品社群',
      '加賴床的群組',
      '這種無賴也想進群裡',
      '他太依賴社群的風向了',
      '籟聲很美，歡迎加入社群一起聽',
    ];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤殺');
    }
  });

  // 兩個訊號缺一不可:只有 LINE 提及（官方帳號公告、客服資訊）或只有群組／
  // 加入詞（Discord、Telegram、實體社團）都不成立。
  test('detectScamPitch:只有 LINE 提及、或只有群組／加入詞——都不命中', () => {
    const lineOnly = [
      'LINE 官方帳號今天當機了',
      'LINE 又改版了，訊息列很難用',
      'LINE：shop001（本店客服，週一到週五）',
    ];
    for (const text of lineOnly) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 缺群組／加入詞');
    }
    const wordOnly = [
      '歡迎加入我們的 Discord 群組',
      '台股群組今天討論飆股',
      '讀書會還有名額，想加入的留言',
      '私訊我就好，不用客氣',
    ];
    for (const text of wordOnly) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 缺 LINE 提及');
    }
  });

  // 群組／加入詞必須獨立於提及本體之外:「加入我的LINE」整句只是一個片語型
  // 提及，不得自己拿裡面的「加入」湊成命中。這條界線擋的是「加入LINE官方帳
  // 號」這類正當商家貼文（見「誤報防線」區塊）。
  test('detectScamPitch:片語型提及不得自己湊出加入詞', () => {
    assert.equal(C.detectScamPitch('加入我的LINE').hit, false, '提及本體不得同時充當加入詞');
    assert.equal(C.detectScamPitch('加入LINE官方帳號領取優惠').hit, false, '正當商家貼文不得誤報');
    assert.equal(C.detectScamPitch('加我賴 ex01abc 聊天，晚上一起打球').hit, false, '純交友不在範圍');
    // 另有一個獨立的群組詞時才成立。
    assert.equal(C.detectScamPitch('加入我的LINE，我拉你進群組').hit, true, '多一個群組詞就成立');
    assert.equal(C.detectScamPitch('加入我的LINE，社群裡有完整筆記').hit, true, '多一個群組詞就成立');
  });

  // 話術詞降級成純證據:強詞仍會出現在 pitchMatches，但不再是門檻的一部分。
  // 既有的「錨點 ＋ 強詞」路徑照舊成立（既有正例不得翻紅）。
  test('detectScamPitch:話術詞仍列入 pitchMatches，且錨點＋強詞路徑保留', () => {
    const res = C.detectScamPitch('想進群組的加 LINE：ab12cd，帶你找飆股');
    assert.equal(res.hit, true);
    assert.equal(res.pitchMatches.includes('飆股'), true, '話術詞仍要當證據列出');
    assert.equal(C.detectScamPitch(SCAM_POST_TEXT).hit, true, '既有招攬篇正例不得翻紅');
    assert.equal(C.detectScamPitch('加入我的LINE，每日獲利分享').hit, true, '錨點＋強詞路徑保留');
    assert.equal(C.detectScamPitch('籟：xyz789 教你抓飆股').hit, true, '錨點＋強詞路徑保留');
  });
});

// ---- 詐騙偵測:單字型 LINE 的窄門與裸網址錨點(覆審裁決)----
//
// 【單字型要更窄】「LINE 提及 ＋ 群組／加入詞」對單字型提及太寬:公司公告、
// 社區公告、讀書會、商家會員這些貼文本來就會同時寫到 LINE 與「群組」「加
// 入」，它們是名詞，不是把人拉走的動作。單字型因此只配**主動招攬詞**(進
// 群、拉進、拉你進、小群、加我、私訊我);名詞型的群組／社群／群裡／加入只
// 有在提及本身已經是錨點(連結／帳號／片語)時才算。
//
// 【裸網址】招攬串常把深連結寫成沒有 scheme 的 `lin.ee/xxx`,Threads 照樣會
// 自動連結。連結型錨點因此讓 `https://` 與 `www.` 都可省，改用前置的負向
// lookbehind 擋住黏在別的網域後面的情形(`xxline.me/ti/g/x`)。

test.describe('詐騙偵測:單字型 LINE 只配主動招攬詞', () => {
  // 名詞型的群組／社群／加入配單字型 LINE——正當貼文的日常組合，不得命中。
  test('detectScamPitch:單字型 LINE 配名詞型群組／加入詞不命中', () => {
    const negatives = [
      '公司公告改用 LINE 群組發布',
      '社區公告都發在 LINE，請加入住戶群組',
      '讀書會的 LINE 群組本週開放加入',
      '健身房加入會員送體驗課，LINE 有客服可以問',
      'LINE Pay 加入會員送點數',
    ];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤殺');
    }
  });

  // 主動招攬詞描述的是「把你帶走」這個動作，單字型配它才成立。
  test('detectScamPitch:單字型 LINE 配主動招攬詞才命中', () => {
    const positives = ['想進群的加入我們 LINE 群組', 'LINE 群組名額還有，晚點拉你進群', '有空的話私訊我，LINE 都在'];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
  });

  // 錨點型提及(連結／帳號／片語)不受這道窄門影響，照樣吃完整詞表。
  test('detectScamPitch:錨點型提及仍吃完整群組／加入詞表', () => {
    const positives = [
      '可以加 LINE：ab12cd，傳訊息給我，我把你拉進群組',
      '私訊我 LINE:xyz123',
      '加line 進群',
      '加入我的LINE，社群裡有完整筆記',
      'LINE ID：join002，想聽的加入就好',
    ];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
  });

  // 「加 LINE／加LINE」本來就被片語型錨點的區間蓋住，留在加入詞表裡只會從
  // LINEUP／LINEAR 這類英文詞洩漏出來(片語錨點的 lookahead 擋掉了 LINEUP,
  // 加入詞的純字串比對卻擋不住)。整個移除。
  test('detectScamPitch:加LINEUP 不得充當加入詞', () => {
    assert.equal(C.detectScamPitch('LINE 又改版了，記得加LINEUP到行事曆').hit, false, '英文詞片段不得湊成加入詞');
    assert.equal(C.detectScamPitch('LINE 官方帳號公告，加LINEAR代數課表').hit, false, '英文詞片段不得湊成加入詞');
  });
});

test.describe('詐騙偵測:連結型錨點吃裸網址', () => {
  test('detectScamPitch:lin.ee／line.me 不帶 scheme 也算連結型錨點', () => {
    const links = ['加我 lin.ee/Ab12Cd', '群組在這 line.me/ti/g/AbCdEf01', '點 www.lin.ee/abc123 就好'];
    for (const text of links) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 裸網址應單獨命中');
    }
    // 帶 scheme 的既有形式不得翻紅。
    assert.equal(C.detectScamPitch('點這 https://lin.ee/abc123').hit, true, '帶 scheme 的形式維持命中');
    assert.equal(C.detectScamPitch('看這篇 https://line.me/R/ti/p/@abc').hit, true, '帶 scheme 的形式維持命中');
  });

  // 網域前面黏著英數/點/@/斜線時是別人的網域(xxline.me、my.lin.ee.evil)，
  // 不是 LINE 的深連結。
  test('detectScamPitch:網域前面黏著英數不算連結型錨點', () => {
    const negatives = ['圖在 xxline.me/ti/g/AbCdEf01', '網址是 9lin.ee/abc123', '看 a.linktr.ee/someone'];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤判為 LINE 深連結');
    }
  });
});

test.describe('詐騙偵測:isPostDetailPath', () => {
  test('isPostDetailPath:/@handle/post/CODE 為真', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    assert.equal(C.isPostDetailPath('/@example_author/post/DxSyNtH0001'), true);
    assert.equal(C.isPostDetailPath('/@user_c/post/GhI789'), true);
    assert.equal(
      C.isPostDetailPath('/@some.other_reader/post/A-b_C1'),
      true,
      'handle 含句點、ID 含連字號都在既有白名單字元類內'
    );
  });

  test('isPostDetailPath:河道／個人頁／搜尋頁為偽', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    const negatives = [
      '/',
      '',
      '/@example_author',
      '/@example_author/',
      '/@example_author/replies',
      '/search',
      '/search/?q=abc',
      '/activity',
      '/post/DxSyNtH0001',
      '/@example_author/post/',
      '/@example_author/posts/DxSyNtH0001',
      '/@example_author/post/DxSyNtH0001/extra',
      '/@bad handle/post/DxSyNtH0001',
    ];
    for (const p of negatives) {
      assert.equal(C.isPostDetailPath(p), false, JSON.stringify(p) + ' 不是詳情頁');
    }
    // 中文釣魚字元:沿用 STRICT_POST_URL_PATTERN 的白名單字元類擋下。
    assert.equal(C.isPostDetailPath('/@u/post/ID' + cp(0x5e10) + 'evil'), false);
  });

  // 【既有慣例】讀取側(normalizePostUrl / NORMALIZE_POST_URL_PATTERN)容忍尾隨
  // 斜線與 query/hash;isPostDetailPath 是讀取側判定(判斷「目前這頁是不是詳情
  // 頁」)，沿用同一套寬鬆慣例，而非寫入側 isCleanPostUrl 的嚴格錨定。
  test('isPostDetailPath:尾斜線與查詢字串的變體依讀取側慣例容忍', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    assert.equal(C.isPostDetailPath('/@example_author/post/DxSyNtH0001/'), true);
    assert.equal(C.isPostDetailPath('/@example_author/post/DxSyNtH0001?xmt=abc'), true);
    assert.equal(C.isPostDetailPath('/@example_author/post/DxSyNtH0001/?igsh=x#frag'), true);
  });

  test('isPostDetailPath:非字串一律 false，不拋錯', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    for (const bad of [null, undefined, 123, {}, [], true]) {
      assert.equal(C.isPostDetailPath(bad), false, JSON.stringify(String(bad)) + ' 應為 false');
    }
  });
});

test.describe('詐騙偵測:normalizeScamBlocklist', () => {
  // 【斷言翻轉｜D36】version 由 1 改成 2:讀回時一律就地升版，v1 的形狀不再
  // 是任何一條路徑的輸出。allowlist 仍在輸出上，但已是 dismissed 條目的派生
  // 唯讀視圖（見檔尾「警示名單 v2」區塊）。
  // 【斷言翻轉｜D46】v4 多一張 lineIdIndex（{ lineId → userId } 的反查表）。
  // 它與 allowlist 同款：普通的可列舉鍵、只活在記憶體、落盤由
  // capScamBlocklist 挑鍵擋掉（那條斷言另外釘著三把鍵）。刻意不用不可列舉屬
  // 性把它藏過這條形狀斷言——藏起來的鍵在 structured clone、物件展開與
  // Object.assign 之下會被默默丟掉，靠它的那條命中路徑就無聲失效。
  const EMPTY_LIST = { version: 2, entries: {}, handleIndex: {}, allowlist: {}, lineIdIndex: {} };

  test('normalizeScamBlocklist:缺席／非物件一律回空的五欄形狀', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    for (const bad of [undefined, null, 'nope', 42, true, []]) {
      assert.deepEqual(C.normalizeScamBlocklist(bad), EMPTY_LIST, JSON.stringify(String(bad)) + ' 應回空形狀');
    }
  });

  test('normalizeScamBlocklist:髒值逐項剝除不炸，其餘條目保留', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      version: 99,
      entries: {
        '111': {
          handle: 'Example_Author',
          displayName: 'Example',
          evidence: [{ postUrl: SCAM_POST_URL, snippet: '賴：ex01abc', at: 5 }],
          addedAt: 5,
          source: 'auto',
        },
        '222': 'not-an-object',
        '333': null,
        '444': { handle: 'Foo', evidence: 'not-an-array', addedAt: 6 },
        '555': 12345,
      },
      handleIndex: { staleghost: '999' },
      allowlist: { '777': true },
      junkField: 'should not survive',
    });
    // 【斷言翻轉｜D36】version 1 → 2；allowlist 的 '777' 現在會升成 entries
    // 裡的一筆 dismissed 條目，因此 entries 多一把鍵。
    assert.equal(out.version, 2, 'version 一律正規化成 2');
    assert.deepEqual(
      Object.keys(out.entries).sort(),
      ['111', '444', '777'],
      'entries 內非物件逐項剝除；v1 的 allowlist 升成 dismissed 條目'
    );
    assert.equal(out.entries['777'].state, 'dismissed', '舊 allowlist 那一筆是解除態');
    assert.deepEqual(out.entries['444'].evidence, [], 'evidence 非陣列退成空陣列，不整筆丟棄');
    assert.equal(Array.isArray(out.entries['111'].evidence), true);
    assert.equal(out.entries['111'].evidence.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'junkField'), false, '未知欄位不留存');
  });

  test('normalizeScamBlocklist:handleIndex 由 entries 重建且 handle 小寫', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      entries: {
        '111': { handle: 'Example_Author', evidence: [], addedAt: 1 },
        '444': { handle: 'Foo', evidence: [], addedAt: 2 },
        '555': { evidence: [], addedAt: 3 },
      },
      handleIndex: { staleghost: '999', example_author: 'wrong-id' },
    });
    assert.deepEqual(out.handleIndex, { example_author: '111', foo: '444' }, 'handleIndex 只能由 entries 重建');
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.handleIndex, 'undefined'),
      false,
      '缺 handle 的條目不得產生 undefined 鍵'
    );
  });

  // entries 與 allowlist 的 handle 走同一把尺（sanitizeDisplayName）：摺疊連續
  // 空白、去頭尾空白、截長。兩側尺不同時，同一個帳號會在封鎖表與解除表存成兩
  // 種字串，解除後的比對與 handleIndex 反查都會漏掉。
  test('normalizeScamBlocklist:entries 與 allowlist 的 handle 清洗結果一致', () => {
    const dirty = '  Example \t\n  Author  ';
    const longHandle = 'a'.repeat(120);
    const out = C.normalizeScamBlocklist({
      entries: {
        '111': { handle: dirty, evidence: [], addedAt: 1 },
        '222': { handle: longHandle, evidence: [], addedAt: 2 },
      },
      allowlist: {
        '111': { at: 7, handle: dirty },
        '222': { at: 8, handle: longHandle },
      },
    });
    assert.equal(out.entries['111'].handle, 'Example Author', 'entries 的 handle 摺疊連續空白並去頭尾');
    assert.equal(
      out.allowlist['111'].handle,
      out.entries['111'].handle,
      'entries 與 allowlist 的 handle 清洗結果須一致'
    );
    assert.equal(
      out.allowlist['222'].handle,
      out.entries['222'].handle,
      '超長 handle 兩側截到同一長度'
    );
    // 【斷言翻轉｜D36】原斷言為 handleIndex['example author'] === '111'。輸入
    // 的 '111' 同時出現在 entries 與 allowlist，v2 遷移以 dismissed 為準，而
    // handleIndex 只含 active——反查鍵因此不該存在。handle 清洗一致性（本測試
    // 的本意）改由上面兩條 entries／allowlist 的比對承擔。
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.handleIndex, 'example author'),
      false,
      'dismissed 條目不進 handleIndex'
    );
  });

  test('normalizeScamBlocklist:allowlist 髒值退成空物件', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    assert.deepEqual(C.normalizeScamBlocklist({ allowlist: 'nope' }).allowlist, {});
    assert.deepEqual(C.normalizeScamBlocklist({ allowlist: null }).allowlist, {});
    assert.deepEqual(C.normalizeScamBlocklist({ allowlist: { '777': true } }).allowlist, { '777': { at: 0, handle: '' } });
  });

  // allowlist 的值是「解除紀錄」：at 為解除時間，handle 為解除當下的帳
  // 號，選項頁「已解除」小節靠這兩欄排序與顯示。舊版只存 true，讀回來要能
  // 自動升成新形狀，不得讓使用者已解除的作者被下一次掃描復活。
  test('normalizeScamBlocklist:allowlist 值為 { at, handle }——舊值 true 相容、髒值剝除', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      allowlist: {
        '111': { at: 1700000000000, handle: 'Example_Author' },
        '222': true,
        '333': { at: 'nope', handle: 42 },
        '444': { at: 1700000000001 },
        '555': false,
        '666': 'yes',
        '777': null,
        '888': 0,
        '999': ['Example_Author'],
      },
    });

    assert.deepEqual(
      out.allowlist['111'],
      { at: 1700000000000, handle: 'Example_Author' },
      '合格的 { at, handle } 原樣保留，handle 維持原始大小寫'
    );
    assert.deepEqual(out.allowlist['222'], { at: 0, handle: '' }, '舊值 true 升成空解除紀錄 { at:0, handle }');
    assert.deepEqual(out.allowlist['333'], { at: 0, handle: '' }, '欄位髒值各自退回預設，不整筆丟棄');
    assert.deepEqual(out.allowlist['444'], { at: 1700000000001, handle: '' }, 'handle 缺席退成空字串');
    assert.deepEqual(
      Object.keys(out.allowlist).sort(),
      ['111', '222', '333', '444'],
      'true 以外的非物件值（false／字串／null／0／陣列）一律剝除'
    );
    assert.equal(Object.getPrototypeOf(out.allowlist['111']), Object.prototype);
  });

  // 【斷言翻轉｜D36】原斷言為「capScamBlocklist 把 allowlist 原樣帶出來」。
  // v2 的落盤物件只有 version／entries／handleIndex 三把鍵:allowlist 只是
  // normalizeScamBlocklist 掛在記憶體物件上的派生視圖，跟著落盤等於讓
  // storage 存兩份真相。舊 allowlist 的每一列改以 dismissed 條目落盤。
  test('capScamBlocklist:v1 的 allowlist 落盤成 dismissed 條目，輸出不帶 allowlist 鍵', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.capScamBlocklist({
      version: 1,
      entries: {},
      handleIndex: {},
      allowlist: { '111': { at: 5, handle: 'foo' }, '222': true, '333': 'nope' },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'allowlist'), false, '派生視圖不得落盤');
    assert.deepEqual(Object.keys(out.entries).sort(), ['111', '222'], 'true 以外的非物件值一律剝除');
    assert.equal(out.entries['111'].state, 'dismissed');
    assert.equal(out.entries['111'].dismissedAt, 5);
    assert.equal(out.entries['111'].handle, 'foo');
    assert.equal(out.entries['222'].dismissedAt, 0, '舊值 true 沒有時間，退 0');
  });
});

test.describe('詐騙偵測:capScamBlocklist', () => {
  // 造一份 n 筆的名單，addedAt 由舊到新(1..n)，userId 為 '<i>'——entries 的鍵
  // 須是 userId 形狀（純數字字串、1-20 位），normalizeScamBlocklist 會剝掉其餘鍵。
  function makeList(n, evidencePerEntry, snippetLen) {
    const entries = {};
    const handleIndex = {};
    for (let i = 1; i <= n; i++) {
      const id = String(i);
      const evidence = [];
      for (let e = 0; e < (evidencePerEntry || 1); e++) {
        evidence.push({
          postUrl: 'https://www.threads.com/@h' + i + '/post/CODE' + e,
          snippet: 'S'.repeat(snippetLen || 10),
          at: i * 1000 + e,
        });
      }
      entries[id] = { handle: 'h' + i, displayName: 'name' + i, evidence: evidence, addedAt: i, source: 'auto' };
      handleIndex['h' + i] = id;
    }
    return { version: 1, entries: entries, handleIndex: handleIndex, allowlist: {} };
  }

  test('capScamBlocklist:entries 上限 5000，依 addedAt 最舊先淘汰', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.capScamBlocklist(makeList(5050, 1, 10));
    const ids = Object.keys(out.entries);
    assert.equal(ids.length, 5000, 'entries 裁到 5000 筆');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '1'), false, '最舊的 addedAt 先淘汰');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '50'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '51'), true, '保留最新 5000 筆');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '5050'), true);
    // handleIndex 必須跟著裁，不能留下指向已淘汰條目的孤兒鍵。
    assert.equal(Object.keys(out.handleIndex).length, 5000);
    assert.equal(Object.prototype.hasOwnProperty.call(out.handleIndex, 'h1'), false);
    assert.equal(out.handleIndex.h5050, '5050');
  });

  test('capScamBlocklist:每筆 evidence 上限 3，保留最新(at 最大)', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const list = makeList(1, 1, 10);
    list.entries['1'].evidence = [
      { postUrl: SCAM_POST_URL + '1', snippet: 'a', at: 100 },
      { postUrl: SCAM_POST_URL + '2', snippet: 'b', at: 500 },
      { postUrl: SCAM_POST_URL + '3', snippet: 'c', at: 300 },
      { postUrl: SCAM_POST_URL + '4', snippet: 'd', at: 900 },
      { postUrl: SCAM_POST_URL + '5', snippet: 'e', at: 200 },
    ];
    const kept = C.capScamBlocklist(list).entries['1'].evidence;
    assert.equal(kept.length, 3, 'evidence 裁到 3 筆');
    assert.deepEqual(
      kept.map((e) => e.at),
      [900, 500, 300],
      '保留最新三筆且依 at 降冪'
    );
  });

  test('capScamBlocklist:snippet 裁到 120 字', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const list = makeList(1, 1, 400);
    const kept = C.capScamBlocklist(list).entries['1'].evidence[0];
    assert.equal(kept.snippet.length, 120, 'snippet 硬裁 120 字');
    assert.equal(kept.postUrl.startsWith('https://www.threads.com/'), true, '其餘欄位原樣保留');
  });

  test('capScamBlocklist:整包 JSON 超過 2MB 軟預算時繼續淘汰最舊', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    // 4000 筆 × 3 證據 × 120 字 snippet 遠超 2MB，筆數上限（5000）攔不住，只能靠軟預算。
    const out = C.capScamBlocklist(makeList(4000, 3, 120));
    const ids = Object.keys(out.entries);
    assert.equal(ids.length < 4000, true, '軟預算應再淘汰，實得 ' + ids.length + ' 筆');
    assert.equal(ids.length > 0, true, '不得把整份名單清空');
    assert.equal(JSON.stringify(out).length <= 2 * 1024 * 1024, true, '整包 JSON 不得超過 2MB');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '4000'), true, '最新的一筆永遠留著');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '1'), false, '最舊的先走');
  });

  test('capScamBlocklist:未超量時原樣回傳；非物件不炸', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const small = makeList(3, 2, 20);
    const out = C.capScamBlocklist(small);
    assert.deepEqual(Object.keys(out.entries).sort(), ['1', '2', '3']);
    assert.equal(out.entries['2'].evidence.length, 2);
    // 【斷言翻轉｜D36】空形狀改成 v2 的三欄:version 2，且不帶 allowlist。
    for (const bad of [undefined, null, 'nope', 42, []]) {
      assert.deepEqual(
        C.capScamBlocklist(bad),
        { version: 2, entries: {}, handleIndex: {} },
        JSON.stringify(String(bad)) + ' 應回空形狀'
      );
    }
  });
});

test.describe('詐騙偵測:makeBlocklistEntry 與 mergeBlocklistEvidence', () => {
  test('makeBlocklistEntry:回傳含單筆證據的條目', () => {
    assert.equal(typeof C.makeBlocklistEntry, 'function', 'makeBlocklistEntry 應掛在 TCLCore 匯出');
    const entry = C.makeBlocklistEntry({
      userId: '1234567890',
      handle: 'Example_Author',
      displayName: 'Example Author',
      postUrl: SCAM_POST_URL,
      snippet: '加我 賴：ex01abc',
      at: 1700000000000,
      source: 'auto',
    });
    assert.equal(entry.handle, 'Example_Author', 'handle 保留原始大小寫(小寫化是 handleIndex 的事)');
    assert.equal(entry.displayName, 'Example Author');
    assert.equal(entry.addedAt, 1700000000000);
    assert.equal(entry.source, 'auto');
    assert.equal(Array.isArray(entry.evidence), true);
    assert.equal(entry.evidence.length, 1);
    assert.deepEqual(entry.evidence[0], {
      postUrl: SCAM_POST_URL,
      snippet: '加我 賴：ex01abc',
      at: 1700000000000,
    });
  });

  test('makeBlocklistEntry:snippet 超長裁到 120 字；髒輸入不拋錯', () => {
    assert.equal(typeof C.makeBlocklistEntry, 'function', 'makeBlocklistEntry 應掛在 TCLCore 匯出');
    const entry = C.makeBlocklistEntry({
      userId: '1',
      handle: 'h',
      postUrl: SCAM_POST_URL,
      snippet: 'S'.repeat(300),
      at: 1,
      source: 'auto',
    });
    assert.equal(entry.evidence[0].snippet.length, 120);
    assert.doesNotThrow(() => C.makeBlocklistEntry(null), '缺席引數不得拋錯');
    assert.doesNotThrow(() => C.makeBlocklistEntry({}), '空物件不得拋錯');
  });

  test('mergeBlocklistEvidence:同 postUrl 不重複', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    const entry = {
      handle: 'h',
      displayName: 'n',
      evidence: [{ postUrl: SCAM_POST_URL, snippet: 'old', at: 100 }],
      addedAt: 100,
      source: 'auto',
    };
    const merged = C.mergeBlocklistEvidence(entry, { postUrl: SCAM_POST_URL, snippet: 'new', at: 900 });
    assert.equal(merged.evidence.length, 1, '同一篇貼文只算一筆證據');
    assert.equal(entry.evidence.length, 1, '純函式:不得就地改寫傳入的條目');
  });

  test('mergeBlocklistEvidence:新 postUrl 併入且依 at 降冪', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    const entry = {
      handle: 'h',
      displayName: 'n',
      evidence: [
        { postUrl: SCAM_POST_URL + 'A', snippet: 'a', at: 500 },
        { postUrl: SCAM_POST_URL + 'B', snippet: 'b', at: 100 },
      ],
      addedAt: 100,
      source: 'auto',
    };
    const merged = C.mergeBlocklistEvidence(entry, { postUrl: SCAM_POST_URL + 'C', snippet: 'c', at: 300 });
    assert.deepEqual(
      merged.evidence.map((e) => e.at),
      [500, 300, 100],
      '證據依 at 降冪'
    );
    assert.equal(merged.addedAt, 100, 'addedAt 是首見時間，不隨新證據往後跳');
    assert.equal(entry.evidence.length, 2, '純函式:不得就地改寫傳入的條目');
  });

  test('mergeBlocklistEvidence:髒證據不入列也不拋錯', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    const entry = {
      handle: 'h',
      displayName: 'n',
      evidence: [{ postUrl: SCAM_POST_URL, snippet: 'a', at: 500 }],
      addedAt: 500,
      source: 'auto',
    };
    for (const bad of [null, undefined, 'nope', 42, {}, { postUrl: 'https://evil.example/x', snippet: 'b', at: 9 }]) {
      const merged = C.mergeBlocklistEvidence(entry, bad);
      assert.equal(merged.evidence.length, 1, JSON.stringify(String(bad)) + ' 不得入列');
    }
  });
});

// ---- 詐騙偵測的誤報防線(審查 FAIL 回歸) ----
//
// 首版實作讓五類誤報過關:「信賴：」開頭的正常句被當錨點、體育/職場語境的
// 「內線」被當投資話術、「免費教學／不收費」單詞就足以命中、全形帳號漏抓、
// 位元組預算用 JS 字元數而非真位元組(中文 snippet 實際佔 3 倍)，外加
// `__proto__` 鍵與 displayName 換行兩個衛生問題。此區塊逐條釘死。

test.describe('詐騙偵測:誤報防線(審查 FAIL 回歸)', () => {
  // 「賴」前面接 信/依/無/仰 時整個詞是「信賴/依賴/無賴/仰賴」，後面的冒號
  // 是正常標點，不是 LINE 帳號引導。這類句子常同時帶投資詞(討論股票時說
  // 「我信賴某某分析」)，光靠 PITCH 二次確認擋不住，錨點本身必須排除。
  test('detectScamPitch:信賴／依賴／無賴／仰賴 後接冒號不是錨點', () => {
    const negatives = [
      '我信賴：Apple 的品質，這檔是飆股',
      '感謝大家的信賴：thanks，一起抓飆股',
      '依賴：technical analysis 的人很容易買到假飆股',
      '無賴：scammer123 這種人才會報明牌',
      '仰賴：xyz123 黑馬股',
    ];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤報');
    }
    // 對照組:排除清單只針對 信/依/無/仰，不得擴成「前面是中文就不算錨點」
    // ——詐騙招攬句「我的賴：ex01abc」正是這個形狀。
    assert.equal(C.detectScamPitch('我的賴：ex01abc，專攻波段黑馬股').hit, true, '排除清單不得過寬');
    assert.equal(C.detectScamPitch('找我聊 賴：ex01abc，有黑馬股').hit, true, '排除清單不得過寬');
  });

  // 帳號型錨點加了繫詞(是／ID／帳號)可選之後，信賴／依賴的負向邊界不能跟著
  // 鬆動——「信賴是：」「依賴是：」後面接的仍是正常標點，不是 LINE 帳號引
  // 導；「賴清德」是姓氏，後面接的是人名不是繫詞或冒號，本來就不成立錨點。
  test('detectScamPitch:帳號型繫詞加入後，信賴／依賴／賴清德的負向邊界照舊', () => {
    const negatives = [
      '我最信賴是：Apple2024 的品質，加入我們的社群討論。',
      '過度依賴是：problem1 的根源，歡迎加入讀書會群組。',
      '賴清德的政見群組，加入後可以討論 policy2024 的細節。',
    ];
    for (const text of negatives) {
      assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤報');
    }
  });

  // 【PM 裁決】話術表回歸規格原文:刪除「內線」。內線在中文是體育(內線傳
  // 球)、職場(內線消息)、電話分機的日常詞，投資語境的辨識力不足以單獨撐起
  // PITCH，留著只會把球評與八卦貼文一起掃進黑名單。表定保留:黑馬股／報明牌
  // ／代操／帶單／飆股／穩賺／獲利分享。
  test('detectScamPitch:內線不在話術表內', () => {
    const text = '他的內線很強，禁區沒人擋得住，加入LINE看直播';
    const res = C.detectScamPitch(text);
    assert.equal(res.hit, false, '內線不得撐起 PITCH');
    assert.equal(res.pitchMatches.includes('內線'), false, '內線不得出現在 pitchMatches');
    // 表定的七個詞逐一確認仍在(各配一個錨點)。
    const kept = ['黑馬股', '報明牌', '代操', '帶單', '飆股', '穩賺', '獲利分享'];
    for (const word of kept) {
      const hitRes = C.detectScamPitch('加入我的LINE，' + word + '都有');
      assert.equal(hitRes.hit, true, word + ' 應仍是話術詞');
      assert.equal(hitRes.pitchMatches.includes(word), true, word + ' 應出現在 pitchMatches');
    }
  });

  // pitchMatches 會直接進證據卡給使用者看:「明牌」是「報明牌」的子字串，同
  // 一段文字兩個都列等於同一件事數兩次，也讓「PITCH >= 1」的門檻被子字串灌
  // 水。被包含的短詞在長詞已命中時不列入。
  test('detectScamPitch:pitchMatches 去除被包含詞', () => {
    const res = C.detectScamPitch('加入我的LINE，不報明牌也能賺');
    assert.equal(res.hit, true);
    assert.equal(res.pitchMatches.includes('報明牌'), true, '長詞列入');
    assert.equal(res.pitchMatches.includes('明牌'), false, '被包含的短詞不重複列');
    assert.equal(new Set(res.pitchMatches).size, res.pitchMatches.length, 'pitchMatches 不得有重複項');
    // 只出現短詞時，短詞照列。
    const short = C.detectScamPitch('加入我的LINE，明牌直接給你');
    assert.equal(short.pitchMatches.includes('明牌'), true);
  });

  // 「免費教學」「不收費」在補習、餐飲、健身、公益貼文裡是中性詞，辨識力遠
  // 低於「黑馬股」「代操」。降權成弱詞:只有它們時不足以命中，必須再有一個
  // 其他投資詞才算 PITCH 成立。
  test('detectScamPitch:免費教學／不收費是弱詞，單獨不足以命中', () => {
    assert.equal(C.detectScamPitch('烘焙免費教學，加入LINE官方帳號領取食譜').hit, false, '免費教學單獨不成立');
    assert.equal(C.detectScamPitch('瑜珈課程不收費，加入我的LINE').hit, false, '不收費單獨不成立');
    // 弱詞 + 一個強詞 → 成立。
    assert.equal(C.detectScamPitch('黑馬股免費教學，加入我的LINE').hit, true, '弱詞配強詞應命中');
    assert.equal(C.detectScamPitch('代操不收費，賴：ex01abc').hit, true, '弱詞配強詞應命中');
    // 範例第六篇原句:「不報明牌、不收費、不代操」含兩個強詞，降權後仍命中。
    assert.equal(C.detectScamPitch(SCAM_POST_TEXT).hit, true, '真實詐騙貼文不得因降權漏抓');
  });

  // 詐騙帳號會用全形英數規避純 ASCII 的帳號樣式。錨點要吃全形，且
  // anchorMatch／snippet 必須保留原文全形——證據卡要讓使用者一眼看出對方用
  // 了規避字元，不能偷偷正規化成半形。
  test('detectScamPitch:全形英數帳號照樣是錨點，原文全形保留', () => {
    const text = '賴：ｅｘ０１ａｂｃ 有黑馬股';
    const res = C.detectScamPitch(text);
    assert.equal(res.hit, true, '全形帳號應命中');
    assert.equal(
      res.anchorMatch.includes('ｅｘ０１ａｂｃ') || res.snippet.includes('ｅｘ０１ａｂｃ'),
      true,
      'anchorMatch 或 snippet 必須保留原文全形'
    );
    // 3 位的門檻對全形一視同仁:2 位仍不算帳號。
    assert.equal(C.detectScamPitch('賴：ｅｘ 有黑馬股').hit, false, '全形也要滿 3 位');
  });

  // 2MB 軟預算是 chrome.storage 的位元組配額，不是 JS 字元數。snippet 幾乎必
  // 然是中文(詐騙話術本體)，UTF-8 每字 3 bytes——用 String#length 當預算會讓
  // 實際寫入量膨脹到三倍而撞配額。
  test('capScamBlocklist:2MB 軟預算算的是 UTF-8 真位元組', () => {
    const entries = {};
    const handleIndex = {};
    for (let i = 1; i <= 2000; i++) {
      const id = String(i);
      const evidence = [];
      for (let e = 0; e < 3; e++) {
        evidence.push({
          postUrl: 'https://www.threads.com/@h' + i + '/post/CODE' + e,
          snippet: '詐騙'.repeat(60), // 120 字 / 360 bytes
          at: i * 1000 + e,
        });
      }
      entries[id] = { handle: 'h' + i, displayName: '帳號' + i, evidence: evidence, addedAt: i, source: 'auto' };
      handleIndex['h' + i] = id;
    }
    const out = C.capScamBlocklist({ version: 1, entries: entries, handleIndex: handleIndex, allowlist: {} });
    const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
    assert.equal(bytes <= 2 * 1024 * 1024, true, '真位元組不得超過 2MB，實得 ' + bytes);
    assert.equal(Object.keys(out.entries).length > 0, true, '不得把整份名單清空');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '2000'), true, '最新的一筆永遠留著');
  });

  // storage 讀回的 JSON 可能含 `__proto__` 鍵(手工編輯的匯入檔、或他處寫入
  // 的髒資料)。`out.entries['__proto__'] = entry` 不會建出自有鍵，而是把
  // entries 的原型整個換掉:Object.keys 看不到它，handleIndex 卻留下指向它的
  // 孤兒鍵，之後的查表會拿到一筆撈不出來的條目。
  test('normalizeScamBlocklist:__proto__ 鍵拒收，原型不受污染', () => {
    const raw = JSON.parse(
      '{"entries":{"__proto__":{"handle":"evil","displayName":"x","evidence":[],"addedAt":1,"polluted":"yes"},' +
        '"111":{"handle":"ok","evidence":[],"addedAt":2}}}'
    );
    const out = C.normalizeScamBlocklist(raw);
    assert.deepEqual(Object.keys(out.entries), ['111'], '__proto__ 鍵不得成為條目');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, '__proto__'), false);
    assert.equal(Object.getPrototypeOf(out.entries), Object.prototype, 'entries 的原型不得被換掉');
    assert.deepEqual(out.handleIndex, { ok: '111' }, 'handleIndex 不得留下孤兒鍵');
    assert.equal({}.polluted, undefined, 'Object.prototype 不得被污染');
    assert.equal(Object.prototype.polluted, undefined, 'Object.prototype 不得被污染');

    const allowOut = C.normalizeScamBlocklist(JSON.parse('{"allowlist":{"__proto__":true,"777":true}}'));
    assert.deepEqual(Object.keys(allowOut.allowlist), ['777'], 'allowlist 同樣拒收 __proto__');
    assert.equal(Object.getPrototypeOf(allowOut.allowlist), Object.prototype);
  });

  // 黑名單卡片是單行版面:displayName 帶換行/tab 會把卡片撐開或截斷。比照
  // sanitizeDisplayName 的做法把連續空白摺成一個半形空格並去頭尾。
  test('makeBlocklistEntry:displayName 摺疊空白成單行', () => {
    const entry = C.makeBlocklistEntry({
      userId: '1234567890',
      handle: 'Example_Author',
      displayName: '  Example\n\tAuthor \n 投資 ',
      postUrl: SCAM_POST_URL,
      snippet: '賴：ex01abc',
      at: 1700000000000,
      source: 'auto',
    });
    assert.equal(entry.displayName, 'Example Author 投資', '連續空白摺成單一半形空格並去頭尾');
    assert.equal(/[\r\n\t]/.test(entry.displayName), false, 'displayName 不得留下換行或 tab');
    const dirtyHandle = C.makeBlocklistEntry({
      userId: '1',
      handle: 'Example\tAuthor\n',
      postUrl: SCAM_POST_URL,
      snippet: 's',
      at: 1,
      source: 'auto',
    });
    assert.equal(/[\r\n\t]/.test(dirtyHandle.handle), false, 'handle 不得留下換行或 tab');
  });
});

// ============================================================
// 【整合審查 S7】normalizeScamBlocklist 的 entries／allowlist 鍵必須是
// userId 形狀（純數字字串，§14）。storage 是使用者可編輯、也可能被他處寫
// 髒的地方；鍵不驗形狀時，任意字串（handle、路徑、標記字串）都能混進
// entries 當成一筆「作者」，handleIndex 還會跟著指過去，查表就會拿到一筆
// 永遠對不上 background 寫入側 userId 的幽靈條目。
// ============================================================

test.describe('詐騙偵測:normalizeScamBlocklist 的鍵形狀', () => {
  const SCAM_USER_ID_PATTERN = /^\d{1,20}$/;

  function entryOf(handle) {
    return { handle: handle, displayName: handle, evidence: [], addedAt: 1, source: 'auto' };
  }

  test('normalizeScamBlocklist:entries 非數字鍵整筆剝除，handleIndex 不得殘留指向它', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      entries: {
        abc: entryOf('ghost_author'),
        '123': entryOf('example_author'),
        '12a34': entryOf('mixed_author'),
        '-1': entryOf('negative_author'),
        '1.5': entryOf('float_author'),
        '': entryOf('blank_author'),
        '123456789012345678901': entryOf('overlong_author'),
      },
    });

    assert.deepEqual(Object.keys(out.entries), ['123'], 'entries 只留 userId 形狀（純數字、1-20 位）的鍵');
    Object.keys(out.entries).forEach((id) => {
      assert.match(id, SCAM_USER_ID_PATTERN, id + ' 應為 userId 形狀');
    });
    assert.deepEqual(
      out.handleIndex,
      { example_author: '123' },
      'handleIndex 不得殘留指向被丟棄鍵的項目——那是查不出條目的孤兒鍵'
    );
    Object.keys(out.handleIndex).forEach((key) => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(out.entries, out.handleIndex[key]),
        'handleIndex[' + key + '] 指向的條目必須還在 entries 裡'
      );
    });
  });

  test('normalizeScamBlocklist:allowlist 同樣只留 userId 形狀的鍵', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      allowlist: {
        abc: { at: 1, handle: 'ghost_author' },
        '456': { at: 2, handle: 'example_author' },
        '4a56': true,
        '': true,
      },
    });

    assert.deepEqual(Object.keys(out.allowlist), ['456'], 'allowlist 只留 userId 形狀的鍵');
    assert.deepEqual(out.allowlist['456'], { at: 2, handle: 'example_author' }, '合格鍵的值照舊正規化');
  });
});

// ============================================================
// 詐騙偵測:證據結構補強(anchorPostUrl／threadUrl／anchorMatch／signals)
//
// 【為什麼要補】舊證據只有 { postUrl, snippet, at } 三欄，而 postUrl 存的是
// 「使用者當時開的那一頁」。招攬串的錨點幾乎都落在末篇，點進證據連結看到的
// 卻是第一篇的長篇鋪陳，使用者無從一眼確認當初為何被標記。四個新欄位把「哪
// 一篇帶錨點」「整串從哪裡開始」「錨點本體是什麼」「踩到哪幾類訊號」一併留
// 下，證據卡才講得清楚。
//
// 【欄位契約】
//   anchorPostUrl 含錨點那一篇的永久連結(走 normalizePostUrl)
//   threadUrl     串頭(第一篇)的永久連結(走 normalizePostUrl)
//   anchorMatch   錨點本體，剝控制字元後硬裁 40 字
//   signals       字串陣列，白名單 link|line|group|join|pitch，其餘剝除
//   postUrl       維持原義:使用者當時開的那一頁(必要欄位，不合法整筆丟)
//
// 【向後相容】四欄皆為選填。舊證據缺欄時輸出就不帶該鍵(不是補 null 也不是
// 補空字串)——選項頁靠「鍵在不在」決定要不要畫那一行，補空值會讓舊證據畫出
// 一排空連結。
//
// 【不合法剝欄不剝筆】新欄位形狀不對時只剝掉那一欄，整筆證據照留:它們是加
// 值資訊，不是證據成立的必要條件，為了一個壞掉的 threadUrl 丟掉整筆等於把使
// 用者真的命中過的紀錄一起抹掉。postUrl 與 at 仍是必要欄位，維持原行為。
// ============================================================

// 同一位作者的三篇:0001 是使用者開的那一頁(也是串頭),0002 是帶錨點的末
// 篇。合成資料沿用 example_author／DxSyNtH000x。
const EV_PAGE_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const EV_ANCHOR_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0002';
const EV_THREAD_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const EV_OTHER_ANCHOR_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0003';
const EV_ANCHOR_TEXT = 'LINE：ab12cd';
const EV_SIGNALS = ['line', 'group'];
const EV_SNIPPET = '想多一個地方交流可以加 LINE：ab12cd，我把你拉進群組';

// 條目序列化後的實際 UTF-8 位元組，供位元組估算的差額比對。
const evUtf8 = (value) => Buffer.byteLength(value, 'utf8');

// 帶滿四個新欄位的一筆證據(raw 形狀，尚未正規化)。
function richEvidence(patch) {
  return Object.assign(
    {
      postUrl: EV_PAGE_URL,
      snippet: EV_SNIPPET,
      at: 1700000100000,
      anchorPostUrl: EV_ANCHOR_URL,
      threadUrl: EV_THREAD_URL,
      anchorMatch: EV_ANCHOR_TEXT,
      signals: EV_SIGNALS.slice(),
    },
    patch || {}
  );
}

test.describe('詐騙偵測:normalizeScamEvidence 的新欄位', () => {
  test('normalizeScamEvidence:掛在 TCLCore 匯出(選項頁與 background 都要能單獨驗一筆證據)', () => {
    assert.equal(
      typeof C.normalizeScamEvidence,
      'function',
      'normalizeScamEvidence 應掛在 TCLCore 匯出'
    );
  });

  test('normalizeScamEvidence:四個新欄位原樣留下，三個網址都走 normalizePostUrl', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    const out = C.normalizeScamEvidence(richEvidence());
    assert.deepEqual(out, {
      postUrl: EV_PAGE_URL,
      snippet: EV_SNIPPET,
      at: 1700000100000,
      anchorPostUrl: EV_ANCHOR_URL,
      threadUrl: EV_THREAD_URL,
      anchorMatch: EV_ANCHOR_TEXT,
      signals: EV_SIGNALS,
    });
  });

  test('normalizeScamEvidence:三個網址的容尾變體(尾斜線／query／hash)一律正規化成乾淨網址', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    const out = C.normalizeScamEvidence(
      richEvidence({
        postUrl: EV_PAGE_URL + '/?xmt=AQGzabcdef',
        anchorPostUrl: EV_ANCHOR_URL + '?xmt=AQGzabcdef',
        threadUrl: EV_THREAD_URL + '#comments',
      })
    );
    assert.equal(out.postUrl, EV_PAGE_URL, 'postUrl 去 query/尾斜線');
    assert.equal(out.anchorPostUrl, EV_ANCHOR_URL, 'anchorPostUrl 同樣走 normalizePostUrl');
    assert.equal(out.threadUrl, EV_THREAD_URL, 'threadUrl 同樣走 normalizePostUrl');
  });

  test('normalizeScamEvidence:不合法的 anchorPostUrl／threadUrl 只剝該欄，整筆證據照留', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    const bads = [
      'https://evil.example/@example_author/post/DxSyNtH0002',
      'https://www.threads.com/@example_author',
      'javascript:alert(1)',
      '',
      42,
      null,
      {},
    ];
    for (const bad of bads) {
      const label = JSON.stringify(String(bad));

      const a = C.normalizeScamEvidence(richEvidence({ anchorPostUrl: bad }));
      assert.ok(a, 'anchorPostUrl=' + label + ' 不得讓整筆證據被丟掉');
      assert.equal(
        Object.prototype.hasOwnProperty.call(a, 'anchorPostUrl'),
        false,
        'anchorPostUrl=' + label + ' 應整欄剝除(不是補 null/空字串)'
      );
      assert.equal(a.postUrl, EV_PAGE_URL, '剝欄不得波及 postUrl');
      assert.equal(a.threadUrl, EV_THREAD_URL, '剝欄不得波及同筆的其他新欄位');

      const t = C.normalizeScamEvidence(richEvidence({ threadUrl: bad }));
      assert.ok(t, 'threadUrl=' + label + ' 不得讓整筆證據被丟掉');
      assert.equal(
        Object.prototype.hasOwnProperty.call(t, 'threadUrl'),
        false,
        'threadUrl=' + label + ' 應整欄剝除'
      );
      assert.equal(t.anchorPostUrl, EV_ANCHOR_URL, '剝欄不得波及同筆的其他新欄位');
    }
  });

  test('normalizeScamEvidence:postUrl 與 at 仍是必要欄位，不合法整筆回 null(行為不變)', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    assert.equal(
      C.normalizeScamEvidence(richEvidence({ postUrl: 'https://evil.example/x' })),
      null,
      'postUrl 不合法時整筆丟棄——新欄位再齊全也救不回一筆來源不明的證據'
    );
    assert.equal(C.normalizeScamEvidence(richEvidence({ at: 'now' })), null, 'at 非數字整筆丟棄');
    assert.equal(C.normalizeScamEvidence(null), null);
    assert.equal(C.normalizeScamEvidence('nope'), null);
  });

  test('normalizeScamEvidence:signals 只留白名單值，順序照 link|line|group|join|pitch 且去重', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    const out = C.normalizeScamEvidence(
      richEvidence({ signals: ['link', 'evil', 'line', 42, null, 'group', '', 'PITCH', 'join', 'pitch'] })
    );
    assert.deepEqual(
      out.signals,
      ['link', 'line', 'group', 'join', 'pitch'],
      'signals 逐項過白名單(link|line|group|join|pitch)，其餘剝除;大小寫不放寬'
    );
  });

  test('normalizeScamEvidence:signals 非陣列或全被剝光時整欄剝除，不留空陣列', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    for (const bad of ['line', 42, null, {}, ['evil', 'nope']]) {
      const out = C.normalizeScamEvidence(richEvidence({ signals: bad }));
      assert.ok(out, 'signals=' + JSON.stringify(String(bad)) + ' 不得讓整筆證據被丟掉');
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, 'signals'),
        false,
        'signals=' + JSON.stringify(String(bad)) + ' 應整欄剝除;留一個空陣列會讓證據卡畫出一排沒有 chip 的空白'
      );
    }
  });

  test('normalizeScamEvidence:anchorMatch 剝控制字元、硬裁 40 字;非字串整欄剝除', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    // 控制/bidi 字元用碼位組出，原始碼保持全 ASCII(見檔頭紀律)。
    const dirty = 'LINE' + cp(0x202e) + '：ab12cd' + cp(0x0007);
    assert.equal(
      C.normalizeScamEvidence(richEvidence({ anchorMatch: dirty })).anchorMatch,
      EV_ANCHOR_TEXT,
      'anchorMatch 會進選項頁 DOM，控制/bidi 字元一律剝掉'
    );

    assert.equal(
      C.normalizeScamEvidence(richEvidence({ anchorMatch: 'L'.repeat(80) })).anchorMatch.length,
      40,
      'anchorMatch 硬裁 40 字(儲存端保證，選項頁不必再截)'
    );
    assert.equal(
      C.normalizeScamEvidence(richEvidence({ anchorMatch: 'L'.repeat(40) })).anchorMatch.length,
      40,
      '恰 40 字不得誤裁'
    );

    for (const bad of [42, null, {}, []]) {
      const out = C.normalizeScamEvidence(richEvidence({ anchorMatch: bad }));
      assert.ok(out, 'anchorMatch=' + JSON.stringify(String(bad)) + ' 不得讓整筆證據被丟掉');
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, 'anchorMatch'),
        false,
        'anchorMatch 非字串應整欄剝除'
      );
    }
  });

  test('normalizeScamEvidence:舊形狀(只有 postUrl/snippet/at)原樣通過，不補出新欄位的空殼', () => {
    assert.equal(typeof C.normalizeScamEvidence, 'function', 'normalizeScamEvidence 應掛在 TCLCore 匯出');
    const out = C.normalizeScamEvidence({ postUrl: EV_PAGE_URL, snippet: '賴：ex01abc', at: 5 });
    assert.deepEqual(
      out,
      { postUrl: EV_PAGE_URL, snippet: '賴：ex01abc', at: 5 },
      '舊證據照舊只有三欄——選項頁靠「鍵在不在」決定畫不畫，補空殼會畫出空連結'
    );
  });

  test('normalizeScamBlocklist:條目內的舊證據與新證據可以並存，各自保留自己有的欄位', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      entries: {
        '10000000001': {
          handle: 'example_author',
          evidence: [richEvidence(), { postUrl: EV_OTHER_ANCHOR_URL, snippet: 'old', at: 1 }],
          addedAt: 1,
        },
      },
    });
    const kept = out.entries['10000000001'].evidence;
    assert.equal(kept.length, 2, '新舊證據並存，兩筆都要留');
    assert.equal(kept[0].anchorPostUrl, EV_ANCHOR_URL, '新證據保留 anchorPostUrl');
    assert.equal(
      Object.prototype.hasOwnProperty.call(kept[1], 'anchorPostUrl'),
      false,
      '舊證據不得被補出新欄位'
    );
  });
});

test.describe('詐騙偵測:證據去重鍵改為 anchorPostUrl || postUrl', () => {
  // 同一串被重掃(使用者從不同篇進入詳情頁)時，postUrl 會是不同的一頁，但錨
  // 點篇永遠是同一篇。去重鍵若還綁 postUrl，同一次招攬會被記成好幾筆證據，
  // 三筆額度一下就被同一串吃光。
  test('mergeBlocklistEvidence:anchorPostUrl 相同時視為同一篇，即使 postUrl 不同也不重複入列', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    const entry = {
      handle: 'example_author',
      evidence: [richEvidence({ postUrl: EV_PAGE_URL, at: 100 })],
      addedAt: 100,
      source: 'auto',
    };
    const merged = C.mergeBlocklistEvidence(
      entry,
      richEvidence({ postUrl: EV_ANCHOR_URL, at: 900 })
    );
    assert.equal(
      merged.evidence.length,
      1,
      '去重鍵是 anchorPostUrl:同一篇錨點只算一筆證據，不因使用者從哪一篇進來而分裂'
    );
    assert.equal(entry.evidence.length, 1, '純函式:不得就地改寫傳入的條目');
  });

  test('mergeBlocklistEvidence:anchorPostUrl 不同時各記一筆，即使 postUrl 相同', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    const entry = {
      handle: 'example_author',
      evidence: [richEvidence({ at: 100 })],
      addedAt: 100,
      source: 'auto',
    };
    const merged = C.mergeBlocklistEvidence(
      entry,
      richEvidence({ anchorPostUrl: EV_OTHER_ANCHOR_URL, at: 900 })
    );
    assert.equal(merged.evidence.length, 2, '兩篇不同的錨點篇是兩筆證據');
    assert.deepEqual(
      merged.evidence.map((e) => e.at),
      [900, 100],
      '依 at 降冪'
    );
  });

  test('mergeBlocklistEvidence:缺 anchorPostUrl 的一側退回 postUrl 當鍵(新舊證據互相認得出同一篇)', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    // 舊證據只有 postUrl = 錨點篇;新證據帶 anchorPostUrl 指向同一篇。
    const entry = {
      handle: 'example_author',
      evidence: [{ postUrl: EV_ANCHOR_URL, snippet: 'old', at: 100 }],
      addedAt: 100,
      source: 'auto',
    };
    const merged = C.mergeBlocklistEvidence(
      entry,
      richEvidence({ postUrl: EV_PAGE_URL, anchorPostUrl: EV_ANCHOR_URL, at: 900 })
    );
    assert.equal(
      merged.evidence.length,
      1,
      '舊證據的 postUrl 與新證據的 anchorPostUrl 指向同一篇，不得記成兩筆'
    );
  });

  test('mergeBlocklistEvidence:併入的新證據四個欄位一併落盤', () => {
    assert.equal(typeof C.mergeBlocklistEvidence, 'function', 'mergeBlocklistEvidence 應掛在 TCLCore 匯出');
    const entry = {
      handle: 'example_author',
      evidence: [{ postUrl: EV_OTHER_ANCHOR_URL, snippet: 'old', at: 100 }],
      addedAt: 100,
      source: 'auto',
    };
    const added = C.mergeBlocklistEvidence(entry, richEvidence({ at: 900 })).evidence[0];
    assert.equal(added.anchorPostUrl, EV_ANCHOR_URL);
    assert.equal(added.threadUrl, EV_THREAD_URL);
    assert.equal(added.anchorMatch, EV_ANCHOR_TEXT);
    assert.deepEqual(added.signals, EV_SIGNALS);
  });
});

test.describe('詐騙偵測:capScamEvidence／scamEntryBytes 與新欄位', () => {
  test('capScamEvidence:掛在 TCLCore 匯出', () => {
    assert.equal(typeof C.capScamEvidence, 'function', 'capScamEvidence 應掛在 TCLCore 匯出');
  });

  test('capScamEvidence:留最新三筆且四個新欄位原樣帶過，snippet 仍硬裁 120', () => {
    assert.equal(typeof C.capScamEvidence, 'function', 'capScamEvidence 應掛在 TCLCore 匯出');
    const list = [1, 2, 3, 4].map((i) =>
      richEvidence({
        postUrl: 'https://www.threads.com/@example_author/post/DxSyNtH000' + i,
        anchorPostUrl: 'https://www.threads.com/@example_author/post/DxSyNtA000' + i,
        snippet: 'S'.repeat(300),
        at: i * 100,
      })
    );
    const kept = C.capScamEvidence(list);
    assert.equal(kept.length, 3, '每位作者仍只留三筆證據');
    assert.deepEqual(
      kept.map((e) => e.at),
      [400, 300, 200],
      '保留最新三筆且依 at 降冪'
    );
    kept.forEach((e) => {
      assert.equal(e.snippet.length, 120, 'snippet 仍硬裁 120 字');
      assert.equal(
        e.anchorPostUrl,
        'https://www.threads.com/@example_author/post/DxSyNtA000' + e.at / 100,
        'anchorPostUrl 不得在裁切時被丟掉'
      );
      assert.equal(e.threadUrl, EV_THREAD_URL, 'threadUrl 不得在裁切時被丟掉');
      assert.equal(e.anchorMatch, EV_ANCHOR_TEXT, 'anchorMatch 不得在裁切時被丟掉');
      assert.deepEqual(e.signals, EV_SIGNALS, 'signals 不得在裁切時被丟掉');
    });
  });

  test('capScamEvidence:舊形狀證據裁切後仍只有三欄，不得補出新欄位', () => {
    assert.equal(typeof C.capScamEvidence, 'function', 'capScamEvidence 應掛在 TCLCore 匯出');
    const kept = C.capScamEvidence([{ postUrl: EV_PAGE_URL, snippet: 'old', at: 7 }]);
    assert.deepEqual(kept, [{ postUrl: EV_PAGE_URL, snippet: 'old', at: 7 }]);
  });

  test('capScamBlocklist:整包裁切走完一輪後，新欄位仍在(正規化與裁切都不得吃掉它們)', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.capScamBlocklist({
      entries: {
        '10000000001': {
          handle: 'example_author',
          displayName: 'Example Author',
          evidence: [richEvidence()],
          addedAt: 1700000100000,
          source: 'auto',
        },
      },
    });
    const ev = out.entries['10000000001'].evidence[0];
    assert.equal(ev.anchorPostUrl, EV_ANCHOR_URL);
    assert.equal(ev.threadUrl, EV_THREAD_URL);
    assert.equal(ev.anchorMatch, EV_ANCHOR_TEXT);
    assert.deepEqual(ev.signals, EV_SIGNALS);
  });

  test('scamEntryBytes:掛在 TCLCore 匯出，且估算把新欄位一起算進去', () => {
    assert.equal(typeof C.scamEntryBytes, 'function', 'scamEntryBytes 應掛在 TCLCore 匯出');
    const lean = {
      handle: 'example_author',
      evidence: [{ postUrl: EV_PAGE_URL, snippet: 'x', at: 1 }],
      addedAt: 1,
      source: 'auto',
    };
    const rich = {
      handle: 'example_author',
      evidence: [richEvidence({ snippet: 'x', at: 1 })],
      addedAt: 1,
      source: 'auto',
    };
    const leanBytes = C.scamEntryBytes('10000000001', lean);
    const richBytes = C.scamEntryBytes('10000000001', rich);
    assert.equal(typeof leanBytes, 'number');
    assert.ok(
      richBytes > leanBytes,
      '新欄位佔的位元組必須計入，否則 2MB 軟預算會低估、先爆的是 storage 配額而不是預算'
    );
    // 四個新欄位的序列化長度是可算的下界:估算不得只多算一點意思意思。
    const delta = evUtf8(JSON.stringify(rich)) - evUtf8(JSON.stringify(lean));
    assert.equal(
      richBytes - leanBytes,
      delta,
      '兩者的差額應等於條目序列化後的實際 UTF-8 位元組差(估算以 JSON.stringify 全量計)'
    );
  });
});

test.describe('詐騙偵測:makeBlocklistEntry 帶新欄位', () => {
  test('makeBlocklistEntry:一次命中的四個新欄位要寫進 evidence[0]', () => {
    assert.equal(typeof C.makeBlocklistEntry, 'function', 'makeBlocklistEntry 應掛在 TCLCore 匯出');
    const entry = C.makeBlocklistEntry({
      handle: 'example_author',
      displayName: 'Example Author',
      postUrl: EV_PAGE_URL,
      snippet: EV_SNIPPET,
      at: 1700000100000,
      anchorPostUrl: EV_ANCHOR_URL,
      threadUrl: EV_THREAD_URL,
      anchorMatch: EV_ANCHOR_TEXT,
      signals: EV_SIGNALS.slice(),
      source: 'auto',
    });
    assert.equal(entry.evidence.length, 1);
    assert.deepEqual(entry.evidence[0], {
      postUrl: EV_PAGE_URL,
      snippet: EV_SNIPPET,
      at: 1700000100000,
      anchorPostUrl: EV_ANCHOR_URL,
      threadUrl: EV_THREAD_URL,
      anchorMatch: EV_ANCHOR_TEXT,
      signals: EV_SIGNALS,
    });
  });

  test('makeBlocklistEntry:命中沒帶新欄位時 evidence[0] 維持舊三欄形狀', () => {
    assert.equal(typeof C.makeBlocklistEntry, 'function', 'makeBlocklistEntry 應掛在 TCLCore 匯出');
    const entry = C.makeBlocklistEntry({
      handle: 'example_author',
      postUrl: EV_PAGE_URL,
      snippet: 'x',
      at: 5,
      source: 'auto',
    });
    assert.deepEqual(entry.evidence[0], { postUrl: EV_PAGE_URL, snippet: 'x', at: 5 });
  });
});

// ============================================================
// 詐騙偵測:證據的 postedAt(貼文發布時間)
//
// 【為什麼要】證據原本只有 at＝「掃到的時間」。使用者在證據卡上想知道的是
// 「這篇招攬貼文是什麼時候發的」——同一位作者去年貼的跟上週貼的，判斷份量
// 完全不同，而掃描時間只反映使用者什麼時候剛好滑到那一頁。
//
// 【契約】選填、有限數字才留，其餘整欄剝除(比照另外四欄:剝欄不剝筆)。
// 缺席時不補鍵——選項頁靠「鍵在不在」決定要不要退回 at。
// ============================================================

const EV_POSTED_AT = 1789700000000;

test.describe('詐騙偵測:normalizeScamEvidence 的 postedAt', () => {
  test('normalizeScamEvidence:postedAt 為有限數字時原樣留下', () => {
    const out = C.normalizeScamEvidence(richEvidence({ postedAt: EV_POSTED_AT }));
    assert.equal(out.postedAt, EV_POSTED_AT, '貼文發布時間原樣落盤');
    assert.equal(out.at, 1700000100000, 'at(掃到的時間)是另一欄，兩者不得互相取代');
  });

  test('normalizeScamEvidence:postedAt 非有限數字時整欄剝除，整筆證據照留', () => {
    for (const bad of ['2026-09-18', NaN, Infinity, null, {}, [], true]) {
      const out = C.normalizeScamEvidence(richEvidence({ postedAt: bad }));
      assert.ok(out, 'postedAt=' + JSON.stringify(String(bad)) + ' 不得讓整筆證據被丟掉');
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, 'postedAt'),
        false,
        'postedAt 非有限數字應整欄剝除(不是補 null/0)'
      );
      assert.equal(out.at, 1700000100000, '剝欄不得波及 at');
    }
  });

  test('normalizeScamEvidence:沒帶 postedAt 的證據不得被補出這一欄', () => {
    const out = C.normalizeScamEvidence({ postUrl: EV_PAGE_URL, snippet: 'x', at: 5 });
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, 'postedAt'),
      false,
      '缺席就不補鍵——選項頁靠「鍵在不在」決定要不要退回 at'
    );
  });

  test('capScamEvidence:裁切時 postedAt 一併帶過', () => {
    const kept = C.capScamEvidence([
      richEvidence({ snippet: 'S'.repeat(300), at: 100, postedAt: EV_POSTED_AT }),
    ]);
    assert.equal(kept[0].postedAt, EV_POSTED_AT, 'postedAt 不得在裁切時被丟掉');
    assert.equal(kept[0].snippet.length, 120, '前置:snippet 仍硬裁 120');
  });

  test('makeBlocklistEntry:一次命中的 postedAt 要寫進 evidence[0]', () => {
    const entry = C.makeBlocklistEntry({
      handle: 'example_author',
      postUrl: EV_PAGE_URL,
      snippet: 'x',
      at: 5,
      postedAt: EV_POSTED_AT,
      source: 'auto',
    });
    assert.equal(entry.evidence[0].postedAt, EV_POSTED_AT);
  });

  test('mergeBlocklistEvidence:併入的新證據帶著自己的 postedAt', () => {
    const entry = {
      handle: 'example_author',
      evidence: [{ postUrl: EV_OTHER_ANCHOR_URL, snippet: 'old', at: 100 }],
      addedAt: 100,
      source: 'auto',
    };
    const added = C.mergeBlocklistEvidence(entry, richEvidence({ at: 900, postedAt: EV_POSTED_AT }))
      .evidence[0];
    assert.equal(added.postedAt, EV_POSTED_AT);
  });

  test('scamEntryBytes:postedAt 佔的位元組要計入', () => {
    const lean = {
      handle: 'example_author',
      evidence: [{ postUrl: EV_PAGE_URL, snippet: 'x', at: 1 }],
      addedAt: 1,
      source: 'auto',
    };
    const withPosted = {
      handle: 'example_author',
      evidence: [{ postUrl: EV_PAGE_URL, snippet: 'x', at: 1, postedAt: EV_POSTED_AT }],
      addedAt: 1,
      source: 'auto',
    };
    assert.equal(
      C.scamEntryBytes('10000000001', withPosted) - C.scamEntryBytes('10000000001', lean),
      evUtf8(JSON.stringify(withPosted)) - evUtf8(JSON.stringify(lean)),
      '差額應等於條目序列化後的實際 UTF-8 位元組差'
    );
  });
});

// ============================================================
// 車道 A(計畫 D36／D37):警示名單本機 v2 形狀、v1 遷移、雲端 mark 互轉與合併
// ============================================================
//
// v1 的名單把「已封鎖」與「已解除」拆成 entries 與 allowlist 兩張表，解除時
// 條目連同證據一起被刪掉——證據沒了就無法在多裝置之間對帳，使用者反悔復原
// 時卡片也是空的。v2 收斂成單一張 entries:一位作者一筆條目，用 state 分
// 「active／dismissed」兩態，解除只翻狀態、證據照留。
//
// 【派生唯讀視圖】既有讀者(content script 的 releaseAllowlistedScan、選項頁
// 的「已解除」小節、background 判斷作者是否解除過)都查 list.allowlist。
// normalizeScamBlocklist 因此在輸出上另掛一份由 dismissed 條目派生的
// allowlist 視圖 { [userId]: { at: dismissedAt || 0, handle } }，讓那些讀者零
// 改動。它只存在於記憶體:capScamBlocklist 寫回 storage 的物件只有
// version／entries／handleIndex 三把鍵，落盤的資料不得有兩份真相。
//
// 【雲端形狀】本機 entry 與雲端 mark 不同形:mark 的鍵帶 threads: 前綴，證據
// 只留可跨裝置對帳的欄位(anchorPostUrl／threadUrl／signals／at／postedAt／
// rulesVersion／deviceId)，剝掉 snippet／anchorMatch／postUrl——前兩者是這台
// 裝置當下看到的原文與高亮位置(他人貼文的內容，不該離開本機),postUrl 則是
// 「使用者從哪一頁看到的」，換台裝置沒有意義。
//
// 合成資料沿用 example_author／10000000001／DxSyNtH000x。
// ============================================================

const MK_ID = '10000000001';
const MK_ID_2 = '10000000002';
const MK_ID_3 = '10000000003';
const MK_HANDLE = 'Example_Author';
const MK_HANDLE_KEY = 'example_author';
const MK_PAGE_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const MK_ANCHOR_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0002';
const MK_OTHER_ANCHOR_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0003';
const MK_THIRD_ANCHOR_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0004';
const MK_FOURTH_ANCHOR_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0005';
const MK_THREAD_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const MK_SNIPPET = '想多一個地方交流可以加 LINE：ab12cd，我把你拉進群組';
const MK_ANCHOR_TEXT = 'LINE：ab12cd';
const MK_DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const MK_DEVICE_ID_2 = '99999999-8888-4777-8666-555555555555';

const mkHas = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const mkSnap = (value) => JSON.stringify(value);

// 本機形狀的一筆證據(已含 v2 新增的 rulesVersion／deviceId)。
function mkEvidence(patch) {
  return Object.assign(
    {
      postUrl: MK_PAGE_URL,
      snippet: MK_SNIPPET,
      at: 1700000100000,
      anchorPostUrl: MK_ANCHOR_URL,
      threadUrl: MK_THREAD_URL,
      anchorMatch: MK_ANCHOR_TEXT,
      signals: ['line', 'group'],
      postedAt: 1700000000000,
      rulesVersion: 3,
      deviceId: MK_DEVICE_ID,
    },
    patch || {}
  );
}

// v2 形狀的一筆條目。
function mkEntry(patch) {
  return Object.assign(
    {
      state: 'active',
      handle: MK_HANDLE,
      displayName: 'Example Author',
      source: 'auto',
      evidence: [mkEvidence()],
      addedAt: 1700000100000,
      updatedAt: 1700000100000,
    },
    patch || {}
  );
}

test.describe('警示名單 v2:normalizeScamBlocklist 的形狀與派生 allowlist', () => {
  test('normalizeScamBlocklist:v2 輸入回 version 2，兩態條目各自保留 state／updatedAt／dismissedAt', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry({ addedAt: 100, updatedAt: 900 }),
        [MK_ID_2]: mkEntry({
          state: 'dismissed',
          dismissedAt: 2000,
          handle: 'Other_Author',
          evidence: [],
          addedAt: 300,
          updatedAt: 2000,
        }),
      },
      handleIndex: { stale: '999' },
    });

    assert.equal(out.version, 2, 'v2 輸入的 version 維持 2');
    assert.equal(out.entries[MK_ID].state, 'active');
    assert.equal(out.entries[MK_ID].updatedAt, 900, 'updatedAt 是合併的判準，不得被 addedAt 取代');
    assert.equal(mkHas(out.entries[MK_ID], 'dismissedAt'), false, 'active 條目不得補出 dismissedAt');
    assert.equal(out.entries[MK_ID_2].state, 'dismissed');
    assert.equal(out.entries[MK_ID_2].dismissedAt, 2000);
    assert.equal(out.entries[MK_ID_2].updatedAt, 2000);
  });

  test('normalizeScamBlocklist:allowlist 是 dismissed 條目派生的唯讀視圖 { at, handle }', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry(),
        [MK_ID_2]: mkEntry({
          state: 'dismissed',
          dismissedAt: 2000,
          handle: 'Other_Author',
          evidence: [],
          updatedAt: 2000,
        }),
        [MK_ID_3]: mkEntry({ state: 'dismissed', handle: 'Third_Author', evidence: [], updatedAt: 5 }),
      },
    });

    assert.deepEqual(
      out.allowlist,
      { [MK_ID_2]: { at: 2000, handle: 'Other_Author' }, [MK_ID_3]: { at: 0, handle: 'Third_Author' } },
      'allowlist 只含 dismissed 條目，at 取 dismissedAt，缺席退 0'
    );
    assert.equal(mkHas(out.allowlist, MK_ID), false, 'active 條目不得出現在 allowlist 視圖');
  });

  test('normalizeScamBlocklist:handleIndex 只含 active——dismissed 不得佔住反查鍵', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry({ handle: MK_HANDLE }),
        [MK_ID_2]: mkEntry({
          state: 'dismissed',
          dismissedAt: 9000,
          handle: 'Other_Author',
          evidence: [],
          updatedAt: 9000,
        }),
      },
    });

    assert.deepEqual(out.handleIndex, { [MK_HANDLE_KEY]: MK_ID }, 'handleIndex 只由 active 條目重建');
    assert.equal(mkHas(out.handleIndex, 'other_author'), false, 'dismissed 條目不進 handleIndex');
  });

  test('normalizeScamBlocklist:v2 輸入冪等——再正規化一次結果完全相同', () => {
    const once = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry({ addedAt: 100, updatedAt: 900 }),
        [MK_ID_2]: mkEntry({
          state: 'dismissed',
          dismissedAt: 2000,
          handle: 'Other_Author',
          evidence: [],
          updatedAt: 2000,
        }),
      },
    });
    const twice = C.normalizeScamBlocklist(once);
    assert.deepEqual(twice, once, 'v2 輸出餵回去必須原樣還原(含派生的 allowlist 視圖)');
  });

  test('normalizeScamBlocklist:純函式——不得就地改寫傳入的 storage 物件', () => {
    const raw = {
      version: 1,
      entries: { [MK_ID]: { handle: MK_HANDLE, evidence: [mkEvidence()], addedAt: 100, source: 'auto' } },
      allowlist: { [MK_ID_2]: { at: 700, handle: 'Other_Author' } },
    };
    const before = mkSnap(raw);
    C.normalizeScamBlocklist(raw);
    assert.equal(mkSnap(raw), before, 'normalizeScamBlocklist 不得改動輸入');
  });
});

test.describe('警示名單 v2:v1 遷移', () => {
  test('v1 遷移:只有 entries——升成 state active,updatedAt 取 addedAt', () => {
    const out = C.normalizeScamBlocklist({
      version: 1,
      entries: {
        [MK_ID]: {
          handle: MK_HANDLE,
          displayName: 'Example Author',
          evidence: [mkEvidence()],
          addedAt: 100,
          source: 'auto',
        },
      },
      handleIndex: { [MK_HANDLE_KEY]: MK_ID },
      allowlist: {},
    });

    assert.equal(out.version, 2, 'v1 讀回時就地升版成 2');
    assert.equal(out.entries[MK_ID].state, 'active', '舊 entries 一律是 active');
    assert.equal(out.entries[MK_ID].addedAt, 100);
    assert.equal(out.entries[MK_ID].updatedAt, 100, 'v1 沒有 updatedAt，遷移時取 addedAt');
    assert.equal(mkHas(out.entries[MK_ID], 'dismissedAt'), false);
    assert.equal(out.entries[MK_ID].evidence.length, 1, '證據照留');
    assert.deepEqual(out.allowlist, {}, '沒有 dismissed 條目時派生視圖為空');
    assert.equal(out.handleIndex[MK_HANDLE_KEY], MK_ID);
  });

  test('v1 遷移:只有 allowlist——升成 dismissed 條目，evidence 空、三個時戳對齊解除時間', () => {
    const out = C.normalizeScamBlocklist({
      version: 1,
      entries: {},
      allowlist: { [MK_ID]: { at: 700, handle: MK_HANDLE }, [MK_ID_2]: true },
    });

    assert.equal(out.version, 2);
    const entry = out.entries[MK_ID];
    assert.ok(entry, 'v1 的 allowlist 必須升成 entries 裡的一筆 dismissed 條目');
    assert.equal(entry.state, 'dismissed');
    assert.equal(entry.dismissedAt, 700);
    assert.equal(entry.updatedAt, 700);
    assert.equal(entry.addedAt, 700, '舊解除紀錄沒有首見時間，只能取解除時間');
    assert.deepEqual(entry.evidence, [], 'v1 解除時證據已被刪，遷移補不回來');
    assert.equal(entry.source, 'auto');
    assert.equal(entry.handle, MK_HANDLE);

    assert.equal(out.entries[MK_ID_2].state, 'dismissed', '舊值 true 同樣升成 dismissed 條目');
    assert.equal(out.entries[MK_ID_2].dismissedAt, 0, 'true 沒有時間，退 0');

    assert.deepEqual(out.handleIndex, {}, 'dismissed 不進 handleIndex');
    assert.deepEqual(out.allowlist, {
      [MK_ID]: { at: 700, handle: MK_HANDLE },
      [MK_ID_2]: { at: 0, handle: '' },
    });
  });

  test('v1 遷移:同 userId 同時在 entries 與 allowlist 時以 dismissed 為準', () => {
    const out = C.normalizeScamBlocklist({
      version: 1,
      entries: {
        [MK_ID]: { handle: MK_HANDLE, evidence: [mkEvidence()], addedAt: 100, source: 'auto' },
      },
      handleIndex: { [MK_HANDLE_KEY]: MK_ID },
      allowlist: { [MK_ID]: { at: 700, handle: MK_HANDLE } },
    });

    assert.equal(Object.keys(out.entries).length, 1, '同一位作者只能有一筆條目，不得分裂成兩筆');
    assert.equal(out.entries[MK_ID].state, 'dismissed', '使用者解除過就是解除過，不得被舊 entries 復活');
    assert.equal(out.entries[MK_ID].dismissedAt, 700);
    assert.equal(out.entries[MK_ID].updatedAt, 700);
    assert.equal(mkHas(out.handleIndex, MK_HANDLE_KEY), false, 'dismissed 不得留在 handleIndex');
    assert.deepEqual(out.allowlist, { [MK_ID]: { at: 700, handle: MK_HANDLE } });
  });

  test('v1 遷移:無 version 的舊資料視同 v1', () => {
    const out = C.normalizeScamBlocklist({
      entries: { [MK_ID]: { handle: MK_HANDLE, evidence: [], addedAt: 100, source: 'auto' } },
      allowlist: { [MK_ID_2]: { at: 700, handle: 'Other_Author' } },
    });
    assert.equal(out.version, 2);
    assert.equal(out.entries[MK_ID].state, 'active');
    assert.equal(out.entries[MK_ID].updatedAt, 100);
    assert.equal(out.entries[MK_ID_2].state, 'dismissed');
  });

  test('v1 遷移:遷移後再遷移一次冪等', () => {
    const raw = {
      version: 1,
      entries: { [MK_ID]: { handle: MK_HANDLE, evidence: [mkEvidence()], addedAt: 100, source: 'auto' } },
      allowlist: { [MK_ID_2]: { at: 700, handle: 'Other_Author' } },
    };
    const once = C.normalizeScamBlocklist(raw);
    assert.deepEqual(C.normalizeScamBlocklist(once), once, '遷移一次之後就穩定，不得每次讀回都再動一次');
  });
});

test.describe('警示名單 v2:capScamBlocklist', () => {
  // 造 n 筆 v2 條目:updatedAt 由舊到新(1..n),addedAt 刻意反向(n..1)——淘汰
  // 序若還看 addedAt，留下來的會是完全相反的一批。
  function mkV2List(n, opts) {
    const cfg = opts || {};
    const entries = {};
    for (let i = 1; i <= n; i++) {
      const id = String(20000000000 + i);
      const evidence = [];
      for (let e = 0; e < (cfg.evidencePerEntry || 1); e++) {
        evidence.push({
          postUrl: 'https://www.threads.com/@h' + i + '/post/DxSyNtH' + e + i,
          snippet: 'S'.repeat(cfg.snippetLen || 10),
          at: i * 1000 + e,
        });
      }
      entries[id] = {
        state: cfg.state || 'active',
        handle: 'h' + i,
        displayName: 'name' + i,
        source: 'auto',
        evidence: evidence,
        addedAt: n - i + 1,
        updatedAt: i,
      };
      if ((cfg.state || 'active') === 'dismissed') entries[id].dismissedAt = i;
    }
    return { version: 2, entries: entries, handleIndex: {} };
  }

  test('capScamBlocklist:寫回 storage 的物件只有 version／entries／handleIndex 三把鍵', () => {
    const out = C.capScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry(),
        [MK_ID_2]: mkEntry({
          state: 'dismissed',
          dismissedAt: 2000,
          handle: 'Other_Author',
          evidence: [],
          updatedAt: 2000,
        }),
      },
    });
    assert.deepEqual(Object.keys(out).sort(), ['entries', 'handleIndex', 'version'], '落盤的物件不得帶派生視圖');
    assert.equal(mkHas(out, 'allowlist'), false, 'allowlist 只是記憶體視圖，不得寫進 storage');
    assert.equal(out.version, 2);
    assert.equal(out.entries[MK_ID_2].state, 'dismissed', 'dismissed 條目照樣落盤(證據要留著)');
  });

  test('capScamBlocklist:非物件／空輸入回 v2 的三欄空形狀', () => {
    for (const bad of [undefined, null, 'nope', 42, []]) {
      assert.deepEqual(
        C.capScamBlocklist(bad),
        { version: 2, entries: {}, handleIndex: {} },
        JSON.stringify(String(bad)) + ' 應回 v2 空形狀'
      );
    }
  });

  test('capScamBlocklist:筆數淘汰依 updatedAt 降冪，不看 addedAt', () => {
    const out = C.capScamBlocklist(mkV2List(5050));
    const ids = Object.keys(out.entries);
    assert.equal(ids.length, 5000, 'entries 裁到 SCAM_LIMITS.MAX_ENTRIES');
    assert.equal(mkHas(out.entries, String(20000000001)), false, 'updatedAt 最舊的先走(即使它的 addedAt 最新)');
    assert.equal(mkHas(out.entries, String(20000000050)), false);
    assert.equal(mkHas(out.entries, String(20000000051)), true, '保留 updatedAt 最新的 5000 筆');
    assert.equal(mkHas(out.entries, String(20000005050)), true);
  });

  test('capScamBlocklist:dismissed 與 active 共用同一個 5000 筆名額', () => {
    const list = mkV2List(2);
    // 兩態混排:updatedAt 最大的那筆是 dismissed，它必須跟 active 一起排序。
    list.entries[String(20000000002)].state = 'dismissed';
    list.entries[String(20000000002)].dismissedAt = 2;
    const out = C.capScamBlocklist(list);
    assert.equal(Object.keys(out.entries).length, 2, '未超量時兩態都留著');
    assert.equal(C.SCAM_LIMITS.MAX_ENTRIES, 5000, 'MAX_ENTRIES 不變，只是改成兩態共用');
    assert.equal(C.SCAM_LIMITS.MAX_ALLOWLIST, 5000, 'MAX_ALLOWLIST 廢止但常數保留');
  });

  test('capScamBlocklist:位元組預算把 dismissed 一起算進去', () => {
    // 全 dismissed、每筆三段滿版證據:筆數上限攔不住，只能靠 2MB 軟預算。
    // dismissed 若被排除在預算之外，這份名單會整包落盤而爆掉配額。
    const out = C.capScamBlocklist(mkV2List(4000, { state: 'dismissed', evidencePerEntry: 3, snippetLen: 120 }));
    const ids = Object.keys(out.entries);
    assert.equal(ids.length < 4000, true, 'dismissed 也要被軟預算淘汰，實得 ' + ids.length + ' 筆');
    assert.equal(ids.length > 0, true, '不得把整份名單清空');
    assert.equal(Buffer.byteLength(JSON.stringify(out), 'utf8') <= 2 * 1024 * 1024, true, '整包不得超過 2MB');
    assert.equal(mkHas(out.entries, String(20000004000)), true, 'updatedAt 最新的一筆永遠留著');
  });

  test('capScamBlocklist:v1 輸入一併遷移後才裁切', () => {
    const out = C.capScamBlocklist({
      version: 1,
      entries: { [MK_ID]: { handle: MK_HANDLE, evidence: [mkEvidence()], addedAt: 100, source: 'auto' } },
      allowlist: { [MK_ID_2]: { at: 700, handle: 'Other_Author' } },
    });
    assert.equal(out.version, 2);
    assert.equal(out.entries[MK_ID].state, 'active');
    assert.equal(out.entries[MK_ID_2].state, 'dismissed', '舊 allowlist 那一筆落盤時已是 dismissed 條目');
    assert.equal(mkHas(out, 'allowlist'), false);
  });
});

// 【契約 R1】雲端 Mark 是**固定欄位**的物件，不是本機那種「缺席就不補鍵」的
// 形狀:九欄一律在(key／state／dismissedAt／handle／displayName／source／
// evidence／addedAt／updatedAt)，可空者寫 null;evidence 每筆固定七欄
// (anchorPostUrl／threadUrl／signals／at／postedAt／rulesVersion／deviceId),
// 同樣以 null 表缺席。上雲的是跨端契約，欄位在不在不該當成訊號——固定欄位讓
// 後端的 schema 與索引一次定死，本機那套「靠鍵在不在決定畫不畫」留在本機。
const MK_MARK_KEYS = [
  'addedAt',
  'dismissedAt',
  'displayName',
  'evidence',
  'handle',
  'key',
  'source',
  'state',
  'updatedAt',
];
const MK_MARK_EVIDENCE_KEYS = [
  'anchorPostUrl',
  'at',
  'deviceId',
  'postedAt',
  'rulesVersion',
  'signals',
  'threadUrl',
];

test.describe('警示名單 v2:toScamMark', () => {
  test('toScamMark:key 帶 threads: 前綴，純量欄位原樣帶出', () => {
    assert.equal(typeof C.toScamMark, 'function', 'toScamMark 應掛在 TCLCore 匯出');
    const mark = C.toScamMark(MK_ID, mkEntry({ addedAt: 100, updatedAt: 900 }));
    assert.equal(mark.key, 'threads:' + MK_ID, '雲端主鍵是 threads: 加 userId');
    assert.equal(mark.state, 'active');
    assert.equal(mark.handle, MK_HANDLE);
    assert.equal(mark.displayName, 'Example Author');
    assert.equal(mark.source, 'auto');
    assert.equal(mark.addedAt, 100);
    assert.equal(mark.updatedAt, 900);
    assert.equal(mkHas(mark, 'userId'), false, 'userId 已在 key 裡，不重複一份');
  });

  test('toScamMark:輸出固定九欄，可空者寫 null 而非缺鍵', () => {
    const mark = C.toScamMark(MK_ID, mkEntry({ displayName: undefined }));
    assert.deepEqual(Object.keys(mark).sort(), MK_MARK_KEYS, 'Mark 是固定欄位的跨端契約');
    assert.equal(mark.dismissedAt, null, 'active 的 mark 寫 dismissedAt: null，不是缺鍵');
    assert.equal(mark.displayName, null, '沒有顯示名時寫 null');
  });

  test('toScamMark:dismissed 條目帶 dismissedAt', () => {
    const mark = C.toScamMark(
      MK_ID,
      mkEntry({ state: 'dismissed', dismissedAt: 2000, evidence: [], updatedAt: 2000 })
    );
    assert.equal(mark.state, 'dismissed');
    assert.equal(mark.dismissedAt, 2000);
    assert.deepEqual(mark.evidence, [], '沒有證據時是空陣列，不是 null');
  });

  test('toScamMark:證據剝掉 snippet／anchorMatch／postUrl，只留可跨裝置對帳的七欄', () => {
    const mark = C.toScamMark(MK_ID, mkEntry({ evidence: [mkEvidence({ at: 900, postedAt: 800 })] }));
    assert.deepEqual(mark.evidence, [
      {
        anchorPostUrl: MK_ANCHOR_URL,
        threadUrl: MK_THREAD_URL,
        signals: ['line', 'group'],
        at: 900,
        postedAt: 800,
        rulesVersion: 3,
        deviceId: MK_DEVICE_ID,
      },
    ]);
    const ev = mark.evidence[0];
    assert.deepEqual(Object.keys(ev).sort(), MK_MARK_EVIDENCE_KEYS, '證據同樣是固定七欄');
    assert.equal(mkHas(ev, 'snippet'), false, 'snippet 是他人貼文原文，不上雲');
    assert.equal(mkHas(ev, 'anchorMatch'), false, 'anchorMatch 是原文片段，不上雲');
    assert.equal(mkHas(ev, 'postUrl'), false, 'postUrl 是本機這次從哪一頁看到的，換台裝置沒有意義');
  });

  test('toScamMark:缺 anchorPostUrl 的舊證據以 postUrl 當 anchorPostUrl，其餘欄位寫 null', () => {
    const lean = { postUrl: MK_PAGE_URL, snippet: MK_SNIPPET, at: 500 };
    const mark = C.toScamMark(MK_ID, mkEntry({ evidence: [lean] }));
    assert.deepEqual(
      mark.evidence,
      [
        {
          anchorPostUrl: MK_PAGE_URL,
          threadUrl: null,
          // 【斷言翻轉｜審查 F2】原斷言為 signals: null。signals 的契約型別
          // 是 string[]，缺席送空陣列;讀取端因此永遠可以直接走訪，不必先分
          // 辨 null 與陣列兩種形狀。其餘五欄是純量，照舊以 null 表缺席。
          signals: [],
          at: 500,
          postedAt: null,
          rulesVersion: null,
          deviceId: null,
        },
      ],
      '舊證據的 postUrl 就是錨點篇;純量五欄補 null、signals 補空陣列，都不缺鍵'
    );
    assert.equal(mark.evidence[0].rulesVersion, null, '舊證據沒有規則版本，寫 null 不得補 0');
    assert.deepEqual(mark.evidence[0].signals, [], 'signals 缺席送 []，不得送 null(契約型別是 string[])');
  });

  test('toScamMark:純函式——不得改動傳入的條目', () => {
    const entry = mkEntry();
    const before = mkSnap(entry);
    C.toScamMark(MK_ID, entry);
    assert.equal(mkSnap(entry), before);
  });
});

test.describe('警示名單 v2:fromScamMark', () => {
  function mkMark(patch) {
    return Object.assign(
      {
        key: 'threads:' + MK_ID,
        state: 'active',
        dismissedAt: null,
        handle: MK_HANDLE,
        displayName: 'Example Author',
        source: 'auto',
        evidence: [
          {
            anchorPostUrl: MK_ANCHOR_URL,
            threadUrl: MK_THREAD_URL,
            signals: ['line', 'group'],
            at: 900,
            postedAt: 800,
            rulesVersion: 3,
            deviceId: MK_DEVICE_ID,
          },
        ],
        addedAt: 100,
        updatedAt: 900,
      },
      patch || {}
    );
  }

  test('fromScamMark:合法 mark 還原成 { userId, entry }', () => {
    assert.equal(typeof C.fromScamMark, 'function', 'fromScamMark 應掛在 TCLCore 匯出');
    const out = C.fromScamMark(mkMark());
    assert.ok(out, '合法 mark 不得回 null');
    assert.equal(out.userId, MK_ID, 'userId 由 key 去掉 threads: 前綴而來');
    assert.equal(out.entry.state, 'active');
    assert.equal(out.entry.handle, MK_HANDLE);
    assert.equal(out.entry.displayName, 'Example Author');
    assert.equal(out.entry.source, 'auto');
    assert.equal(out.entry.addedAt, 100);
    assert.equal(out.entry.updatedAt, 900);
    assert.equal(mkHas(out.entry, 'dismissedAt'), false);
  });

  test('fromScamMark:雲端證據落回本機形狀——postUrl 退回 anchorPostUrl，新欄位保留', () => {
    const entry = C.fromScamMark(mkMark()).entry;
    assert.equal(entry.evidence.length, 1, '雲端證據沒有 postUrl，不得因此被 normalize 整筆丟掉');
    const ev = entry.evidence[0];
    assert.equal(ev.anchorPostUrl, MK_ANCHOR_URL);
    assert.equal(ev.postUrl, MK_ANCHOR_URL, 'postUrl 是本機的必要欄位，沒有就用錨點篇填');
    assert.equal(ev.at, 900);
    assert.equal(ev.postedAt, 800);
    assert.equal(ev.rulesVersion, 3);
    assert.equal(ev.deviceId, MK_DEVICE_ID);
    assert.deepEqual(ev.signals, ['line', 'group']);
  });

  test('fromScamMark:dismissed 的 mark 帶回 dismissedAt', () => {
    const out = C.fromScamMark(mkMark({ state: 'dismissed', dismissedAt: 2000, evidence: [], updatedAt: 2000 }));
    assert.equal(out.entry.state, 'dismissed');
    assert.equal(out.entry.dismissedAt, 2000);
    assert.deepEqual(out.entry.evidence, []);
  });

  // 【契約 R1】雲端是固定欄位、以 null 表缺席;本機是「缺席就不補鍵」。
  // 兩種寫法(null 與整個鍵不在)都要當成缺席——固定欄位是給後端 schema 用
  // 的，不是給本機當訊號用的，讀回來一律落成本機那套形狀。
  test('fromScamMark:null 與缺鍵都算缺席，一律不落成本機的鍵', () => {
    const withNulls = C.fromScamMark(
      mkMark({
        dismissedAt: null,
        displayName: null,
        evidence: [
          {
            anchorPostUrl: MK_ANCHOR_URL,
            threadUrl: null,
            signals: null,
            at: 900,
            postedAt: null,
            rulesVersion: null,
            deviceId: null,
          },
        ],
      })
    ).entry;
    const withMissing = C.fromScamMark(
      mkMark({
        dismissedAt: undefined,
        displayName: undefined,
        evidence: [{ anchorPostUrl: MK_ANCHOR_URL, at: 900 }],
      })
    ).entry;

    assert.deepEqual(withNulls, withMissing, 'null 與缺鍵必須落成同一份本機條目');
    assert.equal(mkHas(withNulls, 'dismissedAt'), false, 'dismissedAt: null 不得落成本機的一把鍵');
    assert.equal(mkHas(withNulls, 'displayName'), false, 'displayName: null 不得落成空字串或 null');
    for (const field of ['threadUrl', 'signals', 'postedAt', 'rulesVersion', 'deviceId']) {
      assert.equal(mkHas(withNulls.evidence[0], field), false, field + ' 為 null 時本機不補鍵');
    }
  });

  test('fromScamMark:key 不合法一律回 null', () => {
    const bads = [
      ['缺席', undefined],
      ['null', null],
      ['非物件', 'threads:10000000001'],
      ['沒有 key', mkMark({ key: undefined })],
      ['key 非字串', mkMark({ key: 10000000001 })],
      ['沒有前綴', mkMark({ key: MK_ID })],
      ['前綴不對', mkMark({ key: 'twitter:' + MK_ID })],
      ['前綴後面是空的', mkMark({ key: 'threads:' })],
      ['userId 非數字', mkMark({ key: 'threads:abcdef' })],
      ['userId 超過 20 位', mkMark({ key: 'threads:' + '1'.repeat(21) })],
      ['原型污染鍵', mkMark({ key: 'threads:__proto__' })],
    ];
    for (const bad of bads) {
      assert.equal(C.fromScamMark(bad[1]), null, bad[0] + ' 應回 null');
    }
  });

  // 【斷言翻轉｜R3-6】handle 不再走 sanitizeDisplayName 的「摺空白後照收」，
  // 改驗伺服器那把尺 ^[A-Za-z0-9._]{1,80}$，不合整筆回 null（帶空白的 handle
  // 落進 handleIndex 就是一條跨裝置的冒名管道）。displayName 的 80 字硬裁不變。
  test('fromScamMark:顯示名截到 80 字，handle 改驗形狀（R3-6）', () => {
    const out = C.fromScamMark(mkMark({ displayName: 'D'.repeat(200) }));
    assert.equal(out.entry.displayName.length, 80, '顯示名硬裁 80(DISPLAY_NAME_MAX)');
    assert.equal(out.entry.handle, MK_HANDLE, '合法 handle 原樣保留');
    assert.equal(
      C.fromScamMark(mkMark({ handle: '  Example \t\n  Author  ' })),
      null,
      '帶空白的 handle 不再被摺成合法值，整筆丟棄'
    );
  });

  test('fromScamMark:髒證據逐筆剝除，其餘欄位照留', () => {
    const out = C.fromScamMark(
      mkMark({
        evidence: [
          { anchorPostUrl: 'https://example.com/@x/post/AAA', at: 100 },
          { anchorPostUrl: MK_OTHER_ANCHOR_URL, at: 'nope' },
          { anchorPostUrl: MK_ANCHOR_URL, at: 900 },
        ],
      })
    );
    assert.equal(out.entry.evidence.length, 1, '外部網域與壞 at 的證據逐筆剝除');
    assert.equal(out.entry.evidence[0].anchorPostUrl, MK_ANCHOR_URL);
  });

  test('fromScamMark／toScamMark:往返一圈純量欄位不變', () => {
    const entry = mkEntry({ addedAt: 100, updatedAt: 900 });
    const back = C.fromScamMark(C.toScamMark(MK_ID, entry));
    assert.equal(back.userId, MK_ID);
    for (const field of ['state', 'handle', 'displayName', 'source', 'addedAt', 'updatedAt']) {
      assert.equal(back.entry[field], entry[field], field + ' 往返後不得變形');
    }
    assert.equal(back.entry.evidence.length, 1, '證據往返後仍在');
  });

  test('fromScamMark:純函式——不得改動傳入的 mark', () => {
    const mark = mkMark();
    const before = mkSnap(mark);
    C.fromScamMark(mark);
    assert.equal(mkSnap(mark), before);
  });
});

test.describe('警示名單 v2:mergeScamEntry', () => {
  test('mergeScamEntry:remote 較新時純量整組換成遠端的', () => {
    assert.equal(typeof C.mergeScamEntry, 'function', 'mergeScamEntry 應掛在 TCLCore 匯出');
    const local = mkEntry({
      state: 'active',
      handle: 'Old_Handle',
      displayName: 'Old Name',
      source: 'auto',
      addedAt: 200,
      updatedAt: 500,
      evidence: [mkEvidence({ at: 500 })],
    });
    const remote = mkEntry({
      state: 'dismissed',
      dismissedAt: 900,
      handle: 'New_Handle',
      displayName: 'New Name',
      source: 'manual',
      addedAt: 300,
      updatedAt: 900,
      evidence: [],
    });

    const out = C.mergeScamEntry(local, remote);
    assert.equal(out.state, 'dismissed');
    assert.equal(out.dismissedAt, 900);
    assert.equal(out.handle, 'New_Handle');
    assert.equal(out.displayName, 'New Name');
    assert.equal(out.source, 'manual');
    assert.equal(out.addedAt, 200, 'addedAt 取較小——首見時間不得往後跳');
    assert.equal(out.updatedAt, 900, 'updatedAt 取較大');
    assert.equal(out.evidence.length, 1, '純量落敗不影響證據聯集，本機那筆照留');
  });

  test('mergeScamEntry:local 較新時保留本機純量，且 dismissedAt 不得被遠端帶進來', () => {
    const local = mkEntry({
      state: 'active',
      handle: 'Local_Handle',
      displayName: 'Local Name',
      source: 'auto',
      addedAt: 300,
      updatedAt: 900,
      evidence: [mkEvidence({ at: 900 })],
    });
    const remote = mkEntry({
      state: 'dismissed',
      dismissedAt: 500,
      handle: 'Remote_Handle',
      displayName: 'Remote Name',
      source: 'manual',
      addedAt: 200,
      updatedAt: 500,
      evidence: [],
    });

    const out = C.mergeScamEntry(local, remote);
    assert.equal(out.state, 'active');
    assert.equal(mkHas(out, 'dismissedAt'), false, 'active 勝出時不得殘留遠端的 dismissedAt');
    assert.equal(out.handle, 'Local_Handle');
    assert.equal(out.displayName, 'Local Name');
    assert.equal(out.source, 'auto');
    assert.equal(out.addedAt, 200, 'addedAt 一律取兩邊較小的');
    assert.equal(out.updatedAt, 900);
  });

  test('mergeScamEntry:updatedAt 相等時取 local', () => {
    const local = mkEntry({ handle: 'Local_Handle', updatedAt: 900, addedAt: 100, evidence: [] });
    const remote = mkEntry({ handle: 'Remote_Handle', updatedAt: 900, addedAt: 100, evidence: [] });
    assert.equal(C.mergeScamEntry(local, remote).handle, 'Local_Handle', '平手時本機說了算');
  });

  test('mergeScamEntry:evidence 以錨點篇為鍵聯集，依 at 降冪留 3', () => {
    const local = mkEntry({
      updatedAt: 900,
      evidence: [
        mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 100 }),
        mkEvidence({ anchorPostUrl: MK_OTHER_ANCHOR_URL, at: 200 }),
      ],
    });
    const remote = mkEntry({
      updatedAt: 500,
      evidence: [
        { anchorPostUrl: MK_THIRD_ANCHOR_URL, at: 300 },
        { anchorPostUrl: MK_FOURTH_ANCHOR_URL, at: 400 },
      ],
    });

    const out = C.mergeScamEntry(local, remote);
    assert.deepEqual(
      out.evidence.map((e) => e.at),
      [400, 300, 200],
      '聯集四筆後依 at 降冪裁到 SCAM_LIMITS.MAX_EVIDENCE'
    );
    assert.deepEqual(
      out.evidence.map((e) => e.anchorPostUrl),
      [MK_FOURTH_ANCHOR_URL, MK_THIRD_ANCHOR_URL, MK_OTHER_ANCHOR_URL],
      '最舊的那筆被擠掉'
    );
  });

  test('mergeScamEntry:同一篇錨點只算一筆，本機獨有的 snippet／anchorMatch／postUrl 保留', () => {
    const local = mkEntry({
      updatedAt: 100,
      evidence: [
        {
          postUrl: MK_PAGE_URL,
          snippet: MK_SNIPPET,
          anchorMatch: MK_ANCHOR_TEXT,
          anchorPostUrl: MK_ANCHOR_URL,
          signals: ['line'],
          at: 100,
        },
      ],
    });
    const remote = mkEntry({
      updatedAt: 900,
      evidence: [
        {
          anchorPostUrl: MK_ANCHOR_URL,
          threadUrl: MK_THREAD_URL,
          signals: ['line', 'group'],
          at: 900,
          postedAt: 800,
          rulesVersion: 3,
          deviceId: MK_DEVICE_ID_2,
        },
      ],
    });

    const out = C.mergeScamEntry(local, remote);
    assert.equal(out.evidence.length, 1, '同一篇錨點貼文不得分裂成兩筆證據');
    const ev = out.evidence[0];
    assert.equal(ev.snippet, MK_SNIPPET, '雲端沒有 snippet，不得把本機的洗掉');
    assert.equal(ev.anchorMatch, MK_ANCHOR_TEXT, '雲端沒有 anchorMatch，不得把本機的洗掉');
    assert.equal(ev.postUrl, MK_PAGE_URL, '雲端沒有 postUrl，不得把本機的洗掉');
    assert.equal(ev.at, 900, '其餘欄位 LWW by at，遠端較新');
    assert.equal(ev.threadUrl, MK_THREAD_URL);
    assert.deepEqual(ev.signals, ['line', 'group']);
    assert.equal(ev.postedAt, 800);
    assert.equal(ev.rulesVersion, 3);
    assert.equal(ev.deviceId, MK_DEVICE_ID_2);
  });

  // 【審查 F1】上面那支的 remote 是手寫的 literal:剛好沒有 snippet／
  // anchorMatch／postUrl 這三把鍵。真實路徑上的遠端條目不是這個形狀——它是
  // 雲端 mark 經 fromScamMark 落回本機形狀的，而本機形狀要求 postUrl 必填、
  // snippet 至少是空字串，於是 normalizeScamEvidence 會補出 snippet:'' 與
  // postUrl＝錨點篇。兩欄都「有鍵」卻是空殼，只看「鍵在不在」的守衛因此放行，
  // 遠端一勝出就把使用者的證據片段與來源頁洗掉，證據卡當場變空白。
  test('mergeScamEntry:遠端條目走真實往返時，本機的 snippet／anchorMatch／postUrl 不得被空殼蓋掉', () => {
    // 另一台裝置的同一位作者:本機條目 → mark → 落回本機，再過一次 JSON 往返
    // (雲端來回一定會序列化)。全程不手寫 literal，守衛面對的就是真實形狀。
    const remote = JSON.parse(
      JSON.stringify(
        C.fromScamMark(
          C.toScamMark(
            MK_ID,
            C.makeBlocklistEntry({
              handle: MK_HANDLE,
              displayName: 'Example Author',
              postUrl: MK_OTHER_ANCHOR_URL,
              snippet: '另一台裝置看到的原文，不上雲',
              at: 900,
              anchorPostUrl: MK_ANCHOR_URL,
              threadUrl: MK_THREAD_URL,
              anchorMatch: '另一台裝置的高亮位置',
              signals: ['line', 'group'],
              postedAt: 800,
              rulesVersion: 3,
              deviceId: MK_DEVICE_ID_2,
              source: 'auto',
            })
          )
        ).entry
      )
    );

    // 先釘住這份 fixture 真的是空殼形狀——否則這支測試會隨著往返邏輯變形而
    // 悄悄失去意義。
    const remoteEv = remote.evidence[0];
    assert.equal(remoteEv.snippet, '', '雲端 mark 不帶 snippet，落回本機時被補成空字串');
    assert.equal(remoteEv.postUrl, MK_ANCHOR_URL, '雲端 mark 不帶 postUrl，落回本機時被補成錨點篇');
    assert.equal(mkHas(remoteEv, 'anchorMatch'), false, 'anchorMatch 不上雲，落回本機時整欄缺席');

    const local = mkEntry({
      updatedAt: 100,
      evidence: [mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 100 })],
    });

    const ev = C.mergeScamEntry(local, remote).evidence[0];
    assert.equal(ev.snippet, MK_SNIPPET, '遠端的空字串不得蓋掉本機的證據片段');
    assert.equal(ev.anchorMatch, MK_ANCHOR_TEXT, '遠端缺席的高亮位置不得把本機的清掉');
    assert.equal(ev.postUrl, MK_PAGE_URL, '遠端回填的錨點篇不得取代本機真正的來源頁');
    assert.equal(ev.at, 900, '其餘欄位照舊 LWW by at，遠端較新');
    assert.equal(ev.deviceId, MK_DEVICE_ID_2);
    assert.equal(ev.postedAt, 800);
  });

  test('mergeScamEntry:同一篇錨點但本機 at 較新時，遠端不得覆蓋本機欄位', () => {
    const local = mkEntry({
      updatedAt: 900,
      evidence: [mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 900, signals: ['line'], deviceId: MK_DEVICE_ID })],
    });
    const remote = mkEntry({
      updatedAt: 100,
      evidence: [{ anchorPostUrl: MK_ANCHOR_URL, at: 100, signals: ['pitch'], deviceId: MK_DEVICE_ID_2 }],
    });
    const ev = C.mergeScamEntry(local, remote).evidence[0];
    assert.equal(ev.at, 900);
    assert.deepEqual(ev.signals, ['line'], '本機那筆較新，LWW 由本機勝出');
    assert.equal(ev.deviceId, MK_DEVICE_ID);
  });

  test('mergeScamEntry:dismissed 勝出時證據照樣聯集保留', () => {
    const local = mkEntry({
      state: 'dismissed',
      dismissedAt: 900,
      updatedAt: 900,
      evidence: [
        mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 100 }),
        mkEvidence({ anchorPostUrl: MK_OTHER_ANCHOR_URL, at: 200 }),
      ],
    });
    const remote = mkEntry({
      state: 'active',
      updatedAt: 500,
      evidence: [{ anchorPostUrl: MK_THIRD_ANCHOR_URL, at: 300 }],
    });

    const out = C.mergeScamEntry(local, remote);
    assert.equal(out.state, 'dismissed', '解除狀態較新，合併後仍是解除');
    assert.equal(out.dismissedAt, 900);
    assert.equal(out.evidence.length, 3, '解除不等於刪證據——三筆聯集全留');
    assert.deepEqual(
      out.evidence.map((e) => e.at),
      [300, 200, 100]
    );
  });

  test('mergeScamEntry:純函式——兩邊輸入都不得被改動', () => {
    const local = mkEntry({ updatedAt: 100, evidence: [mkEvidence({ at: 100 })] });
    const remote = mkEntry({
      updatedAt: 900,
      handle: 'Remote_Handle',
      evidence: [{ anchorPostUrl: MK_OTHER_ANCHOR_URL, at: 900 }],
    });
    const beforeLocal = mkSnap(local);
    const beforeRemote = mkSnap(remote);
    const out = C.mergeScamEntry(local, remote);

    assert.equal(mkSnap(local), beforeLocal, 'local 不得被就地改寫');
    assert.equal(mkSnap(remote), beforeRemote, 'remote 不得被就地改寫');
    assert.notEqual(out.evidence, local.evidence, '輸出的證據陣列不得與輸入共用同一個參照');
    out.evidence.push({ postUrl: MK_PAGE_URL, at: 1 });
    assert.equal(local.evidence.length, 1, '改動輸出不得波及輸入');
  });
});

// ============================================================================
// R3 — 警示名單同步的縱深修補（安全審查 2026-09-22，後端契約 R3）
// ----------------------------------------------------------------------------
// 6.  `fromScamMark`：`handle` 驗形狀 `^[A-Za-z0-9._]{1,80}$`，不合整筆回 null。
//     伺服器對 handle 用的就是這把尺（見 test/mock-marks-server.test.js 的
//     normalizeMark），本機這一側不驗等於讓雲端任意字串落進 entries 與
//     handleIndex——那張反查表是河道「只查表不掃文」的依據，混進帶空白／標點
//     的假 handle 就成了跨裝置的冒名管道。
// 9.  `normalizeScamEvidence` 的 `deviceId` 改走 `normalizeDeviceId`（UUID 形
//     狀、一律小寫），不合整欄剝除。原本是 `sanitizeText(…, 64)`，任意字串都
//     放行，拿去 join 裝置清單永遠落空。
// 10. `scamMergeEvidenceKey`（雲端合併路徑）去掉 `threadUrl` 那一段，與
//     `scamEvidenceKey`（`anchorPostUrl ‖ postUrl`）對齊。兩把尺不一致時，帶
//     threadUrl 但沒有 anchorPostUrl 的本機證據跑一趟雲端往返就會裂成兩筆。
// 12. `normalizeMarksRejected` 夾筆數上限：那是寫進 syncState 的映射，沒有上
//     限就會隨著被拒的 key 無限成長，最後撐爆 storage 配額。
// 14. `normalizeBlocklistEntry`：`addedAt` 與 `updatedAt` 兩者都不合法時整筆
//     丟棄；只有一個不合法時以另一個補。兩格都補 0 的舊行為會讓一筆壞資料的
//     updatedAt 變成 0，在 LWW 合併裡永遠輸，從此無法更新也無法解除。
// ============================================================================

const MARKS_REJECTED_MAX = 5000;

test.describe('警示名單 R3:形狀閘門與合併鍵', () => {
  function r3Mark(patch) {
    return Object.assign(
      {
        key: 'threads:' + MK_ID,
        state: 'active',
        dismissedAt: null,
        handle: MK_HANDLE,
        displayName: 'Example Author',
        source: 'auto',
        evidence: [],
        addedAt: 100,
        updatedAt: 900,
      },
      patch || {}
    );
  }

  test('R3-6 fromScamMark:handle 不合 ^[A-Za-z0-9._]{1,80}$ 一律整筆回 null', () => {
    const bads = [
      ['含空白', 'Example Author'],
      ['含斜線', 'example/author'],
      ['含 @', '@example_author'],
      ['含全形字', '詐騙帳號'],
      ['含控制字元', 'example\u0000author'],
      ['含 HTML 角括號', '<b>example</b>'],
      ['超過 80 字', 'a'.repeat(81)],
      ['空字串', ''],
      ['非字串', 12345],
    ];
    for (const bad of bads) {
      assert.equal(
        C.fromScamMark(r3Mark({ handle: bad[1] })),
        null,
        'handle ' + bad[0] + ' 時整筆丟棄（落進 handleIndex 就是一條冒名管道）'
      );
    }
  });

  test('R3-6 fromScamMark:合法 handle 原樣收下，缺席（null）仍算合法', () => {
    const ok = ['example_author', 'Example.Author', 'a', '0'.repeat(80), 'a.b_c.1'];
    for (const handle of ok) {
      const out = C.fromScamMark(r3Mark({ handle }));
      assert.ok(out, 'handle=' + handle + ' 應收下');
      assert.equal(out.entry.handle, handle, '合法 handle 不得被改寫');
    }
    // 契約允許 handle 為 null（可空欄位），那不是「形狀不合」。
    const withoutHandle = C.fromScamMark(r3Mark({ handle: null }));
    assert.ok(withoutHandle, 'handle 為 null 是合法的缺席，不得整筆丟棄');
    assert.equal(mkHas(withoutHandle.entry, 'handle'), false, '缺席不落成本機的鍵');
  });

  test('R3-9 normalizeScamEvidence:deviceId 只收 UUID 形狀並轉小寫，其餘整欄剝除', () => {
    const base = { postUrl: MK_PAGE_URL, snippet: MK_SNIPPET, at: 1700000100000 };
    const upper = C.normalizeScamEvidence(Object.assign({}, base, { deviceId: MK_DEVICE_ID.toUpperCase() }));
    assert.equal(upper.deviceId, MK_DEVICE_ID, 'UUID 一律轉小寫（伺服器存小寫，不對齊就 join 不到裝置）');

    const bads = ['not-a-uuid', '', '11111111-2222-4333-8444', MK_DEVICE_ID + 'x', 42, null, {}];
    for (const bad of bads) {
      const out = C.normalizeScamEvidence(Object.assign({}, base, { deviceId: bad }));
      assert.ok(out, '前置條件:其餘欄位合法時整筆仍收下');
      assert.equal(
        mkHas(out, 'deviceId'),
        false,
        'deviceId=' + JSON.stringify(bad) + ' 形狀不合應整欄剝除，不得原樣落盤'
      );
    }
  });

  test('R3-10 證據去重鍵對齊:有 threadUrl、無 anchorPostUrl 的證據跑完雲端往返不得裂成兩筆', () => {
    // 本機證據只有 postUrl 與 threadUrl（自回覆串的錨點篇還沒記下來）。
    const local = mkEntry({
      evidence: [
        {
          postUrl: MK_PAGE_URL,
          snippet: MK_SNIPPET,
          at: 1700000100000,
          threadUrl: MK_ANCHOR_URL,
        },
      ],
    });
    // 一趟真實往返:上雲時 anchorPostUrl 以 postUrl 補位，落回本機後兩邊指的
    // 其實是同一篇。
    const remote = C.fromScamMark(C.toScamMark(MK_ID, local)).entry;
    const merged = C.mergeScamEntry(local, remote);
    assert.equal(
      merged.evidence.length,
      1,
      '合併鍵若還吃 threadUrl，本機那一筆與落回來的同一筆會被當成兩篇，每同步一次就多一筆'
    );
    assert.equal(merged.evidence[0].snippet, MK_SNIPPET, '合併後本機獨有的片段要留著');
  });

  test('R3-12 normalizeMarksRejected:被拒映射夾筆數上限，不得無限成長', () => {
    const raw = {};
    for (let i = 0; i < MARKS_REJECTED_MAX + 100; i += 1) raw['threads:' + (90000000000 + i)] = 1700000000000 + i;
    const out = C.normalizeSyncState({ marksRejected: raw }).marksRejected;
    assert.ok(out && typeof out === 'object', '前置條件:合法映射照收');
    assert.equal(
      Object.keys(out).length,
      MARKS_REJECTED_MAX,
      `被拒映射是整包寫回 storage 的，沒有上限就會一路長到配額爆掉（上限 ${MARKS_REJECTED_MAX}）`
    );
  });

  test('R3-12 normalizeMarksRejected:未達上限時一項不刪', () => {
    const raw = {};
    for (let i = 0; i < 10; i += 1) raw['threads:' + (90000000000 + i)] = 1700000000000 + i;
    const out = C.normalizeSyncState({ marksRejected: raw }).marksRejected;
    assert.equal(Object.keys(out).length, 10, '沒到上限就不該動它');
  });

  test('R3-14 normalizeBlocklistEntry:addedAt 與 updatedAt 都不合法時整筆丟棄', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry({ addedAt: 'nope', updatedAt: null }),
        [MK_ID_2]: mkEntry({ addedAt: 100, updatedAt: 900 }),
      },
    });
    assert.deepEqual(
      Object.keys(out.entries),
      [MK_ID_2],
      '兩個時戳都讀不懂的條目沒有可比較的版本，補 0 只會讓它在 LWW 裡永遠輸、再也改不動'
    );
  });

  test('R3-14 normalizeBlocklistEntry:只有一個時戳不合法時以另一個補', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: mkEntry({ addedAt: 'nope', updatedAt: 900 }),
        [MK_ID_2]: mkEntry({ addedAt: 100, updatedAt: 'nope' }),
      },
    });
    assert.equal(out.entries[MK_ID].addedAt, 900, 'addedAt 壞掉時拿 updatedAt 補，不補 0');
    assert.equal(out.entries[MK_ID].updatedAt, 900);
    assert.equal(out.entries[MK_ID_2].addedAt, 100);
    assert.equal(out.entries[MK_ID_2].updatedAt, 100, 'updatedAt 壞掉時拿 addedAt 補');
  });
});

// ============================================================================
// 官方 code review（2026-09-22，整合分支 agent/feature/marks-sync）的修補
// ----------------------------------------------------------------------------
// CR-1 `toScamMark`：本機專有的推送提示欄位一律不上雲（九欄契約）。
// CR-4 `mergeScamEntry`：純量欄位取 updatedAt 勝方的值，勝方缺值時回退到另一
//      方——鏡射伺服器 mergeMark 的同一條規則。
// CR-7 mark key 的解析收斂成單一來源 `scamMarkUserId`，sync.js 不再自備前綴與
//      形狀樣板。
// ============================================================================

test.describe('CR-4 mergeScamEntry：純量缺值回退', () => {
  test('CR-4 mergeScamEntry:遠端較新但 displayName 為 null 時保留本機的值', () => {
    const local = mkEntry({ displayName: 'Foo', updatedAt: 500 });
    const remote = mkEntry({ displayName: null, updatedAt: 900 });
    const out = C.mergeScamEntry(local, remote);
    assert.equal(
      out.displayName,
      'Foo',
      '勝方沒有值不等於「使用者把顯示名清空了」——雲端那一欄本來就可能是 null，拿它蓋掉本機快照只會讓名單變成一排沒有名字的數字 id'
    );
  });

  test('CR-4 mergeScamEntry:遠端較新但 displayName 整個鍵缺席時同樣保留本機的值', () => {
    const local = mkEntry({ displayName: 'Foo', updatedAt: 500 });
    const remote = mkEntry({ updatedAt: 900 });
    delete remote.displayName;
    const out = C.mergeScamEntry(local, remote);
    assert.equal(out.displayName, 'Foo', 'null 與缺鍵在本機形狀裡是同一件事');
  });

  test('CR-4 mergeScamEntry:本機較新但本機沒有 displayName 時回退到遠端的值', () => {
    const local = mkEntry({ updatedAt: 900 });
    delete local.displayName;
    const remote = mkEntry({ displayName: 'Bar', updatedAt: 500 });
    const out = C.mergeScamEntry(local, remote);
    assert.equal(out.displayName, 'Bar', '回退是雙向的，不是只照顧遠端缺值那一邊');
  });

  test('CR-4 mergeScamEntry:handle 走同一條回退規則', () => {
    const winnerless = C.mergeScamEntry(
      mkEntry({ handle: 'Example_Author', updatedAt: 500 }),
      mkEntry({ handle: null, updatedAt: 900 })
    );
    assert.equal(
      winnerless.handle,
      'Example_Author',
      'handle 是推送的必填欄位：被一個 null 洗掉就再也選不進推送批，這台裝置上的那筆從此同步不出去'
    );

    const reverse = C.mergeScamEntry(mkEntry({ handle: null, updatedAt: 900 }), mkEntry({ handle: 'Example_Author', updatedAt: 500 }));
    assert.equal(reverse.handle, 'Example_Author', '本機較新但沒有 handle 時回退到遠端的快照');
  });

  test('CR-4 mergeScamEntry:兩邊都沒有值時不得補出空字串或 null 鍵', () => {
    const local = mkEntry({ updatedAt: 500 });
    const remote = mkEntry({ updatedAt: 900 });
    delete local.displayName;
    delete remote.displayName;
    const out = C.mergeScamEntry(local, remote);
    assert.equal(
      mkHas(out, 'displayName'),
      false,
      '本機形狀是「缺席就不寫鍵」——補一個 null 會讓選項頁畫出一行空白的顯示名'
    );
  });

  test('CR-4 mergeScamEntry:勝方有值時照舊取勝方的（回退不得反過來壓過 LWW）', () => {
    const out = C.mergeScamEntry(
      mkEntry({ handle: 'Old_Handle', displayName: 'Old Name', updatedAt: 500 }),
      mkEntry({ handle: 'New_Handle', displayName: 'New Name', updatedAt: 900 })
    );
    assert.equal(out.handle, 'New_Handle');
    assert.equal(out.displayName, 'New Name');
  });
});

test.describe('CR-7 scamMarkUserId：mark key 解析的單一來源', () => {
  test('CR-7 scamMarkUserId:合法 key 剝掉前綴回 userId 字串', () => {
    assert.equal(typeof C.scamMarkUserId, 'function', 'scamMarkUserId 應掛在 TCLCore 匯出（sync.js 與 fromScamMark 共用這一把尺）');
    assert.equal(C.scamMarkUserId('threads:' + MK_ID), MK_ID);
    assert.equal(C.scamMarkUserId('threads:1'), '1', '1 位數字是合法的作者 id');
    assert.equal(C.scamMarkUserId('threads:' + '9'.repeat(20)), '9'.repeat(20), '20 位是上界，恰好放行');
  });

  test('CR-7 scamMarkUserId:前綴或形狀不合一律回 null', () => {
    const bad = [
      ['非字串', 42],
      ['null', null],
      ['undefined', undefined],
      ['物件', { key: 'threads:1' }],
      ['沒有前綴', MK_ID],
      ['別站的前綴', 'ig:' + MK_ID],
      ['前綴不在開頭', 'x-threads:' + MK_ID],
      ['空 id', 'threads:'],
      ['非數字 id', 'threads:abc'],
      ['夾雜非數字', 'threads:100a2'],
      ['21 位超出上界', 'threads:' + '9'.repeat(21)],
      ['原型污染鍵', 'threads:__proto__'],
      ['帶空白', 'threads: 100'],
    ];
    bad.forEach(([label, key]) => {
      assert.equal(C.scamMarkUserId(key), null, label + ' 應回 null');
    });
  });

  test('CR-7 scamMarkUserId:fromScamMark 對 key 的取捨與它逐字一致', () => {
    ['threads:' + MK_ID, 'threads:abc', 'ig:' + MK_ID, 'threads:', 'threads:__proto__'].forEach((key) => {
      const parsed = C.fromScamMark({
        key,
        state: 'active',
        dismissedAt: null,
        handle: MK_HANDLE,
        displayName: null,
        source: 'auto',
        evidence: [],
        addedAt: 100,
        updatedAt: 900,
      });
      const userId = C.scamMarkUserId(key);
      if (userId === null) {
        assert.equal(parsed, null, key + '：scamMarkUserId 判不合法時 fromScamMark 也必須整筆丟棄');
      } else {
        assert.equal(parsed && parsed.userId, userId, key + '：兩者必須解出同一個 userId');
      }
    });
  });
});

test.describe('CR-1 toScamMark：本機專有的推送提示欄位不上雲', () => {
  test('CR-1 toScamMark:條目帶本機推送提示欄位時，輸出仍是固定九欄', () => {
    // 欄位名由實作者定（pushAfter／evidenceAt 之類），這裡不指定名字，只釘住
    // 「本機多出來的任何鍵都不得漏進 mark」——契約是固定九欄，多一欄後端整筆
    // 拒收，那一筆從此同步不出去。
    const entry = mkEntry({ addedAt: 100, updatedAt: 900 });
    entry.pushAfter = 1700000200000;
    entry.evidenceAt = 1700000200000;
    entry.whateverLocalOnly = 'x';
    const mark = C.toScamMark(MK_ID, entry);
    assert.deepEqual(
      Object.keys(mark).sort(),
      ['addedAt', 'dismissedAt', 'displayName', 'evidence', 'handle', 'key', 'source', 'state', 'updatedAt'],
      'mark 是固定九欄的跨端契約，本機自用的推送提示欄位一個都不得跟著上雲'
    );
    assert.equal(mark.updatedAt, 900, '本機提示欄位也不得頂替 updatedAt——它是 LWW 判準');
  });
});

// ============================================================
// 規則 v4:LINE ID 錨點、暗號型行動呼籲、ID 跨帳號命中(D42-D46)
//
// 【為什麼】警示名單標亮的是片語而不是對方的 LINE ID;同一個 ID 換一個帳號
// 再貼一次就完全認不出來。v4 把「抓到的那串 ID」升成第一級證據:命中時標亮
// ID 本體、ID 進派生索引，下一位用同一個 ID 招攬的作者不必再湊行動呼籲或話
// 術詞就認得出來。
//
// 【欄位】detectScamPitch 多回一個 lineId(小寫、尾端 ._- 剝掉、3-20 字,抓
// 不到為 null);證據多一個本機專有的 lineId(不上雲);黑名單多一張派生的唯讀
// lineIdIndex(不落盤)。
//
// 【合成資料】帳號一律 kw0000／ex01abc／ry0000 之類，userId 沿用
// 1000000x 那組——本區塊不得出現任何真實 LINE ID 或真實帳號。
// ============================================================

// 帳號型錨點的六種真實寫法(全形空白、大小寫 id、繫詞在前),帳號本體都是
// kw0000。
const V4_ACCOUNT_FORMS = [
  '賴：kw0000',
  '賴是：kw0000',
  'LINE ID：kw0000',
  '加我賴號ID：kw0000',
  'LINE 帳號 : kw0000',
  '賴　id：kw0000',
];

// 「賴」在這兩句裡是信賴/無賴的一部分，後面的冒號是正常標點。負向 lookbehind
// 在 v4 放寬繫詞之後必須原封不動。
const V4_ACCOUNT_NEGATIVES = ['我一向信賴：Apple 的品質', '那個無賴：xx 又來了'];

const v4Signals = (text) => C.detectScamPitch(text).signals;

test.describe('D42 規則 v4:帳號型錨點放寬', () => {
  test('D42 detectScamPitch:六種帳號型寫法都認得出帳號型錨點(signals 含 account)', () => {
    for (const text of V4_ACCOUNT_FORMS) {
      const res = C.detectScamPitch(text);
      assert.equal(
        res.signals.includes('account'),
        true,
        JSON.stringify(text) + ' 應被認成帳號型錨點(signals 含 account),實得 ' + JSON.stringify(res.signals)
      );
    }
  });

  test('D42 detectScamPitch:六種帳號型寫法配強話術詞一律命中，lineId 都是 kw0000', () => {
    for (const form of V4_ACCOUNT_FORMS) {
      const text = '我做黑馬股波段很多年，' + form + '，有興趣再聊。';
      const res = C.detectScamPitch(text);
      assert.equal(res.hit, true, JSON.stringify(text) + ' 錨點＋強話術詞應命中');
      assert.equal(res.lineId, 'kw0000', JSON.stringify(text) + ' 的 lineId 應是帳號本體');
    }
  });

  test('D42 detectScamPitch:信賴／無賴的負向 lookbehind 維持——不得冒出 account 訊號，也不得命中', () => {
    for (const form of V4_ACCOUNT_NEGATIVES) {
      const text = '我做黑馬股波段很多年，' + form;
      const res = C.detectScamPitch(text);
      assert.equal(
        res.signals.includes('account'),
        false,
        JSON.stringify(text) + ' 的「賴」是信賴/無賴的一部分，不是帳號型錨點'
      );
      assert.equal(res.hit, false, JSON.stringify(text) + ' 不得命中');
      assert.equal(res.lineId, null, JSON.stringify(text) + ' 不得抓出 lineId');
    }
  });

  // 【負例是本體】D42 把繫詞放寬之後的頭號誤判面:LINE Pay 是收款服務，它的
  // 收款 ID 不是加好友帳號。繫詞必須是封閉的選項清單，不是「LINE 與冒號之間
  // 的任意字」——夾了其他英文字就不算帳號型錨點。
  test('D42 detectScamPitch:「LINE Pay ID：abc123」不得被帳號型錨點命中(繫詞是封閉清單)', () => {
    const res = C.detectScamPitch('付款用 LINE Pay ID：abc123 就可以');
    assert.equal(
      res.signals.includes('account'),
      false,
      'LINE 與可選繫詞之間夾了其他英文字(Pay)，整條樣式就該在那裡斷開'
    );
    assert.equal(res.hit, false, 'LINE Pay 的收款說明不得進黑名單');
    // 強話術詞同框也不得因此成立:帳號型錨點是「錨點 ＋ 強話術詞」那條路的前
    // 提，前提不成立就整條路走不到。
    const withPitch = C.detectScamPitch('我做黑馬股波段很多年，付款用 LINE Pay ID：abc123');
    assert.equal(withPitch.signals.includes('account'), false);
    assert.equal(withPitch.hit, false, '沒有錨點時，單字型提及配強話術詞不構成命中');
  });
});

test.describe('D43 規則 v4:lineId 抓取與標亮', () => {
  test('D43 detectScamPitch:回傳新增 lineId;命中且抓到 ID 時 anchorMatch 是 ID 本體、snippet 含該 ID', () => {
    const res = C.detectScamPitch('我做黑馬股波段很多年，有興趣加我 賴：ex01abc，我把筆記傳給你。');
    assert.equal(res.hit, true);
    assert.equal(res.lineId, 'ex01abc', 'lineId 是抓到的 LINE 帳號本體');
    assert.equal(res.anchorMatch, 'ex01abc', '標亮的是 ID 本體，不是「賴：ex01abc」這段片語');
    assert.equal(res.snippet.includes('ex01abc'), true, 'snippet 以 ID 為中心');
  });

  test('D43 detectScamPitch:抓取順序——帳號型優先於提及後的 ID，ID 又優先於深連結路徑段', () => {
    // 三種來源同時在場:帳號型(kw0000)、LINE 提及後的 ID(ry0000)、深連結
    // 路徑段(ex01abc)。取值順序決定證據卡標亮哪一個。
    const all = '加我的賴，傳送暗號 ID：ry0000，或點 lin.ee/ex01abc，賴：kw0000';
    assert.equal(C.detectScamPitch(all).lineId, 'kw0000', '帳號型錨點的帳號段排第一順位');

    const noAccount = '加我的賴，傳送暗號 ID：ry0000，或點 lin.ee/ex01abc';
    assert.equal(C.detectScamPitch(noAccount).lineId, 'ry0000', '提及後的 ID 排第二順位，深連結墊底');
  });

  test('D43 detectScamPitch:LINE／賴提及後 80 字內的「ID／帳號＋冒號＋ID」抓得到(暗號夾在中間也不影響)', () => {
    const res = C.detectScamPitch('加我的賴，傳送暗號【04】>> ID：ry0000');
    assert.equal(res.lineId, 'ry0000', '提及後 80 字內的「ID：xxx」就是要抓的那一串');
  });

  test('D43 detectScamPitch:深連結的路徑段當 lineId(lin.ee 短網址與 line.me 加好友深連結)', () => {
    assert.equal(C.detectScamPitch('全部資料點這 lin.ee/ex01abc').lineId, 'ex01abc');
    assert.equal(
      C.detectScamPitch('加好友請點 https://line.me/ti/p/~ex01abc').lineId,
      'ex01abc',
      'ti/p 的 ~ 前綴是 LINE 深連結的寫法，不屬於 ID 本體'
    );
  });

  test('D43 detectScamPitch:抓不到 ID 時 lineId 為 null，anchorMatch 退回片語', () => {
    const res = C.detectScamPitch('加入我的LINE，並傳送暗號【w23】');
    assert.equal(res.hit, true, '暗號型行動呼籲＋片語型錨點應命中(D45)');
    assert.equal(res.lineId, null, '這句沒有帳號本體，lineId 必須是 null 而不是暗號代碼');
    assert.equal(res.anchorMatch.includes('LINE'), true, '抓不到 ID 就退回片語當標亮位置');
  });

  test('D43 detectScamPitch:暗號代碼不得成為 lineId', () => {
    const res = C.detectScamPitch('可以到 LINE 傳「177」給我，我把資料分享給你');
    assert.equal(res.lineId, null, '「177」是暗號代碼，不是 LINE 帳號');
  });

  test('D43 detectScamPitch:沒有 LINE 提及的「訂單 ID」不得被抓成 lineId', () => {
    const res = C.detectScamPitch('出貨後請保留 訂單 ID：A12345 以便查詢');
    assert.equal(res.lineId, null, '沒有任何 LINE 提及時，任何 ID 欄位都不該被當成 LINE 帳號');
    assert.equal(res.hit, false);
  });

  test('D43 detectScamPitch:lineId 一律小寫、尾端 ._- 剝掉、長度落在 3-20', () => {
    assert.equal(C.detectScamPitch('黑馬股筆記，LINE ID：ABC_123').lineId, 'abc_123', 'lineId 一律存小寫');
    assert.equal(
      C.detectScamPitch('黑馬股筆記，LINE ID：abc123.').lineId,
      'abc123',
      '尾端的 . _ - 是句讀不是帳號的一部分'
    );
    assert.equal(C.detectScamPitch('黑馬股筆記，LINE ID：abc123-').lineId, 'abc123');
    const long = C.detectScamPitch('黑馬股筆記，LINE ID：' + 'a'.repeat(25)).lineId;
    assert.equal(typeof long, 'string', '超長帳號段仍要抓得到');
    assert.equal(long.length <= 20, true, 'lineId 上限 20 字(LINE ID 的官方上限),實得 ' + long.length);
  });

  test('D43 detectScamPitch:未命中時 lineId 照樣回報(D46 跨帳號比對的唯一來源)', () => {
    // 「LINE ID：xxx」單獨不成立(計畫已裁決不採),但 D46 的跨帳號比對就是
    // 靠這條路拿到 ID——未命中就不回報的話，D46 整條路永遠走不到。
    const res = C.detectScamPitch('LINE ID：ex01abc');
    assert.equal(res.hit, false, '帳號型錨點單獨不構成命中(維持 v3 的門檻)');
    assert.equal(res.lineId, 'ex01abc', 'lineId 與 pitchMatches 同一個待遇:未命中照樣回報');
    // 非字串/空字串的早退分支也要帶這一欄，呼叫端才能無條件走訪。
    for (const bad of [null, undefined, 42, {}, '']) {
      assert.equal(C.detectScamPitch(bad).lineId, null, JSON.stringify(String(bad)) + ' 應回 lineId:null');
    }
  });

  test('D43 detectScamPitch:「LINE Pay ID：xx」維持 v3 的不命中', () => {
    assert.equal(C.detectScamPitch('付款用 LINE Pay ID：xx 就可以').hit, false);
  });
});

// 合成的暗號型樣本(比照 DdlMRmDmAak 那一篇的句型):LINE 提及＋暗號型行動呼
// 籲(傳「177」給我)＋帳號型錨點，整串沒有群組/加入詞、沒有任何強話術詞。
// v3 對它回 hit:false。
const V4_CODE_WORD_SAMPLE =
  '可以到 LINE 傳「177」給我，我免費把整理好的資料分享給你！\nLINE ID：ex01abc';

test.describe('D45 規則 v4:暗號型行動呼籲', () => {
  test('D45 detectScamPitch:合成 DdlMRmDmAak 樣本命中，signals 含 line／account 與行動呼籲類別', () => {
    const res = C.detectScamPitch(V4_CODE_WORD_SAMPLE);
    assert.equal(res.hit, true, '暗號型行動呼籲＋帳號型錨點必須命中(v3 對它整串漏抓)');
    assert.equal(res.signals.includes('line'), true, 'signals 應含 line');
    assert.equal(res.signals.includes('account'), true, 'signals 應含 account');
    assert.equal(
      res.signals.includes('join') || res.signals.includes('phrase'),
      true,
      '暗號型行動呼籲要落在 join(或新類別)上，實得 ' + JSON.stringify(res.signals)
    );
    assert.equal(res.lineId, 'ex01abc', '標亮的是 ID 本體');
  });

  test('D45 detectScamPitch:四種暗號型行動呼籲配 LINE 提及各自命中', () => {
    const positives = [
      '想看完整資料的到我的 LINE 傳送暗號【246】',
      '加我的LINE，傳送暗號【04】就送你整理好的表',
      '想拿資料的在我 LINE 底下留言【18】',
      '到我的 LINE 傳訊「63」我就回你',
    ];
    for (const text of positives) {
      assert.equal(C.detectScamPitch(text).hit, true, JSON.stringify(text) + ' 應命中');
    }
  });

  test('D45 detectScamPitch:「傳訊息給我」「把檔案傳給我」不是暗號，配 LINE 提及也不得命中', () => {
    const negatives = ['有問題可以用 LINE 傳訊息給我', '資料很大，用 LINE 把檔案傳給我就好'];
    for (const text of negatives) {
      assert.equal(
        C.detectScamPitch(text).hit,
        false,
        JSON.stringify(text) + ' 沒有暗號代碼，單獨的「給我」不算行動呼籲'
      );
    }
  });

  test('D45 detectScamPitch:公司公告改用 LINE 群組維持不命中(v3 回歸)', () => {
    assert.equal(C.detectScamPitch('公司公告:內部通知改用 LINE 群組發布，請同仁自行加入').hit, false);
  });

  test('D45 SCAM_RULES.version 升為 4;SCAM_SIGNALS 併入 account／phrase／id／id-match，既有五類順序不變', () => {
    assert.equal(C.SCAM_RULES.version, 4, '規則版本 3 → 4(證據的 rulesVersion 靠它分辨新舊判定)');
    assert.deepEqual(
      C.SCAM_SIGNALS.slice(0, 5),
      ['link', 'line', 'group', 'join', 'pitch'],
      '既有五類的值與顯示順序不得動——證據卡的 chip 與已落盤的證據都吃這張表'
    );
    for (const name of ['account', 'phrase', 'id', 'id-match']) {
      assert.equal(C.SCAM_SIGNALS.includes(name), true, 'signals 白名單應含 ' + name);
    }
  });

  test('D45 signals:account／phrase／id 分別對應帳號型錨點、片語型錨點、抓到 lineId', () => {
    const account = v4Signals('賴：kw0000');
    assert.equal(account.includes('account'), true, '帳號型錨點 → account');
    assert.equal(account.includes('phrase'), false, '帳號型錨點不是片語型');

    const phrase = v4Signals('加入我的LINE');
    assert.equal(phrase.includes('phrase'), true, '片語型錨點 → phrase');
    assert.equal(phrase.includes('account'), false, '片語型錨點沒有帳號段');

    assert.equal(v4Signals('LINE ID：kw0000').includes('id'), true, '抓到 lineId → id');
    assert.equal(v4Signals('公司的 LINE 又改版了').includes('id'), false, '沒抓到 ID 就不得有 id 訊號');

    const link = v4Signals('全部資料點這 lin.ee/ex01abc');
    assert.equal(link.includes('link'), true, '連結型錨點的 link 語意不變');
    assert.equal(link.includes('id'), true, '深連結的路徑段也是一個 lineId');

    const notice = v4Signals('公司公告:內部通知改用 LINE 群組發布，請同仁自行加入');
    assert.deepEqual(notice, ['line', 'group', 'join'], '既有五類的語意不得因為新類別而位移');
  });
});

// D44:證據的本機專有欄位 lineId。
const V4_LINE_ID = 'ex01abc';

test.describe('D44 規則 v4:evidence.lineId 是本機專有欄位', () => {
  test('D44 normalizeScamEvidence:lineId 是字串時放行並轉小寫', () => {
    const out = C.normalizeScamEvidence(richEvidence({ lineId: 'EX01ABC' }));
    assert.equal(out.lineId, V4_LINE_ID, 'lineId 一律小寫落盤(索引與比對都以小寫為鍵)');
  });

  test('D44 normalizeScamEvidence:lineId 非字串或空字串一律不落鍵，整筆證據照留', () => {
    for (const bad of [42, null, {}, [], true, '']) {
      const out = C.normalizeScamEvidence(richEvidence({ lineId: bad }));
      assert.ok(out, 'lineId=' + JSON.stringify(String(bad)) + ' 不得讓整筆證據被丟掉');
      assert.equal(
        mkHas(out, 'lineId'),
        false,
        'lineId=' + JSON.stringify(String(bad)) + ' 應整欄不落鍵(缺席不補空字串)'
      );
    }
    assert.equal(
      mkHas(C.normalizeScamEvidence(richEvidence()), 'lineId'),
      false,
      '沒帶 lineId 的舊證據不得被補出這一欄'
    );
  });

  test('D44 normalizeScamEvidence:lineId 超過 20 字裁到 20 字(不整欄丟棄)', () => {
    const out = C.normalizeScamEvidence(richEvidence({ lineId: 'a'.repeat(30) }));
    assert.equal(out.lineId, 'a'.repeat(20), 'LINE ID 官方上限 20 字，超長裁切而不是整欄丟掉');
  });

  test('D44 makeBlocklistEntry:新建條目的證據帶上 lineId', () => {
    const entry = C.makeBlocklistEntry({
      handle: MK_HANDLE,
      postUrl: MK_PAGE_URL,
      snippet: MK_SNIPPET,
      at: 1700000100000,
      anchorPostUrl: MK_ANCHOR_URL,
      anchorMatch: V4_LINE_ID,
      lineId: V4_LINE_ID,
      source: 'auto',
    });
    assert.equal(entry.evidence[0].lineId, V4_LINE_ID, '首次命中就要把 ID 記進證據，之後才索引得到');
  });

  test('D44 toScamMark:證據仍是固定七欄，lineId 不上雲', () => {
    const mark = C.toScamMark(MK_ID, mkEntry({ evidence: [mkEvidence({ lineId: V4_LINE_ID })] }));
    assert.deepEqual(
      Object.keys(mark.evidence[0]).sort(),
      ['anchorPostUrl', 'at', 'deviceId', 'postedAt', 'rulesVersion', 'signals', 'threadUrl'],
      '上雲的證據是固定七欄的契約，lineId 是本機專有欄位，一個都不得漏出去'
    );
  });

  test('D44 fromScamMark:雲端 mark 夾帶 lineId 也不得讀進本機證據', () => {
    const parsed = C.fromScamMark({
      key: 'threads:' + MK_ID,
      state: 'active',
      dismissedAt: null,
      handle: MK_HANDLE,
      displayName: null,
      source: 'auto',
      evidence: [
        {
          anchorPostUrl: MK_ANCHOR_URL,
          threadUrl: MK_THREAD_URL,
          signals: ['line'],
          at: 900,
          postedAt: 800,
          rulesVersion: 4,
          deviceId: MK_DEVICE_ID_2,
          lineId: 'cloudid01',
        },
      ],
      addedAt: 100,
      updatedAt: 900,
    });
    assert.ok(parsed, '多一欄不得讓整筆 mark 被丟掉');
    assert.equal(
      mkHas(parsed.entry.evidence[0], 'lineId'),
      false,
      'lineId 不在契約裡:雲端來的那一格一律不讀進本機(否則等於開了一條寫本機索引的後門)'
    );
  });

  test('D44 mergeScamEvidencePair:遠端較新但沒有 lineId 時，本機的 lineId 保留', () => {
    const local = mkEntry({
      updatedAt: 100,
      evidence: [mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 100, lineId: V4_LINE_ID })],
    });
    const remote = mkEntry({
      updatedAt: 900,
      evidence: [mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 900 })],
    });
    const ev = C.mergeScamEntry(local, remote).evidence[0];
    assert.equal(
      ev.lineId,
      V4_LINE_ID,
      'lineId 與 snippet／anchorMatch／postUrl 同屬本機專有，不得被較新的遠端洗掉'
    );
  });

  test('D44 mergeScamEntry:真實往返(本機有 lineId、遠端走 toScamMark → fromScamMark)後 lineId 仍在', () => {
    const remote = JSON.parse(
      JSON.stringify(
        C.fromScamMark(
          C.toScamMark(
            MK_ID,
            C.makeBlocklistEntry({
              handle: MK_HANDLE,
              postUrl: MK_ANCHOR_URL,
              snippet: '另一台裝置看到的原文，不上雲',
              at: 900,
              anchorPostUrl: MK_ANCHOR_URL,
              threadUrl: MK_THREAD_URL,
              anchorMatch: V4_LINE_ID,
              lineId: V4_LINE_ID,
              signals: ['line', 'account'],
              rulesVersion: 4,
              deviceId: MK_DEVICE_ID_2,
              source: 'auto',
            })
          )
        ).entry
      )
    );
    assert.equal(mkHas(remote.evidence[0], 'lineId'), false, '前提:走一趟雲端往返之後，遠端那一筆沒有 lineId');

    const local = mkEntry({
      updatedAt: 100,
      evidence: [mkEvidence({ anchorPostUrl: MK_ANCHOR_URL, at: 100, lineId: V4_LINE_ID })],
    });
    const ev = C.mergeScamEntry(local, remote).evidence[0];
    assert.equal(ev.lineId, V4_LINE_ID, '同步一次就把本機的 ID 洗掉的話，跨帳號索引會在每次同步後失憶');
  });

  test('D44 capScamEvidence／capScamBlocklist:落盤裁切一路保留 lineId', () => {
    const capped = C.capScamEvidence([mkEvidence({ lineId: V4_LINE_ID })]);
    assert.equal(capped[0].lineId, V4_LINE_ID, 'capScamEvidence 逐欄帶過時不得漏掉 lineId');

    const out = C.capScamBlocklist({
      version: 2,
      entries: { [MK_ID]: mkEntry({ evidence: [mkEvidence({ lineId: V4_LINE_ID })] }) },
    });
    assert.equal(out.entries[MK_ID].evidence[0].lineId, V4_LINE_ID, 'lineId 要落盤——它是索引的唯一真相來源');
  });
});

test.describe('D46 規則 v4:lineIdIndex 派生索引', () => {
  // 帶 N 筆證據的條目，每筆各自帶一個 lineId(錨點篇各不相同，才不會被證據
  // 去重併成一筆)。
  const v4Entry = (lineIds, patch) =>
    mkEntry(
      Object.assign(
        {
          evidence: lineIds.map((lineId, index) =>
            mkEvidence({
              lineId,
              anchorPostUrl: 'https://www.threads.com/@example_author/post/DxSyNtH100' + index,
              at: 1700000100000 + index,
            })
          ),
        },
        patch || {}
      )
    );

  test('D46 normalizeScamBlocklist:派生唯讀 lineIdIndex——鍵是 lineId，值是 userId', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: { [MK_ID]: v4Entry(['ex01abc']), [MK_ID_2]: v4Entry(['kw0000']) },
    });
    assert.ok(out.lineIdIndex, 'normalizeScamBlocklist 的輸出要多一張 lineIdIndex');
    assert.deepEqual(
      out.lineIdIndex,
      { ex01abc: MK_ID, kw0000: MK_ID_2 },
      'lineIdIndex 是 { lineId → userId } 的反查表，與 handleIndex 同一類派生視圖'
    );
  });

  test('D46 normalizeScamBlocklist:同一條目的多筆證據各自帶 ID 時，每一個都進索引', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: { [MK_ID]: v4Entry(['ex01abc', 'kw0000']) },
    });
    assert.equal(out.lineIdIndex.ex01abc, MK_ID);
    assert.equal(out.lineIdIndex.kw0000, MK_ID, '同一個人換 ID 再招攬一次，兩個 ID 都要查得到他');
  });

  test('D46 normalizeScamBlocklist:lineIdIndex 一律小寫為鍵(髒資料的大小寫不得讓查表落空)', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: { [MK_ID]: v4Entry(['EX01ABC']) },
    });
    assert.equal(out.lineIdIndex.ex01abc, MK_ID, '比照 handleIndex:鍵一律小寫');
  });

  test('D46 normalizeScamBlocklist:dismissed 條目的 lineId 不進索引', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: {
        [MK_ID]: v4Entry(['ex01abc'], { state: 'dismissed', dismissedAt: 1700000200000 }),
        [MK_ID_2]: v4Entry(['kw0000']),
      },
    });
    assert.deepEqual(
      out.lineIdIndex,
      { kw0000: MK_ID_2 },
      '使用者解除過的作者不該再靠一個 ID 把別人也拖下水(與 handleIndex 只含 active 同一條線)'
    );
  });

  test('D46 normalizeScamBlocklist:lineIdIndex 拒收 __proto__ 鍵，原型不受污染', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: { [MK_ID]: v4Entry(['__proto__']) },
    });
    assert.equal({}.ex01abc, undefined, '原型不得被污染');
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.lineIdIndex, '__proto__'),
      false,
      '三張反查表拒收 __proto__ 的規矩，第四張照辦'
    );
  });

  test('D46 capScamBlocklist:落盤只有 version／entries／handleIndex 三鍵，lineIdIndex 不持久化', () => {
    const out = C.capScamBlocklist({
      version: 2,
      entries: { [MK_ID]: v4Entry(['ex01abc']) },
    });
    assert.deepEqual(
      Object.keys(out).sort(),
      ['entries', 'handleIndex', 'version'],
      'lineIdIndex 與 allowlist 同類:記憶體裡的派生視圖，落盤等於讓 storage 存兩份真相'
    );
  });
});

// ============================================================
// 審查修訂:誤判面收緊(F1-F5)與 D46 來源側門檻(B1)
//
// 【為什麼】v4 第一版把「暗號」與「ID 欄位」認得太寬:留言抽獎、傳 email 給
// 我、加密語音、訂單／會員／銀行／Apple ID 全都踩得到，而且那些誤抓的 ID 還
// 會進跨帳號索引，把毫不相干的人拖下水。這一區塊逐條釘住負例。
//
// 【合成資料】帳號沿用 ex01abc／kw0000，userId 沿用 1000000x 那組。
// ============================================================

test.describe('F1-F3 審查修訂:暗號型行動呼籲收緊', () => {
  test('F1 detectScamPitch:「留言 1 抽獎」「留言【1】索取」不是暗號——必須有括號且是 2-8 位數字', () => {
    assert.equal(
      C.detectScamPitch('品牌 LINE 官方帳號上線，留言 1 抽獎').hit,
      false,
      '沒有括號的「留言 1」是抽獎活動的日常寫法，不是把人帶走的暗號'
    );
    assert.equal(
      C.detectScamPitch('新書 LINE 社群開張，留言【1】索取懶人包').hit,
      false,
      '括號裡只有一位數字的多半是選項編號，不是暗號代碼'
    );
    assert.equal(
      C.detectScamPitch('想拿資料的在我 LINE 底下留言【18】').hit,
      true,
      '【正例維持】括號 ＋ 2 位數字的暗號照舊命中'
    );
  });

  test('F2 detectScamPitch:「傳 email 給我」「傳 LINE 給我」不是暗號——裸代碼分支只認數字', () => {
    assert.equal(
      C.detectScamPitch('檔案太大，請用 LINE 傳 email 給我').hit,
      false,
      '「傳 email 給我」是日常請求，email 不是暗號代碼'
    );
    assert.equal(
      C.detectScamPitch('報名表請傳 LINE 給我，我再轉給窗口').hit,
      false,
      '「傳 LINE 給我」要的是對方的 LINE，不是暗號代碼'
    );
    assert.equal(
      C.detectScamPitch('可以到 LINE 傳「177」給我，我把資料分享給你').hit,
      true,
      '【正例維持】括號 ＋ 數字代碼照舊命中'
    );
    assert.equal(
      C.detectScamPitch('到我的 LINE 傳訊「63」我就回你').hit,
      true,
      '【正例維持】傳訊「63」照舊命中'
    );
  });

  test('F3 detectScamPitch:「加密語音」不是加入詞——詞表只留「暗號」「通關密語」', () => {
    assert.equal(
      C.detectScamPitch('公司的 LINE 支援加密語音通話').hit,
      false,
      '「密語」是「加密語音」的子字串，當加入詞會把資安介紹整批誤判'
    );
    assert.equal(
      C.detectScamPitch('想看完整資料的到我的 LINE 傳送暗號【246】').hit,
      true,
      '【正例維持】暗號照舊命中'
    );
    assert.equal(
      C.detectScamPitch('到我的 LINE 傳送通關密語').hit,
      true,
      '【正例維持】通關密語照舊命中'
    );
  });
});

test.describe('F4-F5 審查修訂:lineId 抓取收緊', () => {
  test('F4 detectScamPitch:訂單／會員／銀行／手機／Apple 的 ID 欄位與 LINE 同框也不算 lineId', () => {
    const cases = [
      '有 LINE 的朋友請對一下 訂單 ID：A12345',
      '加我的 LINE 之後回報 會員 ID：vip0088',
      '請用 LINE 回覆 銀行 帳號：012345678',
      '用 LINE 聯絡前請先確認 Apple ID：user01a',
      '有 LINE 再傳 手機 號碼：0912345678',
    ];
    for (const text of cases) {
      assert.equal(
        C.detectScamPitch(text).lineId,
        null,
        JSON.stringify(text) + ' 的 ID 欄位有自己的歸屬，不是 LINE 帳號'
      );
    }
  });

  test('F4 detectScamPitch:「LINE Pay ID：abc123」除了不命中，也不得抓出 lineId', () => {
    const res = C.detectScamPitch('付款用 LINE Pay ID：abc123 就可以');
    assert.equal(res.signals.includes('account'), false);
    assert.equal(res.hit, false);
    assert.equal(res.lineId, null, 'LINE Pay 的收款 ID 不是加好友帳號，抓進來就會進跨帳號索引');
  });

  test('F4 detectScamPitch:正例維持——一般的「ID：xxx」在 LINE 提及之後照樣抓得到', () => {
    assert.equal(C.detectScamPitch('加我的賴，傳送暗號【04】>> ID：ry0000').lineId, 'ry0000');
  });

  test('F5 detectScamPitch:ID 欄位落在視窗邊界時，帳號段不得被切片截斷', () => {
    const text = '加我的賴' + '。'.repeat(C.SCAM_LIMITS.ID_WINDOW - 2) + 'ID：ex01abc';
    assert.equal(
      C.detectScamPitch(text).lineId,
      'ex01abc',
      '視窗管的是「ID 欄位起點離提及多遠」,切片得放寬到足以吃完整個帳號段'
    );
  });

  test('B2 SCAM_LIMITS.ID_WINDOW:視窗 24 字釘住——隔得太遠的 ID 欄位與 LINE 無關', () => {
    assert.equal(
      C.SCAM_LIMITS.ID_WINDOW,
      24,
      '視窗放寬等於把整段貼文裡的任何 ID 欄位都當成 LINE 帳號'
    );
    const far = '加我的賴' + '。'.repeat(40) + 'ID：ex01abc';
    assert.equal(C.detectScamPitch(far).lineId, null, '隔 40 字的 ID 欄位講的是別的東西');
  });
});

test.describe('B1 審查修訂:lineIdIndex 的來源側門檻', () => {
  // 一筆帶指定 lineId 與 signals 的條目。
  const b1Entry = (lineId, signals) =>
    mkEntry({ evidence: [mkEvidence({ lineId: lineId, signals: signals })] });

  test('B1 normalizeScamBlocklist:證據沒踩到行動呼籲/話術/連結訊號時，它的 lineId 不進索引', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: { [MK_ID]: b1Entry('ex01abc', ['line', 'account', 'id']) },
    });
    assert.equal(
      out.entries[MK_ID].evidence[0].lineId,
      'ex01abc',
      '證據照留——標亮與人工複核還用得到'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.lineIdIndex, 'ex01abc'),
      false,
      '只貼了一個帳號、沒有任何招攬動作的條目，不該讓同一個 ID 把別人也標上(同店兩位員工貼同一支客服 LINE 是常態)'
    );
  });

  test('B1 normalizeScamBlocklist:證據踩到 join／group／pitch／link 任一時，lineId 照樣進索引', () => {
    for (const signal of ['join', 'group', 'pitch', 'link']) {
      const out = C.normalizeScamBlocklist({
        version: 2,
        entries: { [MK_ID]: b1Entry('ex01abc', ['line', 'account', 'id', signal]) },
      });
      assert.equal(
        out.lineIdIndex.ex01abc,
        MK_ID,
        'signals 含 ' + signal + ' 就是一次真的招攬，ID 要進索引'
      );
    }
  });

  test('F4 normalizeScamBlocklist:純數字的 lineId 留在證據裡，但不進索引', () => {
    const out = C.normalizeScamBlocklist({
      version: 2,
      entries: { [MK_ID]: b1Entry('0912345678', ['line', 'account', 'id', 'join']) },
    });
    assert.equal(out.entries[MK_ID].evidence[0].lineId, '0912345678', '證據照留');
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.lineIdIndex, '0912345678'),
      false,
      '純數字多半是電話或訂單號，拿它跨帳號比對是在賭撞號'
    );
  });
});
