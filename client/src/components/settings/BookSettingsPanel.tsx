import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Settings, Loader2, Check } from "lucide-react";

interface BookSettings {
  preset_style: string;
  auto_save_interval_sec: number;
  daily_word_goal?: number;
}

interface Props {
  bookId: string;
}

const WRITING_STYLES = [
  { value: "default", label: "默认" },
  { value: "light-novel", label: "轻小说" },
  { value: "serious", label: "严肃文学" },
  { value: "ancient", label: "古风" },
  { value: "plain", label: "小白文" },
  { value: "colloquial", label: "口语化" },
];

const SAVE_INTERVALS = [
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分钟" },
  { value: 120, label: "2 分钟" },
  { value: 300, label: "5 分钟（默认）" },
  { value: 600, label: "10 分钟" },
  { value: 1800, label: "30 分钟" },
];

export function BookSettingsPanel({ bookId }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () => api.get<{ data: BookSettings }>(`/books/${bookId}/settings`),
  });

  const settings = data?.data;

  const [presetStyle, setPresetStyle] = useState("default");
  const [saveInterval, setSaveInterval] = useState(300);
  const [wordGoal, setWordGoal] = useState(0);

  useEffect(() => {
    if (settings) {
      setPresetStyle(settings.preset_style ?? "default");
      setSaveInterval(settings.auto_save_interval_sec ?? 300);
      setWordGoal(settings.daily_word_goal ?? 0);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (body: Partial<BookSettings>) =>
      api.put(`/books/${bookId}/settings`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book-settings", bookId] });
      toast({ title: "设置已保存" });
    },
    onError: () => toast({ title: "保存失败", variant: "destructive" }),
  });

  const isDirty =
    presetStyle !== (settings?.preset_style ?? "default") ||
    saveInterval !== (settings?.auto_save_interval_sec ?? 300) ||
    wordGoal !== (settings?.daily_word_goal ?? 0);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-6 space-y-6">
      <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Settings className="size-5" />
        作品设置
      </h2>

      {/* 自动保存间隔 */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">自动保存间隔</Label>
        <div className="grid grid-cols-3 gap-2">
          {SAVE_INTERVALS.map((opt) => (
            <Button
              key={opt.value}
              variant={saveInterval === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => setSaveInterval(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <Separator />

      {/* 预设写作风格 */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">预设写作风格</Label>
        <div className="grid grid-cols-3 gap-2">
          {WRITING_STYLES.map((opt) => (
            <Button
              key={opt.value}
              variant={presetStyle === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => setPresetStyle(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          AI 续写时的默认风格，写作过程中可临时切换
        </p>
      </div>

      <Separator />

      {/* 每日字数目标 */}
      <div className="space-y-2">
        <Label htmlFor="word-goal" className="text-sm font-medium">
          每日码字目标
        </Label>
        <div className="flex items-center gap-3">
          <Input
            id="word-goal"
            type="number"
            value={wordGoal || ""}
            onChange={(e) => setWordGoal(Number(e.target.value))}
            placeholder="不限制"
            className="w-32"
          />
          <span className="text-sm text-muted-foreground">字/天</span>
        </div>
      </div>

      {/* 保存按钮 */}
      <div className="flex justify-end">
        <Button
          onClick={() =>
            saveMutation.mutate({
              preset_style: presetStyle,
              auto_save_interval_sec: saveInterval,
              daily_word_goal: wordGoal || undefined,
            })
          }
          disabled={!isDirty || saveMutation.isPending}
        >
          {saveMutation.isPending && <Loader2 className="size-4 animate-spin" />}
          {!saveMutation.isPending && <Check className="size-4" />}
          保存设置
        </Button>
      </div>
    </div>
  );
}
