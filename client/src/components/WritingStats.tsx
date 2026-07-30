import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, TrendingUp, BookOpen } from "lucide-react";

interface Props {
  bookId: string;
}

export function WritingStats({ bookId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["stats", bookId],
    queryFn: () => api.get<{ data: { total: number; chapterCount: number; daily: Record<string, number> } }>(`/books/${bookId}/stats`),
  });

  const stats = data?.data;

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!stats) return <p className="text-sm text-muted-foreground">暂无统计数据</p>;

  // 日字数柱状图数据（最近 14 天）
  const days: { date: string; words: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key.slice(5), words: stats.daily[key] ?? 0 });
  }
  const maxWords = Math.max(...days.map((d) => d.words), 1);

  return (
    <div className="space-y-4">
      {/* 概览卡片 */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<FileText className="size-4" />} label="总字数" value={stats.total.toLocaleString()} />
        <StatCard icon={<BookOpen className="size-4" />} label="章节数" value={String(stats.chapterCount)} />
        <StatCard icon={<TrendingUp className="size-4" />} label="日均字数" value={stats.chapterCount > 0 ? Math.round(stats.total / Math.max(stats.chapterCount, 1)).toLocaleString() : "0"} />
      </div>

      {/* 日字数柱状图 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="text-sm font-medium text-foreground mb-3">近 14 天写作量</h4>
        <div className="flex items-end gap-1 h-24">
          {days.map((d) => (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
              <span className="text-[9px] text-muted-foreground">{d.words > 0 ? d.words.toLocaleString() : ""}</span>
              <div
                className="w-full rounded-sm bg-primary/60 hover:bg-primary transition-colors min-h-[2px]"
                style={{ height: `${(d.words / maxWords) * 100}%` }}
                title={`${d.date}: ${d.words} 字`}
              />
              <span className="text-[9px] text-muted-foreground mt-1">{d.date}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <div className="flex justify-center text-primary mb-1">{icon}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
