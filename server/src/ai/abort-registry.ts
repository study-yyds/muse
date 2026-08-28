/**
 * 作品级 AI 请求中止注册表
 *
 * 软删除作品时中止该作品所有进行中的 AI 生成（SSE 流、快捷创作等），
 * 停止继续消耗 token——对应 PRD 3.2.2「删除作品时取消进行中的 AI 请求」。
 *
 * 注：内存 Map 适用于单实例部署，多实例需迁移到 Redis/消息总线
 */
const registry = new Map<string, Set<AbortController>>();

export function registerBookAbort(bookId: string, ctrl: AbortController): void {
  if (!bookId) return;
  let set = registry.get(bookId);
  if (!set) {
    set = new Set();
    registry.set(bookId, set);
  }
  set.add(ctrl);
}

export function unregisterBookAbort(
  bookId: string,
  ctrl: AbortController,
): void {
  const set = registry.get(bookId);
  if (!set) return;
  set.delete(ctrl);
  if (set.size === 0) registry.delete(bookId);
}

/** 中止指定作品的全部进行中 AI 请求 */
export function abortBookRequests(bookId: string): void {
  const set = registry.get(bookId);
  if (!set) return;
  for (const ctrl of set) {
    ctrl.abort();
  }
  registry.delete(bookId);
}
