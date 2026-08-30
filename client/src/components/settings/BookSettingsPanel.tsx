import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, authFetch } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Settings, Loader2, Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ModelSelector, customKeyValue } from "@/components/settings/ModelSelector";
import { SynopsisSection } from "@/components/settings/SynopsisSection";
import { PlotThreadsEditor } from "@/components/settings/PlotThreadsEditor";
import { WRITING_STYLES } from "@/lib/writing-styles";

interface BookSettings {
  preset_style: string;
  daily_word_goal?: number;
}

interface Props {
  bookId: string;
  book?: { title: string; type?: string };
  coverUrl?: string | null;
  onCoverChange?: (url: string) => void;
  onCoverHistory?: (history: string[]) => void;
}

export function BookSettingsPanel({ bookId, book, coverUrl, onCoverChange }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () => api.get<{ data: BookSettings }>(`/books/${bookId}/settings`),
  });

  const settings = data?.data;

  // 本月 AI 用量（计费口径：生成字数；quota_words 为 null 表示不限）
  const { data: quotaData } = useQuery({
    queryKey: ["ai-quota"],
    queryFn: () =>
      api.get<{
        data: {
          used_words: number;
          quota_words: number | null;
          remaining: number | null;
          month: string;
        };
      }>(`/ai/quota`),
  });
  const quota = quotaData?.data;

  const [presetStyle, setPresetStyle] = useState("default");
  const [wordGoal, setWordGoal] = useState(0);
  const [isMimicking, setIsMimicking] = useState(false);
  const [mimicResult, setMimicResult] = useState<string | null>(null);
  const [customStyleText, setCustomStyleText] = useState("");
  const [visualStyle, setVisualStyle] = useState("");
  const [coverLightbox, setCoverLightbox] = useState(false);
  const [coverHistory, setCoverHistory] = useState<string[]>([]);

  const doMimic = async (body: Record<string, any>) => {
    setIsMimicking(true);
    try {
      const t = localStorage.getItem("token");
      const r = await authFetch("/api/ai/mimic-style", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      const analysis = json.data?.analysis ?? "";
      setMimicResult(analysis);
      if (analysis) {
        // 粘贴文本分析时把原文存为风格样本（续写注入用，描述式模仿遵循率低）
        const extraPatch: Record<string, any> = {
          mimic_style_analysis: analysis,
          mimic_style_sample: body.text ? String(body.text).slice(0, 1000) : null,
        };
        api.put(`/books/${bookId}/settings`, { extra: extraPatch as any });
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

  const [mimicModel, setMimicModel] = useState("deepseek-v4-flash");
  const [mimicKeyId, setMimicKeyId] = useState<string | undefined>(undefined);
  const doMimicBook = () => doMimic({ book_id: bookId, model: mimicModel, key_id: mimicKeyId });
  const doMimicCustom = () => doMimic({ text: customStyleText, model: mimicModel, key_id: mimicKeyId });

  useEffect(() => {
    if (settings) {
      // 旧值 plain（小白文）已从预设中移除，归一为默认
      setPresetStyle(
        settings.preset_style === "plain" ? "default" : (settings.preset_style ?? "default"),
      );
      setWordGoal(settings.daily_word_goal ?? 0);
      setMimicResult((settings as any).extra?.mimic_style_analysis ?? null);
      const h = (settings as any).extra?.cover_history;
      if (Array.isArray(h) && h.length > 0) setCoverHistory(h);
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
      {/* 本月 AI 用量（计费口径：生成字数） */}
      {quota && quota.quota_words != null && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">本月 AI 用量</Label>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${Math.min(100, (quota.used_words / quota.quota_words) * 100)}%`,
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {quota.used_words.toLocaleString()} / {quota.quota_words.toLocaleString()} 字
            </span>
          </div>
        </div>
      )}
      <Separator />
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
              onGenerated={(url, history) => { onCoverChange?.(url); if (history) setCoverHistory(history); }}
              style={visualStyle}
            />
          </div>
        </div>
        {/* 封面历史版本 */}
        {coverHistory.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {coverHistory.map((h, i) => (
              <img
                key={i}
                src={h}
                alt={`封面版本 ${i + 1}`}
                className={`w-12 h-18 object-cover rounded cursor-pointer border-2 flex-shrink-0 ${h === coverUrl ? 'border-primary' : 'border-transparent hover:border-border'}`}
                onClick={async () => {
                  onCoverChange?.(h);
                  const t = localStorage.getItem("token");
                  await authFetch(`/api/books/${bookId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
                    body: JSON.stringify({ cover_url: h }),
                  }).catch(() => {});
                }}
              />
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* 视觉风格 */}
      <VisualStyleSetting bookId={bookId} style={visualStyle} onStyleChange={setVisualStyle} />

      <Separator />

      {/* 作品简介 */}
      {/* 短篇不需要简介：短篇平台的"简介"就是正文开头三句，不单独生成 */}
      {book?.type !== "short" && <SynopsisSection bookId={bookId} />}

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
          分析已有正文或手动输入样本，提取写作风格特征。
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            usage="chat"
            value={mimicKeyId ? customKeyValue(mimicKeyId) : mimicModel}
            onChange={(m, keyId) => { setMimicModel(m); setMimicKeyId(keyId); }}
            className="text-xs rounded border border-border bg-background px-2 py-1"
          />
          <Button
          variant="outline"
          size="sm"
          onClick={doMimicBook}
          disabled={isMimicking}
        >
          {isMimicking && <Loader2 className="size-4 animate-spin" />}
          从我的作品分析
        </Button>
        </div>
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

      {/* 伏笔账本（折叠版，共享组件；写作页弹窗同源） */}
      <PlotThreadsEditor bookId={bookId} collapsed />

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
          在顶部头像菜单 →「设置」中管理你的 API Key，所有作品共享
        </p>
      </div>

      {/* 保存按钮 */}
      <div className="flex justify-end">
        <Button
          onClick={() =>
            saveMutation.mutate({
              preset_style: presetStyle,
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
      const res = await authFetch("/api/ai/recommend-style", {
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
  onGenerated: (url: string, history?: string[]) => void;
  style?: string;
}) {
  const [generating, setGenerating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [model, setModel] = useState("doubao-seedream-5-0-260128");
  const [coverKeyId, setCoverKeyId] = useState<string | undefined>(undefined);
  const [imageResolution, setImageResolution] = useState("2K");
  const [imageRatio, setImageRatio] = useState("1:1");
  const { toast } = useToast();

  const imageSize = imageRatio === "1:1" ? imageResolution : `${imageResolution}:${imageRatio}`;

  const doGenerate = async () => {
    setGenerating(true);
    try {
      const token = localStorage.getItem("token");
      const res = await authFetch("/api/ai/generate-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId, prompt: prompt || undefined, size: imageSize, style, model, key_id: coverKeyId }),
      });
      if (!res.ok) throw new Error("生成失败");
      const json = await res.json();
      const url = json?.data?.url;
      if (url) {
        onGenerated(url, json?.data?.history);
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
            const res = await authFetch("/api/ai/generate-cover", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ book_id: bookId, size: imageSize, style, model, key_id: coverKeyId }),
            });
            if (res.ok) {
              const json = await res.json();
              if (json?.data?.url) {
                onGenerated(json.data.url, json.data.history);
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
      <select value={imageResolution} onChange={(e) => setImageResolution(e.target.value)}
        className="text-xs rounded border border-border bg-background px-1 py-1">
        <option value="1K">1K</option>
        <option value="2K">2K</option>
        <option value="4K">4K</option>
      </select>
      <select value={imageRatio} onChange={(e) => setImageRatio(e.target.value)}
        className="text-xs rounded border border-border bg-background px-1 py-1">
        <option value="1:1">1:1</option>
        <option value="16:9">16:9</option>
        <option value="9:16">9:16</option>
        <option value="3:4">3:4</option>
      </select>
      <ModelSelector
        usage="image"
        value={coverKeyId ? customKeyValue(coverKeyId) : model}
        onChange={(m, keyId) => { setModel(m); setCoverKeyId(keyId); }}
        className="text-xs rounded border border-border bg-background px-2 py-1"
      />

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
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [modelName, setModelName] = useState("deepseek-v4-flash");
  const [usage, setUsage] = useState("chat");
  const [keys, setKeys] = useState<any[]>([]);
  const { toast } = useToast();

  // 加载已有 Key 列表
  const loadKeys = async () => {
    const token = localStorage.getItem("token");
    try {
      const res = await authFetch("/api/user/api-keys", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setKeys(json.data || []);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => { loadKeys(); }, []);

  const saveKey = async () => {
    if (!name.trim() || !key.trim()) return;
    const token = localStorage.getItem("token");
    try {
      const res = await authFetch("/api/user/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, api_key: key, base_url: baseUrl, model_name: modelName, usage }),
      });
      if (res.ok) {
        toast({ title: "API Key 已保存" });
        setName(""); setKey(""); loadKeys();
      } else {
        toast({ title: "保存失败", variant: "destructive" });
      }
    } catch {
      toast({ title: "保存失败", variant: "destructive" });
    }
  };

  const deleteKey = async (id: string) => {
    const token = localStorage.getItem("token");
    try {
      await authFetch(`/api/user/api-keys/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      loadKeys();
      toast({ title: "已删除" });
    } catch { toast({ title: "删除失败", variant: "destructive" }); }
  };

  return (
    <div className="space-y-3">
      {/* 已有 Key 列表 */}
      {keys.length > 0 && (
        <div className="space-y-1">
          {keys.map((k: any) => (
            <div key={k.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-muted/30">
              <span className="font-medium">{k.name}</span>
              <span className="text-muted-foreground">{k.model_name}</span>
              <Badge variant="secondary" className="text-xs">{k.usage}</Badge>
              <button onClick={() => deleteKey(k.id)} className="ml-auto text-muted-foreground hover:text-destructive">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 新增表单 */}
      <div className="space-y-2 pt-2 border-t border-border">
        <div className="flex gap-2">
          <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)}
            className="w-28 rounded border border-border bg-background px-2 py-1 text-xs" />
          <input placeholder="API Key" value={key} onChange={(e) => setKey(e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
        </div>
        <div className="flex gap-2">
          <input placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
          <input placeholder="Model" value={modelName} onChange={(e) => setModelName(e.target.value)}
            className="w-36 rounded border border-border bg-background px-2 py-1 text-xs" />
          <select value={usage} onChange={(e) => setUsage(e.target.value)}
            className="w-18 rounded border border-border bg-background px-1 py-1 text-xs">
            <option value="chat">文本</option>
            <option value="image">生图</option>
            <option value="both">通用</option>
          </select>
          <Button size="xs" onClick={saveKey}>保存</Button>
        </div>
      </div>
    </div>
  );
}
