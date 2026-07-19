const fs = require("fs");
const path = require("path");

const helperPaths = [
  path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
  path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper")
];

for (const helperPath of helperPaths) {
  try {
    if (!fs.existsSync(helperPath)) {
      continue;
    }

    // Why: node-pty fails with posix_spawnp on macOS if the helper loses its execute bit during install.
    fs.chmodSync(helperPath, 0o755);
    console.log(`Fixed execute permission for ${path.basename(path.dirname(helperPath))}/spawn-helper`);
  } catch (error) {
    console.warn(`Unable to fix node-pty helper permissions at ${helperPath}: ${error.message}`);
  }
}
