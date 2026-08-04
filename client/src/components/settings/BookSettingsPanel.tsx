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
  coverUrl?: string | null;
  onCoverChange?: (url: string) => void;
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

export function BookSettingsPanel({ bookId, coverUrl, onCoverChange }: Props) {
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
  const [visualStyle, setVisualStyle] = useState("");
  const [coverLightbox, setCoverLightbox] = useState(false);

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

      {/* 封面管理 */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">作品封面</Label>
        <div className="flex gap-4">
          <div className="w-32 aspect-[2/3] rounded-lg overflow-hidden bg-muted flex-shrink-0">
            {coverUrl ? (
              <img src={coverUrl} alt="封面" className="w-full h-full object-cover cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all" onClick={() => setCoverLightbox(true)} />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                暂无封面
              </div>
            )}
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-xs text-muted-foreground">
              根据作品世界观、角色设定自动生成封面图
            </p>
            <CoverGenerateButton
              bookId={bookId}
              onGenerated={(url) => onCoverChange?.(url)}
              style={visualStyle}
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* 视觉风格 */}
      <VisualStyleSetting bookId={bookId} style={visualStyle} onStyleChange={setVisualStyle} />

      <Separator />

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

      {/* 封面全屏 lightbox */}
      {coverLightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setCoverLightbox(false)}
        >
          <img
            src={coverUrl!}
            alt="封面预览"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
          />
        </div>
      )}
    </div>
  );
}

function VisualStyleSetting({
  bookId,
  style,
  onStyleChange,
}: {
  bookId: string;
  style: string;
  onStyleChange: (s: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.get<{ data: { extra?: any } }>(`/books/${bookId}/settings`).then((res) => {
      const s = res?.data?.extra?.visual_style;
      if (s) onStyleChange(s);
    }).catch(() => {});
  }, [bookId]);

  const getRecommendation = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/ai/recommend-style", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId }),
      });
      const json = await res.json();
      const recommended = json?.data?.style || "电影写实风";
      onStyleChange(recommended);
      await api.put(`/books/${bookId}/settings`, { extra: { visual_style: recommended } as any });
      toast({ title: `推荐风格：${recommended}` });
    } catch {
      toast({ title: "获取推荐失败", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const saveStyle = async () => {
    try {
      await api.put(`/books/${bookId}/settings`, { extra: { visual_style: style } as any });
      toast({ title: "视觉风格已保存" });
    } catch {
      toast({ title: "保存失败", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">视觉风格（生图用）</Label>
      <div className="flex gap-2">
        <Input
          value={style}
          onChange={(e) => onStyleChange(e.target.value)}
          placeholder="如：废土朋克、水墨武侠..."
          className="flex-1"
        />
        <Button size="sm" variant="outline" onClick={getRecommendation} disabled={loading}>
          {loading ? <Loader2 className="size-3 animate-spin" /> : "AI 推荐"}
        </Button>
        <Button size="sm" onClick={saveStyle}>保存</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        所有封面和角色图将统一使用此风格。AI 推荐基于世界观自动分析。
      </p>
    </div>
  );
}

function CoverGenerateButton({
  bookId,
  onGenerated,
  style,
}: {
  bookId: string;
  onGenerated: (url: string) => void;
  style?: string;
}) {
  const [generating, setGenerating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const { toast } = useToast();

  const doGenerate = async () => {
    setGenerating(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/ai/generate-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId, prompt: prompt || undefined, size: "2K", style }),
      });
      if (!res.ok) throw new Error("生成失败");
      const json = await res.json();
      const url = json?.data?.url;
      if (url) {
        onGenerated(url);
        toast({ title: "封面已生成" });
        setShowPrompt(false);
      }
    } catch {
      toast({ title: "生成失败，请稍后重试", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          setGenerating(true);
          try {
            const token = localStorage.getItem("token");
            const res = await fetch("/api/ai/generate-cover", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ book_id: bookId, size: "2K", style }),
            });
            if (res.ok) {
              const json = await res.json();
              if (json?.data?.url) {
                onGenerated(json.data.url);
                toast({ title: "封面已生成" });
                return;
              }
            }
            setShowPrompt(true);
          } catch {
            setShowPrompt(true);
          } finally {
            setGenerating(false);
          }
        }}
        disabled={generating}
      >
        {generating && <Loader2 className="size-3 animate-spin mr-1" />}
        快速生成
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setShowPrompt(true)}
        disabled={generating}
      >
        自定义 Prompt
      </Button>

      {showPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl p-6 w-full max-w-lg mx-4 space-y-4">
            <h3 className="text-sm font-semibold">封面 Prompt</h3>
            <textarea
              className="w-full h-32 rounded border border-border bg-background px-3 py-2 text-xs resize-none"
              placeholder="描述你想要的封面..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowPrompt(false)}>
                取消
              </Button>
              <Button size="sm" onClick={doGenerate} disabled={generating}>
                {generating && <Loader2 className="size-3 animate-spin mr-1" />}
                生成
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
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
