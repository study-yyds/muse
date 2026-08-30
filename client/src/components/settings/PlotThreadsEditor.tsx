import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface PlotThread {
  desc: string;
  status: string;
  key?: string;
}

/**
 * 伏笔账本编辑器：设置页（折叠版）与写作页弹窗共用。
 * 支持添加（描述+答案关键词可选）、行内编辑描述、状态切换（待收/已收）、删除。
 * 保存走 settings extra 合并接口；AI 续写时注入未回收伏笔（≤8 条）。
 */
export function PlotThreadsEditor({ bookId, collapsed = false }: { bookId: string; collapsed?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () => api.get<{ data: { extra?: Record<string, any> } }>(`/books/${bookId}/settings`),
  });
  const threads = (data?.data?.extra?.plot_threads ?? []) as PlotThread[];
  const [open, setOpen] = useState(!collapsed);
  const [newDesc, setNewDesc] = useState("");
  const [newKey, setNewKey] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [removeIdx, setRemoveIdx] = useState<number | null>(null);

  const saveThreads = async (next: PlotThread[]) => {
    try {
      await api.put(`/books/${bookId}/settings`, { extra: { plot_threads: next } as any });
      queryClient.invalidateQueries({ queryKey: ["book-settings", bookId] });
    } catch {
      toast({ title: "保存失败", variant: "destructive" });
    }
  };
  const addThread = () => {
    const d = newDesc.trim();
    if (!d) return;
    const k = newKey.trim();
    saveThreads([...threads, { desc: d, status: "待收", ...(k ? { key: k } : {}) }]);
    setNewDesc("");
    setNewKey("");
  };
  const updateThread = (i: number, patch: Partial<PlotThread>) => {
    const next = threads.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
    saveThreads(next);
  };
  const removeThread = (i: number) => {
    setRemoveIdx(i);
  };

  const pendingCount = threads.filter((t) => t.status !== "已收").length;

  return (
    <div className="space-y-2">
      <button
        onClick={() => collapsed && setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Label className="text-sm font-medium cursor-pointer">伏笔账本</Label>
        <span className="text-xs text-muted-foreground">{pendingCount} 条待收</span>
        {collapsed && (
          <span className="ml-auto text-xs text-muted-foreground">
            {open ? "收起" : "展开"}
          </span>
        )}
      </button>
      {open && (
        <>
          <p className="text-xs text-muted-foreground">
            手动登记伏笔；AI 续写时自动注入未回收的伏笔（最多 8 条），回收后标记"已收"。
            关键词用于回收校验（正文出现该词 AI 才能标"已收"）。
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {threads.map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span
                  className={
                    "text-xs px-1.5 py-0.5 rounded shrink-0 " +
                    (t.status === "已收"
                      ? "bg-muted text-muted-foreground"
                      : "bg-primary/10 text-foreground")
                  }
                >
                  {t.status ?? "待收"}
                </span>
                {editingIdx === i ? (
                  <Input
                    autoFocus
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={() => {
                      const d = editingText.trim();
                      if (d && d !== t.desc) updateThread(i, { desc: d });
                      setEditingIdx(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") { setEditingIdx(null); setEditingText(t.desc); }
                    }}
                    className="flex-1 min-w-0 h-6 text-sm"
                  />
                ) : (
                  <span
                    onClick={() => { setEditingIdx(i); setEditingText(t.desc); }}
                    title="点击编辑描述"
                    className={
                      "flex-1 min-w-0 truncate cursor-text " +
                      (t.status === "已收" ? "line-through text-muted-foreground" : "")
                    }
                  >
                    {t.desc}
                  </span>
                )}
                {t.key && (
                  <span
                    title="答案关键词"
                    className="shrink-0 text-xs text-muted-foreground border border-border rounded px-1"
                  >
                    {t.key}
                  </span>
                )}
                <button
                  onClick={() => updateThread(i, { status: t.status === "已收" ? "待收" : "已收" })}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t.status === "已收" ? "重开" : "已收"}
                </button>
                <button
                  onClick={() => removeThread(i)}
                  className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
                >
                  删除
                </button>
              </div>
            ))}
            {threads.length === 0 && (
              <p className="text-xs text-muted-foreground">
                暂无伏笔。写正文时 AI 会自动抽取，也可手动添加。
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addThread(); }}
              placeholder="伏笔描述，如：神秘老者身份未揭"
              className="flex-1"
            />
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addThread(); }}
              placeholder="关键词（可选）"
              className="w-28"
            />
            <Button size="sm" onClick={addThread} disabled={!newDesc.trim()}>
              添加
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={removeIdx != null}
        onOpenChange={(o) => !o && setRemoveIdx(null)}
        title="删除伏笔"
        description={`确定删除伏笔"${removeIdx != null ? (threads[removeIdx]?.desc ?? "") : ""}"？`}
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (removeIdx != null) {
            saveThreads(threads.filter((_, idx) => idx !== removeIdx));
          }
          setRemoveIdx(null);
        }}
      />
    </div>
  );
}
