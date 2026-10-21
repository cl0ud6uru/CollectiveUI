import { readFile } from 'node:fs/promises';
import { assertAttachmentPostgresReport } from './attachment-postgres-proof.mjs';

assertAttachmentPostgresReport(JSON.parse(await readFile(process.argv[2], 'utf8')));
console.log('All 19 cases passed on PostgreSQL; neither suite skipped');
