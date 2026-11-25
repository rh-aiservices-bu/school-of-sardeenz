# PatternFly 6 — Dashboard Guidelines

The Sardeenz dashboard uses [PatternFly 6](https://www.patternfly.org/) (PF6) as its design system and component library.

## Key Rules

- **Do NOT use Context7** for PatternFly components — it may return outdated PF4/PF5 patterns
- **Use [PatternFly.org](https://www.patternfly.org/)** as the authoritative reference
- Use the built-in `/patternfly-6-development` skill when working on dashboard components

## CSS and Tokens

- All PF CSS classes use the `pf-v6-` prefix (not `pf-v5-` or unprefixed)
- Use only `--pf-t--` semantic design tokens for custom styling
- Never use `--pf-v6-` component-level tokens directly — they are internal

```css
/* Correct */
.my-component {
  color: var(--pf-t--global--color--brand--default);
  padding: var(--pf-t--global--spacer--md);
}

/* Wrong — uses internal component token */
.my-component {
  color: var(--pf-v6--c-button--m-primary--Color);
}
```

## Import Patterns

```typescript
// Components
import { Button, Card, CardBody } from '@patternfly/react-core';

// Icons
import { PlusCircleIcon } from '@patternfly/react-icons';

// Charts
import { Chart, ChartBar } from '@patternfly/react-charts/victory';

// Table
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
```

## Layout Patterns

- Use `Page`, `PageSection`, and `PageSidebar` for top-level layout
- Use `Grid`/`GridItem` for responsive multi-column layouts
- Use `Stack`/`StackItem` for vertical stacking
- Use `Split`/`SplitItem` for horizontal alignment

## Accessibility

- All interactive elements must have accessible labels
- Use `aria-label` or `aria-labelledby` on icon-only buttons
- Follow PF6's built-in ARIA patterns — don't override them
- Test with keyboard navigation

## Unit testing (Vitest)

`dashboard/vitest.config.ts` keeps the whole test render tree on the dashboard's own React 18.3.1 copy
(issue #176), so PatternFly, router, i18next and react-query components render in unit tests. Three
levers, all in that file:

- `resolve.mainFields` is ESM-first — otherwise the resolver picks each package's CJS `main`
  (PatternFly's `dist/js`) and inlined CJS bypasses the alias table.
- `resolve.alias` (array form; anchored `find` regexes for the new entries) pins React, react-dom,
  `@testing-library/react` (root-hoisted, so its ESM build) **and** the packages whose consumed entry is
  CJS: `react-router-dom`, `react-router`, `react-router/dom`, `react-virtualized-auto-sizer`,
  `use-sync-external-store`.
- `test.server.deps.inline` lists every React-consuming package family, so their `import 'react'` goes
  through the alias table. Externalized modules are loaded natively by Node and bind the monorepo-root
  React 19 copy no matter what the aliases say.

No CSS stub or `resolve.conditions` is needed: once PatternFly is inlined, Vite's own CSS pipeline handles
its `react-styles` imports.

Adding a React-consuming dependency: add its family to `test.server.deps.inline` and a case to
`src/__tests__/render-probes.test.tsx`. A package that only ships CJS also needs an ESM-entry alias —
`inline` cannot fix it (inlined CJS runs with a native `require`). Bumping PatternFly, nivo, TanStack or
router majors means re-checking the alias targets (`dist/index.mjs`, `dist/development/*.mjs`, `…esm.js`).

Two jsdom limits that are not React problems:

- nivo `Responsive*` wrappers (and `react-virtualized-auto-sizer` directly) never measure in jsdom
  (`offsetWidth`/`offsetHeight` are 0), so the render prop is never called: give `Bar`/`Line` explicit
  `width`/`height`, or mock the auto-sizer.
- `@patternfly/react-charts` must be imported through its `/victory` subpath (as the app does): the bare
  specifier's `module` field points at a file that does not exist upstream.

Anything that needs real layout, real measurement or a real browser still belongs in the Playwright suite
(`dashboard/e2e/`).

## Reference

- [PatternFly.org Components](https://www.patternfly.org/components/all-components/)
- [PatternFly.org Layouts](https://www.patternfly.org/layouts/about-layouts/)
- [PatternFly.org Design Tokens](https://www.patternfly.org/tokens/all-patternfly-tokens/)
- [Sardeenz v1 UI patterns](https://github.com/rh-aiservices-bu/sardeenz) — reference for cherry-picking
