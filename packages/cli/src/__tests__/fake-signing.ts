import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Fake Git signing protocol. No account, network, key material or host agent. */
export function configureFakeSigning(repoDir: string): void {
  const program = path.join(repoDir, ".afk", "fake-gpg.cjs");
  fs.writeFileSync(program, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--verify')) {
  const status = args.includes('--status-fd=1') ? process.stdout : process.stderr;
  status.write('[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG 0123456789ABCDEF Test User <test@example.com>\\n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-01-01 1767225600 0 4 0 1 10 00 0123456789ABCDEF0123456789ABCDEF01234567\\n[GNUPG:] TRUST_FULLY 0 pgp\\n');
} else {
  fs.readFileSync(0);
  process.stderr.write('[GNUPG:] SIG_CREATED D 1 10 00 1767225600 0123456789ABCDEF0123456789ABCDEF01234567\\n');
  process.stdout.write('-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZS1zaWduYXR1cmU=\\n-----END PGP SIGNATURE-----\\n');
}
`);
  fs.chmodSync(program, 0o755);
  for (const [key, value] of [["gpg.format", "openpgp"], ["gpg.program", program], ["user.signingkey", "fixture-key"]]) {
    execFileSync("git", ["config", key!, value!], { cwd: repoDir });
  }
}
