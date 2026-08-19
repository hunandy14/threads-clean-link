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
