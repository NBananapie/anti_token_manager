#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PLUGIN_NAME = 'antigravity-token-manager';
const GEMINI_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');
const PLUGINS_DIR = path.join(GEMINI_CONFIG_DIR, 'plugins');
const TARGET_PLUGIN_DIR = path.join(PLUGINS_DIR, PLUGIN_NAME);
const LEGACY_SKILL_DIR = path.join(GEMINI_CONFIG_DIR, 'skills', PLUGIN_NAME);

const COPY_ITEMS = [
  'plugin.json',
  'README.md',
  'LICENSE',
  'package.json',
  'mcp_config.json',
  'hooks.json',
  'assets',
  'core',
  'mcp',
  'hooks',
  'rules',
  'sidecars',
  'skills',
  'scripts',
  'web/server.js',
  'web/package.json',
  'web/dist'
];

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  let mode = 'copy';
  if (args.has('--link')) mode = 'link';
  if (args.has('--copy')) mode = 'copy';
  if (args.has('--uninstall')) mode = 'uninstall';
  const migrateSkill = args.has('--migrate-skill');
  const help = args.has('--help') || args.has('-h');
  return { mode, migrateSkill, help };
}

function isSymlinkOrJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removePluginTarget(targetPath) {
  if (!fs.existsSync(targetPath) && !isSymlinkOrJunction(targetPath)) {
    return false;
  }
  if (isSymlinkOrJunction(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      console.error(`[错误] 插件目录正在被 Antigravity 运行中的 Sidecar/MCP 进程占用: ${targetPath}`);
      console.error('       请先在 Antigravity 自定义插件页暂时关闭该插件后再执行卸载。');
      process.exit(1);
    }
    throw err;
  }
}

function pruneStaleAssets(srcAssetsDir, destAssetsDir) {
  if (!fs.existsSync(srcAssetsDir) || !fs.existsSync(destAssetsDir)) return;
  const keep = new Set(fs.readdirSync(srcAssetsDir));
  for (const name of fs.readdirSync(destAssetsDir)) {
    if (!keep.has(name)) {
      try {
        fs.rmSync(path.join(destAssetsDir, name), { force: true });
      } catch {}
    }
  }
}

function copyFiltered(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === '.DS_Store' || entry.name.endsWith('.pyc')) {
        continue;
      }
      copyFiltered(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function handleLegacySkill(migrateSkill) {
  const exists = fs.existsSync(LEGACY_SKILL_DIR) || isSymlinkOrJunction(LEGACY_SKILL_DIR);
  if (!exists) return;

  if (!migrateSkill) {
    console.log(`[提示] 检测到旧的独立 Skill 目录: ${LEGACY_SKILL_DIR}`);
    console.log('       为避免与原生插件内置同名 Skill 冲突，可加 --migrate-skill 参数自动备份并迁移。');
    return;
  }

  if (isSymlinkOrJunction(LEGACY_SKILL_DIR)) {
    fs.unlinkSync(LEGACY_SKILL_DIR);
    console.log(`[迁移] 已移除旧独立 Skill 符号链接: ${LEGACY_SKILL_DIR}`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupRoot = path.join(GEMINI_CONFIG_DIR, 'skills-backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupDest = path.join(backupRoot, `${PLUGIN_NAME}-${stamp}`);
  fs.renameSync(LEGACY_SKILL_DIR, backupDest);
  console.log(`[迁移] 已将旧独立 Skill 备份至: ${backupDest}`);
}

function main() {
  const { mode, migrateSkill, help } = parseArgs(process.argv);

  if (help) {
    console.log(`用法: node scripts/install_plugin.mjs [选项]

选项:
  --copy            默认模式：复制精简运行时产物到 ~/.gemini/config/plugins/${PLUGIN_NAME}（不含 node_modules / .git，兼容 Windows / macOS / Linux）
  --link            符号链接模式（注意：Windows 下 Antigravity 扫描插件目录会跳过 Junction，仅建议在非 Windows 平台调试使用）
  --uninstall       卸载插件（仅删除插件目录或联接，不影响源码仓库）
  --migrate-skill   自动备份并移出旧的独立 ~/.gemini/config/skills/${PLUGIN_NAME} 避免同名冲突
`);
    process.exit(0);
  }

  if (mode === 'uninstall') {
    const removed = removePluginTarget(TARGET_PLUGIN_DIR);
    console.log(removed
      ? `[完成] 已卸载插件: ${TARGET_PLUGIN_DIR}`
      : `[跳过] 未检测到已安装的插件: ${TARGET_PLUGIN_DIR}`);
    return;
  }

  const distIndex = path.join(REPO_ROOT, 'web', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.error('[错误] 未找到 web/dist/index.html，请先运行: npm run build');
    process.exit(1);
  }

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  if (mode === 'link') {
    removePluginTarget(TARGET_PLUGIN_DIR);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(REPO_ROOT, TARGET_PLUGIN_DIR, linkType);
    console.log(`[完成] 已以 ${linkType} 模式挂载原生插件:`);
    console.log(`       ${TARGET_PLUGIN_DIR} -> ${REPO_ROOT}`);
  } else {
    if (isSymlinkOrJunction(TARGET_PLUGIN_DIR)) {
      fs.unlinkSync(TARGET_PLUGIN_DIR);
    }
    fs.mkdirSync(TARGET_PLUGIN_DIR, { recursive: true });
    for (const rel of COPY_ITEMS) {
      const src = path.join(REPO_ROOT, rel);
      const dest = path.join(TARGET_PLUGIN_DIR, rel);
      if (!fs.existsSync(src)) {
        console.warn(`[警告] 跳过缺失路径: ${rel}`);
        continue;
      }
      copyFiltered(src, dest);
    }
    pruneStaleAssets(
      path.join(REPO_ROOT, 'web', 'dist', 'assets'),
      path.join(TARGET_PLUGIN_DIR, 'web', 'dist', 'assets')
    );
    console.log(`[完成] 已同步精简插件产物至: ${TARGET_PLUGIN_DIR}`);
  }

  handleLegacySkill(migrateSkill);
  console.log('[说明] 插件已由 Antigravity 自动发现，可在自定义插件页启用或打开右侧辅助面板。');
}

main();
