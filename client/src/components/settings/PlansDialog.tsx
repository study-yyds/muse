import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { PLANS } from "@/lib/plans";

const STATUS_LABELS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  cancelled: "已取消",
};

interface OrderRow {
  id: string;
  plan_id: string;
  amount: string;
  status: string;
  created_at: string;
  paid_at?: string | null;
  expires_at?: string | null;
}

/**
 * 套餐选择 + 模拟收银台弹窗。
 * 流程：选套餐 → 创建订单 → 模拟支付 → 服务端应用额度。
 * 真实支付接入后，仅替换收银台一步（跳转支付宝/微信 + 回调），其余不变。
 */
export function PlansDialog({
  open,
  onOpenChange,
  currentQuotaWords,
  onPurchased,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  currentQuotaWords: number | null;
  onPurchased: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<"plans" | "checkout">("plans");
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [paying, setPaying] = useState(false);
  const [creating, setCreating] = useState(false);

  const { data: ordersData } = useQuery({
    queryKey: ["billing-orders"],
    queryFn: () => api.get<{ data: OrderRow[] }>("/billing/orders"),
    enabled: open,
  });
  const orders = ordersData?.data ?? [];

  const startCheckout = async (planId: string) => {
    setCreating(true);
    try {
      const r = await api.post<{ data: OrderRow }>("/billing/orders", {
        plan_id: planId,
      });
      setOrder(r.data);
      setStep("checkout");
    } catch (e: any) {
      toast({ title: e?.message ?? "下单失败", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const payMock = async () => {
    if (!order) return;
    setPaying(true);
    try {
      const r = await api.post<{ data: { quota_words: number } }>(
        `/billing/orders/${order.id}/pay-mock`,
      );
      toast({
        title: `支付成功，额度已更新为 ${Math.round(r.data.quota_words / 10000)} 万字/月`,
      });
      onPurchased();
      onOpenChange(false);
      setStep("plans");
      setOrder(null);
    } catch (e: any) {
      toast({ title: e?.message ?? "支付失败", variant: "destructive" });
    } finally {
      setPaying(false);
    }
  };

  const cancelOrder = async () => {
    if (!order) return;
    try {
      await api.post(`/billing/orders/${order.id}/cancel`);
    } catch {
      /* 取消失败不阻断回到套餐页 */
    }
    setStep("plans");
    setOrder(null);
  };

  const plan = order ? PLANS.find((p) => p.id === order.plan_id) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setStep("plans");
          setOrder(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === "plans" ? "升级套餐" : "收银台（模拟支付）"}
          </DialogTitle>
        </DialogHeader>

        {step === "plans" ? (
          <div className="space-y-3">
            {PLANS.map((p) => {
              const isCurrent = currentQuotaWords === p.words;
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-3 rounded-md border p-3 ${
                    isCurrent ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      {isCurrent && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1 py-0"
                        >
                          当前套餐
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {p.desc}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium">{p.price}</p>
                    {p.id !== "free" && !isCurrent && (
                      <Button
                        size="xs"
                        className="mt-1"
                        disabled={creating}
                        onClick={() => startCheckout(p.id)}
                      >
                        升级
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              升级后额度即时生效，本月已用字数保留。演示环境：支付为模拟，不会真实扣款。
            </p>

            {orders.length > 0 && (
              <div className="space-y-1 border-t border-border pt-2">
                <p className="text-xs font-medium text-muted-foreground">
                  订单记录
                </p>
                <div className="max-h-28 overflow-y-auto space-y-1">
                  {orders.map((o) => (
                    <div key={o.id} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground shrink-0">
                        {new Date(o.created_at).toLocaleDateString("zh-CN")}
                      </span>
                      <span className="flex-1 truncate">
                        {PLANS.find((p) => p.id === o.plan_id)?.name ?? o.plan_id}{" "}
                        {o.amount}
                      </span>
                      {o.status === "paid" && o.expires_at && (
                        <span className="text-muted-foreground shrink-0">
                          {new Date(o.expires_at).toLocaleDateString("zh-CN")}{" "}
                          到期
                        </span>
                      )}
                      <span
                        className={
                          o.status === "paid"
                            ? "text-green-600"
                            : "text-muted-foreground"
                        }
                      >
                        {STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">套餐</span>
                <span>{plan?.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">价格</span>
                <span>{plan?.price}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">订单号</span>
                <span className="text-xs">{order?.id.slice(0, 8)}…</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              模拟收银台：真实支付接入后，此处将跳转支付宝/微信支付并回调确认。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={cancelOrder}>
                取消订单
              </Button>
              <Button size="sm" disabled={paying} onClick={payMock}>
                {paying ? "处理中..." : "模拟支付成功"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
