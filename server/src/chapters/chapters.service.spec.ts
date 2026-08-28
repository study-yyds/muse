import { ChaptersService } from './chapters.service';

const mockExecute = jest.fn();
const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  execute: mockExecute,
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: {
    chapters: {
      chapter_id: 'ch_id',
      book_id: 'ch_book_id',
      title: 'ch_title',
      content: 'ch_content',
      sort_order: 'ch_sort',
      word_count: 'ch_wc',
    },
    books: {
      book_id: 'b_id',
      word_count: 'b_wc',
      updated_at: 'b_upd',
      status: 'b_status',
    },
    book_settings: { book_id: 'bs_bid', extra: 'bs_extra' },
    outline_chapters: {
      id: 'oc_id',
      status: 'oc_status',
      updated_at: 'oc_upd',
    },
  },
}));

describe('ChaptersService', () => {
  let service: ChaptersService;

  beforeEach(() => {
    service = new ChaptersService();
    jest.clearAllMocks();
  });

  describe('save — 跨书校验', () => {
    it('expectedBookId 匹配时正常保存', async () => {
      let selectCallCount = 0;
      jest.spyOn(mockDb, 'select').mockImplementation(() => {
        selectCallCount++;
        return {
          from: () => ({
            where: () => {
              if (selectCallCount === 1) {
                // 第一次：所有权 + 旧内容校验 → 调用 .limit()
                return {
                  limit: () => Promise.resolve([{ book_id: 'book-123' }]),
                };
              }
              if (selectCallCount === 2) {
                // 第二次：recalcBookWords 的 SELECT SUM → 直接返回结果
                return Promise.resolve([{ total: 100 }]);
              }
              // 第三次：recordDailyWords 读取 book_settings
              return {
                limit: () => Promise.resolve([{ extra: {} }]),
              };
            },
          }),
        } as any;
      });

      await expect(
        service.save('chapter-1', 'content', 100, undefined, 'book-123'),
      ).resolves.not.toThrow();
    });

    it('expectedBookId 不匹配时抛错', async () => {
      jest.spyOn(mockDb, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ book_id: 'other-book' }]),
          }),
        }),
      } as any);

      await expect(
        service.save('chapter-1', 'content', 100, undefined, 'book-123'),
      ).rejects.toThrow('章节不属于该作品');
    });

    it('expectedBookId 为 undefined 时跳过校验（向后兼容）', async () => {
      mockDb.set.mockImplementation(() => mockDb);
      mockDb.where.mockImplementation(() => mockDb);
      await expect(
        service.save('chapter-1', 'content', 100),
      ).resolves.not.toThrow();
    });
  });
});
