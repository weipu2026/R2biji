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
    /* 值存在 dataset 上:syncSeg 靠它把「当前项」刷对 —— 只记「是否相等」
     * 的话,事后无法从 DOM 反查某一项代表哪个值。 */
    b.dataset.value = String(o.value);
    b.setAttribute('aria-pressed', String(String(o.value) === String(current)));
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.setAttribute('aria-pressed', String(x === b));
      onPick(o.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

/** 把分段按钮组的当前项刷成 current(用于「面板开着时状态被别处改了」)。 */
function syncSeg(wrap, current) {
  for (const b of wrap.children) {
    b.setAttribute('aria-pressed', String(b.dataset.value === String(current)));
  }
}

/** 打开设置面板。ctx 需要:modal / store / saveSettings(patch) /
 *  setThemeMode / themeMode / reading{load,set} / mono{get,set}。 */
export async function openSettings(ctx) {
  /* 主题行的回显要跟着顶栏那枚二态按钮走:设置是 modal(<dialog> showModal
   * 进 top layer),面板盖住界面,但键盘 Tab 仍可能触达顶栏按钮;而且
   * 用户完全可能先开面板、发现太亮、直接去点顶栏那枚月亮/太阳。
   * 若只在 build 时读一次,回来会看到「深色」仍高亮、事实却是浅色 ——
   * 显示说谎比不显示更糟。用 MutationObserver 盯 data-theme
   * (applyTheme 是唯一写入点),面板关闭时断开。 */
  let themeObserver = null;
  try {
    await ctx.modal({
      type: 'custom',
      title: '设置',
      text: '偏好只存在本浏览器(localStorage),不参与加密、不随笔记库同步。',
      build: (body) => {
        /* ── 外观 ── */
        group(body, '外观');
        const themeSeg = seg(ctx.themeMode(), [
          { value: 'system', label: '跟随系统' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ], (v) => ctx.setThemeMode(v));
        row(body, '主题', themeSeg);
        if (typeof MutationObserver === 'function') {
          themeObserver = new MutationObserver(() => syncSeg(themeSeg, ctx.themeMode()));
          themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        }

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
          { value: 'narrow', label: '窄' },
          { value: 'center', label: '标准' },
          { value: 'broad', label: '宽' },
          { value: 'wider', label: '更宽' },
          { value: 'wide', label: '全宽' },
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
  } finally {
    /* 面板关闭即断开。放在 finally 而不是 await 之后的普通语句:modal 抛异常
     * 时也必须断开,否则观察者留在 documentElement 上、每次切主题白跑一次,
     * 下次开面板还会再挂一个(泄漏累积)。 */
    if (themeObserver) themeObserver.disconnect();
  }
}
