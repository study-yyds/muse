import {
  downgradeExpiredForUser,
  downgradeExpiredSubscriptions,
  FREE_WORDS_QUOTA,
} from './subscription-ops';

// Mock DB：链式 mock（与 billing.service.spec 同款）
const mockDb: any = {
  select: jest.fn(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: {
    billing_orders: {
      id: 'id',
      user_id: 'user_id',
      status: 'status',
      expires_at: 'expires_at',
      quota_words: 'quota_words',
      downgraded_at: 'downgraded_at',
    },
    users: { user_id: 'user_id', monthly_words_quota: 'monthly_words_quota' },
  },
}));

/** 构造一次 select 链：orderBy=true 时含 orderBy→limit，否则 where→limit 直达 */
const sel = (rows: any[], withOrderBy: boolean) => {
  const limit = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({
    where: jest
      .fn()
      .mockReturnValue(
        withOrderBy
          ? { orderBy: jest.fn().mockReturnValue({ limit }) }
          : { limit },
      ),
  });
  return { from };
};

/** 构造无 limit 的 select 链（全量扫描查询：select→from→where 后直接 await） */
const selBulk = (rows: any[]) => ({
  from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }),
});

describe('subscription-ops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select = jest.fn();
    mockDb.update = jest.fn().mockReturnThis();
    mockDb.set = jest.fn().mockReturnThis();
  });

  const EXPIRED = new Date(Date.now() - 1000);
  const ACTIVE = new Date(Date.now() + 24 * 3600 * 1000);
  // 过期未评估的 paid 订单
  const expOrder = (quota_words: number) => ({
    id: 'o1',
    quota_words,
    expires_at: EXPIRED,
    downgraded_at: null,
  });

  it('无 paid 订单：不降级', async () => {
    mockDb.select.mockReturnValueOnce(sel([], true));
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('最新订单未到期（含续费场景）：不降级', async () => {
    mockDb.select.mockReturnValueOnce(
      sel([{ id: 'o1', quota_words: 300000, expires_at: ACTIVE, downgraded_at: null }], true),
    );
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('历史订单 expires_at 为 NULL：忽略', async () => {
    mockDb.select.mockReturnValueOnce(
      sel([{ id: 'o1', quota_words: 300000, expires_at: null, downgraded_at: null }], true),
    );
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('已打过标的过期订单：不再评估（admin 后续额度调整永久生效）', async () => {
    mockDb.select.mockReturnValueOnce(
      sel([{ id: 'o1', quota_words: 300000, expires_at: EXPIRED, downgraded_at: new Date() }], true),
    );
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('过期且额度为支付时写入的档位额度：降级到免费档并打标', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([expOrder(300000)], true))
      .mockReturnValueOnce(sel([{ quota: 300000 }], false));
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(true);
    expect(mockDb.set).toHaveBeenCalledWith({
      monthly_words_quota: FREE_WORDS_QUOTA,
    });
    expect(mockDb.set).toHaveBeenCalledWith({
      downgraded_at: expect.any(Date),
    });
  });

  it('过期但额度被 admin 手动改过：只打标不动额度', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([expOrder(300000)], true))
      .mockReturnValueOnce(sel([{ quota: 500000 }], false));
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(false);
    expect(mockDb.set).toHaveBeenCalledWith({
      downgraded_at: expect.any(Date),
    });
    expect(mockDb.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ monthly_words_quota: expect.anything() }),
    );
  });

  it('额度已是免费档：只打标不重复降级', async () => {
    mockDb.select
      .mockReturnValueOnce(sel([expOrder(300000)], true))
      .mockReturnValueOnce(sel([{ quota: FREE_WORDS_QUOTA }], false));
    await expect(downgradeExpiredForUser('u1')).resolves.toBe(false);
    expect(mockDb.set).toHaveBeenCalledWith({
      downgraded_at: expect.any(Date),
    });
    expect(mockDb.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ monthly_words_quota: expect.anything() }),
    );
  });

  it('全量扫描：用户去重 + 逐个惰性降级，返回降级数量', async () => {
    // 扫描结果：u1 出现两次（多条过期订单）→ 只处理一次
    mockDb.select
      .mockReturnValueOnce(selBulk([{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u1' }]))
      // u1：过期 + 额度匹配 → 降级并打标
      .mockReturnValueOnce(sel([expOrder(300000)], true))
      .mockReturnValueOnce(sel([{ quota: 300000 }], false))
      // u2：过期但额度被 admin 改过 → 只打标
      .mockReturnValueOnce(sel([{ id: 'o2', quota_words: 1000000, expires_at: EXPIRED, downgraded_at: null }], true))
      .mockReturnValueOnce(sel([{ quota: 500000 }], false));

    await expect(downgradeExpiredSubscriptions()).resolves.toBe(1);
    // 一次额度降级 + 两张订单打标
    expect(mockDb.set).toHaveBeenCalledWith({
      monthly_words_quota: FREE_WORDS_QUOTA,
    });
    expect(mockDb.set).toHaveBeenCalledTimes(3);
  });
});
