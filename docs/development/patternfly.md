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

## Reference

- [PatternFly.org Components](https://www.patternfly.org/components/all-components/)
- [PatternFly.org Layouts](https://www.patternfly.org/layouts/about-layouts/)
- [PatternFly.org Design Tokens](https://www.patternfly.org/tokens/all-patternfly-tokens/)
- [Sardeenz v1 UI patterns](https://github.com/rh-aiservices-bu/sardeenz) — reference for cherry-picking
