const fs = require("fs");
const path = require("path");

function serializeError(error) {
  if (!error) return null;
  return {
    message: error.message || String(error),
    code: error.code || null,
    stack: error.stack || null,
    debug: error.debug || null,
  };
}

function createSteamDebugLogger(rootDir) {
  const logPath = path.join(rootDir, "steam_public_inventory_debug.log");

  function write(event, data = {}) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...data,
    }) + "\n";

    fs.appendFileSync(logPath, line, "utf8");
  }

  function reset() {
    fs.writeFileSync(
      logPath,
      "",
      "utf8"
    );
  }

  return {
    path: logPath,
    write,
    reset,
    serializeError,
  };
}

module.exports = {
  createSteamDebugLogger,
  serializeError,
};