// ============================================================
// 【CS-1／XC-8】帳號型錨點與串文徽章正則的行為 golden 表＋病態輸入示範
//
// G2（閘門）：兩條有二次方回溯的正則（tcl-core 的 SCAM_ACCOUNT_ANCHOR_RES、
// scam-guard 的 POSITION_BADGE_PATTERN）改寫之後，對下列語料的判定結果必須
// 與改寫前逐條一致。golden 值取自改寫前的 main（0.10.0），透過公開入口
// detectScamPitch／stripPositionBadge 觀察，不直接綁正則物件——改寫可以拆
// 條、合併或換成程式判斷，只要對外行為不變。
//
// detectScamPitch 的觀察面收斂成四欄：account（signals 是否含 account，即帳
// 號型錨點是否成立）、lineId、anchorMatch、hit。語料涵蓋繫詞
// 是／ID／帳號／號碼／號ID／號、全形／半形冒號、半形空白／全形空白／tab 的
// 空白容忍，以及信賴／無賴等負向邊界。
//
// G3（非閘門）：對兩條正則餵 5,000 個空白的病態字串，印出耗時；上限只設 2
// 秒寬鬆值，避免 CI 機器慢時誤判。真正的線性保證由 regex-safety.test.js 的
// recheck 靜態分析把關。
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));
const G = require(path.join(__dirname, '..', 'scam-guard.js'));

const project = (res) => ({
  account: res.signals.includes('account'),
  lineId: res.lineId,
  anchorMatch: res.anchorMatch,
  hit: res.hit,
});

// [輸入, 期望的四欄投影]
const ACCOUNT_POSITIVES = [
  ['賴：kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['賴是：kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['LINE ID：kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['加我賴號ID：kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['LINE 帳號 : kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['賴　id：kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['LINE  ID: wolf88，穩賺不賠', { account: true, lineId: 'wolf88', anchorMatch: 'wolf88', hit: true }],
  ['LINE ID：wolf_88 免費教學抓黑馬股', { account: true, lineId: 'wolf_88', anchorMatch: 'wolf_88', hit: true }],
  ['LINE ：form003，我拉你進群組', { account: true, lineId: 'form003', anchorMatch: 'form003', hit: true }],
  ['LINE:form002，我拉你進群組', { account: true, lineId: 'form002', anchorMatch: 'form002', hit: true }],
  ['LINE：form001，我拉你進群組', { account: true, lineId: 'form001', anchorMatch: 'form001', hit: true }],
  ['籟：ab12cd', { account: true, lineId: 'ab12cd', anchorMatch: '', hit: false }],
  ['賴號碼：ab12cd', { account: true, lineId: 'ab12cd', anchorMatch: '', hit: false }],
  ['賴號：ab12cd', { account: true, lineId: 'ab12cd', anchorMatch: '', hit: false }],
  ['LINE號碼 ： ab12cd', { account: true, lineId: 'ab12cd', anchorMatch: '', hit: false }],
  ['line id:ABC_123', { account: true, lineId: 'abc_123', anchorMatch: '', hit: false }],
  ['LINE是：kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['賴 帳號　：　kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['LINE\tID\t:\tkw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['賴\u3000\u3000號ID\u3000\u3000:\u3000\u3000kw0000', { account: true, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['代操不收費，賴：ex01abc', { account: true, lineId: 'ex01abc', anchorMatch: 'ex01abc', hit: true }],
  ['LINE ID：' + 'a'.repeat(25), { account: true, lineId: 'aaaaaaaaaaaaaaaaaaaa', anchorMatch: '', hit: false }],
  ['賴：abc123.', { account: true, lineId: 'abc123', anchorMatch: '', hit: false }],
  ['我做黑馬股波段很多年，LINE 帳號 : kw0000，有興趣再聊。', { account: true, lineId: 'kw0000', anchorMatch: 'kw0000', hit: true }],
];

const ACCOUNT_NEGATIVES = [
  ['我一向信賴：Apple 的品質', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['那個無賴：xx 又來了', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['付款用 LINE Pay ID：abc123 就可以', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['仰賴：xyz123 黑馬股', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['依賴：technical analysis 的人很容易買到假飆股', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['信賴：這家店開很久了', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['倚賴：abc123', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['不要賴皮好嗎', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['賴：ab', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['LINE：_abc123', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['ONLINE：abc123', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['deadline: abc123', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['賴 ID abc123', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['賴清德：今天開記者會', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['賴：   ', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['LINE 帳號：-abc', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['賴 是 ID：kw0000', { account: false, lineId: 'kw0000', anchorMatch: '', hit: false }],
  ['LINE 的 ID：abc123', { account: false, lineId: 'abc123', anchorMatch: '', hit: false }],
  ['LINE Pay ID：xx', { account: false, lineId: null, anchorMatch: '', hit: false }],
  ['賴' + ' '.repeat(40) + '沒有冒號', { account: false, lineId: null, anchorMatch: '', hit: false }],
];

// stripPositionBadge 的完整回傳（text／position／total）。
const BADGE_CASES = [
  ['這是第三篇的本文\n3\n/\n6', { text: '這是第三篇的本文', position: 3, total: 6 }],
  ['本文\n\n  5\n/\n6  \n', { text: '本文', position: 5, total: 6 }],
  ['本文1/6', { text: '本文', position: 1, total: 6 }],
  ['本文 1/6', { text: '本文', position: 1, total: 6 }],
  ['本文\n1/6', { text: '本文', position: 1, total: 6 }],
  ['本文\n12\n/\n50', { text: '本文', position: 12, total: 50 }],
  ['  \n3\n/\n4\n', { text: '', position: 3, total: 4 }],
  ['1/2', { text: '', position: 1, total: 2 }],
  ['本文\t2/3\t', { text: '本文', position: 2, total: 3 }],
  ['本文\n\n3\n\n/\n6', { text: '本文\n\n3\n\n/\n6', position: null, total: null }],
  ['本文\n3 / 6', { text: '本文\n3 / 6', position: null, total: null }],
  ['本文 3/6 。', { text: '本文 3/6 。', position: null, total: null }],
  ['本文\n3\n/\n', { text: '本文\n3\n/\n', position: null, total: null }],
  ['abc/6', { text: 'abc/6', position: null, total: null }],
  ['排程 4/24 小時輪一次，撐了十多年', { text: '排程 4/24 小時輪一次，撐了十多年', position: null, total: null }],
  ['那個月領了 15 萬', { text: '那個月領了 15 萬', position: null, total: null }],
  ['第六篇：想跟我一起學的可以來社群，活動到 2026/9/19', { text: '第六篇：想跟我一起學的可以來社群，活動到 2026/', position: 9, total: 19 }],
  ['第一篇：那一年我的勝率大概是 30/100', { text: '第一篇：那一年我的勝率大概是', position: 30, total: 100 }],
  ['', { text: '', position: null, total: null }],
  ['   ', { text: '   ', position: null, total: null }],
];

test('G2 語料量：帳號錨點正例、反例、徽章案例各至少 15 條', () => {
  assert.ok(ACCOUNT_POSITIVES.length >= 15, '帳號錨點正例 ' + ACCOUNT_POSITIVES.length);
  assert.ok(ACCOUNT_NEGATIVES.length >= 15, '帳號錨點反例 ' + ACCOUNT_NEGATIVES.length);
  assert.ok(BADGE_CASES.length >= 15, '徽章案例 ' + BADGE_CASES.length);
});

test('G2 帳號型錨點正例：detectScamPitch 的判定與 golden 一致', () => {
  for (const [input, expected] of ACCOUNT_POSITIVES) {
    assert.deepEqual(project(C.detectScamPitch(input)), expected, JSON.stringify(input));
  }
});

test('G2 帳號型錨點反例：detectScamPitch 的判定與 golden 一致', () => {
  for (const [input, expected] of ACCOUNT_NEGATIVES) {
    assert.deepEqual(project(C.detectScamPitch(input)), expected, JSON.stringify(input));
  }
});

test('G2 串文徽章：stripPositionBadge 的回傳與 golden 一致', () => {
  for (const [input, expected] of BADGE_CASES) {
    assert.deepEqual(G.stripPositionBadge(input), expected, JSON.stringify(input));
  }
});

// ---- G3：病態輸入示範（非閘門，只設寬鬆上限） ----

const PATHOLOGICAL_SPACES = 5000;
const LOOSE_LIMIT_MS = 2000;

function timeIt(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

test('G3 病態輸入：帳號型錨點吃 5,000 個空白（非閘門，印出耗時）', () => {
  const spaces = ' '.repeat(PATHOLOGICAL_SPACES);
  const inputs = {
    '賴 + 空白 + 無冒號': '賴' + spaces + 'x',
    'LINE + 空白 + 無冒號': 'LINE' + spaces + 'x',
  };
  for (const [label, input] of Object.entries(inputs)) {
    const ms = timeIt(() => C.detectScamPitch(input));
    console.log('[G3] 帳號型錨點 ' + label + '（' + PATHOLOGICAL_SPACES + ' 空白）：' + ms.toFixed(1) + ' ms');
    assert.ok(ms < LOOSE_LIMIT_MS, label + ' 耗時 ' + ms.toFixed(1) + ' ms 超過寬鬆上限');
  }
});

test('G3 病態輸入：串文徽章吃 5,000 個空白（非閘門，印出耗時）', () => {
  const input = ' '.repeat(PATHOLOGICAL_SPACES) + 'x';
  const ms = timeIt(() => G.stripPositionBadge(input));
  console.log('[G3] 串文徽章（' + PATHOLOGICAL_SPACES + ' 空白＋尾字）：' + ms.toFixed(1) + ' ms');
  assert.ok(ms < LOOSE_LIMIT_MS, '耗時 ' + ms.toFixed(1) + ' ms 超過寬鬆上限');
});
