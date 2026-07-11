# README and Ledger Documentation Refresh

## Scope

- Update `README.md` to document the personal E-Invoice workflow, the Spending page, per-item category editing, and the Traditional Chinese README link.
- Add `README.zh-TW.md` as a complete Traditional Chinese version of the user-facing README.
- Update `docs/raw-ledger.md` to describe normalized personal invoice tables, E-Invoice reimport/upsert behavior, item sequence normalization, and persisted item categories.
- Keep historical implementation plans/specifications and desktop release instructions unchanged.

## Content Rules

- Keep commands, paths, route hashes, environment variables, and SQLite identifiers identical across languages.
- Treat local financial data and credentials as sensitive in both README versions.
- Describe implemented behavior only; do not add roadmap or speculative setup instructions.
- Link the English and Traditional Chinese README files to each other near the title.

## Verification

- Check every documented npm command against `package.json`.
- Search the updated Markdown for stale claims that E-Invoice rows are append-only or uncategorized.
- Run the repository privacy and secrets checks because the documentation mentions credential and local-data paths.
