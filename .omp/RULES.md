# RULES.md — schools-of-sardeenz

Hard rules for working in this repository. Loaded as project context; do
not weaken without an explicit user decision recorded here.

## Git permissions (agent behavior)

- **Committing is allowed** without asking — on the correct branch per
  `docs/development/setup.md` (never `main`, never direct pushes to `dev`;
  branch from `dev`, PR back to `dev`).
- **Pushing to any remote ALWAYS requires the user's explicit permission**
  in the current conversation. A standing "you may push" applies only to
  the conversation it was given in.
- **Creating a PR ALWAYS requires the user's explicit permission** in the
  current conversation.
- NEVER force-push. NEVER amend and push a branch the user has already
  reviewed without asking again.
- When permission is granted, push only the branches named in the grant;
  do not push side branches that happened to accumulate.
