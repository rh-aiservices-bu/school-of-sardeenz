# Accessibility Audit Checklist

Practical checklist for auditing the Sardeenz dashboard. Run this after significant UI changes.

## Coverage Status

Automated axe-core scanning covers the following views:

- Cluster Overview (`/`)
- Model List with data and empty state (`/models`)
- Worker List with data and empty state (`/workers`)
- Model Detail (`/models/:name`)
- Worker Detail (`/workers/:id`)
- Deploy Model form (`/models/deploy`)
- Delete model confirmation modal
- Metrics Dashboard (`/metrics`)

The automated scan runs the WCAG 2.1 AA ruleset via axe-core. It catches many but not all accessibility issues — colour contrast, label association, role usage, and landmark structure are well covered; focus management within complex keyboard interactions and screen reader announcement quality require manual verification.

**A full manual WCAG 2.1 AA audit has not been completed.** The items below are a checklist for future manual verification. Checked items have been reviewed against the code; unchecked items are pending.

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

- [x] All images and icons have meaningful `alt` text or `aria-label`, or are marked `aria-hidden` if decorative — PatternFly icons use `aria-hidden` by default; custom icons in the codebase follow this pattern
- [x] Form inputs have associated `<label>` elements (or `aria-label` / `aria-labelledby`) — Deploy Model form uses PatternFly `FormGroup` with `label` props wired to field IDs
- [ ] Error messages are linked to their inputs via `aria-describedby`
- [ ] Live regions (`aria-live`) announce dynamic changes (SSE connection status, mutation results)
- [x] Tables have `<caption>` or `aria-label`, and all column headers use `<th scope="col">` — Model and Worker list tables use `aria-label`; PatternFly `Th` renders with correct scope
- [ ] Charts expose a text alternative (title, description, or summary)
- [x] Progress bars have an accessible name via `aria-label` — GPU memory progress bars use `aria-label` with device index
- [x] Status badges (model state, worker status) convey meaning through text, not colour alone — `StateLabel` and `Label` components include text alongside colour

## Colour and Contrast

- [ ] Text contrast meets WCAG AA (4.5:1 for body text, 3:1 for large text / UI components)
- [x] No information is conveyed by colour alone — labels or icons supplement colour-coded states throughout
- [ ] Focus indicators have sufficient contrast against their background
- [ ] Warning and error states use both colour and an icon or text

## Charts

- [ ] Each chart card has an `ariaDesc` and `ariaTitle` prop describing the data
- [ ] Legend labels include the value, not just a colour swatch
- [ ] Voronoi tooltip container is keyboard-accessible
- [ ] An alternative text summary is available for screen reader users when chart data is meaningful

## Forms (Deploy Model)

- [x] Required fields are marked `isRequired` and exposed to screen readers — PatternFly `FormGroup isRequired` sets the visual asterisk and `aria-required` on the input
- [ ] Validation errors are announced as `role="alert"` or `aria-live="assertive"`
- [ ] Helper text is linked via `aria-describedby`
- [x] Submit buttons are disabled (not hidden) when submission is in progress — deploy button uses `isLoading` which disables the button during submission

---

## Running the Automated Scan

```bash
# From the repo root
npm run test:e2e --workspace=@sardeenz/dashboard -- --grep "Accessibility"
```

Violations are reported with a full HTML detail report. Fix all axe-reported WCAG 2.1 AA violations before merging. Note that passing the automated scan is a necessary but not sufficient condition for full WCAG 2.1 AA conformance.
