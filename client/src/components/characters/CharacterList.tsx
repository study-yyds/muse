import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { CharacterData, CreateCharacterRequest } from "@muse/shared";
import { CharacterForm, type CharacterFormData } from "./CharacterForm";
import { CharacterTestDialog } from "./CharacterTestDialog";
import { CharacterRelationGraph } from "./CharacterRelationGraph";
import { TemplatePicker, type CharacterTemplate } from "./TemplatePicker";
import { SaveAsTemplateDialog } from "@/components/templates/SaveAsTemplateDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  UserRound,
  MessageCircle,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  BookmarkPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  bookId: string;
}

export function CharacterList({ bookId }: Props) {
  const [createStep, setCreateStep] = useState<"picker" | "form" | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<CharacterTemplate | null>(null);
  const [editing, setEditing] = useState<CharacterData | null>(null);
  const [testChar, setTestChar] = useState<CharacterData | null>(null);
  const [showRelations, setShowRelations] = useState(false);
  const [saveTplChar, setSaveTplChar] = useState<CharacterData | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["characters", bookId],
    queryFn: () => api.get<{ data: CharacterData[] }>(`/books/${bookId}/characters`),
  });

  const characters = data?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (body: CreateCharacterRequest) =>
      api.post(`/books/${bookId}/characters`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
      setCreateStep(null);
      toast({ title: "角色已创建" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      charId,
      body,
    }: {
      charId: string;
      body: Partial<CharacterFormData>;
    }) => api.patch(`/books/${bookId}/characters/${charId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
      setEditing(null);
      toast({ title: "角色已更新" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (charId: string) =>
      api.delete(`/books/${bookId}/characters/${charId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
      toast({ title: "角色已删除" });
    },
  });

  const handleDelete = (char: CharacterData) => {
    if (confirm(`确定删除「${char.name}」？`)) {
      deleteMutation.mutate(char.char_id);
    }
  };

  const handleCreate = (data: CharacterFormData) => {
    createMutation.mutate({
      name: data.name,
      gender: data.gender,
      age: data.age,
      appearance: data.appearance,
      personality: data.personality,
      catchphrase: data.catchphrase,
      speech_style: data.speech_style,
      identity: data.identity,
      aliases: data.aliases,
      is_main: data.is_main,
      backstory: data.backstory,
      motivation: data.motivation,
      custom_fields: data.custom_fields,
    });
  };

  const handleUpdate = (data: CharacterFormData) => {
    if (!editing) return;
    updateMutation.mutate({ charId: editing.char_id, body: data });
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="space-y-2">
      {/* 顶部：标题 + 新建按钮 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-foreground">
          角色
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {characters.length} 个
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={showRelations ? "secondary" : "ghost"} onClick={() => setShowRelations(!showRelations)}>
            关系网络
          </Button>
          <Button size="sm" onClick={() => setCreateStep("picker")}>
            <Plus className="size-4" />
            添加角色
          </Button>
        </div>
      </div>

      {/* 关系网络视图 */}
      {showRelations && <CharacterRelationGraph bookId={bookId} />}

      {/* 角色列表（关系网络模式下隐藏） */}
      {!showRelations && <>

      {/* 加载 */}
      {isLoading &&
        Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-md" />
        ))}

      {/* 空状态 */}
      {!isLoading && characters.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <UserRound className="size-12" />
          <p className="mt-4 text-sm">还没有角色，点击右上角「添加角色」开始</p>
        </div>
      )}

      {/* 角色列表（可展开行） */}
      {characters.map((char) => (
        <div
          key={char.char_id}
          className="rounded-lg border border-border bg-card"
        >
          {/* 行头 */}
          <button
            onClick={() => toggleExpand(char.char_id)}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors rounded-lg"
          >
            {expandedId === char.char_id ? (
              <ChevronDown className="size-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground truncate">
                  {char.name}
                </span>
                {char.is_main && <span className="text-[10px] bg-primary/15 text-primary px-1 rounded">主</span>}
                {char.identity && (
                  <span className="text-xs text-muted-foreground truncate">
                    {char.identity}
                  </span>
                )}
              </div>
              {char.personality && (
                <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                  {char.personality}
                </p>
              )}
            </div>

            {/* 操作按钮 */}
            <div
              className="flex gap-1 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                title="保存为模板"
                onClick={() => setSaveTplChar(char)}
              >
                <BookmarkPlus className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="测试对话"
                onClick={() => setTestChar(char)}
              >
                <MessageCircle className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="编辑"
                onClick={() => setEditing(char)}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive hover:text-destructive"
                title="删除"
                onClick={() => handleDelete(char)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </button>

          {/* 展开的详情 */}
          {expandedId === char.char_id && (
            <div className="px-10 pb-4 grid gap-3 sm:grid-cols-2">
              {char.gender && <Detail label="性别" value={char.gender} />}
              {char.age != null && <Detail label="年龄" value={String(char.age)} />}
              {char.aliases && <Detail label="别名" value={char.aliases} />}
              {char.appearance && <Detail label="外貌" value={char.appearance} span />}
              {char.speech_style && <Detail label="说话风格" value={char.speech_style} />}
              {char.catchphrase && <Detail label="口头禅" value={char.catchphrase} />}
              {char.backstory && <Detail label="背景故事" value={char.backstory} span />}
              {char.motivation && <Detail label="动机/目标" value={char.motivation} span />}
              {char.custom_fields?.map((cf) => (
                <Detail key={cf.key} label={cf.key} value={cf.value} />
              ))}
            </div>
          )}
        </div>
      ))}

      {/* 新建角色弹窗 */}
      <Dialog open={!!createStep} onOpenChange={(open) => { if (!open) setCreateStep(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          {createStep === "picker" && (
            <>
              <DialogHeader><DialogTitle>新建角色</DialogTitle></DialogHeader>
              <TemplatePicker onSelect={(tpl) => { setSelectedTemplate(tpl); setCreateStep("form"); }} />
            </>
          )}
          {createStep === "form" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {selectedTemplate ? `创建「${selectedTemplate.name}」` : "新建角色"}
                </DialogTitle>
              </DialogHeader>
              <CharacterForm
                defaultValues={selectedTemplate?.data ? {
                  name: selectedTemplate.data.name,
                  gender: selectedTemplate.data.gender,
                  personality: selectedTemplate.data.personality,
                  catchphrase: selectedTemplate.data.catchphrase,
                  speech_style: selectedTemplate.data.speech_style,
                  identity: selectedTemplate.data.identity,
                  backstory: selectedTemplate.data.backstory,
                  motivation: selectedTemplate.data.motivation,
                } : undefined}
                onSubmit={handleCreate}
                onCancel={() => setCreateStep(null)}
                isPending={createMutation.isPending}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 编辑弹窗 */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>编辑「{editing?.name}」</DialogTitle></DialogHeader>
          {editing && (
            <CharacterForm
              defaultValues={{
                name: editing.name,
                gender: editing.gender ?? "",
                age: editing.age,
                appearance: editing.appearance ?? "",
                personality: editing.personality ?? "",
                catchphrase: editing.catchphrase ?? "",
                speech_style: editing.speech_style ?? "",
                identity: editing.identity ?? "",
                aliases: editing.aliases ?? "",
                is_main: editing.is_main ?? false,
                backstory: editing.backstory ?? "",
                motivation: editing.motivation ?? "",
                custom_fields: editing.custom_fields,
              }}
              onSubmit={handleUpdate}
              onCancel={() => setEditing(null)}
              isPending={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      </>}

      {/* 保存为模板弹窗 */}
      <SaveAsTemplateDialog
        open={!!saveTplChar}
        onOpenChange={(open) => { if (!open) setSaveTplChar(null); }}
        type="character"
        data={{
          name: saveTplChar?.name,
          gender: saveTplChar?.gender,
          personality: saveTplChar?.personality,
          catchphrase: saveTplChar?.catchphrase,
          speech_style: saveTplChar?.speech_style,
          identity: saveTplChar?.identity,
          backstory: saveTplChar?.backstory,
          motivation: saveTplChar?.motivation,
          appearance: saveTplChar?.appearance,
        }}
      />

      {/* 测试对话弹窗 */}
      <Dialog open={!!testChar} onOpenChange={(open) => { if (!open) setTestChar(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>与 {testChar?.name} 对话</DialogTitle></DialogHeader>
          {testChar && <CharacterTestDialog char={testChar} bookId={bookId} onClose={() => setTestChar(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 详情行 */
function Detail({ label, value, span }: { label: string; value: string; span?: boolean }) {
  return (
    <div className={cn("space-y-0.5", span && "sm:col-span-2")}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}
