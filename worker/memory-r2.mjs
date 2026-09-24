/* ============================================================
 * 内存版 R2 绑定 —— 复刻真机 R2 语义的子集
 * (Worker 单测与本地 dev-server 共用,单一出处)
 *
 * 覆盖:head/get/put/delete/list + 条件写(onlyIf)。
 * put 条件失败返回 null 且不写入 —— 与真机 R2 一致;
 * ⚠️ 不识别的选项会被静默忽略(与真机一致),所以「用错参数名 →
 * 条件失效 → 无条件写」会直接导致依赖条件写的断言失败,防回归。
 * ============================================================ */

export class MemoryR2 {
  /**
   * @param {{pageSize?: number}} [opt] pageSize 模拟真机单次返回上限(默认 1000),
   *   调小即可在测试里逼出「游标翻页」这条路径,而不必真造 1000 个对象。
   */
  constructor({ pageSize = 1000 } = {}) { this.map = new Map(); this.n = 0; this.pageSize = pageSize; }

  async head(key) {
    const e = this.map.get(key);
    return e ? { key, size: e.bytes.length, uploaded: e.uploaded, etag: e.etag } : null;
  }

  async get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    return {
      key, etag: e.etag, uploaded: e.uploaded, size: e.bytes.length,
      arrayBuffer: async () => e.bytes.slice().buffer,
    };
  }

  async put(key, bytes, opts = {}) {
    const existing = this.map.get(key);
    const cond = opts.onlyIf;
    if (cond) {
      const isHeaders = typeof cond.get === 'function';
      const ifMatch = isHeaders ? cond.get('if-match') : cond.etagMatches;
      const ifNoneMatch = isHeaders ? cond.get('if-none-match') : cond.etagDoesNotMatch;
      if (ifMatch != null) {
        const ok = ifMatch === '*' ? !!existing : !!(existing && existing.etag === ifMatch);
        if (!ok) return null;
      }
      if (ifNoneMatch != null) {
        const ok = ifNoneMatch === '*' ? !existing : (!existing || existing.etag !== ifNoneMatch);
        if (!ok) return null;
      }
    }
    const etag = `etag${++this.n}`;
    const rec = {
      bytes: bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes),
      etag,
      uploaded: new Date(),
    };
    this.map.set(key, rec);
    return { key, etag, uploaded: rec.uploaded };
  }

  async delete(key) { this.map.delete(key); }

  async list({ prefix = '', cursor } = {}) {
    const all = [...this.map.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, e]) => ({ key: k, etag: e.etag, size: e.bytes.length, uploaded: e.uploaded }));
    // 复刻真机:单次最多 pageSize 条,截断时返回 truncated + 游标(这里用下一条
    // 的 key 充当游标;真机是不透明串,调用方本来就只能原样回传)。
    const at = cursor ? all.findIndex((o) => o.key === cursor) : 0;
    const from = at < 0 ? all.length : at;
    const objects = all.slice(from, from + this.pageSize);
    const truncated = from + objects.length < all.length;
    return { objects, truncated, cursor: truncated ? all[from + objects.length].key : undefined };
  }

  /** 测试辅助:某分类的备份数量 */
  backupCount(base) {
    return [...this.map.keys()].filter((k) => k.startsWith(`backup/${base}/`)).length;
  }
}
