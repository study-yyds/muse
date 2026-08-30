import { Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc, sql, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { assertSafeBaseUrl } from '../base-url-safety';
import { registerBookAbort, unregisterBookAbort } from './abort-registry';
import { detectAiFlavors } from './text-quality-checks';
import { Response } from 'express';
import crypto from 'crypto';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

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

// 写作风格预设（模块级常量：chat 续写与整章生成共用）
const STYLE_GUIDES: Record<string, string> = {
  default:
    '自然流畅的通俗小说叙事：语言直白清晰，动作与对话推进情节，少用辞藻堆砌；段落不宜过长，避免文艺腔与抽象抒情',
  'light-novel':
    '快节奏网文（番茄/起点主流写法）：写"人话"——动词为主、少形容词，拒绝矫情长句与堆砌辞藻；段落短，手机屏不超过5行；用动作和对话展示情绪与冲突，不直白叙述；冲突前置，片段内必有具体可感知的麻烦与爽点（打压→反转→打脸）；情绪靠真细节传递，不替读者说完；结尾留强钩子',
  serious:
    '文艺细腻：句子节奏舒缓，多用长句与细节描写；情感表达克制含蓄，靠动作与场景传情；注重氛围营造；修辞与用词讲究但不堆砌',
  ancient:
    '古风：多用文言词汇与四字短语，善用诗词意象；句式对仗工整，有章回体韵味；称谓与器物考究，符合古代语境',
  'jj-style':
    '晋江文风：以人物关系与情感线为叙事核心（言情/纯爱/百合通用，无CP作品则以人物成长与羁绊为主线）；心理描写细腻，氛围感与留白充足；一条主情绪贯穿全篇，情绪转折必须有铺垫；对话含蓄有张力，靠潜台词和细节传递情绪，不把话说满；情节逻辑自洽，情感质感优先于节奏爽感',
  colloquial:
    '平实口语：像日常说话一样自然，多用生活化词汇；句式松散灵活，允许口语省略；贴近真实对话节奏，不端着',
};

@Injectable()
export class AiService {
  // 统一获取 API Key（指定 keyId 时精确使用该 Key，否则用户自定义优先，fallback 平台）
  private async resolveApiKey(
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
    // 月度字数额度拦截：所有 AI 调用统一在此检查（计费口径=生成字数）
    if (userId) {
      await this.assertMonthlyQuota(userId);
    }
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
  static readonly GENRE_KNOWLEDGE = `【题材知识库（2026 年网文市场趋势）——提问与给方向时参考】

【2026 三大风向】
1. 反套路成为新套路：读者看腻传统套路，开篇 300 字内要给出"反预期"信号；读者能接受慢节奏、重逻辑的深度内容
2. 跨界融合取代单一题材：爆款多为"题材A+题材B"的化学反应（如末世+种田、玄幻+同人、历史+考据权谋）；追问点：两个题材的情绪反差/化学反应点在哪
3. 情绪价值压过逻辑爽感："发疯文学""反内卷""躺平流"（摸鱼得奖励）完读率显著更高；从"我要赢"转向"我值得"；追问点：主角的情绪出口是什么、在反抗什么评价体系

【男频赛道（2026）】
- 都市脑洞/都市日常（新书最多）：日常藏异常+脑洞反转；追问点：核心异常、反转节奏
- 东方仙侠/都市高武：设定扎实+快节奏；追问点：力量体系代价、越级打脸设计
- 战神赘婿（仍稳）：老套路但流量稳定，开篇须做反套路微调
- 系统流都市：新人友好；追问点：系统规则/奖励/代价
- 都市种田/重生基建：全民参与感+成长线；追问点：开局资源、扩张节奏
- 无限流智斗：规则怪谈+以智取胜；追问点：规则边界、骚操作设计
- 历史权谋/考据：硬核深度向；追问点：史实考据点、权谋棋局
- 同人：斗罗/斗破不可写（版权封禁），海贼/火影等动漫同人起量快

【女频赛道（2026）】
- 豪门总裁/先婚后爱（最大盘）：甜宠为主，"双洁"是主流刚需，虐越少越好；追问点：契约缘由、误会反转、男主先动心的契机
- 年代文/高干（榜单半壁江山）：可短期冲爆款，流量周期短，不宜写太长；追问点：时代红利点、家长里短冲突
- 宫斗宅斗（古言）：追问点：家世格局、斗法层级
- 追妻火葬场+带球跑：已烂大街，需强反套路才写
- 蓝海：非遗文化+中女创业、女性科研/科考（航天/考古/海洋）、无CP女性互助群像——作品极少但转化好评率高，番茄对"非遗传承"标签有流量倾斜

【知乎盐选短篇向】
- 强反转+信息差+道德困境；追问点：核心物证、隐瞒的真相、结局反转方向

【政策红线】
- 黑化/暴力擦边题材已被屏蔽签约，属高危雷区
- 平台严打纯 AI 水文：开篇代入感强、主线清晰、人物立得住是收稿硬标准

注意：以上为 2026 年市场趋势参考（非实时榜单，需定期人工更新），是辅助判断不是模板——先听清作者脑洞，再针对性追问；不要替作者选题材。`

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

${AiService.GENRE_KNOWLEDGE}

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
          params.key_id,
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

    // 随机灵感：专用策划 prompt，不加载作品上下文；智能默认时升 Pro
    // （策划类任务在 Flash 上先塌陷，IFScale 依据；同梗概升级逻辑）
    if (ct === 'inspire') {
      try {
        const inspirePrompt =
          '你是短篇小说创意策划。根据用户指定的题材和脑洞要素要求，给出一个一句话故事脑洞，20-40 字，只抓一个核心爆点。脑洞必须含：一个具体的主角身份（职业/角色，如茶水妹、实习生）和一个情绪钩子（让读者产生"然后呢"的情绪）。脑洞必须符合基本生理/物理/社会常识（心脏捐献=人死亡，不能"捐了心脏还能跑路"；若用超自然设定必须明示为奇幻）。脑洞若含关键道具/信物（糖/信/礼物等），必须一句内闭环它的归属与传递（谁留的、放在哪、对方怎么拿到），不得只写"留了"不写去向；若含"延迟发现"（攒了X年/多年后才察觉），必须写明延迟的机制（舍不得拆/藏得极深/特定条件才显现），不得仅写"一直没注意"。只输出这一句脑洞本身，不加引号、不加解释。';
        const cleanMessages = Array.isArray(params.messages)
          ? sanitizeMessages(params.messages)
          : [];
        const resolved = await this.resolveApiKey(
          params.user_id,
          'chat',
          params.model,
          params.key_id,
        );
        const inspireModel =
          !params.model && resolved.source === 'platform'
            ? 'deepseek-v4-pro'
            : resolved.model;
        await this.streamChatToClient(
          res,
          inspirePrompt,
          cleanMessages,
          inspireModel,
          1024,
          resolved.apiKey,
          resolved.baseUrl,
          {
            userId: params.user_id,
            bookId: params.book_id || undefined,
            usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
          },
          // Pro 是推理模型:关闭思考链,否则思考耗尽 max_tokens 导致输出为空
          { type: 'disabled' },
        );
      } catch (e: any) {
        console.error('[inspire] stream error:', e.message ?? e);
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
    let chapterOutlineBlock = '';
    let chapterProgressBlock = '';
    let goldenThreeBlock = '';
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
              summary: schema.chapters.summary,
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

        // 章纲注入：按章节序号取对应行（快捷创作首批 10 章，后续可续生）——
        // 卷纲颗粒度太粗，写作时靠章纲补上位约束
        try {
          const [bso] = await db
            .select({ extra: schema.book_settings.extra })
            .from(schema.book_settings)
            .where(eq(schema.book_settings.book_id, params.book_id))
            .limit(1);
          const chOutlines = ((bso?.extra ?? {}) as Record<string, any>)
            ?.chapter_outlines as string[] | undefined;
          if (chOutlines?.length && ch.sort_order <= chOutlines.length) {
            const prevLine =
              ch.sort_order > 1 ? chOutlines[ch.sort_order - 2] : undefined;
            const line = chOutlines[ch.sort_order - 1];
            if (line) {
              chapterOutlineBlock = `${prevLine ? `【上一章章纲——本章开篇应回答其钩子】\n${prevLine}\n` : ''}【本章细纲——目标/阻碍/爽点/钩子，写作必须覆盖】
${line}（本章已写 ${ch.content.length} 字）
`;
            }
          }
        } catch {
          /* 章纲查询失败不影响续写 */
        }
        // 黄金三章：平台共识——前300字定去留、第1章300字内四件事、第3章内第一个小爽点
        goldenThreeBlock =
          ch.sort_order === 1
            ? `【开篇三章专项——本章是第 1 章，严格遵守】
- 前 300 字内完成：冲突爆发 + 主角登场 + 目标浮现 + 钩子落地
- 禁止开篇大段世界观说明文（设定靠情节和对话带出）
- 主角的金手指/能力最晚本章上线
- 章末强钩子：让读者必须点开下一章
`
            : ch.sort_order <= 3
              ? `【开篇三章专项——本章处于黄金三章内】
- 本章内必须有具体的小爽点（打压→反转→打脸）或强悬念
- 章末强钩子
`
              : '';
        // 本章进度感知：续写需知道写到哪、还剩多少，避免章中留钩子/章末开新线
        if (ch.content.length >= 1500) {
          chapterProgressBlock = `【本章进度】已写 ${ch.content.length} 字（本章目标 2000-5000 字）——写到自然停点即可落章末钩子收束；未到停点则继续推进，不凑字、不拖延、不开新冲突线。
`;
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

    // 角色完整信息（含自定义字段：金手指/缺陷/弧光等——之前未注入，快捷创作的新字段会丢失）
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
          ...((c.custom_fields as any[] | undefined) ?? []).map(
            (f: any) => `${f.key}：${f.value}`,
          ),
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

    // 全角色名单：写作时防 AI 凭空造新名字（几行字的成本，防人设漂移）
    const charNameList = chars.length
      ? `【全部角色名单——正文不得凭空新增人名，新角色必须先经作者确认】
${chars.map((c) => c.name).join('、')}
`
      : '';

    // 大纲全部节点列表（含 ID 供 update 引用）
    const outlineNodes = allOutlineNodes
      .map(
        (oc) =>
          `- id=${oc.id} | ${oc.title}（${oc.status}）：${oc.summary ?? ''}`,
      )
      .join('\n');

    // 风格说明：4 个预设统一按"语言质感"维度；mimic = 用户笔风分析结果
    const styleGuide = STYLE_GUIDES;
    // 书级风格预设：大纲/角色/世界观上下文也吃风格约束（正文由面板 style 控制）
    let bookStyleNote = '';
    if (params.book_id && !isShort) {
      try {
        const [bsp] = await db
          .select({ preset_style: schema.book_settings.preset_style })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, params.book_id))
          .limit(1);
        bookStyleNote = bsp?.preset_style
          ? (styleGuide[bsp.preset_style] ?? '')
          : '';
      } catch {
        /* 查询失败不阻断 */
      }
    }
    let styleNote = params.style ? (styleGuide[params.style] ?? '') : '';
    if (params.style === 'mimic' && params.book_id) {
      // 笔风分析结果：读取已保存的分析文本（查询失败/为空则不注入）
      try {
        const [bs] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, params.book_id))
          .limit(1);
        styleNote =
          (bs?.extra as Record<string, any>)?.mimic_style_analysis ?? '';
        if (styleNote) {
          // 描述式模仿遵循率低：附一段原文作为风格样本。
          // 优先用分析时保存的原文（粘贴文本路径）；没有则取第一章（全书分析路径）
          const storedSample = ((bs?.extra ?? {}) as Record<string, any>)
            ?.mimic_style_sample as string | undefined | null;
          let sample = (storedSample ?? '').slice(0, 500);
          if (sample.length < 100) {
            try {
              const [ch0] = await db
                .select({ content: schema.chapters.content })
                .from(schema.chapters)
                .where(eq(schema.chapters.book_id, params.book_id))
                .orderBy(schema.chapters.sort_order)
                .limit(1);
              sample = (ch0?.content ?? '').slice(0, 500);
            } catch {
              sample = '';
            }
          }
          if (sample.length >= 100) {
            styleNote += `\n\n【风格样本——模仿以下文笔的用词、句式与节奏】\n${sample}`;
          }
        }
      } catch {
        /* 分析不存在则跳过 */
      }
    }
    const styleBlock = styleNote
      ? `\n【文风要求——严格遵守】\n${styleNote}`
      : '';
    // 大纲/角色/世界观上下文注入书级风格（正文走 styleBlock，面板切换只影响正文）
    const bookStyleBlock = bookStyleNote
      ? `\n【全书风格——设定与情节的表述按此语言质感】\n${bookStyleNote}`
      : '';

    // 世界观按需注入：用本章正文+大纲节点的要素给分区打分，选最相关的注入
    // （替代全量硬截断——硬截断可能丢掉与本章最相关的规则，如力量体系）
    let worldForWrite = '';
    if (worldSections?.length && (chapterContext || outlineContext)) {
      const sectionFactors = AiService.extractFactors(
        `${chapterContext} ${outlineContext}`,
      );
      worldForWrite = AiService.selectWorldSections(
        worldSections as Array<{ name: string; content: string }>,
        sectionFactors,
      );
    }

    // ====== 系统提示词 ======
    // write 上下文的共享设定块：章节+大纲+章纲+进度+角色+世界观+风格
    const writeShared = `${chapterContext}

${outlineContext ? `【故事进程——角色近期经历了什么】\n${outlineContext}\n` : ''}${chapterOutlineBlock}${chapterProgressBlock}${goldenThreeBlock}【本作品相关角色设定——请严格按照以下设定写作，保持角色言行一致】
${charFull || '暂无角色设定'}

${charNameList}【世界观规则——所有情节必须符合以下世界设定】
${worldForWrite || '（暂无世界观设定）'}
${styleBlock}`;

    // 改写与续写任务不同：改写保事实换形式，续写推进剧情
    const writeInstruction = params.rewrite
      ? `【改写指引】
- 严格按用户指令改写选中文本（压缩/扩写/换文风/调情绪等），原文事实（人名/道具/时间/已发生事件）不得改动
- 输出只包含改写后的文本本身，长度与指令匹配（未指定时与原文相近）
- 文风与光标前文保持一致，衔接前后文自然`
      : `【写作指引】
- 续写时自然衔接光标前文的语气和节奏，不要重复光标后文的内容
- 每 300-500 字推进一次剧情（新信息/冲突/反转），禁止原地描写
- 对话每句一行，用对话推进剧情；段末可留钩子
- 文风与光标前文保持一致：前文短句你就短句，前文白描你就白描
- 若角色在故事进程中经历了重大事件，其言行要有对应变化
- 本章目标约 2000-5000 字：一次写不完就写到自然停点，作者会继续
- 当前大纲节点是剧情大方向（通常需要多章完成），本章只推进其中一段，禁止把整个节点情节压缩进一章
- 若注入有【本章细纲】，以细纲为本章执行计划（目标/阻碍/爽点/钩子），大纲节点仅作方向参考
- 主角道德基线：可以狠、自保、报复，但对象必须是真恶人（对方确实作恶或先害主角）；不得伤害无辜之人（仆从/路人）；灰色行为必须有正当理由（被逼到绝境/对方作恶在先）；黑化反派型主角也必须有可理解的动机，不得无缘无故作恶`;

    const writeReplyFormat = `【回复格式——严格遵守】
你的回复分为两部分：
1. 正文内容（纯自然语言：不含任何 JSON 标记，禁止 Markdown 格式——不用 # 标题、不用 **加粗**、不用列表符号，章节标题直接写成"第N章 标题"一行）
2. 最后一行为操作指令 JSON（单独一行）

示例：
久仰尊颜，今日得见，果然名不虚传。
{"action":"insert_content","content":"久仰尊颜，今日得见，果然名不虚传。"}

如果只是闲聊讨论，则只输出自然语言，不需要 JSON。`;

    const prompts: Record<string, string> = {
      write: `你是专业小说写作助手，正在帮助作者完成当前的写作章节。

${writeShared}
${writeInstruction}

${writeReplyFormat}`,

      short: `你是知乎盐选爆款短篇作家。

${chapterContext}

【通用结构】
1. 开篇第一句就是冲突/悬念，不铺垫不写景
2. 段落简短，段间空行，节末留钩子：让读者想问"然后呢？"
3. 反差制造爽感：预期→意外→奖励

【技术规则】纯文本，不用Markdown。环境≤3行。不写大段独白。文风与上文保持一致。

正文直接输出，最后一行操作指令 JSON。闲聊只输出自然语言。`,

      outline: `你是小说大纲规划助手，帮作者把零散的想法变成清晰的故事结构。

【已有角色】
${charBrief}

【世界观——情节必须符合以下世界设定】
${worldText.slice(0, 1500)}
${bookStyleBlock}

【当前大纲节点（情节关键点），修改已有节点时用对应的 id】
${outlineNodes || '暂无节点，需要从零开始'}

【规划指引】
- 若作者要求生成正文/章节内容，提醒其切换到"写作"面板，本面板只产出大纲节点
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
${bookStyleBlock}

【创作指引】
- 若作者要求生成正文/章节内容，提醒其切换到"写作"面板，不要在此输出正文
- 主角必须有金手指/能力、缺陷与弧光（开篇→结局的变化）；配角要有"要什么"（动机）和"怕什么"（软肋）
- 角色要服务于故事：为什么需要这个角色？TA推动什么情节？
- 性格不能凭空而来：用背景故事解释性格成因
- 说话风格要独特：每个角色有标志性的语气、用词习惯
- 角色之间要有化学反应：师徒、宿敌、暗恋、利用……关系让故事丰富
- custom_fields 用于超出固定字段的属性，如"灵根"、"异能力"、"血型"、"武器"等
- 如果用户提及已有角色名，用 update_character；否则用 create_character
- 输出角色描述一定要具体丰富，不能只有一两句笼统的话

【输出格式——严格遵守】
先对每个角色进行自然语言描述（姓名、性格、背景、与其他角色的关系等），让用户了解你的设计思路。然后在最后一行输出 JSON 供系统自动创建。

创建角色（每个角色一个对象，多个角色用 JSON 数组）。年龄、境界成长线等动态信息放进 custom_fields（如 {"key":"年龄","value":"外表20实际500"}）：
[{"action":"create_character","name":"必填","gender":"男/女/?","personality":"","identity":"","backstory":"","motivation":"","catchphrase":"","speech_style":"","appearance":"","is_main":false,"aliases":"别名1,别名2","custom_fields":[{"key":"年龄","value":"外表20实际500"},{"key":"属性名","value":"属性值"}]}]

修改已有角色：
{"action":"update_character","char_id":"上面列表中的角色ID","personality":"新性格","custom_fields":[{"key":"新能力","value":"描述"}]}

注意：最后一行 JSON 不要有任何额外字符（不用反引号包裹、不加缩进、不加注释）。`,

      world: `你是世界观构建专家，帮作者创造自洽、引人入胜的虚构世界。

【已有世界观分区——所有内容必须按以下分区名逐个输出】
${worldSectionNames.map((n) => `- ${n}`).join('\n')}

【当前各分区内容——空分区请填充，有内容的分区可补充或修改】
${worldText}
${bookStyleBlock}

【构建指引】
- 若作者要求生成正文/章节内容，提醒其切换到"写作"面板，不要在此输出正文
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

      settings: `你是作品配置助手。帮作者调整写作风格、自动保存间隔、每日字数目标等设置。根据作者的问题给出建议。

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
      // 写作交接摘要(治"第二天回来 AI 失忆"):章节字数与上次摘要时
      // 差 ≥800 字才更新一次(便宜调用),随续写请求注入
      let handoffBlock = '';
      if (!isShort && ct === 'write' && params.book_id && params.chapter_id) {
        try {
          const [ch] = await db
            .select({
              content: schema.chapters.content,
              sort_order: schema.chapters.sort_order,
            })
            .from(schema.chapters)
            .where(eq(schema.chapters.chapter_id, params.chapter_id))
            .limit(1);
          const curWords = (ch?.content ?? '').length;
          const [bs] = await db
            .select({ extra: schema.book_settings.extra })
            .from(schema.book_settings)
            .where(eq(schema.book_settings.book_id, params.book_id))
            .limit(1);
          const extra = (bs?.extra ?? {}) as Record<string, any>;
          const handoff = extra.writing_handoff as
            { summary?: string; at_words?: number } | undefined;
          if (!handoff?.summary || curWords - (handoff.at_words ?? 0) >= 800) {
            const handoffPrompt =
              '你是写作状态交接员。根据章节尾部内容，输出两部分：\n1. 交接摘要（150 字内）：当前剧情位置（谁在哪、在做什么）、主角最近的状态变化、已埋未回收的伏笔\n2. 伏笔账本（另起一段，每行一条）：格式"伏笔：描述 | 待收/已收"，只列与后续剧情相关的伏笔，没有则输出"伏笔：无"。注意：只有在本章及之前正文中已实际写到的回收才能标"已收"，未实际写到的一律保持"待收"，不得凭剧情预判提前标"已收"';
            const rH = await fetch(`${resolved.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${resolved.apiKey}`,
              },
              body: JSON.stringify({
                model: resolved.model,
                messages: [
                  { role: 'system', content: handoffPrompt },
                  { role: 'user', content: (ch?.content ?? '').slice(-2500) },
                ],
                max_tokens: 500,
                temperature: 0.3,
                thinking: { type: 'disabled' },
              }),
              signal: AbortSignal.timeout(60_000),
            });
            if (rH.ok) {
              const dH = await rH.json();
              const rawHandoff = (
                dH.choices?.[0]?.message?.content ?? ''
              ).trim();
              const handoffParts = rawHandoff.split(/\n(?=伏笔[:：])/);
              // 清洗:模型会复读 prompt 的编号标题("1. 交接摘要"等),剔除
              const summary = handoffParts[0]
                .replace(/^[12][.、]\s*(?:交接摘要|伏笔账本)\s*$/gm, '')
                .trim();
              if (summary) {
                extra.writing_handoff = { summary, at_words: curWords };
                // 伏笔账本:描述|状态,供写前注入与前端面板展示
                const plotLines = (handoffParts[1] ?? '')
                  .split('\n')
                  .map((l: string) => l.trim())
                  .filter(
                    (l: string) =>
                      /^伏笔[:：]/.test(l) && !/伏笔[:：]\s*无/.test(l),
                  )
                  .map((l: string) => l.replace(/^伏笔[:：]\s*/, ''));
                if (plotLines.length) {
                  // 合并而非覆盖：保留用户手动添加的伏笔；AI 抽取的按描述匹配更新状态
                  const prevThreads = (extra.plot_threads as any[]) ?? [];
                  const merged = [...prevThreads];
                  for (const line of plotLines) {
                    const [desc, status] = line
                      .split('|')
                      .map((s: string) => s.trim());
                    const d = desc ?? '';
                    const st = status ?? '待收';
                    const idx = merged.findIndex((t: any) => t.desc === d);
                    if (idx >= 0) merged[idx] = { ...merged[idx], status: st };
                    else merged.push({ desc: d, status: st });
                  }
                  extra.plot_threads = merged.slice(-50);
                  // 代码级回收校验：带关键词的伏笔被标"已收"时，验证关键词出现在
                  // 本章或上一章正文；未命中驳回为"待收"（模型自评不可靠，短篇同款教训）
                  const keyedThreads = (
                    (extra.plot_threads as any[]) ?? []
                  ).filter(
                    (t: any) =>
                      t.status === '已收' &&
                      typeof t.key === 'string' &&
                      t.key.trim(),
                  );
                  if (keyedThreads.length) {
                    const [prevCh] = await db
                      .select({ content: schema.chapters.content })
                      .from(schema.chapters)
                      .where(
                        and(
                          eq(schema.chapters.book_id, params.book_id),
                          sql`${schema.chapters.sort_order} < ${ch?.sort_order ?? 0}`,
                        ),
                      )
                      .orderBy(desc(schema.chapters.sort_order))
                      .limit(1);
                    const haystack = `${ch?.content ?? ''}\n${prevCh?.content ?? ''}`;
                    extra.plot_threads = (
                      extra.plot_threads as any[]
                    ).map((t: any) =>
                      t.status === '已收' &&
                      typeof t.key === 'string' &&
                      t.key.trim() &&
                      !haystack.includes(t.key.trim())
                        ? { ...t, status: '待收' }
                        : t,
                    );
                  }
                }
                await db
                  .update(schema.book_settings)
                  .set({ extra: extra as any })
                  .where(eq(schema.book_settings.book_id, params.book_id));
              }
            }
          }
          const saved = extra.writing_handoff?.summary;
          if (saved) {
            handoffBlock = `\n【上次写作交接——继续写时从这里接上】\n${saved}\n`;
            // 活跃伏笔:状态未收的注入(最近 8 条)
            const activeThreads = ((extra.plot_threads as any[]) ?? []).filter(
              (t: any) => t.status !== '已收',
            );
            if (activeThreads.length) {
              handoffBlock += `【活跃伏笔——写到这里时记得推进】\n${activeThreads
                .slice(0, 8)
                .map((t: any) => `- ${t.desc}（${t.status}）`)
                .join('\n')}\n`;
            }
            // 前情摘要链:最近 3 个已摘要章节的梗概
            try {
              const recentSummaries = await db
                .select({
                  title: schema.chapters.title,
                  summary: schema.chapters.summary,
                  sort_order: schema.chapters.sort_order,
                })
                .from(schema.chapters)
                .where(
                  and(
                    eq(schema.chapters.book_id, params.book_id),
                    isNotNull(schema.chapters.summary),
                  ),
                )
                .orderBy(desc(schema.chapters.sort_order))
                .limit(3);
              if (recentSummaries.length) {
                handoffBlock += `【前情摘要——最近章节梗概】\n${recentSummaries
                  .reverse()
                  .map((c) => `- 第${c.sort_order}章 ${c.title}：${c.summary}`)
                  .join('\n')}\n`;
              }
            } catch {
              /* 摘要链查询失败不影响续写 */
            }
          }
        } catch {
          /* 交接摘要失败不影响续写 */
        }
      }
      // 章节事实清单注入：当前章节(若已提取) + 最近提取的前章——
      // 短篇 factBlock 机制移植，拦截跨章一致漂移(道具归属/称谓/人物状态)
      let factsBlock = '';
      if (!isShort && ct === 'write' && params.book_id) {
        try {
          const [bsf] = await db
            .select({ extra: schema.book_settings.extra })
            .from(schema.book_settings)
            .where(eq(schema.book_settings.book_id, params.book_id))
            .limit(1);
          const chapterFacts = ((bsf?.extra ?? {}) as Record<string, any>)
            ?.chapter_facts as
            Record<string, { at: number; facts: string }> | undefined;
          if (chapterFacts && Object.keys(chapterFacts).length > 0) {
            const own = params.chapter_id
              ? chapterFacts[params.chapter_id]
              : undefined;
            const recent = Object.entries(chapterFacts)
              .filter(([id]) => id !== params.chapter_id)
              .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))[0]?.[1];
            if (own?.facts || recent?.facts) {
              factsBlock = `\n【前文已确立事实与未解悬念——续写必须继承，不得改写】
${own?.facts ? `【本章已确立】\n${own.facts}\n` : ''}${recent?.facts ? `【前章】\n${recent.facts}` : ''}
`;
            }
          }
        } catch {
          /* 事实清单查询失败不影响续写 */
        }
      }
      void this.streamChatToClient(
        res,
        systemPrompt + guideBlock + factsBlock + handoffBlock,
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
        // 思考链会耗尽 max_tokens 导致正文为空：平台模型（DeepSeek/千问均含推理
        // 能力）与用户 DeepSeek/千问 Key 一律关闭思考，其余自定义 Key 尊重原样
        resolved.source === 'platform' || /deepseek|qwen/i.test(resolved.model)
          ? { type: 'disabled' }
          : undefined,
        // 正文类输出跑 AI 味检测（短篇 context 与长篇写作共用）
        ct === 'write' || isShort,
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
    thinking?: { type: string },
    qualityCheck = false,
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

    // 注册作品级中止：软删除作品时取消进行中的生成，停止继续消耗 token
    const bookAbortCtrl = usage?.bookId ? new AbortController() : null;
    if (usage?.bookId && bookAbortCtrl) {
      registerBookAbort(usage.bookId, bookAbortCtrl);
    }
    try {
      const timeoutSignal = AbortSignal.timeout(
        maxTokens > 16000 ? 420000 : 120000,
      );
      const signal = bookAbortCtrl
        ? AbortSignal.any([bookAbortCtrl.signal, timeoutSignal])
        : timeoutSignal;
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
          ...(thinking ? { thinking } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        // 携带上游状态码：前端可区分 401/403（Key 失效）与 429（限流）
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
                // 只累计用量，不再转发：前端不展示思考文本，只显示加载态
                fullReasoning += reasoning;
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
      // 只用正文提取：推理模型的思考文本会引用示例 JSON，误提取会产生假"采纳"按钮
      try {
        const combined = fullContent;
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

      // AI 味代码级检测：剥离 action JSON 后跑确定性检测（不依赖模型自评），
      // 结果随流下发 quality 事件，前端提示用户
      if (qualityCheck) {
        try {
          const bodyText = (fullContent || '')
            .replace(/\n?\{["']action["']:[\s\S]*$/, '')
            .trim();
          if (bodyText.length >= 500) {
            const issues = detectAiFlavors(bodyText);
            if (issues.length > 0) {
              res.write(
                `event: quality\ndata: ${JSON.stringify({
                  count: issues.length,
                  types: [...new Set(issues.map((i) => i.type))],
                })}\n\n`,
              );
            }
          }
        } catch {
          /* 检测失败不影响主流程 */
        }
      }

      res.write('event: done\ndata: {}\n\n');
    } catch {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'AI 服务异常' })}\n\n`,
      );
    } finally {
      // 注销作品级中止注册，防止 Map 泄漏
      if (usage?.bookId && bookAbortCtrl) {
        unregisterBookAbort(usage.bookId, bookAbortCtrl);
      }
    }
    res.end();
  }

  /**
   * 章节摘要链(长篇):内容增长 ≥1500 字时异步生成 100 字摘要,
   * 供后续章节 AI 上下文注入(第 50 章的 AI 知道第 3 章的梗概)。
   * 由章节保存触发,失败静默(不阻断保存)
   */
  async summarizeChapter(userId: string, chapterId: string, content: string) {
    const db = getDb();
    try {
      const resolved = await this.resolveApiKey(
        userId,
        'chat',
        undefined,
        undefined,
      );
      const prompt =
        '你是章节摘要员。把下面的章节内容压缩成 100 字内的摘要：本章发生的核心事件、关键信息揭示、结尾状态。只输出摘要本身。';
      const r = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: content.slice(-3000) },
          ],
          max_tokens: 300,
          temperature: 0.3,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`summary status ${r.status}`);
      const d = await r.json();
      const summary = (d.choices?.[0]?.message?.content ?? '').trim();
      if (summary) {
        await db
          .update(schema.chapters)
          .set({ summary, summary_at_words: content.length })
          .where(eq(schema.chapters.chapter_id, chapterId));
      }
    } catch (e: any) {
      console.error('[summarizeChapter] failed:', e.message);
    }
  }

  /**
   * 章节事实清单(长篇):内容 ≥2000 字且较上次提取增长 ≥1500 字时提取
   * 事实|谁知道 + 人物称谓 + 未解悬念,存 book_settings.extra.chapter_facts,
   * 续写时注入——短篇 factBlock 机制移植,拦截跨章一致漂移(道具归属/称谓/状态)。
   * 由章节保存触发,失败静默(不阻断保存)
   */
  async extractChapterFacts(
    userId: string,
    bookId: string,
    chapterId: string,
    content: string,
  ) {
    const db = getDb();
    try {
      // 增长阈值检查：读取上次提取字数，增量不足则跳过（便宜调用不重复烧钱）
      const [settings0] = await db
        .select({ extra: schema.book_settings.extra })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, bookId))
        .limit(1);
      const prevFacts = ((settings0?.extra ?? {}) as Record<string, any>)
        ?.chapter_facts as
        Record<string, { at_chars: number; facts: string }> | undefined;
      const prevAt = prevFacts?.[chapterId]?.at_chars ?? 0;
      if (content.length - prevAt < 1500) return;

      const resolved = await this.resolveApiKey(
        userId,
        'chat',
        undefined,
        undefined,
      );
      const factPrompt = `你是故事事实提取员。从下面的章节内容提取三段清单:
【已确立事实】每行一条,格式"事实 | 谁知道",只列影响后续续写的事实:人物状态(婚姻/恋爱/生死/关系)、关键物品及归属、公证/合同/转账等关键设定;谁知道=该事实被哪些角色知晓(只有主角知道写"主角",众人皆知写"公开",特定角色知道写角色名);同类型物品的多个实例必须分别记录各自归属,不得合并;事实的表述口径必须原样登记,后续续写只能沿用该口径,不得改写成等价但不同的说法
【人物称谓】每行一条,登记每个出场人物的姓名与所有称谓(如"守墓人=老郑,其子=郑明"),同一人若在前文出现多个叫法必须并列登记,后续续写只能使用已登记的称谓
【未解悬念】每行一条,文中已提出但尚未解答的问题

只输出这三段清单,每条一行,不要评论、不要分析。`;
      const r = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model: resolved.model,
          messages: [
            { role: 'system', content: factPrompt },
            { role: 'user', content: content.slice(-4000) },
          ],
          max_tokens: 1500,
          temperature: 0.3,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`facts status ${r.status}`);
      const d = await r.json();
      const factText = (d.choices?.[0]?.message?.content ?? '').trim();
      if (!factText) throw new Error('facts empty');

      const [settings] = await db
        .select({ extra: schema.book_settings.extra })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, bookId))
        .limit(1);
      const extra = (settings?.extra ?? {}) as Record<string, any>;
      const chapterFacts = (extra.chapter_facts ?? {}) as Record<
        string,
        { at_chars: number; at: number; facts: string }
      >;
      chapterFacts[chapterId] = {
        at_chars: content.length,
        at: Date.now(),
        facts: factText,
      };
      await db
        .update(schema.book_settings)
        .set({ extra: { ...extra, chapter_facts: chapterFacts } })
        .where(eq(schema.book_settings.book_id, bookId));
    } catch (e: any) {
      console.error('[extractChapterFacts] failed:', e.message);
    }
  }

  /**
   * 续生章纲：写到已有章纲末尾后，生成下一批 10 章细纲并追加保存。
   * 输入=卷纲+上一批章纲结尾+最近已写章节摘要，保证批次间钩子衔接、不重写已发生事件。
   * 结构设计类长指令在 Flash 上先塌陷（IFScale），平台智能默认升级 Pro。
   */
  async extendChapterOutlines(
    userId: string,
    bookId: string,
    model?: string,
    keyId?: string,
  ): Promise<{ lines: string[]; startNo: number }> {
    const db = getDb();
    const resolved = await this.resolveApiKey(userId, 'chat', model, keyId);
    const useModel =
      !model && resolved.source === 'platform'
        ? 'deepseek-v4-pro'
        : resolved.model;
    const resolvedUse =
      useModel === resolved.model
        ? resolved
        : await this.resolveApiKey(userId, 'chat', useModel, keyId);

    // 已有章纲
    const [settings] = await db
      .select({ extra: schema.book_settings.extra })
      .from(schema.book_settings)
      .where(eq(schema.book_settings.book_id, bookId))
      .limit(1);
    const existing = ((settings?.extra ?? {}) as Record<string, any>)
      ?.chapter_outlines as string[] | undefined;
    const existingLines = existing ?? [];
    const startNo = existingLines.length + 1;

    // 最近已写章节摘要（承接已写剧情，不重写已发生事件）
    const recentChs = await db
      .select({
        title: schema.chapters.title,
        summary: schema.chapters.summary,
        sort_order: schema.chapters.sort_order,
      })
      .from(schema.chapters)
      .where(
        and(
          eq(schema.chapters.book_id, bookId),
          isNotNull(schema.chapters.summary),
        ),
      )
      .orderBy(desc(schema.chapters.sort_order))
      .limit(3);

    // 承接素材：优先章节摘要；没有摘要（手动建书/篇幅不足）则取最新已写章节正文尾部
    let continuityBlock = '';
    if (recentChs.length) {
      continuityBlock = `【最近已写章节摘要】\n${recentChs.reverse().map((c) => `- 第${c.sort_order}章 ${c.title}：${c.summary}`).join('\n')}\n`;
    } else {
      const [lastCh] = await db
        .select({
          title: schema.chapters.title,
          content: schema.chapters.content,
          sort_order: schema.chapters.sort_order,
        })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, bookId))
        .orderBy(desc(schema.chapters.sort_order))
        .limit(1);
      if (lastCh && (lastCh.content ?? '').trim()) {
        continuityBlock = `【已写章节（第${lastCh.sort_order}章）正文尾部——续写必须承接，不重写已发生事件】\n${(lastCh.content ?? '').slice(-1500)}\n`;
      }
    }

    const [bookRow] = await db
      .select({ title: schema.books.title })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);

    // 卷纲（大纲节点）
    const loadOutlineNodes = async () => {
      const [outline] = await db
        .select()
        .from(schema.outlines)
        .where(eq(schema.outlines.book_id, bookId))
        .limit(1);
      return outline
        ? await db
            .select({
              title: schema.outline_chapters.title,
              summary: schema.outline_chapters.summary,
            })
            .from(schema.outline_chapters)
            .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
            .orderBy(schema.outline_chapters.sort_order)
        : [];
    };
    let nodes = await loadOutlineNodes();

    // 手动建书无卷纲：先用书名+引导摘要+已写正文自动生成卷纲，再展开章纲
    if (nodes.length === 0) {
      const guideSummary = (settings?.extra ?? {}) as Record<string, any>;
      const guideBlock =
        (guideSummary?.guide_summary as string | undefined)?.slice(0, 800) ?? '';
      const outlineGenPrompt = `你是网文大纲规划助手。根据下面的信息为这部小说设计情节大纲（卷纲），至少 8-12 个节点。

【书名】${bookRow?.title ?? '（未命名）'}

${guideBlock ? `【创作方向——严格遵循】\n${guideBlock}\n` : ''}
${continuityBlock ? `【已写正文参考——大纲必须承接，不重写已发生事件】\n${continuityBlock.slice(0, 1500)}` : '【注意】暂无正文：根据书名和题材常识合理发挥。'}

【核心要求】
1. 分卷/分段推进：每段有明确的阶段目标，段末解决并引出下一段
2. 递进节奏：每个节点应有实质进展
3. 每个节点必须内置冲突或爽点（打压→反转→打脸，或悬念揭示）
4. 摘要用"谁+做了什么+得到什么结果"的直白句式，禁止文艺腔

【输出格式——严格遵守】
只输出 JSON 数组，不要任何其他文字。title 精炼（8字内），summary 简短（30字内）：
[{"title":"裂缝心跳","summary":"沈桁在灰塔底层发现空间裂缝，接触神秘气体后指纹异变"}]`;
      const rOutline = await fetch(`${resolvedUse.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolvedUse.apiKey}`,
        },
        body: JSON.stringify({
          model: useModel,
          messages: [
            { role: 'system', content: outlineGenPrompt },
            { role: 'user', content: '请设计这部小说的卷纲。' },
          ],
          max_tokens: 4096,
          temperature: 0.7,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!rOutline.ok) {
        throw new Error(`outline auto-gen status ${rOutline.status}`);
      }
      const dOutline = await rOutline.json();
      const outlineRaw = (dOutline.choices?.[0]?.message?.content ?? '').trim();
      const savedCount = await this.parseAndSaveOutline(bookId, outlineRaw);
      if (!savedCount) {
        throw new Error('卷纲自动生成失败，请稍后重试');
      }
      await this.recordUsage({
        userId,
        bookId,
        model: useModel,
        inChars: outlineGenPrompt.length,
        outChars: outlineRaw.length,
        usageType: resolvedUse.source === 'user' ? 'user_key' : 'platform_key',
      });
      nodes = await loadOutlineNodes();
    }

    const outlineText =
      nodes.map((n) => `- ${n.title}：${n.summary}`).join('\n') || '（无大纲）';

    // 硬性要求按素材条件化：首批无上一批钩子可承接、无卷纲时从正文自然延伸
    const requirements = [
      '一章一小冲突，10 章内至少 2 个小高潮；爽点必须具体（什么被证明/谁被打脸/什么反转），禁止"主角变强"式空话',
      '表述直白网文化，禁止文学化修饰',
      '打脸/报复对象必须是真恶人（对方先作恶），不得牵连无辜之人',
      nodes.length
        ? '卷纲是大方向：新章纲推进的情节必须落在卷纲范围内'
        : '暂无大纲：剧情从已写正文自然延伸，不要凭空引入与正文无关的设定',
      existingLines.length
        ? `承接上一批章纲的结尾钩子：第 ${startNo} 章的开篇必须回答上一批最后一章的钩子`
        : '',
    ]
      .filter(Boolean)
      .map((r, i) => `${i + 1}. ${r}`)
      .join('\n');

    const prompt = `你是网文细纲设计师。为这本书生成下一批 10 章的细纲（第 ${startNo} 到第 ${startNo + 9} 章）。

${bookRow?.title ? `【书名】${bookRow.title}` : ''}

【每章一行，格式】
第N章 | 目标=主角本章要达成什么 | 阻碍=什么在挡路（人或事） | 爽点=本章的爽点/反转/打脸点 | 钩子=章末悬念

【硬性要求】
${requirements}

【卷纲】
${outlineText.slice(0, 2000) || '（无大纲）'}

${continuityBlock}
${existingLines.length ? `【上一批章纲结尾】\n${existingLines.slice(-3).join('\n')}\n` : ''}
只输出 10 行，每行一条章纲，不要编号、不要其他文字。`;

    const r = await fetch(`${resolvedUse.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolvedUse.apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `请生成第 ${startNo} 到第 ${startNo + 9} 章的细纲。` },
        ],
        max_tokens: 2048,
        temperature: 0.7,
        // 推理模型关闭思考链,防止思考耗尽 max_tokens
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`extend outlines status ${r.status}`);
    const d = await r.json();
    const rawText = (d.choices?.[0]?.message?.content ?? '').trim();
    const lines = AiService.parseChapterOutlines(rawText);
    if (!lines.length) throw new Error('章纲续生解析为空');

    // 追加保存（只接在已有批次后面，覆盖重复续生）
    await db
      .update(schema.book_settings)
      .set({ extra: { ...((settings?.extra ?? {}) as Record<string, any>), chapter_outlines: [...existingLines, ...lines] } })
      .where(eq(schema.book_settings.book_id, bookId));
    await this.recordUsage({
      userId,
      bookId,
      model: useModel,
      inChars: prompt.length,
      outChars: rawText.length,
      usageType: resolvedUse.source === 'user' ? 'user_key' : 'platform_key',
    });
    return { lines, startNo };
  }

  /**
   * 整章生成：按章纲（目标/阻碍/爽点/钩子）写完整一章。
   * 三级降级：章纲 → 绑定大纲节点 → 模型自定"本章目标"行。
   * 单轮为主（16k 输出），字数 <2000 自动补写一轮；章末钩子关键词校验 + AI 味检测。
   * 已有正文不覆盖：生成内容追加到章末。
   */
  async generateChapter(
    res: Response,
    params: {
      user_id: string;
      book_id: string;
      chapter_id: string;
      model?: string;
      key_id?: string;
      style?: string;
    },
  ) {
    const db = getDb();
    const resolved = await this.resolveApiKey(
      params.user_id,
      'chat',
      params.model,
      params.key_id,
    );
    const model = resolved.model;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (event: string, data: Record<string, any>) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const abortCtrl = new AbortController();
    const onClientClose = () => abortCtrl.abort();
    res.on('close', onClientClose);
    registerBookAbort(params.book_id, abortCtrl);
    const genSignal = (timeoutMs: number) =>
      AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(timeoutMs)]);

    try {
      send('step', { step: 'prepare', status: 'generating', label: '组装写作上下文' });
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
        )
        .limit(1);
      if (!ch) throw new Error('章节不存在');

      // 书设置（章纲 + 风格预设）
      const [settings] = await db
        .select({
          preset_style: schema.book_settings.preset_style,
          extra: schema.book_settings.extra,
        })
        .from(schema.book_settings)
        .where(eq(schema.book_settings.book_id, params.book_id))
        .limit(1);
      const extra = (settings?.extra ?? {}) as Record<string, any>;

      // 章纲：当前行 + 上一行（开篇应回答其钩子）
      const chOutlines = extra.chapter_outlines as string[] | undefined;
      let chapterPlanBlock = '';
      let planHook = '';
      if (chOutlines?.length && ch.sort_order <= chOutlines.length) {
        const line = chOutlines[ch.sort_order - 1];
        const prevLine =
          ch.sort_order > 1 ? chOutlines[ch.sort_order - 2] : undefined;
        if (line) {
          chapterPlanBlock = `${prevLine ? `【上一章章纲——本章开篇应回答其钩子】\n${prevLine}\n` : ''}【本章细纲——目标/阻碍/爽点/钩子，写作必须覆盖】\n${line}\n`;
          const hookMatch = line.match(/钩子\s*=\s*([^|]*)/);
          planHook = hookMatch ? hookMatch[1].trim() : '';
        }
      }

      // 大纲节点：已完成前置 ×2 + 当前 + 下一
      let nodeBlock = '';
      if (ch.bound_outline_node_id) {
        const [outline] = await db
          .select({ outline_id: schema.outlines.outline_id })
          .from(schema.outlines)
          .where(eq(schema.outlines.book_id, params.book_id))
          .limit(1);
        if (outline) {
          const nodes = await db
            .select()
            .from(schema.outline_chapters)
            .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
            .orderBy(schema.outline_chapters.sort_order);
          const idx = nodes.findIndex((n) => n.id === ch.bound_outline_node_id);
          if (idx >= 0) {
            const prevNodes = nodes
              .slice(Math.max(0, idx - 2), idx)
              .filter((n) => n.status === 'completed');
            const lines: string[] = [];
            if (prevNodes.length) {
              lines.push('【已完成的前置情节——角色当前状态由此形成】');
              prevNodes.forEach((n) => lines.push(`- ${n.title}：${n.summary}`));
            }
            lines.push(`【当前节点——本章正在写的情节】${nodes[idx].title}：${nodes[idx].summary}`);
            if (nodes[idx + 1]) {
              lines.push(`【下一节点——剧情走向参考】${nodes[idx + 1].title}：${nodes[idx + 1].summary}`);
            }
            nodeBlock = lines.join('\n');
          }
        }
      }
      const needsSelfPlan = !chapterPlanBlock && !nodeBlock;

      // 角色：主要角色 + 正文出现的角色
      const chars = await db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.book_id, params.book_id));
      const chapterText = (ch.content ?? '').toLowerCase();
      const mainChars = chars.filter((c) => c.is_main);
      const appearedChars = chars.filter((c) => {
        if (c.is_main) return false;
        const names = [
          c.name,
          ...(c.aliases ? c.aliases.split(/[,，]/).map((s) => s.trim()) : []),
        ];
        return names.some((n) => chapterText.includes(n.toLowerCase()));
      });
      const contextChars =
        [...mainChars, ...appearedChars].length > 0
          ? [...mainChars, ...appearedChars]
          : chars;
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
            ...((c.custom_fields as any[] | undefined) ?? []).map(
              (f: any) => `${f.key}：${f.value}`,
            ),
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n');
      const charNameList = chars.length
        ? `【全部角色名单——正文不得凭空新增人名，新角色必须先经作者确认】\n${chars.map((c) => c.name).join('、')}\n`
        : '';

      // 世界观按需注入
      const [world] = await db
        .select()
        .from(schema.world_settings)
        .where(eq(schema.world_settings.book_id, params.book_id))
        .limit(1);
      const worldSections = world?.sections as any[] | undefined;
      let worldBlock = '';
      if (worldSections?.length) {
        const factors = AiService.extractFactors(
          `${ch.title} ${chapterPlanBlock} ${nodeBlock} ${chapterText.slice(-1000)}`,
        );
        worldBlock = AiService.selectWorldSections(
          worldSections as Array<{ name: string; content: string }>,
          factors,
        );
      }

      // 风格（面板传入优先，回退书预设）
      const styleNote = STYLE_GUIDES[
        params.style || settings?.preset_style || 'default'
      ] ?? '';
      const styleBlock = styleNote ? `【文风要求——严格遵守】\n${styleNote}\n` : '';

      // 记忆：交接摘要 + 活跃伏笔 + 前章事实
      let memoryBlock = '';
      {
        const handoff = extra.writing_handoff as
          | { summary?: string }
          | undefined;
        if (handoff?.summary) {
          memoryBlock += `【上次写作交接——继续写时从这里接上】\n${handoff.summary}\n`;
        }
        const activeThreads = ((extra.plot_threads as any[]) ?? []).filter(
          (t: any) => t.status !== '已收',
        );
        if (activeThreads.length) {
          memoryBlock += `【活跃伏笔——写到这里时记得推进】\n${activeThreads
            .slice(0, 8)
            .map((t: any) => `- ${t.desc}（${t.status}）`)
            .join('\n')}\n`;
        }
        const chapterFacts = extra.chapter_facts as
          | Record<string, { facts: string; at: number }>
          | undefined;
        if (chapterFacts && Object.keys(chapterFacts).length > 0) {
          const own = chapterFacts[params.chapter_id];
          const recent = Object.entries(chapterFacts)
            .filter(([id]) => id !== params.chapter_id)
            .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))[0]?.[1];
          if (own?.facts || recent?.facts) {
            memoryBlock += `\n【前文已确立事实与未解悬念——续写必须继承，不得改写】\n${own?.facts ? `【本章已确立】\n${own.facts}\n` : ''}${recent?.facts ? `【前章】\n${recent.facts}` : ''}\n`;
          }
        }
      }

      // 黄金三章
      const goldenBlock =
        ch.sort_order === 1
          ? `【开篇三章专项——本章是第 1 章，严格遵守】\n- 前 300 字内完成：冲突爆发 + 主角登场 + 目标浮现 + 钩子落地\n- 禁止开篇大段世界观说明文（设定靠情节和对话带出）\n- 主角的金手指/能力最晚本章上线\n- 章末强钩子：让读者必须点开下一章\n`
          : ch.sort_order <= 3
            ? `【开篇三章专项——本章处于黄金三章内】\n- 本章内必须有具体的小爽点（打压→反转→打脸）或强悬念\n- 章末强钩子\n`
            : '';

      // 已有正文：追加模式
      const existingContent = (ch.content ?? '').trim();
      const existingTail = existingContent.slice(-1500);

      const taskBlock = needsSelfPlan
        ? `【本章任务】\n本章没有细纲约束：第一行先输出"本章目标=… | 冲突=… | 章末钩子=…"（自定本章写作目标），然后空一行写正文。目标约 2000-5000 字，写到自然停点；章末必须以悬念或未完成动作收尾（钩子）。`
        : `【本章任务】\n按上面的细纲/节点写本章：目标、阻碍、爽点、钩子逐项落实。目标约 2000-5000 字，写到自然停点；章末必须落实章末钩子——以悬念或未完成动作收尾。`;

      const systemPrompt = `你是专业小说写作助手，正在为作者写完整的一章（第${ch.sort_order}章《${ch.title}》）。

${chapterPlanBlock}${nodeBlock ? `【故事进程——角色近期经历了什么】\n${nodeBlock}\n` : ''}${goldenBlock}【本作品相关角色设定——请严格按照以下设定写作，保持角色言行一致】
${charFull || '暂无角色设定'}

${charNameList}【世界观规则——所有情节必须符合以下世界设定】
${worldBlock || '（暂无世界观设定）'}
${styleBlock}${memoryBlock}
【写作指引】
- 每 300-500 字推进一次剧情（新信息/冲突/反转），禁止原地描写
- 对话每句一行，用对话推进剧情
- 文风与设定要求一致；短句白描优先
- 主角道德基线：可以狠、自保、报复，但对象必须是真恶人（对方先作恶）；不得伤害无辜之人（仆从/路人）；灰色行为必须有正当理由

${taskBlock}

【输出格式】
- 纯文本正文，禁止 Markdown（不用 # 标题/**加粗**）与 JSON
- 不写章节标题行（标题由系统管理）
- 不要输出任何解释或批注`;

      send('step', { step: 'write', status: 'generating', label: '生成正文（第一轮）' });
      const userPrompt = `请写第${ch.sort_order}章《${ch.title}》${existingContent ? '。本章已有内容，从断点继续写，不重复已写内容：\n【已有内容结尾】\n' + existingTail + '\n' : '。从本章开头开始写。'}`;
      const r1 = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 16384,
          temperature: 0.8,
          // 思考链会耗尽 max_tokens 导致正文为空（同 chat 策略）
          ...(resolved.source === 'platform' || /deepseek|qwen/i.test(model)
            ? { thinking: { type: 'disabled' } }
            : {}),
        }),
        signal: genSignal(600_000),
      });
      if (!r1.ok) throw new Error(`generate status ${r1.status}`);
      const d1 = await r1.json();
      let text = (d1.choices?.[0]?.message?.content ?? '').trim();
      if (!text) throw new Error('生成正文为空，请重试');

      // 剥自定目标行 / 尾部 JSON / markdown 标题
      if (needsSelfPlan && /^本章目标\s*=/.test(text.split('\n')[0] ?? '')) {
        text = text.split('\n').slice(1).join('\n').trim();
      }
      text = text
        .replace(/\n?\{["']action["']:[\s\S]*$/, '')
        .replace(/^#{1,6}\s+/gm, '')
        .trim();

      // 字数不足补写一轮
      if (text.length < 2000) {
        send('step', { step: 'write', status: 'generating', label: `字数不足（${text.length}），补写一轮` });
        const r2 = await fetch(`${resolved.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolved.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: `已写部分（结尾）：\n${text.slice(-1500)}\n\n继续写，直到本章情节到自然停点（累计至少 2000 字），章末以悬念/未完成动作收尾。不重复已写内容。`,
              },
            ],
            max_tokens: 16384,
            temperature: 0.8,
            ...(resolved.source === 'platform' || /deepseek|qwen/i.test(model)
              ? { thinking: { type: 'disabled' } }
              : {}),
          }),
          signal: genSignal(600_000),
        });
        if (r2.ok) {
          const d2 = await r2.json();
          const part2 = ((d2.choices?.[0]?.message?.content ?? '')
            .trim()
            .replace(/^#{1,6}\s+/gm, ''));
          if (part2) {
            // 接缝去重：第二段开头与第一段结尾重叠部分裁掉
            let head = part2;
            const maxLen = Math.min(text.length, part2.length, 200);
            for (let len = maxLen; len >= 10; len--) {
              if (text.slice(-len) === part2.slice(0, len)) {
                head = part2.slice(len).trimStart();
                break;
              }
            }
            text = `${text.trimEnd()}\n\n${head}`;
          }
        }
      }

      // 章末钩子校验：章纲钩子字段的关键词应出现在结尾 500 字
      const warnings: string[] = [];
      if (planHook) {
        const keys = (planHook.match(/[一-鿿]{4,}/g) ?? []).slice(0, 2);
        if (
          keys.length &&
          !keys.some((k: string) => text.slice(-500).includes(k))
        ) {
          warnings.push(
            `章末钩子可能未落实（章纲钩子：${planHook.slice(0, 20)}），可手动补一句悬念`,
          );
        }
      }

      // AI 味检测（随 done 下发）
      const issues = detectAiFlavors(text);

      // 保存：空章替换、非空追加
      send('step', { step: 'save', status: 'generating', label: '保存到章节' });
      const newContent = existingContent
        ? `${existingContent}\n\n${text}`
        : text;
      await db
        .update(schema.chapters)
        .set({
          content: newContent,
          word_count: newContent.length,
          updated_at: sql`NOW()`,
        })
        .where(eq(schema.chapters.chapter_id, params.chapter_id));
      // 作品总字数重算 + 绑定节点 planned → writing
      const [sumRow] = await db
        .select({
          total: sql<number>`COALESCE(SUM(${schema.chapters.word_count}), 0)`,
        })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, params.book_id));
      await db
        .update(schema.books)
        .set({ word_count: sumRow?.total ?? 0, status: 'writing', updated_at: new Date() })
        .where(eq(schema.books.book_id, params.book_id));
      if (ch.bound_outline_node_id) {
        await db
          .update(schema.outline_chapters)
          .set({ status: 'writing', updated_at: sql`NOW()` })
          .where(
            and(
              eq(schema.outline_chapters.id, ch.bound_outline_node_id),
              eq(schema.outline_chapters.status, 'planned'),
            ),
          );
      }
      await this.recordUsage({
        userId: params.user_id,
        bookId: params.book_id,
        model,
        inChars: systemPrompt.length + userPrompt.length,
        outChars: text.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });
      send('done', {
        chapter_id: params.chapter_id,
        length: newContent.length,
        warnings,
        quality: issues.length
          ? { count: issues.length, types: [...new Set(issues.map((i) => i.type))] }
          : null,
      });
    } catch (e: any) {
      send('error', { message: e?.message ?? '生成失败' });
    } finally {
      unregisterBookAbort(params.book_id, abortCtrl);
      res.off('close', onClientClose);
      res.end();
    }
  }

  // AI 模仿笔风：分析已完成章节，提取写作风格特征
  async mimicStyle(
    bookId?: string,
    model?: string,
    customText?: string,
    userId?: string,
    keyId?: string,
  ) {
    const resolved = await this.resolveApiKey(userId, 'chat', model, keyId);
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
      .set({ active: false, updated_at: new Date() })
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
      .set({ active: false, updated_at: new Date() })
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

    const resolved = await this.resolveApiKey(
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
    const resolved = await this.resolveApiKey(userId, 'chat');
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
  async generateSynopsis(
    bookId: string,
    userId?: string,
    model?: string,
    keyId?: string,
  ) {
    const db = getDb();
    const [book] = await db
      .select({ title: schema.books.title, user_id: schema.books.user_id })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);
    if (!book) return { synopsis: '' };

    const resolved = await this.resolveApiKey(userId, 'chat', model, keyId);
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
    const hasRebirth = /重生|回到.{0,6}(前|过去)|穿越|穿书/.test(p);

    if (!hasRevenge && !hasSweet && !hasRebirth) return ''; // 中性题材不加条件规则

    const rules: string[] = [];
    if (hasRebirth) {
      rules.push(
        '重生时间线铁律：前世的物件、证据、文件不随重生带回当前世界，只有主角的记忆回来；当前时间线里的任何证据必须是当前时间线真实发生的事；道具出现时必须交代来源一句（如"轮椅"必须说明她为何坐轮椅）',
      );
    }
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
    chapters: Array<{
      title: string;
      content: string;
      summary?: string | null;
    }>,
  ): string {
    if (chapters.length === 0) return '';
    return (
      '【前情提要——之前章节的梗概，续写时保持连贯】\n' +
      chapters
        .map(
          (c) =>
            // 优先用章节摘要（剧情梗概）；摘要未生成时回退章节开头
            `《${c.title}》：${(c.summary || c.content || '').slice(0, 150).replace(/\n/g, ' ')}`,
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
    // 干净降级:只返回 1 条(脑洞切片),前端 titles.length>1 才展示选择区,
    // 不再用网文梗模板拼接("之后我逆天改命"式拼接名是负分)
    const base = premise.slice(0, 20).trim() || '短篇故事';
    return [base];
  }

  /**
   * 双字滑窗提取文本要素（确定性，零调用）：模型要素提取实测有幻觉
   * （如从"母亲重生回女儿成人礼当天"提取出"恶毒女配"），不可依赖。
   * 用 Unicode 码点过滤只保留汉字，避免正则字符类含非 ASCII 字面量
   */
  static extractFactors(s: string): string[] {
    const clean = s
      .split('')
      .filter((c) => {
        const code = c.charCodeAt(0);
        return code >= 0x4e00 && code <= 0x9fff;
      })
      .join('');
    const set = new Set<string>();
    for (let i = 0; i + 2 <= clean.length; i++) {
      set.add(clean.slice(i, i + 2));
    }
    return [...set];
  }

  /**
   * 世界观分区按需注入：用章节要素给分区打分，按命中数排序取最相关的分区，
   * 总量 ≤ maxChars。替代全量硬截断——硬截断可能丢掉与本章最相关的规则
   * （如力量体系分区排在后面就被截掉）。无要素时回退全量拼接截断（旧行为）。
   */
  static selectWorldSections(
    sections: Array<{ name: string; content: string }>,
    factors: string[],
    maxChars = 2000,
  ): string {
    if (!sections?.length) return '';
    if (!factors?.length) {
      return sections
        .map((s) => `【${s.name}】\n${s.content}`)
        .join('\n\n')
        .slice(0, maxChars);
    }
    const scored = sections
      .map((s) => ({
        s,
        hits: factors.filter((f) => f.length >= 2 && s.content.includes(f))
          .length,
      }))
      .sort((a, b) => b.hits - a.hits);
    const picked: typeof scored = [];
    let used = 0;
    for (const item of scored) {
      if (used + item.s.content.length > maxChars && picked.length > 0) break;
      picked.push(item);
      used += item.s.content.length;
    }
    return picked.map((x) => `【${x.s.name}】\n${x.s.content}`).join('\n\n');
  }

  /** 解析章纲：每行"第N章 | 目标=... | 阻碍=... | 爽点=... | 钩子=..."，最多 10 行 */
  static parseChapterOutlines(text: string): string[] {
    if (!text) return [];
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^第[一二三四五六七八九十\d]+章\s*[|｜]/.test(l))
      .slice(0, 10);
  }

  /** 解析主角 JSON：单个对象 / 代码块包裹 / 数组取第一个；无 name 返回 null */
  static parseProtagonist(aiText: string): any {
    const attempts: string[] = [];
    const codeBlock = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) attempts.push(codeBlock[1].trim());
    const objMatch = aiText.match(/\{[\s\S]*"name"[\s\S]*\}/);
    if (objMatch) attempts.push(objMatch[0]);
    const lastOpen = aiText.lastIndexOf('{');
    const lastClose = aiText.lastIndexOf('}');
    if (lastOpen >= 0 && lastClose > lastOpen) {
      attempts.push(aiText.slice(lastOpen, lastClose + 1));
    }
    for (const t of attempts) {
      try {
        const parsed = JSON.parse(t);
        const obj = Array.isArray(parsed) ? parsed[0] : parsed;
        if (obj && obj.name) return obj;
      } catch {
        /* 尝试下一个提取 */
      }
    }
    return null;
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
      key_id?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
  ) {
    const db = getDb();
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(
      params.user_id,
      'chat',
      model,
      params.key_id,
    );
    const apiKey = resolved.apiKey;
    const baseUrl = resolved.baseUrl;
    // 梗概策划是创作质量瓶颈：仅当用户未手动选择模型（智能默认）时，
    // 平台场景自动升级 Pro；用户显式选择的任何模型（含自定义 Key）都完全尊重。
    // 机制（IFScale 2025 指令遵循分型）：Flash 级模型随指令量呈"指数型"衰减，
    // Pro 级呈"阈值型"——未过阈值前几乎不衰减；结构设计类长指令（骨架/节拍表）
    // 在 Flash 上先于正文塌陷，故策划环节固定升级 Pro，正文仍按用户所选执行
    const outlineModel =
      !params.model && resolved.source === 'platform'
        ? 'deepseek-v4-pro'
        : resolved.model;
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

      // Step 2: 生成 3 个不同方向的故事梗概（供用户选择后再写正文）
      send('step', {
        step: 'story',
        status: 'generating',
        label: '正在构思 3 个方向的故事梗概...',
      });
      const guideBlock = params.guide_summary
        ? `\n【创作方向——请严格遵循以下设定】\n${params.guide_summary}\n${params.guide_full_log ? `\n【引导讨论记录——参考细节】\n${params.guide_full_log}\n` : ''}`
        : '';
      const outlinePrompt = `${guideBlock}你是知乎盐选短篇的故事策划。根据脑洞，设计 3 个故事梗概。

【方向选择】先分析脑洞的核心冲突与情绪属性，**推导出 3 个基调互不重叠的方向**（基调名称自定，如"悬疑追凶""温情守护""荒诞喜剧"，在骨架行的基调字段里用括号注明契合理由，如"基调=悬疑追凶（契合脑洞的票根之谜）"）；若脑洞元素不足以推导出 3 个，再从参考池补足。参考池（不强制、可按脑洞增删）：
- 爽文逆袭（解气、打脸）
- 悬疑惊悚（恐惧、追查真相）
- 治愈温情（温暖、和解、泪目）
- 沙雕喜剧（荒诞、反差笑点）
- 虐心刀糖（先虐后治愈）
- 热血成长（燃、逆流而上）

【输出格式】每个方向输出两行：
第一行"骨架：基调=X；起因=故事起点发生了什么（一句，时间关系清楚，关系状态转变须写中间环节如分手→复合→结婚，且必须直接使用脑洞的核心要素：重生脑洞必须写重生、物证脑洞必须用该物证、人物脑洞必须保留该人物关系，不得替换为其他题材；穿书脑洞必须写明原书里该角色的结局——主角靠先知剧本做出的改变，没有先知优势的穿书只是普通穿越，不合格）；行动=主角由此做的第一件事（动机必须来自起因）；连锁=这件事引发的结果与反转（至多1个，须写明核心谜底的答案与动机：关键悬念由谁造成、为什么，如"信是谁写的、为什么承认"）；结局=故事的收束方式（一句：谁做了什么、人物关系/命运如何落定、关键道具最终归属）；物证=核心物证的来龙去脉（在谁手里、为什么在他手里，一句；无物证写无）"
第二行"梗概：……"（80-250 字，按骨架扩写，可新增一个支撑性细节；最后一句必须是钩子——悬念/反差/未完成动作，不把结局说穿，让读者产生"然后呢"）

【硬性要求】
1. 同一事实只能有一个版本，前后不得矛盾
2. 人物关系不超过 3 组，核心信物不超过 1 个
3. 留住人的方式只用三种：谎言、示弱、情感恳求
4. 不写正文片段、对话或开篇段落
5. 因果自洽：关键因果（核心动机、失忆/误会、核心物证的来龙去脉、关系状态变化、施恩/受恩关系）不得跳变或倒置——每个状态转变必须有一句中间环节（如分手→复合→结婚、票根→从谁手里→为什么在他外套里）；施恩方向不得写反（为对方挡刀=对方欠你，不得写成"欠你的那一刀我还过了"）；核心动机另须闭环三环：手段、该手段的必要条件（为什么非要这样/这个节点/这个人）、必要条件是否成立；任一断裂就换一个因果
6. 女主道德基线：默认女主偏正面——可以狠、可以自保、可以报复，但对象必须是真恶人（对方确实作恶或先害女主）；禁止伪造证据诬陷无辜、下毒滥杀、牵连无害之人（仆从/旁人）；脑洞本身是灰色行为（举报/报复/设局）时，必须给女主正当理由（对方作恶在先/女主被逼到绝境），不得把女主写成栽赃者或凶手。例外：若用户脑洞明确要求黑化/恶毒/全员恶人/复仇到底等设定，按用户要求写，但女主的行为仍必须有一个可理解的动机（受过的伤害/背叛/不公），不得无缘无故作恶

【示例】（只示范结构与因果方式，不得复制示例的情节、人物或道具）
骨架：基调=治愈温情；起因=女儿前世成人礼当天出门遇车祸离世，母亲三年后心衰去世；行动=重生回那天清晨，她谎称心口疼，让女儿留在家照顾她；连锁=女儿翻病历发现母亲旧疾已恶化到必须手术，取出了打工五年的积蓄，带母亲去医院；结局=女儿陪母亲完成手术，母女在病房里补过了错过的成人礼，母亲终于说出迟了十年的"生日快乐"；物证=无
梗概：前世女儿成人礼当天出门遭遇车祸离世，母亲守墓三年后心衰去世。重生回到那天清晨，她谎称心口疼，让女儿留在家里照顾她。女儿请了假、煮了粥、翻出母亲的病历，才发现母亲心脏的旧疾已经恶化到了必须手术的地步。这一次，女儿把存了五年的打工钱全部取了出来，对母亲说：妈，今天我不出门了，我们去医院。

每个方向之间用单独一行的 "---" 分隔，共 3 组。不要编号、不要标题、不要任何其他解释。`;

      // 脑洞要素=代码双字滑窗(确定性,零调用):模型要素提取实测有幻觉
      // (如从"母亲重生回女儿成人礼当天"提取出"恶毒女配"),不可依赖。
      const factors: string[] = AiService.extractFactors(premise);
      const r1 = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: outlineModel,
          messages: [
            { role: 'system', content: outlinePrompt },
            {
              role: 'user',
              content: `脑洞/想法：${premise}\n\n请设计 3 个不同方向的故事梗概。`,
            },
          ],
          max_tokens: 2400,
          temperature: 0.7,
          // deepseek-v4-pro 是推理模型：关闭思考链，否则思考会耗尽 max_tokens 导致正文为空
          thinking: { type: 'disabled' },
        }),
        signal: genSignal(60_000),
      });
      if (!r1.ok) {
        send('error', { message: `AI 请求失败 (${r1.status})` });
        res.end();
        return;
      }
      const data1 = await r1.json();
      let rawText = (data1.choices?.[0]?.message?.content ?? '').trim();

      // 解析 3 个梗概：按 "---" 分隔，每个方向剥离"骨架："行（骨架另行提取入库）；
      // 少于 3 个时按换行双分隔降级；仍为空则整体作为单候选
      const stripSkeleton = (block: string): string => {
        const lines = block
          .split('\n')
          .map((l: string) => l.trim())
          .filter(
            (l: string) =>
              l &&
              !/^骨架[：:=]/.test(l) &&
              !/^(?:时间轴|物证|逻辑|脑洞|要素)[：:]/.test(l),
          );
        const merged = lines.join('\n').trim();
        return merged || block.trim();
      };
      const extractSkeleton = (block: string): string => {
        const line = block
          .split('\n')
          .map((l: string) => l.trim())
          .find((l: string) => /^骨架[：:=]/.test(l));
        return line ?? '';
      };
      const parseOutlines = (text: string): string[] => {
        let list = text
          .split(/\n?---\n?/)
          .map(stripSkeleton)
          .filter(Boolean)
          .slice(0, 3);
        if (list.length < 3) {
          const byBlank = text
            .split(/\n{2,}/)
            .map(stripSkeleton)
            .filter((s: string) => s.length >= 30)
            .slice(0, 3);
          if (byBlank.length > list.length) list = byBlank;
        }
        if (list.length === 0 && text.trim()) list = [text.trim()];
        return list;
      };
      let previews = parseOutlines(rawText);
      // 上游偶发空响应：重试一次
      if (previews.length === 0) {
        const rRetry = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: outlineModel,
            messages: [
              { role: 'system', content: outlinePrompt },
              {
                role: 'user',
                content: `脑洞/想法：${premise}\n\n请设计 3 个不同方向的故事梗概。`,
              },
            ],
            max_tokens: 2400,
            temperature: 0.7,
            thinking: { type: 'disabled' },
          }),
          signal: genSignal(60_000),
        });
        if (rRetry.ok) {
          const retryData = await rRetry.json();
          rawText = (retryData.choices?.[0]?.message?.content ?? '').trim();
          previews = parseOutlines(rawText);
        }
      }
      if (previews.length === 0) {
        throw new Error(
          `梗概生成失败：AI 返回为空（原始响应：${rawText.slice(0, 120) || '空'}）`,
        );
      }

      // 脑洞要素代码级过滤(确定性):千问下模型自检实测三轮放水(方向悖论/
      // 偏离脑洞全漏检),已移除梗概自检调用——要素命中数硬过滤替代,
      // 每个方向必须命中 ≥2 个脑洞核心要素,否则丢弃;用户 3 选 1 是第二道人工审查
      // factors 来自独立的要素提取调用(生成前),不是模型随稿附带的要素行
      const skeletonsAll = rawText
        .split(/\n?---\n?/)
        .map(extractSkeleton)
        .filter(Boolean)
        .slice(0, 3);
      const applyFactorFilter = (): void => {
        if (!factors.length || previews.length <= 1) return;
        const hitsArr = previews.map(
          (p) =>
            factors.filter((f: string) => f.length >= 2 && p.includes(f))
              .length,
        );
        const maxHits = Math.max(...hitsArr);
        let keptIdx = previews
          .map((p, i) => ({ p, i }))
          .filter(
            ({ p }) =>
              factors.filter((f: string) => f.length >= 2 && p.includes(f))
                .length >= 2,
          )
          .map(({ i }) => i);
        if (keptIdx.length === 0 && maxHits >= 1) {
          // 全不达标:保留命中数最高的方向,丢弃零命中的
          keptIdx = hitsArr
            .map((h, i) => ({ h, i }))
            .filter((x) => x.h === maxHits)
            .map((x) => x.i);
        }
        if (keptIdx.length > 0 && keptIdx.length < previews.length) {
          console.warn(
            `[quickCreateShort] factor filter dropped ${
              previews.length - keptIdx.length
            } direction(s), factors=${factors.join('|')}, hits=${hitsArr.join('/')}`,
          );
          previews = keptIdx.map((i) => previews[i]);
          skeletonsAll.length = 0;
          const allSk = rawText
            .split(/\n?---\n?/)
            .map(extractSkeleton)
            .filter(Boolean);
          keptIdx.forEach((i) => {
            if (allSk[i]) skeletonsAll.push(allSk[i]);
          });
        } else {
          console.warn(
            `[quickCreateShort] factor filter no-op: factors=${factors.join('|')}, hits=${hitsArr.join('/')}, kept=${keptIdx.length}`,
          );
        }
      };
      applyFactorFilter();
      // 过滤后不足 2 个方向,或所有方向零命中(整批跑题):
      // 提高温度重生成一轮
      const allHitsAfterFilter = previews.map(
        (p) => factors.filter((f: string) => p.includes(f)).length,
      );
      if (
        (previews.length < 2 || Math.max(...allHitsAfterFilter, 0) === 0) &&
        factors.length
      ) {
        console.warn(
          `[quickCreateShort] only ${previews.length} direction(s) left (hits=${allHitsAfterFilter.join('/')}), regenerating with higher temperature`,
        );
        try {
          const rRegen = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: outlineModel,
              messages: [
                { role: 'system', content: outlinePrompt },
                {
                  role: 'user',
                  content: `脑洞/想法：${premise}\n\n请设计 3 个不同方向的故事梗概。`,
                },
              ],
              max_tokens: 2400,
              temperature: 0.95,
              thinking: { type: 'disabled' },
            }),
            signal: genSignal(60_000),
          });
          if (rRegen.ok) {
            const regenData = await rRegen.json();
            rawText = (regenData.choices?.[0]?.message?.content ?? '').trim();
            previews = parseOutlines(rawText);
            skeletonsAll.length = 0;
            rawText
              .split(/\n?---\n?/)
              .map(extractSkeleton)
              .filter(Boolean)
              .slice(0, 3)
              .forEach((s: string) => skeletonsAll.push(s));
            applyFactorFilter();
          }
        } catch (e: any) {
          console.error('[quickCreateShort] outline regen failed:', e.message);
        }
      }

      // 梗概候选存 book_settings.extra（outline_preview 由用户确认选中后写入）
      {
        const [s] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId))
          .limit(1);
        const extra = (s?.extra ?? {}) as Record<string, any>;
        extra.outline_previews = previews;
        // 骨架与梗概同序存储,供正文阶段按用户选中的方向注入(跨环节传递)
        extra.outline_skeletons = skeletonsAll;
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
        label: `已生成 ${previews.length} 个方向的故事梗概`,
        previews,
      });
      await this.recordUsage({
        userId: params.user_id,
        bookId,
        model,
        inChars: outlinePrompt.length + premise.length,
        outChars: rawText.length,
        usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
      });
      send('done', {
        book_id: bookId,
        previews,
        // 基调列表(与 previews 同序,从骨架行解析),供前端 3 选 1 展示方向气质标签
        vibes: skeletonsAll.map(
          (s: string) => s.match(/基调=([^;；(]+)/)?.[1] ?? '',
        ),
      });
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
   * 解析骨架化输出：骨架行 / 梗概行 / 风险行（纯函数，供单测）
   */
  static parseSkeletonize(text: string): {
    skeleton: string;
    preview: string;
    risks: string[];
  } {
    let skeleton = '';
    let preview = '';
    const risks: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!skeleton && /^骨架[：:=]/.test(line)) skeleton = line;
      if (!preview && /^梗概[：:]/.test(line)) {
        preview = line.replace(/^梗概[：:]\s*/, '');
      }
      const riskMatch = line.match(/^风险[：:]\s*(.+)$/);
      if (riskMatch) {
        const content = riskMatch[1].trim();
        if (content !== '无') risks.push(content);
      }
    }
    return { skeleton, preview, risks };
  }

  /**
   * 自写梗概：骨架化 + 逻辑体检（一次调用，非流式）。
   * 忠实拆解——不得改动用户设定；体检只报告不改写，改不改由用户决定。
   */
  async skeletonizeSynopsis(params: {
    user_id: string;
    synopsis: string;
    model?: string;
    key_id?: string;
    with_check?: boolean;
  }): Promise<{ skeleton: string; preview: string; risks: string[] }> {
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(
      params.user_id,
      'chat',
      model,
      params.key_id,
    );
    // 同梗概策划：结构设计类长指令在 Flash 上先塌陷（IFScale 分型），
    // 平台智能默认升级 Pro；用户显式选择的模型完全尊重
    const useModel =
      !params.model && resolved.source === 'platform'
        ? 'deepseek-v4-pro'
        : resolved.model;
    const resolvedUse =
      useModel === resolved.model
        ? resolved
        : await this.resolveApiKey(
            params.user_id,
            'chat',
            useModel,
            params.key_id,
          );
    const synopsis = sanitizePrompt(params.synopsis);
    const withCheck = params.with_check !== false;
    const prompt = `你是知乎盐选短篇的故事策划。把用户手写的故事梗概拆成结构化骨架，并做一次逻辑体检。

【任务】
1. 忠实拆解：骨架六字段必须完全来自用户梗概，不得改动任何设定、事实、人名、物证、时间与因果关系，不得新增关键事实，不得替换题材。梗概中出现的每个关键设定要素（身份与关系如未婚夫/恋人、所有人名、关键意象如心口旧疤、物证细节如血契上刻的名字）必须全部落入骨架对应字段，不得遗漏。用户梗概明确写出的结局必须原样进入"结局="字段，不得改写、反转或丢弃。梗概行基本保留用户原文（字数相近，±20%），只允许两处微调：①某处状态转变缺中间环节时补一句（≤15字）；②结尾若无悬念，在保留原结局的基础上追加一句钩子（不得删除、替换或反转用户明写的结局与事实）。
2. 输出两行：
骨架：基调=X；起因=故事起点发生了什么（一句，时间关系清楚）；行动=主角由此做的第一件事；连锁=这件事引发的结果与反转；结局=故事的收束方式；物证=核心物证的来龙去脉（在谁手里、为什么在他手里；无物证写无）
梗概：……
${withCheck ? `3. 逻辑体检（只报告，不改写）：逐项检查，每发现一个潜在矛盾输出一行"风险：……"（指明位置与原因，每条一句）；全部通过输出"风险：无"。检查项：①因果跳变（状态转变缺中间环节、核心动机链条断裂）②施恩方向（为对方挡刀=对方欠你，不得写反）③物证来龙去脉（在谁手里、为什么在他手里）④时间点前后一致、动机不得时间倒置⑤结局与起因因果闭环⑥时间锚点算术（所有"X年前/十年前/去年"的衍生年龄必须与人物年龄一致；"每年一封"的序列封数=年份跨度、起始年份与事件锚点一致）⑦数字与金额（口算正确、同一笔钱/数量前后一致）。` : ''}
不要输出其他内容。`;
    const r = await fetch(`${resolvedUse.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolvedUse.apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `故事梗概：\n${synopsis}\n\n请骨架化并体检。`,
          },
        ],
        max_tokens: 1500,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`骨架化失败 (${r.status}) ${errBody.slice(0, 120)}`);
    }
    const data = await r.json();
    const rawText = (data.choices?.[0]?.message?.content ?? '').trim();
    const parsed = AiService.parseSkeletonize(rawText);
    // 解析失败兜底：按原文生成，不阻断创作
    if (!parsed.preview) parsed.preview = synopsis;
    await this.recordUsage({
      userId: params.user_id,
      model: useModel,
      inChars: prompt.length + synopsis.length,
      outChars: rawText.length,
      usageType: resolvedUse.source === 'user' ? 'user_key' : 'platform_key',
    });
    return parsed;
  }

  /**
   * 自写梗概建书：骨架化已在客户端完成确认，这里只建书 + 写入 settings，零 AI 调用。
   * extra 结构与 3 选 1 流程同构，generate-story 按 outline_preview/outline_skeletons 读取。
   */
  async createShortFromSynopsis(params: {
    user_id: string;
    synopsis: string;
    skeleton?: string;
    preview?: string;
  }): Promise<{ book_id: string }> {
    const db = getDb();
    const synopsis = sanitizePrompt(params.synopsis);
    const preview = (params.preview || synopsis).trim();
    const skeleton = (params.skeleton || '').trim();
    const title =
      synopsis.length > 20 ? synopsis.slice(0, 20) + '...' : synopsis;
    const [book] = await db
      .insert(schema.books)
      .values({ user_id: params.user_id, title, type: 'short' } as any)
      .returning({ book_id: schema.books.book_id });
    const bookId = book.book_id;
    await db
      .insert(schema.book_settings)
      .values({ book_id: bookId, preset_style: 'default' });
    await db
      .insert(schema.chapters)
      .values({ book_id: bookId, title: '正文', sort_order: 1 });
    const [s] = await db
      .select({ extra: schema.book_settings.extra })
      .from(schema.book_settings)
      .where(eq(schema.book_settings.book_id, bookId))
      .limit(1);
    const extra = (s?.extra ?? {}) as Record<string, any>;
    extra.outline_preview = preview;
    extra.outline_previews = [preview];
    extra.outline_skeletons = skeleton ? [skeleton] : [];
    await db
      .update(schema.book_settings)
      .set({ extra: extra as any })
      .where(eq(schema.book_settings.book_id, bookId));
    return { book_id: bookId };
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
      key_id?: string;
      // 断点续传:客户端断连后带 true 重试,跳过已完成的轮(settings.extra.story_parts)
      resume_story?: boolean;
    },
  ) {
    const db = getDb();
    // 仅允许短篇作品：长篇调用会整体覆写第一章内容且重置字数，数据不可逆
    const [book] = await db
      .select({ type: schema.books.type })
      .from(schema.books)
      .where(eq(schema.books.book_id, params.book_id))
      .limit(1);
    if (!book || book.type !== 'short') {
      throw new BadRequestException('写完整故事仅适用于短篇作品');
    }
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(
      params.user_id,
      'chat',
      model,
      params.key_id,
    );
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
    // 注册作品级中止：软删除作品时取消生成，停止继续消耗 token
    registerBookAbort(bookId, abortCtrl);
    const genSignal = (timeoutMs: number) =>
      AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(timeoutMs)]);
    // SSE 心跳:每 30s 发注释帧,防浏览器/中间设备清理长时间无数据的空闲连接
    // (实测:第三轮生成 5-10 分钟无数据时,连接会被静默断开)
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 30_000);
    (heartbeat as any).unref?.();

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
      // 梗概骨架（起因/行动/连锁，梗概阶段产出的结构化制品）。
      // 按用户选中的梗概在候选列表中的位置匹配对应骨架,防止注入未选方向的骨架
      const outlineSkeletons: string[] =
        (settings?.extra as any)?.outline_skeletons ?? [];
      const outlinePreviews: string[] =
        (settings?.extra as any)?.outline_previews ?? [];
      const chosenOutlineIdx = Math.max(0, outlinePreviews.indexOf(preview));
      const chosenSkeleton = outlineSkeletons[chosenOutlineIdx] ?? '';
      const [chapter] = await db
        .select({ chapter_id: schema.chapters.chapter_id })
        .from(schema.chapters)
        .where(eq(schema.chapters.book_id, bookId))
        .orderBy(schema.chapters.sort_order)
        .limit(1);
      if (!chapter) throw new Error('章节不存在');

      // 断点续传:每轮完成后把已生成段落存到 settings.extra.story_parts,
      // 客户端断连后带 resume_story=true 重试,跳过已完成的轮,不重复烧 token
      const canResume =
        params.resume_story === true &&
        ((settings?.extra as any)?.story_parts ?? []).length >= 2;
      const savedParts = ((settings?.extra as any)?.story_parts ??
        []) as string[];
      const saveStoryParts = async (parts: string[]) => {
        try {
          const [s0] = await db
            .select({ extra: schema.book_settings.extra })
            .from(schema.book_settings)
            .where(eq(schema.book_settings.book_id, bookId))
            .limit(1);
          const ex = (s0?.extra ?? {}) as Record<string, any>;
          ex.story_parts = parts;
          await db
            .update(schema.book_settings)
            .set({ extra: ex as any })
            .where(eq(schema.book_settings.book_id, bookId));
        } catch (e: any) {
          console.error('[generateStory] save story_parts failed:', e.message);
        }
      };

      // Step 0.5: 节拍表（梗概确认后、正文前，一次调用设计情绪曲线；
      // 模型无法感知悬念弧线(Matlin 2025)，曲线必须在生成前显式编排，生成时逐拍执行）
      // 模型升级理由同梗概策划（IFScale 分型：结构设计长指令在 Flash 上先塌陷）
      const skeletonBlock = chosenSkeleton || preview;
      const beatModel =
        !params.model && resolved.source === 'platform'
          ? 'deepseek-v4-pro'
          : model;
      let beats: string[] = [];
      let recoupLines: string[] = [];
      send('step', {
        step: 'beat',
        status: 'generating',
        label: '设计情绪节拍表...',
      });
      try {
        const beatResolved =
          beatModel === model
            ? resolved
            : await this.resolveApiKey(
                params.user_id,
                'chat',
                beatModel,
                params.key_id,
              );
        const beatPrompt = `你是短篇故事节拍设计师。根据梗概骨架,设计整篇(1-3 万字)的情绪节拍表。

【每拍一行,格式】
拍N | 情绪=<一个情绪词> | 事件=<本拍核心事件,一句> | 钩子=<本拍结尾未解决的问题或未完成动作,一句> | 真相=<释放真相第几块:1/2/3 或无> | 转折=<全篇情绪转折点:是/否>

【硬性要求】
1. 共 5-7 拍,按顺序覆盖:出事→升级→谷底→反弹→高潮→收束
2. 相邻拍情绪必须相反(如 恐惧→希望→绝望→释然)
3. 谷底(最绝望/最虐)安排在 60%-80% 位置,谷底越深反弹越爽;结尾落在最高点或释然点
4. 若故事有核心真相/反转（悬疑/重生/误会类），先把真相自行拆成 1-3 块（真相1/真相2/真相3，按揭示顺序），每拍最多释放一块；无真相悬念的故事该字段写"无"
5. 转折点全篇最多 2 个,必须由新信息触发;其余拍用"冲突升级"推进
6. 对手动作交替:每拍的"事件"必须含主角行动或对手反制/环境恶化,不得连续 3 拍都是主角单边推进;主角被动接受(被打压/被安排/只能配合)的拍不得连续 2 拍
7. 宣泄拍:5-7 拍中至少 1 拍是宣泄拍(摊牌/反击/当众反转,情绪=爽/解气),全篇情绪不得只有虐没有爽

【梗概骨架】
${skeletonBlock}

输出格式:先逐拍输出节拍表(每拍一行),最后单独输出一行"回收清单",格式如下:
回收清单：谜团A(简述) → 答案一句话 → 第N拍揭示；谜团B → 答案 → 第M拍揭示
主干谜团(核心动机/核心反转/隐藏关系)必须在最后一拍前有答案;没有答案的谜团不要列入骨架。不要输出其他内容。`;
        const rBeat = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${beatResolved.apiKey}`,
          },
          body: JSON.stringify({
            model: beatModel,
            messages: [
              { role: 'system', content: beatPrompt },
              {
                role: 'user',
                content: `脑洞/想法：${premise}\n\n请设计整篇的情绪节拍表。`,
              },
            ],
            max_tokens: 1500,
            temperature: 0.7,
            // 推理模型关闭思考链,防止思考耗尽 max_tokens
            thinking: { type: 'disabled' },
          }),
          signal: genSignal(60_000),
        });
        if (!rBeat.ok) throw new Error(`beat status ${rBeat.status}`);
        const dataBeat = await rBeat.json();
        const rawBeat = (dataBeat.choices?.[0]?.message?.content ?? '').trim();
        beats = rawBeat
          .split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => /^拍\s*\d+/.test(l))
          .slice(0, 7);
        if (!beats.length) throw new Error('beat parse empty');
        // 回收清单:主线谜团的兑现映射(谜团→答案→揭示拍),随节拍表注入正文
        recoupLines = rawBeat
          .split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => /^回收清单[:：]/.test(l));
        send('step', {
          step: 'beat',
          status: 'done',
          label: `节拍表已设计（${beats.length} 拍）`,
          preview:
            beats.join('\n') +
            (recoupLines.length ? '\n' + recoupLines.join('\n') : ''),
        });
        await this.recordUsage({
          userId: params.user_id,
          bookId,
          model: beatModel,
          inChars: beatPrompt.length + premise.length,
          outChars: rawBeat.length,
          usageType:
            beatResolved.source === 'user' ? 'user_key' : 'platform_key',
        });
      } catch (e: any) {
        // 节拍表失败不阻断正文：降级为正文自行设计情绪曲线
        console.error('[generateStory] beat sheet failed:', e.message);
        send('step', {
          step: 'beat',
          status: 'done',
          label: '节拍表生成失败，正文按情绪曲线自行设计',
        });
      }
      // 三段均分节拍(三轮正文各执行一段):
      // 第一段铺垫至谷底前,第二段谷底与反弹,第三段高潮与收束
      const beatSplit1 = Math.ceil(beats.length / 3);
      const beatSplit2 = Math.ceil((beats.length * 2) / 3);
      // 回收清单是全篇约束,三轮都注入(量小,遗漏代价大于重复)
      const recoupBlock = recoupLines.length
        ? `【回收清单——主线谜团逐条兑现,在对应拍揭示】
${recoupLines.join('\n')}`
        : '';
      const beatBlockFirst = beats.length
        ? `【节拍表——第一段逐拍执行,每拍走完再进入下一拍,相邻拍情绪相反】
${beats.slice(0, beatSplit1).join('\n')}
${recoupBlock}`
        : '';
      const beatBlockSecond = beats.length
        ? `【节拍表——第二段逐拍执行】
${beats.slice(beatSplit1, beatSplit2).join('\n')}
${recoupBlock}`
        : '';
      const beatBlockThird = beats.length
        ? `【节拍表——第三段逐拍执行(高潮与收束)】
${beats.slice(beatSplit2).join('\n')}
${recoupBlock}`
        : '';

      // Step 1: 写正文（三轮，各 5000-6000 字，总 1.5 万字+；
      // 骨架+节拍表作为走向锚点，不再注入梗概全文防泄底）
      send('step', {
        step: 'story',
        status: 'generating',
        label: '正在写故事第一段（铺垫与升级）...',
      });
      const storyPrompt = `你是知乎盐选爆款短篇作家。

【已确认的梗概骨架——起因/行动/连锁/结局是唯一权威,写作走向与结局不得偏离;骨架明写的结局不得反转或改写(梗概写"她没要那笔钱"就不得写成"她拿回了那笔钱",梗概写"十八岁生日"就不得写成"十九岁生日");骨架各字段中的每个要素(身份关系如未婚夫/恋人、人名、关键意象如心口旧疤、物证刻字)必须在正文出现并回收,不得省略或替换(梗概写"未婚夫"不得写成师兄,写"恋人"就必须写明两人此前相恋,写"血契刻着两人的名字"就必须写全两个名字,写"心口旧疤"就必须让结局落到该疤上)]
${skeletonBlock}

${beatBlockFirst}

【输出格式】
第一行输出一行"张力骨架:冲突=本段核心冲突;升级=2-3个冲突升级点;真相释放=本段释放前世真相的哪一块(只释放一块,其余保留);节末钩子=本节结尾未解决的问题",然后空一行直接写正文。

【真相释放】
若故事有核心真相/反转（重生/悬疑/误会/身份类），真相拆成至少 3 块，本段只释放第一块;真相要在冲突、对话、发现中自然露出,不用大段内心独白倒叙;读者始终要有一个想知道答案的问题悬着;真相关键词(如"幻影""顶替""假死")只在释放该真相块的节次首次出现,之前的节次只能用异常细节暗示,不得提前说破;关键信息的揭示必须绑定具体事件(动作/冲突/发现),不得用大段对话倾倒。温情/日常向等无真相悬念的故事跳过本节要求。

【结构与钩子】
1. 第一句话即冲突/反常事实/强情绪动作,禁止任何介绍性铺垫;前 300 字引爆核心矛盾;1000 字内出现第一次反转(可倒叙)
2. 四幕推进:钩子 → 冲突升级 → 高潮 → 反转收束
3. 主角主动行动推进剧情;8000-12000 字,角色沿用梗概设定,配角不起名
4. 空行分节,每节 800-1500 字,节末留一个未解决的问题;禁止数字编号

【抓人机制】
1. 钩子轮换三种:悬念(危险将至/真相半露)、反转(颠覆预期)、情感悬置(误解加深)
2. 善用信息差:读者已知道危险时,角色越放松越误解,张力越强
3. 误解逐层加深,解开放在高潮前后;关键处留白,不把话说满;操作类动作(查资料/打电话)必须与冲突升级绑定,不写流水账

【文风】
1. 环境描写≤3 行,不写大段独白;同一角色全文只能有一个全名,不得中途换名(柳清婉不得后文写成白柔),小名/绰号首次出现必须紧跟全名绑定(如"柳清婉,小名柔儿");同一物件的名称前后一致(校服外套不得中途写成衬衫,同一件衣服只能有一个叫法)
2. 段落开头轮换使用动作、对话、环境、心理四种方式,同一主语(她/人名)开头的段落不得连续出现 3 次以上
3. 一个具体道具反复出现、多次回收;道具的归属变化(谁送谁、何时回到谁手上)必须有一句交代,不得无过渡跳变(如"送给他"之后不能直接写"一直在我手上")
4. 全文固定第一人称"我"叙事(知乎盐选标准,梗概/骨架的第三人称只是策划语言);只写"我"的所见所感,别人的内心只能通过其动作/表情/语言被"我"推测,不得直接写他人心理
5. 去 AI 味(主语):同一话题链内主语承前省略,不要每句都写"我";连续动作合并成一句,一个主语带多个动作;句首可换身体部位/物件/声音/时间("目光扫过去"不写"我看过去","门开了"不写"我听见门开");连续 3 句不得都以"我+动词"开头
6. 去 AI 味(心理):情绪演出不喊出——不直接命名情绪("我很痛苦"),用神态/小动作/生理反应/对话潜台词呈现,一个情绪只挑 1-2 个细节,克制留白("我累了"比嚎啕大哭更狠);心理独白必须由眼前事物触发,连排不超过 2 句;禁用"忽然明白/意识到/终于懂了"式替读者下结论,让读者自己得出

【伏笔与结局】
1. 重大反转前至少埋 3 处可回查伏笔
2. 结尾最多一个温情场景+一句金句收住,不逐个角色报结局
3. 题材内元素自洽,不突兀

【情绪】
1. 严格按节拍表逐拍推进情绪,相邻节情绪相反
2. 结局情绪释放与蓄积势能同量级,禁止情绪蒸发(如"误会一场"式和解);释放形式可以是代价、理解达成或情绪兑现

【技术红线】
1. 纯文本输出,不用 Markdown
2. 语法通顺,主谓施受清晰;禁止为悬念写病句

【时空一致性】
人物位置、时间线、道具状态前后一致;涉及多个时间点(结婚/流产/过户/现在等)时,每个事件的时间关系与先后顺序必须一次定死并全程沿用,任何角色提及同一事件时口径一致(如"流产在婚后一年、过户在婚前三个月"就不得写成"过户在流产后");动机的时间顺序不得倒置(婚前的决定不可能为了赔婚后的损失);跨越时间的对照(十年后/前世/重生)只允许永久特征一致(痣/疤痕/习惯),短期状态(痘痘/发型/穿着)不得镜像;预言/提示与后续事件的对应必须严丝合缝,提示的语义范围必须覆盖事件的实际形态(如"别点外卖"只能应对"自己点外卖",不能用来解释"别人送的外卖");诊断/预言类时间与实际存活必须闭环(医生说"活不过三年"、实际活了十年,必须交代一句原因:误诊/硬撑/医学奇迹,不得让两个数字并存);遗书/预写的信/提前录制的留言的时间参照必须与书写时间一致——书写者死后发生的事不得以"那年""今年"的亲眼口吻描述(预写的信可以写"等你读到这封信时",不得写"你十五岁那年爸看见你……",除非书写者那时还活着);同一时间锚点的衍生年龄必须算术一致(人物19岁时"三年前"=16岁,不得写成14岁;"每年一封"的信/日记序列封数必须等于年份跨度、第一封的年份与起始事件锚点一致);年龄与事件先后必须单调一致(先"十三岁遇劫灵根碎裂",就不能再写"十五岁筑基巅峰"发生在后,巅峰必须在遇劫之前);数字与金额必须口算正确且前后一致(四千双×五毛=两千,同一笔钱不得又说成两万);正文不得用角色或弹幕"点破"自身设定矛盾而不解决(如弹幕吐槽"十八岁寄的十九岁才到"),发现矛盾必须直接修正设定使之自洽,或删掉该情节。

${AiService.buildConditionalRules(premise)}

**写 5000-6000 字作为故事第一段（铺垫与升级，覆盖节拍表第一段的所有拍），在谷底前的关键转折点停住，最后一行标注：【待续】。**`;

      // 上游网络波动重试(千问偶发 fetch failed):最多 3 次,间隔 2 秒
      const sleepMs = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      let data1: any = null;
      if (!canResume) {
        for (let attempt = 0; attempt < 3 && !data1; attempt++) {
          try {
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
                    content: `脑洞/想法：${premise}\n\n请写故事第一段（5000-6000字），在谷底前的剧情关键时刻停住。`,
                  },
                ],
                max_tokens: 24576,
                temperature: 0.8,
              }),
              signal: genSignal(600_000),
            });
            if (!r1.ok) throw new Error(`status ${r1.status}`);
            data1 = await r1.json();
            if (!data1.choices?.[0]?.message?.content) {
              data1 = null;
              throw new Error('empty content');
            }
          } catch (e: any) {
            const reason = abortCtrl.signal.aborted
              ? 'client-abort'
              : e?.name === 'TimeoutError'
                ? 'timeout'
                : 'api-error';
            console.warn(
              `[generateStory] part1 attempt ${attempt + 1} failed (${reason}): ${e.message}`,
            );
            if (abortCtrl.signal.aborted) break; // 连接已断:客户端不在(睡眠/关页/服务重启),重试白等,直接失败让前端走续传
            if (attempt < 2) await sleepMs(2000);
          }
        }
        if (!data1) {
          send('error', { message: 'AI 请求失败，请重试' });
          res.end();
          return;
        }
      }
      // 剥离首行"张力骨架"（模型未按格式输出时安全降级为全文）；
      // 骨架另行抽取,随衔接回灌传给第二轮(跨环节传递,修"定义两次零传递")
      const stripTensionSkeleton = (
        text: string,
      ): { text: string; skeleton: string } => {
        const lines = text.split('\n');
        if (/^张力骨架[:：=]/.test(lines[0]?.trim() ?? '')) {
          const skeleton = lines[0].trim();
          let idx = 1;
          while (idx < lines.length && !lines[idx].trim()) idx++;
          return { text: lines.slice(idx).join('\n'), skeleton };
        }
        return { text, skeleton: '' };
      };
      // 断点续传:已保存的轮直接沿用,不发 AI 调用
      let part1Result: { text: string; skeleton: string };
      if (canResume) {
        send('step', {
          step: 'story',
          status: 'done',
          label: '断点续传:第一段沿用上次已生成内容',
        });
        part1Result = { text: savedParts[0], skeleton: '' };
      } else {
        part1Result = stripTensionSkeleton(
          (data1.choices?.[0]?.message?.content ?? '').replace(
            /【待续】.*$/s,
            '',
          ),
        );
      }
      // 接缝清洗(确定性):模型长输出尾部/头部常带空行与"---"分隔线,
      // 且第二轮会复读第一轮结尾句——拼接前清理,不依赖模型自觉
      const cleanSeam = (text: string, side: 'head' | 'tail'): string => {
        let t = side === 'tail' ? text.trimEnd() : text.trimStart();
        for (let i = 0; i < 5; i++) {
          const next =
            side === 'tail'
              ? t.replace(/-{3,}\s*$/, '').trimEnd()
              : t.replace(/^\s*-{3,}\s*\n?/, '').trimStart();
          if (next === t) break;
          t = next;
        }
        return t;
      };
      const dedupeOverlap = (tail: string, head: string): string => {
        if (!tail || !head) return head;
        // 找 head 开头与 tail 结尾的最大重叠(≥10 字),切掉复读前缀
        const maxLen = Math.min(tail.length, head.length, 200);
        for (let len = maxLen; len >= 10; len--) {
          if (tail.slice(-len) === head.slice(0, len)) {
            return head.slice(len).trimStart();
          }
        }
        return head;
      };
      const part1 = cleanSeam(part1Result.text, 'tail');
      const part1Skeleton = part1Result.skeleton;
      // 第一轮完成即持久化:断连后可从断点续跑
      if (!canResume) await saveStoryParts([part1]);

      // Step 1.5: 提取已写部分的关键事实与未解悬念(跨轮设定继承;
      // 模型无法靠结尾 3000 字自行继承,必须显式回灌清单)。
      // 每轮续写前都提取一次(第二轮前提取第一段,第三轮前提取第二段)
      const extractFacts = async (
        genLabel: string,
        doneLabel: string,
        input: string,
      ): Promise<string> => {
        let block = '';
        send('step', { step: 'fact', status: 'generating', label: genLabel });
        try {
          const factPrompt = `你是故事事实提取员。从下面的已写部分小说提取三段清单:
【已确立事实】每行一条,格式"事实 | 谁知道",只列影响后续续写的事实:人物状态(婚姻/恋爱/生死/关系)、关键物品及归属、公证/合同/转账等关键设定;谁知道=该事实被哪些角色知晓(只有主角知道写"主角",众人皆知写"公开",特定角色知道写角色名);同类型物品的多个实例(如两张票根)必须分别记录各自归属,不得合并;事实的表述口径必须原样登记(过户就是过户,不得写成购买;老宅就是老宅,不得写成新房),后续续写只能沿用该口径,不得为了某个场景的方便改写成等价但不同的说法
【人物称谓】每行一条,登记每个出场人物的姓名与所有称谓(如"守墓人=老郑,其子=郑明"),同一人若在前文出现多个叫法必须并列登记,后续续写只能使用已登记的称谓
【未解悬念】每行一条,文中已提出但尚未解答的问题

只输出这三段清单,每条一行,不要评论、不要分析。`;
          const rFact = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: beatModel,
              messages: [
                { role: 'system', content: factPrompt },
                { role: 'user', content: input },
              ],
              max_tokens: 1500,
              temperature: 0.3,
              // 推理模型关闭思考链
              thinking: { type: 'disabled' },
            }),
            signal: genSignal(60_000),
          });
          if (!rFact.ok) throw new Error(`fact status ${rFact.status}`);
          const dataFact = await rFact.json();
          const factText = (
            dataFact.choices?.[0]?.message?.content ?? ''
          ).trim();
          if (!factText) throw new Error('fact empty');
          block = `【前文已确立事实与未解悬念——续写必须继承,不得改写】
${factText}

`;
          send('step', { step: 'fact', status: 'done', label: doneLabel });
          await this.recordUsage({
            userId: params.user_id,
            bookId,
            model: beatModel,
            inChars: factPrompt.length + input.length,
            outChars: factText.length,
            usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
          });
        } catch (e: any) {
          // 事实提取失败不阻断:降级为仅靠结尾上下文续写
          console.error('[generateStory] fact extract failed:', e.message);
          send('step', {
            step: 'fact',
            status: 'done',
            label: '事实提取失败,按前文结尾续写',
          });
        }
        return block;
      };
      const factBlock = await extractFacts(
        '提取第一段关键事实...',
        '第一段关键事实已提取',
        part1.slice(-4000),
      );

      send('step', {
        step: 'story',
        status: 'generating',
        label: `第一段完成（${part1.length} 字），正在写第二段（谷底与反弹）...`,
        preview: part1.slice(0, 150),
      });

      // 第二轮/第三轮共用 system(精简,风格由第一段确立,只需一致性+结局约束)
      const continuationSystem =
        '你是知乎盐选爆款短篇作家。严格按照前文的文风、人物性格和节奏续写。第一行先输出一行"张力骨架：冲突=本段核心冲突；升级=2-3个升级点；真相释放=剩余真相块如何逐块揭示；节末钩子=本段结尾前最后一个未解决的问题"，然后空一行，再写正文。规则：从新的时间点或场景开始，已写过的场景不重写；前文结尾悬而未决的问题逐条给出答案；前文埋过的数量类/对比类细节（几张明信片、几码的鞋、几处地点）在本段逐一对上，不留下"还有两张给谁"这类空账；同一物件的唯一实例不得同时出现在多个角色手中（如一颗纽扣不可能既在主角手里又在自己手里，除非先交代它如何转移）；基调守恒——本段不得引入前文未铺垫的重大新设定（同名家人/超自然元素/凭空道具），所有新信息必须是前文已有线索的延伸，现实题材的后半不得突然出现超自然；同一角色全名与前文一致，不得中途换名（前文叫"柳清婉"本段就不得写成"白柔"），小名必须与前文的绑定一致；结局必须与梗概骨架的"结局="一致，不得反转或改写（梗概写"她没要那笔钱"就不得写成"她拿回了那笔钱"，梗概写"十八岁生日"就不得写成"十九岁生日"）；梗概骨架中的关键要素（结局意象如"心口旧疤"、人名、物证刻字）必须在本段收束时全部回收，不得遗漏；结局的情绪势能必须与前文的蓄积匹配，禁止"误会一场"式轻拿轻放；结尾最多一个温情场景+一句总结性金句；只输出正文，不写任何检查报告或批注。';
      // 第二轮：谷底与反弹（上游网络波动重试:最多 3 次,间隔 2 秒）
      let data2: any = null;
      if (!canResume) {
        for (let attempt = 0; attempt < 3 && !data2; attempt++) {
          try {
            const r2 = await fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'system', content: continuationSystem },
                  {
                    role: 'user',
                    content: `脑洞/想法：${premise}\n\n梗概骨架（结局与设定不得偏离）：\n${skeletonBlock || '（无骨架，按前文内容收束）'}\n\n第一段的张力骨架（据此衔接，已释放的真相块不要重复释放）：\n${part1Skeleton || '（第一段未输出骨架行，按正文内容自行衔接）'}\n\n${factBlock}${beatBlockSecond}\n\n已写的第一段（结尾部分）：\n${part1.slice(-3000)}\n\n请接着写第二段（5000-6000字）：保持人物性格和文风一致，从新场景开始，推进至谷底并完成第一次反弹，回收第一段的伏笔。不要给出结局，在反弹后的新悬念处停住，最后一行标注【待续】。`,
                  },
                ],
                max_tokens: 24576,
                temperature: 0.8,
              }),
              signal: genSignal(600_000),
            });
            if (!r2.ok) throw new Error(`status ${r2.status}`);
            data2 = await r2.json();
            if (!data2.choices?.[0]?.message?.content) {
              data2 = null;
              throw new Error('empty content');
            }
          } catch (e: any) {
            const reason = abortCtrl.signal.aborted
              ? 'client-abort'
              : e?.name === 'TimeoutError'
                ? 'timeout'
                : 'api-error';
            console.warn(
              `[generateStory] part2 attempt ${attempt + 1} failed (${reason}): ${e.message}`,
            );
            if (abortCtrl.signal.aborted) break; // 连接已断:客户端不在(睡眠/关页/服务重启),重试白等,直接失败让前端走续传
            if (attempt < 2) await sleepMs(2000);
          }
        }
        if (!data2) {
          send('error', { message: 'AI 续写失败，请重试' });
          res.end();
          return;
        }
      }
      let part2Result: { text: string; skeleton: string };
      if (canResume) {
        send('step', {
          step: 'story',
          status: 'done',
          label: '断点续传:第二段沿用上次已生成内容',
        });
        part2Result = { text: savedParts[1], skeleton: '' };
      } else {
        part2Result = stripTensionSkeleton(
          (data2.choices?.[0]?.message?.content ?? '').replace(
            /【待续】.*$/s,
            '',
          ),
        );
      }
      const part2 = cleanSeam(
        dedupeOverlap(part1, cleanSeam(part2Result.text, 'head')),
        'tail',
      );
      const part2Skeleton = part2Result.skeleton;
      // 第二轮完成即持久化
      if (!canResume) await saveStoryParts([part1, part2]);

      // Step 1.7: 第二段事实提取(第三轮前回灌)
      const factBlock2 = await extractFacts(
        '提取第二段关键事实...',
        '第二段关键事实已提取',
        part2.slice(-4000),
      );

      // 第三轮：高潮与收束（同第二轮结构，注入前两段事实+节拍第三段）
      send('step', {
        step: 'story',
        status: 'generating',
        label: `第二段完成（${part2.length} 字），正在写第三段（高潮与结局）...`,
        preview: part2.slice(0, 150),
      });
      let data3: any = null;
      for (let attempt = 0; attempt < 3 && !data3; attempt++) {
        try {
          const r3 = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: continuationSystem },
                {
                  role: 'user',
                  content: `脑洞/想法：${premise}\n\n梗概骨架（结局与设定不得偏离）：\n${skeletonBlock || '（无骨架，按前文内容收束）'}\n\n第二段的张力骨架（据此衔接，已释放的真相块不要重复释放）：\n${part2Skeleton || '（第二段未输出骨架行，按正文内容自行衔接）'}\n\n${factBlock}${factBlock2}${beatBlockThird}\n\n已写的第二段（结尾部分）：\n${part2.slice(-3000)}\n\n请接着写第三段（5000-6000字）：保持人物性格和文风一致，展开高潮、逐块释放剩余真相、给出完整结局。这是故事结尾，不要标注【待续】。`,
                },
              ],
              max_tokens: 24576,
              temperature: 0.8,
            }),
            signal: genSignal(600_000),
          });
          if (!r3.ok) throw new Error(`status ${r3.status}`);
          data3 = await r3.json();
          if (!data3.choices?.[0]?.message?.content) {
            data3 = null;
            throw new Error('empty content');
          }
        } catch (e: any) {
          const reason = abortCtrl.signal.aborted
            ? 'client-abort'
            : e?.name === 'TimeoutError'
              ? 'timeout'
              : 'api-error';
          console.warn(
            `[generateStory] part3 attempt ${attempt + 1} failed (${reason}): ${e.message}`,
          );
          if (abortCtrl.signal.aborted) break; // 连接已断:客户端不在(睡眠/关页/服务重启),重试白等,直接失败让前端走续传
          if (attempt < 2) await sleepMs(2000);
        }
      }
      if (!data3) {
        send('error', { message: 'AI 续写失败，请重试' });
        res.end();
        return;
      }
      const part3 = cleanSeam(
        dedupeOverlap(
          part2,
          cleanSeam(
            stripTensionSkeleton(
              (data3.choices?.[0]?.message?.content ?? '').replace(
                /【待续】.*$/s,
                '',
              ),
            ).text,
            'head',
          ),
        ),
        'tail',
      );
      // 分节只需单个空行:正文中间连续 3+ 换行压成标准空行(治模型异常空行)
      let storyText = (part1 + '\n\n' + part2 + '\n\n' + part3).replace(
        /\n{3,}/g,
        '\n\n',
      );
      // 删除模型自查报告混入正文的评审评论行
      // (如"(此段逻辑不通…建议删除)"、"这段文字在后文重复提及,此处保留原文")
      storyText = storyText
        .replace(
          /^\s*[（(][^)）\n]*(?:逻辑不通|建议删除|保留原文|与文风不符|不通顺|矛盾|重复)[^)）\n]*[)）]\s*$/gm,
          '',
        )
        .replace(
          /^\s*但?[此这]段[^\n]*(?:矛盾|重复|建议删除|保留原文)[^\n]*\s*$/gm,
          '',
        )
        .replace(/\n{3,}/g, '\n\n');

      // Step 2.5: 精修（自动审稿 + 修复 + 去 AI 味；失败不阻断，原文入库）
      if (storyText.trim()) {
        send('step', {
          step: 'polish',
          status: 'generating',
          label: '精修审稿中...',
        });
        try {
          // 代码级确定性 AI 味检测（不依赖模型自评），命中位置 ±150 字
          // 拼成待修片段——精修不再注入全文(约省 12K tokens/次)
          const deterministicIssues = detectAiFlavors(storyText);
          const snippets = deterministicIssues
            .slice(0, 10)
            .map((i, idx) => {
              const start = Math.max(0, i.index - 150);
              const end = Math.min(
                storyText.length,
                i.index + i.excerpt.length + 150,
              );
              return `【片段${idx + 1}·${i.type}】\n${storyText.slice(start, end)}`;
            })
            .join('\n\n');
          const polishPrompt = `你是小说精修编辑。下面是代码检测出的可疑片段（每段标注了问题类型），只改有明显问题的地方，不重写内容。

【文风锚】以下正文开头的语气、断句、用词是本篇的基准。修改时只做减法：问题句修向"更像这段开头"的方向，不得引入开头没有的修辞风格。
${storyText.slice(0, 400)}

【设定对照】以下骨架的起因/行动/连锁是全篇动机链的权威定义。片段中动机执行、时间口径、角色行为与骨架不一致处按句子级修复。
${chosenSkeleton}

对每个片段逐条判断：确有问题才修。检查范围：句尾补语（"他终于明白了一切"式）、"仿佛/宛如/像是/在那一刻"密度、"不是A而是B"二分壳、开头景物描写、连续句式重复、连续 3 句以上同一主语开头的短动作句（合并句子/换部位物件做主/承前省略主语）、"忽然明白/意识到"式解释腔（删掉或改为动作呈现）、病句标点、剂量与数字常识（几十片安眠药不能"假死"）。

输出严格 JSON 数组，每项为 {"find":"片段中连续≥10字且全文唯一出现的原文","replace":"修改后的文本"}。没问题的片段不输出。不要输出其他任何内容。

【待修片段】
${snippets}`;
          const pr = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: polishPrompt }],
              max_tokens: 4000,
              temperature: 0.3,
              thinking: { type: 'disabled' },
            }),
            signal: genSignal(300_000),
          });
          if (pr.ok) {
            const pd = await pr.json();
            const rawPolish = (pd.choices?.[0]?.message?.content ?? '').trim();
            let items: Array<{ find: string; replace: string }> = [];
            try {
              const parsed = JSON.parse(
                rawPolish
                  .replace(/^```(?:json)?\s*/i, '')
                  .replace(/```\s*$/, ''),
              );
              if (Array.isArray(parsed)) items = parsed;
            } catch {
              const arrMatch = rawPolish.match(/\[[\s\S]*\]/);
              if (arrMatch) {
                try {
                  const parsed2 = JSON.parse(arrMatch[0]);
                  if (Array.isArray(parsed2)) items = parsed2;
                } catch {
                  /* 解析失败:跳过精修 */
                }
              }
            }
            // 应用替换:只接受在正文中唯一出现的 find,防止误伤
            let applied = 0;
            for (const it of items) {
              if (
                typeof it?.find !== 'string' ||
                typeof it?.replace !== 'string' ||
                it.find.length < 10
              ) {
                continue;
              }
              const idx = storyText.indexOf(it.find);
              if (idx === -1) continue;
              if (storyText.indexOf(it.find, idx + 1) !== -1) continue;
              storyText =
                storyText.slice(0, idx) +
                it.replace +
                storyText.slice(idx + it.find.length);
              applied++;
            }
            // 精修替换可能引入多余空行,最后再压一次
            storyText = storyText.replace(/\n{3,}/g, '\n\n');
            // 精修效果闭环:修复后重跑检测,记录问题数变化
            const issuesAfter = detectAiFlavors(storyText).length;
            send('step', {
              step: 'polish',
              status: 'done',
              label: `精修完成（修复 ${applied} 处，问题 ${deterministicIssues.length}→${issuesAfter}）`,
            });
            // 回收清单兑现检查(代码级):每行"答案"的关键词必须出现在正文
            if (recoupLines.length) {
              const missed: string[] = [];
              for (const line of recoupLines) {
                const parts = line
                  .replace(/^回收清单[:：]\s*/, '')
                  .split('→')
                  .map((s: string) => s.trim());
                const answer = parts[1] ?? '';
                const keywords = (answer.match(/[一-鿿]{4,}/g) ?? []).slice(
                  0,
                  2,
                );
                if (!keywords.some((k: string) => storyText.includes(k))) {
                  missed.push(answer.slice(0, 30));
                }
              }
              console.warn(
                `[generateStory] recoup check: ${recoupLines.length - missed.length}/${recoupLines.length} answered${missed.length ? `, missed=${JSON.stringify(missed)}` : ''}`,
              );
            }
            await this.recordUsage({
              userId: params.user_id,
              bookId,
              model,
              inChars: polishPrompt.length,
              outChars: rawPolish.length,
              usageType:
                resolved.source === 'user' ? 'user_key' : 'platform_key',
            });
          }
        } catch (e: any) {
          console.error('[generateStory] polish failed:', e.message);
        }
      }

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
        // 生成完成:清理断点缓存
        await saveStoryParts([]);
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

根据下面的【故事梗概 + 正文开头 + 正文结尾】，生成 7 个书名（每个 18 字以内），七种风格各一个（顺序即优先级，第一个是默认书名，必须最有钩子）：
1. 悬念式：抛出问题或恐怖留白（如《那天，女儿没有回家》《他手机里有个叫"我"的联系人》）
2. 时间锚点式：具体时间 + 戏剧反转，数字制造真实感（如《领证3小时后，他把我送进了精神病院》《被赶出家门那天，我中了五百万》）
3. 道德困境式：为了正当理由，做了不可原谅的事（如《为了救女儿，我偷了闺蜜的骨髓配型报告》）
4. 反差式：用反差制造冲击（如《乖乖女的手机里藏着什么》《全班都以为我死了，直到我出现在高考考场》）
5. 爽点式：打脸逆袭向（如《撕碎成人礼那天，全班跪了》）
6. 情感式：温情催泪向（如《妈妈再爱我一次》）
7. 文艺含蓄：不带情绪词，意象化（如《铃兰》《她回来的那天》）

优先从正文的实际反转、核心道具、金句里提炼书名，不凭空编造梗概里没有的信息；不得直接照抄正文句子片段。

输出格式：每行一个书名，共 7 行，每行格式"风格名：书名"（如"悬念：那天，女儿没有回家"）。不要编号、不要引号、不要 JSON、不要其他内容。

【故事梗概】
${preview.slice(0, 400)}

【正文开头——核心设定】
${storyText.slice(0, 300)}

【正文结尾——反转与金句】
${storyText.slice(-800)}`;
      let titleText = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
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
              // 推理模型关闭思考链,防止思考耗尽 max_tokens 导致空输出
              thinking: { type: 'disabled' },
            }),
            // 千问等模型生成慢:超时放宽,失败重试不抛穿
            signal: genSignal(60_000),
          });
          const titleData = await titleR.json();
          titleText = (titleData.choices?.[0]?.message?.content ?? '').trim();
          if (titleText) break;
        } catch (e: any) {
          console.error(
            `[generateStory] title attempt ${attempt + 1} failed:`,
            e.message,
          );
        }
      }
      const stripped = titleText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      let titles: Array<{ style: string; title: string }> = [];
      // 行格式优先(新格式"风格名：书名"):模型对行格式遵循度远高于 JSON
      const lineTitles = stripped
        .split('\n')
        .map((l: string) => l.replace(/^\d+[.、]\s*/, '').trim())
        .filter(Boolean)
        .map((l: string) => {
          const m = l.match(/^([^：:]{1,8})[：:](.+)$/);
          if (m) return { style: m[1].trim(), title: m[2].trim() };
          return { style: '', title: l };
        })
        .filter((t) => t.title && t.title.length <= 25)
        .slice(0, 7);
      if (lineTitles.length >= 3) {
        titles = lineTitles;
      } else {
        try {
          const parsed = JSON.parse(stripped);
          if (Array.isArray(parsed)) {
            titles = parsed
              .map((t: any) => ({
                style: String(t?.style ?? '').trim(),
                title: String(t?.title ?? t ?? '').trim(),
              }))
              .filter((t) => t.title)
              .slice(0, 7);
          }
        } catch {
          const arrMatch = stripped.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            try {
              const parsed2 = JSON.parse(arrMatch[0]);
              if (Array.isArray(parsed2)) {
                titles = parsed2
                  .map((t: any) => ({
                    style: String(t?.style ?? '').trim(),
                    title: String(t?.title ?? t ?? '').trim(),
                  }))
                  .filter((t) => t.title)
                  .slice(0, 7);
              }
            } catch {
              /* 继续降级 */
            }
          }
          if (titles.length === 0) {
            // 降级：按行拆分，无风格标签
            titles = stripped
              .split('\n')
              .map((l: string) => l.replace(/^\d+[.、]\s*/, '').trim())
              .filter(Boolean)
              .slice(0, 7)
              .map((t: string) => ({ style: '', title: t }));
          }
        }
      }
      if (titles.length === 0) {
        titles = AiService.buildTitleFallback(premise).map((t: string) => ({
          style: '',
          title: t,
        }));
      }
      if (titles.length <= 1) {
        console.error(
          `[generateStory] title candidates=${titles.length}, model=${model}, raw=${JSON.stringify(titleText).slice(0, 300)}`,
        );
      }
      const finalTitle = (titles[0]?.title ?? '').slice(0, 30);
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
      clearInterval(heartbeat);
      unregisterBookAbort(bookId, abortCtrl);
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
      key_id?: string;
      guide_summary?: string;
      guide_full_log?: string;
    },
  ) {
    const db = getDb();
    const model = params.model || 'deepseek-v4-flash';
    const resolved = await this.resolveApiKey(
      params.user_id,
      'chat',
      model,
      params.key_id,
    );
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
    let protagonist: any = null;
    let protagonistText = '';
    let chapterOutlines: string[] = [];
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
        // 快捷创作默认绑定"快节奏网文"：番茄向用户为主，文艺向可在设置里切换
        .values({ book_id: bookId, preset_style: 'light-novel' });
      await db.insert(schema.outlines).values({ book_id: bookId });
      await db
        .insert(schema.world_settings)
        .values({ book_id: bookId, sections: [] });
      // 预建第一章：完成后可直接进入写作页（与短篇建"正文"对齐，避免空书）
      await db
        .insert(schema.chapters)
        .values({ book_id: bookId, title: '第一章', sort_order: 1 });
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

【调性】设定为冲突与爽点服务：每条设定都要能派上用场（制造矛盾、限制主角、提供打脸素材），不做无关的文学性铺陈。

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

      // Step 2.5: 生成主角卡（先于大纲：动机驱动情节，避免主角沦为大纲工具人）
      send('step', {
        step: 'protagonist',
        status: 'generating',
        label: '生成主角',
      });
      try {
        const protagonistPrompt = `你是网文角色创作顾问。根据题材和世界观，塑造这本书的主角。主角是故事的引擎——ta 的核心欲望决定大纲走向，缺陷决定冲突来源，金手指决定爽点供给。

【主角必须包含】
- 金手指/能力：主角的行动资本，最晚第 1 章上线
- 缺陷/不理性的点：人味来源，与核心欲望冲突
- 弧光：开篇→结局的性格或心境变化（非单纯变强）
- 语言指纹：口头禅/说话风格
- 所有字段表述具体可写（"护短、嘴硬心软"），禁止文学化抽象（"在孤独中寻找自我救赎"式）

【输出格式——只输出 JSON 对象】
{"name":"必填","gender":"男/女","personality":"性格3个关键词+1个反差","identity":"开局身份（10字内）","backstory":"背景（40字内）","motivation":"核心欲望：到底要什么（30字内）","catchphrase":"口头禅","speech_style":"说话风格","appearance":"外貌","custom_fields":[{"key":"金手指","value":"描述（30字内）"},{"key":"缺陷","value":"描述（20字内）"},{"key":"弧光","value":"开篇→结局的变化（30字内）"}]}`;
        const protText = await aiCall(
          protagonistPrompt,
          `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 1500)}\n\n请创作主角。`,
          2048,
        );
        protagonist = AiService.parseProtagonist(protText);
        if (protagonist) {
          protagonistText = [
            `姓名：${protagonist.name}`,
            protagonist.gender ? `性别：${protagonist.gender}` : '',
            protagonist.personality ? `性格：${protagonist.personality}` : '',
            protagonist.identity ? `身份：${protagonist.identity}` : '',
            protagonist.backstory ? `背景：${protagonist.backstory}` : '',
            protagonist.motivation ? `动机：${protagonist.motivation}` : '',
            protagonist.catchphrase ? `口头禅：${protagonist.catchphrase}` : '',
            protagonist.speech_style
              ? `说话风格：${protagonist.speech_style}`
              : '',
            ...((protagonist.custom_fields as any[]) ?? []).map(
              (f: any) => `${f.key}：${f.value}`,
            ),
          ]
            .filter(Boolean)
            .join('\n');
          await db.insert(schema.characters).values({
            book_id: bookId,
            name: protagonist.name || '主角',
            gender: protagonist.gender || '',
            personality: protagonist.personality || '',
            identity: protagonist.identity || '',
            backstory: protagonist.backstory || '',
            motivation: protagonist.motivation || '',
            catchphrase: protagonist.catchphrase || '',
            speech_style: protagonist.speech_style || '',
            appearance: protagonist.appearance || '',
            is_main: true,
            aliases: protagonist.aliases || '',
            custom_fields: protagonist.custom_fields || [],
          });
          send('step', {
            step: 'protagonist',
            status: 'done',
            label: `主角已生成（${protagonist.name}）`,
          });
        } else {
          send('step', {
            step: 'protagonist',
            status: 'done',
            label: `主角：AI 返回无法解析（${protText.length}字），大纲将无主角约束`,
          });
        }
      } catch (e: any) {
        console.error('[quickCreate] protagonist failed:', e.message ?? e);
        send('step', {
          step: 'protagonist',
          status: 'done',
          label: '主角生成失败（不阻断），大纲将无主角约束',
        });
      }

      // Step 3: 生成大纲（卷纲）
      send('step', {
        step: 'outline',
        status: 'generating',
        label: '生成卷纲',
      });
      const outlinePrompt = `你是网文大纲规划助手。根据世界观和主角设定，为这部小说设计情节大纲（卷纲）。**只使用用户已提供的信息，可以合理扩展，但不要修改或替换用户已明确的情节。**

【核心要求】
1. 分卷/分段推进：每段有明确的阶段目标，段末解决并引出下一段
2. 递进节奏：每个节点应有实质进展（具体是什么取决于故事本身的驱动力）
3. 格局扩展：故事舞台逐步扩大
4. 每个节点应能制造悬念或期待，让读者想看下一章
5. 节点必须体现主角的动机驱动：主角的每个关键选择都能回溯到他的欲望/缺陷/金手指，禁止主角随波逐流
6. 每个节点必须内置冲突或爽点（打压→反转→打脸，或悬念揭示），摘要用"谁+做了什么+得到什么结果"的直白句式，禁止文艺腔与抽象抒情
7. 主角道德基线：报复/打脸对象必须是真恶人（对方先作恶），情节不得伤害无辜之人（仆从/路人）；灰色行为须有正当理由

【数量要求】
至少输出 8-12 个情节节点，覆盖前 1-2 卷。标题简洁有力。

【输出格式——严格遵守】
只输出 JSON 数组，不要任何其他文字。title 精炼有网文感（8字以内），summary 简短有力（30字以内，写清谁+做了什么+结果）：
[{"title":"裂缝心跳","summary":"沈桁在灰塔底层发现空间裂缝，接触神秘气体后指纹异变"}]`;

      const outlineText = await aiCall(
        outlinePrompt,
        `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 2000)}${protagonistText ? `\n\n【主角设定——情节必须服务于主角的动机、缺陷与金手指】\n${protagonistText}` : ''}\n\n请设计大纲。`,
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
        label: `卷纲已生成（${outlineCount} 个节点）`,
      });

      // Step 3.5: 生成前 10 章章纲（场景级：目标/阻碍/爽点/钩子）
      // 卷纲颗粒度≈10万字/节点，写作时无上位约束会水；章纲补场景级控制
      send('step', {
        step: 'chapter-outlines',
        status: 'generating',
        label: '生成前10章章纲',
      });
      try {
        const chapterOutlinePrompt = `你是网文细纲设计师。根据世界观、主角设定和卷纲，为前 10 章逐章设计细纲。

【每章一行，格式】
第N章 | 目标=主角本章要达成什么 | 阻碍=什么在挡路（人或事） | 爽点=本章的爽点/反转/打脸点 | 钩子=章末悬念

【硬性要求】
1. 黄金三章：第 1 章 300 字内必须完成冲突爆发+主角登场+目标浮现；金手指最晚第 1 章上线；第 3 章内出现第一个小爽点
2. 前 3 章禁大段世界观说明，设定靠情节带出
3. 上一章的钩子=下一章开篇要回答的问题，因果承接
4. 一章一小冲突，10 章内至少 2 个小高潮
5. 爽点必须具体（什么被证明/谁被打脸/什么反转），禁止"主角变强"式空话
6. 表述直白网文化："打脸""捡漏""当众揭穿"式话术优先，禁止文学化修饰
7. 打脸/报复对象必须是真恶人（对方先作恶），不得牵连无辜之人

只输出 10 行，每行一条章纲，不要编号、不要其他文字。`;
        const chOutText = await aiCall(
          chapterOutlinePrompt,
          `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 1000)}${protagonistText ? `\n\n【主角设定】\n${protagonistText}` : ''}\n\n卷纲：${outlineText.slice(0, 2000)}\n\n请设计前 10 章细纲。`,
          2048,
        );
        chapterOutlines = AiService.parseChapterOutlines(chOutText);
        send('step', {
          step: 'chapter-outlines',
          status: 'done',
          label: `章纲已生成（${chapterOutlines.length} 章）`,
          preview: chapterOutlines.slice(0, 3).join('\n'),
        });
      } catch (e: any) {
        console.error('[quickCreate] chapter outlines failed:', e.message ?? e);
        send('step', {
          step: 'chapter-outlines',
          status: 'done',
          label: '章纲生成失败（不阻断），继续角色步骤',
        });
      }

      // Step 4: 生成角色
      send('step', {
        step: 'characters',
        status: 'generating',
        label: '生成角色',
      });
      const charsPrompt = protagonistText
        ? `你是网文角色创作顾问。主角已确定（见用户消息），根据世界观和大纲，输出 3-5 个配角的 JSON 数组。**不要重复生成主角**。只使用用户已提供和世界观/大纲已确定的角色信息，可以新增角色，但不要修改或替换用户已明确的角色身份。

【必须包含的角色类型】
- 重要助力者/伙伴（1-2个）
- 核心对手/反派（1个）

【角色深度要求】
- 每个角色必须有"要什么"（动机）和"怕什么"（缺陷/软肋）
- 与主角的关系必须明确（师生/宿敌/暗恋/利用），关系是冲突来源

【输出格式——只输出 JSON 数组】
[{"name":"必填","gender":"男/女","personality":"性格标签（10字内）","identity":"身份（10字内）","backstory":"背景（30字内）","motivation":"动机（20字内）","is_main":false,"custom_fields":[{"key":"与主角的关系","value":"..."},{"key":"弧光","value":"开篇→结局的变化（20字内）"}]}]`
        : `你是网文角色创作顾问。根据世界观和大纲，输出 4-6 个核心角色的 JSON 数组。**只使用用户已提供和世界观/大纲已确定的角色信息，可以新增角色，但不要修改或替换用户已明确的角色身份。**

【必须包含的角色类型】
- 主角（is_main:true）
- 重要助力者/伙伴（1-2个）
- 核心对手/反派（1个）

【角色深度要求】
- 主角必须有金手指、缺陷与弧光；每个角色都要有"要什么"（动机）和"怕什么"（软肋）

【输出格式——只输出 JSON 数组】
[{"name":"必填","gender":"男/女","personality":"性格标签（10字内）","identity":"身份（10字内）","backstory":"背景（30字内）","motivation":"动机（20字内）","is_main":true,"custom_fields":[{"key":"金手指","value":"..."},{"key":"缺陷","value":"..."},{"key":"弧光","value":"开篇→结局的变化"}]}]`;

      const charsText = await aiCall(
        charsPrompt,
        `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 1500)}\n\n大纲（角色必须与大纲中的名字一致）：${typeof outlineText === 'string' ? outlineText.slice(0, 1500) : ''}${protagonistText ? `\n\n【主角设定——不要重复生成主角】\n${protagonistText}` : ''}\n\n请设计角色${protagonistText ? '（配角）' : ''}，确保角色名字和大纲中完全一致。`,
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
      // 复用短篇书名的 few-shot 体系
      const titlePrompt = `参考这些爆款标题的调性：
《我在闺蜜葬礼上笑了出来》
《被赶出家门那天，我中了五百万》
《我替仇人养了十年孩子》
《老公的白月光住进了我家》
《全班都以为我死了，直到我出现在高考考场》
《我死后的第七天，全城都在找我》
《婆婆要我的肾，我反手签了器官捐献》
《前夫跪着求我复婚那天，我结婚了》

根据以下小说设定，生成 5 个书名（每个 12-22 字，符合番茄 2026 主流长句体），五种类型各一个：悬念式、金手指承诺式（身份+金手指+结果承诺，如《退婚当天，我靠种田系统逆袭成首富》）、反差式、爽点式、情感式。每个书名必须传达三层信息：题材标签+核心冲突+结果期待，忌文艺抽象、忌设定全亮。直接输出 5 行，每行一个，不要编号、不要引号、不要解释。`;
      const titleSummary = `题材：${fullPremise.slice(0, 500)}\n\n世界观：${worldText.slice(0, 500)}`;
      const titleText = (await aiCall(titlePrompt, titleSummary, 500)).trim();
      const titleLines = titleText
        .split('\n')
        .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const finalTitle = (titleLines[0] || premise.slice(0, 20)).slice(0, 40);
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

      // 保存引导讨论上下文 + 章纲，供后续 AI 对话使用
      {
        const [s] = await db
          .select({ extra: schema.book_settings.extra })
          .from(schema.book_settings)
          .where(eq(schema.book_settings.book_id, bookId))
          .limit(1);
        const extra = (s?.extra ?? {}) as Record<string, any>;
        if (params.guide_summary || params.guide_full_log) {
          extra.guide_summary = params.guide_summary || '';
          extra.guide_full_log = params.guide_full_log || '';
        }
        if (chapterOutlines.length) {
          extra.chapter_outlines = chapterOutlines;
        }
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
          // 主角/配角已生成时一并清理（此前回滚漏删角色，会残留半成品数据）
          await db2
            .delete(schema.characters)
            .where(eq(schema.characters.book_id, bookId));
          // 预建章节一并清理
          await db2
            .delete(schema.chapters)
            .where(eq(schema.chapters.book_id, bookId));
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
      /\[[\s\S]*"title"\s*:[\s\S]*"summary"[\s\S]*\]/,
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
          ? parsed.filter((a: any) => a.title && a.summary)
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
            ? parsed.filter((a: any) => a.title && a.summary)
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
            status: 'planned',
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
      /\[[\s\S]*"name"\s*:[\s\S]*"identity"[\s\S]*\]/,
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
          ? parsed.filter((a: any) => a.name)
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
            ? parsed.filter((a: any) => a.name)
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
        const ageText = get('年龄');
        chars.push({
          name,
          gender: get('性别'),
          personality: get('性格'),
          identity: get('身份'),
          backstory: get('背景') || get('背景故事'),
          motivation: get('动机') || get('目标'),
          catchphrase: get('口头禅'),
          speech_style: get('说话风格'),
          appearance: get('外貌'),
          is_main: /主要|主角|main/i.test(block),
          aliases: get('别名'),
          // 年龄不再用固定数字字段，解析结果放进自定义字段（自由文本，支持成长线描述）
          custom_fields: ageText ? [{ key: '年龄', value: ageText }] : [],
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
          const ageText = get('年龄');
          chars.push({
            name,
            gender: get('性别'),
            personality: get('性格'),
            identity: get('身份'),
            backstory: get('背景') || get('背景故事'),
            motivation: get('动机') || get('目标'),
            catchphrase: get('口头禅'),
            speech_style: get('说话风格'),
            appearance: get('外貌'),
            is_main: /主要|主角|main/i.test(block),
            aliases: get('别名'),
            custom_fields: ageText ? [{ key: '年龄', value: ageText }] : [],
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
