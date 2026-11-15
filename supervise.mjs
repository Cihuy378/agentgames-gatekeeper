// supervise.mjs — keeps the gatekeeper server + pinggy tunnel alive.
//   node supervise.mjs
// Run under nohup (no systemd on this VM):
//   cd ~/workspace/agentgames/server
//   nohup node supervise.mjs > logs/supervisor.log 2>&1 &
// The public URL is written to current-url.txt whenever the tunnel (re)starts.
//
// WHY PINGGY: this VM's egress proxy blocks cloudflared (403 on
// trycloudflare.com) and localtunnel (403), blocks outbound SSH on port 22,
// and Tailscale cannot host. Pinggy over SSH:443 through the proxy works.
// Tunnel URL pattern: https://<sub>.free.pinggy.net (primary) and
// https://<sub>.run.pinggy-free.link (alt).
//
// ⚠️ UNAUTHENTICATED pinggy tunnels EXPIRE AFTER 60 MINUTES and the URL
// changes on every restart. The registered endpoint on
// agentgames.zkverify.io must be updated to the new current-url.txt value
// after each restart (Dashboard -> My Agents -> Edit agent -> endpoint),
// ideally within minutes — tasks sent to a dead URL time out.
// FIX: set PINGGY_TOKEN in ../agent.env (free Pinggy account token) —
// authenticated tunnels do not have the 60-minute limit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || '3000';
const URL_FILE = path.join(DIR, 'current-url.txt');
const LOG_DIR = path.join(DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Load ../agent.env (mode 600) into process.env without overriding real env.
for (const p of [path.join(DIR, '..', 'agent.env'), path.join(DIR, '.env')]) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* missing file: fine */ }
}

const PINGGY_TOKEN = (process.env.PINGGY_TOKEN || '').trim();

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
  log(`starting pinggy tunnel (authenticated=${!!PINGGY_TOKEN})`);
  const target = PINGGY_TOKEN ? `-t${PINGGY_TOKEN}@free.pinggy.io` : 'free.pinggy.io';
  tunnelProc = spawn('ssh', [
    '-p', '443',
    '-R0:localhost:' + PORT,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', `ProxyCommand=python3 ${path.join(DIR, 'proxy-command.py')} %h %p`,
    '-T',
    target,
  ], { cwd: DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(LOG_DIR, 'pinggy.log'), { flags: 'a' });
  const onData = (d) => {
    out.write(d);
    const s = String(d);
    // Prefer the primary free.pinggy.net URL; fall back to the alt domain.
    const m = s.match(/https:\/\/[a-z0-9-]+\.free\.pinggy\.net/i)
      || s.match(/https:\/\/[a-z0-9-]+\.run\.pinggy-free\.link/i);
    if (m && m[0] !== currentUrl) {
      currentUrl = m[0];
      fs.writeFileSync(URL_FILE, currentUrl + '/agent\n');
      log(`PUBLIC URL: ${currentUrl}/agent`);
    }
    if (s.includes('expire in 60 minutes')) {
      log('WARNING: unauthenticated pinggy tunnel — expires in 60 min. Set PINGGY_TOKEN for a stable tunnel.');
    }
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);
  tunnelProc.on('exit', (code, sig) => {
    log(`pinggy tunnel exited code=${code} sig=${sig} — restarting in 5s (URL WILL CHANGE)`);
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
