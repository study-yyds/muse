import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { sanitizePrompt } from '../ai/ai.service';
import { Response } from 'express';

@Injectable()
export class CharTestService {
  // 创建或获取角色的测试会话
  async getOrCreateSession(charId: string, bookId?: string) {
    const db = getDb();
    if (bookId) await this.#verifyCharOwnership(charId, bookId);
    const [existing] = await db
      .select()
      .from(schema.char_test_dialog_sessions)
      .where(eq(schema.char_test_dialog_sessions.char_id, charId))
      .limit(1);

    if (existing) return existing;

    const [session] = await db
      .insert(schema.char_test_dialog_sessions)
      .values({ char_id: charId })
      .returning();

    return session;
  }

  // 校验角色归属
  async #verifyCharOwnership(charId: string, bookId: string) {
    const db = getDb();
    const [c] = await db
      .select({ book_id: schema.characters.book_id })
      .from(schema.characters)
      .where(eq(schema.characters.char_id, charId))
      .limit(1);
    if (!c || c.book_id !== bookId) throw new Error('角色不属于该作品');
  }

  // 列出角色的所有测试会话
  async listSessions(charId: string, bookId?: string) {
    if (bookId) await this.#verifyCharOwnership(charId, bookId);
    const db = getDb();
    return db
      .select()
      .from(schema.char_test_dialog_sessions)
      .where(eq(schema.char_test_dialog_sessions.char_id, charId))
      .orderBy(schema.char_test_dialog_sessions.updated_at);
  }

  // SSE 流式对话：AI 扮演角色与用户对话
  async chat(
    res: Response,
    charId: string,
    sessionId: string,
    message: string,
    model: string = 'deepseek-v4-flash',
    customApiKey?: string,
    customBaseUrl?: string,
    bookId?: string,
  ) {
    if (bookId) await this.#verifyCharOwnership(charId, bookId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 用户消息清洗：防 prompt 注入 + 长度限制
    message = sanitizePrompt(message);
    if (!message.trim()) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: '消息为空' })}\n\n`,
      );
      res.end();
      return;
    }

    const db = getDb();
    const apiKey = customApiKey || process.env.AI_PLATFORM_KEY;
    if (!apiKey) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 未配置' })}\n\n`,
      );
      res.end();
      return;
    }

    // 获取角色完整设定
    const [char] = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.char_id, charId));

    if (!char) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: '角色不存在' })}\n\n`,
      );
      res.end();
      return;
    }

    // 获取历史对话（必须属于当前角色，防止跨角色会话串用）
    const [session] = await db
      .select()
      .from(schema.char_test_dialog_sessions)
      .where(eq(schema.char_test_dialog_sessions.session_id, sessionId));

    if (!session || session.char_id !== charId) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: '会话不存在或不属于该角色' })}\n\n`,
      );
      res.end();
      return;
    }

    const history: any[] = Array.isArray(session?.messages)
      ? (session.messages as any[])
      : [];

    // 构建角色扮演 system prompt
    const charProfile = [
      `你正在扮演以下角色，请完全沉浸在这个角色中进行对话。`,
      ``,
      `【角色名】${char.name}`,
      char.gender ? `性别：${char.gender}` : null,
      char.identity ? `身份：${char.identity}` : null,
      char.personality ? `性格：${char.personality}` : null,
      char.speech_style ? `说话风格：${char.speech_style}` : null,
      char.catchphrase ? `口头禅：${char.catchphrase}` : null,
      char.backstory ? `背景故事：${char.backstory}` : null,
      char.motivation ? `动机：${char.motivation}` : null,
      char.appearance ? `外貌：${char.appearance}` : null,
      ``,
      `【扮演规则】`,
      `- 严格按照角色的性格、说话风格、口头禅来回应`,
      `- 用第一人称回复，就像你就是${char.name}本人在说话`,
      `- 回复长度适中，像真实对话一样自然`,
      `- 不要跳出角色，始终保持角色一致性`,
      `- 不要用括号描述动作（除非角色的设定中有这种习惯）`,
      `- 用中文回复`,
    ]
      .filter(Boolean)
      .join('\n');

    // 最近 20 轮对话作为上下文
    const recentHistory = history.slice(-20);
    const messages: any[] = [
      { role: 'system', content: charProfile },
      ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // 保存用户消息
    history.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    const baseUrl =
      customBaseUrl ||
      process.env.AI_PLATFORM_BASE_URL ||
      'https://api.deepseek.com/v1';
    // SSRF 防护：只允许白名单域名
    const allowedHosts = [
      'api.deepseek.com',
      'api.openai.com',
      'dashscope.aliyuncs.com',
    ];
    try {
      const host = new URL(baseUrl).hostname;
      if (!allowedHosts.some((h) => host === h || host.endsWith('.' + h))) {
        console.warn('[char-test] blocked SSRF attempt to:', host);
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: '不允许的 API 端点' })}\n\n`,
        );
        res.end();
        return;
      }
    } catch {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: '无效的 API 地址' })}\n\n`,
      );
      res.end();
      return;
    }
    let fullContent = '';

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          max_tokens: 2048,
          // 关闭思考链：不关的话 reasoning_content 会以思考过程流给前端，
          // 且思考消耗 max_tokens 导致对白为空（与快捷生成同款病）
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        // 携带上游状态码：前端可区分 401/403（Key 失效）与 429（限流）
        console.log(
          `[char-test] AI error status ${response.status}, model ${model}`,
        );
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: 'AI 请求失败', status: response.status })}\n\n`,
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
              // 只转发对白正文：reasoning_content 是思考过程，泄露给用户会看到角色内心独白
              const content = delta?.content;
              if (content) {
                fullContent += content;
                // JSON.stringify：chunk 含换行时按 SSE 规范编码，客户端解析不丢换行
                res.write(`event: chunk\ndata: ${JSON.stringify(content)}\n\n`);
              }
            } catch {
              /* empty */
            }
          }
        }
      }

      if (!fullContent) {
        console.log(`[char-test] empty reply (model ${model}), msg:`, message.slice(0, 50));
      }

      // 保存 AI 回复到历史
      if (fullContent) {
        history.push({
          role: 'assistant',
          content: fullContent,
          timestamp: new Date().toISOString(),
        });
        await db
          .update(schema.char_test_dialog_sessions)
          .set({ messages: history, updated_at: new Date() })
          .where(eq(schema.char_test_dialog_sessions.session_id, sessionId));
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
