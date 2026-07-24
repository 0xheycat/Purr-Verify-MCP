# Contributing to Purr Verify MCP

Thanks for helping build **Purr Verify MCP** — a self-hosted verification runtime that gives coding agents real clone/build/test verification, browser QA, and operator jobs over MCP.

## Ways to contribute

- 🐛 **Fix bugs** — start with [`good first issue`](https://github.com/0xheycat/Purr-Verify-MCP/labels/good%20first%20issue).
- 🧪 **New verification checks** — more languages, frameworks, or CI signals.
- 🔌 **MCP tools** — extend the tool surface for agents.
- 📝 **Docs** — setup guides, self-hosting on new platforms.

## Getting started

```bash
git clone https://github.com/0xheycat/Purr-Verify-MCP
cd Purr-Verify-MCP
bun install       # or: npm install
bun run dev
```

## Pull request flow

1. Fork and branch: `git checkout -b feat/short-name`.
2. Keep tools well-typed and documented in the operating guide.
3. Add tests where practical and run the build locally.
4. Open a PR using the template and link the issue.

## Security

Never commit secrets. For vulnerabilities, see [SECURITY.md](SECURITY.md).

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Questions? Open a [Discussion](https://github.com/0xheycat/Purr-Verify-MCP/discussions).
