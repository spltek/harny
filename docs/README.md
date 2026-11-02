# Reference tools

This folder contains **reference material only**, not code executed by the extension.

`REFERENCE_TOOLS.json` holds the tool definitions Harny took as a model — the well-known,
widely-used agent tool set (Cursor's), used as a reference for parameter schemas and behavior.
All tools actually implemented live in `src/core/tools/` with their own descriptions; this file is
never read at runtime and is **not** a mirror of them (only its `implemented` / `planned` lists are
kept in sync).