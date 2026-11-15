// kurier.js — Kurier REST client (zkVerify mainnet).
// Docs: https://agentgames.zkverify.io/build (Kurier snippet) and
// https://docs.zkverify.io/overview/getting-started/kurier
//   POST {API}/submit-proof/{KEY}
//     { proofType:'groth16', vkRegistered:true,
//       proofOptions:{library:'snarkjs', curve:'bn128'},
//       proofData:{ proof, publicSignals, vk: registeredVkHash } }
//   GET  {API}/job-status/{KEY}/{jobId}  -> { status, ... }
// Statuses: Submitted -> IncludedInBlock -> Finalized.
'use strict';

const API_URL = process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1';
const VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

function key() {
  return process.env.KURIER_API_KEY || '';
}

function configured() {
  return key().length > 0;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Submit a proof to Kurier. Returns { jobId, optimisticVerify, raw }.
 * @throws on network error, non-2xx, or missing jobId.
 */
async function submitProof(proof, publicSignals, timeoutMs = 15000) {
  const res = await fetchWithTimeout(`${API_URL}/submit-proof/${key()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proofType: 'groth16',
      vkRegistered: true,
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      proofData: { proof, publicSignals, vk: VK_HASH },
    }),
  }, timeoutMs);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`kurier submit ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const jobId = body.jobId || body.job_id || body.id;
  if (!jobId) throw new Error(`kurier submit: no jobId in ${JSON.stringify(body).slice(0, 300)}`);
  return { jobId, optimisticVerify: body.optimisticVerify, raw: body };
}

/** Poll one job's status. Returns the status object. */
async function jobStatus(jobId, timeoutMs = 15000) {
  const res = await fetchWithTimeout(`${API_URL}/job-status/${key()}/${jobId}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  }, timeoutMs);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`kurier job-status ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

module.exports = { submitProof, jobStatus, configured, VK_HASH, API_URL };
