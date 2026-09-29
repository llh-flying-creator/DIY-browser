'use strict';

/** 新标签页：搜索框直接在本标签内跳转（无需与主进程通信） */

const SEARCH_URL = 'https://www.bing.com/search?q=';

const form = document.getElementById('search');
const input = document.getElementById('q');

/** 输入看起来像域名/网址就直接访问，否则走搜索 */
function toUrl(text) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[^\s/?#]+\.[^\s/?#]{2,}([:/?#].*)?$/.test(text)) return `https://${text}`;
  return SEARCH_URL + encodeURIComponent(text);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  location.href = toUrl(value);
});

// 打开新标签页即聚焦输入框
input.focus({ preventScroll: true });
