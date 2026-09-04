// auth.js — Google 登入(OIDC implicit flow)取得 id_token，交給後端換取工作階段。
// 載入環境比照 tcl-core.js:
//   - service worker:background.js 以 importScripts('auth.js') 載入(全域 self)
//   - Node 測試:CommonJS require(純函式部分不碰 chrome API,crypto/btoa/atob
//     取自 globalThis)
//
// 為何是 implicit flow(response_type=id_token)而非授權碼:擴充功能沒有可
// 保管 client secret 的地方，且後端只需要一枚可驗簽的 id_token 來認人。
// redirect_uri 固定為 https://<擴充 ID>.chromiumapp.org/,由 manifest 的 key
// 欄位把擴充 ID 釘死，Console 端才登記得起來。
//
// nonce 是這條流程的重放防線:由呼叫端(sync.js 的同步引擎)在同一個閉包裡產生
// 並傳入，**不落 storage**;本模組把它放進授權請求，回來時與 id_token payload
// 的 nonce 逐字比對(verifyIdTokenPayload)，一次比對就是全部的防線。SW 在授權
// 往返中途被回收時，launchWebAuthFlow 的 promise 鏈整條消失，沒有「待比對的
// 登入」可接，存一份到 storage 也接不回來。
//
// 權限:identity 與後端 host 都是 optional 權限。chrome.permissions.request
// 只能在使用者手勢中呼叫，SW 自行發起一律失敗，因此本模組只提供「探」的一半
// (containsPermissions);「求」的一半在 options 頁的登入按鈕 click handler 內。
(function (root) {
  'use strict';

  var GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  var GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
  var SCOPE = 'openid email profile';

  // 256 bits 的隨機值，以 base64url 呈現(無填充,URL 安全)。
  function generateNonce() {
    var bytes = new Uint8Array(32);
    root.crypto.getRandomValues(bytes);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return root.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildAuthorizeUrl(options) {
    var params = new URLSearchParams({
      client_id: options.clientId,
      response_type: 'id_token',
      redirect_uri: options.redirectUri,
      scope: SCOPE,
      nonce: options.nonce,
      prompt: options.prompt || 'select_account',
    });
    return GOOGLE_AUTH_ENDPOINT + '?' + params.toString();
  }

  // id_token 走 URL fragment 回來(implicit flow 不把權杖放進 query),因此
  // 從 # 之後解析;沒有 fragment 或缺 id_token 一律視為失敗。
  //
  // expectedRedirectUri 有給就先比對前綴:launchWebAuthFlow 回傳的網址必須是
  // 本擴充的 chromiumapp.org 位址，換成別的來源就代表這串 fragment 不是我們
  // 發起的那一次授權的產物，整條拒收。
  function extractIdTokenFromRedirect(redirectUrl, expectedRedirectUri) {
    if (typeof redirectUrl !== 'string' || redirectUrl.indexOf('#') === -1) {
      throw new Error('授權回呼沒有 fragment，取不到 id_token');
    }
    if (typeof expectedRedirectUri === 'string' && expectedRedirectUri) {
      if (redirectUrl.indexOf(expectedRedirectUri) !== 0) {
        throw new Error('授權回呼的 redirect 前綴與本次請求不符');
      }
    }
    var fragment = redirectUrl.slice(redirectUrl.indexOf('#') + 1);
    var params = new URLSearchParams(fragment);
    if (params.get('error')) {
      throw new Error('授權失敗:' + params.get('error'));
    }
    var idToken = params.get('id_token');
    if (!idToken) throw new Error('授權回呼缺少 id_token');
    return idToken;
  }

  function decodeJwtPayload(token) {
    var parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('id_token 不是三段式 JWT');
    var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var binary = root.atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // 用戶端側的健全性檢查。簽章驗證是後端的責任(擴充功能拿不到也不該保管
  // Google 的公鑰輪替狀態),這裡只擋「拿錯 client 的 token」與重放。
  function verifyIdTokenPayload(payload, expected) {
    if (!payload || typeof payload !== 'object') throw new Error('id_token payload 解析失敗');
    // 預期值本身缺漏時前置拒絕:aud/nonce 比對在 expected 為空字串或 undefined
    // 時會因為 payload 也缺該欄位而「意外相符」，等於整道檢查被繞過。
    if (typeof expected !== 'object' || !expected) throw new Error('缺少 id_token 的預期值');
    if (typeof expected.clientId !== 'string' || !expected.clientId) {
      throw new Error('缺少預期的 client ID，無法驗 aud');
    }
    if (typeof expected.nonce !== 'string' || !expected.nonce) {
      throw new Error('缺少本次請求的 nonce，無法擋重放');
    }
    if (payload.aud !== expected.clientId) {
      throw new Error('id_token 的 aud 不是預期的 client ID');
    }
    if (payload.nonce !== expected.nonce) {
      throw new Error('id_token 的 nonce 與本次請求不符');
    }
    if (GOOGLE_ISSUERS.indexOf(payload.iss) === -1) {
      throw new Error('id_token 的 iss 不是 Google');
    }
    // exp 是必要欄位:缺漏或型別不對時「跳過過期檢查」等於接受一枚永不過期
    // 的 token，那正是重放攻擊要的東西。
    if (typeof payload.exp !== 'number' || !isFinite(payload.exp)) {
      throw new Error('id_token 缺少有效的 exp');
    }
    if (payload.exp * 1000 <= Date.now()) {
      throw new Error('id_token 已過期');
    }
    return payload;
  }

  function permissionsFor(apiBase) {
    return { permissions: ['identity'], origins: [apiBase.replace(/\/+$/, '') + '/*'] };
  }

  // SW 端的權限探測:只回報「有沒有」，不發起 request(見檔頭「權限」段落)。
  // 同步引擎拿到 false 就把狀態轉成 error/permission_required，由 options 頁
  // 的登入按鈕在使用者手勢內補請求。
  function containsPermissions(descriptor) {
    return new Promise(function (resolve, reject) {
      chrome.permissions.contains(descriptor, function (granted) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(Boolean(granted));
      });
    });
  }

  function launchWebAuthFlow(url) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({ url: url, interactive: true }, function (redirectUrl) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!redirectUrl) {
          reject(new Error('授權流程未回傳 redirect URL(使用者取消?)'));
          return;
        }
        resolve(redirectUrl);
      });
    });
  }

  // nonce 由呼叫端傳入(引擎生成);本模組不自行生成——授權請求送出的那一枚與
  // 底下驗 payload 用的必須是同一個值，來源只能有一個。
  function signInWithGoogle(options) {
    var clientId = options.clientId;
    var nonce = options.nonce;
    var redirectUri;
    return Promise.resolve()
      .then(function () {
        if (typeof clientId !== 'string' || !clientId) throw new Error('signInWithGoogle 缺少 clientId');
        if (typeof nonce !== 'string' || !nonce) throw new Error('signInWithGoogle 缺少 nonce');
        redirectUri = chrome.identity.getRedirectURL();
        return launchWebAuthFlow(
          buildAuthorizeUrl({ clientId: clientId, redirectUri: redirectUri, nonce: nonce })
        );
      })
      .then(function (redirectUrl) {
        var idToken = extractIdTokenFromRedirect(redirectUrl, redirectUri);
        var payload = verifyIdTokenPayload(decodeJwtPayload(idToken), {
          clientId: clientId,
          nonce: nonce,
        });
        return { idToken: idToken, nonce: nonce, email: payload.email, payload: payload };
      });
  }

  // credentials:'omit' — 工作階段憑證由呼叫端保管，不讓瀏覽器自動夾帶 cookie。
  // redirect:'error' — 後端不該對這支回 3xx。放任 fetch 自動跟隨的話，轉址後
  // 那一站的回應照樣會被當成後端回應處理(包含採信它的 set-auth-token 標頭)，
  // 等於把整個工作階段的來源交給任何能讓後端轉址的人;與 sync.js 的 call()
  // 同一條紀律，登入這支更是 token 的第一個入口。
  function exchangeWithBackend(options) {
    var url = options.apiBase.replace(/\/+$/, '') + '/api/auth/sign-in/social';
    return fetch(url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        idToken: { token: options.idToken, nonce: options.nonce },
      }),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          return {
            status: res.status,
            ok: res.ok,
            authToken: res.headers.get('set-auth-token'),
            body: body,
          };
        });
    });
  }

  var api = {
    GOOGLE_AUTH_ENDPOINT: GOOGLE_AUTH_ENDPOINT,
    SCOPE: SCOPE,
    permissionsFor: permissionsFor,
    containsPermissions: containsPermissions,
    generateNonce: generateNonce,
    buildAuthorizeUrl: buildAuthorizeUrl,
    extractIdTokenFromRedirect: extractIdTokenFromRedirect,
    decodeJwtPayload: decodeJwtPayload,
    verifyIdTokenPayload: verifyIdTokenPayload,
    signInWithGoogle: signInWithGoogle,
    exchangeWithBackend: exchangeWithBackend,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLAuth = api;
})(typeof self !== 'undefined' ? self : globalThis);
