import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { ArrowLeft, UserRound, Globe, ListTree, FileText, Download, Send, Loader2, Sparkles, Settings, BarChart3, Menu, MessageCircle } from "lucide-react";
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
            {(["txt", "docx", "html"] as const).map((fmt) => (
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
  const [section, setSection] = useState<Section>("write");
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
  type Ver = { content: string; action?: any };
  type Msg = { role: string; content: string; action?: any; versions?: Ver[]; adoptedVer?: number };
  const [histories, setHistories] = useState<Record<string, Msg[]>>({});
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("deepseek-v4-flash");
  const [activeVer, setActiveVer] = useState<Record<number, number>>({});
  const rewriteCtx = useEditorStore((s) => s.aiRewriteContext);
  const clearRewrite = useEditorStore((s) => s.clearAiRewrite);
  const editor = useEditorStore();
  const { toast } = useToast();
  const msgs = histories[section] ?? [];
  const token = localStorage.getItem("token");

  const extractDisplayText = (t: string) => {
    if (!t.trim()) return "";
    if (t.trim().startsWith("{")) {
      try { const p = JSON.parse(t.trim()); if (p.action && p.content) return p.content; } catch { /* incomplete */ }
    }
    const lastBrace = t.lastIndexOf("{");
    if (lastBrace > 0) {
      try { const p = JSON.parse(t.slice(lastBrace)); if (p.action) return t.slice(0, lastBrace).trim(); } catch { return t.slice(0, lastBrace).trim(); }
    }
    return t.trim();
  };

  // 单次 SSE 流式调用
  const streamOnce = async (msg: string, prevMsgs: { role: string; content: string }[], bodyExtra?: Record<string, any>): Promise<Ver> => {
    const r = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ book_id: bookId, context_type: section, model, message: msg, messages: prevMsgs, ...bodyExtra }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const reader = r.body?.getReader(); if (!reader) throw new Error("无响应");
    const decoder = new TextDecoder(); let buf = ""; let ac = ""; let action: any = undefined;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() ?? "";
      let ev = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (ev === "chunk") { ac += payload; }
          if (ev === "action") { try { action = JSON.parse(payload); } catch { /* ignore */ } }
          if (ev === "error") {
            try { const err = JSON.parse(payload); throw new Error(err.message ?? "AI 错误"); } catch (e) { if (e instanceof Error && e.message !== "AI 错误") throw e; throw new Error("AI 请求失败"); }
          }
          ev = "";
        }
      }
      if (ac) setStreaming(extractDisplayText(ac));
    }
    return { content: ac ? extractDisplayText(ac) : "", action };
  };

  const send = async () => {
    if (!input.trim() || loading) return;
    const msg = rewriteCtx
      ? "【改写以下选中文本】\n" + rewriteCtx.text + "\n\n【用户指令】" + input
      : input;
    const um: Msg = { role: "user", content: msg };
    const prevMsgs = [...msgs, um].map((m) => ({ role: m.role, content: m.content }));
    setHistories((p) => ({ ...p, [section]: [...(p[section] ?? []), um] }));
    setInput(""); setLoading(true); setStreaming("");
    const bodyExtra: Record<string, any> = {};
    if (section === "write" && editor.activeChapterId) {
      bodyExtra.chapter_id = editor.activeChapterId;
      bodyExtra.cursor_position = rewriteCtx ? rewriteCtx.start : editor.cursorPosition;
    }
    try {
      const V = 3;
      const versions: Ver[] = [];
      const baseMsgs = [...prevMsgs];
      for (let v = 0; v < V; v++) {
        setStreaming(`版本 ${v + 1}/${V} 生成中...`);
        const result = await streamOnce(msg, baseMsgs, bodyExtra);
        versions.push(result);
      }
      setStreaming("");
      setHistories((p) => {
        const updated = [...(p[section] ?? [])];
        updated.push({ role: "assistant", content: versions[0].content, action: versions[0].action, versions });
        return { ...p, [section]: updated };
      });
    } catch (e: any) {
      setHistories((p) => ({ ...p, [section]: [...(p[section] ?? []), { role: "assistant", content: `（${e.message ?? "网络异常"}）` }] }));
    }
    setLoading(false); setStreaming("");
  };

  const adopt = async (a: any, gi: number, vi: number) => {
    try {
      if (a.action === "create_character") { await fetch("/api/books/" + bookId + "/characters", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(a) }); toast({ title: "角色已创建" }); }
      else if (a.action === "add_chapter") { await fetch("/api/books/" + bookId + "/outline/chapters", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(a) }); toast({ title: "大纲章节已添加" }); }
      else {
        const oldCtx = useEditorStore.getState().aiRewriteContext;
        if (oldCtx) { useEditorStore.getState().requestReplace(oldCtx.text, a.content, oldCtx.start, oldCtx.end); useEditorStore.getState().clearAiRewrite(); }
        else useEditorStore.getState().requestInsert(a.content);
        toast({ title: "已插入编辑器" });
      }
      setHistories((p) => {
        const sec = [...(p[section] ?? [])];
        if (gi < sec.length) sec[gi] = { ...sec[gi], adoptedVer: vi };
        return { ...p, [section]: sec };
      });
    } catch (e) { toast({ title: "写入失败", variant: "destructive" }); }
  };

  let globalIdx = 0;
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium text-foreground">AI 助手</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">可对话修改内容</p>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-3">
          {msgs.map((m: Msg, i: number) => {
            const gi = globalIdx++;
            const hasVers = m.versions && m.versions.length > 1;
            const vi = hasVers ? (activeVer[gi] ?? 0) : 0;
            const displayContent = hasVers && m.versions ? m.versions[vi]?.content : m.content;
            const displayAction = hasVers && m.versions ? m.versions[vi]?.action : m.action;
            return (
              <div
                key={i}
                className={cn(
                  "text-sm rounded-lg px-3 py-2",
                  m.role === "user"
                    ? "bg-primary/10 text-foreground ml-2"
                    : "bg-muted text-foreground mr-2"
                )}
              >
                <div className="whitespace-pre-wrap">{displayContent}</div>
                {m.adoptedVer !== undefined ? (
                  <div className="mt-2 pt-2 border-t border-border text-xs text-muted-foreground text-center">
                    已采纳{hasVers ? ` (版本 ${m.adoptedVer + 1})` : ""}
                  </div>
                ) : displayAction && (
                  <div className="mt-2 pt-2 border-t border-border space-y-1.5">
                    <div className="flex items-center justify-center gap-1">
                      {hasVers && (
                        <Button variant="ghost" size="icon-xs" disabled={vi === 0} onClick={() => setActiveVer((p) => ({ ...p, [gi]: vi - 1 }))}>
                          &lt;
                        </Button>
                      )}
                      <Button size="xs" onClick={() => adopt(displayAction, gi, vi)}>
                        采纳{hasVers ? ` (${vi + 1}/${m.versions!.length})` : ""}
                      </Button>
                      {hasVers && (
                        <Button variant="ghost" size="icon-xs" disabled={vi >= m.versions!.length - 1} onClick={() => setActiveVer((p) => ({ ...p, [gi]: vi + 1 }))}>
                          &gt;
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {streaming && (
            <div className="text-sm rounded-lg px-3 py-2 bg-muted text-foreground mr-2 whitespace-pre-wrap">
              {streaming}
              <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
            </div>
          )}
          {loading && !streaming && (
            <div className="text-xs text-muted-foreground italic px-3">
              <Loader2 className="inline size-3 animate-spin mr-1" />
              思考中...
            </div>
          )}
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
                  &times;
                </button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className="text-xs"
                onClick={() => {
                  const s = useEditorStore.getState();
                  if (s.selectedText) s.setAiRewrite(s.selectedText, s.cursorPosition, s.cursorPosition + s.selectedText.length);
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
          <Button size="icon" onClick={send} disabled={loading || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">模型</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
            <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
          </select>
        </div>
      </div>
    </div>
  );
}
