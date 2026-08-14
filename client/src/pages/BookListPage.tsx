import { useState, useRef, useEffect, useCallback } from "react";
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
import { Plus, BookOpen, Loader2, Trash2, Undo2, Sparkles, Check, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ModelSelector } from "@/components/settings/ModelSelector";

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

// 知乎体公共体例：所有短篇模板统一注入（写法外壳，与题材正交）
const SHORT_STYLE_SUFFIX =
  "。体例要求：知乎体短篇——第一人称「我」叙述，开篇三句内直给冲突或悬念，段落短节奏快，反转密集，篇幅 1~3 万字，结尾留余味";

const SHORT_TEMPLATES = [
  { key: "rebirth", label: "重生逆袭", prompt: "写一个女主重生回到过去、改变命运的短篇，第一人称「我」叙述，开篇即冲突，打脸虐渣爽感十足" },
  { key: "face-slap", label: "复仇打脸", prompt: "写一个复仇打脸短篇——女主被背叛/轻视/夺走一切后蛰伏反击，把伤害过她的人一个个送进深渊，不靠男人只靠自己，第一人称" },
  { key: "strong", label: "大女主", prompt: "写一个大女主短篇——女主能力强、有主见、不依附任何人，在自己的领域闪闪发光，爱情是锦上添花不是救命稻草" },
  { key: "transmigration", label: "穿越穿书", prompt: "写一个穿越穿书短篇——主角穿进一本书里成为下场凄惨的配角（恶毒女配/炮灰/工具人），熟知剧情走向，靠信息差逆天改命，第一人称" },
  { key: "ancient", label: "古言宫斗", prompt: "写一个古言宫斗短篇——深宫或宅院里，女主在嫡庶之争/宠妾算计/帝王猜忌中步步为营，从棋子变成执棋人，第一人称" },
  { key: "rule-horror", label: "规则怪谈", prompt: "写一个规则怪谈短篇——主角进入一个规则诡异的场所（公司/学校/小区/医院），发现一条条不能违反的规则，违反规则的人一个接一个消失，主角在恐惧中找出规则真相并逃出生天，第一人称" },
  { key: "horror", label: "恐怖惊悚", prompt: "写一个恐怖惊悚短篇——凶宅/噩梦/民俗禁忌类，氛围压抑细思极恐，主角逐渐发现最恐怖的不是鬼而是人，第一人称" },
  { key: "twist", label: "悬疑反转", prompt: "写一个结局出人意料的悬疑反转短篇，全程铺垫细节，最后一句话颠覆全部认知" },
  { key: "knife-sugar", label: "刀糖文学", prompt: "写一个刀糖短篇——用悬疑/犯罪/惊悚的外壳包裹温情内核，表面细思极恐，内核实则催泪治愈，参考《杀人犯的生日蛋糕》风格" },
  { key: "reality", label: "现实情感", prompt: "写一个现实向短篇——离婚逆袭、职场PUA、育儿焦虑等真实社会议题，细节扎心、情绪共鸣强，女主从谷底爬起来活出自己，第一人称" },
  { key: "family", label: "亲情催泪", prompt: "写一个亲情短篇——母女/父子/兄妹/祖孙之间，细腻真实让人泪目，第一人称" },
  { key: "sweet", label: "甜宠治愈", prompt: "写一个甜宠治愈短篇——男主温柔深情，女主被好好珍惜，全程轻松温暖没有虐点，让人读完嘴角上扬" },
  { key: "work-fantasy", label: "社畜奇幻", prompt: "写一个轻奇幻短篇——把奇幻设定植入职场/校园/日常场景，比如公司洗手间通向异世界、能听懂猫狗说话，想象力+烟火气，温暖治愈" },
];

export function BookListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createType, setCreateType] = useState<'novel' | 'short'>('novel');
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickRestored, setQuickRestored] = useState(false);
  const [quickType, setQuickType] = useState<'novel' | 'short'>('novel');
  const [quickPremise, setQuickPremise] = useState("");
  const [quickModel, setQuickModel] = useState("deepseek-v4-flash");
  const [quickGenerating, setQuickGenerating] = useState(false);
  const [inspireLoading, setInspireLoading] = useState(false);
  const [quickSteps, setQuickSteps] = useState<Array<{ step: string; label: string; status: string; preview?: string }>>([]);
  // 短篇生成完成后的书名候选
  const [quickTitles, setQuickTitles] = useState<string[]>([]);
  const [quickCreatedId, setQuickCreatedId] = useState("");
  const [quickAppliedTitle, setQuickAppliedTitle] = useState("");
  // 梗概确认流程
  const [quickOutline, setQuickOutline] = useState("");
  const [quickOutlineBookId, setQuickOutlineBookId] = useState("");
  // 引导模式
  const [quickGuiding, setQuickGuiding] = useState(false);
  const [quickGuideMsgs, setQuickGuideMsgs] = useState<Array<{ role: string; content: string }>>([]);
  const [quickGuideInput, setQuickGuideInput] = useState("");
  const [quickGuideLoading, setQuickGuideLoading] = useState(false);
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

  // 恢复引导会话 / 弹窗状态（含中断生成自动恢复）
  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem("token");
        if (!token) { setQuickRestored(true); return; }
        const res = await fetch(`/api/ai/chat-sessions/guide?section=guide`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        console.log('[guide restore] status:', res.status);
        const json = await res.json();
        console.log('[guide restore] data:', JSON.stringify(json?.data).slice(0, 200));
        if (res.ok && json?.data?.active?.messages?.length > 0) {
          guideSessionRef.current = json.data.active.id;
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
            console.log('[guide restore] detected interrupted generation, auto-resuming...');
            setQuickRestored(true);
            // 等组件渲染完成后自动继续生成
            setTimeout(() => resumeGuideGeneration(resumeMsgs), 300);
            return;
          }
          setQuickGuideMsgs(allMsgs);
          setQuickGuiding(true);
          setQuickOpen(true);
          console.log('[guide restore] restored', allMsgs.length, 'msgs');
        }
      } catch (e) { console.log('[guide restore] error:', e); }
      setQuickRestored(true);
    })();
  }, []);

  // restore 完成后，如果没有引导会话，用 localStorage 恢复弹窗开关
  useEffect(() => {
    console.log('[quick restore] quickRestored:', quickRestored, 'quickGuiding:', quickGuiding, 'ls:', localStorage.getItem("muse_quick_open"));
    if (quickRestored && !quickGuiding && localStorage.getItem("muse_quick_open") === "1") {
      setQuickOpen(true);
      console.log('[quick restore] opening dialog from localStorage');
    }
  }, [quickRestored, quickGuiding]);

  const quickAbortRef = useRef<AbortController | null>(null);
  const guideChatRef = useRef<HTMLDivElement>(null);
  const guideUserScrolledUp = useRef(false);
  const guideGotContent = useRef(false);
  const guideStreamAcRef = useRef(""); // 流式累积内容，供定时保存用
  const guideInitSaveRef = useRef<ReturnType<typeof setInterval> | null>(null); // 初始引导消息的定时保存

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
      api.post<{ data: { book_id: string } }>("/books", { ...form, type: createType }),
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

  const permanentDeleteBook = useMutation({
    mutationFn: (bookId: string) => api.delete(`/books/${bookId}/permanent`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      toast({ title: "作品已彻底删除" });
    },
    onError: () => {
      toast({ title: "删除失败", variant: "destructive" });
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

  const doQuickCreate = async (premise: string, type: string, guideSummary?: string, guideFullLog?: string) => {
    setQuickGenerating(true);
    setQuickSteps([]);
    const controller = new AbortController();
    quickAbortRef.current = controller;
    const token = localStorage.getItem("token");
    try {
      const res = await fetch("/api/ai/quick-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ premise, type, model: quickModel, guide_summary: guideSummary, guide_full_log: guideFullLog }),
        signal: controller.signal,
      });
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
                  if (data.preview) {
                    // 新流程：展示梗概，等用户确认后写正文
                    hasPreview = true;
                    setQuickOutline(data.preview);
                    setQuickOutlineBookId(data.book_id);
                  } else if (data.titles?.length > 1) {
                    // 正文写完：至少 2 个候选才展示选择区
                    hasTitleCandidates = true;
                    setQuickTitles(data.titles);
                    setQuickCreatedId(data.book_id);
                    setQuickAppliedTitle(data.title || data.titles[0]);
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
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast({ title: err?.message || "生成失败", variant: "destructive" });
      }
    } finally {
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

  // 引导模式：发送消息
  const sendGuideMsg = async () => {
    guideUserScrolledUp.current = false;
    guideGotContent.current = false;
    const input = quickGuideInput.trim();
    if (!input || quickGuideLoading) return;
    setQuickGuideInput("");
    const newMsgs = [...quickGuideMsgs, { role: "user", content: input }];
    setQuickGuideMsgs(newMsgs);
    setQuickGuideLoading(true);
    const token = localStorage.getItem("token");
    const controller = new AbortController();
    guideAbortRef.current = controller;
    // 先保存用户消息（await 确保 DB 已写入），再发 AI 请求
    if (guideSessionRef.current) {
      await fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: newMsgs }),
      }).catch(() => {});
    }
    let saveInterval: ReturnType<typeof setInterval> | undefined;
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          book_id: "",
          context_type: "write",
          model: quickModel,
          message: input,
          messages: newMsgs.map(m => ({ role: m.role, content: m.content })),
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
          const partialMsgs = [...newMsgs, { role: "assistant", content: guideStreamAcRef.current }];
          fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
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
        // 只在有内容时才追加/更新 AI 回复，并同步写 localStorage
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
    } catch (err: any) {
      if (err.name === "AbortError") return;
      toast({ title: err?.message || "发送失败", variant: "destructive" });
    } finally {
      if (saveInterval) clearInterval(saveInterval);
      guideStreamAcRef.current = "";
      setQuickGuideLoading(false);
      setQuickGuideMsgs((prev) => {
        const next = !guideGotContent.current
          ? [...prev, { role: "assistant", content: "（AI 未响应，请重试）" }]
          : prev;
        // 保存到后端
        if (guideSessionRef.current) {
          console.log('[guide] saving', next.length, 'msgs to', guideSessionRef.current);
          fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
            body: JSON.stringify({ messages: next }),
          }).then(r => { if (!r.ok) console.log('[guide] save failed:', r.status); else console.log('[guide] save ok'); })
            .catch(e => console.log('[guide] save error:', e));
        } else {
          console.log('[guide] no session to save to');
        }
        return next;
      });
      guideAbortRef.current = null;
    }
  };

  // 刷新后恢复中断的生成：去掉 sentinel，重新发起 AI 请求
  const resumeGuideGeneration = async (msgs: Array<{ role: string; content: string }>) => {
    guideUserScrolledUp.current = false;
    guideGotContent.current = false;
    setQuickGuideLoading(true);
    const token = localStorage.getItem("token");
    const controller = new AbortController();
    guideAbortRef.current = controller;
    // 先保存去掉 sentinel 的消息（含占位，标记"生成中"）
    const resumeMsgs = [...msgs, { role: "assistant", content: "（生成中...）" }];
    if (guideSessionRef.current) {
      fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: resumeMsgs }),
      }).catch(() => {});
    }
    setQuickGuideMsgs(resumeMsgs);
    let saveInterval: ReturnType<typeof setInterval> | undefined;
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          book_id: "",
          context_type: "write",
          model: quickModel,
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
      saveInterval = setInterval(() => {
        if (guideSessionRef.current && guideStreamAcRef.current) {
          const partialMsgs = [...msgs, { role: "assistant", content: guideStreamAcRef.current }];
          fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
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
    } catch (err: any) {
      if (err.name === "AbortError") return;
      toast({ title: err?.message || "恢复生成失败", variant: "destructive" });
    } finally {
      if (saveInterval) clearInterval(saveInterval);
      guideStreamAcRef.current = "";
      setQuickGuideLoading(false);
      setQuickGuideMsgs((prev) => {
        const next = !guideGotContent.current
          ? [...prev, { role: "assistant", content: "（AI 未响应，请重试）" }]
          : prev;
        if (guideSessionRef.current) {
          fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
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

  // 梗概确认后：调 generate-story 写正文（SSE 进度 + 书名候选）
  const doGenerateStory = async () => {
    if (!quickOutlineBookId) return;
    setQuickGenerating(true);
    setQuickSteps([]);
    setQuickOutline("");
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
      const res = await fetch("/api/ai/generate-story", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: quickOutlineBookId, premise: quickPremise, model: quickModel }),
        signal: controller.signal,
      });
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
        toast({ title: err?.message || "生成失败", variant: "destructive" });
      }
    } finally {
      setQuickGenerating(false);
      setQuickSteps([]);
      quickAbortRef.current = null;
    }
  };

  // 应用书名候选
  const applyQuickTitle = async (title: string) => {
    if (!quickCreatedId) return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/books/${quickCreatedId}`, {
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
    setQuickOpen(false);
    setQuickPremise("");
    setQuickSteps([]);
    setQuickTitles([]);
    setQuickCreatedId("");
    setQuickAppliedTitle("");
    setQuickOutline("");
    setQuickOutlineBookId("");
    setQuickGuiding(false);
    setQuickGuideMsgs([]);
    setQuickGuideInput("");
    setQuickGuideLoading(false);
    localStorage.removeItem("muse_quick_open");
    localStorage.removeItem("muse_guide_premise");
    // 删除引导会话
    if (guideSessionRef.current) {
      fetch(`/api/ai/chat-sessions/${guideSessionRef.current}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      }).catch(() => {});
      guideSessionRef.current = null;
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
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
                  onClick={async () => {
                    if (!confirm(`恢复选中的 ${selectedIds.size} 个作品？`)) return;
                    const ids = [...selectedIds];
                    try {
                      await api.post(`/books/batch-restore`, { book_ids: ids });
                      toast({ title: `已恢复 ${ids.length} 个作品` });
                    } catch (e: any) {
                      toast({ title: e.message || "恢复失败", variant: "destructive" });
                      return;
                    }
                    setSelectedIds(new Set());
                    setSelectMode(false);
                    queryClient.invalidateQueries({ queryKey: ["books"] });
                  }}
                >
                  恢复选中 ({selectedIds.size})
                </Button>
              )}
              <Button variant="destructive" size="sm" disabled={selectedIds.size === 0}
                onClick={async () => {
                  if (!confirm(`确定删除选中的 ${selectedIds.size} 个作品？`)) return;
                  const ids = [...selectedIds];
                  try {
                    if (showDeleted) {
                      // 回收站：一次请求批量彻底删除（并发，速度快）
                      await api.post(`/books/batch-permanent-delete`, { book_ids: ids });
                    } else {
                      for (const id of ids) await api.delete(`/books/${id}`);
                    }
                    toast({ title: `已${showDeleted ? "彻底删除" : "删除"} ${ids.length} 个作品` });
                  } catch (e: any) {
                    toast({ title: e.message || "删除失败", variant: "destructive" });
                    return;
                  }
                  setSelectedIds(new Set());
                  setSelectMode(false);
                  queryClient.invalidateQueries({ queryKey: ["books"] });
                }}
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
            // 生成中：直接取消
            if (quickGenerating) {
              quickAbortRef.current?.abort();
              resetQuickDialog();
              return;
            }
            // 引导聊天中：确认后取消
            if (quickGuiding) {
              if (!confirm("确定退出引导？当前对话将丢失。")) return;
              guideAbortRef.current?.abort();
              resetQuickDialog();
              return;
            }
            // 表单阶段：直接关闭
            resetQuickDialog();
          }}>
            <DialogContent className={quickGuiding ? "max-w-lg h-[520px] flex flex-col" : "max-w-lg sm:max-w-lg"}>
              <DialogHeader>
                <DialogTitle>{quickGuiding ? "创作引导" : "快捷创作"}</DialogTitle>
                <DialogDescription>
                  {quickGuiding
                    ? `第 ${Math.min(quickGuideMsgs.filter(m => m.role === "user").length + 1, 5)} 轮 · AI 帮你梳理想法`
                    : (quickType === 'short' ? 'AI 一步写完完整短篇故事' : 'AI 自动生成世界观、大纲和角色')}
                </DialogDescription>
              </DialogHeader>

              {/* ===== 阶段 1：表单 ===== */}
              {!quickGuiding && (
                <div className="space-y-4">
                  {/* 类型切换 + 模型选择 */}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={quickType === 'novel' ? 'default' : 'outline'} onClick={() => setQuickType('novel')} disabled={quickGenerating}>长篇</Button>
                    <Button size="sm" variant={quickType === 'short' ? 'default' : 'outline'} onClick={() => setQuickType('short')} disabled={quickGenerating}>短篇</Button>
                    <div className="flex-1" />
                    <ModelSelector
                      usage="chat"
                      value={quickModel}
                      onChange={(model) => setQuickModel(model)}
                      className="text-xs rounded border border-border bg-background px-2 py-1"
                    />
                  </div>

                  {/* 短篇模板 */}
                  {quickType === 'short' && (
                    <div className="space-y-2">
                      <Label className="text-xs">套模板</Label>
                      <div className="grid grid-cols-3 gap-2">
                        {SHORT_TEMPLATES.map((tpl) => (
                          <Button key={tpl.key} size="xs" variant="outline"
                            disabled={quickGenerating}
                            onClick={() => setQuickPremise(tpl.prompt + SHORT_STYLE_SUFFIX)}>
                            {tpl.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 脑洞输入 */}
                  <div className="space-y-2">
                    <Label htmlFor="premise">{quickType === 'short' ? '脑洞 / 想法' : '题材 / 想法'}</Label>
                    <textarea
                      id="premise"
                      placeholder={quickType === 'short' ? '简单描述你的想法，AI 帮你完善...' : '例如：我想写一本末世公路求生小说...'}
                      value={quickPremise}
                      onChange={(e) => setQuickPremise(e.target.value)}
                      rows={quickType === 'short' ? 3 : 4}
                      disabled={quickGenerating}
                      className="w-full rounded border border-border bg-background px-3 py-2 text-sm resize-none"
                    />
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

                  {/* 梗概确认：展示梗概 + 开始写正文 / 换个梗概 */}
                  {quickOutline && !quickGenerating && (
                    <div className="space-y-2">
                      <Label className="text-xs">故事梗概（确认走向后开始写正文）</Label>
                      <div className="max-h-44 overflow-y-auto rounded border border-border bg-muted/20 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                        {quickOutline}
                      </div>
                      <div className="flex gap-2">
                        <Button className="flex-1" onClick={doGenerateStory}>
                          <Sparkles className="size-3.5 mr-1" />
                          开始写正文
                        </Button>
                        <Button
                          variant="outline"
                          disabled={quickGenerating}
                          onClick={async () => {
                            // 删掉旧书，重新生成梗概
                            try {
                              await api.delete(`/books/${quickOutlineBookId}/permanent`);
                            } catch { /* 忽略 */ }
                            setQuickOutline("");
                            setQuickOutlineBookId("");
                            doQuickCreate(quickPremise, quickType);
                          }}
                        >
                          换个梗概
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* 生成完成：书名候选 */}
                  {quickCreatedId && quickTitles.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs">书名候选（点击使用）</Label>
                      <div className="space-y-1.5">
                        {quickTitles.map((t, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => applyQuickTitle(t)}
                            className={cn(
                              "w-full text-left rounded border px-3 py-2 text-sm transition-colors",
                              quickAppliedTitle === t
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-background hover:bg-muted/50",
                            )}
                          >
                            {t}
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
                    </div>
                  )}

                  {/* 生成完成后隐藏操作区，只留书名候选和打开作品 */}
                  {!quickCreatedId && (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={resetQuickDialog}
                      disabled={quickGenerating}
                    >
                      取消
                    </Button>
                    {quickType === 'short' && (
                      <Button variant="outline" disabled={quickGenerating || inspireLoading}
                        onClick={async () => {
                          setInspireLoading(true);
                          const token = localStorage.getItem("token");
                          // 题材随机化，避免每次都出悬疑向创意
                          const topics = ["重生逆袭", "都市情感", "脑洞奇幻", "规则怪谈", "穿越穿书", "甜宠治愈", "亲情催泪", "悬疑反转", "职场现实", "古风古言"];
                          const topic = topics[Math.floor(Math.random() * topics.length)];
                          const ideaMsg = `生成一个「${topic}」题材的短篇小说创意，一句话描述，20-40字，要具体有画面感。直接输出创意本身，不要解释、不要分析、不要反问。`;
                          try {
                            const res = await fetch("/api/ai/chat", {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                              body: JSON.stringify({
                                book_id: "",
                                context_type: "write",
                                model: quickModel,
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
                                  // 剥掉 AI 附带的 JSON action（write 上下文的结构化输出残留），提取纯创意
                                  const jsonContent = ac.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                                  const noJson = ac.replace(/\{[\s\S]*"action"[\s\S]*\}/g, "").trim();
                                  const idea = (jsonContent?.[1]?.replace(/\\n/g, "\n").trim() || noJson).trim();
                                  if (idea) setQuickPremise(idea);
                                }
                              }
                            }
                          } catch { /* 忽略 */ }
                          setInspireLoading(false);
                        }}>
                        {inspireLoading ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Sparkles className="size-3 mr-1" />}
                        {inspireLoading ? "生成中..." : "随机灵感"}
                      </Button>
                    )}
                    <Button variant="outline" onClick={async () => {
                      if (!quickPremise.trim()) { toast({ title: "请先输入想法", variant: "destructive" }); return; }
                      setQuickGuiding(true);
                      localStorage.setItem("muse_guide_premise", quickPremise);
                      guideGotContent.current = false;
                      // 先创建引导会话
                      try {
                        const r = await fetch("/api/ai/chat-sessions", {
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
                        fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ messages: initMsgs }),
                        }).catch(() => {});
                      }
                      // 再存一个占位 AI 消息，恢复时可检测中断的生成
                      const sentinelMsgs = [...initMsgs, { role: "assistant", content: "（生成中...）" }];
                      if (guideSessionRef.current) {
                        fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ messages: sentinelMsgs }),
                        }).catch(() => {});
                      }
                      setQuickGuideMsgs(sentinelMsgs);
                      setQuickGuideLoading(true);
                      fetch("/api/ai/chat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({
                          book_id: "",
                          context_type: "write",
                          model: quickModel,
                          message: initMsg,
                          messages: [{ role: "user", content: initMsg }],
                          guide_mode: true,
                          guide_context: quickPremise || localStorage.getItem("muse_guide_premise"),
                          guide_type: quickType,
                        }),
                        signal: AbortSignal.timeout(120000),
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
                            fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
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
                        toast({ title: err?.message || "请求失败", variant: "destructive" });
                        setQuickGuiding(false);
                      }).finally(() => {
                        if (guideInitSaveRef.current) { clearInterval(guideInitSaveRef.current); guideInitSaveRef.current = null; }
                        guideStreamAcRef.current = "";
                        setQuickGuideLoading(false);
                        setQuickGuideMsgs((prev) => {
                          if (!guideGotContent.current) prev = [...prev, { role: "assistant", content: "（AI 未响应，请重试）" }];
                          if (guideSessionRef.current) {
                            fetch(`/api/ai/chat-sessions/${guideSessionRef.current}/messages`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
                              body: JSON.stringify({ messages: prev }),
                            }).catch(() => {});
                          }
                          return prev;
                        });
                      });
                    }} disabled={quickGenerating || !quickPremise.trim()}>
                      <Sparkles className="size-4 mr-1" />AI 引导
                    </Button>
                    <Button onClick={() => doQuickCreate(quickPremise, quickType)} disabled={quickGenerating || !quickPremise.trim()}>
                      {quickGenerating && <Loader2 className="size-4 animate-spin mr-1" />}
                      {quickGenerating ? "生成中..." : "直接生成"}
                    </Button>
                  </div>
                  )}
                </div>
              )}

              {/* ===== 阶段 2：引导聊天 ===== */}
              {quickGuiding && (
                <>
                  <div ref={guideChatRef} onScroll={handleGuideScroll} className="flex-1 overflow-y-auto space-y-3 min-h-0 border rounded-lg p-3 bg-muted/20">
                    {quickGuideMsgs.map((m, i) => (
                      <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                        <div className={cn(
                          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                          m.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card border border-border text-foreground",
                        )}>
                          {m.content || (i === quickGuideMsgs.length - 1 && quickGuideLoading ? "思考中..." : "")}
                        </div>
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
                    <Button size="sm" onClick={sendGuideMsg} disabled={quickGuideLoading || !quickGuideInput.trim()}>
                      <Send className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={async () => {
                      // 先向 AI 发送"开始生成"，获取结构化创作摘要
                      setQuickGuideLoading(true);
                      const finalMsg = "开始生成，请输出创作摘要";
                      const finalMsgs = [...quickGuideMsgs, { role: "user", content: finalMsg }];
                      setQuickGuideMsgs(finalMsgs);
                      const token = localStorage.getItem("token");
                      let summary = "";
                      try {
                        const res = await fetch("/api/ai/chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                            book_id: "",
                            context_type: "write",
                            model: quickModel,
                            message: finalMsg,
                            messages: finalMsgs.map(m => ({ role: m.role, content: m.content })),
                            guide_mode: true,
                            guide_context: quickPremise || localStorage.getItem("muse_guide_premise"),
                            guide_type: quickType,
                          }),
                          signal: AbortSignal.timeout(120000),
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
                        summary = ac;
                        // 摘要流结束，立即保存
                        setQuickGuideMsgs((prev) => {
                                                    return prev;
                        });
                      } catch (err: any) {
                        toast({ title: "获取摘要失败: " + (err?.message || "未知错误"), variant: "destructive" });
                        setQuickGuideLoading(false);
                        return;
                      }
                      setQuickGuideLoading(false);
                      // 构建完整对话日志作为参考附录
                      const fullLog = quickGuideMsgs
                        .filter(m => m.role === "user" || m.role === "assistant")
                        .map(m => `${m.role === "user" ? "作者" : "AI"}: ${m.content}`)
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
