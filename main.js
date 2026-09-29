'use strict';

/**
 * DeepSeek 浏览器 —— 基于 Chromium 内核（Electron）的极简浏览器
 * 定位：秒开 DeepSeek 对话官网，偶尔用地址栏搜索。
 *
 * 架构说明：
 *  - 主进程（本文件）：负责窗口、标签页容器（WebContentsView，即 Chromium 的偏内嵌视图）、
 *    导航控制、快捷键、右键菜单、权限等浏览器"外壳"能力。
 *  - 渲染进程（renderer/）：只负责浏览器自绘 UI（标签栏 / 工具栏 / 地址栏 / 窗口控制）。
 *  - 每个标签页 = 一个独立的 Chromium webContents（进程级隔离），通过 WebContentsView 贴到窗口内容区。
 */

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
  Menu,
  clipboard,
  nativeTheme,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/** 启动页：DeepSeek 对话官网 */
const HOME_URL = 'https://chat.deepseek.com/';
/** 地址栏输入非网址时的搜索兜底 */
const SEARCH_URL = 'https://www.bing.com/search?q=';
/** UI 高度兜底值（渲染进程会通过 ui:chrome-height 上报真实值） */
const DEFAULT_CHROME_HEIGHT = 88;
/** 允许的权限白名单 */
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'audioCapture',
  'videoCapture',
  'display-capture',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'notifications',
  'pointerLock',
  'idle-detection',
]);
/** 窗口 / 任务栏图标（由 scripts/make-icon.ps1 生成） */
const APP_ICON = path.join(__dirname, 'build', 'icon.ico');
/** 深色窗口底色（与外壳主题一致，避免加载瞬间白闪） */
const WINDOW_BG = '#101216';
/** 新标签页（本地起始页，点击 + 打开） */
const NEW_TAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;

let mainWindow = null;
/** @type {Map<number, {id:number, view:WebContentsView, title:string, url:string, loading:boolean, favicon:string}>} */
const tabs = new Map();
let activeTabId = null;
let tabSeq = 0;
let chromeHeight = DEFAULT_CHROME_HEIGHT;

/* -------------------------------------------------------------------------- */
/*                              工具函数                                       */
/* -------------------------------------------------------------------------- */

/**
 * 把地址栏输入解析成可加载的 URL（智能识别网址 / 搜索词）
 */
function normalizeInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return HOME_URL;

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (/^(https?|file|about|data|blob|chrome|view-source|devtools):/i.test(text)) return text;
    return SEARCH_URL + encodeURIComponent(text);
  }

  const isLocal = /^localhost(:\d+)?(\/.*)?$/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text);
  const looksLikeHost = isLocal || /^[^\s/?#]+\.[^\s/?#]{2,}(:\d+)?([/?#].*)?$/.test(text);
  if (!/\s/.test(text) && looksLikeHost) return `${isLocal ? 'http' : 'https'}://${text}`;

  return SEARCH_URL + encodeURIComponent(text);
}

/** 标签页状态快照（发送给渲染进程） */
function snapshot() {
  return {
    activeId: activeTabId,
    tabs: [...tabs.values()].map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
      favicon: t.favicon,
      canGoBack: canGo(t, 'back'),
      canGoForward: canGo(t, 'forward'),
    })),
  };
}

function canGo(tab, dir) {
  try {
    const nav = tab.view.webContents.navigationHistory;
    if (!nav) return false;
    return dir === 'back' ? nav.canGoBack() : nav.canGoForward();
  } catch {
    return false;
  }
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tabs:changed', snapshot());
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 重新计算所有标签页视图的位置（紧贴工具栏下方） */
function layout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const bounds = {
    x: 0,
    y: chromeHeight,
    width,
    height: Math.max(0, height - chromeHeight),
  };
  for (const tab of tabs.values()) {
    try {
      tab.view.setBounds(bounds);
    } catch {
      /* 视图可能已被销毁 */
    }
  }
}

/** 统一控制网页视图可见性：只显示当前激活的标签页 */
function applyVisibility() {
  for (const tab of tabs.values()) {
    try {
      tab.view.setVisible(tab.id === activeTabId);
    } catch {
      /* 视图可能已被销毁 */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              标签页管理                                     */
/* -------------------------------------------------------------------------- */

function createTab(rawUrl = HOME_URL, { activate = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const id = ++tabSeq;
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 关掉后台节流：启动页在隐藏状态下也要全速渲染，切回来也是秒响应
      backgroundThrottling: false,
    },
  });

  mainWindow.contentView.addChildView(view);

  const tab = {
    id,
    view,
    title: '新标签页',
    url: rawUrl === 'about:blank' ? '' : rawUrl,
    loading: false,
    favicon: '',
  };
  tabs.set(id, tab);

  try {
    view.setBackgroundColor('#ffffff');
  } catch {
    /* 老版本无此 API，忽略 */
  }

  wireTab(tab);
  view.setVisible(false);
  layout();

  const target = rawUrl === 'about:blank' ? 'about:blank' : normalizeInput(rawUrl);
  tab.url = target === 'about:blank' ? '' : target;
  view.webContents.loadURL(target).catch(() => {
    /* 加载失败由 Chromium 内置错误页呈现 */
  });

  if (activate) activateTab(id);
  else broadcast();

  return id;
}

function wireTab(tab) {
  const wc = tab.view.webContents;

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title || '新标签页';
    broadcast();
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = Array.isArray(favicons) && favicons.length ? favicons[0] : '';
    broadcast();
  });

  wc.on('did-start-loading', () => {
    tab.loading = true;
    broadcast();
  });

  wc.on('did-stop-loading', () => {
    tab.loading = false;
    broadcast();
  });

  const syncUrl = (_e, url) => {
    if (url && url !== 'about:blank') tab.url = url;
    broadcast();
  };
  wc.on('did-navigate', syncUrl);
  wc.on('did-navigate-in-page', syncUrl);

  wc.on('render-process-gone', (_e, details) => {
    tab.loading = false;
    tab.title = '页面崩溃';
    console.error('[tab] render process gone:', details.reason);
    broadcast();
  });

  // 页面内的 target=_blank / window.open 一律转为新标签页
  wc.setWindowOpenHandler(({ url }) => {
    if (!url) return { action: 'deny' };
    if (/^https?:/i.test(url) || url === 'about:blank') {
      createTab(url);
    } else {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  wc.on('context-menu', (_e, params) => openContextMenu(tab, params));
  attachShortcuts(wc);
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeTabId = id;
  applyVisibility();
  layout();
  try {
    tab.view.webContents.focus();
  } catch {
    /* ignore */
  }
  broadcast();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  tabs.delete(id);
  try {
    mainWindow.contentView.removeChildView(tab.view);
  } catch {
    /* ignore */
  }
  try {
    tab.view.webContents.close();
  } catch {
    /* ignore */
  }

  if (tabs.size === 0) {
    // 与主流浏览器一致：关掉最后一个标签页即关闭窗口，保证任何标签都能删掉
    activeTabId = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return;
  }
  if (activeTabId === id) {
    const ids = [...tabs.keys()];
    activateTab(ids[ids.length - 1]);
  } else {
    broadcast();
  }
}

function cycleTab(step) {
  const ids = [...tabs.keys()];
  if (ids.length < 2) return;
  const index = Math.max(0, ids.indexOf(activeTabId));
  activateTab(ids[(index + step + ids.length) % ids.length]);
}

function navigateTab(id, rawUrl) {
  const tab = tabs.get(id);
  if (!tab) return;
  const target = normalizeInput(rawUrl);
  tab.url = target;
  tab.view.webContents.loadURL(target).catch(() => {});
  broadcast();
}

function navAction(id, action) {
  const tab = tabs.get(id);
  if (!tab) return;
  const wc = tab.view.webContents;
  const nav = wc.navigationHistory;
  switch (action) {
    case 'back':
      if (nav && nav.canGoBack()) nav.goBack();
      break;
    case 'forward':
      if (nav && nav.canGoForward()) nav.goForward();
      break;
    case 'reload':
      wc.reload();
      break;
    case 'stop':
      wc.stop();
      break;
    case 'home':
      wc.loadURL(HOME_URL).catch(() => {});
      break;
    case 'devtools':
      wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'bottom' });
      break;
    case 'zoom-in':
      wc.setZoomLevel(Math.min(5, wc.getZoomLevel() + 0.5));
      break;
    case 'zoom-out':
      wc.setZoomLevel(Math.max(-5, wc.getZoomLevel() - 0.5));
      break;
    case 'zoom-reset':
      wc.setZoomLevel(0);
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/*                        右键菜单 / 快捷键                                    */
/* -------------------------------------------------------------------------- */

function openContextMenu(tab, params) {
  const wc = tab.view.webContents;
  const nav = wc.navigationHistory;
  const items = [];

  if (params.linkURL) {
    items.push(
      { label: '在新标签页中打开链接', click: () => createTab(params.linkURL) },
      { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  if (params.isEditable) {
    items.push(
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
      { type: 'separator' },
    );
  } else if (params.selectionText) {
    items.push(
      { role: 'copy', label: '复制' },
      { label: '搜索所选内容', click: () => createTab(SEARCH_URL + encodeURIComponent(params.selectionText)) },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'image' || params.mediaType === 'video') {
    items.push(
      { label: '在新标签页中打开媒体', click: () => createTab(params.srcURL) },
      { label: '图片另存为…', click: () => wc.downloadURL(params.srcURL) },
      { type: 'separator' },
    );
  }

  items.push(
    { label: '后退', enabled: !!(nav && nav.canGoBack()), click: () => navAction(tab.id, 'back') },
    { label: '前进', enabled: !!(nav && nav.canGoForward()), click: () => navAction(tab.id, 'forward') },
    { label: '刷新', click: () => navAction(tab.id, 'reload') },
    { type: 'separator' },
    { label: '复制页面地址', click: () => clipboard.writeText(wc.getURL()) },
    { label: '用系统浏览器打开', click: () => shell.openExternal(wc.getURL()).catch(() => {}) },
    { type: 'separator' },
    { label: '检查元素', click: () => navAction(tab.id, 'devtools') },
  );

  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

/** 地址栏（外壳 UI）右键菜单 */
function openChromeContextMenu(params) {
  if (!params.isEditable) return;
  Menu.buildFromTemplate([
    { role: 'undo', label: '撤销' },
    { role: 'redo', label: '重做' },
    { type: 'separator' },
    { role: 'cut', label: '剪切' },
    { role: 'copy', label: '复制' },
    { role: 'paste', label: '粘贴' },
    {
      label: '粘贴并访问',
      click: () => {
        const text = clipboard.readText().trim();
        if (text && activeTabId != null) navigateTab(activeTabId, text);
      },
    },
    { type: 'separator' },
    { role: 'selectAll', label: '全选' },
  ]).popup({ window: mainWindow });
}

/** 浏览器级快捷键（挂在每个 webContents 上，页面内同样生效） */
function attachShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    const shift = input.shift;
    let handled = true;

    if (ctrl && key === 't') createTab(NEW_TAB_URL);
    else if (ctrl && !shift && key === 'w') {
      if (activeTabId != null) closeTab(activeTabId);
    } else if (ctrl && !shift && key === 'l') send('ui:focus-address');
    else if (ctrl && !shift && key === 'r') navAction(activeTabId, 'reload');
    else if (key === 'f5') navAction(activeTabId, 'reload');
    else if (ctrl && key === 'tab') cycleTab(shift ? -1 : 1);
    else if (ctrl && /^[1-9]$/.test(key)) {
      const ids = [...tabs.keys()];
      const index = key === '9' ? ids.length - 1 : Number(key) - 1;
      if (ids[index] != null) activateTab(ids[index]);
    } else if (ctrl && (key === '+' || key === '=')) navAction(activeTabId, 'zoom-in');
    else if (ctrl && key === '-') navAction(activeTabId, 'zoom-out');
    else if (ctrl && key === '0') navAction(activeTabId, 'zoom-reset');
    else if (input.alt && key === 'arrowleft') navAction(activeTabId, 'back');
    else if (input.alt && key === 'arrowright') navAction(activeTabId, 'forward');
    else if (key === 'f12' || (ctrl && shift && key === 'i')) navAction(activeTabId, 'devtools');
    else if (key === 'escape') navAction(activeTabId, 'stop');
    else handled = false;

    if (handled) event.preventDefault();
  });
}

/* -------------------------------------------------------------------------- */
/*                              窗口创建                                       */
/* -------------------------------------------------------------------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 640,
    minHeight: 420,
    // 直接显示，不等 ready-to-show：窗口第一时间出来，深色底与启动页无缝衔接
    show: true,
    frame: false,
    backgroundColor: WINDOW_BG,
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 先建 DeepSeek 标签，再加载外壳 UI：两者并行，窗口一出来页面基本已就绪
  createTab(HOME_URL);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('resize', layout);
  mainWindow.on('maximize', () => {
    layout();
    send('window:state', { maximized: true });
  });
  mainWindow.on('unmaximize', () => {
    layout();
    send('window:state', { maximized: false });
  });
  mainWindow.on('closed', () => {
    for (const tab of tabs.values()) {
      try {
        tab.view.webContents.close();
      } catch {
        /* ignore */
      }
    }
    tabs.clear();
    activeTabId = null;
    mainWindow = null;
  });

  attachShortcuts(mainWindow.webContents);
  mainWindow.webContents.on('context-menu', (_e, params) => openChromeContextMenu(params));
}

/* -------------------------------------------------------------------------- */
/*                              IPC 接口                                       */
/* -------------------------------------------------------------------------- */

function registerIpc() {
  // 不传地址 = 新建标签页（本地起始页），便于识别与关闭
  ipcMain.handle('tabs:create', (_e, url) => createTab(url || NEW_TAB_URL));
  ipcMain.on('tabs:close', (_e, id) => closeTab(id));
  ipcMain.on('tabs:activate', (_e, id) => activateTab(id));
  ipcMain.on('tabs:navigate', (_e, { id, url }) => navigateTab(id, url));
  ipcMain.on('tabs:action', (_e, { id, action }) => navAction(id == null ? activeTabId : id, action));
  ipcMain.on('ui:chrome-height', (_e, height) => {
    const value = Math.round(Number(height) || DEFAULT_CHROME_HEIGHT);
    if (value !== chromeHeight) {
      chromeHeight = value;
      layout();
    }
  });

  ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow && mainWindow.close());

  ipcMain.on('app:open-external', (_e, url) => {
    if (url) shell.openExternal(url).catch(() => {});
  });
}

/* -------------------------------------------------------------------------- */
/*                              应用启动                                       */
/* -------------------------------------------------------------------------- */

// 去掉 UA 中的 Electron / 应用标识，让站点按标准 Chrome 处理
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/[\d.]+/, '')
  .replace(new RegExp(`\\s${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[\\d.]+`), '');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // 全深色主题：外壳自绘深色，同时让网页 prefers-color-scheme 也走深色
    nativeTheme.themeSource = 'dark';

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    session.defaultSession.setSpellCheckerEnabled(false);

    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
