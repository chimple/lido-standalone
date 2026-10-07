export const ZIP_PLAYER_ENTRY = 'code/lido-player.esm.js';

export interface PreparedZipBundle {
  zipUrl: string;
  assets: Record<string, string>;
  hasPlayerCode: boolean;
  playerEntry?: string;
  dispose: () => void;
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;

function normalizeBundlePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function readBundleUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readBundleUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const DecompressionStreamConstructor = (globalThis as typeof globalThis & {
    DecompressionStream?: new (format: string) => TransformStream;
  }).DecompressionStream;

  if (!DecompressionStreamConstructor) {
    throw new Error('This browser does not support ZIP deflate decompression.');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStreamConstructor('deflate-raw'));
  return new Response(stream).arrayBuffer();
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset--) {
    if (readBundleUint32(view, offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('Invalid lesson ZIP: end of central directory not found.');
}

function getBlobType(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export async function prepareZipBundle(zipUrl: string): Promise<PreparedZipBundle> {
  const response = await fetch(zipUrl);
  if (!response.ok) throw new Error(`Unable to download lesson ZIP: ${zipUrl}`);

  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  const endOffset = findEndOfCentralDirectory(view);
  const entryCount = readBundleUint16(view, endOffset + 10);
  const centralDirectoryOffset = readBundleUint32(view, endOffset + 16);
  const assets: Record<string, string> = {};
  const objectUrls: string[] = [];

  let offset = centralDirectoryOffset;
  try {
    for (let index = 0; index < entryCount; index++) {
      if (readBundleUint32(view, offset) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
        throw new Error('Invalid lesson ZIP: malformed central directory.');
      }

      const compressionMethod = readBundleUint16(view, offset + 10);
      const compressedSize = readBundleUint32(view, offset + 20);
      const nameLength = readBundleUint16(view, offset + 28);
      const extraLength = readBundleUint16(view, offset + 30);
      const commentLength = readBundleUint16(view, offset + 32);
      const localHeaderOffset = readBundleUint32(view, offset + 42);
      const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
      const path = normalizeBundlePath(new TextDecoder().decode(nameBytes));
      offset += 46 + nameLength + extraLength + commentLength;

      if (!path || path.endsWith('/')) continue;
      if (readBundleUint32(view, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
        throw new Error(`Invalid lesson ZIP: malformed local header for ${path}.`);
      }

      const localNameLength = readBundleUint16(view, localHeaderOffset + 26);
      const localExtraLength = readBundleUint16(view, localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressedBytes = buffer.slice(dataOffset, dataOffset + compressedSize);
      const bytes = compressionMethod === 0
        ? compressedBytes
        : compressionMethod === 8
          ? await inflateRaw(compressedBytes)
          : (() => { throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${path}.`); })();

      const url = URL.createObjectURL(new Blob([bytes], { type: getBlobType(path) }));
      assets[path] = url;
      objectUrls.push(url);
    }
  } catch (error) {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }

  let disposed = false;
  return {
    zipUrl,
    assets,
    hasPlayerCode: Boolean(assets[ZIP_PLAYER_ENTRY]),
    playerEntry: assets[ZIP_PLAYER_ENTRY] ? ZIP_PLAYER_ENTRY : undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
    },
  };
}

const ZIP_RESOLVER_KEY = '__lidoZipModuleResolver__';
const REGISTRATION_NAMES = ['lido-home', 'lido-root', 'lido-container'];

interface Token {
  kind: 'word' | 'string' | 'template' | 'punctuation';
  start: number;
  end: number;
  value?: string;
}

interface ModuleInfo {
  path: string;
  source: string;
  imports: Token[];
  dynamicTemplateCandidates: string[];
}

interface ResolverState {
  module: (fromPath: string, specifier: string) => string;
  resource: (fromPath: string, specifier: string) => string;
  resourceBase: () => string;
}

export interface LoadedZipPlayer {
  entryUrl: string;
  dispose: () => void;
}

export class ZipPlayerLoadError extends Error {
  readonly partialRegistration: boolean;

  constructor(message: string, partialRegistration: boolean, cause?: unknown) {
    super(message);
    this.name = 'ZipPlayerLoadError';
    this.partialRegistration = partialRegistration;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isJavaScriptPath(path: string): boolean {
  return /\.m?js$/i.test(path);
}

function normalizePath(path: string): string {
  const segments: string[] = [];

  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  return segments.join('/');
}

function resolveZipPath(fromPath: string, specifier: string): string | undefined {
  if (!isRelativeSpecifier(specifier)) return undefined;

  const base = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  const withoutQuery = specifier.split(/[?#]/, 1)[0];
  return normalizePath(`${base}${withoutQuery}`);
}

function resolveResourcePath(fromPath: string, specifier: string): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(specifier)) return undefined;

  const base = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  const withoutQuery = specifier.split(/[?#]/, 1)[0];
  return normalizePath(`${base}${withoutQuery}`);
}

function decodeQuotedString(source: string, token: Token): string {
  const raw = source.slice(token.start, token.end);
  if (raw.startsWith('"')) {
    return JSON.parse(raw);
  }

  return raw
    .slice(1, -1)
    .replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
      if (escaped === 'n') return '\n';
      if (escaped === 'r') return '\r';
      if (escaped === 't') return '\t';
      return escaped;
    });
}

function skipQuotedString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '`') return index + 1;
    index++;
  }
  return source.length;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (/\s/.test(character)) {
      index++;
      continue;
    }

    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }

    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }

    if (character === '"' || character === "'") {
      const end = skipQuotedString(source, index, character);
      tokens.push({ kind: 'string', start: index, end });
      index = end;
      continue;
    }

    if (character === '`') {
      const end = skipTemplate(source, index);
      tokens.push({ kind: 'template', start: index, end });
      index = end;
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index++;
      tokens.push({ kind: 'word', start, end: index, value: source.slice(start, index) });
      continue;
    }

    tokens.push({ kind: 'punctuation', start: index, end: index + 1, value: character });
    index++;
  }

  return tokens;
}

function findClosingParenthesis(source: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      index = skipQuotedString(source, index, character);
      continue;
    }
    if (character === '`') {
      index = skipTemplate(source, index);
      continue;
    }
    if (character === '(') depth++;
    if (character === ')' && --depth === 0) return index;
    index++;
  }

  return -1;
}

function findSpecifierTokens(source: string, tokens: Token[]): Token[] {
  const specifiers: Token[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word' || (token.value !== 'import' && token.value !== 'export')) continue;

    const next = tokens[index + 1];
    if (!next) continue;

    if (next.kind === 'punctuation' && next.value === '(') {
      const close = findClosingParenthesis(source, next.start);
      if (close < 0) continue;
      const argument = tokens.find(candidate => candidate.start > next.end && candidate.end <= close);
      if (argument?.kind === 'string' || argument?.kind === 'template') specifiers.push(argument);
      while (index < tokens.length && tokens[index].start <= close) index++;
      index--;
      continue;
    }

    if (token.value === 'import' && next.kind === 'string') {
      specifiers.push(next);
      continue;
    }

    const statementEnd = source.indexOf(';', token.end);
    const end = statementEnd < 0 ? source.length : statementEnd;
    for (let candidateIndex = index + 1; candidateIndex < tokens.length; candidateIndex++) {
      const candidate = tokens[candidateIndex];
      if (candidate.start >= end) break;
      if (candidate.kind === 'word' && candidate.value === 'from') {
        const specifier = tokens[candidateIndex + 1];
        if (specifier?.kind === 'string') specifiers.push(specifier);
        break;
      }
    }
  }

  return specifiers;
}

function findDynamicSpecifierStarts(source: string, tokens: Token[]): Set<number> {
  const dynamicStarts = new Set<number>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token.kind !== 'word' || token.value !== 'import' || next?.value !== '(') continue;

    const close = findClosingParenthesis(source, next.start);
    if (close < 0) continue;
    const argument = tokens.find(candidate => candidate.start > next.end && candidate.end <= close);
    if (argument?.kind === 'string' || argument?.kind === 'template') {
      dynamicStarts.add(argument.start);
    }
    while (index < tokens.length && tokens[index].start <= close) index++;
    index--;
  }

  return dynamicStarts;
}

function isGeneratedEntryTemplate(
  source: string,
  token: Token,
): { variable: string; queryExpression?: string } | undefined {
  if (token.kind !== 'template') return undefined;

  const raw = source.slice(token.start + 1, token.end - 1);
  const match = raw.match(
    /^\.\/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}\.entry\.js(?:\$\{([\s\S]+)\})?$/,
  );
  return match ? { variable: match[1], queryExpression: match[2] } : undefined;
}

const GENERATED_ENTRY_IMPORT_PATTERN = /import\(`\.\/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}\.entry\.js(?:\$\{([\s\S]*?)\})?`\)/g;
const RELATIVE_DYNAMIC_IMPORT_PATTERN = /import\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g;

function getAssetUrl(bundle: PreparedZipBundle, path: string): string | undefined {
  return bundle.assets[path] || bundle.assets[`/${path}`];
}

function getGeneratedEntryCandidates(bundle: PreparedZipBundle, fromPath: string): string[] {
  const directory = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  return Object.keys(bundle.assets)
    .map(normalizePath)
    .filter(path => path.startsWith(directory) && path.endsWith('.entry.js'));
}

function getRelativeDynamicImportCandidates(
  bundle: PreparedZipBundle,
  fromPath: string,
  source: string,
): string[] {
  const candidates: string[] = [];
  RELATIVE_DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(RELATIVE_DYNAMIC_IMPORT_PATTERN)) {
    const target = resolveZipPath(fromPath, match[2]);
    if (target && isJavaScriptPath(target) && getAssetUrl(bundle, target)) {
      candidates.push(target);
    }
  }
  RELATIVE_DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
  return candidates;
}

function getRegistrationSnapshot(): Record<string, CustomElementConstructor | undefined> {
  return Object.fromEntries(REGISTRATION_NAMES.map(name => [name, customElements.get(name)]));
}

function hasNewRegistration(before: Record<string, CustomElementConstructor | undefined>): boolean {
  return REGISTRATION_NAMES.some(name => !before[name] && customElements.get(name));
}

export async function loadPlayerFromPreparedZip(bundle: PreparedZipBundle): Promise<LoadedZipPlayer | undefined> {
  if (!bundle.hasPlayerCode || !bundle.playerEntry) return undefined;

  const moduleUrls = new Map<string, string>();
  const moduleSources = new Map<string, ModuleInfo>();
  const visiting = new Set<string>();
  const discovered = new Set<string>();
  const resolverState: ResolverState = {
    module: (fromPath, specifier) => {
      const path = resolveZipPath(fromPath, specifier);
      if (!path) return specifier;
      const url = moduleUrls.get(path);
      if (!url) throw new Error(`ZIP player module is not prepared: ${path}`);
      return url;
    },
    resource: (fromPath, specifier) => {
      const path = resolveResourcePath(fromPath, specifier);
      if (!path) return specifier;
      const url = getAssetUrl(bundle, path);
      if (!url) throw new Error(`ZIP player resource is missing: ${path}`);
      return url;
    },
    resourceBase: () => document.baseURI,
  };

  const globalObject = globalThis as typeof globalThis & Record<string, unknown>;
  if (REGISTRATION_NAMES.some(name => customElements.get(name))) {
    throw new ZipPlayerLoadError(
      'A Lido player has already registered custom elements; ZIP player cannot be loaded safely.',
      true,
    );
  }

  const previousResolver = globalObject[ZIP_RESOLVER_KEY];
  globalObject[ZIP_RESOLVER_KEY] = resolverState;

  const readModule = async (path: string): Promise<ModuleInfo> => {
    const existing = moduleSources.get(path);
    if (existing) return existing;

    const assetUrl = getAssetUrl(bundle, path);
    if (!assetUrl) throw new Error(`ZIP player module is missing: ${path}`);
    if (!isJavaScriptPath(path)) throw new Error(`ZIP player dependency is not JavaScript: ${path}`);

    const source = await fetch(assetUrl).then(response => {
      if (!response.ok) throw new Error(`Unable to read ZIP player module: ${path}`);
      return response.text();
    });
    const tokens = tokenize(source);
    const imports = findSpecifierTokens(source, tokens);
    const dynamicTemplateCandidates = tokens
      .map(token => isGeneratedEntryTemplate(source, token))
      .filter((value): value is { variable: string } => Boolean(value))
      .flatMap(() => getGeneratedEntryCandidates(bundle, path));
    if (GENERATED_ENTRY_IMPORT_PATTERN.test(source)) {
      dynamicTemplateCandidates.push(...getGeneratedEntryCandidates(bundle, path));
      GENERATED_ENTRY_IMPORT_PATTERN.lastIndex = 0;
    }
    dynamicTemplateCandidates.push(...getRelativeDynamicImportCandidates(bundle, path, source));

    const info = { path, source, imports, dynamicTemplateCandidates };
    moduleSources.set(path, info);
    return info;
  };

  const discover = async (path: string): Promise<void> => {
    if (discovered.has(path)) return;
    discovered.add(path);

    const info = await readModule(path);
    for (const token of info.imports) {
      if (token.kind !== 'string') continue;
      const specifier = decodeQuotedString(info.source, token);
      const target = resolveZipPath(path, specifier);
      if (target && isJavaScriptPath(target)) await discover(target);
    }
    for (const candidate of info.dynamicTemplateCandidates) await discover(candidate);
  };

  const replaceSpecifier = (source: string, token: Token, replacement: string): string =>
    `${source.slice(0, token.start)}${replacement}${source.slice(token.end)}`;

  const rewrite = async (info: ModuleInfo): Promise<string> => {
    let source = info.source;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const tokens = tokenize(info.source);

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== 'word' || (token.value !== 'import' && token.value !== 'export')) continue;

      const next = tokens[index + 1];
      if (!next) continue;

      if (token.value === 'import' && next.kind === 'punctuation' && next.value === '(') {
        const close = findClosingParenthesis(info.source, next.start);
        if (close < 0) continue;
        const argument = tokens.find(candidate => candidate.start > next.end && candidate.end <= close);
        if (!argument) continue;

        if (argument.kind === 'string') {
          const specifier = decodeQuotedString(info.source, argument);
          const target = resolveZipPath(info.path, specifier);
          if (target && isJavaScriptPath(target)) {
            if (!getAssetUrl(bundle, target)) throw new Error(`ZIP player module is missing: ${target}`);
            replacements.push({
              start: argument.start,
              end: argument.end,
              value: `globalThis[${JSON.stringify(ZIP_RESOLVER_KEY)}].module(${JSON.stringify(info.path)}, ${JSON.stringify(specifier)})`,
            });
          }
        } else if (argument.kind === 'template') {
          const generated = isGeneratedEntryTemplate(info.source, argument);
          if (generated) {
            const querySuffix = generated.queryExpression ? ` + (${generated.queryExpression})` : '';
            replacements.push({
              start: argument.start,
              end: argument.end,
              value: `globalThis[${JSON.stringify(ZIP_RESOLVER_KEY)}].module(${JSON.stringify(info.path)}, "./" + ${generated.variable} + ".entry.js"${querySuffix})`,
            });
          }
        }

        while (index < tokens.length && tokens[index].start <= close) index++;
        index--;
        continue;
      }

      let specifierToken: Token | undefined;
      if (token.value === 'import' && next.kind === 'string') {
        specifierToken = next;
      } else {
        const statementEnd = info.source.indexOf(';', token.end);
        const end = statementEnd < 0 ? info.source.length : statementEnd;
        for (let candidateIndex = index + 1; candidateIndex < tokens.length; candidateIndex++) {
          const candidate = tokens[candidateIndex];
          if (candidate.start >= end) break;
          if (candidate.kind === 'word' && candidate.value === 'from') {
            const candidateSpecifier = tokens[candidateIndex + 1];
            if (candidateSpecifier?.kind === 'string') specifierToken = candidateSpecifier;
            break;
          }
        }
      }

      if (!specifierToken) continue;
      const specifier = decodeQuotedString(info.source, specifierToken);
      const target = resolveZipPath(info.path, specifier);
      if (!target) continue;
      if (!isJavaScriptPath(target)) continue;
      const url = moduleUrls.get(target);
      if (!url) throw new Error(`ZIP player module is not prepared: ${target}`);
      replacements.push({ start: specifierToken.start, end: specifierToken.end, value: JSON.stringify(url) });
    }

    replacements.sort((left, right) => right.start - left.start);
    for (const replacement of replacements) {
      source = replaceSpecifier(source, { start: replacement.start, end: replacement.end, kind: 'string' }, replacement.value);
    }

    // Stencil emits this exact lazy-entry form in minified player bundles. Keep
    // a source-level fallback because tokenization can otherwise miss it when
    // the generated expression is embedded in surrounding minified code.
    source = source.replace(
      GENERATED_ENTRY_IMPORT_PATTERN,
      (_match, variable: string, queryExpression?: string) => {
        const querySuffix = queryExpression ? ` + (${queryExpression})` : '';
        return `import(globalThis[${JSON.stringify(ZIP_RESOLVER_KEY)}].module(${JSON.stringify(info.path)}, "./" + ${variable} + ".entry.js"${querySuffix}))`;
      },
    );
    source = source.replace(
      RELATIVE_DYNAMIC_IMPORT_PATTERN,
      (_match, _quote: string, specifier: string) =>
        `import(globalThis[${JSON.stringify(ZIP_RESOLVER_KEY)}].module(${JSON.stringify(info.path)}, ${JSON.stringify(specifier)}))`,
    );

    if (info.path === bundle.playerEntry) {
      const resourcePattern = /new URL\(\s*["']\.["']\s*,\s*o\s*\)\.href/;
      if (!resourcePattern.test(source)) {
        throw new Error('ZIP player entry resource base was not recognized');
      }
      source = source.replace(resourcePattern, `globalThis[${JSON.stringify(ZIP_RESOLVER_KEY)}].resourceBase()`);
    }

    // Stencil's generated runtime contains a small URL resolver for assets.
    // Its chunk filename is content-hashed, so identify the resolver by its
    // code rather than coupling ZIP loading to one generated filename.
    const runtimeResourcePattern = /O=t=>\{const e=new URL\(t,h\.p\);return e\.origin!==p\.location\.origin\?e\.href:e\.pathname\}/;
    if (runtimeResourcePattern.test(source)) {
      source = source.replace(
        runtimeResourcePattern,
        `O=t=>globalThis[${JSON.stringify(ZIP_RESOLVER_KEY)}].resource(${JSON.stringify(info.path)},t)`,
      );
    }

    return source;
  };

  const build = async (path: string): Promise<string> => {
    const existing = moduleUrls.get(path);
    if (existing) return existing;
    if (visiting.has(path)) throw new Error(`ZIP player contains an unsupported static module cycle at ${path}`);

    visiting.add(path);
    const info = await readModule(path);
    const dynamicSpecifierStarts = findDynamicSpecifierStarts(info.source, tokenize(info.source));
    for (const token of info.imports) {
      if (token.kind !== 'string') continue;
      if (dynamicSpecifierStarts.has(token.start)) continue;
      const specifier = decodeQuotedString(info.source, token);
      const target = resolveZipPath(path, specifier);
      if (target && isJavaScriptPath(target)) await build(target);
    }

    const rewrittenSource = await rewrite(info);
    const moduleUrl = URL.createObjectURL(new Blob([rewrittenSource], { type: 'text/javascript' }));
    moduleUrls.set(path, moduleUrl);
    visiting.delete(path);
    return moduleUrl;
  };

  const beforeRegistration = getRegistrationSnapshot();
  try {
    await discover(bundle.playerEntry);
    const entryUrl = await build(bundle.playerEntry);
    for (const path of moduleSources.keys()) {
      if (!moduleUrls.has(path)) await build(path);
    }
    await import(/* @vite-ignore */ entryUrl);

    await Promise.race([
      Promise.all(REGISTRATION_NAMES.map(name => customElements.whenDefined(name))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ZIP player custom-element registration timed out')), 10000)),
    ]);

    return {
      entryUrl,
      dispose: () => {
        for (const url of moduleUrls.values()) URL.revokeObjectURL(url);
        moduleUrls.clear();
        if (globalObject[ZIP_RESOLVER_KEY] === resolverState) {
          if (previousResolver === undefined) delete globalObject[ZIP_RESOLVER_KEY];
          else globalObject[ZIP_RESOLVER_KEY] = previousResolver;
        }
      },
    };
  } catch (error) {
    const partialRegistration = hasNewRegistration(beforeRegistration);
    for (const url of moduleUrls.values()) URL.revokeObjectURL(url);
    moduleUrls.clear();
    if (globalObject[ZIP_RESOLVER_KEY] === resolverState) {
      if (previousResolver === undefined) delete globalObject[ZIP_RESOLVER_KEY];
      else globalObject[ZIP_RESOLVER_KEY] = previousResolver;
    }
    throw new ZipPlayerLoadError(
      `Unable to load ZIP player from ${bundle.playerEntry}`,
      partialRegistration,
      error,
    );
  }
}
