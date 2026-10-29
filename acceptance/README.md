# acceptance/

Owner-only. Agents never create, edit, or delete files here.

Each fixture is a trace window from the owner's data plus the owner's verdict on what the system should have done (see AGENTS.md section 9). Fixtures built from real data stay on the owner's machine; only synthetic or owner-approved redacted fixtures are committed.

`MANIFEST.sha256` lists the sha256 of every file here. CI (`scripts/guard_acceptance_manifest.mjs`) fails on any difference. CODEOWNERS plus branch protection on `main` is what stops edits; the manifest catches drift.
