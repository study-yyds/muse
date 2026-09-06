// AI 纯函数工具层：从 ai.service.ts 拆出的静态纯函数（无副作用、可单测）。
// ai.service.ts 上保留同名静态入口委托到这里，既有调用与测试零改动。

import { GENRE_KNOWLEDGE, sanitizePrompt } from './ai-prompts';

/**
 * 从引导摘要中按段提取（slice 截断会把中部的【关键节点】/【已确认设定】丢掉，
 * 导致下游生成颠倒阶段顺序、越过设定边界——必须按段提取）
 */
export function extractGuideSections(summary: string): {
  theme: string;
  keyNodes: string;
  confirmed: string;
} {
  const extract = (marker: string) => {
    const m = (summary ?? '').match(
      new RegExp(`${marker}】([\\s\\S]*?)(?=【[^】]+】|$)`),
    );
    return (m?.[1] ?? '').trim();
  };
  return {
    theme: extract('【故事主题'),
    keyNodes: extract('【关键节点'),
    confirmed: extract('【已确认设定'),
  };
}

// 构建引导模式 system prompt
export function buildGuideSystemPrompt(
  context?: string,
  type?: string,
  contextLabel = '用户的初始想法',
): string {
  const isShort = type === 'short';
  const typeGuide = isShort
    ? `\n【篇幅注意——短篇】
- 作者要写的是短篇（8000-20000字），故事结构应紧凑聚焦
- 引导时侧重：单一核心冲突、1-3个关键角色、一个强有力的结尾反转`
    : `\n【篇幅注意——长篇网文】
- 作者要写的是长篇网络小说。从作者的脑洞中识别这个故事的驱动力，围绕它来提问，不预设模板`;

  return `你是一位创作导师，帮作者把模糊的想法打磨成精彩的故事。${typeGuide}

${GENRE_KNOWLEDGE}

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
【已确认设定】作者明确敲定的设定逐条列出（金手指/人物关系/背景/结局方向），不得遗漏
【叙事风格】视角 + 节奏
\`\`\`

【摘要硬约束——输出摘要前逐条核对，违反即为失败】
1. **只写作者确认过的内容**：作者在对话中否定过、或后来推翻改掉的说法一律不得写入；同一事项有多轮说法时，以对话中作者最新的决定为准
2. **时间线忠实于作者给出的顺序**：不得自行插入阶段、颠倒先后、混淆阶段归属（如把"考入大学"写成"考入高中"、把觉醒/排位战/高考的先后写反这类硬错误）
3. **能力与金手指只按作者最终的定义写**：不得添加作者没提过的能力形态、来源、代价或身世谜团（作者没说过"预知"，就不要写出预知碎片；作者没提过身世线，就不要编来历）
4. **不得继承旧摘要**：如果对话中已出现过摘要文本，输出新摘要时必须基于对话最新结论重新整理，逐条重写，不得复制旧摘要的表述；作者后来推翻过的设定，即使出现在旧摘要或早期讨论中，也一律不得写入新摘要

5. **就绪标记**：当摘要所需的【主题/主角/驱动力/关键节点/结局方向】都已明确、足够支撑生成时，在回复的最后单独一行输出标记 \`[GUIDE_READY]\`（只输出标记本身，不要解释）；信息还不足、或用户刚推翻了设定时不要输出。这只是提示——用户随时可以自己点击"开始生成"，无需等待标记
${context ? `\n【${contextLabel}】\n${context}` : ''}`;
}

/**
 * 大纲节点 JSON 解析（卷纲/章纲生成结果）：
 * 容错链——代码块 → 中括号数组提取；过滤非法节点；≥3 个有效节点才返回
 */
export function parseOutlineNodesJson(
  aiText: string,
): Array<{ title: string; summary: string }> {
  const text = aiText ?? '';
  const attempts: string[] = [];
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) attempts.push(codeBlock[1].trim());
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) attempts.push(arrMatch[0]);
  for (const t of attempts) {
    try {
      const parsed = JSON.parse(t);
      if (!Array.isArray(parsed)) continue;
      const nodes = parsed
        .filter(
          (n: any) =>
            n && typeof n.title === 'string' && typeof n.summary === 'string',
        )
        .map((n: any) => ({
          title: n.title.trim().slice(0, 20),
          summary: n.summary.trim().slice(0, 60),
        }))
        .filter((n) => n.title && n.summary);
      if (nodes.length >= 3) return nodes;
    } catch {
      /* 尝试下一个 */
    }
  }
  return [];
}

/**
 * 题材条件规则构建（纯函数，可单测）：
 * 复仇/悬疑类注入"信息差不摊牌"；甜宠/治愈类注入"允许坦白"；有加害者题材注入"代价铁律"
 */
export function buildConditionalRules(premise: string): string {
  const p = premise || '';
  const hasRevenge =
    /复仇|打脸|虐渣|报复|逆袭|重生|穿越|穿书|预知|怪谈|悬疑|惊悚|反转/.test(p);
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
export function buildRecap(
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
export function buildTitleFallback(premise: string): string[] {
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
export function extractFactors(s: string): string[] {
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
export function selectWorldSections(
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
export function parseChapterOutlines(text: string): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+[.、)）]\s*/, ''),
    )
    .filter((l) => /^第[一二三四五六七八九十百\d]+章\s*[|｜：: ]/.test(l))
    .slice(0, 10);
}

/**
 * 从卷纲文本提取能力节点，生成显式时间线约束块。
 * 模型自行推断"觉醒在第几章"不可靠（曾出现第 1 章就用双系、觉醒章被跳过的错误），
 * 改为把能力节点编号和禁用区间直接写入 prompt。
 */
export function buildCapabilityTimeline(outlineText: string): string {
  const text = outlineText ?? '';
  let entries: string[] = [];
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        entries = parsed
          .filter((n: any) => n && (n.title || n.summary))
          .map((n: any) => `${n.title ?? ''}：${n.summary ?? ''}`);
      }
    } catch {
      entries = [];
    }
  }
  if (!entries.length) {
    entries = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const hits = entries
    .map((e, i) => ({ no: i + 1, e }))
    .filter(({ e }) => /觉醒|获得|解锁|激活|突破/.test(e));
  if (!hits.length) return '';
  const first = hits[0];
  const list = hits
    .map(
      (h) =>
        `- 卷纲第 ${h.no} 个节点为能力节点：${h.e.replace(/^- /, '').slice(0, 80)}`,
    )
    .join('\n');
  return `【能力时间线——按卷纲严格执行】
${list}
- 本批章纲按卷纲节点顺序推进，不得跳过能力节点；每个能力节点必须在对应顺序的某章中完整写出觉醒/获得过程（绝境、触发条件、代价），不得默认主角已拥有
- 觉醒/激活事件不得整体拖后：节点摘要中写明的激活是其语义核心，必须落在该节点对应章节区间的开头部分——禁止把同一个节点拆成"铺垫数章后才激活"（节点已是规划最小颗粒，激活应尽早落位）
- 第 ${first.no} 个节点（首个能力节点）之前的章节：主角不得使用任何超自然能力（预判、瞬移、共鸣等异能一律禁用），只能靠体术/头脑/环境；可埋伏笔（旧物发热、异常直觉），但不得点破、不得实际生效
- 首个能力节点对应章节及之后：方可使用该能力，觉醒后首次使用必须写明"第一次用"的镜头`;
}

/** 解析主角 JSON：容错链——代码块/name锚定/花括号提取 → 常见 JSON 语病修复 → 中文字段名归一 → 正则抢救；无 name 返回 null */
export function parseProtagonist(aiText: string): any {
  const text = aiText ?? '';
  const attempts: string[] = [];
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) attempts.push(codeBlock[1].trim());
  const objMatch = text.match(/\{[\s\S]*"name"[\s\S]*\}/);
  if (objMatch) attempts.push(objMatch[0]);
  const lastOpen = text.lastIndexOf('{');
  const lastClose = text.lastIndexOf('}');
  if (lastOpen >= 0 && lastClose > lastOpen) {
    attempts.push(text.slice(lastOpen, lastClose + 1));
  }

  // 中文键名归一（模型常输出 姓名/性别 而非 name/gender）
  const KEY_ALIAS: Record<string, string> = {
    姓名: 'name',
    名字: 'name',
    性别: 'gender',
    性格: 'personality',
    身份: 'identity',
    背景: 'backstory',
    动机: 'motivation',
    口头禅: 'catchphrase',
    说话风格: 'speech_style',
    外貌: 'appearance',
  };
  const normalize = (raw: any): any => {
    const obj = Array.isArray(raw) ? raw[0] : raw;
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.name) {
      for (const [k, v] of Object.entries(obj)) {
        const target = KEY_ALIAS[k];
        if (target && obj[target] == null) obj[target] = v;
      }
    }
    return obj.name ? obj : null;
  };
  // 常见 LLM JSON 语病修复：尾逗号、中文引号、中文冒号
  const repair = (t: string): string =>
    t
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[“”]/g, '"')
      .replace(/([{,]\s*)"([^"]{1,40}?)"\s*：/g, '$1"$2":');
  for (const t of attempts) {
    try {
      const parsed = JSON.parse(t);
      const obj = normalize(parsed);
      if (obj) return obj;
    } catch {
      /* 尝试下一个提取 */
    }
    const repaired = repair(t);
    if (repaired !== t) {
      try {
        const parsed = JSON.parse(repaired);
        const obj = normalize(parsed);
        if (obj) return obj;
      } catch {
        /* 修复后仍失败，继续 */
      }
    }
  }
  // 正则抢救：从散文中按"字段：值"提取（最少拿到姓名即可保留主角约束）
  const pick = (label: string) => {
    const m = text.match(
      new RegExp(`(?:${label})\\s*[:：]\\s*["']?([^"'，,。\\n]{1,30})`),
    );
    return m ? m[1].trim() : '';
  };
  const name = pick('姓名') || pick('名字') || pick('name');
  if (!name) return null;
  return {
    name,
    gender: pick('性别'),
    personality: pick('性格'),
    identity: pick('身份'),
    backstory: pick('背景'),
    motivation: pick('动机'),
    catchphrase: pick('口头禅'),
    speech_style: pick('说话风格'),
    appearance: pick('外貌'),
  };
}

/**
 * 对话长期记忆（引导/写作面板共用）：长对话时把早期"作者的发言"压缩成
 * 【已确认设定】块注入 system。切割策略：条数设上限、字数设预算，
 * 两者先到先停，只切在完整消息之间（消息长度方差大：纯条数会让
 * token 失控，纯字数会切断半句话）。必须在 sanitizeMessages 截断之前调用，
 * 否则 40 条窗口外的设定会被直接丢弃。
 */
export function buildChatMemory(
  messages: { role: string; content: string }[],
): {
  messages: { role: string; content: string }[];
  memoryBlock: string;
} {
  const KEEP_MAX_MSGS = 8; // 近窗条数上限：保证对话轮次完整
  const KEEP_MAX_CHARS = 4000; // 近窗字数预算：保证 token 可控
  const totalChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  // 全部历史都在预算内（近窗 4000 + 记忆块 1500 余量）→ 不压缩，保完整连贯
  if (totalChars <= KEEP_MAX_CHARS + 1500) {
    return { messages, memoryBlock: '' };
  }
  // 近窗：从最新往回取整条消息，字数预算与条数上限先到先停（绝不切半句）
  let chars = 0;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0 && kept < KEEP_MAX_MSGS; i--) {
    const len = messages[i].content?.length ?? 0;
    if (kept > 0 && chars + len > KEEP_MAX_CHARS) break;
    chars += len;
    kept++;
  }
  const recent = messages.slice(messages.length - kept);
  const userLines = messages
    .slice(0, messages.length - kept)
    .filter((m) => m.role === 'user')
    .map((m) => sanitizePrompt(m.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((c) => (c.length > 200 ? c.slice(0, 200) + '…' : c));
  if (!userLines.length) {
    return { messages: recent, memoryBlock: '' };
  }
  // 记忆块总量封顶 2000 字，从最旧的开始丢（越近的设定越重要）
  let total = 0;
  const keptLines: string[] = [];
  for (let i = userLines.length - 1; i >= 0; i--) {
    const l = userLines[i];
    total += l.length;
    if (total > 2000) break;
    keptLines.unshift(l); // 保持时间顺序
  }
  const memoryBlock = `\n\n【已确认设定——你和作者在前面讨论中敲定的内容，按时间顺序排列；同一事项有多条发言时，以靠后的最新发言为准；若与最近对话中的新指示冲突，一律以最近对话为准】\n${keptLines.join('\n')}\n`;
  return { messages: recent, memoryBlock };
}

/**
 * 梗概骨架化结果解析：逐行提取 骨架/梗概/风险 三段，
 * 骨架化生成与逻辑体检共用（自写梗概功能）。
 */
export function parseSkeletonize(text: string): {
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
