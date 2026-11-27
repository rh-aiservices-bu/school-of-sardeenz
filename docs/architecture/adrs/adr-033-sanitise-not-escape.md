# ADR-033: Untrusted Text Rendered Into a Rendered Surface Is Sanitised by Whitelist, Never Escaped

## Status

Accepted. Implements [#338](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/338)
(M22). First applied to the nightly advisory issue body
(`tests/security/report-advisories.mjs`); the rule is general.

## Context

The nightly advisory sweep renders upstream advisory metadata — npm titles and severities, cargo
advisory ids, pip descriptions, URLs — into a GitHub issue body. That metadata is only
semi-trusted: an attacker who can influence an advisory record can influence what a maintainer
sees in a security-labelled issue.

The first implementation escaped markdown metacharacters one character class at a time. Three
review rounds each found another character that survived:

1. No escaping → a crafted title became a live link and an `@mention`.
2. Escaping `[ ] ( ) @ |` plus code-span ids → a value containing `\|` double-escaped to `\\|`,
   which GFM reads as an escaped backslash followed by a **row-splitting pipe**; the row gained a
   column and the text after the pipe rendered outside the code span as a live autolink.
3. A lone `\r` ended the table row for the same reason.

Each round produced a plausible-looking fix and a new hole, because escaping is a blacklist: it is
correct only if the list of dangerous characters is complete, and the renderer's own grammar decides
that, not us.

## Decision

1. **Sanitise per field, by whitelist, before anything is rendered.** Every upstream value passes
   through a field-specific sanitiser: advisory ids allow `[A-Za-z0-9.-]`, package names
   `[A-Za-z0-9._@/+:-]`, versions `[A-Za-z0-9.+~<>=-]`, severity a closed set
   (`low|moderate|medium|high|critical|unknown`), and free text has every markup-capable character
   removed, whitespace collapsed and the result capped. A value that fails its whitelist becomes
   `unknown` rather than being repaired.
2. **No escaping layer exists to get wrong.** Because no input can contain a pipe, a backtick, a
   backslash or a bracket, the cell assembler only normalises newlines/tabs/CR. There is no second
   pass that could double-escape.
3. **Links are constructed, not trusted.** Only `http(s)` destinations become links; cargo and pip
   links are built from the sanitised id against a fixed host (`rustsec.org`, `osv.dev`), and npm
   links from the sanitised GHSA id against `github.com/advisories`. An upstream `url` field is
   never a link source — a valid attacker URL is exactly what a scheme check cannot catch.
4. **The sanitiser is rehearsed, and the rehearsal has teeth.** Committed fixtures cover a pipe, a
   pre-escaped `\|`, a two-backtick run, `](https://…)`, an `@mention`, a bare URL, a
   `javascript:` URL, hostile ids/names/severities/versions and an over-long title; the check
   counts cells against the header and asserts no live markup survives. Mutating the sanitiser must
   make it fail — a fixture the check does not exercise is decoration.

## Consequences

- Report text is slightly less faithful to upstream (a hostile or unusual value reads as `unknown`,
  and long text is truncated with `…`). That is the intended trade: a security report must not be a
  rendering surface.
- Real-world values (`CVE-2024-1234`, `GHSA-…`, `lodash`, `^4.17.21`, `moderate`) pass unchanged;
  the whitelists were chosen against real advisory data, not in the abstract.
- Any future renderer — a terminal summary, an HTML page, a chat message — starts from the same
  rule. Escaping untrusted text into a grammar is the bug, not the fix.
- The specific attack surface (mentions/links in a GitHub issue) is low severity; the reason this is
  a decision record is the _pattern_: three "correct" escapes in a row.

## Non-goals

- Sanitising the advisory _data_ that the audits produce (tool output is stored verbatim as
  artifacts; only the rendered issue body is sanitised).
- HTML sanitisation of the dashboard (React escapes by construction; this rule is for text we
  assemble into a markup document ourselves).
- Validating advisory URLs against an allowlist of hosts — construction from ids makes that moot.
