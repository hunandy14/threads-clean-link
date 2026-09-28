// test/scam-rules-v5.test.js — 詐騙偵測規則 v5 的契約：拆字折疊、規則表、
// fixture 語料庫。
//
// v5 把判定拆成三層：
//   1. 折疊前置 foldScamText(text)：NFKC（逐 code unit、等長）＋ LINE 拆字／
//      混淆變體折疊（L.I.N.E、L I N E、L-I-N-E、l1ne …）。輸出與輸入**等長且
//      逐位對齊**，anchorMatch／snippet 才能照舊拿 index 回原文切片。
//   2. 規則表 SCAM_RULE_TABLE：每列 { id, kind, desc, words|re|res|fold,
//      active?, fixtures }，判定引擎讀表跑；buildScamRules(table) 把表轉成
//      detectScamPitch 吃的規則包。新增規則＝加一列＋丟一個 fixture。
//   3. fixture 語料庫 test/fixtures/scam/*.txt：每個樣本一檔，本檔自動遍歷。
//      新漏網只要丟一檔進去。
//
// detectScamPitch 的回傳多一欄 ruleIds：這次比對踩到的規則表列 id（命中與否
// 都回報，與 pitchMatches 同一待遇），供 fixture 的 `rules:` 表頭驗證歸因。
//
// 【fixture 格式】檔頭若干行 `# key: value`，空一行後是內文。
//   expect      hit | miss（必填）
//   lineId      期望的 lineId，抓不到寫 null（必填）
//   anchorMatch 命中時期望的標亮原文（選填）
//   rules       逗號分隔的規則列 id，必須全數出現在 ruleIds（選填）
//   source／note 出處與說明（選填，不參與斷言）
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'tcl-core.js'));

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'scam');
const HEADER_KEYS = new Set(['expect', 'lineId', 'anchorMatch', 'rules', 'source', 'note']);

function parseFixture(name) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8').replace(/\r\n/g, '\n');
  const split = raw.indexOf('\n\n');
  assert.ok(split > 0, name + '：檔頭與內文之間要空一行');
  const header = {};
  for (const line of raw.slice(0, split).split('\n')) {
    const m = /^# (\w+): (.*)$/.exec(line);
    assert.ok(m, name + '：檔頭每行必須是 `# key: value`，收到 ' + JSON.stringify(line));
    assert.ok(HEADER_KEYS.has(m[1]), name + '：未知的檔頭欄位 ' + m[1]);
    header[m[1]] = m[2].trim();
  }
  const rules = header.rules ? header.rules.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { name, header, rules, body: raw.slice(split + 2) };
}

const FIXTURE_NAMES = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();
const FIXTURES = FIXTURE_NAMES.map(parseFixture);
const byName = new Map(FIXTURES.map((f) => [f.name, f]));

const LINE_WORD = /(?<![A-Za-z])LINE(?![A-Za-z])/i;

// ---- fixture 語料庫 ----

test('fixture 語料庫：每檔檔頭合法（expect 為 hit／miss、lineId 必填、內文非空）', () => {
  assert.ok(FIXTURES.length >= 20, 'fixture 至少 20 檔，實得 ' + FIXTURES.length);
  for (const f of FIXTURES) {
    assert.ok(f.header.expect === 'hit' || f.header.expect === 'miss', f.name + '：expect 必須是 hit 或 miss');
    assert.ok('lineId' in f.header, f.name + '：lineId 必填（抓不到寫 null）');
    assert.ok(f.body.trim().length > 0, f.name + '：內文不得為空');
  }
});

for (const f of FIXTURES) {
  test('fixture ' + f.name + '：判定（hit／lineId／anchorMatch）', () => {
    const res = C.detectScamPitch(f.body);
    assert.equal(res.hit, f.header.expect === 'hit', f.name + ' 期望 ' + f.header.expect + '，signals=' + res.signals.join(','));
    const wantId = f.header.lineId === 'null' ? null : f.header.lineId;
    assert.equal(res.lineId, wantId, f.name + ' 的 lineId');
    if (f.header.anchorMatch !== undefined) {
      assert.equal(res.anchorMatch, f.header.anchorMatch, f.name + ' 的 anchorMatch');
    }
  });

  if (f.rules.length > 0) {
    test('fixture ' + f.name + '：規則歸因（ruleIds 含檔頭列出的規則）', () => {
      const res = C.detectScamPitch(f.body);
      assert.ok(Array.isArray(res.ruleIds), 'detectScamPitch 要回傳 ruleIds 陣列');
      for (const id of f.rules) {
        assert.ok(res.ruleIds.includes(id), f.name + ' 應踩到 ' + id + '，實得 ' + JSON.stringify(res.ruleIds));
      }
    });
  }
}

// ---- 漏網實例 p3：拆字 L.I.N.E＋小寫 line 緊貼中文＋「傳個信息（110）」 ----

test('v5 p3 漏網實例：命中、標亮 LINE ID 本體 ex6667，證據片段保留原文的拆字寫法', () => {
  const f = byName.get('hit-v5-p3-dotted-line.txt');
  assert.ok(f, 'p3 fixture 必須存在');
  const res = C.detectScamPitch(f.body);
  assert.equal(res.hit, true, 'p3 必須命中');
  assert.equal(res.lineId, 'ex6667');
  assert.equal(res.anchorMatch, 'ex6667', '標亮的是 ID 本體');
  assert.ok(res.snippet.includes('L.I.N.E：ex6667'), 'snippet 取自原文，拆字寫法原樣保留：' + JSON.stringify(res.snippet));
  for (const s of ['line', 'account', 'id']) {
    assert.ok(res.signals.includes(s), 'signals 應含 ' + s + '，實得 ' + res.signals.join(','));
  }
});

test('v5 p3 單句：不靠拆字折疊，單字型 line＋「傳個信息（110）」也要命中', () => {
  const res = C.detectScamPitch('有需要了解和領取的line上給我傳個信息（110）我建個群分享出來自行參考');
  assert.equal(res.hit, true);
  assert.ok(res.signals.includes('join'), '暗號型行動呼籲落在 join，實得 ' + res.signals.join(','));
});

// ---- 折疊前置 foldScamText ----

const FOLD_POSITIVES = [
  'L.I.N.E：abc123',
  'L I N E：abc123',
  'L-I-N-E：abc123',
  'l.i.n.e：abc123',
  'Ｌｉｎｅ：abc123',
  'l1ne：abc123',
  '搜索L.I.N.E：ex6667',
];

// 純 ASCII 的反例：折疊不得動到任何一個字元。
const FOLD_NEGATIVES = [
  'online',
  'ONLINE',
  'lineup',
  'timeline',
  'airline',
  'deadline',
  'headline',
  'O.N.L.I.N.E',
  'onl1ne',
  'LINE:l1ne99',
  'LINE:xl1ne',
];

test('foldScamText：匯出為函式', () => {
  assert.equal(typeof C.foldScamText, 'function', 'foldScamText 應掛在 TCLCore 匯出');
});

test('foldScamText：拆字／全形／混淆變體折疊成可被單字型提及認出的 LINE', () => {
  for (const text of FOLD_POSITIVES) {
    const out = C.foldScamText(text);
    assert.ok(LINE_WORD.test(out), JSON.stringify(text) + ' 折疊後應出現獨立的 LINE，實得 ' + JSON.stringify(out));
  }
});

test('foldScamText：輸出與輸入等長（逐位對齊，index 可直接套回原文）', () => {
  const samples = FOLD_POSITIVES.concat(FOLD_NEGATIVES, FIXTURES.map((f) => f.body));
  for (const text of samples) {
    assert.equal(C.foldScamText(text).length, text.length, JSON.stringify(text.slice(0, 40)) + ' 折疊後長度改變');
  }
});

test('foldScamText：英文詞裡的 line 片段、帳號本體裡的 l1ne 一律不動', () => {
  for (const text of FOLD_NEGATIVES) {
    assert.equal(C.foldScamText(text), text, JSON.stringify(text) + ' 不得被折疊');
  }
});

test('折疊不得改寫 LINE ID 本體：帳號段裡的 l1ne 原樣進 lineId', () => {
  assert.equal(C.detectScamPitch('LINE：l1ne99 拉你進群').lineId, 'l1ne99');
  assert.equal(C.detectScamPitch('LINE：xl1ne 拉你進群').lineId, 'xl1ne');
});

// ---- 反例：英文詞與名詞型公告不得命中 ----

test('反例：online／lineup／timeline／airline 配行動呼籲不得命中', () => {
  const negatives = [
    'online 課程加入群組，我建個群給大家',
    '先看 lineup 再決定要不要進群',
    'timeline 上找我，拉你進群',
    'airline 會員 ID：abc123 歡迎加入社群',
    'O.N.L.I.N.E 課程，我建個群拉你進群',
  ];
  for (const text of negatives) {
    assert.equal(C.detectScamPitch(text).hit, false, JSON.stringify(text) + ' 不得誤殺');
  }
});

test('反例：公司改用 LINE 群組公告（含「建個群」）不得命中', () => {
  assert.equal(C.detectScamPitch('公司改用 LINE 群組公告').hit, false);
  assert.equal(C.detectScamPitch('公司改用 LINE 群組公告，行政會建個群通知大家').hit, false);
});

test('反例：括號裡是電話區碼、後面緊接號碼時不算暗號', () => {
  assert.equal(C.detectScamPitch('有問題可以 LINE 或傳個訊息（02）2345-6789 找客服').hit, false);
});

// ---- 規則表 ----

const KINDS = new Set([
  'fold',
  'mention',
  'anchor-link',
  'anchor-account',
  'anchor-phrase',
  'group',
  'join',
  'code',
  'pitch-strong',
  'pitch-weak',
]);

test('SCAM_RULES：規則版本升到 5', () => {
  assert.equal(C.SCAM_RULES.version, 5);
});

test('SCAM_RULE_TABLE：每列有唯一 id、合法 kind、說明、恰好一種比對資料與至少一個 fixture', () => {
  const table = C.SCAM_RULE_TABLE;
  assert.ok(Array.isArray(table) && table.length > 0, 'SCAM_RULE_TABLE 應為非空陣列並掛在 TCLCore 匯出');
  const seen = new Set();
  for (const row of table) {
    const tag = JSON.stringify(row && row.id);
    assert.equal(typeof row.id, 'string', tag + '：id 必須是字串');
    assert.match(row.id, /^[a-z][a-z0-9-]*$/, tag + '：id 只用小寫英數與連字號');
    assert.ok(!seen.has(row.id), tag + '：id 重複');
    seen.add(row.id);
    assert.ok(KINDS.has(row.kind), tag + '：未知的 kind ' + row.kind);
    assert.ok(typeof row.desc === 'string' && row.desc.length > 0, tag + '：desc 必填');

    const data = ['words', 're', 'res', 'fold'].filter((k) => row[k] !== undefined);
    assert.equal(data.length, 1, tag + '：words／re／res／fold 恰好一種，實得 ' + data.join(','));
    if (row.words !== undefined) {
      assert.ok(Array.isArray(row.words) && row.words.length > 0, tag + '：words 為非空陣列');
      for (const w of row.words) assert.ok(typeof w === 'string' && w.length > 0, tag + '：words 內只放非空字串');
    }
    if (row.re !== undefined) assert.ok(row.re instanceof RegExp, tag + '：re 必須是 RegExp');
    if (row.res !== undefined) {
      assert.ok(Array.isArray(row.res) && row.res.length > 0, tag + '：res 為非空陣列');
      for (const r of row.res) assert.ok(r instanceof RegExp, tag + '：res 內只放 RegExp');
    }
    if (row.fold !== undefined) {
      assert.equal(row.kind, 'fold', tag + '：只有 kind=fold 的列可以帶 fold 函式');
      assert.equal(typeof row.fold, 'function', tag + '：fold 必須是函式');
    }
    if (row.kind === 'group' || row.kind === 'join') {
      assert.equal(typeof row.active, 'boolean', tag + '：group／join 列要標 active（單字型提及是否認得）');
    }

    assert.ok(Array.isArray(row.fixtures) && row.fixtures.length > 0, tag + '：至少對應一個 fixture');
    for (const name of row.fixtures) {
      const f = byName.get(name);
      assert.ok(f, tag + '：fixture ' + name + ' 不存在於 test/fixtures/scam/');
      assert.ok(f.rules.includes(row.id), tag + '：fixture ' + name + ' 的 rules 表頭要列出 ' + row.id);
    }
  }
});

test('SCAM_RULE_TABLE：fixture 表頭提到的每個規則 id 都在表內', () => {
  const ids = new Set((C.SCAM_RULE_TABLE || []).map((r) => r.id));
  for (const f of FIXTURES) {
    for (const id of f.rules) {
      assert.ok(ids.has(id), f.name + ' 的 rules 提到表內沒有的 ' + id);
    }
  }
});

test('buildScamRules：引擎讀表跑——加一列 active 群組詞即生效，拿掉就失效', () => {
  assert.equal(typeof C.buildScamRules, 'function', 'buildScamRules 應掛在 TCLCore 匯出');
  const text = 'LINE 上找我，進測試專用群';
  const base = C.buildScamRules(C.SCAM_RULE_TABLE);
  assert.equal(C.detectScamPitch(text, base).hit, false, '表內沒有這個詞時不命中');

  const extra = {
    id: 'test-extra-group',
    kind: 'group',
    desc: '測試用',
    active: true,
    words: ['測試專用群'],
    fixtures: ['hit-group-active.txt'],
  };
  const res = C.detectScamPitch(text, C.buildScamRules(C.SCAM_RULE_TABLE.concat([extra])));
  assert.equal(res.hit, true, '加一列後應命中');
  assert.ok(res.ruleIds.includes('test-extra-group'), 'ruleIds 要回報新加的列');
});

test('buildScamRules：由表建出的規則包與預設 SCAM_RULES 對 fixture 的判定一致', () => {
  const built = C.buildScamRules(C.SCAM_RULE_TABLE);
  for (const f of FIXTURES) {
    assert.equal(C.detectScamPitch(f.body, built).hit, C.detectScamPitch(f.body).hit, f.name);
  }
});

// ---- 模糊自測：probe 只供定位，lineId 與 anchorMatch 的內容一律來自原文 ----
//
// 以固定種子拼出含拆字 LINE、代理對、全形字元的隨機句子，只驗兩條不變式，不
// 綁任何一條規則的判定結果：
//   - lineId 必須等於原文某個 code point 起點上「逐 code point NFKC、屬帳號
//     字元者連續串接、裁到 20 字、剝掉尾端 . _ -」的結果（小寫）。
//   - anchorMatch 必須是原文的子字串，頭尾不切在半個代理對上；有 lineId 且命
//     中時，anchorMatch 逐 code point NFKC 後就是 lineId。

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_PIECES = [
  'LINE', 'line', 'L.I.N.E', 'L I N E', 'L·I·N·E', 'L-I-N-E', 'L|NE', 'l1ne', '𝐋𝐈𝐍𝐄', 'Ｌｉｎｅ', 'ⓛⓘⓝⓔ',
  '賴', '籟', '：', ':', ' ', '　', 'ID', '帳號', '是',
  'ex', 'abc', 'shop', '𝟔𝟔𝟔', '𝐝ef', '１２３', '99', '.', '-', '_',
  '私訊我', '進群', '加入', '加我', '群組', '報明牌', '傳個信息（110）',
  'line.me/ti/p/~', 'lin.ee/', 'online', '訂單 ID：',
];

const ID_CHAR = /^[A-Za-z0-9._-]$/;

function codePoints(text) {
  return Array.from(text);
}

// 原文第 k 個 code point 起的帳號段（逐 code point NFKC）。
function idRunAt(points, k) {
  const chars = [];
  for (let i = k; i < points.length && chars.length < 20; i++) {
    const ch = points[i].normalize('NFKC');
    if (!ID_CHAR.test(ch)) break;
    chars.push(ch);
  }
  while (chars.length > 0 && '._-'.includes(chars[chars.length - 1])) chars.pop();
  return chars.join('').toLowerCase();
}

function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

test('模糊自測：lineId 只來自原文帳號段，anchorMatch 是原文子字串且不切半個代理對（200 條，固定種子）', () => {
  const rand = mulberry32(20260928);
  for (let n = 0; n < 200; n++) {
    const count = 3 + Math.floor(rand() * 8);
    let text = '';
    for (let i = 0; i < count; i++) text += FUZZ_PIECES[Math.floor(rand() * FUZZ_PIECES.length)];
    const res = C.detectScamPitch(text);
    const clean = C.stripControlChars(text);
    const tag = JSON.stringify(text);

    if (res.lineId !== null) {
      const points = codePoints(clean);
      let ok = false;
      for (let k = 0; k < points.length && !ok; k++) ok = idRunAt(points, k) === res.lineId;
      assert.ok(ok, tag + ' 的 lineId ' + JSON.stringify(res.lineId) + ' 不是原文上的帳號段');
    }

    if (res.anchorMatch !== '') {
      assert.ok(clean.includes(res.anchorMatch), tag + ' 的 anchorMatch 不是原文子字串：' + JSON.stringify(res.anchorMatch));
      assert.ok(!isLow(res.anchorMatch.charCodeAt(0)), tag + ' 的 anchorMatch 起點切在代理對中間');
      assert.ok(
        !isHigh(res.anchorMatch.charCodeAt(res.anchorMatch.length - 1)),
        tag + ' 的 anchorMatch 終點切在代理對中間'
      );
      if (res.hit && res.lineId !== null) {
        const normalized = codePoints(res.anchorMatch).map((ch) => ch.normalize('NFKC')).join('').toLowerCase();
        assert.equal(normalized, res.lineId, tag + ' 的 anchorMatch 應是 lineId 的原文寫法');
      }
    }
  }
});
