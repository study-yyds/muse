// 拆自 ai.service.ts：chapter-ops
import type { Response } from 'express';
import { eq, and, desc, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb, schema, mergeJsonb } from '../database/connection';
import { sanitizePrompt, STYLE_GUIDES } from './ai-prompts';
import * as aiUtils from './ai-utils';
import { registerBookAbort, unregisterBookAbort } from './abort-registry';
import { detectAiFlavors } from './text-quality-checks';
import type { AiHost } from './ai-host';

export class ChapterOps {
  constructor(private readonly host: AiHost) {}

  /**
   * 章节摘要链(长篇):内容增长 ≥1500 字时异步生成 100 字摘要,
   * 供后续章节 AI 上下文注入(第 50 章的 AI 知道第 3 章的梗概)。
   * 由章节保存触发,失败静默(不阻断保存)
   */
  async summarizeChapter(userId: string, chapterId: string, content: string) {
    const db = getDb();
    try {
      const resolved = await this.host.resolveApiKey(
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

      const resolved = await this.host.resolveApiKey(
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
    count?: number,
    nodeId?: string,
  ): Promise<{ lines: string[]; startNo: number }> {
    const db = getDb();
    const resolved = await this.host.resolveApiKey(
      userId,
      'chat',
      model,
      keyId,
    );
    const useModel =
      !model && resolved.source === 'platform'
        ? 'deepseek-v4-pro'
        : resolved.model;
    const resolvedUse =
      useModel === resolved.model
        ? resolved
        : await this.host.resolveApiKey(userId, 'chat', useModel, keyId);

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
    // 本批章数（1-30，默认 10）
    const genCount = Math.min(Math.max(count ?? 10, 1), 30);

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
      continuityBlock = `【最近已写章节摘要】\n${recentChs
        .reverse()
        .map((c) => `- 第${c.sort_order}章 ${c.title}：${c.summary}`)
        .join('\n')}\n`;
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
        (guideSummary?.guide_summary as string | undefined)?.slice(0, 800) ??
        '';
      const outlineGenPrompt = `你是网文大纲规划助手。根据下面的信息为这部小说设计情节大纲（卷纲），至少 10-14 个节点，必须覆盖到全书结局：前 1-2 卷细节点（8-10 个），后续每卷 1-2 个粗节点，最后一个节点为全书结局（大结局+尾声），禁止只写到中段就停。

【书名】${bookRow?.title ?? '（未命名）'}

${guideBlock ? `【创作方向——严格遵循】\n${guideBlock}\n` : ''}
${continuityBlock ? `【已写正文参考——大纲必须承接，不重写已发生事件】\n${continuityBlock.slice(0, 1500)}` : '【注意】暂无正文：根据书名和题材常识合理发挥。'}

【核心要求】
1. 分卷/分段推进：每段有明确的阶段目标，段末解决并引出下一段
2. 递进节奏：每个节点应有实质进展
3. 每个节点必须内置冲突或爽点；爽点按番茄长篇偏好——规则内/信息差打脸（对手不降智）、升级养成快感、情绪价值、悬念揭示；节点功能轮换：冲突节点不超过一半，收获/铺垫/揭露节点各至少 1 个
4. 摘要用"谁+做了什么+得到什么结果"的直白句式，禁止文艺腔
5. 能力/金手指的觉醒节点必须在对应节点的摘要中明确写出（如"绝境觉醒异能"），供章纲生成对齐时间线；觉醒节点之前的节点摘要不得出现能力使用，只能写铺垫/伏笔
6. 全程骨架式：前 1-2 卷细节点（8-10 个），后续每卷 1-2 个粗节点，最后一个节点必须是全书结局（大结局+尾声）；禁止只写到中段就停
6. 全程骨架式：前 1-2 卷细节点（8-10 个），后续每卷 1-2 个粗节点，最后一个节点必须是全书结局（大结局+尾声）；禁止只写到中段就停

【输出格式——严格遵守】
只输出 JSON 数组，不要任何其他文字。title 精炼（8字内），summary 简短（30字内）：
[{"title":"意外之喜","summary":"主角在山洞中发现前人遗留的秘籍，从此走上修行之路"}]`;
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
      const savedCount = await this.host.parseAndSaveOutline(
        bookId,
        outlineRaw,
      );
      if (!savedCount) {
        throw new Error('卷纲自动生成失败，请稍后重试');
      }
      await this.host.recordUsage({
        userId,
        bookId,
        model: useModel,
        inChars: outlineGenPrompt.length,
        outChars: outlineRaw.length,
        usageType: resolvedUse.source === 'user' ? 'user_key' : 'platform_key',
      });
      nodes = await loadOutlineNodes();
    }

    // 指定目标节点：卷纲聚焦该节点（+前后邻居作衔接），并加聚焦约束
    let focusNodeBlock = '';
    let focusRequirement = '';
    if (nodeId) {
      const idx = nodes.findIndex((n: any) => n.id === nodeId);
      if (idx >= 0) {
        const focusNodes = nodes.slice(Math.max(0, idx - 1), idx + 2);
        focusNodeBlock = focusNodes
          .map(
            (n: any, i: number) =>
              `${i === idx - Math.max(0, idx - 1) ? '【重点节点——本批章纲围绕它展开】' : ''}- ${n.title}：${n.summary}`,
          )
          .join('\n');
        focusRequirement = `本批 ${genCount} 章全部围绕重点节点展开：目标/阻碍/爽点/钩子服务于该节点的情节，不要跳入后续节点的剧情`;
      }
    }
    const outlineText =
      focusNodeBlock ||
      nodes.map((n) => `- ${n.title}：${n.summary}`).join('\n') ||
      '（无大纲）';
    // 能力时间线约束用全量卷纲提取（聚焦块可能不含觉醒节点），显式告诉模型觉醒在第几个节点
    const timelineBlock = aiUtils.buildCapabilityTimeline(
      nodes.map((n) => `- ${n.title}：${n.summary}`).join('\n'),
    );

    // 硬性要求按素材条件化：首批无上一批钩子可承接、无卷纲时从正文自然延伸
    const requirements = [
      '一章一小冲突，10 章内至少 2 个小高潮；爽点必须具体（什么被证明/谁被打脸/什么反转），禁止"主角变强"式空话',
      '表述直白网文化，禁止文学化修饰',
      '打脸/报复对象必须是真恶人（对方先作恶），不得牵连无辜之人',
      '能力/金手指时间线铁律：以【能力时间线】块为准——首个能力节点之前的章节禁止出现任何异能（连"预判""瞬移"等字眼都不能有），只能埋伏笔；觉醒必须在对应章节作为完整情节写出，不得跳过、不得默认已拥有',
      '反派动机多样化：不能全是"看不起主角"式脸谱，至少一个反派有自己的立场/苦衷/合理动机；同一反派不得连续 3 章作为主要阻碍',
      '爽点机制按番茄长篇偏好轮换：打脸须升级为规则内打脸/信息差打脸（对手越精明、越站得住，翻盘越爽），禁止"当众嘲讽→当众打脸"同构循环；爽点模式多样化——升级养成快感、情绪价值（被理解/被看见）、悬念揭示、智力破局各至少出现一次',
      '章节功能轮换（核心节奏）：冲突章（对抗/考核/战斗）不超过本批一半且不得连续超过 2 章，收获章（升级/资源/奖励兑现）、铺垫章（日常/关系线/感情/内心戏）、揭露章（世界观真相/阴谋推进/伏笔回收）各至少 1 章；冲突章之间必须有缓冲章',
      '钩子类型轮换：禁止连续 3 章"角色放狠话/威胁"式钩子；本批至少 3 章钩子改为信息揭示（物证/真相碎片）、情感悬置（牵挂/误会/失约）或主角主动做出的危险决定',
      '若注入有【能力时间线】块（即本作存在觉醒/激活/获得金手指的设定）：激活的节奏与长度按卷纲节点执行（单章或多章任务式皆可，如百天打卡），但禁止把激活句拆成逐字谜题（如"我"字→"想"字）、禁止激活句/主题台词无必要地反复出现；道具设定不得因拼字/谜题需要而改动',
      '对立势力行动具体化：对手施加压力必须用实际动作（动手脚/改档案/截资源/设局），禁止只有语言挑衅；同一阴谋逐章递进露出新一层，本批内至少完成一次阴谋的阶段性揭露',
      '冲突来源多样化：人际、环境与规则、主角内心缺陷三类冲突至少各出现一次，禁止全篇都是"有人找茬→反击"的同构循环',
      '权威角色理性铁律：教师、考官、官员等权威配角的言行必须符合其身份立场与自身利益——刁难主角只能出于真实利益冲突（名额竞争、隐瞒事故、站队压力），禁止"看不起主角"式无理由贬损；对主角的质疑应为专业存疑而非人身嘲讽；本批内至少一半配角立场中立或善意',
      nodes.length
        ? '卷纲是大方向：新章纲推进的情节必须落在卷纲范围内'
        : '暂无大纲：剧情从已写正文自然延伸，不要凭空引入与正文无关的设定',
      focusRequirement,
      existingLines.length
        ? `承接上一批章纲的结尾钩子：第 ${startNo} 章的开篇必须回答上一批最后一章的钩子`
        : '',
    ]
      .filter(Boolean)
      .map((r, i) => `${i + 1}. ${r}`)
      .join('\n');

    const prompt = `你是网文细纲设计师。为这本书生成下一批 ${genCount} 章的细纲（第 ${startNo} 到第 ${startNo + genCount - 1} 章）。

${bookRow?.title ? `【书名】${bookRow.title}` : ''}

【每章一行，格式】
第N章 | 目标=主角本章要达成什么 | 阻碍=什么在挡路（人或事） | 爽点=本章的爽点/反转/打脸点 | 钩子=章末悬念

【硬性要求】
${requirements}

【卷纲】
${outlineText.slice(0, 2000) || '（无大纲）'}

${timelineBlock}
${continuityBlock}
${existingLines.length ? `【上一批章纲结尾】\n${existingLines.slice(-3).join('\n')}\n` : ''}
只输出 ${genCount} 行，每行一条章纲，不要编号、不要其他文字。`;

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
            content: `请生成第 ${startNo} 到第 ${startNo + genCount - 1} 章的细纲。`,
          },
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
    const lines = aiUtils.parseChapterOutlines(rawText);
    if (!lines.length) throw new Error('章纲续生解析为空');

    // 追加保存（只接在已有批次后面，覆盖重复续生）——JSONB 原子合并，并发写不互相覆盖
    await db
      .update(schema.book_settings)
      .set({
        extra: mergeJsonb(schema.book_settings.extra, {
          chapter_outlines: [...existingLines, ...lines],
        }),
      })
      .where(eq(schema.book_settings.book_id, bookId));
    await this.host.recordUsage({
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
   * 节点细化（第一阶段）：把粗节点拆成 8-10 个细节点，存入草稿（extra.refine_draft），
   * 不写入大纲——作者在预览弹窗审阅/编辑后调用 applyRefinedNodes 才落库。
   */
  async refineNode(
    userId: string,
    bookId: string,
    nodeId: string,
    model?: string,
    keyId?: string,
  ) {
    const db = getDb();
    await this.host.checkBookOwnership(bookId, userId);
    const [outline] = await db
      .select({ outline_id: schema.outlines.outline_id })
      .from(schema.outlines)
      .where(eq(schema.outlines.book_id, bookId))
      .limit(1);
    if (!outline) throw new Error('该作品还没有大纲');
    const loadNodes = () =>
      db
        .select()
        .from(schema.outline_chapters)
        .where(eq(schema.outline_chapters.outline_id, outline.outline_id))
        .orderBy(schema.outline_chapters.sort_order);
    // 先定位目标节点（失败残留的孤儿行可能显示在列表里——先校验目标再清理，
    // 否则点击孤儿节点会"先删后找"报"节点不存在"）
    let nodes = await loadNodes();
    let idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) throw new Error('节点不存在');
    // 清理历史失败残留：sort_order 唯一约束冲突导致的孤儿行（sort_order < 1）
    await db
      .delete(schema.outline_chapters)
      .where(
        and(
          eq(schema.outline_chapters.outline_id, outline.outline_id),
          lt(schema.outline_chapters.sort_order, 1),
        ),
      );
    nodes = await loadNodes();
    idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) throw new Error('节点不存在');
    const node = nodes[idx];
    const prev = nodes[idx - 1];
    const next = nodes[idx + 1];

    const resolved = await this.host.resolveApiKey(
      userId,
      'chat',
      model,
      keyId,
    );
    const [settings] = await db
      .select({ extra: schema.book_settings.extra })
      .from(schema.book_settings)
      .where(eq(schema.book_settings.book_id, bookId))
      .limit(1);
    const extra = (settings?.extra ?? {}) as Record<string, any>;
    const guideBlock = (extra.guide_summary as string | undefined)
      ?.replace(/【关键节点】[^【]*/g, '')
      .slice(0, 800);
    const chOutlines = (extra.chapter_outlines as string[] | undefined) ?? [];
    const recentWritten = chOutlines.slice(-3).join('\n');
    const timelineBlock = aiUtils.buildCapabilityTimeline(
      nodes.map((n) => `- ${n.title}：${n.summary}`).join('\n'),
    );

    const prompt = `你是网文大纲规划助手。把下面的粗节点细化为 8-10 个细节点（卷内情节链）。

【待细化的节点】
${node.title}：${node.summary}

${prev ? `【上一节点——细化后的第 1 个节点必须承接其结果与钩子】\n${prev.title}：${prev.summary}\n` : ''}${next ? `【下一节点——细化后的最后一个节点必须达成原节点结果，并为它铺垫】\n${next.title}：${next.summary}\n` : ''}${guideBlock ? `【创作方向——严格遵循】\n${guideBlock}\n` : ''}${recentWritten ? `【已写章纲（尾部）——不得推翻已写情节】\n${recentWritten}\n` : ''}${timelineBlock}

【核心要求】
1. 8-10 个细节点，按因果链推进，每个节点"谁+做了什么+得到什么结果"
2. 冲突节点不超过一半；爽点模式轮换（规则内/信息差打脸、升级养成、情绪价值、悬念揭示）
3. 主角道德基线：报复对象必须是真恶人，不得伤害无辜之人

【输出格式——严格遵守】
只输出 JSON 数组，不要任何其他文字。title 精炼（8字内），summary 简短（30字内）：
[{"title":"意外之喜","summary":"主角在山洞中发现前人遗留的秘籍，从此走上修行之路"}]`;

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
          { role: 'user', content: `请细化节点「${node.title}」。` },
        ],
        max_tokens: 4096,
        temperature: 0.7,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`refine status ${r.status}`);
    const d = await r.json();
    const rawText = (d.choices?.[0]?.message?.content ?? '').trim();
    const refined = aiUtils.parseOutlineNodesJson(rawText);
    if (!refined.length) throw new Error('节点细化解析失败，请重试');

    await this.host.recordUsage({
      userId,
      bookId,
      model: resolved.model,
      inChars: prompt.length,
      outChars: rawText.length,
      usageType: resolved.source === 'user' ? 'user_key' : 'platform_key',
    });

    // 持久化入事务：备份 + 替换 + 插入 + 重排，中途失败自动回滚
    // （此前无事务时两次踩过半应用状态：孤儿行、原节点内容被换）
    await db.transaction(async (tx) => {
      await tx
        .update(schema.book_settings)
        .set({
          extra: mergeJsonb(schema.book_settings.extra, {
            refine_last_original: { title: node.title, summary: node.summary },
          }),
        })
        .where(eq(schema.book_settings.book_id, bookId));

      // 替换原节点：第一个细化节点复用原 id，其余插入；最后统一重排 sort_order
      await tx
        .update(schema.outline_chapters)
        .set({ title: refined[0].title, summary: refined[0].summary })
        .where(eq(schema.outline_chapters.id, nodeId));
      const insertedIds: string[] = [];
      for (const [i, rn] of refined.slice(1).entries()) {
        const [ins] = await tx
          .insert(schema.outline_chapters)
          .values({
            outline_id: outline.outline_id,
            title: rn.title,
            summary: rn.summary,
            status: 'planned',
            // 临时负数排序：sort_order 有唯一约束（正数已被现有节点占用），重排后归位
            sort_order: -1 - i,
          })
          .returning({ id: schema.outline_chapters.id });
        insertedIds.push(ins.id);
      }
      const before = nodes.slice(0, idx).map((n) => n.id);
      const after = nodes.slice(idx + 1).map((n) => n.id);
      const newOrder = [...before, nodeId, ...insertedIds, ...after];
      // 两阶段重排：先全部移到临时负数（避免"目标值仍被旧节点占用"的唯一约束瞬时冲突），
      // 再按新顺序赋 1..N 正序
      for (let i = 0; i < newOrder.length; i++) {
        await tx
          .update(schema.outline_chapters)
          .set({ sort_order: -1000 - i })
          .where(eq(schema.outline_chapters.id, newOrder[i]));
      }
      for (let i = 0; i < newOrder.length; i++) {
        await tx
          .update(schema.outline_chapters)
          .set({ sort_order: i + 1 })
          .where(eq(schema.outline_chapters.id, newOrder[i]));
      }
    });
    return { count: refined.length, nodes: refined };
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
      replace?: boolean; // true = 覆盖重新生成（视本章为空，从开头写并替换保存）
    },
  ) {
    const db = getDb();
    const resolved = await this.host.resolveApiKey(
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
      send('step', {
        step: 'prepare',
        status: 'generating',
        label: '组装写作上下文',
      });
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

      // 章纲：当前行 + 上一行（开篇应回答其钩子）+ 后续两行（事件先后参考，防提前写）
      const chOutlines = extra.chapter_outlines as string[] | undefined;
      let chapterPlanBlock = '';
      let planHook = '';
      if (chOutlines?.length && ch.sort_order <= chOutlines.length) {
        const line = chOutlines[ch.sort_order - 1];
        const prevLine =
          ch.sort_order > 1 ? chOutlines[ch.sort_order - 2] : undefined;
        const nextLines = chOutlines.slice(ch.sort_order, ch.sort_order + 2);
        if (line) {
          chapterPlanBlock = `${prevLine ? `【上一章章纲——本章开篇应回答其钩子】\n${prevLine}\n` : ''}【本章细纲——目标/阻碍/爽点/钩子，写作必须覆盖】\n${line}\n${nextLines.length ? `【后续章节细纲——事件先后参考：其中的事件（如激活/觉醒/关键反转）不得提前写进本章】\n${nextLines.join('\n')}\n` : ''}`;
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
              prevNodes.forEach((n) =>
                lines.push(`- ${n.title}：${n.summary}`),
              );
            }
            lines.push(
              `【当前节点——本章正在写的情节】${nodes[idx].title}：${nodes[idx].summary}`,
            );
            if (nodes[idx + 1]) {
              lines.push(
                `【下一节点——剧情走向参考】${nodes[idx + 1].title}：${nodes[idx + 1].summary}`,
              );
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
        const factors = aiUtils.extractFactors(
          `${ch.title} ${chapterPlanBlock} ${nodeBlock} ${chapterText.slice(-1000)}`,
        );
        worldBlock = aiUtils.selectWorldSections(
          worldSections as Array<{ name: string; content: string }>,
          factors,
        );
      }

      // 风格（面板传入优先，回退书预设）
      const styleNote =
        STYLE_GUIDES[params.style || settings?.preset_style || 'default'] ?? '';
      const styleBlock = styleNote
        ? `【文风要求——严格遵守】\n${styleNote}\n`
        : '';

      // 记忆：交接摘要 + 活跃伏笔 + 前章事实
      let memoryBlock = '';
      {
        const handoff = extra.writing_handoff as
          { summary?: string } | undefined;
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
          Record<string, { facts: string; at: number }> | undefined;
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
          ? `【开篇三章专项——本章是第 1 章，严格遵守】\n- 前 300 字内完成：冲突爆发 + 主角登场 + 目标浮现 + 钩子落地\n- 禁止开篇大段世界观说明文（设定靠情节和对话带出）\n- 主角的金手指/能力最晚本章上线（若能力时间线/章纲安排金手指在后续章节觉醒/激活，则本章只需埋钩子——如异常现象/神秘物件，不要求能力实际登场）\n- 章末强钩子：让读者必须点开下一章\n`
          : ch.sort_order <= 3
            ? `【开篇三章专项——本章处于黄金三章内】\n- 本章内必须有具体的小爽点（打压→反转→打脸）或强悬念\n- 章末强钩子\n`
            : '';

      // 已有正文：追加模式；replace=true 时视为空章（覆盖重新生成，保存时替换）
      const existingContent = params.replace ? '' : (ch.content ?? '').trim();
      const existingTail = existingContent.slice(-1500);

      const taskBlock = needsSelfPlan
        ? `【本章任务】\n本章没有细纲约束：第一行先输出"本章目标=… | 冲突=… | 章末钩子=…"（自定本章写作目标），然后空一行写正文。目标约 2000-5000 字，写到自然停点；章末必须以悬念或未完成动作收尾（钩子）。`
        : `【本章任务】\n按上面的细纲/节点写本章：目标、阻碍、爽点、钩子逐项落实。目标约 2000-5000 字，写到自然停点；章末必须落实章末钩子——以悬念或未完成动作收尾。若细纲与节点摘要冲突（如激活/觉醒时机、事件先后），一律以细纲为准；本章细纲未提及的事件（激活/觉醒/关键反转）不得从节点摘要自行补写，【后续章节细纲】中的事件不得提前写进本章。`;

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
- 金手指/系统等载体的声音来源必须单一明确：若系统藏在收音机里，收音机里的人声就是系统在说话，不得出现两个无法区分的声源，也不得让载体自我否认"这不是我"
- 主角道德基线：可以狠、自保、报复，但对象必须是真恶人（对方先作恶）；不得伤害无辜之人（仆从/路人）；灰色行为必须有正当理由

${taskBlock}

【输出格式】
- 纯文本正文，禁止 Markdown（不用 # 标题/**加粗**）与 JSON
- 不写章节标题行（标题由系统管理）
- 不要输出任何解释或批注`;

      send('step', {
        step: 'write',
        status: 'generating',
        label: '生成正文（第一轮）',
      });
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
        send('step', {
          step: 'write',
          status: 'generating',
          label: `字数不足（${text.length}），补写一轮`,
        });
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
          const part2 = (d2.choices?.[0]?.message?.content ?? '')
            .trim()
            .replace(/^#{1,6}\s+/gm, '');
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
        .set({
          word_count: sumRow?.total ?? 0,
          status: 'writing',
          updated_at: new Date(),
        })
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
      await this.host.recordUsage({
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
          ? {
              count: issues.length,
              types: [...new Set(issues.map((i) => i.type))],
            }
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
    const resolved = await this.host.resolveApiKey(
      userId,
      'chat',
      model,
      keyId,
    );
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
}
