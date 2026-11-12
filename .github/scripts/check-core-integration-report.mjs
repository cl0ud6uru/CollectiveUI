import { readFile } from 'node:fs/promises';
import { assertCoreIntegrationReport } from './core-integration-proof.mjs';

const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
assertCoreIntegrationReport(report);
console.log(`All ${report.numPassedTests} core integration cases passed; no suites or cases skipped`);
