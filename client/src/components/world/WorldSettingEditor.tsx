import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { WorldSettingData, WorldSection } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { SaveAsTemplateDialog } from "@/components/templates/SaveAsTemplateDialog";
import { Plus, Trash2, ChevronDown, ChevronRight, Globe, Loader2, BookmarkPlus } from "lucide-react";
import { cn } from "@/lib/utils";

const DEFAULT_SECTIONS = [
  { name: "时代与背景", content: "", sort_order: 1 },
  { name: "地理与场景", content: "", sort_order: 2 },
  { name: "规则与体系", content: "", sort_order: 3 },
  { name: "势力与阵营", content: "", sort_order: 4 },
];

interface Props {
  bookId: string;
}

export function WorldSettingEditor({ bookId }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saveTplOpen, setSaveTplOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["world-setting", bookId],
    queryFn: () =>
      api.get<{ data: WorldSettingData }>(`/books/${bookId}/world-setting`),
    refetchOnWindowFocus: false, // 防止切窗口后覆盖用户正在编辑的内容
  });

  const sections = data?.data?.sections?.length
    ? data.data.sections
    : DEFAULT_SECTIONS.map((s) => ({ ...s }));

  const [editing, setEditing] = useState<WorldSection[]>(sections);
  // 上次与服务端同步的快照：有未保存的本地修改时不覆盖
  const lastSyncedRef = useRef<string>("");
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    const incoming = data?.data?.sections?.length
      ? data.data.sections
      : DEFAULT_SECTIONS.map((s) => ({ ...s }));
    const incomingJson = JSON.stringify(incoming);
    // 正在编辑（与服务端快照不一致）时跳过同步，
    // 防止采纳 AI 建议/refetch 覆盖用户正在输入的内容
    if (
      lastSyncedRef.current &&
      JSON.stringify(editingRef.current) !== lastSyncedRef.current
    ) {
      return;
    }
    setEditing(incoming);
    lastSyncedRef.current = incomingJson;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (sections: WorldSection[]) =>
      api.put(`/books/${bookId}/world-setting`, { sections }),
    onSuccess: () => {
      // 保存的内容即新的同步快照，之后 refetch 不再触发覆盖
      lastSyncedRef.current = JSON.stringify(editingRef.current);
      queryClient.invalidateQueries({ queryKey: ["world-setting", bookId] });
      toast({ title: "世界观已保存" });
    },
    onError: () => {
      toast({ title: "保存失败", variant: "destructive" });
    },
  });

  const updateSection = (index: number, content: string) => {
    setEditing((prev) =>
      prev.map((s, i) => (i === index ? { ...s, content } : s))
    );
  };

  const updateName = (index: number, name: string) => {
    setEditing((prev) =>
      prev.map((s, i) => (i === index ? { ...s, name } : s))
    );
  };

  const addSection = () => {
    const maxOrder = Math.max(...editing.map((s) => s.sort_order), 0);
    setEditing((prev) => [
      ...prev,
      { name: "自定义分区", content: "", sort_order: maxOrder + 1 },
    ]);
  };

  const removeSection = (index: number) => {
    setEditing((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleCollapse = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {editing.length} 个分区
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setSaveTplOpen(true)}
          >
            <BookmarkPlus className="size-3" />
            保存为模板
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={addSection}
          >
            <Plus className="size-3" />
            添加分区
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(editing)}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="size-4 animate-spin" />}
            保存
          </Button>
        </div>
      </div>

      {/* 空状态 */}
      {editing.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Globe className="size-12" />
          <p className="mt-4 text-sm">还没有世界观设定，可手动添加或让右侧 AI 助手帮你构建</p>
          <Button variant="link" onClick={addSection}>
            添加第一个分区
          </Button>
        </div>
      )}

      {/* 分区列表 */}
      <div className="space-y-3">
        {editing.map((section, i) => (
          <div
            key={i}
            className={cn(
              "rounded-lg border border-border bg-card",
              collapsed.has(section.name) && "pb-0"
            )}
          >
            {/* 分区标题栏 */}
            <div className="flex items-center gap-2 px-4 py-2">
              <button
                onClick={() => toggleCollapse(section.name)}
                className="text-muted-foreground hover:text-foreground"
              >
                {collapsed.has(section.name) ? (
                  <ChevronRight className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
              </button>
              <input
                value={section.name}
                onChange={(e) => updateName(i, e.target.value)}
                className="flex-1 bg-transparent text-sm font-medium text-foreground outline-none focus:bg-muted/30 rounded px-1 -mx-1"
                placeholder="分区名称"
                title="点击编辑分区名称"
              />
              {editing.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeSection(i)}
                >
                  <Trash2 className="size-3 text-muted-foreground" />
                </Button>
              )}
            </div>

            {/* 分区内容 */}
            {!collapsed.has(section.name) && (
              <div className="px-4 pb-4">
                <Textarea
                  value={section.content}
                  onChange={(e) => updateSection(i, e.target.value)}
                  rows={6}
                  placeholder={`描述这个世界的${section.name}...`}
                  className="resize-y min-h-[120px]"
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <SaveAsTemplateDialog
        open={saveTplOpen}
        onOpenChange={setSaveTplOpen}
        type="world"
        data={{ sections: editing }}
      />
    </div>
  );
}
