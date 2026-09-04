// 拆自 ai.service.ts：chat-ops
import type { Response } from 'express';
import { eq, and, desc, isNotNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { sanitizePrompt, sanitizeMessages, STYLE_GUIDES } from './ai-prompts';
import * as aiUtils from './ai-utils';
import { registerBookAbort, unregisterBookAbort } from './abort-registry';
import { detectAiFlavors } from './text-quality-checks';
import type { AiHost } from './ai-host';

export class ChatOps {
  constructor(private readonly host: AiHost) {}

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
        const basePrompt = aiUtils.buildGuideSystemPrompt(
          params.guide_context,
          params.guide_type,
        );
        // 长对话记忆：先压缩再截断——早期作者发言压进【已确认设定】注入 system，
        // 否则 40 条窗口外的设定会被 sanitizeMessages 直接丢弃
        const { messages: guideMsgs, memoryBlock } = aiUtils.buildChatMemory(
          Array.isArray(params.messages) ? params.messages : [],
        );
        const cleanMessages = sanitizeMessages(guideMsgs);
        const guidePrompt = basePrompt + memoryBlock;
        const resolved = await this.host.resolveApiKey(
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
        const resolved = await this.host.resolveApiKey(
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
      await this.host.checkBookOwnership(params.book_id, params.user_id);
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
            recapBlock = aiUtils.buildRecap(prevChapters.reverse());
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
            const nextLines = chOutlines.slice(
              ch.sort_order,
              ch.sort_order + 2,
            );
            if (line) {
              chapterOutlineBlock = `${prevLine ? `【上一章章纲——本章开篇应回答其钩子】\n${prevLine}\n` : ''}【本章细纲——目标/阻碍/爽点/钩子，写作必须覆盖】
${line}（本章已写 ${ch.content.length} 字）
${nextLines.length ? `【后续章节细纲——事件先后参考：其中的事件（如激活/觉醒/关键反转）不得提前写进本章】\n${nextLines.join('\n')}\n` : ''}`;
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
- 主角的金手指/能力最晚本章上线（若能力时间线/章纲安排金手指在后续章节觉醒/激活，则本章只需埋钩子——如异常现象/神秘物件，不要求能力实际登场）
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
      const sectionFactors = aiUtils.extractFactors(
        `${chapterContext} ${outlineContext}`,
      );
      worldForWrite = aiUtils.selectWorldSections(
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
- 若注入有【本章细纲】，以细纲为本章执行计划（目标/阻碍/爽点/钩子），大纲节点仅作方向参考；细纲与节点摘要冲突时（如激活/觉醒时机、事件先后），一律以细纲为准，节点摘要中属于后续阶段的情节（如"夜里激活"）不得提前写进本章；本章细纲未提及的事件（激活/觉醒/关键反转等）一律不得从节点摘要自行补写，后续章节细纲中的事件不得提前写
- 金手指/系统等载体的声音来源必须单一明确：若系统藏在收音机里，收音机里的人声就是系统在说话，不得出现两个无法区分的声源，也不得让载体自我否认"这不是我"
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

【套路偏向——知乎盐选】
1. 爽点走反转/信息差/情感悬置，不走"当众打脸"
2. 沿用上文第一人称"我"叙事；只写"我"的所见所感，他人内心只能通过其动作/表情/语言被推测
3. 故事若有核心真相/反转，只释放当前进度该露的信息，不得提前说破后续真相
4. 节末钩子轮换三种：悬念（危险将至/真相半露）、反转（颠覆预期）、情感悬置（误解加深），禁止连续两节同一式

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
      // 对话长期记忆：先压缩再截断——口述设定压进【已确认设定】块，
      // 可跨 40 条窗口存活（否则 sanitizeMessages 会直接丢弃窗口外内容）
      const rawMsgs = Array.isArray(params.messages) ? params.messages : [];
      const { messages: memWindow, memoryBlock: fallbackMemoryBlock } =
        aiUtils.buildChatMemory(rawMsgs);
      let chatMemoryBlock = fallbackMemoryBlock;
      const cleanMessages = memWindow.length
        ? sanitizeMessages(memWindow)
        : [{ role: 'user', content: sanitizePrompt(params.message) }];
      const resolved = await this.host.resolveApiKey(
        params.user_id,
        'chat',
        params.model,
      );

      // 维护版设定记忆（AI 合并去重）：每累计 6 条新作者发言合并一次——
      // 改设定时旧条目被替换删除，不靠模型每次裁决；合并失败回退上面的静态压缩块
      if (params.book_id && rawMsgs.length) {
        try {
          const [bset] = await db
            .select({ extra: schema.book_settings.extra })
            .from(schema.book_settings)
            .where(eq(schema.book_settings.book_id, params.book_id))
            .limit(1);
          const extra = (bset?.extra ?? {}) as Record<string, any>;
          const userMsgs = rawMsgs
            .filter((m: any) => m?.role === 'user')
            .map((m: any) =>
              sanitizePrompt(m.content).replace(/\s+/g, ' ').trim(),
            )
            .filter(Boolean);
          const anchorMap = (extra.chat_settings_anchor ?? {}) as Record<
            string,
            number
          >;
          const anchor = anchorMap[ct] ?? 0;
          if (userMsgs.length - anchor >= 6) {
            const merged = await this.mergeChatSettings(
              resolved.baseUrl,
              resolved.apiKey,
              resolved.model,
              (extra.chat_settings ?? []) as string[],
              userMsgs.slice(anchor),
            );
            if (merged) {
              extra.chat_settings = merged;
              extra.chat_settings_anchor = {
                ...anchorMap,
                [ct]: userMsgs.length,
              };
              await db
                .update(schema.book_settings)
                .set({ extra } as any)
                .where(eq(schema.book_settings.book_id, params.book_id));
            }
          }
          const set = (extra.chat_settings ?? []) as string[];
          if (set.length) {
            chatMemoryBlock = `\n\n【已确认设定——AI 维护的设定集，按时间从旧到新排列；同一事项以靠后的最新条目为准；与最近对话冲突时以最近对话为准】\n${set.join('\n')}\n`;
          }
        } catch {
          /* 设定集维护失败回退静态压缩块 */
        }
      }
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
                    extra.plot_threads = (extra.plot_threads as any[]).map(
                      (t: any) =>
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
        systemPrompt + guideBlock + chatMemoryBlock + factsBlock + handoffBlock,
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

  async streamChatToClient(
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
        await this.host.recordUsage({
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
   * 设定集合并：AI 维护版设定记忆。把作者的新发言合并进现有设定集——
   * 修改/推翻旧设定时旧条目必须删除（解决静态记忆块"新旧设定并存"的冲突问题）。
   * 失败返回 null，调用方回退静态压缩块。
   */
  async mergeChatSettings(
    baseUrl: string,
    apiKey: string,
    model: string,
    existing: string[],
    newLines: string[],
  ): Promise<string[] | null> {
    const prompt = `你是小说设定管理员。把作者的新发言合并进现有设定集。

【现有设定集】${existing.length ? existing.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（空）'}

【新增作者发言】${newLines.map((s, i) => `${i + 1}. ${s}`).join('\n')}

【合并规则】
1. 只保留对创作有约束力的设定（人物/世界观/剧情方向/写作偏好），闲聊不收录
2. 新发言修改或推翻旧设定：用新表述替换旧条目，旧条目必须删除，不得新旧并存
3. 同一事项合并为一条，每条 ≤40 字、具体可执行
4. 未被推翻的旧条目原样保留
5. 按时间从旧到新排列，最多 15 条
【输出】只输出 JSON 字符串数组，不要任何其他文字。`;
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
            { role: 'system', content: prompt },
            { role: 'user', content: '请输出合并后的设定集。' },
          ],
          max_tokens: 1024,
          temperature: 0.3,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) return null;
      const d = await r.json();
      const raw = (d.choices?.[0]?.message?.content ?? '').trim();
      const arrMatch = raw.match(/\[[\s\S]*\]/);
      if (!arrMatch) return null;
      const parsed = JSON.parse(arrMatch[0]);
      if (!Array.isArray(parsed)) return null;
      const cleaned = parsed
        .filter((s: any) => typeof s === 'string' && s.trim())
        .map((s: string) => s.trim().slice(0, 60))
        .slice(0, 15);
      return cleaned.length ? cleaned : null;
    } catch {
      return null;
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
    if (bookId) await this.host.checkBookOwnership(bookId, userId);
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
    if (s.book_id) await this.host.checkBookOwnership(s.book_id, userId);
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
    if (target.book_id)
      await this.host.checkBookOwnership(target.book_id, userId);
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
    if (s.book_id) await this.host.checkBookOwnership(s.book_id, userId);
    else if (s.user_id !== userId) throw new Error('无权访问');
    await db
      .delete(schema.ai_chat_sessions)
      .where(eq(schema.ai_chat_sessions.id, sessionId));
  }
}
