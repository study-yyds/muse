import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PromoVideoDialog } from "@/components/promo/PromoVideoDialog";

interface Props {
  bookId: string;
}

export function WritingEditor({ bookId }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // 章节列表
  const { data: chapterList, isLoading: listLoading } = useQuery({
    queryKey: ["chapters", bookId],
    queryFn: () =>
      api.get<{ data: { chapter_id: string; title: string; sort_order: number; word_count: number; updated_at: string }[] }>(`/books/${bookId}/chapters`),
  });

  const chapters = chapterList?.data ?? [];
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    typeof window !== 'undefined' && window.innerWidth < 768,
  );
  const [promoOpen, setPromoOpen] = useState(false);
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
  const goalProgress = dailyGoal > 0 ? Math.min(todayWords / dailyGoal, 1) : 0;

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
      setEditorContent(chapterData.data.content);
      setBoundNodeId(chapterData.data.bound_outline_node_id ?? null);
      setIsDirty(false);
    }
  }, [chapterData, activeChapterId]);

  useEffect(() => {
    if (activeChapterId) storeSetActive(activeChapterId);
  }, [activeChapterId, storeSetActive]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put(`/books/${bookId}/chapters/${activeChapterId}`, {
        content: editorContent,
        word_count: editorContent.length,
        bound_outline_node_id: boundNodeId,
      }),
    onSuccess: () => {
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      toast({ title: "已保存" });
    },
    onError: () => {
      toast({ title: "保存失败", variant: "destructive" });
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

  const newChapter = useThrottle(() => {
    if (createChapterMutation.isPending) return;
    if (isDirty && activeChapterId) {
      if (!confirm("有未保存的内容，是否保存？")) return;
      saveMutation.mutate();
    }
    createChapterMutation.mutate(`第${chapters.length + 1}章`);
  });

  const selectChapter = (id: string) => {
    if (id === activeChapterId) return;
    if (isDirty && activeChapterId) {
      const ok = confirm("有未保存的内容，是否保存？");
      if (ok) saveMutation.mutate();
      else return;
    }
    setEditorContent("");
    setActiveChapterId(id);
  };

  return (
    <div className="flex h-full min-h-0 gap-0 min-w-0 overflow-hidden">
      {/* 左侧章节列表 */}
      <div
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
                    "flex items-center gap-1 px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors cursor-pointer",
                    activeChapterId === ch.chapter_id && "bg-muted font-medium text-foreground",
                    activeChapterId !== ch.chapter_id && "text-muted-foreground",
                  )}
                >
                  <button onClick={() => selectChapter(ch.chapter_id)} className="flex-1 text-left min-w-0">
                    <div className="truncate">{ch.title}</div>
                    <div className="text-xs text-muted-foreground">{ch.word_count.toLocaleString()} 字</div>
                  </button>
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
      </div>

      {/* 中间编辑器 + AI 面板 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            {chapter ? (
              <div className="flex items-center gap-2">
                <button className="p-0.5 -ml-1" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title="章节列表">
                  {sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>
                <FileText className="size-4 text-muted-foreground hidden sm:block" />
                <span className="text-sm font-medium text-foreground">{chapter.title}</span>
                <Badge variant="secondary" className="text-xs">
                  {chapter.word_count.toLocaleString()} 字
                </Badge>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button className="p-0.5 -ml-1" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title="章节列表">
                  {sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>
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
                onChange={(e) => setBoundNodeId(e.target.value || null)}
                className="text-xs rounded border border-border bg-background px-2 py-1 text-foreground max-w-[160px]"
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
            {isDirty && <span className="text-xs text-muted-foreground">未保存</span>}
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


      <PromoVideoDialog bookId={bookId} open={promoOpen} onOpenChange={setPromoOpen} />
    </div>
  );
}
