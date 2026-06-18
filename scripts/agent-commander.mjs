#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const repoRoot = path.resolve(scriptDir, "..");
const templatePath = path.join(repoRoot, "templates", "assistant-task.md");
const statusValues = new Set(["done", "needs_followup", "blocked", "failed"]);

main();

function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  const opts = parseArgs(argv);
  try {
    if (command === "help" || opts.help) return printHelp();
    if (command === "doctor") return doctor(opts);
    if (command === "run-hidden") return openVisible({ ...opts, windowMode: "hidden" });
    if (command === "open-visible") return openVisible(opts);
    if (command === "continue-visible") return continueVisible(opts);
    if (command === "check") return checkRun(opts);
    if (command === "close-visible") return closeVisible(opts);
    if (command === "self-test") return selfTest(opts);
    fail(`Unknown command: ${command}`);
  } catch (error) {
    fail(error.message);
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      opts._.push(token);
      continue;
    }
    const key = camel(token.slice(2));
    if (key === "help") {
      opts[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${token}`);
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function getProject(opts) {
  const projectRoot = path.resolve(opts.projectRoot || process.cwd());
  const stateRoot = path.join(projectRoot, ".agent-commander");
  return {
    projectRoot,
    stateRoot,
    runsDir: path.join(stateRoot, "runs"),
    taskDir: path.join(stateRoot, "tasks"),
    reportDir: path.join(stateRoot, "reports")
  };
}

function findClaude() {
  const candidates = process.platform === "win32" ? ["claude.cmd", "claude"] : ["claude"];
  for (const candidate of candidates) {
    const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [candidate], { encoding: "utf8" });
    if (result.status === 0) {
      const found = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      return { command: candidate, path: found };
    }
  }
  return null;
}

function doctor(opts) {
  const project = getProject(opts);
  const claude = findClaude();
  const version = claude ? spawnCmd(claude.path || claude.command, ["--version"], { cwd: project.projectRoot }) : null;
  printJson({
    platform: process.platform,
    projectRoot: project.projectRoot,
    stateRoot: project.stateRoot,
    claude,
    claudeVersion: version?.status === 0 ? version.stdout.trim() : null,
    ready: Boolean(claude && fs.existsSync(project.projectRoot))
  });
}

function openVisible(opts) {
  requireWindows();
  const project = getProject(opts);
  const claude = findClaude();
  if (!claude) fail("Claude Code command not found. Install Claude Code and ensure claude.cmd or claude is on PATH.");
  const title = opts.title || "Assistant task";
  const body = opts.body || fail("Missing --body.");
  const run = createRun(project, title, body);
  fs.mkdirSync(run.sessionDir, { recursive: true });
  writeRound(project, run, run.rounds[0]);
  const output = withProjectLock(project, () => {
    const launched = runClaudeRound(project, run, run.rounds[0], claude, opts);
    saveRun(project, run);
    const report = inspectReport(run.reportFile);
    return baseOutput(run, { status: launched ? "launched" : "launch_failed", report });
  });
  printJson(output);
}

function continueVisible(opts) {
  requireWindows();
  const runId = opts.run || opts._[0] || fail("Missing --run.");
  const body = opts.body || fail("Missing --body.");
  const run = loadRunById(runId);
  const project = {
    projectRoot: run.projectRoot,
    stateRoot: run.stateRoot,
    runsDir: path.join(run.stateRoot, "runs"),
    taskDir: path.join(run.stateRoot, "tasks"),
    reportDir: path.join(run.stateRoot, "reports")
  };
  const round = createRound(project, run, opts.title || `${run.title} follow-up`, body, run.rounds.length + 1);
  run.rounds.push(round);
  run.instructionFile = round.instructionFile;
  run.reportFile = round.reportFile;
  writeRound(project, run, round);
  run.windowTitle = `AgentCommander-${run.runId}-round-${round.round}`;
  const claude = findClaude();
  if (!claude) fail("Claude Code command not found. Install Claude Code and ensure claude.cmd or claude is on PATH.");
  const output = withProjectLock(project, () => {
    const launched = runClaudeRound(project, run, round, claude, opts);
    round.launched = launched;
    saveRun(project, run);
    const report = inspectReport(round.reportFile);
    return baseOutput(run, { status: "continued", round: round.round, launched, report });
  });
  printJson(output);
}

function checkRun(opts) {
  const runId = opts.run || opts._[0] || fail("Missing --run.");
  const run = loadRunById(runId);
  printJson(baseOutput(run, { status: "checked", report: inspectReport(run.reportFile) }));
}

function closeVisible(opts) {
  const runId = opts.run || opts._[0] || fail("Missing --run.");
  const run = loadRunById(runId);
  printJson({ runId, close: closeWindow(run.windowTitle) });
}

function selfTest(opts) {
  doctor(opts);
}

function createRun(project, title, body) {
  const runId = `${stamp()}-${crypto.randomBytes(3).toString("hex")}`;
  const run = {
    runId,
    title,
    slug: slug(title),
    createdAt: new Date().toISOString(),
    projectRoot: project.projectRoot,
    stateRoot: project.stateRoot,
    sessionDir: path.join(project.runsDir, runId),
    windowTitle: `AgentCommander-${runId}`,
    rounds: []
  };
  const firstRound = createRound(project, run, title, body, 1);
  run.rounds.push(firstRound);
  run.instructionFile = firstRound.instructionFile;
  run.reportFile = firstRound.reportFile;
  return run;
}

function createRound(project, run, title, body, roundNumber) {
  const roundSlug = slug(title || run.title);
  const roundLabel = `round-${roundNumber}`;
  return {
    round: roundNumber,
    title,
    body,
    instructionFile: path.join(project.taskDir, `${run.runId}-${roundLabel}-${roundSlug}.md`),
    reportFile: path.join(project.reportDir, `${run.runId}-${roundLabel}-${roundSlug}.md`),
    promptFile: path.join(run.sessionDir, `${roundLabel}.prompt.txt`)
  };
}

function writeRound(project, run, round) {
  fs.mkdirSync(project.taskDir, { recursive: true });
  fs.mkdirSync(project.reportDir, { recursive: true });
  fs.mkdirSync(run.sessionDir, { recursive: true });
  const template = fs.readFileSync(templatePath, "utf8");
  const values = {
    runId: run.runId,
    round: round.round,
    title: round.title,
    body: round.body,
    projectRoot: run.projectRoot,
    instructionFile: round.instructionFile,
    reportFile: round.reportFile
  };
  fs.writeFileSync(round.instructionFile, fill(template, values), "utf8");
  fs.writeFileSync(round.promptFile, [
    `Read and follow this instruction file: ${round.instructionFile}`,
    `Save the report to: ${round.reportFile}`,
    "After saving the report, output only the report path."
  ].join("\n"), "utf8");
}

function runClaudeRound(project, run, round, claude, opts) {
  const wrapperFile = path.join(run.sessionDir, `round-${round.round}.cmd`);
  const permission = opts.permissionMode || "bypassPermissions";
  const args = [
    windowsQuote(claude.path || claude.command),
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    windowsQuote(permission),
    `--add-dir=${windowsQuote(project.projectRoot)}`,
    "--name",
    windowsQuote(run.windowTitle),
    "<",
    windowsQuote(round.promptFile)
  ].join(" ");
  const wrapper = [
    "@echo off",
    `title ${run.windowTitle}`,
    "chcp 65001 >nul",
    `cd /d ${windowsQuote(project.projectRoot)}`,
    "echo.",
    "echo [Codex Agent Commander] Opening Claude Code.",
    `echo [Project Root] ${project.projectRoot}`,
    `echo [Run ID] ${run.runId}`,
    "echo.",
    `call ${args}`,
    "set EXIT_CODE=%ERRORLEVEL%",
    "echo.",
    "echo [Codex Agent Commander] Claude Code returned with code %EXIT_CODE%.",
    "timeout /t 3 /nobreak >nul",
    "exit /b %EXIT_CODE%"
  ].join("\r\n");
  fs.writeFileSync(wrapperFile, wrapper, "utf8");
  const launched = launchRoundProcess(project.projectRoot, wrapperFile, run.windowTitle, opts.windowMode || "hidden");
  run.wrapperFile = wrapperFile;
  saveRun(project, run);
  waitForReportWithResends(run, round, opts);
  return launched;
}

function launchRoundProcess(projectRoot, wrapperFile, title, windowMode) {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", wrapperFile], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20
  });
  return result.status === 0;
}

function withProjectLock(project, work) {
  fs.mkdirSync(project.stateRoot, { recursive: true });
  const lockFile = path.join(project.stateRoot, "agent-commander.lock");
  const start = Date.now();
  while (fs.existsSync(lockFile)) {
    if (Date.now() - start > 10 * 60 * 1000) fail(`Another assistant task is still running: ${lockFile}`);
    sleep(2000);
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), "utf8");
  try {
    return work();
  } finally {
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function waitForReportWithResends(run, round, opts) {
  const waitMs = Number(opts.waitMs || 120000);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(round.reportFile)) return true;
    sleep(2000);
  }
  return fs.existsSync(round.reportFile);
}

function inspectReport(reportFile) {
  const exists = fs.existsSync(reportFile);
  const text = exists ? fs.readFileSync(reportFile, "utf8") : "";
  const match = text.match(/^\s*-\s*status\s*:\s*([a-z_]+)/im);
  const reportStatus = exists ? (match && statusValues.has(match[1]) ? match[1] : "unknown") : "waiting";
  return {
    reportFile,
    reportExists: exists,
    reportStatus,
    summary: exists ? section(text, "Summary") : null
  };
}

function closeWindow(windowTitle) {
  if (!windowTitle || process.platform !== "win32") return { status: "unsupported", windowTitle };
  const script = [
    `$p = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${psQuote(windowTitle)}*' } | Select-Object -First 1`,
    "if (-not $p) { exit 2 }",
    "$p.CloseMainWindow() | Out-Null",
    "Start-Sleep -Milliseconds 1000",
    "if (-not $p.HasExited) { $p.Kill() }",
    "exit 0"
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8" });
  return { status: result.status === 0 ? "close_requested" : "window_not_found", windowTitle };
}

function saveRun(project, run) {
  fs.mkdirSync(project.runsDir, { recursive: true });
  fs.writeFileSync(path.join(project.runsDir, `${run.runId}.json`), JSON.stringify(run, null, 2), "utf8");
}

function loadRunById(runId) {
  const matches = [];
  for (const root of candidateSearchRoots()) {
    collectRunFiles(root, runId, matches);
  }
  if (!matches.length) fail(`Run not found: ${runId}`);
  return JSON.parse(fs.readFileSync(matches[0], "utf8"));
}

function candidateSearchRoots() {
  return [process.cwd(), path.dirname(process.cwd()), repoRoot].filter((value, index, array) => array.indexOf(value) === index);
}

function collectRunFiles(root, runId, matches) {
  const target = path.join(root, ".agent-commander", "runs", `${runId}.json`);
  if (fs.existsSync(target)) matches.push(target);
}

function baseOutput(run, extra) {
  return {
    ...extra,
    runId: run.runId,
    projectRoot: run.projectRoot,
    instructionFile: run.instructionFile,
    reportFile: run.reportFile,
    windowTitle: run.windowTitle
  };
}

function spawnCmd(command, args, options = {}) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(windowsQuote).join(" ")], {
      encoding: "utf8",
      ...options
    });
  }
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function sleep(ms) {
  spawnSync(process.platform === "win32" ? "timeout.exe" : "sleep", process.platform === "win32" ? ["/t", String(Math.ceil(ms / 1000)), "/nobreak"] : [String(ms / 1000)], {
    stdio: "ignore"
  });
}

function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim() || null;
}

function fill(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => values[key] ?? "");
}

function stamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function slug(value) {
  return String(value).normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "task";
}

function windowsQuote(value) {
  const text = String(value);
  if (/^[^\s"&|<>^()%!]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function requireWindows() {
  if (process.platform !== "win32") fail("Visible Claude Code window mode currently supports Windows only.");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Codex Agent Commander

Commands:
  run-hidden --project-root <folder> --title <title> --body <text>
  doctor --project-root <folder>
  open-visible --project-root <folder> --title <title> --body <text>
  continue-visible --run <run_id> --body <text>
  check --run <run_id>
  close-visible --run <run_id>
`);
}

function fail(message) {
  process.stderr.write(`codex-agent-commander: ${message}\n`);
  process.exit(1);
}
