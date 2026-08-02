import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("合并类名字符串", () => {
    expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
  });

  it("过滤假值", () => {
    expect(cn("text-sm", false, undefined, null, "font-bold")).toBe("text-sm font-bold");
  });

  it("合并 object 形式", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("tailwind 冲突合并（twMerge）", () => {
    expect(cn("px-4", "px-2")).toBe("px-2");
  });

  it("无参数返回空字符串", () => {
    expect(cn()).toBe("");
  });
});
