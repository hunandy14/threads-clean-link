// test/sync-env.test.js — test/support/sync-env.js 的自測：每個 profile 參數
// 確實改變替身行為。sync 系列測試依賴這些差異（延遲結算、拷貝深淺、alarms
// 是否保存排程、auth payload），參數失效時各檔仍可能全綠，所以在這裡直接守。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  T0,
  createSyncStorage,
  createAlarmsMock,
  createAuthMock,
  signedInState,
  createSyncEnv,
} = require('./support/sync-env');

// 讓出 n 輪微任務，不跨巨集任務。
async function microtasks(n = 10) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

for (const defer of ['immediate', 'timeout']) {
  test(`createSyncStorage：defer '${defer}' 時 get 不在同一輪微任務內 resolve`, async () => {
    const storage = createSyncStorage({ k: 1 }, {}, { defer });
    let resolved = false;
    const pending = storage.api.local.get('k').then((out) => {
      resolved = true;
      return out;
    });
    await microtasks();
    assert.equal(resolved, false, '結算必須延到下一輪巨集任務');
    assert.deepEqual(await pending, { k: 1 });
  });
}

test('createSyncStorage：deepClone 開啟時改動種子與整區讀取結果都不影響儲存值', async () => {
  const seed = { list: { a: 1 } };
  const storage = createSyncStorage(seed, {}, { deepClone: true });
  seed.list.a = 2;
  const all = await storage.api.local.get(null);
  all.list.a = 3;
  assert.deepEqual(storage.localData.list, { a: 1 });
});

test('createSyncStorage：deepClone 關閉時整區讀取結果與儲存值共用巢狀參照', async () => {
  const storage = createSyncStorage({ list: { a: 1 } });
  const all = await storage.api.local.get(null);
  all.list.a = 3;
  assert.deepEqual(storage.localData.list, { a: 3 });
});

test('createAlarmsMock：stateful 時 create 之後 get／getAll 看得到該 alarm，clear 後消失', async () => {
  const alarms = createAlarmsMock();
  alarms.api.create('tick', { delayInMinutes: 1 });
  assert.deepEqual(await alarms.api.get('tick'), { name: 'tick', delayInMinutes: 1 });
  assert.deepEqual(await alarms.api.getAll(), [{ name: 'tick', delayInMinutes: 1 }]);
  await alarms.api.clear('tick');
  assert.equal(await alarms.api.get('tick'), undefined);
});

test('createAlarmsMock：stateful 為 false 時只側錄呼叫，get／getAll 看不到任何 alarm', async () => {
  const alarms = createAlarmsMock({ stateful: false });
  alarms.api.create('tick', { delayInMinutes: 1 });
  assert.equal(await alarms.api.get('tick'), undefined);
  assert.deepEqual(await alarms.api.getAll(), []);
  assert.equal(alarms.creates().length, 1);
});

test('createAuthMock：payload 預設帶 name／picture，顯式傳 null 時不帶該 claim', async () => {
  const full = await createAuthMock(null).signInWithGoogle();
  assert.equal(full.payload.name, 'Fake Payload Name');
  assert.equal(typeof full.payload.picture, 'string');

  const bare = await createAuthMock(null, { payloadName: null, payloadPicture: null }).signInWithGoogle();
  assert.deepEqual(bare.payload, { sub: 'user-abc', email: 'someone@example.com' });
});

test('signedInState：預設欄位固定，over 覆寫與追加欄位', () => {
  assert.deepEqual(signedInState(), {
    userId: 'user-abc',
    email: 'someone@example.com',
    cursor: '0',
    lastSyncedAt: T0 - 10 * 60_000,
    lastError: null,
  });
  assert.deepEqual(signedInState({ cursor: 'c1', marksCursor: null }), {
    userId: 'user-abc',
    email: 'someone@example.com',
    cursor: 'c1',
    lastSyncedAt: T0 - 10 * 60_000,
    lastError: null,
    marksCursor: null,
  });
});

test('createSyncEnv：profile 的 auth 與 signedInState 確實接到環境', async () => {
  const env = createSyncEnv(
    { signedIn: true },
    {
      auth: { payloadPicture: null },
      signedInState: (over) => signedInState(Object.assign({ cursor: 'p1' }, over)),
    }
  );
  assert.equal(env.storage.localData.syncState.cursor, 'p1');
  const res = await env.deps.auth.signInWithGoogle();
  assert.equal('picture' in res.payload, false);
  assert.equal(res.payload.name, 'Fake Payload Name');
});
