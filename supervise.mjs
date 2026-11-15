// supervise.mjs — keeps the gatekeeper server + cloudflared tunnel alive.
//   node supervise.mjs
// Run under nohup (no systemd on this VM):
//   cd ~/workspace/agentgames/server
//   nohup node supervise.mjs > logs/supervisor.log 2>&1 &
// The public URL is written to current-url.txt whenever the tunnel (re)starts.
// NOTE: a trycloudflare URL CHANGES on tunnel restart — after a restart, the
// registered endpoint on agentgames.zkverify.io must be updated to the new URL
// (Dashboard -> My Agents -> Edit agent -> endpoint).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || path.join(DIR, '..', 'bin', 'cloudflared');
const PORT = process.env.PORT || '3000';
const URL_FILE = path.join(DIR, 'current-url.txt');
const LOG_DIR = path.join(DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'supervisor.log'), line + '\n');
}

let serverProc = null;
let tunnelProc = null;
let currentUrl = null;

function startServer() {
  if (serverProc) return;
  log('starting server.js');
  serverProc = spawn('node', ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(path.join(LOG_DIR, 'server.log'), { flags: 'a' });
  serverProc.stdout.pipe(out);
  serverProc.stderr.pipe(out);
  serverProc.on('exit', (code, sig) => {
    log(`server exited code=${code} sig=${sig} — restarting in 3s`);
    serverProc = null;
    setTimeout(startServer, 3000);
  });
}

function startTunnel() {
  if (tunnelProc) return;
  log('starting cloudflared quick tunnel');
  tunnelProc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
    cwd: DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(path.join(LOG_DIR, 'cloudflared.log'), { flags: 'a' });
  const onData = (d) => {
    out.write(d);
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && m[0] !== currentUrl) {
      currentUrl = m[0];
      fs.writeFileSync(URL_FILE, currentUrl + '/agent\n');
      log(`PUBLIC URL: ${currentUrl}/agent`);
    }
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);
  tunnelProc.on('exit', (code, sig) => {
    log(`cloudflared exited code=${code} sig=${sig} — restarting in 5s (URL WILL CHANGE)`);
    tunnelProc = null;
    currentUrl = null;
    setTimeout(startTunnel, 5000);
  });
}

startServer();
setTimeout(startTunnel, 2000); // let the server bind first

// Self-health: if the server stops answering locally, kill it (supervisor restarts it).
setInterval(async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('bad status ' + r.status);
  } catch (e) {
    log(`local health check failed (${e.message}) — restarting server`);
    if (serverProc) { serverProc.kill('SIGKILL'); serverProc = null; }
    setTimeout(startServer, 1000);
  }
}, 30000);

log('supervisor up');
