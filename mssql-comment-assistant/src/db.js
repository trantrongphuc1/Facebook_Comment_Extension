const sql = require('mssql');

function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
}

const connectionString = (process.env.MSSQL_CONNECTION_STRING || '').trim();

const config = connectionString
  ? {
    connectionString,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  }
  : {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_SERVER,
    port: Number(process.env.MSSQL_PORT || 1433),
    database: process.env.MSSQL_DATABASE,
    options: {
      encrypt: readBool(process.env.MSSQL_ENCRYPT, false),
      trustServerCertificate: readBool(process.env.MSSQL_TRUST_CERT, true)
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };

let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config);
  }
  return poolPromise;
}

async function withTransaction(work) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const result = await work(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

function createRequest(scope) {
  return scope ? new sql.Request(scope) : null;
}

module.exports = {
  sql,
  config,
  getPool,
  withTransaction,
  createRequest
};