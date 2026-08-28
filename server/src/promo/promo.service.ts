import { Injectable, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import path from 'path';
import { writeFile, mkdir, unlink, access } from 'fs/promises';
import crypto from 'crypto';
import { execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { AiService } from '../ai/ai.service';

const W = 1080;
const H = 1920;
const FONT_SIZE = 52;
const MAX_CHARS_PER_LINE = 14;
const LINE_HEIGHT = 70; // 行距
const PARA_GAP = 100; // 基础段距（行距 70 + 段间额外 30）
const MAX_SCRIPT_LINES = 200; // 脚本行数上限（每行一次 TTS/一张卡片，防资源耗尽）
const MAX_CARD_PAGES = 100; // 素材包页数上限（每页约 8MB 画布，防内存耗尽）

@Injectable()
export class PromoService {
  constructor(private readonly ai: AiService) {}

  /**
   * 音色试听：固定短文本合成一次，按音色磁盘缓存
   * 同一音色只消耗一次 API 调用，之后直接返回缓存音频 URL
   */
  async previewVoice(voiceType: string, userId: string): Promise<string> {
    const safeName = voiceType.replace(/[^a-zA-Z0-9_-]/g, '_') + '.mp3';
    const previewDir = path.join(
      __dirname,
      '..',
      '..',
      'public',
      'uploads',
      'voice-previews',
    );
    await mkdir(previewDir, { recursive: true });
    const filePath = path.join(previewDir, safeName);
    const url = `/uploads/voice-previews/${safeName}`;

    // 命中缓存：直接返回，零消耗
    try {
      await access(filePath);
      return url;
    } catch {
      // 未缓存，走合成
    }

    const base64 = await this.ai.synthesizeShortText(
      '你好，我是 Muse 创作助手，这是本音色的试听效果。',
      voiceType,
      userId,
    );
    await writeFile(filePath, Buffer.from(base64, 'base64'));
    return url;
  }

  async generatePromoVideo(
    res: Response,
    params: {
      scriptText: string;
      voiceType: string;
      userId: string;
      bookId: string;
      mode: 'background' | 'pack';
      backgroundUrl?: string;
    },
  ) {
    const send = (event: string, data: Record<string, any>) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    try {
      const rawLines = params.scriptText.split('\n').map((l) => l.trim());
      // 保留段前空行数（编辑器空行 → 卡片上对应空一行高度）
      const scriptLines: string[] = [];
      const blankBefore: number[] = [];
      let pending = 0;
      for (const l of rawLines) {
        if (l.length === 0) {
          pending++;
          continue;
        }
        scriptLines.push(l);
        blankBefore.push(pending);
        pending = 0;
      }

      if (scriptLines.length === 0) {
        send('error', { message: '脚本内容为空' });
        res.end();
        return;
      }

      // 行数上限：每行一次 TTS 调用 + 渲染资源，超限直接拒绝
      if (scriptLines.length > MAX_SCRIPT_LINES) {
        throw new Error(`脚本过长（最多 ${MAX_SCRIPT_LINES} 句），请分段生成`);
      }

      send('step', {
        step: 'script',
        status: 'done',
        label: `脚本已就绪（${scriptLines.length} 句）`,
      });

      // Step 1: 素材包模式不需要配音（只出卡片图）；解压背景需要 TTS
      let lineAudios: Array<{ url: string; durationSec: number }> = [];
      if (params.mode !== 'pack') {
        send('step', {
          step: 'tts',
          status: 'generating',
          label: `语音合成中（${scriptLines.length} 句）...`,
        });

        lineAudios = await this.ai.generateSpeechPerLine(
          scriptLines,
          params.voiceType || 'zh_female_xiaohe_uranus_bigtts',
          params.userId,
        );
        const totalDur = lineAudios.reduce((s, a) => s + a.durationSec, 0);

        send('step', {
          step: 'tts',
          status: 'done',
          label: `配音完成（${Math.round(totalDur)} 秒）`,
          data: { lineAudios },
        });
      }

      // Step 2: 按模式分叉
      if (params.mode === 'pack') {
        send('step', {
          step: 'render',
          status: 'generating',
          label: '生成卡片素材包...',
        });
        const packUrl = await this.renderCardPack(scriptLines, blankBefore);
        send('step', {
          step: 'render',
          status: 'done',
          label: '素材包已生成',
          data: { packUrl },
        });
        send('done', { packUrl, scriptText: params.scriptText });
      } else if (params.mode === 'background') {
        if (!params.backgroundUrl) {
          send('error', { message: '未提供背景视频' });
          res.end();
          return;
        }
        send('step', {
          step: 'render',
          status: 'generating',
          label: '渲染解压视频背景...',
        });
        const videoUrl = await this.renderBackgroundVideo(
          scriptLines,
          lineAudios,
          params.backgroundUrl,
          send,
        );
        send('step', {
          step: 'render',
          status: 'done',
          label: '视频生成完成',
          data: { videoUrl },
        });
        send('done', { videoUrl });
      }
    } catch (e: any) {
      send('error', { message: e.message ?? '生成失败' });
    } finally {
      res.end();
    }
  }

  // ============ 共用工具 ============

  private getFfmpegPath(): string {
    return ffmpegStatic || 'ffmpeg';
  }

  private getFontPath(): string {
    return path
      .join('C:', 'Windows', 'Fonts', 'msyh.ttc')
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:');
  }

  /** 检测视频文件是否带音轨（ffmpeg -i 的 stderr 流信息） */
  private hasAudioTrack(filePath: string): boolean {
    const ffmpegPath = this.getFfmpegPath();
    try {
      execSync(`"${ffmpegPath}" -i "${filePath.replace(/\\/g, '/')}"`, {
        timeout: 15000,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e: any) {
      return /Stream #0:\d+[^\n]*Audio/.test(e.stderr || '');
    }
    return false;
  }

  private escapeText(t: string): string {
    return t
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  /**
   * 按标点拆分子句并去除所有标点（仅背景视频字幕用）
   * 断句标点：，。！？；：、…及英文 ,.!?;:；子句超 14 字再折行
   */
  private splitByClause(line: string): string[] {
    const clauses = line
      .split(/(?<=[，。！？；：、…,.!?;:])/)
      .map((c) =>
        c.replace(/[，。！？；：、…,.!?;:“”"'（）《》【】()[\]<>]/g, '').trim(),
      )
      .filter(Boolean);
    const rows: string[] = [];
    for (const c of clauses) {
      for (let i = 0; i < c.length; i += MAX_CHARS_PER_LINE) {
        rows.push(c.slice(i, i + MAX_CHARS_PER_LINE));
      }
    }
    return rows;
  }

  /** 卡片排版：左右对称边距（(1080 - 14字×52px) / 2 = 176） */
  private static readonly CARD_MARGIN_X = 176;

  /**
   * 段落流动排版（手机小说格式）：段落内文本连续填满每行，
   * 每行 14 字，段尾短行；无首行缩进
   */
  private flowParagraph(text: string): string[] {
    const rows: string[] = [];
    let rest = text;
    while (rest.length > 0) {
      rows.push(rest.slice(0, MAX_CHARS_PER_LINE));
      rest = rest.slice(MAX_CHARS_PER_LINE);
    }
    return rows;
  }

  /** 页面上下边距（px）：顶部与底部对称留白 */
  private static readonly TOP_MARGIN = 120;
  /** 每页内容区高度 = 1920 - 上下边距 - 字号（最后一行底与下边距对齐） */
  private static readonly PAGE_CONTENT_H =
    H - 2 * PromoService.TOP_MARGIN - FONT_SIZE;

  /**
   * 小说阅读式分页：段落流动排版，按像素容量满页换页
   * 长段允许跨页拆分（书页标准行为）；每页条目记录原句音频索引和总行数
   * 段距（空行×行高 或 基础段距）计入页容量
   */
  private paginateLines(
    lines: string[],
    blankBefore: number[],
  ): Array<
    Array<{
      line: string;
      rows: string[];
      totalRows: number;
      audioIdx: number;
      blankBefore: number;
    }>
  > {
    const pages: Array<
      Array<{
        line: string;
        rows: string[];
        totalRows: number;
        audioIdx: number;
        blankBefore: number;
      }>
    > = [];
    let curPage: Array<{
      line: string;
      rows: string[];
      totalRows: number;
      audioIdx: number;
      blankBefore: number;
    }> = [];
    let curH = 0;

    for (let i = 0; i < lines.length; i++) {
      const allRows = this.flowParagraph(lines[i]);
      // 段前空行数（超过一页容量时截断）；段尾间距据此计算
      const blank = Math.min(
        blankBefore[i] ?? 0,
        Math.floor(PromoService.PAGE_CONTENT_H / LINE_HEIGHT) - 1,
      );
      const gap = blank > 0 ? blank * LINE_HEIGHT : PARA_GAP - LINE_HEIGHT;
      let rest = allRows;
      while (rest.length > 0) {
        const space = PromoService.PAGE_CONTENT_H - curH;
        if (curPage.length > 0 && space < LINE_HEIGHT) {
          // 本页放不下一行，换页
          pages.push(curPage);
          curPage = [];
          curH = 0;
          continue;
        }
        let take = Math.min(rest.length, Math.floor(space / LINE_HEIGHT));
        if (take >= rest.length && space - take * LINE_HEIGHT < gap) {
          // 整段放得下但段尾间距溢出：少放一行，段尾去下一页
          take -= 1;
        }
        if (take <= 0) take = 1; // 极端：段前空行占满一页时仍放一行
        const isParaEnd = take >= rest.length;
        curPage.push({
          line: lines[i],
          rows: rest.slice(0, take),
          totalRows: allRows.length,
          audioIdx: i,
          blankBefore: blank,
        });
        curH += take * LINE_HEIGHT;
        // 段完整放入时加段距（拆段续页不加）
        if (isParaEnd) curH += gap;
        rest = rest.slice(take);
      }
    }
    if (curPage.length > 0) pages.push(curPage);
    return pages;
  }

  private getOutputDir(): string {
    return path.join(__dirname, '..', '..', 'public', 'uploads', 'videos');
  }

  private async ensureOutputDir(): Promise<string> {
    const dir = this.getOutputDir();
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** 合并逐句音频为一条完整音频，返回 URL */
  private async concatAudios(
    lineAudios: Array<{ url: string; durationSec: number }>,
  ): Promise<string> {
    const ffmpegPath = this.getFfmpegPath();
    const dir = await this.ensureOutputDir();

    if (lineAudios.length === 1) return lineAudios[0].url;

    const listFile = path.join(dir, `concat-${crypto.randomUUID()}.txt`);
    await writeFile(
      listFile,
      lineAudios
        .map(
          (a) =>
            `file '${path.join(__dirname, '..', '..', 'public', a.url).replace(/\\/g, '/')}'`,
        )
        .join('\n'),
      'utf-8',
    );
    const outFile = path.join(dir, `audio-${crypto.randomUUID()}.mp3`);
    execSync(
      `"${ffmpegPath}" -f concat -safe 0 -i "${listFile.replace(/\\/g, '/')}" -c copy "${outFile.replace(/\\/g, '/')}" -y`,
      { timeout: 30000, encoding: 'utf8', stdio: 'pipe' },
    );
    unlink(listFile).catch(() => {});
    return `/uploads/videos/${path.basename(outFile)}`;
  }

  // ============ 模式 C：解压视频背景 ============

  /**
   * 校验并解析背景视频路径（防路径穿越）
   * 只允许 public/uploads/videos 下的文件，解析后必须仍位于 public 目录内
   */
  private resolveBackgroundPath(backgroundUrl: string): string {
    const rel = backgroundUrl.replace(/^[\\/]+/, '');
    if (
      !rel.startsWith('uploads/videos/') &&
      !rel.startsWith('uploads\\videos\\')
    ) {
      throw new BadRequestException('背景视频路径无效');
    }
    const publicDir = path.resolve(__dirname, '..', '..', 'public');
    const target = path.resolve(publicDir, rel);
    if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
      throw new BadRequestException('背景视频路径无效');
    }
    return target;
  }

  private async renderBackgroundVideo(
    scriptLines: string[],
    lineAudios: Array<{ url: string; durationSec: number }>,
    backgroundUrl: string,
    send: (event: string, data: Record<string, any>) => void,
  ): Promise<string> {
    const ffmpegPath = this.getFfmpegPath();
    const fontPath = this.getFontPath();
    const dir = await this.ensureOutputDir();
    const videoId = crypto.randomUUID();
    const bgPath = this.resolveBackgroundPath(backgroundUrl);
    const outputPath = path.join(dir, `promo-${videoId}.mp4`);

    const lines = scriptLines.filter((l) => l.trim());
    const totalDur = lineAudios.reduce((s, a) => s + a.durationSec, 0);

    send('step', {
      step: 'render',
      status: 'generating',
      label: `渲染解压视频背景（时长 ${Math.round(totalDur)} 秒）...`,
    });

    // 字幕：按标点断句、无标点、每次一行、随配音逐行切换（行时长按字数占比分配）
    const SUBTITLE_Y = 1100; // 约 57% 高度，中间偏下
    let cum = 0;
    const drawtextChain = lines
      .flatMap((line, i) => {
        const dur = lineAudios[i].durationSec;
        const rows = this.splitByClause(line);
        const totalChars = rows.reduce((s, r) => s + r.length, 0) || 1;
        const parts: string[] = [];
        let rowStart = cum;
        for (const row of rows) {
          const rowDur = (dur * row.length) / totalChars;
          const start = rowStart;
          const end = rowStart + rowDur - 0.05;
          rowStart += rowDur;
          parts.push(
            `drawtext=fontfile='${fontPath}'` +
              `:text='${this.escapeText(row)}'` +
              `:fontsize=${FONT_SIZE}` +
              `:fontcolor=white` +
              `:borderw=3` +
              `:bordercolor=black` +
              `:x=(w-text_w)/2` +
              `:y=${SUBTITLE_Y}` +
              `:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`,
          );
        }
        cum += dur;
        return parts;
      })
      .join(',');

    // 合并音频
    const mergedAudioUrl = await this.concatAudios(lineAudios);
    const mergedAudioPath = path.join(
      __dirname,
      '..',
      '..',
      'public',
      mergedAudioUrl,
    );

    const vfChain = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${drawtextChain}`;

    // 背景带音轨：原声压低为 BGM 与配音混音；否则只用配音
    const bgVolume = 0.22;
    const voiceVolume = 0.9;
    const audioChain = this.hasAudioTrack(bgPath)
      ? `[0:a]volume=${bgVolume}[bgm];[1:a]volume=${voiceVolume}[voice];[bgm][voice]amix=inputs=2:duration=first:normalize=0[aout]`
      : `[1:a]volume=${voiceVolume}[aout]`;
    const filterComplex = `[0:v]${vfChain}[vout];${audioChain}`;

    const cmd = [
      `"${ffmpegPath}"`,
      '-i',
      `"${bgPath.replace(/\\/g, '/')}"`,
      '-i',
      `"${mergedAudioPath.replace(/\\/g, '/')}"`,
      '-filter_complex',
      `"${filterComplex}"`,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-y',
      `"${outputPath.replace(/\\/g, '/')}"`,
    ].join(' ');

    try {
      execSync(cmd, { timeout: 180000, encoding: 'utf8', stdio: 'pipe' });
      return `/uploads/videos/promo-${videoId}.mp4`;
    } catch (e: any) {
      console.error('[promo] background render failed. stderr:', e.stderr);
      throw new Error(
        `背景视频渲染失败：${e.stderr?.slice(0, 800) || e.message?.slice(0, 800)}`,
      );
    }
  }

  // ============ 模式 A：素材包 ============

  private async renderCardPack(
    scriptLines: string[],
    blankBefore: number[],
  ): Promise<string> {
    const dir = await this.ensureOutputDir();
    const packId = crypto.randomUUID();

    // 注册中文字体
    const fontFile = path.join('C:', 'Windows', 'Fonts', 'msyh.ttc');
    try {
      GlobalFonts.registerFromPath(fontFile, 'MSYH');
    } catch {
      // 字体注册失败用默认字体
    }

    const zip = new JSZip();
    const lines = scriptLines.filter((l) => l.trim());

    // 小说阅读式分页：每页一张卡片，多句垂直排列
    const pages = this.paginateLines(lines, blankBefore);
    if (pages.length > MAX_CARD_PAGES) {
      throw new Error(`脚本过长（最多 ${MAX_CARD_PAGES} 页），请分段生成`);
    }
    for (let p = 0; p < pages.length; p++) {
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');

      // 黑色背景
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, W, H);

      // 白色文字
      ctx.fillStyle = '#ffffff';
      ctx.font = `${FONT_SIZE}px MSYH`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // 手机小说排版：顶对齐（每页起始位置固定），上下边距 30px，段距 > 行距
      // 页内剩余空间均摊到各段距（纵向微 justify），保证下边距 ≈ 30px
      let used = 0;
      let gaps = 0;
      for (const item of pages[p]) {
        used += item.rows.length * LINE_HEIGHT;
        if (item.rows.length >= item.totalRows) {
          used +=
            item.blankBefore > 0
              ? item.blankBefore * LINE_HEIGHT
              : PARA_GAP - LINE_HEIGHT;
          gaps++;
        }
      }
      const extra = gaps > 0 ? (PromoService.PAGE_CONTENT_H - used) / gaps : 0;

      let y = PromoService.TOP_MARGIN + Math.floor(FONT_SIZE / 2);
      for (const item of pages[p]) {
        for (const row of item.rows) {
          ctx.fillText(row, PromoService.CARD_MARGIN_X, y);
          y += LINE_HEIGHT;
        }
        // 段尾才加段间距（跨页拆断的段不加）；
        // 有段前空行时 = 空行×行高（空行替代基础段距）；无空行时 = 基础段距
        if (item.rows.length >= item.totalRows) {
          y +=
            (item.blankBefore > 0
              ? item.blankBefore * LINE_HEIGHT
              : PARA_GAP - LINE_HEIGHT) + extra;
        }
      }

      const png = await canvas.encode('png');
      zip.file(`card-${String(p + 1).padStart(2, '0')}.png`, png);
    }

    // 附文案（素材包只含卡片图和文案，不生成音频）
    zip.file('script.txt', lines.join('\n'));

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
    const outputPath = path.join(dir, `promo-pack-${packId}.zip`);
    await writeFile(outputPath, zipBuffer);

    return `/uploads/videos/promo-pack-${packId}.zip`;
  }
}
