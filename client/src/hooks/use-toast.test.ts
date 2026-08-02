import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAdd, mockClose } = vi.hoisted(() => ({
  mockAdd: vi.fn(() => "toast-id-1"),
  mockClose: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    add: mockAdd,
    close: mockClose,
    update: vi.fn(),
  },
}));

import { useToast } from "./use-toast";

describe("useToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("默认 variant 调用 toast.add type=success", () => {
    const { toast } = useToast();
    toast({ title: "成功" });

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "成功", type: "success", timeout: 3000 })
    );
  });

  it("variant=destructive 调用 toast.add type=error", () => {
    const { toast } = useToast();
    toast({ title: "失败", description: "出错了", variant: "destructive" });

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "失败", description: "出错了", type: "error" })
    );
  });

  it("dismiss 调用 toast.close", () => {
    const { dismiss } = useToast();
    dismiss("some-id");
    expect(mockClose).toHaveBeenCalledWith("some-id");
  });

  it("dismiss 无参数调用 toast.close()", () => {
    const { dismiss } = useToast();
    dismiss();
    expect(mockClose).toHaveBeenCalledWith(undefined);
  });
});
