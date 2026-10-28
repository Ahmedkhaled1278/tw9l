'use strict';
const path = require('node:path');
const { createJsonStorage } = require('./json');
function createStorage() {
  if (process.env.DATABASE_URL) return require('./pg').createPgStorage();
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  console.warn('Storage mode: local JSON. Set DATABASE_URL to enable normalized PostgreSQL storage.');
  return createJsonStorage(path.join(dataDir, 'wasl-store.json'));
}
module.exports = { createStorage };
