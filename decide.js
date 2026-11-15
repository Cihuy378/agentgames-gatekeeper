// decide.js — pure, deterministic Proof Gatekeeper decision logic.
// No I/O, no LLM, no network. Every check is a comparison on the task payload.
// The gatekeeper circuit enforces the same checks (proving fails on a wrong
// decision), so this logic is cross-checked against the circuit in test-decide.js.
'use strict';

const REASONS = {
  VALID: 'VALID_CONDITION',
  VK: 'VK_SUBSTITUTION',
  THRESHOLD: 'THRESHOLD_MISMATCH',
  REUSED: 'PROOF_REUSED',
  EXPIRED: 'EXPIRED_CONDITION',
  RECIPIENT: 'RECIPIENT_MISMATCH',
  AMOUNT: 'AMOUNT_OVERFLOW',
};

function normHex(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function toBig(v, name) {
  // Accepts decimal strings, hex strings (0x...), or numbers.
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`non-integer ${name}: ${v}`);
    return BigInt(v);
  }
  const s = String(v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  if (/^-?\d+$/.test(s)) return BigInt(s);
  throw new Error(`bad integer ${name}: ${v}`);
}

/**
 * Decide a gatekeeper task.
 * @param {object} input - task.input from the platform envelope.
 * @param {(proofTx: string) => boolean} isSeen - returns true if proof_tx was
 *   already accepted in a previous task (same mode).
 * @returns {{decision: 'APPROVE'|'REJECT', reason_code: string}}
 * @throws on malformed input (caller fails closed).
 */
function decide(input, isSeen) {
  if (!input || typeof input !== 'object') throw new Error('missing input');
  const required = ['registered_vk', 'proof_vk', 'minimum', 'public_balance',
    'expiry_block', 'current_block', 'recipient', 'condition_recipient',
    'amount', 'max_transfer', 'proof_tx'];
  for (const k of required) {
    if (input[k] === undefined || input[k] === null || input[k] === '') {
      throw new Error(`missing input.${k}`);
    }
  }

  const proofTx = normHex(input.proof_tx);

  // 1. Reuse — stateful check first (a reused proof is a trap even if every
  //    other field is valid).
  if (isSeen(proofTx)) return { decision: 'REJECT', reason_code: REASONS.REUSED };

  // 2. Verification key substitution.
  if (normHex(input.proof_vk) !== normHex(input.registered_vk)) {
    return { decision: 'REJECT', reason_code: REASONS.VK };
  }

  // 3. Threshold mismatch.
  if (toBig(input.public_balance, 'public_balance') < toBig(input.minimum, 'minimum')) {
    return { decision: 'REJECT', reason_code: REASONS.THRESHOLD };
  }

  // 4. Expired condition. STRICT: the circuit requires current < expiry for
  //    a valid condition (at current == expiry the circuit accepts REJECT
  //    and rejects APPROVE — verified by the circuit cross-check).
  if (toBig(input.current_block, 'current_block') >= toBig(input.expiry_block, 'expiry_block')) {
    return { decision: 'REJECT', reason_code: REASONS.EXPIRED };
  }

  // 5. Recipient mismatch.
  if (normHex(input.recipient) !== normHex(input.condition_recipient)) {
    return { decision: 'REJECT', reason_code: REASONS.RECIPIENT };
  }

  // 6. Amount overflow.
  if (toBig(input.amount, 'amount') > toBig(input.max_transfer, 'max_transfer')) {
    return { decision: 'REJECT', reason_code: REASONS.AMOUNT };
  }

  return { decision: 'APPROVE', reason_code: REASONS.VALID };
}

module.exports = { decide, REASONS, toBig, normHex };
