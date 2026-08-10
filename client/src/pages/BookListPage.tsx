import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { BookListItem } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, BookOpen, Loader2, Trash2, Undo2, Sparkles, Check, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ModelSelector } from "@/components/settings/ModelSelector";

const createBookSchema = z.object({
  title: z.string().min(1, "书名不能为空").max(200),
  preset_style: z.string().optional(),
});

type CreateBookForm = z.infer<typeof createBookSchema>;

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  writing: "写作中",
  completed: "已完成",
};

const SHORT_TEMPLATES = [
  { key: "rebirth", label: "重生逆袭", prompt: "写一个女主重生回到过去、改变命运的短篇，第一人称「我」叙述，开篇即冲突，打脸虐渣爽感十足" },
  { key: "face-slap", label: "打脸爽文", prompt: "写一个打脸爽文短篇——女主被轻视后一举翻盘，不靠男人只靠自己，让所有人刮目相看，第一人称" },
  { key: "strong", label: "大女主", prompt: "写一个大女主短篇——女主能力强、有主见、不依附任何人，在自己的领域闪闪发光，爱情是锦上添花不是救命稻草" },
  { key: "anti-trope", label: "反套路", prompt: "写一个反套路短篇——经典狗血开局（替身/契约/退婚），但女主不按常理出牌，剧情走向完全出乎意料，第一人称" },
  { key: "reality", label: "现实情感", prompt: "写一个现实向短篇——离婚逆袭、职场PUA、育儿焦虑等真实社会议题，细节扎心、情绪共鸣强，女主从谷底爬起来活出自己，第一人称" },
  { key: "sweet", label: "甜宠治愈", prompt: "写一个甜宠治愈短篇——男主温柔深情，女主被好好珍惜，全程轻松温暖没有虐点，让人读完嘴角上扬" },
  { key: "knife-sugar", label: "刀糖文学", prompt: "写一个刀糖短篇——用悬疑/犯罪/惊悚的外壳包裹温情内核，表面细思极恐，内核实则催泪治愈，参考《杀人犯的生日蛋糕》风格" },
  { key: "twist", label: "悬疑反转", prompt: "写一个结局出人意料的悬疑反转短篇，全程铺垫细节，最后一句话颠覆全部认知" },
  { key: "work-fantasy", label: "社畜奇幻", prompt: "写一个轻奇幻短篇——把奇幻设定植入职场/校园/日常场景，比如公司洗手间通向异世界、能听懂猫狗说话，想象力+烟火气，温暖治愈" },
  { key: "family", label: "亲情催泪", prompt: "写一个亲情短篇——母女/父子/兄妹/祖孙之间，细腻真实让人泪目，第一人称" },
  { key: "friend", label: "友情岁月", prompt: "写一个友情短篇——闺蜜/兄弟从亲密到疏远再到和解，或至死不渝的陪伴" },
  { key: "zhihu", label: "知乎体", prompt: "写一个以「我」的第一人称叙述的短篇故事，像在知乎分享亲身经历，开头有钩子，都市情感/悬疑奇遇/职场均可" },
];

export function BookListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createType, setCreateType] = useState<'novel' | 'short'>('novel');
  const [showDeleted, setShowDeleted] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickType, setQuickType] = useState<'novel' | 'short'>('novel');
  const [quickPremise, setQuickPremise] = useState("");
  const [quickModel, setQuickModel] = useState("deepseek-v4-flash");
  const [quickGenerating, setQuickGenerating] = useState(false);
  const [quickSteps, setQuickSteps] = useState<Array<{ step: string; label: string; status: string; preview?: string }>>([]);
  // 引导模式
  const [quickGuiding, setQuickGuiding] = useState(false);
  const [quickGuideMsgs, setQuickGuideMsgs] = useState<Array<{ role: string; content: string }>>([]);
  const [quickGuideInput, setQuickGuideInput] = useState("");
  const [quickGuideLoading, setQuickGuideLoading] = useState(false);
  const guideAbortRef = useRef<AbortController | null>(null);
  const quickAbortRef = useRef<AbortController | null>(null);
  const guideChatRef = useRef<HTMLDivElement>(null);
  const guideUserScrolledUp = useRef(false);
  const guideGotContent = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: ["books", showDeleted ? "deleted" : "active"],
    queryFn: () =>
      api.get<{ data: BookListItem[] }>(
        `/books?status=${showDeleted ? "deleted" : "active"}`
      ),
  });

  const books = data?.data ?? [];

  const createBook = useMutation({
    mutationFn: (form: CreateBookForm) =>
      api.post<{ data: { book_id: string } }>("/books", { ...form, type: createType }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      setDialogOpen(false);
      toast({ title: "作品已创建" });
      navigate(`/books/${res.data.book_id}`);
    },
    onError: () => {
      setDialogOpen(false);
      toast({ title: "创建失败，请确认后端已启动", variant: "destructive" });
    },
  });

  const deleteBook = useMutation({
    mutationFn: (bookId: string) => api.delete(`/books/${bookId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "作品已移至回收站" });
    },
    onError: () => {
      toast({ title: "删除失败，后端未启动", variant: "destructive" });
    },
  });

  const restoreBook = useMutation({
    mutationFn: (bookId: string) => api.post(`/books/${bookId}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "作品已恢复" });
    },
    onError: () => {
      toast({ title: "恢复失败，后端未启动", variant: "destructive" });
    },
  });

  const permanentDeleteBook = useMutation({
    mutationFn: (bookId: string) => api.delete(`/books/${bookId}/permanent`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "作品已彻底删除" });
    },
    onError: () => {
      toast({ title: "删除失败", variant: "destructive" });
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<CreateBookForm>({
    resolver: zodResolver(createBookSchema),
    defaultValues: { title: "", preset_style: "default" },
  });

  const onSubmit = (form: CreateBookForm) => {
    createBook.mutate(form);
    reset();
  };

  const doQuickCreate = async (premise: string, type: string, guideSummary?: string, guideFullLog?: string) => {
    setQuickGenerating(true);
    setQuickSteps([]);
    const controller = new AbortController();
    quickAbortRef.current = controller;
    const token = localStorage.getItem("token");
    try {
      const res = await fetch("/api/ai/quick-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ premise, type, model: quickModel, guide_summary: guideSummary, guide_full_log: guideFullLog }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let bookId = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // flush decoder
          buffer += decoder.decode();
          const finalLines = buffer.split("\n").filter(Boolean);
          for (let i = 0; i < finalLines.length; i++) {
            if (finalLines[i].startsWith("event: ") && finalLines[i + 1]?.startsWith("data: ")) {
              try {
                const data = JSON.parse(finalLines[i + 1].slice(6));
                if (finalLines[i].slice(7).trim() === "done") bookId = data.book_id;
              } catch {}
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("event: ")) {
            const eventType = line.slice(7).trim();
            const dataLine = lines[i + 1];
            if (dataLine?.startsWith("data: ")) {
              try {
                const data = JSON.parse(dataLine.slice(6));
                if (eventType === "step") {
                  setQuickSteps((prev) => {
                    const newStep = { step: data.step, label: data.label, status: data.status, preview: data.preview };
                    const idx = prev.findIndex((s) => s.step === data.step);
                    if (idx >= 0) {
                      const next = [...prev];
                      next[idx] = newStep;
                      return next;
                    }
                    return [...prev, newStep];
                  });
                } else if (eventType === "done") {
                  bookId = data.book_id;
                } else if (eventType === "error") {
                  toast({ title: data.message || "生成失败", variant: "destructive" });
                }
              } catch { /* parse error */ }
            }
          }
        }
      }
      if (bookId) {
        queryClient.invalidateQueries({ queryKey: ["books"] });
        setQuickOpen(false);
        setQuickPremise("");
        toast({ title: "创作完成！" });
        navigate(`/books/${bookId}`);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast({ title: err?.message || "生成失败", variant: "destructive" });
      }
    } finally {
      setQuickGenerating(false);
      setQuickSteps([]);
      quickAbortRef.current = null;
    }
  };

  // 引导聊天自动滚底（用户上滑时暂停，发消息时恢复）
  const scrollGuideToBottom = useCallback(() => {
    const el = guideChatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!guideUserScrolledUp.current) {
      scrollGuideToBottom();
    }
  }, [quickGuideMsgs, quickGuideLoading, scrollGuideToBottom]);

  const handleGuideScroll = useCallback(() => {
    const el = guideChatRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    guideUserScrolledUp.current = !atBottom;
  }, []);

  // 引导模式：发送消息
  const sendGuideMsg = async () => {
    guideUserScrolledUp.current = false;
    guideGotContent.current = false; // 重置内容标记
    const input = quickGuideInput.trim();
    if (!input || quickGuideLoading) return;
    setQuickGuideInput("");
    const newMsgs = [...quickGuideMsgs, { role: "user", content: input }];
    setQuickGuideMsgs(newMsgs);
    setQuickGuideLoading(true);
    const token = localStorage.getItem("token");
    const controller = new AbortController();
    guideAbortRef.current = controller;
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          book_id: "",
          context_type: "write",
          model: quickModel,
          message: input,
          messages: newMsgs.map(m => ({ role: m.role, content: m.content })),
          guide_mode: true,
          guide_context: quickPremise,
          guide_type: quickType,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("无响应");
      const decoder = new TextDecoder();
      let buf = ""; let ac = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buf += decoder.decode(); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        let ev = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
          if (line.startsWith("data: ")) {
            try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
            if (ev === "error") { const d = JSON.parse(line.slice(6)); throw new Error(d.message); }
          }
        }
        // 只在有内容时才追加/更新 AI 回复
        if (ac) {
          guideGotContent.current = true;
          setQuickGuideMsgs((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = { role: "assistant", content: ac };
            } else {
              updated.push({ role: "assistant", content: ac });
            }
            return updated;
          });
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      toast({ title: err?.message || "发送失败", variant: "destructive" });
    } finally {
      setQuickGuideLoading(false);
      if (!guideGotContent.current) {
        setQuickGuideMsgs((prev) => [
          ...prev,
          { role: "assistant", content: "（AI 未响应，请重试）" },
        ]);
      }
      guideAbortRef.current = null;
    }
  };

  const resetQuickDialog = () => {
    setQuickOpen(false);
    setQuickPremise("");
    setQuickSteps([]);
    setQuickGuiding(false);
    setQuickGuideMsgs([]);
    setQuickGuideInput("");
    setQuickGuideLoading(false);
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* 标题栏 */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">我的作品</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleted(!showDeleted)}
          >
            {showDeleted ? "查看作品" : "回收站"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setQuickOpen(true)}>
            <Sparkles className="size-4" />
            快捷创作
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button size="sm">
                  <Plus className="size-4" />
                  新建作品
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>创建新作品</DialogTitle>
                <DialogDescription>给你的故事取个名字</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant={createType === 'novel' ? 'default' : 'outline'} onClick={() => setCreateType('novel')}>长篇</Button>
                  <Button type="button" size="sm" variant={createType === 'short' ? 'default' : 'outline'} onClick={() => setCreateType('short')}>短篇</Button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="title">作品名称</Label>
                  <Input
                    id="title"
                    placeholder="输入作品名"
                    {...register("title")}
                  />
                  {errors.title && (
                    <p className="text-xs text-destructive">{errors.title.message}</p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    取消
                  </Button>
                  <Button type="submit" disabled={createBook.isPending}>
                    {createBook.isPending && <Loader2 className="size-4 animate-spin" />}
                    创建
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          {/* 快捷创作对话框 */}
          <Dialog open={quickOpen} onOpenChange={(open) => {
            if (open) return;
            // 生成中：直接取消
            if (quickGenerating) {
              quickAbortRef.current?.abort();
              resetQuickDialog();
              return;
            }
            // 引导聊天中：确认后取消
            if (quickGuiding) {
              if (!confirm("确定退出引导？当前对话将丢失。")) return;
              guideAbortRef.current?.abort();
              resetQuickDialog();
              return;
            }
            // 表单阶段：直接关闭
            resetQuickDialog();
          }}>
            <DialogContent className={quickGuiding ? "max-w-lg h-[520px] flex flex-col" : ""}>
              <DialogHeader>
                <DialogTitle>{quickGuiding ? "创作引导" : "快捷创作"}</DialogTitle>
                <DialogDescription>
                  {quickGuiding
                    ? `第 ${Math.min(quickGuideMsgs.filter(m => m.role === "user").length + 1, 5)} 轮 · AI 帮你梳理想法`
                    : (quickType === 'short' ? 'AI 一步写完完整短篇故事' : 'AI 自动生成世界观、大纲和角色')}
                </DialogDescription>
              </DialogHeader>

              {/* ===== 阶段 1：表单 ===== */}
              {!quickGuiding && (
                <div className="space-y-4">
                  {/* 类型切换 + 模型选择 */}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={quickType === 'novel' ? 'default' : 'outline'} onClick={() => setQuickType('novel')} disabled={quickGenerating}>长篇</Button>
                    <Button size="sm" variant={quickType === 'short' ? 'default' : 'outline'} onClick={() => setQuickType('short')} disabled={quickGenerating}>短篇</Button>
                    <div className="flex-1" />
                    <ModelSelector
                      usage="chat"
                      value={quickModel}
                      onChange={(model) => setQuickModel(model)}
                      className="text-xs rounded border border-border bg-background px-2 py-1"
                    />
                  </div>

                  {/* 短篇模板 */}
                  {quickType === 'short' && (
                    <div className="space-y-2">
                      <Label className="text-xs">套模板</Label>
                      <div className="grid grid-cols-3 gap-2">
                        {SHORT_TEMPLATES.map((tpl) => (
                          <Button key={tpl.key} size="xs" variant="outline"
                            disabled={quickGenerating}
                            onClick={() => setQuickPremise(tpl.prompt)}>
                            {tpl.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 脑洞输入 */}
                  <div className="space-y-2">
                    <Label htmlFor="premise">{quickType === 'short' ? '脑洞 / 想法' : '题材 / 想法'}</Label>
                    <textarea
                      id="premise"
                      placeholder={quickType === 'short' ? '简单描述你的想法，AI 帮你完善...' : '例如：我想写一本末世公路求生小说...'}
                      value={quickPremise}
                      onChange={(e) => setQuickPremise(e.target.value)}
                      rows={quickType === 'short' ? 3 : 4}
                      disabled={quickGenerating}
                      className="w-full rounded border border-border bg-background px-3 py-2 text-sm resize-none"
                    />
                  </div>

                  {/* 进度 */}
                  {quickGenerating && (
                    <div className="space-y-2">
                      {quickSteps.map((s) => (
                        <div key={s.step} className="flex items-center gap-2 text-xs">
                          {s.status === "done" ? (
                            <Check className="size-3 text-green-500" />
                          ) : (
                            <Loader2 className="size-3 animate-spin text-primary" />
                          )}
                          <div>
                            <span className={s.status === "done" ? "text-muted-foreground" : "text-foreground"}>
                              {s.label}
                            </span>
                            {s.preview && (
                              <p className="text-[10px] text-muted-foreground mt-0.5 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                                {s.preview}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                      {quickSteps.length === 0 && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" />
                          正在准备...
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={resetQuickDialog}
                      disabled={quickGenerating}
                    >
                      取消
                    </Button>
                    {quickType === 'short' && (
                      <Button variant="outline" disabled={quickGenerating}
                        onClick={() => {
                          const ideas = [
                            '我是一个死刑犯，临刑前收到一条短信：「你的死刑已延期」——发件人是三年前的自己。',
                            '全城的人突然同时做了一个相同的梦，梦里有人在教他们唱一首歌。只有我没做梦。',
                            '我的影子开始不听使唤，它会在我睡着时自己出门，第二天身上多了来历不明的伤疤。',
                            '我继承了一家只在午夜营业的书店，每个顾客都来自不同的时代。',
                            '地球停转了三秒，所有人失忆了那三秒的内容——但我用相机拍到了。',
                          ];
                          setQuickPremise(ideas[Math.floor(Math.random() * ideas.length)]);
                        }}>
                        <Sparkles className="size-3 mr-1" />随机灵感
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => {
                      if (!quickPremise.trim()) { toast({ title: "请先输入想法", variant: "destructive" }); return; }
                      setQuickGuiding(true);
                      guideGotContent.current = false;
                      // 自动发送第一条引导消息
                      const initMsg = `我想写一个故事，我的想法是：${quickPremise}`;
                      setQuickGuideMsgs([{ role: "user", content: initMsg }]);
                      setQuickGuideLoading(true);
                      const token = localStorage.getItem("token");
                      fetch("/api/ai/chat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({
                          book_id: "",
                          context_type: "write",
                          model: quickModel,
                          message: initMsg,
                          messages: [{ role: "user", content: initMsg }],
                          guide_mode: true,
                          guide_context: quickPremise,
                          guide_type: quickType,
                        }),
                        signal: AbortSignal.timeout(120000),
                      }).then(async (res) => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const reader = res.body?.getReader();
                        if (!reader) throw new Error("无响应");
                        const decoder = new TextDecoder();
                        let buf = "", ac = "";
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) { buf += decoder.decode(); break; }
                          buf += decoder.decode(value, { stream: true });
                          const lines = buf.split("\n"); buf = lines.pop() ?? "";
                          let ev = "";
                          for (const line of lines) {
                            if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
                            if (line.startsWith("data: ")) {
                              try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
                            }
                          }
                          if (ac) {
                            guideGotContent.current = true;
                            setQuickGuideMsgs([{ role: "user", content: initMsg }, { role: "assistant", content: ac }]);
                          }
                        }
                      }).catch((err) => {
                        toast({ title: err?.message || "请求失败", variant: "destructive" });
                        setQuickGuiding(false);
                      }).finally(() => {
                        setQuickGuideLoading(false);
                        if (!guideGotContent.current) {
                          setQuickGuideMsgs((prev) => [
                            ...prev,
                            { role: "assistant", content: "（AI 未响应，请重试）" },
                          ]);
                        }
                      });
                    }} disabled={quickGenerating || !quickPremise.trim()}>
                      <Sparkles className="size-4 mr-1" />AI 引导
                    </Button>
                    <Button onClick={() => doQuickCreate(quickPremise, quickType)} disabled={quickGenerating || !quickPremise.trim()}>
                      {quickGenerating && <Loader2 className="size-4 animate-spin mr-1" />}
                      {quickGenerating ? "生成中..." : "直接生成"}
                    </Button>
                  </div>
                </div>
              )}

              {/* ===== 阶段 2：引导聊天 ===== */}
              {quickGuiding && (
                <>
                  <div ref={guideChatRef} onScroll={handleGuideScroll} className="flex-1 overflow-y-auto space-y-3 min-h-0 border rounded-lg p-3 bg-muted/20">
                    {quickGuideMsgs.map((m, i) => (
                      <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                        <div className={cn(
                          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                          m.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card border border-border text-foreground",
                        )}>
                          {m.content || (i === quickGuideMsgs.length - 1 && quickGuideLoading ? "思考中..." : "")}
                        </div>
                      </div>
                    ))}
                    {quickGuideLoading && quickGuideMsgs[quickGuideMsgs.length - 1]?.role === "user" && (
                      <div className="flex justify-start">
                        <div className="bg-card border border-border rounded-lg px-3 py-2 text-sm text-muted-foreground">
                          <Loader2 className="size-3 animate-spin inline mr-1" />思考中...
                        </div>
                      </div>
                    )}
                  </div>
                  {/* 引导输入 + 操作 */}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={quickGuideInput}
                      onChange={(e) => {
                        setQuickGuideInput(e.target.value);
                        const el = e.target;
                        el.style.height = "auto";
                        el.style.height = Math.min(el.scrollHeight, 96) + "px";
                      }}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendGuideMsg(); } }}
                      placeholder="回复 AI 的问题... Shift+Enter 换行"
                      disabled={quickGuideLoading}
                      rows={3}
                      className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm resize-none"
                    />
                    <Button size="sm" onClick={sendGuideMsg} disabled={quickGuideLoading || !quickGuideInput.trim()}>
                      <Send className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={async () => {
                      // 先向 AI 发送"开始生成"，获取结构化创作摘要
                      setQuickGuideLoading(true);
                      const finalMsg = "开始生成，请输出创作摘要";
                      const finalMsgs = [...quickGuideMsgs, { role: "user", content: finalMsg }];
                      setQuickGuideMsgs(finalMsgs);
                      const token = localStorage.getItem("token");
                      let summary = "";
                      try {
                        const res = await fetch("/api/ai/chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                            book_id: "",
                            context_type: "write",
                            model: quickModel,
                            message: finalMsg,
                            messages: finalMsgs.map(m => ({ role: m.role, content: m.content })),
                            guide_mode: true,
                            guide_context: quickPremise,
                            guide_type: quickType,
                          }),
                          signal: AbortSignal.timeout(120000),
                        });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const reader = res.body?.getReader();
                        if (!reader) throw new Error("无响应");
                        const decoder = new TextDecoder();
                        let buf = "", ac = "";
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) { buf += decoder.decode(); break; }
                          buf += decoder.decode(value, { stream: true });
                          const lines = buf.split("\n"); buf = lines.pop() ?? "";
                          let ev = "";
                          for (const line of lines) {
                            if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
                            if (line.startsWith("data: ")) {
                              try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
                            }
                          }
                          if (ac) {
                            setQuickGuideMsgs([...finalMsgs, { role: "assistant", content: ac }]);
                          }
                        }
                        if (!ac) {
                          setQuickGuideMsgs([...finalMsgs, { role: "assistant", content: "（AI 未响应，请重试）" }]);
                        }
                        summary = ac;
                      } catch (err: any) {
                        toast({ title: "获取摘要失败: " + (err?.message || "未知错误"), variant: "destructive" });
                        setQuickGuideLoading(false);
                        return;
                      }
                      setQuickGuideLoading(false);
                      setQuickGuiding(false);
                      // 构建完整对话日志作为参考附录
                      const fullLog = quickGuideMsgs
                        .filter(m => m.role === "user" || m.role === "assistant")
                        .map(m => `${m.role === "user" ? "作者" : "AI"}: ${m.content}`)
                        .join("\n");
                      doQuickCreate(quickPremise, quickType, summary, fullLog);
                    }} disabled={quickGuideLoading || quickGuideMsgs.length === 0}>
                      开始生成
                    </Button>
                  </div>
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 加载骨架 */}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!isLoading && books.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BookOpen className="size-12" />
          <p className="mt-4 text-sm">
            {showDeleted ? "回收站为空" : "还没有作品，点击「新建作品」开始"}
          </p>
        </div>
      )}

      {/* 作品卡片列表 */}
      {!isLoading && books.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {books.map((book) => (
            <Card
              key={book.book_id}
              className={cn(
                "group cursor-pointer transition-shadow hover:shadow-md",
                showDeleted && "opacity-60"
              )}
              onClick={() => {
                if (!showDeleted) {
                  navigate(`/books/${book.book_id}`);
                }
              }}
            >
              <CardContent className="p-4">
                <div className="mb-2 flex items-start justify-between">
                  <h3 className="font-medium text-foreground truncate">{book.title}</h3>
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {STATUS_LABELS[book.status] ?? book.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {book.word_count.toLocaleString()} 字 ·{" "}
                  {new Date(book.last_updated).toLocaleDateString("zh-CN")}
                </p>
                <div className={`mt-3 flex gap-1 transition-opacity ${showDeleted ? "" : "opacity-0 group-hover:opacity-100"}`}>
                  {showDeleted ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          restoreBook.mutate(book.book_id);
                        }}
                      >
                        <Undo2 className="size-3" />
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm("确定彻底删除？此操作不可撤销。")) {
                            permanentDeleteBook.mutate(book.book_id);
                          }
                        }}
                      >
                        <Trash2 className="size-3" />
                        彻底删除
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`确定删除「${book.title}」？7 天内可恢复。`)) {
                          deleteBook.mutate(book.book_id);
                        }
                      }}
                    >
                      <Trash2 className="size-3" />
                      删除
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
