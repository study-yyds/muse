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

    this.streamToClient(
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
      res.on('close', () => reader.cancel());

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
                /* 忽略解析错误 */
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

    const charList = chars
      .map(
        (c) =>
          `- ${c.name}（${c.personality ?? '暂无性格'}）: ${c.identity ?? ''}`,
      )
      .join('\n');

    // 根据 context_type 构建不同的 system prompt
    const prompts: Record<string, string> = {
      write: `你是小说写作助手。当前在"写作"模式。

【角色设定】
${charList}

【世界观】
${world?.sections ? (world.sections as any[]).map((s) => `[${s.name}] ${s.content}`).join('\n') : '暂无'}

你可以：续写、改写、润色。生成内容时用 JSON 格式：
{"action":"insert_content","content":"生成的内容","title":"可选标题"}`,

      outline: `你是大纲规划助手。当前在"大纲"模式。

【角色】
${charList}

【已写章节】
${outline ? `有 ${outlineChapters.length} 个大纲节点` : '暂无大纲'}

你可以：建议新章节、调整结构、补全章节摘要。生成内容时用 JSON：
{"action":"add_chapter","title":"章节名","summary":"章节摘要"}`,

      characters: `你是角色创作助手。当前在"角色"模式。

【已有角色】
${charList}

【世界观】
${world?.sections ? JSON.stringify(world.sections).slice(0, 500) : '暂无'}

你可以：创建新角色、补全性格/背景、建议角色关系。生成内容时用 JSON：
{"action":"create_character","name":"角色名","gender":"性别","personality":"性格","identity":"身份","backstory":"背景","motivation":"动机","catchphrase":"口头禅","speech_style":"说话风格","appearance":"外貌"}`,

      world: `你是世界观构建助手。当前在"世界观"模式。

【已有分区】
${world?.sections ? (world.sections as any[]).map((s) => `${s.name}: ${s.content}`).join('\n') : '暂无'}

你可以：补全分区内容、建议新分区、完善设定。生成内容时用 JSON：
{"action":"update_section","name":"分区名","content":"补全内容"}`,
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
      res.on('close', () => reader.cancel());

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
            } catch {}
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
      } catch {}

      res.write('event: done\ndata: {}\n\n');
    } catch (e: any) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`,
      );
    }
    res.end();
  }
}
