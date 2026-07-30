import { create } from "zustand";

interface RewriteContext {
  text: string;
  start: number;
  end: number;
}

interface EditorState {
  activeChapterId: string | null;
  editorContent: string;
  cursorPosition: number;
  selectedText: string;
  pendingInsert: string | null;
  // 改写请求：携带原文本 + 精确位置（避免多处匹配时替换错误）
  pendingReplace: { oldText: string; newText: string; start: number; end: number } | null;
  // 改写上下文：用户在编辑器中选中的文本 + 精确选区位置
  aiRewriteContext: RewriteContext | null;
  setActiveChapter: (id: string | null) => void;
  setContent: (content: string) => void;
  setCursor: (pos: number) => void;
  setSelection: (text: string, pos: number) => void;
  clearSelection: () => void;
  requestInsert: (text: string) => void;
  requestReplace: (oldText: string, newText: string, start: number, end: number) => void;
  clearPendingInsert: () => void;
  setAiRewrite: (text: string, start: number, end: number) => void;
  clearAiRewrite: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  activeChapterId: null,
  editorContent: "",
  cursorPosition: 0,
  selectedText: "",
  pendingInsert: null,
  pendingReplace: null,
  aiRewriteContext: null,
  setActiveChapter: (id) => set({ activeChapterId: id, editorContent: "", cursorPosition: 0, selectedText: "" }),
  setContent: (content) => set({ editorContent: content }),
  setCursor: (pos) => set({ cursorPosition: pos }),
  setSelection: (text, pos) => set({ selectedText: text, cursorPosition: pos }),
  clearSelection: () => set({ selectedText: "" }),
  requestInsert: (text) => set({ pendingInsert: text }),
  requestReplace: (oldText, newText, start, end) => set({ pendingReplace: { oldText, newText, start, end } }),
  clearPendingInsert: () => set({ pendingInsert: null, pendingReplace: null }),
  setAiRewrite: (text: string, start: number, end: number) => set({ aiRewriteContext: { text, start, end } }),
  clearAiRewrite: () => set({ aiRewriteContext: null }),
}));
