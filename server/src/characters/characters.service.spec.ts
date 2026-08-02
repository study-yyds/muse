import { CharactersService } from './characters.service';

// Mock 数据库
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
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: {
    characters: { char_id: 'c_id', book_id: 'c_book_id', name: 'c_name', personality: 'c_personality' },
    character_relations: {},
  },
}));

describe('CharactersService — 字段白名单', () => {
  let service: CharactersService;

  beforeEach(() => {
    service = new CharactersService();
    mockDb.returning.mockResolvedValue([{ char_id: 'test-id' }]);
  });

  it('create 只写入白名单字段', async () => {
    const body = { name: '林墨', personality: '冷淡', book_id: 'evil-book', char_id: 'evil-id' };
    await service.create('real-book-id', body);
    const values = mockDb.values.mock.calls[0][0];
    expect(values.book_id).toBe('real-book-id'); // 路由 bookId 优先
    expect(values.name).toBe('林墨');
    expect(values.personality).toBe('冷淡');
    expect(values.book_id).not.toBe('evil-book'); // 被白名单过滤
  });

  it('create 忽略非白名单字段', async () => {
    const body = { name: '林墨', book_id: 'hacked', char_id: 'hacked', created_at: 'fake' };
    await service.create('real-book-id', body);
    const values = mockDb.values.mock.calls[0][0];
    expect(values.char_id).toBeUndefined();
    expect(values.created_at).toBeUndefined();
  });

  it('update 只写入白名单字段', async () => {
    mockDb.limit.mockReturnValue(mockDb);
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => [{ book_id: 'real-book-id' }] }) }) });
    const body = { name: '新名字', book_id: 'hacked', personality: '新性格' };
    await service.update('char-id', body, 'real-book-id');
    const setArg = mockDb.set.mock.calls[0][0];
    expect(setArg.name).toBe('新名字');
    expect(setArg.personality).toBe('新性格');
    expect(setArg.book_id).toBeUndefined();
    expect(setArg.char_id).toBeUndefined();
  });

  it('update 跨书校验——不同 bookId 抛错', async () => {
    mockDb.limit.mockReturnValue(mockDb);
    // 模拟 chapter 属于 different-book
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => [{ book_id: 'other-book' }] }) }) });
    await expect(
      service.update('char-id', { name: 'x' }, 'real-book-id')
    ).rejects.toThrow('角色不属于该作品');
  });
});
