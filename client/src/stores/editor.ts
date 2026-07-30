import { create } from "zustand";

interface EditorState {
  activeChapterId: string | null;
  editorContent: string;
  cursorPosition: number;
  selectedText: string;
  aiRewriteContext: string;
  setActiveChapter: (id: string | null) => void;
  setContent: (content: string) => void;
  setCursor: (pos: number) => void;
  setSelection: (text: string, pos: number) => void;
  clearSelection: () => void;
  setAiRewrite: (text: string) => void;
  clearAiRewrite: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  activeChapterId: null,
  editorContent: "",
  cursorPosition: 0,
  selectedText: "",
  setActiveChapter: (id) => set({ activeChapterId: id, editorContent: "", cursorPosition: 0, selectedText: "" }),
  setContent: (content) => set({ editorContent: content }),
  setCursor: (pos) => set({ cursorPosition: pos }),
  setSelection: (text, pos) => set({ selectedText: text, cursorPosition: pos }),
  clearSelection: () => set({ selectedText: "" }),
  aiRewriteContext: "", // AI 面板的改写上下文（选中文本）
  setAiRewrite: (text: string) => set({ aiRewriteContext: text }),
  clearAiRewrite: () => set({ aiRewriteContext: "" }),
}));
