import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { ChapterDetail } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AIGeneratePanel } from "./AIGeneratePanel";
import {
  Plus,
  FileText,
  Loader2,
  Send,
  Sparkles,
  ChevronDown,
  ChevronRight,
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

  // 切换到新章节时同步内容
  useEffect(() => {
    if (chapter) {
      setEditorContent(chapter.content);
      setIsDirty(false);
    }
  }, [activeChapterId]);

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
    <div className="flex h-[calc(100vh-150px)] gap-0">
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
                <button
                  key={ch.chapter_id}
                  onClick={() => selectChapter(ch.chapter_id)}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors",
                    activeChapterId === ch.chapter_id && "bg-muted font-medium text-foreground",
                    activeChapterId !== ch.chapter_id && "text-muted-foreground"
                  )}
                >
                  <div className="truncate">{ch.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {ch.word_count.toLocaleString()} 字
                  </div>
                </button>
              ))}
              {chapters.length === 0 && !listLoading && (
                <p className="px-3 py-8 text-xs text-muted-foreground text-center">
                  还没有章节
                </p>
              )}
            </ScrollArea>
            <div className="p-2 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={newChapter}
                disabled={createChapterMutation.isPending}
              >
                <Plus className="size-4" />
                新建章节
              </Button>
            </div>
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
            {isDirty && (
              <span className="text-xs text-muted-foreground">未保存</span>
            )}
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              保存
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
            <div className="flex-1 flex flex-col p-6 overflow-hidden">
              {/* Markdown 编辑区（后续替换为 Milkdown） */}
              <Textarea
                value={editorContent}
                onChange={(e) => {
                  setEditorContent(e.target.value);
                  setIsDirty(true);
                }}
                placeholder="开始写作..."
                className="flex-1 resize-none text-base leading-relaxed border-none shadow-none focus-visible:ring-0 font-normal"
                style={{ minHeight: "300px" }}
              />
            </div>

            {/* AI 面板 */}
            <Separator />
            <AIGeneratePanel
              bookId={bookId}
              chapterId={activeChapterId}
              editorContent={editorContent}
              onInsert={(text) => {
                setEditorContent((prev) => prev + text);
                setIsDirty(true);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
