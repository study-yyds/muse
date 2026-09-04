// 拆自 ai.service.ts：creation-ops
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb, schema, mergeJsonb } from '../database/connection';
import { sanitizePrompt } from './ai-prompts';
import * as aiUtils from './ai-utils';
import { registerBookAbort, unregisterBookAbort } from './abort-registry';
import { detectAiFlavors } from './text-quality-checks';
import type { AiHost } from './ai-host';

export class CreationOps {
  constructor(private readonly host: AiHost) {}

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
    const resolved = await this.host.resolveApiKey(userId, 'chat');
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
      await this.host.recordUsage({
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
    const resolved = await this.host.resolveApiKey(
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
      const factors: string[] = aiUtils.extractFactors(premise);
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
      await this.host.recordUsage({
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
    const resolved = await this.host.resolveApiKey(
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
        : await this.host.resolveApiKey(
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
    const parsed = aiUtils.parseSkeletonize(rawText);
    // 解析失败兜底：按原文生成，不阻断创作
    if (!parsed.preview) parsed.preview = synopsis;
    await this.host.recordUsage({
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
    const resolved = await this.host.resolveApiKey(
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
            : await this.host.resolveApiKey(
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
        await this.host.recordUsage({
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

${aiUtils.buildConditionalRules(premise)}

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
          await this.host.recordUsage({
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
            await this.host.recordUsage({
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
        titles = aiUtils.buildTitleFallback(premise).map((t: string) => ({
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

      await this.host.recordUsage({
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
    const resolved = await this.host.resolveApiKey(
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
      ? `【创作方向】\n${params.guide_summary}\n${params.guide_full_log ? `\n【引导讨论记录——对话尾部节选，参考细节】\n${params.guide_full_log.slice(-1500)}\n` : ''}\n【用户初始想法】\n${premise}`
      : premise;
    // 精简版（用于需要结构化输出的 world/outline/chars 步骤，避免 prompt 过长导致格式异常）
    const shortPremise = params.guide_summary
      ? `【创作方向】\n${params.guide_summary.slice(0, 800)}\n${params.guide_full_log ? `【引导讨论记录——对话尾部节选，请严格参考，其中的人物身份和设定不可修改】\n${params.guide_full_log.slice(-1200)}\n` : ''}\n【用户初始想法】\n${premise.slice(0, 500)}`
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
        protagonist = aiUtils.parseProtagonist(protText);
        if (!protagonist) {
          // 解析失败重试一次：主角约束缺失会拖累大纲/章纲质量，重试成本远低于补救成本
          const retryText = await aiCall(
            `${protagonistPrompt}\n\n【上次输出无法解析——本次只输出 JSON 对象】首字符必须是 {，末字符必须是 }，不要代码块、不要解释、不要任何其他文字。`,
            `题材和想法：${shortPremise}\n\n世界观：${worldText.slice(0, 1500)}\n\n请创作主角。`,
            2048,
          );
          protagonist = aiUtils.parseProtagonist(retryText);
        }
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

【对引导结论的最高优先级——若注入有【创作方向】与【引导讨论记录】】
- 【创作方向】中的【已确认设定】逐条检查，每一条都必须在大纲中有对应体现，不得遗漏（如金手指类型、核心冲突、结局方向、已确认的人物关系）
- 大纲不得与已确认设定矛盾；不确定时宁可不扩展，不要替换

【核心要求】
1. 分卷/分段推进：每段有明确的阶段目标，段末解决并引出下一段
2. 递进节奏：每个节点应有实质进展（具体是什么取决于故事本身的驱动力）
3. 格局扩展：故事舞台逐步扩大
4. 每个节点应能制造悬念或期待，让读者想看下一章
5. 节点必须体现主角的动机驱动：主角的每个关键选择都能回溯到他的欲望/缺陷/金手指，禁止主角随波逐流
6. 每个节点必须内置冲突或爽点（打压→反转→打脸，或悬念揭示），摘要用"谁+做了什么+得到什么结果"的直白句式，禁止文艺腔与抽象抒情
7. 主角道德基线：报复/打脸对象必须是真恶人（对方先作恶），情节不得伤害无辜之人（仆从/路人）；灰色行为须有正当理由
8. 能力/金手指的觉醒节点必须在对应节点的摘要中明确写出（如"绝境觉醒异能"），供章纲生成对齐时间线；觉醒节点之前的节点摘要不得出现能力使用，只能写铺垫/伏笔
9. 反派与配角要有多样动机（立场/苦衷/利益），禁止多个节点连续出现"有人看不起主角→被打脸"的同构循环；节点爽点模式按番茄偏好轮换（规则内/信息差打脸、升级养成、情绪价值、悬念揭示）；权威角色（教师/考官/官员）言行须符合其立场利益，不得无理由敌视主角；节点功能轮换：冲突节点不超过一半，收获（升级/资源）、铺垫（关系线/日常）、揭露（真相/伏笔）节点各至少 1 个，冲突节点之间必须有缓冲节点

【数量要求——全程骨架式，必须覆盖到全书结局】
至少输出 10-14 个节点：
- 前 1-2 卷：8-10 个细节点（情节具体、节奏密）
- 后续各卷：每卷 1-2 个粗节点（只写该卷的阶段目标与结果，如"中段：主角离开新手村进入大舞台"）
- 最后一个节点必须是全书结局（大结局+尾声：最终矛盾如何解决、主角归宿）
禁止只写到中段就停。标题简洁有力。

【输出格式——严格遵守】
只输出 JSON 数组，不要任何其他文字。title 精炼有网文感（8字以内），summary 简短有力（30字以内，写清谁+做了什么+结果）：
[{"title":"意外之喜","summary":"主角在山洞中发现前人遗留的秘籍，从此走上修行之路"}]`;

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

      // 提前保存引导讨论上下文：extendChapterOutlines 从 settings 读取创作方向
      // （guide_summary），章纲生成必须吃引导结论
      if (params.guide_summary || params.guide_full_log) {
        // JSONB 原子合并（不读改写，避免与并发生成互相覆盖）
        await db
          .update(schema.book_settings)
          .set({
            extra: mergeJsonb(schema.book_settings.extra, {
              ...(params.guide_summary
                ? { guide_summary: params.guide_summary }
                : {}),
              ...(params.guide_full_log
                ? { guide_full_log: params.guide_full_log }
                : {}),
            }),
          })
          .where(eq(schema.book_settings.book_id, bookId));
      }

      // Step 3.5: 生成前 10 章章纲（场景级：目标/阻碍/爽点/钩子）
      // 卷纲颗粒度≈10万字/节点，写作时无上位约束会水；章纲补场景级控制
      // 复用 extendChapterOutlines：与"写作页续生章纲"同一套 prompt 与规则，避免两处维护漂移
      send('step', {
        step: 'chapter-outlines',
        status: 'generating',
        label: '生成前10章章纲',
      });
      try {
        const r = await this.host.extendChapterOutlines(
          params.user_id,
          bookId,
          params.model,
          params.key_id,
          10,
          undefined,
        );
        chapterOutlines = r.lines ?? [];
        if (chapterOutlines.length === 0) {
          send('step', {
            step: 'chapter-outlines',
            status: 'done',
            label: '章纲生成失败（无法解析）——可到写作页点"生成章纲"重试',
          });
        } else {
          send('step', {
            step: 'chapter-outlines',
            status: 'done',
            label: `章纲已生成（${chapterOutlines.length} 章）`,
            preview: chapterOutlines.slice(0, 3).join('\n'),
          });
        }
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

根据以下小说设定，生成 5 个书名（每个 12-22 字，符合番茄 2026 主流长句体），五种类型各一个：悬念式、金手指承诺式（身份+金手指+结果承诺，如《退婚当天，我靠种田系统逆袭成首富》）、反差式、爽点式、情感式。每个书名必须传达三层信息：题材标签+核心冲突+结果期待，忌文艺抽象、忌设定全亮。直接输出 5 行，每行一个，不要编号、不要引号、不要解释。每行只允许书名本身：禁止说明文字、标题符号（#/**）、冒号句式。`;
      const titleSummary = `题材：${fullPremise.slice(0, 500)}\n\n世界观：${worldText.slice(0, 500)}`;
      const titleText = (await aiCall(titlePrompt, titleSummary, 500)).trim();
      const titleLines = titleText
        .split('\n')
        .map((l) =>
          l
            .replace(/^\d+[.、]\s*/, '')
            .replace(/^[-*•]\s*/, '')
            .trim(),
        )
        .filter((l) => {
          // 书名形态校验：丢弃模型跑偏时输出的说明性段落
          // （markdown 标题/加粗/冒号句式/带引号/超长段落，实测出现"## 三、关键设定与勾子"式输出）
          if (l.length < 2 || l.length > 30) return false;
          if (/[#*_`>|「」“”"']/.test(l)) return false;
          if (/[：:]/.test(l)) return false;
          return true;
        })
        .slice(0, 5);
      const fallbackTitles = aiUtils.buildTitleFallback(premise);
      const finalTitle = (
        titleLines[0] ||
        fallbackTitles[0] ||
        '未命名作品'
      ).slice(0, 40);
      // 书名候选（五种类型各一）：合格行不足 2 条时不给候选区（前端走"直接进入"兜底）
      const TITLE_STYLES = [
        '悬念式',
        '金手指承诺式',
        '反差式',
        '爽点式',
        '情感式',
      ];
      const titleCandidates =
        titleLines.length >= 2
          ? titleLines
              .slice(0, 5)
              .map((t, i) => ({ style: TITLE_STYLES[i] ?? '候选', title: t }))
          : [];
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

      // 保存引导讨论上下文 + 章纲，供后续 AI 对话使用（JSONB 原子合并）
      {
        await db
          .update(schema.book_settings)
          .set({
            extra: mergeJsonb(schema.book_settings.extra, {
              ...(params.guide_summary
                ? { guide_summary: params.guide_summary }
                : {}),
              ...(params.guide_full_log
                ? { guide_full_log: params.guide_full_log }
                : {}),
              ...(chapterOutlines.length
                ? { chapter_outlines: chapterOutlines }
                : {}),
            }),
          })
          .where(eq(schema.book_settings.book_id, bookId));
      }

      // 完成：候选 ≥2 时带出候选区（候选不足则走前端"直接进入"兜底）
      send('done', {
        book_id: bookId,
        title: finalTitle,
        titles: titleCandidates.length > 1 ? titleCandidates : undefined,
      });
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
  async parseAndSaveWorld(bookId: string, aiText: string) {
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
  async parseAndSaveOutline(bookId: string, aiText: string) {
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
        // 事务化：N 条节点插入全部成功或全部回滚（避免中途失败留半套大纲）
        await db.transaction(async (tx) => {
          for (let i = 0; i < nodes.length; i++) {
            await tx.insert(schema.outline_chapters).values({
              outline_id: outline.outline_id,
              title: nodes[i].title,
              status: 'planned',
              summary: nodes[i].summary,
              sort_order: i + 1,
            });
          }
        });
      }
    }
    return nodes.length;
  }

  // 解析并保存角色
  async parseAndSaveCharacters(bookId: string, aiText: string) {
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
