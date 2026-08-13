import axios from 'axios';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// e2e 的 axios 呼叫會經 Traefik 使用 HTTPS。優先使用 E2E_TLS_CA_FILE
// 指定公司 Root CA；未設定時才相容既有 mkcert 開發環境。絕不以
// NODE_TLS_REJECT_UNAUTHORIZED=0 關閉 TLS 驗證。
//
// axios is a singleton default export, and Jest's setupFiles run in the
// same module registry as the test file they precede, so this
// axios.defaults mutation is visible to every *.e2e-spec.ts file's own
// `import axios from 'axios'`.
const MKCERT_CAROOT =
  process.env.MKCERT_CAROOT ?? path.join(os.homedir(), '.local', 'share', 'mkcert');
const configuredCaFile = process.env.E2E_TLS_CA_FILE;
const mkcertCaFile = path.join(MKCERT_CAROOT, 'rootCA.pem');
const caFile = configuredCaFile ?? mkcertCaFile;

if (fs.existsSync(caFile)) {
  axios.defaults.httpsAgent = new https.Agent({ ca: fs.readFileSync(caFile) });
} else {
  // Fail loudly rather than silently falling back to no TLS verification --
  // every *.e2e-spec.ts request to the https://*.drm.apower.lan hosts will
  // throw a normal certificate-chain error, which is a much clearer signal
  // than a security downgrade would be.
  // eslint-disable-next-line no-console
  console.warn(
    `jest-e2e.setup.ts: TLS Root CA not found at ${caFile}. Set E2E_TLS_CA_FILE to the ` +
      `APOWER Root CA PEM path, or set MKCERT_CAROOT for the legacy mkcert environment; ` +
      `e2e HTTPS requests will fail closed.`,
  );
}
