import { useState, useEffect } from "react";
import { api, authFetch } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, History } from "lucide-react";
import { ModelSelector, customKeyValue } from "@/components/settings/ModelSelector";
import { getDefaultModel } from "@/lib/default-model";

/**
 * 作品简介：AI 生成（服务端按书类型分流平台调性）+ 手动编辑 + 版本历史回退。
 * 生成与保存均落库（extra.synopsis / extra.synopsis_history）。
 */
export function SynopsisSection({ bookId }: { bookId: string }) {
  const [synopsis, setSynopsis] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(getDefaultModel().model || "");
  const [keyId, setKeyId] = useState<string | undefined>(getDefaultModel().keyId);
  const { toast } = useToast();

  useEffect(() => {
    api
      .get<{ data: { extra?: any } }>(`/books/${bookId}/settings`)
      .then((res) => {
        const extra = res?.data?.extra ?? {};
        const s = extra.synopsis || "";
        setSynopsis(s);
        setSaved(s);
        setHistory(extra.synopsis_history ?? []);
      })
      .catch(() => {});
  }, [bookId]);

  const save = async (text: string, silent = false) => {
    setSaving(true);
    try {
      await api.put(`/books/${bookId}/settings`, {
        extra: { synopsis: text } as any,
      });
      setSaved(text);
      if (!silent) toast({ title: "简介已保存" });
    } catch {
      if (!silent) toast({ title: "保存失败", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("token");
      const res = await authFetch("/api/ai/generate-synopsis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          book_id: bookId,
          ...(model ? { model } : {}),
          ...(keyId ? { key_id: keyId } : {}),
        }),
      });
      const json = await res.json();
      const s = json?.data?.synopsis || "";
      const h = json?.data?.history ?? [];
      if (!s) {
        toast({ title: "生成失败", variant: "destructive" });
        return;
      }
      setSynopsis(s);
      setHistory(h);
      await save(s, true); // 生成结果直接落库
      toast({ title: "简介已生成并保存（可在下方编辑后再次保存）" });
    } catch {
      toast({ title: "生成失败", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const restoreHistory = async (text: string) => {
    setSynopsis(text);
    await save(text, true);
    toast({ title: "已回退到该历史版本" });
  };

  const isDirty = synopsis !== saved;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">作品简介</Label>
        {isDirty && (
          <span className="text-xs text-muted-foreground">未保存</span>
        )}
      </div>

      <textarea
        value={synopsis}
        onChange={(e) => setSynopsis(e.target.value)}
        placeholder="暂无简介：点击下方按钮 AI 生成，或直接手写"
        rows={4}
        className="w-full rounded border border-border bg-background px-3 py-2 text-sm leading-relaxed resize-none"
      />

      {history.length > 1 && (
        <div className="flex items-center gap-2">
          <History className="size-3.5 text-muted-foreground shrink-0" />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) restoreHistory(e.target.value);
            }}
            className="flex-1 min-w-0 rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">历史版本（{history.length} 版，选择即回退）</option>
            {history
              .slice()
              .reverse()
              .map((h, i) => (
                <option key={i} value={h}>
                  {h.slice(0, 30)}…
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="flex items-center gap-2">
        <ModelSelector
          usage="chat"
          allowAuto
          value={keyId ? customKeyValue(keyId) : model}
          onChange={(m, k) => {
            setModel(m);
            setKeyId(k);
          }}
          className="text-xs rounded border border-border bg-background px-2 py-1"
        />
        <Button size="sm" variant="outline" onClick={generate} disabled={loading || saving}>
          {loading && <Loader2 className="size-3 animate-spin mr-1" />}
          生成简介
        </Button>
        <Button size="sm" onClick={() => save(synopsis)} disabled={saving || !isDirty || !synopsis.trim()}>
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}
