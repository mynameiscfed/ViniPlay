// Syntax check for every JavaScript file in the repo (server and browser code).
// Runs with Node's built-in test runner: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'test']);

function findJsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : findJsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

// Browser files under public/ are ES modules, so check them as .mjs.
function checkSyntax(file) {
    const isModule = /^\s*(import|export)\s/m.test(fs.readFileSync(file, 'utf8'));
    let target = file;
    if (isModule) {
        target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'viniplay-')), path.basename(file, '.js') + '.mjs');
        fs.copyFileSync(file, target);
    }
    return spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
}

for (const file of findJsFiles(ROOT)) {
    test(`syntax: ${path.relative(ROOT, file)}`, () => {
        const result = checkSyntax(file);
        assert.strictEqual(result.status, 0, result.stderr);
    });
}
