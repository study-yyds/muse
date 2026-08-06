import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { X, Plus } from "lucide-react";

export function ApiKeyManager() {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [modelName, setModelName] = useState("deepseek-v4-flash");
  const [usage, setUsage] = useState("chat");
  const [keys, setKeys] = useState<any[]>([]);
  const { toast } = useToast();

  const loadKeys = async () => {
    const token = localStorage.getItem("token");
    try {
      const res = await fetch("/api/user/api-keys", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setKeys(json.data || []);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => { loadKeys(); }, []);

  const saveKey = async () => {
    if (!name.trim() || !key.trim()) return;
    const token = localStorage.getItem("token");
    try {
      const res = await fetch("/api/user/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, api_key: key, base_url: baseUrl, model_name: modelName, usage }),
      });
      if (res.ok) {
        toast({ title: "API Key 已保存" });
        setName(""); setKey(""); loadKeys();
      } else {
        toast({ title: "保存失败", variant: "destructive" });
      }
    } catch {
      toast({ title: "保存失败", variant: "destructive" });
    }
  };

  const deleteKey = async (id: string) => {
    const token = localStorage.getItem("token");
    try {
      await fetch(`/api/user/api-keys/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      loadKeys();
      toast({ title: "已删除" });
    } catch { toast({ title: "删除失败", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto">
      <div>
        <h4 className="text-sm font-medium mb-2">API Key 管理</h4>
        <p className="text-xs text-muted-foreground mb-3">
          添加你自己的大模型 API Key，留空则使用平台内置 Key
        </p>

        {/* 已有 Key 列表 */}
        {keys.length > 0 && (
          <div className="space-y-1 mb-3">
            {keys.map((k: any) => (
              <div key={k.id} className="flex items-center gap-2 text-xs py-1.5 px-2 rounded bg-muted/30">
                <span className="font-medium">{k.name}</span>
                <span className="text-muted-foreground">{k.model_name}</span>
                <Badge variant="secondary" className="text-[10px]">{k.usage === 'both' ? '通用' : k.usage === 'image' ? '生图' : '文本'}</Badge>
                <button onClick={() => deleteKey(k.id)} className="ml-auto text-muted-foreground hover:text-destructive">
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 新增表单 */}
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="flex gap-2">
            <input placeholder="名称（如：公司的深言V4）" value={name} onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs" />
            <select value={usage} onChange={(e) => setUsage(e.target.value)}
              className="w-16 rounded border border-border bg-background px-1 py-1.5 text-xs">
              <option value="chat">文本</option>
              <option value="image">生图</option>
              <option value="both">通用</option>
            </select>
          </div>
          <div className="flex gap-2">
            <input placeholder="API Key" value={key} onChange={(e) => setKey(e.target.value)}
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs" />
          </div>
          <div className="flex gap-2">
            <input placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs" />
            <input placeholder="Model" value={modelName} onChange={(e) => setModelName(e.target.value)}
              className="w-36 rounded border border-border bg-background px-2 py-1.5 text-xs" />
          </div>
          <Button size="sm" onClick={saveKey} className="w-full">
            <Plus className="size-3 mr-1" />添加 Key
          </Button>
        </div>
      </div>
    </div>
  );
}
