# Alfred

A reusable agent harness for the browser, shown through a movie recommender. Rules handle most requests instantly; embeddings handle free text; an LLM runs only for multi-step tasks. Runs on the Cloudflare free plan.

Work in progress.

## Structure

- `libs/agent-harness` - parser, router, tool registry, agent loop
- `apps/web` - movies app (Vite + React) and Cloudflare Pages Functions

## Run

```sh
pnpm install
pnpm dev     # http://localhost:5173
pnpm -r test
```

## Data

<img src="assets/tmdb.svg" alt="TMDB" height="12"> This product uses the TMDB API but is not endorsed or certified by TMDB.
