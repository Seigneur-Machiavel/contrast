# Contrast

> A transparent blockchain — because transparency is the consequence of a public network that nobody wants to own up to.

Contrast is an experimental blockchain built around a single founding principle: **full transparency**. Not as a feature, but as an architectural constraint. Decentralization follows naturally from it — not the other way around.

This is a playground for building real solutions with transparency as the foundation. No premine. No arbitrary smart contracts. No shortcuts.

**⚠️ Work in progress — not production-ready.**

---

## Philosophy

Most crypto projects lead with decentralization, privacy, or throughput. Contrast starts with a simpler observation: a public network has consequences — full transparency being the first one. Most projects quietly sidestep that. Contrast doesn't.

From that foundation:
- **Decentralization** comes second — it's the enforcement mechanism for transparency
- **Minimal L1** — an accounting layer, not a decentralized bank. Predefined scripts only, no Turing-complete execution
- **No premine, fair distribution** — the emission schedule is fixed and public
- **Hybrid POW/POS (50/50)** — both consensus mechanisms contribute to block validation

---

## Architecture overview

### Monorepo — intentional but temporary

This is a single repository by pragmatic choice. Managing separate npm packages has a cost, and solo development time is finite.

The codebase uses a simple convention to signal boundaries:

| Extension | Role |
|-----------|------|
| `.mjs` | **Future packages** — everything that will eventually be published: consensus, crypto, P2P, storage, utils. The extractable core. |
| `.js` | **App layer** — things a library consumer would never care about: wallet UI, explorer, launcher logic, etc. |

The frontend (`board/`) imports `.mjs` files directly — no build step, no duplication. This will evolve toward proper package separation as the project matures.

### Directory structure

```
contrast/
├── node/               # Node runner (run-client.mjs, run-public.mjs)
├── board/              # Frontend — WM-style interface (wallet, explorer, staking, P2P viz)
├── board-service.mjs   # HTTP service layer (vanilla node:http, no Express)
├── ext-libs/           # External dependencies (kept minimal)
├── utils/              # Utilities (.mjs — part of the future core)
├── storage/            # Storage layer (atomic writes, O(1) address lookups)
├── types/              # JSDoc type definitions
└── miniLogger/         # Lightweight logger with ANSI coloring, TTY-aware
```

### Key components

**Consensus** — Hybrid POW/POS. Solvers (≠ miners — terminology matters for policy compliance) compete on the POW side; validators stake on the POS side. Both contribute 50/50 to block finality.

**Storage** — Custom binary file format. Unified ledger and identity storage. 7-character Base58 addresses (`C123456` style) with direct file offsets for O(1) lookups.

**Networking** — Built on [HiveP2P](https://github.com/Seigneur-Machiavel/hive-p2p), a custom P2P library developed specifically for Contrast and published as a standalone npm package. Features entropy-maximizing topology, global network mapping via gossip, Ed25519 + Argon2id identity, and anti-Sybil proof-of-work.

**Desktop app** — Distributed as a Node.js SEA (Single Executable Application). The executable is just Node bundled with a loader — all application code remains plain `.js` files alongside it, fully readable. UI via Neutralino.js (WebView2). Auto-update via GitHub Releases (`manifest.json` + `resources.zip`).

---

## Running a node

> Requires Node.js (tested on v20+). No global install needed.

```bash
git clone https://github.com/Seigneur-Machiavel/contrast
cd contrast
npm install
```

**As a client node:**
```bash
node node/run-client.mjs
```

**As a public node:**
```bash
node node/run-public.mjs
```

Test entry points are available in the corresponding `test/` directories.

### Desktop app (Windows)

Grab the latest release from [GitHub Releases](https://github.com/Seigneur-Machiavel/contrast/releases):
- `resources.zip` — resources only
- `contrast.zip` — full bundle (executables + resources)

---

## Dependencies worth noting

- **[HiveP2P](https://github.com/Seigneur-Machiavel/hive-p2p)** — custom P2P networking layer (also available on npm)
- No Express — HTTP handled via vanilla `node:http`
- No TypeScript — vanilla JS throughout, JSDoc for typing

---

## Status

Early-stage. The architecture is stabilizing but APIs, storage formats, and consensus parameters are still moving. Don't build on top of this yet unless you're comfortable reading source code as documentation.

Contributions, issues, and hard questions are welcome.

---

*Built by [@PinkParrot aka @Seigneur-Machiavel](https://github.com/Seigneur-Machiavel)*