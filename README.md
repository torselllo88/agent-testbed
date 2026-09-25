# Agent Testbed

A small, configurable testbed for multi-agent LLM coordination experiments.
Several independent LLM agents, each holding only part of the information,
talk in a shared room, reach a collective decision, and have that decision
checked by a deterministic evaluator.

> **Work in progress.** This repository is being migrated from
> [RoleCase](https://github.com/torselllo88/rolecase); the unmodified starting
> point is tagged `rolecase-baseline` (`git diff rolecase-baseline` shows the
> full transformation). Full documentation lands with the first end-to-end
> prototype.

## Quick start

Requires Node.js ≥ 22.5.0.

```
npm install
npm run gui      # http://localhost:3939
npm test
```

Copy `.env.example` to `.env` to configure real LLM providers (OpenRouter,
Azure OpenAI). Without it everything runs on the deterministic stub provider.

## License

Apache-2.0 — see [LICENSE](LICENSE).
