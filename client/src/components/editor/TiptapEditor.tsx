import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useEditorStore } from "@/stores/editor";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  Minus,
} from "lucide-react";

interface Props {
  content: string;
  onChange: (text: string) => void;
  placeholder?: string;
}

function getPlainText(editor: ReturnType<typeof useEditor>): string {
  if (!editor) return "";
  return editor.getText();
}

function getCursorTextOffset(editor: ReturnType<typeof useEditor>): number {
  if (!editor) return 0;
  const { from } = editor.state.selection;
  // 用 \n 作为块分隔符，与 getText() 保持一致，否则多段落文档偏移会错位
  return editor.state.doc.textBetween(0, from, '\n').length;
}

/** 文本偏移 → Tiptap 文档位置（与 getCursorTextOffset 相同分隔符约定，二分查找保证一致） */
function textOffsetToDocPos(editor: ReturnType<typeof useEditor>, offset: number): number {
  if (!editor) return 0;
  const doc = editor.state.doc;
  if (offset <= 0) return 0;
  const size = doc.content.size;
  if (offset >= doc.textBetween(0, size, '\n').length) return size;
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.textBetween(0, mid, '\n').length < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function TiptapEditor({ content, onChange, placeholder }: Props) {
  const isInternalChange = useRef(false);
  const { toast } = useToast();

  // 将纯文本转为 HTML 段落（每个 \n 分隔的块 → <p>）。
  // 保存侧 getText() 段落间是 "\n\n"，若按 \n 直拆会生成空 <p>（刷新后多空行）；
  // 这里折叠连续空行：单个空行保留（短篇分节），双空行折叠（消除多余空行）
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const textToHtml = (text: string) => {
    const parts = text.split('\n');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '' && out[out.length - 1] === '') continue; // 连续空行折叠为单个
      out.push(p);
    }
    return out.map(p => `<p>${escapeHtml(p)}</p>`).join('');
  };

  const isStructured = (content || '').trimStart().startsWith('{"type"') || (content || '').trimStart().startsWith('<p');
  const initialContent = isStructured ? content : textToHtml(content);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? "开始写作..." }),
    ],
    content: initialContent,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class:
          "outline-none min-h-[300px] px-4 py-3 text-base leading-relaxed text-foreground max-w-full overflow-x-auto break-words",
      },
      // 粘贴格式清理：只保留纯文本（Word/网页带来的颜色、字体、加粗等全部丢弃），
      // 按行拆分为段落，与编辑器纯文本 + 段落模型保持一致
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text == null) return false;
        event.preventDefault();
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        const tr = view.state.tr;
        const sel = view.state.selection;
        let pos = sel.from;
        if (!sel.empty) {
          tr.delete(sel.from, sel.to);
          pos = sel.from;
        }
        for (let i = 0; i < lines.length; i++) {
          tr.insertText(lines[i], pos);
          pos += lines[i].length;
          if (i < lines.length - 1) {
            // 换行：拆分为新段落，mapping 映射新文档位置
            tr.split(pos);
            pos = tr.mapping.map(pos);
          }
        }
        view.dispatch(tr);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const text = getPlainText(editor);
      isInternalChange.current = true;
      onChange(text);
      useEditorStore.getState().setContent(text);
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      const textOffset = getCursorTextOffset(editor);
      useEditorStore.getState().setCursor(textOffset);
      const selectedText = editor.state.doc.textBetween(from, to, '\n');
      if (selectedText) {
        useEditorStore.getState().setSelection(selectedText, textOffset);
        useEditorStore.getState().setAiRewrite(selectedText, textOffset, textOffset + selectedText.length, from, to);
      } else {
        // 选区折叠（点击别处）时清除改写上下文，防止误替换旧选中文本
        useEditorStore.getState().clearSelection();
        useEditorStore.getState().clearAiRewrite();
      }
    },
  });

  // 外部内容变更时同步编辑器
  useEffect(() => {
    if (!editor) return;
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }
    const currentText = getPlainText(editor);
    if (content !== currentText) {
      const isStructured = (content || '').trimStart().startsWith('{"type"') || (content || '').trimStart().startsWith('<p');
      editor.commands.setContent(isStructured ? content : textToHtml(content));
    }
  }, [content, editor]);

  // AI 面板请求
  const pendingInsert = useEditorStore((s) => s.pendingInsert);
  const pendingReplace = useEditorStore((s) => s.pendingReplace);
  const clearPendingInsert = useEditorStore((s) => s.clearPendingInsert);
  const activeChapterId = useEditorStore((s) => s.activeChapterId);

  useEffect(() => {
    if (!editor) return;
    // 章节校验：请求发起后用户可能切换了章节，此时不执行插入/替换
    const chapterMismatch =
      (pendingReplace && pendingReplace.chapterId != null && pendingReplace.chapterId !== activeChapterId) ||
      (pendingInsert && pendingInsert.chapterId != null && pendingInsert.chapterId !== activeChapterId);
    if (chapterMismatch) {
      toast({ title: "该 AI 内容属于其他章节，已忽略", variant: "destructive" });
      clearPendingInsert();
      return;
    }
    if (pendingReplace) {
      const { newText, tiptapFrom, tiptapTo, oldText } = pendingReplace;
      let from = tiptapFrom;
      let to = tiptapTo;
      if (from == null || to == null || editor.state.doc.textBetween(from, to, '\n') !== oldText) {
        // 坐标失效时按文本内容回退查找（与 getCursorTextOffset 相同的 \n 分隔约定）
        const plainText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
        const idx = plainText.indexOf(oldText);
        if (idx === -1) { clearPendingInsert(); return; }
        from = textOffsetToDocPos(editor, idx);
        to = textOffsetToDocPos(editor, idx + oldText.length);
      }
      if (from != null && to != null) {
        editor.chain().focus().setTextSelection({ from, to }).insertContent(newText).run();
      }
      clearPendingInsert();
      return;
    }
    if (pendingInsert != null) {
      // 插入到请求发起时的光标位置，而不是当前光标
      const pos = textOffsetToDocPos(editor, pendingInsert.textOffset);
      editor.chain().focus().setTextSelection(pos).insertContent(pendingInsert.text).run();
      clearPendingInsert();
    }
  }, [pendingInsert, pendingReplace, editor, clearPendingInsert, activeChapterId, toast]);

  if (!editor) return null;

  const a = (name: string, attrs?: Record<string, any>) => editor.isActive(name, attrs ?? {});

  const tools = [
    { icon: Bold, label: "加粗", active: a("bold"), cmd: () => editor.chain().focus().toggleBold().run() },
    { icon: Italic, label: "斜体", active: a("italic"), cmd: () => editor.chain().focus().toggleItalic().run() },
    { icon: Heading1, label: "一级标题", active: a("heading", { level: 1 }), cmd: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { icon: Heading2, label: "二级标题", active: a("heading", { level: 2 }), cmd: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { icon: Heading3, label: "三级标题", active: a("heading", { level: 3 }), cmd: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { icon: Quote, label: "引用", active: a("blockquote"), cmd: () => editor.chain().focus().toggleBlockquote().run() },
    { icon: Minus, label: "分隔线", active: false, cmd: () => editor.chain().focus().setHorizontalRule().run() },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden tiptap-editor">
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/30">
        {tools.map((t) => (
          <Button
            key={t.label}
            variant={t.active ? "secondary" : "ghost"}
            size="icon-xs"
            type="button"
            title={t.label}
            onMouseDown={(e) => {
              e.preventDefault();
              t.cmd();
            }}
            className={cn("rounded", t.active && "bg-primary/15 text-primary")}
          >
            <t.icon className="size-3.5" />
          </Button>
        ))}
      </div>
      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:px-4 [&_.ProseMirror]:py-3"
      />
      {/* ProseMirror 内容样式（替代 Tailwind Typography） */}
      <style>{`
        .tiptap-editor .ProseMirror h1 { font-size: 1.5rem; font-weight: 700; line-height: 1.3; margin: 1rem 0 0.5rem; }
        .tiptap-editor .ProseMirror h2 { font-size: 1.25rem; font-weight: 600; line-height: 1.35; margin: 0.75rem 0 0.5rem; }
        .tiptap-editor .ProseMirror h3 { font-size: 1.1rem; font-weight: 600; line-height: 1.4; margin: 0.5rem 0 0.25rem; }
        .tiptap-editor .ProseMirror blockquote { border-left: 3px solid hsl(var(--primary)/0.4); padding-left: 1rem; margin: 0.5rem 0; color: hsl(var(--muted-foreground)); font-style: italic; }
        .tiptap-editor .ProseMirror hr { border: none; border-top: 1px solid hsl(var(--border)); margin: 1.5rem 0; text-align: center; }
        .tiptap-editor .ProseMirror hr::after { content: "*  *  *"; display: inline-block; position: relative; top: -0.75em; padding: 0 0.5em; background: hsl(var(--background)); color: hsl(var(--muted-foreground)); font-size: 0.85rem; }
        .tiptap-editor .ProseMirror ul { list-style: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
        .tiptap-editor .ProseMirror ol { list-style: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
        .tiptap-editor .ProseMirror li { margin: 0.125rem 0; }
        .tiptap-editor .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: hsl(var(--muted-foreground)); pointer-events: none; float: left; height: 0; }
        .tiptap-editor .ProseMirror p { margin: 0.25rem 0; }
      `}</style>
    </div>
  );
}
