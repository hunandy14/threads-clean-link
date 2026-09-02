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
// nonce 是這條流程的重放防線:本地產生後同時放進授權請求與後端 sign-in body,
// 回來的 id_token payload 內的 nonce 必須一致，否則整條拒收。
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
  function extractIdTokenFromRedirect(redirectUrl) {
    if (typeof redirectUrl !== 'string' || redirectUrl.indexOf('#') === -1) {
      throw new Error('授權回呼沒有 fragment，取不到 id_token');
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
    if (payload.aud !== expected.clientId) {
      throw new Error('id_token 的 aud 不是預期的 client ID');
    }
    if (payload.nonce !== expected.nonce) {
      throw new Error('id_token 的 nonce 與本次請求不符');
    }
    if (GOOGLE_ISSUERS.indexOf(payload.iss) === -1) {
      throw new Error('id_token 的 iss 不是 Google');
    }
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      throw new Error('id_token 已過期');
    }
    return payload;
  }

  function permissionsFor(apiBase) {
    return { permissions: ['identity'], origins: [apiBase.replace(/\/+$/, '') + '/*'] };
  }

  // identity 與後端 host 都是 optional 權限。chrome.permissions.request 只能在
  // 使用者手勢中呼叫，service worker 自行發起會直接丟錯，因此先用 contains 探
  // 一次:已授予就跳過 request,只有真的缺權限時才需要呼叫端提供手勢脈絡。
  function ensurePermissions(apiBase) {
    var descriptor = permissionsFor(apiBase);
    return new Promise(function (resolve, reject) {
      chrome.permissions.contains(descriptor, function (granted) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (granted) {
          resolve(true);
          return;
        }
        chrome.permissions.request(descriptor, function (accepted) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!accepted) {
            reject(new Error('使用者未授予 identity 或後端 host 權限'));
            return;
          }
          resolve(true);
        });
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

  function signInWithGoogle(options) {
    var clientId = options.clientId;
    var apiBase = options.apiBase;
    var nonce;
    return ensurePermissions(apiBase)
      .then(function () {
        nonce = generateNonce();
        var redirectUri = chrome.identity.getRedirectURL();
        return launchWebAuthFlow(
          buildAuthorizeUrl({ clientId: clientId, redirectUri: redirectUri, nonce: nonce })
        );
      })
      .then(function (redirectUrl) {
        var idToken = extractIdTokenFromRedirect(redirectUrl);
        var payload = verifyIdTokenPayload(decodeJwtPayload(idToken), {
          clientId: clientId,
          nonce: nonce,
        });
        return { idToken: idToken, nonce: nonce, email: payload.email, payload: payload };
      });
  }

  // credentials:'omit' — 工作階段憑證由呼叫端保管，不讓瀏覽器自動夾帶 cookie。
  function exchangeWithBackend(options) {
    var url = options.apiBase.replace(/\/+$/, '') + '/api/auth/sign-in/social';
    return fetch(url, {
      method: 'POST',
      credentials: 'omit',
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
    ensurePermissions: ensurePermissions,
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
