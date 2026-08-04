const BASE_URL = "/api";
const TIMEOUT_MS = 3000;

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
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem("token");
      // 避免在登录页本身触发无限跳转
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
      throw new ApiError(res.status, "登录已过期，请重新登录");
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new ApiError(res.status, error.message ?? "请求失败");
    }

    return res.json();
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
