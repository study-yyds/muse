import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { BookDetail } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { CharacterList } from "@/components/characters/CharacterList";
import { WorldSettingEditor } from "@/components/world/WorldSettingEditor";
import { OutlinePanel } from "@/components/outline/OutlinePanel";
import { WritingEditor } from "@/components/editor/WritingEditor";
import { BookSettingsPanel } from "@/components/settings/BookSettingsPanel";
import {
  ArrowLeft,
  UserRound,
  Globe,
  ListTree,
  FileText,
  Download,
  Send,
  Loader2,
  Sparkles,
  Settings,
} from "lucide-react";
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

  const { data, isLoading } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.get<{ data: BookDetail }>(`/books/${bookId}`),
    enabled: !!bookId,
  });

  const isDev = bookId?.startsWith("dev-");
  const book = data?.data;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!book && !isDev) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <p>作品不存在</p>
        <Button variant="link" onClick={() => navigate("/")}>返回</Button>
      </div>
    );
  }

  const displayBook = book ?? {
    book_id: bookId!,
    title: "开发模式作品",
    word_count: 0,
    status: "writing" as const,
    cover_url: null,
    last_updated: new Date().toISOString(),
    preset_style: "default",
    auto_save_interval_sec: 300,
  };

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* ======== 左侧导航栏 ======== */}
      <nav className="w-48 shrink-0 border-r border-border bg-card flex flex-col">
        {/* 作品标题 */}
        <div className="px-4 py-3 border-b border-border">
          <Button
            variant="ghost"
            size="icon-xs"
            className="mb-2"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-sm font-semibold text-foreground truncate">
            {displayBook.title}
          </h1>
          <p className="text-xs text-muted-foreground">
            {displayBook.word_count.toLocaleString()} 字
          </p>
        </div>

        {/* 导航菜单 */}
        <div className="flex-1 py-2">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setSection(item.key)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-left",
                section === item.key
                  ? "bg-muted text-foreground font-medium border-r-2 border-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
        </div>

        {/* 导出 */}
        <div className="p-3 border-t border-border">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                  <Download className="size-4" />导出
                </Button>
              }
            />
            <DropdownMenuContent side="right" align="start">
              {(["txt", "docx", "html"] as const).map((fmt) => (
                <DropdownMenuItem
                  key={fmt}
                  onClick={() => {
                    const blob = new Blob(
                      [`【${displayBook.title}】\n导出格式: ${fmt.toUpperCase()}\n导出功能将在后端就绪后可用。`],
                      { type: "text/plain" }
                    );
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${displayBook.title}.${fmt}`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  导出 {fmt.toUpperCase()}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>

      {/* ======== 中间内容区 ======== */}
      <div className="flex-1 flex flex-col min-w-0">
        {section === "write" && bookId && <WritingEditor bookId={bookId} />}
        {section === "outline" && bookId && (
          <div className="p-4 h-full">
            <OutlinePanel bookId={bookId} />
          </div>
        )}
        {section === "characters" && bookId && (
          <div className="p-4 h-full overflow-y-auto">
            <CharacterList bookId={bookId} />
          </div>
        )}
        {section === "world" && bookId && (
          <div className="p-4 h-full overflow-y-auto">
            <WorldSettingEditor bookId={bookId} />
          </div>
        )}
        {section === "settings" && bookId && (
          <div className="h-full overflow-y-auto">
            <BookSettingsPanel bookId={bookId} />
          </div>
        )}
      </div>

      {/* ======== 右侧 AI 对话面板 ======== */}
      <AIChatPanel />
    </div>
  );
}

/* ======== AI 对话面板 ======== */
function AIChatPanel() {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>(() => [
    {
      role: "assistant",
      content: "你好！我是 Muse 写作助手。你可以让我帮你修改角色设定、调整大纲结构、润色世界观描述。随时告诉我你的想法。",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const send = () => {
    if (!input.trim() || loading) return;
    setMessages((prev) => [...prev, { role: "user", content: input }]);
    setInput("");
    setLoading(true);

    // TODO: 接入 AI API
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "（模拟回复）好的，我理解你的需求。实际 AI 功能将在接入后端后可用。",
        },
      ]);
      setLoading(false);
    }, 1000);
  };

  return (
    <div className="w-72 shrink-0 border-l border-border bg-card flex flex-col">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium text-foreground">AI 助手</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">可以对话修改内容</p>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "text-sm rounded-lg px-3 py-2",
                msg.role === "user"
                  ? "bg-primary/10 text-foreground ml-2"
                  : "bg-muted text-foreground mr-2 whitespace-pre-wrap"
              )}
            >
              {msg.content}
            </div>
          ))}
          {loading && (
            <div className="text-xs text-muted-foreground italic px-3">
              <Loader2 className="inline size-3 animate-spin mr-1" />思考中...
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border">
        <div className="flex gap-2">
          <Textarea
            rows={2}
            placeholder="输入修改指令..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="text-xs"
          />
          <Button size="icon" onClick={send} disabled={loading || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
