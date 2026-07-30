import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { BookDetail } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { CharacterList } from "@/components/characters/CharacterList";
import { WorldSettingEditor } from "@/components/world/WorldSettingEditor";
import { OutlinePanel } from "@/components/outline/OutlinePanel";
import { WritingEditor } from "@/components/editor/WritingEditor";
import { BookSettingsPanel } from "@/components/settings/BookSettingsPanel";
import { useEditorStore } from "@/stores/editor";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ArrowLeft, UserRound, Globe, ListTree, FileText, Download, Send, Loader2, Sparkles, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

type Section = "write" | "outline" | "characters" | "world" | "settings";
const NAV_ITEMS: { key: Section; label: string; icon: typeof FileText }[] = [
  { key: "write", label: "写作", icon: FileText },
  { key: "outline", label: "大纲", icon: ListTree },
  { key: "characters", label: "角色", icon: UserRound },
  { key: "world", label: "世界观", icon: Globe },
  { key: "settings", label: "设置", icon: Settings },
];

export function BookDetailPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [section, setSection] = useState<Section>("write");
  const { data, isLoading } = useQuery({ queryKey: ["book", bookId], queryFn: () => api.get<{ data: BookDetail }>(`/books/${bookId}`), enabled: !!bookId });
  const book = data?.data;
  if (isLoading) return <div className="mx-auto max-w-5xl px-6 py-6 space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-96" /></div>;
  if (!book) return <div className="flex flex-col items-center justify-center py-20 text-muted-foreground"><p>作品不存在</p><Button variant="link" onClick={() => navigate("/")}>返回</Button></div>;
  return (
    <div className="flex h-[calc(100vh-48px)]">
      <nav className="w-48 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-4 py-3 border-b border-border">
          <Button variant="ghost" size="icon-xs" className="mb-2" onClick={() => navigate("/")}><ArrowLeft className="size-4" /></Button>
          <h1 className="text-sm font-semibold text-foreground truncate">{book.title}</h1>
          <p className="text-xs text-muted-foreground">{book.word_count.toLocaleString()} 字</p>
        </div>
        <div className="flex-1 py-2">{NAV_ITEMS.map((item) => (
          <button key={item.key} onClick={() => setSection(item.key)} className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left", section === item.key ? "bg-muted text-foreground font-medium border-r-2 border-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50")}><item.icon className="size-4" />{item.label}</button>
        ))}</div>
        <div className="p-3 border-t border-border">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="w-full justify-start gap-2"><Download className="size-4" />导出</Button>} />
            <DropdownMenuContent side="right" align="start">
              {(["txt", "docx", "html"] as const).map((fmt) => (<DropdownMenuItem key={fmt} onClick={() => { const t = localStorage.getItem("token"); window.open("/api/books/" + bookId + "/export?format=" + fmt + "&token=" + t, "_blank"); }}>导出 {fmt.toUpperCase()}</DropdownMenuItem>))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
      <div className="flex-1 flex flex-col min-w-0">
        {section === "write" && bookId && <WritingEditor bookId={bookId} />}
        {section === "outline" && bookId && <div className="p-4 h-full"><OutlinePanel bookId={bookId} /></div>}
        {section === "characters" && bookId && <div className="p-4 h-full overflow-y-auto"><CharacterList bookId={bookId} /></div>}
        {section === "world" && bookId && <div className="p-4 h-full overflow-y-auto"><WorldSettingEditor bookId={bookId} /></div>}
        {section === "settings" && bookId && <div className="h-full overflow-y-auto"><BookSettingsPanel bookId={bookId} /></div>}
      </div>
      <AIChatPanel section={section} bookId={bookId ?? ""} />
    </div>
  );
}

function AIChatPanel({ section, bookId }: { section: string; bookId: string }) {
  const [histories, setHistories] = useState<Record<string, { role: string; content: string; action?: any }[]>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("deepseek-v4-flash");
  const rewriteCtx = useEditorStore((s) => s.aiRewriteContext);
  const clearRewrite = useEditorStore((s) => s.clearAiRewrite);
  const editor = useEditorStore();
  const { toast } = useToast();
  const msgs = histories[section] ?? [];
  const token = localStorage.getItem("token");

  const send = async () => {
    if (!input.trim() || loading) return;
    let msg = input;
    if (section === "write" && editor.activeChapterId) {
      msg = rewriteCtx
        ? "【改写以下选中文本】\n" + rewriteCtx + "\n\n【用户指令】" + input
        : "【续写——光标前内容供参考】\n" + editor.editorContent.slice(Math.max(0, editor.cursorPosition - 1000), editor.cursorPosition) + "\n\n【用户指令】" + input;
    }
    const um = { role: "user", content: msg };
    clearRewrite();
    setHistories((p) => ({ ...p, [section]: [...(p[section] ?? []), um] }));
    setInput(""); setLoading(true);
    try {
      const r = await fetch("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ book_id: bookId, context_type: section, model, message: msg, messages: [...(histories[section] ?? []), um].map((m) => ({ role: m.role, content: m.content })) }) });
      const reader = r.body?.getReader(); if (!reader) return;
      const d = new TextDecoder(); let b = ""; let ac = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        b += d.decode(value, { stream: true }); const lines = b.split("\n"); b = lines.pop() ?? "";
        for (const l of lines) {
          if (l.startsWith("event: chunk")) { try { ac += JSON.parse(l.split("data: ")[1]).content; } catch (e) {} }
          if (l.startsWith("event: action")) { try { const a = JSON.parse(l.split("data: ")[1]); setHistories((p) => ({ ...p, [section]: [...(p[section] ?? []), { role: "assistant", content: ac, action: a }] })); ac = ""; } catch (e) {} }
        }
        if (ac) setHistories((p) => ({ ...p, [section]: [...(p[section] ?? []), { role: "assistant", content: ac }] }));
      }
    } catch (e) { setHistories((p) => ({ ...p, [section]: [...(p[section] ?? []), { role: "assistant", content: "（AI 请求失败）" }] })); }
    setLoading(false);
  };

  const adopt = async (a: any) => {
    try {
      if (a.action === "create_character") { await fetch("/api/books/" + bookId + "/characters", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(a) }); toast({ title: "角色已创建" }); }
      else if (a.action === "add_chapter") { await fetch("/api/books/" + bookId + "/outline/chapters", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(a) }); toast({ title: "大纲章节已添加" }); }
      else toast({ title: "内容已生成，请复制到编辑器" });
    } catch (e) { toast({ title: "写入失败", variant: "destructive" }); }
  };

  return (
    <div className="w-72 shrink-0 border-l border-border bg-card flex flex-col">
      <div className="px-4 py-3 border-b border-border"><div className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /><span className="text-sm font-medium text-foreground">AI 助手</span></div><p className="text-xs text-muted-foreground mt-0.5">可对话修改内容</p></div>
      <ScrollArea className="flex-1 p-4"><div className="space-y-3">
        {msgs.map((m: any, i: number) => (<div key={i} className={cn("text-sm rounded-lg px-3 py-2", m.role === "user" ? "bg-primary/10 text-foreground ml-2" : "bg-muted text-foreground mr-2 whitespace-pre-wrap")}>{m.content}{m.action && <Button size="xs" className="mt-2" onClick={() => adopt(m.action)}>采纳</Button>}</div>))}
        {loading && <div className="text-xs text-muted-foreground italic px-3"><Loader2 className="inline size-3 animate-spin mr-1" />思考中...</div>}
      </div></ScrollArea>
      <div className="p-3 border-t border-border space-y-2">
        {section === "write" && (<div className="flex items-center gap-2">{rewriteCtx ? (<div className="flex-1 flex items-center gap-2 rounded border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-foreground"><span className="text-muted-foreground shrink-0">改写：</span><span className="truncate">{rewriteCtx.slice(0, 80)}</span><button onClick={() => clearRewrite()} className="shrink-0 text-muted-foreground hover:text-foreground">&times;</button></div>) : <Button variant="ghost" size="xs" className="text-xs" onClick={()=>{const ta=document.querySelector("textarea[placeholder='开始写作...']") as HTMLTextAreaElement;const sel=ta?.value.substring(ta.selectionStart??0,ta.selectionEnd??0).trim();if(sel)useEditorStore.getState().setAiRewrite(sel)}}>附加编辑器选中</Button>}</div>)}
        <div className="flex gap-2"><Textarea rows={2} placeholder="输入修改指令..." value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} className="text-xs" /><Button size="icon" onClick={send} disabled={loading || !input.trim()}><Send className="size-4" /></Button></div>
        <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">模型</span><select value={model} onChange={(e) => setModel(e.target.value)} className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"><option value="deepseek-v4-flash">DeepSeek V4 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option><option value="custom">用户自定义</option></select></div>
      </div>
    </div>
  );
}
