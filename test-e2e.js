// test-e2e.js — end-to-end test against a live server instance.
// Starts server.js on a test port with a test HMAC secret, then:
//   1. GET / health
//   2. Signed preflight -> {ok:true, protocolVersion:'v1'} + valid signature
//   3. Signed valid task -> APPROVE + proof + public_signals + valid signature
//   4. Signed trap task -> REJECT/VK_SUBSTITUTION + proof
//   5. Same task_id replay -> identical cached response
//   6. Unsigned task with secret set -> 401
//   7. Reused proof_tx (new task_id) -> REJECT/PROOF_REUSED, no proof
// Run: node test-e2e.js   (uses PORT 3101 + a temp data dir)
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 3101;
const SECRET = 'test-hmac-secret-0123456789abcdef0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}`;

const VK_A = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const VK_B = '0xa4c1b8ff9e2d4c5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9';
const ADDR = '0xDe42a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f01';

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function verifySig(body, header) {
  if (!header) return false;
  const hex = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return header === hex;
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.log('  FAIL', msg); }
}

function taskEnvelope(taskId, input, mode = 'practice') {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode,
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input,
  };
}

function validInput(proofTx) {
  return {
    registered_vk: VK_A, proof_vk: VK_A,
    minimum: '1000', public_balance: '1460',
    expiry_block: 8430000, current_block: 8420000,
    recipient: ADDR, condition_recipient: ADDR,
    amount: '500', max_transfer: '1000',
    proof_tx: proofTx,
  };
}

async function post(pathname, obj, { signed = true, raw = null } = {}) {
  const body = raw !== null ? raw : JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  if (signed) headers['x-agent-games-signature'] = sign(body);
  const res = await fetch(BASE + pathname, { method: 'POST', headers, body });
  const text = await res.text();
  return { status: res.status, text, sig: res.headers.get('x-agent-games-signature'), json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

(async () => {
  // Isolate test state in a temp dir — NEVER touch the production data/.
  const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gatekeeper-e2e-'));

  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET, DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => { serverOut += d; });
  child.stderr.on('data', (d) => { serverOut += d; });

  const stop = () => { try { child.kill('SIGTERM'); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', stop);

  try {
    // Wait for health.
    let up = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(BASE + '/');
        if (r.status === 200) { up = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    check(up, 'server starts + GET / 200');

    // 1. Health payload.
    const h = await fetch(BASE + '/');
    const hj = await h.json();
    check(hj.ok === true && hj.protocolVersion === 'v1' && hj.hmacConfigured === true, 'health payload ok');

    // 2. Preflight.
    const pf = await post('/agent', { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'abc123' });
    check(pf.status === 200 && pf.json && pf.json.ok === true && pf.json.protocolVersion === 'v1', 'preflight response shape');
    check(verifySig(pf.text, pf.sig), 'preflight response signature valid');

    // 3. Valid task.
    const t0 = Date.now();
    const v = await post('/agent', taskEnvelope('e2e-valid-1', validInput('0xe2e111')));
    const vMs = Date.now() - t0;
    check(v.status === 200 && v.json.decision === 'APPROVE' && v.json.reason_code === 'VALID_CONDITION', `valid task APPROVE (${vMs}ms)`);
    check(v.json.proof && Array.isArray(v.json.public_signals) && v.json.public_signals.length === 13, 'valid task has proof + 13 public signals');
    check(v.json.proof_tx === '0xe2e111', 'proof_tx echoed');
    check(verifySig(v.text, v.sig), 'valid task response signature valid');
    check(vMs < 30000, `valid task under 30s (${vMs}ms)`);

    // 4. Trap task (VK substitution).
    const trap = await post('/agent', taskEnvelope('e2e-trap-1', { ...validInput('0xe2e222'), proof_vk: VK_B }));
    check(trap.status === 200 && trap.json.decision === 'REJECT' && trap.json.reason_code === 'VK_SUBSTITUTION', 'trap task REJECT/VK_SUBSTITUTION');
    check(trap.json.proof && Array.isArray(trap.json.public_signals), 'trap task has proof (rejections are provable)');

    // 5. Replay same task_id -> identical response.
    const replay = await post('/agent', taskEnvelope('e2e-valid-1', validInput('0xe2e111')));
    check(replay.status === 200 && replay.text === v.text, 'task_id replay returns identical cached response');

    // 6. Unsigned task with secret set -> 401.
    const unauth = await post('/agent', taskEnvelope('e2e-noauth', validInput('0xe2e333')), { signed: false });
    check(unauth.status === 401, 'unsigned request rejected 401 when secret is set');

    // 7. Reused proof_tx, new task_id -> REJECT/PROOF_REUSED, no proof.
    const reused = await post('/agent', taskEnvelope('e2e-reused-1', validInput('0xe2e111')));
    check(reused.status === 200 && reused.json.decision === 'REJECT' && reused.json.reason_code === 'PROOF_REUSED', 'reused proof_tx REJECT/PROOF_REUSED');
    check(!reused.json.proof && !reused.json.public_signals, 'reused task carries no proof');

    // 8. Practice vs competition seen-sets are separate: same proof_tx in
    //    competition mode (fresh) must NOT be flagged reused.
    const comp = await post('/agent', taskEnvelope('e2e-comp-1', validInput('0xe2e111'), 'competition'));
    check(comp.status === 200 && comp.json.decision === 'APPROVE', 'competition mode not tainted by practice seen-set');
  } finally {
    stop();
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(failures === 0 ? 'ALL E2E TESTS PASSED' : `${failures} E2E FAILURES`);
  if (failures > 0) {
    console.log('--- server output ---');
    console.log(serverOut.slice(-3000));
  }
  process.exit(failures === 0 ? 0 : 1);
})();
