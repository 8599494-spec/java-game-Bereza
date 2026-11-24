import { expect, test } from '@playwright/test';

test('two browser contexts join one room, observe movement within 500ms, and receive chat', async ({
  browser,
}) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  try {
    await Promise.all([page1.goto('/'), page2.goto('/')]);

    await page1.fill('#playerNameInput', 'AlphaOne');
    await page1.fill('#roomNameInput', 'E2E-Sector');
    await page1.click('#connectBtn');

    await page2.fill('#playerNameInput', 'BravoTwo');
    await page2.fill('#roomNameInput', 'E2E-Sector');
    await page2.click('#connectBtn');

    await expect(page1.locator('#gameStage')).toBeVisible();
    await expect(page2.locator('#gameStage')).toBeVisible();
    await expect(page1.locator('#rosterCount')).toHaveText('2');
    await expect(page2.locator('#rosterCount')).toHaveText('2');

    // Capture AlphaOne's initial position as observed by BravoTwo (page2)
    await expect
      .poll(async () => {
        return page2.evaluate(() => {
          const ships = window.__GAME_DEBUG__?.getRemoteShipPositions() ?? [];
          return ships.find((s) => s.name === 'AlphaOne') ?? null;
        });
      })
      .not.toBeNull();

    const initialAlphaOnPage2 = await page2.evaluate(() => {
      const ships = window.__GAME_DEBUG__?.getRemoteShipPositions() ?? [];
      return ships.find((s) => s.name === 'AlphaOne') ?? { x: 0, y: 0 };
    });

    // Fly AlphaOne forward on page1
    await page1.keyboard.down('KeyW');
    await page1.waitForTimeout(220);
    await page1.keyboard.up('KeyW');

    // Assert BravoTwo (page2) observes AlphaOne's movement within 500ms
    await expect
      .poll(
        async () => {
          return page2.evaluate((start) => {
            const ships = window.__GAME_DEBUG__?.getRemoteShipPositions() ?? [];
            const alpha = ships.find((s) => s.name === 'AlphaOne');
            if (!alpha) return 0;
            return Math.hypot(alpha.x - start.x, alpha.y - start.y);
          }, initialAlphaOnPage2);
        },
        { timeout: 500, intervals: [50, 100, 150] },
      )
      .toBeGreaterThan(5);

    // Send chat message from AlphaOne and assert receipt on BravoTwo
    await page1.fill('#chatInput', 'Copy that, BravoTwo!');
    await page1.click('#chatSendBtn');
    await expect(page2.locator('#chatMessages')).toContainText('AlphaOne: Copy that, BravoTwo!');
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
