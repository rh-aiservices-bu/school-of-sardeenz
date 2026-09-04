import { expect, test } from '@playwright/test';
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDistFresh } from './global-setup.js';

const temporaryDashboards: string[] = [];

test.afterEach(() => {
  for (const dashboardRoot of temporaryDashboards.splice(0)) {
    rmSync(dashboardRoot, { recursive: true, force: true });
  }
});

function createDashboardTree(): {
  dashboardRoot: string;
  distEntry: string;
  publicDirectory: string;
  nestedAsset: string;
  obsoleteAsset: string;
} {
  const dashboardRoot = mkdtempSync(join(tmpdir(), 'sardeenz-e2e-global-setup-'));
  temporaryDashboards.push(dashboardRoot);

  const publicDirectory = join(dashboardRoot, 'public');
  const nestedDirectory = join(publicDirectory, 'assets', 'nested');
  const nestedAsset = join(nestedDirectory, 'logo.svg');
  const obsoleteAsset = join(publicDirectory, 'obsolete.svg');
  const distEntry = join(dashboardRoot, 'dist', 'client', 'index.html');

  mkdirSync(nestedDirectory, { recursive: true });
  mkdirSync(join(dashboardRoot, 'dist', 'client'), { recursive: true });
  writeFileSync(nestedAsset, '<svg />');
  writeFileSync(obsoleteAsset, '<svg />');
  writeFileSync(distEntry, '<!doctype html>');

  return { dashboardRoot, distEntry, publicDirectory, nestedAsset, obsoleteAsset };
}

function setMtime(path: string, timestamp: number): void {
  const time = new Date(timestamp);
  utimesSync(path, time, time);
}

test.describe('dist freshness guard', () => {
  test('rejects a build older than a nested public asset', () => {
    const { dashboardRoot, distEntry, publicDirectory, nestedAsset, obsoleteAsset } =
      createDashboardTree();
    const directoryTime = Date.UTC(2024, 0, 1);
    const buildTime = Date.UTC(2024, 0, 2);
    const sourceTime = Date.UTC(2024, 0, 3);

    setMtime(distEntry, buildTime);
    setMtime(nestedAsset, sourceTime);
    setMtime(obsoleteAsset, directoryTime);
    setMtime(join(publicDirectory, 'assets', 'nested'), directoryTime);
    setMtime(join(publicDirectory, 'assets'), directoryTime);
    setMtime(publicDirectory, directoryTime);

    expect(() => assertDistFresh(dashboardRoot)).toThrow(
      '[e2e] dist/client is older than the client source',
    );
  });

  test('rejects a stale build when a public asset was deleted', () => {
    const { dashboardRoot, distEntry, publicDirectory, nestedAsset, obsoleteAsset } =
      createDashboardTree();
    const remainingAssetTime = Date.UTC(2024, 0, 1);
    const buildTime = Date.UTC(2024, 0, 2);
    const deletionTime = Date.UTC(2024, 0, 3);

    rmSync(obsoleteAsset);
    setMtime(nestedAsset, remainingAssetTime);
    setMtime(join(publicDirectory, 'assets', 'nested'), remainingAssetTime);
    setMtime(join(publicDirectory, 'assets'), remainingAssetTime);
    setMtime(publicDirectory, deletionTime);
    setMtime(distEntry, buildTime);

    expect(() => assertDistFresh(dashboardRoot)).toThrow(
      '[e2e] dist/client is older than the client source',
    );
  });

  test('rejects a stale build when a public asset was renamed', () => {
    const { dashboardRoot, distEntry, publicDirectory, nestedAsset, obsoleteAsset } =
      createDashboardTree();
    const remainingAssetTime = Date.UTC(2024, 0, 1);
    const buildTime = Date.UTC(2024, 0, 2);
    const renameTime = Date.UTC(2024, 0, 3);
    const renamedAsset = join(publicDirectory, 'renamed.svg');

    renameSync(obsoleteAsset, renamedAsset);
    setMtime(renamedAsset, remainingAssetTime);
    setMtime(nestedAsset, remainingAssetTime);
    setMtime(join(publicDirectory, 'assets', 'nested'), remainingAssetTime);
    setMtime(join(publicDirectory, 'assets'), remainingAssetTime);
    setMtime(publicDirectory, renameTime);
    setMtime(distEntry, buildTime);

    expect(() => assertDistFresh(dashboardRoot)).toThrow(
      '[e2e] dist/client is older than the client source',
    );
  });

  test('accepts a build newer than a nested public asset', () => {
    const { dashboardRoot, distEntry, publicDirectory, nestedAsset, obsoleteAsset } =
      createDashboardTree();
    const sourceTime = Date.UTC(2024, 0, 1);
    const buildTime = Date.UTC(2024, 0, 2);

    setMtime(nestedAsset, sourceTime);
    setMtime(obsoleteAsset, sourceTime);
    setMtime(join(publicDirectory, 'assets', 'nested'), sourceTime);
    setMtime(join(publicDirectory, 'assets'), sourceTime);
    setMtime(publicDirectory, sourceTime);
    setMtime(distEntry, buildTime);

    expect(() => assertDistFresh(dashboardRoot)).not.toThrow();
  });

  test('rejects symbolic links in client source without following them', () => {
    const { dashboardRoot, publicDirectory } = createDashboardTree();
    const target = join(dashboardRoot, 'outside-public.txt');
    const link = join(publicDirectory, 'outside-public.txt');
    writeFileSync(target, 'not a public asset');

    try {
      symlinkSync(target, link);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM')
      ) {
        test.skip(true, 'symbolic links are not permitted on this platform');
        return;
      }
      throw error;
    }

    expect(() => assertDistFresh(dashboardRoot)).toThrow(
      '[e2e] symbolic links are not supported in client source',
    );
  });

  test('rejects cyclic symbolic links in client source', () => {
    const { dashboardRoot, publicDirectory } = createDashboardTree();
    const link = join(publicDirectory, 'cycle');

    try {
      symlinkSync(publicDirectory, link, 'dir');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM')
      ) {
        test.skip(true, 'symbolic links are not permitted on this platform');
        return;
      }
      throw error;
    }

    expect(() => assertDistFresh(dashboardRoot)).toThrow(
      '[e2e] symbolic links are not supported in client source',
    );
  });

  test('rejects a tree with no client source', () => {
    const dashboardRoot = mkdtempSync(join(tmpdir(), 'sardeenz-e2e-global-setup-'));
    temporaryDashboards.push(dashboardRoot);
    const distEntry = join(dashboardRoot, 'dist', 'client', 'index.html');
    mkdirSync(join(dashboardRoot, 'dist', 'client'), { recursive: true });
    writeFileSync(distEntry, '<!doctype html>');

    expect(() => assertDistFresh(dashboardRoot)).toThrow('[e2e] client source is missing');
  });
});
