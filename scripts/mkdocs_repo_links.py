"""MkDocs hook: rewrite links that point outside ``docs/`` to GitHub URLs.

The markdown under ``docs/`` links to source files with repo-relative paths
(``../../packages/contracts/specs/control-plane.yaml``). Those links work on
GitHub and in editors but have no target in the published site, and
``mkdocs build --strict`` treats them as errors. This hook resolves each
relative link against the page location and, when it escapes the docs
directory, replaces it with ``<repo_url>/blob/<branch>/<path>`` (``tree`` for
directories). Links to docs that are deliberately not published (``exclude_docs``:
project planning and ADRs) are rewritten the same way, to ``docs/<path>`` in the
repo. Every other link inside ``docs/`` is left alone so MkDocs keeps validating it.
"""

from __future__ import annotations

import posixpath
import re

BRANCH = "dev"
REPO_ONLY_PREFIXES = ("project/", "architecture/adrs/", "architecture/archive/")
_LINK = re.compile(r"(?<!\\)\]\(([^)\s]+)(\s+\"[^\"]*\")?\)")
_SKIP_PREFIXES = ("http://", "https://", "mailto:", "#", "/", "//")


def on_page_markdown(markdown: str, page, config, files) -> str:
    repo_url = (config.get("repo_url") or "").rstrip("/")
    if not repo_url:
        return markdown
    page_dir = posixpath.dirname(page.file.src_uri)

    def rewrite(match: re.Match[str]) -> str:
        target = match.group(1)
        title = match.group(2) or ""
        if target.startswith(_SKIP_PREFIXES) or "://" in target:
            return match.group(0)
        path, _, fragment = target.partition("#")
        resolved = posixpath.normpath(posixpath.join(page_dir, path))
        if resolved.startswith("../"):
            repo_path = resolved.removeprefix("../")
        elif resolved.startswith(REPO_ONLY_PREFIXES):
            repo_path = f"docs/{resolved}"
        else:
            return match.group(0)
        kind = "tree" if path.endswith("/") or "." not in posixpath.basename(repo_path) else "blob"
        url = f"{repo_url}/{kind}/{BRANCH}/{repo_path}"
        if fragment:
            url += f"#{fragment}"
        return f"]({url}{title})"

    return _LINK.sub(rewrite, markdown)
