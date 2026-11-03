# RoadmapProof

**On-chain accountability for crypto roadmap promises, judged by GenLayer validators.**

## The problem

Crypto teams announce dates all the time: "mainnet in Q3", "v2 by December", "mobile app next month". Holders buy on those promises. When the date passes and nothing ships, the team goes quiet, posts get deleted, and there is no neutral record of who delivered and who did not. Today the only "verification" is someone on X saying so — and they may be paid, biased or wrong.

## What RoadmapProof does

1. **Lock.** A team registers a promise: what it will deliver, a deadline, and the **official page** where proof will appear (GitHub releases, changelog, blog, docs). The team's wallet is recorded as the author.
2. **Read.** Anyone presses **Verify**. Every GenLayer validator opens that live page itself with `gl.nondet.web.render`.
3. **Agree.** An LLM judge on each validator decides `DELIVERED`, `NOT_DELIVERED` or `UNCLEAR`. Through `gl.eq_principle.prompt_comparative` the validators must reach the same verdict — no single model, server or admin decides.
4. **Settle.**
   - Delivered → status **KEPT**.
   - Not delivered and the deadline has passed → status **BROKEN**.
   - Not delivered but the deadline is still open, or the page is unclear → stays **PENDING** with the latest reason recorded. Anyone can check again later.
5. Every project earns a public **Trust Score** (kept ÷ resolved) from its history.

### Why GenLayer is required

A normal smart contract cannot read a website or understand whether "v2.0 with limit orders" was actually released. A centralized oracle could, but then you trust that oracle. RoadmapProof needs both **live web data** and **judgment**, agreed by independent validators — exactly what Intelligent Contracts provide.

## Project structure

```
RoadmapProof/
├── contracts/roadmap_proof.py   # Intelligent Contract
├── index.html                   # Frontend (single page)
├── app.js                       # genlayer-js wiring + transaction lifecycle UI
└── README.md
```

## Contract methods

| Method | Type | What it does |
|---|---|---|
| `create_promise(project, claim, evidence_url, deadline)` | write | Registers a promise. Deadline format `YYYY-MM-DD`. |
| `verify_promise(promise_id)` | write | Validators read the evidence page, judge, reach consensus and settle. |
| `get_promises()` | view | All promises, newest first (JSON). |
| `get_promise(promise_id)` | view | One promise (JSON). |
| `get_leaderboard()` | view | Trust Score per project (JSON). |
| `get_stats()` | view | Totals: kept, broken, pending, validator checks (JSON). |

Safety details: input limits on every field, https-only evidence links, deadlines cannot be in the past, the prompt tells the model to ignore instructions inside the page (prompt-injection guard), model output is parsed into a fixed verdict set, and a promise cannot be resolved twice.

## Frontend

- Reads live data from the contract (`readContract`) — stats, ledger, trust scores.
- Sends real transactions (`writeContract`) for creating and verifying promises.
- Shows the **full transaction lifecycle**: signed → pending → validators judging → consensus (accepted) → finalized, and clear messages for failures (undetermined, timeouts).
- Works with a browser key out of the box, or MetaMask on GenLayer Studionet.

## Live deployment

- Contract (GenLayer Studionet): [`0x13DCb5fE3EF0D349291fFfCB6F67a5ADDC461c10`](https://explorer-studio.genlayer.com/address/0x13DCb5fE3EF0D349291fFfCB6F67a5ADDC461c10)
- Website: https://gurusankar55.github.io/roadmapproof/
- First verified promise: Node.js — "Release Node.js version 22" → **KEPT** (validators found the v22 LTS release on the official GitHub releases page before the deadline).

## How to run

1. Open [GenLayer Studio](https://studio.genlayer.com), create a new contract, paste `contracts/roadmap_proof.py`, deploy (no constructor arguments). Copy the contract address.
2. Open the website (GitHub Pages link or `index.html` via any static server).
3. Paste the contract address into the yellow box (or set `DEFAULT_CONTRACT` in `app.js`).
4. Create a promise with a real evidence page, for example a GitHub releases page, then press **Verify now**.

### Try it quickly

- **Kept example:** Project `Node.js`, claim `Release Node.js version 22`, evidence `https://github.com/nodejs/node/releases` → validators find the release → **KEPT**.
- **Pending example:** a claim for something not yet on the page with a future deadline → stays **PENDING** with the reason.

## Roadmap for continued use

- GEN bonds: teams lock GEN behind a promise, returned if kept and slashed if broken (when value transfers are available on the target network).

- Telegram / X bot that posts every KEPT or BROKEN verdict.
- Embeddable Trust Score badge for project websites.
- Scheduled automatic verification at each deadline.
- Multiple evidence URLs per promise (GitHub + blog + app store).
