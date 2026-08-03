import { Injectable } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { Response } from 'express';

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
    role: m.role,
    content: sanitizePrompt(m.content),
  }));
}

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

    // 已有世界观分区
    const [world] = await db
      .select({ sections: schema.world_settings.sections })
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId));

    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';
    const apiKey = process.env.AI_PLATFORM_KEY;

    if (!apiKey) return { suggestions: [] };

    const prompt = `从以下小说章节中提取角色和世界观设定。

【已有角色，带 char_id——修改已有角色时必须用这个 ID】
${characters.map((c) => `- id=${c.char_id} | ${c.name} | 性格=${c.personality ?? '无'} | 身份=${c.identity ?? '无'} | 背景=${(c.backstory ?? '').slice(0, 50)}`).join('\n') || '暂无角色'}

【已有世界观分区——新增或修改世界观时参考分区名】
${world?.sections ? (world.sections as any[]).map((s: any) => `${s.name}`).join(', ') : '无分区'}

【章节内容】
${(chapter?.content ?? '').slice(0, 4000)}

请按以下 JSON 格式返回（只返回 JSON，不要其他文字）：
{
  "suggestions": [
    {"type": "character", "target_char_id": "已有角色的char_id或null(新建)", "field": "personality|identity|backstory|motivation|appearance|gender|catchphrase|speech_style", "value": "提取到的值", "existing_value": "已有值或null", "conflict": true或false},
    {"type": "world", "section_name": "分区名", "content": "该分区的设定内容", "existing_value": null, "conflict": false}
  ]
}
规则：
- character: 如果角色已存在（名字匹配），target_char_id 填已有 ID
- character: 如果角色不存在，target_char_id=null，用 field="name" 给出新角色名
- world: 设定归属到已有分区名，或建议新分区
- conflict: 已有值与提取值不一致时为 true`;

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
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '{}';
      // JSON 提取容错：去除 markdown 代码块包裹
      let jsonStr = text.trim();
      const match = jsonStr.match(/\{[\s\S]*"suggestions"[\s\S]*\}/);
      if (match) jsonStr = match[0];
      return JSON.parse(jsonStr);
    } catch {
      return { suggestions: [] };
    }
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
        .where(eq(schema.chapters.chapter_id, params.chapter_id));

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

    // 大纲全部节点列表
    const outlineNodes = allOutlineNodes
      .map((oc) => `- ${oc.title}（${oc.status}）：${oc.summary ?? ''}`)
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
如果需要新增章节，先简要说明理由，最后一行输出纯 JSON（前后不加任何额外字符，不要用反引号包裹）：
{"action":"add_chapter","title":"章节名","summary":"该章节的核心情节摘要"}
如果只是讨论，只输出自然语言。`,

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

    const systemPrompt = prompts[ct] ?? prompts.write;

    try {
      const cleanMessages = params.messages
        ? sanitizeMessages(params.messages)
        : [{ role: 'user', content: sanitizePrompt(params.message) }];
      void this.streamChatToClient(
        res,
        systemPrompt,
        cleanMessages,
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
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(120000),
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
                res.write(
                  `event: chunk\ndata: ${JSON.stringify(content)}\n\n`,
                );
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
          if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.includes('"action"')) {
            let parsed: any = null;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              // 尝试修复无效 JSON
              const fixed = trimmed.replace(
                /"content"\s*:\s*"([\s\S]*?)"\s*[,}]/g,
                (_: string, inner: string) => {
                  const escaped = inner.replace(/(?<!\\)"(?!"\s*[,:}\]])/g, '"');
                  return `"content":"${escaped}"`;
                },
              );
              try { parsed = JSON.parse(fixed); } catch { /* 放弃 */ }
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
      // 使用手动输入的文本（消毒 + 长度限制）
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

    const baseUrl =
      process.env.AI_PLATFORM_BASE_URL ?? 'https://api.deepseek.com/v1';
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
}
