import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, authFetch } from "@/services/api";
import type { ChapterDetail } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TiptapEditor } from "./TiptapEditor";
import { useToast } from "@/hooks/use-toast";
import { useThrottle } from "@/hooks/use-throttle";
import { useEditorStore } from "@/stores/editor";
import {
  Plus,
  FileText,
  Loader2,
  PanelLeftOpen,
  PanelLeftClose,
  Target,
  Sparkles,
  Video,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PromoVideoDialog } from "@/components/promo/PromoVideoDialog";
import { ZhihuPackDialog } from "@/components/zhihu/ZhihuPackDialog";
import { PlotThreadsEditor } from "@/components/settings/PlotThreadsEditor";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface Props {
  bookId: string;
  bookType?: string;
}

export function WritingEditor({ bookId, bookType }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // 章节列表
  const { data: chapterList, isLoading: listLoading } = useQuery({
    queryKey: ["chapters", bookId],
    queryFn: () =>
      api.get<{ data: { chapter_id: string; title: string; sort_order: number; word_count: number; updated_at: string }[] }>(`/books/${bookId}/chapters`),
  });

  const chapters = chapterList?.data ?? [];
  // 短篇无章节概念：自动选中唯一章节，隐藏章节列表侧栏
  const isShort = bookType === "short";
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);

  // 刚删除的章节 id：列表刷新前会短暂残留，自动选中需跳过它
  const lastDeletedIdRef = useRef<string | null>(null);

  // 无选中章节时自动选中第一章（长篇空书直接生成也能落进编辑器；短篇同逻辑）
  useEffect(() => {
    if (!activeChapterId && chapters.length > 0) {
      if (
        lastDeletedIdRef.current &&
        chapters.length === 1 &&
        chapters[0].chapter_id === lastDeletedIdRef.current
      ) {
        return; // 仅剩的章节是刚删的那条，等列表刷新
      }
      setActiveChapterId(chapters[0].chapter_id);
    }
  }, [activeChapterId, chapters]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    typeof window !== 'undefined' && window.innerWidth < 768,
  );
  const [promoOpen, setPromoOpen] = useState(false);
  const [zhihuOpen, setZhihuOpen] = useState(false);
  const selectedText = useEditorStore((s) => s.selectedText);

  // 当前章节内容
  const { data: chapterData, isLoading: chapterLoading } = useQuery({
    queryKey: ["chapter", bookId, activeChapterId],
    queryFn: () =>
      api.get<{ data: ChapterDetail }>(`/books/${bookId}/chapters/${activeChapterId}`),
    enabled: !!activeChapterId,
  });

  const chapter = chapterData?.data;
  const [editorContent, setEditorContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [boundNodeId, setBoundNodeId] = useState<string | null>(null);
  const [extendingOutlines, setExtendingOutlines] = useState(false);
  const [generatingChapter, setGeneratingChapter] = useState(false);
  const [plotOpen, setPlotOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ chapter_id: string; title: string } | null>(null);

  // 最新值 ref：供卸载/页面隐藏兜底保存与同步守卫读取，避免闭包过期
  const editorContentRef = useRef(editorContent);
  editorContentRef.current = editorContent;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const boundNodeIdRef = useRef(boundNodeId);
  boundNodeIdRef.current = boundNodeId;
  const activeChapterIdRef = useRef(activeChapterId);
  activeChapterIdRef.current = activeChapterId;
  const savePendingRef = useRef(false);

  // 今日码字进度
  const { data: statsData } = useQuery({
    queryKey: ["stats", bookId],
    queryFn: () => api.get<{ data: { todayWords: number; streak: number } }>(`/books/${bookId}/stats`),
    refetchInterval: 60000,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () => api.get<{ data: { daily_word_goal?: number; extra?: any } }>(`/books/${bookId}/settings`),
  });
  const todayWords = statsData?.data?.todayWords ?? 0;
  const dailyGoal = settingsData?.data?.daily_word_goal ?? (settingsData?.data?.extra as any)?.daily_word_goal ?? 0;
  // 章纲（快捷创作首批 10 章，可续生）：当前章号超出已有章纲时提示续生
  const chapterOutlines = (settingsData?.data?.extra as any)?.chapter_outlines as string[] | undefined;
  const chapterOutlinesCount = chapterOutlines?.length ?? 0;
  const curSort = chapters.find((c) => c.chapter_id === activeChapterId)?.sort_order ?? null;
  const goalProgress = dailyGoal > 0 ? Math.min(todayWords / dailyGoal, 1) : 0;
  // 短篇"故事走向"卡片:选中的梗概(写作对照)
  const outlinePreview = (settingsData?.data?.extra as any)?.outline_preview as
    | string
    | undefined;
  const [outlineExpanded, setOutlineExpanded] = useState(false);

  // 大纲节点列表（用于绑定选择）
  const { data: outlineData } = useQuery({
    queryKey: ["outline", bookId],
    queryFn: () =>
      api.get<{ data: { chapters: { id: string; title: string; summary: string; status: string }[] } }>(`/books/${bookId}/outline`),
    enabled: !!bookId,
  });
  const outlineNodes = outlineData?.data?.chapters ?? [];

  const storeSetActive = useEditorStore((s) => s.setActiveChapter);

  // 章节数据到达后同步到编辑器
  useEffect(() => {
    if (chapterData?.data && chapterData.data.chapter_id === activeChapterId) {
      // 有未保存的本地修改时不覆盖：自动保存后的 refetch 可能带回旧内容
      if (isDirtyRef.current) return;
      setEditorContent(chapterData.data.content);
      setBoundNodeId(chapterData.data.bound_outline_node_id ?? null);
      setIsDirty(false);
    }
  }, [chapterData, activeChapterId]);

  useEffect(() => {
    if (activeChapterId) storeSetActive(activeChapterId);
  }, [activeChapterId, storeSetActive]);

  // AI 面板自动建章/切章：一次性请求，消费后立即清除——不会与本地选中互相
  // 触发造成 setState 循环（此前双向同步 effect 在点击章节时引发无限更新）
  const chapterSwitch = useEditorStore((s) => s.chapterSwitch);
  const clearChapterSwitch = useEditorStore((s) => s.clearChapterSwitch);
  useEffect(() => {
    if (!chapterSwitch) return;
    if (chapterSwitch.chapterId === activeChapterId) {
      clearChapterSwitch();
      return;
    }
    // 超时丢弃：编辑器长时间未就绪视为失效
    if (Date.now() - chapterSwitch.at > 5000) {
      clearChapterSwitch();
      return;
    }
    setActiveChapterId(chapterSwitch.chapterId);
    clearChapterSwitch();
  }, [chapterSwitch, activeChapterId, clearChapterSwitch]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put(`/books/${bookId}/chapters/${activeChapterId}`, {
        content: editorContent,
        word_count: editorContent.length,
        bound_outline_node_id: boundNodeId,
      }),
    onMutate: () => {
      savePendingRef.current = true;
    },
    onSuccess: () => {
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      // 失效本章节缓存：否则切走后 5 分钟内切回会读到保存前的旧内容
      queryClient.invalidateQueries({ queryKey: ["chapter", bookId, activeChapterId] });
    },
    onError: () => {
      toast({ title: "保存失败", variant: "destructive" });
    },
    onSettled: () => {
      savePendingRef.current = false;
    },
  });

  const createChapterMutation = useMutation({
    mutationFn: (title: string) =>
      api.post(`/books/${bookId}/chapters`, { title }),
    onSuccess: (res: { data: { chapter_id: string } }) => {
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      setActiveChapterId(res.data.chapter_id);
      toast({ title: "新章节已创建" });
    },
  });

  // 删除章节：仅限长篇（短篇唯一正文章不可删）；删除当前章则清编辑器并选剩余章节
  const deleteChapterMutation = useMutation({
    mutationFn: (chapterId: string) =>
      api.delete(`/books/${bookId}/chapters/${chapterId}`),
    onSuccess: (_res: any, chapterId: string) => {
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      lastDeletedIdRef.current = chapterId;
      if (activeChapterId === chapterId) {
        // 显式清掉已删章节的残留内容，再选定剩余章节（不依赖自动选中，
        // 避免列表未刷新时选中已删章节）
        setEditorContent("");
        setIsDirty(false);
        const remaining = chapters.find((c) => c.chapter_id !== chapterId);
        if (remaining) {
          setActiveChapterId(remaining.chapter_id);
        } else {
          setActiveChapterId(null);
          useEditorStore.getState().setActiveChapter(null);
        }
      }
      toast({ title: "章节已删除" });
    },
    onError: () => {
      toast({ title: "删除失败", variant: "destructive" });
    },
  });

  const handleDeleteChapter = (ch: { chapter_id: string; title: string }) => {
    if (isShort) return;
    setDeleteTarget(ch);
  };

  // 整章生成：按章纲写完整一章（追加到章末），服务端单轮为主、字数不足补写
  const generateWholeChapter = async () => {
    if (!activeChapterId || generatingChapter) return;
    setGeneratingChapter(true);
    const controller = new AbortController();
    const token = localStorage.getItem("token");
    try {
      const res = await authFetch(
        "/api/ai/generate-chapter",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ book_id: bookId, chapter_id: activeChapterId }),
          signal: controller.signal,
        },
        20 * 60_000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("无响应");
      const decoder = new TextDecoder();
      let buf = "";
      let warnings: string[] = [];
      let quality: { count: number; types: string[] } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buf += decoder.decode(); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        let ev = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (ev === "done") {
              warnings = data.warnings ?? [];
              quality = data.quality ?? null;
            }
            if (ev === "error") {
              throw new Error(data.message || "生成失败");
            }
          } catch (err: any) {
            if (ev === "error") {
              throw err instanceof Error ? err : new Error("生成失败");
            }
          }
        }
      }
      queryClient.invalidateQueries({ queryKey: ["chapter", bookId, activeChapterId] });
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      if (warnings.length) {
        toast({ title: warnings[0], variant: "destructive" });
      }
      if (quality) {
        toast({ title: `AI 味提示（${quality.count} 处）：${quality.types.slice(0, 3).join("、")}` });
      }
      toast({ title: "本章已生成" });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast({ title: err?.message || "生成失败", variant: "destructive" });
      }
    } finally {
      setGeneratingChapter(false);
    }
  };

  // 自动保存：内容变化停止 2 秒后静默保存
  const AUTOSAVE_DEBOUNCE_MS = 2000;
  useEffect(() => {
    if (!isDirty || !activeChapterId) return;
    const timer = setTimeout(() => {
      if (!savePendingRef.current) saveMutation.mutate();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorContent, isDirty, activeChapterId]);

  // 页面隐藏/关闭/组件卸载时兜底保存（切 tab、刷新、关页均覆盖）
  useEffect(() => {
    const flush = () => {
      const id = activeChapterIdRef.current;
      if (!id || !isDirtyRef.current) return;
      const token = localStorage.getItem("token");
      // keepalive：页面卸载时请求仍能发出；注意浏览器对 keepalive body 有
      // 64KB 限制，超大章节关页时可能被丢弃（2 秒防抖自动保存已兜底绝大部分）
      authFetch(`/api/books/${bookId}/chapters/${id}`, {
        method: "PUT",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          content: editorContentRef.current,
          word_count: editorContentRef.current.length,
          bound_outline_node_id: boundNodeIdRef.current,
        }),
      }).catch(() => {});
      setIsDirty(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      flush(); // 组件卸载（切 tab/返回列表）时最后保存一次
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  const newChapter = useThrottle(async () => {
    if (createChapterMutation.isPending) return;
    if (isDirty && activeChapterId) {
      if (!confirm("有未保存的内容，是否保存？")) return;
      try {
        await saveMutation.mutateAsync();
      } catch {
        toast({ title: "保存失败，已取消新建章节", variant: "destructive" });
        return;
      }
    }
    createChapterMutation.mutate(`第${chapters.length + 1}章`);
  });

  const selectChapter = async (id: string) => {
    if (id === activeChapterId) return;
    if (isDirty && activeChapterId) {
      const ok = confirm("有未保存的内容，是否保存？");
      if (ok) {
        try {
          // 等待保存完成再切换，失败则停留在当前章节，避免内容丢失
          await saveMutation.mutateAsync();
        } catch {
          toast({ title: "保存失败，已取消切换章节", variant: "destructive" });
          return;
        }
      } else {
        return;
      }
    }
    setEditorContent("");
    setActiveChapterId(id);
  };

  return (
    <div className="flex h-full min-h-0 gap-0 min-w-0 overflow-hidden">
      {/* 左侧章节列表（短篇无章节概念，不渲染） */}
      {!isShort && <div
        className={cn(
          "border-r border-border bg-card flex flex-col transition-all z-10",
          "max-md:fixed max-md:left-0 max-md:top-0 max-md:h-full max-md:shadow-xl",
          sidebarCollapsed ? "w-0 overflow-hidden border-0" : "w-44"
        )}
      >
        <div className="flex items-center justify-between p-3 border-b border-border">
          <div className="flex items-center gap-1">
            {!sidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="md:hidden"
                onClick={() => setSidebarCollapsed(true)}
                title="收起章节列表"
              >
                <PanelLeftClose className="size-4" />
              </Button>
            )}
            {!sidebarCollapsed && (
              <p className="text-sm font-medium text-foreground">章节</p>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {!sidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={newChapter}
                disabled={createChapterMutation.isPending}
                title="新建章节"
              >
                <Plus className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {!sidebarCollapsed && (
          <>
            <ScrollArea className="flex-1">
              {listLoading && (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              )}
              {chapters.map((ch) => (
                <div
                  key={ch.chapter_id}
                  className={cn(
                    "group flex items-center gap-1 px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors cursor-pointer",
                    activeChapterId === ch.chapter_id && "bg-muted font-medium text-foreground",
                    activeChapterId !== ch.chapter_id && "text-muted-foreground",
                  )}
                >
                  <button onClick={() => selectChapter(ch.chapter_id)} className="flex-1 text-left min-w-0">
                    <div className="truncate">{ch.title}</div>
                    <div className="text-xs text-muted-foreground">{ch.word_count.toLocaleString()} 字</div>
                  </button>
                  {!isShort && (
                    <button
                      onClick={() => handleDeleteChapter(ch)}
                      className="shrink-0 p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-opacity"
                      title="删除章节"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {chapters.length === 0 && !listLoading && (
                <p className="px-3 py-8 text-xs text-muted-foreground text-center">
                  还没有章节
                </p>
              )}
            </ScrollArea>
          </>
        )}
      </div>}

      {/* 中间编辑器 + AI 面板 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            {chapter ? (
              <div className="flex items-center gap-2">
                {!isShort && (
                  <button className="p-0.5 -ml-1" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title="章节列表">
                    {sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                  </button>
                )}
                <FileText className="size-4 text-muted-foreground hidden sm:block" />
                <span className="text-sm font-medium text-foreground">{chapter.title}</span>
                <Badge variant="secondary" className="text-xs">
                  {chapter.word_count.toLocaleString()} 字
                </Badge>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {!isShort && (
                  <button className="p-0.5 -ml-1" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title="章节列表">
                    {sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                  </button>
                )}
                <p className="text-sm text-muted-foreground">选择一个章节开始写作</p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {dailyGoal > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`今日 ${todayWords.toLocaleString()} / ${dailyGoal.toLocaleString()}`}>
                <Target className="size-3.5" />
                <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${goalProgress >= 1 ? 'bg-green-500' : 'bg-primary'}`}
                    style={{ width: `${goalProgress * 100}%` }} />
                </div>
                <span>{Math.round(goalProgress * 100)}%</span>
              </div>
            )}
            {activeChapterId && outlineNodes.length > 0 && (
              <select
                value={boundNodeId ?? ""}
                onChange={(e) => {
                  setBoundNodeId(e.target.value || null);
                  // 绑定变更也是修改：标记脏触发自动保存，否则切换章节后绑定丢失
                  setIsDirty(true);
                }}
                className="text-xs rounded border border-border bg-background px-2 py-1 text-foreground max-w-40"
                title="关联大纲节点"
              >
                <option value="">无关联大纲</option>
                {outlineNodes.map((n: any) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            )}
            {!isShort && (chapterOutlinesCount === 0 || (curSort != null && curSort > chapterOutlinesCount)) && (
              <Button
                size="xs"
                variant="outline"
                disabled={extendingOutlines}
                title="生成/续生下一批 10 章章纲（承接卷纲与已写章节）"
                onClick={async () => {
                  setExtendingOutlines(true);
                  try {
                    const t = localStorage.getItem("token");
                    const r = await authFetch("/api/ai/chapter-outlines/extend", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${t}`,
                      },
                      body: JSON.stringify({ book_id: bookId }),
                    });
                    const j = await r.json();
                    if (r.ok && j.code === 200 && j.data?.lines?.length) {
                      queryClient.invalidateQueries({ queryKey: ["book-settings", bookId] });
                      toast({ title: `已生成第 ${j.data.startNo}-${j.data.startNo + j.data.lines.length - 1} 章章纲` });
                    } else {
                      toast({ title: j.message || "生成失败", variant: "destructive" });
                    }
                  } catch {
                    toast({ title: "续生失败", variant: "destructive" });
                  } finally {
                    setExtendingOutlines(false);
                  }
                }}
              >
                {extendingOutlines
                  ? "生成中..."
                  : chapterOutlinesCount === 0
                    ? "生成章纲"
                    : `续生章纲（第 ${chapterOutlinesCount + 1} 章起）`}
              </Button>
            )}
            {!isShort && activeChapterId && (
              <Button
                size="xs"
                disabled={generatingChapter}
                title="按章纲生成完整一章（追加到章末，不覆盖已有内容）"
                onClick={generateWholeChapter}
              >
                {generatingChapter ? "生成中..." : "生成本章"}
              </Button>
            )}
            {!isShort && (
              <Button
                size="xs"
                variant="outline"
                title="管理伏笔（登记/回收/删除）"
                onClick={() => setPlotOpen(true)}
              >
                伏笔
              </Button>
            )}
            {isDirty && <span className="text-xs text-muted-foreground">未保存</span>}
            {bookType === 'short' && activeChapterId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setZhihuOpen(true)}
                title="生成知乎体标题和抓人开篇"
              >
                <Sparkles className="size-4 mr-1" />
                知乎包装
              </Button>
            )}
            {selectedText && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPromoOpen(true)}
                title="用选中文字生成推文视频"
              >
                <Video className="size-4 mr-1" />
                推文视频
              </Button>
            )}
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!isDirty || saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="size-4 animate-spin" />}保存
            </Button>
          </div>
        </div>

        {/* 短篇"故事走向"卡片:梗概对照,默认折叠(写作时抬眼即可对照) */}
        {isShort && outlinePreview && (
          <div className="border-b border-border">
            <button
              className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-muted/50"
              onClick={() => setOutlineExpanded(!outlineExpanded)}
            >
              <span className="text-xs font-medium text-muted-foreground">故事走向</span>
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  outlineExpanded && "rotate-180",
                )}
              />
            </button>
            {outlineExpanded && (
              <p className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                {outlinePreview}
              </p>
            )}
          </div>
        )}

        {/* 编辑器 */}
        {!activeChapterId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FileText className="size-12 mx-auto" />
              <p className="mt-4 text-sm">选择或创建一个章节开始写作，右侧 AI 助手可帮你续写</p>
            </div>
          </div>
        ) : chapterLoading ? (
          <div className="flex-1 p-6">
            <Skeleton className="h-full w-full" />
          </div>
        ) : (
          <TiptapEditor
            key={activeChapterId}
            content={editorContent}
            onChange={(text) => {
              setEditorContent(text);
              setIsDirty(true);
            }}
            placeholder="开始写作..."
          />
        )}
      </div>


      <Dialog open={plotOpen} onOpenChange={setPlotOpen}>
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>伏笔账本</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <PlotThreadsEditor bookId={bookId} />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="删除章节"
        description={`确定删除《${deleteTarget?.title ?? ""}》？正文内容将一并删除，无法恢复。`}
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (deleteTarget) deleteChapterMutation.mutate(deleteTarget.chapter_id);
          setDeleteTarget(null);
        }}
      />

      <PromoVideoDialog bookId={bookId} open={promoOpen} onOpenChange={setPromoOpen} />
      <ZhihuPackDialog
        bookId={bookId}
        content={editorContent}
        open={zhihuOpen}
        onOpenChange={setZhihuOpen}
        onApplyOpening={(opening) => {
          // 替换章节前 500 字为改写开篇
          setEditorContent(opening + '\n\n' + editorContent.slice(500));
          setIsDirty(true);
        }}
      />
    </div>
  );
}
