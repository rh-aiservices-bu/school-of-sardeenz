# Work item template — the self-sufficient standard

A work item is a contract an agent with no conversational history can execute and validate. Every section below is filled; "see discussion" or "as usual" is a defect. Anything that cannot be filled from the issue, the plan and the code is an **open question**, listed as such — never a guess.

The specification is posted as a **spec comment** on the issue (format in the project profile, *Tracker → spec comments*), never as a body edit — the body stays as its author wrote it. The comment uses these headings verbatim so that `implement-milestone` can locate them. A newer spec comment replaces an older one in full; decision comments override both.

---

## Summary

One or two sentences: the change, in the language of the user or system that will observe it. Where the body already says it well, point to it rather than restate it.

## Why

The goal this serves, so the implementer can make sensible micro-decisions. Link the plan section and the roadmap milestone.

## Where

The parts of the repository involved: workspaces/services, directories, the files expected to change (create vs modify). Real paths, verified to exist at authoring time.

## Constraints

What must not change. Which invariants from the context file apply. Which decision records constrain this (by id, with the one line that matters). Configurability requirements.

## Design

The existing pattern to follow, with a **`path:line` exemplar** for every kind of artifact this item creates (endpoint, view, schema, adapter, test). Data shapes and signatures at the level a blueprint would state them, when the item is small enough to skip a blueprint. Never describe a pattern abstractly when the repository already contains it.

## Dependencies

Other items or components that must exist first (by issue number), and what this item unblocks. Shared groundwork it relies on and which item builds it.

## Validation

How everyone will know it works: tests to add (file + named cases: happy, edge, failure; fixtures to reuse), commands to run, behaviour to observe and where (log line, UI state, endpoint response), acceptance criteria as a checklist. What is not locally verifiable, stated as such.

## References

Documents, decision records, prior issues and upstream docs that matter, each with why it matters in five words.

## Open questions

Everything the sections above could not settle. Each one blocks the item from being lighter than the Full pipeline until answered by a dated decision comment. Empty is a valid — and desirable — state.

## Proposed pipeline

`direct` / `light` / `full`, with the one-line reason and any add-on (security, boundary, spike) with its trigger. Applied as a `pipeline/*` label once the user agrees.

---

### Quick self-check for the author

- Could a competent engineer who has never seen this repository start within five minutes of reading body + this comment + the decisions? If they would have to ask someone, the answer is a missing section.
- Does every path exist? Does every exemplar line show what the item claims it shows?
- Is the validation section a checklist someone could tick, or a sentiment?
- Is "light" being proposed on a real exemplar and an empty *Open questions* section, or on optimism?
