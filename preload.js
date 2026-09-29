'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 仅向浏览器外壳 UI 暴露必要能力，页面内容无法访问这些 API */
contextBridge.exposeInMainWorld('browser', {
  /* 标签页 */
  createTab: (url) => ipcRenderer.invoke('tabs:create', url),
  closeTab: (id) => ipcRenderer.send('tabs:close', id),
  activateTab: (id) => ipcRenderer.send('tabs:activate', id),
  navigate: (id, url) => ipcRenderer.send('tabs:navigate', { id, url }),
  action: (action, id) => ipcRenderer.send('tabs:action', { id, action }),
  onTabsChanged: (handler) => ipcRenderer.on('tabs:changed', (_e, data) => handler(data)),

  /* 界面联动 */
  reportChromeHeight: (height) => ipcRenderer.send('ui:chrome-height', height),
  onFocusAddress: (handler) => ipcRenderer.on('ui:focus-address', () => handler()),

  /* 窗口控制 */
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onWindowState: (handler) => ipcRenderer.on('window:state', (_e, data) => handler(data)),

  /* 其他 */
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
});
