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

// 建立具備 addEventListener/postMessage 的假 window,模擬同一分頁內
// MAIN world 與 ISOLATED world 用 postMessage 互通的行為;派送採
// setTimeout(0) 排程,貼近瀏覽器 postMessage 的非同步時序。
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

module.exports = { FakeClipboardItem, createWindow, runInSandbox };
