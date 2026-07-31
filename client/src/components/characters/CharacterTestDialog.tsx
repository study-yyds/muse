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
  const customKey = JSON.parse(localStorage.getItem("muse-custom-api-key") || "null");
  const customLabel = customKey ? `自定义 (${customKey.model_name || "?"})` : "自定义（未配置）";
  const [model, setModel] = useState("deepseek-v4-flash");
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
          body: JSON.stringify({
            message: input,
            model: model === "__custom__" ? customKey?.model_name : model,
            api_key: model === "__custom__" ? customKey?.api_key : undefined,
            base_url: model === "__custom__" ? customKey?.base_url : undefined,
          }),
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
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]" || payload === "{}") continue;
            // 尝试 JSON 解析，兼容 JSON 编码和纯文本两种格式
            try { ac += JSON.parse(payload); } catch { ac += payload; }
            setStreaming(ac);
          }
        }
      }
      // 流结束后统一保存
      if (ac.trim()) {
        setMessages((prev) => [...prev, { role: "assistant", content: ac.trim() }]);
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
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{char.name}</span>
          {char.personality && <span> · {char.personality.slice(0, 40)}</span>}
        </div>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="text-xs rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground"
        >
          <option value="deepseek-v4-flash">deepseek-v4-flash</option>
          <option value="deepseek-v4-pro">deepseek-v4-pro</option>
          {customKey && <option value="__custom__">{customLabel}</option>}
        </select>
      </div>

      {/* 对话区 */}
      <ScrollArea className="flex-1 min-h-0 rounded-md border border-border bg-muted/30 p-3">
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
