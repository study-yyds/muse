import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./api";

describe("api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- GET ----
  describe("get", () => {
    it("应发送 GET 请求并返回 JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ data: "ok" }), { status: 200 })
      );

      const result = await api.get("/test");
      expect(result).toEqual({ data: "ok" });
      const [url] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/test");
    });

    it("有 token 时应带 Authorization 头", async () => {
      localStorage.setItem("token", "my-token");
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );

      await api.get("/test");
      expect(fetch).toHaveBeenCalledWith(
        "/api/test",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer my-token" }) as HeadersInit,
        })
      );
    });
  });

  // ---- POST ----
  describe("post", () => {
    it("应发送 POST 请求带 JSON body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ data: "created" }), { status: 201 })
      );

      const result = await api.post("/test", { name: "foo" });
      expect(result).toEqual({ data: "created" });
      expect(fetch).toHaveBeenCalledWith(
        "/api/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "foo" }),
        })
      );
    });
  });

  // ---- 错误处理 ----
  describe("错误响应", () => {
    it("非 2xx 应抛出 ApiError", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
      );

      await expect(api.get("/missing")).rejects.toMatchObject({
        status: 404,
        message: "Not Found",
      });
    });

    it("响应不是 JSON 时用 statusText 兜底", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("plain text error", { status: 500, statusText: "Internal Server Error" })
      );

      await expect(api.get("/error")).rejects.toMatchObject({
        status: 500,
        message: "Internal Server Error",
      });
    });
  });

  // ---- 其他方法 ----
  describe("其他 HTTP 方法", () => {
    it("put", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
      await api.put("/test", { x: 1 });
      expect(fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({ method: "PUT" }));
    });

    it("patch", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
      await api.patch("/test", { x: 1 });
      expect(fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({ method: "PATCH" }));
    });

    it("delete", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
      await api.delete("/test");
      expect(fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({ method: "DELETE" }));
    });
  });
});
