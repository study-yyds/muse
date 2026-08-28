import { QueryClient } from "@tanstack/react-query";

/** 全局 QueryClient：独立模块导出，供 App 与 auth store（登录/登出清缓存）共用 */
export const queryClient = new QueryClient({
  defaultOptions: {
    // retry 1：后端重启/冷启动时首请求常失败，不重试会永久停在失败态
    queries: { staleTime: 5 * 60_000, gcTime: 10 * 60_000, retry: 1 },
  },
});
