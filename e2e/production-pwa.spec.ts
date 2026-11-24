import { expect, test } from '@playwright/test';

test.describe('Lab 08 — Production Telemetry, Security Headers & PWA', () => {
  test('exposes /health, /ready, /metrics and security headers', async ({ request }) => {
    const healthRes = await request.get('/health');
    expect(healthRes.status()).toBe(200);
    expect(healthRes.headers()['x-content-type-options']).toBe('nosniff');
    expect(healthRes.headers()['x-frame-options']).toBe('DENY');
    expect(healthRes.headers()['content-security-policy']).toContain("default-src 'self'");

    const healthJson = (await healthRes.json()) as { ok: boolean; uptimeSec: number };
    expect(healthJson.ok).toBe(true);
    expect(typeof healthJson.uptimeSec).toBe('number');

    const readyRes = await request.get('/ready');
    expect(readyRes.status()).toBe(200);
    const readyJson = (await readyRes.json()) as { ready: boolean };
    expect(readyJson.ready).toBe(true);

    const metricsRes = await request.get('/metrics');
    expect(metricsRes.status()).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('game_connected_players');
    expect(metricsText).toContain('game_active_rooms');
    expect(metricsText).toContain('game_tick_duration_seconds');
  });

  test('serves valid PWA manifest, registers Service Worker and handles offline state', async ({
    page,
    context,
    request,
  }) => {
    const manifestRes = await request.get('/manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      name: string;
      display: string;
      start_url: string;
      icons: Array<{ sizes: string; src: string }>;
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === '512x512')).toBe(true);

    await page.goto('/');

    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    });
    expect(swRegistered).toBe(true);

    const cacheHasShell = await page.evaluate(async () => {
      const keys = await caches.keys();
      return keys.some((k) => k.startsWith('space-dogfight-shell-'));
    });
    expect(cacheHasShell).toBe(true);

    await context.setOffline(true);
    await expect(page.locator('#statusBar')).toContainText('Offline');

    await context.setOffline(false);
    await expect(page.locator('#statusBar')).toContainText('Back online');
  });
});
