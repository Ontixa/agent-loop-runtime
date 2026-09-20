# Contributing to Agent Loop Runtime

Thank you for your interest in contributing! Here's how you can help:

## 🐛 Reporting Bugs

- Check the [Issues](https://github.com/Ontixa/agent-loop-runtime/issues) page first
- Include:
  - Node.js version (`node --version`)
  - Agent CLI + version (e.g. `qwen --version`, `codex --version`)
  - Steps to reproduce
  - Mission record + events from `.agentloop/missions/<id>/` (redact anything sensitive)

## ✨ Requesting Features

- Open a feature request issue
- Describe the use case and why it's valuable
- Keep scope focused — one feature per issue

## 🔧 Pull Requests

### Before You Start

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Run `npm install` and `npx tsc --noEmit` to verify setup

### Code Standards

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **ESM imports** — use `.js` extension for local imports
- **No console.log** — use the `logger` module instead
- **No `shell: true`, no `exec`** — all processes go through `process-supervisor`
- **No raw git strings** — all git ops through `git-runner` allowlist
- See `docs/design-guidelines.md` for the safety invariants

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add gemini adapter flag support
fix: handle Windows spawn ENOENT error
docs: update README with new config options
```

### Before Submitting

- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] `npm run build` passes
- [ ] `npx tsx --test src/__tests__/*.test.ts` is green
- [ ] Tests added for behavior changes (fake agents — never vendor CLIs)
- [ ] README/docs updated if behavior changed
- [ ] No sensitive data (API keys, tokens, machine paths) in code or commits

## 📖 Documentation

Docs live in `docs/` — see `docs/` for the required structure. Improvements welcome.

## 🚀 Development Workflow

```bash
npm install
npm run build                  # or: npx tsc --watch
npx tsx src/cli.ts --help      # run the CLI from source
npx tsx --test src/__tests__/  # test suite (fake agents, no vendor CLIs needed)
```

## Questions?

Open a [Discussion](https://github.com/Ontixa/agent-loop-runtime/discussions) or tag maintainers in issues/PRs.
