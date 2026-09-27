// sw-device.js — service worker 的本機裝置身分(裝置歸屬，契約 §9)，由
// background.js 以 importScripts 載入。
//
// 本檔負責:惰性建立並記住本機的 syncDevice 身分、預設裝置名的 OS 探測、
// 提供給同步引擎的 getLocalDevice，以及 sync.devices.* 三個訊息 handler 的參數
// 自驗與本機名稱鏡像。
//
// 對外提供的全域名稱:
//   DEVICE_KEY、ensureDevice、getLocalDevice、readLocalDeviceId、
//   normalizeDeviceName、handleDevicesList、handleDevicesRename、handleDevicesRemove
//
// 依賴:前載的 tcl-core.js(TCLCore)、sw-history.js(storageQueue)與 chrome。
'use strict';

// ------------------------------------------------------------
// 裝置身分(裝置歸屬，契約 §9)
// ------------------------------------------------------------

// 本機這台的身分:{ deviceId, name?, platform, createdAt }。登出、刪雲端、清
// 紀錄、匯入一律不碰它——重灌擴充才算換一台新裝置。name 缺席代表「用預設
// 名」，預設名只在讀取時算(見 getLocalDevice)，不固化進 storage。
// 直接讀這個 key 的人必須自行 TCLCore.normalizeDeviceId(裡頭躺的可能是大寫
// 寫法或損毀值);經 ensureDevice／getLocalDevice 取得的一律已歸一。
const DEVICE_KEY = 'syncDevice';

// 惰性初始化的 memo。不掛 onInstalled:那支只在安裝/更新的當下觸發一次，錯過
// 就永遠不會有身分。實際的讀改寫排在 storageQueue 上，與 recordHistory、兩
// 支遷移串行，併發呼叫不會各生一組 deviceId 互相覆蓋。
let localDevicePromise = null;

// 讀到既有值一律採用(重生 deviceId 等於在雲端變成另一台裝置);沒有才生成。
// 既有值先過 TCLCore.normalizeDeviceId:大寫寫法歸一成小寫(伺服器存小寫，不
// 對齊就 join 不到自己這台);形狀根本不合(storage 損毀、手改過)才重生——當不
// 成識別碼的值留著，這台裝置就永遠註冊不上雲端。
// 新身分在同一段佇列內當場落地，一個安裝週期只寫這一次;寫入失敗視同初始化
// 失敗，下一次呼叫重來。
// 呼叫端注意:ensureDevice 自己佔一段 storageQueue，不得在佇列上的工作內第一
// 次呼叫它，否則等於在佇列上等自己(死鎖)。recordHistory 因此在排入本次寫入
// 之前就先呼叫。
function ensureDevice() {
  if (localDevicePromise !== null) return localDevicePromise;
  const pending = storageQueue(async () => {
    const stored = await chrome.storage.local.get(DEVICE_KEY);
    const existing = stored && stored[DEVICE_KEY];
    const existingId =
      existing && typeof existing === 'object'
        ? TCLCore.normalizeDeviceId(existing.deviceId)
        : undefined;
    if (existingId !== undefined) {
      // 形狀合法就不是重寫的理由:只在記憶體裡把它歸一成小寫交出去。
      return existingId === existing.deviceId
        ? existing
        : Object.assign({}, existing, { deviceId: existingId });
    }
    const device = {
      deviceId: TCLCore.randomUuid(),
      platform: 'chrome_extension',
      createdAt: Date.now(),
    };
    await chrome.storage.local.set({ [DEVICE_KEY]: device });
    return device;
  }).catch((err) => {
    console.warn('[threads-clean-link] 裝置身分初始化失敗', err);
    // 失敗不長期卡住:清掉 memo 讓下一次呼叫重試，別讓一次 storage 抽風害得
    // 這個 SW 實例往後所有事件都沒有歸屬。
    if (localDevicePromise === pending) localDevicePromise = null;
    return null;
  });
  localDevicePromise = pending;
  return pending;
}

// 預設名的 OS 來源。getPlatformInfo 在舊環境可能整支不存在、也可能 reject，
// 兩種都退成 undefined 讓 TCLCore.defaultDeviceName 回 'Chrome'。探測結果 memo，
// 一個 SW 實例內只問一次。
let platformOsPromise = null;

function detectPlatformOs() {
  if (platformOsPromise !== null) return platformOsPromise;
  platformOsPromise = Promise.resolve()
    .then(() => {
      if (!chrome.runtime || typeof chrome.runtime.getPlatformInfo !== 'function') return undefined;
      return chrome.runtime.getPlatformInfo();
    })
    .then((info) => (info && typeof info.os === 'string' ? info.os : undefined))
    .catch(() => undefined);
  return platformOsPromise;
}

// 引擎介面(計劃 §12):sync.js 靠這支取得請求的 device 區塊與 currentDeviceId。
// 名稱一律以本機的 syncDevice.name 為準(D26)，缺席才算預設名。
async function getLocalDevice() {
  const device = await ensureDevice();
  if (!device) return null;
  // 交出去的 deviceId 一律正規化:引擎拿它組請求的 device 區塊與
  // currentDeviceId，handleDevicesRemove 拿它擋「移除自己這台」，兩邊大小寫
  // 不一致就比不中。ensureDevice 已經歸一過，這裡是縱深。
  const deviceId = TCLCore.normalizeDeviceId(device.deviceId);
  if (deviceId === undefined) return null;
  const name =
    typeof device.name === 'string' && device.name !== ''
      ? device.name
      : TCLCore.defaultDeviceName(await detectPlatformOs());
  return {
    deviceId,
    name,
    platform: typeof device.platform === 'string' ? device.platform : 'chrome_extension',
  };
}

// 本機這台改名成功後把新名字寫回 syncDevice(§5);改別台不得寫進來——本機
// 名稱以本機為準(D26)。同樣排在 storageQueue 上，與紀錄寫入不互相覆蓋。
async function rememberLocalDeviceName(deviceId, name) {
  const device = await ensureDevice();
  if (!device || TCLCore.normalizeDeviceId(device.deviceId) !== deviceId) return;
  await storageQueue(async () => {
    const stored = await chrome.storage.local.get(DEVICE_KEY);
    const current = stored && stored[DEVICE_KEY];
    if (!current || typeof current !== 'object') return;
    const next = Object.assign({}, current, { name });
    await chrome.storage.local.set({ [DEVICE_KEY]: next });
    // memo 是這個 SW 實例內 getLocalDevice 的唯一來源:落地了卻不換掉它，改完
    // 名之後的每一輪同步都還在送舊名，要等 SW 回收重載才會對齊。deviceId 補
    // 上正規化後的值，維持「memo 交出去的一律已歸一」。
    localDevicePromise = Promise.resolve(Object.assign({}, next, { deviceId }));
  });
}

// 裝置名的合法範圍:trim 後 1–80 個 code point。上限算 code point 而非
// String.prototype.length——40 個 emoji 的 length 是 80 卻只有 40 個字，用
// length 把關會誤殺合法名字。不合格回 undefined。
function normalizeDeviceName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const size = Array.from(trimmed).length;
  if (size < 1 || size > 80) return undefined;
  return trimmed;
}

// 三個 devices handler 一律先自驗參數(不合格就不碰引擎)，通過後把引擎回應
// 原樣透出——失敗碼是 UI 分流的依據，handler 不得改寫形狀。
//
// list 額外在成功回應補一個頂層 defaultName(§12 增補):UI 把本機的改名欄清
// 空時要能回退到預設名，而預設名只有 background 算得出來。引擎已經給了就
// 不覆蓋。
async function handleDevicesList(engine, message) {
  const response = await engine.listDevices({ force: message ? message.force : undefined });
  if (!response || response.ok !== true || response.defaultName !== undefined) return response;
  return Object.assign({}, response, { defaultName: TCLCore.defaultDeviceName(await detectPlatformOs()) });
}

async function handleDevicesRename(engine, message) {
  const deviceId = TCLCore.normalizeDeviceId(message && message.deviceId);
  if (deviceId === undefined) return { ok: false, code: 'bad_device_id' };
  const name = normalizeDeviceName(message && message.name);
  if (name === undefined) return { ok: false, code: 'bad_device_name' };
  const response = await engine.renameDevice(deviceId, name);
  // 伺服器已經改好了，本機那份鏡像寫不進去只是下次讀到舊名，不能反過來把
  // 成功的回應吞成 undefined 讓 UI 以為改名失敗。
  if (response && response.ok === true) {
    await rememberLocalDeviceName(deviceId, name).catch((err) => {
      console.warn('[threads-clean-link] 本機裝置名寫入失敗', err);
    });
  }
  return response;
}

async function handleDevicesRemove(engine, message) {
  const deviceId = TCLCore.normalizeDeviceId(message && message.deviceId);
  if (deviceId === undefined) return { ok: false, code: 'bad_device_id' };
  // 這台裝置自己不得被移除:UI 那顆按鈕是 disabled，handler 再擋一次。
  // 兩邊都跑過 normalizeDeviceId 才比:參數已經歸一，本機那份若因舊資料而是
  // 大寫寫法，直接比就比不中——使用者正在用的這台會被送進 DELETE。
  const local = await getLocalDevice();
  const localId = local ? TCLCore.normalizeDeviceId(local.deviceId) : undefined;
  if (localId !== undefined && localId === deviceId) return { ok: false, code: 'current_device' };
  return engine.removeDevice(deviceId);
}

// 證據要記下的本機裝置 id。直接讀 storage 而不走 ensureDevice：ensureDevice
// 自己佔一段 storageQueue（在佇列上的工作裡呼叫等於等自己），而且沒有身分
// 時會生一組新的——證據記的是「哪一台寫的」，還沒有身分就該缺席，不值得為它
// 生一組 deviceId 出來。讀不到（缺席、形狀不合、storage 抽風）一律回
// undefined 讓證據不帶這一欄，絕不因此擋下整次寫入。
async function readLocalDeviceId() {
  try {
    const stored = await chrome.storage.local.get(DEVICE_KEY);
    const device = stored && stored[DEVICE_KEY];
    return device && typeof device === 'object' ? TCLCore.normalizeDeviceId(device.deviceId) : undefined;
  } catch (err) {
    console.warn('[threads-clean-link] 證據取裝置 id 失敗', err);
    return undefined;
  }
}
