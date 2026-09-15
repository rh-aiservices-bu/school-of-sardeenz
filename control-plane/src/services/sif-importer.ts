import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch, Headers, type RequestInit, type Response } from 'undici';
import type { CatalogEntry } from './catalog-service.js';

// A SifImporter leaves a valid SIF at `tmpPath` (the caller renames it atomically onto the module
// store). Pluggable so the control plane stays runtime-agnostic: OrasImporter for real deployments
// (K8s or Podman/VM), StubImporter for local dev/CI where apptainer isn't installed.
export interface ImportOptions {
  tmpPath: string;
  onProgress: (percentComplete: number) => void;
}

export interface SifImporter {
  readonly kind: 'stub' | 'oras';
  import(entry: CatalogEntry, opts: ImportOptions): Promise<void>;
}

// --- dev/CI stub: writes a placeholder file so imported-state is observable without apptainer ----
export class StubImporter implements SifImporter {
  readonly kind = 'stub';

  constructor(
    private readonly delayMs = 200,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async import(entry: CatalogEntry, opts: ImportOptions): Promise<void> {
    opts.onProgress(10);
    await this.sleep(this.delayMs);
    opts.onProgress(70);
    await writeFile(
      opts.tmpPath,
      `SARDEENZ-DEV-STUB-SIF\nimage=${entry.image}\nsif=${entry.sifName}\n`,
    );
    opts.onProgress(100);
  }
}

// Production imports resolve the digest-pinned OCI manifest and stream its single SIF layer
// directly to the module-store temporary path. This gives us structured byte progress and avoids
// Apptainer's opaque two-step download-to-/tmp then copy-to-destination behavior. Apptainer remains
// responsible for optional SIF signature verification after the layer digest has been checked.
export type RunResult = { code: number; stderr: string };
export type RunFn = (command: string, args: string[], timeoutMs?: number) => Promise<RunResult>;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const SIF_LAYER_MEDIA_TYPES = new Set([
  'application/vnd.sylabs.sif.layer.v1.sif',
  // Historical Apptainer/Singularity prototype value (including its original typo).
  'appliciation/vnd.sylabs.sif.layer.tar',
]);

const defaultRun: RunFn = (command, args, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      finish({ code: -1, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.once('error', (err) => finish({ code: -1, stderr: err.message }));
    child.once('exit', (code) => finish({ code: code ?? -1, stderr }));
  });

interface OrasReference {
  registry: string;
  repository: string;
  manifestDigest: string;
}

interface OciDescriptor {
  mediaType?: unknown;
  size?: unknown;
  digest?: unknown;
}

interface OciManifest {
  schemaVersion?: unknown;
  layers?: unknown;
}

interface RegistryCredential {
  auth?: string;
  username?: string;
  password?: string;
  identitytoken?: string;
}

interface DockerAuthFile {
  auths?: Record<string, RegistryCredential>;
}

function parseOrasReference(image: string): OrasReference {
  const match = /^oras:\/\/([^/]+)\/(.+)@sha256:([a-fA-F0-9]{64})$/.exec(image);
  if (!match) {
    throw new Error(`Catalog image is not a digest-pinned ORAS reference: ${image}`);
  }
  const [, registry, taggedRepository, digest] = match;
  if (
    !registry ||
    !taggedRepository ||
    !digest ||
    registry.includes('@') ||
    /[\s/?#]/.test(registry)
  ) {
    throw new Error(`Invalid ORAS reference: ${image}`);
  }
  const lastSlash = taggedRepository.lastIndexOf('/');
  const lastColon = taggedRepository.lastIndexOf(':');
  const repository =
    lastColon > lastSlash ? taggedRepository.slice(0, lastColon) : taggedRepository;
  if (!repository || repository.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid ORAS repository: ${image}`);
  }
  return { registry, repository, manifestDigest: `sha256:${digest.toLowerCase()}` };
}

function registryUrl(ref: OrasReference, kind: 'manifests' | 'blobs', digest: string): string {
  const repository = ref.repository.split('/').map(encodeURIComponent).join('/');
  return `https://${ref.registry}/v2/${repository}/${kind}/${digest}`;
}

function parseBearerChallenge(
  challenge: string,
): { realm: string; params: URLSearchParams } | null {
  const scheme = /^Bearer\s+/i.exec(challenge);
  if (!scheme) return null;
  const values = new Map<string, string>();
  const paramsPart = challenge.slice(scheme[0].length);
  for (const match of paramsPart.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g)) {
    values.set(match[1].toLowerCase(), match[2]);
  }
  const realm = values.get('realm');
  if (!realm) return null;
  const params = new URLSearchParams();
  for (const key of ['service', 'scope'] as const) {
    const value = values.get(key);
    if (value) params.set(key, value);
  }
  return { realm, params };
}

function decodeBasicCredential(credential: RegistryCredential): string | undefined {
  if (credential.auth) return credential.auth;
  if (credential.username != null && credential.password != null) {
    return Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
  }
  return undefined;
}

export interface OrasImporterConfig {
  apptainerBin: string;
  verifySif: boolean;
  pullTimeoutMs?: number;
  registryAuthFile?: string;
}

export class OrasImporter implements SifImporter {
  readonly kind = 'oras';
  private authFilePromise?: Promise<DockerAuthFile>;

  constructor(
    private readonly config: OrasImporterConfig,
    private readonly run: RunFn = defaultRun,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async authFile(): Promise<DockerAuthFile> {
    if (!this.authFilePromise) {
      const path = this.config.registryAuthFile ?? process.env.APPTAINER_AUTH_FILE;
      this.authFilePromise = path
        ? readFile(path, 'utf8').then((contents) => JSON.parse(contents) as DockerAuthFile)
        : Promise.resolve({});
    }
    return this.authFilePromise;
  }

  private async credentialFor(registry: string): Promise<RegistryCredential | undefined> {
    const { auths = {} } = await this.authFile();
    return (
      auths[registry] ??
      auths[`https://${registry}`] ??
      auths[`https://${registry}/v1/`] ??
      auths[`https://${registry}/v2/`]
    );
  }

  private async bearerToken(
    ref: OrasReference,
    challenge: { realm: string; params: URLSearchParams },
    signal: AbortSignal,
  ): Promise<string> {
    const scope = challenge.params.get('scope') ?? `repository:${ref.repository}:pull`;
    const tokenUrl = new URL(challenge.realm);
    if (tokenUrl.protocol !== 'https:') {
      throw new Error(`Registry ${ref.registry} requested an insecure token service`);
    }
    for (const [key, value] of challenge.params) tokenUrl.searchParams.set(key, value);
    tokenUrl.searchParams.set('scope', scope);

    const headers = new Headers({ Accept: 'application/json' });
    const credential = await this.credentialFor(ref.registry);
    const basic = credential && decodeBasicCredential(credential);
    if (basic) headers.set('Authorization', `Basic ${basic}`);
    else if (credential?.identitytoken) {
      headers.set('Authorization', `Bearer ${credential.identitytoken}`);
    }

    const response = await this.fetchFn(tokenUrl.toString(), { headers, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Registry token request failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { token?: unknown; access_token?: unknown };
    const token =
      typeof body.token === 'string'
        ? body.token
        : typeof body.access_token === 'string'
          ? body.access_token
          : undefined;
    if (!token) throw new Error('Registry token response did not contain a token');
    return token;
  }

  private async registryFetch(
    ref: OrasReference,
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const request = async (authorization?: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (authorization) headers.set('Authorization', authorization);
      return this.fetchFn(url, { ...init, headers, signal });
    };

    const response = await request();
    if (response.status !== 401) return response;

    const challengeHeader = response.headers.get('www-authenticate') ?? '';
    await response.body?.cancel();
    const bearer = parseBearerChallenge(challengeHeader);
    if (bearer) {
      const token = await this.bearerToken(ref, bearer, signal);
      return request(`Bearer ${token}`);
    }
    if (/^Basic(?:\s|$)/i.test(challengeHeader)) {
      const credential = await this.credentialFor(ref.registry);
      const basic = credential && decodeBasicCredential(credential);
      if (basic) return request(`Basic ${basic}`);
    }
    return response;
  }

  private async resolveLayer(ref: OrasReference, signal: AbortSignal): Promise<OciDescriptor> {
    const response = await this.registryFetch(
      ref,
      registryUrl(ref, 'manifests', ref.manifestDigest),
      { headers: { Accept: `${OCI_MANIFEST}, ${DOCKER_MANIFEST}` } },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OCI manifest request failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      await response.body?.cancel();
      throw new Error(`OCI manifest exceeds the ${MAX_MANIFEST_BYTES}-byte safety limit`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new Error(`OCI manifest exceeds the ${MAX_MANIFEST_BYTES}-byte safety limit`);
    }
    const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actualDigest !== ref.manifestDigest) {
      throw new Error(
        `OCI manifest digest mismatch: expected ${ref.manifestDigest}, received ${actualDigest}`,
      );
    }

    let manifest: OciManifest;
    try {
      manifest = JSON.parse(bytes.toString('utf8')) as OciManifest;
    } catch {
      throw new Error('OCI manifest response was not valid JSON');
    }
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers)) {
      throw new Error('OCI response is not a version 2 image manifest');
    }
    if (manifest.layers.length !== 1) {
      throw new Error(
        `ORAS SIF image must contain exactly one layer, found ${manifest.layers.length}`,
      );
    }
    const layer = manifest.layers[0] as OciDescriptor;
    if (typeof layer.mediaType !== 'string' || !SIF_LAYER_MEDIA_TYPES.has(layer.mediaType)) {
      throw new Error(`Invalid SIF layer media type: ${String(layer.mediaType)}`);
    }
    if (typeof layer.size !== 'number' || !Number.isSafeInteger(layer.size) || layer.size <= 0) {
      throw new Error('SIF layer descriptor has an invalid size');
    }
    if (typeof layer.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(layer.digest)) {
      throw new Error('SIF layer descriptor has an invalid digest');
    }
    return { ...layer, digest: layer.digest.toLowerCase() };
  }

  private async downloadLayer(
    ref: OrasReference,
    layer: OciDescriptor,
    opts: ImportOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const size = layer.size as number;
    const digest = layer.digest as string;
    const response = await this.registryFetch(
      ref,
      registryUrl(ref, 'blobs', digest),
      { headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } },
      signal,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`OCI blob request failed with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength != null && Number(contentLength) !== size) {
      await response.body.cancel();
      throw new Error(
        `OCI blob size mismatch: expected ${size} bytes, server reported ${contentLength}`,
      );
    }
    const contentEncoding = response.headers.get('content-encoding');
    if (contentEncoding && contentEncoding !== 'identity') {
      await response.body.cancel();
      throw new Error(`OCI blob returned unsupported content encoding: ${contentEncoding}`);
    }

    const hash = createHash('sha256');
    let received = 0;
    let lastProgress = 5;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > size) {
          callback(new Error(`OCI blob exceeded its declared size of ${size} bytes`));
          return;
        }
        hash.update(chunk);
        const percent = Math.min(79, 5 + Math.floor((received / size) * 75));
        if (percent > lastProgress) {
          lastProgress = percent;
          opts.onProgress(percent);
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      response.body as AsyncIterable<Uint8Array>,
      progress,
      createWriteStream(opts.tmpPath, { flags: 'wx', mode: 0o600 }),
    );
    if (received !== size) {
      throw new Error(`OCI blob was truncated: expected ${size} bytes, received ${received}`);
    }
    const actualDigest = `sha256:${hash.digest('hex')}`;
    if (actualDigest !== digest) {
      throw new Error(`SIF layer digest mismatch: expected ${digest}, received ${actualDigest}`);
    }
    opts.onProgress(80);
  }

  async import(entry: CatalogEntry, opts: ImportOptions): Promise<void> {
    const ref = parseOrasReference(entry.image);
    const controller = new AbortController();
    const timeoutMs = this.config.pullTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const timer = setTimeout(
      () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
    try {
      opts.onProgress(1);
      const layer = await this.resolveLayer(ref, controller.signal);
      opts.onProgress(5);
      await this.downloadLayer(ref, layer, opts, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`OCI pull timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (this.config.verifySif) {
      const verify = await this.run(
        this.config.apptainerBin,
        ['verify', opts.tmpPath],
        this.config.pullTimeoutMs,
      );
      if (verify.code !== 0) {
        throw new Error(
          `SIF signature verification failed (exit ${verify.code}): ${verify.stderr.trim()}`,
        );
      }
    }
    opts.onProgress(100);
  }
}
