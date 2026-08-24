import { describe, it, expect } from 'vitest';
import {
  initialPanes,
  selectModel,
  closePane,
  resizePanes,
} from '../../../pages/Playground/paneState';

describe('initialPanes', () => {
  it('creates one empty pane for the single layout', () => {
    expect(initialPanes('single')).toEqual([null]);
  });

  it('creates two empty panes for the split layout', () => {
    expect(initialPanes('split')).toEqual([null, null]);
  });
});

describe('selectModel', () => {
  it('opens a session in the first empty pane', () => {
    expect(selectModel([null, null], 'llama-3')).toEqual(['llama-3', null]);
  });

  it('fills the next empty pane, leaving the first untouched', () => {
    expect(selectModel(['llama-3', null], 'mistral-7b')).toEqual(['llama-3', 'mistral-7b']);
  });

  it('is a no-op (focuses) when the model is already open in a pane', () => {
    expect(selectModel(['llama-3', 'mistral-7b'], 'llama-3')).toEqual(['llama-3', 'mistral-7b']);
  });

  it('replaces the last pane when no pane is empty', () => {
    expect(selectModel(['llama-3', 'mistral-7b'], 'gemma-2b')).toEqual(['llama-3', 'gemma-2b']);
  });

  it('supports a 2-pane layout with two independent sessions', () => {
    let panes = initialPanes('split');
    panes = selectModel(panes, 'llama-3');
    panes = selectModel(panes, 'mistral-7b');
    expect(panes).toEqual(['llama-3', 'mistral-7b']);
  });
});

describe('closePane', () => {
  it('clears the session at the given index', () => {
    expect(closePane(['llama-3', 'mistral-7b'], 0)).toEqual([null, 'mistral-7b']);
  });

  it('leaves other panes untouched', () => {
    expect(closePane(['llama-3', 'mistral-7b'], 1)).toEqual(['llama-3', null]);
  });
});

describe('resizePanes', () => {
  it('grows from single to split, preserving the existing session', () => {
    expect(resizePanes(['llama-3'], 'split')).toEqual(['llama-3', null]);
  });

  it('shrinks from split to single, dropping the second session', () => {
    expect(resizePanes(['llama-3', 'mistral-7b'], 'single')).toEqual(['llama-3']);
  });

  it('is a no-op when already the right size', () => {
    const panes = ['llama-3', null];
    expect(resizePanes(panes, 'split')).toBe(panes);
  });
});
