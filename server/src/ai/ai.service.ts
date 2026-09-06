import { Injectable } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { assertSafeBaseUrl } from '../base-url-safety';
import { downgradeExpiredForUser } from '../billing/subscription-ops';
import * as aiPrompts from './ai-prompts';
import * as aiUtils from './ai-utils';
import { ChatOps } from './chat-ops';
import { ChapterOps } from './chapter-ops';
import { MediaOps } from './media-ops';
import { CreationOps } from './creation-ops';
import { Response } from 'express';
import crypto from 'crypto';

// sanitizePrompt 由 ai-prompts.ts 实现，此处 re-export 供外部模块与测试沿用原导入路径
export { sanitizePrompt } from './ai-prompts';

@Injectable()
export class AiService {
  // 拆分出的操作层（见各 ops 文件）；AiService 保留编排 / Key 解析 / 额度
  private readonly chatOps = new ChatOps(this);
  private readonly chapterOps = new ChapterOps(this);
  private readonly mediaOps = new MediaOps(this);
  private readonly creationOps = new CreationOps(this);
  // 统一获取 API Key（指定 keyId 时精确使用该 Key，否则用户自定义优先，fallback 平台）
  async resolveApiKey(
    userId: string | undefined,
    usage: 'chat' | 'image',
    modelHint?: string,
    keyId?: string,
  ): Promise<{
    apiKey: string;
    baseUrl: string;
    model: string;
    source: 'user' | 'platform';
  }> {
    const db = getDb();
    // 月度字数额度拦截只针对平台 Key（计费口径=生成字数）：
    // 自有 Key 由用户自付成本、不消耗平台额度，作为额度耗尽后的兜底通道不拦截
    if (userId) {
      // 前端指定了具体 Key：只使用该 Key（校验归属 + 启用 + 用途匹配）
      if (keyId) {
        const [k] = await db
          .select()
          .from(schema.user_api_keys)
          .where(
            and(
              eq(schema.user_api_keys.id, keyId),
              eq(schema.user_api_keys.user_id, userId),
              eq(schema.user_api_keys.is_active, true),
            ),
          )
          .limit(1);
        if (k && (k.usage === usage || k.usage === 'both')) {
          try {
            const decrypted = this.#decryptUserKey(k);
            await assertSafeBaseUrl(k.base_url);
            return {
              apiKey: decrypted,
              baseUrl: k.base_url,
              model: k.model_name,
              source: 'user',
            };
          } catch {
            /* 解密/校验失败：回退到默认逻辑 */
          }
        }
      }

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
          const decrypted = this.#decryptUserKey(k);
          // SSRF 防护：校验用户 base_url（私网/回环/内网域名一律拒绝），
          // 校验失败时降级到平台 Key
          await assertSafeBaseUrl(k.base_url);
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
      if (userId) await this.assertMonthlyQuota(userId);
      return {
        apiKey: process.env.QWEN_API_KEY,
        baseUrl:
          process.env.QWEN_BASE_URL ||
          'https://llm-6pagmd0n2hiazjz1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: modelHint || 'qwen3.7-plus',
        source: 'platform',
      };
    }

    if (userId) await this.assertMonthlyQuota(userId);
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

  // AES-256-GCM 解密用户 API Key
  #decryptUserKey(k: {
    api_key_encrypted: string;
    encryption_iv: string;
  }): string {
    const { createDecipheriv } = crypto;
    const key = crypto
      .createHash('sha256')
      .update(process.env.ENCRYPTION_KEY || '')
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
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
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
  async recordUsage(params: {
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
      // 按服务器本地月份（UTC 切月会让国内用户月初 8 点前的用量记入上月）
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await db
        .insert(schema.user_monthly_quota)
        .values({
          user_id: params.userId,
          month,
          used_tokens: tokenCount,
          used_words: params.outChars,
        })
        .onConflictDoUpdate({
          target: [
            schema.user_monthly_quota.user_id,
            schema.user_monthly_quota.month,
          ],
          set: {
            used_tokens: sql`${schema.user_monthly_quota.used_tokens} + ${tokenCount}`,
            used_words: sql`${schema.user_monthly_quota.used_words} + ${params.outChars}`,
          },
        });
    } catch (e: any) {
      console.error('[usage] record failed:', e.message);
    }
  }

  /**
   * 月度字数额度拦截：额度耗尽时抛错（带标记）；DB 异常静默放行——
   * 额度系统故障不阻断创作，但不能因故障白放行超限。
   */
  private async assertMonthlyQuota(userId: string) {
    try {
      // 惰性订阅降级：过期付费用户在额度检查前降回免费档（maintenance 全量扫描之外的即时兜底）
      await downgradeExpiredForUser(userId);
      const db = getDb();
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const [quotaRow] = await db
        .select({ used: schema.user_monthly_quota.used_words })
        .from(schema.user_monthly_quota)
        .where(
          and(
            eq(schema.user_monthly_quota.user_id, userId),
            eq(schema.user_monthly_quota.month, month),
          ),
        )
        .limit(1);
      const [user] = await db
        .select({ quota: schema.users.monthly_words_quota })
        .from(schema.users)
        .where(eq(schema.users.user_id, userId))
        .limit(1);
      const quota = user?.quota ?? null;
      if (quota != null && quota >= 0 && (quotaRow?.used ?? 0) >= quota) {
        const err = new Error(
          '本月 AI 字数额度已用完，请升级套餐或等待下月重置',
        );
        (err as any).__quotaExceeded = true;
        throw err;
      }
    } catch (e: any) {
      if (e?.__quotaExceeded) throw e;
      /* DB 异常静默放行 */
    }
  }

  /** 本月用量与额度（对外计费口径：生成字数；quota 为 null 表示不限） */
  async getMonthlyQuota(userId: string) {
    const db = getDb();
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [quotaRow] = await db
      .select({ used: schema.user_monthly_quota.used_words })
      .from(schema.user_monthly_quota)
      .where(
        and(
          eq(schema.user_monthly_quota.user_id, userId),
          eq(schema.user_monthly_quota.month, month),
        ),
      )
      .limit(1);
    const [user] = await db
      .select({ quota: schema.users.monthly_words_quota })
      .from(schema.users)
      .where(eq(schema.users.user_id, userId))
      .limit(1);
    const quota = user?.quota ?? 30000;
    const used = quotaRow?.used ?? 0;
    return {
      month,
      used_words: used,
      quota_words: quota < 0 ? null : quota,
      remaining: quota < 0 ? null : Math.max(0, quota - used),
    };
  }

  // 主流题材知识库（引导模式注入）：题材-套路-爽点结构-引导追问点。
  // 覆盖经典热门（模型自有知识，非实时榜单）；时效热点由运营配置维护（预留）
  // 实现见 ai-prompts.ts / ai-utils.ts，此处保留静态入口兼容既有调用与测试
  static readonly GENRE_KNOWLEDGE = aiPrompts.GENRE_KNOWLEDGE;

  // 构建引导模式 system prompt
  static buildGuideSystemPrompt = aiUtils.buildGuideSystemPrompt;

  async chat(
    res: Response,
    params: {
      book_id: string;
      context_type: string;
      message: string;
      messages?: any[];
      model?: string;
      key_id?: string;
      chapter_id?: string;
      cursor_position?: number;
      style?: string;
      // 选中改写模式：改写指引替代续写指引（保事实换形式）
      rewrite?: boolean;
      user_id?: string;
      guide_mode?: boolean;
      guide_context?: string;
      guide_type?: string;
    },
  ) {
    return this.chatOps.chat(res, params);
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
    thinking?: { type: string },
    qualityCheck = false,
  ) {
    return this.chatOps.streamChatToClient(
      res,
      systemPrompt,
      messages,
      model,
      maxTokens,
      customApiKey,
      customBaseUrl,
      usage,
      thinking,
      qualityCheck,
    );
  }

  async summarizeChapter(userId: string, chapterId: string, content: string) {
    return this.chapterOps.summarizeChapter(userId, chapterId, content);
  }

  async extractChapterFacts(
    userId: string,
    bookId: string,
    chapterId: string,
    content: string,
  ) {
    return this.chapterOps.extractChapterFacts(
      userId,
      bookId,
      chapterId,
      content,
    );
  }

  async extendChapterOutlines(
    userId: string,
    bookId: string,
    model?: string,
    keyId?: string,
    count?: number,
    nodeId?: string,
  ): Promise<{ lines: string[]; startNo: number }> {
    return this.chapterOps.extendChapterOutlines(
      userId,
      bookId,
      model,
      keyId,
      count,
      nodeId,
    );
  }

  /** 重新生成卷纲：按引导摘要+世界观+主角重写整套大纲节点（替换旧节点，章节解绑） */
  async regenerateOutline(
    userId: string,
    bookId: string,
    model?: string,
    keyId?: string,
  ) {
    return this.chapterOps.regenerateOutline(userId, bookId, model, keyId);
  }

  /** 解析细化节点的 JSON 数组（代码块/裸数组容错）；至少 3 个有效节点才返回 */
  static parseOutlineNodesJson = aiUtils.parseOutlineNodesJson;

  async refineNode(
    userId: string,
    bookId: string,
    nodeId: string,
    model?: string,
    keyId?: string,
  ) {
    return this.chapterOps.refineNode(userId, bookId, nodeId, model, keyId);
  }

  async generateChapter(
    res: Response,
    params: {
      user_id: string;
      book_id: string;
      chapter_id: string;
      model?: string;
      key_id?: string;
      style?: string;
      replace?: boolean; // true = 覆盖重新生成（视本章为空，从开头写并替换保存）
    },
  ) {
    return this.chapterOps.generateChapter(res, params);
  }

  async mimicStyle(
    bookId?: string,
    model?: string,
    customText?: string,
    userId?: string,
    keyId?: string,
  ) {
    return this.chapterOps.mimicStyle(bookId, model, customText, userId, keyId);
  }

  async getActiveSession(
    bookId: string | null,
    section: string,
    userId?: string,
  ) {
    return this.chatOps.getActiveSession(bookId, section, userId);
  }

  async getSessions(bookId: string | null, section: string, userId?: string) {
    return this.chatOps.getSessions(bookId, section, userId);
  }

  async createSession(
    bookId: string | null,
    section: string,
    title: string,
    userId: string,
  ) {
    return this.chatOps.createSession(bookId, section, title, userId);
  }

  async updateSessionMessages(
    sessionId: string,
    messages: any[],
    userId: string,
  ) {
    return this.chatOps.updateSessionMessages(sessionId, messages, userId);
  }

  async restoreSession(sessionId: string, userId: string) {
    return this.chatOps.restoreSession(sessionId, userId);
  }

  async deleteSession(sessionId: string, userId: string) {
    return this.chatOps.deleteSession(sessionId, userId);
  }

  async generateImage(
    prompt: string,
    size = '2K',
    style?: string,
    userId?: string,
    modelHint?: string,
    keyId?: string,
  ): Promise<string> {
    return this.mediaOps.generateImage(
      prompt,
      size,
      style,
      userId,
      modelHint,
      keyId,
    );
  }

  async buildCoverPrompt(bookId: string) {
    return this.mediaOps.buildCoverPrompt(bookId);
  }

  async recommendVisualStyle(bookId: string, userId?: string) {
    return this.mediaOps.recommendVisualStyle(bookId, userId);
  }

  async buildCharPrompt(charId: string) {
    return this.mediaOps.buildCharPrompt(charId);
  }

  private async ttsRequest(
    text: string,
    apiKey: string,
    voiceType: string,
  ): Promise<{ base64: string; durationSec: number }> {
    return this.mediaOps.ttsRequest(text, apiKey, voiceType);
  }

  private getAudioDurationSec(audioBuf: Buffer, text: string): number {
    return this.mediaOps.getAudioDurationSec(audioBuf, text);
  }

  async synthesizeShortText(
    text: string,
    voiceType: string,
    userId?: string,
  ): Promise<string> {
    return this.mediaOps.synthesizeShortText(text, voiceType, userId);
  }

  async generateSpeech(
    text: string,
    voiceType: string = 'zh_female_xiaohe_uranus_bigtts',
    userId?: string,
  ): Promise<{ url: string; durationSec: number }> {
    return this.mediaOps.generateSpeech(text, voiceType, userId);
  }

  async generateSpeechPerLine(
    lines: string[],
    voiceType: string = 'zh_female_xiaohe_uranus_bigtts',
    userId?: string,
  ): Promise<Array<{ url: string; durationSec: number }>> {
    return this.mediaOps.generateSpeechPerLine(lines, voiceType, userId);
  }

  async generateSynopsis(
    bookId: string,
    userId?: string,
    model?: string,
    keyId?: string,
  ) {
    return this.mediaOps.generateSynopsis(bookId, userId, model, keyId);
  }

  async generateZhihuPack(
    content: string,
    userId?: string,
    bookId?: string,
  ): Promise<{ titles: string[]; openings: string[] }> {
    return this.creationOps.generateZhihuPack(content, userId, bookId);
  }

  // ============== 快捷创作 ==============

  /**
   * 条件规则：根据用户想法中的题材意图，动态生成创作规则段（纯函数，可单测）
   * 复仇/悬疑类注入"信息差不摊牌"；甜宠/治愈类注入"允许坦白"；有加害者题材注入"代价铁律"
   */
  static buildConditionalRules = aiUtils.buildConditionalRules;
  static buildRecap = aiUtils.buildRecap;
  static buildTitleFallback = aiUtils.buildTitleFallback;
  static extractFactors = aiUtils.extractFactors;
  static selectWorldSections = aiUtils.selectWorldSections;

  static parseChapterOutlines = aiUtils.parseChapterOutlines;
  static buildCapabilityTimeline = aiUtils.buildCapabilityTimeline;
  static parseProtagonist = aiUtils.parseProtagonist;
  static buildChatMemory = aiUtils.buildChatMemory;

  private async mergeChatSettings(
    baseUrl: string,
    apiKey: string,
    model: string,
    existing: string[],
    newLines: string[],
  ): Promise<string[] | null> {
    return this.chatOps.mergeChatSettings(
      baseUrl,
      apiKey,
      model,
      existing,
      newLines,
    );
  }

  async quickCreateShort(
    res: Response,
    params: {
      user_id: string;
      premise: string;
      model?: string;
      key_id?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
  ) {
    return this.creationOps.quickCreateShort(res, params);
  }

  /**
   * 解析骨架化输出：骨架行 / 梗概行 / 风险行（纯函数，供单测）
   */
  static parseSkeletonize = aiUtils.parseSkeletonize;

  async skeletonizeSynopsis(params: {
    user_id: string;
    synopsis: string;
    model?: string;
    key_id?: string;
    with_check?: boolean;
  }): Promise<{ skeleton: string; preview: string; risks: string[] }> {
    return this.creationOps.skeletonizeSynopsis(params);
  }

  async createShortFromSynopsis(params: {
    user_id: string;
    synopsis: string;
    skeleton?: string;
    preview?: string;
  }): Promise<{ book_id: string }> {
    return this.creationOps.createShortFromSynopsis(params);
  }

  async generateStory(
    res: Response,
    params: {
      user_id: string;
      book_id: string;
      premise: string;
      model?: string;
      key_id?: string;
      // 断点续传:客户端断连后带 true 重试,跳过已完成的轮(settings.extra.story_parts)
      resume_story?: boolean;
    },
  ) {
    return this.creationOps.generateStory(res, params);
  }

  async quickCreate(
    res: Response,
    params: {
      user_id: string;
      premise: string;
      model?: string;
      key_id?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
  ) {
    return this.creationOps.quickCreate(res, params);
  }

  private async parseAndSaveWorld(bookId: string, aiText: string) {
    return this.creationOps.parseAndSaveWorld(bookId, aiText);
  }

  async parseAndSaveOutline(bookId: string, aiText: string) {
    return this.creationOps.parseAndSaveOutline(bookId, aiText);
  }

  private async parseAndSaveCharacters(bookId: string, aiText: string) {
    return this.creationOps.parseAndSaveCharacters(bookId, aiText);
  }
}
