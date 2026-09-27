// ============================================================
// 【CS-1／XC-8 G1】產品檔正則的 ReDoS 靜態分析閘門
//
// 掃描產品檔原始碼，抽出所有正則字面量與「整段是靜態字串」的
// `new RegExp('…', '…')`，逐條交給 recheck 做靜態分析，status 必須是
// 'safe'（線性）。vulnerable（多項式／指數回溯）與 unknown（分析逾時或放
// 棄）一律算失敗——閘門要的是「證明線性」，不是「沒被證明有害」。
//
// recheck 以 pure 後端執行（純 JS，不依賴 Java 或平台原生執行檔），並固定
// randomSeed，讓 fuzz 階段在各平台的結果可重現。
//
// checker 用 recheck 的 'auto'：樣式能建成大小合理的自動機時走 automaton（純
// 靜態、毫秒級），含 lookaround 或 `{1,80}` 這類大範圍計數時改走 fuzz。硬性
// 先跑 automaton 對後者沒有好處——lookaround 直接回 unsupported，大計數要把
// timeout 整段耗完才回 unknown，再跑 fuzz 反而更久。
//
// pure 後端逐條分析是單執行緒的 CPU 工作，各條互不相依，因此分給
// worker_threads 並行（工作佇列逐條派發，重的幾條不會卡在同一個 worker）。
//
// 動態組字串的 `new RegExp(…)` 無法靜態取得完整樣式，列在
// DYNAMIC_REGEXP_ALLOWLIST 並逐條註明原因；清單外出現新的動態建構時本檔
// 會失敗，逼新增者補上說明（或改寫成可分析的形狀）。
// ============================================================
'use strict';

process.env.RECHECK_BACKEND = 'pure';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

const ROOT = path.join(__dirname, '..');

const PRODUCT_FILES = [
  'tcl-core.js',
  'scam-guard.js',
  'post-icon.js',
  'bridge.js',
  'clipboard-guard.js',
  'background.js',
  'sw-history.js',
  'sw-device.js',
  'sw-og.js',
  'sw-scam.js',
  'sync.js',
  'auth.js',
  'options.js',
  'popup.js',
  'i18n.js',
];

// 時間型上限（timeout／attackTimeout／incubationTimeout）一律關掉，只留
// recheck 的步數型上限：時間上限的結果取決於機器當下的負載，同一條樣式在忙
// 碌的機器上會因為逾時而變成 unknown，或把「跑得慢」誤當成攻擊成立；步數上
// 限配固定 randomSeed，結果與機器快慢無關。
const RECHECK_PARAMS = {
  randomSeed: 42,
  checker: 'auto',
  timeout: null,
  attackTimeout: null,
  incubationTimeout: null,
};

// worker 端：逐條收 { index, source, flags }，回傳分析結果的可序列化摘要。
const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { checkSync } = require(workerData.recheckPath);
  parentPort.on('message', (job) => {
    const result = checkSync(job.source, job.flags, workerData.params);
    parentPort.postMessage({
      index: job.index,
      status: result.status,
      complexity: result.complexity ? result.complexity.summary : null,
      errorKind: result.error ? result.error.kind : null,
      attack: result.attack ? result.attack.pattern : null,
    });
  });
`;

// 以 worker 池並行分析 items，回傳與 items 同序的結果陣列。
function checkAllInParallel(items) {
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  // 留一顆核心給主執行緒與同時在跑的其他測試檔，上限 6：再多就被 worker
  // 各自載入 recheck 的成本吃掉。
  const poolSize = Math.max(1, Math.min(items.length, cores - 1, 6));
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  return new Promise((resolve, reject) => {
    const workers = [];
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      for (const w of workers) w.terminate();
      if (err) reject(err);
      else resolve(results);
    };
    const dispatch = (worker) => {
      if (next >= items.length) return;
      const index = next++;
      worker.postMessage({ index, source: items[index].source, flags: items[index].flags });
    };
    for (let k = 0; k < poolSize; k++) {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { recheckPath: require.resolve('recheck'), params: RECHECK_PARAMS },
        env: { ...process.env, RECHECK_BACKEND: 'pure' },
      });
      worker.on('message', (msg) => {
        results[msg.index] = msg;
        done++;
        if (done === items.length) finish();
        else dispatch(worker);
      });
      worker.on('error', finish);
      // 還有結果沒收齊時 worker 就結束（沒拋錯也算），整批立即失敗，不等到測
      // 試逾時；收齊之後 finish 已結算，terminate 觸發的 exit 在這裡被忽略。
      worker.on('exit', (code) => {
        finish(new Error('recheck worker 在分析完成前結束，exit code ' + code));
      });
      workers.push(worker);
      dispatch(worker);
    }
  });
}

// 動態建構的 new RegExp：key 是「檔名:建構式第一個引數的開頭片段」，以前綴
// 比對，不綁行號，避免無關改動讓清單失效。這些樣式不在 G1 閘門內（G1 只管
// 字面量與靜態字串），列在這裡是為了讓新增的動態建構一定被看見。
const DYNAMIC_REGEXP_ALLOWLIST = {
  // 兩段字面值夾一個經 escapeRegExp 跳脫的 handle，無量詞。
  "sw-scam.js:'\"username\":\"' + escapeRegExp(handle)": '跳脫後的字面值比對，無量詞',
  // og meta 擷取，屬性名經 escapeRegExp 跳脫。以 og:title 代入、用本檔的
  // RECHECK_PARAMS 試跑 recheck：property 在前的一條 vulnerable（automaton
  // 判定三次方），content 在前的一條 vulnerable（fuzz 判定二次方）。輸入是
  // fetch 回來的 HTML，工作量由 sw-og.js 的 OG_SCAN_LIMIT 封頂，屬未納
  // 入閘門的已知風險（不改寫的理由見 sw-og.js extractOgMeta 的註解）。
  'sw-og.js:`<meta[^>]+property="${escaped}"': 'og meta 擷取（property 在前），未納入閘門',
  'sw-og.js:`<meta[^>]+content="([^"]*)"': 'og meta 擷取（content 在前），未納入閘門',
  // 由常數字元清單組出的單一字元類，無量詞。
  "tcl-core.js:'[' + cls + ']'": '單一字元類，無量詞',
  // 以既有正則的 source／flags 複製出 g 旗標版本；來源正則本身已在掃描範圍內。
  'tcl-core.js:pattern.source, pattern.flags': '複製既有正則並加 g 旗標',
};

// ---- 極簡 JS tokenizer：只為了把正則字面量從註解、字串、模板字串裡分出來 ----

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

// 回傳 { regexes: [{ line, source, flags }], strings: [{ start, end, value? }] }
function tokenize(src) {
  const regexes = [];
  const stringsByStart = new Map();
  let i = 0;
  let line = 1;
  // 上一個有意義的 token：'ident'、'keyword'、'num'、'punct'（附字元）
  let prev = { type: 'punct', value: '(' };
  // 模板字串 ${ } 的巢狀：每層記錄進入 ${ 時的大括號深度
  const templateStack = [];
  let braceDepth = 0;

  function advance(n) {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') line++;
      i++;
    }
  }

  function readQuoted(quote) {
    const start = i;
    advance(1);
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') advance(1);
      advance(1);
    }
    advance(1);
    stringsByStart.set(start, { start, end: i, raw: src.slice(start, i), kind: 'string' });
  }

  // 從 ` 或 } 之後讀模板片段，直到結尾 ` 或 ${。
  function readTemplateChunk() {
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { advance(2); continue; }
      if (ch === '`') { advance(1); return 'end'; }
      if (ch === '$' && src[i + 1] === '{') { advance(2); return 'expr'; }
      advance(1);
    }
    return 'end';
  }

  function readRegex() {
    const startLine = line;
    advance(1);
    let body = '';
    let inClass = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\n') throw new Error('正則字面量跨行，tokenizer 判斷錯誤，行 ' + startLine);
      if (ch === '\\') { body += ch + src[i + 1]; advance(2); continue; }
      if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === '/') {
        break;
      }
      body += ch;
      advance(1);
    }
    advance(1);
    let flags = '';
    while (i < src.length && /[a-z]/.test(src[i])) { flags += src[i]; advance(1); }
    regexes.push({ line: startLine, source: body, flags });
  }

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { advance(1); continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') advance(1);
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      advance((end === -1 ? src.length : end + 2) - i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      readQuoted(ch);
      prev = { type: 'string' };
      continue;
    }
    if (ch === '`') {
      const start = i;
      advance(1);
      const r = readTemplateChunk();
      if (r === 'expr') templateStack.push(braceDepth);
      stringsByStart.set(start, { start, end: i, raw: src.slice(start, i), kind: 'template' });
      prev = r === 'expr' ? { type: 'punct', value: '(' } : { type: 'string' };
      continue;
    }
    if (ch === '}' && templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
      templateStack.pop();
      advance(1);
      const r = readTemplateChunk();
      if (r === 'expr') templateStack.push(braceDepth);
      prev = r === 'expr' ? { type: 'punct', value: '(' } : { type: 'string' };
      continue;
    }
    if (ch === '/') {
      const divisionContext =
        prev.type === 'ident' || prev.type === 'num' || prev.type === 'string' ||
        (prev.type === 'punct' && (prev.value === ')' || prev.value === ']'));
      if (!divisionContext) {
        readRegex();
        prev = { type: 'regex' };
        continue;
      }
      advance(1);
      prev = { type: 'punct', value: '/' };
      continue;
    }
    if (isIdentChar(ch)) {
      let word = '';
      while (i < src.length && isIdentChar(src[i])) { word += src[i]; advance(1); }
      if (/^[0-9]/.test(word)) prev = { type: 'num' };
      else prev = REGEX_PRECEDING_KEYWORDS.has(word) ? { type: 'keyword' } : { type: 'ident' };
      continue;
    }
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    advance(1);
    prev = { type: 'punct', value: ch };
  }

  return { regexes, stringsByStart };
}

function lineOf(src, index) {
  let n = 1;
  for (let k = 0; k < index; k++) if (src[k] === '\n') n++;
  return n;
}

// 找出 `new RegExp(`，第一個引數若是單一字串字面量（後面緊接 `)` 或 `,` 加
// 另一個字串字面量），取其值；否則列為動態。
function findRegExpConstructors(src, stringsByStart) {
  const staticOnes = [];
  const dynamicOnes = [];
  const re = /new\s+RegExp\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // 落在字串或註解裡的不算；以 tokenizer 已知的字串區段排除字串內的出現。
    const at = m.index;
    let insideString = false;
    for (const s of stringsByStart.values()) {
      if (at > s.start && at < s.end) { insideString = true; break; }
    }
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const lineText = src.slice(lineStart, at);
    if (insideString || /\/\/|^\s*\*/.test(lineText)) continue;

    let j = m.index + m[0].length;
    while (/\s/.test(src[j])) j++;
    const argStart = j;
    const first = stringsByStart.get(j);
    let isStatic = false;
    let source;
    let flags = '';
    if (first && first.kind === 'string') {
      j = first.end;
      while (/\s/.test(src[j])) j++;
      if (src[j] === ')') {
        isStatic = true;
      } else if (src[j] === ',') {
        j++;
        while (/\s/.test(src[j])) j++;
        const second = stringsByStart.get(j);
        if (second && second.kind === 'string') {
          j = second.end;
          while (/\s/.test(src[j])) j++;
          if (src[j] === ')') {
            isStatic = true;
            flags = Function('"use strict"; return ' + second.raw)();
          }
        }
      }
      if (isStatic) source = Function('"use strict"; return ' + first.raw)();
    }
    const line = lineOf(src, at);
    if (isStatic) {
      staticOnes.push({ line, source, flags });
    } else {
      dynamicOnes.push({ line, head: src.slice(argStart, argStart + 40).replace(/\s+/g, ' ') });
    }
  }
  return { staticOnes, dynamicOnes };
}

function collectAll() {
  const items = [];
  const dynamic = [];
  for (const file of PRODUCT_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const { regexes, stringsByStart } = tokenize(src);
    for (const r of regexes) items.push({ file, kind: 'literal', ...r });
    const { staticOnes, dynamicOnes } = findRegExpConstructors(src, stringsByStart);
    for (const r of staticOnes) items.push({ file, kind: 'new RegExp', ...r });
    for (const d of dynamicOnes) dynamic.push({ file, ...d });
  }
  return { items, dynamic };
}

const { items: ALL_REGEXES, dynamic: DYNAMIC_REGEXPS } = collectAll();

test('G1 tokenizer 自檢：抽得出已知的兩條目標正則，且每條都是合法正則', () => {
  assert.ok(ALL_REGEXES.length > 20, '抽出的正則數量異常少：' + ALL_REGEXES.length);
  for (const r of ALL_REGEXES) {
    assert.doesNotThrow(
      () => new RegExp(r.source, r.flags),
      r.file + ':' + r.line + ' 抽出的不是合法正則：/' + r.source + '/' + r.flags
    );
  }
  // 兩條已知有回溯問題的正則所在的宣告必須在掃描範圍內（改寫後樣式會變，
  // 這裡只確認兩個檔案都有抽到東西，不綁樣式內容）。
  assert.ok(ALL_REGEXES.some((r) => r.file === 'tcl-core.js'), 'tcl-core.js 沒有抽到任何正則');
  assert.ok(ALL_REGEXES.some((r) => r.file === 'scam-guard.js'), 'scam-guard.js 沒有抽到任何正則');
});

test('G1 動態建構的 new RegExp 都在白名單內並註明原因', () => {
  const keys = Object.keys(DYNAMIC_REGEXP_ALLOWLIST);
  const unknown = DYNAMIC_REGEXPS.filter((d) => !keys.some((k) => (d.file + ':' + d.head).startsWith(k)));
  assert.deepEqual(
    unknown.map((d) => d.file + ':' + d.line + '  ' + d.head),
    [],
    '以下 new RegExp 的樣式無法靜態取得，請改寫成字面量或加進 DYNAMIC_REGEXP_ALLOWLIST 並註明原因'
  );
});

test('G1 recheck：所有產品檔正則必須為 safe（線性）', async () => {
  const failures = [];
  const results = await checkAllInParallel(ALL_REGEXES);
  for (let k = 0; k < ALL_REGEXES.length; k++) {
    const r = ALL_REGEXES[k];
    const result = results[k];
    if (result.status !== 'safe') {
      const complexity = result.complexity || '—';
      const reason = result.status === 'unknown' && result.errorKind ? '（' + result.errorKind + '）' : '';
      const attack = result.attack ? '  攻擊字串：' + result.attack : '';
      failures.push(
        r.file + ':' + r.line + '  [' + r.kind + ']  /' + r.source + '/' + r.flags +
          '\n    status=' + result.status + reason + '  complexity=' + complexity + attack
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    '共掃描 ' + ALL_REGEXES.length + ' 條正則，' + failures.length + ' 條非 safe：\n' + failures.join('\n')
  );
});
