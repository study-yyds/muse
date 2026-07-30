import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Send } from "lucide-react";
import type { CharacterData } from "@muse/shared";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  char: CharacterData;
  bookId: string;
  onClose: () => void;
}

export function CharacterTestDialog({ char, bookId }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const token = localStorage.getItem("token");

  // 初始化：获取或创建测试会话，加载历史消息
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(
          `/api/books/${bookId}/characters/${char.char_id}/test`,
          {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
          },
        );
        const d = await r.json();
        if (d.data) {
          sessionRef.current = d.data.session_id;
          if (Array.isArray(d.data.messages) && d.data.messages.length > 0) {
            setMessages(d.data.messages.map((m: any) => ({
              role: m.role,
              content: m.content,
            })));
          }
        }
      } catch { /* ignore */ }
    })();
  }, [char.char_id, bookId, token]);

  const send = async () => {
    if (!input.trim() || isLoading || !sessionRef.current) return;
    const userMsg: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setStreaming("");

    try {
      const r = await fetch(
        `/api/books/${bookId}/characters/${char.char_id}/test/${sessionRef.current}/message`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ message: input }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const reader = r.body?.getReader();
      if (!reader) throw new Error("无响应");

      const decoder = new TextDecoder();
      let buf = ""; let ac = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let ev = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            if (ev === "chunk") { ac += payload; }
            if (ev === "done") {
              if (ac.trim()) {
                setMessages((prev) => [...prev, { role: "assistant", content: ac.trim() }]);
                ac = "";
              }
            }
            if (ev === "error") { throw new Error("AI 错误"); }
            ev = "";
          }
        }
        if (ac) setStreaming(ac);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "（对话失败，请重试）" }]);
    }
    setIsLoading(false);
    setStreaming("");
  };

  return (
    <div className="flex flex-col h-80">
      {/* 角色简介 */}
      <div className="mb-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{char.name}</span>
        {char.personality && <span> · {char.personality.slice(0, 40)}</span>}
      </div>

      {/* 对话区 */}
      <ScrollArea className="flex-1 rounded-md border border-border bg-muted/30 p-3">
        {messages.length === 0 && !streaming && (
          <p className="text-xs text-muted-foreground text-center py-8">
            输入一句话，测试 {char.name} 会如何回应
          </p>
        )}
        <div className="space-y-2">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`text-sm ${msg.role === "user" ? "text-foreground" : "text-muted-foreground italic"}`}
            >
              <span className="font-medium text-xs">
                {msg.role === "user" ? "你" : char.name}：
              </span>
              {msg.content}
            </div>
          ))}
          {streaming && (
            <div className="text-sm text-muted-foreground italic">
              <span className="font-medium text-xs">{char.name}：</span>
              {streaming}
              <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
            </div>
          )}
          {isLoading && !streaming && (
            <p className="text-xs text-muted-foreground italic">
              <Loader2 className="inline size-3 animate-spin mr-1" />
              {char.name} 正在思考...
            </p>
          )}
        </div>
      </ScrollArea>

      {/* 输入区 */}
      <div className="mt-3 flex gap-2">
        <Textarea
          rows={2}
          placeholder={`对 ${char.name} 说点什么...`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button size="icon" onClick={send} disabled={isLoading || !input.trim()}>
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}
