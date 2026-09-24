/* JMbiji 入口 */
import { start } from './ui.js';

start();

/* PWA:注册 Service Worker(file:// 下不可用,静默跳过) */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
