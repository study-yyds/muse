import { Injectable } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { Response } from 'express';
import crypto from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

// 提示注入防护
const MAX_USER_INPUT = 8000; // 用户输入最大长度
const MAX_HISTORY_MSG = 40; // 历史消息最大条数
const INJECTION_PATTERNS = [
  /忽略.*(?:系统|之前|上面|所有|提示|规则|指令)/gi,
  /ignore.*(?:system|previous|above|all|prompt|rule|instruction)/gi,
  /\[系统指令\]|\[SYSTEM\]|<<SYSTEM>>|\[INST\]|<<SYS>>/gi,
  /你的.*(?:系统提示|system prompt|指令|提示词)/gi,
  /输出.*(?:系统提示|system prompt|指令|提示词)/gi,
];

export function sanitizePrompt(text: string): string {
  if (!text || typeof text !== 'string') return '';
  // 长度限制
  let sanitized = text.slice(0, MAX_USER_INPUT);
  // 过滤注入模式
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[filtered]');
  }
  return sanitized;
}

function sanitizeMessages(msgs: any[]): any[] {
  if (!Array.isArray(msgs)) return [];
  return msgs.slice(-MAX_HISTORY_MSG).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: sanitizePrompt(m.content),
  }));
}

@Injectable()
export class AiService {
  // 统一获取 API Key（优先用户自定义，fallback 平台）
  private async resolveApiKey(
    userId: string | undefined,
    usage: 'chat' | 'image',
    modelHint?: string,
  ): Promise<{ apiKey: string; baseUrl: string; model: string }> {
    const db = getDb();
    if (userId) {
      const keys = await db
        .select()
        .from(schema.user_api_keys)
        .where(
          and(
            eq(schema.user_api_keys.user_id, userId),
            eq(schema.user_api_keys.is_active, true),
          ),
        );
      const matched = keys.filter(
        (k) => k.usage === usage || k.usage === 'both',
      );
      if (matched.length > 0) {
        const k = matched[0];
        try {
          const { createDecipheriv } = require('crypto');
          const key = require('crypto')
            .createHash('sha256')
            .update(process.env.ENCRYPTION_KEY)
            .digest();
          const buf = Buffer.from(k.api_key_encrypted, 'base64');
          const tag = buf.subarray(0, 16);
          const data = buf.subarray(16);
          const decipher = createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(k.encryption_iv, 'base64'),
          );
          decipher.setAuthTag(tag);
          const decrypted = Buffer.concat([
            decipher.update(data),
            decipher.final(),
          ]).toString('utf8');
          return { apiKey: decrypted, baseUrl: k.base_url, model: k.model_name };
        } catch { /* fall through */ }
      }
    }

    // 千问平台 Key
    const isQwen = modelHint?.startsWith('qwen');
    if (isQwen && process.env.QWEN_API_KEY) {
      return {
        apiKey: process.env.QWEN_API_KEY,
        baseUrl:
          process.env.QWEN_BASE_URL ||
          'https://llm-6pagmd0n2hiazjz1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: modelHint || 'qwen3.7-plus',
      };
    }

    return usage === 'image'
      ? {
          apiKey: process.env.VOLCANO_IMAGE_KEY || '',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: modelHint || 'doubao-seedream-5-0-260128',
        }
      : {
          apiKey: process.env.AI_PLATFORM_KEY || '',
          baseUrl:
            process.env.AI_PLATFORM_BASE_URL || 'https://api.deepseek.com/v1',
          model: modelHint || 'deepseek-v4-flash',
        };
  }

  // SSE 流式续写/改写
  async generate(
    res: Response,
    params: {
      bookId: string;
      chapterId: string;
      mode: 'continue' | 'rewrite';
      cursorPosition: number;
      selectedText?: string;
      instruction?: string;
      style?: string;
      model: string;
      usePlatformKey: boolean;
      user_id?: string;
    },
  ) {
    if (params.user_id)
      await this.checkBookOwnership(params.bookId, params.user_id);
    const db = getDb();

    // 获取角色设定
    const characters = await db
      .select({
        name: schema.characters.name,
        personality: schema.characters.personality,
      })
      .from(schema.characters)
      .where(eq(schema.characters.book_id, params.bookId));

    // 获取章节内容
    const [chapter] = await db
      .select({
        content: schema.chapters.content,
        title: schema.chapters.title,
      })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.chapter_id, params.chapterId), eq(schema.chapters.book_id, params.bookId)))
      .limit(1);

    // 构建 AI 上下文
    const charContext = characters
      .filter((c) => c.personality)
      .map((c) => `${c.name}: ${c.personality}`)
      .join('\n');

    const systemPrompt = `你是一个专业的小说写作助手。以下是当前作品的设定：

【角色设定】
${charContext || '暂无'}

【写作要求】
- 根据上下文和角色设定续写，保持角色性格一致
- 文风：${params.style ?? '默认'}
- 生成内容应与前文自然衔接`;

    const userPrompt =
      params.mode === 'continue'
        ? `请从以下位置续写（光标位置：${params.cursorPosition}）：\n\n${(chapter?.content ?? '').slice(Math.max(0, params.cursorPosition - 1000), params.cursorPosition)}`
        : `请改写以下内容（${sanitizePrompt(params.instruction ?? '优化这段文字')}）：\n\n${sanitizePrompt(params.selectedText ?? '')}`;

    void this.streamToClient(
      res,
      systemPrompt,
      userPrompt,
      params.model,
      params.usePlatformKey,
    );
  }

  // SSE 流式推送
  private async streamToClient(
    res: Response,
    systemPrompt: string,
    userPrompt: string,
    model: string,
    usePlatformKey: boolean,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let apiKey = process.env.AI_PLATFORM_KEY;
    let baseUrl = process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';

    if (!usePlatformKey) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: '自定义 Key 请通过前端直连' })}\n\n`);
      res.end();
      return;
    }

    if (!apiKey) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'AI 服务未配置' })}\n\n`);
      res.end();
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: true,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const err = await response.text();
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: 'AI 请求失败' })}\n\n`,
        );
        res.end();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      // 监听客户端断开连接
      res.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write('event: done\ndata: {}\n\n');
            } else {
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                const content = delta?.content || delta?.reasoning_content;
                if (content) {
                  res.write(
                    `event: chunk\ndata: ${JSON.stringify({ content })}\n\n`,
                  );
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
      }
    } catch (e: any) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 服务异常' })}\n\n`,
      );
    }
    res.end();
  }

  // 应用提取的设定：写入 characters 或 world_settings
  async applySettings(
    bookId: string,
    suggestions: Array<{
      type: 'character' | 'world';
      target_char_id?: string | null;
      field?: string;
      value?: string;
      section_name?: string;
      content?: string;
    }>,
    userId: string,
  ) {
    await this.checkBookOwnership(bookId, userId);
    const db = getDb();
    const results: string[] = [];

    for (const s of suggestions) {
      if (s.type === 'character') {
        // 角色字段映射
        const charFields = [
          'name',
          'gender',
          'personality',
          'identity',
          'backstory',
          'motivation',
          'appearance',
          'catchphrase',
          'speech_style',
        ];
        if (!s.field || !charFields.includes(s.field)) continue;

        if (s.target_char_id) {
          // 校验角色属于该书
          const [charCheck] = await db.select({ book_id: schema.characters.book_id }).from(schema.characters).where(eq(schema.characters.char_id, s.target_char_id)).limit(1);
          if (!charCheck || charCheck.book_id !== bookId) continue;
          // 更新已有角色
          await db
            .update(schema.characters)
            .set({ [s.field]: s.value, updated_at: new Date() })
            .where(eq(schema.characters.char_id, s.target_char_id));
          results.push(`更新角色字段 ${s.field}`);
        } else if (s.field === 'name' && s.value) {
          // 新建角色：以 name 为必填
          const [created] = await db
            .insert(schema.characters)
            .values({ book_id: bookId, name: s.value })
            .returning({ char_id: schema.characters.char_id });
          if (created) results.push(`新建角色 ${s.value}`);
        } else if (s.value) {
          // 新建角色并设置字段
          const [created] = await db
            .insert(schema.characters)
            .values({
              book_id: bookId,
              name: '新角色',
              [s.field]: s.value,
            } as any)
            .returning({ char_id: schema.characters.char_id });
          if (created) results.push(`新建角色（${s.field}）`);
        }
      } else if (s.type === 'world' && s.section_name && s.content) {
        // 世界观：查找已有分区，有则更新，无则追加
        const [world] = await db
          .select({ sections: schema.world_settings.sections })
          .from(schema.world_settings)
          .where(eq(schema.world_settings.book_id, bookId));

        const currentSections: any[] = (world?.sections as any[]) ?? [];
        const idx = currentSections.findIndex(
          (sec: any) => sec.name === s.section_name,
        );

        if (idx >= 0) {
          currentSections[idx] = {
            ...currentSections[idx],
            content: s.content,
          };
        } else {
          currentSections.push({
            name: s.section_name,
            content: s.content,
            sort_order: currentSections.length,
          });
        }

        // upsert world_settings
        await db
          .insert(schema.world_settings)
          .values({ book_id: bookId, sections: currentSections })
          .onConflictDoUpdate({
            target: schema.world_settings.book_id,
            set: { sections: currentSections, updated_at: new Date() },
          });
        results.push(
          idx >= 0
            ? `更新世界观分区 ${s.section_name}`
            : `新建世界观分区 ${s.section_name}`,
        );
      }
    }

    return { applied: results };
  }

  // 校验 book_id 所有权
  async checkBookOwnership(bookId: string, userId: string) {
    const db = getDb();
    const [book] = await db
      .select({ user_id: schema.books.user_id })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book || book.user_id !== userId) {
      throw new Error('无权访问该作品');
    }
  }

  // 全局 AI 对话（根据菜单切换上下文和动作）
  async chat(
    res: Response,
    params: {
      book_id: string;
      context_type: string;
      message: string;
      messages?: any[];
      model?: string;
      chapter_id?: string;
      cursor_position?: number;
      style?: string;
      user_id?: string;
    },
  ) {
    const db = getDb();
    const ct = params.context_type;

    // 校验所有权
    if (params.user_id) {
      await this.checkBookOwnership(params.book_id, params.user_id);
    }

    // 查作品类型
    const [book] = await db
      .select({ type: schema.books.type })
      .from(schema.books)
      .where(eq(schema.books.book_id, params.book_id))
      .limit(1);
    const bookType = book?.type ?? 'novel';

    // 短篇跳过上下文加载（不需要世界观/大纲/角色）
    const isShort = bookType === 'short';

    // 通用上下文：角色（完整字段）、世界观、大纲（长篇才加载）
    const chars = isShort
      ? []
      : await db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.book_id, params.book_id));

    const [world] = isShort
      ? [null]
      : await db
          .select()
          .from(schema.world_settings)
          .where(eq(schema.world_settings.book_id, params.book_id));

    const [outline] = isShort
      ? [null]
      : await db
          .select()
          .from(schema.outlines)
          .where(eq(schema.outlines.book_id, params.book_id));
    const allOutlineNodes = outline
      ? await db
          .select()
          .from(schema.outline_chapters)
          .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
          .orderBy(schema.outline_chapters.sort_order)
      : [];

    // 世界观文本：空设定时给出默认分区名供 AI 填充
    const DEFAULT_SECTION_NAMES = [
      '时代与背景',
      '地理与场景',
      '规则与体系',
      '势力与阵营',
    ];
    const worldSections = world?.sections as any[] | undefined;
    const worldText = worldSections?.length
      ? worldSections
          .map((s: any) => `【${s.name}】\n${s.content}`)
          .join('\n\n')
      : DEFAULT_SECTION_NAMES.map((n) => `【${n}】\n暂无`).join('\n\n');
    const worldSectionNames = worldSections?.length
      ? worldSections.map((s: any) => s.name)
      : DEFAULT_SECTION_NAMES;

    // ====== 章节上下文 + 大纲节点上下文 + 角色筛选 ======
    let chapterContext = '';
    let outlineContext = '';
    let appearingChars: typeof chars = [];

    if (params.chapter_id) {
      const [ch] = await db
        .select({
          title: schema.chapters.title,
          content: schema.chapters.content,
          bound_outline_node_id: schema.chapters.bound_outline_node_id,
        })
        .from(schema.chapters)
        .where(and(eq(schema.chapters.chapter_id, params.chapter_id), eq(schema.chapters.book_id, params.book_id)));

      if (ch) {
        // 章节文本上下文
        const cursorPos = params.cursor_position ?? 0;
        const before = ch.content.slice(
          Math.max(0, cursorPos - 2000),
          cursorPos,
        );
        const after = ch.content.slice(cursorPos, cursorPos + 500);
        chapterContext = `【当前章节】
标题：${ch.title}
总字数：${ch.content.length}

【光标前文——你要接着这里续写】
${before || '（开头）'}

【光标后文——仅供参考，不需要重复】
${after || '（结尾）'}`;

        // 大纲节点上下文：当前绑定的节点 + 前后已完成节点
        const nodeId = ch.bound_outline_node_id;
        if (nodeId) {
          const idx = allOutlineNodes.findIndex((n) => n.id === nodeId);
          if (idx >= 0) {
            const prevNodes = allOutlineNodes
              .slice(Math.max(0, idx - 2), idx)
              .filter((n) => n.status === 'completed');
            const currNode = allOutlineNodes[idx];
            const nextNode = allOutlineNodes[idx + 1];

            const nodeLines: string[] = [];
            if (prevNodes.length > 0) {
              nodeLines.push('【已完成的前置情节——角色当前状态由此形成】');
              prevNodes.forEach((n) =>
                nodeLines.push(`- ${n.title}：${n.summary}`),
              );
            }
            nodeLines.push(
              `【当前节点——本章正在写的情节】${currNode.title}：${currNode.summary}`,
            );
            if (nextNode) {
              nodeLines.push(
                `【下一节点——剧情走向参考】${nextNode.title}：${nextNode.summary}`,
              );
            }
            outlineContext = nodeLines.join('\n');
          }
        }

        // 角色筛选：主要角色 + 在章节中出场的角色
        const chapterText = ch.content.toLowerCase();
        const mainChars = chars.filter((c) => c.is_main);
        const appearedChars = chars.filter((c) => {
          if (c.is_main) return false; // 已在 mainChars 中
          const names = [
            c.name,
            ...(c.aliases ? c.aliases.split(/[,，]/).map((s) => s.trim()) : []),
          ];
          return names.some((n) => chapterText.includes(n.toLowerCase()));
        });
        appearingChars = [...mainChars, ...appearedChars];
      }
    }

    // 如果没有章节内容，回退：注入主要角色 + 所有角色
    const contextChars = appearingChars.length > 0 ? appearingChars : chars;

    // 角色完整信息
    const charFull = contextChars
      .map((c) =>
        [
          `【${c.name}】${c.is_main ? '（主要角色）' : ''}`,
          c.gender ? `性别：${c.gender}` : null,
          c.identity ? `身份：${c.identity}` : null,
          c.personality ? `性格：${c.personality}` : null,
          c.catchphrase ? `口头禅：${c.catchphrase}` : null,
          c.speech_style ? `说话风格：${c.speech_style}` : null,
          c.backstory ? `背景：${c.backstory}` : null,
          c.motivation ? `动机：${c.motivation}` : null,
          c.appearance ? `外貌：${c.appearance}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');

    // 角色简表
    const charBrief = chars
      .map(
        (c) =>
          `- id=${c.char_id} | ${c.name} | ${c.gender ?? '?'}/${c.identity ?? '?'} | 性格=${c.personality ?? '暂无'}${c.is_main ? '【主】' : ''}`,
      )
      .join('\n');

    // 大纲全部节点列表（含 ID 供 update 引用）
    const outlineNodes = allOutlineNodes
      .map(
        (oc) =>
          `- id=${oc.id} | ${oc.title}（${oc.status}）：${oc.summary ?? ''}`,
      )
      .join('\n');

    // 风格说明
    const styleGuide: Record<string, string> = {
      default: '',
      'light-novel': '轻小说风格：口语化对话、短段落、角色内心独白、轻松快节奏',
      serious: '严肃文学风格：细腻描写、克制情感、长句节奏、氛围营造优先',
      ancient: '古风风格：文言词汇、诗词意象、章回体韵味、对仗工整',
      plain: '小白文风格：直白易懂、快节奏、少修饰、注重剧情推进',
      colloquial: '口语化风格：生活化对话、接地气表述、贴近日常语言',
    };
    const styleNote = params.style ? (styleGuide[params.style] ?? '') : '';
    const styleBlock = styleNote
      ? `\n【文风要求——严格遵守】\n${styleNote}`
      : '';

    // ====== 系统提示词 ======
    const prompts: Record<string, string> = {
      write: `你是专业小说写作助手，正在帮助作者完成当前的写作章节。

${chapterContext}

${outlineContext ? `【故事进程——角色近期经历了什么】\n${outlineContext}\n` : ''}
【本作品相关角色设定——请严格按照以下设定写作，保持角色言行一致】
${charFull || '暂无角色设定'}

【世界观规则——所有情节必须符合以下世界设定】
${worldText}
${styleBlock}
【写作指引】
- 根据角色性格写对话：冷淡角色话少、活泼角色语气词多
- 根据世界观限制情节
- 续写时自然衔接光标前文的语气和节奏
- 不要重复光标后文的内容
- 如果角色在故事进程中经历了重大事件，考虑其对角色状态的影响

【回复格式——严格遵守】
你的回复分为两部分：
1. 正文内容（纯自然语言，不含任何 JSON 标记）
2. 最后一行为操作指令 JSON（单独一行）

示例：
久仰尊颜，今日得见，果然名不虚传。
{"action":"insert_content","content":"久仰尊颜，今日得见，果然名不虚传。"}

如果只是闲聊讨论，则只输出自然语言，不需要 JSON。`,

      short: `你是知乎盐选爆款短篇作家。参照以下风格：

${chapterContext}

【核心规则】
1. 第一人称「我」，开篇第一句就是冲突——不铺垫不写景
2. 每段 1-3 句，段间空行，手机一屏 2-3 段
3. 40% 用对话推进，让人物自己说话
4. 每 800 字有新信息：反转/爆点/真相碎片
5. 前 1/3 冲突堆到最高点，后 2/3 高潮+反击+结局，女主必须赢

【禁止】Markdown / 环境描写超三行 / 大段独白 / 平淡收尾 / 女主吃亏

正文直接输出，最后一行操作指令 JSON。闲聊只输出自然语言。`,

      outline: `你是小说大纲规划助手，帮作者把零散的想法变成清晰的故事结构。

【已有角色】
${charBrief}

【当前大纲节点（情节关键点），修改已有节点时用对应的 id】
${outlineNodes || '暂无节点，需要从零开始'}

【规划指引】
- 每个节点是一个独立的情节事件，标题精炼有冲突感，摘要写清"谁做了什么，导致了什么变化"
- 节点之间必须有因果链：上一个节点的结果 = 下一个节点的起因
- 故事弧线完整：铺垫 → 激励事件 → 上升冲突 → 转折 → 高潮 → 收束
- 每个节点至少推动一个角色的状态变化（成长、堕落、觉悟、牺牲等）

【输出格式】
先按序号列出每个节点（标题 + 一句话摘要），最后一行输出纯 JSON 数组。

JSON 格式：
[{"action":"add_chapter","title":"节点标题","summary":"谁做了什么事，导致了什么变化或后果"}]

示例：
1. 血路重逢：陆启鸣在灰潮禁区偶遇失踪七年的师父柯常，发现对方双手已被灰石替代，正在替路币公会秘密测绘禁区。
2. 旧账翻新：霍青当众公开三年前的隧道事故记录，指控陆启鸣伪造数据——实则是顾长明栽赃的证据浮出水面。

[{"action":"add_chapter","title":"血路重逢","summary":"陆启鸣在灰潮禁区偶遇失踪七年的师父柯常，发现对方双手已被灰石替代，正在替路币公会秘密测绘禁区，陆启鸣对自己的过去产生怀疑。"}]

修改已有节点（用上面列表中的节点 ID）：
{"action":"update_chapter","chapter_id":"上面列表中的节点ID","title":"新标题","summary":"新摘要"}`,

      characters: `你是角色创作顾问，帮作者塑造生动、立体的角色。

【已有角色——修改已有角色时必须用对应的 char_id】
${charBrief || '暂无角色'}

【世界观——新角色必须符合这个世界】
${worldText.slice(0, 1500)}

【创作指引】
- 角色要服务于故事：为什么需要这个角色？TA推动什么情节？
- 性格不能凭空而来：用背景故事解释性格成因
- 说话风格要独特：每个角色有标志性的语气、用词习惯
- 角色之间要有化学反应：师徒、宿敌、暗恋、利用……关系让故事丰富
- custom_fields 用于超出固定字段的属性，如"灵根"、"异能力"、"血型"、"武器"等
- 如果用户提及已有角色名，用 update_character；否则用 create_character
- 输出角色描述一定要具体丰富，不能只有一两句笼统的话

【输出格式——严格遵守】
先对每个角色进行自然语言描述（姓名、性格、背景、与其他角色的关系等），让用户了解你的设计思路。然后在最后一行输出 JSON 供系统自动创建。

创建角色（每个角色一个对象，多个角色用 JSON 数组）：
[{"action":"create_character","name":"必填","gender":"男/女/?","age":0,"personality":"","identity":"","backstory":"","motivation":"","catchphrase":"","speech_style":"","appearance":"","is_main":false,"aliases":"别名1,别名2","custom_fields":[{"key":"属性名","value":"属性值"}]}]

修改已有角色：
{"action":"update_character","char_id":"上面列表中的角色ID","personality":"新性格","custom_fields":[{"key":"新能力","value":"描述"}]}

注意：最后一行 JSON 不要有任何额外字符（不用反引号包裹、不加缩进、不加注释）。`,

      world: `你是世界观构建专家，帮作者创造自洽、引人入胜的虚构世界。

【已有世界观分区——所有内容必须按以下分区名逐个输出】
${worldSectionNames.map((n) => `- ${n}`).join('\n')}

【当前各分区内容——空分区请填充，有内容的分区可补充或修改】
${worldText}

【构建指引】
- 每个分区都要给出具体、独特的细节
- 规则要有代价，设定要推动故事
- 不同势力/阵营要有不同的价值观和利益冲突

【输出格式——严格遵守】
按上面列出的分区名，逐个输出正文内容，格式如下：

分区名
该分区的详细正文...

（用空行分隔分区，分区名必须与上面列表中的完全一致）
如果现有分区不够，在内容中建议新增分区。
回答的最后一行输出 JSON，包含所有有内容的分区：
{"action":"update_sections","sections":[{"name":"分区名","content":"完整内容"},{"name":"分区名","content":"完整内容"}]}`,

      settings: `你是作品配置助手。帮作者调整写作风格、自动保存间隔、每日字数目标等设置。

【当前状态】
- 写作风格预设：${params.message}
- 可根据作者习惯给出建议

【回复格式】
只输出自然语言建议，不需要 JSON。`,

      default: `你是 Muse AI 写作助手，帮小说作者完成创作。

【角色】
${charBrief}

【世界观】
${worldText.slice(0, 1000)}

用自然语言回复作者的问题，涉及具体操作时给出明确指引。`,
    };

    const systemPrompt = isShort
      ? prompts.short
      : (prompts[ct] ?? prompts.write);

    try {
      const cleanMessages = params.messages
        ? sanitizeMessages(params.messages)
        : [{ role: 'user', content: sanitizePrompt(params.message) }];
      void this.streamChatToClient(
        res,
        systemPrompt,
        cleanMessages,
        params.model ?? 'deepseek-chat',
        isShort ? 24576 : 8192,
      );
    } catch (e: any) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: e.message ?? 'AI 服务异常' })}\n\n`,
      );
      res.end();
    }
  }

  private async streamChatToClient(
    res: Response,
    systemPrompt: string,
    messages: any[],
    model: string = 'deepseek-chat',
    maxTokens = 8192,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const apiKey = process.env.AI_PLATFORM_KEY;
    if (!apiKey) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 未配置' })}\n\n`,
      );
      res.end();
      return;
    }

    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          stream: true,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(maxTokens > 16000 ? 420000 : 120000),
      });

      if (!response.ok) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: 'AI 请求失败' })}\n\n`,
        );
        res.end();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';
      res.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
            try {
              const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (reasoning) {
                fullReasoning += reasoning;
                res.write(
                  `event: reasoning\ndata: ${JSON.stringify(reasoning)}\n\n`,
                );
              }
              if (content) {
                fullContent += content;
                res.write(`event: chunk\ndata: ${JSON.stringify(content)}\n\n`);
              }
            } catch {
              /* empty */
            }
          }
        }
      }

      // 从末尾行反向查找 JSON action，容错中文引号冲突和 markdown 代码块
      try {
        const combined = fullContent || fullReasoning;
        const revLines = combined.split('\n').reverse();
        for (const line of revLines) {
          let trimmed = line.trim();
          // 处理被 ``` 包裹的情况：去掉末尾的 ``` 和开头的 ```json
          if (trimmed.endsWith('```')) trimmed = trimmed.slice(0, -3).trim();
          // 处理 ```json{"action":...} 或 {"action":...}``` 混合在同一行
          const fenceIdx = trimmed.indexOf('```json');
          if (fenceIdx >= 0) trimmed = trimmed.slice(fenceIdx + 7).trim();
          if (trimmed.startsWith('```')) trimmed = trimmed.slice(3).trim();
          // 支持 JSON 对象 {...} 或数组 [{...}]
          if (
            (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
            trimmed.includes('"action"')
          ) {
            let parsed: any = null;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              // 尝试修复无效 JSON
              const fixed = trimmed.replace(
                /"content"\s*:\s*"([\s\S]*?)"\s*[,}]/g,
                (_: string, inner: string) => {
                  const escaped = inner.replace(
                    /(?<!\\)"(?!"\s*[,:}\]])/g,
                    '"',
                  );
                  return `"content":"${escaped}"`;
                },
              );
              try {
                parsed = JSON.parse(fixed);
              } catch {
                /* 放弃 */
              }
            }
            if (parsed) {
              if (Array.isArray(parsed) && parsed.length > 0) {
                // 数组：逐个作为独立 action 发送；前端 adopt 会遍历处理
                res.write(`event: action\ndata: ${JSON.stringify(parsed)}\n\n`);
              } else if (parsed.action) {
                res.write(`event: action\ndata: ${JSON.stringify(parsed)}\n\n`);
              }
            }
            break;
          }
        }
      } catch {
        /* empty */
      }

      res.write('event: done\ndata: {}\n\n');
    } catch (e: any) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 服务异常' })}\n\n`,
      );
    }
    res.end();
  }

  // AI 模仿笔风：分析已完成章节，提取写作风格特征
  async mimicStyle(bookId?: string, model?: string, customText?: string, userId?: string) {
    const resolved = await this.resolveApiKey(userId, 'chat', model);
    if (!resolved.apiKey) return { analysis: '' };

    let sample = '';

    if (customText && customText.trim().length >= 200) {
      sample = sanitizePrompt(customText);
    } else if (bookId) {
      const db = getDb();
      const chapters = await db
        .select({ content: schema.chapters.content, title: schema.chapters.title })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, bookId));
      for (const ch of chapters) {
        if (sample.length >= 5000) break;
        sample += ch.content.slice(0, 2000) + '\n\n';
      }
    }

    if (sample.trim().length < 200) return { analysis: '内容不足，需至少 200 字' };

    try {
      const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}` },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            {
              role: 'user',
              content: `以下是一位小说作者的写作样本。请分析其写作风格特征，包括：
1. 词汇偏好（常用词汇、修辞手法）
2. 句子结构（长短句比例、句式复杂度）
3. 语气和语调（正式/随意、客观/感性）
4. 叙事特点（视角运用、描写密度、对话比例）
5. 节奏感（段落长度、标点使用习惯）

以简洁的自然语言返回分析结果（100-200字），作为AI后续续写时的风格参考。

【写作样本】
${sample.slice(0, 5000)}`,
            },
          ],
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const analysis = data.choices?.[0]?.message?.content ?? '';
      return { analysis };
    } catch {
      return { analysis: '' };
    }
  }

  // ============== 会话管理 ==============

  // 获取活跃会话（含消息），不存在则返回 null
  async getActiveSession(bookId: string, section: string) {
    const db = getDb();
    const [session] = await db
      .select()
      .from(schema.ai_chat_sessions)
      .where(
        and(
          eq(schema.ai_chat_sessions.book_id, bookId),
          eq(schema.ai_chat_sessions.section, section),
          eq(schema.ai_chat_sessions.active, true),
        ),
      )
      .limit(1);
    return session ?? null;
  }

  // 获取指定 section 的所有会话（按时间倒序）
  async getSessions(bookId: string, section: string) {
    const db = getDb();
    return db
      .select()
      .from(schema.ai_chat_sessions)
      .where(
        and(
          eq(schema.ai_chat_sessions.book_id, bookId),
          eq(schema.ai_chat_sessions.section, section),
        ),
      )
      .orderBy(desc(schema.ai_chat_sessions.updated_at));
  }

  // 创建新会话：归档当前活跃会话，创建新的
  async createSession(
    bookId: string,
    section: string,
    title: string,
    userId: string,
  ) {
    await this.checkBookOwnership(bookId, userId);
    const db = getDb();

    // 归档当前活跃会话
    await db
      .update(schema.ai_chat_sessions)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(schema.ai_chat_sessions.book_id, bookId),
          eq(schema.ai_chat_sessions.section, section),
          eq(schema.ai_chat_sessions.active, true),
        ),
      );

    // 创建新会话
    const [created] = await db
      .insert(schema.ai_chat_sessions)
      .values({ book_id: bookId, section, title, messages: [], active: true })
      .returning();
    return created;
  }

  // 更新会话消息
  async updateSessionMessages(
    sessionId: string,
    messages: any[],
    userId: string,
  ) {
    const db = getDb();
    const [s] = await db
      .select()
      .from(schema.ai_chat_sessions)
      .where(eq(schema.ai_chat_sessions.id, sessionId))
      .limit(1);
    if (!s) throw new Error('会话不存在');
    await this.checkBookOwnership(s.book_id, userId);

    // 自动更新标题（如果还没有标题，取第一条用户消息的前30字）
    let title = s.title;
    if (!title) {
      const firstUser = messages.find((m: any) => m.role === 'user');
      title = firstUser
        ? `${new Date().toLocaleDateString('zh-CN')} ${firstUser.content.slice(0, 30)}`
        : new Date().toLocaleDateString('zh-CN');
    }

    await db
      .update(schema.ai_chat_sessions)
      .set({ messages, title, updated_at: new Date() })
      .where(eq(schema.ai_chat_sessions.id, sessionId));
  }

  // 恢复已归档会话：归档当前活跃，激活目标
  async restoreSession(sessionId: string, userId: string) {
    const db = getDb();
    const [target] = await db
      .select()
      .from(schema.ai_chat_sessions)
      .where(eq(schema.ai_chat_sessions.id, sessionId))
      .limit(1);
    if (!target) throw new Error('会话不存在');
    await this.checkBookOwnership(target.book_id, userId);

    // 归档当前活跃会话
    await db
      .update(schema.ai_chat_sessions)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(schema.ai_chat_sessions.book_id, target.book_id),
          eq(schema.ai_chat_sessions.section, target.section),
          eq(schema.ai_chat_sessions.active, true),
        ),
      );

    // 激活目标会话
    await db
      .update(schema.ai_chat_sessions)
      .set({ active: true, updated_at: new Date() })
      .where(eq(schema.ai_chat_sessions.id, sessionId));
  }

  // 删除会话
  async deleteSession(sessionId: string, userId: string) {
    const db = getDb();
    const [s] = await db
      .select()
      .from(schema.ai_chat_sessions)
      .where(eq(schema.ai_chat_sessions.id, sessionId))
      .limit(1);
    if (!s) throw new Error('会话不存在');
    await this.checkBookOwnership(s.book_id, userId);
    await db
      .delete(schema.ai_chat_sessions)
      .where(eq(schema.ai_chat_sessions.id, sessionId));
  }

  // ============== AI 生图 ==============

  // 通用生图方法
  async generateImage(
    prompt: string,
    size = '2K',
    style?: string,
    userId?: string,
    modelHint?: string,
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

    const resolved = await this.resolveApiKey(userId, 'image', modelHint);
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
      imageUrl =
        data?.output?.choices?.[0]?.message?.content?.[0]?.image || '';
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
        ? (world.sections as any[])
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
  async recommendVisualStyle(bookId: string) {
    const db = getDb();
    const [world] = await db
      .select({ sections: schema.world_settings.sections })
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId));

    const worldText =
      world?.sections && Array.isArray(world.sections)
        ? (world.sections as any[])
            .map((s: any) => s.content)
            .join('\n')
            .slice(0, 2000)
        : '';

    if (!worldText.trim()) return { style: '电影写实风' };

    // 用 DeepSeek 分析并推荐
    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';
    const apiKey = process.env.AI_PLATFORM_KEY;
    if (!apiKey) return { style: '电影写实风' };

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
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

  // ============== 生成简介 ==============

  async generateSynopsis(bookId: string, userId?: string, model?: string) {
    const db = getDb();
    const [book] = await db
      .select({ title: schema.books.title, user_id: schema.books.user_id })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book) return { synopsis: '' };

    const resolved = await this.resolveApiKey(userId, 'chat', model);
    if (!resolved.apiKey) return { synopsis: '' };

    // 取章节摘要
    const chapters = await db
      .select({ content: schema.chapters.content })
      .from(schema.chapters)
      .where(eq(schema.chapters.book_id, bookId))
      .orderBy(schema.chapters.sort_order)
      .limit(5);
    const chapterSamples = chapters.map((c) => c.content?.slice(0, 1000)).join('\n');
    const chars = await db
      .select({ name: schema.characters.name, identity: schema.characters.identity })
      .from(schema.characters)
      .where(eq(schema.characters.book_id, bookId))
      .limit(5);
    const charBrief = chars.map((c) => `${c.name}：${c.identity || ''}`).join('；');
    const [outline] = await db.select().from(schema.outlines).where(eq(schema.outlines.book_id, bookId));
    const nodes = outline
      ? await db.select().from(schema.outline_chapters).where(eq(schema.outline_chapters.outline_id, outline.outline_id)).orderBy(schema.outline_chapters.sort_order).limit(5)
      : [];
    const nodeBrief = nodes.map((n) => n.title).join(' → ');

    const prompt = `根据以下信息，为小说《${book.title}》写一段简介（200-400字），吸引读者。概况主线、主要冲突和看点。只输出简介文本。`;

    const summary = [chapterSamples ? `内容节选：${chapterSamples.slice(0, 2000)}` : '', charBrief ? `主要角色：${charBrief}` : '', nodeBrief ? `情节主线：${nodeBrief}` : ''].filter(Boolean).join('\n\n');

    try {
      const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}` },
        body: JSON.stringify({ model: resolved.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: summary }], max_tokens: 1024 }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const synopsis = (data.choices?.[0]?.message?.content || '').trim();
      if (synopsis) {
        const [settings] = await db.select({ extra: schema.book_settings.extra }).from(schema.book_settings).where(eq(schema.book_settings.book_id, bookId));
        const extra = (settings?.extra ?? {}) as Record<string, any>;
        extra.synopsis = synopsis;
        await db.update(schema.book_settings).set({ extra: extra as any }).where(eq(schema.book_settings.book_id, bookId));
      }
      return { synopsis };
    } catch { return { synopsis: '' }; }
  }

  // ============== 快捷创作 ==============

  // 短篇快捷创作：输入脑洞 → AI 直接写完完整故事
  async quickCreateShort(
    res: Response,
    params: { user_id: string; premise: string; model?: string },
  ) {
    const db = getDb();
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(params.user_id, 'chat', model);
    const apiKey = resolved.apiKey;
    const baseUrl = resolved.baseUrl;
    const premise = sanitizePrompt(params.premise);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const send = (event: string, data: Record<string, any>) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // Step 1: 创建短篇作品 + 唯一章节
      send('step', { step: 'book', status: 'generating', label: '创建作品' });
      const title =
        premise.length > 20 ? premise.slice(0, 20) + '...' : premise;
      const [book] = await db
        .insert(schema.books)
        .values({ user_id: params.user_id, title, type: 'short' } as any)
        .returning({ book_id: schema.books.book_id });
      const bookId = book.book_id;
      await db
        .insert(schema.book_settings)
        .values({ book_id: bookId, preset_style: 'default' });
      const [chapter] = await db
        .insert(schema.chapters)
        .values({ book_id: bookId, title: '正文', sort_order: 1 })
        .returning({ chapter_id: schema.chapters.chapter_id });
      send('step', {
        step: 'book',
        status: 'done',
        label: '作品已创建',
        book_id: bookId,
      });

      // Step 2: AI 生成完整短篇
      send('step', {
        step: 'story',
        status: 'generating',
        label: '正在写故事...',
      });
      const storyPrompt = `你是知乎盐选爆款短篇作家。参照以下风格：

【风格示范——这就是我要的节奏和质感】
结婚三年，顾景琛从没碰过我。直到我递上离婚协议那天，他却疯了。

他站在暴雨里，浑身湿透，手里攥着被我改过的那份协议。我坐在暖烘烘的咖啡厅里，隔着落地窗看他。林薇戳了戳我胳膊："你就让他那么淋着？" "淋着吧。"我搅了搅咖啡，"淋不坏。"

三小时。他在雨里站了三小时。我在咖啡厅里续了两杯拿铁。最后他推门进来，眼眶通红："协议上写的——房子归你，存款归你。我只要一个机会。"

我放下杯子，看着他狼狈的样子，忽然觉得很平静。

"顾景琛，"我说，"你要机会？三年前你跟实习生去三亚，我给过。两年前你把我的存款转走，我给过。一年前你妈上门骂我，我还是给过。现在——你问老天要去吧。"

我推门出去，雨停了。手机一震，律师发来消息："财产交割完成，恭喜。"

原来甩掉一个错的人，比遇见一个对的人，更让人快乐。

【核心规则】
1. 第一人称「我」，开篇第一句就是冲突——不铺垫不写景不交代背景
2. 每段 1-3 句话，段间空一行（手机一屏只看 2-3 段）
3. 40% 用对话推进——让人物自己说话，不要旁白替他们解释
4. 每 800 字必须有新信息：反转/爆点/真相碎片/人物新面目，不给读者喘气
5. 前 1/3 篇幅冲突堆到最高点卡住，后 2/3 展开高潮+反击+结局，女主必须赢且赢得漂亮
6. 主要角色 3-5 个，名字从开头到结尾不变。配角（同事/路人/服务员）可以出现但不给名字，避免混淆

【禁止】
Markdown / 环境描写超三行 / 大段独白 / 平淡收尾 / 女主吃亏 / 角色名中途变化 / 配角喧宾夺主

纯文本输出，写 4000-5000 字作为故事前半部分，在剧情关键时刻停住，最后一行标注：【待续】。`;

      // 第一轮：生成前半部分
      const r1 = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: storyPrompt },
            {
              role: 'user',
              content: `脑洞/想法：${premise}\n\n请写故事的前半部分（4000-5000字），在剧情关键时刻停住。`,
            },
          ],
          max_tokens: 16384,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!r1.ok) { send('error', { message: `AI 请求失败 (${r1.status})` }); res.end(); return; }
      const data1 = await r1.json();
      const part1 = (data1.choices?.[0]?.message?.content ?? '').replace(
        /【待续】.*$/s,
        '',
      );

      send('step', {
        step: 'story',
        status: 'generating',
        label: `前半部分完成（${part1.length} 字），正在续写后半部分...`,
        preview: part1.slice(0, 150),
      });

      // 第二轮：续写后半部分
      const r2 = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: storyPrompt },
            {
              role: 'user',
              content: `脑洞/想法：${premise}\n\n已写的前半部分：\n${part1.slice(-1000)}\n\n请接着写后半部分（4000-5000字），展开高潮、揭示真相、给出完整结局。`,
            },
          ],
          max_tokens: 16384,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!r2.ok) { send('error', { message: `AI 续写失败 (${r2.status})` }); res.end(); return; }
      const data2 = await r2.json();
      const part2 = data2.choices?.[0]?.message?.content ?? '';
      const storyText = part1 + '\n\n' + part2;

      if (storyText.trim()) {
        await db
          .update(schema.chapters)
          .set({
            content: storyText,
            word_count: storyText.length,
            updated_at: new Date(),
          } as any)
          .where(eq(schema.chapters.chapter_id, chapter.chapter_id));
        await db
          .update(schema.books)
          .set({ word_count: storyText.length, updated_at: new Date() } as any)
          .where(eq(schema.books.book_id, bookId));
        send('step', {
          step: 'story',
          status: 'done',
          label: `故事已生成（${storyText.length} 字）`,
          preview: storyText.slice(0, 200),
        });
      }

      // Step 3: 生成书名
      send('step', { step: 'title', status: 'generating', label: '生成书名' });
      const titleR = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: `根据以下短篇故事，生成一个吸引人的标题（10字以内）。只输出标题，不要加引号。\n\n${storyText.slice(0, 500)}`,
            },
          ],
          max_tokens: 50,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const titleData = await titleR.json();
      const finalTitle =
        (titleData.choices?.[0]?.message?.content ?? premise.slice(0, 15))
          .trim()
          .slice(0, 30) || '短篇故事';
      await db
        .update(schema.books)
        .set({ title: finalTitle, updated_at: new Date() } as any)
        .where(eq(schema.books.book_id, bookId));
      send('step', {
        step: 'title',
        status: 'done',
        label: `书名：${finalTitle}`,
      });

      send('done', { book_id: bookId, title: finalTitle });
    } catch (err: any) {
      send('error', { message: err?.message ?? '生成失败' });
    } finally {
      res.end();
    }
  }

  async quickCreate(
    res: Response,
    params: { user_id: string; premise: string; model?: string },
  ) {
    const db = getDb();
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(params.user_id, 'chat', model);
    const apiKey = resolved.apiKey;
    const baseUrl = resolved.baseUrl;
    const premise = sanitizePrompt(params.premise);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    const send = (event: string, data: Record<string, any>) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
    ): Promise<string> => {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 4096,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw new Error(`AI API 错误 (${r.status})`);
      const d = await r.json();
      return d.choices?.[0]?.message?.content ?? '';
    };

    try {
      // Step 1: 创建作品
      send('step', { step: 'book', status: 'generating', label: '创建作品' });
      const title =
        premise.length > 20 ? premise.slice(0, 20) + '...' : premise;
      const [book] = await db
        .insert(schema.books)
        .values({ user_id: params.user_id, title })
        .returning({ book_id: schema.books.book_id });
      const bookId = book.book_id;
      await db
        .insert(schema.book_settings)
        .values({ book_id: bookId, preset_style: 'default' });
      await db.insert(schema.outlines).values({ book_id: bookId });
      await db
        .insert(schema.world_settings)
        .values({ book_id: bookId, sections: [] } as any);
      send('step', {
        step: 'book',
        status: 'done',
        label: '作品已创建',
        book_id: bookId,
      });

      // Step 2: 生成世界观
      send('step', {
        step: 'world',
        status: 'generating',
        label: '生成世界观',
      });
      const worldPrompt = `你是世界观构建专家。根据用户提供的题材和想法，创造一个自洽、引人入胜的虚构世界。

按以下分区输出：
- 时代与背景
- 地理与场景
- 规则与体系
- 势力与阵营

每个分区给出具体、独特的细节。规则要有代价，设定要推动故事。

【输出格式——严格遵守】
按分区名逐个输出正文内容，格式如下：

分区名
该分区的详细正文...

（用空行分隔分区）
回答的最后一行输出 JSON：
{"action":"update_sections","sections":[{"name":"分区名","content":"完整内容"},...]}`;

      const worldText = await aiCall(
        worldPrompt,
        `题材和想法：${premise}\n\n请构建这个世界观。`,
      );
      send('step', {
        step: 'world',
        status: 'parsing',
        label: '保存世界观',
        preview: worldText.slice(0, 200),
      });
      await this.parseAndSaveWorld(bookId, worldText);
      send('step', { step: 'world', status: 'done', label: '世界观已生成' });

      // Step 3: 生成大纲
      send('step', {
        step: 'outline',
        status: 'generating',
        label: '生成大纲',
      });
      const outlinePrompt = `你是小说大纲规划助手。根据世界观，为这部小说设计情节大纲。

每个节点是一个独立的情节事件，标题精炼有冲突感，摘要写清"谁做了什么，导致了什么变化"。
故事弧线完整：铺垫 → 激励事件 → 上升冲突 → 转折 → 高潮 → 收束。
节点之间必须有因果链。

【输出格式】
先按序号列出每个节点（标题 + 一句话摘要），最后一行输出纯 JSON 数组：
[{"action":"add_chapter","title":"节点标题","summary":"谁做了什么事，导致了什么变化或后果"}]`;

      const outlineText = await aiCall(
        outlinePrompt,
        `题材和想法：${premise}\n\n世界观：${worldText.slice(0, 2000)}\n\n请设计大纲。`,
      );
      send('step', {
        step: 'outline',
        status: 'parsing',
        label: '保存大纲',
        preview: outlineText.slice(0, 200),
      });
      await this.parseAndSaveOutline(bookId, outlineText);
      send('step', { step: 'outline', status: 'done', label: '大纲已生成' });

      // Step 4: 生成角色
      send('step', {
        step: 'characters',
        status: 'generating',
        label: '生成角色',
      });
      const charsPrompt = `你是角色创作顾问。根据世界观和大纲，塑造生动、立体的角色。

【创作指引】
- 角色要服务于故事：为什么需要这个角色？TA推动什么情节？
- 性格不能凭空而来：用背景故事解释性格成因
- 每个角色都要具体丰富，不能只有一两句笼统的话
- 至少包含主角、重要配角、反派

【输出格式——严格遵守】
先对每个角色进行自然语言描述。然后在最后一行输出 JSON 数组：
[{"action":"create_character","name":"必填","gender":"男/女","age":0,"personality":"","identity":"","backstory":"","motivation":"","catchphrase":"","speech_style":"","appearance":"","is_main":false}]`;

      const charsText = await aiCall(
        charsPrompt,
        `题材和想法：${premise}\n\n世界观：${worldText.slice(0, 1500)}\n\n请设计角色。`,
      );
      const charCount = await this.parseAndSaveCharacters(bookId, charsText);
      send('step', {
        step: 'characters',
        status: 'done',
        label: `已创建 ${charCount} 个角色`,
      });

      // Step 5: 生成书名
      send('step', { step: 'title', status: 'generating', label: '生成书名' });
      const titlePrompt = `根据以下小说设定，生成一个吸引人的书名（10-20字以内）。只输出书名，不要其他文字。`;
      const titleSummary = `题材：${premise.slice(0, 300)}\n\n世界观：${worldText.slice(0, 500)}`;
      const generatedTitle = (await aiCall(titlePrompt, titleSummary))
        .trim()
        .slice(0, 40);
      let finalTitle = generatedTitle || premise.slice(0, 20);
      // 更新书名
      await db
        .update(schema.books)
        .set({ title: finalTitle, updated_at: new Date() } as any)
        .where(eq(schema.books.book_id, bookId));
      send('step', {
        step: 'title',
        status: 'done',
        label: `书名：${finalTitle}`,
      });

      // 完成
      send('done', { book_id: bookId, title: finalTitle });
    } catch (err: any) {
      send('error', { message: err?.message ?? '生成失败' });
    } finally {
      res.end();
    }
  }

  // 解析并保存世界观
  private async parseAndSaveWorld(bookId: string, aiText: string) {
    const db = getDb();
    let sections: { name: string; content: string }[] = [];

    console.log(
      '[quickCreate] world AI response (first 300):',
      aiText.slice(0, 300),
    );

    // 尝试从 JSON action 提取（s 标志支持多行）
    const jsonMatch = aiText.match(/\{"action":"update_sections"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        sections = parsed.sections || [];
        console.log(
          '[quickCreate] parsed world sections from JSON:',
          sections.length,
        );
      } catch (e) {
        console.log('[quickCreate] world JSON parse failed:', e);
      }
    }

    // 如果没有 JSON，按分区名分割
    if (sections.length === 0) {
      const knownSections = [
        '时代与背景',
        '地理与场景',
        '规则与体系',
        '势力与阵营',
      ];
      const text = aiText.replace(/\{"action"[\s\S]*\}/, '');
      for (const name of knownSections) {
        const regex = new RegExp(
          `${name}\\s*\\n([\\s\\S]*?)(?=\\n(?:${knownSections.join('|')})\\n|$)`,
          'i',
        );
        const m = text.match(regex);
        if (m && m[1].trim()) {
          sections.push({ name, content: m[1].trim() });
        }
      }
      console.log(
        '[quickCreate] parsed world sections from text:',
        sections.length,
      );
    }

    if (sections.length > 0) {
      console.log(
        '[quickCreate] world saving',
        sections.length,
        'sections:',
        sections.map((s) => s.name).join(', '),
      );
      const result = await db
        .update(schema.world_settings)
        .set({ sections: sections as any, updated_at: new Date() } as any)
        .where(eq(schema.world_settings.book_id, bookId));
      // 兜底：如果 update 没命中（可能行不存在），尝试 insert
      if ((result as any)?.rowCount === 0) {
        await db
          .insert(schema.world_settings)
          .values({ book_id: bookId, sections: sections as any } as any);
      }
    }
  }

  // 解析并保存大纲
  private async parseAndSaveOutline(bookId: string, aiText: string) {
    const db = getDb();
    let nodes: { title: string; summary: string }[] = [];

    console.log(
      '[quickCreate] outline AI response (first 300):',
      aiText.slice(0, 300),
    );

    const jsonMatch = aiText.match(/\[[\s\S]*"action":"add_chapter"[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        nodes = parsed
          .filter((a: any) => a.action === 'add_chapter')
          .map((a: any) => ({ title: a.title, summary: a.summary || '' }));
        console.log(
          '[quickCreate] parsed outline nodes from JSON:',
          nodes.length,
        );
      } catch (e) {
        console.log('[quickCreate] outline JSON parse failed:', e);
      }
    }

    if (nodes.length > 0) {
      const [outline] = await db
        .select({ outline_id: schema.outlines.outline_id })
        .from(schema.outlines)
        .where(eq(schema.outlines.book_id, bookId))
        .limit(1);
      if (outline) {
        for (let i = 0; i < nodes.length; i++) {
          await db.insert(schema.outline_chapters).values({
            outline_id: outline.outline_id,
            title: nodes[i].title,
            status: 'draft',
            summary: nodes[i].summary,
            sort_order: i + 1,
          });
        }
      }
    }
  }

  // 解析并保存角色
  private async parseAndSaveCharacters(bookId: string, aiText: string) {
    const db = getDb();
    let chars: any[] = [];

    console.log('[quickCreate] chars AI full response length:', aiText.length);
    console.log(
      '[quickCreate] chars AI response tail 500:',
      aiText.slice(-500),
    );

    // 多种方式尝试提取 JSON
    const attempts: string[] = [];

    // 1. 去掉 markdown 代码块
    const codeBlock = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) attempts.push(codeBlock[1].trim());

    // 2. 正则匹配完整的 JSON 数组
    const jsonMatch = aiText.match(
      /\[[\s\S]*"action"\s*:\s*"create_character"[\s\S]*\]/,
    );
    if (jsonMatch) attempts.push(jsonMatch[0]);

    // 3. 从最后一个 [ 开始到最后一个 ] 结束
    const lastOpen = aiText.lastIndexOf('[');
    const lastClose = aiText.lastIndexOf(']');
    if (lastOpen >= 0 && lastClose > lastOpen) {
      attempts.push(aiText.slice(lastOpen, lastClose + 1));
    }

    for (const tryStr of attempts) {
      try {
        const parsed = JSON.parse(tryStr);
        const found = Array.isArray(parsed)
          ? parsed.filter((a: any) => a.action === 'create_character')
          : [];
        if (found.length > 0) {
          chars = found;
          break;
        }
      } catch {
        /* try next */
      }
    }

    console.log('[quickCreate] parsed chars:', chars.length);
    for (const c of chars) {
      await db.insert(schema.characters).values({
        book_id: bookId,
        name: c.name || '未命名角色',
        gender: c.gender || '',
        age: c.age || null,
        personality: c.personality || '',
        identity: c.identity || '',
        backstory: c.backstory || '',
        motivation: c.motivation || '',
        catchphrase: c.catchphrase || '',
        speech_style: c.speech_style || '',
        appearance: c.appearance || '',
        is_main: c.is_main || false,
        aliases: c.aliases || '',
        custom_fields: c.custom_fields || [],
      } as any);
    }
    return chars.length;
  }
}
