# Octopus Beak HyperFrames

Video workspace for dashboard animation sources.

## Dashboard source

From the repo root:

```bash
npm run run:seed-mock-ledger-db
LEDGER_DIR=data/mock-ledger vite dev
```

Use the running dashboard to create or update screenshots in `assets/captures/`.

## Video workspace

From the repo root:

```bash
npm --prefix docs/hyperframes install
npm run video:hyperframes
npm run video:hyperframes:render
```

From this directory:

```bash
npm run preview
npm run check
npm run render
```

The root project forwards `video:hyperframes` and `video:hyperframes:render` into this folder.
