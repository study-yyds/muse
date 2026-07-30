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
  const [isMimicking, setIsMimicking] = useState(false);
  const [mimicResult, setMimicResult] = useState<string | null>(null);
  const [customStyleText, setCustomStyleText] = useState("");

  const doMimic = async (body: Record<string, any>) => {
    setIsMimicking(true);
    try {
      const t = localStorage.getItem("token");
      const r = await fetch("/api/ai/mimic-style", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      const analysis = json.data?.analysis ?? "";
      setMimicResult(analysis);
      if (analysis) {
        api.put(`/books/${bookId}/settings`, { extra: { mimic_style_analysis: analysis } as any });
        toast({ title: "笔风分析完成" });
      } else {
        toast({ title: json.data?.analysis === "" ? "分析失败" : "内容不足", variant: "destructive" });
      }
    } catch {
      toast({ title: "分析失败", variant: "destructive" });
    } finally {
      setIsMimicking(false);
    }
  };

  const doMimicBook = () => doMimic({ book_id: bookId, model: "deepseek-v4-flash" });
  const doMimicCustom = () => doMimic({ text: customStyleText, model: "deepseek-v4-flash" });

  useEffect(() => {
    if (settings) {
      setPresetStyle(settings.preset_style ?? "default");
      setSaveInterval(settings.auto_save_interval_sec ?? 300);
      setWordGoal(settings.daily_word_goal ?? 0);
      setMimicResult((settings as any).extra?.mimic_style_analysis ?? null);
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

      {/* AI 模仿笔风 */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">AI 模仿笔风</Label>
        <p className="text-xs text-muted-foreground">
          分析已有正文或手动输入样本，提取写作风格特征。AI 后续续写将参考此风格。
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={doMimicBook}
          disabled={isMimicking}
        >
          {isMimicking && <Loader2 className="size-4 animate-spin" />}
          从我的作品分析
        </Button>
        <div className="space-y-1.5">
          <textarea
            placeholder="或粘贴网上的文字样本（≥200字），如金庸/余华/猫腻的段落..."
            value={customStyleText}
            onChange={(e) => setCustomStyleText(e.target.value)}
            rows={3}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs resize-none"
          />
          <Button
            variant="outline"
            size="xs"
            onClick={doMimicCustom}
            disabled={isMimicking || customStyleText.trim().length < 200}
          >
            {isMimicking && <Loader2 className="size-4 animate-spin" />}
            分析这段文字
          </Button>
        </div>
        {mimicResult && (
          <div className="rounded border border-border bg-muted/50 p-3 text-sm">
            <p className="font-medium mb-1">当前风格分析：</p>
            <p className="text-muted-foreground">{mimicResult}</p>
          </div>
        )}
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

      <Separator />

      {/* 自定义 AI API Key */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">自定义 AI API Key</Label>
        <p className="text-xs text-muted-foreground">
          填写你自己的 API Key 和端点，使用私有额度而非平台免费额度
        </p>
        <ApiKeyForm bookId={bookId} />
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

function ApiKeyForm({ bookId: _ }: { bookId: string }) {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [modelName, setModelName] = useState("deepseek-chat");
  const { toast } = useToast();

  const saveKey = async () => {
    const token = localStorage.getItem("token");
    try {
      const res = await fetch("/api/user/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ api_key: key, base_url: baseUrl, model_name: modelName }),
      });
      if (res.ok) {
        toast({ title: "API Key 已保存" });
        setKey("");
      } else {
        toast({ title: "保存失败", variant: "destructive" });
      }
    } catch {
      toast({ title: "后端不可用，API Key 将在本地保存", variant: "destructive" });
      localStorage.setItem("muse-custom-api-key", JSON.stringify({ api_key: key, base_url: baseUrl, model_name: modelName }));
      setKey("");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input placeholder="API Key" value={key} onChange={(e) => setKey(e.target.value)}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
        <Button size="xs" onClick={saveKey}>保存</Button>
      </div>
      <div className="flex gap-2">
        <input placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
        <input placeholder="Model" value={modelName} onChange={(e) => setModelName(e.target.value)}
          className="w-40 rounded border border-border bg-background px-2 py-1 text-xs" />
      </div>
    </div>
  );
}
