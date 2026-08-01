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
      user_id?: string;
    },
  ) {
    if (params.user_id) await this.checkBookOwnership(params.bookId, params.user_id);
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
        reader.cancel().catch(() => { });
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

    // 通用上下文：角色（完整字段）、世界观、大纲
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
    const allOutlineNodes = outline
      ? await db
          .select()
          .from(schema.outline_chapters)
          .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
          .orderBy(schema.outline_chapters.sort_order)
      : [];

    // 世界观文本
    const worldText = world?.sections
      ? (world.sections as any[])
          .map((s: any) => `【${s.name}】\n${s.content}`)
          .join('\n\n')
      : '暂无设定';

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
        .where(eq(schema.chapters.chapter_id, params.chapter_id));

      if (ch) {
        // 章节文本上下文
        const cursorPos = params.cursor_position ?? 0;
        const before = ch.content.slice(Math.max(0, cursorPos - 2000), cursorPos);
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
          const names = [c.name, ...(c.aliases ? c.aliases.split(/[,，]/).map((s) => s.trim()) : [])];
          return names.some((n) => chapterText.includes(n.toLowerCase()));
        });
        appearingChars = [...mainChars, ...appearedChars];
      }
    }

    // 如果没有章节内容，回退：注入主要角色 + 所有角色
    const contextChars =
      appearingChars.length > 0 ? appearingChars : chars;

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
          `- ${c.name}（${c.gender ?? ''}/${c.identity ?? ''}）：${c.personality ?? '暂无性格'}${c.is_main ? '【主】' : ''}`,
      )
      .join('\n');

    // 大纲全部节点列表
    const outlineNodes = allOutlineNodes
      .map((oc) => `- ${oc.title}（${oc.status}）：${oc.summary ?? ''}`)
      .join('\n');

    // 风格说明
    const styleGuide: Record<string, string> = {
      default: '',
      'light-novel':
        '轻小说风格：口语化对话、短段落、角色内心独白、轻松快节奏',
      serious: '严肃文学风格：细腻描写、克制情感、长句节奏、氛围营造优先',
      ancient:
        '古风风格：文言词汇、诗词意象、章回体韵味、对仗工整',
      plain: '小白文风格：直白易懂、快节奏、少修饰、注重剧情推进',
      colloquial: '口语化风格：生活化对话、接地气表述、贴近日常语言',
    };
    const styleNote = params.style ? styleGuide[params.style] ?? '' : '';
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

      outline: `你是小说大纲规划助手，帮作者把零散的想法变成清晰的故事结构。

【已有角色】
${charBrief}

【当前大纲节点】
${outlineNodes || '暂无节点，需要从零开始'}

【规划指引】
- 根据角色驱动情节：每个大纲节点应该推动至少一个角色的成长或冲突
- 保持节奏：幕与幕之间要有转折，章与章之间要有钩子
- 讨论结构时用自然语言，给具体建议而不是泛泛而谈

【回复格式——严格遵守】
如果需要新增章节，先简要说明理由，最后一行输出 JSON：
{"action":"add_chapter","title":"章节名","summary":"该章节的核心情节摘要"}
如果只是讨论，只输出自然语言。`,

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
- 建议修改已有角色时直接描述建议内容

【回复格式——严格遵守】
如果需要创建角色，先简要说明，最后一行输出 JSON：
{"action":"create_character","name":"","gender":"男/女","personality":"","identity":"","backstory":"","motivation":"","catchphrase":"","speech_style":"","appearance":""}
如果只是讨论角色设计，只输出自然语言。`,

      world: `你是世界观构建专家，帮作者创造自洽、引人入胜的虚构世界。

【已有世界观分区——请在此基础上扩展或补充】
${worldText}

【构建指引】
- 规则要有代价：如果魔法存在，使用者要付出什么？
- 设定要推动故事：世界规则不是为了"酷"，而是创造冲突和选择
- 细节要具体：不要"科技发达"，要"2049年的新东京，义体移植像今天配眼镜一样普遍"
- 不同势力/阵营要有不同的价值观和利益冲突
- 建议新分区时用自然语言描述，引导作者创建

【回复格式——严格遵守】
如果需要修改/补充分区，先简要说明，最后一行输出 JSON：
{"action":"update_section","name":"分区名","content":"完整的修改后内容"}
如果只是讨论设定，只输出自然语言。`,

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

    const systemPrompt = prompts[ct] ?? prompts.write;

    try {
      void this.streamChatToClient(
        res,
        systemPrompt,
        params.messages ?? [{ role: 'user', content: params.message }],
        params.model ?? 'deepseek-chat',
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
        reader.cancel().catch(() => { });
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
                // 直接发原文，不做 JSON 包装（标准 SSE 流式模式）
                res.write(`event: chunk\ndata: ${content}\n\n`);
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

  // AI 模仿笔风：分析已完成章节，提取写作风格特征
  async mimicStyle(bookId?: string, model?: string, customText?: string) {
    const apiKey = process.env.AI_PLATFORM_KEY;
    if (!apiKey) return { analysis: '' };

    let sample = '';

    if (customText && customText.trim().length >= 200) {
      // 使用手动输入的文本
      sample = customText.slice(0, 8000);
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

    const baseUrl = process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
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
}
