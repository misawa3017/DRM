import axios from 'axios';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The e2e suite's axios calls hit https://{app,api,auth,storage}.drm.apower.lan
// through Traefik, which now terminates TLS with an mkcert-issued
// certificate (see traefik/dynamic.yml). mkcert's root CA lives in a
// per-developer directory (mkcert's default CAROOT, $XDG_DATA_HOME/mkcert
// or ~/.local/share/mkcert when XDG_DATA_HOME is unset -- confirmed via
// `mkcert -CAROOT` on this host) and is only trusted automatically by an
// OS/browser that has run `mkcert -install` against it. Rather than
// disabling TLS verification outright (NODE_TLS_REJECT_UNAUTHORIZED=0,
// which would accept ANY certificate, not just ours), this points axios's
// shared https.Agent at the mkcert root CA specifically, so these requests
// still get genuine chain validation -- just against the one CA that's
// legitimately supposed to have issued this cert.
//
// axios is a singleton default export, and Jest's setupFiles run in the
// same module registry as the test file they precede, so this
// axios.defaults mutation is visible to every *.e2e-spec.ts file's own
// `import axios from 'axios'`.
const MKCERT_CAROOT =
  process.env.MKCERT_CAROOT ?? path.join(os.homedir(), '.local', 'share', 'mkcert');
const caFile = path.join(MKCERT_CAROOT, 'rootCA.pem');

if (fs.existsSync(caFile)) {
  axios.defaults.httpsAgent = new https.Agent({ ca: fs.readFileSync(caFile) });
} else {
  // Fail loudly rather than silently falling back to no TLS verification --
  // every *.e2e-spec.ts request to the https://*.drm.apower.lan hosts will
  // throw a normal certificate-chain error, which is a much clearer signal
  // than a security downgrade would be.
  // eslint-disable-next-line no-console
  console.warn(
    `jest-e2e.setup.ts: mkcert root CA not found at ${caFile}. Set MKCERT_CAROOT or run ` +
      `'mkcert -install' equivalent setup; e2e HTTPS requests will fail TLS verification.`,
  );
}
