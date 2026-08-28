import { authFetch } from "@/services/api";
import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface CharacterTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  data: {
    name: string;
    gender: string;
    personality: string;
    catchphrase: string;
    speech_style: string;
    identity: string;
    backstory: string;
    motivation: string;
  };
}

const TEMPLATES: CharacterTemplate[] = [
  {
    id: "cold-swordsman",
    name: "冷面剑客",
    category: "仙侠/武侠",
    description: "寡言少语、剑术高超的独行侠，背负着不为人知的过去",
    data: {
      name: "",
      gender: "男",
      personality: "外表冷漠、不善言辞，内心重情重义，对认定的朋友愿意付出一切",
      catchphrase: "……随你。",
      speech_style: "简短、冷淡，极少主动开口，每句话不超过十个字",
      identity: "流浪剑客",
      backstory: "幼年目睹师门被灭，从此独自行走江湖寻找仇人。剑法自成一派，曾一剑斩杀魔教护法而名震天下",
      motivation: "报仇雪恨，寻找当年灭门惨案的真相",
    },
  },
  {
    id: "scheming-strategist",
    name: "腹黑军师",
    category: "历史/权谋",
    description: "表面温文尔雅，实则心思深沉，算无遗策的谋士",
    data: {
      name: "",
      gender: "男",
      personality: "外表温和有礼，内心精于算计。微笑背后藏着刀锋，但并非无情之人",
      catchphrase: "这盘棋，才刚刚开始。",
      speech_style: "文雅、喜欢用典故和隐喻，话中有话",
      identity: "幕僚/军师",
      backstory: "出身寒门，凭借过人智谋一步步爬到权力中心。曾辅佐三代主公，每一任都死得不明不白",
      motivation: "打破门阀世袭，让寒门子弟也能出人头地",
    },
  },
  {
    id: "genki-girl",
    name: "元气少女",
    category: "轻小说/校园",
    description: "永远充满活力、感染力极强的阳光少女",
    data: {
      name: "",
      gender: "女",
      personality: "乐观开朗、精力充沛、天然呆。遇到挫折从不气馁，总是先行动再思考",
      catchphrase: "没问题的！交给我吧～",
      speech_style: "活泼、语气词多、偶尔冒出奇怪的自创词汇",
      identity: "高中生/冒险者",
      backstory: "在和平的小镇长大，向往冒险故事中的英雄。某天意外获得了神秘力量",
      motivation: "成为能够保护所有人的英雄",
    },
  },
  {
    id: "antihero",
    name: "亦正亦邪",
    category: "都市/悬疑",
    description: "游走在善恶边缘的灰色角色，亦敌亦友",
    data: {
      name: "",
      gender: "男",
      personality: "亦正亦邪、随性洒脱，做事全凭心情。不遵守任何规则，但有自己的底线",
      catchphrase: "正义？邪恶？不过是一枚硬币的两面罢了。",
      speech_style: "慵懒、带讽刺意味、偶尔冒出深刻的哲理",
      identity: "情报贩子/浪人",
      backstory: "曾是顶级特工，被组织背叛后假死脱身。如今游走于各方势力之间",
      motivation: "活着，顺便看看这个世界还有什么有意思的事",
    },
  },
  {
    id: "ice-queen",
    name: "高冷女王",
    category: "都市/奇幻",
    description: "能力超群、气场强大的女性角色，冷漠外表下藏着柔软的心",
    data: {
      name: "",
      gender: "女",
      personality: "高冷、完美主义、刀子嘴豆腐心。对自己和他人都极其严格",
      catchphrase: "不要浪费我的时间。",
      speech_style: "简洁有力、命令式口吻、偶尔毒舌",
      identity: "CEO/女王/强者",
      backstory: "年少时就扛起了家族重担，在残酷的商业/政治斗争中杀出一条血路。从不示弱，因为一旦示弱就会被吞噬",
      motivation: "守护自己拼下的一切，证明女性不需要依附任何人",
    },
  },
  {
    id: "reluctant-hero",
    name: "被迫英雄",
    category: "奇幻/冒险",
    description: "本来只想平凡生活，却被命运推着成为英雄的普通人",
    data: {
      name: "",
      gender: "男",
      personality: "胆怯、爱抱怨、但关键时刻从不退缩。嘴硬心软，每次说不干最后还是冲在最前面",
      catchphrase: "为什么总是我啊……",
      speech_style: "抱怨式、内心独白多、紧张时结巴",
      identity: "普通村民/学生",
      backstory: "在偏远村庄长大，最大的梦想是开一家面包店。直到某天，一个受伤的神秘来客带来了改变一切的预言",
      motivation: "先活下去，再想办法回到正常生活",
    },
  },
];

interface Props {
  onSelect: (template: CharacterTemplate | null) => void;
}

export function TemplatePicker({ onSelect }: Props) {
  const [templates, setTemplates] = useState<CharacterTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch("/api/templates?type=character")
      .then((r) => r.json())
      .then((d) => {
        const items = (d.data ?? []).map((t: any) => ({
          id: t.template_id, name: t.name, category: t.category,
          description: t.description, data: t.data,
        }));
        setTemplates(items.length > 0 ? items : TEMPLATES);
      })
      .catch(() => setTemplates(TEMPLATES))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <Button variant="outline" className="w-full" onClick={() => onSelect(null)}>
        空白创建
      </Button>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">或从模板创建</p>
        <ScrollArea className="max-h-64">
          {loading && <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>}
          <div className="space-y-2">
            {templates.map((tpl) => (
              <Card
                key={tpl.id}
                className={cn(
                  "cursor-pointer transition-shadow hover:shadow-md"
                )}
                onClick={() => onSelect(tpl)}
              >
                <CardContent className="p-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {tpl.name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {tpl.description}
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">
                      {tpl.category}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

export { TEMPLATES };
