// test/helpers.js — 測試共用工具。三支 content script / service worker
// 都是無 module.exports 的整段執行腳本，這裡用 vm 在隔離的 sandbox 內載入
// 它們，並提供 window / ClipboardItem 的離線假實作，不碰真實瀏覽器 API。
'use strict';

const vm = require('node:vm');

class FakeClipboardItem {
  constructor(map) {
    this._map = map;
    this.types = Object.keys(map);
  }
  getType(type) {
    return Promise.resolve(this._map[type]);
  }
}

// 建立具備 addEventListener/postMessage 的假 window，模擬同一分頁內
// MAIN world 與 ISOLATED world 用 postMessage 互通的行為;派送採
// setTimeout(0) 排程，貼近瀏覽器 postMessage 的非同步時序。
function createWindow(origin = 'https://www.threads.com') {
  const listeners = [];
  const win = {
    location: { origin },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== 'message') return;
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    postMessage(data) {
      setTimeout(() => {
        const event = { source: win, origin: win.location.origin, data };
        listeners.slice().forEach((fn) => fn(event));
      }, 0);
    },
    // 測試專用:直接派送任意 event 物件給已註冊的 'message' 監聽器，
    // 用來偽造 event.source / event.origin 不符的情境(真實 postMessage
    // 做不到偽造來源，只能用這個管道測防護邏輯)。
    dispatchRawMessageEvent(event) {
      listeners.slice().forEach((fn) => fn(event));
    },
    // 測試專用:目前註冊中的 'message' 監聽器數量，用來驗證解析流程
    // 結束後有無正確 removeEventListener、不累積洩漏。
    getMessageListenerCount() {
      return listeners.length;
    },
  };
  return win;
}

// 在給定的 sandbox 物件內執行原始碼字串，並回傳同一個 sandbox
// (script 透過它的全域變數(navigator/window/chrome...)產生副作用)。
function runInSandbox(src, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

// ---- v1.1 設定規格(S1–S7)新增的共用 mock ----

// chrome.storage 的離線假實作(sync 區 + onChanged)。
// 【時序紀律】get/set/onChanged 一律以 setTimeout(0) 延遲結算，絕不在同一個
// tick 直接 resolve 或回呼——同 tick 假綠燈是本專案已知風險。
// get/set 同時支援 Promise 與 callback 兩種呼叫慣例，不預設實作採用哪一種。
function createChromeStorage(initial = {}) {
  const data = Object.assign({}, initial);
  const calls = { get: [], set: [] };
  const onChangedListeners = [];

  function later(fn) {
    setTimeout(fn, 0);
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(data, key);
  }

  // 比照 chrome.storage 的 keys 語義:null/undefined 取全部;字串取單鍵;
  // 陣列取多鍵;物件則以其值為「查無此鍵時的預設值」。
  function read(keys) {
    if (keys === null || keys === undefined) return Object.assign({}, data);
    if (typeof keys === 'string') return has(keys) ? { [keys]: data[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      keys.forEach((k) => {
        if (has(k)) out[k] = data[k];
      });
      return out;
    }
    const out = Object.assign({}, keys);
    Object.keys(keys).forEach((k) => {
      if (has(k)) out[k] = data[k];
    });
    return out;
  }

  const sync = {
    get(keys, callback) {
      calls.get.push(keys);
      if (typeof callback === 'function') {
        later(() => callback(read(keys)));
        return undefined;
      }
      return new Promise((resolve) => later(() => resolve(read(keys))));
    },
    set(items, callback) {
      calls.set.push(Object.assign({}, items));
      if (typeof callback === 'function') {
        later(() => {
          Object.assign(data, items);
          callback();
        });
        return undefined;
      }
      return new Promise((resolve) =>
        later(() => {
          Object.assign(data, items);
          resolve();
        })
      );
    },
  };

  return {
    calls,
    sync,
    // 直接掛到 sandbox 的 chrome.storage 上使用。
    api: {
      sync,
      onChanged: {
        addListener(fn) {
          onChangedListeners.push(fn);
        },
      },
    },
    snapshot() {
      return Object.assign({}, data);
    },
    onChangedListenerCount() {
      return onChangedListeners.length;
    },
    // 測試專用:模擬使用者在別處改了設定，延遲一個 tick 後觸發 onChanged。
    emitChange(changes, areaName = 'sync') {
      Object.keys(changes).forEach((k) => {
        data[k] = changes[k].newValue;
      });
      later(() => {
        onChangedListeners.slice().forEach((fn) => fn(changes, areaName));
      });
    },
  };
}

// 只含 checkbox 的假 document，供 popup 邏輯層以注入方式測試
// (本專案無 DOM harness，popup 邏輯約定為可注入 document 的純函式模組)。
function createCheckboxDocument(ids) {
  const elements = {};
  ids.forEach((id) => {
    const listeners = {};
    elements[id] = {
      id,
      type: 'checkbox',
      checked: false,
      disabled: false,
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners[type];
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      },
      // 測試專用:模擬使用者切換開關——先改 checked，再派送 change 事件。
      fireChange(nextChecked) {
        this.checked = nextChecked;
        (listeners.change || []).slice().forEach((fn) => fn({ type: 'change', target: this }));
      },
      listenerCount(type) {
        return (listeners[type] || []).length;
      },
    };
  });
  return {
    elements,
    getElementById(id) {
      return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null;
    },
  };
}

module.exports = {
  FakeClipboardItem,
  createWindow,
  runInSandbox,
  createChromeStorage,
  createCheckboxDocument,
};
