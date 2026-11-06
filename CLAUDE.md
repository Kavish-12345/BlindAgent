# Blindspot — instructions for Claude Code

Hackathon project (ETHGlobal). Targets: EF Best CROPS App + Best Use of Anon-RPC, and ENS Best Use of ENSv2. Read AGENTS.md and SPEC.md before any work. This file overrides SPEC.md wherever they differ.

## The idea
Blindspot is an agent wallet where an AI agent can be tricked (prompt injection, malicious sites, poisoned documents/repos/tokens) but cannot move money outside the owner's rules.

## How it works
- Funds live in a Safe on Sepolia. The Agent key holds no funds; its only path is BlindspotModule.execute() or BlindspotModule.executeBatch().
- BlindspotModule (on-chain): checks the agent's ENSv2 name via getState(labelhash) (registered, latestOwner == msg.sender, not expired; never cache token IDs); reads the owner's rules from the agent's ENS data record "blindspot.policy" (missing/undecodable = revert); enforces allowed recipients, contracts + functions, tokens, per-tx cap, daily cap, max ETH, allowed spenders, no leftover approvals; CALL only, never targets the Safe/module; executes via the Safe; post-checks; reverts violations with named custom errors. Code-hash pinning only for non-proxy targets.
- ENSv2 (Sepolia): parent .eth name (official Sepolia MockUSDC 0x240b0316df57887dbbe58b586508b19e633a14aa, commit-reveal, wait 60s); UserRegistry via VerifiableFactory + setSubregistry; each agent = subname registered to the agent address with zero roles and an absolute expiry; own Permissioned Resolver; owner-only "blindspot.policy" data record; agent may write only "agent.status" (EAC); owner writes ENSIP-26 "agent-context". Revoke = unregister. ALL ENS addresses only from https://docs.ens.domains/learn/deployments (Sepolia ENSv2), in one config file.
- Wallet protection layer (before signing): simulate via eth_simulateV1 through Anon-RPC; list all effects; check rules; claim vs reality (effects vs what the agent declared); look-alike check (first 3 + last 3 hex); off-chain proxy-upgrade check (EIP-1967 slot); origin trace of suspicious values to untrusted inputs; ALLOW / BLOCK / ASK OWNER with plain-language reasons; fail closed on anything unclassified.
- Policies are general. Owner sets them via presets, a rule editor, or a plain-English helper (LLM drafts, owner reviews and signs). Wallet-only rules: rate limits, new-contract/look-alike blocks, "ask owner above $X".
- Privacy: all RPC reads through Anon-RPC (Nox on Sepolia with a Sepolia bootstrap RPC; tor-js fallback with a mainnet bootstrap). Declare bootstrap read and owner setup as excluded traffic. Keys stay on the device. No backend except the public site's LLM proxy (declared); presenter mode uses no proxy.

## Product shape (plan update 2026-11-06)
- Blindspot = a hosted web agent wallet opened as a popup (like Coinbase's popup wallet). Nothing to install.
- Agents run OUTSIDE the wallet and connect through @blindspot/sdk (packages/sdk): connect() (wallet popup + owner approval + session), OpenAI-compatible tool definitions, callTool(), SessionRevokedError. Browser agents only for now; Node/Python via MCP/bridge on the roadmap. Every tool runs inside the wallet (reading tools too, so inputs are traced); sessions are revocable; locking or closing the wallet ends them.
- Public site: Try-it mode (example agent + popup wallet; real payments through self-serve trial agents tryN.blindspot-demo.eth with tiny fixed policies, or simulated) + view mode (live ENS rules, "Verify it yourself" eth_call panel, recorded-run replay, Etherscan proofs). AI key: hosted proxy by default + optional own key. Presenter mode: keys only in the presenter's browser.
- Browser extension: OPTIONAL, only if time remains. The submission video uses the web flow.

## Structure (one shared core)
- packages/core: rules engine, simulation, trace, agent loop, session protocol. Never call chrome.* directly; use adapters: storage, rpc, llm, readSource, runScript.
- packages/sdk: @blindspot/sdk, what any agent uses to connect to the wallet (connect, tool definitions, callTool, SessionRevokedError).
- apps/wallet: the popup wallet (agent key encrypted in the browser, rules live from ENS, all checks, decision cards with "where it went wrong", Approve & send, sessions + revoke, Anon-RPC with retry state + pre-warm, analytics; reading tools + run_script sandbox run here).
- apps/agent: an example agent built with the Blindspot SDK (Groq gpt-oss-120b default, model picker incl. custom/local endpoint, live AI log, SCRIPTED badge). Holds no keys and no funds.
- Public site (3c): Try-it + view mode around apps/agent and apps/wallet; hosted LLM proxy (rate-limited, declared). The demo agent's key is never published.
- Trial agents (3d): provisioner contract with registration rights on our UserRegistry (exact ENSv2 roles from the official docs); the judge's browser makes a fresh agent key; tryN name (zero roles, 24 h expiry), tiny fixed policy, tiny gas drip; one per address per day, global cap, owner kill switch + unregister; "simulate only" fallback.
- apps/extension (optional): extension agent wallet as a thin shell over the same core.
- Demo world (teammate): malicious repo (README "fund the deployer", key-stealing setup script, legit 12 USDC invoice, 22 USDC licence → ASK_OWNER) + a second scenario (approval drain or look-alike vendor email); each shown without Blindspot (real loss) and with Blindspot (BLOCK + source).

## The agent
Normal, realistic tool-calling LLM (temperature 0); not artificially gullible, no heavy anti-injection prompting. Tools: read_page, read_document, read_repo, run_script (sandboxed, no keys), get_rules, get_balances, resolve_name, propose(tx, declared_effects, reason), execute(id). No raw signing tool. Hidden scripted fallback for demos. Clearly labelled unprotected comparison account for the demo only.

## Demo
Owner sets rules (ENS) -> agent does a real task on demo sites -> hits a trap on its own -> blocked with broken rules + exact source -> judges write their own attack -> same task without Blindspot loses money on Etherscan -> direct bypass reverts on-chain -> owner revokes the ENS name -> analytics recap with Anon-RPC traffic meter.

## Rules
- No raw signing path for the Agent key. No unencrypted keys. No trackers, analytics or remote code.
- Ask before deploying or spending testnet funds.
- ENS, Anon-RPC, Safe, Chrome extension APIs: official docs only. Never guess an API.
- Prove every step with tests, build output or on-chain evidence. Never fake or mock to make a check pass.
- Never change the core idea or security rules without asking.

## Working style
Build one step at a time:
1. contracts + ENS setup (done)
2. packages/core (done)
3. Step 3 in this order: 3a agent/wallet separation + SDK + popup wallet → 3d self-serve trial agents (plan first, wait for OK) → 3c public site (Try-it + view mode)
4. apps/extension (optional, only if time remains)
5. demo world (teammate), analytics, README (with CROPS section), video assets
Later: repo cleanup proposal after 3a (list only, nothing deleted without approval); replace payee 2 (exposed key) before recording.
Don't start the next step until the current one passes its checks and I approve. Before each step: short plan (files, approach, risks). After each step: proof it works.

## When something goes wrong: STOP and report
On a blocker, unclear spec, docs mismatch, failing integration, or when about to guess, STOP and send:

PROBLEM REPORT
- Step / task:
- What I was trying to do:
- What happened (exact error or behaviour):
- What I already checked (docs links, commands run):
- Possible causes:
- Options to fix (with trade-offs):
- My recommendation:
- What I need from you (decision, info, funds, keys):

Never work around a blocker silently.
