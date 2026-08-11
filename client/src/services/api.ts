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
      localStorage.removeItem("token");
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
