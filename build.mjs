import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, 'src/index.ts')],
  outfile: resolve(__dirname, 'api/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: false,
  sourcemap: true,
  external: [
    // Node built-ins
    'crypto', 'path', 'fs', 'url', 'http', 'https', 'stream',
    'buffer', 'util', 'os', 'events', 'net', 'tls', 'dns',
    'zlib', 'module', 'worker_threads', 'querystring',
    'string_decoder', 'assert', 'child_process',
    // Vercel runtime
    '@vercel/node',
  ],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __dirname_fn } from 'path';",
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_fn(__filename);',
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

console.log('Built → api/index.js');
