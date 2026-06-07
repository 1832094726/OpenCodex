const { findOfficialRuntimeLayout } = require("./official-layout.cjs");
const { createMacRunner } = require("./platform/macos.cjs");
const { createPortableRunner } = require("./platform/portable.cjs");

async function prepareOfficialElectronRuntime({ runtimeDir, officialBundleDir, logger }) {
  const layout = findOfficialRuntimeLayout({ officialBundleDir, logger });
  if (process.platform === "darwin") return createMacRunner({ layout, runtimeDir, logger });
  if (process.platform === "win32" || process.platform === "linux") {
    return createPortableRunner({ layout, runtimeDir, logger });
  }
  throw new Error(`当前 official Electron runner 不支持平台：${process.platform}`);
}

module.exports = {
  prepareOfficialElectronRuntime,
};
