import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { Response } from 'express';

@Injectable()
export class AiService {
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
    },
  ) {
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
      .where(eq(schema.chapters.chapter_id, params.chapterId))
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
        : `请改写以下内容（${params.instruction ?? '优化这段文字'}）：\n\n${params.selectedText}`;

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

    const apiKey = usePlatformKey ? process.env.AI_PLATFORM_KEY : null; // 用户自定义 Key 由前端直连

    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';

    if (!apiKey && usePlatformKey) {
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
          `event: error\ndata: ${JSON.stringify({ message: err })}\n\n`,
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
                const content = parsed.choices?.[0]?.delta?.content;
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
        `event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`,
      );
    }
    res.end();
  }

  // 设定提取（非流式）
  async extractSettings(bookId: string, chapterId: string, model: string) {
    const db = getDb();

    const [chapter] = await db
      .select({ content: schema.chapters.content })
      .from(schema.chapters)
      .where(eq(schema.chapters.chapter_id, chapterId));

    const characters = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.book_id, bookId));

    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';
    const apiKey = process.env.AI_PLATFORM_KEY;

    if (!apiKey) return { suggestions: [] };

    const prompt = `从以下小说章节中提取角色和世界观设定，以 JSON 格式返回。

【已有角色】
${characters.map((c) => `- ${c.name}: ${c.personality ?? '无'}`).join('\n')}

【章节内容】
${(chapter?.content ?? '').slice(0, 3000)}

请返回 JSON 格式：
{
  "suggestions": [
    {"type": "character", "target_char_id": null, "field": "personality", "value": "...", "existing_value": null, "conflict": false}
  ]
}`;

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '{}';
      return JSON.parse(text);
    } catch {
      return { suggestions: [] };
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
    },
  ) {
    const db = getDb();
    const ct = params.context_type;

    // 获取通用上下文
    const chars = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.book_id, params.book_id));
    const [world] = await db
      .select()
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, params.book_id));
    const [outline] = await db
      .select()
      .from(schema.outlines)
      .where(eq(schema.outlines.book_id, params.book_id));
    const outlineChapters = outline
      ? await db
          .select()
          .from(schema.outline_chapters)
          .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
      : [];

    // 角色完整信息（用于写作用途）
    const charFull = chars
      .map((c) =>
        [
          `【${c.name}】`,
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

    // 角色简表（用于大纲和角色管理）
    const charBrief = chars
      .map(
        (c) =>
          `- ${c.name}（${c.gender ?? ''}/${c.identity ?? ''}）：${c.personality ?? '暂无性格'}`,
      )
      .join('\n');

    // 大纲节点列表
    const outlineNodes = outlineChapters
      .map((oc) => `- ${oc.title}（${oc.status}）：${oc.summary ?? ''}`)
      .join('\n');

    // 世界观分区文本
    const worldText = world?.sections
      ? (world.sections as any[])
          .map((s) => `【${s.name}】\n${s.content}`)
          .join('\n\n')
      : '暂无设定';

    // 根据 context_type 构建定制的 system prompt
    const prompts: Record<string, string> = {
      write: `你是专业小说写作助手，正在帮助作者完成当前的写作章节。

【本作品全部角色设定——请严格按照以下设定写作，保持角色言行一致】
${charFull || '暂无角色设定'}

【世界观规则——所有情节必须符合以下世界设定】
${worldText}

【写作指引】
- 根据角色性格写对话：冷淡角色话少、活泼角色语气词多、文雅角色用典
- 根据世界观限制情节：修真世界遵循境界体系、科幻世界遵循科技设定
- 续写时自然衔接上文语气和节奏
- 需要插入正文时，输出 JSON：{"action":"insert_content","content":"<内容>","title":"可选标题"}
- 其他交互用自然语言回复即可`,

      outline: `你是小说大纲规划助手，帮作者把零散的想法变成清晰的故事结构。

【已有角色】
${charBrief}

【当前大纲节点】
${outlineNodes || '暂无节点，需要从零开始'}

【规划指引】
- 根据角色驱动情节：每个大纲节点应该推动至少一个角色的成长或冲突
- 保持节奏：幕与幕之间要有转折，章与章之间要有钩子
- 新增章节时输出 JSON：{"action":"add_chapter","title":"章节名","summary":"该章节的核心情节摘要"}
- 讨论结构时用自然语言，给具体建议而不是泛泛而谈`,

      characters: `你是角色创作顾问，帮作者塑造生动、立体的角色。

【已有角色——避免创建重复或矛盾的角色】
${charBrief}

【世界观——新角色必须符合这个世界】
${worldText.slice(0, 1500)}

【创作指引】
- 角色要服务于故事：为什么需要这个角色？TA推动什么情节？
- 性格不能凭空而来：用背景故事解释性格成因
- 说话风格要独特：每个角色有标志性的语气、用词习惯
- 角色之间要有化学反应：师徒、宿敌、暗恋、利用……关系让故事丰富
- 创建角色时输出 JSON：{"action":"create_character","name":"","gender":"男/女","personality":"","identity":"","backstory":"","motivation":"","catchphrase":"","speech_style":"","appearance":""}
- 建议修改已有角色时直接描述建议内容`,

      world: `你是世界观构建专家，帮作者创造自洽、引人入胜的虚构世界。

【已有世界观分区——请在此基础上扩展或补充】
${worldText}

【构建指引】
- 规则要有代价：如果魔法存在，使用者要付出什么？
- 设定要推动故事：世界规则不是为了"酷"，而是创造冲突和选择
- 细节要具体：不要"科技发达"，要"2049年的新东京，义体移植像今天配眼镜一样普遍"
- 不同势力/阵营要有不同的价值观和利益冲突
- 需要修改/补充分区时输出 JSON：{"action":"update_section","name":"分区名","content":"完整的修改后内容"}
- 建议新分区时用自然语言描述，引导作者创建`,

      settings: `你是作品配置助手。帮作者调整写作风格、自动保存间隔、每日字数目标等设置。

【当前状态】
- 写作风格预设：${params.message}
- 可根据作者习惯给出建议`,

      // 默认兜底
      default: `你是 Muse AI 写作助手，帮小说作者完成创作。

【角色】
${charBrief}

【世界观】
${worldText.slice(0, 1000)}

用自然语言回复作者的问题，涉及具体操作时给出明确指引。`,
    };

    const systemPrompt = prompts[ct] ?? prompts.write;

    this.streamChatToClient(
      res,
      systemPrompt,
      params.messages ?? [{ role: 'user', content: params.message }],
    );
  }

  private async streamChatToClient(
    res: Response,
    systemPrompt: string,
    messages: any[],
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
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          stream: true,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(60000),
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
              const content = JSON.parse(line.slice(6)).choices?.[0]?.delta
                ?.content;
              if (content) {
                fullContent += content;
                res.write(
                  `event: chunk\ndata: ${JSON.stringify({ content })}\n\n`,
                );
              }
            } catch {
              /* empty */
            }
          }
        }
      }

      // 尝试从完整回复中提取 JSON action
      try {
        const jsonMatch = fullContent.match(/\{[\s\S]*"action"[\s\S]*\}/);
        if (jsonMatch) {
          const action = JSON.parse(jsonMatch[0]);
          if (action.action) {
            res.write(`event: action\ndata: ${JSON.stringify(action)}\n\n`);
          }
        }
      } catch {
        /* empty */
      }

      res.write('event: done\ndata: {}\n\n');
    } catch (e: any) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`,
      );
    }
    res.end();
  }
}
