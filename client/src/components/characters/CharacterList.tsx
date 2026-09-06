import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, authFetch } from "@/services/api";
import type { CharacterData, CreateCharacterRequest } from "@muse/shared";
import { CharacterForm, type CharacterFormData } from "./CharacterForm";
import { CharacterTestDialog } from "./CharacterTestDialog";
import { TemplatePicker, type CharacterTemplate } from "./TemplatePicker";
import { SaveAsTemplateDialog } from "@/components/templates/SaveAsTemplateDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ModelSelector, customKeyValue } from "@/components/settings/ModelSelector";
import {
  Plus,
  UserRound,
  MessageCircle,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  BookmarkPlus,
  Sparkles,
  Loader2,
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
  const [saveTplChar, setSaveTplChar] = useState<CharacterData | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [generatingCharId, setGeneratingCharId] = useState<string | null>(null);
  const [imageModel, setImageModel] = useState("doubao-seedream-5-0-260128");
  const [imageKeyId, setImageKeyId] = useState<string | undefined>(undefined);
  const [imageResolution, setImageResolution] = useState("2K");
  const [imageRatio, setImageRatio] = useState("9:16");
  const imageSize = imageRatio === "1:1" ? imageResolution : `${imageResolution}:${imageRatio}`;
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
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
    <div className="space-y-2 pb-8">
      {/* 顶部：标题 + 新建按钮 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-foreground">
          角色
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {characters.length} 个
          </span>
        </h2>
        <div className="flex items-center gap-2">
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
            value={imageKeyId ? customKeyValue(imageKeyId) : imageModel}
            onChange={(m, keyId) => { setImageModel(m); setImageKeyId(keyId); }}
            className="text-xs rounded border border-border bg-background px-2 py-1"
          />
          <Button size="sm" onClick={() => setCreateStep("picker")}>
            <Plus className="size-4" />
            添加角色
          </Button>
        </div>
      </div>


      {/* 加载 */}
      {isLoading &&
        Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-md" />
        ))}

      {/* 空状态 */}
      {!isLoading && characters.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <UserRound className="size-12" />
          <p className="mt-4 text-sm">还没有角色，点击右上角「添加角色」手动创建，或切换到 AI 助手让它帮你生成</p>
        </div>
      )}

      {/* 角色列表（可展开行） */}
      {characters.map((char) => (
        <div
          key={char.char_id}
          className="rounded-lg border border-border bg-card"
        >
          {/* 行头 */}
          <div
            onClick={() => toggleExpand(char.char_id)}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors rounded-lg cursor-pointer"
          >
            {expandedId === char.char_id ? (
              <ChevronDown className="size-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground shrink-0" />
            )}
            {/* 头像缩略图 */}
            <div className="size-8 rounded-full overflow-hidden bg-muted shrink-0">
              {char.avatar_url ? (
                <img src={char.avatar_url} alt={char.name} className="size-full object-cover" />
              ) : (
                <div className="size-full flex items-center justify-center text-xs text-muted-foreground font-medium">
                  {char.name.charAt(0)}
                </div>
              )}
            </div>
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
                title="AI 生成立绘"
                disabled={generatingCharId === char.char_id}
                onClick={async () => {
                  setGeneratingCharId(char.char_id);
                  const t = localStorage.getItem("token");
                  let style = "";
                  try {
                    const sRes = await api.get<{ data: { extra?: any } }>(`/books/${bookId}/settings`);
                    style = sRes?.data?.extra?.visual_style || "";
                  } catch { /* ignore */ }
                  try {
                    const res = await authFetch(`/api/ai/generate-char-image`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
                      body: JSON.stringify({ book_id: bookId, char_id: char.char_id, size: imageSize, style, model: imageModel, key_id: imageKeyId }),
                    });
                    if (res.ok) {
                      const json = await res.json();
                      if (json?.data?.url) {
                        toast({ title: `${char.name} 立绘已生成` });
                        queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
                      }
                    } else {
                      toast({ title: "生成失败", variant: "destructive" });
                    }
                  } catch { toast({ title: "生成失败", variant: "destructive" }); }
                  finally { setGeneratingCharId(null); }
                }}
              >
                {generatingCharId === char.char_id ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
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
          </div>

          {/* 展开的详情 */}
          {expandedId === char.char_id && (
            <div className="px-10 py-4">
              {/* 角色立绘大图 */}
              {char.avatar_url && (
                <div className="mb-4 flex flex-col items-center">
                  <img
                    src={char.avatar_url}
                    alt={char.name}
                    className="w-48 h-64 object-cover rounded-lg border border-border cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
                    onClick={() => setLightboxUrl(char.avatar_url!)}
                  />
                  {/* 历史版本缩略图 */}
                  {(char as any).avatar_history?.length > 1 && (
                    <div className="flex gap-1 mt-2 overflow-x-auto max-w-48">
                      {((char as any).avatar_history as string[]).map((h: string, i: number) => (
                        <img key={i} src={h} alt={`v${i + 1}`}
                          className={`w-10 h-14 object-cover rounded cursor-pointer border flex-shrink-0 ${h === char.avatar_url ? 'border-primary' : 'border-transparent hover:border-border'}`}
                          onClick={async () => {
                            try { await api.patch(`/books/${bookId}/characters/${char.char_id}`, { avatar_url: h }); queryClient.invalidateQueries({ queryKey: ["characters", bookId] }); } catch {}
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
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

      {/* 图片全屏 lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="预览"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
          />
        </div>
      )}
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
