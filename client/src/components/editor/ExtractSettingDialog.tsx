import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Sparkles, AlertTriangle, UserRound, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

interface Suggestion {
  type: "character" | "world";
  target_char_id: string | null;
  field?: string;
  value?: string;
  section_name?: string;
  content?: string;
  existing_value: string | null;
  conflict: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  chapterId: string;
}

const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  gender: "性别",
  personality: "性格",
  identity: "身份",
  backstory: "背景故事",
  motivation: "动机",
  appearance: "外貌",
  catchphrase: "口头禅",
  speech_style: "说话风格",
};

export function ExtractSettingDialog({ open, onOpenChange, bookId, chapterId }: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const doExtract = async () => {
    setLoading(true);
    setSuggestions([]);
    setSelected(new Set());
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/ai/extract-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, model: "deepseek-v4-flash" }),
      });
      const json = await res.json();
      const items: Suggestion[] = json?.data?.suggestions ?? [];
      setSuggestions(items);
      if (items.length === 0) {
        toast({ title: "未提取到设定建议，当前章节可能没有新的角色或世界观信息" });
      }
    } catch {
      toast({ title: "提取失败，请稍后重试", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const toggleAll = () => {
    if (selected.size === suggestions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(suggestions.map((_, i) => i)));
    }
  };

  const doApply = async () => {
    const toApply = suggestions.filter((_, i) => selected.has(i));
    if (toApply.length === 0) return;
    setApplying(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/ai/apply-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId, suggestions: toApply }),
      });
      const json = await res.json();
      toast({ title: json?.data?.applied?.length ? `已应用 ${json.data.applied.length} 条设定` : "已应用" });
      onOpenChange(false);
    } catch {
      toast({ title: "应用失败", variant: "destructive" });
    } finally {
      setApplying(false);
    }
  };

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            提取设定
          </DialogTitle>
        </DialogHeader>

        {suggestions.length === 0 && !loading && (
          <div className="text-center py-8 text-muted-foreground text-sm">
            <Sparkles className="size-8 mx-auto mb-2 opacity-30" />
            <p>AI 将分析当前章节，找出新的角色设定和世界观信息</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={doExtract}>
              开始提取
            </Button>
          </div>
        )}

        {loading && (
          <div className="space-y-3 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-2">
                <Skeleton className="size-4 rounded shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground text-center pt-2">
              <Loader2 className="inline size-3 animate-spin mr-1" />
              AI 正在分析章节内容...
            </p>
          </div>
        )}

        {suggestions.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.size === suggestions.length}
                  onChange={toggleAll}
                  className="size-3.5"
                />
                全选
              </label>
              <span>（{selected.size}/{suggestions.length}）</span>
            </div>

            <ScrollArea className="flex-1 min-h-0 -mx-1">
              <div className="space-y-2 pr-2">
                {suggestions.map((s, i) => (
                  <label
                    key={i}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors",
                      selected.has(i) ? "border-primary/30 bg-primary/5" : "border-border hover:bg-muted/50",
                      s.conflict && "border-amber-500/40 bg-amber-50 dark:bg-amber-950/10"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggle(i)}
                      className="size-3.5 mt-0.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {s.type === "character" ? (
                          <UserRound className="size-3 text-muted-foreground shrink-0" />
                        ) : (
                          <Globe className="size-3 text-muted-foreground shrink-0" />
                        )}
                        <span className="text-xs font-medium text-foreground">
                          {s.type === "character"
                            ? (s.field ? FIELD_LABELS[s.field] ?? s.field : "角色")
                            : s.section_name}
                        </span>
                        {s.conflict && (
                          <span className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-0.5">
                            <AlertTriangle className="size-3" />
                            冲突
                          </span>
                        )}
                      </div>
                      {s.type === "character" && s.field === "name" && (
                        <p className="text-sm font-medium text-foreground mt-0.5">新角色：{s.value}</p>
                      )}
                      {s.type === "character" && s.field !== "name" && (
                        <p className="text-sm mt-0.5 text-foreground">
                          {s.field === "name" ? s.value : `${FIELD_LABELS[s.field ?? ""] ?? s.field}：${s.value ?? ""}`}
                        </p>
                      )}
                      {s.type === "world" && (
                        <p className="text-xs mt-0.5 text-muted-foreground line-clamp-2">{s.content}</p>
                      )}
                      {s.existing_value && !s.conflict && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          已有：{s.existing_value.slice(0, 80)}
                        </p>
                      )}
                      {s.conflict && s.existing_value && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                          已有：{s.existing_value.slice(0, 80)}
                        </p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={doExtract} disabled={loading || applying}>
                重新提取
              </Button>
              <Button size="sm" onClick={doApply} disabled={selected.size === 0 || applying}>
                {applying && <Loader2 className="size-3 animate-spin" />}
                应用选中
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
