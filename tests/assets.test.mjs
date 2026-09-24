/* ============================================================
 * 静态资源清单守卫:Service Worker 的 ASSETS 必须与 public/ 实际文件对得上
 *
 * 为什么需要:SW 安装时会按清单预缓存,清单漏登记一个模块不会报任何错 ——
 * 联网时它退化成普通请求照样能拉到(network-first 下更是如此),
 * 只有**离线**时才暴露(表现为那个模块加载失败甚至整个应用白屏)。
 * 这类错靠人眼发现不了,而「新增模块」是每次加功能都会做的事。
 *
 * 版本号说明(2026-09-25 起):fetch 已全量 network-first,普通刷新即拿新版,
 * **不再需要「改完资源升 CACHE 版本号」**;版本号只在清理历史旧缓存时才动。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

/** 抠出 ASSETS 数组里的字符串字面量 */
function assetsFromSw() {
  const block = /const ASSETS = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(block, 'sw.js 里应当有 const ASSETS = [...]');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const ASSETS = assetsFromSw();
/** './js/ui.js' → 'public/js/ui.js' */
const toPath = (a) => join(PUBLIC, a.replace(/^\.\//, ''));

test('SW 清单:每个条目都真实存在(漏登记 / 写错名都会让离线白屏)', () => {
  for (const a of ASSETS) {
    if (a === './') continue; // 目录本身,对应 index.html
    assert.ok(existsSync(toPath(a)), `ASSETS 里的 ${a} 在 public/ 下不存在`);
  }
});

test('SW 清单:public/js 下的每个模块都必须登记(新加模块最容易漏)', () => {
  const onDisk = readdirSync(join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));
  assert.ok(onDisk.length > 0, 'public/js 下应当有模块');
  const listed = new Set(ASSETS.map((a) => a.replace(/^\.\/js\//, '')));
  const missing = onDisk.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `这些模块没登记进 sw.js 的 ASSETS:${missing.join(', ')}`);
});

test('SW 清单:css 与入口页也在(否则离线连样式和外壳都没有)', () => {
  for (const need of ['./', './index.html', './css/style.css']) {
    assert.ok(ASSETS.includes(need), `ASSETS 缺少 ${need}`);
  }
});

test('SW 护栏:/api/* 仍然永不经缓存(锁屏形同虚设的唯一防线)', () => {
  assert.match(sw, /startsWith\('\/api\/'\)/, '必须保留 /api/* 的显式拒绝');
});

test('CACHE 版本号形如 jmbiji-vN(network-first 后仅为清理旧缓存而存在)', () => {
  const m = /const CACHE = '([^']+)'/.exec(sw);
  assert.ok(m, 'sw.js 里应当有 const CACHE');
  assert.match(m[1], /^jmbiji-v\d+$/, `CACHE 版本号格式异常:${m[1]}`);
});
