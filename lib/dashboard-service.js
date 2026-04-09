const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { buildDashboard } = require("./dashboard-analytics-v2");

const DEFAULT_CONFIG = {
  scheduler: {
    enabled: true,
    intervalMinutes: 360,
    runOnStartup: true,
  },
  refresh: {
    headless: true,
    slowMo: 0,
    pricePage: 1,
    priceLimit: 50,
    includeSteam: true,
    steamLimit: 500,
    steamConcurrency: 2,
    includeTimeseries: false,
  },
  analysis: {
    strictness: 55,
  },
  paths: {
    cases: "cases.json",
    details: "case_details.json",
    pricempire: "pricempire_prices_eur.json",
    steam: "steam_market_data.json",
    csmoney: "csmoney_prices_eur.json",
    csfloat: "csfloat_prices_eur.json",
    timeseries: "case-timeseries.json",
    shotsDir: "shots",
    snapshotsDir: "out",
  },
};

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      output[key] = mergeDeep(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function clampInt(value, fallback, min, max) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function sanitizePath(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function sanitizeConfig(config) {
  const merged = mergeDeep(DEFAULT_CONFIG, config || {});
  return {
    scheduler: {
      enabled: !!merged.scheduler.enabled,
      intervalMinutes: clampInt(merged.scheduler.intervalMinutes, DEFAULT_CONFIG.scheduler.intervalMinutes, 15, 24 * 60),
      runOnStartup: !!merged.scheduler.runOnStartup,
    },
    refresh: {
      headless: !!merged.refresh.headless,
      slowMo: clampInt(merged.refresh.slowMo, DEFAULT_CONFIG.refresh.slowMo, 0, 500),
      pricePage: clampInt(merged.refresh.pricePage, DEFAULT_CONFIG.refresh.pricePage, 1, 10),
      priceLimit: clampInt(merged.refresh.priceLimit, DEFAULT_CONFIG.refresh.priceLimit, 5, 100),
      includeSteam: merged.refresh.includeSteam !== false,
      steamLimit: clampInt(merged.refresh.steamLimit, DEFAULT_CONFIG.refresh.steamLimit, 10, 1000),
      steamConcurrency: clampInt(merged.refresh.steamConcurrency, DEFAULT_CONFIG.refresh.steamConcurrency, 1, 12),
      includeTimeseries: !!merged.refresh.includeTimeseries,
    },
    analysis: {
      strictness: clampInt(merged.analysis.strictness, DEFAULT_CONFIG.analysis.strictness, 0, 100),
    },
    paths: {
      cases: sanitizePath(merged.paths.cases, DEFAULT_CONFIG.paths.cases),
      details: sanitizePath(merged.paths.details, DEFAULT_CONFIG.paths.details),
      pricempire: sanitizePath(merged.paths.pricempire, DEFAULT_CONFIG.paths.pricempire),
      steam: sanitizePath(merged.paths.steam, DEFAULT_CONFIG.paths.steam),
      csmoney: sanitizePath(merged.paths.csmoney, DEFAULT_CONFIG.paths.csmoney),
      csfloat: sanitizePath(merged.paths.csfloat, DEFAULT_CONFIG.paths.csfloat),
      timeseries: sanitizePath(merged.paths.timeseries, DEFAULT_CONFIG.paths.timeseries),
      shotsDir: sanitizePath(merged.paths.shotsDir, DEFAULT_CONFIG.paths.shotsDir),
      snapshotsDir: sanitizePath(merged.paths.snapshotsDir, DEFAULT_CONFIG.paths.snapshotsDir),
    },
  };
}

function timestampId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

class DashboardService {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.configPath = path.join(rootDir, "dashboard.config.json");
    this.config = sanitizeConfig(DEFAULT_CONFIG);
    this.dashboard = buildDashboard(rootDir, this.config);
    this.status = {
      state: "idle",
      source: null,
      currentStep: null,
      startedAt: null,
      finishedAt: null,
      nextRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      plannedSteps: [],
      logs: [],
    };
    this._scheduleTimer = null;
    this._runPromise = null;
  }

  async initialize(options = {}) {
    const autoStart = options.autoStart !== false;
    this.loadConfig();
    this.dashboard = buildDashboard(this.rootDir, this.config, { refresh: this.getStatus() });
    this.scheduleNextRun();
    if (autoStart && this.config.scheduler.runOnStartup) {
      setTimeout(() => {
        this.triggerRefresh("startup").catch(() => {});
      }, 1200);
    }
  }

  loadConfig() {
    if (fs.existsSync(this.configPath)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        this.config = sanitizeConfig(loaded);
      } catch {
        this.config = sanitizeConfig(DEFAULT_CONFIG);
      }
    } else {
      this.config = sanitizeConfig(DEFAULT_CONFIG);
      this.saveConfig();
    }
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
  }

  getConfig() {
    return this.config;
  }

  getStatus() {
    return {
      ...this.status,
      running: this.status.state === "running",
      plannedSteps: [...(this.status.plannedSteps || [])],
      logs: [...this.status.logs],
    };
  }

  getDashboard() {
    this.dashboard = buildDashboard(this.rootDir, this.config, { refresh: this.getStatus() });
    const snapshots = this.listSnapshots();
    return {
      config: this.getConfig(),
      status: this.getStatus(),
      dashboard: {
        ...this.dashboard,
        refresh: this.getStatus(),
      },
      snapshots,
    };
  }

  async updateConfig(patch) {
    this.config = sanitizeConfig(mergeDeep(this.config, patch || {}));
    this.saveConfig();
    this.dashboard = buildDashboard(this.rootDir, this.config, { refresh: this.getStatus() });
    this.scheduleNextRun();
    return this.getConfig();
  }

  async triggerRefresh(source = "manual") {
    if (this.status.state === "running") {
      const error = new Error("A refresh is already running.");
      error.code = "REFRESH_IN_PROGRESS";
      throw error;
    }

    this._runPromise = this.runRefresh(source);
    await Promise.resolve();
    return this.getStatus();
  }

  async runRefresh(source) {
    this.clearSchedule();
    this.status.state = "running";
    this.status.source = source;
    this.status.currentStep = null;
    this.status.startedAt = new Date().toISOString();
    this.status.finishedAt = null;
    this.status.lastError = null;
    this.status.plannedSteps = [];
    this.status.logs = [];
    this.appendLog(`Refresh started (${source}).`);

    const report = {
      source,
      steps: [],
      startedAt: this.status.startedAt,
      finishedAt: null,
      success: false,
    };

    try {
      const steps = this.createSteps();
      this.status.plannedSteps = steps.map((step) => step.label);
      for (const step of steps) {
        this.status.currentStep = step.label;
        const stepStart = new Date();
        this.appendLog(`Starting ${step.label}.`);
        try {
          await this.runProcess(step.command, step.args, step.label);
          this.validateStepOutput(step);
          const durationMs = Date.now() - stepStart.getTime();
          report.steps.push({ id: step.id, label: step.label, durationMs, success: true });
          this.appendLog(`Finished ${step.label} in ${(durationMs / 1000).toFixed(1)}s.`);
        } catch (error) {
          const durationMs = Date.now() - stepStart.getTime();
          const message = error && error.message ? error.message : String(error);
          report.steps.push({ id: step.id, label: step.label, durationMs, success: false, optional: !!step.optional, error: message });
          if (!step.optional) {
            throw error;
          }
          this.appendLog(`Optional step failed: ${step.label} (${message})`, "error");
        }
      }

      report.finishedAt = new Date().toISOString();
      report.success = true;
      const snapshotDir = this.copySnapshot(report);
      report.snapshotDir = snapshotDir;

      this.status.state = "success";
      this.status.lastSuccessAt = report.finishedAt;
      this.appendLog("Refresh completed successfully.");
      this.dashboard = buildDashboard(this.rootDir, this.config, { refresh: this.getStatus() });
    } catch (error) {
      report.finishedAt = new Date().toISOString();
      report.success = false;
      report.error = error && error.message ? error.message : String(error);
      this.status.state = "error";
      this.status.lastError = report.error;
      this.appendLog(`Refresh failed: ${report.error}`, "error");
      this.dashboard = buildDashboard(this.rootDir, this.config, { refresh: this.getStatus() });
    } finally {
      this.status.currentStep = null;
      this.status.finishedAt = report.finishedAt || new Date().toISOString();
      this._runPromise = null;
      this.scheduleNextRun();
    }
  }

  createSteps() {
    const paths = this.config.paths;
    const refresh = this.config.refresh;
    const node = process.execPath;
    const steps = [];

    const csstonksScript = path.join(this.rootDir, "scrape-csstonks.js");
    const detailsScript = path.join(this.rootDir, "scrape-case-details.js");
    const skinBaronScript = path.join(this.rootDir, "scrape-skinbaron-containers-eur.cjs");
    const steamScript = path.join(this.rootDir, "scrape-steam-market-data.cjs");

    if (fs.existsSync(csstonksScript)) {
      steps.push({
        id: "cases",
        label: "CSStonks universe",
        command: node,
        args: [csstonksScript, path.resolve(this.rootDir, paths.cases)],
      });
    } else {
      this.appendLog("Skipping CSStonks universe because `scrape-csstonks.js` is missing.", "error");
    }

    if (fs.existsSync(detailsScript)) {
      steps.push({
        id: "details",
        label: "Case details",
        command: node,
        args: [
          detailsScript,
          "--cases",
          path.resolve(this.rootDir, paths.cases),
          "--out",
          path.resolve(this.rootDir, paths.details),
          "--shots",
          path.resolve(this.rootDir, paths.shotsDir),
          ...(refresh.headless ? ["--headless"] : []),
        ],
      });
    } else {
      this.appendLog("Skipping case details because `scrape-case-details.js` is missing.", "error");
    }

    if (!fs.existsSync(skinBaronScript)) {
      throw new Error("`scrape-skinbaron-marketplaces-eur.cjs` is missing.");
    }

    steps.push({
      id: "skinbaron",
      label: "SkinBaron prices",
      optional: true,
      command: node,
      args: [
        skinBaronScript,
        "--out",
        path.resolve(this.rootDir, paths.pricempire),
        "--limit",
        String(refresh.priceLimit),
        "--headless",
        refresh.headless ? "1" : "0",
        "--slowmo",
        String(refresh.slowMo),
        "--max-pages",
        "12",
      ],
      outputPath: path.resolve(this.rootDir, paths.pricempire),
    });

    if (refresh.includeSteam && fs.existsSync(steamScript)) {
      steps.push({
        id: "steam",
        label: "Steam summaries",
        optional: true,
        command: node,
        args: [
          steamScript,
          "--out",
          path.resolve(this.rootDir, paths.steam),
          "--source",
          path.resolve(this.rootDir, paths.pricempire),
          "--cases",
          path.resolve(this.rootDir, paths.cases),
          "--limit",
          String(refresh.steamLimit),
          "--concurrency",
          String(refresh.steamConcurrency),
        ],
        outputPath: path.resolve(this.rootDir, paths.steam),
      });
    }

    if (refresh.includeTimeseries) {
      steps.push({
        id: "timeseries",
        label: "Case timeseries",
        optional: true,
        command: node,
        args: [path.join(this.rootDir, "scrape-case-timeseries.js")],
      });
    }

    return steps;
  }

  validateStepOutput(step) {
    if (!step?.outputPath) return;

    const payload = readJsonSafe(step.outputPath);
    if (!payload || typeof payload !== "object") {
      throw new Error(`${step.label} did not produce readable JSON output.`);
    }

    const map = payload.map && typeof payload.map === "object" ? payload.map : {};
    const scraped = Number.parseInt(payload?.meta?.scraped, 10);
    const itemCount = Object.keys(map).length;
    const errorCount = Array.isArray(payload.errors) ? payload.errors.length : Number.parseInt(payload?.meta?.errors, 10) || 0;

    if (itemCount > 0 || scraped > 0) return;

    const suffix = errorCount > 0 ? ` (${errorCount} item errors)` : "";
    throw new Error(`${step.label} returned no prices${suffix}.`);
  }

  runProcess(command, args, label) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.rootDir,
        env: process.env,
        windowsHide: true,
      });

      const forward = (stream, level) => {
        let buffer = "";
        stream.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const text = line.trim();
            if (text) this.appendLog(`[${label}] ${text}`, level);
          }
        });
        stream.on("end", () => {
          const text = buffer.trim();
          if (text) this.appendLog(`[${label}] ${text}`, level);
        });
      };

      forward(child.stdout, "info");
      forward(child.stderr, "error");

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${label} exited with code ${code}.`));
      });
    });
  }

  appendLog(message, level = "info") {
    this.status.logs.push({
      time: new Date().toISOString(),
      level,
      message,
    });

    if (this.status.logs.length > 250) {
      this.status.logs = this.status.logs.slice(-250);
    }
  }

  copySnapshot(report) {
    const outputRoot = path.resolve(this.rootDir, this.config.paths.snapshotsDir);
    fs.mkdirSync(outputRoot, { recursive: true });

    const snapshotDir = path.join(outputRoot, timestampId());
    fs.mkdirSync(snapshotDir, { recursive: true });

    const files = [
      this.config.paths.cases,
      this.config.paths.details,
      this.config.paths.pricempire,
      this.config.paths.steam,
    ];

    if (this.config.refresh.includeTimeseries) {
      files.push(this.config.paths.timeseries);
    }

    for (const relativePath of files) {
      const sourcePath = path.resolve(this.rootDir, relativePath);
      if (!fs.existsSync(sourcePath)) continue;
      const destinationPath = path.join(snapshotDir, path.basename(relativePath));
      fs.copyFileSync(sourcePath, destinationPath);
    }

    fs.writeFileSync(path.join(snapshotDir, "refresh-report.json"), JSON.stringify(report, null, 2), "utf8");
    return path.relative(this.rootDir, snapshotDir).replace(/\\/g, "/");
  }

  listSnapshots() {
    const snapshotsRoot = path.resolve(this.rootDir, this.config.paths.snapshotsDir);
    if (!fs.existsSync(snapshotsRoot)) return [];

    return fs.readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const absolutePath = path.join(snapshotsRoot, entry.name);
        const stat = fs.statSync(absolutePath);
        const files = fs.readdirSync(absolutePath);
        return {
          name: entry.name,
          path: path.relative(this.rootDir, absolutePath).replace(/\\/g, "/"),
          updatedAt: stat.mtime.toISOString(),
          files,
        };
      })
      .sort((left, right) => right.name.localeCompare(left.name))
      .slice(0, 12);
  }

  clearSchedule() {
    if (this._scheduleTimer) {
      clearTimeout(this._scheduleTimer);
      this._scheduleTimer = null;
    }
    this.status.nextRunAt = null;
  }

  scheduleNextRun() {
    this.clearSchedule();
    if (!this.config.scheduler.enabled) return;
    const delayMs = this.config.scheduler.intervalMinutes * 60 * 1000;
    this.status.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this._scheduleTimer = setTimeout(() => {
      this.triggerRefresh("schedule").catch(() => {});
    }, delayMs);
    if (typeof this._scheduleTimer.unref === "function") {
      this._scheduleTimer.unref();
    }
  }
}

module.exports = {
  DashboardService,
  DEFAULT_CONFIG,
};
