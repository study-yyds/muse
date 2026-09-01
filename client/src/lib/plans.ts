/**
 * 套餐档位定义（计费口径：生成字数）
 * 支付渠道接入后，升级 = 调 users.monthly_words_quota（admin 或支付回调）
 */
export interface Plan {
  id: string;
  name: string;
  price: string;
  words: number; // 每月字数额度（-1 = 不限）
  desc: string;
}

export const PLANS: Plan[] = [
  { id: "free", name: "免费版", price: "¥0", words: 30000, desc: "3 万字/月，全部基础功能" },
  { id: "basic", name: "基础版", price: "¥19/月", words: 300000, desc: "30 万字/月" },
  { id: "pro", name: "专业版", price: "¥49/月", words: 1000000, desc: "100 万字/月 + 全部高级功能" },
];

/** 按额度匹配当前档位名（未匹配的视为自定义额度） */
export function planNameFor(wordsQuota: number | null): string {
  if (wordsQuota == null) return "不限额度";
  const hit = PLANS.find((p) => p.words === wordsQuota);
  return hit ? hit.name : "自定义额度";
}
