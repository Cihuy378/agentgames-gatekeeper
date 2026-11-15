// prover.js — local Groth16 proof generation for the gatekeeper circuit.
// Circuit: GatekeeperEvaluation (Circom 2.x, Groth16/BN128).
// 13 named inputs (verified against the wasm via fullProve):
//   registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
//   currentBlock, recipient, conditionRecipient, amount, maxTransfer,
//   decision, taskId, salt.
// Public signals (13, in order): [bindingHash, registeredVkHash, proofVkHash,
//   minimum, publicBalance, expiryBlock, currentBlock, recipient,
//   conditionRecipient, amount, maxTransfer, decision, taskId].
// The circuit ENFORCES decision correctness: fullProve throws (Assert Failed,
// GatekeeperEvaluation line 102) when the decision contradicts the inputs.
// Encoding notes:
//   - vk hashes are 32-byte values > the BN128 field prime; they are reduced
//     mod p (snarkjs/the witness calculator reduces inputs mod p anyway).
//   - taskId is the UTF-8 bytes of the task id string as a big-endian integer.
//   - salt is deterministic: first 8 bytes of sha256(taskId). Deterministic
//     inputs => deterministic proofs => identical responses on platform retries.
'use strict';

const path = require('path');
const crypto = require('crypto');
const snarkjs = require('snarkjs');

const WASM = path.join(__dirname, 'gatekeeper.wasm');
const ZKEY = path.join(__dirname, 'gatekeeper_final.zkey');
const VK = require(path.join(__dirname, 'verification_key.json'));

const P = BigInt('0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47');
const modP = (x) => ((x % P) + P) % P;

function taskIdToField(taskId) {
  const hex = Buffer.from(String(taskId), 'utf8').toString('hex');
  return BigInt('0x' + hex);
}

function saltFor(taskId) {
  return BigInt('0x' + crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 16));
}

function toField(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  const s = String(v).trim();
  return BigInt(s);
}

/**
 * Build the circuit input object from a task + decision.
 * @param {object} input - task.input payload
 * @param {string} taskId - task id string
 * @param {0|1} decision - 0 = REJECT, 1 = APPROVE
 */
function buildInputs(input, taskId, decision) {
  return {
    registeredVkHash: modP(toField(input.registered_vk)).toString(),
    proofVkHash: modP(toField(input.proof_vk)).toString(),
    minimum: toField(input.minimum).toString(),
    publicBalance: toField(input.public_balance).toString(),
    expiryBlock: toField(input.expiry_block).toString(),
    currentBlock: toField(input.current_block).toString(),
    recipient: toField(input.recipient).toString(),
    conditionRecipient: toField(input.condition_recipient).toString(),
    amount: toField(input.amount).toString(),
    maxTransfer: toField(input.max_transfer).toString(),
    decision: String(decision),
    taskId: taskIdToField(taskId).toString(),
    salt: saltFor(taskId).toString(),
  };
}

/**
 * Generate + locally verify a proof for a task/decision.
 * @returns {Promise<{proof: object, publicSignals: string[], ms: number}>}
 * @throws if the decision contradicts the circuit (Assert Failed) or on any
 *   proving/verification failure.
 */
async function prove(input, taskId, decision) {
  const t0 = Date.now();
  const circuitInputs = buildInputs(input, taskId, decision);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInputs, WASM, ZKEY);
  const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
  if (!ok) throw new Error('local groth16 verification failed');
  return { proof, publicSignals, ms: Date.now() - t0 };
}

module.exports = { prove, buildInputs, taskIdToField, saltFor, VK };
