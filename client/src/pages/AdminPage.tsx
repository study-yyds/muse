import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Shield, Ban, CheckCircle, UserRound, FileText, Plus, Trash2, Pencil } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ============== 类型 ==============

interface UserRow {
  user_id: string;
  phone_number: string;
  role: string;
  status: string;
  book_limit: number;
  created_at: string;
  total_tokens: number;
  request_count: number;
}

interface TemplateRow {
  template_id: string;
  name: string;
  type: string;
  category: string;
  description: string | null;
  is_preset: boolean;
  is_public: boolean;
  data: any;
}

type Tab = "users" | "templates";

const TYPES = ["character", "world", "outline"] as const;
const TYPE_LABELS: Record<string, string> = { character: "角色", world: "世界观", outline: "大纲" };

// ============== 用户管理 ==============

function UsersPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-users", page],
    queryFn: () =>
      api.get<{ data: { items: UserRow[]; total: number; page: number } }>(
        `/admin/users?page=${page}&pageSize=20`
      ),
  });

  const users = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const totalPages = Math.ceil(total / 20);

  const updateMutation = useMutation({
    mutationFn: ({
      userId,
      body,
    }: {
      userId: string;
      body: { role?: string; status?: string; book_limit?: number };
    }) => api.patch(`/admin/users/${userId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({ title: "已更新" });
    },
  });

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-12 w-full" />))}</div>;

  return (
    <>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">手机号</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">角色</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">状态</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">配额</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">Token</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id} className="border-t border-border">
                <td className="px-4 py-2.5 flex items-center gap-2"><UserRound className="size-3.5 text-muted-foreground" />{u.phone_number}</td>
                <td className="px-4 py-2.5"><span className={u.role === "admin" ? "text-primary font-medium" : "text-foreground"}>{u.role === "admin" ? "管理员" : "用户"}</span></td>
                <td className="px-4 py-2.5"><span className={u.status === "active" ? "text-green-600" : u.status === "suspended" ? "text-yellow-600" : "text-red-600"}>{u.status === "active" ? "正常" : u.status === "suspended" ? "暂停" : "封禁"}</span></td>
                <td className="px-4 py-2.5 text-right">{u.book_limit}</td>
                <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{u.total_tokens?.toLocaleString()}</td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-center gap-1">
                    <Button variant="ghost" size="icon-xs" title={u.status === "active" ? "暂停" : "恢复"}
                      onClick={() => updateMutation.mutate({ userId: u.user_id, body: { status: u.status === "active" ? "suspended" : "active" } })}>
                      {u.status === "active" ? <Ban className="size-3 text-yellow-600" /> : <CheckCircle className="size-3 text-green-600" />}
                    </Button>
                    <Button variant="ghost" size="icon-xs" title={u.role === "admin" ? "降级" : "升级"}
                      onClick={() => updateMutation.mutate({ userId: u.user_id, body: { role: u.role === "admin" ? "user" : "admin" } })}>
                      <Shield className={`size-3 ${u.role === "admin" ? "text-primary" : "text-muted-foreground"}`} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">暂无用户</td></tr>}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span className="text-xs text-muted-foreground">{page} / {totalPages}</span>
          <Button variant="outline" size="xs" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      )}
    </>
  );
}

// ============== 模板管理 ==============

function TemplateForm({
  onSave,
  onCancel,
  initial,
}: {
  onSave: (data: any) => void;
  onCancel: () => void;
  initial?: TemplateRow;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState(initial?.type ?? "character");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [isPreset, setIsPreset] = useState(initial?.is_preset ?? true);

  // 角色模板字段
  const d = initial?.data ?? {};
  const [charName, setCharName] = useState(d.name ?? "");
  const [charGender, setCharGender] = useState(d.gender ?? "");
  const [charPersonality, setCharPersonality] = useState(d.personality ?? "");
  const [charCatchphrase, setCharCatchphrase] = useState(d.catchphrase ?? "");
  const [charSpeech, setCharSpeech] = useState(d.speech_style ?? "");
  const [charIdentity, setCharIdentity] = useState(d.identity ?? "");
  const [charBackstory, setCharBackstory] = useState(d.backstory ?? "");
  const [charMotivation, setCharMotivation] = useState(d.motivation ?? "");
  const [charAppearance, setCharAppearance] = useState(d.appearance ?? "");

  // 世界观模板字段
  const [sections, setSections] = useState<{ name: string; content: string }[]>(
    d.sections?.length ? d.sections : [{ name: "时代与背景", content: "" }]
  );

  // 大纲模板字段
  const [chapters, setChapters] = useState<{ title: string; summary: string }[]>(
    d.chapters?.length ? d.chapters : [{ title: "", summary: "" }]
  );

  const buildData = (): any => {
    if (type === "character") {
      return { name: charName, gender: charGender, personality: charPersonality, catchphrase: charCatchphrase, speech_style: charSpeech, identity: charIdentity, backstory: charBackstory, motivation: charMotivation, appearance: charAppearance };
    }
    if (type === "world") return { sections: sections.filter((s) => s.name) };
    if (type === "outline") return { chapters: chapters.filter((c) => c.title) };
    return {};
  };

  const handleSave = () => onSave({ name, type, category, description: desc, data: buildData(), is_preset: isPreset, is_public: true });

  return (
    <div className="rounded-lg border border-border p-4 space-y-3 bg-muted/20">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">模板名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">类型</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm">
            {TYPES.map((t) => (<option key={t} value={t}>{TYPE_LABELS[t]}</option>))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">分类标签</label>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm" placeholder="如 仙侠/都市" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">简短描述</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">可见范围</span>
        <Button
          variant={isPreset ? "secondary" : "outline"}
          size="xs"
          onClick={() => setIsPreset(!isPreset)}
          title={isPreset ? "所有用户可见，出现在模板选择器中" : "仅自己可见"}
        >
          {isPreset ? "公共模板" : "私有"}
        </Button>
      </div>

      <Separator />

      {/* 模板数据：按类型展示不同表单 */}
      {type === "character" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="角色名" value={charName} onChange={setCharName} placeholder="用户新建时可修改" />
          <Field label="性别" value={charGender} onChange={setCharGender} />
          <Field label="身份/职业" value={charIdentity} onChange={setCharIdentity} />
          <Field label="口头禅" value={charCatchphrase} onChange={setCharCatchphrase} />
          <div className="col-span-2"><Field label="说话风格" value={charSpeech} onChange={setCharSpeech} /></div>
          <div className="col-span-2"><Field label="性格描述" value={charPersonality} onChange={setCharPersonality} textarea /></div>
          <div className="col-span-2"><Field label="背景故事" value={charBackstory} onChange={setCharBackstory} textarea /></div>
          <div className="col-span-2"><Field label="动机/目标" value={charMotivation} onChange={setCharMotivation} textarea /></div>
          <div className="col-span-2"><Field label="外貌描写" value={charAppearance} onChange={setCharAppearance} textarea /></div>
        </div>
      )}

      {type === "world" && (
        <div className="space-y-3">
          {sections.map((s, i) => (
            <div key={i} className="flex gap-2 items-start">
              <input value={s.name} onChange={(e) => { const ns = [...sections]; ns[i] = { ...ns[i], name: e.target.value }; setSections(ns); }}
                className="w-32 rounded border border-border bg-background px-2 py-1 text-sm" placeholder="分区名" />
              <textarea value={s.content} onChange={(e) => { const ns = [...sections]; ns[i] = { ...ns[i], content: e.target.value }; setSections(ns); }}
                rows={2} className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm resize-none" placeholder="分区内容" />
              <Button variant="ghost" size="icon-xs" onClick={() => setSections(sections.filter((_, j) => j !== i))}><Trash2 className="size-3 text-muted-foreground" /></Button>
            </div>
          ))}
          <Button variant="outline" size="xs" onClick={() => setSections([...sections, { name: "", content: "" }])}><Plus className="size-3" />添加分区</Button>
        </div>
      )}

      {type === "outline" && (
        <div className="space-y-3">
          {chapters.map((c, i) => (
            <div key={i} className="flex gap-2 items-start">
              <input value={c.title} onChange={(e) => { const nc = [...chapters]; nc[i] = { ...nc[i], title: e.target.value }; setChapters(nc); }}
                className="w-40 rounded border border-border bg-background px-2 py-1 text-sm" placeholder="章节标题" />
              <input value={c.summary} onChange={(e) => { const nc = [...chapters]; nc[i] = { ...nc[i], summary: e.target.value }; setChapters(nc); }}
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm" placeholder="章节摘要" />
              <Button variant="ghost" size="icon-xs" onClick={() => setChapters(chapters.filter((_, j) => j !== i))}><Trash2 className="size-3 text-muted-foreground" /></Button>
            </div>
          ))}
          <Button variant="outline" size="xs" onClick={() => setChapters([...chapters, { title: "", summary: "" }])}><Plus className="size-3" />添加章节</Button>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" onClick={handleSave}>保存</Button>
      </div>
    </div>
  );
}

/** 表单字段 */
function Field({ label, value, onChange, placeholder, textarea }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; textarea?: boolean }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} className="w-full rounded border border-border bg-background px-2 py-1 text-sm resize-none" placeholder={placeholder} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm" placeholder={placeholder} />
      )}
    </div>
  );
}

function TemplatesPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-templates"],
    queryFn: () => api.get<{ data: TemplateRow[] }>("/templates/admin/all"),
  });
  const templates = data?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (body: any) => api.post("/templates/admin/create", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
      setShowForm(false);
      toast({ title: "模板已创建" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.patch(`/templates/admin/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
      setEditing(null);
      toast({ title: "已更新" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/templates/admin/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
      toast({ title: "已删除" });
    },
  });

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-10 w-full" />))}</div>;

  return (
    <div className="space-y-3">
      {!showForm && !editing && (
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="size-4" /> 新建模板
        </Button>
      )}
      {showForm && <TemplateForm onSave={(d) => createMutation.mutate(d)} onCancel={() => setShowForm(false)} />}
      {editing && <TemplateForm initial={editing} onSave={(d) => updateMutation.mutate({ id: editing.template_id, body: d })} onCancel={() => setEditing(null)} />}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">名称</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">类型</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">分类</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground">预置</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.template_id} className="border-t border-border">
                <td className="px-4 py-2 flex items-center gap-2"><FileText className="size-3.5 text-muted-foreground" />{t.name}</td>
                <td className="px-4 py-2 text-xs">{TYPE_LABELS[t.type]}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{t.category}</td>
                <td className="px-4 py-2 text-center">{t.is_preset ? <span className="text-xs text-primary">✓</span> : <span className="text-xs text-muted-foreground">-</span>}</td>
                <td className="px-4 py-2">
                  <div className="flex justify-center gap-1">
                    <Button variant="ghost" size="icon-xs" title="编辑" onClick={() => setEditing(t)}>
                      <Pencil className="size-3" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" title="删除" onClick={() => { if (confirm(`删除「${t.name}」？`)) deleteMutation.mutate(t.template_id); }}>
                      <Trash2 className="size-3 text-destructive" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {templates.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">暂无模板</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============== 主页面 ==============

export function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("users");

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-xs" onClick={() => navigate("/")}><ArrowLeft className="size-4" /></Button>
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2"><Shield className="size-5 text-primary" />管理后台</h1>
      </div>

      <div className="flex gap-2 border-b border-border">
        {(["users", "templates"] as Tab[]).map((t) => (
          <button key={t}
            onClick={() => setTab(t)}
            className={cn("px-4 py-2 text-sm border-b-2 transition-colors", tab === t ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t === "users" ? "用户管理" : "模板管理"}
          </button>
        ))}
      </div>

      {tab === "users" ? <UsersPanel /> : <TemplatesPanel />}
    </div>
  );
}
