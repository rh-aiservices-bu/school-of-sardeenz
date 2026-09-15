/**
 * Delete-affordance gating tests (#172).
 *
 * After #140 the control plane 409s a DELETE while an instance is transient
 * (PENDING/DRAINING/STOPPING). STARTING is deliberately cancellable. These tests pin that the
 * dashboard hides Delete for the remaining transient states and keeps it for cancellable or
 * settled states.
 *
 * Following the project convention (see role-visibility.test.tsx, ModelDeploy.test.tsx) we test
 * the pure predicates that drive the JSX conditionals rather than rendering PatternFly
 * (PF/React version conflicts in this worktree). Full rendering coverage is left to e2e.
 */
import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import {
  canDeleteModelRow,
  canDeleteModelDetail,
  canDeleteInstanceRow,
  isTransientState,
} from '../../pages/Models/deleteGating';

const TRANSIENT: ModelLifecycleState[] = [
  ModelLifecycleState.PENDING,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.STOPPING,
];

const NON_TRANSIENT: ModelLifecycleState[] = [
  ModelLifecycleState.STARTING,
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.SLEEPING,
  ModelLifecycleState.STOPPED,
  ModelLifecycleState.ERROR,
];

describe('isTransientState', () => {
  it.each(TRANSIENT)('treats %s as transient', (state) => {
    expect(isTransientState(state)).toBe(true);
  });

  it.each(NON_TRANSIENT)('treats %s as non-transient', (state) => {
    expect(isTransientState(state)).toBe(false);
  });
});

describe('canDeleteModelRow (list kebab)', () => {
  it.each(TRANSIENT)('hides Delete for %s (would 409)', (state) => {
    expect(canDeleteModelRow(state)).toBe(false);
  });

  it.each(NON_TRANSIENT)('shows Delete for %s', (state) => {
    expect(canDeleteModelRow(state)).toBe(true);
  });
});

describe('canDeleteModelDetail (detail header — gates on "any instance transient")', () => {
  it.each(TRANSIENT)('hides Delete when any instance is %s', (state) => {
    const instances = [{ state: ModelLifecycleState.ACTIVE }, { state }];
    expect(canDeleteModelDetail(instances)).toBe(false);
  });

  it.each(NON_TRANSIENT)('shows Delete when the only instance is %s', (state) => {
    expect(canDeleteModelDetail([{ state }])).toBe(true);
  });

  it('shows Delete for a model with zero instances (STOPPED)', () => {
    expect(canDeleteModelDetail([])).toBe(true);
  });

  it('shows Delete when every instance is non-transient', () => {
    expect(
      canDeleteModelDetail([
        { state: ModelLifecycleState.ACTIVE },
        { state: ModelLifecycleState.SLEEPING },
      ]),
    ).toBe(true);
  });

  it('shows Delete for a mixed ACTIVE+STARTING model because startup is cancellable', () => {
    expect(
      canDeleteModelDetail([
        { state: ModelLifecycleState.ACTIVE },
        { state: ModelLifecycleState.STARTING },
      ]),
    ).toBe(true);
  });
});

describe('canDeleteInstanceRow (per-instance row)', () => {
  it.each(TRANSIENT)('hides Delete for a %s instance (would 409)', (state) => {
    expect(canDeleteInstanceRow(state)).toBe(false);
  });

  it.each(NON_TRANSIENT)('shows Delete for a %s instance', (state) => {
    expect(canDeleteInstanceRow(state)).toBe(true);
  });
});
