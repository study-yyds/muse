import { PromoService } from './promo.service';

// 分页排版是纯逻辑（不碰 DB/ffmpeg），直接单测
describe('PromoService 排版逻辑', () => {
  let service: PromoService;

  beforeEach(() => {
    service = new PromoService({} as any);
  });

  describe('flowParagraph', () => {
    it('14 字/行流动切行', () => {
      const rows = (service as any).flowParagraph('a'.repeat(30));
      expect(rows).toEqual(['a'.repeat(14), 'a'.repeat(14), 'a'.repeat(2)]);
    });

    it('空文本返回空数组', () => {
      expect((service as any).flowParagraph('')).toEqual([]);
    });
  });

  describe('paginateLines', () => {
    it('短段落合并到同一页', () => {
      const pages = (service as any).paginateLines(
        ['你好。', '世界。', '再见。'],
        [0, 0, 0],
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]).toHaveLength(3);
    });

    it('长段允许跨页拆分（书页标准行为）', () => {
      // 200 字 = 15 行，超过一页容量（约 23 行），配合其他段触发拆分
      const long = '长'.repeat(400); // 29 行，必拆
      const pages = (service as any).paginateLines([long], [0]);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      // 拆分后每页行数不超过容量
      for (const page of pages) {
        const rows = page.reduce((s: number, it: any) => s + it.rows.length, 0);
        expect(rows).toBeLessThanOrEqual(24);
      }
    });

    it('跨页拆分的段保留原句音频索引', () => {
      const long = '长'.repeat(400);
      const pages = (service as any).paginateLines(['短句。', long], [0, 0]);
      // 所有条目 audioIdx 正确映射原句
      for (const page of pages) {
        for (const item of page) {
          expect([0, 1]).toContain(item.audioIdx);
        }
      }
    });

    it('段前空行计入页容量', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `第${i}句`);
      const blank = lines.map(() => 1); // 每段前都有 1 空行
      const pages = (service as any).paginateLines(lines, blank);
      // 空行占容量，30 段必分多页
      expect(pages.length).toBeGreaterThan(1);
    });
  });
});
