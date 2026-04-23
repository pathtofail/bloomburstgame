#!/usr/bin/env node
// Quick syntax check for index.html's inline scripts.
// Extracts every <script>…</script> block, concatenates them, and runs
// `node --check` on the result. Exits non-zero if the parse fails.
//
// Invoke: `node scripts/check.mjs`
// (the fixed path lets us allowlist it in .claude/settings.json)

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HTML = 'index.html';
const src = readFileSync(HTML, 'utf8');
const blocks = [...src.matchAll(/<script(\s+type=["']module["'])?[^>]*>([\s\S]*?)<\/script>/g)];
const joined = blocks.map(b => b[2]).join('\n;\n');

const tmp = join(tmpdir(), 'bloomburst-check.mjs');
writeFileSync(tmp, joined);

const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
try { unlinkSync(tmp); } catch {}

if (r.status !== 0) {
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
}
console.log(`OK — ${blocks.length} script block(s) parse.`);
