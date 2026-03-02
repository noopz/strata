#!/usr/bin/env node
/**
 * End-to-end smoke test for the read hook pipeline.
 * Tests: outline serving, targeted read passthrough, repeat read handling.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const TEST_FILE = '/tmp/test-hook-file.ts';

// Create test file with 349 lines (above 300 threshold)
const lines = [];
for (let i = 1; i <= 349; i++) {
  if (i === 42) lines.push('function handleAuth(req) {');
  else if (i === 43) lines.push('  const token = req.headers.auth;');
  else if (i === 44) lines.push('  return validate(token);');
  else if (i === 45) lines.push('}');
  else lines.push(`// line ${i} of filler content`);
}
fs.writeFileSync(TEST_FILE, lines.join('\n') + '\n');

function runHook(hookName, input) {
  const hookPath = path.join(HOOKS_DIR, hookName);
  const result = execSync(`bash "${hookPath}"`, {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/tmp' },
    encoding: 'utf-8',
    timeout: 10000,
  });
  return JSON.parse(result);
}

let passed = 0;
let failed = 0;
const results = [];

function assert(label, condition, detail) {
  results.push({ label, passed: !!condition, detail: condition ? undefined : (detail || undefined) });
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label} — ${detail || ''}`);
    failed++;
  }
}

// --- Step 1: Mode 1 — Untargeted Read ---
console.log('\n=== Step 1: Untargeted Read (Mode 1) ===');
const mode1 = runHook('pre-read.sh', { tool_input: { file_path: TEST_FILE } });
const m1out = mode1.hookSpecificOutput || {};
assert('permissionDecision = allow', m1out.permissionDecision === 'allow', m1out.permissionDecision);
assert('updatedInput.file_path is cache file', m1out.updatedInput && m1out.updatedInput.file_path && m1out.updatedInput.file_path.includes('.strata/'), m1out.updatedInput?.file_path);
assert('additionalContext mentions outline', (m1out.additionalContext || '').includes('outline'), m1out.additionalContext?.substring(0, 80));
assert('Mode 1 additionalContext mentions Edit', (m1out.additionalContext || '').includes('Edit'), m1out.additionalContext?.substring(0, 200));
assert('Mode 1 additionalContext warns against full rewrite', (m1out.additionalContext || '').includes('never rewrite'), m1out.additionalContext?.substring(0, 300));

// Check that cached outline file contains line-number tags
const cacheFilePath = m1out.updatedInput && m1out.updatedInput.file_path;
if (cacheFilePath && fs.existsSync(cacheFilePath)) {
  const cacheContent = fs.readFileSync(cacheFilePath, 'utf-8');
  assert('cached outline contains line-number tags', /\d+:/.test(cacheContent), cacheContent.substring(0, 200));
} else {
  assert('cached outline file exists for tag check', false, cacheFilePath || 'no path');
}

// --- Step 2: Targeted Read on large file — passthrough with context ---
console.log('\n=== Step 2: Targeted Read on large file (passthrough + context) ===');
const targeted = runHook('pre-read.sh', { tool_input: { file_path: TEST_FILE, offset: 40, limit: 8 } });
const t2out = targeted.hookSpecificOutput || {};
assert('targeted read permissionDecision = allow', t2out.permissionDecision === 'allow', t2out.permissionDecision);
assert('targeted read does NOT redirect file_path', !t2out.updatedInput, JSON.stringify(t2out.updatedInput));
assert('targeted read additionalContext mentions Edit', (t2out.additionalContext || '').includes('Edit'), t2out.additionalContext?.substring(0, 200));
assert('targeted read additionalContext warns against full rewrite', (t2out.additionalContext || '').includes('never rewrite'), t2out.additionalContext?.substring(0, 200));

// --- Step 3: Offset-only Read on large file — passthrough with context ---
console.log('\n=== Step 3: Offset-only Read on large file (passthrough + context) ===');
const offsetOnly = runHook('pre-read.sh', { tool_input: { file_path: TEST_FILE, offset: 40 } });
const o3out = offsetOnly.hookSpecificOutput || {};
assert('offset-only read permissionDecision = allow', o3out.permissionDecision === 'allow', o3out.permissionDecision);
assert('offset-only read does NOT redirect file_path', !o3out.updatedInput, JSON.stringify(o3out.updatedInput));

// --- Step 4: Repeat untargeted Read of large file — should serve outline again ---
console.log('\n=== Step 4: Repeat untargeted Read of large file ===');
const repeat = runHook('pre-read.sh', { tool_input: { file_path: TEST_FILE } });
const r4out = repeat.hookSpecificOutput || {};
assert('repeat untargeted read serves outline', r4out.permissionDecision === 'allow', r4out.permissionDecision);
assert('repeat untargeted read redirects to cache file', r4out.updatedInput && r4out.updatedInput.file_path && r4out.updatedInput.file_path.includes('.strata/'), r4out.updatedInput?.file_path);
assert('repeat untargeted read additionalContext mentions outline', (r4out.additionalContext || '').includes('outline'), r4out.additionalContext?.substring(0, 100));
assert('repeat untargeted read warns against full rewrite', (r4out.additionalContext || '').includes('never rewrite'), r4out.additionalContext?.substring(0, 300));

// --- Step 5: Mid-size file repeat read (Mode 2) ---
console.log('\n=== Step 5: Mid-size file repeat read (Mode 2) ===');
const MID_TEST_FILE = '/tmp/test-hook-midsize.ts';
const midLines = [];
for (let i = 1; i <= 200; i++) {
  if (i === 50) midLines.push('function processData(input) {');
  else if (i === 51) midLines.push('  return input.map(x => x * 2);');
  else if (i === 52) midLines.push('}');
  else midLines.push(`// mid-size line ${i}`);
}
fs.writeFileSync(MID_TEST_FILE, midLines.join('\n') + '\n');

// Clear any existing seen markers for this file
const midCacheDir = '/tmp/.strata';
if (fs.existsSync(midCacheDir)) {
  for (const f of fs.readdirSync(midCacheDir)) {
    if (f.endsWith('-seen')) fs.unlinkSync(path.join(midCacheDir, f));
  }
}

// 5a: First untargeted read → passthrough
console.log('  --- 5a: First read (passthrough) ---');
const mid1 = runHook('pre-read.sh', { tool_input: { file_path: MID_TEST_FILE } });
assert('first mid-size read passes through (empty JSON)', Object.keys(mid1).length === 0, JSON.stringify(mid1));

// 5b: Second untargeted read → outline served
console.log('  --- 5b: Second read (outline) ---');
const mid2 = runHook('pre-read.sh', { tool_input: { file_path: MID_TEST_FILE } });
const m2out = mid2.hookSpecificOutput || {};
assert('repeat read serves outline', m2out.permissionDecision === 'allow', m2out.permissionDecision);
assert('repeat read redirects to cache file', m2out.updatedInput && m2out.updatedInput.file_path && m2out.updatedInput.file_path.includes('.strata/'), m2out.updatedInput?.file_path);
assert('repeat read additionalContext mentions "Previously read"', (m2out.additionalContext || '').includes('Previously read in full'), m2out.additionalContext?.substring(0, 100));

// 5c: Targeted read of same file → still passthrough
console.log('  --- 5c: Targeted read (passthrough) ---');
const midTargeted = runHook('pre-read.sh', { tool_input: { file_path: MID_TEST_FILE, offset: 48, limit: 6 } });
assert('targeted read of mid-size file passes through', Object.keys(midTargeted).length === 0, JSON.stringify(midTargeted));

// --- Step 6: Verify hook log entries ---
console.log('\n=== Step 6: Hook log verification ===');
const hookLogPath = path.join('/tmp', '.strata', 'hook.log');
if (fs.existsSync(hookLogPath)) {
  const logLines = fs.readFileSync(hookLogPath, 'utf-8').trim().split('\n');
  const logEntries = logLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  assert('hook.log has entries', logEntries.length > 0, `found ${logEntries.length}`);

  const allHaveRequired = logEntries.every(e => e.ts && e.hook && e.decision && e.file);
  assert('all entries have ts, hook, decision, file', allHaveRequired,
    logEntries.find(e => !e.ts || !e.hook || !e.decision || !e.file) ? JSON.stringify(logEntries.find(e => !e.ts || !e.hook || !e.decision || !e.file)) : '');

  const preReadDecisions = new Set(logEntries.filter(e => e.hook === 'pre-read').map(e => e.decision));
  assert('log contains outline_always decision', preReadDecisions.has('outline_always'), [...preReadDecisions].join(', '));
  assert('log contains passthrough_targeted_ctx decision', preReadDecisions.has('passthrough_targeted_ctx'), [...preReadDecisions].join(', '));
  assert('log contains passthrough_targeted decision', preReadDecisions.has('passthrough_targeted'), [...preReadDecisions].join(', '));
  assert('log contains passthrough_first_read decision', preReadDecisions.has('passthrough_first_read'), [...preReadDecisions].join(', '));
  assert('log contains outline_repeat decision', preReadDecisions.has('outline_repeat'), [...preReadDecisions].join(', '));
} else {
  assert('hook.log exists', false, `not found at ${hookLogPath}`);
}

// --- Write report ---
const REPORT_DIR = path.join(__dirname, '..', 'reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const report = {
  timestamp: new Date().toISOString(),
  passed,
  failed,
  total: passed + failed,
  results,
};

const reportPath = path.join(REPORT_DIR, 'smoke-test-latest.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`Report:  ${reportPath}`);
if (failed > 0) process.exit(1);
