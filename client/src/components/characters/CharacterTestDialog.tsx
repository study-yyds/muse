import { useState } from "react";
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
  onClose: () => void;
}

export function CharacterTestDialog({ char }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const send = async () => {
    if (!input.trim() || isLoading) return;
    const userMsg: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    // TODO: 接入后端 AI API
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `（以 ${char.name} 的身份）这是一个模拟回复。实际功能将在接入 AI API 后可用。`,
        },
      ]);
      setIsLoading(false);
    }, 800);
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
        {messages.length === 0 && (
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
          {isLoading && (
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
