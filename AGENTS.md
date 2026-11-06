# AGENTS.md — rules for coding agents (Claude Code, Codex, others)

Read **SPEC.md** fully before writing any code. SPEC.md is the source of truth.
If CLAUDE.md exists, it carries the same rules; where they ever differ, ask.

## Project in one line
Blindspot is an agent wallet where an AI agent can be tricked, but cannot move money outside the owner's rules. Rules live on the agent's ENSv2 name and are enforced on-chain by BlindspotModule on a Safe; the wallet checks every request privately (Anon-RPC) before signing.

## Hard rules (never break)
1. The Agent key must never get a raw signing path. It may only sign `BlindspotModule.execute` / `BlindspotModule.executeBatch` calls for proposals the guard ALLOWED.
   **Test exception (owner-approved 2026-11-06), not a product path:** for the Step 2 end-to-end milestone, the
   owner personally runs one deliberate stolen-key test outside the wallet, a direct `module.execute` from the
   agent key that pays an unlisted address, to show the on-chain revert on Etherscan. No wallet, core or app code
   may sign a non-ALLOWed proposal; this test lives only in `checks/` and is run by the owner's own command.
2. Never store private keys unencrypted. Never commit secrets, `.env` files or keys.
3. No analytics, trackers or remote code in any client (extension, playground, portal).
4. Every RPC read in core goes through the `rpc` adapter (Anon-RPC). Anything that cannot is listed as excluded traffic in README.md.
5. `packages/core` never calls `chrome.*` or other platform APIs directly; only the adapters.
6. Ask before deploying contracts or spending Sepolia funds.
7. ENS, Anon-RPC, Safe and Chrome extension APIs: use the official docs listed in SPEC.md §22. Never guess a function name, signature or address.
8. ENS addresses come only from the official deployments page, stored in one config file.
9. Never fake, mock or stub something to make a check pass. Never weaken a security check to make a demo work.
10. Never change the core idea or the security model without asking.

## Build order
1. Contracts + ENS setup
2. `packages/core`
3. `apps/playground` end to end (the live demo link)
4. `apps/extension` as a thin shell over the same core
5. Demo world, analytics, README (CROPS section), video assets

Do one step at a time. Do not start the next step until the current one passes its "Done when" checks (SPEC.md §18) and the human approves.

## For every step
- Before: short plan (files, approach, risks).
- After: proof it works (test output, build output, tx hashes, what was observed in the browser).

## When something goes wrong: STOP and report
On a blocker, an unclear spec, a docs mismatch, a failing integration, or whenever you are about to guess, stop and send:

```
PROBLEM REPORT
- Step / task:
- What I was trying to do:
- What happened (exact error or behaviour):
- What I already checked (docs links, commands run):
- Possible causes:
- Options to fix (with trade-offs):
- My recommendation:
- What I need from you (decision, info, funds, keys):
```

Never work around a blocker silently.
