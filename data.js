import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataset, runTool as queryTool } from './queries.js';

const base = dirname(fileURLToPath(import.meta.url));
const localData = resolve(base, '../企业数据/2026-09-07_Bitkey/Data');
export const dataDir = resolve(process.env.OFFICE_DATA_DIR || (existsSync(resolve(localData, 'reservations.csv')) ? localData : resolve(base, 'demo-data')));
export function loadData(dir = dataDir) {
  const files = Object.fromEntries(['spaces.csv', 'reservations.csv', 'reservations_classified_mapping.csv'].map(name => [name, readFileSync(resolve(dir, name))]));
  return createDataset(files, resolve(dir) === resolve(base, 'demo-data') ? 'synthetic' : 'sample');
}
export const data = loadData();
export { warnings, selectedRows } from './queries.js';
export function runTool(name, args, db = data) {
  return queryTool(name, args, db);
}
