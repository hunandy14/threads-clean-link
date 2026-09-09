// test/mock-sync-server.test.js — 假後端 test/helpers/mock-sync-server.js 的裝置
// 歸屬（0.7）擴充契約，紅燈先行。
//
// 唯一真相源：tmp/cloud-sync-plan-full.md 第 9 節「裝置歸屬（0.7）後端契約凍結版」
// （後端 repo docs/api-spec.md §4.7 的凍結摘要）。插件側實作計畫見
// tmp/device-attribution-plan.md 第 7 節。
//
// ============================================================================
// 本檔釘定的擴充（mock 尚未實作，以下形狀由測試釘死）
// ============================================================================
// - `GET /api/v1/devices` → 200
//   `{ devices: [{deviceId,name,platform,createdAt,lastSeenAt,removedAt}] }`，lastSeenAt DESC、
//   不分頁，活躍與已移除混排（活躍者 removedAt 為 null）。契約 §13 翻轉，原為嚴格五欄。
// - `PUT /api/v1/devices/:deviceId` body `{ name, platform? }` → 200 `{ device }`；
//   建立時 platform 必填、改名可省；每次呼叫都更新 lastSeenAt。
// - `DELETE /api/v1/devices/:deviceId` → 軟刪除：只標 `removedAt`，冪等 200 `{ ok: true }`；
//   已上傳事件的 seen[].deviceId 不動。契約 §13 翻轉，原為硬刪除。
// - `POST /api/v1/links/sync` 可選頂層 `device` 區塊與 `seen[].deviceId`；
//   upsert 不覆寫 name、lastSeenAt 只在 >30 分鐘或 platform 改變時寫入、
//   無效輸入靜默丟棄、回應不帶 `devices`。
// - 驗證錯誤碼（僅 PUT／DELETE）：422 `bad_device_id`／`bad_device_platform`／
//   `bad_device_name`、415、400、401。
//
// 錯誤 body 形狀沿用既有總表：`{ "error": "<code>" }`（mock 既有 401／415／422 皆同）。
//
// PM 裁決（2026-09-07，後端會話離線期間暫行）：
// 1. name 正規化 ＝ 剝控制字元 ＋ trim，純空白同樣 422 `bad_device_name`。
// 2. 裝置三端點與 `/api/v1/links` **共用**同一個 per-user 限流桶（契約字面）。
// 3. lastSeenAt 節流維持嚴格「距上次 >30 分鐘」。
// 4. sync 內嵌 device 首次註冊缺 platform ＝ 無效區塊，靜默丟棄不建立。
// 5. DELETE 的 deviceId 驗證先於冪等：爛 id 回 422 `bad_device_id`。
// 6. sync 內嵌註冊同樣觸發超過裝置上限的淘汰。
// 7. GET 每項嚴格六欄（契約 §13 翻轉，原為五欄；第六欄 removedAt）。
//
// 備註：契約寫「Bearer＋csrfGuard＋per-user 限流」，但既有 mock 並未實作 origin
// 檢查（403 `forbidden_origin` 只能靠 `failNext` 注入），故本檔不測 403。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockSyncServer, RATE_LIMIT_MAX, MAX_DEVICES } = require('./helpers/mock-sync-server.js');

const BASE = 'https://api.metalinkclearer.workers.dev';
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

// 契約：deviceId 需 UUID 形狀（大小寫不敏感、不驗版本位、伺服器存小寫）。
const DEV_A = '11111111-2222-4333-8444-555555555555';
const DEV_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DEV_ZERO = '00000000-0000-0000-0000-000000000000';
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

// 塞滿裝置上限的批次備料用：由序號生成合法形狀的 UUID。
function uuidOf(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * 一台已登入的假後端 ＋ 可控時鐘 ＋ 三支裝置端點的呼叫捷徑。
 * 時間一律由 `at` 驅動（mock 的 `now` 注入），30 分鐘節流測試靠它推進。
 */
function harness(options = {}) {
  const clock = { at: options.startAt === undefined ? T0 : options.startAt };
  const server = createMockSyncServer({ now: () => clock.at });
  const token = server.grantToken();

  function call(method, path, opts = {}) {
    const init = { method, headers: {} };
    const useToken = Object.prototype.hasOwnProperty.call(opts, 'token') ? opts.token : token;
    if (useToken !== null) init.headers.authorization = `Bearer ${useToken}`;
    if (opts.rawBody !== undefined) {
      init.body = opts.rawBody;
      init.headers['content-type'] = opts.contentType || 'application/json';
    } else if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers['content-type'] = opts.contentType || 'application/json';
    } else if (opts.contentType) {
      init.headers['content-type'] = opts.contentType;
    }
    return server.fetch(`${BASE}${path}`, init);
  }

  return {
    server,
    token,
    clock,
    advance(ms) {
      clock.at += ms;
      return clock.at;
    },
    listDevices(opts) {
      return call('GET', '/api/v1/devices', opts);
    },
    putDevice(deviceId, body, opts) {
      return call('PUT', `/api/v1/devices/${deviceId}`, Object.assign({ body }, opts));
    },
    deleteDevice(deviceId, opts) {
      return call('DELETE', `/api/v1/devices/${deviceId}`, opts);
    },
    sync(body, opts) {
      return call('POST', '/api/v1/links/sync', Object.assign({ body }, opts));
    },
    listLinks(opts) {
      return call('GET', '/api/v1/links', opts);
    },
  };
}

function linkItem(overrides = {}) {
  return Object.assign(
    {
      id: 'local-1',
      original: 'https://www.threads.com/@alice/post/AAAAAAAAAAA?igshid=1',
      cleaned: 'https://www.threads.com/@alice/post/AAAAAAAAAAA',
      receivedAt: T0,
      seen: [{ at: T0, source: 'share' }],
    },
    overrides
  );
}

async function devicesOf(h, opts) {
  const res = await h.listDevices(opts);
  const body = await res.json();
  return { res, body, devices: (body && body.devices) || [] };
}

async function deviceById(h, deviceId) {
  const { devices } = await devicesOf(h);
  return devices.find((d) => d.deviceId === deviceId) || null;
}

// 端點未實作時 deviceById 會回 null；先斷言存在，讓失敗停在斷言而不是 TypeError。
async function requireDevice(h, deviceId) {
  const device = await deviceById(h, deviceId);
  assert.notEqual(device, null, `裝置 ${deviceId} 應存在於 GET /api/v1/devices`);
  return device;
}

// ============================================================================
// GET /api/v1/devices
// ============================================================================

test('GET /api/v1/devices：無 bearer 回 401 unauthorized', async () => {
  const h = harness();
  const res = await h.listDevices({ token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('GET /api/v1/devices：沒有任何裝置時回空陣列', async () => {
  const h = harness();
  const res = await h.listDevices();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { devices: [] });
});

test('GET /api/v1/devices：每項欄位齊全，且依 lastSeenAt DESC 排序', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  h.advance(5 * MINUTE);
  const createdB = h.clock.at;
  await h.putDevice(DEV_B, { name: '手機', platform: 'android' });

  const { res, devices } = await devicesOf(h);
  assert.equal(res.status, 200);
  assert.equal(devices.length, 2);
  assert.deepEqual(
    devices.map((d) => d.deviceId),
    [DEV_B, DEV_A],
    'lastSeenAt 較新的排前面'
  );
  // 【契約 §13 翻轉】原斷言嚴格五欄。軟刪除定稿後每項多一欄 removedAt，活躍者
  // 為 null——缺席與 null 是兩回事，客戶端要靠這一欄 filter 出管理清單。
  assert.deepEqual(Object.keys(devices[0]).sort(), [
    'createdAt',
    'deviceId',
    'lastSeenAt',
    'name',
    'platform',
    'removedAt',
  ]);
  devices.forEach((d) => {
    assert.equal(d.removedAt, null, '沒被移除過的裝置 removedAt 一律 null');
  });
  assert.equal(devices[0].name, '手機');
  assert.equal(devices[0].platform, 'android');
  assert.equal(devices[0].createdAt, createdB);
  assert.equal(devices[0].lastSeenAt, createdB);
});

// ============================================================================
// PUT /api/v1/devices/:deviceId
// ============================================================================

test('PUT /api/v1/devices：無 bearer 回 401 unauthorized', async () => {
  const h = harness();
  const res = await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' }, { token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('PUT /api/v1/devices：建立時缺 platform 回 422 bad_device_platform', async () => {
  const h = harness();
  const res = await h.putDevice(DEV_A, { name: '桌機' });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'bad_device_platform' });
  assert.deepEqual((await devicesOf(h)).devices, [], '驗證失敗不得留下半套裝置');
});

test('PUT /api/v1/devices：platform 不在枚舉回 422 bad_device_platform', async () => {
  const h = harness();
  const res = await h.putDevice(DEV_A, { name: '桌機', platform: 'windows' });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'bad_device_platform' });
});

test('PUT /api/v1/devices：三種合法 platform 皆接受', async () => {
  const h = harness();
  const platforms = ['android', 'ios', 'chrome_extension'];
  for (let i = 0; i < platforms.length; i += 1) {
    const res = await h.putDevice(uuidOf(i), { name: `d${i}`, platform: platforms[i] });
    assert.equal(res.status, 200, `platform ${platforms[i]} 應被接受`);
    const body = await res.json();
    assert.equal(body.device.platform, platforms[i]);
  }
});

test('PUT /api/v1/devices：改名可省 platform，回 { device } 且 platform 不變', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '舊名', platform: 'chrome_extension' });
  h.advance(MINUTE);

  const res = await h.putDevice(DEV_A, { name: '新名' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['device']);
  assert.equal(body.device.deviceId, DEV_A);
  assert.equal(body.device.name, '新名');
  assert.equal(body.device.platform, 'chrome_extension');
  assert.equal((await requireDevice(h, DEV_A)).name, '新名');
});

test('PUT /api/v1/devices：name 剝掉控制字元後保存', async () => {
  const h = harness();
  const raw = 'a\u0000b\u0007c\u001Fd\u007Fe';
  const res = await h.putDevice(DEV_A, { name: raw, platform: 'chrome_extension' });
  assert.equal(res.status, 200);
  const { device } = await res.json();
  assert.equal(device.name, raw.replace(CONTROL_CHARS, ''));
  assert.equal(/[\u0000-\u001F\u007F]/.test(device.name), false);
});

test('PUT /api/v1/devices：name 截到 80 個 code point（emoji 算 1）', async () => {
  const h = harness();
  const res = await h.putDevice(DEV_A, { name: '😀'.repeat(100), platform: 'chrome_extension' });
  assert.equal(res.status, 200);
  const { device } = await res.json();
  assert.equal([...device.name].length, 80, '以 code point 計，不是 UTF-16 長度');
  assert.equal(device.name, '😀'.repeat(80));

  const res2 = await h.putDevice(DEV_B, { name: 'x'.repeat(80), platform: 'android' });
  assert.equal(res2.status, 200, '剛好 80 不算超長');
  assert.equal((await res2.json()).device.name, 'x'.repeat(80));
});

test('PUT /api/v1/devices：name 正規化後為空回 422 bad_device_name', async () => {
  const h = harness();
  const empty = await h.putDevice(DEV_A, { name: '', platform: 'chrome_extension' });
  assert.equal(empty.status, 422);
  assert.deepEqual(await empty.json(), { error: 'bad_device_name' });

  const onlyControl = await h.putDevice(DEV_A, { name: '\u0000\u0007\u001F', platform: 'chrome_extension' });
  assert.equal(onlyControl.status, 422);
  assert.deepEqual(await onlyControl.json(), { error: 'bad_device_name' });

  assert.deepEqual((await devicesOf(h)).devices, []);
});

test('PUT /api/v1/devices：name 只有空白時 trim 後為空，回 422 bad_device_name', async () => {
  const h = harness();
  const blank = await h.putDevice(DEV_A, { name: '   ', platform: 'chrome_extension' });
  assert.equal(blank.status, 422);
  assert.deepEqual(await blank.json(), { error: 'bad_device_name' });
  assert.deepEqual((await devicesOf(h)).devices, [], '不得留下空名裝置');

  // 正規化 ＝ 剝控制字元 ＋ trim：前後空白剝掉後還有字就照收。
  const kept = await h.putDevice(DEV_A, { name: '  桌機  ', platform: 'chrome_extension' });
  assert.equal(kept.status, 200);
  assert.equal((await kept.json()).device.name, '桌機');
});

test('PUT /api/v1/devices：deviceId 非 UUID 回 422 bad_device_id', async () => {
  const h = harness();
  for (const bad of ['not-a-uuid', '1234', '11111111-2222-4333-8444-55555555555', 'zzzzzzzz-2222-4333-8444-555555555555']) {
    const res = await h.putDevice(bad, { name: '桌機', platform: 'chrome_extension' });
    assert.equal(res.status, 422, `${bad} 應被拒`);
    assert.deepEqual(await res.json(), { error: 'bad_device_id' });
  }
});

test('PUT /api/v1/devices：deviceId 大小寫不敏感、不驗版本位、存小寫，全零合法', async () => {
  const h = harness();
  const upper = DEV_A.toUpperCase();
  const res = await h.putDevice(upper, { name: '大寫', platform: 'chrome_extension' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).device.deviceId, DEV_A, '伺服器存小寫');

  // 版本／變體位不合 RFC，但形狀合法 → 接受。
  const oddVersion = 'f47ac10b-58cc-f372-0567-0e02b2c3d479';
  const res2 = await h.putDevice(oddVersion, { name: '怪版本', platform: 'android' });
  assert.equal(res2.status, 200);

  const res3 = await h.putDevice(DEV_ZERO, { name: '全零', platform: 'ios' });
  assert.equal(res3.status, 200);
  assert.equal((await res3.json()).device.deviceId, DEV_ZERO);

  const { devices } = await devicesOf(h);
  assert.equal(devices.length, 3, '大寫與小寫是同一台，不得重複建立');
  assert.equal(devices.filter((d) => d.deviceId === DEV_A).length, 1);
});

test('PUT /api/v1/devices：非 JSON content-type 回 415', async () => {
  const h = harness();
  const res = await h.putDevice(
    DEV_A,
    { name: '桌機', platform: 'chrome_extension' },
    { contentType: 'text/plain' }
  );
  assert.equal(res.status, 415);
  assert.deepEqual(await res.json(), { error: 'unsupported_media_type' });
});

test('PUT /api/v1/devices：body 非物件回 400', async () => {
  const h = harness();
  const arr = await h.putDevice(DEV_A, [], {});
  assert.equal(arr.status, 400);
  assert.deepEqual(await arr.json(), { error: 'bad_request' });

  const str = await h.putDevice(DEV_A, 'nope', {});
  assert.equal(str.status, 400);
  assert.deepEqual(await str.json(), { error: 'bad_request' });
});

test('PUT /api/v1/devices：每次呼叫都更新 lastSeenAt（createdAt 不動）', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  const created = await requireDevice(h, DEV_A);
  assert.equal(created.lastSeenAt, T0);

  // 遠小於 30 分鐘：PUT 路徑不套節流（節流只在 sync 內嵌路徑）。
  const at1 = h.advance(MINUTE);
  await h.putDevice(DEV_A, { name: '桌機' });
  const after1 = await requireDevice(h, DEV_A);
  assert.equal(after1.lastSeenAt, at1);
  assert.equal(after1.createdAt, T0, 'createdAt 不因改名而變');

  const at2 = h.advance(2 * MINUTE);
  const res = await h.putDevice(DEV_A, { name: '桌機二號' });
  assert.equal((await res.json()).device.lastSeenAt, at2, '回應直接帶新的 lastSeenAt');
});

// ============================================================================
// DELETE /api/v1/devices/:deviceId
// ============================================================================

test('DELETE /api/v1/devices：無 bearer 回 401 unauthorized', async () => {
  const h = harness();
  const res = await h.deleteDevice(DEV_A, { token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('DELETE /api/v1/devices：冪等回 200 { ok: true }，刪後仍在 GET 內但帶 removedAt', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  await h.putDevice(DEV_B, { name: '手機', platform: 'android' });

  const first = await h.deleteDevice(DEV_A);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });

  const second = await h.deleteDevice(DEV_A);
  assert.equal(second.status, 200, '重複刪除仍成功');
  assert.deepEqual(await second.json(), { ok: true });

  const never = await h.deleteDevice(uuidOf(999));
  assert.equal(never.status, 200, '從未存在的裝置也回成功');
  assert.deepEqual(await never.json(), { ok: true });

  // 【契約 §13 翻轉】原斷言「刪後 GET 不見」。軟刪除之後那一台仍在同一個陣列
  // 裡（帶 removedAt），從未存在過的那一個 id 則不因 DELETE 而建列。
  const { devices } = await devicesOf(h);
  assert.deepEqual(
    devices.map((d) => d.deviceId).sort(),
    [DEV_A, DEV_B].sort(),
    '已移除的仍在清單內，從未存在的不建列'
  );
  assert.equal(typeof devices.find((d) => d.deviceId === DEV_A).removedAt, 'number');
  assert.equal(devices.find((d) => d.deviceId === DEV_B).removedAt, null);
});

test('DELETE /api/v1/devices：deviceId 非 UUID 回 422 bad_device_id', async () => {
  const h = harness();
  const res = await h.deleteDevice('not-a-uuid');
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'bad_device_id' });
});

test('DELETE /api/v1/devices：已上傳事件的 seen[].deviceId 不動', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  await h.sync({
    upserts: [linkItem({ seen: [{ at: T0, source: 'share', deviceId: DEV_A }] })],
    deletes: [],
  });

  const del = await h.deleteDevice(DEV_A);
  assert.equal(del.status, 200);

  const links = await (await h.listLinks()).json();
  assert.equal(links.items.length, 1);
  assert.equal(links.items[0].seen[0].deviceId, DEV_A, '裝置移除不清事件上的 deviceId');

  // 回填路徑（sync 帶 since）看到的也是原 deviceId。
  const back = await (await h.sync({ upserts: [], deletes: [], since: '0' })).json();
  assert.equal(back.changes.links[0].seen[0].deviceId, DEV_A);
});

// ============================================================================
// POST /api/v1/links/sync 的 device 區塊
// ============================================================================

test('sync：頂層 device 區塊 upsert 出新裝置', async () => {
  const h = harness();
  const res = await h.sync({
    upserts: [linkItem()],
    deletes: [],
    device: { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' },
  });
  assert.equal(res.status, 200);

  const device = await deviceById(h, DEV_A);
  assert.notEqual(device, null, 'sync 內嵌註冊即建立裝置');
  assert.equal(device.name, 'Chrome on Windows');
  assert.equal(device.platform, 'chrome_extension');
  assert.equal(device.createdAt, T0);
  assert.equal(device.lastSeenAt, T0);
});

test('sync：裝置已存在時不覆寫 name（改名一律走 PUT）', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '使用者改過的名字', platform: 'chrome_extension' });
  h.advance(40 * MINUTE);

  await h.sync({
    upserts: [],
    deletes: [],
    device: { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' },
  });

  assert.equal((await requireDevice(h, DEV_A)).name, '使用者改過的名字');
});

test('sync：lastSeenAt 只在距上次超過 30 分鐘時更新', async () => {
  const h = harness();
  const device = { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' };
  await h.putDevice(DEV_A, { name: 'Chrome on Windows', platform: 'chrome_extension' });
  assert.equal((await requireDevice(h, DEV_A)).lastSeenAt, T0);

  h.advance(20 * MINUTE);
  await h.sync({ upserts: [], deletes: [], device });
  assert.equal((await requireDevice(h, DEV_A)).lastSeenAt, T0, '30 分鐘內不寫入');

  h.advance(10 * MINUTE); // T0 + 30 分整
  await h.sync({ upserts: [], deletes: [], device });
  assert.equal((await requireDevice(h, DEV_A)).lastSeenAt, T0, '剛好 30 分不算超過');

  const at = h.advance(MINUTE); // T0 + 31 分
  await h.sync({ upserts: [], deletes: [], device });
  assert.equal((await requireDevice(h, DEV_A)).lastSeenAt, at, '超過 30 分鐘才寫入');
});

test('sync：platform 改變時即更新 lastSeenAt 與 platform', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '同一台', platform: 'chrome_extension' });

  const at = h.advance(MINUTE);
  await h.sync({
    upserts: [],
    deletes: [],
    device: { deviceId: DEV_A, name: '同一台', platform: 'android' },
  });

  const device = await requireDevice(h, DEV_A);
  assert.equal(device.platform, 'android');
  assert.equal(device.lastSeenAt, at, 'platform 改變即更新，不受 30 分鐘節流');
});

test('sync：無效 device 區塊靜默丟棄，連結照常同步且不回錯', async () => {
  const cases = [
    ['deviceId 非 UUID', { deviceId: 'nope', name: '桌機', platform: 'chrome_extension' }],
    ['platform 不在枚舉', { deviceId: DEV_A, name: '桌機', platform: 'windows' }],
    ['name 為空', { deviceId: DEV_A, name: '', platform: 'chrome_extension' }],
    ['device 非物件', 'nope'],
  ];
  for (const [label, device] of cases) {
    const h = harness();
    const res = await h.sync({ upserts: [linkItem()], deletes: [], device });
    assert.equal(res.status, 200, `${label}：不得回錯`);
    const body = await res.json();
    assert.equal(body.error, undefined, `${label}：body 不帶 error`);
    assert.equal(body.applied.upserts.length, 1, `${label}：連結照常同步`);
    assert.equal(h.server.linkCount(), 1, `${label}：連結真的入庫`);
    assert.deepEqual((await devicesOf(h)).devices, [], `${label}：不得留下裝置`);
  }
});

test('sync：內嵌 device 首次註冊缺 platform 視為無效，靜默丟棄不建立', async () => {
  const h = harness();
  await h.putDevice(DEV_B, { name: '既有裝置', platform: 'android' });

  const res = await h.sync({
    upserts: [linkItem()],
    deletes: [],
    device: { deviceId: DEV_A, name: 'Chrome on Windows' },
  });
  assert.equal(res.status, 200, '不得回錯');
  const body = await res.json();
  assert.equal(body.error, undefined);
  assert.equal(body.applied.upserts.length, 1, '連結照常同步');

  const { devices } = await devicesOf(h);
  assert.deepEqual(
    devices.map((d) => d.deviceId),
    [DEV_B],
    '缺 platform 的新裝置不得建立，既有裝置不受影響'
  );
});

test('sync：seen[].deviceId 非 UUID 視為未提供', async () => {
  const h = harness();
  await h.sync({
    upserts: [
      linkItem({
        seen: [
          { at: T0, source: 'share', deviceId: 'nope' },
          { at: T0 + 1000, source: 'clipboard', deviceId: DEV_A },
        ],
      }),
    ],
    deletes: [],
  });

  const links = await (await h.listLinks()).json();
  const seen = links.items[0].seen;
  const dirty = seen.find((rec) => rec.at === T0);
  const clean = seen.find((rec) => rec.at === T0 + 1000);
  assert.equal(dirty.deviceId === undefined || dirty.deviceId === null, true, '髒值只丟該欄');
  assert.equal(dirty.source, 'share', '整筆事件仍保留');
  assert.equal(clean.deviceId, DEV_A);
});

test('sync：回應不帶 devices', async () => {
  const h = harness();
  const res = await h.sync({
    upserts: [linkItem()],
    deletes: [],
    since: '0',
    device: { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' },
  });
  const body = await res.json();
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'devices'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body.changes, 'devices'), false);
});

test('sync：GET links 與 changes 回填的 seen 帶 deviceId，舊事件為 null 或缺席', async () => {
  const h = harness();
  await h.sync({
    upserts: [
      linkItem({
        seen: [
          { at: T0, source: 'share' }, // 舊事件：0.6.x 客戶端不帶 deviceId
          { at: T0 + 1000, source: 'clipboard', deviceId: DEV_A },
        ],
      }),
    ],
    deletes: [],
    device: { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' },
  });

  const links = await (await h.listLinks()).json();
  const seen = links.items[0].seen;
  const legacy = seen.find((rec) => rec.at === T0);
  const owned = seen.find((rec) => rec.at === T0 + 1000);
  assert.equal(legacy.deviceId === undefined || legacy.deviceId === null, true);
  assert.equal(owned.deviceId, DEV_A);

  const back = await (await h.sync({ upserts: [], deletes: [], since: '0' })).json();
  const changed = back.changes.links[0].seen.find((rec) => rec.at === T0 + 1000);
  assert.equal(changed.deviceId, DEV_A);
});

// ============================================================================
// 每帳號裝置上限
// ============================================================================

// 塞滿 n 台裝置：每台間隔 61 秒，讓 lastSeenAt 嚴格遞增（淘汰順序可預期），
// 同時讓共用的 per-user 限流視窗（60 次／60 秒）每輪歸零。
async function seedDevices(h, count) {
  for (let i = 0; i < count; i += 1) {
    const res = await h.putDevice(uuidOf(i), { name: `d${i}`, platform: 'chrome_extension' });
    assert.equal(res.status, 200, `第 ${i} 台裝置應建立成功`);
    h.advance(61_000);
  }
}

function assertEvictedOldest(devices, newDeviceId) {
  const ids = devices.map((d) => d.deviceId);
  assert.equal(devices.length, MAX_DEVICES, '維持在上限台數');
  assert.equal(ids.includes(newDeviceId), true, '新裝置留下');
  assert.equal(ids.includes(uuidOf(0)), false, 'lastSeenAt 最舊者被淘汰');
  assert.equal(ids.includes(uuidOf(1)), true, '只淘汰溢位的那一台');
}

test('超過裝置上限：PUT 超過時淘汰 lastSeenAt 最舊者且不回錯', async () => {
  const h = harness();
  await seedDevices(h, MAX_DEVICES);
  assert.equal((await devicesOf(h)).devices.length, MAX_DEVICES);

  const overflow = await h.putDevice(uuidOf(MAX_DEVICES), { name: `d${MAX_DEVICES}`, platform: 'chrome_extension' });
  assert.equal(overflow.status, 200, '超過上限不回錯');

  assertEvictedOldest((await devicesOf(h)).devices, uuidOf(MAX_DEVICES));
});

test('超過裝置上限：sync 內嵌註冊同樣觸發淘汰', async () => {
  const h = harness();
  await seedDevices(h, MAX_DEVICES);

  const res = await h.sync({
    upserts: [linkItem()],
    deletes: [],
    device: { deviceId: DEV_A, name: '溢位的那一台', platform: 'chrome_extension' },
  });
  assert.equal(res.status, 200, '超過上限不回錯');
  const body = await res.json();
  assert.equal(body.applied.upserts.length, 1, '連結照常同步');

  assertEvictedOldest((await devicesOf(h)).devices, DEV_A);
});

test('裝置三端點與 links 共用 per-user 限流桶，超量回 429 rate_limited', async () => {
  const h = harness();
  // 時鐘不動：60 次都落在同一個 60 秒視窗內，把桶打滿。
  for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
    const res = await h.listLinks();
    assert.equal(res.status, 200, `第 ${i + 1} 次 links 請求應在額度內`);
  }

  const list = await h.listDevices();
  assert.equal(list.status, 429);
  assert.deepEqual(await list.json(), { error: 'rate_limited', retryAfter: 60 });
  assert.equal(list.headers.get('retry-after'), '60');

  const put = await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  assert.equal(put.status, 429, 'PUT 也吃同一個桶');
  const del = await h.deleteDevice(DEV_A);
  assert.equal(del.status, 429, 'DELETE 也吃同一個桶');
});

// ============================================================================
// 裝置軟刪除（契約 §13 定稿，2026-09-09）
// ============================================================================
// DELETE 從硬刪改為軟刪除，本節與上面幾條既有斷言的翻轉都出自這一段契約：
//   - `DELETE /api/v1/devices/:id` 只把 `removedAt` 標成毫秒時戳；該台仍留在
//     `GET /api/v1/devices` 的同一個陣列裡（活躍與已移除混排，客戶端自行 filter），
//     GET 每項因此由五欄變六欄（活躍者 `removedAt` 為 null）。
//   - 已移除者再 DELETE 冪等 200，且**保留最初的 removedAt**（不更新時戳）；
//     從未存在的 id 不因 DELETE 而建列。
//   - 復活：sync 內嵌 device 區塊或 PUT 遇到已移除的 id → `removedAt` 清成 null。
//     sync 內嵌保留原 name（改名一律走 PUT），PUT 則套自己的語意（帶 name 就改名）。
//     復活不受 lastSeenAt 的 30 分鐘節流限制——節流只管 lastSeenAt 寫不寫，
//     removedAt 照清。
//   - 每帳號上限計總列數（活躍＋已移除）：溢位時先淘汰已移除者（lastSeenAt 最舊
//     者優先），名額仍不夠再淘汰活躍最舊者，直到總數回到上限內。「上限台活躍
//     ＋若干已移除」不是穩態。被淘汰的已移除者就真的不見了（§13「已移除永久
//     保留（除非被上限淘汰）」）。
//   - `seen[].deviceId` 不動（既有斷言不變）。

test('軟刪除：DELETE 後該台仍在 GET 內且 removedAt 為數字，活躍者為 null', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  h.advance(MINUTE);
  await h.putDevice(DEV_B, { name: '手機', platform: 'android' });

  const beforeDelete = await requireDevice(h, DEV_A);

  const deletedAt = h.advance(MINUTE);
  const del = await h.deleteDevice(DEV_A);
  assert.equal(del.status, 200);

  const { devices } = await devicesOf(h);
  assert.deepEqual(
    devices.map((d) => d.deviceId).sort(),
    [DEV_A, DEV_B].sort(),
    '已移除的與活躍的混在同一個陣列裡'
  );
  const removed = devices.find((d) => d.deviceId === DEV_A);
  const active = devices.find((d) => d.deviceId === DEV_B);
  assert.equal(typeof removed.removedAt, 'number', 'removedAt 是毫秒時戳');
  assert.equal(removed.removedAt, deletedAt, '時戳取 DELETE 當下');
  assert.equal(removed.name, '桌機', '名稱保留：紀錄上還 join 得回原名');
  // DELETE 只碰 removedAt。lastSeenAt 是「這台最後一次現身」的語意，移除動作
  // 不算現身；若被順手更新，清單的 lastSeenAt DESC 排序會讓剛移除的那台竄到頂端。
  assert.equal(removed.lastSeenAt, beforeDelete.lastSeenAt, 'DELETE 不得更新 lastSeenAt');
  assert.equal(active.removedAt, null, '活躍者一律 null，不是缺席');
});

test('軟刪除：已移除者再 DELETE 冪等 200，且保留最初的 removedAt', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });
  const firstAt = h.advance(MINUTE);
  assert.equal((await h.deleteDevice(DEV_A)).status, 200);
  const first = await requireDevice(h, DEV_A);
  assert.equal(first.removedAt, firstAt);

  h.advance(10 * MINUTE);
  const second = await h.deleteDevice(DEV_A);
  assert.equal(second.status, 200, '重複刪除仍成功');
  assert.deepEqual(await second.json(), { ok: true });

  const after = await requireDevice(h, DEV_A);
  assert.equal(after.removedAt, firstAt, '重複 DELETE 不得把時戳往後推');
});

test('軟刪除：DELETE 從未存在的 id 回 200，但不得憑空建一列', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '桌機', platform: 'chrome_extension' });

  const res = await h.deleteDevice(uuidOf(999));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const { devices } = await devicesOf(h);
  assert.deepEqual(
    devices.map((d) => d.deviceId),
    [DEV_A],
    '沒有的東西刪不出一列已移除裝置'
  );
});

test('軟刪除復活：sync 內嵌 device 遇已移除 id → removedAt 清 null、name 保留', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '書房桌機', platform: 'chrome_extension' });
  h.advance(MINUTE);
  await h.deleteDevice(DEV_A);

  // 拉開超過 30 分鐘，讓 lastSeenAt 也會被寫（節流那條路徑另有一支測試）。
  const at = h.advance(31 * MINUTE);
  const res = await h.sync({
    upserts: [linkItem()],
    deletes: [],
    device: { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' },
  });
  assert.equal(res.status, 200);

  const device = await requireDevice(h, DEV_A);
  assert.equal(device.removedAt, null, '內嵌註冊＝這台又回來了，removedAt 要清掉');
  assert.equal(device.name, '書房桌機', '復活保留自訂名（改名一律走 PUT，內嵌不覆寫）');
  assert.equal(device.lastSeenAt, at, '超過節流窗，lastSeenAt 照常更新');
});

test('軟刪除復活：sync 內嵌在 30 分鐘節流窗內也照清 removedAt（只是 lastSeenAt 不動）', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '書房桌機', platform: 'chrome_extension' });
  const seenAt = T0;
  h.advance(MINUTE);
  await h.deleteDevice(DEV_A);

  h.advance(MINUTE); // 距上次 lastSeenAt 僅 2 分鐘，遠在節流窗內
  const res = await h.sync({
    upserts: [linkItem()],
    deletes: [],
    device: { deviceId: DEV_A, name: 'Chrome on Windows', platform: 'chrome_extension' },
  });
  assert.equal(res.status, 200);

  const device = await requireDevice(h, DEV_A);
  assert.equal(device.removedAt, null, '節流管的是 lastSeenAt，不是復活');
  assert.equal(device.lastSeenAt, seenAt, 'lastSeenAt 照原節流，不因復活而寫');
  assert.equal(device.name, '書房桌機');
});

test('軟刪除復活：PUT 遇已移除 id → removedAt 清 null，name 依 PUT，createdAt 不動', async () => {
  const h = harness();
  await h.putDevice(DEV_A, { name: '舊筆電', platform: 'chrome_extension' });
  h.advance(MINUTE);
  await h.deleteDevice(DEV_A);

  const at = h.advance(MINUTE);
  // platform 省略：能沿用既有值就代表 PUT 真的找得到那一列已移除的裝置。
  const res = await h.putDevice(DEV_A, { name: '書房桌機' });
  assert.equal(res.status, 200, '已移除的那一列仍在，PUT 找得到它就不必再帶 platform');
  const body = await res.json();
  assert.equal(body.device.removedAt, null, '回應直接帶復活後的 removedAt');
  assert.equal(body.device.name, '書房桌機');

  const device = await requireDevice(h, DEV_A);
  assert.equal(device.removedAt, null);
  assert.equal(device.name, '書房桌機', 'PUT 帶 name 就是改名');
  assert.equal(device.platform, 'chrome_extension', '省略 platform 沿用既有值');
  assert.equal(device.createdAt, T0, '復活不是新建，createdAt 不動');
  assert.equal(device.lastSeenAt, at, 'PUT 每次都更新 lastSeenAt');
});

test('軟刪除上限：溢位時先淘汰已移除者，活躍最舊的那台不被牽連', async () => {
  const h = harness();
  await seedDevices(h, MAX_DEVICES);
  const gone = uuidOf(0); // lastSeenAt 最舊的那一台
  assert.equal((await h.deleteDevice(gone)).status, 200);

  const fresh = uuidOf(MAX_DEVICES);
  const res = await h.putDevice(fresh, { name: `d${MAX_DEVICES}`, platform: 'chrome_extension' });
  assert.equal(res.status, 200);

  const { devices } = await devicesOf(h);
  const activeIds = devices.filter((d) => d.removedAt === null).map((d) => d.deviceId);
  assert.equal(activeIds.length, MAX_DEVICES, '活躍數回到上限');
  assert.equal(activeIds.includes(fresh), true, '新裝置留下');
  assert.equal(
    activeIds.includes(uuidOf(1)),
    true,
    '淘汰先挑已移除者，活躍最舊的那台不該被牽連'
  );
  assert.deepEqual(
    devices.filter((d) => d.removedAt !== null).map((d) => d.deviceId),
    [],
    '上限計總列數：已移除的那一列就是這次溢位被淘汰掉的名額'
  );
});

test('軟刪除上限：溢位先淘汰已移除者（lastSeenAt 最舊），名額仍不夠才淘汰活躍最舊', async () => {
  const h = harness();
  await seedDevices(h, MAX_DEVICES);
  const gone = uuidOf(0);
  await h.deleteDevice(gone);
  // 補一台：總數溢位一列，已移除的那台先被淘汰，補進來的成為活躍最新一台。
  await h.putDevice(uuidOf(MAX_DEVICES), { name: `d${MAX_DEVICES}`, platform: 'chrome_extension' });
  h.advance(61_000);

  const overflow = uuidOf(MAX_DEVICES + 1);
  const res = await h.putDevice(overflow, { name: 'd-overflow', platform: 'chrome_extension' });
  assert.equal(res.status, 200, '超過上限不回錯');

  const { devices } = await devicesOf(h);
  const ids = devices.map((d) => d.deviceId);
  assert.equal(ids.includes(gone), false, '已移除者先被淘汰');
  assert.equal(
    ids.includes(uuidOf(1)),
    false,
    '淘汰已移除者並不會讓活躍數下降，名額不夠就接著淘汰活躍最舊者'
  );
  assert.equal(ids.includes(overflow), true, '新裝置留下');
  assert.equal(
    devices.filter((d) => d.removedAt === null).length,
    MAX_DEVICES,
    '活躍數維持在上限'
  );
});
