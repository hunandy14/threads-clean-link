// sw-og.js — service worker 的短碼解析與貼文頁 og 資訊擷取，由 background.js
// 以 importScripts 載入。
//
// 本檔負責:分享短連結的匿名解析(resolveFinalUrl)與乾淨網址截取、
// resolveShare 訊息的 handler、og:title／og:description 的擷取與消毒、og
// 短期快取與 in-flight 去重，以及本地路徑(icon/strip)的 og 補強請求。對
// Threads 的請求量與逾時都在這裡把關。
//
// 對外提供的全域名稱:
//   CLEAN_POST_URL_PATTERN、OG_SCAN_LIMIT、OG_FETCH_HEADERS、escapeRegExp、
//   decodeHtmlEntities、extractOgFields、sanitizeOgFields、mergeOgIntoFields、
//   cacheOgFields、peekOgFields、fetchOgFieldsForLocalKind、diffRemovedParams、
//   handleResolveShareMessage、resolveFinalUrl、extractCleanPostUrl
//
// 依賴:前載的 tcl-core.js(TCLCore)與 SW 原生的 fetch／AbortSignal。
'use strict';

// 乾淨貼文網址格式，例如：https://www.threads.com/@username/post/AbCd123EfGh
// 刻意不錨定收尾：extractCleanPostUrl 仰賴它能從帶 query/hash 的轉址結果
// 「截」出前段乾淨網址，加上 $ 會讓截取失效。
const CLEAN_POST_URL_PATTERN = /^https:\/\/(www\.)?threads\.(com|net)\/@[^/?#]+\/post\/[^/?#]+/i;

// 全 repo 單一權威的乾淨貼文網址驗證走 TCLCore.isCleanPostUrl(錨定整串、
// 白名單字元類 + 長度上限)，與 options 讀取端共用同一份。cleanedNotice(見
// handleCleanedNotice)與 menu 路徑寫入 history 前(見 handleShareLinkClick)
// 都過同一份權威驗證——extractCleanPostUrl 用的 CLEAN_POST_URL_PATTERN 刻意
// 寬鬆(不錨定收尾)，寬鬆匹配到的內容不能不經 isCleanPostUrl 就直接流進 history。

// 短碼解析(resolveFinalUrl)單次請求的逾時，與 sw-scam.js 的 SCAM_FETCH_TIMEOUT_MS 同量級。
const RESOLVE_FETCH_TIMEOUT_MS = 10000;

// 右鍵路徑(menu)專用——對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/link-cleaner.ts:diffRemovedParams，比對淨化前後兩個網址，列出
// 被移除的 query 參數。cleanUrl(extractCleanPostUrl 的結果)一律不含
// query，afterParams 實際上恆為空集合，等同回報 finalUrl 的全部 query
// 參數;仍照抄手機版「比較後者鍵集合」的寫法，不自行簡化，未來若
// cleanUrl 的定義改變也不必回頭改這支函式。任一邊網址不合法(URL 建構
// 例外)一律回傳空陣列，不影響呼叫端(fail-safe，缺席不硬造)。
function diffRemovedParams(before, after) {
  try {
    const beforeParams = new URL(before).searchParams;
    const afterKeys = new Set(Array.from(new URL(after).searchParams.keys()).map((k) => k.toLowerCase()));
    const removed = [];
    beforeParams.forEach((value, key) => {
      if (!afterKeys.has(key.toLowerCase())) removed.push({ key, value });
    });
    return removed;
  } catch (err) {
    return [];
  }
}

// ---- og:description/og:title 擷取。實測 threads 貼文頁的 og:description
// 是全文且連結完整(DOM 顯示層才截斷);og:title 形如「かえで (@kaede.hong)
// on Threads」。短碼解析路徑(resolveFinalUrl，share 與右鍵路徑共用)本來就
// fetch 貼文頁，同一 response 順手撈，零額外請求。SW 沒有 DOMParser，自行用
// regex 抽取 + HTML entity 解碼，規則對齊手機版 hunandy14/meta-link-clearer 的
// src/lib/post-meta.ts(ogContent／decodeHtmlEntities／parsePostMetaFromHtml
// 的 Threads 分支)，額外加上掃描長度上限防 ReDoS(手機版沒有這道防線，是本
// 檔案在 SW 環境下的加固)。----

// 掃描長度上限:只在 HTML 前段找 og meta 標籤(通常在 <head>，離文件開頭
// 很近)，避免對整份頁面(可能數百 KB)全文跑正則。
const OG_SCAN_LIMIT = 65536;

// 【語系鎖定】Threads 貼文頁的 og:title 會跟著 Accept-Language 換格式:
// 英文是「かえで (@kaede.hong) on Threads」(半形括號、帳號在名稱後)，
// 中文則是「Threads 上的かえで（@kaede.hong）」(全形括號、多一個前綴)。
// 解析規則(parseOgTitle)照抄手機版 post-meta.ts，只認半形括號那一式，
// 中文格式會整串被當成顯示名稱塞進 author。
//
// 與其讓解析器去追各語系的措辭變化(站方隨時可改，且語系數量無上限)，
// 不如把來源鎖成固定的一種:兩個抓貼文頁的 fetch 點一律帶
// Accept-Language: 'en'，og:title 恆為英文格式，解析規則不必變。SW 的
// fetch 不受使用者瀏覽器語系影響，這個 header 只影響我們自己這兩次背景
// 請求，不會改變使用者在 threads 頁面上看到的語言。
//
// 抓貼文頁的 fetch 點就這兩處(全庫已確認無第三處)，兩處共用本常數:
//   1. resolveFinalUrl —— share 自動路徑與右鍵選單路徑共用的短碼解析器
//      (右鍵路徑經 handleShareLinkClick 呼叫，不另開 fetch)。
//   2. fetchOgFieldsForLocalKind —— icon/strip 兩條本地路徑的 og 補強。
//   3. fetchScamAuthorId —— 詐騙黑名單的匿名取作者 id 備援。
//
// 【不可加 User-Agent】帶了 Threads 會回 SPA 殼，頁面裡一個 og 標籤與
// SSR JSON 欄位都沒有。三條路徑皆依賴此隱性行為。
const OG_FETCH_HEADERS = { 'Accept-Language': 'en' };

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 從 HTML 文字擷取 <meta property="og:xxx" content="..."> 的 content 屬
// 性值，property 可能在 content 之前或之後(不同頁面產生器順序不一定)，
// 兩種順序都要能比對到。找不到回傳 null。正則沿用手機版 post-meta.ts 的
// ogContent 寫法，只多了掃描長度上限這一層(見上方常數註解)。
//
// 這兩條由屬性名動態組成，不在 ReDoS 靜態閘門(test/regex-safety.test.js)
// 的範圍內，列在該檔的動態建構白名單。`[^>]+` 夾著屬性字面值的形狀不是線
// 性的，工作量由 OG_SCAN_LIMIT 封頂;改用 scamDocIdentityUrls 那套逐屬性拆
// 解會改變吻合範圍(例如 `data-property="og:title"` 這類字面值落在別的屬
// 性裡的寫法，這兩條會認、逐屬性拆解不認)，因此維持與手機版一致的寫法。
function extractOgMeta(html, property) {
  if (typeof html !== 'string' || !html) return null;
  const scanText = html.slice(0, OG_SCAN_LIMIT);
  const escaped = escapeRegExp(property);
  const re1 = new RegExp(`<meta[^>]+property="${escaped}"[^>]+content="([^"]*)"`, 'i');
  const re2 = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${escaped}"`, 'i');
  const match = re1.exec(scanText) || re2.exec(scanText);
  return match ? decodeHtmlEntities(match[1]) : null;
}

// 極簡 HTML entity 解碼，只處理 og:content 屬性值裡實際會出現的子集(SW
// 沒有 DOMParser，不用瀏覽器原生解碼器)。規則與順序照抄手機版
// post-meta.ts 的 decodeHtmlEntities(依序 amp/lt/gt/quot/#39/hex/十進
// 位，鏈式 replace)。解碼後的純文字只會流入 textContent 類的 sink(下游
// options.js 卡片渲染皆為 textContent，不是 innerHTML)，不得再進任何
// HTML sink——這裡的解碼純粹是把屬性值裡的逸出字元還原成使用者看得懂
// 的原文字元，不是要重新產生可執行的 HTML。
function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch (e) {
        return m;
      }
    })
    .replace(/&#(\d+);/g, (m, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch (e) {
        return m;
      }
    });
}

// og:title 常見樣式:「顯示名稱 (@handle) on Threads」。比對規則照抄手
// 機版 post-meta.ts 的 Threads 分支:非貪婪抓第一組「(@handle)」前的文
// 字當顯示名稱，不要求整串以「on Threads」結尾——顯示名稱本身含括號、
// @ 等邊角字元不影響，因為比對的是「第一個」(@…)出現的位置，不是整段
// 字串的格式。抓不到 (@handle) 形狀時，整串當顯示名稱、只去掉結尾的
// 「 on Threads」尾綴，不解析 handle(手機版同一套邏輯，涵蓋粉專等
// og:title 沒有帳號形狀的情況)。回傳 { author?, handle? }(handle 補回
// 開頭的 @，對齊本檔既有的 handle 儲存格式——手機版儲存不含 @，於渲染
// 層補上，本檔案渲染層直接吃已含 @ 的 handle，見 options.js)，皆缺席時
// 回傳 null。
//
// 【第二式:全形括號保底】兩個 fetch 點已鎖 Accept-Language: 'en'(見
// OG_FETCH_HEADERS)，正常情況 og:title 恆為英文格式，走不到這一式。它
// 存在是為了 header 失效的情境:站方改版忽略 Accept-Language、企業代理
// 改寫 header、或未來新增的呼叫點忘了帶。中文語系的樣式是「Threads 上
// 的かえで（@kaede.hong）」——全形括號，且顯示名稱前多一個「Threads 上
// 的」前綴。主式(半形)不成立時才試這一式，主式行為零改動。
//
// 【第三式:fallback 的髒字串防線】兩式都不成立時，沿用原本「整串當顯
// 示名稱、只剝掉英文尾綴」的手機版邏輯(涵蓋粉專等 og:title 本來就沒有
// 帳號形狀的情況);但結果若仍夾帶「(@」或「（@」殘片，代表這是某種我們
// 沒認得的帳號形狀樣式(例如又一種語系的新措辭)，整串塞進 author 只會產
// 生「Threads 上的某某（@someone）」這類髒資料——寧缺勿錯，整欄放棄，讓
// author 缺席即可(卡片自然只顯示 @handle)。
const OG_TITLE_LOCALE_PREFIX = /^Threads\s*上的\s*/;
const OG_TITLE_EN_SUFFIX_WORDS = /on Threads$/i;
const OG_TITLE_HANDLE_RESIDUE = /[(（]@/;
const LINE_TERMINATOR_PATTERN = /[\n\r\u2028\u2029]/;

// 切出 og:title 第一組「(@handle)」:open／close 是一對括號字元(半形 '(' 與
// ')'，或全形 '（' 與 '）')。回傳 [括號前的文字, handle] 或 null，語意與
// /^(.*?)\s*\(@([^)]+)\)/ 相同:括號前的文字去掉緊貼括號的空白後不得含換行
// (`.` 不吃換行，這段空白本身可以含);handle 至少一字、不含右括號，可以跨
// 行;這一組括號裡是空的就往後找下一組。以 indexOf 逐組定位、往回數空白，
// 整串最多各走一遍:寫成正則時 `.*?` 與 `\s*` 相鄰，同一段空白能拆給兩邊，
// 比對失敗前每種拆法都要試過。
function splitAtFirstHandle(text, open, close) {
  const opener = open + '@';
  const lineBreak = LINE_TERMINATOR_PATTERN.exec(text);
  const firstBreak = lineBreak ? lineBreak.index : text.length;
  let at = text.indexOf(opener);
  while (at !== -1) {
    let nameEnd = at;
    while (nameEnd > 0 && text.charAt(nameEnd - 1).trim() === '') nameEnd--;
    if (firstBreak < nameEnd) return null;
    const end = text.indexOf(close, at + opener.length);
    if (end === -1) return null;
    if (end > at + opener.length) return [text.slice(0, nameEnd), text.slice(at + opener.length, end)];
    at = text.indexOf(opener, at + 1);
  }
  return null;
}

// 剝掉結尾的「 on Threads」(前面至少一個空白，大小寫不拘)連同它前面整段空
// 白，語意與 replace(/\s+on Threads$/i, '') 相同。尾綴字面值由錨定在結尾的
// 正則判斷，空白交給 trimEnd:`\s+` 沒有起點錨定時，引擎從空白串的每個位置
// 各掃一次。
function stripOgTitleEnSuffix(text) {
  if (!OG_TITLE_EN_SUFFIX_WORDS.test(text)) return text;
  const head = text.slice(0, text.length - 'on Threads'.length);
  const name = head.trimEnd();
  return name.length < head.length ? name : text;
}

function parseOgTitle(ogTitle) {
  if (typeof ogTitle !== 'string' || !ogTitle) return null;
  const trimmed = ogTitle.trim();
  const match = splitAtFirstHandle(trimmed, '(', ')');
  if (match) {
    return buildOgTitleResult(match[0], match[1]);
  }

  const fullwidth = splitAtFirstHandle(trimmed, '（', '）');
  if (fullwidth) {
    // 括號前段才是顯示名稱的所在;再剝掉中文語系前綴，以及(理論上不會
    // 與全形樣式同時出現、但剝了無害的)英文尾綴。
    const name = stripOgTitleEnSuffix(fullwidth[0].replace(OG_TITLE_LOCALE_PREFIX, ''));
    return buildOgTitleResult(name, fullwidth[1]);
  }

  const fallbackAuthor = stripOgTitleEnSuffix(trimmed).trim();
  if (!fallbackAuthor || OG_TITLE_HANDLE_RESIDUE.test(fallbackAuthor)) return null;
  return { author: fallbackAuthor };
}

// 前兩式共用的收尾:各自 trim、handle 補回開頭的 @，兩者皆空則回傳 null。
function buildOgTitleResult(rawAuthor, rawHandle) {
  const author = rawAuthor.trim();
  const handle = rawHandle.trim();
  const result = {};
  if (author) result.author = author;
  if (handle) result.handle = '@' + handle;
  return result.author || result.handle ? result : null;
}

// 從貼文頁 HTML 一次擷取 og:description(excerpt)與 og:title(拆
// author/handle)，擷取不到的欄位就缺席、不硬造。回傳值尚未經長度上限
// sanitize，呼叫端(resolveFinalUrl)統一過 sanitizeOgFields。
function extractOgFields(html) {
  const result = {};
  const description = extractOgMeta(html, 'og:description');
  if (description) result.excerpt = description;
  const title = extractOgMeta(html, 'og:title');
  const parsedTitle = title ? parseOgTitle(title) : null;
  if (parsedTitle) {
    if (parsedTitle.author !== undefined) result.author = parsedTitle.author;
    if (parsedTitle.handle !== undefined) result.handle = parsedTitle.handle;
  }
  return result;
}

// { author?, handle?, excerpt? } 形狀的三欄統一過長度上限，規則與既有
// author/handle/excerpt 完全一致。兩種輸入都會經過這裡:
//   1. resolveFinalUrl 擷取到的原始 og 資訊(extractOgFields 的回傳
//      值)，讓兩條呼叫路徑(menu 直接用、share 路徑經 og 快取轉一手)都
//      拿到同一份已經處理過的資料，不必各自重覆寫一次 sanitize。
//   2. mergeOgIntoFields 的合併結果:merge 只負責「挑值 + 去重比對」，不
//      保證輸出仍在長度上限內，任何一處疏漏都會讓超長字串直通入庫，故合
//      併後統一再過一次同一把尺——順序是「先在 mergeOgIntoFields 內完成
//      author===handle 去重比對，這裡才截斷」，避免截斷影響去重判斷的正
//      確性。
function sanitizeOgFields(rawOgFields) {
  const out = {};
  const excerpt = TCLCore.sanitizeText(rawOgFields && rawOgFields.excerpt, TCLCore.LIMITS.EXCERPT_MAX);
  if (excerpt !== undefined) out.excerpt = excerpt;
  const author = TCLCore.sanitizeText(rawOgFields && rawOgFields.author, TCLCore.LIMITS.AUTHOR_MAX);
  if (author !== undefined) out.author = author;
  const handle = TCLCore.sanitizeText(rawOgFields && rawOgFields.handle, TCLCore.LIMITS.AUTHOR_MAX);
  if (handle !== undefined) out.handle = handle;
  return out;
}

// og 資訊與既有欄位(DOM 擷取或缺席)的合併規則。web DOM 抓到的「作者」實為
// username——與 handle 同源、是錯值不是缺席，og:title 解析出的顯示名稱優先
// 蓋過，不是「新值優先、缺席才沿用」這種對等合併(手機版一律靠 og:title 解析、
// 從不做 DOM 擷取，不存在這個資料品質問題，故無對應防禦可抄，以下為本檔案針
// 對此問題的裁決):
//   - excerpt:og 版是全文(DOM 顯示層才截斷)，og 有值就蓋過既有版本;
//     og 缺席才維持既有版本。
//   - author:og 有解析出來就一定蓋過既有版本(既有的 DOM 版本本身就不
//     可信);og 缺席才維持既有版本。
//   - handle:反過來，DOM/URL 擷取的 handle 才是可靠來源，既有版本有值
//     就維持，og 版只在既有版本缺席時補位。
//   - 重複值防禦:合併後若 author 與 handle(去掉開頭 @ 比較)相同，視
//     同 author 缺席、不存重複值——通常是 og 解析也失敗、退回到與 DOM
//     版一樣的窘境(或 og:title 本身就只有帳號名沒有顯示名稱)。
function mergeOgIntoFields(existing, ogFields) {
  const hasOg = ogFields && typeof ogFields === 'object';
  let author = hasOg && ogFields.author !== undefined ? ogFields.author : existing.author;
  const handle = existing.handle !== undefined ? existing.handle : hasOg && ogFields.handle;
  const excerpt = hasOg && ogFields.excerpt !== undefined ? ogFields.excerpt : existing.excerpt;

  const normalizedHandle = typeof handle === 'string' ? handle.replace(/^@/, '') : handle;
  if (author !== undefined && author === normalizedHandle) {
    author = undefined;
  }

  const result = {};
  if (author !== undefined) result.author = author;
  if (handle) result.handle = handle;
  if (excerpt !== undefined) result.excerpt = excerpt;
  return result;
}

// og 資料橋接快取(share 路徑專用):resolveShare(handleResolveShareMessage)
// 解析短碼時已經拿到 og 資訊，但 share 路徑實際的 recordHistory 要等
// guard 之後另外送來的 cleanedNotice(見 handleCleanedNotice)才會發生
// ——兩者是不同時間點的訊息，用一個以 cleanUrl 為 key 的小快取橋接。取用
// 一律走 peekOgFields(窺視不刪，見下方);上限與 TTL 防止使用者複製後遲遲不
// 觸發 cleanedNotice 時無限累積或用到過期資料。menu 路徑不經這個快取，
// resolveFinalUrl 的回傳值直接同步使用。
const OG_CACHE_MAX = 20;
const OG_CACHE_TTL_MS = 60 * 1000;
// 負快取短 TTL:og 抓不到(空結果)存負快取，避免同一貼文每次事件都重跑
// 一次 2.5s fetch;但比正快取短很多，讓「站方稍後補上 og」或「暫時性抓取
// 失敗」有機會在不久後重試，不被卡滿整個 60 秒。
const OG_NEGATIVE_TTL_MS = 10 * 1000;
// 負快取標記:空結果不是「沒有這筆快取」，而是「查過了，確實沒有 og」。
// 用一個獨一無二的 sentinel 與正常 og 物件區分，peek 到它時呼叫端一律當
// 作 null(沒收穫)處理，但不會因此再發一次 fetch。
const OG_NEGATIVE = { __tclNegativeOg: true };
const ogFieldsCache = new Map();
// in-flight 去重:同一 cleanUrl 正在跑的 fetch promise，連點 icon 時第二
// 次事件直接接同一個 promise，不重複發 fetch。完成後(finally)就地移除。
const ogInflight = new Map();

// 空結果判定:三個 og 欄位全缺席即視為空(呼叫端據此落負快取)。
function isEmptyOgFields(ogFields) {
  return (
    !ogFields ||
    (ogFields.excerpt === undefined && ogFields.author === undefined && ogFields.handle === undefined)
  );
}

function cacheOgFields(cleanUrl, ogFields) {
  const empty = isEmptyOgFields(ogFields);
  // 真 LRU:set 前先 delete，讓「重新被碰到」的 key 移到 Map 迭代序尾端
  // (最新)，size 超限時淘汰的 keys().next()(最舊)才是真正最久沒用到的
  // 那筆，而不是最早插入但可能剛被讀取過的那筆。
  ogFieldsCache.delete(cleanUrl);
  ogFieldsCache.set(cleanUrl, {
    at: Date.now(),
    ogFields: empty ? OG_NEGATIVE : ogFields,
    ttl: empty ? OG_NEGATIVE_TTL_MS : OG_CACHE_TTL_MS,
  });
  if (ogFieldsCache.size > OG_CACHE_MAX) {
    const oldestKey = ogFieldsCache.keys().next().value;
    ogFieldsCache.delete(oldestKey);
  }
}

// 窺視快取但不刪:同一個 cleanUrl 在 OG_CACHE_TTL_MS 視窗內的多次事件都能
// 重用同一份快取(見下方 fetchOgFieldsForLocalKind 的節流)，不能第一次讀到
// 就把快取清空。share
// 路徑的 cleanedNotice 命中的正是 resolveShare 剛寫入的這份快取——peek
// 到就零額外 fetch。負快取(空結果，見 fetchOgFieldsForLocalKind 的
// NEGATIVE_OG 標記)也一律先由這裡撈出，呼叫端據此判斷是否短路。
function peekOgFields(cleanUrl) {
  const entry = ogFieldsCache.get(cleanUrl);
  if (!entry) return null;
  const ttl = typeof entry.ttl === 'number' ? entry.ttl : OG_CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    // 過期就地清掉，不留給 LRU 慢慢淘汰，順手讓快取只保有有效項目。
    ogFieldsCache.delete(cleanUrl);
    return null;
  }
  return entry.ogFields; // 正常 og 物件，或 OG_NEGATIVE(負快取 sentinel)
}

// 本地路徑(icon/strip)專用的 og 補強逾時:貼文按鈕複製與 ?xmt 剪參都是
// 純本地判斷，本身不觸發網路請求;這裡額外補一次 fetch 專門拿 og
// 資訊，逾時風格沿用 clipboard-guard.js 的 RESOLVE_TIMEOUT_MS(2.5 秒，
// 本檔案獨立維護同一個數值，兩處環境不同沒有共用單一來源的機制)。
const OG_LOCAL_FETCH_TIMEOUT_MS = 2500;

// 本地路徑(icon/strip)專用:貼文按鈕複製與 ?xmt 剪參的 web 動態牆 DOM
// 沒有個人顯示名稱(只有 username)，單靠 DOM 的 author 永遠等於 handle、
// 被重複值防禦丟棄，卡片只剩 @handle；DOM 擷取的摘要還可能吸到讚數等雜
// 訊。這裡額外對 cleanUrl 補一次 fetch 擷取 og 資訊，
// 重用既有的 extractOgFields／sanitizeOgFields 全鏈(長度雙層防線不變)。
//
// 節流(三層):
//   1. 快取命中(peekOgFields，窺視不刪):同一 cleanUrl 在 TTL 內的正快取
//      直接回傳、不重複 fetch;負快取(OG_NEGATIVE)命中則回傳 null 但同樣
//      不 fetch——og 抓不到的貼文在短 TTL 內不再每次重跑 2.5s fetch。
//   2. in-flight 去重(ogInflight):同一 cleanUrl 已有 fetch 在跑，連點 icon
//      的第二次事件直接接同一個 promise，不發第二次 fetch;完成後就地換成
//      結果(靠快取)並從 ogInflight 移除。
//   3. 每次呼叫各自的逾時競速:即使接了別人的 in-flight promise，自己這次
//      事件仍最多等 OG_LOCAL_FETCH_TIMEOUT_MS 就 fail-open 回 null。
// 逾時或 fetch 失敗一律回傳 null，呼叫端 fail-open 退回 DOM 版欄位，離線也
// 不影響紀錄照常落盤——逾時之後 fetch 仍在背景跑完的話，結果照樣存回快取
// (正或負)供下一次事件重用(這次事件用不到，但沒有浪費)。
async function fetchOgFieldsForLocalKind(cleanUrl) {
  const cached = peekOgFields(cleanUrl);
  // 正快取回傳結果;負快取(sentinel)回傳 null(沒收穫但不再 fetch)。
  if (cached !== null) return cached === OG_NEGATIVE ? null : cached;

  // in-flight 去重:已有同 cleanUrl 的 fetch 在跑就共用，否則起一個新的並
  // 登記到 ogInflight。fetch 完成後把結果寫回快取(正或負)，供後續事件經
  // 第 1 層命中;無論成敗都在 finally 從 ogInflight 移除。
  let fetchOnce = ogInflight.get(cleanUrl);
  if (!fetchOnce) {
    fetchOnce = (async () => {
      try {
        const response = await fetch(cleanUrl, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'follow',
          // og:title 的語系鎖定，見 OG_FETCH_HEADERS。
          headers: OG_FETCH_HEADERS,
        });
        const text = await response.text();
        const ogFields = sanitizeOgFields(extractOgFields(text));
        // 空結果會被 cacheOgFields 收成負快取(短 TTL);非空則正快取。
        cacheOgFields(cleanUrl, ogFields);
        return isEmptyOgFields(ogFields) ? null : ogFields;
      } catch (err) {
        console.error('[threads-clean-link] 本地路徑(icon/strip)補強 og 資訊失敗', err);
        return null;
      } finally {
        ogInflight.delete(cleanUrl);
      }
    })();
    ogInflight.set(cleanUrl, fetchOnce);
  }

  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), OG_LOCAL_FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([fetchOnce, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

// 不信任呼叫端傳入的 url，一律用 TCLCore.SHARE_URL_PATTERN 重新驗證，
// 不符合就直接拒絕、不對外發送任何請求。
async function handleResolveShareMessage(message) {
  const shareUrl = message && message.url;

  if (typeof shareUrl !== 'string' || !TCLCore.SHARE_URL_PATTERN.test(shareUrl)) {
    return { ok: false, reason: 'invalid-url' };
  }

  let finalUrl, ogFields;
  try {
    const resolved = await resolveFinalUrl(shareUrl);
    finalUrl = resolved.finalUrl;
    ogFields = resolved.ogFields;
  } catch (err) {
    console.error('[threads-clean-link] (bridge) 解析短連結失敗', err);
    return { ok: false, reason: 'network-error' };
  }

  const cleanUrl = extractCleanPostUrl(finalUrl);
  if (!cleanUrl) {
    return { ok: false, reason: 'format-error' };
  }

  // og 資訊透過快取橋接到之後才會抵達的 cleanedNotice(見
  // handleCleanedNotice → fetchOgFieldsForLocalKind → peekOgFields)，這條
  // 訊息通道的回應形狀不變，不需要多帶欄位、也不需要改動 guard/bridge 的
  // 訊息協定。
  cacheOgFields(cleanUrl, ogFields);

  return { ok: true, cleanUrl };
}

// 對短連結發一次匿名(不帶 cookie)請求並跟隨轉址，只取最終網址。
// 用 GET 而非 HEAD:匿名 HEAD 常不回傳 302、或會先跳驗證頁，
// GET + redirect:'follow' 較穩定。share 與右鍵路徑共用同一個 resolver，
// 回傳值除了 finalUrl，也附上這次順手從同一個 response 擷取到的 og 資
// 訊(見上方 og 擷取區塊)，兩條呼叫路徑各自決定怎麼用(menu 路徑直接把
// ogFields 餵給 extractHistoryExtraFields;share 路徑經
// handleResolveShareMessage 寫入 og 快取橋接)。
//
// 逾時 RESOLVE_FETCH_TIMEOUT_MS 涵蓋到讀完本文:headers 階段逾時丟給呼叫端
// (走既有的網路錯誤回報)，讀本文逾時由下方的 try 吞掉(ogFields 為空、
// finalUrl 照回)。逾時只會提早結束同一個請求，不重試。SW 原生有
// AbortSignal;沒有它的環境(部分測試沙箱)以 typeof 取值，不帶 signal。
async function resolveFinalUrl(shareUrl) {
  const response = await fetch(shareUrl, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' ? AbortSignal.timeout(RESOLVE_FETCH_TIMEOUT_MS) : undefined,
    // og:title 的語系鎖定，見 OG_FETCH_HEADERS。只影響本次背景請求擷取到
    // 的 og 內容，轉址跟隨(finalUrl)的行為不受影響。
    headers: OG_FETCH_HEADERS,
  });
  const finalUrl = response.url;

  // og:description/og:title(短碼解析路徑順手擷取，同一 response，零額
  // 外請求):讀取失敗(非文字回應、body 已消費等)一律容錯為空物件，不
  // 影響 finalUrl 本身的既有行為——og 擷取純屬錦上添花，絕不能讓解析流
  // 程本身失敗。改讀 response.text() 之後不再需要另外 cancel() 未讀取
  // 的 body 串流(body 已經被完整消費)。
  let ogFields = {};
  try {
    const text = await response.text();
    ogFields = sanitizeOgFields(extractOgFields(text));
  } catch (err) {
    console.error('[threads-clean-link] 讀取回應內容擷取 og 資訊失敗', err);
  }

  return { finalUrl, ogFields };
}

// 最終網址符合貼文格式才回傳乾淨網址(去掉整段 query 與 hash)，否則回傳 null。
function extractCleanPostUrl(finalUrl) {
  const match = CLEAN_POST_URL_PATTERN.exec(finalUrl);
  return match ? match[0] : null;
}
