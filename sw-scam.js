// sw-scam.js — service worker 的投資詐騙警示名單寫入端，由 background.js 以
// importScripts 載入。
//
// 本檔負責:scam.hit 的 payload 驗證與總開關、缺作者 id 時的匿名 GET 備援
// (含逐篇 24 小時節流與全域每分鐘速率上限)、名單條目的建立與補證據，以及
// 選項頁的解除／復原。寄件者判準(isScamContentScriptSender)與路由留在
// background.js。
//
// 對外提供的全域名稱:
//   SCAM_BLOCKLIST_KEY、SCAM_MUTATE_OPTS、validateScamHit、handleScamHit、
//   handleScamBlocklistRemove、handleScamBlocklistRestore
//
// 依賴:前載的 tcl-core.js(TCLCore)、sw-history.js(mutate、
// notifySyncRecorded)、sw-device.js(readLocalDeviceId)、sw-og.js
// (OG_FETCH_HEADERS、OG_SCAN_LIMIT、escapeRegExp、decodeHtmlEntities)與 chrome。
'use strict';

// ------------------------------------------------------------
// 投資詐騙黑名單（內部可行性評估 §14，見 docs/scam-guard.md）
// ------------------------------------------------------------
//
// storage.local 的 scamBlocklist 只有 background 寫得到：content script 與
// 選項頁一律直接讀 storage 並監聽 chrome.storage.onChanged。三個 handler 的
// 讀改寫全走 mutate(storageQueue)，與 history 寫入串行，互不覆蓋；每次寫
// 前過 TCLCore.normalizeScamBlocklist、寫後過 capScamBlocklistAt，落地的形狀
// 與上限只有這一處說了算。撞配額拋 storage_quota，由路由表轉成 internal_error。

const SCAM_BLOCKLIST_KEY = 'scamBlocklist';

const SCAM_MUTATE_OPTS = {
  normalize: TCLCore.normalizeScamBlocklist,
  cap: TCLCore.capScamBlocklistAt,
  onQuota: 'throw',
};

// 總開關存 storage.local（選項頁設定卡寫入）。缺席＝開，首次安裝即生效。
const SCAM_ENABLED_KEY = 'scamGuardEnabled';

// 匿名 GET 回應裡的作者數字 id（SSR JSON 欄位）。頁面可能出現多個（引用貼
// 文、推薦貼文、側欄作者各有一個），因此是 global，逐個候選試。
const SCAM_AUTHOR_ID_PATTERN = /"post_author_id":"(\d{1,20})"/g;

// 備援回應的掃描上限。**刻意不與 og 擷取的 OG_SCAN_LIMIT 共用**：og:meta 必
// 在 <head>，64KB 綽綽有餘；這裡要的 RelayPrefetchedStreamCache 是 SSR 的
// JSON 酬載，真實貼文頁常把它推到文件中後段，用 64KB 切會把 post_author_id
// 切在範圍外，備援等於長期失效。登出態的永久連結回應實測約 581KB，0.5MB 的
// 上限同樣會把 route props 整段切掉，因此放到 1MB。仍保留上限，不對超大回應
// 做無界正則掃描。
const SCAM_SCAN_LIMIT = 1048576;

// 文件身分的 meta 屬性名：兩者的 content 都是本篇貼文的永久連結，任一個對得
// 上請求的網址，就足以確認「拿回來的這份 HTML 就是我要的那一篇」。
const SCAM_DOC_IDENTITY_PROPERTIES = ['og:url', 'al:android:url'];

// <meta> 標籤與其屬性。屬性順序（property 在前或 content 在前）與引號種類
// （雙引號、單引號、無引號）在真實 HTML 都不固定，逐標籤拆屬性而非把單一形
// 狀寫死進正則。
//
// 標籤起點用正則找「<meta」加字界，標籤結尾交給 indexOf 找下一個 `>`:起點
// 到 `>` 之間寫成 `[^>]*` 時，一串沒有 `>` 收尾的 `<meta` 會讓每個起點各掃
// 一次到文件尾端。
const SCAM_META_OPEN_PATTERN = /<meta\b/gi;
// 屬性名後面的「= 值」整段可選：每段屬性名一律整段吃掉(沒帶值的由呼叫端略
// 過)，下一次比對從它後面接著找，屬性名字元不會從中間各個起點重掃一遍。取
// 到的帶值屬性與「值為必要」的寫法相同:屬性名必須整段比對完才輪得到 `=`，
// 從屬性名中間起頭的比對不可能成立。
const SCAM_META_ATTR_PATTERN = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

// 交叉驗證的比對視窗（以命中的 post_author_id 位置為中心，前後各這麼多字）。
// 整份文字比對太寬：頁面任何角落出現過本人的 username，就會替一個不相干的
// id 背書。
const SCAM_AUTHOR_ID_WINDOW = 2000;

// 匿名備援的逾時：SW 不能掛在一個永遠不回的請求上。
const SCAM_FETCH_TIMEOUT_MS = 8000;

// 匿名備援的節流表：以 postUrl 為鍵存上次發請求的時間，同一篇 24 小時內只
// 打一次。存 chrome.storage.session（SW 被回收也留著、瀏覽器關閉即清），沒
// 有 session 區域的環境退回 local。表只寫不刪會在一次工作階段裡無上限成長
// （鍵是整串 postUrl），寫入時剔除過期鍵並以筆數上限收尾。
const SCAM_FETCH_THROTTLE_KEY = 'scamAuthorFetchAt';
const SCAM_FETCH_THROTTLE_MS = 24 * 60 * 60 * 1000;
const SCAM_FETCH_THROTTLE_MAX = 500;

// 匿名備援的全域速率上限：每分鐘最多 6 次，超過一律當作撈不到 id。逐篇的
// 24 小時節流只擋得住同一篇重複打，河道一次捲動就有幾十位不同作者，每人各
// 一次照樣是一串齊發的匿名請求，對站方而言就是掃描行為。存最近一分鐘的時戳
// 陣列，與節流表同放 session 區。
const SCAM_FETCH_RATE_KEY = 'scamAuthorFetchLog';
const SCAM_FETCH_RATE_WINDOW_MS = 60 * 1000;
const SCAM_FETCH_RATE_MAX = 6;

// scam.hit 的 payload 驗證。不合格一律回 null（呼叫端轉成 bad_request）：
// 黑名單是使用者資料，形狀可疑的回報寧可整筆不收。userId 允許缺席（null）
// ——那是登入態 SSR JSON 讀不到 id 的情形，由匿名 GET 備援補。
//
// 證據補強的五欄（anchorPostUrl／threadUrl／anchorMatch／signals／postedAt）
// 一律可缺席——舊版 content script 送來的三欄 payload 照常受理——但**有
// 帶就驗形狀，不合格整筆回 bad_request**：payload 是自家 content script 送
// 的，形狀不對代表兩端版本對不上，默默剝掉會讓錯誤晚好幾週才被發現。
// lineId 是這條規矩的唯一例外，理由見下方該欄的註解。
function validateScamHit(message) {
  if (!message) return null;
  // handle 與 userId 的形狀一律走 TCLCore 的判準(與伺服器同一把尺)：handle 既是
  // handleIndex 的鍵、也直接顯示在名單卡片上，帶 @ 的原始文字或夾帶控制字元
  // 的值不得入庫;userId 是 entries 的鍵，只收 1–20 位數字字串。
  if (!TCLCore.isScamMarkHandle(message.handle)) return null;
  const postUrl = TCLCore.normalizePostUrl(message.postUrl);
  if (postUrl === null) return null;
  if (typeof message.snippet !== 'string' || message.snippet.length > TCLCore.SCAM_LIMITS.SNIPPET_MAX) return null;
  if (typeof message.at !== 'number' || !isFinite(message.at)) return null;
  // at 是頁面端送來的數字，夾在「現在」以內。這個值一路流進證據的 at 與新建條
  // 目的 addedAt／updatedAt：證據依 at 降冪排列、裁筆數時留最新的，一個偽造的
  // 未來時戳會永遠霸佔榜首、把真正的新證據擠出去；updatedAt 是跨裝置 LWW 的判
  // 準，未來值會讓這筆在合併裡永遠勝出。往回的時戳不夾：補送舊命中是正常情
  // 形，太舊只會讓它排在證據清單後面。
  const at = Math.min(message.at, Date.now());

  let userId = null;
  if (message.userId !== null && message.userId !== undefined) {
    if (!TCLCore.isScamUserId(message.userId)) return null;
    userId = message.userId;
  }

  let anchorPostUrl;
  if (message.anchorPostUrl !== null && message.anchorPostUrl !== undefined) {
    anchorPostUrl = TCLCore.normalizePostUrl(message.anchorPostUrl);
    if (anchorPostUrl === null) return null;
  }

  let threadUrl;
  if (message.threadUrl !== null && message.threadUrl !== undefined) {
    threadUrl = TCLCore.normalizePostUrl(message.threadUrl);
    if (threadUrl === null) return null;
  }

  let anchorMatch;
  if (message.anchorMatch !== null && message.anchorMatch !== undefined) {
    if (typeof message.anchorMatch !== 'string' || message.anchorMatch.length > TCLCore.SCAM_ANCHOR_MATCH_MAX) {
      return null;
    }
    anchorMatch = message.anchorMatch;
  }

  let signals;
  if (message.signals !== null && message.signals !== undefined) {
    if (!Array.isArray(message.signals)) return null;
    for (let i = 0; i < message.signals.length; i++) {
      if (TCLCore.SCAM_SIGNALS.indexOf(message.signals[i]) === -1) return null;
    }
    signals = message.signals;
  }

  // postedAt 是貼文發布時間（at 是掃到的時間）。同一條規則：缺席通過，有帶
  // 就必須是有限數字。
  let postedAt;
  if (message.postedAt !== null && message.postedAt !== undefined) {
    if (typeof message.postedAt !== 'number' || !isFinite(message.postedAt)) return null;
    postedAt = message.postedAt;
  }

  return {
    userId,
    handle: message.handle,
    displayName: typeof message.displayName === 'string' ? message.displayName : undefined,
    postUrl,
    snippet: message.snippet,
    at,
    anchorPostUrl,
    threadUrl,
    anchorMatch,
    signals,
    postedAt,
    // lineId 的驗證規則**刻意與上面幾欄不同**：形狀不對只丟這一欄、整筆照收
    // （normalizeScamLineId 對非字串／空字串回 undefined，從不拒收）。它是加
    // 值資訊——標亮位置與跨帳號索引——不是證據成立的必要條件，為了它把一次真
    // 的命中整筆退掉是賠本生意。
    lineId: TCLCore.normalizeScamLineId(message.lineId),
  };
}

// 總開關。讀取失敗時視為開啟。
async function isScamGuardEnabled() {
  try {
    const stored = await chrome.storage.local.get({ [SCAM_ENABLED_KEY]: true });
    return stored[SCAM_ENABLED_KEY] !== false;
  } catch (err) {
    console.error('[threads-clean-link] 讀取詐騙警示總開關失敗，視為開啟', err);
    return true;
  }
}

// 節流表存放的區域：session；缺 session 的環境退回 local。
function scamThrottleArea() {
  const session = chrome.storage && chrome.storage.session;
  if (session && typeof session.get === 'function' && typeof session.set === 'function') return session;
  return chrome.storage.local;
}

// 身分鍵的網域歸一：threads.net 與 threads.com 是同一個站的兩個網域，`www.`
// 也可有可無，一律寫成 `https://www.threads.com/`。使用者可能停在 threads.net
// 的分頁上，回應的 og:url 卻一律是 www.threads.com，不歸一就會判成兩篇不同的
// 貼文，備援在 .net 分頁上全面失效。
const SCAM_IDENTITY_HOST_PATTERN = /^https:\/\/(?:www\.)?threads\.(?:com|net)\//;
const SCAM_IDENTITY_HOST = 'https://www.threads.com/';

// 貼文網址的身分鍵：正規化後把網域歸一、handle 段轉小寫，供兩個網址比「是不
// 是同一篇」。Threads 的 handle 不分大小寫（/@Example/post/X 與 /@example/post/X
// 是同一篇），post 識別碼則分大小寫，只壓前半段、`/post/` 之後原樣保留。比對
// 兩側（請求的 postUrl 與回應宣告的身分網址）都走這支，歸一規則必然一致。不
// 是貼文永久連結（正規化失敗）回 null——無從比對，不算身分宣告。
function scamPostIdentityKey(url) {
  const normalized = TCLCore.normalizePostUrl(url);
  if (normalized === null) return null;
  const at = normalized.lastIndexOf('/post/');
  const head = normalized.slice(0, at).toLowerCase().replace(SCAM_IDENTITY_HOST_PATTERN, SCAM_IDENTITY_HOST);
  return head + normalized.slice(at);
}

// 逐個 <meta> 拆屬性，取出文件身分 meta（og:url／al:android:url）的 content，
// entity 還原後回傳。真機回應的 content 是
// `https://www.threads.com/&#064;<handle>/post/<code>`，`@` 以 entity 形式出
// 現，不還原永遠對不上。property 與 name 兩種屬性名都認。
function scamDocIdentityUrls(scanText) {
  const urls = [];
  // global 正則的 lastIndex 跨呼叫會殘留，每次掃描前歸零。
  SCAM_META_OPEN_PATTERN.lastIndex = 0;
  let open = SCAM_META_OPEN_PATTERN.exec(scanText);
  while (open !== null) {
    const attrsStart = open.index + open[0].length;
    const close = scanText.indexOf('>', attrsStart);
    // 這個 <meta 之後再也沒有 `>`，後面的 <meta 也都收不了尾。
    if (close === -1) break;
    const attrs = scanText.slice(attrsStart, close);
    let property = '';
    let content = null;
    SCAM_META_ATTR_PATTERN.lastIndex = 0;
    let attr = SCAM_META_ATTR_PATTERN.exec(attrs);
    while (attr !== null) {
      const value = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4];
      if (value !== undefined) {
        const name = attr[1].toLowerCase();
        if (name === 'property' || name === 'name') property = value.toLowerCase();
        else if (name === 'content') content = value;
      }
      attr = SCAM_META_ATTR_PATTERN.exec(attrs);
    }
    if (content !== null && SCAM_DOC_IDENTITY_PROPERTIES.indexOf(property) !== -1) {
      urls.push(decodeHtmlEntities(content));
    }
    SCAM_META_OPEN_PATTERN.lastIndex = close + 1;
    open = SCAM_META_OPEN_PATTERN.exec(scanText);
  }
  return urls;
}

// 文件身分過關後的取值：回應裡的 post_author_id 候選必須全部同值才採信。這
// 份 HTML 已確認是本篇貼文，但仍可能嵌著引用貼文或推薦貼文的作者 id，兩個以
// 上不同值時哪一個是本篇作者無從判定，一律回 null。
function scamSoleAuthorId(scanText) {
  let sole = null;
  // global 正則的 lastIndex 跨呼叫會殘留，每次掃描前歸零。
  SCAM_AUTHOR_ID_PATTERN.lastIndex = 0;
  let match = SCAM_AUTHOR_ID_PATTERN.exec(scanText);
  while (match !== null) {
    if (sole !== null && match[1] !== sole) return null;
    sole = match[1];
    match = SCAM_AUTHOR_ID_PATTERN.exec(scanText);
  }
  return sole;
}

// 替代錨點：逐個 post_author_id 候選試，每個只在它前後 SCAM_AUTHOR_ID_WINDOW
// 字的切片內找對應的 username（Threads 的 handle 不分大小寫，比對亦不分；
// handle 先正則逸出，句點不得當萬用字元），全部落空回 null——本篇作者的 id
// 與 username 必然相鄰，隔著幾千字的那一組不是同一筆。
function scamAuthorIdNearUsername(scanText, handle) {
  const usernamePattern = new RegExp('"username":"' + escapeRegExp(handle) + '"', 'i');

  // global 正則的 lastIndex 跨呼叫會殘留，每次掃描前歸零。
  SCAM_AUTHOR_ID_PATTERN.lastIndex = 0;
  let match = SCAM_AUTHOR_ID_PATTERN.exec(scanText);
  while (match !== null) {
    const from = Math.max(0, match.index - SCAM_AUTHOR_ID_WINDOW);
    if (usernamePattern.test(scanText.slice(from, match.index + SCAM_AUTHOR_ID_WINDOW))) return match[1];
    match = SCAM_AUTHOR_ID_PATTERN.exec(scanText);
  }
  return null;
}

// 匿名 GET 取作者數字 id。比照 resolveFinalUrl 用 OG_FETCH_HEADERS：**不得
// 帶 User-Agent**，帶了 Threads 只回 SPA 殼，撈不到任何 SSR 欄位。
// credentials:'omit' 不帶使用者 cookie（不以使用者身分發非觸發請求）；
// redirect:'error' 讓轉址直接算失敗，不跟著跳到登入／驗證頁；signal 讓慢回應
// 在 SCAM_FETCH_TIMEOUT_MS 後中斷。非 2xx 直接回 null：錯誤頁的內容不是貼文
// 本身，不得拿來背書任何 id。
//
// 【交叉驗證】回應裡的 post_author_id 未必就是 handle 那個人：轉址到別篇貼
// 文、頁面嵌了他人的引用貼文、或 content script 被頁面腳本餵了假 handle，都
// 會讓不相干的帳號被寫進黑名單。主判準是**文件身分**：og:url／al:android:url
// 的 content 正規化後必須等於請求的 postUrl，確認這份 HTML 就是我要的那一
// 篇，才採信其中的 post_author_id（且候選必須全部同值）。有身分 meta 指向另
// 一篇時一律回 null，這道否決優先於 username 視窗——登出態的回應整份沒有
// `"username":"`，視窗判準對真機貼文永遠落空，只剩文件身分認得出這一篇。
// 沒有任何可比對的身分 meta（登入態或舊形狀的回應）才退回 username 視窗。
async function fetchScamAuthorId(postUrl, handle) {
  const response = await fetch(postUrl, {
    method: 'GET',
    credentials: 'omit',
    headers: OG_FETCH_HEADERS,
    redirect: 'error',
    signal: AbortSignal.timeout(SCAM_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const scanText = (await response.text()).slice(0, SCAM_SCAN_LIMIT);

  // 身分 meta 只掃前 OG_SCAN_LIMIT 字，post_author_id 才吃整份 1MB 切片：og
  // meta 必在 <head>，離文件開頭很近。兩個理由——正則的最壞成本回到既有
  // extractOgMeta 同級（<meta> 標籤掃描不對 1MB 正文做無界比對）；正文區的未
  // 逸出字串（貼文內文可以原樣寫出一段 <meta property="og:url" …>）不會被當
  // 成這份文件的身分宣告，身分只認 head 裡站方自己產的那幾個標籤。
  const wanted = scamPostIdentityKey(postUrl);
  const claimed = scamDocIdentityUrls(scanText.slice(0, OG_SCAN_LIMIT)).map(scamPostIdentityKey);
  if (claimed.some((key) => key !== null && key !== wanted)) return null;
  if (claimed.some((key) => key !== null && key === wanted)) return scamSoleAuthorId(scanText);

  return scamAuthorIdNearUsername(scanText, handle);
}

// 節流表淘汰：先剔除已過期（早就不再有節流作用）的鍵，補上本次這一篇，再以
// 筆數上限收尾——最舊的先淘汰，本次這一筆必然是最新的，永遠留著。
function capScamThrottleTable(table, postUrl, now) {
  const next = {};
  Object.keys(table).forEach((key) => {
    const at = table[key];
    if (typeof at === 'number' && isFinite(at) && now - at < SCAM_FETCH_THROTTLE_MS) next[key] = at;
  });
  next[postUrl] = now;

  const keys = Object.keys(next);
  if (keys.length <= SCAM_FETCH_THROTTLE_MAX) return next;
  keys.sort((a, b) => next[b] - next[a]);
  const capped = {};
  for (let i = 0; i < SCAM_FETCH_THROTTLE_MAX; i++) capped[keys[i]] = next[keys[i]];
  return capped;
}

// 閘門的讀改寫序列鏈。河道一次捲動會同時派出幾十則 scam.hit，它們是同一
// tick 進來的：讀改寫沒有序列化，七則各自讀到「目前 0 次」再各自寫回，閘門
// 等於不存在，節流表也會互相覆蓋成少於實際請求數。不共用 storageQueue——兩
// 者沒有共用資料，紀錄寫入不該被備援的閘門排隊拖慢。
const enqueueScamFetchGate = TCLCore.createSerialQueue();

// 在兩張表上各佔一個名額：逐篇 24 小時節流、全域每分鐘 SCAM_FETCH_RATE_MAX
// 次。兩者都在發請求前就記下，成功與失敗一視同仁——撈不到 id 的原因（SPA
// 殼、站方限流、貼文已刪）重試也不會變，只會替使用者多發網路請求。回 false
// 代表本次不得發請求。讀寫失敗時放行：閘門是替站方節流用的，
// 不是功能開關，不該因為 storage 故障把備援整條關掉。
async function reserveScamFetchSlot(postUrl) {
  const area = scamThrottleArea();
  const now = Date.now();

  try {
    const stored = await area.get({ [SCAM_FETCH_THROTTLE_KEY]: {}, [SCAM_FETCH_RATE_KEY]: [] });
    const rawTable = stored && stored[SCAM_FETCH_THROTTLE_KEY];
    const table = rawTable && typeof rawTable === 'object' ? rawTable : {};
    const last = table[postUrl];
    if (typeof last === 'number' && isFinite(last) && now - last < SCAM_FETCH_THROTTLE_MS) return false;

    const rawLog = stored && stored[SCAM_FETCH_RATE_KEY];
    const recent = (Array.isArray(rawLog) ? rawLog : []).filter(
      (at) => typeof at === 'number' && isFinite(at) && now - at < SCAM_FETCH_RATE_WINDOW_MS
    );
    if (recent.length >= SCAM_FETCH_RATE_MAX) return false;
    recent.push(now);

    await area.set({
      [SCAM_FETCH_THROTTLE_KEY]: capScamThrottleTable(table, postUrl, now),
      [SCAM_FETCH_RATE_KEY]: recent,
    });
    return true;
  } catch (err) {
    console.warn('[threads-clean-link] 讀寫取作者 id 的節流表失敗', err);
    return true;
  }
}

// 帶兩道閘門的備援。佔名額走序列鏈（同 tick 的併發必須排隊），真正的網路請
// 求留在鏈外——鏈上 await 一個可能跑滿 8 秒的 fetch，會把後面所有人一起卡住。
// 撈不到回 null。
async function resolveScamAuthorId(postUrl, handle) {
  const allowed = await enqueueScamFetchGate(() => reserveScamFetchSlot(postUrl));
  if (!allowed) return null;

  try {
    return await fetchScamAuthorId(postUrl, handle);
  } catch (err) {
    console.warn('[threads-clean-link] 匿名取作者 id 失敗', err);
    return null;
  }
}

// content script 掃到詐騙串文：建條目或替既有作者補一筆證據。
// 順序刻意如此：驗 payload → 總開關（關閉時連備援請求都不發）→ 缺 id 才走
// 匿名備援（解除與否以 userId 為準，沒有 id 就無從判斷）→ 讀改寫。
async function handleScamHit(message) {
  const hit = validateScamHit(message);
  if (!hit) return { ok: false, code: 'bad_request' };
  if (!(await isScamGuardEnabled())) return { ok: false, code: 'disabled' };

  let userId = hit.userId;
  if (userId === null) {
    userId = await resolveScamAuthorId(hit.postUrl, hit.handle);
    if (userId === null) return { ok: false, code: 'no_user_id' };
  }

  // 不寫的兩條分支各自的回應;有寫入時回應在 mutate 之後組。
  let unchanged = null;
  const out = await mutate(SCAM_BLOCKLIST_KEY, async (list) => {
    // 使用者解除過的作者不得被下一次掃描復活，且整條路徑不留任何寫入——連
    // updatedAt 都不推新，否則這筆會在跨裝置合併時無端勝出。
    const existing = list.entries[userId];
    if (existing && existing.state === 'dismissed') {
      unchanged = { ok: true, added: false, allowlisted: true };
      return undefined;
    }

    // deviceId 只有真的要寫一筆證據時才用得到，因此排在早退分支之後才讀：河道
    // 一次捲動就派出幾十則 scam.hit，早退的那些先讀一次 storage 是白花的往返。
    // readLocalDeviceId 不排隊，在 fn 內呼叫不違反死鎖守則。
    const deviceId = await readLocalDeviceId();

    // 證據帶判定規則版本與寫入裝置：兩者是日後跨裝置對帳與規則調參的依據，
    // 由寫入端記下，與 content script 送來的 payload 無關。
    const evidence = {
      postUrl: hit.postUrl,
      snippet: hit.snippet,
      at: hit.at,
      anchorPostUrl: hit.anchorPostUrl,
      threadUrl: hit.threadUrl,
      anchorMatch: hit.anchorMatch,
      signals: hit.signals,
      postedAt: hit.postedAt,
      rulesVersion: TCLCore.SCAM_RULES.version,
      deviceId: deviceId,
      // 本機專有：不上雲，但一定要落盤——整份名單的 lineIdIndex 由證據派生，
      // 這一欄不寫，ID 跨帳號比對就永遠查不到人。
      lineId: hit.lineId,
    };

    const added = !existing;
    if (added) {
      list.entries[userId] = TCLCore.markScamEntryDirty(
        TCLCore.makeBlocklistEntry(
          Object.assign({ handle: hit.handle, displayName: hit.displayName, source: 'auto' }, evidence)
        ),
        Date.now()
      );
    } else {
      const merged = TCLCore.mergeBlocklistEvidence(existing, evidence);
      // 去重之後一筆都沒多，整筆條目一個位元都沒變：不寫 storage 也不掛去抖
      // 同步。河道一次捲動就派出幾十則 scam.hit，每一則都回寫一次整份名單、
      // 再推一輪跟雲端一模一樣的資料，是白花的配額。
      if (merged.evidence.length === existing.evidence.length) {
        unchanged = { ok: true, added: false, entry: existing };
        return undefined;
      }
      // 【被動掃描不動 updatedAt／state】updatedAt 是跨裝置 LWW 的唯一判準，
      // 「這台機器又掃到一次」不是使用者的意思表示。推進它等於讓一次背景掃描
      // 勝過別台裝置更早做的解除，使用者按掉的標記會在下一次捲到同一位作者時
      // 自己長回來。新證據改以本機專有的 dirty 讓下一輪推得出去，已經 dirty
      // 的也要換一版 dirtyAt。
      list.entries[userId] = TCLCore.markScamEntryDirty(merged, Date.now());
    }

    // handleIndex 不在這裡手動維護：capScamBlocklist 內的正規化一律由
    // entries 重建，孤兒鍵沒有任何機會留下。
    return { next: list, result: added };
  }, SCAM_MUTATE_OPTS);
  if (!out.written) return unchanged;
  // 名單是與紀錄並存的第二條同步通道(D38)：不掛去抖同步的話，新標記的作者
  // 最久要等一輪週期 alarm 才推得上去，期間別台裝置看到的是舊名單。
  notifySyncRecorded();
  // 回傳的條目取實際落盤的那一份(過 cap 後)。
  return { ok: true, added: out.result, entry: out.value.entries[userId] };
}

// 選項頁的「解除」：條目留在 entries，state 翻成 dismissed 並記下解除時間，
// 下次掃到同一位作者不再入名單。證據一律保留——復原後卡片要畫得出來，跨裝置
// 對帳也還需要它。名單裡沒有這一筆時補一筆空的解除條目：使用者按過解除就得
// 擋得住之後的掃描，哪怕條目已被上限淘汰；補建的那一筆要帶上訊息送來的帳號
// 快照，handle 為 null 的 mark 會被後端整筆拒收，那次解除就永遠同步不出去。
async function handleScamBlocklistRemove(message) {
  const userId = message && message.userId;
  if (!TCLCore.isScamUserId(userId)) return { ok: false, code: 'bad_request' };

  await mutate(SCAM_BLOCKLIST_KEY, (list) => {
    const now = Date.now();
    const existing = list.entries[userId];
    const entry = existing || { evidence: [], addedAt: now, source: 'auto' };
    const patch = { state: 'dismissed', dismissedAt: now, updatedAt: now };
    if (!existing) {
      // 補建的空條目：帳號快照只認伺服器那把尺(TCLCore.isScamMarkHandle)，形狀
      // 不合就忽略該欄位——解除本身不因為一個壞欄位失敗(使用者會按不掉標記)，
      // 但訊息端的任意字串也不得落進 entries 與 handleIndex。
      if (TCLCore.isScamMarkHandle(message.handle)) patch.handle = message.handle;
      const displayName = TCLCore.sanitizeDisplayName(message.displayName);
      if (displayName) patch.displayName = displayName;
    }
    // handleIndex 不在這裡手動維護：capScamBlocklist 內的正規化一律由
    // entries 重建，dismissed 不進反查表，孤兒鍵沒有任何機會留下。
    list.entries[userId] = TCLCore.markScamEntryDirty(Object.assign({}, entry, patch), now);
    return { next: list };
  }, SCAM_MUTATE_OPTS);
  notifySyncRecorded();
  return { ok: true };
}

// 選項頁的「復原」（使用者反悔解除）：把同一筆條目翻回 active 並刪掉
// dismissedAt，證據一路留著——復原後不必等下一次掃描，卡片就畫得出來。名單裡
// 沒有這一筆時無事可做（沒有條目可復原）：不寫 storage、不掛同步，仍回 ok。
async function handleScamBlocklistRestore(message) {
  const userId = message && message.userId;
  if (!TCLCore.isScamUserId(userId)) return { ok: false, code: 'bad_request' };

  const out = await mutate(SCAM_BLOCKLIST_KEY, (list) => {
    const entry = list.entries[userId];
    if (!entry) return undefined;
    const now = Date.now();
    const restored = TCLCore.markScamEntryDirty(Object.assign({}, entry, { state: 'active', updatedAt: now }), now);
    delete restored.dismissedAt;
    list.entries[userId] = restored;
    return { next: list };
  }, SCAM_MUTATE_OPTS);
  if (out.written) notifySyncRecorded();
  return { ok: true };
}
