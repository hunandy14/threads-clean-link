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
// 對應 tmp/scam-thread-feasibility.md 的 v1 實作計畫:詐騙帳號用中文文字引導
// 到 LINE(「賴：vg475」「加我的賴」「lin.ee/」)，domain 規則命中率 0，判定
// 只能靠「LINE 錨點 + 投資話術」的二次確認。此區塊釘住五支純函式:
//   - detectScamPitch:錨點/話術/片段的命中契約，**負例是本體**(賴床、賴皮、
//     信賴、賴清德、無賴不得誤殺)
//   - isPostDetailPath:詳情頁 pathname 判定(河道不掃全文，只有詳情頁掃)
//   - normalizeScamBlocklist / capScamBlocklist:storage 形狀與上限裁切
//   - makeBlocklistEntry / mergeBlocklistEvidence:條目建立與證據合併
//
// 【紀律】每個 test 先斷言函式掛上 TCLCore 匯出——未實作時吐可讀的斷言失敗，
// 而不是 TypeError crash 把整支測試檔打斷。

const SCAM_POST_URL = 'https://www.threads.com/@dakkaknight/post/DdbYCAfgV4M';

// 範例第六篇原句(含前文的三個話術詞)——真實資料，不得只靠合成字串。
const SCAM_POST_TEXT = [
  '我自己做波段黑馬股很多年，這裡只分享操作心得。',
  '不報明牌、不收費、不代操，純粹交流。',
  '有興趣加我 賴：vg475，說「yy」我就知道是你',
].join('\n');

test.describe('詐騙偵測:detectScamPitch', () => {
  test('detectScamPitch:範例第六篇原句——錨點 + 話術命中，回傳四欄形狀', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const res = C.detectScamPitch(SCAM_POST_TEXT);
    assert.equal(res.hit, true, '真實詐騙貼文必須命中');
    assert.equal(typeof res.anchorMatch, 'string', 'anchorMatch 是命中的錨點原文');
    assert.equal(res.anchorMatch.includes('vg475'), true, '錨點應涵蓋帳號本體');
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
      '波段黑馬股分享，賴：vg475',
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
    assert.equal(C.detectScamPitch('加我賴 vg475 聊天，晚上一起打球').hit, false, '只有錨點不成立');
    assert.equal(C.detectScamPitch('賴：vg475，明天見').hit, false, '只有錨點不成立');
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
    const text = '黑馬股' + 'A'.repeat(100) + '賴：vg475' + 'B'.repeat(100);
    const res = C.detectScamPitch(text);
    assert.equal(res.hit, true);
    assert.equal(res.snippet.length <= 120, true, 'snippet 總長上限 120，實得 ' + res.snippet.length);
    assert.equal(res.snippet.includes('vg475'), true, 'snippet 必須含錨點本體');
    assert.equal(res.snippet.includes('A'.repeat(41)), false, '錨點前最多 40 字');
    assert.equal(res.snippet.includes('B'.repeat(41)), false, '錨點後最多 40 字');
    assert.equal(res.snippet.includes('黑馬股'), false, '超過 40 字的前文不進 snippet');
  });

  // snippet 會進 storage 也會進選項頁 DOM:控制/bidi 字元必須在此剝除，不能把
  // RLO 這類偽裝字元原封帶進黑名單卡片。
  test('detectScamPitch:snippet 剝除控制字元與 bidi', () => {
    assert.equal(typeof C.detectScamPitch, 'function', 'detectScamPitch 應掛在 TCLCore 匯出');
    const text = '黑馬股介紹' + NUL1 + '加我 賴' + RLO + '：vg475' + C1 + LRM + ' 謝謝';
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

test.describe('詐騙偵測:isPostDetailPath', () => {
  test('isPostDetailPath:/@handle/post/CODE 為真', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    assert.equal(C.isPostDetailPath('/@dakkaknight/post/DdbYCAfgV4M'), true);
    assert.equal(C.isPostDetailPath('/@user_c/post/GhI789'), true);
    assert.equal(
      C.isPostDetailPath('/@da.fu.coding/post/A-b_C1'),
      true,
      'handle 含句點、ID 含連字號都在既有白名單字元類內'
    );
  });

  test('isPostDetailPath:河道／個人頁／搜尋頁為偽', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    const negatives = [
      '/',
      '',
      '/@dakkaknight',
      '/@dakkaknight/',
      '/@dakkaknight/replies',
      '/search',
      '/search/?q=abc',
      '/activity',
      '/post/DdbYCAfgV4M',
      '/@dakkaknight/post/',
      '/@dakkaknight/posts/DdbYCAfgV4M',
      '/@dakkaknight/post/DdbYCAfgV4M/extra',
      '/@bad handle/post/DdbYCAfgV4M',
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
    assert.equal(C.isPostDetailPath('/@dakkaknight/post/DdbYCAfgV4M/'), true);
    assert.equal(C.isPostDetailPath('/@dakkaknight/post/DdbYCAfgV4M?xmt=abc'), true);
    assert.equal(C.isPostDetailPath('/@dakkaknight/post/DdbYCAfgV4M/?igsh=x#frag'), true);
  });

  test('isPostDetailPath:非字串一律 false，不拋錯', () => {
    assert.equal(typeof C.isPostDetailPath, 'function', 'isPostDetailPath 應掛在 TCLCore 匯出');
    for (const bad of [null, undefined, 123, {}, [], true]) {
      assert.equal(C.isPostDetailPath(bad), false, JSON.stringify(String(bad)) + ' 應為 false');
    }
  });
});

test.describe('詐騙偵測:normalizeScamBlocklist', () => {
  const EMPTY_LIST = { version: 1, entries: {}, handleIndex: {}, allowlist: {} };

  test('normalizeScamBlocklist:缺席／非物件一律回空的四欄形狀', () => {
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
          handle: 'DakkaKnight',
          displayName: 'Dakka',
          evidence: [{ postUrl: SCAM_POST_URL, snippet: '賴：vg475', at: 5 }],
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
    assert.equal(out.version, 1, 'version 固定正規化成 1');
    assert.deepEqual(Object.keys(out.entries).sort(), ['111', '444'], 'entries 內非物件逐項剝除');
    assert.deepEqual(out.entries['444'].evidence, [], 'evidence 非陣列退成空陣列，不整筆丟棄');
    assert.equal(Array.isArray(out.entries['111'].evidence), true);
    assert.equal(out.entries['111'].evidence.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'junkField'), false, '未知欄位不留存');
  });

  test('normalizeScamBlocklist:handleIndex 由 entries 重建且 handle 小寫', () => {
    assert.equal(typeof C.normalizeScamBlocklist, 'function', 'normalizeScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.normalizeScamBlocklist({
      entries: {
        '111': { handle: 'DakkaKnight', evidence: [], addedAt: 1 },
        '444': { handle: 'Foo', evidence: [], addedAt: 2 },
        '555': { evidence: [], addedAt: 3 },
      },
      handleIndex: { staleghost: '999', dakkaknight: 'wrong-id' },
    });
    assert.deepEqual(out.handleIndex, { dakkaknight: '111', foo: '444' }, 'handleIndex 只能由 entries 重建');
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.handleIndex, 'undefined'),
      false,
      '缺 handle 的條目不得產生 undefined 鍵'
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
        '111': { at: 1700000000000, handle: 'DakkaKnight' },
        '222': true,
        '333': { at: 'nope', handle: 42 },
        '444': { at: 1700000000001 },
        '555': false,
        '666': 'yes',
        '777': null,
        '888': 0,
        '999': ['DakkaKnight'],
      },
    });

    assert.deepEqual(
      out.allowlist['111'],
      { at: 1700000000000, handle: 'DakkaKnight' },
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

  test('capScamBlocklist:allowlist 透傳正規化後的 { at, handle }', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const out = C.capScamBlocklist({
      version: 1,
      entries: {},
      handleIndex: {},
      allowlist: { '111': { at: 5, handle: 'foo' }, '222': true, '333': 'nope' },
    });
    assert.deepEqual(
      out.allowlist,
      { '111': { at: 5, handle: 'foo' }, '222': { at: 0, handle: '' } },
      'capScamBlocklist 不碰 allowlist，只把 normalizeScamBlocklist 的結果原樣帶出來'
    );
  });
});

test.describe('詐騙偵測:capScamBlocklist', () => {
  // 造一份 n 筆的名單，addedAt 由舊到新(1..n)，userId 為 'u<i>'。
  function makeList(n, evidencePerEntry, snippetLen) {
    const entries = {};
    const handleIndex = {};
    for (let i = 1; i <= n; i++) {
      const id = 'u' + i;
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
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u1'), false, '最舊的 addedAt 先淘汰');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u50'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u51'), true, '保留最新 5000 筆');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u5050'), true);
    // handleIndex 必須跟著裁，不能留下指向已淘汰條目的孤兒鍵。
    assert.equal(Object.keys(out.handleIndex).length, 5000);
    assert.equal(Object.prototype.hasOwnProperty.call(out.handleIndex, 'h1'), false);
    assert.equal(out.handleIndex.h5050, 'u5050');
  });

  test('capScamBlocklist:每筆 evidence 上限 3，保留最新(at 最大)', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const list = makeList(1, 1, 10);
    list.entries.u1.evidence = [
      { postUrl: SCAM_POST_URL + '1', snippet: 'a', at: 100 },
      { postUrl: SCAM_POST_URL + '2', snippet: 'b', at: 500 },
      { postUrl: SCAM_POST_URL + '3', snippet: 'c', at: 300 },
      { postUrl: SCAM_POST_URL + '4', snippet: 'd', at: 900 },
      { postUrl: SCAM_POST_URL + '5', snippet: 'e', at: 200 },
    ];
    const kept = C.capScamBlocklist(list).entries.u1.evidence;
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
    const kept = C.capScamBlocklist(list).entries.u1.evidence[0];
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
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u4000'), true, '最新的一筆永遠留著');
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u1'), false, '最舊的先走');
  });

  test('capScamBlocklist:未超量時原樣回傳；非物件不炸', () => {
    assert.equal(typeof C.capScamBlocklist, 'function', 'capScamBlocklist 應掛在 TCLCore 匯出');
    const small = makeList(3, 2, 20);
    const out = C.capScamBlocklist(small);
    assert.deepEqual(Object.keys(out.entries).sort(), ['u1', 'u2', 'u3']);
    assert.equal(out.entries.u2.evidence.length, 2);
    for (const bad of [undefined, null, 'nope', 42, []]) {
      assert.deepEqual(
        C.capScamBlocklist(bad),
        { version: 1, entries: {}, handleIndex: {}, allowlist: {} },
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
      handle: 'DakkaKnight',
      displayName: 'Dakka Knight',
      postUrl: SCAM_POST_URL,
      snippet: '加我 賴：vg475',
      at: 1700000000000,
      source: 'auto',
    });
    assert.equal(entry.handle, 'DakkaKnight', 'handle 保留原始大小寫(小寫化是 handleIndex 的事)');
    assert.equal(entry.displayName, 'Dakka Knight');
    assert.equal(entry.addedAt, 1700000000000);
    assert.equal(entry.source, 'auto');
    assert.equal(Array.isArray(entry.evidence), true);
    assert.equal(entry.evidence.length, 1);
    assert.deepEqual(entry.evidence[0], {
      postUrl: SCAM_POST_URL,
      snippet: '加我 賴：vg475',
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
// 位元組預算用 JS 字元數而非真位元組(中文 snippet 實際佔 3 倍),外加
// `__proto__` 鍵與 displayName 換行兩個衛生問題。此區塊逐條釘死。

test.describe('詐騙偵測:誤報防線(審查 FAIL 回歸)', () => {
  // 「賴」前面接 信/依/無/仰 時整個詞是「信賴/依賴/無賴/仰賴」，後面的冒號
  // 是正常標點,不是 LINE 帳號引導。這類句子常同時帶投資詞(討論股票時說
  // 「我信賴某某分析」),光靠 PITCH 二次確認擋不住,錨點本身必須排除。
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
    // ——真實詐騙句「我的賴：vg475」正是這個形狀。
    assert.equal(C.detectScamPitch('我的賴：vg475，專攻波段黑馬股').hit, true, '排除清單不得過寬');
    assert.equal(C.detectScamPitch('找我聊 賴：vg475，有黑馬股').hit, true, '排除清單不得過寬');
  });

  // 【PM 裁決】話術表回歸規格原文:刪除「內線」。內線在中文是體育(內線傳
  // 球)、職場(內線消息)、電話分機的日常詞，投資語境的辨識力不足以單獨撐起
  // PITCH,留著只會把球評與八卦貼文一起掃進黑名單。表定保留:黑馬股／報明牌
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

  // 「免費教學」「不收費」在補習、餐飲、健身、公益貼文裡是中性詞,辨識力遠
  // 低於「黑馬股」「代操」。降權成弱詞:只有它們時不足以命中，必須再有一個
  // 其他投資詞才算 PITCH 成立。
  test('detectScamPitch:免費教學／不收費是弱詞，單獨不足以命中', () => {
    assert.equal(C.detectScamPitch('烘焙免費教學，加入LINE官方帳號領取食譜').hit, false, '免費教學單獨不成立');
    assert.equal(C.detectScamPitch('瑜珈課程不收費，加入我的LINE').hit, false, '不收費單獨不成立');
    // 弱詞 + 一個強詞 → 成立。
    assert.equal(C.detectScamPitch('黑馬股免費教學，加入我的LINE').hit, true, '弱詞配強詞應命中');
    assert.equal(C.detectScamPitch('代操不收費，賴：vg475').hit, true, '弱詞配強詞應命中');
    // 範例第六篇原句:「不報明牌、不收費、不代操」含兩個強詞，降權後仍命中。
    assert.equal(C.detectScamPitch(SCAM_POST_TEXT).hit, true, '真實詐騙貼文不得因降權漏抓');
  });

  // 詐騙帳號會用全形英數規避純 ASCII 的帳號樣式。錨點要吃全形，且
  // anchorMatch／snippet 必須保留原文全形——證據卡要讓使用者一眼看出對方用
  // 了規避字元，不能偷偷正規化成半形。
  test('detectScamPitch:全形英數帳號照樣是錨點，原文全形保留', () => {
    const text = '賴：ｖｇ４７５ 有黑馬股';
    const res = C.detectScamPitch(text);
    assert.equal(res.hit, true, '全形帳號應命中');
    assert.equal(
      res.anchorMatch.includes('ｖｇ４７５') || res.snippet.includes('ｖｇ４７５'),
      true,
      'anchorMatch 或 snippet 必須保留原文全形'
    );
    // 3 位的門檻對全形一視同仁:2 位仍不算帳號。
    assert.equal(C.detectScamPitch('賴：ｖｇ 有黑馬股').hit, false, '全形也要滿 3 位');
  });

  // 2MB 軟預算是 chrome.storage 的位元組配額,不是 JS 字元數。snippet 幾乎必
  // 然是中文(詐騙話術本體),UTF-8 每字 3 bytes——用 String#length 當預算會讓
  // 實際寫入量膨脹到三倍而撞配額。
  test('capScamBlocklist:2MB 軟預算算的是 UTF-8 真位元組', () => {
    const entries = {};
    const handleIndex = {};
    for (let i = 1; i <= 2000; i++) {
      const id = 'u' + i;
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
    assert.equal(Object.prototype.hasOwnProperty.call(out.entries, 'u2000'), true, '最新的一筆永遠留著');
  });

  // storage 讀回的 JSON 可能含 `__proto__` 鍵(手工編輯的匯入檔、或他處寫入
  // 的髒資料)。`out.entries['__proto__'] = entry` 不會建出自有鍵，而是把
  // entries 的原型整個換掉:Object.keys 看不到它，handleIndex 卻留下指向它的
  // 孤兒鍵,之後的查表會拿到一筆撈不出來的條目。
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
      handle: 'DakkaKnight',
      displayName: '  Dakka\n\tKnight \n 投資 ',
      postUrl: SCAM_POST_URL,
      snippet: '賴：vg475',
      at: 1700000000000,
      source: 'auto',
    });
    assert.equal(entry.displayName, 'Dakka Knight 投資', '連續空白摺成單一半形空格並去頭尾');
    assert.equal(/[\r\n\t]/.test(entry.displayName), false, 'displayName 不得留下換行或 tab');
    const dirtyHandle = C.makeBlocklistEntry({
      userId: '1',
      handle: 'Dakka\tKnight\n',
      postUrl: SCAM_POST_URL,
      snippet: 's',
      at: 1,
      source: 'auto',
    });
    assert.equal(/[\r\n\t]/.test(dirtyHandle.handle), false, 'handle 不得留下換行或 tab');
  });
});

// ---- 詐騙偵測:allowlist 的筆數上限（L4 審查建議）----
//
// entries 有 MAX_ENTRIES 擋著，allowlist 卻是無上限的：使用者每按一次「解
// 除」就多一筆，而解除紀錄會永遠留著（它的作用就是不讓下一次掃描把人復
// 活）。同一份位元組軟預算下，無上限的 allowlist 最終會把 entries 擠光。
// 上限與 entries 同為 5000 筆，依 at 降冪留最新——舊值升級來的 { at:0 } 排在
// 最後，本來就是最沒有顯示價值的那一批。
test.describe('詐騙偵測:capScamBlocklist allowlist 上限', () => {
  function makeAllowlist(count) {
    const allowlist = {};
    for (let i = 0; i < count; i++) {
      allowlist[String(900000000 + i)] = { at: i + 1, handle: 'h' + i };
    }
    return allowlist;
  }

  test('capScamBlocklist:allowlist 超過 5000 筆時依 at 降冪留最新 5000', () => {
    const out = C.capScamBlocklist({
      version: 1,
      entries: {},
      handleIndex: {},
      allowlist: makeAllowlist(5001),
    });

    assert.equal(Object.keys(out.allowlist).length, 5000, 'allowlist 上限與 entries 同為 5000 筆');
    assert.equal(out.allowlist['900000000'], undefined, 'at 最小（最舊）的一筆被淘汰');
    assert.deepEqual(
      out.allowlist['900005000'],
      { at: 5001, handle: 'h5000' },
      '最新的一筆必須留著，且值的形狀不變'
    );
  });

  test('capScamBlocklist:allowlist 恰 5000 筆時一筆都不裁', () => {
    const out = C.capScamBlocklist({
      version: 1,
      entries: {},
      handleIndex: {},
      allowlist: makeAllowlist(5000),
    });

    assert.equal(Object.keys(out.allowlist).length, 5000, '恰為上限不得誤裁');
    assert.deepEqual(out.allowlist['900000000'], { at: 1, handle: 'h0' }, '最舊的那一筆在上限內照樣留著');
  });

  test('capScamBlocklist:allowlist 裁切不得動到 entries', () => {
    const out = C.capScamBlocklist({
      version: 1,
      entries: {
        '111': {
          handle: 'DakkaKnight',
          displayName: 'Dakka',
          evidence: [{ postUrl: SCAM_POST_URL, snippet: '賴：vg475', at: 5 }],
          addedAt: 5,
          source: 'auto',
        },
      },
      handleIndex: { dakkaknight: '111' },
      allowlist: makeAllowlist(5001),
    });

    assert.ok(out.entries['111'], '解除名單爆量不得連帶淘汰黑名單條目');
    assert.equal(out.handleIndex['dakkaknight'], '111');
  });
});
