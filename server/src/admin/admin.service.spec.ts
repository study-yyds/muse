import { AdminService } from './admin.service';

// Mock DB：链式 mock，select 按调用顺序返回不同结果
const mockDb: any = {
  select: jest.fn(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: {
    users: { user_id: 'user_id', role: 'role', status: 'status', book_limit: 'book_limit', monthly_words_quota: 'monthly_words_quota', phone_number: 'phone_number', created_at: 'created_at' },
    books: { book_id: 'book_id', user_id: 'user_id' },
    token_usage_records: { user_id: 'user_id', token_count: 'token_count', id: 'id' },
    user_monthly_quota: { user_id: 'user_id', month: 'month', used_words: 'used_words' },
    admin_audit_logs: { id: 'id', operator_id: 'operator_id', target_user_id: 'target_user_id', action: 'action', detail: 'detail', created_at: 'created_at' },
  },
}));

jest.mock('../ai/abort-registry', () => ({
  abortBookRequests: jest.fn(),
}));
import { abortBookRequests } from '../ai/abort-registry';

/** 构造一次 select 链：返回 rows */
const sel = (rows: any[]) => {
  const limit = jest.fn().mockResolvedValue(rows);
  const thenable = {
    limit,
    then: (fn: any) => limit().then(fn),
  };
  const where = jest.fn().mockReturnValue(thenable);
  const from = jest.fn().mockReturnValue({ where });
  return { from };
};

describe('AdminService.updateUser 安全保护', () => {
  let service: AdminService;

  beforeEach(() => {
    service = new AdminService();
    jest.clearAllMocks();
    // 重置链式 mock 默认行为
    Object.keys(mockDb).forEach((k) => {
      if (k !== 'select' && typeof mockDb[k] === 'function') {
        mockDb[k] = jest.fn().mockReturnThis();
      }
    });
    mockDb.select = jest.fn();
  });

  it('不能修改自己的账户', async () => {
    await expect(
      service.updateUser('u1', 'u1', { role: 'user' }),
    ).rejects.toThrow('不能修改自己的账户');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('不能降级最后一名管理员', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ role: 'admin' }])) // 目标用户
      .mockReturnValueOnce(sel([{ count: 0 }])); // 其他 admin 数
    await expect(
      service.updateUser('op', 'u2', { role: 'user' }),
    ).rejects.toThrow('不能降级/封禁最后一名管理员');
  });

  it('有第二名管理员时允许操作并写入审计日志', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ role: 'admin' }]))
      .mockReturnValueOnce(sel([{ count: 1 }]))
      .mockReturnValueOnce(sel([])); // books 查询（封禁分支）
    await service.updateUser('op', 'u2', { role: 'user' });
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        operator_id: 'op',
        target_user_id: 'u2',
        action: 'update_user',
      }),
    );
  });

  it('封禁用户时中止其全部作品进行中的 AI 生成', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ role: 'user' }])) // 目标非 admin，跳过最后管理员检查
      .mockReturnValueOnce(sel([{ book_id: 'b1' }, { book_id: 'b2' }])); // books
    await service.updateUser('op', 'u3', { status: 'banned' });
    expect(abortBookRequests).toHaveBeenCalledTimes(2);
    expect(abortBookRequests).toHaveBeenCalledWith('b1');
    expect(abortBookRequests).toHaveBeenCalledWith('b2');
  });

  it('暂停非管理员用户也中止 AI 生成', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([{ role: 'user' }]))
      .mockReturnValueOnce(sel([])); // 无作品
    await service.updateUser('op', 'u4', { status: 'suspended' });
    expect(abortBookRequests).not.toHaveBeenCalled();
  });
});
