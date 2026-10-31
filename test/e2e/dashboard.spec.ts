/// <reference lib="dom" />
import { expect, test } from '@playwright/test';

const TOKEN = 'e2e0123456789abcdef0123456789abcdef0123456789ab';

test.describe('paper trading dashboard', () => {
  test.beforeEach(async ({ page }, info) => {
    page.on('dialog', () => {
      throw new Error('a dialog opened: external content was executed');
    });
    await page.goto(`/?token=${TOKEN}`);
    await page.getByTestId('session-select').selectOption(`fixture-${info.project.name}`);
  });

  test('shows the PAPER label, session, balances and the order/fill blotter', async ({ page }) => {
    await expect(page.getByTestId('paper-band')).toHaveText('PAPER — SIMULATED FUNDS');
    await expect(page.getByTestId('paper-band')).toBeVisible();
    await expect(page.getByTestId('session-select')).toContainText('fixture-desktop');
    await expect(page.getByTestId('cash')).toContainText('$');
    await expect(page.getByTestId('orders-table').locator('tbody tr')).not.toHaveCount(0);
    await expect(page.getByTestId('fills-table').locator('tbody tr')).not.toHaveCount(0);
    await expect(page.getByTestId('evidence')).toHaveText(/not_ready|insufficient_evidence/);
  });

  test('renders hostile external content as inert text', async ({ page }) => {
    const purpose = page.getByTestId('purpose');
    await expect(purpose).toContainText('<script>alert("xss")</script>');
    await expect(purpose).toContainText('<img src=x onerror=alert(1)>');
    expect(await page.locator('[data-testid="purpose"] script, [data-testid="purpose"] img').count()).toBe(0);
  });

  test('controls pause and stop the session (recorded, no runtime attached)', async ({ page }) => {
    await page.getByTestId('btn-pause').click();
    await expect(page.getByTestId('control-msg')).toContainText('applied');
    await expect(page.getByTestId('session-status')).toContainText('paused');
    await page.getByTestId('btn-flatten').click();
    await expect(page.getByTestId('control-msg')).toContainText('refused');
    await page.getByTestId('btn-stop').click();
    await expect(page.getByTestId('session-status')).toContainText('stopped');
  });

  test('requires the token', async ({ page, context }) => {
    // (beforeEach already proved the token works; now drop it)
    await context.clearCookies();
    const res = await page.goto('/');
    expect(res?.status()).toBe(401);
  });

  test('layout fits the viewport without horizontal page scroll', async ({ page }) => {
    await expect(page.getByTestId('orders-table')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
