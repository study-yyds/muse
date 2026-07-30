import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { CharacterData, CharacterRelation } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, ArrowRight } from "lucide-react";
import { useState, useEffect } from "react";

interface Props {
  bookId: string;
}

export function CharacterRelationGraph({ bookId }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: charsData } = useQuery({
    queryKey: ["characters", bookId],
    queryFn: () => api.get<{ data: CharacterData[] }>(`/books/${bookId}/characters`),
  });
  const characters = charsData?.data ?? [];

  // 加载所有角色关系
  const { data: allRelations, isLoading } = useQuery({
    queryKey: ["all-relations", bookId],
    queryFn: async () => {
      const rels: Record<string, CharacterRelation[]> = {};
      for (const c of characters) {
        if (!c.char_id) continue;
        try {
          const r = await api.get<{ data: CharacterRelation[] }>(
            `/books/${bookId}/characters/${c.char_id}/relations`,
          );
          rels[c.char_id] = r.data ?? [];
        } catch { /* ignore */ }
      }
      return rels;
    },
    enabled: characters.length > 0,
  });

  const relations = allRelations ?? {};

  // 新建关系
  const [adding, setAdding] = useState(false);
  const [sourceChar, setSourceChar] = useState("");
  const [targetChar, setTargetChar] = useState("");
  const [relType, setRelType] = useState("");

  const addMutation = useMutation({
    mutationFn: (body: { target_char_id: string; relation_type: string }) =>
      api.post(`/books/${bookId}/characters/${sourceChar}/relations`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["all-relations", bookId] });
      setAdding(false); setTargetChar(""); setRelType("");
      toast({ title: "关系已添加" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ charId, relId }: { charId: string; relId: string }) =>
      api.delete(`/books/${bookId}/characters/${charId}/relations/${relId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["all-relations", bookId] });
      toast({ title: "关系已删除" });
    },
  });

  const charMap = new Map(characters.map((c) => [c.char_id, c.name]));

  // 计算 SVG 节点位置 — 简单环形布局
  const n = characters.length;
  const r = n > 1 ? 140 : 0;
  const cx = 200, cy = 180;
  const nodes = characters.map((c, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    return {
      id: c.char_id,
      name: c.name,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });

  // 收集所有连线
  const edges: { from: string; to: string; type: string }[] = [];
  for (const [charId, rels] of Object.entries(relations)) {
    for (const rel of rels) {
      const existing = edges.find(
        (e) => (e.from === charId && e.to === rel.target_char_id) ||
               (e.from === rel.target_char_id && e.to === charId)
      );
      if (!existing) {
        edges.push({ from: charId, to: rel.target_char_id, type: rel.relation_type });
      }
    }
  }

  return (
    <div className="space-y-4">
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : characters.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">暂无角色，先添加角色再创建关系</p>
      ) : (
        <>
          {/* SVG 关系图 */}
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <svg viewBox="0 0 400 360" className="w-full h-auto">
              {/* 连线 */}
              {edges.map((edge, i) => {
                const from = nodes.find((n) => n.id === edge.from);
                const to = nodes.find((n) => n.id === edge.to);
                if (!from || !to) return null;
                return (
                  <g key={i}>
                    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                      stroke="var(--primary)" strokeOpacity={0.4} strokeWidth={1.5} />
                    {/* 关系标签 */}
                    <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 4}
                      textAnchor="middle" fill="var(--muted-foreground)" fontSize="10">
                      {edge.type}
                    </text>
                  </g>
                );
              })}
              {/* 节点 */}
              {nodes.map((node) => (
                <g key={node.id}>
                  <circle cx={node.x} cy={node.y} r={5} fill="var(--primary)" />
                  <text x={node.x} y={node.y + 18} textAnchor="middle"
                    fill="var(--foreground)" fontSize="11" fontWeight="500">
                    {node.name}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          {/* 关系列表 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">关系列表</h3>
              <Button size="xs" variant="outline" onClick={() => setAdding(!adding)}>
                <Plus className="size-3" />添加关系
              </Button>
            </div>

            {/* 添加表单 */}
            {adding && (
              <div className="flex items-center gap-2 p-2 rounded border border-border bg-muted/30">
                <select value={sourceChar} onChange={(e) => setSourceChar(e.target.value)}
                  className="text-xs rounded border border-border bg-background px-2 py-1">
                  <option value="">角色A</option>
                  {characters.map((c) => <option key={c.char_id} value={c.char_id}>{c.name}</option>)}
                </select>
                <select value={relType} onChange={(e) => setRelType(e.target.value)}
                  className="text-xs rounded border border-border bg-background px-2 py-1">
                  <option value="">关系</option>
                  {["朋友","恋人","师徒","宿敌","家人","仇敌","利用","暗恋","同盟","敬畏"].map((t) =>
                    <option key={t} value={t}>{t}</option>
                  )}
                </select>
                <select value={targetChar} onChange={(e) => setTargetChar(e.target.value)}
                  className="text-xs rounded border border-border bg-background px-2 py-1">
                  <option value="">角色B</option>
                  {characters.filter((c) => c.char_id !== sourceChar).map((c) => <option key={c.char_id} value={c.char_id}>{c.name}</option>)}
                </select>
                <Button size="xs" disabled={!sourceChar || !targetChar || !relType}
                  onClick={() => addMutation.mutate({ target_char_id: targetChar, relation_type: relType })}>
                  确认
                </Button>
              </div>
            )}

            {/* 现有关系 */}
            {Object.entries(relations).map(([charId, rels]) =>
              rels.length > 0 ? (
                <div key={charId} className="text-xs space-y-1">
                  <span className="font-medium text-foreground">{charMap.get(charId) ?? charId}</span>
                  {rels.map((rel: any) => (
                    <div key={rel.id ?? rel.target_char_id} className="flex items-center gap-2 ml-2 text-muted-foreground">
                      <ArrowRight className="size-3" />
                      <Badge variant="secondary" className="text-[10px]">{rel.relation_type}</Badge>
                      <span className="text-foreground">{charMap.get(rel.target_char_id) ?? rel.target_char_id}</span>
                      {rel.id && (
                        <button onClick={() => deleteMutation.mutate({ charId, relId: rel.id })}
                          className="text-muted-foreground hover:text-destructive">
                          <X className="size-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : null
            )}
            {Object.values(relations).every((r) => r.length === 0) && !adding && (
              <p className="text-xs text-muted-foreground text-center py-4">暂无关系，点击"添加关系"创建</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
