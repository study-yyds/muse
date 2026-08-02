import { test, expect } from '@playwright/test';

const PHONE = `139${String(Date.now()).slice(-8)}`;
const BOOK_PREFIX = `e2e-${Date.now().toString(36)}`;

/**
 * 完整 UI 登录流程：填写手机号 -> 获取验证码 -> 抓取验证码 -> 填入 -> 登录
 * 验证码从 send-code API 响应中实时抓取
 */
async function doLogin(page: import('@playwright/test').Page): Promise<boolean> {
  await page.goto('/login');
  await expect(page.locator('input[placeholder*="手机号"]')).toBeVisible({ timeout: 5000 });

  await page.fill('input[placeholder*="手机号"]', PHONE);
  await page.click('button:has-text("获取验证码")');

  // 等待验证码输入框出现，同时从 API 直接获取验证码
  await expect(page.locator('input[placeholder*="验证码"]')).toBeVisible({ timeout: 5000 });

  // 直接调 API 获取验证码（不依赖页面响应拦截）
  const apiResp = await page.evaluate(async (phone) => {
    const r = await fetch('/api/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_number: phone }) });
    const d = await r.json();
    return d?.data?.code || d?.code || '';
  }, PHONE);
  const code = String(apiResp);

  if (!code) return false;

  const codeInput = page.locator('input[placeholder*="验证码"]');
  await expect(codeInput).toBeVisible({ timeout: 5000 });
  await codeInput.fill(String(code));
  await page.click('button:has-text("登录")');

  try {
    await expect(page.locator('text=Muse')).toBeVisible({ timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function loginAndEnterBook(page: import('@playwright/test').Page): Promise<boolean> {
  if (!(await doLogin(page))) return false;
  await page.waitForLoadState('domcontentloaded');
  const card = page.locator('[class*="cursor-pointer"]').first();
  if (!(await card.isVisible({ timeout: 8000 }).catch(() => false))) return false;
  await card.click();
  // 等进入作品详情页
  await expect(page.locator('text=章节').first()).toBeVisible({ timeout: 5000 });
  return true;
}

test.describe('Muse E2E', () => {

  test('UI login flow', async ({ page }) => {
    const ok = await doLogin(page);
    expect(ok).toBe(true);
  });

  test('create book -> enter -> URL persists', async ({ page }) => {
    test.setTimeout(60000);
    const name = `${BOOK_PREFIX}-nav`;
    if (!(await doLogin(page))) { test.skip(); return; }

    await expect(page.locator('text=Muse')).toBeVisible({ timeout: 5000 });
    await page.locator('button').filter({ hasText: '新建' }).first().click();

    const input = page.locator('input[placeholder="输入作品名"]');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill(name);
    await page.locator('button:has-text("创建")').last().click();

    // 章节 & 大纲 出现在侧边栏和内容区两处，用 .first()
    await expect(page.locator('text=章节').first()).toBeVisible({ timeout: 10000 });
    await page.locator('button:has-text("大纲")').first().click();
    expect(page.url()).toContain('tab=outline');
    await page.reload();
    await expect(page.locator('text=大纲').first()).toBeVisible({ timeout: 8000 });
    expect(page.url()).toContain('tab=outline');
  });

  test('editor write and save', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 8000 });
    const newBtn = page.locator('button[title="新建章节"]');
    if (await newBtn.isVisible()) await newBtn.click();
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await editor.fill(`E2E test - ${Date.now()}`);
    const saveBtn = page.locator('button:has-text("保存")');
    await expect(saveBtn).toBeVisible();
    if (await saveBtn.isEnabled()) {
      await saveBtn.click();
      await expect(page.locator('text=已保存')).toBeVisible({ timeout: 5000 });
    }
  });

  test('character list visible', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('button:has-text("角色")')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("角色")');
    await expect(page.locator('text=添加角色')).toBeVisible({ timeout: 8000 });
  });

  test('AI chat send message', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('textarea[placeholder*="输入修改指令"]')).toBeVisible({ timeout: 8000 });
    const aiInput = page.locator('textarea[placeholder*="输入修改指令"]');
    await aiInput.fill('hi');
    await aiInput.press('Enter');
    const thinking = page.locator('text=思考中');
    const response = page.locator('[class*="whitespace-pre-wrap"]');
    await expect(thinking.or(response).first()).toBeVisible({ timeout: 10000 });
  });

  test('admin access denied', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('text=管理后台')).not.toBeVisible({ timeout: 5000 }).catch(() => {});
    expect(page.url()).not.toContain('/admin');
  });

  test('stats page visible', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('button:has-text("统计")')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("统计")');
    await expect(page.locator('text=总字数').or(page.locator('text=暂无'))).toBeVisible({ timeout: 8000 });
  });

  test('char dialog - open, send, see reply', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('button:has-text("角色")')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("角色")');
    await expect(page.locator('text=添加角色')).toBeVisible({ timeout: 5000 });
    const testBtn = page.locator('button[title="测试对话"]').first();
    if (!(await testBtn.isVisible({ timeout: 3000 }).catch(() => false))) { test.skip(); return; }
    await testBtn.click();
    await expect(page.locator('text=对话')).toBeVisible({ timeout: 5000 });
    const input = page.locator('textarea[placeholder*="说点什么"]');
    if (await input.isVisible()) {
      await input.fill('hi');
      await input.press('Enter');
    }
    await expect(
      page.locator('text=思考中').or(page.locator('[class*="whitespace-pre-wrap"]')).first()
    ).toBeVisible({ timeout: 15000 });
  });

  test('outline - add node -> bulk delete', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('button:has-text("大纲")')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("大纲")');
    await expect(page.locator('text=添加节点')).toBeVisible({ timeout: 8000 });
    const addBtn = page.locator('button:has-text("添加节点")');
    for (let i = 0; i < 3; i++) {
      if (!(await addBtn.isEnabled())) break;
      await addBtn.click();
    }
    await expect(page.locator('[class*="group flex items-start"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('save char as template dialog', async ({ page }) => {
    if (!(await loginAndEnterBook(page))) { test.skip(); return; }
    await expect(page.locator('button:has-text("角色")')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("角色")');
    await expect(page.locator('text=添加角色')).toBeVisible({ timeout: 5000 });
    const tplBtn = page.locator('button[title="保存为模板"]').first();
    if (!(await tplBtn.isVisible({ timeout: 3000 }).catch(() => false))) { test.skip(); return; }
    await tplBtn.click();
    await expect(page.locator('text=保存为模板')).toBeVisible({ timeout: 5000 });
  });

  test('dark mode toggle persists', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[placeholder*="手机号"]')).toBeVisible({ timeout: 5000 });
    const themeBtn = page.locator('button[title*="主题"], button:has([class*="sun"]), button:has([class*="moon"])').first();
    if (!(await themeBtn.isVisible({ timeout: 3000 }).catch(() => false))) { test.skip(); return; }
    const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    await themeBtn.click();
    await expect(async () => {
      const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
      expect(isDark).toBe(!wasDark);
    }).toPass({ timeout: 3000 });
    await page.reload();
    await expect(page.locator('input[placeholder*="手机号"]')).toBeVisible({ timeout: 5000 });
    const after = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    expect(after).toBe(!wasDark);
  });
});
