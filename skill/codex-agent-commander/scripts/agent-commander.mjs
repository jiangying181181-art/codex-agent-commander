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
    if (command === "run-hidden") return runHidden(opts);
    if (command === "open-visible") return runHidden(opts);
    if (command === "continue-hidden") return continueHidden(opts);
    if (command === "continue-visible") return continueHidden(opts);
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
    if (opts[key] === undefined) {
      opts[key] = value;
    } else if (Array.isArray(opts[key])) {
      opts[key].push(value);
    } else {
      opts[key] = [opts[key], value];
    }
    i += 1;
  }
  return opts;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function getProject(opts) {
  const projectRoot = path.resolve(opts.projectRoot || process.cwd());
  const configFile = path.resolve(opts.config || path.join(projectRoot, ".agent-commander", "config.json"));
  const config = readJsonIfExists(configFile);
  const assistant = normalizeAssistant(opts.assistant || config.defaultAssistant || "claude");
  const stateRoot = resolveProjectPath(projectRoot, firstValue(opts.stateRoot, config.stateRoot, ".agent-commander"));
  const taskDir = firstValue(opts.taskDir, config.taskDir);
  const reportDir = firstValue(opts.reportDir, config.reportDir);
  const contextFiles = [
    ...normalizeContextFiles(projectRoot, opts.contextFile ?? config.contextFiles ?? config.defaultContextFiles),
    ...normalizeContextFiles(projectRoot, assistantContextFiles(config, assistant))
  ];
  return {
    assistant,
    projectRoot,
    configFile,
    stateRoot,
    runsDir: path.join(stateRoot, "runs"),
    taskDir: taskDir ? resolveProjectPath(projectRoot, taskDir) : path.join(stateRoot, "tasks"),
    reportDir: reportDir ? resolveProjectPath(projectRoot, reportDir) : path.join(stateRoot, "reports"),
    contextFiles
  };
}

function findAssistant(assistant) {
  if (assistant === "workbuddy") return findWorkBuddy();
  return findClaude();
}

function findClaude() {
  if (process.env.CODEX_AGENT_COMMANDER_DISABLE_CLAUDE === "1") return null;
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

function findWorkBuddy() {
  if (process.env.CODEX_AGENT_COMMANDER_DISABLE_WORKBUDDY === "1") return null;
  const envPath = process.env.WORKBUDDY_CLI;
  if (envPath && fs.existsSync(envPath)) return { command: "workbuddy", path: envPath, runner: "node" };
  const pathCandidate = findCommand(process.platform === "win32" ? ["codebuddy.cmd", "cbc.cmd", "codebuddy", "cbc"] : ["codebuddy", "cbc"]);
  if (pathCandidate) return { command: path.basename(pathCandidate), path: pathCandidate };
  const localCandidate = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy")
    : "";
  if (localCandidate && fs.existsSync(localCandidate)) return { command: "codebuddy", path: localCandidate, runner: "node" };
  return null;
}

function findCommand(candidates) {
  for (const candidate of candidates) {
    const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [candidate], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    }
  }
  return null;
}

function doctor(opts) {
  const project = getProject(opts);
  const claude = findClaude();
  const workbuddy = findWorkBuddy();
  const version = claude ? spawnCmd(claude.path || claude.command, ["--version"], { cwd: project.projectRoot }) : null;
  const workbuddyVersion = workbuddy ? spawnAssistant(workbuddy, ["--version"], { cwd: project.projectRoot }) : null;
  printJson({
    platform: process.platform,
    assistant: project.assistant,
    projectRoot: project.projectRoot,
    configFile: project.configFile,
    stateRoot: project.stateRoot,
    taskDir: project.taskDir,
    reportDir: project.reportDir,
    contextFiles: project.contextFiles,
    claude,
    claudeVersion: version?.status === 0 ? version.stdout.trim() : null,
    workbuddy,
    workbuddyVersion: workbuddyVersion?.status === 0 ? workbuddyVersion.stdout.trim() : null,
    ready: Boolean(findAssistant(project.assistant) && fs.existsSync(project.projectRoot))
  });
}

function runHidden(opts) {
  const project = getProject(opts);
  const assistant = findAssistant(project.assistant);
  const title = opts.title || "Assistant task";
  const body = opts.body || fail("Missing --body.");
  if (!assistant) return printJson(assistantUnavailable(project, { title, body }));
  const run = createRun(project, title, body);
  fs.mkdirSync(run.sessionDir, { recursive: true });
  writeRound(project, run, run.rounds[0]);
  const output = withProjectLock(project, () => {
    const launched = runAssistantRound(project, run, run.rounds[0], assistant, opts);
    saveRun(project, run);
    const report = inspectReport(run.reportFile);
    return baseOutput(run, { status: launched ? "launched" : "launch_failed", report });
  });
  printJson(output);
}

function continueHidden(opts) {
  const runId = opts.run || opts._[0] || fail("Missing --run.");
  const body = opts.body || fail("Missing --body.");
  const run = loadRunById(runId, opts);
  const project = {
    projectRoot: run.projectRoot,
    stateRoot: run.stateRoot,
    runsDir: path.join(run.stateRoot, "runs"),
    taskDir: run.taskDir || path.join(run.stateRoot, "tasks"),
    reportDir: run.reportDir || path.join(run.stateRoot, "reports"),
    contextFiles: run.contextFiles || [],
    assistant: normalizeAssistant(opts.assistant || run.assistant || "claude")
  };
  const round = createRound(project, run, opts.title || `${run.title} follow-up`, body, run.rounds.length + 1);
  run.rounds.push(round);
  run.instructionFile = round.instructionFile;
  run.reportFile = round.reportFile;
  writeRound(project, run, round);
  run.windowTitle = `AgentCommander-${run.runId}-round-${round.round}`;
  const assistant = findAssistant(project.assistant);
  if (!assistant) return printJson(assistantUnavailable(project, { title: round.title, body, runId }));
  const output = withProjectLock(project, () => {
    const launched = runAssistantRound(project, run, round, assistant, opts);
    round.launched = launched;
    saveRun(project, run);
    const report = inspectReport(round.reportFile);
    return baseOutput(run, { status: "continued", round: round.round, launched, report });
  });
  printJson(output);
}

function assistantUnavailable(project, details = {}) {
  const assistantName = project.assistant === "workbuddy" ? "workbuddy" : "claude-code";
  return {
    status: "assistant_unavailable",
    assistant: assistantName,
    projectRoot: project.projectRoot,
    reason: project.assistant === "workbuddy"
      ? "WorkBuddy CLI command not found. Install WorkBuddy or set WORKBUDDY_CLI to the codebuddy CLI path."
      : "Claude Code command not found. Install Claude Code and ensure claude.cmd or claude is on PATH.",
    codexAction: "continue_without_assistant",
    message: "Delegated assistant collaboration was skipped because the requested assistant is not installed or not available. Codex should continue the user's task directly and mention the skipped assistant only when relevant.",
    ...details
  };
}

function checkRun(opts) {
  const runId = opts.run || opts._[0] || fail("Missing --run.");
  const run = loadRunById(runId, opts);
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
    assistant: project.assistant,
    projectRoot: project.projectRoot,
    stateRoot: project.stateRoot,
    taskDir: project.taskDir,
    reportDir: project.reportDir,
    contextFiles: project.contextFiles,
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
    reportFile: round.reportFile,
    contextFiles: formatContextFiles(project.contextFiles)
  };
  fs.writeFileSync(round.instructionFile, fill(template, values), "utf8");
  const prompt = [
    `Read and follow this instruction file: ${round.instructionFile}`,
    ...(project.contextFiles.length ? ["Read these project context files before starting:", ...project.contextFiles.map((file) => `- ${file}`)] : []),
    `Save the report to: ${round.reportFile}`,
    "After saving the report, output only the report path."
  ].join("\n");
  fs.writeFileSync(round.promptFile, prompt, "utf8");
}

function runAssistantRound(project, run, round, assistant, opts) {
  if (project.assistant === "workbuddy") return runWorkBuddyRound(project, run, round, assistant, opts);
  return runClaudeRound(project, run, round, assistant, opts);
}

function runClaudeRound(project, run, round, claude, opts) {
  const permission = opts.permissionMode || "bypassPermissions";
  const args = [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    permission,
    `--add-dir=${project.projectRoot}`,
    "--name",
    run.windowTitle
  ];
  const prompt = fs.readFileSync(round.promptFile, "utf8");
  const result = spawnCmd(claude.path || claude.command, args, {
    cwd: project.projectRoot,
    input: prompt,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20
  });
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stdout.txt`), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stderr.txt`), result.stderr || "", "utf8");
  round.exitCode = result.status;
  saveRun(project, run);
  waitForReportWithResends(run, round, opts);
  return result.status === 0;
}

function runWorkBuddyRound(project, run, round, workbuddy, opts) {
  const permission = opts.permissionMode || "bypassPermissions";
  const prompt = fs.readFileSync(round.promptFile, "utf8");
  const args = [
    "-p",
    "--output-format",
    "text",
    "-y",
    "--permission-mode",
    permission,
    prompt,
    "--add-dir",
    project.projectRoot
  ];
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  const timeoutMs = Number(opts.timeoutMs || opts.assistantTimeoutMs || 10 * 60 * 1000);
  const result = spawnAssistant(workbuddy, args, {
    cwd: project.projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20
  });
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stdout.txt`), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stderr.txt`), result.stderr || "", "utf8");
  round.exitCode = result.status;
  saveRun(project, run);
  waitForReportWithResends(run, round, opts);
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

function loadRunById(runId, opts = {}) {
  const matches = [];
  for (const root of candidateSearchRoots(opts)) {
    collectRunFiles(root, runId, matches);
  }
  if (!matches.length) fail(`Run not found: ${runId}`);
  return JSON.parse(fs.readFileSync(matches[0], "utf8"));
}

function candidateSearchRoots(opts = {}) {
  const roots = [process.cwd(), path.dirname(process.cwd()), repoRoot];
  if (opts.projectRoot) roots.unshift(path.resolve(opts.projectRoot));
  return roots.filter((value, index, array) => array.indexOf(value) === index);
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

function spawnAssistant(assistant, args, options = {}) {
  if (assistant.runner === "node") return spawnSync(process.execPath, [assistant.path, ...args], { encoding: "utf8", ...options });
  return spawnCmd(assistant.path || assistant.command, args, options);
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

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Invalid JSON config: ${file}: ${error.message}`);
  }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function resolveProjectPath(projectRoot, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

function normalizeContextFiles(projectRoot, value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => resolveProjectPath(projectRoot, item));
}

function assistantContextFiles(config, assistant) {
  const byAssistant = config.assistantContextFiles || {};
  const specific = assistant === "workbuddy"
    ? firstValue(config.workbuddyContextFiles, byAssistant.workbuddy)
    : firstValue(config.claudeContextFiles, byAssistant.claude, byAssistant.claudeCode);
  return specific || [];
}

function normalizeAssistant(value) {
  const assistant = String(value || "claude").trim().toLowerCase();
  if (["claude", "claude-code", "claudecode"].includes(assistant)) return "claude";
  if (["workbuddy", "codebuddy", "cbc"].includes(assistant)) return "workbuddy";
  fail(`Unknown assistant: ${value}`);
}

function formatContextFiles(files) {
  if (!files || !files.length) return "None.";
  return files.map((file) => `- ${file}`).join("\n");
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Codex Agent Commander

Commands:
  run-hidden --assistant claude|workbuddy --project-root <folder> --title <title> --body <text>
  doctor --assistant claude|workbuddy --project-root <folder>
  continue-hidden --assistant claude|workbuddy --project-root <folder> --run <run_id> --body <text>
  check --run <run_id>
`);
}

function fail(message) {
  process.stderr.write(`codex-agent-commander: ${message}\n`);
  process.exit(1);
}
