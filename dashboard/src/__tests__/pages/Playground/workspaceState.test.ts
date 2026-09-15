import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ModelInfo } from '../../../api/client';
import {
  assignSessionToPane,
  getVisibleSessions,
  loadPersistedPreferences,
  loadPersistedSessionData,
  removeSessionAssignment,
  sortSessions,
  syncSessions,
} from '../../../pages/Playground/workspaceState';
import type { WorkspaceSession } from '../../../pages/Playground/workspace-types';

const model = (modelName: string, state = ModelLifecycleState.ACTIVE): ModelInfo => ({
  modelName,
  state,
  runnerType: 'vllm',
  instanceCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const session = (id: string, modelName: string, addedAt: string): WorkspaceSession => ({
  id,
  modelId: modelName,
  model: model(modelName),
  status: 'idle',
  addedAt,
});

const s1 = session('s1', 'alpha', '2026-01-01T00:00:01.000Z');
const s2 = session('s2', 'beta', '2026-01-01T00:00:02.000Z');
const s3 = session('s3', 'gamma', '2026-01-01T00:00:03.000Z');
const sessions = new Map([s3, s1, s2].map((s) => [s.id, s]));

describe('workspaceState', () => {
  describe('sortSessions', () => {
    it('orders by creation time', () => {
      expect(sortSessions(sessions.values()).map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    });
  });

  describe('getVisibleSessions', () => {
    it('returns nothing when there are no sessions', () => {
      expect(getVisibleSessions(new Map(), null, 'single', {})).toEqual([]);
    });

    it('single: shows the active session, else the oldest', () => {
      expect(getVisibleSessions(sessions, 's2', 'single', {}).map((s) => s.id)).toEqual(['s2']);
      expect(getVisibleSessions(sessions, null, 'single', {}).map((s) => s.id)).toEqual(['s1']);
      expect(getVisibleSessions(sessions, 'gone', 'single', {}).map((s) => s.id)).toEqual(['s1']);
    });

    it('split-2: falls back to creation order without assignments', () => {
      expect(getVisibleSessions(sessions, 's3', 'split-2', {}).map((s) => s.id)).toEqual([
        's1',
        's2',
      ]);
    });

    it('split-2: honours explicit assignments and fills the rest in order', () => {
      expect(getVisibleSessions(sessions, null, 'split-2', { 0: 's3' }).map((s) => s.id)).toEqual([
        's3',
        's1',
      ]);
      expect(
        getVisibleSessions(sessions, null, 'split-2', { 0: 's3', 1: 's2' }).map((s) => s.id),
      ).toEqual(['s3', 's2']);
    });

    it('ignores assignments pointing at removed sessions', () => {
      expect(getVisibleSessions(sessions, null, 'split-2', { 0: 'gone' }).map((s) => s.id)).toEqual(
        ['s1', 's2'],
      );
    });

    it('grid-4: never shows a session twice and caps at the session count', () => {
      const visible = getVisibleSessions(sessions, null, 'grid-4', { 0: 's2', 2: 's2' });
      expect(visible.map((s) => s.id)).toEqual(['s2', 's1', 's3']);
    });
  });

  describe('assignSessionToPane', () => {
    it('assigns and clears', () => {
      expect(assignSessionToPane({}, 1, 's2')).toEqual({ 1: 's2' });
      expect(assignSessionToPane({ 1: 's2' }, 1, null)).toEqual({});
    });

    it('swaps when the session is already shown in another pane', () => {
      expect(assignSessionToPane({ 0: 's1', 1: 's2' }, 0, 's2')).toEqual({ 0: 's2', 1: 's1' });
    });

    it('moves the session when the target pane had no assignment', () => {
      expect(assignSessionToPane({ 0: 's1' }, 1, 's1')).toEqual({ 1: 's1' });
    });
  });

  describe('removeSessionAssignment', () => {
    it('drops the session and returns the same object when absent', () => {
      const assignments = { 0: 's1', 1: 's2' };
      expect(removeSessionAssignment(assignments, 's1')).toEqual({ 1: 's2' });
      expect(removeSessionAssignment(assignments, 'zzz')).toBe(assignments);
    });
  });

  describe('syncSessions', () => {
    it('drops sessions whose model is no longer chattable', () => {
      const result = syncSessions(sessions, [model('alpha'), model('gamma')], null);
      expect(result.changed).toBe(true);
      expect(Array.from(result.sessions.keys())).toEqual(['s3', 's1']);
      expect(result.restoredActiveSessionId).toBeUndefined();
    });

    it('refreshes the model snapshot when its state changes', () => {
      const result = syncSessions(
        new Map([[s1.id, s1]]),
        [model('alpha', ModelLifecycleState.SLEEPING)],
        null,
      );
      expect(result.changed).toBe(true);
      expect(result.sessions.get('s1')?.model.state).toBe(ModelLifecycleState.SLEEPING);
    });

    it('returns the same map when nothing changed', () => {
      const prev = new Map([[s1.id, s1]]);
      const result = syncSessions(prev, [model('alpha')], null);
      expect(result.changed).toBe(false);
      expect(result.sessions).toBe(prev);
    });

    it('restores persisted sessions when none are open, keeping the active one', () => {
      let n = 0;
      const result = syncSessions(
        new Map(),
        [model('alpha'), model('beta')],
        { openModelIds: ['beta', 'missing', 'alpha'], activeModelId: 'alpha' },
        () => `id-${++n}`,
      );
      expect(result.changed).toBe(true);
      expect(Array.from(result.sessions.values()).map((s) => s.modelId)).toEqual(['beta', 'alpha']);
      expect(result.restoredActiveSessionId).toBe('id-2');
    });

    it('falls back to the first restored session when the active model is gone', () => {
      const result = syncSessions(
        new Map(),
        [model('beta')],
        { openModelIds: ['beta'], activeModelId: 'alpha' },
        () => 'only',
      );
      expect(result.restoredActiveSessionId).toBe('only');
    });

    it('does not restore when persisted models are all gone', () => {
      const prev = new Map<string, WorkspaceSession>();
      const result = syncSessions(prev, [model('beta')], {
        openModelIds: ['alpha'],
        activeModelId: 'alpha',
      });
      expect(result.changed).toBe(false);
      expect(result.sessions).toBe(prev);
    });
  });

  describe('persistence parsing', () => {
    const storageWith = (value: string | null) => ({ getItem: () => value });

    it('ignores malformed or unknown preference values', () => {
      expect(loadPersistedPreferences(storageWith('{not json'))).toEqual({});
      expect(
        loadPersistedPreferences(
          storageWith(JSON.stringify({ layout: 'grid-9', sidebarExpanded: 'yes' })),
        ),
      ).toEqual({});
      expect(
        loadPersistedPreferences(
          storageWith(JSON.stringify({ layout: 'grid-4', sidebarExpanded: false })),
        ),
      ).toEqual({ layout: 'grid-4', sidebarExpanded: false });
    });

    it('validates persisted session data', () => {
      expect(loadPersistedSessionData(storageWith(null))).toBeNull();
      expect(
        loadPersistedSessionData(storageWith(JSON.stringify({ openModelIds: 'x' }))),
      ).toBeNull();
      expect(
        loadPersistedSessionData(
          storageWith(JSON.stringify({ openModelIds: ['a', 1, 'b'], activeModelId: 7 })),
        ),
      ).toEqual({ openModelIds: ['a', 'b'], activeModelId: null });
    });
  });
});
