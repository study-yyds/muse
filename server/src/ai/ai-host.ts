// 拆出的 ops 层对 AiService 主机的最小依赖面。
// 跨簇调用统一走 host 上的包装方法；AiService 结构上满足该接口
// （resolveApiKey/recordUsage 因此从 private 改为 public）。
export interface AiHost {
  resolveApiKey(
    userId: string | undefined,
    usage: 'chat' | 'image',
    modelHint?: string,
    keyId?: string,
  ): Promise<{
    apiKey: string;
    baseUrl: string;
    model: string;
    source: 'user' | 'platform';
  }>;
  recordUsage(params: {
    userId?: string;
    bookId?: string;
    model: string;
    inChars: number;
    outChars: number;
    usageType: 'platform_key' | 'user_key';
  }): Promise<void>;
  checkBookOwnership(bookId: string, userId: string): Promise<void>;
  extendChapterOutlines(
    userId: string,
    bookId: string,
    model?: string,
    keyId?: string,
    count?: number,
    nodeId?: string,
  ): Promise<{ lines: string[]; startNo: number }>;
  parseAndSaveOutline(bookId: string, aiText: string): Promise<any>;
}
