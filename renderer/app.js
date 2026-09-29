'use strict';

/**
 * 浏览器外壳 UI 逻辑：标签栏、工具栏、地址栏、窗口控制。
 * 通过 preload 暴露的 window.browser 与主进程通信。
 */

const api = window.browser;
const $ = (sel) => document.querySelector(sel);

const el = {
  chrome: $('#chrome'),
  tabs: $('#tabs'),
  address: $('#address'),
  addressForm: $('#address-form'),
  scheme: $('#scheme-icon'),
  back: $('#btn-back'),
  forward: $('#btn-forward'),
  reload: $('#btn-reload'),
  home: $('#btn-home'),
  external: $('#btn-external'),
  newTab: $('#new-tab'),
  winMin: $('#win-min'),
  winMax: $('#win-max'),
  winClose: $('#win-close'),
};

/** 当前 UI 状态（由主进程推送） */
let state = { activeId: null, tabs: [] };

/* -------------------------------------------------------------------------- */
/*                                 渲染                                       */
/* -------------------------------------------------------------------------- */

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

/** 新标签页不暴露本地文件路径，地址栏留空（与主流浏览器一致） */
function displayUrl(url) {
  if (!url) return '';
  return /newtab\.html(\?.*)?$/i.test(url) ? '' : url;
}

function render() {
  renderTabs();
  renderToolbar();
}

function createTabNode(tab) {
  const node = document.createElement('div');
  node.className = 'tab';
  node.dataset.id = String(tab.id);

  const icon = document.createElement('span');
  icon.className = 'tab-icon';
  icon.innerHTML = '<svg class="icon globe"><use href="#i-globe"/></svg>';

  const title = document.createElement('span');
  title.className = 'tab-title';

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.title = '关闭标签页 (Ctrl+W)';
  close.innerHTML = '<svg class="icon"><use href="#i-close"/></svg>';

  node.append(icon, title, close);

  node.addEventListener('mousedown', (event) => {
    if (event.button === 0) api.activateTab(tab.id);
    if (event.button === 1) {
      event.preventDefault();
      api.closeTab(tab.id);
    }
  });
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    api.closeTab(tab.id);
  });

  return node;
}

function renderTabs() {
  const existing = new Map([...el.tabs.children].map((node) => [Number(node.dataset.id), node]));
  const fragment = document.createDocumentFragment();

  for (const tab of state.tabs) {
    const node = existing.get(tab.id) || createTabNode(tab);
    existing.delete(tab.id);

    node.classList.toggle('active', tab.id === state.activeId);
    node.querySelector('.tab-title').textContent = tab.title || '新标签页';
    node.title = tab.title && tab.url ? `${tab.title}\n${tab.url}` : '新标签页';

    const icon = node.querySelector('.tab-icon');
    icon.classList.toggle('loading', !!tab.loading);
    if (tab.loading || !tab.favicon) {
      icon.classList.remove('has-favicon');
      icon.style.backgroundImage = '';
    } else {
      icon.classList.add('has-favicon');
      icon.style.backgroundImage = `url("${tab.favicon}")`;
    }

    fragment.appendChild(node);
  }

  for (const node of existing.values()) node.remove();
  el.tabs.appendChild(fragment);
}

function renderToolbar() {
  const tab = activeTab();

  el.back.disabled = !tab || !tab.canGoBack;
  el.forward.disabled = !tab || !tab.canGoForward;
  el.reload.disabled = !tab;
  el.home.disabled = !tab;
  el.external.disabled = !tab;

  el.reload.title = tab && tab.loading ? '停止加载 (Esc)' : '刷新 (Ctrl+R)';
  el.reload.innerHTML = tab && tab.loading
    ? '<svg class="icon"><use href="#i-stop"/></svg>'
    : '<svg class="icon"><use href="#i-reload"/></svg>';

  // 地址栏：仅在用户未编辑时同步
  if (document.activeElement !== el.address) {
    el.address.value = tab ? displayUrl(tab.url) : '';
  }
  const transfering = !!tab && tab.loading;
  const secure = !!tab && /^https:/i.test(tab.url || '');
  el.scheme.classList.toggle('secure', secure && !transfering);
  el.scheme.innerHTML = transfering
    ? '<span class="spinner"></span>'
    : secure
      ? '<svg class="icon"><use href="#i-lock"/></svg>'
      : '<svg class="icon"><use href="#i-globe"/></svg>';
}

/* -------------------------------------------------------------------------- */
/*                              交互绑定                                      */
/* -------------------------------------------------------------------------- */

function activeId() {
  return state.activeId;
}

el.back.addEventListener('click', () => api.action('back', activeId()));
el.forward.addEventListener('click', () => api.action('forward', activeId()));
el.reload.addEventListener('click', () => {
  const tab = activeTab();
  api.action(tab && tab.loading ? 'stop' : 'reload', activeId());
});
el.home.addEventListener('click', () => api.action('home', activeId()));
el.newTab.addEventListener('click', () => api.createTab());
el.external.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.url) api.openExternal(tab.url);
});

el.addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = el.address.value.trim();
  if (!value || activeId() == null) return;
  api.navigate(activeId(), value);
  el.address.blur();
});

el.address.addEventListener('focus', () => el.address.select());

// 地址栏失焦后立刻回填真实地址
el.address.addEventListener('blur', () => {
  const tab = activeTab();
  el.address.value = tab ? displayUrl(tab.url) : '';
});

el.winMin.addEventListener('click', () => api.minimize());
el.winMax.addEventListener('click', () => api.toggleMaximize());
el.winClose.addEventListener('click', () => api.closeWindow());

// 中键点击工具栏按钮不做默认行为
document.addEventListener('auxclick', (event) => {
  if (event.button === 1) event.preventDefault();
});

/* -------------------------------------------------------------------------- */
/*                              主进程事件                                    */
/* -------------------------------------------------------------------------- */

api.onTabsChanged((data) => {
  state = data || { activeId: null, tabs: [] };
  render();
});

api.onWindowState(({ maximized }) => {
  el.winMax.innerHTML = maximized
    ? '<svg class="icon"><use href="#i-restore"/></svg>'
    : '<svg class="icon"><use href="#i-max"/></svg>';
  el.winMax.title = maximized ? '还原' : '最大化';
});

api.onFocusAddress(() => {
  el.address.focus();
  el.address.select();
});

/* -------------------------------------------------------------------------- */
/*                    把外壳真实高度上报给主进程（视图定位）                     */
/* -------------------------------------------------------------------------- */

function reportChromeHeight() {
  api.reportChromeHeight(el.chrome.getBoundingClientRect().height);
}

new ResizeObserver(reportChromeHeight).observe(el.chrome);
window.addEventListener('DOMContentLoaded', reportChromeHeight);
window.addEventListener('resize', reportChromeHeight);
reportChromeHeight();

// 首帧渲染前先给出一次默认值，避免视图出现跳动
render();
