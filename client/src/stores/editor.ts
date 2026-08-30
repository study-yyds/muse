import { create } from "zustand";

interface RewriteContext {
  text: string;
  start: number;
  end: number;
  // Tiptap 文档坐标（用于精确替换，仅 Tiptap 编辑器使用）
  tiptapFrom?: number;
  tiptapTo?: number;
}

interface PendingInsertRequest {
  text: string;
  // 发起请求时的章节与光标位置（防止采纳时插入到错误章节/位置）
  chapterId: string | null;
  textOffset: number;
  // 发起时间戳：编辑器超时未就绪则丢弃，防止陈旧的插入请求迟到生效
  at: number;
}

interface ChapterSwitchRequest {
  chapterId: string;
  at: number;
}

interface ReplaceRequest {
  oldText: string;
  newText: string;
  start: number;
  end: number;
  // Tiptap 文档坐标
  tiptapFrom?: number;
  tiptapTo?: number;
  // 发起请求时的章节（防止采纳时替换到错误章节）
  chapterId: string | null;
}

interface PendingRequestMeta {
  chapterId: string;
  cursorPosition: number;
}

interface EditorState {
  activeChapterId: string | null;
  editorContent: string;
  cursorPosition: number;
  selectedText: string;
  pendingInsert: PendingInsertRequest | null;
  // 一次性章节切换请求：AI 面板自动建章/切章时通知编辑器跟随，消费即清除
  chapterSwitch: ChapterSwitchRequest | null;
  // 改写请求：携带原文本 + 精确位置（避免多处匹配时替换错误）
  pendingReplace: ReplaceRequest | null;
  // 改写上下文：用户在编辑器中选中的文本 + 精确选区位置
  aiRewriteContext: RewriteContext | null;
  // 最近一次 AI 请求时的章节与光标位置（采纳时精确插入用）
  pendingRequest: PendingRequestMeta | null;
  setActiveChapter: (id: string | null) => void;
  requestChapterSwitch: (chapterId: string) => void;
  clearChapterSwitch: () => void;
  setContent: (content: string) => void;
  setCursor: (pos: number) => void;
  setSelection: (text: string, pos: number) => void;
  clearSelection: () => void;
  requestInsert: (text: string, chapterId?: string | null, textOffset?: number) => void;
  requestReplace: (oldText: string, newText: string, start: number, end: number, tiptapFrom?: number, tiptapTo?: number, chapterId?: string | null) => void;
  clearPendingInsert: () => void;
  setAiRewrite: (text: string, start: number, end: number, tiptapFrom?: number, tiptapTo?: number) => void;
  clearAiRewrite: () => void;
  setPendingRequest: (meta: PendingRequestMeta | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  activeChapterId: null,
  editorContent: "",
  cursorPosition: 0,
  selectedText: "",
  pendingInsert: null,
  chapterSwitch: null,
  pendingReplace: null,
  aiRewriteContext: null,
  pendingRequest: null,
  setActiveChapter: (id) => set({ activeChapterId: id, editorContent: "", cursorPosition: 0, selectedText: "" }),
  requestChapterSwitch: (chapterId) =>
    set({ chapterSwitch: { chapterId, at: Date.now() } }),
  clearChapterSwitch: () => set({ chapterSwitch: null }),
  setContent: (content) => set({ editorContent: content }),
  setCursor: (pos) => set({ cursorPosition: pos }),
  setSelection: (text, pos) => set({ selectedText: text, cursorPosition: pos }),
  clearSelection: () => set({ selectedText: "" }),
  requestInsert: (text, chapterId = null, textOffset = 0) =>
    set({ pendingInsert: { text, chapterId, textOffset, at: Date.now() } }),
  requestReplace: (oldText, newText, start, end, tiptapFrom?, tiptapTo?, chapterId = null) =>
    set({ pendingReplace: { oldText, newText, start, end, tiptapFrom, tiptapTo, chapterId } }),
  clearPendingInsert: () => set({ pendingInsert: null, pendingReplace: null }),
  setAiRewrite: (text: string, start: number, end: number, tiptapFrom?, tiptapTo?) =>
    set({ aiRewriteContext: { text, start, end, tiptapFrom, tiptapTo } }),
  clearAiRewrite: () => set({ aiRewriteContext: null }),
  setPendingRequest: (meta) => set({ pendingRequest: meta }),
}));
