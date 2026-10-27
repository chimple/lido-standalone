import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  canReuseRegisteredZipRuntime,
  getExistingRegistrationNames,
  getPreparedModuleUrl,
  loadPlayerFromPreparedZip,
} from './zip-player-loader';

const registry = (registered: string[]) => ({
  get: (name: string): CustomElementConstructor | undefined =>
    registered.includes(name)
      ? (class {} as unknown as CustomElementConstructor)
      : undefined,
});

describe('ZIP player registration lifecycle guard', () => {
  it('allows the first ZIP initialization in a document', () => {
    expect(getExistingRegistrationNames(registry([]))).toEqual([]);
  });

  it('detects a second initialization after the first player registered', () => {
    expect(getExistingRegistrationNames(registry(['lido-home', 'lido-root', 'lido-container']))).toEqual([
      'lido-home',
      'lido-root',
      'lido-container',
    ]);
  });

  it('also rejects a different ZIP after registrations exist', () => {
    expect(getExistingRegistrationNames(registry(['lido-home']))).toEqual(['lido-home']);
  });

  it('reuses only a matching registered ZIP runtime', () => {
    expect(canReuseRegisteredZipRuntime(['lido-home'], 'same', 'same')).toBe(true);
    expect(canReuseRegisteredZipRuntime(['lido-home'], 'old', 'new')).toBe(false);
    expect(canReuseRegisteredZipRuntime([], 'same', 'same')).toBe(false);
  });

  it('reports an unprepared module instead of returning an empty URL', () => {
    expect(() => getPreparedModuleUrl(new Map(), 'code/p-Dkw9B84d.js')).toThrow(
      'ZIP player module is not prepared: code/p-Dkw9B84d.js',
    );
  });

  it('reuses the original prepared resolver and rejects a different ZIP after registration', async () => {
    const originalBlob = globalThis.Blob;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalFetch = globalThis.fetch;
    const testGlobal = globalThis as typeof globalThis & { __zipLazyModuleLoaded__?: boolean };
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'lido-zip-loader-'));
    let objectUrlIndex = 0;
    const sourceByAssetUrl = new Map<string, string>([
      [
        'entry-asset',
        `const o = {};
          new URL('.', o).href;
          if (false) import('./p-Dkw9B84d.js');
          for (const name of ['lido-home', 'lido-root', 'lido-container']) {
            customElements.define(name, class extends HTMLElement {});
          }`,
      ],
      ['entry-asset-different', `// different ZIP fingerprint\n${'const o = {};\nnew URL(\'.\', o).href;\nimport(\'./p-Dkw9B84d.js\');'}`],
      ['lazy-asset', 'globalThis.__zipLazyModuleLoaded__ = true;'],
      ['lazy-asset-different', 'globalThis.__zipLazyModuleLoaded__ = true;'],
    ]);

    class TestBlob {
      constructor(public readonly parts: unknown[]) {}
    }

    const makeBundle = (entryAsset: string, lazyAsset: string) => ({
      zipUrl: `https://example.test/${entryAsset}.zip`,
      assets: {
        'code/lido-player.esm.js': entryAsset,
        'code/p-Dkw9B84d.js': lazyAsset,
      },
      hasPlayerCode: true,
      playerEntry: 'code/lido-player.esm.js',
      dispose: jest.fn(),
    });

    try {
      globalThis.Blob = TestBlob as unknown as typeof Blob;
      URL.createObjectURL = ((blob: Blob) => {
        const filePath = join(temporaryDirectory, `module-${objectUrlIndex++}.js`);
        writeFileSync(filePath, String((blob as unknown as TestBlob).parts[0]));
        return filePath;
      }) as typeof URL.createObjectURL;
      URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const source = sourceByAssetUrl.get(String(input));
        if (!source) throw new Error(`Unexpected test asset request: ${String(input)}`);
        return { ok: true, text: async () => source } as Response;
      }) as typeof fetch;
      testGlobal.__zipLazyModuleLoaded__ = false;

      const firstLoad = await loadPlayerFromPreparedZip(makeBundle('entry-asset', 'lazy-asset'));
      expect(firstLoad).toBeDefined();

      const resolver = (globalThis as typeof globalThis & {
        __lidoZipModuleResolver__?: { module: (fromPath: string, specifier: string) => string };
      }).__lidoZipModuleResolver__;
      expect(resolver).toBeDefined();
      const preparedLazyModuleUrl = resolver!.module('code/lido-player.esm.js', './p-Dkw9B84d.js');
      expect(existsSync(preparedLazyModuleUrl)).toBe(true);
      require(preparedLazyModuleUrl);
      expect(testGlobal.__zipLazyModuleLoaded__).toBe(true);

      const secondLoad = await loadPlayerFromPreparedZip(makeBundle('entry-asset', 'lazy-asset'));
      expect(secondLoad?.entryUrl).toBe(firstLoad?.entryUrl);
      expect(resolver!.module('code/lido-player.esm.js', './p-Dkw9B84d.js')).toBe(preparedLazyModuleUrl);

      await expect(loadPlayerFromPreparedZip(makeBundle('entry-asset-different', 'lazy-asset-different'))).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: 'A Lido player has already registered custom elements; ZIP player cannot be loaded safely.',
        }),
      });
    } finally {
      delete testGlobal.__zipLazyModuleLoaded__;
      globalThis.Blob = originalBlob;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      globalThis.fetch = originalFetch;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
