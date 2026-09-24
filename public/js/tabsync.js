/* ============================================================
 * JMbiji 多标签页同步 —— 同一个浏览器里打开的多个标签页互相通知
 *
 * 解决什么:同一个库在两个标签页里打开,A 保存之后 B 手里就是**旧数据**了。
 * B 再保存时会撞 CAS 412、弹冲突三选一,而「用我的版本覆盖」会把 A 刚改的
 * 其他笔记一并盖回去(云端有备份、能恢复,但很费解)。这类冲突本不该发生 ——
 * B 只要在 A 保存的那一刻知道「云端变了」,重新拉一次就够了。
 *
 * 为什么走这条路,而不是「笔记级三方合并」:合并是为「两台设备各改各的」准备的,
 * 而单人多设备的实际用法里几乎不出现(手机基本只读);同一台电脑开两个标签页
 * 却相当常见。前者要在 412 之后靠 base 快照逐条比对(工程量大、合并语义要打磨),
 * 后者从源头让冲突不发生,且**没有任何静默覆盖的余地**。
 *
 * ★ 设计原则:tab 消息只当作「去重新核对一次」的提示,**绝不当权威状态**。
 *   · 收到 cats-changed → rescan()(重新问服务器),而不是照着消息改内存
 *   · 收到 cat-saved 且本地正在编辑该分类 → 只警告,绝不自动刷新(不能丢未保存改动)
 *   于是即便某条消息是错的(或来自同源的恶意页面),最坏也只是多拉一次数据。
 *
 * 纯模块(不依赖 DOM),Node 单测可覆盖;环境不支持 BroadcastChannel 时静默降级
 * —— 同步是锦上添花,缺了它其余功能必须照常工作。
 * ============================================================ */

export const TAB_CHANNEL = 'jmbiji-tabs';

const KNOWN_TYPES = new Set(['cat-saved', 'cats-changed', 'locked']);

/**
 * 校验来源消息。不认识的、结构不对的一律返回 null(忽略),不抛错。
 * @returns {{type:string, name?:string}|null}
 */
export function parseTabMessage(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;
  if (!KNOWN_TYPES.has(raw.type)) return null;
  if (raw.type === 'cat-saved') {
    return (typeof raw.name === 'string' && raw.name) ? { type: 'cat-saved', name: raw.name } : null;
  }
  return { type: raw.type };
}

/**
 * 收到「某分类在别的标签页被保存」时该做什么 —— 纯函数,便于离线钉住。
 * @returns {'ignore'|'warn-dirty'|'reload'}
 *   ignore     : 本机没有这个分类,不关我事
 *   warn-dirty : 本地有未保存改动 → **绝不自动刷新**(会丢改动),只提示保存时会冲突
 *   reload     : 本地干净 → 丢弃缓存,重读云端
 */
export function planSavedCategoryAction({ isKnown, isDirty }) {
  if (!isKnown) return 'ignore';
  return isDirty ? 'warn-dirty' : 'reload';
}

/**
 * 标签页间通道。BroadcastChannel 不会把消息投递给发送者自己,所以无需去重。
 */
export class TabSync {
  /**
   * @param {{name?:string, onMessage?:(msg:{type:string,name?:string})=>void, Channel?:Function}} [opt]
   *   Channel 可注入,便于离线单测(默认取全局 BroadcastChannel)
   */
  constructor({ name = TAB_CHANNEL, onMessage = () => {}, Channel = globalThis.BroadcastChannel } = {}) {
    this.channel = null;
    if (typeof Channel !== 'function') return; // 环境不支持 → 静默降级为「不同步」
    try {
      this.channel = new Channel(name);
      this.channel.onmessage = (e) => {
        const msg = parseTabMessage(e?.data);
        if (!msg) return;
        try { onMessage(msg); } catch { /* 单条消息处理失败不影响后续 */ }
      };
    } catch {
      this.channel = null; // 构造失败(隐私模式等)同样降级
    }
  }

  /** 同步是否可用(不可用时其余功能照常,只是不跨标签页通知) */
  get enabled() { return this.channel !== null; }

  /** @returns {boolean} 是否真的发出去了 */
  send(msg) {
    if (!this.channel) return false;
    try { this.channel.postMessage(msg); return true; } catch { return false; }
  }

  /** 关掉通道(锁屏时调用;再想用得重新 new 一个) */
  close() {
    try { this.channel?.close(); } catch { /* 忽略 */ }
    this.channel = null;
  }
}