import { signInSIWC } from '../src/lib/llm/chatgpt/siwc';
import { readProtectedSIWCProfile } from '../src/lib/llm/chatgpt/siwc';

function value(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    process.stdout.write('Usage: npx tsx scripts/chatgpt-sign-in.ts --output <protected-file> [--host-id <stable-host-id>] [--existing <protected-profile>]\n');
    return;
  }
  if (args.some((arg, i) => !['--host-id', '--output', '--existing'].includes(arg) && (i === 0 || !['--host-id', '--output', '--existing'].includes(args[i - 1])))) throw new Error('Unknown argument');
  const outputPath = value(args, '--output'), existingPath = args.includes('--existing') ? value(args, '--existing') : undefined;
  const existing = existingPath ? await readProtectedSIWCProfile(existingPath) : undefined;
  const hostId = args.includes('--host-id') ? value(args, '--host-id') : undefined;
  await signInSIWC({ hostId, existing, outputPath, openBrowser: url => {
    process.stdout.write(`Open this URL in a browser on this computer to sign in:\n${url}\n`);
  } });
  process.stdout.write(`Sign in complete. Protected credentials saved to ${outputPath}. Transfer the file securely to the VM.\n`);
}

main().catch(() => {
  process.stderr.write('Sign in failed. Check the host ID, output path, and network connection, then try again.\n');
  process.exitCode = 1;
});
