# Patent-assistant source attribution

- Upstream: https://github.com/Dyp130/Patent-assistant
- Upstream commit reviewed: `7123187a1e071b402c4e87ff6d2ce8d1aff825e4`
- License: MIT (`LICENSE.txt` in this directory)

SkyViewLab preserves and reimplements the upstream project-list, core-concept,
ten-chapter editor, figure checklist, version history, streaming generation and
Markdown/DOCX export workflow. The browser interface is implemented in React,
the control plane and audit boundary are implemented in Go, and deterministic
document analysis and generation are implemented in Python. Model credentials
remain on the server and are never bundled into the browser application.
