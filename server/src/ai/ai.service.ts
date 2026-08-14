import { Injectable } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { Response } from 'express';
import crypto from 'crypto';
import { writeFile, mkdir, unlink } from 'fs/promises';
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
  ): Promise<{
    apiKey: string;
    baseUrl: string;
    model: string;
    source: 'user' | 'platform';
  }> {
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
          return {
            apiKey: decrypted,
            baseUrl: k.base_url,
            model: k.model_name,
            source: 'user',
          };
        } catch {
          /* fall through */
        }
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
        source: 'platform',
      };
    }

    return usage === 'image'
      ? {
          apiKey: process.env.VOLCANO_IMAGE_KEY || '',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: modelHint || 'doubao-seedream-5-0-260128',
          source: 'platform',
        }
      : {
          apiKey: process.env.AI_PLATFORM_KEY || '',
          baseUrl:
            process.env.AI_PLATFORM_BASE_URL || 'https://api.deepseek.com/v1',
          model: modelHint || 'deepseek-v4-flash',
          source: 'platform',
        };
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

    const apiKey = process.env.AI_PLATFORM_KEY;
    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';

    if (!usePlatformKey) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: '自定义 Key 请通过前端直连' })}\n\n`,
      );
      res.end();
      return;
    }

    if (!apiKey) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 服务未配置' })}\n\n`,
      );
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

  /**
   * 记录 AI 用量：明细表 + 月度汇总原子累加
   * 中文按 1 字 ≈ 1 token 估算；失败不阻断主流程（用量记录不影响生成）
   */
  private async recordUsage(params: {
    userId?: string;
    bookId?: string;
    model: string;
    inChars: number;
    outChars: number;
    usageType: 'platform_key' | 'user_key';
  }): Promise<void> {
    if (!params.userId) return;
    try {
      const db = getDb();
      const tokenCount = Math.max(
        1,
        Math.round((params.inChars + params.outChars) * 0.75),
      );
      await db.insert(schema.token_usage_records).values({
        user_id: params.userId,
        book_id: params.bookId || null,
        token_count: tokenCount,
        model_name: params.model,
        usage_type: params.usageType,
      });
      const month = new Date().toISOString().slice(0, 7);
      await db
        .insert(schema.user_monthly_quota)
        .values({ user_id: params.userId, month, used_tokens: tokenCount })
        .onConflictDoUpdate({
          target: [
            schema.user_monthly_quota.user_id,
            schema.user_monthly_quota.month,
          ],
          set: {
            used_tokens: sql`${schema.user_monthly_quota.used_tokens} + ${tokenCount}`,
          },
        });
    } catch (e: any) {
      console.error('[usage] record failed:', e.message);
    }
  }

  // 构建引导模式 system prompt
  static buildGuideSystemPrompt(context?: string, type?: string): string {
    const isShort = type === 'short';
    const typeGuide = isShort
      ? `\n【篇幅注意——短篇】
- 作者要写的是短篇（8000-20000字），故事结构应紧凑聚焦
- 引导时侧重：单一核心冲突、1-3个关键角色、一个强有力的结尾反转`
      : `\n【篇幅注意——长篇网文】
- 作者要写的是长篇网络小说。从作者的脑洞中识别这个故事的驱动力，围绕它来提问，不预设模板`;

    return `你是一位创作导师，帮作者把模糊的想法打磨成精彩的故事。${typeGuide}

【怎么做——看例子】

作者："雇主因为女主和他亡妻长得一模一样，找上她做替身"
❌ 错误："那她是主动去扮演还是被人雇的？" ← 作者已经说了雇主找上她
✅ 正确："雇主主动找上门的——是私下交易，还是有人牵线？"

作者："女主绑定了平行时空系统，可以学习未来的知识"
❌ 错误："在信息闭塞的年代，她怎么获取知识？" ← 系统已经解决了
✅ 正确："系统提供的学习资料是什么样的？她能带进现实世界使用吗？"

作者："我想写一个重生经商的故事"
❌ 错误："重生文应该有金手指，你的女主金手指是什么？" ← 不要预设
✅ 正确："她重生回去做什么生意？为什么选这个行业？"

【你的工作方式】
1. **作者的描述越短，越帮他拆细**。他说"美食"，你问"美食的什么？做菜、经营、评测、还是收集？"他说"做菜"，你问"是系统升级流（做一道学一道），还是现实成长流（学艺拜师开店）？"——每一轮帮他把模糊的想法拆成一个可回答的具体问题
2. **作者卡住了怎么办**：他不确定主角怎么突破瓶颈、不知道怎么推动剧情、不知道怎么收尾——给他 2-3 个具体的方向选项，附带简短的理由，让他选。不要反问"你想怎么解决"，而是"你可以试试A/B/C，因为..."
3. **先定引擎，再展开**：确定故事靠什么推着走（升级/复仇/经营/关系/谜团），然后围绕引擎追问：升级路径是什么、关键转折在哪、终点是什么样
2. 从作者上一轮的回答里找到没说清楚的点，追问
3. 不确定作者的意思就问"是A还是B？"，不要猜
3. 反馈 = 一句肯定 + 一句话提炼 + 一个问题，控制在 100 字内
4. 作者说"开始生成""差不多了"时，立即停止提问，输出摘要。摘要基于对话中已讨论的内容进行总结，可以合理扩展细节，但不要修改或替换作者已明确的设定：

\`\`\`
【故事主题】基于对话的一句话
【主角画像】仅对话中已提到的信息
【核心驱动力】推着故事往前走的是什么
【关键节点】仅对话中已讨论的情节
【叙事风格】视角 + 节奏
\`\`\`
${context ? `\n【用户的初始想法】\n${context}` : ''}`;
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
      guide_mode?: boolean;
      guide_context?: string;
      guide_type?: string;
    },
  ) {
    const db = getDb();
    const ct = params.context_type;

    // 引导模式：使用引导 prompt，无需加载作品上下文
    if (params.guide_mode) {
      try {
        const guidePrompt = AiService.buildGuideSystemPrompt(
          params.guide_context,
          params.guide_type,
        );
        const cleanMessages = Array.isArray(params.messages)
          ? sanitizeMessages(params.messages)
          : [];
        const resolved = await this.resolveApiKey(
          params.user_id,
          'chat',
          params.model,
        );
        await this.streamChatToClient(
          res,
          guidePrompt,
          cleanMessages,
          resolved.model,
          8192,
          resolved.apiKey,
          resolved.baseUrl,
          {
            userId: params.user_id,
            bookId: params.book_id || undefined,
            usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
          },
        );
      } catch (e: any) {
        console.error('[guide_mode] stream error:', e.message ?? e);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: e.message ?? 'AI 服务异常' })}\n\n`,
        );
        res.end();
      }
      return;
    }

    // 校验所有权（空 book_id = 作品外临时请求，如随机灵感，跳过）
    if (params.user_id && params.book_id) {
      await this.checkBookOwnership(params.book_id, params.user_id);
    }

    // 查作品类型（空 book_id 跳过查询，按长篇默认）
    let bookType = 'novel';
    if (params.book_id) {
      const [book] = await db
        .select({ type: schema.books.type })
        .from(schema.books)
        .where(eq(schema.books.book_id, params.book_id))
        .limit(1);
      bookType = book?.type ?? 'novel';
    }

    // 短篇跳过上下文加载（不需要世界观/大纲/角色）
    const isShort = bookType === 'short';

    // 通用上下文：角色（完整字段）、世界观、大纲（长篇才加载；空 book_id 全跳过）
    const skipCtx = isShort || !params.book_id;
    const chars = skipCtx
      ? []
      : await db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.book_id, params.book_id));

    const [world] = skipCtx
      ? [null]
      : await db
          .select()
          .from(schema.world_settings)
          .where(eq(schema.world_settings.book_id, params.book_id));

    const [outline] = skipCtx
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
          sort_order: schema.chapters.sort_order,
          bound_outline_node_id: schema.chapters.bound_outline_node_id,
        })
        .from(schema.chapters)
        .where(
          and(
            eq(schema.chapters.chapter_id, params.chapter_id),
            eq(schema.chapters.book_id, params.book_id),
          ),
        );

      if (ch) {
        // 前情提要：长篇 AI 记忆——取当前章之前最近 10 章的标题+开头，
        // 避免长篇越写 AI 越"失忆"（零 AI 成本，纯查询）
        let recapBlock = '';
        if (!isShort) {
          const prevChapters = await db
            .select({
              title: schema.chapters.title,
              content: schema.chapters.content,
            })
            .from(schema.chapters)
            .where(
              and(
                eq(schema.chapters.book_id, params.book_id),
                sql`${schema.chapters.sort_order} < ${ch.sort_order}`,
              ),
            )
            .orderBy(desc(schema.chapters.sort_order))
            .limit(10);
          if (prevChapters.length > 0) {
            recapBlock = AiService.buildRecap(prevChapters.reverse());
          }
        }
        // 章节文本上下文
        const cursorPos = params.cursor_position ?? 0;
        const before = ch.content.slice(
          Math.max(0, cursorPos - 2000),
          cursorPos,
        );
        const after = ch.content.slice(cursorPos, cursorPos + 500);
        chapterContext = `${recapBlock}【当前章节】
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

      short: `你是知乎盐选爆款短篇作家。

${chapterContext}

【通用结构】
1. 开篇第一句就是冲突/悬念，不铺垫不写景
2. 每段1-3句，段间空行，对话占比40%+
3. 段末钩子：每段最后一句让读者想问"然后呢？"
4. 反差制造爽感：预期→意外→奖励

【技术规则】纯文本，不用Markdown。环境≤3行。不写大段独白。

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

      promo: `你是竖屏推文视频脚本策划。用户会提供一段小说原文，你需要将其改写成适合短视频口播的推文脚本。

【脚本要求】
- 每句 15-25 字，共 6-10 句
- 口语化、有悬念钩子、适合口播朗读
- 第一句必须是吸引人的开头（悬念/反转/冲突）
- 最后一句加引导语（如"想知道后续吗？评论区告诉我"）
- 每句单独一行，不要编号、不要任何标记符号
- 只输出脚本正文，不要加解释或前缀`,
    };

    // 加载引导讨论上下文（创作概要），追加到所有 AI 对话的 system prompt
    let guideBlock = '';
    if (params.book_id && !isShort) {
      try {
        const [bs] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, params.book_id))
          .limit(1);
        const extra = bs?.extra as Record<string, any> | undefined;
        if (extra?.guide_summary) {
          guideBlock = `\n\n【创作概要——引导讨论确定的方向，所有生成内容必须遵守】
${extra.guide_summary}
${extra.guide_full_log ? `\n【引导讨论原始记录——参考细节】\n${(extra.guide_full_log as string).slice(0, 1500)}` : ''}`;
        }
      } catch {
        /* settings 行可能不存在 */
      }
    }

    const systemPrompt = isShort
      ? prompts.short
      : (prompts[ct] ?? prompts.write);

    try {
      const cleanMessages = params.messages
        ? sanitizeMessages(params.messages)
        : [{ role: 'user', content: sanitizePrompt(params.message) }];
      const resolved = await this.resolveApiKey(
        params.user_id,
        'chat',
        params.model,
      );
      void this.streamChatToClient(
        res,
        systemPrompt + guideBlock,
        cleanMessages,
        resolved.model,
        isShort ? 24576 : 8192,
        resolved.apiKey,
        resolved.baseUrl,
        {
          userId: params.user_id,
          bookId: params.book_id || undefined,
          usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
        },
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
    customApiKey?: string,
    customBaseUrl?: string,
    usage?: {
      userId?: string;
      bookId?: string;
      usageType: 'platform_key' | 'user_key';
    },
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const apiKey = customApiKey || process.env.AI_PLATFORM_KEY;
    if (!apiKey) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 未配置' })}\n\n`,
      );
      res.end();
      return;
    }

    const baseUrl =
      customBaseUrl ||
      process.env.AI_PLATFORM_BASE_URL ||
      'https://api.deepseek.com/v1';

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
        if (done) {
          // 处理最后一段残留数据
          buffer += decoder.decode();
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
              try {
                const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
                if (delta?.content) fullContent += delta.content;
                if (delta?.reasoning_content)
                  fullReasoning += delta.reasoning_content;
              } catch {
                /* empty */
              }
            }
          }
          break;
        }
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

      // 用量记录（估算 token：输入 + 输出；失败不阻断）
      if (usage?.userId) {
        const inChars =
          systemPrompt.length +
          messages.reduce(
            (s: number, m: any) => s + (m.content?.length || 0),
            0,
          );
        await this.recordUsage({
          userId: usage.userId,
          bookId: usage.bookId,
          model,
          inChars,
          outChars: fullContent.length + fullReasoning.length,
          usageType: usage.usageType,
        });
      }

      // 多级回退提取 JSON action（对齐快捷创作解析器）
      try {
        const combined = fullContent || fullReasoning;
        const attempts: string[] = [];

        // 1. markdown 代码块
        const codeBlock = combined.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) attempts.push(codeBlock[1].trim());

        // 2. 正则匹配 JSON 对象/数组（含 action）
        const objMatch = combined.match(/\{[\s\S]*"action"\s*:[\s\S]*\}/);
        if (objMatch) attempts.push(objMatch[0]);
        const arrMatch = combined.match(/\[[\s\S]*"action"\s*:[\s\S]*\]/);
        if (arrMatch) attempts.push(arrMatch[0]);

        // 3. 末行逐行回退（处理单行 JSON）
        const revLines = combined.split('\n').reverse();
        for (const line of revLines) {
          let trimmed = line.trim();
          if (trimmed.endsWith('```')) trimmed = trimmed.slice(0, -3).trim();
          const fenceIdx = trimmed.indexOf('```json');
          if (fenceIdx >= 0) trimmed = trimmed.slice(fenceIdx + 7).trim();
          if (trimmed.startsWith('```')) trimmed = trimmed.slice(3).trim();
          if (
            (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
            trimmed.includes('"action"')
          ) {
            attempts.push(trimmed);
          }
        }

        // 4. 逐级尝试 parse（加容错修复）
        for (const tryStr of attempts) {
          let parsed: any = null;
          try {
            parsed = JSON.parse(tryStr);
          } catch {
            /* try fix */
          }
          if (!parsed) {
            try {
              const fixed = tryStr.replace(
                /"content"\s*:\s*"([\s\S]*?)"\s*[,}]/g,
                (_: string, inner: string) => {
                  const escaped = inner.replace(
                    /(?<!\\)"(?!"\s*[,:}\]])/g,
                    '"',
                  );
                  return `"content":"${escaped}"`;
                },
              );
              parsed = JSON.parse(fixed);
            } catch {
              /* try next */
            }
          }
          if (parsed) {
            if (Array.isArray(parsed) && parsed.length > 0) {
              res.write(`event: action\ndata: ${JSON.stringify(parsed)}\n\n`);
            } else if (parsed.action) {
              res.write(`event: action\ndata: ${JSON.stringify(parsed)}\n\n`);
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
  async mimicStyle(
    bookId?: string,
    model?: string,
    customText?: string,
    userId?: string,
  ) {
    const resolved = await this.resolveApiKey(userId, 'chat', model);
    if (!resolved.apiKey) return { analysis: '' };

    let sample = '';

    if (customText && customText.trim().length >= 200) {
      sample = sanitizePrompt(customText);
    } else if (bookId) {
      const db = getDb();
      const chapters = await db
        .select({
          content: schema.chapters.content,
          title: schema.chapters.title,
        })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, bookId));
      for (const ch of chapters) {
        if (sample.length >= 5000) break;
        sample += ch.content.slice(0, 2000) + '\n\n';
      }
    }

    if (sample.trim().length < 200)
      return { analysis: '内容不足，需至少 200 字' };

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
  // bookId 为 null 时按 user_id + section 查询（引导模式）
  async getActiveSession(
    bookId: string | null,
    section: string,
    userId?: string,
  ) {
    const db = getDb();
    const [session] = await db
      .select()
      .from(schema.ai_chat_sessions)
      .where(
        and(
          bookId
            ? eq(schema.ai_chat_sessions.book_id, bookId)
            : eq(schema.ai_chat_sessions.user_id, userId ?? ''),
          eq(schema.ai_chat_sessions.section, section),
          eq(schema.ai_chat_sessions.active, true),
        ),
      )
      .limit(1);
    return session ?? null;
  }

  // 获取指定 section 的所有会话（按时间倒序）
  async getSessions(bookId: string | null, section: string, userId?: string) {
    const db = getDb();
    return db
      .select()
      .from(schema.ai_chat_sessions)
      .where(
        and(
          bookId
            ? eq(schema.ai_chat_sessions.book_id, bookId)
            : eq(schema.ai_chat_sessions.user_id, userId ?? ''),
          eq(schema.ai_chat_sessions.section, section),
        ),
      )
      .orderBy(desc(schema.ai_chat_sessions.updated_at));
  }

  // 创建新会话：归档当前活跃会话，创建新的
  // bookId 为 null 时为引导模式，按 user_id 鉴权
  async createSession(
    bookId: string | null,
    section: string,
    title: string,
    userId: string,
  ) {
    if (bookId) await this.checkBookOwnership(bookId, userId);
    const db = getDb();

    // 归档当前活跃会话
    const archiveFilter = bookId
      ? and(
          eq(schema.ai_chat_sessions.book_id, bookId),
          eq(schema.ai_chat_sessions.section, section),
          eq(schema.ai_chat_sessions.active, true),
        )
      : and(
          eq(schema.ai_chat_sessions.user_id, userId),
          eq(schema.ai_chat_sessions.section, section),
          eq(schema.ai_chat_sessions.active, true),
        );
    await db
      .update(schema.ai_chat_sessions)
      .set({ active: false, updated_at: new Date() } as any)
      .where(archiveFilter)
      .execute();

    // 创建新会话
    const [created] = await db
      .insert(schema.ai_chat_sessions)
      .values({
        book_id: bookId ?? undefined,
        user_id: userId,
        section,
        title,
        messages: [],
        active: true,
      } as any)
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
    if (s.book_id) await this.checkBookOwnership(s.book_id, userId);
    else if (s.user_id !== userId) throw new Error('无权访问');

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
    if (target.book_id) await this.checkBookOwnership(target.book_id, userId);
    else if (target.user_id !== userId) throw new Error('无权访问');

    // 归档当前活跃会话
    const archiveFilter = target.book_id
      ? and(
          eq(schema.ai_chat_sessions.book_id, target.book_id),
          eq(schema.ai_chat_sessions.section, target.section),
          eq(schema.ai_chat_sessions.active, true),
        )
      : and(
          eq(schema.ai_chat_sessions.user_id, userId),
          eq(schema.ai_chat_sessions.section, target.section),
          eq(schema.ai_chat_sessions.active, true),
        );
    await db
      .update(schema.ai_chat_sessions)
      .set({ active: false, updated_at: new Date() } as any)
      .where(archiveFilter)
      .execute();

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
    if (s.book_id) await this.checkBookOwnership(s.book_id, userId);
    else if (s.user_id !== userId) throw new Error('无权访问');
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
  async recommendVisualStyle(bookId: string) {
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

  // ============== TTS 语音合成 ==============

  // ============== TTS 语音合成 ==============

  // 单次 TTS 请求（豆包语音合成 2.0 HTTP 单向流式 SSE，V3 接口）
  private async ttsRequest(
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
  private getAudioDurationSec(audioBuf: Buffer, text: string): number {
    const { execSync } = require('child_process');
    const ffmpegPath = require('ffmpeg-static');
    const { mkdtempSync, writeFileSync, rmSync } = require('fs');
    const os = require('os');
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
    const resolved = await this.resolveApiKey(userId, 'image');
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
    const resolved = await this.resolveApiKey(userId, 'image');
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
    const { execSync } = require('child_process');
    const ffmpegPath = require('ffmpeg-static');
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
    const resolved = await this.resolveApiKey(userId, 'image');
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
      .orderBy(desc(schema.chapters.sort_order))
      .limit(5);
    const chapterSamples = chapters
      .reverse() // 恢复时间顺序
      .map((c) => c.content?.slice(0, 1000))
      .join('\n');
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
          .limit(5)
      : [];
    const nodeBrief = nodes.map((n) => n.title).join(' → ');

    const prompt = `你是网文平台的爆款编辑。为小说《${book.title}》写一段简介（150-250字），用于封面/平台展示吸引读者。

要求：
1. 第一句就是钩子：悬念/反差/信息差式，让人想点开
2. 只给钩子和看点，绝不剧透结局和高潮反转
3. 知乎体文风：短句有力，不写"这是一部关于……的小说"式套话

参考调性：
"我替仇人养了十年孩子，直到他亲爹找上门。"
"全班都以为我死了，直到我出现在高考考场。"

只输出简介文本。`;

    const summary = [
      chapterSamples ? `内容节选：${chapterSamples.slice(0, 2000)}` : '',
      charBrief ? `主要角色：${charBrief}` : '',
      nodeBrief ? `情节主线：${nodeBrief}` : '',
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
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const synopsis = (data.choices?.[0]?.message?.content || '').trim();
      // 用量记录
      await this.recordUsage({
        userId,
        bookId,
        model: resolved.model,
        inChars: prompt.length + summary.length,
        outChars: synopsis.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });
      if (synopsis) {
        const [settings] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId));
        const extra = (settings?.extra ?? {}) as Record<string, any>;
        extra.synopsis = synopsis;
        await db
          .update(schema.book_settings)
          .set({ extra: extra as any })
          .where(eq(schema.book_settings.book_id, bookId));
      }
      return { synopsis };
    } catch {
      return { synopsis: '' };
    }
  }

  // ============== 知乎体包装 ==============

  /**
   * 知乎体包装：基于章节开头生成 5 个标题候选 + 2 个开篇改写版本
   * 非流式，一次返回
   */
  async generateZhihuPack(
    content: string,
    userId?: string,
    bookId?: string,
  ): Promise<{ titles: string[]; openings: string[] }> {
    const resolved = await this.resolveApiKey(userId, 'chat');
    if (!resolved.apiKey) throw new Error('AI 服务未配置');

    const sample = sanitizePrompt(content).slice(0, 500);
    const prompt = `你是知乎盐选爆款短篇的金牌编辑。根据下面的短篇小说开头，完成两件事：

1. 生成 5 个知乎体标题：信息差/反差/悬念式，15 字以内，让人一眼想点开
2. 改写 2 个开篇版本：三句内直给冲突或悬念，第一人称「我」叙述，保留原文核心情节和文风，每个版本 100-200 字

严格只输出 JSON（不要 markdown 代码块，不要任何解释）：
{"titles":["标题1","标题2","标题3","标题4","标题5"],"openings":["开篇版本1","开篇版本2"]}

小说开头：
${sample}`;

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
            { role: 'user', content: sample },
          ],
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      const text = (data.choices?.[0]?.message?.content || '').trim();
      // 容错：剥离可能出现的 markdown 代码块包裹
      const jsonText = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      const parsed = JSON.parse(jsonText);
      const titles = Array.isArray(parsed.titles)
        ? parsed.titles
            .slice(0, 5)
            .map((t: any) => String(t).trim())
            .filter(Boolean)
        : [];
      const openings = Array.isArray(parsed.openings)
        ? parsed.openings
            .slice(0, 3)
            .map((o: any) => String(o).trim())
            .filter(Boolean)
        : [];
      if (titles.length === 0 && openings.length === 0) {
        throw new Error('AI 返回为空');
      }
      // 用量记录
      await this.recordUsage({
        userId,
        bookId: bookId || undefined,
        model: resolved.model,
        inChars: prompt.length,
        outChars: text.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });
      return { titles, openings };
    } catch (e: any) {
      throw new Error(`知乎体包装生成失败：${e.message?.slice(0, 200)}`);
    }
  }

  // ============== 快捷创作 ==============

  /**
   * 条件规则：根据用户想法中的题材意图，动态生成创作规则段（纯函数，可单测）
   * 复仇/悬疑类注入"信息差不摊牌"；甜宠/治愈类注入"允许坦白"；有加害者题材注入"代价铁律"
   */
  static buildConditionalRules(premise: string): string {
    const p = premise || '';
    const hasRevenge =
      /复仇|打脸|虐渣|报复|逆袭|重生|穿越|穿书|预知|怪谈|悬疑|惊悚|反转/.test(
        p,
      );
    const hasSweet = /甜宠|治愈|温馨|亲情|友情|温暖|救赎|双向奔赴/.test(p);
    const hasVillain = /复仇|打脸|虐渣|背叛|欺负|霸凌|害死|陷害/.test(p);

    if (!hasRevenge && !hasSweet) return ''; // 中性题材不加条件规则

    const rules: string[] = [];
    if (hasRevenge && !hasSweet) {
      rules.push(
        '信息差是命根子：主角的秘密（重生/穿越/预知）是核心筹码，不主动向任何人摊牌；对方也是重生者时双方各自隐藏、互相试探、话里有话，禁止直接说出底牌',
      );
    }
    if (hasSweet) {
      rules.push(
        '允许在情感高潮处坦白（"我重生回来就是为了你"），坦白本身就是甜点',
      );
    }
    if (hasVillain) {
      rules.push(
        '加害者必须付出代价：伤害过主角的人要有对应惩罚或赎罪，禁止"杀妻两世最后相安无事"式轻轻放下；若和解必须先有足够的代价铺垫',
      );
    }
    return `【本作题材约束——优先于通用规则】\n${rules.map((r) => `- ${r}`).join('\n')}`;
  }

  /**
   * 前情提要文本构建（纯函数，可单测）：
   * 每章一行「标题：开头 150 字」，注入续写 prompt 保持长篇连贯
   */
  static buildRecap(
    chapters: Array<{ title: string; content: string }>,
  ): string {
    if (chapters.length === 0) return '';
    return (
      '【前情提要——之前章节的梗概，续写时保持连贯】\n' +
      chapters
        .map(
          (c) =>
            `《${c.title}》：${(c.content || '').slice(0, 150).replace(/\n/g, ' ')}`,
        )
        .join('\n') +
      '\n\n'
    );
  }

  /**
   * 书名候选兜底：AI 多次失败时，用题材词拼 3 个变体，保证候选区有得选
   * 纯函数，可单测
   */
  static buildTitleFallback(premise: string): string[] {
    const base = premise.slice(0, 15).trim() || '短篇故事';
    const topicMatch = premise.match(/写一个(.+?)短篇/);
    const topic = (topicMatch?.[1] || base).slice(0, 10);
    return [base, `${topic}之后，我逆天改命`, `这一世，${topic}我要先手翻盘`];
  }

  /** 故事前中后三段节选（供书名生成等理解完整故事弧线的场景） */
  private storySample(storyText: string): string {
    const len = storyText.length;
    if (len <= 1200) return storyText;
    return [
      storyText.slice(0, 500),
      storyText.slice(Math.floor(len * 0.4), Math.floor(len * 0.4) + 300),
      storyText.slice(Math.floor(len * 0.85), Math.floor(len * 0.85) + 300),
    ].join('\n\n……\n\n');
  }

  // 短篇快捷创作：输入脑洞 → AI 直接写完完整故事
  async quickCreateShort(
    res: Response,
    params: {
      user_id: string;
      premise: string;
      model?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
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

    let bookId: string | undefined;
    // 客户端断连检测：刷新/关闭页面时中止 AI 生成，避免继续烧钱
    const abortCtrl = new AbortController();
    const onClientClose = () => abortCtrl.abort();
    res.on('close', onClientClose);
    const genSignal = (timeoutMs: number) =>
      AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      // Step 1: 创建短篇作品 + 唯一章节
      send('step', { step: 'book', status: 'generating', label: '创建作品' });
      const title =
        premise.length > 20 ? premise.slice(0, 20) + '...' : premise;
      const [book] = await db
        .insert(schema.books)
        .values({ user_id: params.user_id, title, type: 'short' } as any)
        .returning({ book_id: schema.books.book_id });
      bookId = book.book_id;
      await db
        .insert(schema.book_settings)
        .values({ book_id: bookId, preset_style: 'default' });
      await db
        .insert(schema.chapters)
        .values({ book_id: bookId, title: '正文', sort_order: 1 });
      send('step', {
        step: 'book',
        status: 'done',
        label: '作品已创建',
        book_id: bookId,
      });

      // Step 2: 生成故事梗概（含结局走向，供用户确认后再写正文）
      send('step', {
        step: 'story',
        status: 'generating',
        label: '正在构思故事梗概...',
      });
      const guideBlock = params.guide_summary
        ? `\n【创作方向——请严格遵循以下设定】\n${params.guide_summary}\n${params.guide_full_log ? `\n【引导讨论记录——参考细节】\n${params.guide_full_log}\n` : ''}`
        : '';
      const outlinePrompt = `${guideBlock}你是知乎盐选短篇的故事策划。根据脑洞，写一个 400-500 字的故事梗概，包含：
1. 故事核心设定与开篇钩子
2. 主角欲望与主要阻碍
3. 冲突升级的关键节点（3-5 个）
4. 高潮与结局走向（包括最终反转）
5. 一句总结性主题（结尾金句方向）

纯文本输出，不要编号、不要标题、不要解释。`;
      const r1 = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: outlinePrompt },
            {
              role: 'user',
              content: `脑洞/想法：${premise}\n\n请写故事梗概。`,
            },
          ],
          max_tokens: 1500,
          temperature: 0.7,
        }),
        signal: genSignal(60_000),
      });
      if (!r1.ok) {
        send('error', { message: `AI 请求失败 (${r1.status})` });
        res.end();
        return;
      }
      const data1 = await r1.json();
      const preview = (data1.choices?.[0]?.message?.content ?? '').trim();

      if (!preview) {
        throw new Error('梗概生成失败：AI 返回为空');
      }
      // 梗概存 book_settings.extra，供确认后写正文
      {
        const [s] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId))
          .limit(1);
        const extra = (s?.extra ?? {}) as Record<string, any>;
        extra.outline_preview = preview;
        if (params.guide_summary || params.guide_full_log) {
          extra.guide_summary = params.guide_summary || '';
          extra.guide_full_log = params.guide_full_log || '';
        }
        await db
          .update(schema.book_settings)
          .set({ extra: extra as any })
          .where(eq(schema.book_settings.book_id, bookId));
      }
      send('step', {
        step: 'story',
        status: 'done',
        label: '故事梗概已生成',
        preview,
      });
      await this.recordUsage({
        userId: params.user_id,
        bookId,
        model,
        inChars: outlinePrompt.length + premise.length,
        outChars: preview.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });
      send('done', { book_id: bookId, preview });
    } catch (err: any) {
      // 回滚：删除已创建的资源（断连也回滚，不留半成品空书）
      if (bookId) {
        try {
          const db2 = getDb();
          await db2
            .delete(schema.chapters)
            .where(eq(schema.chapters.book_id, bookId));
          await db2
            .delete(schema.book_settings)
            .where(eq(schema.book_settings.book_id, bookId));
          await db2
            .delete(schema.books)
            .where(eq(schema.books.book_id, bookId));
        } catch {
          /* 回滚失败不掩盖原始错误 */
        }
      }
      // 客户端断连：不发 error（连接已断）；正常失败：通知前端
      if (abortCtrl.signal.aborted) {
        console.log(
          '[quickCreateShort] client disconnected, generation aborted',
        );
      } else {
        send('error', { message: err?.message ?? '生成失败' });
      }
    } finally {
      res.off('close', onClientClose);
      res.end();
    }
  }

  /**
   * 短篇正文生成：梗概确认后的第二步——按已确认的梗概写完整故事 + 书名候选
   */
  async generateStory(
    res: Response,
    params: {
      user_id: string;
      book_id: string;
      premise: string;
      model?: string;
    },
  ) {
    const db = getDb();
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(params.user_id, 'chat', model);
    const apiKey = resolved.apiKey;
    const baseUrl = resolved.baseUrl;
    const premise = sanitizePrompt(params.premise);
    const bookId = params.book_id;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const send = (event: string, data: Record<string, any>) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // 客户端断连检测
    const abortCtrl = new AbortController();
    const onClientClose = () => abortCtrl.abort();
    res.on('close', onClientClose);
    const genSignal = (timeoutMs: number) =>
      AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(timeoutMs)]);

    try {
      // 读已确认的梗概 + 章节
      const [settings] = await db
        .select({ extra: schema.book_settings.extra })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, bookId))
        .limit(1);
      const preview =
        (settings?.extra as any)?.outline_preview ||
        (settings?.extra as any)?.guide_summary ||
        premise.slice(0, 200);
      const [chapter] = await db
        .select({ chapter_id: schema.chapters.chapter_id })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, bookId))
        .orderBy(schema.chapters.sort_order)
        .limit(1);
      if (!chapter) throw new Error('章节不存在');

      // Step 1: 写正文（两轮，梗概作为走向锚点）
      send('step', {
        step: 'story',
        status: 'generating',
        label: '正在写故事前半部分...',
      });
      const storyPrompt = `你是知乎盐选爆款短篇作家。以下铁律按重要性排序，全部必须遵守：

【已确认的故事梗概——严格按此走向写作，不偏离】
${preview}

【一、钩子与结构】
1. 开篇第一段直接放全故事最戏剧性的冲突场景（可倒叙），之后才补背景
2. 四幕推进：钩子 → 冲突升级（每 500 字一个爽点/危机/反转）→ 高潮（线索汇聚、情绪顶到最高）→ 反转收束
3. 主角有明确欲望和阻碍，主动行动推进剧情；8000-12000 字，主要角色 ≤5，配角不起名
4. 分节用空行分隔，每节约 800-1500 字，节末留情绪钩子或悬念；禁止数字编号

【二、行文节奏】
1. 短句成段：大量一句话一段，长段不超 3 句
2. 对话占比 50%+，对话每句一行，剧情靠对话推进；主角内心 OS 穿插吐槽（"造孽啊！"式）
3. 环境描写≤3 行，不写大段独白；角色名从头到尾不变
4. 一个具体道具（衣服/手链/信物）反复出现、多次回收

【三、伏笔与结局】
1. 重大反转揭晓前至少埋 3 处可回查伏笔，禁止无铺垫反转
2. 结尾最多一个温情场景 + 一句总结性金句收住，禁止连续多段逐个角色报结局
3. 类型一致：不出现题材外突兀元素（都市文不掏枪）

【四、情绪】
1. 情绪曲线：酸涩→憋屈→爆发→甜，爽虐交替

【五、技术红线】
1. 纯文本输出，不用 Markdown
2. 语法必须通顺：主谓施受清晰，禁止为追求悬念写病句；"XX那天"式开篇先检查主语是谁

${AiService.buildConditionalRules(premise)}

【节奏示范】（仅示范行文节奏，不模仿题材）
我是天生网恋圣体，拥有超绝甜妹音。
姐姐托人要到谢家太子爷的微信后，逼迫我帮她聊。
我夹着嗓子哄了谢寻小半年。
把他调成了一个恋爱脑上头的忠犬乖狗。
后来，他小心翼翼地跟我商量奔现。
【宝宝，见面当天你就穿白色裙子好不好？】
【我一定狠狠把你嘴亲烂。】
我轻声答应。
转头就把账号还给了我姐。
开学那天，我一眼就看见了等在校门口的谢寻。
他帅气的脸上满是紧张。
直到，我姐一身白裙出现。
谢寻眼神一动，目光牢牢锁定在她身上。
耳朵瞬间就红了。

**写 4000-5000 字作为故事前半部分，在剧情关键转折点停住，最后一行标注：【待续】。**`;

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
          max_tokens: 24576,
          temperature: 0.8,
        }),
        signal: genSignal(300_000),
      });
      if (!r1.ok) {
        send('error', { message: `AI 请求失败 (${r1.status})` });
        res.end();
        return;
      }
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

      // 第二轮：续写后半部分（精简 system，风格已由前半部分确立，只需一致性）
      const r2 = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                '你是知乎盐选爆款短篇作家。严格按照前半部分的文风、人物性格和节奏续写，回收所有伏笔，结尾留一句总结性金句。',
            },
            {
              role: 'user',
              content: `脑洞/想法：${premise}\n\n已写的前半部分（结尾部分）：\n${part1.slice(-1500)}\n\n请接着写后半部分（4000-5000字）：保持人物性格和文风一致，回收前半部分的伏笔，展开高潮、揭示真相、给出完整结局。这是故事结尾，不要标注【待续】。`,
            },
          ],
          max_tokens: 24576,
          temperature: 0.8,
        }),
        signal: genSignal(300_000),
      });
      if (!r2.ok) {
        send('error', { message: `AI 续写失败 (${r2.status})` });
        res.end();
        return;
      }
      const data2 = await r2.json();
      const part2 = (data2.choices?.[0]?.message?.content ?? '').replace(
        /【待续】.*$/s,
        '',
      );
      const storyText = part1 + '\n\n' + part2;

      if (storyText.trim()) {
        await db
          .update(schema.chapters)
          .set({
            content: storyText,
            word_count: storyText.length,
            updated_at: new Date(),
          })
          .where(eq(schema.chapters.chapter_id, chapter.chapter_id));
        await db
          .update(schema.books)
          .set({ word_count: storyText.length, updated_at: new Date() })
          .where(eq(schema.books.book_id, bookId));
        send('step', {
          step: 'story',
          status: 'done',
          label: `故事已生成（${storyText.length} 字）`,
          preview: storyText.slice(0, 200),
        });
      }

      // Step 2: 生成书名候选（5 个知乎体标题），默认取第一个
      send('step', { step: 'title', status: 'generating', label: '生成书名' });
      const titleSystem =
        '你是知乎盐选的金牌标题编辑。你的标题让人一眼就想点开，看三秒就想收藏。';
      const titlePrompt = `参考这些爆款标题的调性：
《我在闺蜜葬礼上笑了出来》
《被赶出家门那天，我中了五百万》
《我替仇人养了十年孩子》
《老公的白月光住进了我家》
《全班都以为我死了，直到我出现在高考考场》
《我死后的第七天，全城都在找我》
《婆婆要我的肾，我反手签了器官捐献》
《前夫跪着求我复婚那天，我结婚了》

根据下面的故事，生成 5 个标题（每个 15 字以内），五种类型各一个：悬念式、信息差式、反差式、爽点式、情感式。直接输出 5 行，每行一个，不要编号、不要引号、不要解释。\n\n${this.storySample(storyText)}`;
      let titleText = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const titleR = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: titleSystem },
              { role: 'user', content: titlePrompt },
            ],
            max_tokens: 500,
            temperature: 0.6,
          }),
          signal: genSignal(15_000),
        });
        const titleData = await titleR.json();
        titleText = (titleData.choices?.[0]?.message?.content ?? '').trim();
        if (titleText) break;
      }
      const stripped = titleText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      let titles: string[] = [];
      try {
        const parsed = JSON.parse(stripped);
        if (Array.isArray(parsed)) {
          titles = parsed
            .map((t: any) => String(t).trim())
            .filter(Boolean)
            .slice(0, 5);
        }
      } catch {
        const arrMatch = stripped.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          try {
            const parsed2 = JSON.parse(arrMatch[0]);
            if (Array.isArray(parsed2)) {
              titles = parsed2
                .map((t: any) => String(t).trim())
                .filter(Boolean)
                .slice(0, 5);
            }
          } catch {
            /* 继续降级 */
          }
        }
        if (titles.length === 0) {
          titles = stripped
            .split('\n')
            .map((l: string) => l.replace(/^\d+[.、]\s*/, '').trim())
            .filter(Boolean)
            .slice(0, 5);
        }
      }
      if (titles.length === 0) titles = AiService.buildTitleFallback(premise);
      if (titles.length <= 1) {
        console.error(
          `[generateStory] title candidates=${titles.length}, model=${model}, raw=${JSON.stringify(titleText).slice(0, 300)}`,
        );
      }
      const finalTitle = titles[0].slice(0, 30);
      await db
        .update(schema.books)
        .set({ title: finalTitle, updated_at: new Date() })
        .where(eq(schema.books.book_id, bookId));

      await this.recordUsage({
        userId: params.user_id,
        bookId,
        model,
        inChars:
          storyPrompt.length * 2 + titlePrompt.length * 3 + premise.length * 2,
        outChars: storyText.length + titleText.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });

      send('step', {
        step: 'title',
        status: 'done',
        label: `书名：${finalTitle}`,
        titles,
      });
      send('done', { book_id: bookId, title: finalTitle, titles });
    } catch (err: any) {
      if (abortCtrl.signal.aborted) {
        console.log('[generateStory] client disconnected, generation aborted');
      } else {
        send('error', { message: err?.message ?? '生成失败' });
      }
    } finally {
      res.off('close', onClientClose);
      res.end();
    }
  }

  async quickCreate(
    res: Response,
    params: {
      user_id: string;
      premise: string;
      model?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
  ) {
    const db = getDb();
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(params.user_id, 'chat', model);
    const apiKey = resolved.apiKey;
    const baseUrl = resolved.baseUrl;
    const premise = sanitizePrompt(params.premise);
    // 完整创作上下文（用于书名等需要全貌的场景）
    const fullPremise = params.guide_summary
      ? `【创作方向】\n${params.guide_summary}\n${params.guide_full_log ? `\n【引导讨论记录——参考细节】\n${params.guide_full_log}\n` : ''}\n【用户初始想法】\n${premise}`
      : premise;
    // 精简版（用于需要结构化输出的 world/outline/chars 步骤，避免 prompt 过长导致格式异常）
    const shortPremise = params.guide_summary
      ? `【创作方向】\n${params.guide_summary.slice(0, 800)}\n${params.guide_full_log ? `【引导讨论记录——请严格参考，其中的人物身份和设定不可修改】\n${params.guide_full_log}\n` : ''}\n【用户初始想法】\n${premise.slice(0, 500)}`
      : premise;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    const send = (event: string, data: Record<string, any>) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      maxTokens = 4096,
      retries = 2,
    ): Promise<string> => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          // 等 3 秒再重试，避开限流
          await new Promise((r) => setTimeout(r, 3000));
        }
        try {
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
              max_tokens: maxTokens,
              temperature: 0.7,
            }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!r.ok) {
            if (r.status === 429 && attempt < retries) continue;
            throw new Error(`AI API 错误 (${r.status})`);
          }
          const d = await r.json();
          const content = d.choices?.[0]?.message?.content;
          if (content) return content;
          console.log(
            `[quickCreate] aiCall attempt ${attempt + 1}: empty response, retrying...`,
          );
          if (attempt < retries) continue;
          return '';
        } catch (e: any) {
          if (attempt < retries) continue;
          throw e;
        }
      }
      return '';
    };

    let bookId: string | undefined;
    try {
      // Step 1: 创建作品
      send('step', { step: 'book', status: 'generating', label: '创建作品' });
      const title =
        premise.length > 20 ? premise.slice(0, 20) + '...' : premise;
      const [book] = await db
        .insert(schema.books)
        .values({ user_id: params.user_id, title })
        .returning({ book_id: schema.books.book_id });
      bookId = book.book_id;
      await db
        .insert(schema.book_settings)
        .values({ book_id: bookId, preset_style: 'default' });
      await db.insert(schema.outlines).values({ book_id: bookId });
      await db
        .insert(schema.world_settings)
        .values({ book_id: bookId, sections: [] });
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
      const worldPrompt = `你是网文世界观构建专家。根据用户提供的题材，创造一个自洽、可扩展的世界。
**重要：世界观只写环境、规则、群体。❌ 不要写"刘婶是卖煎饼的，她每天早上..."——这是角色信息，不属于世界观。✅ 写"巷子里有固定摊贩，形成了一套默契的营业时间和规矩"。具体人物留给后续步骤生成。在用户提供的信息基础上合理扩展，但不要修改或替换用户已明确的设定。**

根据故事类型，自行选择最合适的 3-4 个分区来组织世界观。不同故事类型关注的重点不同——年代文关注时代政策和家庭结构，厨艺小说关注店铺环境和食客圈子，玄幻关注力量体系——选对题材真正需要的分区，不要套固定模板。只写组织/群体/环境层面，具体人物留给角色生成环节。

【输出格式——严格遵守】
按分区名逐个输出正文内容，格式如下：

分区名
该分区的详细正文...

（用空行分隔分区，不用 Markdown 标题）`;

      const worldText = await aiCall(
        worldPrompt,
        `题材和想法：${shortPremise}\n\n请构建这个世界观。`,
      );
      send('step', {
        step: 'world',
        status: 'parsing',
        label: `保存世界观（AI返回${worldText.length}字）`,
        preview: worldText.slice(0, 300) || '(AI 返回空)',
      });
      const worldCount =
        worldText.length > 0
          ? await this.parseAndSaveWorld(bookId, worldText)
          : 0;
      send('step', {
        step: 'world',
        status: 'done',
        label:
          worldCount > 0
            ? `世界观已生成（${worldCount} 个分区）`
            : `世界观：AI 未返回有效内容（${worldText.length}字），请重试`,
      });

      // Step 3: 生成大纲
      send('step', {
        step: 'outline',
        status: 'generating',
        label: '生成大纲',
      });
      const outlinePrompt = `你是网文大纲规划助手。根据世界观为这部小说设计情节大纲。**只使用用户已提供的信息，可以合理扩展，但不要修改或替换用户已明确的情节。**

【核心要求】
1. 分卷/分段推进：每段有明确的阶段目标，段末解决并引出下一段
2. 递进节奏：每个节点应有实质进展（具体是什么取决于故事本身的驱动力）
3. 格局扩展：故事舞台逐步扩大
4. 每个节点应能制造悬念或期待，让读者想看下一章

【数量要求】
至少输出 8-12 个情节节点，覆盖前 1-2 卷。标题简洁有力。

【输出格式——严格遵守】
只输出 JSON 数组，不要任何其他文字。title 精炼有网文感（8字以内），summary 简短有力（30字以内，写清谁+做了什么+结果）：
[{"action":"add_chapter","title":"裂缝心跳","summary":"沈桁在灰塔底层发现空间裂缝，接触神秘气体后指纹异变"}]`;

      const outlineText = await aiCall(
        outlinePrompt,
        `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 2000)}\n\n请设计大纲。`,
        8192,
      );
      send('step', {
        step: 'outline',
        status: 'parsing',
        label: `保存大纲（AI返回${outlineText.length}字）`,
        preview: `首200字: ${outlineText.slice(0, 200)}\n末200字: ${outlineText.slice(-200)}`,
      });
      const outlineCount = await this.parseAndSaveOutline(bookId, outlineText);
      send('step', {
        step: 'outline',
        status: 'done',
        label: `大纲已生成（${outlineCount} 个节点）`,
      });

      // Step 4: 生成角色
      send('step', {
        step: 'characters',
        status: 'generating',
        label: '生成角色',
      });
      const charsPrompt = `你是网文角色创作顾问。根据世界观和大纲，输出 4-6 个核心角色的 JSON 数组。**只使用用户已提供和世界观/大纲已确定的角色信息，可以新增角色，但不要修改或替换用户已明确的角色身份。**

【必须包含的角色类型】
- 主角（is_main:true）
- 重要助力者/伙伴（1-2个）
- 核心对手/反派（1个）

【输出格式——只输出 JSON 数组】
[{"action":"create_character","name":"必填","gender":"男/女","personality":"性格标签（10字内）","identity":"身份（10字内）","backstory":"背景（30字内）","motivation":"动机（20字内）","is_main":true}]`;

      const charsText = await aiCall(
        charsPrompt,
        `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 1500)}\n\n大纲（角色必须与大纲中的名字一致）：${typeof outlineText === 'string' ? outlineText.slice(0, 1500) : ''}\n\n请设计角色，确保主角名字和大纲中完全一致。`,
      );
      send('step', {
        step: 'characters',
        status: 'parsing',
        label: `保存角色（AI返回${charsText.length}字）`,
        preview: `首200字: ${charsText.slice(0, 200)}\n末200字: ${charsText.slice(-200)}`,
      });
      if (charsText.length < 20) {
        send('step', {
          step: 'characters',
          status: 'done',
          label: '角色：AI 响应异常（过短），请重试',
        });
      } else {
        const charCount = await this.parseAndSaveCharacters(bookId, charsText);
        send('step', {
          step: 'characters',
          status: 'done',
          label: `已创建 ${charCount} 个角色`,
        });
      }

      // Step 5: 生成书名
      send('step', { step: 'title', status: 'generating', label: '生成书名' });
      const titlePrompt = `根据以下小说设定，生成一个吸引人的书名（10-20字以内）。只输出书名，不要其他文字。`;
      const titleSummary = `题材：${fullPremise.slice(0, 500)}\n\n世界观：${worldText.slice(0, 500)}`;
      const generatedTitle = (await aiCall(titlePrompt, titleSummary))
        .trim()
        .slice(0, 40);
      const finalTitle = generatedTitle || premise.slice(0, 20);
      // 更新书名
      await db
        .update(schema.books)
        .set({ title: finalTitle, updated_at: new Date() })
        .where(eq(schema.books.book_id, bookId));
      send('step', {
        step: 'title',
        status: 'done',
        label: `书名：${finalTitle}`,
      });

      // 保存引导讨论上下文，供后续 AI 对话使用
      if (params.guide_summary || params.guide_full_log) {
        const [s] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId))
          .limit(1);
        const extra = (s?.extra ?? {}) as Record<string, any>;
        extra.guide_summary = params.guide_summary || '';
        extra.guide_full_log = params.guide_full_log || '';
        await db
          .update(schema.book_settings)
          .set({ extra: extra as any })
          .where(eq(schema.book_settings.book_id, bookId));
      }

      // 完成
      send('done', { book_id: bookId, title: finalTitle });
    } catch (err: any) {
      // 回滚：删除已创建的资源
      if (bookId) {
        try {
          const db2 = getDb();
          await db2
            .delete(schema.world_settings)
            .where(eq(schema.world_settings.book_id, bookId));
          await db2
            .delete(schema.outlines)
            .where(eq(schema.outlines.book_id, bookId));
          await db2
            .delete(schema.book_settings)
            .where(eq(schema.book_settings.book_id, bookId));
          await db2
            .delete(schema.books)
            .where(eq(schema.books.book_id, bookId));
        } catch {
          /* 回滚失败不掩盖原始错误 */
        }
      }
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
      const text = aiText.replace(/\{"action"[\s\S]*\}/, '');
      // 通用分区解析：匹配 "分区名\n内容" 模式（分区名为不含标点的短行）
      const lines = text.split('\n');
      let currentName = '';
      let currentContent: string[] = [];
      // 匹配分区标题：纯中文短行，或带 #/## 前缀
      const headingRe = /^(?:#{1,3}\s*)?[一-龥\w·\s]{2,20}$/;
      for (const line of lines) {
        const trimmed = line
          .trim()
          .replace(/^#{1,3}\s*/, '')
          .trim();
        if (headingRe.test(trimmed)) {
          // 保存上一个分区
          if (currentName && currentContent.length > 0) {
            sections.push({
              name: currentName,
              content: currentContent.join('\n').trim(),
            });
            currentContent = [];
          }
          currentName = trimmed;
        } else if (currentName && trimmed) {
          currentContent.push(line);
        }
      }
      // 最后一个分区
      if (currentName && currentContent.length > 0) {
        sections.push({
          name: currentName,
          content: currentContent.join('\n').trim(),
        });
      }
      console.log(
        '[quickCreate] parsed world sections from text:',
        sections.length,
        sections.map((s) => s.name).join(', '),
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
        .set({ sections: sections, updated_at: new Date() })
        .where(eq(schema.world_settings.book_id, bookId));
      if ((result as any)?.rowCount === 0) {
        await db
          .insert(schema.world_settings)
          .values({ book_id: bookId, sections: sections });
      }
    }
    return sections.length;
  }

  // 解析并保存大纲
  private async parseAndSaveOutline(bookId: string, aiText: string) {
    const db = getDb();
    let nodes: { title: string; summary: string }[] = [];

    console.log(
      '[quickCreate] outline AI response (first 300):',
      aiText.slice(0, 300),
    );
    console.log('[quickCreate] outline AI full length:', aiText.length);

    const jsonAttempts: string[] = [];

    // 1. 去掉 markdown 代码块
    const codeBlock = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) jsonAttempts.push(codeBlock[1].trim());

    // 2. 正则匹配完整 JSON 数组
    const jsonMatch = aiText.match(
      /\[[\s\S]*"action"\s*:\s*"add_chapter"[\s\S]*\]/,
    );
    if (jsonMatch) jsonAttempts.push(jsonMatch[0]);

    // 3. 从最后一个 [ 到最后一个 ]
    const lastOpen = aiText.lastIndexOf('[');
    const lastClose = aiText.lastIndexOf(']');
    if (lastOpen >= 0 && lastClose > lastOpen) {
      jsonAttempts.push(aiText.slice(lastOpen, lastClose + 1));
    }

    for (const tryStr of jsonAttempts) {
      try {
        const parsed = JSON.parse(tryStr);
        const found = Array.isArray(parsed)
          ? parsed.filter((a: any) => a.action === 'add_chapter')
          : [];
        if (found.length > 0) {
          nodes = found.map((a: any) => ({
            title: a.title,
            summary: a.summary || '',
          }));
          console.log(
            '[quickCreate] parsed outline nodes from JSON:',
            nodes.length,
          );
          break;
        }
      } catch (e: any) {
        console.log(
          '[quickCreate] outline JSON parse attempt failed:',
          e.message?.slice(0, 100),
        );
      }
    }

    // 4. JSON 截断/语法修复：从末尾逐级回退找最后一个有效对象
    if (nodes.length === 0) {
      const text = aiText.trim();
      let pos = text.length;
      while (pos > 0) {
        pos = text.lastIndexOf('},', pos - 1);
        if (pos < 0) break;
        const candidate = text.slice(0, pos + 1) + '\n]';
        try {
          const parsed = JSON.parse(candidate);
          const found = Array.isArray(parsed)
            ? parsed.filter((a: any) => a.action === 'add_chapter')
            : [];
          if (found.length > 0) {
            nodes = found.map((a: any) => ({
              title: a.title,
              summary: a.summary || '',
            }));
            console.log(
              '[quickCreate] parsed outline nodes from repaired JSON:',
              nodes.length,
            );
            break;
          }
        } catch {
          /* try previous }, */
        }
      }
    }

    // 5. 文本回退：按 "数字. 标题" 或 "第X章" 格式解析
    if (nodes.length === 0) {
      const lines = aiText.split('\n');
      const textNodeRe =
        /^\s*(?:\d+[.、)）]|第[一二三四五六七八九十\d]+章)\s*(.+?)(?:[：:]\s*(.*))?$/;
      for (const line of lines) {
        const m = line.match(textNodeRe);
        if (m) {
          nodes.push({ title: m[1].trim(), summary: (m[2] || '').trim() });
        }
      }
      console.log(
        '[quickCreate] parsed outline nodes from text:',
        nodes.length,
      );
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
    return nodes.length;
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
          console.log('[quickCreate] parsed chars from JSON:', chars.length);
          break;
        }
      } catch (e: any) {
        console.log(
          '[quickCreate] chars JSON parse attempt failed:',
          e.message?.slice(0, 100),
        );
      }
    }

    // 4. JSON 截断/语法修复：从末尾逐级回退找最后一个有效对象
    if (chars.length === 0) {
      const text = aiText.trim();
      // 尝试所有 }, 位置，从后往前，直到找到能 parse 的有效 JSON
      let pos = text.length;
      while (pos > 0) {
        pos = text.lastIndexOf('},', pos - 1);
        if (pos < 0) break;
        const candidate = text.slice(0, pos + 1) + '\n]';
        try {
          const parsed = JSON.parse(candidate);
          const found = Array.isArray(parsed)
            ? parsed.filter((a: any) => a.action === 'create_character')
            : [];
          if (found.length > 0) {
            chars = found;
            console.log(
              '[quickCreate] parsed chars from repaired JSON:',
              chars.length,
            );
            break;
          }
        } catch {
          /* try previous }, */
        }
      }
    }

    // 5. 文本回退：按角色块解析（名字：xxx / 姓名：xxx 开头）
    if (chars.length === 0) {
      const text = aiText.replace(/```[\s\S]*?```/g, ''); // 去代码块
      // 按 "名字"/"姓名"/"角色" 分割
      const blocks = text.split(
        /\n(?=名字[：:]|姓名[：:]|角色\d|[一二三四五六七八九十]、)/,
      );
      for (const block of blocks) {
        const get = (key: string) => {
          const m = block.match(new RegExp(`${key}[：:]\\s*(.+)`, 'i'));
          return m ? m[1].trim() : '';
        };
        const name = get('名字') || get('姓名') || get('角色');
        if (!name || name.length > 20) continue;
        chars.push({
          name,
          gender: get('性别'),
          age: parseInt(get('年龄')) || null,
          personality: get('性格'),
          identity: get('身份'),
          backstory: get('背景') || get('背景故事'),
          motivation: get('动机') || get('目标'),
          catchphrase: get('口头禅'),
          speech_style: get('说话风格'),
          appearance: get('外貌'),
          is_main: /主要|主角|main/i.test(block),
          aliases: get('别名'),
          custom_fields: [],
        });
      }
      // 如果分块失败，尝试按 --- 或空行分隔
      if (chars.length === 0) {
        const altBlocks = text.split(/\n---\n|\n\n(?=名字|姓名|\w{2,4}[：:])/);
        for (const block of altBlocks) {
          const get = (key: string) => {
            const m = block.match(new RegExp(`${key}[：:]\\s*(.+)`, 'i'));
            return m ? m[1].trim() : '';
          };
          const name = get('名字') || get('姓名');
          if (!name || name.length > 20) continue;
          chars.push({
            name,
            gender: get('性别'),
            age: parseInt(get('年龄')) || null,
            personality: get('性格'),
            identity: get('身份'),
            backstory: get('背景') || get('背景故事'),
            motivation: get('动机') || get('目标'),
            catchphrase: get('口头禅'),
            speech_style: get('说话风格'),
            appearance: get('外貌'),
            is_main: /主要|主角|main/i.test(block),
            aliases: get('别名'),
            custom_fields: [],
          });
        }
      }
      console.log('[quickCreate] parsed chars from text:', chars.length);
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
      });
    }
    return chars.length;
  }
}
