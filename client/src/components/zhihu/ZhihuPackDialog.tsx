import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Copy, PenLine, Sparkles } from 'lucide-react';

interface Props {
  bookId: string;
  content: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplyOpening: (opening: string) => void;
}

export function ZhihuPackDialog({
  bookId,
  content,
  open,
  onOpenChange,
  onApplyOpening,
}: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [titles, setTitles] = useState<string[]>([]);
  const [openings, setOpenings] = useState<string[]>([]);
  const [error, setError] = useState('');

  // 打开时生成
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError('');
      setTitles([]);
      setOpenings([]);
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/ai/zhihu-pack', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ book_id: bookId, content: content.slice(0, 500) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.code && json.code >= 400) {
          throw new Error(json.message || '生成失败');
        }
        if (cancelled) return;
        setTitles(json.data?.titles ?? []);
        setOpenings(json.data?.openings ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e.message || '生成失败');
      }
      if (!cancelled) setLoading(false);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, bookId, content]);

  const copyTitle = async (title: string) => {
    try {
      await navigator.clipboard.writeText(title);
      toast({ title: '标题已复制' });
    } catch {
      toast({ title: '复制失败', variant: 'destructive' });
    }
  };

  const applyOpening = (opening: string) => {
    onApplyOpening(opening);
    toast({ title: '开头已替换，记得保存' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            知乎体包装
          </DialogTitle>
          <DialogDescription>
            基于当前章节开头，生成知乎体标题和抓人开篇
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在生成标题和开篇...
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {!loading && titles.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">标题候选（点击复制）</label>
              <div className="space-y-2">
                {titles.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded border border-border bg-muted/20 p-2.5"
                  >
                    <span className="flex-1 text-sm">{t}</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => copyTitle(t)}
                      title="复制标题"
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && openings.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                开篇改写（替换章节前 500 字）
              </label>
              <div className="space-y-3">
                {openings.map((o, i) => (
                  <div
                    key={i}
                    className="rounded border border-border bg-muted/20 p-3 space-y-2"
                  >
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{o}</p>
                    <Button
                      size="xs"
                      onClick={() => applyOpening(o)}
                      title="用这个开篇替换当前章节开头"
                    >
                      <PenLine className="size-3 mr-1" />
                      替换开头
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && !error && titles.length === 0 && openings.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              没有生成结果，请重试
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
