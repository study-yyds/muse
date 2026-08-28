import { authFetch } from "@/services/api";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES: Record<string, string[]> = {
  character: ["仙侠/武侠", "历史/权谋", "轻小说/校园", "科幻", "都市", "其他"],
  world: ["仙侠", "科幻", "历史", "都市", "奇幻", "其他"],
  outline: ["通用", "仙侠", "科幻", "历史", "悬疑", "其他"],
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: "character" | "world" | "outline";
  data: any;
}

export function SaveAsTemplateDialog({ open, onOpenChange, type, data }: Props) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[type][0]);
  const [desc, setDesc] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const t = localStorage.getItem("token");
      const res = await authFetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ name: name.trim(), type, category, description: desc, data, is_public: isPublic }),
      });
      if (res.ok) {
        toast({ title: "模板已保存" });
        onOpenChange(false);
        setName(""); setDesc(""); setIsPublic(false);
      } else {
        toast({ title: "保存失败", variant: "destructive" });
      }
    } catch {
      toast({ title: "保存失败", variant: "destructive" });
    }
    setSaving(false);
  };

  const cats = CATEGORIES[type];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>保存为模板</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">模板名称 *</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="如：冷面剑客、修仙世界" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">分类标签</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
              {cats.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">简短描述</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="一句话介绍这个模板" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">可见范围</span>
            <Button
              variant={isPublic ? "secondary" : "outline"}
              size="xs"
              onClick={() => setIsPublic(!isPublic)}
            >
              {isPublic ? "公共" : "私有"}
            </Button>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
            <Button size="sm" onClick={handleSave} disabled={!name.trim() || saving}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
