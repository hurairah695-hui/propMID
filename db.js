// db.js - one shared SQL Server connection pool + small helpers
require('dotenv').config();
const sql = require('mssql');

const bool = (v, d = false) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

function buildConfig() {
  const cfg = {
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_NAME || 'PropDealDB',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
    options: {
      encrypt: bool(process.env.DB_ENCRYPT, false),
      trustServerCertificate: bool(process.env.DB_TRUST_CERT, true),
      enableArithAbort: true,
      useUTC: true
    }
  };
  if (process.env.DB_INSTANCE) cfg.options.instanceName = process.env.DB_INSTANCE;   // named instance -> no port
  else cfg.port = parseInt(process.env.DB_PORT || '1433', 10);

  if (bool(process.env.DB_LEGACY_TLS, false)) {
    // SQL Server 2014 (unpatched) only offers TLS 1.0 - allow it explicitly
    cfg.options.cryptoCredentialsDetails = { minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' };
  }
  return cfg;
}

let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig())
      .connect()
      .then(pool => {
        pool.on('error', err => console.error('[db] pool error:', err.message));
        return pool;
      })
      .catch(err => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

/**
 * run(text, params, tx?) -> recordset (array of rows)
 * params: { name: value }  or  { name: [sql.Type, value] }
 * Always uses parameters, never string concatenation, so SQL injection is not possible.
 */
async function run(text, params = {}, tx = null) {
  const request = tx ? new sql.Request(tx) : (await getPool()).request();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) request.input(k, v[0], v[1]);
    else request.input(k, v);
  }
  const result = await request.query(text);
  return result.recordset || [];
}

/** Runs fn(tx) inside one transaction. Commits on success, rolls back on any error. */
async function withTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}

async function closePool() {
  if (poolPromise) { const p = await poolPromise; poolPromise = null; await p.close(); }
}

module.exports = { sql, getPool, run, withTransaction, closePool };
