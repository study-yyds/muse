import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, Loader2, ChevronLeft, ChevronRight, Copy, Check } from "lucide-react";

interface Props {
  bookId: string;
  chapterId: string;
  editorContent: string;
  onInsert: (text: string) => void;
}

interface Version {
  index: number;
  content: string;
}

export function AIGeneratePanel({ bookId, chapterId, editorContent, onInsert }: Props) {
  const { toast } = useToast();

  const [mode, setMode] = useState<"continue" | "rewrite">("continue");
  const [instruction, setInstruction] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const generate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    setExpanded(true);
    setVersions([]);

    // TODO: 接入后端 AI SSE 流式 API
    // 当前为模拟数据
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
      setIsGenerating(false);
      toast({ title: "已生成 3 个版本" });
    }, 1500);
  };

  const adopt = () => {
    const v = versions[currentVersion];
    if (v) {
      onInsert(v.content);
      setVersions([]);
      setExpanded(false);
      setInstruction("");
      toast({ title: "已插入正文" });
    }
  };

  const rejectAll = () => {
    setVersions([]);
    setExpanded(false);
  };

  return (
    <div className="bg-card">
      {/* 折叠条 */}
      {!expanded && (
        <div className="flex items-center gap-2 px-4 py-2">
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
          <Textarea
            rows={1}
            placeholder={mode === "continue" ? "续写方向（可选）..." : "改写指令（可选）..."}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className="flex-1 resize-none text-sm h-8 py-1"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                generate();
              }
            }}
          />
          <Button
            size="sm"
            onClick={generate}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            生成
          </Button>
        </div>
      )}

      {/* 展开的生成结果 */}
      {expanded && (
        <div className="border-t border-border">
          {/* 头部 */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <span className="text-sm font-medium">AI 生成结果</span>
              <span className="text-xs text-muted-foreground">
                {currentVersion + 1} / {versions.length}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {isGenerating && (
                <span className="text-xs text-muted-foreground mr-2">生成中...</span>
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

          {/* 内容预览 */}
          <div className="px-4 py-3 max-h-48 overflow-y-auto">
            {isGenerating && versions.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">正在生成...</span>
              </div>
            ) : versions[currentVersion] ? (
              <pre className="text-sm text-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {versions[currentVersion].content}
              </pre>
            ) : null}
          </div>

          {/* 操作按钮 */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border">
            <div className="flex gap-2">
              <Button size="sm" onClick={adopt} disabled={isGenerating || versions.length === 0}>
                <Check className="size-4" />
                采纳当前版本
              </Button>
              <Button size="sm" variant="outline" onClick={rejectAll} disabled={isGenerating}>
                全部拒绝
              </Button>
            </div>
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
