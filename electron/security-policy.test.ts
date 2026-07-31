import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PACKAGED_BLOCKED_URL_PATTERNS,
  trustedDevServerUrl,
} from './security-policy';

const ELECTRON_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

describe('development renderer policy', () => {
  it('accepts only credential-free loopback HTTP(S) URLs outside packages', () => {
    expect(trustedDevServerUrl('http://localhost:5173', false))
      .toBe('http://localhost:5173/');
    expect(trustedDevServerUrl('https://127.0.0.1:5173/app', false))
      .toBe('https://127.0.0.1:5173/app');
    expect(trustedDevServerUrl('http://[::1]:5173', false))
      .toBe('http://[::1]:5173/');

    expect(trustedDevServerUrl('https://example.com', false)).toBeUndefined();
    expect(trustedDevServerUrl('file:///tmp/index.html', false)).toBeUndefined();
    expect(trustedDevServerUrl('http://user:pass@localhost:5173', false))
      .toBeUndefined();
    expect(trustedDevServerUrl('not a URL', false)).toBeUndefined();
  });

  it('ignores even a loopback dev URL in packaged mode', () => {
    expect(trustedDevServerUrl('http://localhost:5173', true)).toBeUndefined();
  });
});

describe('packaged Electron policy wiring', () => {
  it('blocks renderer network schemes and denies permissions/downloads', async () => {
    expect(PACKAGED_BLOCKED_URL_PATTERNS).toEqual([
      'http://*/*',
      'https://*/*',
      'ws://*/*',
      'wss://*/*',
    ]);

    const mainSource = await fs.readFile(
      path.join(ELECTRON_DIRECTORY, 'main.ts'),
      'utf8',
    );
    expect(mainSource).toContain('!app.isPackaged && VITE_DEV_SERVER_URL');
    expect(mainSource).toContain('setPermissionCheckHandler(() => false)');
    expect(mainSource).toContain('setPermissionRequestHandler(');
    expect(mainSource).toContain("on('will-download'");
    expect(mainSource).toContain('event.preventDefault()');
    expect(mainSource).toContain('webRequest.onBeforeRequest(');
  });

  it('exposes only the current desktopApi preload bridge', async () => {
    const preloadSource = await fs.readFile(
      path.join(ELECTRON_DIRECTORY, 'preload.ts'),
      'utf8',
    );
    expect(preloadSource).toContain(
      "contextBridge.exposeInMainWorld('desktopApi', frozenDesktopApi)",
    );
    expect(preloadSource).not.toContain("exposeInMainWorld('electronAPI'");
  });
});
