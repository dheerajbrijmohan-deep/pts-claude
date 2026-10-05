// Makes sure this project's local MySQL instance (backend/mysql/, port 3307)
// is running before the app starts, launching it if needed. No admin rights
// or Windows service required — mysqld just runs as a background process,
// same way the app itself does. Runs on its own port so it never collides
// with any other local MySQL instance on this machine.
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { MYSQL_HOST, MYSQL_PORT } = require('./config');

const MYSQL_DIR = path.join(__dirname, '..', 'mysql');
const MYSQLD_CANDIDATES = [
  'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqld.exe',
  'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe',
];

function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function waitForPort(host, port, tries = 20, delayMs = 500) {
  for (let i = 0; i < tries; i++) {
    if (await isPortOpen(host, port)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  if (await isPortOpen(MYSQL_HOST, MYSQL_PORT)) {
    console.log('MySQL is already running.');
    return;
  }

  const mysqld = MYSQLD_CANDIDATES.find((p) => fs.existsSync(p));
  if (!mysqld) {
    console.error('Could not find mysqld.exe. Is MySQL installed?');
    process.exit(1);
  }

  console.log('Starting MySQL...');
  const child = spawn(mysqld, [`--defaults-file=${path.join(MYSQL_DIR, 'my.ini')}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const up = await waitForPort(MYSQL_HOST, MYSQL_PORT);
  if (!up) {
    console.error('MySQL did not start in time. Check backend/mysql/logs/error.log');
    process.exit(1);
  }
  console.log('MySQL is up.');
}

main();
