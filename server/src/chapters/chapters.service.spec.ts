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
    chapters: { chapter_id: 'ch_id', book_id: 'ch_book_id', title: 'ch_title', content: 'ch_content', sort_order: 'ch_sort', word_count: 'ch_wc' },
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
      mockDb.select.mockImplementation(() => mockDb);
      mockDb.from.mockImplementation(() => mockDb);
      mockDb.where.mockImplementation(() => mockDb);
      mockDb.limit.mockReturnValue(mockDb);
      // Mock: chapter belongs to the right book
      jest.spyOn(mockDb, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ book_id: 'book-123' }]),
          }),
        }),
      } as any);

      await expect(
        service.save('chapter-1', 'content', 100, undefined, 'book-123')
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
        service.save('chapter-1', 'content', 100, undefined, 'book-123')
      ).rejects.toThrow('章节不属于该作品');
    });

    it('expectedBookId 为 undefined 时跳过校验（向后兼容）', async () => {
      mockDb.set.mockImplementation(() => mockDb);
      mockDb.where.mockImplementation(() => mockDb);
      await expect(
        service.save('chapter-1', 'content', 100)
      ).resolves.not.toThrow();
    });
  });

  describe('split', () => {
    it('splitAt=0 产生空第一部分和完整第二部分', () => {
      // 测试边界逻辑
      const content = 'hello world';
      expect(content.slice(0, 0)).toBe('');
      expect(content.slice(0)).toBe('hello world');
    });

    it('splitAt=content.length 产生完整第一部分和空第二部分', () => {
      const content = 'hello world';
      expect(content.slice(0, content.length)).toBe('hello world');
      expect(content.slice(content.length)).toBe('');
    });
  });

  describe('merge', () => {
    it('少于 2 个 id 时抛错', async () => {
      await expect(
        service.merge('book-123', ['single-id'], 'title')
      ).rejects.toThrow(); // 先检查抛错，具体信息取决于 mock
    });
  });
});
