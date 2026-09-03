import { build } from 'esbuild';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Generate Prisma client against the current schema BEFORE bundling.
// Without this, esbuild may pick up a stale generated client (e.g. from a
// previous provider) or a client missing the runtime's binary target.
// On Vercel, a build cache can keep a pre-switch client around unless we
// regenerate on every build.
console.log('Running prisma generate...');
execSync('npx prisma generate', { stdio: 'inherit', cwd: __dirname });

// Type-check gate: abort the build BEFORE esbuild if tsc finds a type error.
// esbuild does not type-check, so without this gate a type regression would
// ship silently. execSync throws on a non-zero child exit, which aborts this
// script with a non-zero code — that IS the fail-build behavior.
console.log('Type-checking (tsc --noEmit)...');
execSync('npx tsc --noEmit', { stdio: 'inherit', cwd: __dirname });

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
    // Prisma must NOT be bundled: esbuild cannot copy the native
    // libquery_engine-*.so.node binary next to the bundle, which causes
    // PrismaClientInitializationError at runtime on serverless targets
    // ("could not locate the Query Engine for runtime rhel-openssl-3.0.x").
    // Leaving these external lets the runtime resolve from node_modules,
    // where `prisma generate` placed the platform-specific engine.
    '@prisma/client',
    '.prisma/client',
    '.prisma/client/default',
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
