import { describe, expect, it } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import { classifyMoveProgress } from '../../utils/move';

const source = { instanceId: 'old', state: ModelLifecycleState.ACTIVE, createdAt: '' };
const replacement = { instanceId: 'new', state: ModelLifecycleState.STARTING, createdAt: '' };

describe('classifyMoveProgress', () => {
  it('keeps a just-accepted replacement pending while stale detail omits it', () => {
    expect(classifyMoveProgress([source], 'old', 'new')).toBe('deploying');
  });

  it('only treats a replacement disappearance as failure after it was observed', () => {
    expect(classifyMoveProgress([source], 'old', 'new', true)).toBe('failed-before-cutover');
  });

  it('treats replacement ERROR and STOPPED as positive pre-cutover failure evidence', () => {
    expect(
      classifyMoveProgress(
        [{ ...replacement, state: ModelLifecycleState.ERROR }, source],
        'old',
        'new',
      ),
    ).toBe('failed-before-cutover');
    expect(
      classifyMoveProgress(
        [{ ...replacement, state: ModelLifecycleState.STOPPED }, source],
        'old',
        'new',
      ),
    ).toBe('failed-before-cutover');
  });
});
