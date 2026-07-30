/**
 * AIGeneratePanel — AI 辅助续写/改写底部面板
 * 提供双模式（续写/改写）、多版本预览、采纳与拒绝操作
 * 当前使用模拟数据，标注 TODO 处将接入后端 SSE API
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, Loader2, ChevronLeft, ChevronRight, Check } from "lucide-react";

// 组件 Props：接收作品 ID、章节 ID、编辑器内容和插入回调
interface Props {
  bookId: string; // 当前作品 ID（预留：AI 上下文用）
  chapterId: string; // 当前章节 ID（预留：定位续写位置）
  editorContent: string; // 编辑器当前内容（预留：改写选中文
  onInsert: (text: string) => void; // 采纳后回调：将 AI 文本插入编辑器
}

// AI 生成的版本数据结构
interface Version {
  index: number; // 版本编号（0/1/2）
  content: string; // 版本内容
}

export function AIGeneratePanel({
  bookId: _bookId, // 预留，AI 接入时用于构建上下文
  chapterId: _chapterId, // 预留，AI 接入时用于定位续写位置
  editorContent: _editorContent, // 预留，AI 接入时用于改写模式
  onInsert, // 采纳后的回调函数
}: Props) {
  // Toast 通知 hook
  const { toast } = useToast();

  // 生成模式：continue（续写）或 rewrite（改写）
  const [mode, setMode] = useState<"continue" | "rewrite">("continue");

  // 用户输入的指令文本（续写方向/改写要求）
  const [instruction, setInstruction] = useState("");

  // 是否正在生成中（控制 loading 状态）
  const [isGenerating, setIsGenerating] = useState(false);

  // 已生成的版本列表（最多 3 个）
  const [versions, setVersions] = useState<Version[]>([]);

  // 当前预览的版本索引（0-based）
  const [currentVersion, setCurrentVersion] = useState(0);

  // 是否展开 AI 生成结果面板
  const [expanded, setExpanded] = useState(false);

  // ============ AI 生成逻辑 ============

  // 触发 AI 生成：调用后端 SSE API（当前为模拟数据）
  const generate = async () => {
    if (isGenerating) return; // 防止重复点击
    setIsGenerating(true);
    setExpanded(true); // 展开结果面板
    setVersions([]); // 清空旧版本

    // TODO: 接入后端 AI SSE 流式 API（POST /api/ai/generate）
    // 当前为模拟数据，展示 3 个不同版本的续写示例
    setTimeout(() => {
      setVersions([
        {
          index: 0,
          content:
            "\n\n（AI 续写版本 1）夜色如墨，林渊独自站在废墟之上。远处传来低沉的风声，空气中弥漫着若有若无的血腥气。他知道，那场追杀还远没有结束。\n\n",
        },
        {
          index: 1,
          content:
            "\n\n（AI 续写版本 2）当林渊睁开眼睛时，月光正好洒在废墟的残垣断壁上。他轻轻吐出一口浊气，体内的真气已经恢复了大半。那只神秘的玉佩在他掌心微微发烫。\n\n",
        },
        {
          index: 2,
          content:
            "\n\n（AI 续写版本 3）夜风凛冽，林渊的身影在废墟中显得格外单薄。他回望身后的断壁残垣，心中闪过一丝悲凉。然而远处的脚步声打断了他的思绪——追兵已至。\n\n",
        },
      ]);
      setIsGenerating(false); // 生成完成，解除 loading
      toast({ title: "已生成 3 个版本" });
    }, 1500);
  };

  // ============ 用户操作 ============

  // 采纳当前选中的版本：将内容插入编辑器，关闭面板
  const adopt = () => {
    const v = versions[currentVersion];
    if (v) {
      onInsert(v.content); // 回调：将文本插入编辑器光标位置
      setVersions([]); // 清空版本列表
      setExpanded(false); // 收起面板
      setInstruction(""); // 清空指令输入
      toast({ title: "已插入正文" });
    }
  };

  // 拒绝所有版本：清空并关闭面板
  const rejectAll = () => {
    setVersions([]);
    setExpanded(false);
  };

  // ============ 渲染 ============

  return (
    <div className="bg-card">
      {/* ---- 折叠状态：底部 AI 工具条 ---- */}
      {!expanded && (
        <div className="flex items-center gap-2 px-4 py-2">
          {/* 模式切换按钮组 */}
          <div className="flex gap-1">
            <Button
              variant={mode === "continue" ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setMode("continue")}
            >
              续写
            </Button>
            <Button
              variant={mode === "rewrite" ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setMode("rewrite")}
            >
              改写
            </Button>
          </div>

          {/* 指令输入框：续写方向或改写要求 */}
          <Textarea
            rows={1}
            placeholder={
              mode === "continue" ? "续写方向（可选）..." : "改写指令（可选）..."
            }
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className="flex-1 resize-none text-sm h-8 py-1"
            onKeyDown={(e) => {
              // Enter 键发送，Shift+Enter 换行
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                generate();
              }
            }}
          />

          {/* 生成按钮 */}
          <Button size="sm" onClick={generate} disabled={isGenerating}>
            {isGenerating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            生成
          </Button>
        </div>
      )}

      {/* ---- 展开状态：AI 生成结果面板 ---- */}
      {expanded && (
        <div className="border-t border-border">
          {/* 顶部：版本导航栏 */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <span className="text-sm font-medium">AI 生成结果</span>
              <span className="text-xs text-muted-foreground">
                {currentVersion + 1} / {versions.length}
              </span>
            </div>
            {/* 版本翻页按钮 */}
            <div className="flex items-center gap-1">
              {isGenerating && (
                <span className="text-xs text-muted-foreground mr-2">
                  生成中...
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() =>
                  setCurrentVersion((v) => Math.max(0, v - 1))
                }
                disabled={currentVersion === 0 || isGenerating}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() =>
                  setCurrentVersion((v) =>
                    Math.min(versions.length - 1, v + 1)
                  )
                }
                disabled={currentVersion >= versions.length - 1 || isGenerating}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>

          {/* 中间：版本内容预览区 */}
          <div className="px-4 py-3 max-h-48 overflow-y-auto">
            {isGenerating && versions.length === 0 ? (
              // 初始加载状态
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  正在生成...
                </span>
              </div>
            ) : versions[currentVersion] ? (
              // 显示当前版本的文本内容
              <pre className="text-sm text-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {versions[currentVersion].content}
              </pre>
            ) : null}
          </div>

          {/* 底部：操作按钮栏 */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border">
            <div className="flex gap-2">
              {/* 采纳按钮：将当前版本插入编辑器 */}
              <Button
                size="sm"
                onClick={adopt}
                disabled={isGenerating || versions.length === 0}
              >
                <Check className="size-4" />
                采纳当前版本
              </Button>
              {/* 拒绝按钮：丢弃所有版本 */}
              <Button
                size="sm"
                variant="outline"
                onClick={rejectAll}
                disabled={isGenerating}
              >
                全部拒绝
              </Button>
            </div>
            {/* 收起按钮：折叠回工具条 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(false)}
            >
              收起
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
