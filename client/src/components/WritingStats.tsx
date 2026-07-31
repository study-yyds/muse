import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, TrendingUp, BookOpen, Flame, Target } from "lucide-react";

interface Props {
  bookId: string;
}

export function WritingStats({ bookId }: Props) {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["stats", bookId],
    queryFn: () =>
      api.get<{
        data: { total: number; chapterCount: number; daily: Record<string, number>; todayWords: number; streak: number };
      }>(`/books/${bookId}/stats`),
  });

  // 获取码字目标
  const { data: settings } = useQuery({
    queryKey: ["book-settings", bookId],
    queryFn: () => api.get<{ data: { daily_word_goal?: number; extra?: any } }>(`/books/${bookId}/settings`),
  });

  const s = stats?.data;
  const goal = settings?.data?.daily_word_goal ?? (settings?.data?.extra as any)?.daily_word_goal ?? 0;

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!s) return <p className="text-sm text-muted-foreground">暂无统计数据</p>;

  const todayWords = s.todayWords ?? 0;
  const progress = goal > 0 ? Math.min(todayWords / goal, 1) : 0;
  const remain = goal > 0 ? Math.max(goal - todayWords, 0) : 0;

  // 日字数柱状图数据（最近 14 天）
  const days: { date: string; words: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key.slice(5), words: s.daily[key] ?? 0 });
  }
  const maxWords = Math.max(...days.map((d) => d.words), goal, 1);

  return (
    <div className="space-y-4">
      {/* 今日目标进度条 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground">今日码字</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {goal > 0 && (
              <span className="text-muted-foreground">
                {todayWords.toLocaleString()} / {goal.toLocaleString()}
              </span>
            )}
            {goal === 0 && (
              <span className="text-muted-foreground">{todayWords.toLocaleString()} 字</span>
            )}
            {(s.streak ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-orange-500 text-xs">
                <Flame className="size-3.5" />
                {s.streak} 天
              </span>
            )}
          </div>
        </div>
        {goal > 0 && (
          <>
            <div className="w-full h-3 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {progress >= 1
                ? "🎉 今日目标已达成！"
                : `还差 ${remain.toLocaleString()} 字，加油！`}
            </p>
          </>
        )}
        {goal === 0 && (
          <p className="text-xs text-muted-foreground">
            前往「设置」设定每日码字目标
          </p>
        )}
      </div>

      {/* 概览卡片 */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<FileText className="size-4" />} label="总字数" value={s.total.toLocaleString()} />
        <StatCard icon={<BookOpen className="size-4" />} label="章节数" value={String(s.chapterCount)} />
        <StatCard icon={<TrendingUp className="size-4" />} label="连续打卡" value={`${s.streak ?? 0} 天`} />
      </div>

      {/* 日字数柱状图 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="text-sm font-medium text-foreground mb-3">近 14 天写作量</h4>
        {goal > 0 && (
          <div className="relative mb-1">
            <div className="absolute left-0 right-0 border-t border-dashed border-orange-400/40"
              style={{ bottom: `${(goal / maxWords) * 100}%` }} />
          </div>
        )}
        <div className="flex items-end gap-1 h-24">
          {days.map((d) => (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
              <span className="text-[9px] text-muted-foreground">{d.words > 0 ? d.words.toLocaleString() : ""}</span>
              <div
                className={`w-full rounded-sm transition-colors min-h-[2px] ${
                  d.words >= goal && goal > 0 ? "bg-orange-400" : "bg-primary/60 hover:bg-primary"
                }`}
                style={{ height: `${Math.max((d.words / maxWords) * 100, 0.5)}%` }}
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
