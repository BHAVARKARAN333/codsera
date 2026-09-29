/**
 * Regression Test Suite: Workspace Indexing Coverage & Filtering
 * 
 * Verifies:
 * 1. Deep directory traversal (maxDepth = 8) discovers nested folders (e.g. services/agent, services/ai, services/tools).
 * 2. `scratch` directory is excluded from indexing.
 * 3. `.tsbuildinfo` cache files are excluded from indexing.
 * 4. Production source files, config files, and project manifests remain indexed.
 * 5. File counts reconcile 100% with the physical disk inventory.
 * 6. File watcher / save events respect directory and extension exclusion filters.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';

// Mirroring the production constants and functions from src/main/index.ts and smartContextEngine.ts
const IGNORED_FOLDERS = new Set(['.git', 'node_modules', 'dist', 'out', '.vscode', '.idea']);
const WATCHER_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vscode',
  '.idea',
  '.cache',
  'coverage',
  '.parcel-cache',
  'scratch'
]);

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vscode',
  '.idea',
  '.cache',
  'coverage',
  '.parcel-cache',
  'scratch'
]);

const BINARY_AND_ASSET_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'mp4', 'mp3', 'pdf',
  'zip', 'tar', 'gz', 'exe', 'dll', 'dylib', 'so', 'bin', 'woff', 'woff2',
  'ttf', 'eot', 'map', 'wasm', 'tsbuildinfo'
]);

// Production readDirectoryTree from src/main/index.ts (with maxDepth = 8)
async function readDirectoryTree(dirPath, maxDepth = 8, currentDepth = 0) {
  if (currentDepth > maxDepth) {
    return [];
  }

  try {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
      if (IGNORED_FOLDERS.has(dirent.name)) {
        continue;
      }

      const fullPath = path.join(dirPath, dirent.name);

      if (dirent.isDirectory()) {
        const children = await readDirectoryTree(fullPath, maxDepth, currentDepth + 1);
        entries.push({
          name: dirent.name,
          path: fullPath,
          isDirectory: true,
          children
        });
      } else if (dirent.isFile()) {
        let size;
        let mtimeMs;
        try {
          const stat = await fs.promises.stat(fullPath);
          size = stat.size;
          mtimeMs = stat.mtimeMs;
        } catch {}
        entries.push({
          name: dirent.name,
          path: fullPath,
          isDirectory: false,
          size,
          mtimeMs
        });
      }
    }

    return entries.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
      return a.isDirectory ? -1 : 1;
    });
  } catch (error) {
    return [];
  }
}

// Production extractFileMetadataMap from smartContextEngine.ts (with maxDepth = 8)
function toRelativeWorkspacePath(fullPath, workspaceRoot) {
  const normEntry = fullPath.replace(/\\/g, '/');
  const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const rootPrefix = normRoot + '/';

  if (normEntry.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    return normEntry.slice(rootPrefix.length).replace(/^\/+/, '');
  }
  return normEntry.replace(/^\/+/, '');
}

function extractFileMetadataMap(
  entries,
  rootPath,
  maxDepth = 8,
  currentDepth = 0,
  accumulator = new Map()
) {
  if (currentDepth > maxDepth || !entries) return accumulator;

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const relPath = toRelativeWorkspacePath(entry.path, rootPath);
    if (!relPath) {
      if (entry.isDirectory && entry.children && entry.children.length > 0) {
        extractFileMetadataMap(entry.children, rootPath, maxDepth, currentDepth + 1, accumulator);
      }
      continue;
    }

    if (entry.isDirectory) {
      if (entry.children && entry.children.length > 0) {
        extractFileMetadataMap(entry.children, rootPath, maxDepth, currentDepth + 1, accumulator);
      }
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() || '';
      if (!BINARY_AND_ASSET_EXTS.has(ext)) {
        accumulator.set(relPath, { size: entry.size, mtimeMs: entry.mtimeMs });
      }
    }
  }

  return accumulator;
}

// Filtering check for event handling (mirroring handleFileEvent in smartContextEngine.ts)
function shouldProcessFileEvent(relativePath) {
  const cleanRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleanRel.startsWith('..') || cleanRel.includes('/../')) return false;

  const pathParts = cleanRel.split('/');
  if (pathParts.some((part) => IGNORED_DIRS.has(part))) return false;

  const ext = cleanRel.split('.').pop()?.toLowerCase() || '';
  if (BINARY_AND_ASSET_EXTS.has(ext)) return false;

  return true;
}

async function runTests() {
  console.log('===========================================================');
  console.log('TEST SUITE: WORKSPACE INDEXING COVERAGE & FILTERS');
  console.log('===========================================================\n');

  const workspaceRoot = process.cwd();

  // Test 1: Directory traversal with maxDepth = 8 discovers deeply nested source files
  console.log('[Test 1] Directory traversal depth discovers services/agent, services/ai, services/tools');
  const tree = await readDirectoryTree(workspaceRoot, 8);
  assert.ok(Array.isArray(tree) && tree.length > 0, 'readDirectoryTree returned non-empty tree');

  // Helper to find entry in tree by relative path
  function findInTree(nodes, targetRel, currentRel = '') {
    for (const node of nodes) {
      const nodeRel = currentRel ? `${currentRel}/${node.name}` : node.name;
      if (nodeRel.toLowerCase() === targetRel.toLowerCase()) return node;
      if (node.isDirectory && node.children) {
        const found = findInTree(node.children, targetRel, nodeRel);
        if (found) return found;
      }
    }
    return null;
  }

  const agentFile = findInTree(tree, 'src/renderer/src/services/agent/smartContextEngine.ts');
  const aiFile = findInTree(tree, 'src/renderer/src/services/ai/geminiProvider.ts');
  const toolFile = findInTree(tree, 'src/renderer/src/services/tools/readFileTool.ts');

  assert.ok(agentFile, 'src/renderer/src/services/agent/smartContextEngine.ts must be found in tree');
  assert.ok(aiFile, 'src/renderer/src/services/ai/geminiProvider.ts must be found in tree');
  assert.ok(toolFile, 'src/renderer/src/services/tools/readFileTool.ts must be found in tree');
  console.log('✓ PASS: Nested source files in services/agent, services/ai, services/tools are present in tree.');

  // Test 2: Indexing filter excludes scratch and .tsbuildinfo while retaining nested source files
  console.log('\n[Test 2] extractFileMetadataMap includes nested sources and excludes scratch & .tsbuildinfo');
  const metadataMap = extractFileMetadataMap(tree, workspaceRoot, 8);
  const indexedPaths = Array.from(metadataMap.keys()).sort();

  // 2a. Verify all 23 previously skipped nested service files are present
  const expectedServices = [
    'src/renderer/src/services/agent/agentPlanner.ts',
    'src/renderer/src/services/agent/codebaseIndex.ts',
    'src/renderer/src/services/agent/contextBudgetManager.ts',
    'src/renderer/src/services/agent/contextCache.ts',
    'src/renderer/src/services/agent/contextDeduplicator.ts',
    'src/renderer/src/services/agent/dependencyAnalyzer.ts',
    'src/renderer/src/services/agent/indexingProfiler.ts',
    'src/renderer/src/services/agent/orchestrator.ts',
    'src/renderer/src/services/agent/smartContextEngine.ts',
    'src/renderer/src/services/ai/geminiProvider.ts',
    'src/renderer/src/services/ai/nvidiaProvider.ts',
    'src/renderer/src/services/ai/openRouterProvider.ts',
    'src/renderer/src/services/ai/opencodeProvider.ts',
    'src/renderer/src/services/ai/types.ts',
    'src/renderer/src/services/tools/createFileTool.ts',
    'src/renderer/src/services/tools/editFileTool.ts',
    'src/renderer/src/services/tools/gitDiffTool.ts',
    'src/renderer/src/services/tools/gitLogTool.ts',
    'src/renderer/src/services/tools/gitStatusTool.ts',
    'src/renderer/src/services/tools/listFilesTool.ts',
    'src/renderer/src/services/tools/readFileTool.ts',
    'src/renderer/src/services/tools/runCommandTool.ts',
    'src/renderer/src/services/tools/types.ts'
  ];

  for (const servicePath of expectedServices) {
    assert.ok(
      indexedPaths.includes(servicePath),
      `Expected ${servicePath} to be included in indexed paths`
    );
  }
  console.log(`✓ PASS: All ${expectedServices.length} nested service files are included in the index.`);

  // 2b. Verify scratch files are excluded
  const indexedScratch = indexedPaths.filter((p) => p.startsWith('scratch/') || p === 'scratch');
  assert.strictEqual(
    indexedScratch.length,
    0,
    `scratch folder must be excluded from index, but found: ${indexedScratch.join(', ')}`
  );
  console.log('✓ PASS: scratch/ folder is completely excluded from index (0 scratch files indexed).');

  // 2c. Verify .tsbuildinfo files are excluded
  const indexedTsBuildInfo = indexedPaths.filter((p) => p.endsWith('.tsbuildinfo'));
  assert.strictEqual(
    indexedTsBuildInfo.length,
    0,
    `.tsbuildinfo files must be excluded, but found: ${indexedTsBuildInfo.join(', ')}`
  );
  console.log('✓ PASS: .tsbuildinfo cache files are excluded from index (0 tsbuildinfo files indexed).');

  // 2d. Verify configurations and manifests remain indexed
  const expectedConfigs = [
    'electron.vite.config.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    '.gitignore'
  ];
  for (const cfg of expectedConfigs) {
    assert.ok(indexedPaths.includes(cfg), `Expected config file ${cfg} to be indexed`);
  }
  console.log('✓ PASS: Configuration files and manifests (.gitignore, package.json, tsconfig) are indexed.');

  // Test 3: Verified file count reconciliation
  console.log('\n[Test 3] Exact file count reconciliation across categories');
  
  // Categorize indexed files
  const categories = {
    productionSrc: indexedPaths.filter((p) => p.startsWith('src/')),
    rootConfigs: indexedPaths.filter((p) => [
      'electron.vite.config.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.node.json',
      'tsconfig.web.json'
    ].includes(p)),
    gitIgnore: indexedPaths.filter((p) => p === '.gitignore'),
    scratch: indexedPaths.filter((p) => p.startsWith('scratch/')),
    tsbuildinfo: indexedPaths.filter((p) => p.endsWith('.tsbuildinfo')),
    other: indexedPaths.filter((p) => 
      !p.startsWith('src/') && 
      !['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', '.gitignore'].includes(p)
    )
  };

  console.log('  Category Breakdown of Indexed Files:');
  console.log(`    - Production source (src/):       ${categories.productionSrc.length}`);
  console.log(`    - Root configs & manifests:       ${categories.rootConfigs.length}`);
  console.log(`    - Root .gitignore:                ${categories.gitIgnore.length}`);
  console.log(`    - Scratch folder scripts:         ${categories.scratch.length}`);
  console.log(`    - Build cache (.tsbuildinfo):     ${categories.tsbuildinfo.length}`);
  console.log(`    - Other / unexpected:             ${categories.other.length}`);
  console.log(`    - Total Indexed Files:            ${indexedPaths.length}`);

  assert.strictEqual(categories.productionSrc.length, 39, 'Must have exactly 39 production source files in src/');
  assert.strictEqual(categories.rootConfigs.length, 6, 'Must have exactly 6 root config files');
  assert.strictEqual(categories.gitIgnore.length, 1, 'Must have exactly 1 .gitignore file');
  assert.strictEqual(categories.scratch.length, 0, 'Must have 0 scratch files indexed');
  assert.strictEqual(categories.tsbuildinfo.length, 0, 'Must have 0 .tsbuildinfo files indexed');
  assert.strictEqual(categories.other.length, 0, 'Must have 0 other/unexpected files');
  assert.strictEqual(indexedPaths.length, 46, 'Total indexed files must equal 46 (39 + 6 + 1)');

  // Verify non-vendor disk inventory reconciliation
  function scanDisk(dir) {
    let files = [];
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_FOLDERS.has(f.name)) continue;
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        files = files.concat(scanDisk(full));
      } else {
        files.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
      }
    }
    return files;
  }
  const allNonVendorOnDisk = scanDisk(workspaceRoot);
  const diskScratch = allNonVendorOnDisk.filter((p) => p.startsWith('scratch/'));
  const diskTsBuildInfo = allNonVendorOnDisk.filter((p) => p.endsWith('.tsbuildinfo'));

  console.log('\n  Reconciliation with Physical Disk:');
  console.log(`    - Total non-vendor files on disk:  ${allNonVendorOnDisk.length}`);
  console.log(`    - Excluded scratch files:          ${diskScratch.length}`);
  console.log(`    - Excluded .tsbuildinfo files:     ${diskTsBuildInfo.length}`);
  console.log(`    - Reconciled Total (46 + 15 + 2):  ${indexedPaths.length + diskScratch.length + diskTsBuildInfo.length}`);

  assert.strictEqual(diskTsBuildInfo.length, 2, 'Physical .tsbuildinfo files count must be 2');
  assert.ok(diskScratch.length >= 15, 'Physical scratch files count must be at least 15');
  assert.strictEqual(
    indexedPaths.length + diskScratch.length + diskTsBuildInfo.length,
    allNonVendorOnDisk.length,
    `Indexed (${indexedPaths.length}) + Excluded (${diskScratch.length} scratch + ${diskTsBuildInfo.length} tsbuildinfo) must equal total non-vendor files on disk (${allNonVendorOnDisk.length})`
  );
  console.log(`✓ PASS: Indexed files (${indexedPaths.length}) + excluded files (${diskScratch.length + diskTsBuildInfo.length}) perfectly reconcile to ${allNonVendorOnDisk.length} total non-vendor files.`);

  // Test 4: File event and save filtering
  console.log('\n[Test 4] File watcher and editor save event filter verification');
  assert.strictEqual(shouldProcessFileEvent('scratch/new_test.mjs'), false, 'scratch file event must be dropped');
  assert.strictEqual(shouldProcessFileEvent('tsconfig.node.tsbuildinfo'), false, '.tsbuildinfo event must be dropped');
  assert.strictEqual(shouldProcessFileEvent('sub/folder/cache.tsbuildinfo'), false, 'nested .tsbuildinfo event must be dropped');
  assert.strictEqual(shouldProcessFileEvent('src/renderer/src/services/agent/newAgent.ts'), true, 'nested source event must be allowed');
  assert.strictEqual(shouldProcessFileEvent('package.json'), true, 'package.json event must be allowed');
  assert.strictEqual(shouldProcessFileEvent('../outside.ts'), false, 'path traversal must be rejected');
  console.log('✓ PASS: Event filtering correctly filters scratch, tsbuildinfo, and traversals while allowing nested sources.');

  console.log('\n===========================================================');
  console.log('ALL COVERAGE & FILTER REGRESSION TESTS PASSED! ✓');
  console.log('===========================================================');
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});
