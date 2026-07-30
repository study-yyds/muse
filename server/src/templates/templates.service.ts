import { Injectable } from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class TemplatesService {
  async list(params: { type?: string; category?: string }) {
    const db = getDb();
    const conditions = [];

    if (params.type) conditions.push(eq(schema.templates.type, params.type));
    if (params.category)
      conditions.push(eq(schema.templates.category, params.category));
    conditions.push(isNull(schema.templates.creator_user_id)); // 只查预置模板

    return db
      .select()
      .from(schema.templates)
      .where(and(...conditions));
  }

  async get(id: string) {
    const db = getDb();
    const [tpl] = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.template_id, id))
      .limit(1);
    return tpl ?? null;
  }

  async create(
    userId: string,
    data: {
      name: string;
      type: string;
      category: string;
      description?: string;
      data: any;
    },
  ) {
    const db = getDb();
    const [tpl] = await db
      .insert(schema.templates)
      .values({
        ...data,
        creator_user_id: userId,
        is_preset: false,
        is_public: true,
      })
      .returning();
    return tpl;
  }

  async delete(id: string) {
    const db = getDb();
    await db
      .delete(schema.templates)
      .where(eq(schema.templates.template_id, id));
  }

  // 预置种子数据
  async seedPresets() {
    const db = getDb();
    const existing = await db
      .select({ id: schema.templates.template_id })
      .from(schema.templates)
      .where(isNull(schema.templates.creator_user_id))
      .limit(1);
    if (existing.length > 0) return; // 已播种

    const presets = [
      {
        name: '冷面剑客',
        type: 'character',
        category: '仙侠/武侠',
        description: '寡言少语、剑术高超的独行侠',
        data: {
          name: '',
          gender: '男',
          personality: '外表冷漠、不善言辞，内心重情重义',
          catchphrase: '……随你。',
          speech_style: '简短冷淡',
          identity: '流浪剑客',
          backstory: '幼年目睹师门被灭，独自寻仇',
          motivation: '报仇雪恨',
        },
      },
      {
        name: '腹黑军师',
        type: 'character',
        category: '历史/权谋',
        description: '表面温文尔雅，实则心思深沉',
        data: {
          name: '',
          gender: '男',
          personality: '外表温和，内心精于算计',
          catchphrase: '这盘棋，才刚刚开始。',
          speech_style: '文雅、用典、话中有话',
          identity: '幕僚/军师',
          backstory: '寒门出身，凭智谋爬到权力中心',
          motivation: '打破门阀世袭',
        },
      },
      {
        name: '元气少女',
        type: 'character',
        category: '轻小说/校园',
        description: '永远充满活力、感染力极强的阳光少女',
        data: {
          name: '',
          gender: '女',
          personality: '乐观开朗、精力充沛、天然呆',
          catchphrase: '没问题的！交给我吧～',
          speech_style: '活泼、语气词多',
          identity: '高中生/冒险者',
          backstory: '在和平小镇长大，某天获得神秘力量',
          motivation: '成为能保护所有人的英雄',
        },
      },
      {
        name: '赛博朋克世界',
        type: 'world',
        category: '科幻',
        description: '高科技低生活的反乌托邦',
        data: {
          sections: [
            {
              name: '时代与背景',
              content: '2077年，科技公司掌控一切，霓虹灯下是贫民窟的绝望',
            },
            {
              name: '规则与体系',
              content: '义体改造普遍，网络接入神经，AI 无处不在',
            },
          ],
        },
      },
      {
        name: '修仙世界',
        type: 'world',
        category: '仙侠',
        description: '灵气复苏的东方奇幻世界',
        data: {
          sections: [
            {
              name: '时代与背景',
              content: '上古大战后灵气衰竭，如今开始复苏，修仙门派重新崛起',
            },
            {
              name: '规则与体系',
              content: '炼气→筑基→金丹→元婴→化神→大乘→渡劫',
            },
          ],
        },
      },
      {
        name: '三幕剧结构',
        type: 'outline',
        category: '通用',
        description: '经典三幕剧大纲模板',
        data: {
          chapters: [
            { title: '第一幕：开端', summary: '介绍主角和日常世界' },
            { title: '激励事件', summary: '打破日常，主角被迫行动' },
            { title: '第二幕：对抗', summary: '矛盾升级，盟友和敌人出现' },
            { title: '中点转折', summary: '看似胜利实则反转' },
            { title: '第三幕：结局', summary: '高潮对决' },
            { title: '收束', summary: '新平衡建立' },
          ],
        },
      },
    ];

    for (const p of presets) {
      await db.insert(schema.templates).values({ ...p, is_preset: true });
    }
  }
}
