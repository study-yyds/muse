/**
 * 代码级确定性 AI 味检测（纯函数，可单测）。
 * 依据：Matlin et al. 2025——模型无法感知自己的悬念/质量曲线，
 * 句式类问题不能靠模型自评，下沉为可计算的外部特征。
 * 检测结果注入精修 prompt 做"逐条判断修复"，而非让模型自己找问题。
 */

export interface TextQualityIssue {
  type: string;
  /** 命中位置在原文中的字符偏移 */
  index: number;
  /** 命中片段（截断） */
  excerpt: string;
}

export function detectAiFlavors(text: string): TextQualityIssue[] {
  const issues: TextQualityIssue[] = [];
  const push = (type: string, index: number, excerpt: string) =>
    issues.push({ type, index, excerpt: excerpt.slice(0, 40) });

  const paragraphs = text.split(/\n{2,}/);

  // 段级检查
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const idx = text.indexOf(para);

    // 1. 破折号密度：单段 >2 个 "——"
    const dashCount = (para.match(/——/g) ?? []).length;
    if (dashCount > 2) push('dash-overuse', idx, para);

    // 2. "不是A而是B" 二分壳
    const binary = para.match(/不是.{1,30}而是/);
    if (binary) push('binary-shell', idx + (binary.index ?? 0), binary[0]);

    // 3. 句尾补语："终于明白/恍然大悟/猛地意识到/忽然懂了 + 一切/过来/什么/原来"
    const epiphany = para.match(
      /(?:终于明白|恍然大悟|猛地意识到|忽然(?:明白|懂了))(?:了)?[，。]?(?:一切|过来|什么|原来)/,
    );
    if (epiphany)
      push('epiphany-ending', idx + (epiphany.index ?? 0), epiphany[0]);

    // 5. 句首环境描写：环境名词开头且前 60 字内无人物代词
    if (/^(?:天空|夜色|雨|风|阳光|月光|窗外|街灯|雾)/.test(para.trim())) {
      const head = para.trim().slice(0, 60);
      if (!/[他她我你]/.test(head)) push('env-opening', idx, para);
    }
  }

  // 4. 结构维度(UMD/DeepMind 研究:只修词汇不降检测率,结构破绽才是持久信号)
  // 4a. 句长均匀度:≥60% 句子长度落在均值±35% 内(总句数 ≥20 时)
  const sentences = text
    .split(/[。!！?？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (sentences.length >= 20) {
    const lens = sentences.map((s) => s.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const uniform = lens.filter(
      (l) => l >= avg * 0.65 && l <= avg * 1.35,
    ).length;
    if (uniform / lens.length >= 0.6) {
      push(
        'uniform-sentence-length',
        0,
        `句长过于均匀(均值${avg.toFixed(0)}字,${Math.round((uniform / lens.length) * 100)}% 句子落在±35%内)`,
      );
    }
  }
  // 4b. 段末总结句:段落以"这就是/这便是/原来如此/一切的一切"式总结收尾
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const idx = text.indexOf(para);
    const lastSent =
      para
        .split(/[。!！?？]/)
        .filter((s) => s.trim())
        .pop() ?? '';
    if (
      /^(?:这|那)(?:就是|便是|才是|原来)|原来如此|一切的一切|命运的齿轮/.test(
        lastSent.trim(),
      ) &&
      lastSent.length < 40
    ) {
      push('summary-ending', idx + Math.max(0, para.length - 40), lastSent);
    }
  }
  // 4c. 三元排比:连续 3 个分句长度相同(≥4 字)
  const triads = text.match(
    /[一-鿿\w，,]{4,}[，,][一-鿿\w，,]{4,}[，,][一-鿿\w]{4,}[。!！]/g,
  );
  if (triads) {
    for (const t of triads.slice(0, 5)) {
      const parts = t.split(/[，,]/).map((s) => s.length);
      if (
        parts.length === 3 &&
        Math.abs(parts[0] - parts[1]) <= 1 &&
        Math.abs(parts[1] - parts[2]) <= 1
      ) {
        const idx = text.indexOf(t);
        push('parallel-triad', idx, t);
      }
    }
  }

  // 5. 句首主语重复:连续 ≥5 句以同一主语开头(代词"她…她…"或人名"阿沅…阿沅…"),
  // AI 味的强特征——模型逐句生成时主语惯性
  {
    const firstToken = (s: string): string => {
      const t = s.trim();
      const pronoun = t.match(/^(她|他|我|你)/);
      if (pronoun) return pronoun[1];
      return t.slice(0, 2);
    };
    let run = 0;
    let maxRun = 0;
    let maxRunStart = 0;
    let curStart = 0;
    let prevToken = '';
    // 7. 主语+动作短句连发(更严,网文去 AI 味共识线):
    // 连续 ≥3 句同代词开头且均为短动作句(≤30 字)——
    // "她走进去。她看向前方。她停下脚步。"式,修法:合并句子/部位物件做主/承前省略。
    // 注意:外层 sentences 过滤 ≥8 字会漏掉 4-6 字的短句连发,此处单独用 ≥4 字切分
    const shortSentences = text
      .split(/[。!！?？\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4);
    let shortRun = 0;
    let shortRunStart = 0;
    let shortReported = false;
    let shortPrev = '';
    for (const s of shortSentences) {
      const tok = firstToken(s);
      const isSubjectish = /^(?:她|他|我|你)$/.test(tok);
      const isShort = s.length <= 30;
      if (isSubjectish && isShort && (shortRun === 0 || tok === shortPrev)) {
        // 首句即开始计数(shortRun===0 时无须与前句同),后续须与前句同主语
        if (shortRun === 0) shortRunStart = text.indexOf(s);
        shortRun += 1;
        if (shortRun >= 3 && !shortReported) {
          shortReported = true;
          push(
            'subject-action-chain',
            shortRunStart,
            `连续 ${shortRun} 句同主语短动作句——合并句子/换部位物件做主/承前省略`,
          );
        }
      } else {
        shortRun = 0;
      }
      shortPrev = tok;
    }
    // 主检测:≥5 句同主语(含人名式"阿沅…阿沅…")
    for (const s of sentences) {
      const tok = firstToken(s);
      const isSubjectish =
        /^(?:她|他|我|你)$/.test(tok) || /^[一-鿿]{2}$/.test(tok);
      if (isSubjectish && tok === prevToken) {
        if (run === 0) curStart = text.indexOf(s);
        run += 1;
        if (run > maxRun) {
          maxRun = run;
          maxRunStart = curStart;
        }
      } else {
        run = 0;
      }
      prevToken = tok;
    }
    if (maxRun >= 5) {
      push(
        'subject-repetition',
        maxRunStart,
        `连续 ${maxRun} 句以同一主语开头——改为动作/对话/环境开头交替`,
      );
    }
  }

  // 6. 称谓登记(只提取不判定):"老X/小X"式称谓汇总,
  // 供精修核对是否有同一人被写成不同姓氏(如守墓人前后叫"老王/老郑")
  const nicknames = new Set(
    (text.match(/[老小][一-鿿]/g) ?? []).map((s) => s.trim()),
  );
  if (nicknames.size >= 2) {
    push(
      'name-variants',
      0,
      `称谓清单:${[...nicknames].join('、')}——逐条核对是否存在同一人被写成不同姓氏(子女随父姓或母姓都合法,以设定为准,代码不判定)`,
    );
  }

  // 6. "仿佛/宛如/像是/在那一刻" 全文密度：每 2000 字至多 3 处
  const fantasyRe = /仿佛|宛如|像是|在那一刻/g;
  const fantasyHits: Array<{ index: number; ctx: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = fantasyRe.exec(text)) !== null) {
    fantasyHits.push({
      index: m.index,
      ctx: text.slice(Math.max(0, m.index - 8), m.index + 8),
    });
  }
  const fantasyCount = fantasyHits.length;
  const densityLimit = Math.max(3, Math.floor(text.length / 2000));
  if (fantasyCount > densityLimit) {
    const spots = fantasyHits
      .slice(0, 5)
      .map((h) => `…${h.ctx}…`)
      .join('｜');
    push(
      'fantasy-overuse',
      0,
      `共 ${fantasyCount} 处（限 ${densityLimit}）。位置：${spots}`,
    );
  }

  // 8. 叙述者解释腔:"忽然明白/意识到/终于懂了"式替读者下结论
  // (网文去 AI 味共识:删解释腔,让读者自己得出结论),全文每 3000 字限 2 处
  {
    const mindRe =
      /(?:忽然|猛地|终于|这才)(?:明白|意识到|懂了|反应过来)|恍然大悟|豁然开朗/g;
    const hits: Array<{ index: number; ctx: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = mindRe.exec(text)) !== null) {
      hits.push({
        index: m.index,
        ctx: text.slice(Math.max(0, m.index - 10), m.index + 12),
      });
    }
    const limit = Math.max(2, Math.floor(text.length / 3000) * 2);
    if (hits.length > limit) {
      const spots = hits
        .slice(0, 5)
        .map((h) => `…${h.ctx}…`)
        .join('｜');
      push(
        'mind-reporting',
        0,
        `共 ${hits.length} 处解释腔（限 ${limit}）。位置：${spots}`,
      );
    }
  }

  return issues;
}
