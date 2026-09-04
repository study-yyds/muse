import { useState, useEffect, useDeferredValue } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  monthly_words_quota?: number;
  created_at: string;
  total_tokens: number;
  request_count: number;
  month_words?: number;
  book_count?: number;
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

type Tab = "users" | "templates" | "audit";

const TYPES = ["character", "world", "outline"] as const;
const TYPE_LABELS: Record<string, string> = { character: "角色", world: "世界观", outline: "大纲" };

// ============== 用户管理 ==============

function UsersPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const me = useAuthStore((s) => s.user);
  const [page, setPage] = useState(1);
  const [phoneQuery, setPhoneQuery] = useState("");
  // 搜索防抖：输入框即时响应，查询参数延迟提交（避免每敲一个字就发起一次请求、卡输入）
  const debouncedQuery = useDeferredValue(phoneQuery);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-users", page, debouncedQuery],
    queryFn: () =>
      api.get<{ data: { items: UserRow[]; total: number; page: number } }>(
        `/admin/users?page=${page}&pageSize=20${debouncedQuery.trim() ? `&phone=${encodeURIComponent(debouncedQuery.trim())}` : ""}`
      ),
    // 搜索词/翻页切换时先保留上一份数据展示，避免骨架屏闪断、输入框重挂载丢焦点
    placeholderData: (prev: any) => prev,
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
      body: {
        role?: string;
        status?: string;
        book_limit?: number;
        monthly_words_quota?: number;
      };
    }) => api.patch(`/admin/users/${userId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({ title: "已更新" });
    },
    onError: (e: any) => {
      toast({ title: e?.message ?? "操作失败", variant: "destructive" });
    },
  });

  return (
    <>
      {/* 搜索框常驻渲染：不在 isLoading 分支里，切换搜索词不会重挂载丢焦点 */}
      <div className="flex items-center gap-2 mb-3">
        <Input
          value={phoneQuery}
          onChange={(e) => { setPhoneQuery(e.target.value); setPage(1); }}
          placeholder="按手机号搜索..."
          className="max-w-56"
        />
      </div>
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-12 w-full" />))}</div>
      ) : (
        <>
      <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">手机号</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">注册时间</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">角色</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">状态</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">作品数</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">本月字数</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">字数/月额度</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">Token</th>
              <th className="text-center px-4 py-2 font-medium text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id} className="border-t border-border">
                <td className="px-4 py-2.5 flex items-center gap-2"><UserRound className="size-3.5 text-muted-foreground" />{u.phone_number}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {u.created_at ? new Date(u.created_at).toLocaleDateString("zh-CN") : "-"}
                </td>
                <td className="px-4 py-2.5"><span className={u.role === "admin" ? "text-primary font-medium" : "text-foreground"}>{u.role === "admin" ? "管理员" : "用户"}</span></td>
                <td className="px-4 py-2.5"><span className={u.status === "active" ? "text-green-600" : u.status === "suspended" ? "text-yellow-600" : "text-red-600"}>{u.status === "active" ? "正常" : u.status === "suspended" ? "暂停" : "封禁"}</span></td>
                <td
                  className="px-4 py-2.5 text-right"
                  title={u.book_limit === -1 ? "作品上限：不限" : `作品上限：${u.book_limit}`}
                >
                  {u.book_count ?? 0}
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                  {(u.month_words ?? 0).toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <input
                    type="number"
                    defaultValue={u.monthly_words_quota ?? 30000}
                    disabled={u.user_id === me?.user_id}
                    title={
                      u.user_id === me?.user_id
                        ? "不能修改自己的账户"
                        : "月度 AI 字数额度（-1 表示不限）"
                    }
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      if (v === (u.monthly_words_quota ?? 30000)) return;
                      updateMutation.mutate({
                        userId: u.user_id,
                        body: { monthly_words_quota: v },
                      });
                    }}
                    className="w-24 text-right rounded border border-border bg-background px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{u.total_tokens?.toLocaleString()}</td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-center gap-1">
                    <Button variant="ghost" size="icon-xs" disabled={u.user_id === me?.user_id}
                      title={u.user_id === me?.user_id ? "不能修改自己的账户" : u.status === "active" ? "暂停" : "恢复"}
                      onClick={() => updateMutation.mutate({ userId: u.user_id, body: { status: u.status === "active" ? "suspended" : "active" } })}>
                      {u.status === "active" ? <Ban className="size-3 text-yellow-600" /> : <CheckCircle className="size-3 text-green-600" />}
                    </Button>
                    <Button variant="ghost" size="icon-xs" disabled={u.user_id === me?.user_id}
                      title={u.user_id === me?.user_id ? "不能修改自己的账户" : u.role === "admin" ? "降级" : "升级"}
                      onClick={() => updateMutation.mutate({ userId: u.user_id, body: { role: u.role === "admin" ? "user" : "admin" } })}>
                      <Shield className={`size-3 ${u.role === "admin" ? "text-primary" : "text-muted-foreground"}`} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">暂无用户</td></tr>}
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

      <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
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

// ============== 审计日志 ==============

interface AuditRow {
  id: string;
  action: string;
  detail: any;
  operator_phone: string;
  target_phone: string;
  created_at: string;
}

function AuditPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-audit"],
    queryFn: () => api.get<{ data: AuditRow[] }>(`/admin/audit-logs`),
  });
  const logs = data?.data ?? [];

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  const detailText = (d: any) => {
    if (!d || typeof d !== "object") return "-";
    const parts: string[] = [];
    const labels: Record<string, string> = {
      role: "角色",
      status: "状态",
      book_limit: "作品数",
      monthly_words_quota: "字数/月",
    };
    for (const [k, v] of Object.entries(d)) {
      if (k in labels) parts.push(`${labels[k]}=${v}`);
    }
    return parts.join("，") || "-";
  };

  return (
    <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">时间</th>
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">操作者</th>
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">目标</th>
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">操作</th>
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">详情</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} className="border-t border-border">
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {new Date(l.created_at).toLocaleString("zh-CN")}
              </td>
              <td className="px-4 py-2.5">{l.operator_phone}</td>
              <td className="px-4 py-2.5">{l.target_phone}</td>
              <td className="px-4 py-2.5">
                {l.action === "update_user" ? "修改用户" : l.action}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">{detailText(l.detail)}</td>
            </tr>
          ))}
          {logs.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">暂无审计记录</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ============== 主页面 ==============

export function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("users");
  const user = useAuthStore((s) => s.user);

  // 平台总用量
  const { data: usageData } = useQuery({
    queryKey: ["admin-usage"],
    queryFn: () =>
      api.get<{
        data: {
          total: { total_tokens: number; request_count: number };
          by_model: Array<{ model_name: string; total_tokens: number; request_count: number }>;
        };
      }>("/admin/usage"),
    enabled: user?.role === "admin",
  });
  const usage = usageData?.data;

  // 前端角色守卫：非 admin 直接回首页（数据层仍有后端 AdminGuard 兜底）
  useEffect(() => {
    if (user && user.role !== "admin") {
      navigate("/", { replace: true });
    }
  }, [user, navigate]);

  if (!user || user.role !== "admin") return null;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-xs" onClick={() => navigate("/")}><ArrowLeft className="size-4" /></Button>
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2"><Shield className="size-5 text-primary" />管理后台</h1>
      </div>

      {/* 平台总用量概览 */}
      {usage && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">全站 Token 总消耗</p>
            <p className="mt-1 text-2xl font-semibold text-foreground">
              {(usage.total.total_tokens ?? 0).toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              共 {usage.total.request_count ?? 0} 次请求
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">按模型分布</p>
            <div className="mt-1 space-y-1">
              {(usage.by_model ?? []).slice(0, 6).map((m) => (
                <div key={m.model_name} className="flex justify-between text-xs">
                  <span className="text-foreground truncate">{m.model_name}</span>
                  <span className="text-muted-foreground ml-2 shrink-0">
                    {m.total_tokens.toLocaleString()} tokens
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2 border-b border-border">
        {(["users", "templates", "audit"] as Tab[]).map((t) => (
          <button key={t}
            onClick={() => setTab(t)}
            className={cn("px-4 py-2 text-sm border-b-2 transition-colors", tab === t ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t === "users" ? "用户管理" : t === "templates" ? "模板管理" : "审计日志"}
          </button>
        ))}
      </div>

      {tab === "users" ? <UsersPanel /> : tab === "templates" ? <TemplatesPanel /> : <AuditPanel />}
    </div>
  );
}
