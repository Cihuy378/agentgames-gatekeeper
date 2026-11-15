// store.js — tiny persistent JSON store (atomic write via temp + rename).
// Holds: seen proof_tx sets (per mode), cached task responses (idempotency),
// Kurier job records. Lives under data/ (gitignored).
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function save(name, obj) {
  const tmp = filePath(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath(name));
}

// Seen proof_tx sets: { competition: {tx: taskId}, practice: {tx: taskId} }
let seen = load('seen.json', { competition: {}, practice: {} });
if (!seen.competition) seen.competition = {};
if (!seen.practice) seen.practice = {};

// Cached responses: { taskId: responseObject }
let responses = load('responses.json', {});

// Kurier jobs: { jobId: { taskId, status, txHash, updatedAt } }
let jobs = load('kurier-jobs.json', {});

function seenKey(mode) {
  return mode === 'practice' ? 'practice' : 'competition';
}

module.exports = {
  isSeen(mode, proofTx) {
    return Boolean(seen[seenKey(mode)][proofTx]);
  },
  markSeen(mode, proofTx, taskId) {
    seen[seenKey(mode)][proofTx] = taskId;
    save('seen.json', seen);
  },
  getResponse(taskId) {
    return responses[taskId] || null;
  },
  putResponse(taskId, response) {
    responses[taskId] = response;
    save('responses.json', responses);
  },
  getJob(jobId) {
    return jobs[jobId] || null;
  },
  putJob(jobId, rec) {
    jobs[jobId] = { ...jobs[jobId], ...rec, updatedAt: new Date().toISOString() };
    save('kurier-jobs.json', jobs);
  },
  pendingJobs() {
    return Object.entries(jobs)
      .filter(([, j]) => j.status !== 'Finalized' && j.status !== 'Failed')
      .map(([jobId, j]) => ({ jobId, ...j }));
  },
  stats() {
    return {
      seenCompetition: Object.keys(seen.competition).length,
      seenPractice: Object.keys(seen.practice).length,
      cachedResponses: Object.keys(responses).length,
      kurierJobs: Object.keys(jobs).length,
    };
  },
};
