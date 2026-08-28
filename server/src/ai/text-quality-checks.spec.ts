import { detectAiFlavors } from './text-quality-checks';

describe('detectAiFlavors', () => {
  it('检测单段 >2 个破折号', () => {
    const text = '她看着他——那个曾经——不——她不敢想下去的人。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'dash-overuse')).toBe(true);
  });

  it('单段 ≤2 个破折号不报', () => {
    const text = '她看着他——那个曾经不敢想的人。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'dash-overuse')).toBe(false);
  });

  it('检测"不是A而是B"二分壳', () => {
    const text = '她不是害怕孤独，而是害怕被所有人遗忘。';
    const issues = detectAiFlavors(text);
    const hit = issues.find((i) => i.type === 'binary-shell');
    expect(hit).toBeDefined();
    expect(hit!.index).toBeGreaterThanOrEqual(0);
  });

  it('检测句尾补语"终于明白了一切"式', () => {
    const text = '那一刻，她终于明白了一切。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'epiphany-ending')).toBe(true);
  });

  it('检测"恍然大悟/猛地意识到"变体', () => {
    const text = '他恍然大悟，原来一切都是安排好的。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'epiphany-ending')).toBe(true);
  });

  it('短文本中"仿佛/宛如"超过密度上限时报 fantasy-overuse', () => {
    const text = '她仿佛看到了希望，宛如冬日阳光，仿佛一切都还有机会，宛如……';
    const issues = detectAiFlavors(text);
    // 文本 <2000 字,上限为 3;共 4 处命中
    expect(issues.some((i) => i.type === 'fantasy-overuse')).toBe(true);
  });

  it('密度未超限不报 fantasy-overuse', () => {
    const text = '她仿佛看到了希望。阳光很好。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'fantasy-overuse')).toBe(false);
  });

  it('检测句首环境描写(前 60 字无人物)', () => {
    const text =
      '窗外，雨下了一整夜，街道上空无一人，路灯把积水照得发亮。\n\n她推开门。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'env-opening')).toBe(true);
  });

  it('句首环境描写但人物及时出现则不报', () => {
    const text = '窗外，雨下着。她站在窗边，手指贴着玻璃。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'env-opening')).toBe(false);
  });

  it('干净文本零问题', () => {
    const text =
      '她推开门，母亲坐在灯下补衣服。\n\n"怎么才回来。"母亲头也不抬。\n\n她把录取通知书放在桌上。';
    const issues = detectAiFlavors(text);
    expect(issues).toEqual([]);
  });

  it('excerpt 截断为 40 字', () => {
    // 超长段落触发 dash-overuse,excerpt 应截断
    const long = '她' + '看'.repeat(50) + '——' + '想'.repeat(30) + '——他——她';
    const issues = detectAiFlavors(long);
    const hit = issues.find((i) => i.type === 'dash-overuse');
    expect(hit).toBeDefined();
    expect(hit!.excerpt.length).toBeLessThanOrEqual(40);
  });

  it('检测句长过于均匀(20+ 句长度一致)', () => {
    const sent = '她抬头看了看窗外，雨还在下。';
    const text = sent.repeat(22);
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'uniform-sentence-length')).toBe(true);
  });

  it('句长多样时不报 uniform', () => {
    const s = [
      '她推开门，一阵冷风灌进来。',
      '母亲坐在灯下补衣服，头也不抬地说了一句，声音很轻，像怕惊动什么。',
      '"怎么才回来。"',
      '她把录取通知书放在桌上，纸角被雨打湿了一小块。',
      '母亲的手停了，抬头，眼睛里有光。',
      '她笑了，鼻子发酸。',
      '窗外雨声大了，屋檐滴水，一下一下敲在铁皮上。',
    ];
    const text = s.join('\n\n').repeat(3);
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'uniform-sentence-length')).toBe(
      false,
    );
  });

  it('检测段末总结句', () => {
    const text = '他走了。她站在门口。这就是命运。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'summary-ending')).toBe(true);
  });

  it('检测三元排比(三个等长分句)', () => {
    const text = '一针一线，一笔一画，一字一句。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'parallel-triad')).toBe(true);
  });

  it('检测连续 3 句同主语短动作句(subject-action-chain)', () => {
    const text = '她走进去。她看向前方。她停下脚步。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'subject-action-chain')).toBe(true);
  });

  it('连续 2 句同主语不报 subject-action-chain', () => {
    const text = '她走进去。她看向前方，脚下停住。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'subject-action-chain')).toBe(false);
  });

  it('同主语但有长句打断时不报短句连发', () => {
    const text =
      '她走进去。她看向前方。她想起母亲说过的那句话，心里像被什么轻轻揪了一下，很久都没有缓过来。她停下脚步。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'subject-action-chain')).toBe(false);
  });

  it('检测"忽然明白/意识到"解释腔密度(mind-reporting)', () => {
    const text =
      '她忽然明白了。他猛地意识到真相。她终于懂了。我这才反应过来，原来如此。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'mind-reporting')).toBe(true);
  });

  it('解释腔在限内不报 mind-reporting', () => {
    const text = '她忽然明白了。那天之后，一切照旧。';
    const issues = detectAiFlavors(text);
    expect(issues.some((i) => i.type === 'mind-reporting')).toBe(false);
  });
});
