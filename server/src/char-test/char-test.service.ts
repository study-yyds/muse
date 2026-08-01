import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { Response } from 'express';

@Injectable()
export class CharTestService {
  // 创建或获取角色的测试会话
  async getOrCreateSession(charId: string) {
    const db = getDb();
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

  // 列出角色的所有测试会话
  async listSessions(charId: string) {
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
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const db = getDb();
    const apiKey = customApiKey || process.env.AI_PLATFORM_KEY;
    if (!apiKey) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'AI 未配置' })}\n\n`);
      res.end();
      return;
    }

    // 获取角色完整设定
    const [char] = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.char_id, charId));

    if (!char) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: '角色不存在' })}\n\n`);
      res.end();
      return;
    }

    // 获取历史对话
    const [session] = await db
      .select()
      .from(schema.char_test_dialog_sessions)
      .where(eq(schema.char_test_dialog_sessions.session_id, sessionId));

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
    history.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

    const baseUrl = customBaseUrl || process.env.AI_PLATFORM_BASE_URL || 'https://api.deepseek.com/v1';
    // SSRF 防护：只允许白名单域名
    const allowedHosts = ['api.deepseek.com', 'api.openai.com', 'dashscope.aliyuncs.com'];
    try {
      const host = new URL(baseUrl).hostname;
      if (!allowedHosts.some((h) => host === h || host.endsWith('.' + h))) {
        console.warn('[char-test] blocked SSRF attempt to:', host);
        res.write(`event: error\ndata: ${JSON.stringify({ message: '不允许的 API 端点' })}\n\n`);
        res.end();
        return;
      }
    } catch {
      res.write(`event: error\ndata: ${JSON.stringify({ message: '无效的 API 地址' })}\n\n`);
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
        body: JSON.stringify({ model, messages, stream: true, max_tokens: 2048 }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'AI 请求失败' })}\n\n`);
        res.end();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) { res.end(); return; }

      const decoder = new TextDecoder();
      let buffer = '';

      res.on('close', () => { reader.cancel().catch(() => {}); });

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
              const content = delta?.content || delta?.reasoning_content;
              if (content) {
                fullContent += content;
                res.write(`event: chunk\ndata: ${content}\n\n`);
              }
            } catch { /* empty */ }
          }
        }
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
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
    }
    res.end();
  }
}
