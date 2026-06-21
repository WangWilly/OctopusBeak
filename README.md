# Libretto Playground

Minimal Libretto project for experimenting with browser automation workflows.

## Setup

Install dependencies:

```bash
npm install
```

Run Libretto's first-time setup:

```bash
npm run libretto:setup
```

The basic browser workflow does not require an OpenAI API key. Copy `.env.example` to `.env` only if your own workflow uses OpenAI-backed recovery, extraction, or other model calls.

## Run The Example

```bash
npm run run:example
```

The example workflow opens `https://example.com`, reads the page title and heading, and returns them as JSON.

Check TypeScript:

```bash
npm run typecheck
```

## Useful Commands

```bash
npm run libretto:status
npx libretto open https://example.com --headed --session demo
npx libretto snapshot --session demo
npx libretto exec --session demo "return await page.title()"
npx libretto close --session demo
```
