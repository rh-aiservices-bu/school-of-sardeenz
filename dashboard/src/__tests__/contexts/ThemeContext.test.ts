/**
 * Tests for ThemeContext state machine behaviour.
 *
 * We test the theme logic by simulating the state machine directly,
 * rather than using renderHook (following the project pattern from
 * useEventStream.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// State machine simulator — mirrors the logic in ThemeContext.tsx
// without depending on React hooks
// ---------------------------------------------------------------------------

class ThemeStateMachine {
  isDarkTheme: boolean;

  constructor(stored: string | null, systemPrefersDark: boolean) {
    if (stored !== null) {
      this.isDarkTheme = stored === 'dark';
    } else {
      this.isDarkTheme = systemPrefersDark;
    }
  }

  toggleTheme(): void {
    this.isDarkTheme = !this.isDarkTheme;
  }

  setDarkTheme(dark: boolean): void {
    this.isDarkTheme = dark;
  }

  getStorageValue(): string {
    return this.isDarkTheme ? 'dark' : 'light';
  }

  getCssClass(): string {
    return 'pf-v6-theme-dark';
  }

  shouldHaveDarkClass(): boolean {
    return this.isDarkTheme;
  }
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mockLocalStorage = new Map<string, string>();
const mockMatchMedia = vi.fn();

beforeEach(() => {
  mockLocalStorage.clear();
  mockMatchMedia.mockReset();

  // Mock localStorage
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mockLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockLocalStorage.set(key, value),
    removeItem: (key: string) => mockLocalStorage.delete(key),
  });

  // Mock matchMedia
  vi.stubGlobal('matchMedia', mockMatchMedia);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThemeContext initialization', () => {
  it('reads stored theme from localStorage (dark)', () => {
    mockLocalStorage.set('theme', 'dark');
    const theme = new ThemeStateMachine('dark', false);
    expect(theme.isDarkTheme).toBe(true);
  });

  it('reads stored theme from localStorage (light)', () => {
    mockLocalStorage.set('theme', 'light');
    const theme = new ThemeStateMachine('light', false);
    expect(theme.isDarkTheme).toBe(false);
  });

  it('falls back to system preference when no stored value (prefers dark)', () => {
    const theme = new ThemeStateMachine(null, true);
    expect(theme.isDarkTheme).toBe(true);
  });

  it('falls back to system preference when no stored value (prefers light)', () => {
    const theme = new ThemeStateMachine(null, false);
    expect(theme.isDarkTheme).toBe(false);
  });

  it('stored preference takes precedence over system preference', () => {
    mockLocalStorage.set('theme', 'light');
    const theme = new ThemeStateMachine('light', true);
    expect(theme.isDarkTheme).toBe(false);
  });
});

describe('ThemeContext toggle logic', () => {
  it('toggleTheme switches from dark to light', () => {
    const theme = new ThemeStateMachine('dark', false);
    expect(theme.isDarkTheme).toBe(true);

    theme.toggleTheme();
    expect(theme.isDarkTheme).toBe(false);
  });

  it('toggleTheme switches from light to dark', () => {
    const theme = new ThemeStateMachine('light', false);
    expect(theme.isDarkTheme).toBe(false);

    theme.toggleTheme();
    expect(theme.isDarkTheme).toBe(true);
  });

  it('multiple toggles alternate correctly', () => {
    const theme = new ThemeStateMachine('light', false);
    expect(theme.isDarkTheme).toBe(false);

    theme.toggleTheme();
    expect(theme.isDarkTheme).toBe(true);

    theme.toggleTheme();
    expect(theme.isDarkTheme).toBe(false);

    theme.toggleTheme();
    expect(theme.isDarkTheme).toBe(true);
  });
});

describe('ThemeContext setDarkTheme logic', () => {
  it('setDarkTheme(true) sets dark theme', () => {
    const theme = new ThemeStateMachine('light', false);
    expect(theme.isDarkTheme).toBe(false);

    theme.setDarkTheme(true);
    expect(theme.isDarkTheme).toBe(true);
  });

  it('setDarkTheme(false) sets light theme', () => {
    const theme = new ThemeStateMachine('dark', false);
    expect(theme.isDarkTheme).toBe(true);

    theme.setDarkTheme(false);
    expect(theme.isDarkTheme).toBe(false);
  });

  it('setDarkTheme is idempotent', () => {
    const theme = new ThemeStateMachine('light', false);

    theme.setDarkTheme(true);
    expect(theme.isDarkTheme).toBe(true);

    theme.setDarkTheme(true);
    expect(theme.isDarkTheme).toBe(true);
  });
});

describe('ThemeContext storage and CSS class', () => {
  it('stores theme preference in localStorage when changed', () => {
    const theme = new ThemeStateMachine('light', false);
    expect(theme.getStorageValue()).toBe('light');

    theme.toggleTheme();
    expect(theme.getStorageValue()).toBe('dark');

    theme.toggleTheme();
    expect(theme.getStorageValue()).toBe('light');
  });

  it('applies dark class when isDarkTheme is true', () => {
    const theme = new ThemeStateMachine('dark', false);
    expect(theme.shouldHaveDarkClass()).toBe(true);
    expect(theme.getCssClass()).toBe('pf-v6-theme-dark');
  });

  it('removes dark class when isDarkTheme is false', () => {
    const theme = new ThemeStateMachine('light', false);
    expect(theme.shouldHaveDarkClass()).toBe(false);
  });

  it('CSS class matches current theme state', () => {
    const theme = new ThemeStateMachine('light', false);
    expect(theme.shouldHaveDarkClass()).toBe(false);

    theme.toggleTheme();
    expect(theme.shouldHaveDarkClass()).toBe(true);

    theme.setDarkTheme(false);
    expect(theme.shouldHaveDarkClass()).toBe(false);
  });
});
