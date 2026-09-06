import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, authFetch, fetchQuotaRemaining } from "@/services/api";
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
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useForm } from "react-hook-form";
import { WRITING_STYLES } from "@/lib/writing-styles";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, BookOpen, Loader2, Trash2, Undo2, Sparkles, Check, Send, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ModelSelector, customKeyValue } from "@/components/settings/ModelSelector";

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

// 随机灵感三维正交题材体系(平台标准:晋江多维必选/番茄主题·角色·情节/学术 genre 与 story type 正交):
// 风格(快感机制,决定模板) × 背景(世界) × 套路(模式),题材由组合自然涌现
const INSPIRE_STYLES: Record<string, string> = {
  爽: "二选一：①被欺压的弱势者+撕破伪装强势反击+全员打脸（资本来源须成立：隐藏身份/杠杆/继承，攒工资买不下集团）；②开局即强，爽点=碾压的痛快与围观惊叹",
  虐: "深情付出+被误解伤害+彻底死心抽身+对方极致追悔（追悔须付具体代价）",
  甜: "一个温暖或心动的瞬间+一件藏在日常物品里的未说出口的心意（载体：伞/围巾/课桌刻痕/铅笔批注/旧照片背面）",
  悬疑: "一个固有假象+一个必须解开的谜，解谜过程颠覆所有人设",
  脑洞: "一个脑洞设定+一个规则冲突",
  反套路: "一个读者默认的套路前提+一个颠覆该前提的反转——颠覆打在套路的默认前提上，结尾翻盘不算；题材从全题材池任选（校园/职场/家庭/仙侠/科幻等），不必限于替身/白月光/穿书",
};

const INSPIRE_BACKDROPS = ["现代", "古代", "仙侠", "科幻", "校园"];
const INSPIRE_MECHANISMS = ["无", "无", "无", "重生", "穿越", "穿书", "系统", "马甲"];

export function BookListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createType, setCreateType] = useState<'novel' | 'short'>('novel');
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchConfirm, setBatchConfirm] = useState<"delete" | "restore" | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickRestored, setQuickRestored] = useState(false);
  const [quickType, setQuickType] = useState<'novel' | 'short'>('novel');
  const [quickPremise, setQuickPremise] = useState("");
  // 快捷创作模型默认"智能"（空值）：梗概自动用 Pro 等场景优化，用户手动选择则完全尊重
  const [quickModel, setQuickModel] = useState("");
  const [quickKeyId, setQuickKeyId] = useState<string | undefined>(undefined);
  const [quickGenerating, setQuickGenerating] = useState(false);
  const [inspireLoading, setInspireLoading] = useState(false);
  const [quickSteps, setQuickSteps] = useState<Array<{ step: string; label: string; status: string; preview?: string }>>([]);
  // 短篇生成完成后的书名候选
  const [quickTitles, setQuickTitles] = useState<Array<{ style: string; title: string }>>([]);
  const [quickCreatedId, setQuickCreatedId] = useState("");
  const [quickAppliedTitle, setQuickAppliedTitle] = useState("");
  // 梗概确认流程：3 个方向候选，用户选 1 个后写正文
  const [quickOutlines, setQuickOutlines] = useState<string[]>([]);
  // 各方向的基调标签(与 quickOutlines 同序,后端从骨架行解析)
  const [quickVibes, setQuickVibes] = useState<string[]>([]);
  const [selectedOutlineIdx, setSelectedOutlineIdx] = useState<number | null>(null);
  const [quickOutlineBookId, setQuickOutlineBookId] = useState("");
  // 引导模式
  const [quickGuiding, setQuickGuiding] = useState(false);
  const [quickGuideMsgs, setQuickGuideMsgs] = useState<Array<{ role: string; content: string }>>([]);
  const [quickGuideInput, setQuickGuideInput] = useState("");
  const [quickGuideLoading, setQuickGuideLoading] = useState(false);
  // AI 就绪判定：回复末尾出现 [GUIDE_READY] 时高亮"开始生成"（用户仍可随时手动点击）
  const [guideReady, setGuideReady] = useState(false);
  // 自写梗概模式：手写梗概 → 骨架化+体检 → 确认(可编辑) → 写正文
  const [quickSynopsisMode, setQuickSynopsisMode] = useState(false);
  const [synopsisEdit, setSynopsisEdit] = useState("");
  const [synopsisSkeleton, setSynopsisSkeleton] = useState("");
  // 上次体检对应的梗概文本，用于比对用户是否编辑过
  const [synopsisPreview, setSynopsisPreview] = useState("");
  const [synopsisRisks, setSynopsisRisks] = useState<string[]>([]);
  const [synopsisCheckEnabled, setSynopsisCheckEnabled] = useState(true);
  const [synopsisConfirmed, setSynopsisConfirmed] = useState(false);
  const [synopsisWorking, setSynopsisWorking] = useState(false);
  // 3 选 1 梗概可编辑：选中方向的编辑文本/体检风险/最近体检的文本与骨架/体检中
  const [outlineEdit, setOutlineEdit] = useState("");
  const [outlineRisks, setOutlineRisks] = useState<string[]>([]);
  const [outlineCheckedText, setOutlineCheckedText] = useState("");
  const [outlineCheckedSkeleton, setOutlineCheckedSkeleton] = useState("");
  const [outlineChecking, setOutlineChecking] = useState(false);
  const guideAbortRef = useRef<AbortController | null>(null);

  // 生成中 / 引导聊天中防止误刷新
  useEffect(() => {
    if (quickGenerating || quickGuiding) {
      const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }
  }, [quickGenerating, quickGuiding]);

  // 引导对话 session 管理
  const guideSessionRef = useRef<string | null>(null);
  // 已使用（生成过作品）的引导会话 id：不自动恢复，仅提供"继续上次引导"入口
  const [usedGuideSessionId, setUsedGuideSessionId] = useState<string | null>(null);

  // 恢复引导会话 / 弹窗状态（含中断生成自动恢复）
  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem("token");
        if (!token) { setQuickRestored(true); return; }
        const res = await authFetch(`/api/ai/chat-sessions/guide?section=guide`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (res.ok && json?.data?.active?.messages?.length > 0) {
          guideSessionRef.current = json.data.active.id;
          // 已使用的引导（生成过作品）：不自动恢复，只登记入口，供"继续上次引导"
          if (localStorage.getItem(`muse_guide_used_${json.data.active.id}`)) {
            setUsedGuideSessionId(json.data.active.id);
            guideSessionRef.current = null;
            setQuickRestored(true);
            return;
          }
          // 恢复用户最初输入的脑洞
          const savedPremise = localStorage.getItem("muse_guide_premise");
          if (savedPremise) setQuickPremise(savedPremise);
          const allMsgs: Array<{ role: string; content: string }> = json.data.active.messages;
          const lastMsg = allMsgs[allMsgs.length - 1];
          // 检测中断的生成：最后一条是 AI 的 sentinel "（生成中...）"
          if (lastMsg?.role === "assistant" && lastMsg.content === "（生成中...）") {
            const resumeMsgs = allMsgs.slice(0, -1); // 去掉 sentinel
            setQuickGuideMsgs(resumeMsgs);
            setQuickGuiding(true);
            setQuickOpen(true);
            setQuickRestored(true);
            // 等组件渲染完成后自动继续生成
            setTimeout(() => resumeGuideGeneration(resumeMsgs), 300);
            return;
          }
          setQuickGuideMsgs(allMsgs);
          setQuickGuiding(true);
          setQuickOpen(true);
        }
      } catch {
        /* 恢复失败静默：用户可手动新建引导 */
      }
      setQuickRestored(true);
    })();
  }, []);

  // restore 完成后，如果没有引导会话，用 localStorage 恢复弹窗开关
  useEffect(() => {
    if (quickRestored && !quickGuiding && localStorage.getItem("muse_quick_open") === "1") {
      setQuickOpen(true);
    }
  }, [quickRestored, quickGuiding]);

  const quickAbortRef = useRef<AbortController | null>(null);
  const guideChatRef = useRef<HTMLDivElement>(null);
  const guideUserScrolledUp = useRef(false);
  const guideGotContent = useRef(false);
  const stopGuideRef = useRef(false); // 手动停止标记：与"退出引导"的中止区分
  const guideStreamAcRef = useRef(""); // 流式累积内容，供定时保存用
  const guideInitSaveRef = useRef<ReturnType<typeof setInterval> | null>(null); // 初始引导消息的定时保存
  const [editingGuideIdx, setEditingGuideIdx] = useState<number | null>(null);
  const [editingGuideText, setEditingGuideText] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["books", showDeleted ? "deleted" : "active"],
    queryFn: () =>
      api.get<{ data: BookListItem[] }>(
        `/books?status=${showDeleted ? "deleted" : "active"}`
      ),
    // 后端冷启动/重启时首请求可能失败，多退避重试几次
    retry: 2,
  });

  const books = data?.data ?? [];

  const createBook = useMutation({
    mutationFn: (form: CreateBookForm) =>
      api.post<{ data: { book_id: string } }>("/books", { ...form, type: createType }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      setDialogOpen(false);
      toast({ title: "作品已创建" });
      navigate(`/books/${res.data.book_id}`);
    },
    onError: (e) => {
      // 失败保持弹窗打开：书名输入不丢失，改完可直接重试
      toast({
        title: e instanceof ApiError ? e.message : "创建失败，请稍后重试",
        variant: "destructive",
      });
    },
  });

  /** 单个作品操作的乐观更新：立即从当前列表移除该项，返回失败回滚函数 */
  const optimisticRemove = (bookId: string) => {
    const listKey = ["books", showDeleted ? "deleted" : "active"];
    const prev = queryClient.getQueryData(listKey);
    queryClient.setQueryData(listKey, (old: any) => {
      const list = old?.data;
      if (!Array.isArray(list)) return old;
      return { ...old, data: list.filter((b: any) => b.book_id !== bookId) };
    });
    return () => queryClient.setQueryData(listKey, prev);
  };

  const deleteBook = useMutation({
    mutationFn: (bookId: string) => api.delete(`/books/${bookId}`),
    onMutate: (bookId) => optimisticRemove(bookId),
    onSuccess: () => {
      toast({ title: "作品已移至回收站" });
    },
    onError: (e, _vars, rollback) => {
      rollback?.();
      toast({
        title: e instanceof ApiError ? e.message : "删除失败，请稍后重试",
        variant: "destructive",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["books"] }),
  });

  const restoreBook = useMutation({
    mutationFn: (bookId: string) => api.post(`/books/${bookId}/restore`),
    onMutate: (bookId) => optimisticRemove(bookId),
    onSuccess: () => {
      toast({ title: "作品已恢复" });
    },
    onError: (e, _vars, rollback) => {
      rollback?.();
      toast({
        title: e instanceof ApiError ? e.message : "恢复失败，请稍后重试",
        variant: "destructive",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["books"] }),
  });

  const permanentDeleteBook = useMutation({
    mutationFn: (bookId: string) => api.delete(`/books/${bookId}/permanent`),
    onMutate: (bookId) => optimisticRemove(bookId),
    onSuccess: () => {
      toast({ title: "作品已彻底删除" });
    },
    onError: (e, _vars, rollback) => {
      rollback?.();
      toast({
        title: e instanceof ApiError ? e.message : "删除失败，请稍后重试",
        variant: "destructive",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["books"] }),
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<CreateBookForm>({
    resolver: zodResolver(createBookSchema),
    defaultValues: { title: "", preset_style: "light-novel" },
  });

  const onSubmit = (form: CreateBookForm) => {
    createBook.mutate(form);
    reset();
  };

  // 批量操作执行（ConfirmDialog 确认后）：一次请求并发执行
  const runBatchAction = async () => {
    const ids = [...selectedIds];
    const isDelete = batchConfirm === "delete";
    // 乐观更新（删除/恢复/彻底删除通用）：立即从当前列表移除选中项，不等接口返回——
    // 此前 key 写成 ["books"] 与真实查询键 ["books", "active"|"deleted"] 不匹配，
    // 乐观更新实际从未生效，UI 一直等接口；失败时刷新回滚
    {
      const listKey = ["books", showDeleted ? "deleted" : "active"];
      const idSet = new Set(ids);
      queryClient.setQueryData(listKey, (old: any) => {
        const list = old?.data;
        if (!Array.isArray(list)) return old;
        return { ...old, data: list.filter((b: any) => !idSet.has(b.book_id)) };
      });
    }
    setSelectedIds(new Set());
    setSelectMode(false);
    setBatchConfirm(null);
    try {
      if (isDelete) {
        await api.post(
          showDeleted ? `/books/batch-permanent-delete` : `/books/batch-delete`,
          { book_ids: ids },
        );
      } else {
        await api.post(`/books/batch-restore`, { book_ids: ids });
      }
      toast({
        title: `已${isDelete ? (showDeleted ? "彻底删除" : "删除") : "恢复"} ${ids.length} 个作品`,
      });
    } catch (e: any) {
      toast({ title: e.message || "操作失败", variant: "destructive" });
    }
    // 完成后刷新列表（乐观移除的项在成功时自然消失；失败时被本次刷新恢复）
    queryClient.invalidateQueries({ queryKey: ["books"] });
  };

  // 长生成期间防止系统睡眠:电脑睡眠会断开 SSE 导致生成中止
  // (用户放电脑自动生成是常态场景,生成一轮约 5-8 分钟)
  const wakeLockRef = useRef<any>(null);
  const acquireWakeLock = async () => {
    try {
      if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      }
    } catch {
      /* 不支持或拒绝不阻断 */
    }
  };
  const releaseWakeLock = () => {
    try {
      wakeLockRef.current?.release();
    } catch {
      /* 忽略 */
    }
    wakeLockRef.current = null;
  };

  // 归档引导会话（生成失败时也调用）：叉掉弹窗不删除对话，"继续上次引导"可进入重试
  const archiveGuideSession = () => {
    if (guideSessionRef.current) {
      localStorage.setItem(
        `muse_guide_used_${guideSessionRef.current}`,
        "failed",
      );
      setUsedGuideSessionId(guideSessionRef.current);
      guideSessionRef.current = null;
    }
  };

  const doQuickCreate = async (premise: string, type: string, guideSummary?: string, guideFullLog?: string) => {
    // 预估成本提示（长篇全套约 8000 字；短篇梗概三方向约 2500 字，正文另计）
    const remaining = await fetchQuotaRemaining();
    const estimate = type === 'short' ? 2500 : 8000;
    if (remaining != null) {
      if (remaining < estimate) {
        toast({ title: `本月剩余 ${remaining.toLocaleString()} 字，本次约需 ${estimate.toLocaleString()} 字，可能超额`, variant: "destructive" });
      } else {
        toast({ title: `本次预计消耗约 ${estimate.toLocaleString()} 字（本月剩余 ${remaining.toLocaleString()} 字）` });
      }
    }
    setQuickGenerating(true);
    setQuickSteps([]);
    await acquireWakeLock();
    const controller = new AbortController();
    quickAbortRef.current = controller;
    const token = localStorage.getItem("token");
    try {
      const res = await authFetch("/api/ai/quick-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ premise, type, model: quickModel || undefined, key_id: quickKeyId, guide_summary: guideSummary, guide_full_log: guideFullLog }),
        signal: controller.signal,
      }, 30 * 60_000); // 长篇全套约 5-8 分钟：默认 5 分钟超时会在中途掐断 SSE，done 丢失→弹窗永远卡在引导态
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let bookId = "";
      let hasTitleCandidates = false;
      let hasPreview = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // flush decoder
          buffer += decoder.decode();
          const finalLines = buffer.split("\n").filter(Boolean);
          for (let i = 0; i < finalLines.length; i++) {
            if (finalLines[i].startsWith("event: ") && finalLines[i + 1]?.startsWith("data: ")) {
              try {
                const data = JSON.parse(finalLines[i + 1].slice(6));
                if (finalLines[i].slice(7).trim() === "done") bookId = data.book_id;
              } catch {}
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("event: ")) {
            const eventType = line.slice(7).trim();
            const dataLine = lines[i + 1];
            if (dataLine?.startsWith("data: ")) {
              try {
                const data = JSON.parse(dataLine.slice(6));
                if (eventType === "step") {
                  setQuickSteps((prev) => {
                    const newStep = { step: data.step, label: data.label, status: data.status, preview: data.preview };
                    const idx = prev.findIndex((s) => s.step === data.step);
                    if (idx >= 0) {
                      const next = [...prev];
                      next[idx] = newStep;
                      return next;
                    }
                    return [...prev, newStep];
                  });
                } else if (eventType === "done") {
                  bookId = data.book_id;
                  const outlineList: string[] =
                    data.previews ?? (data.preview ? [data.preview] : []);
                  if (outlineList.length > 0) {
                    // 新流程：展示梗概候选，等用户选择后写正文
                    hasPreview = true;
                    // 生成成功：引导会话归档——保留对话本体，标记"已使用"防止自动恢复
                    if (guideSessionRef.current) {
                      localStorage.setItem(
                        `muse_guide_used_${guideSessionRef.current}`,
                        data.book_id,
                      );
                      setUsedGuideSessionId(guideSessionRef.current);
                      guideSessionRef.current = null;
                    }
                    setQuickOutlines(outlineList);
                    setQuickVibes(data.vibes ?? []);
                    setSelectedOutlineIdx(0);
                    setOutlineEdit(outlineList[0] ?? "");
                    setOutlineCheckedText((outlineList[0] ?? "").trim());
                    setOutlineCheckedSkeleton("");
                    setOutlineRisks([]);
                    setQuickOutlineBookId(data.book_id);
                  } else if (data.titles?.length > 1) {
                    // 书名候选（长篇/短篇通用）：展示选择区，选完点"打开作品"
                    hasTitleCandidates = true;
                    setQuickTitles(data.titles);
                    setQuickCreatedId(data.book_id);
                    setQuickAppliedTitle(data.title || data.titles[0]?.title);
                    // 生成成功：引导会话归档——保留对话本体，标记"已使用"防止自动恢复
                    if (guideSessionRef.current) {
                      localStorage.setItem(
                        `muse_guide_used_${guideSessionRef.current}`,
                        data.book_id,
                      );
                      setUsedGuideSessionId(guideSessionRef.current);
                      guideSessionRef.current = null;
                    }
                    // 引导模式下退出引导界面，露出候选选择区
                    setQuickGuiding(false);
                  } else if (data.title) {
                    // 长篇：一步到底无候选环节——生成完直接进入作品详情（无书名挑选步骤）
                    setQuickGuiding(false);
                  }
                } else if (eventType === "error") {
                  toast({ title: data.message || "生成失败", variant: "destructive" });
                }
              } catch { /* parse error */ }
            }
          }
        }
      }
      if (bookId) {
        queryClient.invalidateQueries({ queryKey: ["books"] });
        // 梗概确认中：停留在弹窗；有书名候选：停留挑选；否则直接进入作品
        if (!hasPreview && !hasTitleCandidates) {
          resetQuickDialog();
          toast({ title: "创作完成！" });
          navigate(`/books/${bookId}`);
        }
      } else {
        // 流正常结束但缺少 done 事件：服务端在最后一步失败（落库/建书），
        // 明确报错而不是静默回到引导界面，避免"点了生成没反应"的假象
        archiveGuideSession();
        toast({ title: "生成在最后一步中断（作品未创建），引导对话已保留，可点\"继续上次引导\"重试", variant: "destructive" });
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        // 失败也归档引导对话：叉掉弹窗不删除会话，保留重试入口
        archiveGuideSession();
        // 区分网络中断(睡眠/断网)与普通失败:中断时作品可能已创建但正文为空
        const isNetworkBreak =
          err instanceof TypeError || /network|fetch|中断|aborted/i.test(String(err?.message ?? ''));
        toast({
          title: isNetworkBreak
            ? "生成连接中断（电脑是否睡眠或断网？）。已创建的作品可在列表中打开，或重新发起生成"
            : err?.message || "生成失败",
          variant: "destructive",
        });
      }
    } finally {
      releaseWakeLock();
      setQuickGenerating(false);
      setQuickSteps([]);
      quickAbortRef.current = null;
    }
  };

  // 引导聊天自动滚底（用户上滑时暂停，发消息时恢复）
  const scrollGuideToBottom = useCallback(() => {
    const el = guideChatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!guideUserScrolledUp.current) {
      scrollGuideToBottom();
    }
  }, [quickGuideMsgs, quickGuideLoading, scrollGuideToBottom]);

  const handleGuideScroll = useCallback(() => {
    const el = guideChatRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    guideUserScrolledUp.current = !atBottom;
  }, []);

  // 引导 AI 请求核心：msgs 以用户消息结尾；流式追加 AI 回复，支持手动停止
  const runGuideRequest = async (msgs: Array<{ role: string; content: string }>) => {
    setQuickGuideLoading(true);
    setGuideReady(false); // 每轮重新判定，本轮未就绪不沿用旧状态
    const token = localStorage.getItem("token");
    const controller = new AbortController();
    guideAbortRef.current = controller;
    stopGuideRef.current = false;
    // 先保存消息（await 确保 DB 已写入），再发 AI 请求
    if (guideSessionRef.current) {
      await authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: msgs }),
      }).catch(() => {});
    }
    let saveInterval: ReturnType<typeof setInterval> | undefined;
    try {
      const res = await authFetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          book_id: "",
          context_type: "write",
          model: quickModel || undefined, key_id: quickKeyId,
          message: msgs[msgs.length - 1]?.content || "",
          messages: msgs.map(m => ({ role: m.role, content: m.content })),
          guide_mode: true,
          guide_context: quickPremise || localStorage.getItem("muse_guide_premise"),
          guide_type: quickType,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("无响应");
      const decoder = new TextDecoder();
      let buf = ""; let ac = "";
      guideStreamAcRef.current = "";
      // 每 3 秒自动保存当前流式内容，避免刷新丢失 AI 回复
      saveInterval = setInterval(() => {
        if (guideSessionRef.current && guideStreamAcRef.current) {
          const partialMsgs = [...msgs, { role: "assistant", content: guideStreamAcRef.current }];
          authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ messages: partialMsgs }),
          }).catch(() => {});
        }
      }, 3000);
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buf += decoder.decode(); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        let ev = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
          if (line.startsWith("data: ")) {
            try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
            if (ev === "error") { const d = JSON.parse(line.slice(6)); throw new Error(d.message); }
          }
        }
        if (ac) {
          guideGotContent.current = true;
          guideStreamAcRef.current = ac;
          setQuickGuideMsgs((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = { role: "assistant", content: ac };
            } else {
              updated.push({ role: "assistant", content: ac });
            }
            return updated;
          });
        }
      }
      // AI 就绪判定：完整回复末尾带标记 → 高亮"开始生成"按钮
      setGuideReady(ac.includes("[GUIDE_READY]"));
    } catch (err: any) {
      if (err.name === "AbortError") return;
      toast({ title: err?.message || "发送失败", variant: "destructive" });
    } finally {
      if (saveInterval) clearInterval(saveInterval);
      guideStreamAcRef.current = "";
      setQuickGuideLoading(false);
      setQuickGuideMsgs((prev) => {
        let next = prev;
        const last = next[next.length - 1];
        if (stopGuideRef.current) {
          // 手动停止：半截回复保留并标记；无内容则移除占位（用户消息保持最后一条）
          if (last?.role === "assistant") {
            if (guideGotContent.current) {
              next = [...next.slice(0, -1), { role: "assistant", content: last.content + "\n（已停止）" }];
            } else {
              next = next.slice(0, -1);
            }
          }
        } else if (!guideGotContent.current) {
          // 失败/无响应：占位替换为提示，避免"（生成中...）"残留
          if (last?.role === "assistant" && last.content === "（生成中...）") {
            next = [...next.slice(0, -1), { role: "assistant", content: "（AI 未响应，请重试）" }];
          } else {
            next = [...next, { role: "assistant", content: "（AI 未响应，请重试）" }];
          }
        }
        stopGuideRef.current = false;
        if (guideSessionRef.current) {
          authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
            body: JSON.stringify({ messages: next }),
          }).catch(() => {});
        }
        return next;
      });
      guideAbortRef.current = null;
    }
  };

  // 引导模式：发送消息
  const sendGuideMsg = async () => {
    guideUserScrolledUp.current = false;
    guideGotContent.current = false;
    const input = quickGuideInput.trim();
    if (!input || quickGuideLoading) return;
    setQuickGuideInput("");
    const newMsgs = [...quickGuideMsgs, { role: "user", content: input }];
    setQuickGuideMsgs(newMsgs);
    await runGuideRequest(newMsgs);
  };

  // 继续上次已使用的引导（生成后归档的会话）
  const resumeUsedGuide = async () => {
    const token = localStorage.getItem("token");
    try {
      const res = await authFetch(`/api/ai/chat-sessions/guide?section=guide`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      const active = json?.data?.active;
      if (!active?.messages?.length) {
        toast({ title: "引导会话已不存在，请重新开始", variant: "destructive" });
        setUsedGuideSessionId(null);
        return;
      }
      guideSessionRef.current = active.id;
      // 不删除归档标记：关闭引导后会话仍保留，"继续上次引导"可反复进入
      setQuickGuideMsgs(active.messages);
      // 恢复脑洞输入：开始生成时作为 premise 传给后端（参与书名/摘要生成，空值会落成"短篇故事"兜底）
      const savedPremise = localStorage.getItem("muse_guide_premise");
      if (savedPremise) setQuickPremise(savedPremise);
      // 恢复时按最后一条 AI 回复重新判定就绪状态
      const lastAi = [...active.messages].reverse().find((m) => m.role === "assistant");
      setGuideReady(lastAi?.content?.includes("[GUIDE_READY]") ?? false);
      setQuickGuiding(true);
      guideUserScrolledUp.current = false;
    } catch {
      toast({ title: "恢复引导失败", variant: "destructive" });
    }
  };

  // 编辑历史消息：截断该消息之后的历史（AI 回复一并作废），用修改后的内容重发
  const saveEditGuideMsg = async () => {
    const i = editingGuideIdx;
    const text = editingGuideText.trim();
    if (i == null || !text || quickGuideLoading) return;
    const newMsgs = [...quickGuideMsgs.slice(0, i), { role: "user", content: text }];
    setQuickGuideMsgs(newMsgs);
    setEditingGuideIdx(null);
    setEditingGuideText("");
    guideUserScrolledUp.current = false;
    guideGotContent.current = false;
    await runGuideRequest(newMsgs);
  };

  // 刷新后恢复中断的生成：去掉 sentinel，重新发起 AI 请求
  const resumeGuideGeneration = async (msgs: Array<{ role: string; content: string }>) => {
    guideUserScrolledUp.current = false;
    guideGotContent.current = false;
    // 占位标记"生成中"（刷新恢复检测依赖该 sentinel），随后复用统一请求核心
    const resumeMsgs = [...msgs, { role: "assistant", content: "（生成中...）" }];
    if (guideSessionRef.current) {
      authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
        body: JSON.stringify({ messages: resumeMsgs }),
      }).catch(() => {});
    }
    setQuickGuideMsgs(resumeMsgs);
    await runGuideRequest(msgs);
  };

  // 3 选 1 梗概：选中方向时同步可编辑文本与体检状态
  const selectOutline = (i: number) => {
    setSelectedOutlineIdx(i);
    const text = quickOutlines[i] ?? "";
    setOutlineEdit(text);
    setOutlineCheckedText(text.trim());
    setOutlineCheckedSkeleton("");
    setOutlineRisks([]);
  };

  // 3 选 1 梗概：编辑失焦时自动体检（骨架化+风险提示，不阻断）
  const checkOutlineEdit = async () => {
    const edited = outlineEdit.trim();
    if (!edited || edited === outlineCheckedText || outlineChecking) return;
    setOutlineChecking(true);
    try {
      const res = await authFetch("/api/ai/skeletonize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({
          synopsis: edited,
          model: quickModel || undefined,
          key_id: quickKeyId,
          with_check: true,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d.code === 200) {
          setOutlineRisks(d.data?.risks ?? []);
          setOutlineCheckedSkeleton(d.data?.skeleton ?? "");
          setOutlineCheckedText(edited);
        }
      }
    } catch {
      /* 体检失败不阻断 */
    } finally {
      setOutlineChecking(false);
    }
  };

  // 自写梗概：骨架化 + 逻辑体检（风险只提示，改不改由用户）
  const doSkeletonize = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || synopsisWorking) return;
    setSynopsisWorking(true);
    const token = localStorage.getItem("token");
    try {
      const res = await authFetch("/api/ai/skeletonize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          synopsis: trimmed,
          model: quickModel || undefined,
          key_id: quickKeyId,
          with_check: synopsisCheckEnabled,
        }),
      });
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const d = await res.json();
      if (d.code !== 200) throw new Error(d.message || "骨架化失败");
      setSynopsisSkeleton(d.data?.skeleton ?? "");
      setSynopsisPreview(d.data?.preview ?? trimmed);
      setSynopsisEdit(d.data?.preview ?? trimmed);
      setSynopsisRisks(d.data?.risks ?? []);
      setSynopsisConfirmed(true);
    } catch (err: any) {
      toast({ title: err?.message || "骨架化失败，请重试", variant: "destructive" });
    } finally {
      setSynopsisWorking(false);
    }
  };

  // 自写梗概：开始写正文（编辑过则先重新体检，保证骨架与梗概一致）
  const startSynopsisStory = async () => {
    const edited = synopsisEdit.trim();
    if (!edited) return;
    let skeleton = synopsisSkeleton;
    let preview = edited;
    if (edited !== synopsisPreview) {
      setSynopsisWorking(true);
      try {
        const res = await authFetch("/api/ai/skeletonize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
          body: JSON.stringify({
            synopsis: edited,
            model: quickModel || undefined,
            key_id: quickKeyId,
            with_check: synopsisCheckEnabled,
          }),
        });
        if (res.ok) {
          const d = await res.json();
          if (d.code === 200) {
            skeleton = d.data?.skeleton ?? "";
            preview = d.data?.preview ?? edited;
            setSynopsisRisks(d.data?.risks ?? []);
          }
        }
      } catch {
        /* 体检失败不阻断：按编辑文本直接生成 */
      } finally {
        setSynopsisWorking(false);
      }
    }
    try {
      const res = await authFetch("/api/ai/quick-create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({
          type: "short",
          mode: "synopsis",
          synopsis: edited,
          skeleton,
          preview,
          model: quickModel || undefined,
          key_id: quickKeyId,
        }),
      });
      const d = await res.json();
      if (d.code !== 200 || !d.data?.book_id) {
        throw new Error(d.message || "创建失败");
      }
      setQuickOutlineBookId(d.data.book_id);
    } catch (err: any) {
      toast({ title: err?.message || "创建失败", variant: "destructive" });
      return;
    }
    // 复用 doGenerateStory 写正文（quickOutlines 为空，跳过"写回选中梗概"步骤）
    await doGenerateStory(edited);
  };

  // 梗概确认后：调 generate-story 写正文（SSE 进度 + 书名候选）
  const doGenerateStory = async (premiseOverride?: string, resume = false) => {
    if (!quickOutlineBookId) return;
    // 预估成本提示（短篇三轮正文+事实提取+精修约 12000 字）
    const remaining = await fetchQuotaRemaining();
    if (remaining != null) {
      if (remaining < 12000) {
        toast({ title: `本月剩余 ${remaining.toLocaleString()} 字，写完整故事约需 12000 字，可能超额`, variant: "destructive" });
      } else {
        toast({ title: `本次预计消耗约 12000 字（本月剩余 ${remaining.toLocaleString()} 字）` });
      }
    }
    setQuickGenerating(true);
    setQuickSteps([]);
    await acquireWakeLock();
    let resumeAfterFailure = false;
    // 把选中的梗概写回作品设置，generate-story 读取 outline_preview 作为写作走向锚点。
    // 编辑过则重新骨架化保证骨架与梗概一致（blur 已体检过则复用缓存骨架，零调用）
    const selected =
      selectedOutlineIdx != null ? quickOutlines[selectedOutlineIdx] : quickOutlines[0];
    const edited = outlineEdit.trim();
    if (selected && edited && edited !== selected.trim()) {
      let skeleton = "";
      if (edited === outlineCheckedText) {
        skeleton = outlineCheckedSkeleton;
      } else {
        try {
          const res = await authFetch("/api/ai/skeletonize", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${localStorage.getItem("token")}`,
            },
            body: JSON.stringify({
              synopsis: edited,
              model: quickModel || undefined,
              key_id: quickKeyId,
              with_check: true,
            }),
          });
          if (res.ok) {
            const d = await res.json();
            if (d.code === 200) {
              skeleton = d.data?.skeleton ?? "";
              setOutlineRisks(d.data?.risks ?? []);
            }
          }
        } catch {
          /* 骨架化失败不阻断：骨架置空，节拍表降级吃编辑文本 */
        }
      }
      await api
        .put(`/books/${quickOutlineBookId}/settings`, {
          extra: {
            outline_preview: edited,
            outline_skeletons: skeleton ? [skeleton] : [],
          } as any,
        })
        .catch(() => {});
    } else if (selected) {
      await api
        .put(`/books/${quickOutlineBookId}/settings`, {
          extra: { outline_preview: selected } as any,
        })
        .catch(() => {});
    }
    setQuickOutlines([]);
    setSelectedOutlineIdx(null);
    const controller = new AbortController();
    quickAbortRef.current = controller;
    const token = localStorage.getItem("token");
    let hasCandidates = false;
    const handleEvent = (eventType: string, data: any) => {
      if (eventType === "step") {
        setQuickSteps((prev) => {
          const newStep = { step: data.step, label: data.label, status: data.status, preview: data.preview };
          const idx = prev.findIndex((s) => s.step === data.step);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = newStep;
            return next;
          }
          return [...prev, newStep];
        });
      } else if (eventType === "done") {
        if (data.titles?.length > 1) {
          hasCandidates = true;
          setQuickTitles(data.titles);
          setQuickCreatedId(data.book_id);
          setQuickAppliedTitle(data.title || data.titles[0]);
        }
      } else if (eventType === "error") {
        toast({ title: data.message || "生成失败", variant: "destructive" });
      }
    };
    const parseBuffer = (buf: string) => {
      const lines = buf.split("\n").filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("event: ") && lines[i + 1]?.startsWith("data: ")) {
          try {
            const data = JSON.parse(lines[i + 1].slice(6));
            handleEvent(lines[i].slice(7).trim(), data);
          } catch { /* parse error */ }
        }
      }
    };
    try {
      const res = await authFetch("/api/ai/generate-story", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: quickOutlineBookId, premise: premiseOverride ?? quickPremise, model: quickModel, resume_story: resume }),
        signal: controller.signal,
      }, 60 * 60_000); // 三轮正文共需 10-30 分钟,默认 5 分钟超时会在 part2/part3 中途掐断连接
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          parseBuffer(buffer);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        parseBuffer(lines.join("\n"));
      }
      queryClient.invalidateQueries({ queryKey: ["books"] });
      if (!hasCandidates) {
        resetQuickDialog();
        toast({ title: "创作完成！" });
        navigate(`/books/${quickOutlineBookId}`);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        const isNetworkBreak =
          err instanceof TypeError || /network|fetch|中断|aborted/i.test(String(err?.message ?? ''));
        if (isNetworkBreak) {
          // 断点续传:后端已保存每轮完成的内容,从断点继续,不重复烧 token
          if (confirm("生成连接中断，已生成的部分已保存。是否继续生成剩余部分？")) {
            resumeAfterFailure = true;
          } else {
            toast({ title: "已取消。可到列表中打开作品，重新发起生成继续", variant: "destructive" });
          }
        } else {
          toast({ title: err?.message || "生成失败", variant: "destructive" });
        }
      }
    } finally {
      releaseWakeLock();
      setQuickGenerating(false);
      setQuickSteps([]);
      quickAbortRef.current = null;
    }
    // finally 清理完状态后再续跑,避免生成中状态被覆盖
    if (resumeAfterFailure) return doGenerateStory(premiseOverride, true);
  };

  // 应用书名候选
  const applyQuickTitle = async (title: string) => {
    if (!quickCreatedId) return;
    try {
      const token = localStorage.getItem("token");
      const res = await authFetch(`/api/books/${quickCreatedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setQuickAppliedTitle(title);
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "书名已更新" });
    } catch (e: any) {
      toast({ title: e.message || "更新失败", variant: "destructive" });
    }
  };

  const resetQuickDialog = () => {
    releaseWakeLock();
    setQuickOpen(false);
    setQuickPremise("");
    setQuickSteps([]);
    setQuickTitles([]);
    setQuickCreatedId("");
    setQuickAppliedTitle("");
    setQuickOutlines([]);
    setSelectedOutlineIdx(null);
    setOutlineEdit("");
    setOutlineCheckedText("");
    setOutlineCheckedSkeleton("");
    setOutlineRisks([]);
    setOutlineChecking(false);
    setQuickOutlineBookId("");
    setQuickGuiding(false);
    setQuickGuideMsgs([]);
    setQuickGuideInput("");
    setQuickGuideLoading(false);
    setQuickSynopsisMode(false);
    setSynopsisEdit("");
    setSynopsisSkeleton("");
    setSynopsisPreview("");
    setSynopsisRisks([]);
    setSynopsisCheckEnabled(true);
    setSynopsisConfirmed(false);
    setSynopsisWorking(false);
    localStorage.removeItem("muse_quick_open");
    localStorage.removeItem("muse_guide_premise");
    // 关闭永不删除会话：未归档的会话打"暂存"标记（不自动恢复、可反复进入），
    // 过期垃圾会话由服务端 maintenance 按时间清理
    if (guideSessionRef.current) {
      if (!localStorage.getItem(`muse_guide_used_${guideSessionRef.current}`)) {
        localStorage.setItem(
          `muse_guide_used_${guideSessionRef.current}`,
          "paused",
        );
        setUsedGuideSessionId(guideSessionRef.current);
      }
      guideSessionRef.current = null;
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      {/* 标题栏 */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">我的作品</h1>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}>
                取消
              </Button>
              <Button variant="ghost" size="sm" onClick={() => {
                if (books.length === selectedIds.size) setSelectedIds(new Set());
                else setSelectedIds(new Set(books.map(b => b.book_id)));
              }}>
                {books.length === selectedIds.size ? "取消全选" : "全选"}
              </Button>
              {showDeleted && (
                <Button size="sm" disabled={selectedIds.size === 0}
                  onClick={() => setBatchConfirm("restore")}
                >
                  恢复选中 ({selectedIds.size})
                </Button>
              )}
              <Button variant="destructive" size="sm" disabled={selectedIds.size === 0}
                onClick={() => setBatchConfirm("delete")}
              >
                删除选中 ({selectedIds.size})
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setSelectMode(true)}>
              批量选择
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setShowDeleted(!showDeleted); setSelectMode(false); setSelectedIds(new Set()); }}
          >
            {showDeleted ? "查看作品" : "回收站"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => {
            guideSessionRef.current = null;
            localStorage.setItem("muse_quick_open", "1");
            setQuickOpen(true);
          }}>
            <Sparkles className="size-4" />
            快捷创作
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
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant={createType === 'novel' ? 'default' : 'outline'} onClick={() => setCreateType('novel')}>长篇</Button>
                  <Button type="button" size="sm" variant={createType === 'short' ? 'default' : 'outline'} onClick={() => setCreateType('short')}>短篇</Button>
                </div>
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
                <div className="space-y-2">
                  <Label htmlFor="preset_style">写作风格</Label>
                  <select
                    id="preset_style"
                    {...register("preset_style")}
                    className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                  >
                    {WRITING_STYLES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
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

          {/* 快捷创作对话框 */}
          <Dialog open={quickOpen} onOpenChange={(open) => {
            if (open) return;
            // 生成中：确认后才取消(误点 X/ESC 会作废已生成部分)
            if (quickGenerating) {
              if (!confirm("正在生成中，确定取消？已生成的部分会作废。")) return;
              quickAbortRef.current?.abort();
              resetQuickDialog();
              return;
            }
            // 引导聊天中：确认后取消（对话会保留，可随时从"继续上次引导"进入）
            if (quickGuiding) {
              if (!confirm("确定退出引导？进行中的生成会停止。对话会保留，可随时从\"继续上次引导\"进入。")) return;
              guideAbortRef.current?.abort();
              resetQuickDialog();
              return;
            }
            // 表单阶段：直接关闭
            resetQuickDialog();
          }}>
            <DialogContent className={quickGuiding ? "max-w-lg h-[520px] max-sm:h-[80vh] flex flex-col" : "max-w-lg sm:max-w-lg max-h-[80vh] flex flex-col"}>
              <DialogHeader className="shrink-0">
                <DialogTitle>{quickGuiding ? "创作引导" : "快捷创作"}</DialogTitle>
                <DialogDescription>
                  {quickGuiding
                    ? (() => {
                        // 轮数 = 用户消息数 - 1（开场白不算一轮），无上限
                        const rounds = Math.max(
                          1,
                          quickGuideMsgs.filter((m) => m.role === "user").length - 1,
                        );
                        return `第 ${rounds} 轮 · AI 帮你梳理想法`;
                      })()
                    : (quickType === 'short' ? 'AI 一步写完完整短篇故事' : 'AI 自动生成世界观、大纲和角色')}
                </DialogDescription>
              </DialogHeader>

              {/* ===== 阶段 1：表单（内容区滚动，底部按钮固定） ===== */}
              {!quickGuiding && (
                <div className="flex-1 overflow-y-auto min-h-0 space-y-4">
                  {/* 类型切换 + 模型选择 */}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={quickType === 'novel' ? 'default' : 'outline'} onClick={() => { setQuickType('novel'); setQuickSynopsisMode(false); setSynopsisConfirmed(false); }} disabled={quickGenerating}>长篇</Button>
                    <Button size="sm" variant={quickType === 'short' ? 'default' : 'outline'} onClick={() => setQuickType('short')} disabled={quickGenerating}>短篇</Button>
                    <div className="flex-1" />
                    <ModelSelector
                      usage="chat"
                      allowAuto
                      value={quickKeyId ? customKeyValue(quickKeyId) : quickModel}
                      onChange={(m, keyId) => { setQuickModel(m); setQuickKeyId(keyId); }}
                      className="text-xs rounded border border-border bg-background px-2 py-1"
                    />
                  </div>

                  {/* 智能默认的模型策略提示：正文严格按用户所选,想更高文笔质量可手动选 Pro */}
                  {!quickModel && !quickKeyId && (
                    <p className="text-[10px] text-muted-foreground">
                      智能默认：梗概/节拍表用 Pro 策划，正文用 deepseek-v4-flash
                      写作。想要正文更高文笔质量，可在右上角手动选择 Pro（正文严格按你的选择执行）。
                    </p>
                  )}

                  {/* 脑洞/梗概输入：短篇在标签行右侧提供输入方式切换
                      （弱化分段控件，从属于输入框，不与长篇/短篇同级） */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="premise">
                        {quickSynopsisMode && !quickCreatedId
                          ? synopsisConfirmed ? '梗概（已体检，可编辑）' : '故事梗概'
                          : quickType === 'short' ? '脑洞 / 想法' : '题材 / 想法'}
                      </Label>
                      {quickType === 'short' && !synopsisConfirmed && !quickCreatedId && (
                        <div className="flex items-center rounded bg-muted p-0.5">
                          <button
                            type="button"
                            onClick={() => setQuickSynopsisMode(false)}
                            disabled={quickGenerating}
                            className={cn(
                              "px-2 py-0.5 rounded-sm text-xs transition-colors",
                              !quickSynopsisMode
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            写脑洞
                          </button>
                          <button
                            type="button"
                            onClick={() => setQuickSynopsisMode(true)}
                            disabled={quickGenerating}
                            className={cn(
                              "px-2 py-0.5 rounded-sm text-xs transition-colors",
                              quickSynopsisMode
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            自写梗概
                          </button>
                        </div>
                      )}
                    </div>
                    {quickSynopsisMode && synopsisConfirmed && synopsisCheckEnabled && !quickCreatedId && (
                      <div className="space-y-1 rounded border border-border bg-background px-3 py-2">
                        <p className="text-xs font-medium text-foreground">逻辑体检</p>
                        {synopsisRisks.length === 0 ? (
                          <p className="text-xs text-green-600">未发现潜在矛盾</p>
                        ) : (
                          <ul className="space-y-0.5">
                            {synopsisRisks.map((r, i) => (
                              <li key={i} className="text-xs text-amber-600">· {r}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {/* 生成完成后隐藏输入区（synopsis 模式），只剩书名候选与打开作品 */}
                    {!(quickSynopsisMode && quickCreatedId) && (
                      <>
                        <textarea
                          id="premise"
                          placeholder={quickSynopsisMode
                            ? '直接写完整的故事梗概：故事起因、主角的行动与反转、谜底、结局…'
                            : quickType === 'short' ? '简单描述你的想法，可补充：现代/古代、主角身份、想要的结局...' : '例如：我想写一本末世公路求生小说...'}
                          value={quickSynopsisMode ? synopsisEdit : quickPremise}
                          onChange={(e) => quickSynopsisMode ? setSynopsisEdit(e.target.value) : setQuickPremise(e.target.value)}
                          rows={quickSynopsisMode ? 8 : quickType === 'short' ? 3 : 4}
                          disabled={quickGenerating}
                          className="w-full rounded border border-border bg-background px-3 py-2 text-sm resize-none"
                        />
                        {quickSynopsisMode && !synopsisConfirmed && (
                          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                            <Checkbox
                              checked={synopsisCheckEnabled}
                              onChange={(e) => setSynopsisCheckEnabled(e.target.checked)}
                              disabled={quickGenerating || synopsisWorking}
                            />
                            生成时指出潜在矛盾（推荐）
                          </label>
                        )}
                      </>
                    )}
                  </div>

                  {/* 进度 */}
                  {quickGenerating && (
                    <div className="space-y-2">
                      {quickSteps.map((s) => (
                        <div key={s.step} className="flex items-center gap-2 text-xs">
                          {s.status === "done" ? (
                            <Check className="size-3 text-green-500" />
                          ) : (
                            <Loader2 className="size-3 animate-spin text-primary" />
                          )}
                          <div>
                            <span className={s.status === "done" ? "text-muted-foreground" : "text-foreground"}>
                              {s.label}
                            </span>
                            {s.preview && (
                              <p className="text-[10px] text-muted-foreground mt-0.5 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                                {s.preview}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                      {quickSteps.length === 0 && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" />
                          正在准备...
                        </div>
                      )}
                    </div>
                  )}

                  {/* 梗概确认：3 个方向候选，选 1 个后写正文 */}
                  {quickOutlines.length > 0 && !quickGenerating && (
                    <div className="space-y-2">
                      <Label className="text-xs">故事梗概 3 选 1（确认走向后开始写正文）</Label>
                      <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
                        {quickOutlines.map((o, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => selectOutline(i)}
                            className={cn(
                              "w-full text-left rounded border px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap transition-colors",
                              selectedOutlineIdx === i
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-background hover:bg-muted/50",
                            )}
                          >
                            <span className="text-muted-foreground mr-1">方向{i + 1}</span>
                            {quickVibes[i] && (
                              <span className="inline-block mr-1 px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                                {quickVibes[i]}
                              </span>
                            )}
                            {o}
                          </button>
                        ))}
                      </div>
                      {/* 选中方向后可编辑：改完直接开始写正文（失焦自动体检） */}
                      {selectedOutlineIdx != null && (
                        <div className="space-y-2">
                          <Label className="text-xs">梗概（可编辑，改完直接开始写正文）</Label>
                          <textarea
                            value={outlineEdit}
                            onChange={(e) => setOutlineEdit(e.target.value)}
                            onBlur={checkOutlineEdit}
                            rows={6}
                            disabled={quickGenerating}
                            className="w-full rounded border border-border bg-background px-3 py-2 text-xs leading-relaxed resize-none"
                          />
                          {outlineChecking && (
                            <p className="text-xs text-muted-foreground">检查中...</p>
                          )}
                          {outlineRisks.length > 0 && (
                            <div className="space-y-1 rounded border border-border bg-background px-3 py-2">
                              <p className="text-xs font-medium text-foreground">逻辑体检</p>
                              <ul className="space-y-0.5">
                                {outlineRisks.map((r, i) => (
                                  <li key={i} className="text-xs text-amber-600">· {r}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 生成完成：书名候选（多种风格，点击使用） */}
                  {quickCreatedId && quickTitles.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs">书名候选（多种风格，点击使用）</Label>
                      <div className="space-y-1.5">
                        {quickTitles.map((t, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => applyQuickTitle(t.title)}
                            className={cn(
                              "w-full text-left rounded border px-3 py-2 text-sm transition-colors",
                              quickAppliedTitle === t.title
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-background hover:bg-muted/50",
                            )}
                          >
                            {t.style && (
                              <span className="mr-2 text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">
                                {t.style}
                              </span>
                            )}
                            {t.title}
                          </button>
                        ))}
                      </div>
                      <Button
                        className="w-full"
                        onClick={() => {
                          navigate(`/books/${quickCreatedId}`);
                          resetQuickDialog();
                        }}
                      >
                        打开作品
                      </Button>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        发布提示：番茄/起点/晋江等平台限制直接发布 AI 生成的正文（起点严禁 AI 正文、晋江仅允许校对/起名/粗纲、番茄禁止直接复制 AI 章节）。建议将生成内容作为底稿人工修改后再发布。
                      </p>
                    </div>
                  )}

                  {/* 操作区：生成完成（书名候选）与梗概选择阶段隐藏，只留对应阶段按钮 */}
                  {!quickCreatedId && quickOutlines.length === 0 && (
                  <div className="flex justify-end gap-2">
                    {quickGenerating ? (
                      <Button
                        size="icon"
                        variant="destructive"
                        className="rounded-full"
                        onClick={() => {
                          quickAbortRef.current?.abort();
                          resetQuickDialog();
                        }}
                        title="停止生成（已生成的部分保留）"
                      >
                        <Square className="size-4" />
                      </Button>
                    ) : (
                      <Button variant="outline" onClick={resetQuickDialog}>
                        取消
                      </Button>
                    )}
                    {quickType === 'short' && !quickSynopsisMode && (
                      <Button variant="outline" disabled={quickGenerating || inspireLoading}
                        onClick={async () => {
                          setInspireLoading(true);
                          const token = localStorage.getItem("token");
                          // 三维正交抽样:风格(等概率,同风格不连续)×背景(等概率)×套路(加权,无占3/8)
                          const styleNames = Object.keys(INSPIRE_STYLES);
                          let style = styleNames[Math.floor(Math.random() * styleNames.length)];
                          const lastStyle = localStorage.getItem("muse_last_inspire_style");
                          if (lastStyle && styleNames.length > 1 && style === lastStyle) {
                            const others = styleNames.filter((s) => s !== lastStyle);
                            style = others[Math.floor(Math.random() * others.length)];
                          }
                          localStorage.setItem("muse_last_inspire_style", style);
                          const backdrop =
                            INSPIRE_BACKDROPS[
                              Math.floor(Math.random() * INSPIRE_BACKDROPS.length)
                            ];
                          const mechanism =
                            INSPIRE_MECHANISMS[
                              Math.floor(Math.random() * INSPIRE_MECHANISMS.length)
                            ];
                          const mechPart = mechanism === "无" ? "" : `、${mechanism}设定`;
                          // 近期已用元素排除:防茶水妹/殡仪馆/眼角膜这类高频意象重复
                          let recentIdeas: string[] = [];
                          try {
                            recentIdeas = JSON.parse(
                              localStorage.getItem("muse_recent_ideas") ?? "[]",
                            );
                          } catch {
                            recentIdeas = [];
                          }
                          const recentBlock = recentIdeas.length
                            ? `。近期已用过的元素：${recentIdeas.join("；")}，不得重复使用这些职业/场景/道具，换新鲜的`
                            : "";
                          const ideaMsg = `随机给我一个「${style}感」的故事脑洞（${backdrop}背景${mechPart}）：${INSPIRE_STYLES[style]}，20-40 字。只输出这一句脑洞${recentBlock}`;
                          try {
                            const res = await authFetch("/api/ai/chat", {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                              body: JSON.stringify({
                                book_id: "",
                                context_type: "inspire",
                                model: quickModel || undefined, key_id: quickKeyId,
                                message: ideaMsg,
                                messages: [{ role: "user", content: ideaMsg }],
                              }),
                              signal: AbortSignal.timeout(30000),
                            });
                            if (res.ok) {
                              const reader = res.body?.getReader();
                              if (reader) {
                                const decoder = new TextDecoder();
                                let buf = "", ac = "";
                                while (true) {
                                  const { done, value } = await reader.read();
                                  if (done) break;
                                  buf += decoder.decode(value, { stream: true });
                                  const lines = buf.split("\n"); buf = lines.pop() ?? "";
                                  let ev = "";
                                  for (const line of lines) {
                                    if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
                                    if (line.startsWith("data: ")) {
                                      try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
                                    }
                                  }
                                }
                                if (ac.trim()) {
                                  setQuickPremise(ac.trim());
                                  // 记入近期元素(保留最近 5 条),供下次排除重复
                                  try {
                                    const list = JSON.parse(
                                      localStorage.getItem("muse_recent_ideas") ?? "[]",
                                    );
                                    list.unshift(ac.trim());
                                    localStorage.setItem(
                                      "muse_recent_ideas",
                                      JSON.stringify(list.slice(0, 5)),
                                    );
                                  } catch {
                                    /* 忽略 */
                                  }
                                } else {
                                  toast({ title: "随机灵感生成失败，请重试", variant: "destructive" });
                                }
                              }
                            }
                          } catch {
                            toast({ title: "随机灵感生成失败，请重试", variant: "destructive" });
                          }
                          setInspireLoading(false);
                        }}>
                        {inspireLoading ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Sparkles className="size-3 mr-1" />}
                        {inspireLoading ? "生成中..." : "随机灵感"}
                      </Button>
                    )}
                    {usedGuideSessionId && !quickGuiding && (
                      <Button variant="ghost" onClick={resumeUsedGuide}>
                        继续上次引导
                      </Button>
                    )}
                    {!quickSynopsisMode && (
                      <Button variant="outline" onClick={async () => {
                      if (!quickPremise.trim()) { toast({ title: "请先输入想法", variant: "destructive" }); return; }
                      setQuickGuiding(true);
                      localStorage.setItem("muse_guide_premise", quickPremise);
                      guideGotContent.current = false;
                      // 先创建引导会话
                      try {
                        const r = await authFetch("/api/ai/chat-sessions", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
                          body: JSON.stringify({ book_id: "guide", section: "guide" }),
                        });
                        const d = await r.json();
                        if (d.data?.id) guideSessionRef.current = d.data.id;
                      } catch {}
                      // 发送第一条引导消息
                      const initMsg = `我想写一个故事，我的想法是：${quickPremise}`;
                      const initMsgs = [{ role: "user", content: initMsg }];
                      setQuickGuideMsgs(initMsgs);
                      const token = localStorage.getItem("token");
                      // 立即持久化用户消息到 DB，防止刷新时弹窗消失
                      if (guideSessionRef.current) {
                        authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ messages: initMsgs }),
                        }).catch(() => {});
                      }
                      // 再存一个占位 AI 消息，恢复时可检测中断的生成
                      const sentinelMsgs = [...initMsgs, { role: "assistant", content: "（生成中...）" }];
                      if (guideSessionRef.current) {
                        authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ messages: sentinelMsgs }),
                        }).catch(() => {});
                      }
                      setQuickGuideMsgs(sentinelMsgs);
                      setQuickGuideLoading(true);
                      // 挂到 guideAbortRef：退出引导时中止请求，后端停止生成、停止烧 token
                      const guideCtrl = new AbortController();
                      guideAbortRef.current = guideCtrl;
                      authFetch("/api/ai/chat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({
                          book_id: "",
                          context_type: "write",
                          model: quickModel || undefined, key_id: quickKeyId,
                          message: initMsg,
                          messages: [{ role: "user", content: initMsg }],
                          guide_mode: true,
                          guide_context: quickPremise || localStorage.getItem("muse_guide_premise"),
                          guide_type: quickType,
                        }),
                        signal: AbortSignal.any([guideCtrl.signal, AbortSignal.timeout(120000)]),
                      }).then(async (res) => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const reader = res.body?.getReader();
                        if (!reader) throw new Error("无响应");
                        const decoder = new TextDecoder();
                        let buf = "", ac = "";
                        guideStreamAcRef.current = "";
                        // 每 3 秒自动保存当前流式内容，避免刷新丢失 AI 回复
                        guideInitSaveRef.current = setInterval(() => {
                          if (guideSessionRef.current && guideStreamAcRef.current) {
                            const partialMsgs = [{ role: "user", content: initMsg }, { role: "assistant", content: guideStreamAcRef.current }];
                            authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
                              body: JSON.stringify({ messages: partialMsgs }),
                            }).catch(() => {});
                          }
                        }, 3000);
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) { buf += decoder.decode(); break; }
                          buf += decoder.decode(value, { stream: true });
                          const lines = buf.split("\n"); buf = lines.pop() ?? "";
                          let ev = "";
                          for (const line of lines) {
                            if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
                            if (line.startsWith("data: ")) {
                              try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
                            }
                          }
                          if (ac) {
                            guideGotContent.current = true;
                            guideStreamAcRef.current = ac;
                            setQuickGuideMsgs([{ role: "user", content: initMsg }, { role: "assistant", content: ac }]);
                          }
                        }
                      }).catch((err) => {
                        // 主动退出引导（abort）不弹错误
                        if (!guideCtrl.signal.aborted) {
                          toast({ title: err?.message || "请求失败", variant: "destructive" });
                          setQuickGuiding(false);
                        }
                      }).finally(() => {
                        if (guideAbortRef.current === guideCtrl) guideAbortRef.current = null;
                        if (guideInitSaveRef.current) { clearInterval(guideInitSaveRef.current); guideInitSaveRef.current = null; }
                        guideStreamAcRef.current = "";
                        setQuickGuideLoading(false);
                        setQuickGuideMsgs((prev) => {
                          let next = prev;
                          if (stopGuideRef.current) {
                            // 手动停止：半截回复保留并标记；无内容则移除 sentinel
                            const last = prev[prev.length - 1];
                            if (last?.role === "assistant") {
                              if (guideGotContent.current) {
                                next = [...prev.slice(0, -1), { role: "assistant", content: last.content + "\n（已停止）" }];
                              } else {
                                next = prev.slice(0, -1);
                              }
                            }
                          } else if (!guideGotContent.current) {
                            next = [...prev, { role: "assistant", content: "（AI 未响应，请重试）" }];
                          }
                          stopGuideRef.current = false;
                          if (guideSessionRef.current) {
                            authFetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
                              body: JSON.stringify({ messages: next }),
                            }).catch(() => {});
                          }
                          return next;
                        });
                      });
                    }} disabled={quickGenerating || !quickPremise.trim()}>
                      <Sparkles className="size-4 mr-1" />AI 引导
                    </Button>
                    )}
                    {!quickSynopsisMode && (
                    <Button onClick={() => doQuickCreate(quickPremise, quickType)} disabled={quickGenerating || !quickPremise.trim()}>
                      {quickGenerating && <Loader2 className="size-4 animate-spin mr-1" />}
                      {quickGenerating ? "生成中..." : "直接生成"}
                    </Button>
                    )}
                    {quickSynopsisMode && !synopsisConfirmed && (
                    <Button onClick={() => doSkeletonize(synopsisEdit)} disabled={synopsisWorking || !synopsisEdit.trim()}>
                      {synopsisWorking && <Loader2 className="size-4 animate-spin mr-1" />}
                      {synopsisWorking ? "体检中..." : "逻辑体检"}
                    </Button>
                    )}
                  </div>
                  )}
                </div>
              )}

              {/* 底部固定操作栏：梗概候选确认按钮，始终可见不随内容滚动 */}
              {!quickGuiding && quickOutlines.length > 0 && !quickGenerating && (
                <div className="shrink-0 border-t border-border pt-3 flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={selectedOutlineIdx == null}
                    onClick={() => doGenerateStory()}
                  >
                    <Sparkles className="size-3.5 mr-1" />
                    开始写正文
                  </Button>
                  <Button
                    variant="outline"
                    disabled={quickGenerating}
                    onClick={async () => {
                      // 删掉旧书，重新生成梗概候选
                      try {
                        await api.delete(`/books/${quickOutlineBookId}/permanent`);
                      } catch { /* 忽略 */ }
                      setQuickOutlines([]);
                      setSelectedOutlineIdx(null);
                      setOutlineEdit("");
                      setOutlineCheckedText("");
                      setOutlineCheckedSkeleton("");
                      setOutlineRisks([]);
                      setQuickOutlineBookId("");
                      doQuickCreate(quickPremise, quickType);
                    }}
                  >
                    换一批
                  </Button>
                </div>
              )}

              {/* 底部固定操作栏：自写梗概体检确认（编辑过可重新体检；生成完成后隐藏） */}
              {!quickGuiding && quickSynopsisMode && synopsisConfirmed && !quickGenerating && !quickCreatedId && (
                <div className="shrink-0 border-t border-border pt-3 flex gap-2">
                  <Button
                    variant="outline"
                    disabled={synopsisWorking}
                    onClick={() => setSynopsisConfirmed(false)}
                  >
                    返回修改
                  </Button>
                  <Button
                    variant="outline"
                    disabled={synopsisWorking || synopsisEdit.trim() === synopsisPreview}
                    onClick={() => doSkeletonize(synopsisEdit)}
                  >
                    {synopsisWorking && <Loader2 className="size-3.5 animate-spin mr-1" />}
                    重新体检
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={synopsisWorking || !synopsisEdit.trim()}
                    onClick={startSynopsisStory}
                  >
                    <Sparkles className="size-3.5 mr-1" />
                    开始写正文
                  </Button>
                </div>
              )}

              {/* ===== 阶段 2：引导聊天 ===== */}
              {quickGuiding && (
                <>
                  <div ref={guideChatRef} onScroll={handleGuideScroll} className="flex-1 overflow-y-auto space-y-3 min-h-0 border rounded-lg p-3 bg-muted/20">
                    {quickGuideMsgs.map((m, i) => (
                      <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                        {editingGuideIdx === i ? (
                          <div className="w-full space-y-2">
                            <textarea
                              autoFocus
                              value={editingGuideText}
                              onChange={(e) => setEditingGuideText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditGuideMsg(); }
                                if (e.key === "Escape") { setEditingGuideIdx(null); setEditingGuideText(""); }
                              }}
                              rows={3}
                              className="w-full rounded border border-border bg-background px-3 py-2 text-sm resize-none"
                            />
                            <div className="flex justify-end gap-2">
                              <Button variant="ghost" size="xs" onClick={() => { setEditingGuideIdx(null); setEditingGuideText(""); }}>取消</Button>
                              <Button size="xs" onClick={saveEditGuideMsg} disabled={!editingGuideText.trim() || quickGuideLoading}>
                                保存并重发
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="group flex items-start gap-1 max-w-[85%]">
                            <div className={cn(
                              "rounded-lg px-3 py-2 text-sm",
                              m.role === "user"
                                ? "bg-primary text-primary-foreground"
                                : "bg-card border border-border text-foreground",
                            )}>
                              {(m.role === "assistant"
                                ? m.content.replaceAll("[GUIDE_READY]", "")
                                : m.content) ||
                                (i === quickGuideMsgs.length - 1 && quickGuideLoading
                                  ? "思考中..."
                                  : "")}
                            </div>
                            {m.role === "user" && !quickGuideLoading && (
                              <button
                                className="opacity-0 group-hover:opacity-100 shrink-0 mt-1 text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => { setEditingGuideIdx(i); setEditingGuideText(m.content); }}
                                title="编辑并重新发送（该消息之后的内容将作废）"
                              >
                                编辑
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {quickGuideLoading && quickGuideMsgs[quickGuideMsgs.length - 1]?.role === "user" && (
                      <div className="flex justify-start">
                        <div className="bg-card border border-border rounded-lg px-3 py-2 text-sm text-muted-foreground">
                          <Loader2 className="size-3 animate-spin inline mr-1" />思考中...
                        </div>
                      </div>
                    )}
                  </div>
                  {/* 作品生成进度（引导模式下 doQuickCreate 运行时显示） */}
                  {quickGenerating && (
                    <div className="space-y-1 px-1">
                      {quickSteps.map((s) => (
                        <div key={s.step} className="flex items-center gap-2 text-xs">
                          {s.status === "done" ? (
                            <Check className="size-3 text-green-500 shrink-0" />
                          ) : (
                            <Loader2 className="size-3 animate-spin text-primary shrink-0" />
                          )}
                          <span className={s.status === "done" ? "text-muted-foreground" : "text-foreground"}>
                            {s.label}
                          </span>
                        </div>
                      ))}
                      {quickSteps.length === 0 && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" />
                          正在准备...
                        </div>
                      )}
                    </div>
                  )}
                  {/* AI 就绪提示：放输入区上方，避免挤占按钮行 */}
                  {guideReady && (
                    <p className="text-xs text-primary px-1" title="AI 判断引导信息已足够；你也可以不理会，随时点击开始生成">
                      AI 认为信息已足够，可以开始生成
                    </p>
                  )}
                  {/* 引导输入 + 操作 */}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={quickGuideInput}
                      onChange={(e) => {
                        setQuickGuideInput(e.target.value);
                        const el = e.target;
                        el.style.height = "auto";
                        el.style.height = Math.min(el.scrollHeight, 96) + "px";
                      }}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendGuideMsg(); } }}
                      placeholder="回复 AI 的问题... Shift+Enter 换行"
                      disabled={quickGuideLoading}
                      rows={3}
                      className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm resize-none"
                    />
                    {quickGuideLoading && !quickGenerating ? (
                      // AI 回复中：停止当前引导回复（红色圆形图标，与详情页 AI 面板同款）
                      <Button
                        size="icon"
                        variant="destructive"
                        className="rounded-full shrink-0"
                        onClick={() => { stopGuideRef.current = true; guideAbortRef.current?.abort(); }}
                        title="停止生成（已生成的部分保留）"
                      >
                        <Square className="size-4" />
                      </Button>
                    ) : quickGenerating ? (
                      // 作品生成中（引导模式）：中止 quick-create
                      <Button
                        size="icon"
                        variant="destructive"
                        className="rounded-full shrink-0"
                        onClick={() => { quickAbortRef.current?.abort(); }}
                        title="停止生成（已生成的部分保留）"
                      >
                        <Square className="size-4" />
                      </Button>
                    ) : (
                      <Button size="sm" onClick={sendGuideMsg} disabled={quickGuideLoading || !quickGuideInput.trim()}>
                        <Send className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className={guideReady ? "bg-primary text-primary-foreground hover:bg-primary" : ""}
                      onClick={async () => {
                      // 先向 AI 发送"开始生成"，获取结构化创作摘要
                      setQuickGuideLoading(true);
                      const finalMsg = "开始生成，请输出创作摘要";
                      const finalMsgs = [...quickGuideMsgs, { role: "user", content: finalMsg }];
                      setQuickGuideMsgs(finalMsgs);
                      const token = localStorage.getItem("token");
                      let summary = "";
                      // 挂到 guideAbortRef：退出引导时中止，后端停止生成
                      const finalCtrl = new AbortController();
                      guideAbortRef.current = finalCtrl;
                      try {
                        const res = await authFetch("/api/ai/chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                            book_id: "",
                            context_type: "write",
                            model: quickModel || undefined, key_id: quickKeyId,
                            message: finalMsg,
                            messages: finalMsgs.map(m => ({ role: m.role, content: m.content })),
                            guide_mode: true,
                            guide_context: quickPremise || localStorage.getItem("muse_guide_premise"),
                            guide_type: quickType,
                          }),
                          signal: AbortSignal.any([finalCtrl.signal, AbortSignal.timeout(120000)]),
                        });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const reader = res.body?.getReader();
                        if (!reader) throw new Error("无响应");
                        const decoder = new TextDecoder();
                        let buf = "", ac = "";
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) { buf += decoder.decode(); break; }
                          buf += decoder.decode(value, { stream: true });
                          const lines = buf.split("\n"); buf = lines.pop() ?? "";
                          let ev = "";
                          for (const line of lines) {
                            if (line.startsWith("event: ")) { ev = line.slice(7); continue; }
                            if (line.startsWith("data: ")) {
                              try { if (ev === "chunk") ac += JSON.parse(line.slice(6)); } catch { if (ev === "chunk") ac += line.slice(6); }
                            }
                          }
                          if (ac) {
                            const nextMsgs = [...finalMsgs, { role: "assistant", content: ac }];
                            setQuickGuideMsgs(nextMsgs);
                                                      }
                        }
                        if (!ac) {
                          setQuickGuideMsgs([...finalMsgs, { role: "assistant", content: "（AI 未响应，请重试）" }]);
                        }
                        summary = ac.replaceAll("[GUIDE_READY]", "");
                        // 摘要流结束，立即保存
                        setQuickGuideMsgs((prev) => {
                                                    return prev;
                        });
                      } catch (err: any) {
                        // 手动停止：静默返回，留在引导界面
                        if (err?.name === "AbortError") { setQuickGuideLoading(false); return; }
                        // 摘要失败也归档：叉掉弹窗不删除会话，保留重试入口
                        archiveGuideSession();
                        toast({ title: "获取摘要失败: " + (err?.message || "未知错误"), variant: "destructive" });
                        setQuickGuideLoading(false);
                        return;
                      }
                      setQuickGuideLoading(false);
                      // 构建完整对话日志作为参考附录
                      const fullLog = quickGuideMsgs
                        .filter(m => m.role === "user" || m.role === "assistant")
                        .map(m => `${m.role === "user" ? "作者" : "AI"}: ${m.content.replaceAll("[GUIDE_READY]", "")}`)
                        .join("\n");
                      // 等待 quickCreate 完成；失败时留在引导界面可重试
                      await doQuickCreate(quickPremise, quickType, summary, fullLog);
                    }} disabled={quickGuideLoading || quickGenerating || quickGuideMsgs.length === 0}>
                      开始生成
                    </Button>
                  </div>
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <ConfirmDialog
        open={batchConfirm != null}
        onOpenChange={(o) => !o && setBatchConfirm(null)}
        title={batchConfirm === "restore" ? "恢复作品" : "删除作品"}
        description={
          batchConfirm === "restore"
            ? `恢复选中的 ${selectedIds.size} 个作品？`
            : showDeleted
              ? `确定彻底删除选中的 ${selectedIds.size} 个作品？此操作无法恢复。`
              : `确定删除选中的 ${selectedIds.size} 个作品？将移入回收站，7 天内可恢复。`
        }
        confirmText={batchConfirm === "restore" ? "恢复" : "删除"}
        destructive={batchConfirm === "delete"}
        onConfirm={runBatchAction}
      />

      {/* 加载骨架 */}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      )}

      {/* 加载失败：必须与"空状态"区分，否则后端未就绪时会被误认为作品丢失 */}
      {!isLoading && isError && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BookOpen className="size-12" />
          <p className="mt-4 text-sm">作品列表加载失败</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            可能是服务端尚未就绪或网络异常，请稍后重试
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => refetch()}
          >
            重新加载
          </Button>
        </div>
      )}

      {/* 空状态 */}
      {!isLoading && !isError && books.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <BookOpen className="size-12" />
          <p className="mt-4 text-sm">
            {showDeleted ? "回收站为空" : "还没有作品，点击「快捷创作」让 AI 帮你生成，或「新建作品」从空白开始"}
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
                showDeleted && "opacity-60"
              )}
              onClick={() => {
                if (selectMode) {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(book.book_id)) next.delete(book.book_id);
                    else next.add(book.book_id);
                    return next;
                  });
                  return;
                }
                if (!showDeleted) {
                  navigate(`/books/${book.book_id}`);
                }
              }}
            >
              <CardContent className="p-4">
                {selectMode && (
                  <div className={cn("size-5 rounded border-2 flex items-center justify-center mb-2", selectedIds.has(book.book_id) ? "bg-primary border-primary" : "border-muted-foreground/40")}>
                    {selectedIds.has(book.book_id) && <Check className="size-3 text-primary-foreground" />}
                  </div>
                )}
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
                <div className={`mt-3 flex gap-1 transition-opacity ${showDeleted ? "" : "opacity-0 group-hover:opacity-100"}`}>
                  {showDeleted ? (
                    <>
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
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm("确定彻底删除？此操作不可撤销。")) {
                            permanentDeleteBook.mutate(book.book_id);
                          }
                        }}
                      >
                        <Trash2 className="size-3" />
                        彻底删除
                      </Button>
                    </>
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
