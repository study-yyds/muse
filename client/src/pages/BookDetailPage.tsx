import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
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
import { ArrowLeft, UserRound, Globe, ListTree, FileText, Download, Send, Loader2, Sparkles, Settings, BarChart3, Menu, MessageCircle, Square, ChevronRight } from "lucide-react";
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
}: {
  book: BookDetail;
  section: Section;
  onSectionChange: (s: Section) => void;
  onNavigate: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <Button variant="ghost" size="icon-xs" className="mb-2" onClick={onNavigate}>
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-sm font-semibold text-foreground truncate">{book.title}</h1>
        <p className="text-xs text-muted-foreground">{book.word_count.toLocaleString()} 字</p>
      </div>
      <div className="flex-1 py-2">
        {NAV_ITEMS.map((item) => (
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
                onClick={() => {
                  const t = localStorage.getItem("token");
                  window.open(
                    "/api/books/" + book.book_id + "/export?format=" + fmt + "&token=" + t,
                    "_blank"
                  );
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

  const { data, isLoading } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.get<{ data: BookDetail }>(`/books/${bookId}`),
    enabled: !!bookId,
  });
  const book = data?.data;

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
          {section === "write" && bookId && <WritingEditor bookId={bookId} />}
          {section === "outline" && bookId && (
            <div className="p-4 h-full"><OutlinePanel bookId={bookId} /></div>
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
            <div className="h-full overflow-y-auto"><BookSettingsPanel bookId={bookId} /></div>
          )}
        </div>

        {/* ===== 移动端 AI 面板：底部嵌入式 ===== */}
        {mobileAiExpanded && (
          <div className="lg:hidden border-t border-border bg-card shrink-0" style={{ maxHeight: "45vh" }}>
            <AIChatPanel section={section} bookId={bookId ?? ""} />
          </div>
        )}
      </div>

      {/* ===== 桌面端 AI 面板 ===== */}
      <div className="hidden lg:flex w-72 shrink-0 border-l border-border bg-card flex-col h-full">
        <AIChatPanel section={section} bookId={bookId ?? ""} />
      </div>
    </div>
  );
}

function AIChatPanel({ section, bookId }: { section: string; bookId: string }) {
  type Ver = { content: string; action?: any; reasoning?: string };
  type Msg = { role: string; content: string; action?: any; adoptedVer?: number; reasoning?: string; versions?: Ver[] };
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [streaming, setStreaming] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("deepseek-v4-flash");
  const [chatStyle, setChatStyle] = useState("default");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Set<number>>(new Set());
  const [streamReasonCollapsed, setStreamReasonCollapsed] = useState(false);
  const [activeVer, setActiveVer] = useState<Record<number, number>>({});
  const abortRef = useRef<AbortController | null>(null);
  const scrollBottomRef = useRef<HTMLDivElement | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const isRegeneratingRef = useRef(false);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const rewriteCtx = useEditorStore((s) => s.aiRewriteContext);
  const clearRewrite = useEditorStore((s) => s.clearAiRewrite);
  const editor = useEditorStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
    loadSessions();
    return () => clearTimeout(saveTimer.current);
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
    // 优先匹配 JSON 独立行：\n{ 或 \n[
    let idx = t.lastIndexOf('\n{"action"');
    if (idx < 0) idx = t.lastIndexOf('\n[{"action"');
    if (idx > 0) return t.slice(0, idx).trim();
    // fallback：JSON 直接跟在正文后面
    idx = t.lastIndexOf('{"action"');
    if (idx < 0) idx = t.lastIndexOf('[{"action"');
    if (idx > 0) return t.slice(0, idx).trim();
    return t;
  };

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
        // world sections 数组
        if (arr.length && arr[0].name && arr[0].content) {
          return arr
            .map((sec: any) => `【${sec.name}】\n${sec.content}`)
            .join("\n\n");
        }
        // character actions 数组
        if (arr.length && arr[0].action === "create_character") {
          return arr
            .map((c: any) => `【${c.name}】${c.gender ?? ""} · ${c.identity ?? ""}\n${c.personality ?? ""}`)
            .join("\n\n");
        }
      } catch { /* fall through */ }
    }
    // 末尾有 JSON action（完整或截断）→ 去掉
    const lastBrace = s.lastIndexOf("{");
    if (lastBrace > 0) {
      try {
        const p = JSON.parse(s.slice(lastBrace));
        if (p.action) return s.slice(0, lastBrace).trim();
      } catch {
        // JSON 解析失败（可能被截断），仍尝试去除末尾的 JSON 片段
        // 检查末尾是否像 JSON action：含 "action" 或 "sections"
        const tail = s.slice(lastBrace);
        if (tail.includes('"action"') || tail.includes('"sections"')) {
          return s.slice(0, lastBrace).trim();
        }
        return s;
      }
    }
    return s;
  };

  const streamOnce = async (
    msg: string, prevMsgs: { role: string; content: string }[],
    bodyExtra?: Record<string, any>, signal?: AbortSignal,
    onStream?: (ac: string, ar: string) => void,
  ): Promise<{ content: string; action?: any; reasoning: string }> => {
    const r = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ book_id: bookId, context_type: section, model, message: msg, messages: prevMsgs, ...bodyExtra }),
      signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const reader = r.body?.getReader(); if (!reader) throw new Error("无响应");
    const decoder = new TextDecoder(); let buf = ""; let ac = ""; let ar = ""; let action: any = undefined;
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
          if (ev === "error") {
            try { const err = JSON.parse(payload); throw new Error(err.message ?? "AI 错误"); } catch (e) { if (e instanceof Error && e.message !== "AI 错误") throw e; throw new Error("AI 请求失败"); }
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
    return { content: ac ? extractDisplayText(ac) : "", action, reasoning: ar };
  };

  const doSend = async (userMsg: string) => {
    const um: Msg = { role: "user", content: userMsg };
    const prevMsgs = [...msgs, um].map((m) => ({ role: m.role, content: m.content }));
    const newMsgs = [...msgs, um];
    setMsgs(newMsgs);
    // 立即保存用户消息到 DB（不等 debounce），避免刷新丢失
    if (sessionId) flushSave(sessionId, newMsgs);
    setInput(""); setLoading(true); setStreaming(""); setReasoning(""); setStreamReasonCollapsed(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const bodyExtra: Record<string, any> = {};
    if (section === "write" && editor.activeChapterId) {
      bodyExtra.chapter_id = editor.activeChapterId;
      bodyExtra.cursor_position = rewriteCtx ? rewriteCtx.start : editor.cursorPosition;
      bodyExtra.style = chatStyle;
    }
    // 确保有活跃会话
    const sid = await ensureSession();
    try {
      const result = await streamOnce(userMsg, prevMsgs, bodyExtra, controller.signal);
      setStreaming(""); setReasoning("");
      const finalMsgs = [...newMsgs, { role: "assistant", content: result.content, action: result.action, reasoning: result.reasoning || undefined }];
      setMsgs(finalMsgs);
      if (sid) flushSave(sid, finalMsgs);
    } catch (e: any) {
      const errMsgs = [...newMsgs, { role: "assistant", content: `（${e.message ?? "网络异常"}）` }];
      setMsgs(errMsgs);
      if (sid) flushSave(sid, errMsgs);
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

  const regenerate = () => {
    if (loading) return;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;
    const lastAiIdx = msgs.length - 1;
    if (lastAiIdx <= lastUserIdx) return;

    const userMsg = msgs[lastUserIdx].content;
    const prevMsgs = msgs.slice(0, lastUserIdx + 1).map((m) => ({ role: m.role, content: m.content }));

    setLoading(true); setStreamReasonCollapsed(false); isRegeneratingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    const bodyExtra: Record<string, any> = {};
    if (section === "write" && editor.activeChapterId) {
      bodyExtra.chapter_id = editor.activeChapterId;
      bodyExtra.cursor_position = rewriteCtx ? rewriteCtx.start : editor.cursorPosition;
      bodyExtra.style = chatStyle;
    }

    // 在位更新：先保存原始版本为 versions[0]
    setMsgs((prev) => {
      const updated = [...prev];
      const target = { ...updated[lastAiIdx] };
      if (!target.versions?.length) {
        target.versions = [{ content: target.content, action: target.action, reasoning: target.reasoning }];
      }
      // 追加一个空版本作为流式占位
      target.versions = [...target.versions, { content: "", action: undefined, reasoning: "" }];
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
          }
          updated[lastAiIdx] = m;
          return updated;
        });
      }
      setLoading(false); isRegeneratingRef.current = false;
      // 保存
      setTimeout(() => {
        const finalMsgs = msgsRef.current;
        const sid = sessionId;
        if (sid && finalMsgs[lastAiIdx]?.versions) flushSave(sid, finalMsgs);
      }, 100);
    }).catch((e: any) => {
      setLoading(false); isRegeneratingRef.current = false;
      toast({ title: e.message ?? "重新生成失败", variant: "destructive" });
    });
  };

  const stop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  const adopt = async (a: any, gi: number) => {
    try {
      // 支持数组格式：多个角色逐个创建
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
          }
        }
        queryClient.invalidateQueries({ queryKey: ["characters", bookId] });
        toast({ title: `已创建/更新 ${created} 个角色` });
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
          body: JSON.stringify(a),
        });
        queryClient.invalidateQueries({ queryKey: ["outline", bookId] });
        toast({ title: "大纲章节已添加" });
      } else if (a.action === "update_sections" && a.sections) {
        await fetch("/api/books/" + bookId + "/world-setting", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ sections: a.sections }),
        });
        queryClient.invalidateQueries({ queryKey: ["world-setting", bookId] });
        toast({ title: "世界观已更新" });
      } else if (a.action === "update_section") {
        await fetch("/api/books/" + bookId + "/world-setting", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ sections: [{ name: a.name, content: a.content }] }),
        });
        queryClient.invalidateQueries({ queryKey: ["world-setting", bookId] });
        toast({ title: "世界观已更新" });
      } else {
        const oldCtx = useEditorStore.getState().aiRewriteContext;
        if (oldCtx) {
          useEditorStore.getState().requestReplace(oldCtx.text, a.content, oldCtx.start, oldCtx.end, oldCtx.tiptapFrom, oldCtx.tiptapTo);
          useEditorStore.getState().clearAiRewrite();
        } else {
          useEditorStore.getState().requestInsert(a.content);
        }
        toast({ title: "已插入编辑器" });
      }
      const verIdx = msgs[gi]?.versions ? (activeVer[gi] ?? msgs[gi].versions!.length - 1) : 0;
      const updated = msgs.map((m, i) => (i === gi ? { ...m, adoptedVer: verIdx } : m));
      saveMsgs(updated);
    } catch {
      toast({ title: "写入失败", variant: "destructive" });
    }
  };

  // 历史会话列表（归档的，非活跃）
  const archived = sessions.filter((s: any) => s.id !== sessionId);

  return (
    <div className="flex flex-col h-full">
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
                          <div className="text-[10px] text-muted-foreground">
                            {s.messages?.length ?? 0} 条消息
                          </div>
                        </div>
                      </DropdownMenuItem>
                      <button
                        className="text-red-400 hover:text-red-600 text-[10px] shrink-0 px-1"
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

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-3">
          {msgs.map((m: Msg, i: number) => {
            const reasonExpanded = expandedReasoning.has(i);
            const toggleReasoning = () => {
              setExpandedReasoning((prev) => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              });
            };
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

                  return (
                  <div>
                    {/* 思考块（折叠） */}
                    {curVer.reasoning && (
                      <div className="mb-2">
                        <button
                          onClick={toggleReasoning}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3 transition-transform",
                              reasonExpanded && "rotate-90",
                            )}
                          />
                          思考
                        </button>
                        {reasonExpanded && (
                          <div className="mt-1.5 pl-4 border-l-2 border-border text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                            {curVer.reasoning}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{stripActionJson(curVer.content) || "(空白)"}</div>
                    {isAdopted ? (
                      <div className="mt-2 pt-2 border-t border-border text-xs text-muted-foreground text-center">
                        已采纳
                      </div>
                    ) : isLastAi ? (
                      <div className="mt-2 pt-2 border-t border-border flex items-center gap-2 flex-wrap">
                        {hasAction && (
                          <Button size="xs" onClick={() => adopt(curVer.action!, i)}>
                            采纳
                          </Button>
                        )}
                        <Button size="xs" variant="ghost" onClick={regenerate}>
                          重新生成
                        </Button>
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
                );})()}
              </div>
            );
          })}
          {/* 流式输出：思考（可折叠） + 正文 */}
          {(reasoning || streaming) && (
            <div className="text-sm rounded-lg px-3 py-2 bg-muted text-foreground mr-2">
              {reasoning && (
                <div className={cn(streaming && "mb-2")}>
                  <button
                    onClick={() => setStreamReasonCollapsed(!streamReasonCollapsed)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3 transition-transform",
                        !streamReasonCollapsed && "rotate-90",
                      )}
                    />
                    <Loader2 className="size-3 animate-spin" />
                    思考中...
                  </button>
                  {!streamReasonCollapsed && (
                    <div className="mt-1.5 pl-4 border-l-2 border-border text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                      {reasoning}
                    </div>
                  )}
                </div>
              )}
              {streaming && (
                <div className={cn("whitespace-pre-wrap", reasoning && "pt-2 border-t border-border")}>
                  {stripActionJson(streaming)}
                  <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
                </div>
              )}
            </div>
          )}
          {loading && !reasoning && !streaming && !isRegeneratingRef.current && (
            <div className="text-xs text-muted-foreground italic px-3">
              <Loader2 className="inline size-3 animate-spin mr-1" />
              连接中...
            </div>
          )}
          <div ref={scrollBottomRef} />
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border space-y-2 shrink-0">
        {section === "write" && (
          <div className="flex items-center gap-2">
            {rewriteCtx ? (
              <div className="flex-1 flex items-center gap-2 rounded border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-foreground">
                <span className="text-muted-foreground shrink-0">改写：</span>
                <span className="truncate">{rewriteCtx.text.slice(0, 80)}</span>
                <button onClick={() => clearRewrite()} className="shrink-0 text-muted-foreground hover:text-foreground">
                  ×
                </button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className="text-xs"
                onClick={() => {
                  const s = useEditorStore.getState();
                  if (s.selectedText) {
                    const c = s.aiRewriteContext;
                    s.setAiRewrite(
                      s.selectedText,
                      s.cursorPosition,
                      s.cursorPosition + s.selectedText.length,
                      c?.tiptapFrom,
                      c?.tiptapTo,
                    );
                  }
                }}
              >
                <MessageCircle className="size-3 mr-1" />
                附加编辑器选中
              </Button>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Textarea
            rows={2}
            placeholder="输入修改指令..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            className="text-xs"
          />
          {loading ? (
            <Button size="icon" onClick={stop} variant="destructive" title="停止生成">
              <Square className="size-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={send} disabled={!input.trim()}>
              <Send className="size-4" />
            </Button>
          )}
        </div>
        {section === "write" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">风格</span>
            <select
              value={chatStyle}
              onChange={(e) => setChatStyle(e.target.value)}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            >
              <option value="default">默认</option>
              <option value="light-novel">轻小说</option>
              <option value="serious">严肃文学</option>
              <option value="ancient">古风</option>
              <option value="plain">小白文</option>
              <option value="colloquial">口语化</option>
            </select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">模型</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value="deepseek-v4-flash">deepseek-v4-flash</option>
            <option value="deepseek-v4-pro">deepseek-v4-pro</option>
          </select>
        </div>
      </div>
    </div>
  );
}
