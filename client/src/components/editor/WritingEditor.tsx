import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { ChapterDetail } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useEditorStore } from "@/stores/editor";
import {
  Plus,
  FileText,
  Loader2,
  ChevronDown,
  ChevronRight,
  Eye,
  Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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

  const setContent = useEditorStore((s) => s.setContent);
  const setCursor = useEditorStore((s) => s.setCursor);
  const storeSetActive = useEditorStore((s) => s.setActiveChapter);

  // 章节数据到达后同步到编辑器
  useEffect(() => {
    if (chapterData?.data && chapterData.data.chapter_id === activeChapterId) {
      setEditorContent(chapterData.data.content);
      setIsDirty(false);
    }
  }, [chapterData, activeChapterId]);

  // 同步编辑器状态到全局 store（供 AI 面板使用）
  useEffect(() => {
    setContent(editorContent);
  }, [editorContent, setContent]);

  useEffect(() => {
    if (activeChapterId) storeSetActive(activeChapterId);
  }, [activeChapterId, storeSetActive]);

  // AI 面板请求插入/替换文本
  const pendingInsert = useEditorStore((s) => s.pendingInsert);
  const pendingReplace = useEditorStore((s) => s.pendingReplace);
  const clearPendingInsert = useEditorStore((s) => s.clearPendingInsert);
  useEffect(() => {
    if (pendingReplace) {
      // 按精确位置替换，避免文本多处匹配时替换错误
      setEditorContent((prev) => {
        const { start, end, newText } = pendingReplace;
        return prev.slice(0, start) + newText + prev.slice(end);
      });
      setIsDirty(true);
      clearPendingInsert();
    } else if (pendingInsert != null) {
      setEditorContent((prev) => {
        const pos = useEditorStore.getState().cursorPosition;
        return prev.slice(0, pos) + pendingInsert + prev.slice(pos);
      });
      setIsDirty(true);
      clearPendingInsert();
    }
  }, [pendingInsert, pendingReplace]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put(`/books/${bookId}/chapters/${activeChapterId}`, {
        content: editorContent,
        word_count: editorContent.length,
      }),
    onSuccess: () => {
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      toast({ title: "已保存" });
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

  // 多选（合并用）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const mergeMutation = useMutation({
    mutationFn: (body: { ids: string[]; title: string }) =>
      api.post(`/books/${bookId}/chapters/merge`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      setSelectedIds(new Set());
      toast({ title: "已合并" });
    },
  });

  const splitMutation = useMutation({
    mutationFn: (chapterId: string) =>
      api.post(`/books/${bookId}/chapters/${chapterId}/split`, { split_at: Math.floor(editorContent.length / 2) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["chapter", bookId, activeChapterId] });
      toast({ title: "已拆分" });
    },
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const doMerge = () => {
    const ids = Array.from(selectedIds);
    if (ids.length < 2) return;
    const names = chapters.filter((c) => ids.includes(c.chapter_id)).map((c) => c.title);
    const newTitle = prompt("合并后的章节名", names.join(" + "));
    if (newTitle) mergeMutation.mutate({ ids, title: newTitle });
  };

  const newChapter = () => {
    createChapterMutation.mutate(`第${chapters.length + 1}章`);
  };

  const selectChapter = (id: string) => {
    if (isDirty && activeChapterId) {
      if (confirm("有未保存的内容，是否保存？")) {
        saveMutation.mutate();
      }
    }
    setActiveChapterId(id);
  };

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* 左侧章节列表 */}
      <div
        className={cn(
          "border-r border-border bg-card flex flex-col transition-all",
          sidebarCollapsed ? "w-12" : "w-56"
        )}
      >
        <div className="flex items-center justify-between p-3 border-b border-border">
          {!sidebarCollapsed && (
            <p className="text-sm font-medium text-foreground">章节</p>
          )}
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
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {sidebarCollapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </Button>
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
                  <input
                    type="checkbox"
                    checked={selectedIds.has(ch.chapter_id)}
                    onChange={() => toggleSelect(ch.chapter_id)}
                    className="size-3 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  />
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
            {selectedIds.size >= 2 && (
              <div className="px-2 py-1">
                <Button size="xs" variant="outline" className="w-full" onClick={doMerge}>
                  合并选中 ({selectedIds.size} 章)
                </Button>
              </div>
            )}
            {activeChapterId && (
              <div className="px-2 py-1">
                <Button size="xs" variant="outline" className="w-full" onClick={() => { if (confirm("在中间拆分？")) splitMutation.mutate(activeChapterId); }}>
                  拆分当前章
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 中间编辑器 + AI 面板 */}
      <div className="flex-1 flex flex-col">
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            {chapter ? (
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{chapter.title}</span>
                <Badge variant="secondary" className="text-xs">
                  {chapter.word_count.toLocaleString()} 字
                </Badge>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">选择一个章节开始写作</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isDirty && <span className="text-xs text-muted-foreground">未保存</span>}
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
              <p className="mt-4 text-sm">选择或创建一个章节开始写作</p>
            </div>
          </div>
        ) : chapterLoading ? (
          <div className="flex-1 p-6">
            <Skeleton className="h-full w-full" />
          </div>
        ) : (
          <>
            <div className="flex-1 flex flex-col overflow-hidden">
              <Textarea
                value={editorContent}
                onChange={(e) => {
                  setEditorContent(e.target.value);
                  setIsDirty(true);
                }}
                onClick={(e) => {
                  const ta = e.target as HTMLTextAreaElement;
                  setCursor(ta.selectionStart);
                  const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
                  if (sel) useEditorStore.getState().setSelection(sel, ta.selectionStart);
                }}
                onKeyUp={(e) => {
                  const ta = e.target as HTMLTextAreaElement;
                  setCursor(ta.selectionStart);
                }}
                placeholder="开始写作..."
                className="flex-1 resize-none text-base leading-relaxed border-none shadow-none focus-visible:ring-0 font-normal"
                style={{ minHeight: "300px" }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
