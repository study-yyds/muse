import { useState, useEffect } from "react";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { ModelSelector } from "@/components/settings/ModelSelector";

export function SynopsisSection({ bookId }: { bookId: string }) {
  const [synopsis, setSynopsis] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("deepseek-v4-flash");
  const { toast } = useToast();

  useEffect(() => {
    api
      .get<{ data: { extra?: any } }>(`/books/${bookId}/settings`)
      .then((res) => setSynopsis(res?.data?.extra?.synopsis || ""))
      .catch(() => {});
  }, [bookId]);

  const generate = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/ai/generate-synopsis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ book_id: bookId, model }),
      });
      const json = await res.json();
      const s = json?.data?.synopsis || "";
      setSynopsis(s);
      toast({
        title: s ? "简介已生成" : "生成失败",
        variant: s ? "default" : "destructive",
      });
    } catch {
      toast({ title: "生成失败", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">作品简介</Label>
      {synopsis ? (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {synopsis}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          暂无简介，点击下方按钮 AI 自动生成
        </p>
      )}
      <div className="flex items-center gap-2">
        <ModelSelector usage="chat" value={model} onChange={setModel} className="text-xs rounded border border-border bg-background px-2 py-1" />
        <Button size="sm" variant="outline" onClick={generate} disabled={loading}>
          {loading && <Loader2 className="size-3 animate-spin mr-1" />}
          {synopsis ? "重新生成" : "生成简介"}
        </Button>
      </div>
    </div>
  );
}
