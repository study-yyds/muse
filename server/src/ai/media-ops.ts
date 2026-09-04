// 拆自 ai.service.ts：media-ops
import { eq } from 'drizzle-orm';
import { getDb, schema, mergeJsonb } from '../database/connection';
import crypto from 'crypto';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import type { AiHost } from './ai-host';

export class MediaOps {
  constructor(private readonly host: AiHost) {}

  // ============== AI 生图 ==============

  // 通用生图方法
  async generateImage(
    prompt: string,
    size = '2K',
    style?: string,
    userId?: string,
    modelHint?: string,
    keyId?: string,
  ): Promise<string> {
    // 解析尺寸：支持 "2K" 或 "2K:16:9" 格式
    const parts = size.split(':');
    const resolution = parts[0];
    const ratioLabel =
      parts.length === 3
        ? parts[1] === '16' && parts[2] === '9'
          ? '横版16:9构图'
          : parts[1] === '9' && parts[2] === '16'
            ? '竖版9:16构图'
            : parts[1] === '3' && parts[2] === '4'
              ? '竖版3:4构图'
              : ''
        : '';
    const styledPrompt = [
      prompt,
      style ? `整体视觉风格：${style}` : '',
      ratioLabel,
    ]
      .filter(Boolean)
      .join('。');

    const resolved = await this.host.resolveApiKey(
      userId,
      'image',
      modelHint,
      keyId,
    );
    if (!resolved.apiKey) throw new Error('生图 API Key 未配置');

    const isQwen = modelHint?.startsWith('qwen');
    let res: any;
    let imageUrl = '';

    if (isQwen) {
      const qwenUrl =
        process.env.QWEN_IMAGE_URL ||
        `${resolved.baseUrl}/services/aigc/multimodal-generation/generation`;
      res = await fetch(qwenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model: resolved.model,
          input: { messages: [{ content: [{ text: styledPrompt }] }] },
          parameters: {
            size:
              resolution === '4K'
                ? '2048*2048'
                : resolution === '2K'
                  ? '1440*1440'
                  : '1024*1024',
            watermark: true,
            prompt_extend: true,
          },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`千问生图失败 (${res.status})`);
      const data = await res.json();
      imageUrl = data?.output?.choices?.[0]?.message?.content?.[0]?.image || '';
    } else {
      res = await fetch(`${resolved.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model: resolved.model,
          prompt: styledPrompt,
          size: resolution,
          response_format: 'url',
          watermark: true,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`生图失败: ${err}`);
      }
      const data: any = await res.json();
      imageUrl = data?.data?.[0]?.url;
    }

    if (!imageUrl) throw new Error('生图返回无 URL');

    // 下载图片到本地
    const imgRes = await fetch(imageUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const filename = `img-${crypto.randomUUID()}.png`;
    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, filename), buffer);

    return `/uploads/${filename}`;
  }

  // 构建封面 prompt（根据作品信息）
  async buildCoverPrompt(bookId: string) {
    const db = getDb();
    const [book] = await db
      .select({ title: schema.books.title })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book) throw new Error('作品不存在');

    // 世界观简介
    const [world] = await db
      .select({ sections: schema.world_settings.sections })
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId));

    const worldBrief =
      world?.sections && Array.isArray(world.sections)
        ? world.sections
            .map((s: any) => s.content?.slice(0, 100))
            .filter(Boolean)
            .join('；')
        : '';

    // 角色外貌参考（优先主角，无主角则取全部）
    const allChars = await db
      .select({
        name: schema.characters.name,
        appearance: schema.characters.appearance,
        is_main: schema.characters.is_main,
      })
      .from(schema.characters)
      .where(eq(schema.characters.book_id, bookId));

    const mainChars = allChars.filter((c) => c.is_main);
    const refChars = (mainChars.length > 0 ? mainChars : allChars).slice(0, 3);

    const charBrief = refChars
      .map((c) => `${c.name}：${c.appearance ?? ''}`)
      .filter((s) => s.length > 5)
      .join('；');

    return [
      `为小说《${book.title}》设计封面，以主角为主体。`,
      worldBrief ? `世界观：${worldBrief}` : '',
      charBrief ? `角色外貌参考：${charBrief}` : '',
      '适合作为小说封面。',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // AI 推荐视觉风格（根据世界观内容）
  async recommendVisualStyle(bookId: string, userId?: string) {
    const db = getDb();
    const [world] = await db
      .select({ sections: schema.world_settings.sections })
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId));

    const worldText =
      world?.sections && Array.isArray(world.sections)
        ? world.sections
            .map((s: any) => s.content)
            .join('\n')
            .slice(0, 2000)
        : '';

    if (!worldText.trim()) return { style: '电影写实风' };

    // 走统一的 Key 解析（用户 Key 优先、平台 Key 兜底），
    // 不再硬编码 DeepSeek——平台 Key 换模型时不会白打一次必失败的请求
    const resolved = await this.host.resolveApiKey(userId, 'chat');
    if (!resolved.apiKey) return { style: '电影写实风' };

    try {
      const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            {
              role: 'user',
              content: `根据以下小说世界观，推荐一个适合AI生图的视觉风格。只输出风格关键词（10字以内），如"水墨武侠风""废土朋克""日系赛博""国风玄幻"等，不要解释。\n\n世界观：\n${worldText.slice(0, 1500)}`,
            },
          ],
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      const style = data.choices?.[0]?.message?.content?.trim() || '电影写实风';
      return { style };
    } catch {
      return { style: '电影写实风' };
    }
  }

  // 构建角色图 prompt
  async buildCharPrompt(charId: string) {
    const db = getDb();
    const [ch] = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.char_id, charId))
      .limit(1);
    if (!ch) throw new Error('角色不存在');

    const parts = [
      `角色立绘：${ch.name}`,
      ch.gender ? `性别：${ch.gender}` : '',
      ch.appearance ? `外貌：${ch.appearance}` : '',
      ch.identity ? `身份：${ch.identity}` : '',
      ch.personality ? `气质：${ch.personality}` : '',
      '要求：高质量角色立绘，精细刻画，符合角色设定，半身像，光影细腻，oc渲染风格。',
    ];
    return parts.filter(Boolean).join('，');
  }

  // ============== TTS 语音合成 ==============

  // ============== TTS 语音合成 ==============

  // 单次 TTS 请求（豆包语音合成 2.0 HTTP 单向流式 SSE，V3 接口）
  async ttsRequest(
    text: string,
    apiKey: string,
    voiceType: string,
  ): Promise<{ base64: string; durationSec: number }> {
    const estimatedSec = Math.ceil(text.length / 4);
    const timeoutMs = Math.max(estimatedSec * 1000 + 30000, 60000);

    // 火山网关瞬时故障（502/超时）常见：最多重试 2 次
    const MAX_RETRIES = 2;
    let res: any;
    let retried = 0;
    for (;;) {
      try {
        res = await fetch(
          'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': apiKey,
              'X-Api-Resource-Id': 'seed-tts-2.0',
              'X-Api-Request-Id': crypto.randomUUID(),
            },
            body: JSON.stringify({
              user: { uid: 'muse-tts' },
              req_params: {
                text,
                speaker: voiceType,
                sample_rate: 24000,
                audio_params: {
                  format: 'mp3',
                  speech_rate: 0,
                  loudness_rate: 0,
                  bit_rate: 64000,
                },
                additions: JSON.stringify({
                  post_process: { pitch: 0 },
                  disable_markdown_filter: true,
                  enable_latex_tn: true,
                  latex_parser: 'v2',
                }),
              },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        // 5xx 网关错误且未用尽重试次数：重试
        if (res.status >= 500 && retried < MAX_RETRIES) {
          retried++;
          continue;
        }
        break;
      } catch (e: any) {
        if (
          (e.name === 'AbortError' || e.name === 'TimeoutError') &&
          retried < MAX_RETRIES
        ) {
          retried++;
          continue;
        }
        if (e.name === 'AbortError' || e.name === 'TimeoutError') {
          throw new Error(
            `[TTS] 请求超时（等 ${Math.round(timeoutMs / 1000)}s），文本 ${text.length} 字`,
          );
        }
        if (e.cause?.code === 'ENOTFOUND' || e.message?.includes('fetch')) {
          throw new Error(`[TTS] 网络不通：${e.message}`);
        }
        throw new Error(`[TTS] 请求异常：${e.message}`);
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `[TTS] API Key 无效 (${res.status})，请检查：${apiKey.slice(0, 8)}...`,
      );
    }
    if (res.status === 429) {
      throw new Error('[TTS] 请求太频繁（火山限流），请稍后重试');
    }
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(
        `[TTS] HTTP ${res.status}：${err.slice(0, 300) || res.statusText}`,
      );
    }

    // SSE 流式：逐行解析 data: {...} 分片，音频 base64 在 data 字段
    const reader = res.body?.getReader();
    if (!reader) throw new Error('[TTS] 无法读取响应流');
    const decoder = new TextDecoder();
    let audioBase64 = '';
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.code && parsed.code !== 0 && parsed.code !== 20000000) {
            throw new Error(
              `[TTS] API 错误 (code=${parsed.code})：${parsed.message || '未知'}`,
            );
          }
          if (parsed.data) audioBase64 += parsed.data;
        } catch (e: any) {
          if (e.message?.startsWith('[TTS]')) throw e;
          // 非 JSON 分片，忽略
        }
      }
    }

    if (!audioBase64 || audioBase64.length < 100) {
      throw new Error('[TTS] 返回空音频，请确认音色 ID 和模型版本');
    }

    // V3 响应不含 duration，本地用 ffmpeg 解析真实时长
    const durationSec = this.getAudioDurationSec(
      Buffer.from(audioBase64, 'base64'),
      text,
    );
    return { base64: audioBase64, durationSec };
  }

  /** 用 ffmpeg 解析音频真实时长（秒），失败时按 4 字/秒估算 */
  getAudioDurationSec(audioBuf: Buffer, text: string): number {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'muse-tts-'));
    const tmpFile = path.join(tmpDir, 'audio.mp3');
    try {
      writeFileSync(tmpFile, audioBuf);
      // ffmpeg -i 无输出参数时以非零码退出，Duration 信息在 stderr
      execSync(`"${ffmpegPath}" -i "${tmpFile}"`, {
        timeout: 15000,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e: any) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(e.stderr || '');
      if (m) {
        return (
          parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /** 合成短文本并返回音频 base64（音色试听等轻量场景，调用方自行缓存） */
  async synthesizeShortText(
    text: string,
    voiceType: string,
    userId?: string,
  ): Promise<string> {
    const resolved = await this.host.resolveApiKey(userId, 'image');
    const apiKey =
      process.env.VOLCANO_TTS_KEY ||
      resolved.apiKey ||
      process.env.VOLCANO_IMAGE_KEY ||
      '';
    if (!apiKey)
      throw new Error(
        '[TTS] API Key 未配置，请在 .env 中设置 VOLCANO_TTS_KEY（或 VOLCANO_IMAGE_KEY 兜底）',
      );

    const { base64 } = await this.ttsRequest(
      text.slice(0, 3000),
      apiKey,
      voiceType,
    );
    return base64;
  }

  async generateSpeech(
    text: string,
    voiceType: string = 'zh_female_xiaohe_uranus_bigtts',
    userId?: string,
  ): Promise<{ url: string; durationSec: number }> {
    const resolved = await this.host.resolveApiKey(userId, 'image');
    const apiKey =
      process.env.VOLCANO_TTS_KEY ||
      resolved.apiKey ||
      process.env.VOLCANO_IMAGE_KEY ||
      '';
    if (!apiKey)
      throw new Error(
        '[TTS] API Key 未配置，请在 .env 中设置 VOLCANO_TTS_KEY（或 VOLCANO_IMAGE_KEY 兜底）',
      );

    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    await mkdir(uploadsDir, { recursive: true });

    // 分段：每段 <= 2800 字，在句号/换行处断开
    const MAX_CHUNK = 2800;
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_CHUNK) {
        chunks.push(remaining);
        break;
      }
      let cutAt = MAX_CHUNK;
      const searchRange = remaining.slice(MAX_CHUNK - 200, MAX_CHUNK);
      const lastBreak = Math.max(
        searchRange.lastIndexOf('。'),
        searchRange.lastIndexOf('！'),
        searchRange.lastIndexOf('？'),
        searchRange.lastIndexOf('\n'),
        searchRange.lastIndexOf('，'),
      );
      if (lastBreak >= 0) cutAt = MAX_CHUNK - 200 + lastBreak + 1;
      chunks.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt);
    }

    // 单段直返
    if (chunks.length === 1) {
      const { base64, durationSec } = await this.ttsRequest(
        chunks[0],
        apiKey,
        voiceType,
      );
      const filename = `audio-${crypto.randomUUID()}.mp3`;
      await writeFile(
        path.join(uploadsDir, filename),
        Buffer.from(base64, 'base64'),
      );
      return {
        url: `/uploads/${filename}`,
        durationSec: durationSec || Math.ceil(chunks[0].length / 4),
      };
    }

    // 多段：逐段合成 → ffmpeg 拼接
    const tempFiles: string[] = [];
    let totalDur = 0;
    for (let i = 0; i < chunks.length; i++) {
      const { base64, durationSec } = await this.ttsRequest(
        chunks[i],
        apiKey,
        voiceType,
      );
      totalDur += durationSec;
      const tf = path.join(uploadsDir, `tts-temp-${crypto.randomUUID()}.mp3`);
      await writeFile(tf, Buffer.from(base64, 'base64'));
      tempFiles.push(tf);
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500));
    }

    const outputFile = path.join(
      uploadsDir,
      `audio-${crypto.randomUUID()}.mp3`,
    );
    const listFile = path.join(uploadsDir, 'concat-list.txt');
    await writeFile(
      listFile,
      tempFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'),
      'utf-8',
    );

    try {
      execSync(
        `"${ffmpegPath}" -f concat -safe 0 -i "${listFile.replace(/\\/g, '/')}" -c copy "${outputFile.replace(/\\/g, '/')}" -y`,
        { timeout: 30000, encoding: 'utf8' },
      );
    } catch {
      return { url: `/uploads/${path.basename(tempFiles[0])}`, durationSec: 0 };
    }

    // 清理
    unlink(listFile).catch(() => {});
    for (const tf of tempFiles) unlink(tf).catch(() => {});

    return {
      url: `/uploads/${path.basename(outputFile)}`,
      durationSec: totalDur,
    };
  }

  /** 逐句合成：返回每句音频 URL 和真实时长（供视频字幕同步） */
  async generateSpeechPerLine(
    lines: string[],
    voiceType: string = 'zh_female_xiaohe_uranus_bigtts',
    userId?: string,
  ): Promise<Array<{ url: string; durationSec: number }>> {
    const resolved = await this.host.resolveApiKey(userId, 'image');
    const apiKey =
      process.env.VOLCANO_TTS_KEY ||
      resolved.apiKey ||
      process.env.VOLCANO_IMAGE_KEY ||
      '';
    if (!apiKey)
      throw new Error(
        '[TTS] API Key 未配置，请在 .env 中设置 VOLCANO_TTS_KEY（或 VOLCANO_IMAGE_KEY 兜底）',
      );

    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    await mkdir(uploadsDir, { recursive: true });

    const results: Array<{ url: string; durationSec: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const { base64, durationSec } = await this.ttsRequest(
        lines[i].slice(0, 3000),
        apiKey,
        voiceType,
      );
      const filename = `audio-line-${crypto.randomUUID()}.mp3`;
      await writeFile(
        path.join(uploadsDir, filename),
        Buffer.from(base64, 'base64'),
      );
      results.push({
        url: `/uploads/${filename}`,
        durationSec: durationSec || Math.ceil(lines[i].length / 4),
      });
      // 段间稍等避免限流
      if (i < lines.length - 1) await new Promise((r) => setTimeout(r, 300));
    }
    return results;
  }

  // ============== 生成简介 ==============

  /** 生成作品简介（blurb，展示在封面/平台用；命名沿用 synopsis 但语义是简介不是梗概） */
  async generateSynopsis(
    bookId: string,
    userId?: string,
    model?: string,
    keyId?: string,
  ) {
    const db = getDb();
    const [book] = await db
      .select({
        title: schema.books.title,
        user_id: schema.books.user_id,
        type: schema.books.type,
      })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book) return { synopsis: '' };

    const resolved = await this.host.resolveApiKey(
      userId,
      'chat',
      model,
      keyId,
    );
    if (!resolved.apiKey) return { synopsis: '' };

    // 简介不注入正文：实践验证模型会照搬章节内容（且书越长越失真），
    // 卖点信息来自大纲骨架 + 引导摘要 + 角色，足够提炼
    const chars = await db
      .select({
        name: schema.characters.name,
        identity: schema.characters.identity,
      })
      .from(schema.characters)
      .where(eq(schema.characters.book_id, bookId))
      .limit(5);
    const charBrief = chars
      .map((c) => `${c.name}：${c.identity || ''}`)
      .join('；');
    // 引导摘要（创作方向）与短篇梗概：简介必须反映作者确认的方向
    const [settings] = await db
      .select({ extra: schema.book_settings.extra })
      .from(schema.book_settings)
      .where(eq(schema.book_settings.book_id, bookId))
      .limit(1);
    const bookExtra = (settings?.extra ?? {}) as Record<string, any>;
    // 剔除【关键节点】段：该字段是动作级剧情（拍床板/敲水缸），模型会当成必须复述的内容写进简介；
    // 简介的卖点信息在主题/底牌/已确认设定字段里都有，节点骨架另有 nodeBrief 注入
    const guideBlock = (bookExtra.guide_summary as string | undefined)
      ?.replace(/【关键节点】[^【]*/g, '')
      .slice(0, 800);
    // 世界观时代分区：提供年代锚点，防止模型漂移年代（如把 1976 写成六十年代）
    const [worldRow] = await db
      .select({ sections: schema.world_settings.sections })
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId))
      .limit(1);
    const worldSections = (worldRow?.sections ?? []) as Array<{
      name: string;
      content: string;
    }>;
    const eraBlock = worldSections
      .filter((s) => /时代|年代|背景/i.test(s.name))
      .map((s) => s.content)
      .join('\n')
      .slice(0, 300);
    const shortOutlinePreview = (
      bookExtra.outline_preview as string | undefined
    )?.slice(0, 600);
    const [outline] = await db
      .select()
      .from(schema.outlines)
      .where(eq(schema.outlines.book_id, bookId));
    const nodes = outline
      ? await db
          .select()
          .from(schema.outline_chapters)
          .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
          .orderBy(schema.outline_chapters.sort_order)
      : [];
    // 全程骨架：全部节点标题（含结局节点），简介能看到全书方向
    const nodeBrief = nodes
      .map((n) => n.title)
      .join(' → ')
      .slice(0, 600);

    // 平台调性分流：短篇=知乎盐选（悬念反转），长篇=番茄/起点（题材标签+金手指+爽点承诺）
    const prompt =
      book.type === 'short'
        ? `你是知乎盐选爆款编辑。为短篇《${book.title}》写一段简介（150-250字），用于盐选展示吸引读者。

【机制——好简介只做三件事】
1. 制造信息差：读者知道而角色不知道的、表面身份与真实底牌的错位
2. 只承诺不交付：钩子句（第一句）用反常事实+反差，一秒内让人想问"怎么会这样"；爽感只给预期（反转、揭晓的期待），具体结果一律不写
3. 半遮结局：交付"她成功了"的结果感，保留"怎么成功的"过程悬念；节奏短句递进，每 2-3 句埋一个"原来如此"

【正确性——不得违反】
1. 只写三个层次：她的处境 / 她的底牌 / 她的成长结果；动作细节、课程过程、正文片段一律不写
2. 事实不自由：年代与素材一致；引号台词与素材原文一致；题材标签只用真实设定
3. 台词不滥用：同一关键词最多出现两次；结尾落点用具体实物，禁抽象名词与自创比喻，禁"你猜"式问句

【参考样例——参考节奏与信息密度，句式不必模仿，禁止照抄】
"我五岁那年，从收音机里听见了一个不该存在的声音。它说，我的耳朵能听见世界的骨骼。三十年后，飞机从我头顶掠过——那东西里有我的名字。可没人告诉我，听见一切的代价是什么。"

只输出简介文本。`
        : `你是网文平台爆款编辑。为小说《${book.title}》写一段简介（150-250字），用于番茄/起点类平台展示吸引读者。

【机制——好简介只做三件事】
1. 制造信息差：读者知道而角色不知道的、表面身份与真实底牌的错位（"所有人都以为她是天才，只有她知道……"式）
2. 只承诺不交付：钩子句（第一句）用题材标签+反常反差，一秒内让人想问"怎么会这样"；爽感只给预期（碾压、翻盘、被仰望），具体结果一律不写
3. 半遮结局：交付"她成功了"的结果感，保留"怎么成功的"过程悬念；节奏短句递进，每 2-3 句埋一个"原来如此"

【正确性——不得违反】
1. 只写三个层次：她的处境 / 她的底牌 / 她的成长结果；动作细节、课程过程、训练步骤、正文片段一律不写，也不按时间线罗列剧情
2. 事实不自由：年代与素材一致；引号台词与素材原文一致（"我想"不得写成"我想学"）；题材标签只用本书真实设定
3. 台词不滥用：同一关键词最多出现两次；结尾落点用具体实物（图纸/档案/名单），禁抽象名词与自创比喻，禁"你猜"式问句；"多年后"式结尾只可暗示成就，不得写明具体结果

【参考样例——参考节奏与信息密度，句式不必模仿，禁止照抄】
"七零年代，别人家的孩子还在跳皮筋，五岁的她却迷上了收音机里的杂音。没人知道，那台破收音机里住着一个来自未来的学习系统。五岁觉醒超级听觉，七岁碾压全班，十六岁被秘密招进研究所。所有人都以为她是天才，只有她自己知道，她只是把每一课都多听了一遍。多年后，国之重器问世，全世界看向东方——而她的名字，藏在图纸最深的角落。"

只输出简介文本。`;

    const summary = [
      guideBlock ? `创作方向（作者确认的设定，必须符合）：${guideBlock}` : '',
      eraBlock ? `时代背景（年代必须与此一致，不得漂移）：${eraBlock}` : '',
      book.type === 'short' && shortOutlinePreview
        ? `故事梗概：${shortOutlinePreview}`
        : '',
      charBrief ? `主要角色：${charBrief}` : '',
      nodeBrief
        ? `情节主线（开局到结局——结局部分仅供避雷，禁止写进简介）：${nodeBrief}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: summary },
          ],
          max_tokens: 1024,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const synopsis = (data.choices?.[0]?.message?.content || '').trim();
      // 用量记录
      await this.host.recordUsage({
        userId,
        bookId,
        model: resolved.model,
        inChars: prompt.length + summary.length,
        outChars: synopsis.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });
      let history: string[] = [];
      if (synopsis) {
        const [settings2] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId));
        const extra2 = (settings2?.extra ?? {}) as Record<string, any>;
        // 版本历史（最近 5 版）：重复内容不重复入列，新版本追加到末尾
        const prevHistory = (extra2.synopsis_history ?? []) as string[];
        history = [
          ...prevHistory.filter((s) => s !== synopsis),
          synopsis,
        ].slice(-5);
        // JSONB 原子合并写入（读取仅用于历史计算）
        await db
          .update(schema.book_settings)
          .set({
            extra: mergeJsonb(schema.book_settings.extra, {
              synopsis,
              synopsis_history: history,
            }),
          })
          .where(eq(schema.book_settings.book_id, bookId));
      }
      return { synopsis, history };
    } catch {
      return { synopsis: '', history: [] };
    }
  }
}
