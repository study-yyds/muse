const BASE_URL = "/api";
const TIMEOUT_MS = 15000;

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem("token");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });

    // 登录态过期 → 清除 token 并跳转登录页
    if (res.status === 401) {
      // 同时清除裸 token 与 zustand persist 的登录态，
      // 否则跳转登录页后 isAuthenticated 仍为 true，会被 AppLayout 放行造成死循环
      localStorage.removeItem("token");
      localStorage.removeItem("muse-auth");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
      throw new ApiError(res.status, "登录已过期，请重新登录");
    }

    // 尝试解析 JSON body
    const body = await res.json().catch(() => null);

    // 检查业务状态码（服务端 HTTP 200/201 但 code 非 2xx 表示业务错误）
    if (body && typeof body.code === "number" && body.code >= 400) {
      throw new ApiError(body.code, body.message ?? "请求失败");
    }

    if (!res.ok) {
      throw new ApiError(
        res.status,
        body?.message ?? res.statusText ?? "请求失败",
      );
    }

    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 统一带鉴权的 fetch：注入 Authorization 头，401 时清理登录态并跳登录页。
 * 用于 SSE 流、文件下载等无法走 api.* 的请求（path 为完整路径，如 "/api/ai/chat"）。
 * 默认 5 分钟超时（SSE 长生成场景），调用方传入 signal 时与其组合；
 * 三轮正文生成需要 10-30 分钟，调用方传更大的 timeoutMs（传 null 则不设超时）
 */
const AUTH_FETCH_TIMEOUT_MS = 5 * 60_000;

export async function authFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs: number | null = AUTH_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const token = localStorage.getItem("token");
  const timeoutSignal =
    timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
  const signal = timeoutSignal
    ? init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal
    : init.signal;
  const res = await fetch(path, {
    ...init,
    signal,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    // 同时清除裸 token 与 zustand persist 的登录态，避免跳转后残留假登录
    localStorage.removeItem("token");
    localStorage.removeItem("muse-auth");
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
  }
  return res;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
