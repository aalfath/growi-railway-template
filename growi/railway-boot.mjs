// First-boot setup for GROWI on Railway, run once by start.sh before GROWI starts.
//
// 1. Waits for MongoDB to accept writes (single-node replica set).
// 2. Takes a boot lock in MongoDB, so overlapping deploys never install twice.
// 3. On the first boot only: runs GROWI on a private port (Railway routes nothing to it)
//    so its auto-install creates the admin from AUTO_INSTALL_ADMIN_*, checks the admin
//    exists, stops it and sets self-registration to "Closed". If that fails, it exits
//    non-zero and the public port never opens on an uninstalled wiki.
// Exits 0 when GROWI is set up.
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
  return spawn(process.execPath, ['--max-old-space-size=48', '/docker-entrypoint.ts'], {
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

await releaseLock(db);
await client.close().catch(() => {});
process.exit(0);
