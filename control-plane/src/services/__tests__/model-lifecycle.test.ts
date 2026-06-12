import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';

import { isValidTransition, isTerminalState } from '../model-lifecycle.js';

describe('isValidTransition', () => {
  const validTransitions: [ModelLifecycleState, ModelLifecycleState][] = [
    [ModelLifecycleState.PENDING, ModelLifecycleState.STARTING],
    [ModelLifecycleState.PENDING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.STARTING, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.STARTING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.DRAINING],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.ERROR],
    [ModelLifecycleState.DRAINING, ModelLifecycleState.SLEEPING],
    [ModelLifecycleState.DRAINING, ModelLifecycleState.STOPPING],
    [ModelLifecycleState.DRAINING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.STARTING],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.STOPPING],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.STOPPING, ModelLifecycleState.STOPPED],
    [ModelLifecycleState.STOPPING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.ERROR, ModelLifecycleState.STOPPED],
    [ModelLifecycleState.ERROR, ModelLifecycleState.STARTING],
  ];

  for (const [from, to] of validTransitions) {
    it(`allows ${from} → ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }

  const invalidTransitions: [ModelLifecycleState, ModelLifecycleState][] = [
    [ModelLifecycleState.PENDING, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.PENDING, ModelLifecycleState.SLEEPING],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.SLEEPING],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.STARTING],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.STOPPED, ModelLifecycleState.STARTING],
    [ModelLifecycleState.STOPPED, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.STOPPED, ModelLifecycleState.ERROR],
  ];

  for (const [from, to] of invalidTransitions) {
    it(`rejects ${from} → ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

describe('isTerminalState', () => {
  it('STOPPED is terminal', () => {
    expect(isTerminalState(ModelLifecycleState.STOPPED)).toBe(true);
  });

  it('ACTIVE is not terminal', () => {
    expect(isTerminalState(ModelLifecycleState.ACTIVE)).toBe(false);
  });

  it('ERROR is not terminal', () => {
    expect(isTerminalState(ModelLifecycleState.ERROR)).toBe(false);
  });
});
