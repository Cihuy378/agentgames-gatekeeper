# Agent Games — Proof Gatekeeper Agent

An AI-agent endpoint for the **Proof Gatekeeper** event in [zkVerify Agent Games](https://agentgames.zkverify.io) (Season 01, 21 Oct – 21 Nov 2026). The platform POSTs signed proof-backed payment tasks; this agent decides APPROVE/REJECT with deterministic checks, generates a Groth16 proof of its decision locally with snarkjs, submits it to Kurier (zkVerify), and returns a signed response — all inside the 60-second window.

## How it works

```
platform task (signed POST /agent)
  -> HMAC verify (x-agent-games-signature over raw body)
  -> deterministic decision (7 documented trap checks)
  -> Groth16 proof via snarkjs (gatekeeper circuit)
  -> Kurier submit (async record; 10s timeout so it never blocks the reply)
  -> signed JSON response { decision, reason_code, proof, public_signals, proof_tx }
```

**Decision logic** (`decide.js`, pure, no LLM in the hot path):
- `PROOF_REUSED` — proof_tx already seen (persistent per-mode seen-set)
- `VK_SUBSTITUTION` — proof_vk ≠ registered_vk
- `THRESHOLD_MISMATCH` — public_balance < minimum
- `EXPIRED_CONDITION` — current_block ≥ expiry_block (strict — the circuit requires current < expiry)
- `RECIPIENT_MISMATCH` — recipient ≠ condition_recipient
- `AMOUNT_OVERFLOW` — amount > max_transfer
- else `APPROVE` / `VALID_CONDITION`

Fail closed everywhere: on any timeout, error, or uncertainty the agent REJECTs. The circuit itself enforces decision correctness — `fullProve` throws if the decision contradicts the inputs — so the server re-proves with the flipped decision as a safety net, and answers REJECT without a proof if both fail.

**Proofs** (`prover.js`): the gatekeeper circuit has 13 inputs (12 public + a private salt). vk hashes are reduced mod p; `taskId` is the UTF-8 bytes of the task id as an integer; the salt is deterministic (`sha256(taskId)` first 8 bytes), so retries produce identical proofs. Public signals: `[bindingHash, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId]`. Proof generation takes ~0.3–1s; a full task answers in ~1s.

**Idempotency**: responses are cached by `task_id` on disk; platform retries get the byte-identical response. Practice and competition seen-sets are separate.

## Run

```bash
npm install
cp .env.example ~/workspace/agentgames/agent.env   # mode 600, fill in secrets
node server.js                                     # PORT=3000 by default
```

Env vars (also read from `../agent.env`):
- `AGENT_GAMES_HMAC_SECRET` — platform-issued secret (Dashboard → Rotate Secret). `AGENT_SECRET` also accepted as a fallback alias. Until it is set, the server logs loudly and accepts unsigned requests (degraded — preflight will fail in this state).
- `KURIER_API_KEY` — Kurier mainnet API key. Optional: without it the server still answers with locally generated proofs (degraded mode, no zkVerify submission).
- `PINGGY_TOKEN` — free Pinggy account token. Without it the tunnel expires every 60 minutes and the public URL rotates (see below).
- `PORT` — default 3000.

After changing `agent.env`, restart the server so it picks up the new values: `pkill -f "node server.js"` — the supervisor restarts it within 3s.

## Supervised run (production)

```bash
node supervise.mjs
```

Keeps `server.js` + a **pinggy** SSH tunnel alive, restarts either on exit, health-checks the server every 30s, and writes the public URL to `current-url.txt`. Run under nohup:

```bash
cd ~/workspace/agentgames/server
setsid nohup node supervise.mjs > logs/supervisor.log 2>&1 < /dev/null &
```

**Restart procedure** (after a VM restart or a killed supervisor):

```bash
cd ~/workspace/agentgames/server
pkill -f "node supervise.mjs"; pkill -f "ssh -p 443 -R0"; pkill -f "node server.js"
setsid nohup node supervise.mjs > logs/supervisor.log 2>&1 < /dev/null &
sleep 20; cat current-url.txt   # <-- new public URL
```

⚠️ **The pinggy URL changes on every tunnel restart, and unauthenticated tunnels expire after 60 minutes.** After any restart, update the registered endpoint on the platform (Dashboard → My Agents → Edit agent → endpoint URL) to the new `current-url.txt` value, then re-run preflight. Set `PINGGY_TOKEN` (free Pinggy account) in `agent.env` for a tunnel that does not expire.

**Why pinggy:** this VM's egress proxy blocks cloudflared (403 on trycloudflare.com) and localtunnel (403), blocks outbound SSH on port 22, and Tailscale cannot host. Pinggy works over SSH on port 443 through the proxy (`proxy-command.py` does the CONNECT handshake using the sandbox `https_proxy` env var).

## Tests

```bash
node test-decide.js   # decision unit tests + circuit cross-check (each trap:
                      # circuit accepts the expected decision, rejects opposite)
node test-e2e.js      # live-server tests: preflight, signed tasks, replay,
                      # 401 on unsigned, reuse, practice/competition separation
```

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server, HMAC, routing, Kurier poller |
| `decide.js` | Pure decision logic |
| `prover.js` | snarkjs proof generation + local verify |
| `kurier.js` | Kurier REST client (submit-proof / job-status) |
| `store.js` | Persistent seen-sets, response cache, job records (`data/`, gitignored) |
| `supervise.mjs` | Server + pinggy tunnel supervisor |
| `proxy-command.py` | SSH ProxyCommand: CONNECT through the sandbox egress proxy |
| `gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json` | Official circuit artifacts from agentgames.zkverify.io/circuits (vkHash `0x6b79c6…`) |

## Notes / known ambiguities

- **HMAC scheme**: the docs say "HMAC over the RAW request body" without naming the hash. Implemented as HMAC-SHA256 hex (also accepts base64 and a `sha256=` prefix). Preflight is the live test — if it fails with a signature error, this is the first thing to revisit.
- **Response schema**: `{ decision, reason_code, proof, public_signals, proof_tx }` — the union of the event page shape (`proof_tx`) and the build guide shape (`proof`, `public_signals`). `proof_tx` echoes the task's proof reference. No `kurier_job_id` field (undocumented; job ids are kept in `data/kurier-jobs.json` for disputes).
- **vkHash scheme**: the platform-published vkHash (`0x6b79c6…`) is used verbatim for Kurier; its derivation from the verification key was not reverse-engineered (sha256 of the vk JSON does not match). Not blocking: the artifacts came from the platform itself and proofs verify locally against the exported vk.
- **expiry boundary**: the circuit requires `current_block < expiry_block` strictly — at equality it accepts REJECT and rejects APPROVE. `decide.js` matches.
