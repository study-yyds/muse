import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, authFetch, fetchQuotaRemaining } from "@/services/api";
import { WRITING_STYLES } from "@/lib/writing-styles";
import { ModelSelector, customKeyValue } from "@/components/settings/ModelSelector";
import type { BookDetail } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { CharacterList } from "@/components/characters/CharacterList";
import { WorldSettingEditor } from "@/components/world/WorldSettingEditor";
import { OutlinePanel } from "@/components/outline/OutlinePanel";
import { WritingEditor } from "@/components/editor/WritingEditor";
import { BookSettingsPanel } from "@/components/settings/BookSettingsPanel";
import { WritingStats } from "@/components/WritingStats";
import { useEditorStore } from "@/stores/editor";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowLeft, UserRound, Globe, ListTree, FileText, Download, Send, Loader2, Sparkles, Settings, BarChart3, Menu, Square } from "lucide-react";
import { cn } from "@/lib/utils";

type Section = "write" | "outline" | "characters" | "world" | "settings" | "stats";
const NAV_ITEMS: { key: Section; label: string; icon: typeof FileText }[] = [
  { key: "write", label: "写作", icon: FileText },
  { key: "outline", label: "大纲", icon: ListTree },
  { key: "characters", label: "角色", icon: UserRound },
  { key: "world", label: "世界观", icon: Globe },
  { key: "stats", label: "统计", icon: BarChart3 },
  { key: "settings", label: "设置", icon: Settings },
];

/** 左侧导航内容（桌面侧边栏和移动端 Sheet 共用） */
function SidebarNav({
  book,
  section,
  onSectionChange,
  onNavigate,
  coverUrl,
}: {
  book: BookDetail;
  section: Section;
  onSectionChange: (s: Section) => void;
  onNavigate: () => void;
  coverUrl?: string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(book.title);

  const saveTitle = async () => {
    if (!titleDraft.trim() || titleDraft === book.title) { setEditingTitle(false); return; }
    try {
      await api.patch(`/books/${book.book_id}`, { title: titleDraft.trim() });
      queryClient.invalidateQueries({ queryKey: ["book", book.book_id] });
      toast({ title: "书名已更新" });
    } catch { toast({ title: "更新失败", variant: "destructive" }); }
    setEditingTitle(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 封面缩略图 */}
      <div
        className="mx-3 mt-3 rounded-lg overflow-hidden bg-muted cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
        onClick={onSectionChange.bind(null, "settings")}
        title="点击进入设置管理封面"
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={book.title}
            className="w-full aspect-[2/3] object-cover"
          />
        ) : (
          <div className="w-full aspect-[2/3] flex items-center justify-center">
            <span className="text-muted-foreground text-xs">暂无封面</span>
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-b border-border">
        <Button variant="ghost" size="icon-xs" className="mb-2" onClick={onNavigate}>
          <ArrowLeft className="size-4" />
        </Button>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
            className="w-full text-sm font-semibold bg-transparent border-b border-primary outline-none text-foreground"
          />
        ) : (
          <h1
            className="text-sm font-semibold text-foreground truncate cursor-pointer hover:text-primary transition-colors"
            onClick={() => { setTitleDraft(book.title); setEditingTitle(true); }}
            title="点击编辑书名"
          >
            {book.title}
          </h1>
        )}
        <p className="text-xs text-muted-foreground">{book.word_count.toLocaleString()} 字</p>
      </div>
      <div className="flex-1 py-2">
        {(book.type === 'short' ? NAV_ITEMS.filter(i => i.key === 'write' || i.key === 'settings') : NAV_ITEMS).map((item) => (
          <button
            key={item.key}
            onClick={() => onSectionChange(item.key)}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left",
              section === item.key
                ? "bg-muted text-foreground font-medium border-l-[3px] border-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border-l-[3px] border-transparent"
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </div>
      <div className="p-3 border-t border-border flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="flex-1 justify-center gap-2">
                <Download className="size-4" />
                导出
              </Button>
            }
          />
          <DropdownMenuContent side="right" align="start">
            {(["txt", "docx", "html", "epub"] as const).map((fmt) => (
              <DropdownMenuItem
                key={fmt}
                onClick={async () => {
                  const t = localStorage.getItem("token");
                  try {
                    const res = await fetch(`/api/books/${book.book_id}/export?format=${fmt}`, {
                      headers: { Authorization: `Bearer ${t}` },
                    });
                    if (!res.ok) throw new Error("导出失败");
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${book.title}.${fmt}`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch {
                    alert("导出失败，请稍后重试");
                  }
                }}
              >
                导出 {fmt.toUpperCase()}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ThemeToggle />
      </div>
    </div>
  );
}

export function BookDetailPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = (searchParams.get("tab") as Section) || "write";
  const setSection = (s: Section) => setSearchParams({ tab: s }, { replace: true });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileAiExpanded, setMobileAiExpanded] = useState(false);
  const [aiPanelHeight, setAiPanelHeight] = useState(45); // vh
  // AI 面板宽度：拖拽后持久化，刷新保持（钳制 200-500）
  const [aiPanelWidth, setAiPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem("muse_ai_panel_width"));
    return Number.isFinite(saved) && saved >= 200 && saved <= 500 ? saved : 288;
  });
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.get<{ data: BookDetail }>(`/books/${bookId}`),
    enabled: !!bookId,
  });
  const book = data?.data;

  useEffect(() => { if (book?.cover_url) setCoverUrl(book.cover_url); }, [book]);

  if (isLoading)
    return (
      <div className="mx-auto max-w-5xl px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  if (!book)
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <p>作品不存在</p>
        <Button variant="link" onClick={() => navigate("/")}>
          返回
        </Button>
      </div>
    );

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* ===== 桌面端左侧导航 ===== */}
      <nav className="hidden md:block w-48 shrink-0 border-r border-border bg-card">
        <SidebarNav
          book={book}
          section={section}
          onSectionChange={setSection}
          onNavigate={() => navigate("/")}
          coverUrl={coverUrl}
        />
      </nav>

      {/* ===== 移动端导航 Sheet ===== */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="!w-44 p-0" showCloseButton={false}>
          <SidebarNav
            book={book}
            section={section}
            onSectionChange={(s) => {
              setSection(s);
              setMobileNavOpen(false);
            }}
            onNavigate={() => {
              setMobileNavOpen(false);
              navigate("/");
            }}
            coverUrl={coverUrl}
          />
        </SheetContent>
      </Sheet>

      {/* ===== 中间内容区 ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 移动端顶栏：汉堡菜单 + 书名 */}
        <div className="flex md:hidden items-center gap-2 px-4 py-2 border-b border-border bg-card shrink-0">
          <Button variant="ghost" size="icon-xs" onClick={() => setMobileNavOpen(true)}>
            <Menu className="size-4" />
          </Button>
          <span className="text-sm font-medium text-foreground truncate">{book.title}</span>
          {/* 移动端 AI 切换按钮 */}
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto lg:hidden"
            onClick={() => setMobileAiExpanded(!mobileAiExpanded)}
          >
            <Sparkles className="size-4" />
          </Button>
        </div>

        {/* 主内容区 */}
        <div className="flex-1 min-h-0">
          {section === "write" && bookId && <WritingEditor bookId={bookId} bookType={book.type} />}
          {section === "outline" && bookId && (
            <div className="p-4 h-full min-h-0"><OutlinePanel bookId={bookId} /></div>
          )}
          {section === "characters" && bookId && (
            <div className="p-4 h-full overflow-y-auto"><CharacterList bookId={bookId} /></div>
          )}
          {section === "world" && bookId && (
            <div className="p-4 h-full overflow-y-auto"><WorldSettingEditor bookId={bookId} /></div>
          )}
          {section === "stats" && bookId && (
            <div className="p-4 h-full overflow-y-auto"><WritingStats bookId={bookId} /></div>
          )}
          {section === "settings" && bookId && (
            <div className="h-full overflow-y-auto"><BookSettingsPanel bookId={bookId} book={book} coverUrl={coverUrl} onCoverChange={setCoverUrl} /></div>
          )}
        </div>

        {/* ===== 移动端 AI 面板：可拖拽调整高度 ===== */}
        {isMobile && mobileAiExpanded && (
          <div className="border-t border-border bg-card shrink-0 relative" style={{ height: `${aiPanelHeight}vh` }}>
            {/* 拖动把手 */}
            <div
              className="absolute top-0 left-0 right-0 h-4 flex items-center justify-center cursor-ns-resize active:cursor-ns-resize z-10"
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                const startY = e.clientY;
                const startH = aiPanelHeight;
                const onMove = (ev: PointerEvent) => {
                  const deltaY = startY - ev.clientY;
                  const vhDelta = (deltaY / window.innerHeight) * 100;
                  setAiPanelHeight(Math.max(20, Math.min(80, startH + vhDelta)));
                };
                const onUp = () => {
                  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { }
                  document.removeEventListener("pointermove", onMove);
                  document.removeEventListener("pointerup", onUp);
                };
                document.addEventListener("pointermove", onMove);
                document.addEventListener("pointerup", onUp);
              }}
            >
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>
            <AIChatPanel section={section} bookId={bookId ?? ""} initialStyle={book?.preset_style} />
          </div>
        )}
      </div>

      {/* ===== 桌面端 AI 面板 ===== */}
      {!isMobile && (
        <div className="flex shrink-0 border-l border-border bg-card flex-col h-full relative" style={{ width: aiPanelWidth, minWidth: 320, maxWidth: 9000 }}>
          {/* 左边缘拖动把手 */}
          <div
            className="absolute top-0 -left-1 w-2 h-full cursor-col-resize z-10 hover:bg-primary/20 transition-colors"
            onPointerDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = aiPanelWidth;
              const onMove = (ev: PointerEvent) => {
                const delta = startX - ev.clientX;
                const newWidth = Math.min(500, Math.max(200, startWidth + delta));
                setAiPanelWidth(newWidth);
                // 拖动过程持续落盘，刷新后保持上次宽度
                localStorage.setItem("muse_ai_panel_width", String(newWidth));
              };
              const onUp = () => {
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
              };
              document.addEventListener("pointermove", onMove);
              document.addEventListener("pointerup", onUp);
            }}
          />
          <AIChatPanel section={section} bookId={bookId ?? ""} initialStyle={book?.preset_style} />
        </div>
      )}
    </div>
  );
}

/**
 * 合并世界观分区：按分区名覆盖/追加。
 * AI 采纳 update_section(s) 时后端是全量替换语义，若只回传单个分区会清空
 * 其余分区，因此必须先读取现有分区做合并再提交。
 */
async function mergeWorldSections(
  bookId: string,
  token: string | null,
  incoming: Array<{ name: string; content: string }>,
): Promise<Array<{ name: string; content: string; sort_order?: number }>> {
  const res = await fetch(`/api/books/${bookId}/world-setting`, {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
  const json = await res.json().catch(() => null);
  const existing: Array<{ name: string; content: string; sort_order?: number }> =
    json?.data?.sections ?? [];
  const merged = [...existing];
  for (const sec of incoming) {
    if (!sec?.name) continue;
    const idx = merged.findIndex((s) => s.name === sec.name);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], content: sec.content };
    } else {
      merged.push({ name: sec.name, content: sec.content, sort_order: merged.length + 1 });
    }
  }
  return merged;
}

function AIChatPanel({ section, bookId, initialStyle }: { section: string; bookId: string; initialStyle?: string }) {
  type Ver = { content: string; action?: any; reasoning?: string };
  type Msg = { role: string; content: string; action?: any; adoptedVer?: number; reasoning?: string; versions?: Ver[]; quality?: { count: number; types: string[] } };
  // AI 味检测类型 → 中文提示（与 text-quality-checks.ts 的 issue.type 对应）
  const QUALITY_LABELS: Record<string, string> = {
    "dash-overuse": "破折号过密",
    "binary-shell": '"不是…而是"句式',
    "epiphany-ending": "句尾顿悟式总结",
    "env-opening": "开篇环境描写",
    "uniform-sentence-length": "句长过均匀",
    "summary-ending": "段末总结句",
    "parallel-triad": "三元排比",
    "subject-repetition": "主语重复",
    "subject-action-chain": "主语短动作连发",
    "name-variants": "称谓待核对",
    "fantasy-overuse": '"仿佛/宛如"过密',
    "mind-reporting": "解释腔",
  };
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [streaming, setStreaming] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("deepseek-v4-flash");
  const [modelKeyId, setModelKeyId] = useState<string | undefined>(undefined);
  // 中文数字转阿拉伯（支持 1-99：一/二/十/十一/二十/九十九）
  const zhNum = (s: string): number | null => {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s === "十") return 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]?$/.test(s)) {
      const [t, o] = [s[0], s.length > 1 ? s[1] : ""];
      return (map[t] ?? 0) * 10 + (o ? (map[o] ?? 0) : 0);
    }
    if (map[s] != null) return map[s];
    return null;
  };

  // 按"第N章"标题拆分多章正文：标题行作章节名，正文按章分段
  const splitChapters = (text: string): Array<{ title: string; content: string }> => {
    const lines = text.split("\n");
    const heads: number[] = [];
    lines.forEach((l, i) => {
      if (/^(?:#{1,3}\s*)?第[一二三四五六七八九十百\d]+\s*章/.test(l.trim())) heads.push(i);
    });
    if (heads.length === 0) return [{ title: "", content: text }];
    const segs: Array<{ title: string; content: string }> = [];
    // 第一个标题前的文字（如无标题的引子）作为无标题段
    const pre = lines.slice(0, heads[0]).join("\n").trim();
    if (pre) segs.push({ title: "", content: pre });
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i];
      const end = i + 1 < heads.length ? heads[i + 1] : lines.length;
      const title = lines[start].trim().replace(/^#{1,3}\s*/, "").slice(0, 30);
      const body = lines
        .slice(start + 1, end)
        .join("\n")
        .trim();
      if (body) segs.push({ title, content: body });
    }
    return segs;
  };
  const [chatStyle, setChatStyle] = useState(initialStyle ?? "default");
  // 书设置里切换风格预设时同步到面板（快捷创作默认"快节奏网文"）
  useEffect(() => { setChatStyle(initialStyle ?? "default"); }, [initialStyle]);
  const [guideMode, setGuideMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeVer, setActiveVer] = useState<Record<number, number>>({});
  // 反馈重新生成：按消息索引展开输入框
  const [feedbackOpen, setFeedbackOpen] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollBottomRef = useRef<HTMLDivElement | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const isRegeneratingRef = useRef(false);
  const stoppedByUserRef = useRef(false);
  const autoSaveIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const adoptingRef = useRef(false);
  const streamingRef = useRef("");
  const reasoningRef = useRef("");
  // 会话 ID ref：卸载保存时读取最新值（此前闭包捕获的是首次渲染的 null，导致保存逻辑从未生效）
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);
  useEffect(() => { reasoningRef.current = reasoning; }, [reasoning]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rewriteCtx = useEditorStore((s) => s.aiRewriteContext);
  const clearRewrite = useEditorStore((s) => s.clearAiRewrite);
  // 不要用 useEditorStore() 整体订阅：编辑器每次按键都会更新 store，
  // 会导致整个 AI 面板重渲染。事件处理里按需 getState() 读取即可
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // 笔风分析结果：存在时风格下拉出现"我的笔风"选项
  const { data: settingsData } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () =>
      api.get<{ data: { extra?: { mimic_style_analysis?: string } } }>(
        `/books/${bookId}/settings`,
      ),
    enabled: !!bookId,
  });
  const mimicAnalysis = settingsData?.data?.extra?.mimic_style_analysis ?? null;
  const token = localStorage.getItem("token");

  // 从后端加载会话
  const loadSessions = async () => {
    try {
      const res = await fetch(
        `/api/ai/chat-sessions/${bookId}?section=${encodeURIComponent(section)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const json = await res.json();
      const data = json?.data;
      if (data?.active) {
        setSessionId(data.active.id);
        setMsgs(data.active.messages ?? []);
      } else {
        setSessionId(null);
        setMsgs([]);
      }
      setSessions(data?.sessions ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadSessions().then(() => {
      // 检测刷新前中断的生成，自动重新生成
      const curMsgs = msgsRef.current;
      const last = curMsgs[curMsgs.length - 1];
      if (last?.role === "assistant" && last.content === "（生成中...）") {
        setTimeout(() => regenerate(), 500);
      }
    });
    return () => {
      // 卸载前保存当前流式内容，防止切换 tab 丢失 AI 生成的内容
      const curMsgs = msgsRef.current;
      const curStream = streamingRef.current;
      const curReasoning = reasoningRef.current;
      const sid = sessionIdRef.current;
      if ((curStream || curReasoning) && sid && curMsgs.length > 0) {
        const lastMsg = curMsgs[curMsgs.length - 1];
        const partialContent = curStream || (lastMsg?.role === 'assistant' ? lastMsg.content : '（生成中...）');
        const partialMsgs =
          lastMsg?.role === 'user'
            ? [...curMsgs, { role: 'assistant' as const, content: partialContent, reasoning: curReasoning || undefined }]
            : [...curMsgs.slice(0, -1), { ...curMsgs[curMsgs.length - 1], content: partialContent, reasoning: curReasoning || undefined }];
        fetch(`/api/ai/chat-sessions/${sid}/messages`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ messages: partialMsgs }),
        }).catch(() => {});
      }
      clearTimeout(saveTimer.current);
      if (autoSaveIntervalRef.current) clearInterval(autoSaveIntervalRef.current);
      if (abortRef.current) {
        // 标记为用户主动中断（切 tab），doSend 的 catch 不再用错误消息覆盖已保存的生成内容
        stoppedByUserRef.current = true;
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [bookId, section]);

  // 消息变化时自动滚到底部
  useEffect(() => {
    scrollBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, streaming, reasoning]);

  // 防抖保存消息到后端
  const saveMsgs = (newMsgs: Msg[]) => {
    setMsgs(newMsgs);
    if (!sessionId) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await fetch(`/api/ai/chat-sessions/${sessionId}/messages`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ messages: newMsgs }),
        });
      } catch { /* ignore */ }
    }, 1000);
  };

  // 有新消息时立即保存（不等 debounce）
  const flushSave = async (session: string, msgsList: Msg[]) => {
    clearTimeout(saveTimer.current);
    try {
      await fetch(`/api/ai/chat-sessions/${session}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: msgsList }),
      });
    } catch { /* ignore */ }
  };

  // 确保有活跃会话，没有则创建（不调用 loadSessions 避免覆盖当前消息）
  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    try {
      const res = await fetch("/api/ai/chat-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId, section }),
      });
      const json = await res.json();
      const id = json?.data?.id;
      if (id) {
        setSessionId(id);
        // 异步刷新会话列表（不影响当前消息状态）
        loadSessions();
        return id;
      }
    } catch {
      toast({ title: "无法创建会话", variant: "destructive" });
    }
    return null;
  };

  // "新对话"按钮
  const newSession = async () => {
    try {
      const res = await fetch("/api/ai/chat-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: bookId, section }),
      });
      const json = await res.json();
      if (json?.data?.id) {
        setSessionId(json.data.id);
        setMsgs([]);
        await loadSessions();
        toast({ title: "已开启新对话" });
      }
    } catch {
      toast({ title: "创建失败", variant: "destructive" });
    }
  };

  // 恢复历史会话
  const restoreSession = async (id: string) => {
    try {
      await fetch(`/api/ai/chat-sessions/${id}/restore`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      await loadSessions();
      setHistoryOpen(false);
      toast({ title: "已恢复对话" });
    } catch {
      toast({ title: "恢复失败", variant: "destructive" });
    }
  };

  // 删除历史会话
  const deleteSession = async (id: string) => {
    try {
      await fetch(`/api/ai/chat-sessions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await loadSessions();
    } catch {
      toast({ title: "删除失败", variant: "destructive" });
    }
  };

  // 渲染时兜底：从末尾 JSON action 位置一刀切
  const stripActionJson = (t: string) => {
    if (!t) return "";
    let idx = t.lastIndexOf('\n[{"action"');
    if (idx < 0) idx = t.lastIndexOf('\n{"action"');
    if (idx > 0) return t.slice(0, idx).trim();
    idx = t.lastIndexOf('[{"action"');
    if (idx < 0) idx = t.lastIndexOf('{"action"');
    if (idx === 0) return ""; // 整个文本就是 JSON
    if (idx > 0) return t.slice(0, idx).trim();
    return t;
  };

  // 行首 Markdown 标题标记（## 等）剥离：模型偶发不遵循纯文本要求
  const stripMdHeadings = (t: string) => t.replace(/^#{1,6}\s+/gm, "");

  const extractDisplayText = (t: string) => {
    if (!t.trim()) return "";
    let s = t.trim();
    // 处理 markdown 代码块包裹（可能在开头或中间或末尾）
    if (s.startsWith("\`\`\`json")) s = s.slice(7);
    if (s.startsWith("\`\`\`")) s = s.slice(3);
    if (s.endsWith("\`\`\`")) s = s.slice(0, -3);
    // 末尾有 ```json 代码块 → 整体切掉
    const fenceIdx = s.lastIndexOf("\n\`\`\`json\n");
    if (fenceIdx > 0) s = s.slice(0, fenceIdx);
    s = s.trim();
    // 纯 JSON → 提取可读内容
    if (s.startsWith("{")) {
      try {
        const p = JSON.parse(s);
        if (p.sections?.length) {
          return p.sections
            .map((sec: any) => `【${sec.name}】\n${sec.content}`)
            .join("\n\n");
        }
        if (p.name) return `角色：${p.name}\n${p.personality ?? ""}`;
        return p.content || p.action || s;
      } catch {
        return s;
      }
    }
    if (s.startsWith("[")) {
      try {
        const arr = JSON.parse(s);
        if (arr.length && arr[0].name && arr[0].content) {
          return arr
            .map((sec: any) => `【${sec.name}】\n${sec.content}`)
            .join("\n\n");
        }
        if (arr.length && arr[0].action === "create_character") {
          return arr
            .map((c: any) => `【${c.name}】${c.gender ?? ""} · ${c.identity ?? ""}\n${c.personality ?? ""}`)
            .join("\n\n");
        }
        if (arr.length && arr[0].action === "add_chapter") {
          return arr
            .map((n: any) => {
              const act = n.act_name ? `【${n.act_name}】` : "";
              return `${act}${n.title}\n${n.summary}`;
            })
            .join("\n\n");
        }
      } catch { /* fall through */ }
    }
    // 末尾有 JSON action（完整或截断）→ 找 {"action" 而非最后一个 {（后者可能在嵌套对象里）
    let actionIdx = s.lastIndexOf('\n{"action"');
    if (actionIdx < 0) actionIdx = s.lastIndexOf('\n[{"action"');
    if (actionIdx < 0) actionIdx = s.lastIndexOf('{"action"');
    if (actionIdx < 0) actionIdx = s.lastIndexOf('[{"action"');
    if (actionIdx >= 0) {
      if (actionIdx === 0) return ""; // 整个文本就是 JSON action
      try {
        const p = JSON.parse(s.slice(actionIdx));
        if (p.action || (Array.isArray(p) && p.length > 0)) return s.slice(0, actionIdx).trim();
      } catch {
        // 截断的 JSON：仍尝试去除
        return s.slice(0, actionIdx).trim();
      }
    }
    return s;
  };

  const streamOnce = async (
    msg: string, prevMsgs: { role: string; content: string }[],
    bodyExtra?: Record<string, any>, signal?: AbortSignal,
    onStream?: (ac: string, ar: string) => void,
  ): Promise<{ content: string; action?: any; reasoning: string; quality?: { count: number; types: string[] } }> => {
    const r = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        book_id: bookId,
        context_type: section,
        model,
        key_id: modelKeyId,
        message: msg,
        messages: prevMsgs,
        // 带当前章节和光标位置，让 AI 知道正在写的内容
        chapter_id: useEditorStore.getState().activeChapterId ?? undefined,
        cursor_position: useEditorStore.getState().cursorPosition ?? undefined,
        ...bodyExtra,
      }),
      signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const reader = r.body?.getReader(); if (!reader) throw new Error("无响应");
    const decoder = new TextDecoder(); let buf = ""; let ac = ""; let ar = ""; let action: any = undefined; let quality: { count: number; types: string[] } | undefined = undefined;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() ?? "";
      let ev = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (ev === "chunk") {
            try { ac += JSON.parse(payload); } catch { ac += payload; }
          }
          if (ev === "reasoning") {
            try { ar += JSON.parse(payload); } catch { ar += payload; }
          }
          if (ev === "action") { try { action = JSON.parse(payload); } catch { /* ignore */ } }
          if (ev === "quality") { try { quality = JSON.parse(payload); } catch { /* ignore */ } }
          if (ev === "error") {
            try { const err = JSON.parse(payload); toast({ title: err.message || "AI 错误", variant: "destructive" }); } catch { toast({ title: "AI 请求失败", variant: "destructive" }); }
          }
          ev = "";
        }
      }
      if (onStream) {
        onStream(ac, ar);
      } else {
        if (ar) setReasoning(ar);
        if (ac) setStreaming(extractDisplayText(ac));
      }
    }
    return { content: ac ? extractDisplayText(ac) : "", action, reasoning: ar, quality };
  };

  // 整章生成循环：按目标章号列表逐个生成（每章独立 SSE 调用，追加式写入）
  const generateChaptersLoop = async (targets: number[], label: string) => {
    // 预估成本提示（每章约 4000 字）
    const remaining = await fetchQuotaRemaining();
    const estimate = targets.length * 4000;
    if (remaining != null) {
      if (remaining < estimate) {
        toast({ title: `本月剩余 ${remaining.toLocaleString()} 字，生成${label}（约 ${estimate.toLocaleString()} 字）可能超额`, variant: "destructive" });
      } else {
        toast({ title: `本次预计消耗约 ${estimate.toLocaleString()} 字（本月剩余 ${remaining.toLocaleString()} 字）` });
      }
    }
    const um: Msg = { role: "user", content: `生成${label}` };
    const newMsgs = [...msgs, um];
    setMsgs(newMsgs);
    if (sessionId) flushSave(sessionId, newMsgs);
    setInput("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const results: string[] = [];
    let lastChapterId = useEditorStore.getState().activeChapterId;
    try {
      for (const targetSort of targets) {
        // 确保目标章节存在（目标就是当前章时不切换）
        const listRes = await fetch(`/api/books/${bookId}/chapters`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const listData = await listRes.json();
        const chs = listData?.data ?? [];
        let target = chs.find((c: any) => c.sort_order === targetSort);
        if (!target) {
          const createRes = await fetch(`/api/books/${bookId}/chapters`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ title: `第${targetSort}章` }),
          });
          const createData = await createRes.json();
          target = createData?.data ?? null;
        }
        if (!target?.chapter_id) throw new Error(`第${targetSort}章创建失败`);
        if (lastChapterId !== target.chapter_id) {
          useEditorStore.getState().setActiveChapter(target.chapter_id);
          useEditorStore.getState().requestChapterSwitch(target.chapter_id);
        }
        lastChapterId = target.chapter_id;
        queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });

        const res = await authFetch(
          "/api/ai/generate-chapter",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              book_id: bookId,
              chapter_id: target.chapter_id,
            }),
            signal: controller.signal,
          },
          20 * 60_000,
        );
        if (!res.ok) throw new Error(`第${targetSort}章请求失败 (${res.status})`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("无响应");
        const decoder = new TextDecoder();
        let buf = "";
        let genLength = 0;
        let genWarnings: string[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) { buf += decoder.decode(); break; }
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop() ?? "";
          let ev = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (ev === "done") {
                genLength = data.length ?? 0;
                genWarnings = data.warnings ?? [];
              }
              if (ev === "error") throw new Error(data.message || "生成失败");
            } catch (err: any) {
              if (ev === "error") {
                throw err instanceof Error ? err : new Error("生成失败");
              }
            }
          }
        }
        results.push(`第${targetSort}章 ${genLength} 字`);
        if (genWarnings.length) {
          toast({ title: `第${targetSort}章：${genWarnings[0]}`, variant: "destructive" });
        }
      }
      queryClient.invalidateQueries({ queryKey: ["chapter", bookId, lastChapterId ?? ""] });
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["book", bookId] });
      const finalMsgs = [...newMsgs, { role: "assistant", content: `已生成${label}：${results.join("、")}` }];
      setMsgs(finalMsgs);
      if (sessionId) flushSave(sessionId, finalMsgs);
      toast({ title: `已生成${label}` });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        const errMsgs = [...newMsgs, { role: "assistant", content: `（${err?.message ?? "生成失败"}）` }];
        setMsgs(errMsgs);
        if (sessionId) flushSave(sessionId, errMsgs);
        toast({ title: err?.message || "生成失败", variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  };

  const doSend = async (userMsg: string) => {
    // 错面板提示：在角色/世界观等面板请求写正文时提醒（不阻断发送，AI 侧也会引导）
    if (
      section !== "write" &&
      section !== "outline" &&
      /(生成|写|续写).*(第.{1,3}章|正文|小说|故事)/.test(userMsg)
    ) {
      toast({ title: "提示：生成正文请切换到「写作」面板" });
    }
    // 整章生成意图："生成第N章"（单章）/ "生成前N章"（多章循环）→ 路由到整章生成
    if (section === "write") {
      const gMatch = userMsg.match(/(?:生成|写)\s*(第|前|共)?([一二三四五六七八九十百\d]+)\s*章/);
      if (gMatch) {
        const prefix = gMatch[1] ?? "";
        const num = zhNum(gMatch[2]);
        if (num != null && num >= 1) {
          if (prefix === "第") {
            await generateChaptersLoop([num], `第${gMatch[2]}章`);
          } else {
            // "生成前N章"：从当前章开始共 N 章
            let curSort = 1;
            try {
              const listRes = await fetch(`/api/books/${bookId}/chapters`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              const listData = await listRes.json();
              const chs = listData?.data ?? [];
              curSort =
                chs.find(
                  (c: any) => c.chapter_id === useEditorStore.getState().activeChapterId,
                )?.sort_order ?? 1;
            } catch { /* 取不到就用 1 */ }
            const targets = Array.from({ length: num }, (_, i) => curSort + i);
            await generateChaptersLoop(targets, `前${gMatch[2]}章`);
          }
          return;
        }
      }
    }
    const um: Msg = { role: "user", content: userMsg };
    const prevMsgs = [...msgs, um].map((m) => ({ role: m.role, content: m.content }));
    const newMsgs = [...msgs, um];
    setMsgs(newMsgs);
    // 立即保存用户消息到 DB（不等 debounce），避免刷新丢失
    if (sessionId) flushSave(sessionId, newMsgs);
    setInput(""); setLoading(true); setStreaming(""); setReasoning("");
    const controller = new AbortController();
    abortRef.current = controller;
    const bodyExtra: Record<string, any> = {};
    let activeCh = useEditorStore.getState().activeChapterId;
    // 章节意图识别：请求"生成第N章"时自动切换/新建到目标章，避免写进当前章
    if (section === "write") {
      const m = userMsg.match(/第([一二三四五六七八九十百\d]+)\s*章/);
      const targetNo = m ? zhNum(m[1]) : null;
      try {
        const listRes = await fetch(`/api/books/${bookId}/chapters`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const listData = await listRes.json();
        const chs = listData?.data ?? [];
        const cur = chs.find(
          (c: any) => c.chapter_id === activeCh,
        ) as { sort_order: number } | undefined;
        let chapterId: string | null = null;
        if (targetNo != null && cur && cur.sort_order !== targetNo) {
          // 请求的章号与当前章不同：找目标章，没有则新建
          const target = chs.find((c: any) => c.sort_order === targetNo);
          chapterId = target?.chapter_id ?? null;
          if (!chapterId) {
            const createRes = await fetch(`/api/books/${bookId}/chapters`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ title: `第${m![1]}章` }),
            });
            const createData = await createRes.json();
            chapterId = createData?.data?.chapter_id ?? null;
          }
        } else if (!activeCh && chs.length === 0) {
          // 无章节时自动建"第一章"：直接让 AI 生成也能落进编辑器
          const createRes = await fetch(`/api/books/${bookId}/chapters`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ title: "第一章" }),
          });
          const createData = await createRes.json();
          chapterId = createData?.data?.chapter_id ?? null;
        }
        if (chapterId) {
          // 立即更新 store（采纳插入的章节校验用），并发出一次性切换请求让编辑器跟随
          useEditorStore.getState().setActiveChapter(chapterId);
          useEditorStore.getState().requestChapterSwitch(chapterId);
          queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
          activeCh = chapterId;
        }
      } catch {
        /* 章节处理失败不阻断：正文仍会生成 */
      }
    }
    if (section === "write" && activeCh) {
      bodyExtra.chapter_id = activeCh;
      bodyExtra.cursor_position = rewriteCtx ? rewriteCtx.start : useEditorStore.getState().cursorPosition;
      bodyExtra.style = chatStyle;
      // 选中改写标记：服务端据此切换改写指引（保事实换形式，不推进剧情）
      bodyExtra.rewrite = !!rewriteCtx;
      // 记录请求时的章节与光标位置，采纳时精确插入（防止插入到错误章节/位置）
      useEditorStore.getState().setPendingRequest({
        chapterId: activeCh,
        cursorPosition: rewriteCtx ? rewriteCtx.start : useEditorStore.getState().cursorPosition,
      });
    }
    bodyExtra.guide_mode = guideMode;
    // 确保有活跃会话
    const sid = await ensureSession();
    // 每3秒自动保存当前流式内容，避免刷新丢失
    clearInterval(autoSaveIntervalRef.current);
    autoSaveIntervalRef.current = setInterval(() => {
      if (sid) {
        const curContent = streamingRef.current;
        const curReasoning = reasoningRef.current;
        const partialMsgs = [...newMsgs, { role: "assistant", content: curContent || "（生成中...）", reasoning: curReasoning || undefined }];
        flushSave(sid, partialMsgs);
      }
    }, 3000);
    try {
      const result = await streamOnce(userMsg, prevMsgs, bodyExtra, controller.signal);
      clearInterval(autoSaveIntervalRef.current);
      setStreaming(""); setReasoning("");
      const finalMsgs = [...newMsgs, { role: "assistant", content: result.content, action: result.action, reasoning: result.reasoning || undefined, quality: result.quality }];
      setMsgs(finalMsgs);
      if (sid) flushSave(sid, finalMsgs);
    } catch (e: any) {
      clearInterval(autoSaveIntervalRef.current);
      if (stoppedByUserRef.current) {
        stoppedByUserRef.current = false;
        // stop() 已经保存了内容，不再覆盖
      } else {
        const errMsgs = [...newMsgs, { role: "assistant", content: `（${e.message ?? "网络异常"}）` }];
        setMsgs(errMsgs);
        if (sid) flushSave(sid, errMsgs);
      }
    }
    setLoading(false); setStreaming("");
  };

  const send = () => {
    if (!input.trim() || loading) return;
    const msg = rewriteCtx
      ? "【改写以下选中文本】\n" + rewriteCtx.text + "\n\n【用户指令】" + input
      : input;
    doSend(msg);
  };

  const regenerate = (feedback?: string) => {
    if (loading) return;
    const curMsgs = msgsRef.current;
    let lastUserIdx = -1;
    for (let i = curMsgs.length - 1; i >= 0; i--) {
      if (curMsgs[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;
    const lastAiIdx = curMsgs.length - 1;
    if (lastAiIdx <= lastUserIdx) return;

    // 反馈方向只注入本次请求，不写回消息历史
    const userMsg = feedback?.trim()
      ? `${curMsgs[lastUserIdx].content}\n\n【重写方向】${feedback.trim()}`
      : curMsgs[lastUserIdx].content;
    const prevMsgs = curMsgs.slice(0, lastUserIdx + 1).map((m) => ({ role: m.role, content: m.content }));

    setLoading(true); isRegeneratingRef.current = true;
    clearInterval(autoSaveIntervalRef.current);
    autoSaveIntervalRef.current = setInterval(() => {
      const sid = sessionId;
      if (sid) flushSave(sid, msgsRef.current);
    }, 3000);
    const controller = new AbortController();
    abortRef.current = controller;

    const bodyExtra: Record<string, any> = {};
    const activeCh = useEditorStore.getState().activeChapterId;
    if (section === "write" && activeCh) {
      bodyExtra.chapter_id = activeCh;
      bodyExtra.cursor_position = rewriteCtx ? rewriteCtx.start : useEditorStore.getState().cursorPosition;
      bodyExtra.style = chatStyle;
      // 选中改写标记：服务端据此切换改写指引（保事实换形式，不推进剧情）
      bodyExtra.rewrite = !!rewriteCtx;
      // 记录请求时的章节与光标位置，采纳时精确插入（防止插入到错误章节/位置）
      useEditorStore.getState().setPendingRequest({
        chapterId: activeCh,
        cursorPosition: rewriteCtx ? rewriteCtx.start : useEditorStore.getState().cursorPosition,
      });
    }
    bodyExtra.guide_mode = guideMode;

    // 在位更新：先保存原始版本为 versions[0]（占位消息不存档为版本）
    const isPlaceholder = curMsgs[lastAiIdx].content === "（生成中...）";
    setMsgs((prev) => {
      const updated = [...prev];
      const target = { ...updated[lastAiIdx] };
      if (!isPlaceholder) {
        if (!target.versions?.length) {
          target.versions = [{ content: target.content, action: target.action, reasoning: target.reasoning }];
        }
        target.versions = [...target.versions, { content: "", action: undefined, reasoning: "" }];
      } else {
        target.versions = [{ content: "", action: undefined, reasoning: "" }];
      }
      target.content = "";
      target.reasoning = "";
      target.action = undefined;
      target.adoptedVer = undefined;
      updated[lastAiIdx] = target;
      setActiveVer((p) => ({ ...p, [lastAiIdx]: target.versions!.length - 1 }));
      return updated;
    });
    // 立即保存当前版本状态，避免刷新丢失
    setTimeout(() => {
      const sid = sessionId;
      if (sid) flushSave(sid, msgsRef.current);
    }, 50);

    streamOnce(userMsg, prevMsgs, bodyExtra, controller.signal, (ac, ar) => {
      // 实时更新当前版本
      setMsgs((prev) => {
        const updated = [...prev];
        const m = { ...updated[lastAiIdx] };
        if (m.versions) {
          const vIdx = m.versions.length - 1;
          m.versions = [...m.versions];
          m.versions[vIdx] = { content: extractDisplayText(ac), action: undefined, reasoning: ar };
          m.content = extractDisplayText(ac);
          m.reasoning = ar;
        }
        updated[lastAiIdx] = m;
        return updated;
      });
    }).then((result) => {
      if (!result.content && !result.action) {
        // 空响应：移除占位版本，回到之前的状态
        setMsgs((prev) => {
          const updated = [...prev];
          const m = { ...updated[lastAiIdx] };
          if (m.versions && m.versions.length > 1) {
            m.versions = m.versions.slice(0, -1);
            const prevVer = m.versions[m.versions.length - 1];
            m.content = prevVer.content;
            m.reasoning = prevVer.reasoning;
            m.action = prevVer.action;
          }
          updated[lastAiIdx] = m;
          setActiveVer((p) => ({ ...p, [lastAiIdx]: m.versions ? m.versions.length - 1 : 0 }));
          return updated;
        });
        toast({ title: "AI 未生成有效内容，请重试", variant: "destructive" });
      } else {
        setMsgs((prev) => {
          const updated = [...prev];
          const m = { ...updated[lastAiIdx] };
          if (m.versions) {
            const vIdx = m.versions.length - 1;
            m.versions = [...m.versions];
            m.versions[vIdx] = { content: result.content, action: result.action, reasoning: result.reasoning || undefined };
            m.content = result.content;
            m.reasoning = result.reasoning || undefined;
            m.action = result.action;
            m.quality = result.quality;
          }
          updated[lastAiIdx] = m;
          return updated;
        });
      }
      setLoading(false); isRegeneratingRef.current = false;
      clearInterval(autoSaveIntervalRef.current);
      // 保存
      setTimeout(() => {
        const finalMsgs = msgsRef.current;
        const sid = sessionId;
        if (sid && finalMsgs[lastAiIdx]?.versions) flushSave(sid, finalMsgs);
      }, 100);
    }).catch((e: any) => {
      setLoading(false); isRegeneratingRef.current = false;
      clearInterval(autoSaveIntervalRef.current);
      if (stoppedByUserRef.current) {
        stoppedByUserRef.current = false;
      } else {
        toast({ title: e.message ?? "重新生成失败", variant: "destructive" });
      }
    });
  };

  const stop = () => {
    if (abortRef.current) {
      // 先保存当前流式内容为消息，再中断
      const curContent = streamingRef.current;
      const curReasoning = reasoningRef.current;
      if (curContent || curReasoning) {
        setMsgs((prev) => {
          const lastMsg = prev[prev.length - 1];
          // 如果最后一条是用户消息，追加一条 AI 消息
          if (lastMsg?.role === "user") {
            return [...prev, { role: "assistant", content: curContent || "（已中断）", reasoning: curReasoning || undefined }];
          }
          // 如果最后一条正在被 regenerate 更新，把当前版本写进去
          const updated = [...prev];
          const m = { ...updated[updated.length - 1] };
          m.content = curContent || m.content;
          m.reasoning = curReasoning || m.reasoning;
          updated[updated.length - 1] = m;
          return updated;
        });
        setStreaming(""); setReasoning("");
        // 保存到 DB
        setTimeout(() => {
          const sid = sessionId;
          if (sid) flushSave(sid, msgsRef.current);
        }, 50);
      }
      stoppedByUserRef.current = true;
      clearInterval(autoSaveIntervalRef.current);
      abortRef.current.abort();
      abortRef.current = null;
      setLoading(false); isRegeneratingRef.current = false;
    }
  };

  const adopt = async (a: any, gi: number) => {
    if (adoptingRef.current) return;
    adoptingRef.current = true;
    try {
      // 支持数组格式：多个 action 逐个处理
      if (Array.isArray(a)) {
        let created = 0;
        for (const item of a) {
          if (item.action === "create_character") {
            await fetch("/api/books/" + bookId + "/characters", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify(item),
            });
            created++;
          } else if (item.action === "update_character" && item.char_id) {
            const { action, char_id, ...fields } = item;
            await fetch(`/api/books/${bookId}/characters/${char_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify(fields),
            });
            created++;
          } else if (item.action === "add_chapter") {
            await fetch("/api/books/" + bookId + "/outline/chapters", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify({ title: item.title, summary: item.summary, act_name: item.act_name }),
            });
            created++;
          } else if (item.action === "update_chapter" && item.chapter_id) {
            const { action, chapter_id, ...fields } = item;
            await fetch(`/api/books/${bookId}/outline/chapters/${chapter_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify(fields),
            });
            created++;
          }
        }
        queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
        queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
        toast({ title: `已处理 ${created} 条` });
      } else if (a.action === "create_character") {
        await fetch("/api/books/" + bookId + "/characters", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(a),
        });
        queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
        toast({ title: "角色已创建" });
      } else if (a.action === "update_character" && a.char_id) {
        const { action, char_id, ...fields } = a;
        await fetch(`/api/books/${bookId}/characters/${char_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(fields),
        });
        queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
        toast({ title: "角色已更新" });
      } else if (a.action === "add_chapter") {
        await fetch("/api/books/" + bookId + "/outline/chapters", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ title: a.title, summary: a.summary, act_name: a.act_name }),
        });
        queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
        toast({ title: "大纲节点已添加" });
      } else if (a.action === "update_chapter" && a.chapter_id) {
        const { action, chapter_id, ...fields } = a;
        await fetch(`/api/books/${bookId}/outline/chapters/${chapter_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(fields),
        });
        queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
        toast({ title: "大纲节点已更新" });
      } else if (a.action === "update_sections" && a.sections) {
        // 合并而非覆盖：AI 只回部分分区时不能清掉未列出的分区
        const merged = await mergeWorldSections(bookId, token, a.sections);
        await fetch("/api/books/" + bookId + "/world-setting", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ sections: merged }),
        });
        queryClient.invalidateQueries({ queryKey: ["world-setting", bookId] });
        toast({ title: "世界观已更新" });
      } else if (a.action === "update_section") {
        // 合并而非覆盖：按分区名 upsert，其余分区保持不变
        const merged = await mergeWorldSections(bookId, token, [{ name: a.name, content: a.content }]);
        await fetch("/api/books/" + bookId + "/world-setting", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ sections: merged }),
        });
        queryClient.invalidateQueries({ queryKey: ["world-setting", bookId] });
        toast({ title: "世界观已更新" });
      } else if (a.content?.trim()) {
        const pendingReq = useEditorStore.getState().pendingRequest;
        const reqChapter =
          pendingReq?.chapterId ?? useEditorStore.getState().activeChapterId ?? null;
        const oldCtx = useEditorStore.getState().aiRewriteContext;
        if (oldCtx) {
          useEditorStore.getState().requestReplace(oldCtx.text, a.content, oldCtx.start, oldCtx.end, oldCtx.tiptapFrom, oldCtx.tiptapTo, reqChapter);
          useEditorStore.getState().clearAiRewrite();
          toast({ title: "已替换选区" });
        } else {
          // 多章拆分：AI 一次生成多章时，首段插入当前章，其余自动新建章节
          const stripMd = (t: string) => t.replace(/^#{1,6}\s+/gm, "");
          const segs = splitChapters(a.content);
          useEditorStore.getState().requestInsert(
            stripMd(segs[0]?.content ?? ""),
            reqChapter,
            pendingReq?.cursorPosition ?? 0,
          );
          let created = 0;
          for (const seg of segs.slice(1)) {
            try {
              const createRes = await fetch(`/api/books/${bookId}/chapters`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ title: seg.title || "新章节" }),
              });
              const createData = await createRes.json();
              const cid = createData?.data?.chapter_id;
              if (cid) {
                const putRes = await fetch(`/api/books/${bookId}/chapters/${cid}`, {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    content: stripMd(seg.content),
                    word_count: seg.content.length,
                  }),
                });
                if (putRes.ok) {
                  created++;
                } else {
                  toast({ title: "有章节内容保存失败，请手动补写", variant: "destructive" });
                }
              }
            } catch {
              /* 单章失败不阻断其余 */
            }
          }
          if (created) {
            queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
            toast({ title: `已插入当前章，并新建 ${created} 章` });
          } else {
            toast({ title: "已插入编辑器" });
          }
        }
      } else {
        toast({ title: "本次生成无正文内容，请重新生成", variant: "destructive" });
      }
      const verIdx = msgs[gi]?.versions ? (activeVer[gi] ?? msgs[gi].versions!.length - 1) : 0;
      const updated = msgs.map((m, i) => (i === gi ? { ...m, adoptedVer: verIdx } : m));
      saveMsgs(updated);
      adoptingRef.current = false;
    } catch {
      toast({ title: "写入失败", variant: "destructive" });
      adoptingRef.current = false;
    }
  };

  // 历史会话列表（归档的，非活跃）
  const archived = sessions.filter((s: any) => s.id !== sessionId);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 标题栏 + 新对话/历史 */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground">AI 助手</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={newSession}
              title="新对话（归档当前）"
            >
              + 新对话
            </Button>
            {archived.length > 0 && (
              <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="xs" className="text-xs">
                      历史
                    </Button>
                  }
                />
                <DropdownMenuContent side="bottom" align="end" className="w-56">
                  {archived.map((s: any) => (
                    <div key={s.id} className="flex items-center gap-1 px-2 py-1.5">
                      <DropdownMenuItem
                        className="flex-1 cursor-pointer text-xs"
                        onClick={() => restoreSession(s.id)}
                      >
                        <div className="min-w-0">
                          <div className="truncate">{s.title ?? "无标题"}</div>
                          <div className="text-xs text-muted-foreground">
                            {s.messages?.length ?? 0} 条消息
                          </div>
                        </div>
                      </DropdownMenuItem>
                      <button
                        className="text-destructive hover:text-destructive/80 text-xs shrink-0 px-1"
                        onClick={() => deleteSession(s.id)}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  {archived.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      暂无历史对话
                    </div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {sessionId ? (
          <p className="text-xs text-muted-foreground mt-0.5">可对话修改内容</p>
        ) : (
          <p className="text-xs text-muted-foreground mt-0.5">发送消息后将自动创建会话</p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-3">
            {msgs.map((m: Msg, i: number) => {
              return (
                <div
                  key={i}
                  className={cn(
                    "text-sm rounded-lg px-3 py-2",
                    m.role === "user"
                      ? "bg-primary/10 text-foreground ml-2"
                      : "bg-muted text-foreground mr-2",
                  )}
                >
                  {m.role === "user" ? (
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  ) : (() => {
                    const hasVersions = m.versions && m.versions.length > 0;
                    const verIdx = hasVersions ? (activeVer[i] ?? m.versions!.length - 1) : 0;
                    const curVer: Ver = hasVersions
                      ? m.versions![verIdx]
                      : { content: m.content, action: m.action, reasoning: m.reasoning };
                    const isLastAi = i === msgs.length - 1 && m.role === "assistant";
                    const isAdopted = m.adoptedVer !== undefined;
                    const hasAction = !!curVer.action;
                    // 模型偶发漏输出结尾 JSON：写作面板有正文即可采纳（按 insert_content 处理）
                    const adoptFallback =
                      section === "write" &&
                      !hasAction &&
                      !!stripActionJson(curVer.content || "").trim();

                    return (
                      <div>
                        {curVer.content ? (
                          <div className="whitespace-pre-wrap">{stripMdHeadings(stripActionJson(curVer.content))}</div>
                        ) : null}
                        {m.quality && !isAdopted && (
                          <div className="mt-1 text-xs text-destructive">
                            ⚠ AI 味提示（{m.quality.count} 处）：{m.quality.types.slice(0, 3).map((t) => QUALITY_LABELS[t] ?? t).join("、")}
                          </div>
                        )}
                        {isAdopted ? (
                          <div className="mt-2 pt-2 border-t border-border text-xs text-muted-foreground text-center">
                            已采纳
                          </div>
                        ) : isLastAi ? (
                          <div className="mt-2 pt-2 border-t border-border flex items-center gap-2 flex-wrap">
                            {(hasAction || adoptFallback) && (
                              <Button
                                size="xs"
                                disabled={adoptingRef.current}
                                onClick={() =>
                                  adopt(
                                    hasAction
                                      ? curVer.action!
                                      : { action: "insert_content", content: stripActionJson(curVer.content) },
                                    i,
                                  )
                                }
                              >
                                {adoptingRef.current ? "采纳中..." : "采纳"}
                              </Button>
                            )}
                            {feedbackOpen === i ? (
                              <div className="w-full flex items-center gap-2">
                                <Textarea
                                  autoFocus
                                  value={feedbackText}
                                  onChange={(e) => setFeedbackText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                      e.preventDefault();
                                      regenerate(feedbackText);
                                      setFeedbackOpen(null);
                                      setFeedbackText("");
                                    }
                                  }}
                                  placeholder="不满意？告诉 AI 重写方向（可选），如：太啰嗦了，精简一点"
                                  rows={2}
                                  className="flex-1 text-xs min-h-0"
                                />
                                <Button
                                  size="xs"
                                  onClick={() => {
                                    regenerate(feedbackText);
                                    setFeedbackOpen(null);
                                    setFeedbackText("");
                                  }}
                                >
                                  生成
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => { setFeedbackOpen(null); setFeedbackText(""); }}
                                >
                                  取消
                                </Button>
                              </div>
                            ) : (
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={loading}
                                onClick={() => { setFeedbackOpen(i); setFeedbackText(""); }}
                              >
                                重新生成
                              </Button>
                            )}
                            {hasVersions && m.versions!.length > 1 && (
                              <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                                <button
                                  className="hover:text-foreground disabled:opacity-30"
                                  disabled={verIdx === 0}
                                  onClick={() => setActiveVer((p) => ({ ...p, [i]: verIdx - 1 }))}
                                >
                                  ◀
                                </button>
                                版本 {verIdx + 1}/{m.versions!.length}
                                <button
                                  className="hover:text-foreground disabled:opacity-30"
                                  disabled={verIdx === m.versions!.length - 1}
                                  onClick={() => setActiveVer((p) => ({ ...p, [i]: verIdx + 1 }))}
                                >
                                  ▶
                                </button>
                              </span>
                            )}
                          </div>
                        ) : hasAction ? (
                          <div className="mt-2 pt-2 border-t border-border text-xs text-muted-foreground text-center">
                            已覆盖
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
            {/* 流式输出：只显示正文，思考阶段只显示加载标志 */}
            {streaming && (
              <div className="text-sm rounded-lg px-3 py-2 bg-muted text-foreground mr-2">
                <div className="whitespace-pre-wrap">
                  {stripMdHeadings(stripActionJson(streaming))}
                  <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
                </div>
              </div>
            )}
            {loading && !streaming && !isRegeneratingRef.current && (
              <div className="text-xs text-muted-foreground italic px-3">
                <Loader2 className="inline size-3 animate-spin mr-1" />
                生成中...
              </div>
            )}
            <div ref={scrollBottomRef} />
          </div>
        </ScrollArea>
      </div>

      {/* 输入区 */}
      <div className="px-2 py-1.5 border-t border-border shrink-0">
        <div className="rounded-xl border border-border bg-muted/20 px-2.5 py-1">
          {/* 改写上下文 */}
          {section === "write" && rewriteCtx && (
            <div className="flex items-center gap-1 rounded bg-primary/5 px-2 py-0.5 text-xs text-foreground mb-1">
              <span className="text-muted-foreground shrink-0">改写：</span>
              <span className="truncate flex-1">{rewriteCtx.text.slice(0, 60)}</span>
              <button onClick={() => clearRewrite()} className="shrink-0 text-muted-foreground hover:text-foreground">×</button>
            </div>
          )}
          {/* 主体输入框 */}
          <Textarea
            rows={1}
            placeholder="输入消息..."
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 120) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            className="text-sm border-0 bg-transparent resize-none !p-0 min-h-6 shadow-none focus-visible:ring-0 leading-normal"
          />
          {/* 底部工具栏：窄面板时工具项换行，发送按钮 ml-auto 始终右对齐 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {section === "write" && (
              <select
                value={chatStyle}
                onChange={(e) => setChatStyle(e.target.value)}
                className="text-xs text-muted-foreground bg-muted/50 rounded-full px-2.5 py-1 border-0 outline-none cursor-pointer shrink-0"
              >
                {WRITING_STYLES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.value === "default" ? "风格" : s.label}
                  </option>
                ))}
                {/* 做过笔风分析后才出现 */}
                {mimicAnalysis && <option value="mimic">我的笔风</option>}
              </select>
            )}
            <ModelSelector
              usage="chat"
              value={modelKeyId ? customKeyValue(modelKeyId) : model}
              onChange={(m, keyId) => { setModel(m); setModelKeyId(keyId); }}
              className="text-xs text-muted-foreground bg-muted/50 rounded-full px-2.5 py-1 border-0 outline-none cursor-pointer max-w-28"
            />
            <label className="flex items-center gap-1 cursor-pointer shrink-0" title={guideMode ? "关闭引导模式" : "开启引导模式"}>
              <button
                onClick={(e) => { e.preventDefault(); setGuideMode(!guideMode); }}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                  guideMode ? "bg-primary" : "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform",
                    guideMode ? "translate-x-4" : "translate-x-0",
                  )}
                />
              </button>
              <span className="text-xs text-muted-foreground select-none">引导</span>
            </label>
            {loading ? (
              <button onClick={stop} className="ml-auto size-8 flex items-center justify-center rounded-full bg-destructive text-white">
                <Square className="size-4" />
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()} className="ml-auto size-8 flex items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30">
                <Send className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
