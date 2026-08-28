import { authFetch } from "@/services/api";
import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useEditorStore } from '@/stores/editor';
import { Loader2, Sparkles, Play, Download, Check, Video, Pencil, Upload, FileVideo, Volume2 } from 'lucide-react';

const VOICES: Array<{ group: string; options: Array<{ id: string; label: string }> }> = [
  {
    group: '通用',
    options: [
      { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0（清亮女声，默认）' },
      { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0（多语种女声）' },
      { id: 'zh_male_m191_uranus_bigtts', label: '云舟 2.0（沉稳男声）' },
      { id: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0（阳光男声）' },
      { id: 'zh_male_liufei_uranus_bigtts', label: '刘飞 2.0' },
      { id: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲 2.0' },
      { id: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声 2.0' },
      { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源 2.0' },
      { id: 'zh_female_tianmeitaozi_uranus_bigtts', label: '甜美桃子 2.0' },
      { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 2.0' },
      { id: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩 2.0' },
      { id: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年梓辛 2.0' },
      { id: 'zh_female_meilinvyou_uranus_bigtts', label: '魅力女友 2.0' },
      { id: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声 2.0（长文朗读）' },
      { id: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰 2.0' },
    ],
  },
  {
    group: '悬疑解说',
    options: [
      { id: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说 2.0（抖音同款）' },
      { id: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说男声 2.0' },
      { id: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客 2.0' },
      { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', label: '解说小明 2.0' },
      { id: 'zh_male_yizhipiannan_uranus_bigtts', label: '译制片男 2.0' },
      { id: 'zh_male_silang_uranus_bigtts', label: '四郎 2.0' },
    ],
  },
  {
    group: '番茄小说同款',
    options: [
      { id: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年 2.0' },
      { id: 'zh_male_baqiqingshu_uranus_bigtts', label: '霸气青叔 2.0' },
      { id: 'zh_male_qingcang_uranus_bigtts', label: '擎苍 2.0' },
      { id: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女 2.0' },
      { id: 'zh_male_linjiananhai_uranus_bigtts', label: '邻家男孩 2.0' },
      { id: 'zh_male_wennuanahu_uranus_bigtts', label: '温暖阿虎 2.0' },
      { id: 'zh_female_wenroumama_uranus_bigtts', label: '温柔妈妈 2.0' },
      { id: 'zh_female_qiaopinv_uranus_bigtts', label: '俏皮女声 2.0' },
      { id: 'zh_female_zhishuaiyingzi_uranus_bigtts', label: '直率英子 2.0' },
      { id: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本 2.0' },
    ],
  },
  {
    group: '角色扮演',
    options: [
      { id: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 2.0' },
      { id: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹 2.0' },
      { id: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐 2.0' },
      { id: 'zh_male_aojiaobazong_uranus_bigtts', label: '傲娇霸总 2.0' },
      { id: 'zh_female_popo_uranus_bigtts', label: '婆婆 2.0' },
      { id: 'zh_male_lanyinmianbao_uranus_bigtts', label: '懒音绵宝 2.0' },
      { id: 'zh_male_fanjuanqingnian_uranus_bigtts', label: '反卷青年 2.0' },
      { id: 'zh_female_peiqi_uranus_bigtts', label: '佩奇猪 2.0（卡通）' },
      { id: 'zh_female_mizai_uranus_bigtts', label: '黑猫侦探社咪仔 2.0' },
      { id: 'zh_female_tvbnv_uranus_bigtts', label: 'TVB女声 2.0' },
      { id: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥 2.0（孙悟空）' },
      { id: 'zh_male_xionger_uranus_bigtts', label: '熊二 2.0' },
      { id: 'zh_female_yingtaowanzi_uranus_bigtts', label: '樱桃丸子 2.0' },
      { id: 'zh_male_naiqimengwa_uranus_bigtts', label: '奶气萌娃 2.0' },
      { id: 'zh_male_dayi_uranus_bigtts', label: '大壹 2.0' },
      { id: 'zh_female_jitangnv_uranus_bigtts', label: '鸡汤女 2.0' },
    ],
  },
  {
    group: 'ICL 角色扮演（抖音同款）',
    options: [
      { id: 'ICL_uranus_zh_female_aojiaonvyou_tob', label: '傲娇女友 2.0' },
      { id: 'ICL_uranus_zh_female_xiemeinvwang_tob', label: '邪魅女王 2.0' },
      { id: 'ICL_uranus_zh_female_bingjiaojiejie_tob', label: '病娇姐姐 2.0' },
      { id: 'ICL_uranus_zh_female_chengshuwenrou_tob', label: '成熟温柔 2.0' },
      { id: 'ICL_uranus_zh_female_chunzhenshaonv_tob', label: '纯真少女 2.0' },
      { id: 'ICL_uranus_zh_female_wumeikeren_tob', label: '妩媚可人 2.0' },
      { id: 'ICL_uranus_zh_female_guaiqiaokeer_tob', label: '乖巧可儿 2.0' },
      { id: 'ICL_uranus_zh_female_heainainai_tob', label: '和蔼奶奶 2.0' },
      { id: 'ICL_uranus_zh_female_huopodiaoman_tob', label: '活泼刁蛮 2.0' },
      { id: 'ICL_uranus_zh_female_huoponvhai_tob', label: '活泼女孩 2.0' },
      { id: 'ICL_uranus_zh_female_jiaoruoluoli_tob', label: '娇弱萝莉 2.0' },
      { id: 'ICL_uranus_zh_female_jiaxiaozi_tob', label: '假小子 2.0' },
      { id: 'ICL_uranus_zh_female_kailangtingting_tob', label: '开朗婷婷 2.0' },
      { id: 'ICL_uranus_zh_female_kaixinxiaohong_tob', label: '开心小鸿 2.0' },
      { id: 'ICL_uranus_zh_female_keainvsheng_tob', label: '可爱女生 2.0' },
      { id: 'ICL_uranus_zh_female_lingdongxinxin_tob', label: '灵动欣欣 2.0' },
      { id: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', label: '甜美娇俏 2.0' },
      { id: 'ICL_uranus_zh_female_qinglenggaoya_tob', label: '清冷高雅 2.0' },
      { id: 'ICL_uranus_zh_female_lixingyuanzi_tob', label: '理性圆子 2.0' },
      { id: 'ICL_uranus_zh_female_xingganmeihuo_tob', label: '性感魅惑 2.0' },
      { id: 'ICL_uranus_zh_female_nuanxinxixi_tob', label: '暖心茜茜 2.0' },
      { id: 'ICL_uranus_zh_male_ruyajunzi_tob', label: '儒雅君子 2.0' },
    ],
  },
  {
    group: '古风 / 活力',
    options: [
      { id: 'zh_female_gufengshaoyu_uranus_bigtts', label: '古风少御 2.0' },
      { id: 'zh_male_huolixiaoge_uranus_bigtts', label: '活力小哥 2.0' },
      { id: 'zh_female_jitangmei_uranus_bigtts', label: '鸡汤妹妹 2.0' },
      { id: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声 2.0（客服）' },
      { id: 'ICL_uranus_zh_female_kefuwanjun_tob', label: '客服婉君 2.0' },
      { id: 'zh_female_yingyujiaoxue_uranus_bigtts', label: 'Tina老师 2.0（中英）' },
    ],
  },
  {
    group: '多语种（英文）',
    options: [
      { id: 'en_male_tim_uranus_bigtts', label: 'Tim（美式英语男声）' },
      { id: 'en_female_dacey_uranus_bigtts', label: 'Dacey（美式英语女声）' },
      { id: 'en_female_stokie_uranus_bigtts', label: 'Stokie（美式英语女声）' },
    ],
  },
];

interface Props {
  bookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PromoVideoDialog({ bookId, open, onOpenChange }: Props) {
  const { toast } = useToast();
  const selectedText = useEditorStore((s) => s.selectedText);
  const abortRef = useRef<AbortController | null>(null);

  const [stage, setStage] = useState<'input' | 'script' | 'rendering' | 'done'>('input');
  const [scriptLines, setScriptLines] = useState<string[]>([]);
  const [editableScript, setEditableScript] = useState('');
  const [voiceType, setVoiceType] = useState('zh_female_xiaohe_uranus_bigtts');
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<Array<{ step: string; label: string; status: string }>>([]);
  const [videoUrl, setVideoUrl] = useState('');
  const [packUrl, setPackUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'background' | 'pack'>('pack');
  const [backgroundUrl, setBackgroundUrl] = useState('');
  const [error, setError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // 打开时重置；关闭时取消进行中的生成和上传
  useEffect(() => {
    if (open) {
      setStage('input');
      setScriptLines([]);
      setEditing(false);
      setEditableScript('');
      setSteps([]);
      setVideoUrl('');
      setPackUrl('');
      setError('');
      setLoading(false);
      setBackgroundUrl('');
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
    }
  }, [open]);

  const generateScript = async () => {
    if (!selectedText.trim()) return;
    setLoading(true);
    setError('');

    const token = localStorage.getItem('token');
    try {
      const res = await authFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          book_id: bookId,
          context_type: 'promo',
          message: `请将以下小说原文改写成推文脚本：\n\n${selectedText.slice(0, 2000)}`,
          messages: [{ role: 'user', content: `请将以下小说原文改写成推文脚本：\n\n${selectedText.slice(0, 2000)}` }],
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('无响应');

      const decoder = new TextDecoder();
      let buf = ''; let ac = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buf += decoder.decode(); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        let ev = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) { ev = line.slice(7); continue; }
          if (line.startsWith('data: ')) {
            try { if (ev === 'chunk') ac += JSON.parse(line.slice(6)); } catch { if (ev === 'chunk') ac += line.slice(6); }
          }
        }
        if (ac) {
          const lines = ac.split('\n').map((l: string) => l.trim()).filter(Boolean);
          setScriptLines(lines);
          setEditableScript(ac);
        }
      }

      const finalLines = ac.split('\n').map((l: string) => l.trim()).filter(Boolean);
      if (finalLines.length > 0) {
        setScriptLines(finalLines);
        setEditableScript(ac);
        setStage('script');
      } else {
        setError('AI 未生成有效脚本，请重试');
      }
    } catch (e: any) {
      setError(e.message || '生成失败');
    }
    setLoading(false);
  };

  const generateVideo = async () => {
    setLoading(true);
    setError('');
    setStage('rendering');
    setSteps([]);

    const controller = new AbortController();
    abortRef.current = controller;
    const token = localStorage.getItem('token');

    try {
      const text = editableScript || scriptLines.join('\n');
      const res = await authFetch(`/api/books/${bookId}/promo/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          script_text: text,
          voice_type: voiceType,
          mode,
          background_url: mode === 'background' ? backgroundUrl : undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('无响应');

      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) { buf += decoder.decode(); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('event: ')) {
            const eventType = lines[i].slice(7).trim();
            const dataLine = lines[i + 1];
            if (dataLine?.startsWith('data: ')) {
              let data: any = null;
              try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }

              if (eventType === 'error') {
                throw new Error(data?.message || '未知错误');
              }
              if (eventType === 'step') {
                setSteps((prev) => {
                  const idx = prev.findIndex((s) => s.step === data.step);
                  if (idx >= 0) {
                    const next = [...prev];
                    next[idx] = data;
                    return next;
                  }
                  return [...prev, data];
                });
              } else if (eventType === 'done') {
                setVideoUrl(data.videoUrl || '');
                setPackUrl(data.packUrl || '');
                setStage('done');
                toast({ title: data.packUrl ? '素材包已生成！' : '视频生成完成！' });
              }
            }
          }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError(e.message || '生成失败');
        setStage('script');
      }
    }
    setLoading(false);
    abortRef.current = null;
  };

  const downloadVideo = async () => {
    if (!videoUrl) return;
    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = 'promo.mp4';
    a.click();
  };

  const downloadPack = async () => {
    if (!packUrl) return;
    const a = document.createElement('a');
    a.href = packUrl;
    a.download = 'promo-pack.zip';
    a.click();
  };

  // 音色试听（服务端按音色缓存，同一音色只消耗一次 API 调用）
  const previewVoice = async () => {
    setPreviewLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await authFetch(
        `/api/books/${bookId}/promo/preview-voice?voice_type=${encodeURIComponent(voiceType)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code && json.code >= 400) {
        throw new Error(json.message || '试听失败');
      }
      audioRef.current?.pause();
      const audio = new Audio(json.data.url);
      audioRef.current = audio;
      audio.play().catch(() => {});
    } catch (e: any) {
      toast({ title: e.message || '试听失败', variant: 'destructive' });
    }
    setPreviewLoading(false);
  };

  // 上传解压视频背景（独立 uploading 状态，不触发弹窗关闭拦截；关闭弹窗时中止）
  const uploadBackground = async (file: File) => {
    if (file.size > 100 * 1024 * 1024) {
      toast({ title: '背景视频不能超过 100MB', variant: 'destructive' });
      return;
    }
    setUploading(true);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const token = localStorage.getItem('token');
    try {
      const form = new FormData();
      form.append('video', file);
      const res = await authFetch(`/api/books/${bookId}/promo/upload-background`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code && json.code >= 400) throw new Error(json.message || '上传失败');
      setBackgroundUrl(json.data.url);
      toast({ title: '背景视频已上传' });
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      toast({ title: e.message || '上传失败', variant: 'destructive' });
    }
    setUploading(false);
    uploadAbortRef.current = null;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 生成中不允许关闭（点空白/Esc/X 均拦截），避免进度丢失
        if (!next && loading) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="size-5 text-primary" />
            生成推文视频
          </DialogTitle>
          <DialogDescription>
            {stage === 'input' && '选择小说片段，AI 帮你改写成推文脚本'}
            {stage === 'script' && '编辑脚本文案，选择音色后生成视频'}
            {stage === 'rendering' && '正在生成视频...'}
            {stage === 'done' && '视频已生成，点击下载'}
          </DialogDescription>
        </DialogHeader>

        {/* Stage: Input */}
        {stage === 'input' && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">选中原文</label>
              <div className="mt-1 rounded border border-border bg-muted/20 p-3 text-sm max-h-32 overflow-y-auto whitespace-pre-wrap">
                {selectedText || '(请先在编辑器中选中文字)'}
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              onClick={generateScript}
              disabled={loading || !selectedText.trim()}
              className="w-full"
            >
              {loading ? <Loader2 className="size-4 animate-spin mr-1" /> : <Sparkles className="size-4 mr-1" />}
              AI 改写推文脚本
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const lines = selectedText.split('\n').filter((l) => l.trim());
                setScriptLines(lines);
                setEditableScript(selectedText);
                setStage('script');
              }}
              disabled={loading || !selectedText.trim()}
              className="w-full"
            >
              直接用原文配音
            </Button>
          </div>
        )}

        {/* Stage: Script editing */}
        {stage === 'script' && (
          <div className="flex flex-col flex-1 min-h-0 space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">推文脚本（{scriptLines.length} 句）</label>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setEditing(!editing)}
              >
                <Pencil className="size-3 mr-1" />
                {editing ? '预览' : '编辑脚本'}
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto rounded border border-border bg-muted/20">
              {editing ? (
                <Textarea
                  value={editableScript}
                  onChange={(e) => {
                    setEditableScript(e.target.value);
                    setScriptLines(e.target.value.split('\n').filter(Boolean));
                  }}
                  className="text-sm min-h-[200px] h-full resize-none border-0 bg-transparent focus-visible:ring-0 rounded-none"
                />
              ) : (
                <div className="min-h-[200px] p-3 text-sm leading-relaxed space-y-2">
                  {scriptLines.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              )}
            </div>
            {/* 固定在底部 */}
            <div className="shrink-0 space-y-3">
              {/* 音色仅解压背景模式需要（素材包不生成音频） */}
              {mode === 'background' && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium shrink-0">音色：</label>
                <select
                  value={voiceType}
                  onChange={(e) => setVoiceType(e.target.value)}
                  className="text-sm rounded border border-border bg-background px-2 py-1"
                >
                  {VOICES.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.options.map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={previewVoice}
                  disabled={previewLoading}
                  title="试听音色（同一音色只消耗一次调用）"
                >
                  {previewLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Volume2 className="size-3.5" />
                  )}
                  试听
                </Button>
              </div>
              )}
              {/* 输出模式选择 */}
              <div className="space-y-2">
                <label className="text-sm font-medium">输出模式：</label>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={mode === 'pack' ? 'default' : 'outline'}
                    onClick={() => setMode('pack')}
                    disabled={loading}
                    title="小说阅读式卡片图片 + 文案，zip 打包（不生成音频）"
                  >
                    素材包
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === 'background' ? 'default' : 'outline'}
                    onClick={() => setMode('background')}
                    disabled={loading}
                    title="上传解压视频作为背景，烧录配音和字幕"
                  >
                    解压背景
                  </Button>
                </div>
                {mode === 'background' && (
                  <label className="mt-1 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border py-4 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors">
                    <input
                      type="file"
                      accept="video/mp4"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadBackground(f);
                      }}
                      className="hidden"
                    />
                    {uploading ? (
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    ) : backgroundUrl ? (
                      <>
                        <FileVideo className="size-5 text-green-600" />
                        <span className="text-xs text-muted-foreground">
                          已上传：{backgroundUrl.split('/').pop()}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">
                          点击更换
                        </span>
                      </>
                    ) : (
                      <>
                        <Upload className="size-5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          点击上传解压视频（≤100MB）
                        </span>
                      </>
                    )}
                  </label>
                )}
                <p className="text-xs text-muted-foreground">
                  {mode === 'background' && '上传解压视频作为背景，烧录配音和字幕'}
                  {mode === 'pack' && '小说阅读式卡片图片 + 文案，zip 打包（不含音频）'}
                </p>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setStage('input'); setEditing(false); }} disabled={loading}>
                  返回
                </Button>
                <Button
                  onClick={generateVideo}
                  disabled={loading || uploading || !editableScript.trim() || (mode === 'background' && !backgroundUrl)}
                  className="flex-1"
                >
                  {loading ? <Loader2 className="size-4 animate-spin mr-1" /> : <Play className="size-4 mr-1" />}
                  {mode === 'pack' ? '生成素材包' : '生成视频'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Stage: Rendering */}
        {stage === 'rendering' && (
          <div className="space-y-2 py-4">
            {steps.map((s) => (
              <div key={s.step} className="flex items-center gap-2 text-sm">
                {s.status === 'done' ? (
                  <Check className="size-4 text-green-500 shrink-0" />
                ) : (
                  <Loader2 className="size-4 animate-spin text-primary shrink-0" />
                )}
                <span className={s.status === 'done' ? 'text-muted-foreground' : ''}>{s.label}</span>
              </div>
            ))}
            {steps.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在准备...
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => { abortRef.current?.abort(); setStage('script'); }}
            >
              取消
            </Button>
          </div>
        )}

        {/* Stage: Done */}
        {stage === 'done' && (
          <div className="space-y-4">
            {mode === 'pack' ? (
              <div className="text-center text-sm text-muted-foreground py-4">
                素材包已生成：小说阅读式卡片 PNG + 文案 TXT（不含音频）
              </div>
            ) : videoUrl ? (
              <video src={videoUrl} controls className="w-full rounded-lg" style={{ aspectRatio: '9/16', maxHeight: '60vh' }} />
            ) : (
              <div className="text-center text-sm text-muted-foreground py-4">
                视频渲染失败，已生成配音音频
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStage('script')}>
                重新生成
              </Button>
              {mode === 'pack' ? (
                <Button onClick={downloadPack} className="flex-1" disabled={!packUrl}>
                  <Download className="size-4 mr-1" />
                  下载素材包 (zip)
                </Button>
              ) : (
                <Button onClick={downloadVideo} className="flex-1" disabled={!videoUrl}>
                  <Download className="size-4 mr-1" />
                  下载 MP4
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
