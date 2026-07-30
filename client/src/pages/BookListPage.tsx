import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { BookListItem } from "@muse/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, BookOpen, Loader2, Trash2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const createBookSchema = z.object({
  title: z.string().min(1, "书名不能为空").max(200),
  preset_style: z.string().optional(),
});

type CreateBookForm = z.infer<typeof createBookSchema>;

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  writing: "写作中",
  completed: "已完成",
};

export function BookListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["books", showDeleted ? "deleted" : "active"],
    queryFn: () =>
      api.get<{ data: BookListItem[] }>(
        `/books?status=${showDeleted ? "deleted" : "active"}`
      ),
  });

  const books = data?.data ?? [];

  const createBook = useMutation({
    mutationFn: (form: CreateBookForm) =>
      api.post<{ data: { book_id: string } }>("/books", form),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      setDialogOpen(false);
      toast({ title: "作品已创建" });
      navigate(`/books/${res.data.book_id}`);
    },
    onError: () => {
      setDialogOpen(false);
      toast({ title: "创建失败，请确认后端已启动", variant: "destructive" });
    },
  });

  const deleteBook = useMutation({
    mutationFn: (bookId: string) => api.delete(`/books/${bookId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "作品已移至回收站" });
    },
    onError: () => {
      toast({ title: "删除失败，后端未启动", variant: "destructive" });
    },
  });

  const restoreBook = useMutation({
    mutationFn: (bookId: string) => api.post(`/books/${bookId}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "作品已恢复" });
    },
    onError: () => {
      toast({ title: "恢复失败，后端未启动", variant: "destructive" });
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<CreateBookForm>({
    resolver: zodResolver(createBookSchema),
    defaultValues: { title: "", preset_style: "default" },
  });

  const onSubmit = (form: CreateBookForm) => {
    createBook.mutate(form);
    reset();
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* 标题栏 */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">我的作品</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleted(!showDeleted)}
          >
            {showDeleted ? "查看作品" : "回收站"}
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button size="sm">
                  <Plus className="size-4" />
                  新建作品
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>创建新作品</DialogTitle>
                <DialogDescription>给你的故事取个名字</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">作品名称</Label>
                  <Input
                    id="title"
                    placeholder="输入作品名"
                    {...register("title")}
                  />
                  {errors.title && (
                    <p className="text-xs text-destructive">{errors.title.message}</p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    取消
                  </Button>
                  <Button type="submit" disabled={createBook.isPending}>
                    {createBook.isPending && <Loader2 className="size-4 animate-spin" />}
                    创建
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 加载骨架 */}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!isLoading && books.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BookOpen className="size-12" />
          <p className="mt-4 text-sm">
            {showDeleted ? "回收站为空" : "还没有作品，点击「新建作品」开始"}
          </p>
        </div>
      )}

      {/* 作品卡片列表 */}
      {!isLoading && books.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {books.map((book) => (
            <Card
              key={book.book_id}
              className={cn(
                "group cursor-pointer transition-shadow hover:shadow-md",
                book.status === "deleted" && "opacity-60"
              )}
              onClick={() => {
                if (book.status !== "deleted") {
                  navigate(`/books/${book.book_id}`);
                }
              }}
            >
              <CardContent className="p-4">
                <div className="mb-2 flex items-start justify-between">
                  <h3 className="font-medium text-foreground truncate">{book.title}</h3>
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {STATUS_LABELS[book.status] ?? book.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {book.word_count.toLocaleString()} 字 ·{" "}
                  {new Date(book.last_updated).toLocaleDateString("zh-CN")}
                </p>
                <div className="mt-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {book.status === "deleted" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        restoreBook.mutate(book.book_id);
                      }}
                    >
                      <Undo2 className="size-3" />
                      恢复
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`确定删除「${book.title}」？7 天内可恢复。`)) {
                          deleteBook.mutate(book.book_id);
                        }
                      }}
                    >
                      <Trash2 className="size-3" />
                      删除
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
