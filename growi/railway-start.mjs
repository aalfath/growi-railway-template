// Start script for GROWI on Railway.
//
// 1. Checks the generated secrets are set, and fills in safe defaults.
// 2. Waits for MongoDB to accept writes (single-node replica set).
// 3. Takes a boot lock in MongoDB, so overlapping deploys never migrate or install twice.
// 4. On the first boot only: runs GROWI on a private port (Railway routes nothing to it)
//    so its auto-install creates the admin from AUTO_INSTALL_ADMIN_*, checks the admin
//    exists, stops it and sets self-registration to "Closed". If that fails, the
//    container exits non-zero and the public port never opens on an uninstalled wiki.
// 5. Runs the upstream entrypoint (migrations, privilege drop, heap sized from the
//    cgroup) on $PORT. Any unexpected exit, even with code 0, exits non-zero so
//    Railway's ON_FAILURE policy restarts it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';

const log = (...a) => console.log('[railway]', ...a);
const fail = (msg) => {
  console.error('[railway]', msg);
  process.exit(1);
};

const env = process.env;
const def = (k, v) => {
  if (env[k] == null || env[k] === '') env[k] = v;
};

for (const k of ['MONGO_URI', 'PASSWORD_SEED', 'SECRET_TOKEN', 'AUTO_INSTALL_ADMIN_PASSWORD']) {
  if (!env[k]) fail(`${k} is empty: refusing to start (set it on the GROWI service)`);
}
if (env.AUTO_INSTALL_ADMIN_PASSWORD.length < 8) fail('AUTO_INSTALL_ADMIN_PASSWORD must be at least 8 characters');

def('PORT', '3000');
def('AUTO_INSTALL_ADMIN_USERNAME', 'admin');
def('AUTO_INSTALL_ADMIN_NAME', env.AUTO_INSTALL_ADMIN_USERNAME);
def('AUTO_INSTALL_GLOBAL_LANG', 'en_US');
// Attachments are stored in MongoDB (GridFS), so the GROWI service itself keeps no state
// and the whole stack needs only MongoDB's volume.
def('FILE_UPLOAD', 'mongodb');
def('DEPLOYMENT_TYPE', 'others');
// Upstream sends anonymised telemetry to telemetry.growi.org by default; off here.
def('OPENTELEMETRY_ENABLED', 'false');
// Railway's proxy reaches the service from these ranges; trust them for X-Forwarded-*.
if (!env.TRUST_PROXY_BOOL && !env.TRUST_PROXY_HOPS) def('TRUST_PROXY_CSV', 'loopback,100.64.0.0/10,152.233.0.0/16');
// Site URL from Railway's public domain, ignored when empty or invalid.
if (!env.APP_SITE_URL) {
  const d = (env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) env.APP_SITE_URL = `https://${d}`;
}
if (env.APP_SITE_URL && !/^https?:\/\/[^/\s]+/.test(env.APP_SITE_URL)) {
  log(`ignoring invalid APP_SITE_URL "${env.APP_SITE_URL}"`);
  delete env.APP_SITE_URL;
}
// libuv threads from the service's CPUs, not the host's.
try {
  const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
  const cpus = quota === 'max' ? os.availableParallelism() : Math.ceil(Number(quota) / Number(period));
  def('UV_THREADPOOL_SIZE', String(Math.min(4, Math.max(2, cpus || 2))));
} catch {
  def('UV_THREADPOOL_SIZE', '4');
}

const require = createRequire('/opt/growi/apps/app/package.json');
const { MongoClient } = require('mongodb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const holder = `${os.hostname()}-${process.pid}-${Date.now()}`;

async function connectMongo() {
  const limit = Number(env.WAIT_FOR_MONGO_SECONDS || 300) * 1000;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < limit) {
    const client = new MongoClient(env.MONGO_URI, { serverSelectionTimeoutMS: 4000, connectTimeoutMS: 4000 });
    try {
      await client.connect();
      const hello = await client.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary) {
        log(`MongoDB is ready after ${Math.round((Date.now() - started) / 1000)} s`);
        return client;
      }
      last = 'MongoDB is up but not primary yet';
    } catch (e) {
      last = e.message;
    }
    await client.close().catch(() => {});
    await sleep(3000);
  }
  fail(`MongoDB not ready after ${limit / 1000} s: ${last}`);
}

async function takeLock(db) {
  const locks = db.collection('railway_boot_lock');
  const ttl = 10 * 60 * 1000;
  for (;;) {
    const now = new Date();
    try {
      const r = await locks.findOneAndUpdate(
        { _id: 'boot', $or: [{ until: { $lt: now } }, { holder }] },
        { $set: { holder, until: new Date(now.getTime() + ttl) } },
        { upsert: true, returnDocument: 'after' },
      );
      const doc = r?.value ?? r;
      if (doc?.holder === holder) return;
    } catch (e) {
      if (e.code !== 11000) throw e; // 11000: another deploy holds the lock
    }
    log('another deploy holds the boot lock; waiting');
    await sleep(5000);
  }
}

const releaseLock = (db) => db.collection('railway_boot_lock').deleteOne({ _id: 'boot', holder }).catch(() => {});

// Set up = installed by GROWI and the registration mode written by step 4. A half-finished
// first boot (installed flag but no mode) goes through step 4 again.
async function isSetUp(db) {
  const cfg = await db.collection('configs').findOne({ key: 'app:installed' });
  if (cfg?.value !== 'true') return false;
  return (await db.collection('configs').countDocuments({ key: 'security:registrationMode' })) > 0;
}

const hasActiveAdmin = async (db) => (await db.collection('users').countDocuments({ admin: true, status: 2 })) > 0;

function runUpstream(port) {
  return spawn(process.execPath, ['/docker-entrypoint.ts'], {
    stdio: 'inherit',
    env: { ...env, PORT: String(port) },
  });
}

async function waitHttp(port, child, limitMs) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (child.exitCode != null || child.signalCode != null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/_api/v3/healthcheck`);
      if (r.ok) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

const stopChild = (child) =>
  new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 20000).unref();
  });

async function firstBoot(db) {
  if (await hasActiveAdmin(db)) return closeRegistration(db); // install done, mode not yet written
  if ((await db.collection('users').countDocuments({})) === 0) {
    // A first boot that stopped half-way leaves "installed" set with no user, and GROWI
    // would then never run its auto-install again. Clear it so the install is retried.
    await db.collection('configs').deleteOne({ key: 'app:installed' });
  }
  const port = 3999;
  log(`first boot: installing GROWI on private port ${port} (admin "${env.AUTO_INSTALL_ADMIN_USERNAME}")`);
  const child = runUpstream(port);
  const up = await waitHttp(port, child, 15 * 60 * 1000);
  let ok = false;
  if (up) {
    for (let i = 0; i < 10 && !ok; i++) {
      ok = await hasActiveAdmin(db);
      if (!ok) await sleep(2000);
    }
  }
  await stopChild(child);
  if (!ok) {
    await releaseLock(db);
    fail('first-boot install failed: no admin account was created. The public port stays closed. See the logs above.');
  }
  await closeRegistration(db);
}

async function closeRegistration(db) {
  // Close self-registration before GROWI ever listens on the public port. (Not before the
  // install: GROWI marks itself installed before it creates the admin, so a closed mode
  // would leave the admin "pending approval".) The admin can reopen it under
  // Admin > Security; an existing setting is never overwritten.
  await db
    .collection('configs')
    .updateOne({ key: 'security:registrationMode' }, { $setOnInsert: { value: JSON.stringify('Closed') } }, { upsert: true });
  const mode = await db.collection('configs').findOne({ key: 'security:registrationMode' });
  if (!mode) fail('could not set the registration mode');
  log(`first boot: admin account created, self-registration is ${JSON.parse(mode.value)}`);
}

const client = await connectMongo();
const db = client.db(); // database from MONGO_URI
await takeLock(db);
if (!(await isSetUp(db))) await firstBoot(db);

log(`starting GROWI on port ${env.PORT}`);
const app = runUpstream(env.PORT);
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    app.kill(sig);
  });
}
app.on('exit', (code, signal) => {
  if (stopping) process.exit(0);
  console.error(`[railway] GROWI exited (code ${code}, signal ${signal}); exiting non-zero so Railway restarts it`);
  process.exit(code ? code : 1);
});

// Keep the boot lock until GROWI answers on the public port (migrations done), then release it.
if (await waitHttp(env.PORT, app, 15 * 60 * 1000)) log('GROWI is up');
await releaseLock(db);
await client.close().catch(() => {});
