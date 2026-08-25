/**
 * Nivo chart theme helpers (ported from v1's chartTheme.v1.ts, #163).
 *
 * v1 detected dark mode via the same `.pf-v6-theme-dark` class v2's ThemeContext toggles on
 * `document.documentElement` (see src/contexts/ThemeContext.tsx), so the detection logic is
 * unchanged — only the export name is scoped to this file's new home.
 */
export function getNivoTooltipTheme() {
  const isDark = document.documentElement.classList.contains('pf-v6-theme-dark');
  return {
    tooltip: {
      container: {
        background: isDark ? '#1f1f1f' : '#ffffff',
        color: isDark ? '#e0e0e0' : '#151515',
        padding: '8px 12px',
        borderRadius: '4px',
        border: isDark ? '1px solid #3c3f42' : '1px solid #d2d2d2',
        boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
      },
    },
  };
}
