import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { OutlineData, OutlineChapterData, ActStructure } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, GripVertical, ListTree } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  bookId: string;
}

export function OutlinePanel({ bookId }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["outline", bookId],
    queryFn: () => api.get<{ data: OutlineData }>(`/books/${bookId}/outline`),
  });

  const outline = data?.data;
  const chapters: OutlineChapterData[] = outline?.chapters ?? [];
  const acts: ActStructure[] = outline?.acts ?? [];

  const [editingChapter, setEditingChapter] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");

  const addChapterMutation = useMutation({
    mutationFn: (body: { title: string; summary: string }) =>
      api.post(`/books/${bookId}/outline/chapters`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
      toast({ title: "章节已添加" });
    },
  });

  const updateChapterMutation = useMutation({
    mutationFn: ({
      chapterId,
      body,
    }: {
      chapterId: string;
      body: { title?: string; summary?: string };
    }) => api.patch(`/books/${bookId}/outline/chapters/${chapterId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
      setEditingChapter(null);
      toast({ title: "已更新" });
    },
  });

  const deleteChapterMutation = useMutation({
    mutationFn: (chapterId: string) =>
      api.delete(`/books/${bookId}/outline/chapters/${chapterId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
      toast({ title: "已删除" });
    },
  });

  const startEdit = (ch: OutlineChapterData) => {
    setEditingChapter(ch.id);
    setEditTitle(ch.title);
    setEditSummary(ch.summary);
  };

  const saveEdit = () => {
    if (!editingChapter) return;
    updateChapterMutation.mutate({
      chapterId: editingChapter,
      body: { title: editTitle, summary: editSummary },
    });
  };

  const addChapter = () => {
    const num = chapters.length + 1;
    addChapterMutation.mutate({ title: `第${num}章`, summary: "新章节摘要..." });
  };

  return (
    <div className="flex flex-col h-full">
      {/* 顶部 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-foreground">
          大纲
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {chapters.length} 章
          </span>
        </h2>
        <Button size="sm" onClick={addChapter}>
          <Plus className="size-4" />添加章节
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-md" />
          ))}
        </div>
      )}

      {!isLoading && chapters.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <ListTree className="size-12" />
          <p className="mt-4 text-sm">还没有大纲章节</p>
          <p className="text-xs">点击「添加章节」或使用右侧 AI 助手</p>
        </div>
      )}

      {!isLoading && chapters.length > 0 && (
        <ScrollArea className="flex-1">
          {/* 分幕骨架 */}
          {acts.length > 0 && (
            <div className="mb-4 space-y-3">
              {acts.map((act) => (
                <div
                  key={act.act_name}
                  className="rounded-md border border-border bg-muted/30 p-3"
                >
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    {act.act_name}
                    <span className="ml-1 font-normal">({act.chapter_ids.length} 章)</span>
                  </p>
                  {act.chapter_ids
                    .map((id) => chapters.find((ch) => ch.id === id))
                    .filter(Boolean)
                    .map((ch) =>
                      ch &&
                      renderChapter(
                        ch,
                        editingChapter,
                        editTitle,
                        editSummary,
                        setEditTitle,
                        setEditSummary,
                        setEditingChapter,
                        startEdit,
                        saveEdit,
                        deleteChapterMutation
                      )
                    )}
                </div>
              ))}
            </div>
          )}

          {acts.length > 0 && <Separator className="my-3" />}

          {/* 未归类章节 */}
          <div className="space-y-2">
            {chapters
              .filter((ch) => !acts.some((act) => act.chapter_ids.includes(ch.id)))
              .map((ch) =>
                renderChapter(
                  ch,
                  editingChapter,
                  editTitle,
                  editSummary,
                  setEditTitle,
                  setEditSummary,
                  setEditingChapter,
                  startEdit,
                  saveEdit,
                  deleteChapterMutation
                )
              )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function renderChapter(
  ch: OutlineChapterData,
  editingChapter: string | null,
  editTitle: string,
  editSummary: string,
  setEditTitle: (v: string) => void,
  setEditSummary: (v: string) => void,
  setEditingChapter: (v: string | null) => void,
  startEdit: (ch: OutlineChapterData) => void,
  saveEdit: () => void,
  deleteMutation: { mutate: (id: string) => void },
) {
  if (editingChapter === ch.id) {
    return (
      <div key={ch.id} className="rounded-md border border-primary/50 bg-card p-3 space-y-2">
        <input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          className="w-full bg-transparent text-sm font-medium outline-none"
          placeholder="章节标题"
        />
        <textarea
          value={editSummary}
          onChange={(e) => setEditSummary(e.target.value)}
          className="w-full bg-transparent text-xs text-muted-foreground outline-none resize-none"
          rows={2}
          placeholder="章节摘要"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={() => setEditingChapter(null)}>取消</Button>
          <Button size="xs" onClick={saveEdit}>保存</Button>
        </div>
      </div>
    );
  }

  return (
    <div
      key={ch.id}
      className="group flex items-start gap-2 rounded-md px-3 py-2 hover:bg-muted/50 transition-colors"
    >
      <GripVertical className="size-4 text-muted-foreground/40 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground truncate">{ch.title}</p>
          <Badge variant="secondary" className="text-[10px] px-1 py-0">
            {ch.status === "completed" ? "已完成" : ch.status === "writing" ? "写作中" : "规划中"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{ch.summary}</p>
      </div>
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Button variant="ghost" size="icon-xs" onClick={() => startEdit(ch)}>
          <Pencil className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-destructive hover:text-destructive"
          onClick={() => { if (confirm("删除？")) deleteMutation.mutate(ch.id); }}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}
