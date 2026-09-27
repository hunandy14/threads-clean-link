// test/storage-mutate.test.js — TCLCore 的儲存讀改寫模板（SW-1b）單元契約。
//
// 規格：simplify/design-sw.md §1.2。
//   TCLCore.createSerialQueue() → enqueue(fn)：單一 promise 佇列，前一個失敗
//     不阻塞後一個，回傳的是「這一次」的 promise。
//   TCLCore.createMutator({ area, enqueue }) → mutate(key, fn, opts)
//     opts = { normalize(raw), cap(value, level), onQuota: 'skip'|'throw' }
//     fn(current) 回 undefined＝不寫；回 { next, result }＝寫 next，交回 result。
//     寫入撞配額：cap level 0 失敗 → level 1 收緊再寫一次 → 仍失敗依 onQuota。
//     非配額錯誤 → 拋 code 'storage_write_failed'，cause 帶原錯誤。
//
// 【時序紀律】假 storage 一律跨 tick 結算（setImmediate），不在同 tick resolve。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TCLCore = require('../tcl-core.js');

// tcl-core 的 isQuotaExceededError 以訊息含 QUOTA_BYTES 辨識。
function quotaError() {
  return new Error('QUOTA_BYTES quota exceeded');
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 假的 chrome.storage 區域。setImpl(items, n) 可逐次覆寫 set 的行為（n 從 1 起算），
// 回傳 promise 就沿用它，回傳 undefined 就走正常落盤。
function makeArea(seed = {}, setImpl) {
  const data = Object.assign({}, seed);
  const calls = { get: [], set: [] };
  const log = [];
  return {
    data,
    calls,
    log,
    get(keys) {
      calls.get.push(keys);
      log.push('get');
      return tick().then(() => {
        const out = Object.assign({}, keys);
        Object.keys(keys).forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
        });
        return out;
      });
    },
    set(items) {
      calls.set.push(JSON.parse(JSON.stringify(items)));
      log.push('set:' + Object.keys(items).join(','));
      const n = calls.set.length;
      const custom = setImpl ? setImpl(items, n) : undefined;
      if (custom) return custom;
      return tick().then(() => {
        Object.assign(data, items);
      });
    },
  };
}

function requireFactories() {
  assert.equal(typeof TCLCore.createSerialQueue, 'function', 'TCLCore.createSerialQueue 應為函式');
  assert.equal(typeof TCLCore.createMutator, 'function', 'TCLCore.createMutator 應為函式');
}

function makeMutate(area) {
  requireFactories();
  const enqueue = TCLCore.createSerialQueue();
  return { enqueue, mutate: TCLCore.createMutator({ area, enqueue }) };
}

const asNumber = (raw) => (typeof raw === 'number' ? raw : 0);

// ---- createSerialQueue ----

test('SQ 佇列 FIFO：後排的工作等前一個整段跑完才開始，回傳值是這一次的結果', async () => {
  requireFactories();
  const enqueue = TCLCore.createSerialQueue();
  const events = [];
  const a = enqueue(async () => {
    events.push('a:start');
    await delay(15);
    events.push('a:end');
    return 'A';
  });
  const b = enqueue(async () => {
    events.push('b:start');
    return 'B';
  });
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
});

test('SQ 佇列中某次 reject 不阻塞後續（tail catch），該次 promise 如實 reject', async () => {
  requireFactories();
  const enqueue = TCLCore.createSerialQueue();
  const boom = new Error('boom');
  const first = enqueue(async () => {
    throw boom;
  });
  const second = enqueue(async () => 'ok');
  await assert.rejects(first, (err) => err === boom, '失敗的那一次要把原錯誤交回呼叫端');
  assert.equal(await second, 'ok', '前一個失敗不得卡住後一個');
});

// ---- createMutator：序列化 ----

test('MU 序列化：同 key 兩次 mutate 依序執行，第二個 fn 看到第一個寫入後的值', async () => {
  const area = makeArea({ counter: 0 });
  const { mutate } = makeMutate(area);
  const seen = [];
  const bump = async (current) => {
    seen.push(current);
    await delay(10);
    return { next: current + 1, result: current };
  };
  const [r1, r2] = await Promise.all([
    mutate('counter', bump, { normalize: asNumber, onQuota: 'throw' }),
    mutate('counter', bump, { normalize: asNumber, onQuota: 'throw' }),
  ]);
  assert.deepEqual(seen, [0, 1], '第二個 fn 必須讀到第一個寫入後的值');
  assert.equal(area.data.counter, 2, '兩次都落地，沒有互相覆蓋');
  assert.equal(r1.result, 0);
  assert.equal(r2.result, 1);
});

test('MU 序列化：不同 key 也走同一條佇列，後一個 fn 等前一個 set 結算才開始', async () => {
  const area = makeArea({});
  const { mutate } = makeMutate(area);
  const events = [];
  const slow = mutate(
    'a',
    async () => {
      events.push('a:fn');
      await delay(15);
      return { next: 1, result: 'a' };
    },
    { normalize: asNumber, onQuota: 'throw' }
  );
  const fast = mutate(
    'b',
    async () => {
      events.push('b:fn');
      return { next: 2, result: 'b' };
    },
    { normalize: asNumber, onQuota: 'throw' }
  );
  await Promise.all([slow, fast]);
  assert.deepEqual(events, ['a:fn', 'b:fn']);
  assert.deepEqual(
    area.log.filter((x) => x !== 'get'),
    ['set:a', 'set:b'],
    '單一佇列：a 的寫入整段完成後才輪到 b'
  );
  assert.ok(area.log.indexOf('set:a') < area.log.lastIndexOf('get'), 'b 的讀取排在 a 的寫入之後');
});

test('MU 與同一條 enqueue 上的非 mutate 工作互相序列化', async () => {
  const area = makeArea({ k: 0 });
  const { enqueue, mutate } = makeMutate(area);
  const events = [];
  const raw = enqueue(async () => {
    events.push('raw:start');
    await delay(15);
    events.push('raw:end');
  });
  const m = mutate(
    'k',
    async (cur) => {
      events.push('mutate:fn');
      return { next: cur + 1, result: null };
    },
    { normalize: asNumber, onQuota: 'throw' }
  );
  await Promise.all([raw, m]);
  assert.deepEqual(events, ['raw:start', 'raw:end', 'mutate:fn']);
});

// ---- createMutator：寫與不寫 ----

test('MU fn 回 undefined：不呼叫 set，回 { written:false }', async () => {
  const area = makeArea({ k: 5 });
  const { mutate } = makeMutate(area);
  const out = await mutate('k', async () => undefined, { normalize: asNumber, onQuota: 'throw' });
  assert.equal(area.calls.set.length, 0, 'fn 回 undefined 代表不寫');
  assert.equal(out.written, false);
  assert.equal(out.result, undefined);
});

test('MU fn 回 { next, result }：寫入 { [key]: next } 一次並交回 result', async () => {
  const area = makeArea({ k: 5 });
  const { mutate } = makeMutate(area);
  const out = await mutate('k', async (cur) => ({ next: cur * 2, result: 'done' }), {
    normalize: asNumber,
    onQuota: 'throw',
  });
  assert.deepEqual(area.calls.set, [{ k: 10 }]);
  assert.equal(area.data.k, 10);
  assert.equal(out.written, true);
  assert.equal(out.result, 'done');
});

test('MU normalize 在 fn 之前套用：fn 拿到的是正規化後的值，normalize 拿到原始值', async () => {
  const area = makeArea({ list: 'garbage' });
  const { mutate } = makeMutate(area);
  const normalizeArgs = [];
  let fnArg;
  await mutate(
    'list',
    async (cur) => {
      fnArg = cur;
      return undefined;
    },
    {
      normalize: (raw) => {
        normalizeArgs.push(raw);
        return Array.isArray(raw) ? raw : [];
      },
      onQuota: 'throw',
    }
  );
  assert.deepEqual(normalizeArgs, ['garbage']);
  assert.deepEqual(fnArg, []);
});

test('MU 鍵不存在時 normalize 收到缺席值（null／undefined），不拋錯', async () => {
  const area = makeArea({});
  const { mutate } = makeMutate(area);
  let raw = 'untouched';
  await mutate('missing', async () => undefined, {
    normalize: (r) => {
      raw = r;
      return [];
    },
    onQuota: 'throw',
  });
  assert.ok(raw === null || raw === undefined, 'normalize 收到 ' + String(raw));
});

test('MU 有 cap 時寫入值先過 cap(next, 0)', async () => {
  const area = makeArea({});
  const { mutate } = makeMutate(area);
  const capCalls = [];
  await mutate('k', async () => ({ next: [1, 2, 3], result: null }), {
    normalize: () => [],
    cap: (value, level) => {
      capCalls.push(level);
      return value.slice(0, 2);
    },
    onQuota: 'throw',
  });
  assert.deepEqual(capCalls, [0]);
  assert.deepEqual(area.calls.set, [{ k: [1, 2] }]);
});

// ---- createMutator：配額與錯誤 ----

function capSpy() {
  const levels = [];
  const cap = (value, level) => {
    levels.push(level);
    return level === 0 ? value : value.slice(0, 1);
  };
  return { levels, cap };
}

test('MU 撞配額：cap level 0 失敗 → 以 level 1 收緊再 set 一次，成功即 written:true', async () => {
  const area = makeArea({}, (items, n) => (n === 1 ? Promise.reject(quotaError()) : undefined));
  const { mutate } = makeMutate(area);
  const spy = capSpy();
  const out = await mutate('k', async () => ({ next: [3, 2, 1], result: 'r' }), {
    normalize: () => [],
    cap: spy.cap,
    onQuota: 'skip',
  });
  assert.deepEqual(spy.levels, [0, 1], '第一次用 level 0，撞配額後用 level 1 收緊');
  assert.equal(area.calls.set.length, 2, '收緊後再寫一次');
  assert.deepEqual(area.calls.set[1], { k: [3] }, '第二次寫的是 level 1 收緊後的內容');
  assert.equal(out.written, true);
  assert.equal(out.result, 'r');
});

test("MU 收緊後仍撞配額且 onQuota:'skip'：回 { written:false, quota:true }，不再重試", async () => {
  const area = makeArea({}, () => Promise.reject(quotaError()));
  const { mutate } = makeMutate(area);
  const spy = capSpy();
  const out = await mutate('k', async () => ({ next: [3, 2, 1], result: 'r' }), {
    normalize: () => [],
    cap: spy.cap,
    onQuota: 'skip',
  });
  assert.equal(area.calls.set.length, 2, '只重試一次（level 0、level 1）');
  assert.equal(out.written, false);
  assert.equal(out.quota, true);
});

test("MU 收緊後仍撞配額且 onQuota:'throw'：拋 code storage_quota", async () => {
  const area = makeArea({}, () => Promise.reject(quotaError()));
  const { mutate } = makeMutate(area);
  const spy = capSpy();
  await assert.rejects(
    mutate('k', async () => ({ next: [3, 2, 1], result: 'r' }), {
      normalize: () => [],
      cap: spy.cap,
      onQuota: 'throw',
    }),
    (err) => err && err.code === 'storage_quota'
  );
  assert.equal(area.calls.set.length, 2);
});

test('MU 沒有 cap 時撞配額不重試：set 一次，依 onQuota 處理', async () => {
  const area = makeArea({}, () => Promise.reject(quotaError()));
  const { mutate } = makeMutate(area);
  await assert.rejects(
    mutate('k', async () => ({ next: [1], result: null }), { normalize: () => [], onQuota: 'throw' }),
    (err) => err && err.code === 'storage_quota'
  );
  assert.equal(area.calls.set.length, 1, '沒有 cap 就沒有收緊的餘地，不重寫同一份內容');
});

test('MU 非配額錯誤：拋 code storage_write_failed、cause 帶原錯誤，不重試', async () => {
  const original = new Error('IO error');
  const area = makeArea({}, () => Promise.reject(original));
  const { mutate } = makeMutate(area);
  const spy = capSpy();
  await assert.rejects(
    mutate('k', async () => ({ next: [1, 2], result: null }), {
      normalize: () => [],
      cap: spy.cap,
      onQuota: 'skip',
    }),
    (err) => err && err.code === 'storage_write_failed' && err.cause === original
  );
  assert.equal(area.calls.set.length, 1, '非配額錯誤收緊也沒用，不重試');
  assert.deepEqual(spy.levels, [0]);
});

test('MU 某次 mutate 失敗不阻塞同佇列的下一次', async () => {
  const area = makeArea({ k: 1 });
  const { mutate } = makeMutate(area);
  const failing = mutate(
    'k',
    async () => {
      throw new Error('fn blew up');
    },
    { normalize: asNumber, onQuota: 'throw' }
  );
  const next = mutate('k', async (cur) => ({ next: cur + 1, result: 'after' }), {
    normalize: asNumber,
    onQuota: 'throw',
  });
  await assert.rejects(failing, /fn blew up/);
  const out = await next;
  assert.equal(out.result, 'after');
  assert.equal(area.data.k, 2);
});

// ---- capScamBlocklist 的 limits 參數（level 1 收緊用） ----

test('CAP capScamBlocklist 接受 limits.maxEntries：依 updatedAt 留最新 N 筆', () => {
  const entries = {};
  for (let i = 0; i < 5; i++) {
    entries[String(10000000000 + i)] = {
      state: 'active',
      handle: 'h' + i,
      source: 'auto',
      addedAt: 1000 + i,
      updatedAt: 1000 + i,
      evidence: [],
    };
  }
  const out = TCLCore.capScamBlocklist({ version: 2, entries, handleIndex: {} }, { maxEntries: 3 });
  assert.deepEqual(
    Object.keys(out.entries).sort(),
    ['10000000002', '10000000003', '10000000004'],
    'limits.maxEntries 生效，淘汰最舊的兩筆'
  );
  assert.equal(out.handleIndex.h0, undefined, '被淘汰條目的反查鍵一起清掉');
});

test('CAP capScamBlocklist 不帶 limits 時行為不變（預設 SCAM_LIMITS）', () => {
  const entries = {
    10000000001: { state: 'active', handle: 'a', source: 'auto', addedAt: 1, updatedAt: 1, evidence: [] },
    10000000002: { state: 'active', handle: 'b', source: 'auto', addedAt: 2, updatedAt: 2, evidence: [] },
  };
  const out = TCLCore.capScamBlocklist({ version: 2, entries, handleIndex: {} });
  assert.equal(Object.keys(out.entries).length, 2);
});
