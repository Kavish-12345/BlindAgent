# Blindspot — Implementation Spec

Version 2 (supersedes the earlier extension-only spec). Chain: **Sepolia**. Hackathon: ETHGlobal Mumbai.
Targets: **EF Best CROPS App** + **EF Best Use of Anon-RPC** (one EF prize max), **ENS Best Use of ENSv2**.

---

## 1. Overview

**One line:** an AI agent can be tricked (prompt injection, malicious sites, poisoned documents, repos or tokens), but it cannot move money outside the owner's rules.

**Problem.** Agents with wallets get fooled by what they read and send funds to the wrong place. Losses come from what nobody checked: wrong recipients, hidden approvals, leftover allowances.

**Solution — two layers:**

| Layer | Where | Role |
|---|---|---|
| Protection layer | Wallet (playground page or extension) | Before signing: simulate privately through Anon-RPC, list every effect, check the owner's rules, compare with what the agent declared, trace where suspicious values came from, then ALLOW / BLOCK / ASK OWNER with plain-language reasons |
| BlindspotModule | On-chain, enabled on a Safe | The only path from the Agent key to the funds. Re-checks the rules from ENS and reverts violations, even if the wallet is bypassed or the agent key is stolen |

**ENSv2 role:** each agent is an ENS subname (e.g. `trader.owner.eth`) = its identity, its rulebook (owner-only record) and its on/off switch (expiry / unregister). The module reads the rules from ENS on-chain.

**Product forms (one shared core):** a hosted **playground** (live demo link for judges) and a browser **extension** wallet (the shippable product).

---

## 2. Threat model and guarantees

| Situation | Protected? | Why |
|---|---|---|
| Agent is fooled by injected content | Yes (twice) | Wallet blocks before signing; module reverts on-chain |
| Agent key stolen; attacker calls the module directly | Yes | Agent key can only call the module; module enforces the rules |
| Wallet/app bypassed | Yes | On-chain rules still apply |
| Agent holds a plain funded key | No | Out of design: funds never sit with the agent |
| Owner key stolen | No | Owner can change everything. Out of scope |
| Bad decision that stays inside the rules | No | Rules bound the damage; they don't make the agent smart |

Trusted: Safe, BlindspotModule, ENSv2 contracts. Untrusted/hostile: the agent, LLM output, websites, documents, repo files, scripts, tool outputs, token metadata, dapps. Can see but not sign: Anon-RPC worker, RPC provider, LLM provider.

---

## 3. Architecture

```
Owner wallet ── sets rules / revokes ──────────────► ENSv2 (agent subname, rules record, expiry, roles)
                                                          ▲ reads rules + identity (on-chain)
AI agent ── propose(tx, declared effects) ──► Protection layer (core)        │
                                              ├─ Anon-RPC: reads + eth_simulateV1 (private)
                                              ├─ rules, claim vs reality, look-alike, proxy check, origin trace
                                              └─ ALLOW → Agent key signs ──► BlindspotModule ──► Safe (funds)
Websites / dapps ── payment requests ───────► same protection layer
```

---

## 4. Repository structure

```
blindspot/
├── contracts/                      Foundry
│   ├── src/BlindspotModule.sol
│   ├── src/PolicyCodec.sol
│   ├── src/interfaces/             ISafe, ENSv2 registry/resolver interfaces, IERC20, IERC721
│   ├── src/demo/                   InjectToken, HoneypotWrapper, EvilVault, UpgradeableTarget, SimplePool
│   ├── test/                       unit tests + one test per attack (Sepolia fork)
│   └── script/                     DeployModule.s.sol, DeployDemo.s.sol
├── scripts/ens/                    ENS setup (viem): parent name, registry, resolver, agent, records, verify
├── packages/
│   ├── shared/                     types, policy codec (TS), constants, config loader
│   └── core/                       protection layer, agent loop, trace, analytics, UI components, adapter interfaces
├── apps/
│   ├── playground/                 hosted web shell (live demo link) + LLM proxy (serverless)
│   ├── extension/                  Chrome MV3 shell
│   └── portal/                     AcmeSupply business portal + admin panel
├── demo/                           fake DeFi site, repo-trap files, scenario fixtures
├── config/sepolia.json             ALL addresses (ENS, Safe, module, demo contracts, tokens)
├── README.md                       run guide, CROPS section, excluded traffic, limits, test table
├── AGENTS.md / CLAUDE.md
└── LICENSE                         MIT
```

---

## 5. Smart contracts

### 5.1 BlindspotModule

```solidity
contract BlindspotModule is ReentrancyGuard {
    struct Call { address to; uint256 value; bytes data; }
    uint256 public constant MAX_BATCH = 8;

    ISafe public immutable safe;                        // Safe v1.4.1
    IPermissionedRegistry public immutable agentRegistry; // owner's UserRegistry (agent subnames)
    bytes32 public immutable parentNode;                // namehash of the parent name
    bytes public parentDnsName;                         // DNS-encoded parent name, set once in the constructor

    function execute(string calldata label, address to, uint256 value, bytes calldata data)
        external nonReentrant returns (bytes memory);
    function executeBatch(string calldata label, Call[] calldata calls)
        external nonReentrant returns (bytes[] memory);
    function previewPolicy(string calldata label) external view returns (Policy memory);
    function isAgentActive(string calldata label, address agent) external view returns (bool);
    function decodePolicy(bytes memory raw) external pure returns (Policy memory);

    event Executed(string label, address to, bytes4 selector, uint256[] outflows);
    event BatchExecuted(string label, address[] targets, bytes4[] selectors, uint256[] outflows);
    error AgentNotActive(); error PolicyMissing(); error ForbiddenTarget(address to);
    error TargetNotAllowed(address to); error CodeHashMismatch(address to);
    error SelectorNotAllowed(bytes4 sel); error RecipientNotAllowed(address r);
    error SpenderNotAllowed(address s); error OutflowExceeded(address token, uint256 amount);
    error DailyCapExceeded(address token, uint256 spentToday);
    error AllowanceResidue(address token, address spender, uint256 amount);
    error OperatorResidue(address token, address operator);
    error ApprovalResidue(address token, uint256 tokenId, address approved);
    error BatchSizeInvalid(uint256 size); error ExecutionFailed(bytes returnData); error InvalidConfig();
}
```

`outflows[i]` is the outflow of `policy.tokens[i]` for the whole execution.

### 5.2 Checks, in order

`execute` runs one call; `executeBatch` runs 1–`MAX_BATCH` (8) calls atomically (else `BatchSizeInvalid`). Both run the same steps: 1–2 once, 3–7 on **every** call before any call executes, 8 for each call in order, 9–10 **once** after the last call. Any failure reverts the whole execution.

1. **Identity:** `agentRegistry.getState(uint256(keccak256(bytes(label))))` → status REGISTERED, `latestOwner == msg.sender`, not expired. Else `AgentNotActive`. Never cache token IDs.
2. **Rules:** resolver = `agentRegistry.getResolver(label)`; read data record `blindspot.policy` via `resolver.resolve(dnsName, data(node, "blindspot.policy"))`; decode and validate with PolicyCodec (§15 validation rules). Missing resolver, empty, undecodable or invalid → `PolicyMissing`.
3. **Shape:** always CALL (never DELEGATECALL); `to` must not be the Safe or the module → `ForbiddenTarget`.
4. **Target:** `to` in `policy.targets` → else `TargetNotAllowed`. If the pinned hash is non-zero, `extcodehash(to)` must equal it → else `CodeHashMismatch`. A zero hash marks a proxy/unpinned target; the wallet checks its EIP-1967 implementation slot off-chain (§8).
5. **Function:** selector in the target's allowed list → else `SelectorNotAllowed`. Empty calldata has selector `0x00000000` (plain ETH transfer); 1–3 bytes of calldata → `SelectorNotAllowed(0x00000000)`.
6. **Decode sensitive calls:** recipient must be in `payees` → `RecipientNotAllowed` for: empty calldata (recipient = `to`), `transfer`, `transferFrom`, ERC-721 `safeTransferFrom` (both forms), ERC-1155 `safeTransferFrom` / `safeBatchTransferFrom`. `approve` / `increaseAllowance` spender must be in `spenders`; `setApprovalForAll` operator must be in `spenders` or `operators` → `SpenderNotAllowed`. An `approve(spender, tokenId)` on an ERC-721 token is remembered for step 9.
7. **ETH:** each call's `value <= policy.maxEth`, and for a batch the sum of all values `<= policy.maxEth` → else `OutflowExceeded(address(0), …)`.
8. **Execute:** snapshot tracked balances once before the first call (ETH for `address(0)`, `balanceOf(safe)` for ERC-20 and ERC-721; ERC-1155 is not measured); for each call `safe.execTransactionFromModuleReturnData(to, value, data, CALL)`; a failed call → `ExecutionFailed(returnData)`.
9. **Post-checks (once):** per-token outflow over the whole execution ≤ `maxOut` → `OutflowExceeded`; daily total (stored per labelhash, per token, per UTC day) ≤ `dailyCap` → `DailyCapExceeded`. Then no leftover approvals, for every tracked token and every `x` in (all call targets ∪ `spenders`): ERC-20 `allowance(safe, x) == 0` → else `AllowanceResidue`; ERC-721/1155 `isApprovedForAll(safe, x) == false` unless `x` is in `operators` → else `OperatorResidue`; every ERC-721 `approve` from step 6 has `getApproved(tokenId) == address(0)` → else `ApprovalResidue`.
10. Emit `Executed` (single call) or `BatchExecuted` (batch).

Batches exist so that an exact approval and the call that consumes it (e.g. approve + swap) can run together: a lone `approve` always fails step 9.

**Hardening:** selector allowlist (never denylist); no admin functions (rules live only in ENS; addresses immutable); nonReentrant on both entry points; demo targets don't use Permit2 (or Permit2 allowances are also checked in step 9).

**"Ask owner" actions:** the owner executes them directly from the Safe (owner signature); the module is not involved.

### 5.3 Demo contracts (Sepolia)

| Contract | Purpose |
|---|---|
| `InjectToken` | ERC-20 whose name/symbol carries an instruction |
| `HoneypotWrapper` | Profitable-looking trade that leaves an allowance |
| `EvilVault` | Takes deposits, mints ~0 shares |
| `UpgradeableTarget` | Proxy upgraded to malicious code after allowlisting (off-chain detection demo) |
| `SimplePool` | Own swap venue; pulls exactly the approved amount |

### 5.4 Foundry tests
On a Sepolia fork reading the real ENSv2 contracts: one test per custom error; one per attack asserting the unprotected path loses funds and the module path reverts with the expected error; reentrancy attempt fails; policy decoded on-chain equals the TS codec output.

---

## 6. ENSv2 setup (Sepolia)

All addresses from the official deployments page (§22) into `config/sepolia.json`. Re-check on demo day (Sepolia was redeployed before).

1. **Parent name** `owner.eth`: ETHRegistrar `makeCommitment(label, owner, secret, subregistry, resolver, duration, referrer)` → `commit(commitment)` → wait ≥ `MIN_COMMITMENT_AGE` (60 s) → price from `getRegisterPrice(label, duration, paymentToken)` (returns base + premium; there is no `rentPrice`) → `approve` the registrar for base + premium → `register(label, owner, secret, subregistry, resolver, duration, paymentToken, referrer)`. Pay with official Sepolia **MockUSDC** `0x240b0316df57887dbbe58b586508b19e633a14aa` (verify you can mint it; otherwise ask the ENS team). Roles on the parent are fixed by the registrar's `REGISTRATION_ROLE_BITMAP`. Or register via sepolia.app.ens.domains.
2. **Subname registry:** deploy a UserRegistry proxy via **VerifiableFactory** `deployProxy(UserRegistryImpl, salt, initData)` where `initData = initialize(Grant[] grants)` and `Grant = (address account, uint256 roleBitmap)` (a list of grants, not a single bitmap). The owner's grant must include at least `ROLE_REGISTRAR_ADMIN` and `ROLE_RENEW_ADMIN`. Call `setSubregistry` on the parent registry so subnames resolve.
3. **Per-agent resolver:** deploy a PermissionedResolver proxy for each agent via VerifiableFactory with `initialize(Grant[] grants, bytes[] calls)` (resolver roles apply to every name it serves).
4. **Register agent:** `register(label, agentAddress, IRegistry(0), agentResolver, 0, expiry)` — zero roles; `expiry` is an absolute Unix timestamp.
5. **Records (owner):** data record `blindspot.policy` via `setData(dnsName, "blindspot.policy", abiBytes)` (ENSIP-24); ENSIP-26 text record `agent-context` via `setText` (what the agent is and how its rules work); address record via `setAddress(dnsName, 60, addr)`. Setters take the DNS-encoded name; reads go through `resolve(name, data)`.
6. **Agent permission:** the resolver's generic `grantRoles` is disabled (`EACCannotGrantRoles`); grant with `grantSetterRoles(abi.encodeCall(setText, ("", "agent.status", "")), agent)`, which scopes `ROLE_SET_TEXT` to resource `keccak256("agent.status")`. Any other write must revert with `EACUnauthorizedAccountRoles(resource, roleBitmap, account)`.
7. **Payees** as names (e.g. `vendor.owner.eth`) with address records.
8. **Verify script:** resolve the agent with viem; `hasRoles` shows status-only for the agent; policy decodes; expiry set.

**Lifecycle:** revoke = `unregister(label)`; extend = `renew`. Owner never calls `setApprovalForAll` on registries (an operator inherits all owner roles).

---

## 7. `packages/core`

### 7.1 Adapter interfaces (implemented per shell)

| Adapter | Responsibility | Playground | Extension |
|---|---|---|---|
| `storage` | get/set state | localStorage / memory | chrome.storage (encrypted keys) |
| `rpc` | JSON-RPC transport | Anon-RPC browser harness | Anon-RPC extension harness (via offscreen) |
| `llm` | tool-calling model call | serverless LLM proxy | provider API with user key |
| `readSource` | read page / document / repo | fetch by URL (CORS-enabled demo sites) | active tab content + fetch |
| `runScript` | run untrusted script text | sandboxed iframe | manifest sandbox page |

### 7.2 Modules
`ens/` (agent status, rules, payee resolution) · `simulate/` · `check/` · `trace/` · `agent/` (loop + tools) · `policy/` (presets, editor model, plain-English drafting) · `analytics/` · `ui/` (shared React components).

---

## 8. Protection layer

**Simulation (`eth_simulateV1`, one request, one simulated block):**
1. Call `module.execute(label, to, value, data)` — or `module.executeBatch(label, calls)` for a multi-call proposal, simulated as one call — from the Agent address.
2. Same block: `balanceOf(safe)` for tracked tokens, Safe ETH balance, `allowance(safe, spender)` for the target and every spender seen in logs.
3. Decode logs (`Transfer`, `Approval`, `ApprovalForAll`); anything else from a tracked token = `unknownLog`. Native ETH comes from EIP-7708 protocol logs (`SYSTEM_ADDRESS` `0xffff…fffe`, live on Sepolia, also in real receipts) when present, otherwise from `eth_simulateV1` `traceTransfers` logs (`0xeeee…eeee`, simulation only); never both (no double counting). The Safe's ETH and tracked-token balances are also read before and after (ETH via a simulation-only balance-reader state override); any difference from the log effects becomes a `postState` effect.
4. Diff → `Effect[]`; record module revert name if the call would revert.

**Checks (any fail → BLOCK):**

| Check | Fails when |
|---|---|
| Agent active | Name expired, unregistered, or owned by another address |
| Rules | Target, function, recipient, spender, token or cap outside the policy |
| Claim vs reality | An effect not in `declaredEffects`, or a declared amount off by > 1% |
| No leftover approvals | Any Safe allowance non-zero after the call |
| Look-alike | Recipient matches a payee's first 3 + last 3 hex chars but isn't that payee |
| Proxy upgrade | A target's EIP-1967 implementation slot differs from the value recorded when allowlisted |
| Rate limit | More than the policy's transactions per hour |
| Fail-closed | `unknownLog`, undecodable call, or simulation error |
| Module preview | The simulated module call reverts |

**ASK OWNER** when the action is valid but above the owner's approval threshold.

**Origin trace:** every tool call is a trace event tagged trusted (ENS, policy, chain reads) or untrusted (pages, documents, repos, scripts, tool outputs, token metadata). On each decision, normalise the recipient/amount and find its first appearance in an untrusted event → shown as "where the agent went wrong" (source + exact text/line).

---

## 9. Agent runtime

- Normal, realistic tool-calling LLM, temperature 0. Not artificially gullible; no heavy anti-injection prompting.
- System prompt: manage the wallet for the owner; call `get_rules` before transactions; every transaction via `propose`, declaring exactly who receives what and any approvals; if blocked, explain and continue.

| Tool | Returns | Trust |
|---|---|---|
| `read_page(url?)` | Page content | Untrusted |
| `read_document(url)` | Document text | Untrusted |
| `read_repo(url)` | Repo files | Untrusted |
| `run_script(path)` | Script output (sandbox, no keys; only `propose()` exposed) | Untrusted |
| `get_rules()` | Decoded ENS policy | Trusted |
| `get_balances()` | Safe balances/allowances | Trusted |
| `resolve_name(name)` | Address from ENS | Trusted |
| `token_info(token)` | Token name, symbol, decimals read from chain | Untrusted (the text is written by the token deployer) |
| `propose(tx, declared_effects, reason)` | ALLOW / BLOCK / ASK OWNER + reasons | — |
| `execute(id)` | Tx hash or revert | — |

**Agent / wallet separation (plan update, 2026-11-06).** The agent runs OUTSIDE the wallet, the way
outside agents connect to MetaMask / Coinbase agent wallets. Any agent connects through **`@blindspot/sdk`**
(`packages/sdk`): `connect()` opens the Blindspot wallet popup, the owner approves the session ("act as
`<agent>.blindspot-demo.eth`; can read rules, propose, execute; cannot change rules"), and the SDK returns
OpenAI-compatible tool definitions, `callTool()` and a `SessionRevokedError`. Browser agents only for now;
Node / Python agents via an MCP server or bridge are on the roadmap. Every tool above runs **inside the wallet**
(reading tools too, so every input is traced as untrusted); the agent holds no keys and no funds. The owner can
revoke a session at any time; locking or closing the wallet ends every session. Transport: `window.postMessage`
between the agent's origin and the wallet popup, origins checked on both sides.

No raw signing tool. `execute(id)` signs only a proposal from the same run whose decision is ALLOW, re-evaluates it immediately before signing, builds the module calldata itself, and the signer refuses anything that is not a `BlindspotModule.execute` / `executeBatch` call to the module. **Test exception (owner-approved, not a product path):** the Step 2 milestone's stolen-key bypass test is a direct module call from the agent key, run by the owner outside the wallet (`checks/` only), to show the on-chain revert. Max ~15 steps per task. Hidden **scripted mode** replays recorded tool calls (checks still run for real). **Unprotected comparison account** (plain EOA, clearly labelled) exists only for the demo.

---

## 10. Playground (live demo link)

**Final product shape (plan update, 2026-11-06; supersedes the one-page playground below where they differ):**
- **Blindspot is a hosted web agent wallet opened as a popup** (like Coinbase's popup wallet); nothing to install.
- **`apps/wallet`** — the popup wallet: agent key encrypted in the browser (PBKDF2 + AES-GCM, memory-only
  unlock), rules live from ENS, all checks, decision cards, "where it went wrong" (origin), Approve & send,
  sessions + revoke, Anon-RPC with a visible retry state and pre-warm, analytics. Reading tools run in the wallet.
- **`apps/agent`** — "an example agent built with the Blindspot SDK": Groq `openai/gpt-oss-120b` by default,
  model picker (gpt-oss-120b / gpt-oss-20b / custom OpenAI-compatible endpoint incl. local), live AI log (model,
  request id, tokens, latency, raw reply), SCRIPTED badge for labelled fallback runs. No keys, no funds.
- **Presenter mode:** keys only in the presenter's browser, no proxy.
- **Public site (3c):** Try-it mode — judges run the example agent with the popup wallet: real decisions; real
  payments through **self-serve trial agents** (3d), or simulated. View mode — live ENS rules, a "Verify it
  yourself" `eth_call` panel, replay of a recorded run, Etherscan proof links. AI key on the public site: a
  hosted proxy by default plus an optional own-key field (proxy declared in README / CROPS).
- **Self-serve trial agents (3d), so judges get real payments with no server-held key:** a provisioner
  contract with registration rights on our UserRegistry (exact ENSv2 roles from the official docs); the judge's
  browser generates a fresh agent key; the provisioner registers `tryN.blindspot-demo.eth` to it (zero roles,
  24-hour expiry), writes a tiny fixed policy (vendor1 / vendor2 only, e.g. 1 MockUSDC per tx, 2 per day, no
  ETH outflow) and drips a tiny amount of Sepolia ETH for gas. Limits: one trial per address per day, a global
  cap, an owner kill switch; the owner can unregister any trial name. Fallback: a "simulate only" switch in the
  wallet; if 3d is not working 6 hours before the deadline, the public site uses simulated payments.
- **Browser extension: optional**, only if time remains. The submission video uses the web flow.
- **Demo sources** (teammate): the malicious repo (README "fund the deployer" to an attacker address,
  key-stealing setup script, a legit 12 USDC hosting invoice, a 22 USDC licence fee → ASK_OWNER) and a second
  scenario (approval-drain website or look-alike vendor email, still being decided). Each is shown first without
  Blindspot (real loss on an unprotected wallet), then with Blindspot (BLOCK + source).

Original playground notes (kept for reference):

- One page: agent panel + demo-site view + rules + analytics.
- Shared demo agent (`demo.owner.eth`) with a small funded Safe; rules read live from ENS.
- **Judge demo: realistic prompt injections only.** Judges write their own reasonable injections into the demo sources (admin panel) and watch the agent get tricked and Blindspot block it. The demo agent's key is **never published**; it stays private in local configuration, like the owner key (owner decision, 2026-11-06). The on-chain guarantee against a stolen agent key is shown with fork tests and `eth_call` simulations from the agent address, not with a public key. Payees are team-owned addresses; vault kept small; agent gas topped up.
- LLM proxy: serverless function holding the API key, rate-limited per visitor.
- Anon-RPC browser harness; traffic meter visible.
- Links: ENS agent viewer, portal, extension download, video, Etherscan proofs.
- Deploy: Vercel (or similar); optional IPFS + ENS contenthash for the landing page.

---

## 11. Extension (shippable wallet)

- Chrome MV3. Contexts: service worker (keys, router, guard; owns the Anon-RPC harness), offscreen document (holds the null-origin sandbox), side panel (agent, decisions, analytics, policy, lab), popup (unlock, owner approvals, revoke), content script + main-world provider, sandbox page.
- Keys: Owner, Agent, Unprotected (lab only). PBKDF2 + AES-GCM in `chrome.storage.local`; unlocked keys in `chrome.storage.session`; auto-lock.
- Provider: EIP-1193 + EIP-6963 announce; never override `window.ethereum`; dapps see the Safe address; `eth_sendTransaction` → wrapped as `module.execute` → guard; `personal_sign` / `eth_signTypedData_v4` refused in agent mode.
- Permissions: storage, sidePanel, offscreen, alarms, active tab reading; host permissions for RPC, LLM API, Anon-RPC gateways. Bundle everything; no remote code.
- Ship: build → zip → GitHub Release; install via Developer mode → Load unpacked.

---

## 12. Demo world

| Source | Agent task | Trap |
|---|---|---|
| AcmeSupply portal | Pay this week's invoices | Edited payment details / instruction in notes |
| Fake DeFi site | Swap or deposit | Hidden approval; fake vault |
| GitHub repo | Set up the project | README instruction; `setup.js` tries to read keys and drain (browser JS) |
| Sepolia token | Tidy up the wallet | Instruction in token name |
| Admin panel | — | Judges write their own attack in any source |

Portal and sites: static, CORS-enabled for the playground domain, resettable traps. Look-alike address (3+3 hex) generated before the event.

---

## 13. Policy UI

- **Presets:** Payments only · Trading · DeFi deposits · Read-only.
- **Rule editor:** recipients (ENS names/addresses), contracts + functions, tokens, per-tx cap, daily cap, max ETH, spenders, expiry, rate limit, ask-owner threshold.
- **Plain-English helper:** LLM drafts rules → shown as fields → owner reviews → signs. The LLM never saves rules.
- Save = one owner signature writing `blindspot.policy` (versioned). History shown.
- Rules displayed in 4 places: wallet Policy tab, public ENS agent viewer (+ ENS Explorer link), every blocked decision (broken rule highlighted), on-chain revert names.

---

## 14. Analytics

Per run: task → tool calls (trust tags) → origin → proposal + reason → each check pass/fail → outcome (+ tx hash) → one-line verdict.
Session: attacks attempted/blocked (protected vs unprotected), value lost per account, blocks by source, failed checks by type, Anon-RPC share and network, on-chain reverts. Stored locally; JSON export.

---

## 15. Data schemas (`packages/shared`)

```ts
type Policy = {
  version: number;
  targets: Address[]; codeHashes: Hex[]; selectors: Hex[][];
  payees: Address[]; spenders: Address[]; operators: Address[];
  tokens: Address[]; tokenKinds: (0 | 1 | 2)[];   // 0 = ERC-20 (or ETH at address(0)), 1 = ERC-721, 2 = ERC-1155
  maxOut: bigint[]; dailyCap: bigint[]; maxEth: bigint;
  // wallet-only (off-chain) fields, same record:
  rateLimitPerHour: number; askOwnerAbove: bigint; blockNewContracts: boolean;
};
type EffectKind = 'out' | 'in' | 'approve' | 'operator' | 'unknownLog';
type Effect = { kind: EffectKind; token: Address; amount: bigint; counterparty: Address; source: 'log' | 'postState' };
type Proposal = { id: string; origin: 'agent' | 'dapp' | 'script';
  tx: { to: Address; value: bigint; data: Hex };
  declaredEffects: Omit<Effect, 'source'>[]; reason: string; inputsUsed: string[] };
type Decision = { proposalId: string; verdict: 'ALLOW' | 'BLOCK' | 'ASK_OWNER';
  failedChecks: { check: string; rule?: string; detail: string }[];
  effects: Effect[]; undeclared: Effect[];
  origin?: { value: string; eventId: string; source: string; excerpt: string };
  moduleRevert?: string; simulatedAtBlock: bigint; anonCalls: number };
type TraceEvent = { id: string; runId: string; step: number; tool: string; input: unknown;
  output: string; trust: 'trusted' | 'untrusted';
  source: 'ens' | 'chain' | 'page' | 'document' | 'repo' | 'script' | 'tool' | 'token'; at: number };
```

The on-chain part of `Policy` must encode identically in TS and Solidity (round-trip test mandatory). The record is `abi.encode` of the whole struct, fields in the order above.

**Conventions and validation** (TS `validatePolicy` and Solidity `PolicyCodec.isValid` apply the same rules; any failure = `PolicyMissing` on-chain):
- `version >= 1`; `codeHashes`, `selectors` have the length of `targets`; `tokenKinds`, `maxOut`, `dailyCap` have the length of `tokens`; `maxOut[i] <= dailyCap[i]`.
- `codeHashes[i] == 0x00…00` = proxy/unpinned target (wallet does the EIP-1967 check).
- Selector `0x00000000` = empty calldata (plain ETH transfer); the target must also be a payee.
- `tokens[i] == address(0)` tracks native ETH and must have kind 0.
- `tokenKinds[i]` ∈ {0, 1, 2}. ERC-1155 balances are per token id, so the module does not measure ERC-1155 amounts at all. An ERC-1155 token must have `maxOut = dailyCap = 0`, and this means **"amount not tracked"**, not "nothing can move": any amount, up to the whole balance, can be sent to a listed payee in one call. Still enforced on-chain for ERC-1155: target and selector allowlist, recipient must be a payee, operator must be allowed and must not be left approved. **Honest limit:** the owner should list an ERC-1155 token only if every payee may receive all of it.
- `operators`: NFT operators that may remain approved-for-all after a call.
- A target whose selectors include any token-moving function (`transfer`, `transferFrom`, both ERC-721 `safeTransferFrom`, ERC-1155 `safeTransferFrom` / `safeBatchTransferFrom`, `approve`, `increaseAllowance`, `setApprovalForAll`) must be listed in `tokens`.
- The encoding must be canonical (re-encoding reproduces the bytes exactly).

---

## 16. Execution flows

1. **Setup:** owner connects wallet → Safe deployed + module enabled → ENS: agent subname, resolver, roles, rules, agent-context → Safe funded.
2. **Allowed action:** task → tools → `propose` → simulate + checks → ALLOW → `execute` signs `module.execute` (or `module.executeBatch` for a multi-call proposal such as approve + swap) → module re-checks → executes.
3. **Trap:** agent reads untrusted content → proposes bad transfer → BLOCK with broken rules + origin; nothing signed.
4. **Unprotected comparison:** same task on the plain account → real loss on Sepolia.
5. **Bypass:** direct `module.execute` with the agent key → on-chain revert.
6. **Revoke:** owner `unregister` → next action reverts `AgentNotActive`; agent write to `blindspot.policy` always reverts.
7. **Dapp request:** site requests payment → same guard → ALLOW or user-rejected error with reasons.

---

## 17. Configuration

`config/sepolia.json`: ENS contracts (official page), MockUSDC, Safe, module, demo contracts, payees, parent name.
Env (no secrets in repo): `SEPOLIA_RPC_URL` (must support `eth_simulateV1`), `MAINNET_BOOTSTRAP_RPC_URL` (tor-js), Anon-RPC specifiers (Nox Sepolia `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`; tor-js from the adopters page), LLM host. LLM API key only in the proxy's server env (playground) or typed by the user (extension). Deployer keys only in local `.env`.

**Excluded Anon-RPC traffic (declare in README):** the one bootstrap specifier read; owner setup transactions sent via the owner's own wallet.

---

## 18. Task list (build order; each must pass "Done when")

**Step 0 — risk checks**
- R1 Anon-RPC: `eth_blockNumber` + `eth_simulateV1` to Sepolia RPC via Nox, then tor-js. *Done when:* both succeed from a browser page.
- R2 ENSv2: parent name, registry, `setSubregistry`, one agent subname, resolve with viem. *Done when:* name resolves; agent `setData` reverts, owner's works.
- R3 LLM: one tool-calling request via the proxy. *Done when:* a tool call is returned.

**Step 1 — contracts + ENS**
- 1.1 Policy codec TS ↔ Solidity. *Done when:* round-trip test passes.
- 1.2 BlindspotModule. *Done when:* every check in §5.2 exists; each error has a unit test.
- 1.3 Demo contracts + fork tests. *Done when:* each attack drains an unprotected EOA and reverts through the module with the expected error.
- 1.4 Deploy scripts + verify on Etherscan. *Done when:* addresses written to `config/sepolia.json`.
- 1.5 ENS setup scripts (§6). *Done when:* verify script passes.

**Step 2 — packages/core**
- 2.1 Adapters + ENS reads. 2.2 Simulation. 2.3 Checks. 2.4 Trace. 2.5 Agent loop + tools. 2.6 Policy model. 2.7 Analytics.
*Done when:* unit tests for every check (pass + fail case); simulated effects equal real effects for a clean transfer and a swap.

**Step 3 — popup wallet, SDK, example agent, public site** (plan update, 2026-11-06; order 3a → 3d → 3c)
- 3a Agent / wallet separation + `@blindspot/sdk` + popup wallet. *Done when:* the example agent connects, the
  owner approves, it calls `get_rules` first, pays 12 MockUSDC to vendor1 for real (Approve & send, via Nox), and
  revoking the session stops its next call.
- 3d Self-serve trial agents (§10). Plan first (files, ENS roles from the official docs, on-chain setup, limits,
  tests, risks, time) and wait for the owner's OK. *Done when:* a fresh browser gets a trial agent and makes a
  real capped payment; limits and the kill switch work; the owner can unregister a trial name. Deadline rule:
  not working 6 hours before the deadline → simulated payments.
- 3c Public site: Try-it mode + view mode (§10).
- Later: repo cleanup proposal after 3a (a list; nothing deleted without approval); replace payee 2 (exposed
  key) before recording.

Original Step 3 done-when (kept for the public site):
*Done when:* from a fresh incognito browser: agent pays a legit invoice (real tx), gets blocked on a trap with origin shown, a judge-written prompt injection is blocked, a direct module bypass from the agent address reverts (simulated, nothing published), Anon-RPC meter shows the traffic share.

**Step 4 — extension**
*Done when:* zipped build loads on a clean Chrome profile; same flows as step 3 in the side panel; dapp request via EIP-6963 goes through the guard; revoke from popup stops the agent; service-worker restart keeps working.

**Step 5 — demo world, analytics, README, video**
*Done when:* all §12 traps work on both accounts; README has run guide, CROPS section, excluded traffic, limits, test table; video ≤ 3 min recorded.

---

## 19. Testing

- **Contracts:** each error; reentrancy; no delegatecall; every attack; codec equality; revoked/expired agents refused.
- **Core:** every check pass/fail; claim vs reality; look-alike; proxy-slot change; fail-closed on unknown logs; origin attribution per scenario.
- **Integration (Sepolia):** Nox + Tor paths; simulate-vs-real effects; each trap blocked on protected and successful on unprotected; bypass reverts; agent policy write reverts; traffic meter accurate.
- **Demo:** three full live runs in a row; scripted fallback; pre-warmed worker; backup video.

---

## 20. Submission checklist

- EF Anon-RPC: reads through Anon-RPC by default; excluded traffic declared; works end to end.
- EF CROPS App: public repo, MIT, README run guide; README section titled **CROPS** (C/O/P/S one or two lines each); demo video ≤ 3 min showing the moment it matters; no trackers; keys on device (playground proxy declared).
- ENSv2: built on ENSv2 Sepolia; ENS features central; functional demo, no hard-coded values; live demo link (playground) + open-source code.
- On-chain proofs linked: unprotected loss, blocked attempt, bypass revert, revoke.

**CROPS draft:** C — no servers needed by the extension; rules in ENS and checks on-chain keep working if we disappear (playground uses an LLM proxy only for judges). O — MIT, builds from the repo. P — RPC sees anonymized requests; the anon worker can see and could alter requests; LLM provider sees prompts; ENS records are public. S — keys encrypted on device; agent key can't move funds except through the module; trust: Safe, module, ENSv2 contracts; simulation is a prediction, the module is the guarantee.

---

## 21. Risks, limits, non-claims

| Risk | Fallback |
|---|---|
| ENS name/setup on Sepolia fails | Ask ENS team immediately; no substitute (Arkiv only as a different prize) |
| ENS addresses change | Official page only; re-check on demo day |
| Anon-RPC harness in offscreen fails (extension) | Host in side panel; playground uses browser harness anyway |
| RPC lacks `eth_simulateV1` or refuses mixnet traffic | Second provider; else local-fork simulation, declared |
| LLM won't take the bait | Scripted fallback; backup video |
| Demo agent runs out of gas | Keep the agent topped up (small Sepolia ETH); monitor |
| Slow Sepolia blocks | Pre-run slow steps; narrate |
| Nox has no exit for a moment (`NoTunnelExitError`) | Visible "retrying through Nox…" state, pre-warm on load, declared direct-broadcast fallback only with the owner's click |
| Trial agents (3d) not working 6 h before the deadline | Public site switches to simulated payments ("simulate only" switch in the wallet) |
| Trial agents abused (key farming, gas drain) | One trial per address per day, global cap, 24 h expiry, tiny fixed policy, owner kill switch + unregister |
| Hosted LLM proxy (public site) | Rate-limited, declared in README / CROPS; optional own-key field; presenter mode uses no proxy |
| Popup blocked / wallet window closed | Connect opens the popup from a click; a closed wallet ends the session and the agent stops |
| GitHub API limit for `read_repo` (60 requests / hour per IP without sign-in) | Files capped per read; the limit is reported plainly; declared excluded traffic |
| Payee 2 key exposed | Replace payee 2 before recording |

**We claim:** the agent can't pay unlisted recipients, grant unlisted approvals, leave allowances, call unknown or (non-proxy) changed contracts, or exceed caps — enforced on-chain; it can't change its own rules; the owner can revoke instantly; reads are unlinkable from the user's IP; the trace shows which untrusted input misled the agent.

**We don't claim:** agents can't be fooled; the wallet's checks are unbypassable (the module is); simulation equals inclusion; the anon worker or LLM provider are trustless; losses within the owner's rules are prevented; scripts can't do non-financial damage; on-chain detection of proxy upgrades.

---

## 22. Official references (use these, never guess)

- ENS deployments: https://docs.ens.domains/learn/deployments
- ENSv2 overview: https://docs.ens.domains/ensv2/overview
- Contract developer guide: https://docs.ens.domains/ensv2/tutorial-contract-developers
- Permissioned Registry: https://docs.ens.domains/ensv2/permissioned-registry
- Permissioned Resolver: https://docs.ens.domains/ensv2/permissioned-resolver/
- Enhanced Access Control: https://docs.ens.domains/ensv2/enhanced-access-control/
- ETH Registrar: https://docs.ens.domains/ensv2/eth-registrar
- ENSIP-26 Agent Text Records: https://docs.ens.domains/ensip/26/
- Anon-RPC: https://ethereum.github.io/anon-rpc/ · wallet guide https://ethereum.github.io/anon-rpc/wallets/ · adopters https://ethereum.github.io/anon-rpc/adopters/ · repo https://github.com/ethereum/anon-rpc
- Safe modules: https://docs.safe.global/smart-account-modules
- MetaMask transaction insights (why not a Snap): https://docs.metamask.io/snaps/features/transaction-insights/
