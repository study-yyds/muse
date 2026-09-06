import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAuthStore } from "./auth";

// 模拟 api 模块
vi.mock("../services/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from "../services/api";

function seedStore(token: string | null, user: { user_id: string } | null) {
  useAuthStore.setState({
    token,
    user: user
      ? { user_id: user.user_id, phone_number: "138", avatar_path: null, role: "user" }
      : null,
    isAuthenticated: !!token,
  });
}

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, user: null, isAuthenticated: false });
    localStorage.clear();
    vi.clearAllMocks();
  });

  // ---- login ----
  describe("login", () => {
    it("成功登录应设置 token 并拉取用户信息", async () => {
      vi.mocked(api.post).mockResolvedValueOnce({
        data: { access_token: "jwt-123", user_id: "u1" },
      });
      vi.mocked(api.get).mockResolvedValueOnce({
        data: { user_id: "u1", phone_number: "138", avatar_path: null },
      });

      await useAuthStore.getState().login("13800138000", "1234");

      const state = useAuthStore.getState();
      expect(state.token).toBe("jwt-123");
      expect(state.isAuthenticated).toBe(true);
      expect(state.user?.user_id).toBe("u1");
      expect(localStorage.getItem("token")).toBe("jwt-123");
    });

    it("登录失败不应改变状态", async () => {
      vi.mocked(api.post).mockRejectedValueOnce(new Error("401"));
      seedStore(null, null);

      await expect(
        useAuthStore.getState().login("138", "bad")
      ).rejects.toThrow();

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  // ---- logout ----
  describe("logout", () => {
    it("应清除 token、user、isAuthenticated", () => {
      seedStore("jwt-abc", { user_id: "u1" });

      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.token).toBeNull();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(localStorage.getItem("token")).toBeNull();
    });
  });

  // ---- fetchProfile ----
  describe("fetchProfile", () => {
    it("成功应设置 user", async () => {
      seedStore("jwt-abc", null);
      vi.mocked(api.get).mockResolvedValueOnce({
        data: { user_id: "u2", phone_number: "139", avatar_path: null },
      });

      await useAuthStore.getState().fetchProfile();
      expect(useAuthStore.getState().user?.user_id).toBe("u2");
    });

    it("失败应保留登录态", async () => {
      seedStore("bad-token", { user_id: "u1" });
      vi.mocked(api.get).mockRejectedValueOnce(new Error("网络错误"));

      await useAuthStore.getState().fetchProfile();

      // 后端不可用时不登出
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).not.toBeNull();
    });
  });
});
