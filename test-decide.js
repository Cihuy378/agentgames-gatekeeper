// test-decide.js — decision-logic unit tests + circuit cross-check.
// Every trap variety + valid case + boundary cases. For each case we check:
//   1. decide() returns the expected decision/reason.
//   2. The circuit agrees: fullProve succeeds with the expected decision and
//      FAILS with the opposite decision (the circuit is the ground truth).
// Run: node test-decide.js
'use strict';

const { decide, REASONS } = require('./decide');
const { prove } = require('./prover');

const VK_A = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const VK_B = '0xa4c1b8ff9e2d4c5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9';
const ADDR_A = '0xDe42a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f01';
const ADDR_B = '0xBeef00112233445566778899aabbccddeeff0011';

function base(over) {
  return {
    registered_vk: VK_A, proof_vk: VK_A,
    minimum: '1000', public_balance: '1460',
    expiry_block: 8430000, current_block: 8420000,
    recipient: ADDR_A, condition_recipient: ADDR_A,
    amount: '500', max_transfer: '1000',
    proof_tx: '0xabc123',
    ...over,
  };
}

const CASES = [
  ['valid', base(), 'APPROVE', REASONS.VALID, true],
  ['VK_SUBSTITUTION', base({ proof_vk: VK_B }), 'REJECT', REASONS.VK, true],
  ['THRESHOLD_MISMATCH', base({ public_balance: '999' }), 'REJECT', REASONS.THRESHOLD, true],
  ['EXPIRED_CONDITION', base({ current_block: 8430001 }), 'REJECT', REASONS.EXPIRED, true],
  ['RECIPIENT_MISMATCH', base({ recipient: ADDR_B }), 'REJECT', REASONS.RECIPIENT, true],
  ['AMOUNT_OVERFLOW', base({ amount: '1001' }), 'REJECT', REASONS.AMOUNT, true],
  // Boundary cases. balance==minimum and amount==max APPROVE (circuit
  // agrees). current==expiry REJECTS: the circuit requires current < expiry
  // strictly (at equality it accepts decision=0 and rejects decision=1 —
  // verified by the cross-check below).
  ['boundary balance==minimum', base({ public_balance: '1000' }), 'APPROVE', REASONS.VALID, true],
  ['boundary current==expiry', base({ current_block: 8430000 }), 'REJECT', REASONS.EXPIRED, true],
  ['boundary amount==max', base({ amount: '1000' }), 'APPROVE', REASONS.VALID, true],
  // Case-insensitivity.
  ['vk case-insensitive', base({ proof_vk: VK_A.toUpperCase() }), 'APPROVE', REASONS.VALID, false],
  ['addr case-insensitive', base({ recipient: ADDR_A.toUpperCase() }), 'APPROVE', REASONS.VALID, false],
];

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.log('  FAIL', msg); }
}

(async () => {
  console.log('== decide() unit tests ==');
  const neverSeen = () => false;
  for (const [name, input, expDecision, expReason] of CASES) {
    const r = decide(input, neverSeen);
    check(r.decision === expDecision && r.reason_code === expReason,
      `${name}: ${r.decision}/${r.reason_code} (want ${expDecision}/${expReason})`);
  }

  // Reuse check (stateful).
  const seenOnce = (tx) => tx === '0xabc123';
  const r = decide(base(), seenOnce);
  check(r.decision === 'REJECT' && r.reason_code === REASONS.REUSED, `PROOF_REUSED: ${r.decision}/${r.reason_code}`);

  // Malformed input throws.
  for (const bad of [null, {}, base({ minimum: undefined }), base({ amount: 'abc' })]) {
    let threw = false;
    try { decide(bad, neverSeen); } catch { threw = true; }
    check(threw, `malformed input throws (${JSON.stringify(bad || null).slice(0, 40)})`);
  }

  console.log('== circuit cross-check (prove expected decision OK, opposite FAILS) ==');
  for (const [name, input, expDecision, , crossCheck] of CASES) {
    if (!crossCheck) continue;
    const want = expDecision === 'APPROVE' ? 1 : 0;
    const tid = 'test-' + name.replace(/[^a-z0-9]+/gi, '-');
    let okGood = false, okBad = false;
    try { await prove(input, tid, want); okGood = true; } catch (e) { okGood = false; }
    try { await prove(input, tid + '-flip', want === 1 ? 0 : 1); okBad = true; } catch { okBad = false; }
    if (crossCheck === 'edge-unsat') {
      // Documented edge: the circuit accepts NEITHER decision at equality.
      check(!okGood && !okBad, `${name}: circuit unsatisfiable both ways as documented (accept=${okGood}, opposite=${okBad})`);
    } else {
      check(okGood && !okBad, `${name}: circuit accepts ${expDecision} (${okGood}), rejects opposite (${!okBad})`);
    }  }

  console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
