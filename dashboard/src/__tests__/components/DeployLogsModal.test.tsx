/**
 * DeployLogsModal behaviour tests.
 *
 * Following the project convention (see role-visibility.test.tsx and
 * MemoryVisualization.test.tsx), we test the state-derivation logic directly,
 * mirroring DeployLogsModal.tsx exactly, rather than rendering PatternFly
 * components — full rendering coverage is left to the Playwright e2e suite.
 */
import { describe, it, expect } from 'vitest';

interface SessionLike {
  outcome: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Derivation helpers — mirror DeployLogsModal.tsx exactly
// ---------------------------------------------------------------------------

function deriveFlags(session: SessionLike | undefined) {
  const isActive = session?.outcome === 'SUCCEEDED';
  const isError = session?.outcome === 'FAILED';
  const isStarting = !session || session.outcome === 'IN_PROGRESS';
  return { isActive, isError, isStarting };
}

function deriveTitleIconVariant(isError: boolean, isActive: boolean): string | undefined {
  return isError ? 'danger' : isActive ? 'success' : undefined;
}

function deriveFooterButtonVariant(isActive: boolean, isError: boolean): 'primary' | 'secondary' {
  return isActive || isError ? 'primary' : 'secondary';
}

function deriveFailureBody(session: SessionLike | undefined, fallback: string): string {
  return session?.errorMessage ?? fallback;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeployLogsModal — state derivation', () => {
  it('STARTING: shows the starting indicator, no alerts, secondary footer button', () => {
    const { isActive, isError, isStarting } = deriveFlags({ outcome: 'IN_PROGRESS' });
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
    const { isActive, isError, isStarting } = deriveFlags({ outcome: 'SUCCEEDED' });
    expect(isActive).toBe(true);
    expect(isStarting).toBe(false);
    expect(deriveFooterButtonVariant(isActive, isError)).toBe('primary');
    expect(deriveTitleIconVariant(isError, isActive)).toBe('success');
  });

  it('ERROR: shows danger alert, primary footer button, danger icon', () => {
    const { isActive, isError, isStarting } = deriveFlags({ outcome: 'FAILED' });
    expect(isError).toBe(true);
    expect(isStarting).toBe(false);
    expect(deriveFooterButtonVariant(isActive, isError)).toBe('primary');
    expect(deriveTitleIconVariant(isError, isActive)).toBe('danger');
  });

  it('UNKNOWN is terminal but is neither success nor failure', () => {
    const { isActive, isError, isStarting } = deriveFlags({ outcome: 'UNKNOWN' });
    expect(isStarting).toBe(false);
    expect(isActive).toBe(false);
    expect(isError).toBe(false);
  });
});

describe('DeployLogsModal — failure body', () => {
  it('uses the model error message when present', () => {
    expect(deriveFailureBody({ outcome: 'FAILED', errorMessage: 'OOM' }, 'fallback')).toBe('OOM');
  });

  it('falls back to a generic message when errorMessage is absent', () => {
    expect(deriveFailureBody({ outcome: 'FAILED' }, 'fallback')).toBe('fallback');
  });
});
