/* ============================================================
 * feature: 集中设置面板(侧栏那枚齿轮 / 滑杆图标)
 * ------------------------------------------------------------
 * 2026-10-24 全站审计 A2:设置项此前散落三处 —— 顶栏(主题)、
 * 侧栏底(自动锁屏)、编辑态(等宽),没有任何集中入口,新用户永远
 * 发现不了。本模块把它们收进一个面板:
 *   外观  主题:跟随系统 / 浅色 / 深色(三态;顶栏按钮仍是二态快切)
 *   阅读  字号 / 行距 / 宽度(委托 reading.js 的 CSS 变量)
 *   编辑  等宽字体(与编辑态那枚按钮同一份偏好,双向同步)
 *   安全  自动锁屏:关闭 / 5 / 15 / 30 分钟(store.settings)
 * 面板本身不持有任何状态,只做「读当前值 → 改 → 写回」:
 * 主题在 theme.js、排版权在 reading.js、等宽在 shell.js 的 mono、
 * 自动锁屏在 store.settings —— 各处的单一来源都不动。
 * ============================================================ */

/** 一行设置:标签在左,控件在右(两端对齐,扫读时标签成列)。 */
function row(parent, label, control) {
  const r = document.createElement('div');
  r.className = 'set-row';
  const l = document.createElement('div');
  l.className = 'set-label';
  l.textContent = label;
  r.append(l, control);
  parent.appendChild(r);
}

/** 分组标题(与快捷键面板的 keyhelp-group 同一视觉语言)。 */
function group(parent, name) {
  const h = document.createElement('div');
  h.className = 'keyhelp-group';
  h.textContent = name;
  parent.appendChild(h);
}

/** 分段按钮组:二态以上的选择用它,不用 <select> ——
 *  手机上原生 select 会弹系统选择器,看不到当前值与其他选项的关系;
 *  分段按钮一屏尽收,当前项用 aria-pressed 标注(读屏器可播报)。
 *  点完立刻回调,偏好即时生效(不需要「保存」按钮)。 */
function seg(current, options, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'set-seg';
  wrap.setAttribute('role', 'group');
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'set-seg-btn';
    b.textContent = o.label;
    b.setAttribute('aria-pressed', String(String(o.value) === String(current)));
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.setAttribute('aria-pressed', String(x === b));
      onPick(o.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

/** 打开设置面板。ctx 需要:modal / store / saveSettings(patch) /
 *  setThemeMode / themeMode / reading{load,set} / mono{get,set}。 */
export async function openSettings(ctx) {
  await ctx.modal({
    type: 'custom',
    title: '设置',
    text: '偏好只存在本浏览器(localStorage),不参与加密、不随笔记库同步。',
    build: (body) => {
      /* ── 外观 ── */
      group(body, '外观');
      row(body, '主题', seg(ctx.themeMode(), [
        { value: 'system', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
      ], (v) => ctx.setThemeMode(v)));

      /* ── 阅读(字号 / 行距 / 宽度 → reading.js 的三个 CSS 变量) ── */
      group(body, '阅读');
      const read = ctx.reading.load();
      row(body, '字号', seg(read.size, [
        { value: 's', label: '小' },
        { value: 'm', label: '中' },
        { value: 'l', label: '大' },
      ], (v) => ctx.reading.set({ size: v })));
      row(body, '行距', seg(read.lh, [
        { value: 'tight', label: '紧凑' },
        { value: 'std', label: '标准' },
        { value: 'loose', label: '宽松' },
      ], (v) => ctx.reading.set({ lh: v })));
      row(body, '宽度', seg(read.measure, [
        { value: 'wide', label: '全宽' },
        { value: 'center', label: '居中' },
      ], (v) => ctx.reading.set({ measure: v })));

      /* ── 编辑(等宽:与编辑态那枚按钮同一份 localStorage 偏好) ── */
      group(body, '编辑');
      row(body, '等宽字体', seg(ctx.mono.get() ? '1' : '0', [
        { value: '0', label: '关' },
        { value: '1', label: '开' },
      ], (v) => ctx.mono.set(v === '1')));

      /* ── 安全(自动锁屏:store.settings 的单一来源,面板只写不改语义) ── */
      group(body, '安全');
      const min = ctx.store.get('settings').autoLockMinutes;
      row(body, '自动锁屏', seg(String(min), [
        { value: '0', label: '关闭' },
        { value: '5', label: '5 分钟' },
        { value: '15', label: '15 分钟' },
        { value: '30', label: '30 分钟' },
      ], (v) => ctx.saveSettings({ autoLockMinutes: Number(v) || 0 })));
    },
  });
}
