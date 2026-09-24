/* JMbiji 入口 */
import { start } from './ui.js';

start();

/* PWA:注册 Service Worker(file:// 下不可用,静默跳过) */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // SW 更新采用 skipWaiting + clients.claim:新 SW 立即接管。若页面此前已被
    // 旧 SW 控制,接管瞬间会出现「旧外壳 + 新 JS」的混合态 → 刷新一次对齐。
    // 首次安装的 claim 也会触发本事件,但那之前页面未被控制(controller 为空),
    // 没有混合态可言,不刷,免得首次访问多一次无意义重载。
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing || !hadController) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
