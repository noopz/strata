#!/usr/bin/env node
/**
 * End-to-end smoke test: Read(Mode 1) → targeted read passthrough → Edit with hashlines.
 * Simulates the Claude Code hook pipeline.
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
assert('Mode 1 additionalContext mentions hashline-tagged', (m1out.additionalContext || '').includes('hashline-tagged'), m1out.additionalContext?.substring(0, 200));
assert('Mode 1 additionalContext mentions structural_edit', (m1out.additionalContext || '').includes('structural_edit'), m1out.additionalContext?.substring(0, 200));

// Check that cached outline file contains hashline-tagged lines
const cacheFilePath = m1out.updatedInput && m1out.updatedInput.file_path;
if (cacheFilePath && fs.existsSync(cacheFilePath)) {
  const cacheContent = fs.readFileSync(cacheFilePath, 'utf-8');
  assert('cached outline contains hashline tags', /\d+#[A-Z]{3}:/.test(cacheContent), cacheContent.substring(0, 200));
} else {
  assert('cached outline file exists for tag check', false, cacheFilePath || 'no path');
}

// --- Step 2: Targeted Read on large file — passthrough with context ---
console.log('\n=== Step 2: Targeted Read on large file (passthrough + context) ===');
const targeted = runHook('pre-read.sh', { tool_input: { file_path: TEST_FILE, offset: 40, limit: 8 } });
const t2out = targeted.hookSpecificOutput || {};
assert('targeted read permissionDecision = allow', t2out.permissionDecision === 'allow', t2out.permissionDecision);
assert('targeted read does NOT redirect file_path', !t2out.updatedInput, JSON.stringify(t2out.updatedInput));
assert('targeted read additionalContext mentions hashline tags', (t2out.additionalContext || '').includes('hashline-tag'), t2out.additionalContext?.substring(0, 200));
assert('targeted read additionalContext mentions structural_edit', (t2out.additionalContext || '').includes('structural_edit'), t2out.additionalContext?.substring(0, 200));

// --- Step 3: Edit with hashline tags ---
console.log('\n=== Step 3: Edit with hashline-tagged old_string ===');
const editInput = {
  tool_input: {
    file_path: TEST_FILE,
    old_string: '42#WTV:function handleAuth(req) {\n43#WXR:  const token = req.headers.auth;',
    new_string: 'function handleAuth(req, res) {\n  const token = req.headers.authorization;',
  },
};
const edit = runHook('pre-edit.sh', editInput);
const eout = edit.hookSpecificOutput || {};
assert('permissionDecision = allow', eout.permissionDecision === 'allow', eout.permissionDecision);
assert('updatedInput exists', !!eout.updatedInput, '');
if (eout.updatedInput) {
  assert('old_string has NO hashline tags',
    !/\d+#[A-Z]{3}:/.test(eout.updatedInput.old_string),
    eout.updatedInput.old_string);
  assert('old_string matches raw file content',
    eout.updatedInput.old_string === 'function handleAuth(req) {\n  const token = req.headers.auth;',
    JSON.stringify(eout.updatedInput.old_string));
  assert('new_string is clean',
    eout.updatedInput.new_string === 'function handleAuth(req, res) {\n  const token = req.headers.authorization;',
    JSON.stringify(eout.updatedInput.new_string));
}
assert('additionalContext says "Hashline edit resolved"',
  (eout.additionalContext || '').includes('Hashline edit resolved'),
  eout.additionalContext);

// --- Step 4: Edit WITHOUT hashlines (nudge toward structural_edit) ---
console.log('\n=== Step 4: Edit without hashlines (outline nudge) ===');
const plainEdit = runHook('pre-edit.sh', {
  tool_input: {
    file_path: TEST_FILE,
    old_string: 'function handleAuth(req) {',
    new_string: 'function handleAuth(req, res) {',
  },
});
const p4out = plainEdit.hookSpecificOutput || {};
assert('nudge permissionDecision = allow', p4out.permissionDecision === 'allow', p4out.permissionDecision);
assert('nudge additionalContext mentions structural outline', (p4out.additionalContext || '').includes('structural outline'), p4out.additionalContext?.substring(0, 200));
assert('nudge additionalContext mentions structural_edit', (p4out.additionalContext || '').includes('structural_edit'), p4out.additionalContext?.substring(0, 200));
assert('nudge does NOT redirect updatedInput', !p4out.updatedInput, JSON.stringify(p4out.updatedInput));

// --- Step 5: Offset-only Read on large file — passthrough with context ---
console.log('\n=== Step 5: Offset-only Read on large file (passthrough + context) ===');
const offsetOnly = runHook('pre-read.sh', { tool_input: { file_path: TEST_FILE, offset: 40 } });
const o5out = offsetOnly.hookSpecificOutput || {};
assert('offset-only read permissionDecision = allow', o5out.permissionDecision === 'allow', o5out.permissionDecision);
assert('offset-only read does NOT redirect file_path', !o5out.updatedInput, JSON.stringify(o5out.updatedInput));

// --- Step 6: Mid-size file repeat read (Mode 2) ---
console.log('\n=== Step 6: Mid-size file repeat read (Mode 2) ===');
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

// 6a: First untargeted read → passthrough
console.log('  --- 6a: First read (passthrough) ---');
const mid1 = runHook('pre-read.sh', { tool_input: { file_path: MID_TEST_FILE } });
assert('first mid-size read passes through (empty JSON)', Object.keys(mid1).length === 0, JSON.stringify(mid1));

// 6b: Second untargeted read → outline served
console.log('  --- 6b: Second read (outline) ---');
const mid2 = runHook('pre-read.sh', { tool_input: { file_path: MID_TEST_FILE } });
const m2out = mid2.hookSpecificOutput || {};
assert('repeat read serves outline', m2out.permissionDecision === 'allow', m2out.permissionDecision);
assert('repeat read redirects to cache file', m2out.updatedInput && m2out.updatedInput.file_path && m2out.updatedInput.file_path.includes('.strata/'), m2out.updatedInput?.file_path);
assert('repeat read additionalContext mentions "Previously read"', (m2out.additionalContext || '').includes('Previously read in full'), m2out.additionalContext?.substring(0, 100));

// 6c: Targeted read of same file → still passthrough
console.log('  --- 6c: Targeted read (passthrough) ---');
const midTargeted = runHook('pre-read.sh', { tool_input: { file_path: MID_TEST_FILE, offset: 48, limit: 6 } });
assert('targeted read of mid-size file passes through', Object.keys(midTargeted).length === 0, JSON.stringify(midTargeted));

// --- Step 7: Verify hook log entries ---
console.log('\n=== Step 7: Hook log verification ===');
const hookLogPath = path.join('/tmp', '.strata', 'hook.log');
if (fs.existsSync(hookLogPath)) {
  const logLines = fs.readFileSync(hookLogPath, 'utf-8').trim().split('\n');
  const logEntries = logLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  assert('hook.log has entries', logEntries.length > 0, `found ${logEntries.length}`);

  // Check required fields on all entries
  const allHaveRequired = logEntries.every(e => e.ts && e.hook && e.decision && e.file);
  assert('all entries have ts, hook, decision, file', allHaveRequired,
    logEntries.find(e => !e.ts || !e.hook || !e.decision || !e.file) ? JSON.stringify(logEntries.find(e => !e.ts || !e.hook || !e.decision || !e.file)) : '');

  // Check for specific pre-read decisions we expect from the test sequence
  const preReadDecisions = new Set(logEntries.filter(e => e.hook === 'pre-read').map(e => e.decision));
  assert('log contains outline_always decision', preReadDecisions.has('outline_always'), [...preReadDecisions].join(', '));
  assert('log contains passthrough_targeted_ctx decision', preReadDecisions.has('passthrough_targeted_ctx'), [...preReadDecisions].join(', '));
  assert('log contains passthrough_targeted decision', preReadDecisions.has('passthrough_targeted'), [...preReadDecisions].join(', '));
  assert('log contains passthrough_first_read decision', preReadDecisions.has('passthrough_first_read'), [...preReadDecisions].join(', '));
  assert('log contains outline_repeat decision', preReadDecisions.has('outline_repeat'), [...preReadDecisions].join(', '));

  // Check for pre-edit decisions
  const preEditDecisions = new Set(logEntries.filter(e => e.hook === 'pre-edit').map(e => e.decision));
  assert('log contains hashline_resolved decision', preEditDecisions.has('hashline_resolved'), [...preEditDecisions].join(', '));
  assert('log contains passthrough_no_hashlines decision', preEditDecisions.has('passthrough_no_hashlines'), [...preEditDecisions].join(', '));
  assert('log contains passthrough_outline_nudge decision', preEditDecisions.has('passthrough_outline_nudge'), [...preEditDecisions].join(', '));
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
