// server.js — Proof Gatekeeper agent endpoint for zkVerify Agent Games.
// Spec: https://agentgames.zkverify.io/build + /rules (read 2026-11-15).
//
//   POST /agent  (or POST /)  — platform tasks + preflight
//   GET  /  GET /agent  HEAD / — health
//
// Env (see .env.example; secrets live in ~/workspace/agentgames/agent.env,
// mode 600 — NEVER in the repo):
//   AGENT_GAMES_HMAC_SECRET  platform-issued HMAC secret (Rotate Secret)
//   AGENT_SECRET             fallback alias for the HMAC secret
//   KURIER_API_KEY           Kurier mainnet API key (optional; without it the
//                            server still answers with local proofs)
//   PORT                     default 3000
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { decide, REASONS } = require('./decide');
const { prove } = require('./prover');
const kurier = require('./kurier');
const store = require('./store');

// ---- env -----------------------------------------------------------------
// Load ~/workspace/agentgames/agent.env if present (real env vars win).
for (const p of [path.join(__dirname, '..', 'agent.env'), path.join(__dirname, '.env')]) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch { /* file absent — fine */ }
}

const PORT = Number(process.env.PORT || 3000);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || process.env.AGENT_SECRET || '';
const KURIER_KEY_SET = Boolean(process.env.KURIER_API_KEY);

// ---- logging --------------------------------------------------------------
const LOG_FILE = path.join(__dirname, 'data', 'server.log');
function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

// ---- HMAC -----------------------------------------------------------------
// Scheme (docs say "HMAC over the RAW request body" without naming the hash;
// HMAC-SHA256 hex is the standard for this pattern): accept hex or base64,
// with an optional "sha256=" prefix. Responses are signed hex.
function hmacHex(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifySignature(rawBody, header) {
  if (!HMAC_SECRET) return { ok: true, skipped: true };
  if (!header) return { ok: false, reason: 'missing x-agent-games-signature' };
  let sig = String(header).trim();
  if (sig.toLowerCase().startsWith('sha256=')) sig = sig.slice(7);
  const hex = hmacHex(HMAC_SECRET, rawBody);
  const b64 = Buffer.from(hex, 'hex').toString('base64');
  if (safeEqual(sig, hex) || safeEqual(sig, b64)) return { ok: true, skipped: false };
  return { ok: false, reason: 'hmac mismatch' };
}

function signBody(rawBody) {
  if (!HMAC_SECRET) return null;
  return hmacHex(HMAC_SECRET, rawBody);
}

// ---- task handling (serialized — one task at a time) -----------------------
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const HARD_BUDGET_MS = 50000; // respond well inside the 60s platform window

// Boundary audit for the (should-never-happen) case where our checks say
// APPROVE but the circuit demands REJECT: re-check each condition with
// strict boundary comparisons to find the disagreement.
function boundaryAudit(input) {
  const bal = BigInt(String(input.public_balance).trim());
  const min = BigInt(String(input.minimum).trim());
  const cur = BigInt(String(input.current_block).trim());
  const exp = BigInt(String(input.expiry_block).trim());
  const amt = BigInt(String(input.amount).trim());
  const max = BigInt(String(input.max_transfer).trim());
  if (bal <= min) return REASONS.THRESHOLD;
  if (cur >= exp) return REASONS.EXPIRED;
  if (amt >= max) return REASONS.AMOUNT;
  if (String(input.recipient).toLowerCase() !== String(input.condition_recipient).toLowerCase()) return REASONS.RECIPIENT;
  return REASONS.VK; // last resort: vk comparison is the only check left
}

async function handleTask(env, startedAt, decided) {
  const { task_id, mode, input } = env;
  const taskId = String(task_id || '');
  const taskMode = mode === 'practice' ? 'practice' : 'competition';

  // Idempotency: the platform may retry after a network failure.
  const cached = taskId && store.getResponse(taskId);
  if (cached) {
    log({ ev: 'task-replay', taskId, mode: taskMode });
    return cached;
  }

  const t0 = Date.now();
  const decision = decide(input, (tx) => store.isSeen(taskMode, tx));
  // Publish the computed decision immediately so the hard-budget fallback
  // (below) can answer with the real decision even if proving hangs.
  decided.current = { decision: decision.decision, reason_code: decision.reason_code, proof_tx: input.proof_tx };

  // Record the proof reference as seen (first sight only — the check above
  // already rejected repeats). Practice and competition have separate sets.
  store.markSeen(taskMode, String(input.proof_tx).trim().toLowerCase(), taskId);

  const proofTx = input.proof_tx;
  let response;

  if (decision.reason_code === REASONS.REUSED) {
    // Reused proofs have no proof to submit (excluded from the bonus).
    response = { decision: 'REJECT', reason_code: REASONS.REUSED, proof_tx: proofTx };
    log({ ev: 'task-done', taskId, mode: taskMode, ...decision, proof: 'none-reused', ms: Date.now() - t0 });
  } else {
    // Generate the Groth16 proof. The circuit enforces decision correctness:
    // if proving fails, our decision contradicts the circuit — flip once.
    const want = decision.decision === 'APPROVE' ? 1 : 0;
    let proved = null;
    let finalDecision = decision.decision;
    let finalReason = decision.reason_code;
    try {
      proved = await prove(input, taskId, want);
    } catch (e) {
      log({ ev: 'prove-failed-flip', taskId, mode: taskMode, tried: decision.decision, err: String(e.message).slice(0, 200) });
      const flipped = want === 1 ? 0 : 1;
      try {
        proved = await prove(input, taskId, flipped);
        // The circuit says the opposite decision is the correct one.
        finalDecision = flipped === 1 ? 'APPROVE' : 'REJECT';
        // Recompute the reason for the flipped decision: APPROVE => the
        // checks must all pass; REJECT => the first failing check (ignoring
        // reuse, already handled) or a boundary audit if our checks say
        // APPROVE while the circuit says REJECT.
        if (finalDecision === 'APPROVE') {
          finalReason = REASONS.VALID;
        } else {
          const re = decide(input, () => false);
          finalReason = re.decision === 'REJECT' ? re.reason_code : boundaryAudit(input);
        }
        decided.current = { decision: finalDecision, reason_code: finalReason, proof_tx: proofTx };
      } catch (e2) {
        log({ ev: 'prove-failed-both', taskId, mode: taskMode, err: String(e2.message).slice(0, 200) });
        proved = null;
      }
    }

    if (!proved) {
      // Fail closed: REJECT without a proof (-2 for missing proof beats -6
      // for a wrong APPROVE). Reason: keep the original REJECT reason if we
      // started there; if we started at APPROVE but the circuit accepts
      // neither decision (e.g. the current==expiry edge, unsatisfiable both
      // ways), fall back to the boundary audit for the closest trap type.
      if (decision.decision === 'APPROVE') finalReason = boundaryAudit(input);
      response = { decision: 'REJECT', reason_code: finalReason, proof_tx: proofTx };
      log({ ev: 'task-done', taskId, mode: taskMode, decision: 'REJECT', reason_code: finalReason, proof: 'none-failed', ms: Date.now() - t0 });
    } else {
      response = {
        decision: finalDecision,
        reason_code: finalReason,
        proof: proved.proof,
        public_signals: proved.publicSignals,
        proof_tx: proofTx,
      };
      // Kurier submission (async record; await acceptance with a short
      // timeout so a slow Kurier never eats the response window).
      if (kurier.configured() && Date.now() - startedAt < 30000) {
        try {
          const sub = await kurier.submitProof(proved.proof, proved.publicSignals, 10000);
          store.putJob(sub.jobId, { taskId, status: 'Submitted', optimisticVerify: sub.optimisticVerify || null });
          log({ ev: 'kurier-submitted', taskId, jobId: sub.jobId, optimisticVerify: sub.optimisticVerify || null });
        } catch (e) {
          log({ ev: 'kurier-submit-failed', taskId, err: String(e.message).slice(0, 300) });
        }
      } else if (!kurier.configured()) {
        log({ ev: 'kurier-skipped', taskId, reason: 'KURIER_API_KEY unset (degraded mode)' });
      }
      log({ ev: 'task-done', taskId, mode: taskMode, decision: finalDecision, reason_code: finalReason, proofMs: proved.ms, ms: Date.now() - t0 });
    }
  }

  if (taskId) store.putResponse(taskId, response);
  return response;
}

// ---- Kurier background poller ---------------------------------------------
setInterval(async () => {
  if (!kurier.configured()) return;
  for (const job of store.pendingJobs().slice(0, 5)) {
    try {
      const st = await kurier.jobStatus(job.jobId, 10000);
      const status = st.status || st.state || 'unknown';
      const txHash = st.txHash || st.tx_hash || (st.details && st.details.txHash) || null;
      store.putJob(job.jobId, { status, txHash });
      if (status === 'Finalized' || status === 'Failed') {
        log({ ev: 'kurier-job-terminal', jobId: job.jobId, taskId: job.taskId, status, txHash });
      }
    } catch (e) {
      log({ ev: 'kurier-poll-failed', jobId: job.jobId, err: String(e.message).slice(0, 200) });
    }
  }
}, 20000);

// ---- HTTP server -----------------------------------------------------------
function sendJson(res, status, obj, sign) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'content-type': 'application/json', 'content-length': body.length };
  if (sign) {
    const sig = signBody(body);
    if (sig) headers['x-agent-games-signature'] = sig;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function healthPayload() {
  return {
    ok: true,
    service: 'agentgames-gatekeeper',
    protocolVersion: 'v1',
    time: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    hmacConfigured: Boolean(HMAC_SECRET),
    kurierConfigured: KURIER_KEY_SET,
    ...store.stats(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/agent' || p === '/health')) {
    return sendJson(res, 200, healthPayload(), true);
  }
  if (req.method === 'HEAD' && (p === '/' || p === '/agent' || p === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end();
  }
  if (req.method !== 'POST' || (p !== '/agent' && p !== '/')) {
    return sendJson(res, 404, { error: 'not found' }, false);
  }

  const chunks = [];
  req.on('data', (c) => {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 1024 * 1024) req.destroy(); // 1MB cap
  });
  req.on('end', () => {
    enqueue(async () => {
      const startedAt = Date.now();
      const rawBody = Buffer.concat(chunks);
      const v = verifySignature(rawBody, req.headers['x-agent-games-signature']);
      if (!v.ok) {
        log({ ev: 'hmac-reject', reason: v.reason, sigLen: String(req.headers['x-agent-games-signature'] || '').length });
        return sendJson(res, 401, { error: 'invalid signature' }, false);
      }
      if (v.skipped) {
        log({ ev: 'hmac-skipped-warning', msg: 'AGENT_GAMES_HMAC_SECRET unset — accepting unsigned requests (DEGRADED)' });
      }
      let env;
      try {
        env = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid json' }, false);
      }

      // Preflight handshake.
      if (env.type === 'agent-games.preflight.v1') {
        log({ ev: 'preflight', agent_id: env.agent_id || null, nonce: env.nonce || null });
        return sendJson(res, 200, { ok: true, protocolVersion: 'v1' }, true);
      }

      if (env.type !== 'agent-games.proof-gatekeeper.v1') {
        return sendJson(res, 400, { error: `unknown type: ${env.type}` }, false);
      }

      // Hard internal budget: never let a stuck proof eat the 60s window.
      // Falls back to the already-computed decision (without proof) — a
      // missing proof costs -2 but a correct decision can still score.
      const decided = { current: null };
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          log({ ev: 'hard-budget', taskId: env.task_id || null });
          const fb = decided.current || { decision: 'REJECT', reason_code: REASONS.THRESHOLD, proof_tx: env.input && env.input.proof_tx };
          sendJson(res, 200, fb, true);
        }
      }, HARD_BUDGET_MS);

      try {
        const response = await handleTask(env, startedAt, decided);
        clearTimeout(timer);
        if (!res.writableEnded) sendJson(res, 200, response, true);
      } catch (e) {
        clearTimeout(timer);
        log({ ev: 'task-error', taskId: env.task_id || null, err: String(e && e.message).slice(0, 300) });
        if (!res.writableEnded) {
          // Malformed task: 400 so the platform retries/flags it rather than
          // scoring a fabricated decision.
          sendJson(res, 400, { error: String(e && e.message).slice(0, 200) }, false);
        }
      }
    }).catch((e) => {
      log({ ev: 'queue-error', err: String(e && e.message).slice(0, 200) });
      if (!res.writableEnded) sendJson(res, 500, { error: 'internal' }, false);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log({ ev: 'startup', port: PORT, hmacConfigured: Boolean(HMAC_SECRET), kurierConfigured: KURIER_KEY_SET });
  if (!HMAC_SECRET) {
    log({ ev: 'startup-warning', msg: 'AGENT_GAMES_HMAC_SECRET is UNSET — HMAC verification skipped until the parent injects the secret. Preflight WILL FAIL in this state.' });
  }
  if (!KURIER_KEY_SET) {
    log({ ev: 'startup-warning', msg: 'KURIER_API_KEY is UNSET — proofs are generated locally but NOT submitted to zkVerify (degraded mode).' });
  }
});
