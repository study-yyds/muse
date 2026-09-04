import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, authFetch } from "@/services/api";
import { defaultModelBody } from "@/lib/default-model";
import type { OutlineData, OutlineChapterData, ActStructure } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useThrottle } from "@/hooks/use-throttle";
import { SaveAsTemplateDialog } from "@/components/templates/SaveAsTemplateDialog";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Pencil, Trash2, CircleCheck, ListTree, BookmarkPlus, Split, Loader2 } from "lucide-react";
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

  // 章纲（快捷创作/续生生成的前 N 章细纲，存在 book_settings.extra）
  const { data: settingsData } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () =>
      api.get<{ data: { extra?: Record<string, any> } }>(`/books/${bookId}/settings`),
  });
  const chapterOutlines =
    (settingsData?.data?.extra?.chapter_outlines as string[] | undefined) ?? [];
  const [outlinesOpen, setOutlinesOpen] = useState(true);
  const [outlineEditIdx, setOutlineEditIdx] = useState<number | null>(null);
  const [outlineEditText, setOutlineEditText] = useState("");
  const [removeOutlineIdx, setRemoveOutlineIdx] = useState<number | null>(null);
  const [selectedOutlineIdx, setSelectedOutlineIdx] = useState<Set<number>>(new Set());
  const [removeOutlineBatch, setRemoveOutlineBatch] = useState(false);
  const [removeNode, setRemoveNode] = useState<OutlineChapterData | null>(null);
  // 节点细化：粗节点 → 8-10 个细节点（生成后直接应用，审阅发生在大纲页：行内编辑/批量删除/重新细化）
  const [refineTarget, setRefineTarget] = useState<OutlineChapterData | null>(null);
  const [refiningNodeId, setRefiningNodeId] = useState<string | null>(null);

  const doRefineNode = async () => {
    if (!refineTarget) return;
    setRefiningNodeId(refineTarget.id);
    try {
      const t = localStorage.getItem("token");
      const res = await authFetch("/api/ai/outline-nodes/refine", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({
          book_id: bookId,
          node_id: refineTarget.id,
          ...defaultModelBody(),
        }),
      });
      const j = await res.json();
      if (res.ok && j.code === 200 && j.data?.count) {
        queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
        toast({
          title: `已细化 ${j.data.count} 个节点（原节点已替换）`,
          description:
            "请在大纲页审阅；若该节点范围内已有章纲，建议清空后重新生成",
        });
        setRefineTarget(null);
      } else {
        toast({ title: j.message || "细化失败", variant: "destructive" });
      }
    } catch {
      toast({ title: "细化失败", variant: "destructive" });
    } finally {
      setRefiningNodeId(null);
    }
  };
  const [extendingOutlines, setExtendingOutlines] = useState(false);
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [extendCount, setExtendCount] = useState(10);
  const [extendNodeId, setExtendNodeId] = useState("");

  // 生成/续生章纲（无卷纲时服务端会自动先补卷纲；可选章数与目标节点）
  const extendOutlines = async (count?: number, nodeId?: string) => {
    setExtendingOutlines(true);
    try {
      const t = localStorage.getItem("token");
      const res = await authFetch("/api/ai/chapter-outlines/extend", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({
          book_id: bookId,
          ...defaultModelBody(),
          ...(count ? { count } : {}),
          ...(nodeId ? { node_id: nodeId } : {}),
        }),
      });
      const j = await res.json();
      if (res.ok && j.code === 200 && j.data?.lines?.length) {
        queryClient.invalidateQueries({ queryKey: ["book-settings", bookId] });
        queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
        toast({
          title: `已生成第 ${j.data.startNo}-${j.data.startNo + j.data.lines.length - 1} 章章纲${chapterOutlines.length === 0 ? "（并已自动补全卷纲）" : ""}`,
        });
      } else {
        toast({ title: j.message || "生成失败", variant: "destructive" });
      }
    } catch {
      toast({ title: "生成失败", variant: "destructive" });
    } finally {
      setExtendingOutlines(false);
    }
  };

  // 章纲 CRUD：存 book_settings.extra.chapter_outlines（整行文本，注入按索引取）
  const saveChapterOutlines = async (next: string[]) => {
    try {
      await api.put(`/books/${bookId}/settings`, { extra: { chapter_outlines: next } as any });
      queryClient.invalidateQueries({ queryKey: ["book-settings", bookId] });
    } catch {
      toast({ title: "保存失败", variant: "destructive" });
    }
  };
  // 删除后自动重编号：行首"第N章"替换为实际顺位
  const renumberOutlines = (lines: string[]) =>
    lines.map((l, i) =>
      l.replace(/^第[一二三四五六七八九十百\d]+\s*章/, `第${i + 1}章`),
    );
  // 行文本去掉"第N章"前缀，编辑时只改四字段内容
  const stripOutlinePrefix = (l: string) =>
    l.replace(/^第[一二三四五六七八九十百\d]+\s*章\s*[|｜：: ]?\s*/, '');
  // 章纲批量选择（按行索引）
  const toggleOutlineSelect = (i: number) => {
    setSelectedOutlineIdx((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  const toggleOutlineSelectAll = () => {
    if (chapterOutlines.length > 0 && selectedOutlineIdx.size === chapterOutlines.length) {
      setSelectedOutlineIdx(new Set());
    } else {
      setSelectedOutlineIdx(new Set(chapterOutlines.map((_, i) => i)));
    }
  };
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const counterRef = useRef(0);
  useEffect(() => { counterRef.current = chapters.length; }, [chapters.length]);
  const [editingChapter, setEditingChapter] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");

  const addChapterMutation = useMutation({
    mutationFn: (body: { title: string; summary: string }) =>
      api.post(`/books/${bookId}/outline/chapters`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
      toast({ title: "节点已添加" });
    },
  });

  const updateChapterMutation = useMutation({
    mutationFn: ({
      chapterId,
      body,
    }: {
      chapterId: string;
      body: { title?: string; summary?: string; status?: string };
    }) => api.patch(`/books/${bookId}/outline/chapters/${chapterId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
      setEditingChapter(null);
      toast({ title: "已更新" });
    },
  });

  // 标记完成/重新打开：为大纲节点提供 completed 状态写入口
  const toggleStatusMutation = useMutation({
    mutationFn: ({ chapterId, status }: { chapterId: string; status: string }) =>
      api.patch(`/books/${bookId}/outline/chapters/${chapterId}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
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

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === chapters.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(chapters.map((c) => c.id)));
    }
  };

  const doBulkDelete = useThrottle(async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`删除选中的 ${selectedIds.size} 个节点？`)) return;
    const token = localStorage.getItem("token");
    let deleted = 0;
    for (const id of selectedIds) {
      try {
        await authFetch(`/api/books/${bookId}/outline/chapters/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        deleted++;
      } catch { /* ignore */ }
    }
    queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
    toast({ title: `已删除 ${deleted} 个节点` });
    setSelectedIds(new Set());
  });

  const addChapter = useThrottle(() => {
    if (addChapterMutation.isPending) return;
    counterRef.current += 1;
    addChapterMutation.mutate({
      title: `节点 ${counterRef.current}`,
      summary: "新节点摘要...",
    });
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={chapters.length > 0 && selectedIds.size === chapters.length}
            onChange={toggleSelectAll}
            className="mt-0.5 shrink-0"
            title={selectedIds.size === chapters.length ? "取消全选" : "全选"}
          />
          <h2 className="text-base font-semibold text-foreground">
            大纲
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {chapters.length} 个节点
            </span>
          </h2>
        </div>
        <div className="flex gap-2">
          {selectedIds.size > 0 && (
            <Button size="sm" variant="destructive" onClick={doBulkDelete}>
              <Trash2 className="size-4" />删除选中 ({selectedIds.size})
            </Button>
          )}
          {selectedIds.size === 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSaveTplOpen(true)}>
              <BookmarkPlus className="size-4" />保存为模板
            </Button>
          )}
          <Button size="sm" onClick={addChapter} disabled={addChapterMutation.isPending}>
            <Plus className="size-4" />添加节点
          </Button>
        </div>
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
          <p className="mt-4 text-sm">还没有大纲节点</p>
          <p className="text-xs">点击「添加节点」或使用右侧 AI 助手</p>
        </div>
      )}

      {!isLoading && chapters.length > 0 && (
        <ScrollArea className="flex-1 min-h-0">
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
                    <span className="ml-1 font-normal">({act.chapter_ids.length} 个节点)</span>
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
                        deleteChapterMutation,
                        toggleStatusMutation,
                        selectedIds,
                        toggleSelect,
                        setRemoveNode,
                        setRefineTarget,
                        refiningNodeId,
                      )
                    )}
                </div>
              ))}
            </div>
          )}

          {acts.length > 0 && <Separator className="my-3" />}

          {/* 未归类节点 */}
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
                  deleteChapterMutation,
                  toggleStatusMutation,
                  selectedIds,
                  toggleSelect,
                  setRemoveNode,
                  setRefineTarget,
                  refiningNodeId,
                )
              )}
          </div>

          {/* 章纲：前 N 章细纲（目标/阻碍/爽点/钩子）——区与按钮常驻，列表按需显示 */}
          <Separator className="my-3" />
          <div className="flex items-center gap-2 mb-2">
            {chapterOutlines.length > 0 && (
              <Checkbox
                checked={selectedOutlineIdx.size === chapterOutlines.length}
                onChange={toggleOutlineSelectAll}
                className="shrink-0"
                title={
                  selectedOutlineIdx.size === chapterOutlines.length
                    ? "取消全选"
                    : "全选"
                }
              />
            )}
            <button
              onClick={() => setOutlinesOpen(!outlinesOpen)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
            >
              <span className="text-sm font-medium">
                章纲{chapterOutlines.length > 0 ? `（前 ${chapterOutlines.length} 章细纲）` : ""}
              </span>
              {chapterOutlines.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {outlinesOpen ? "收起" : "展开"}
                </span>
              )}
            </button>
            {selectedOutlineIdx.size > 0 ? (
              <Button
                size="xs"
                variant="destructive"
                onClick={() => setRemoveOutlineBatch(true)}
              >
                <Trash2 className="size-3" />删除选中 ({selectedOutlineIdx.size})
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={extendingOutlines}
                title="生成章纲（可选章数与围绕节点，无卷纲时自动先补卷纲）"
                onClick={() => setExtendDialogOpen(true)}
              >
                {extendingOutlines
                  ? "生成中..."
                  : chapterOutlines.length === 0
                    ? "生成章纲"
                    : `续生章纲（第 ${chapterOutlines.length + 1} 章起）`}
              </Button>
            )}
          </div>
          {chapterOutlines.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-2">
              暂无章纲——点击右侧"生成章纲"，AI 将按卷纲生成前 10 章细纲（无卷纲会自动先补）。
            </p>
          )}
          {chapterOutlines.length > 0 && outlinesOpen && (
                <div className="space-y-1.5">
                  {chapterOutlines.map((line, i) => (
                    <div
                      key={i}
                      className="group flex items-start gap-2 rounded-md px-3 py-2 bg-muted/30"
                    >
                      <Checkbox
                        checked={selectedOutlineIdx.has(i)}
                        onChange={() => toggleOutlineSelect(i)}
                        className="mt-0.5 shrink-0"
                        title="选择"
                      />
                      <span className="shrink-0 text-xs font-medium text-primary mt-0.5">
                        第{i + 1}章
                      </span>
                      {outlineEditIdx === i ? (
                        <textarea
                          autoFocus
                          value={outlineEditText}
                          onChange={(e) => setOutlineEditText(e.target.value)}
                          onBlur={() => {
                            const v = outlineEditText.trim();
                            const next = [...chapterOutlines];
                            next[i] = v ? `第${i + 1}章 | ${v}` : next[i];
                            saveChapterOutlines(next);
                            setOutlineEditIdx(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              setOutlineEditIdx(null);
                              setOutlineEditText("");
                            }
                          }}
                          rows={3}
                          placeholder="目标= | 阻碍= | 爽点= | 钩子="
                          className="flex-1 min-w-0 bg-transparent text-xs text-muted-foreground outline-none resize-none"
                        />
                      ) : (
                        <span className="flex-1 min-w-0 text-xs text-muted-foreground whitespace-pre-wrap">
                          {stripOutlinePrefix(line)}
                        </span>
                      )}
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="编辑"
                          onClick={() => {
                            setOutlineEditIdx(i);
                            setOutlineEditText(stripOutlinePrefix(line));
                          }}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-destructive hover:text-destructive"
                          title="删除"
                          onClick={() => setRemoveOutlineIdx(i)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      const next = [
                        ...chapterOutlines,
                        `第${chapterOutlines.length + 1}章 | 目标= | 阻碍= | 爽点= | 钩子=`,
                      ];
                      saveChapterOutlines(next);
                      setOutlineEditIdx(next.length - 1);
                      setOutlineEditText("目标= | 阻碍= | 爽点= | 钩子=");
                    }}
                  >
                    添加一章
                  </Button>
                </div>
              )}
        </ScrollArea>
      )}

      <SaveAsTemplateDialog
        open={saveTplOpen}
        onOpenChange={setSaveTplOpen}
        type="outline"
        data={{ chapters: chapters.map((c) => ({ title: c.title, summary: c.summary })) }}
      />

      <ConfirmDialog
        open={removeOutlineIdx != null}
        onOpenChange={(o) => !o && setRemoveOutlineIdx(null)}
        title="删除章纲"
        description={`确定删除第 ${(removeOutlineIdx ?? 0) + 1} 章章纲？后续章纲将自动重新编号。`}
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (removeOutlineIdx != null) {
            const next = chapterOutlines.filter((_, idx) => idx !== removeOutlineIdx);
            saveChapterOutlines(renumberOutlines(next));
          }
          setRemoveOutlineIdx(null);
        }}
      />

      <ConfirmDialog
        open={removeOutlineBatch}
        onOpenChange={(o) => !o && setRemoveOutlineBatch(false)}
        title="批量删除章纲"
        description={`确定删除选中的 ${selectedOutlineIdx.size} 章章纲？后续章纲将自动重新编号。`}
        confirmText="删除"
        destructive
        onConfirm={() => {
          const next = chapterOutlines.filter((_, idx) => !selectedOutlineIdx.has(idx));
          saveChapterOutlines(renumberOutlines(next));
          if (outlineEditIdx != null && selectedOutlineIdx.has(outlineEditIdx)) {
            setOutlineEditIdx(null);
            setOutlineEditText("");
          }
          setSelectedOutlineIdx(new Set());
          setRemoveOutlineBatch(false);
        }}
      />

      <ConfirmDialog
        open={removeNode != null}
        onOpenChange={(o) => !o && setRemoveNode(null)}
        title="删除大纲节点"
        description={`确定删除节点"${removeNode?.title ?? ""}"？绑定该节点的章节将失去大纲约束。`}
        confirmText="删除"
        destructive
        onConfirm={() => {
          if (removeNode) deleteChapterMutation.mutate(removeNode.id);
          setRemoveNode(null);
        }}
      />

      <ConfirmDialog
        open={refineTarget != null}
        onOpenChange={(o) => !o && setRefineTarget(null)}
        title="细化节点"
        description={`把节点"${refineTarget?.title ?? ""}"细化为 8-10 个细节点（原节点将被替换，已写章节不受影响）。生成后请在大纲页审阅，不满意可批量删除后重新细化。`}
        confirmText={refiningNodeId ? "细化中..." : "细化"}
        onConfirm={doRefineNode}
      />

      <Dialog open={extendDialogOpen} onOpenChange={setExtendDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>生成章纲</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">章数</Label>
              <select
                value={extendCount}
                onChange={(e) => setExtendCount(Number(e.target.value))}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value={5}>5 章</option>
                <option value={10}>10 章</option>
                <option value={15}>15 章</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">围绕节点（可选）</Label>
              <select
                value={extendNodeId}
                onChange={(e) => setExtendNodeId(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">按卷纲顺序续生</option>
                {chapters.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setExtendDialogOpen(false)}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setExtendDialogOpen(false);
                  extendOutlines(extendCount, extendNodeId || undefined);
                }}
              >
                {extendingOutlines ? "生成中..." : "生成"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
  toggleStatusMutation: { mutate: (p: { chapterId: string; status: string }) => void },
  selectedIds?: Set<string>,
  toggleSelect?: (id: string) => void,
  onRequestDelete?: (ch: OutlineChapterData) => void,
  onRequestRefine?: (ch: OutlineChapterData) => void,
  refiningNodeId?: string | null,
) {
  if (editingChapter === ch.id) {
    return (
      <div key={ch.id} className="rounded-md border border-primary/50 bg-card p-3 space-y-2">
        <input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          className="w-full bg-transparent text-sm font-medium outline-none"
          placeholder="节点标题"
        />
        <textarea
          value={editSummary}
          onChange={(e) => setEditSummary(e.target.value)}
          className="w-full bg-transparent text-xs text-muted-foreground outline-none resize-none"
          rows={2}
          placeholder="节点摘要"
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
      <Checkbox
        checked={selectedIds?.has(ch.id) ?? false}
        onChange={() => toggleSelect?.(ch.id)}
        className="mt-0.5 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground truncate">{ch.title}</p>
          <Badge variant="secondary" className="text-[10px] px-1 py-0">
            {ch.status === "completed" ? "已完成" : ch.status === "writing" ? "写作中" : "规划中"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{ch.summary}</p>
      </div>
      <div
        className={cn(
          "flex gap-0.5 transition-opacity shrink-0",
          refiningNodeId === ch.id
            ? "opacity-100" // 细化生成中：加载转圈常驻可见，不依赖悬浮
            : "opacity-0 group-hover:opacity-100",
        )}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          title={ch.status === "completed" ? "标记为未完成" : "标记为已完成"}
          onClick={() =>
            toggleStatusMutation.mutate({
              chapterId: ch.id,
              status: ch.status === "completed" ? "planned" : "completed",
            })
          }
        >
          <CircleCheck
            className={cn(
              "size-3",
              ch.status === "completed" ? "text-primary" : "text-muted-foreground",
            )}
          />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => startEdit(ch)}>
          <Pencil className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={refiningNodeId === ch.id}
          title="细化节点（拆成 8-10 个细节点，生成草稿审阅后才应用）"
          onClick={() => onRequestRefine?.(ch)}
        >
          {refiningNodeId === ch.id ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Split className="size-3" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-destructive hover:text-destructive"
          onClick={() => onRequestDelete?.(ch)}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}
