/**
 * DeployLogsModal behaviour tests.
 *
 * Following the project convention (see role-visibility.test.tsx and
 * MemoryVisualization.test.tsx), we test the state-derivation logic directly,
 * mirroring DeployLogsModal.tsx exactly, rather than rendering PatternFly
 * components — full rendering coverage is left to the Playwright e2e suite.
 */
import { describe, it, expect } from 'vitest';

type ModelLifecycleState =
  | 'PENDING'
  | 'STARTING'
  | 'ACTIVE'
  | 'SLEEPING'
  | 'DRAINING'
  | 'STOPPING'
  | 'STOPPED'
  | 'ERROR';

interface ModelLike {
  state: ModelLifecycleState;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Derivation helpers — mirror DeployLogsModal.tsx exactly
// ---------------------------------------------------------------------------

function deriveFlags(model: ModelLike | undefined) {
  const isActive = model?.state === 'ACTIVE';
  const isError = model?.state === 'ERROR';
  const isStarting = model?.state === 'STARTING' || model === undefined;
  return { isActive, isError, isStarting };
}

function deriveTitleIconVariant(isError: boolean, isActive: boolean): string | undefined {
  return isError ? 'danger' : isActive ? 'success' : undefined;
}

function deriveFooterButtonVariant(isActive: boolean, isError: boolean): 'primary' | 'secondary' {
  return isActive || isError ? 'primary' : 'secondary';
}

function deriveFailureBody(model: ModelLike | undefined, fallback: string): string {
  return model?.errorMessage ?? fallback;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeployLogsModal — state derivation', () => {
  it('STARTING: shows the starting indicator, no alerts, secondary footer button', () => {
    const { isActive, isError, isStarting } = deriveFlags({ state: 'STARTING' });
    expect(isStarting).toBe(true);
    expect(isActive).toBe(false);
    expect(isError).toBe(false);
    expect(deriveFooterButtonVariant(isActive, isError)).toBe('secondary');
    expect(deriveTitleIconVariant(isError, isActive)).toBeUndefined();
  });

  it('model not yet loaded is treated as starting (shows indicator, not an error)', () => {
    const { isStarting, isError } = deriveFlags(undefined);
    expect(isStarting).toBe(true);
    expect(isError).toBe(false);
  });

  it('ACTIVE: shows success alert, primary footer button, success icon', () => {
    const { isActive, isError, isStarting } = deriveFlags({ state: 'ACTIVE' });
    expect(isActive).toBe(true);
    expect(isStarting).toBe(false);
    expect(deriveFooterButtonVariant(isActive, isError)).toBe('primary');
    expect(deriveTitleIconVariant(isError, isActive)).toBe('success');
  });

  it('ERROR: shows danger alert, primary footer button, danger icon', () => {
    const { isActive, isError, isStarting } = deriveFlags({ state: 'ERROR' });
    expect(isError).toBe(true);
    expect(isStarting).toBe(false);
    expect(deriveFooterButtonVariant(isActive, isError)).toBe('primary');
    expect(deriveTitleIconVariant(isError, isActive)).toBe('danger');
  });

  it('other transient states (PENDING, DRAINING, ...) are not starting/active/error', () => {
    for (const state of ['PENDING', 'SLEEPING', 'DRAINING', 'STOPPING', 'STOPPED'] as const) {
      const { isActive, isError, isStarting } = deriveFlags({ state });
      expect(isStarting).toBe(false);
      expect(isActive).toBe(false);
      expect(isError).toBe(false);
    }
  });
});

describe('DeployLogsModal — failure body', () => {
  it('uses the model error message when present', () => {
    expect(deriveFailureBody({ state: 'ERROR', errorMessage: 'OOM' }, 'fallback')).toBe('OOM');
  });

  it('falls back to a generic message when errorMessage is absent', () => {
    expect(deriveFailureBody({ state: 'ERROR' }, 'fallback')).toBe('fallback');
  });
});
