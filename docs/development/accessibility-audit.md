# Accessibility Audit Checklist

Practical checklist for auditing the Sardeenz dashboard. Run this after significant UI changes.

Automated scanning is handled by `dashboard/e2e/accessibility.spec.ts` (axe-core, WCAG 2.1 AA). The items below cover what automation cannot catch.

---

## Keyboard Navigation

- [ ] Tab order is logical and follows the visual reading order
- [ ] Focus indicator is clearly visible on every interactive element (buttons, links, form fields, dropdowns)
- [ ] All interactive elements are reachable without a mouse
- [ ] Modal dialogs trap focus — Tab and Shift+Tab cycle only within the open modal
- [ ] Pressing Escape closes modals and dropdowns
- [ ] Dropdown menus support arrow key navigation
- [ ] No keyboard traps outside of intentional modal focus locks

## Screen Reader

- [ ] All images and icons have meaningful `alt` text or `aria-label`, or are marked `aria-hidden` if decorative
- [ ] Form inputs have associated `<label>` elements (or `aria-label` / `aria-labelledby`)
- [ ] Error messages are linked to their inputs via `aria-describedby`
- [ ] Live regions (`aria-live`) announce dynamic changes (SSE connection status, mutation results)
- [ ] Tables have `<caption>` or `aria-label`, and all column headers use `<th scope="col">`
- [ ] Charts expose a text alternative (title, description, or summary)
- [ ] Progress bars have an accessible name via `aria-label`
- [ ] Status badges (model state, worker status) convey meaning through text, not colour alone

## Colour and Contrast

- [ ] Text contrast meets WCAG AA (4.5:1 for body text, 3:1 for large text / UI components)
- [ ] No information is conveyed by colour alone — labels or icons supplement colour-coded states
- [ ] Focus indicators have sufficient contrast against their background
- [ ] Warning and error states use both colour and an icon or text

## Charts

- [ ] Each chart card has an `ariaDesc` and `ariaTitle` prop describing the data
- [ ] Legend labels include the value, not just a colour swatch
- [ ] Voronoi tooltip container is keyboard-accessible
- [ ] An alternative text summary is available for screen reader users when chart data is meaningful

## Forms (Deploy Model, Login)

- [ ] Required fields are marked `isRequired` and exposed to screen readers
- [ ] Validation errors are announced as `role="alert"` or `aria-live="assertive"`
- [ ] Helper text is linked via `aria-describedby`
- [ ] Submit buttons are disabled (not hidden) when submission is in progress

---

## Running the Automated Scan

```bash
# From the repo root
npm run test:e2e --workspace=@sardeenz/dashboard -- --grep accessibility
```

Violations are reported with a full HTML detail report. Fix all WCAG 2.1 AA violations before merging.
