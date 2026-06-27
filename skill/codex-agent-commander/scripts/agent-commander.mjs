#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const repoRoot = path.resolve(scriptDir, "..");
const templatePath = path.join(repoRoot, "templates", "assistant-task.md");
const statusValues = new Set(["done", "needs_followup", "blocked", "failed"]);
const booleanArgs = new Set(["help", "dryRun", "doctorRun", "wait"]);
const defaultWorkBuddyMaxTurns = 8;
const defaultWorkBuddyModel = "minimax-m3";

main();

function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  const opts = parseArgs(argv);
  try {
    if (command === "help" || opts.help) return printHelp();
    if (command === "doctor") return doctor(opts);
    if (command === "dry-run") return dryRun(opts);
    if (command === "run-hidden") return runHidden(opts);
    if (command === "open-visible") return runHidden(opts);
    if (command === "continue-hidden") return continueHidden(opts);
    if (command === "continue-visible") return continueHidden(opts);
    if (command === "worker-round") return workerRound(opts);
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
    if (booleanArgs.has(key)) {
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
  const model = resolveAssistantModel(assistant, opts, config);
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
    contextFiles,
    model
  };
}

function resolveAssistantModel(assistant, opts, config) {
  const assistantModels = config.assistantModels || {};
  if (assistant === "workbuddy") {
    return firstValue(opts.model, config.workbuddyModel, assistantModels.workbuddy, config.defaultModel, defaultWorkBuddyModel);
  }
  return firstValue(opts.model, config.claudeModel, assistantModels.claude);
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
  const selectedAssistant = findAssistant(project.assistant);
  const writeReportCheck = opts.doctorRun && selectedAssistant ? runDoctorWriteReportCheck(project, selectedAssistant, opts) : null;
  printJson({
    platform: process.platform,
    assistant: project.assistant,
    model: project.model || null,
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
    writeReportCheck,
    ready: Boolean(selectedAssistant && fs.existsSync(project.projectRoot) && (!opts.doctorRun || writeReportCheck?.report?.reportStatus === "done"))
  });
}

function runDoctorWriteReportCheck(project, assistant, opts) {
  const title = `Doctor ${project.assistant} write report check`;
  const body = [
    `This is a non-invasive doctor check for ${project.assistant}.`,
    "Do not modify source files.",
    "Only write the required report file.",
    "In Summary, include exactly: AGENT_COMMANDER_DOCTOR_OK.",
    "Set status to done."
  ].join("\n");
  const run = createRun(project, title, body);
  fs.mkdirSync(run.sessionDir, { recursive: true });
  writeRound(project, run, run.rounds[0]);
  return withProjectLock(project, () => {
    const assistantResult = runAssistantRound(project, run, run.rounds[0], assistant, {
      ...opts,
      waitMs: opts.waitMs || 120000,
      maxTurns: opts.maxTurns || (project.assistant === "workbuddy" ? defaultWorkBuddyMaxTurns : 2)
    });
    saveRun(project, run);
    const report = inspectReport(run.reportFile);
    updateReportIndex(project, run, run.rounds[0], report, `doctor_${assistantResult.status}`);
    return baseOutput(run, { status: "doctor_run", assistantResult, report });
  });
}

function runHidden(opts) {
  const project = getProject(opts);
  const assistant = findAssistant(project.assistant);
  const title = opts.title || "Assistant task";
  const body = opts.body || fail("Missing --body.");
  const run = createRun(project, title, body);
  fs.mkdirSync(run.sessionDir, { recursive: true });
  writeRound(project, run, run.rounds[0]);
  saveRun(project, run);
  if (opts.dryRun) return finishDryRun(project, run, run.rounds[0]);
  if (!assistant) return printJson(assistantUnavailable(project, { title, body }));
  if (!opts.wait) {
    const launched = launchWorker(project, run, run.rounds[0], opts);
    const report = inspectReport(run.reportFile);
    updateReportIndex(project, run, run.rounds[0], report, "launched");
    return printJson(baseOutput(run, { status: "launched", round: 1, workerPid: launched.pid, report }));
  }
  const output = withProjectLock(project, () => {
    const assistantResult = runAssistantRound(project, run, run.rounds[0], assistant, opts);
    saveRun(project, run);
    const report = inspectReport(run.reportFile);
    updateReportIndex(project, run, run.rounds[0], report, assistantResult.status);
    return baseOutput(run, { status: assistantResult.status, assistantResult, report });
  });
  printJson(output);
}

function dryRun(opts) {
  return runHidden({ ...opts, dryRun: true });
}

function continueHidden(opts) {
  const runId = opts.run || opts._[0] || fail("Missing --run.");
  const body = opts.body || fail("Missing --body.");
  const run = loadRunById(runId, opts);
  const continuedAssistant = normalizeAssistant(opts.assistant || run.assistant || "claude");
  const project = {
    projectRoot: run.projectRoot,
    stateRoot: run.stateRoot,
    runsDir: path.join(run.stateRoot, "runs"),
    taskDir: run.taskDir || path.join(run.stateRoot, "tasks"),
    reportDir: run.reportDir || path.join(run.stateRoot, "reports"),
    contextFiles: run.contextFiles || [],
    assistant: continuedAssistant,
    model: firstValue(opts.model, run.model, continuedAssistant === "workbuddy" ? defaultWorkBuddyModel : undefined)
  };
  const round = createRound(project, run, opts.title || `${run.title} follow-up`, body, run.rounds.length + 1);
  run.rounds.push(round);
  run.instructionFile = round.instructionFile;
  run.reportFile = round.reportFile;
  writeRound(project, run, round);
  run.windowTitle = `AgentCommander-${run.runId}-round-${round.round}`;
  saveRun(project, run);
  const assistant = findAssistant(project.assistant);
  if (opts.dryRun) return finishDryRun(project, run, round);
  if (!assistant) return printJson(assistantUnavailable(project, { title: round.title, body, runId }));
  if (!opts.wait) {
    const launched = launchWorker(project, run, round, opts);
    const report = inspectReport(round.reportFile);
    updateReportIndex(project, run, round, report, "launched");
    return printJson(baseOutput(run, { status: "launched", round: round.round, workerPid: launched.pid, report }));
  }
  const output = withProjectLock(project, () => {
    const assistantResult = runAssistantRound(project, run, round, assistant, opts);
    round.launched = assistantResult.ok;
    saveRun(project, run);
    const report = inspectReport(round.reportFile);
    updateReportIndex(project, run, round, report, assistantResult.status);
    return baseOutput(run, { status: "continued", round: round.round, assistantResult, report });
  });
  printJson(output);
}

function workerRound(opts) {
  const runId = opts.run || fail("Missing --run.");
  const roundNumber = Number(opts.round || 1);
  const run = loadRunById(runId, opts);
  const round = run.rounds.find((item) => Number(item.round) === roundNumber) || fail(`Round not found: ${roundNumber}`);
  const project = projectFromRun(run, opts);
  const assistant = findAssistant(project.assistant);
  if (!assistant) {
    const report = inspectReport(round.reportFile);
    updateReportIndex(project, run, round, report, "assistant_unavailable");
    return printJson(assistantUnavailable(project, { title: round.title, body: round.body, runId }));
  }
  const output = withProjectLock(project, () => {
    const assistantResult = runAssistantRound(project, run, round, assistant, opts);
    round.launched = assistantResult.ok;
    saveRun(project, run);
    const report = inspectReport(round.reportFile);
    updateReportIndex(project, run, round, report, assistantResult.status);
    return baseOutput(run, { status: assistantResult.status, round: round.round, assistantResult, report });
  });
  printJson(output);
}

function projectFromRun(run, opts = {}) {
  const continuedAssistant = normalizeAssistant(opts.assistant || run.assistant || "claude");
  return {
    projectRoot: run.projectRoot,
    stateRoot: run.stateRoot,
    runsDir: path.join(run.stateRoot, "runs"),
    taskDir: run.taskDir || path.join(run.stateRoot, "tasks"),
    reportDir: run.reportDir || path.join(run.stateRoot, "reports"),
    contextFiles: run.contextFiles || [],
    assistant: continuedAssistant,
    model: firstValue(opts.model, run.model, continuedAssistant === "workbuddy" ? defaultWorkBuddyModel : undefined)
  };
}

function launchWorker(project, run, round, opts) {
  fs.mkdirSync(run.sessionDir, { recursive: true });
  const args = [
    __filename,
    "worker-round",
    "--project-root",
    project.projectRoot,
    "--run",
    run.runId,
    "--round",
    String(round.round)
  ];
  copyWorkerOption(args, opts, "assistant");
  copyWorkerOption(args, opts, "model");
  copyWorkerOption(args, opts, "permissionMode", "permission-mode");
  copyWorkerOption(args, opts, "timeoutMs", "timeout-ms");
  copyWorkerOption(args, opts, "assistantTimeoutMs", "assistant-timeout-ms");
  copyWorkerOption(args, opts, "waitMs", "wait-ms");
  copyWorkerOption(args, opts, "maxTurns", "max-turns");
  const launched = startBackgroundProcess(project, args);
  round.workerPid = launched.pid;
  round.workerStartedAt = new Date().toISOString();
  saveRun(project, run);
  return launched;
}

function startBackgroundProcess(project, args) {
  if (process.platform === "win32") {
    const argList = args.map(psLiteral).join(", ");
    const script = [
      `$p = Start-Process -FilePath ${psLiteral(process.execPath)} -ArgumentList @(${argList}) -WorkingDirectory ${psLiteral(project.projectRoot)} -WindowStyle Hidden -PassThru`,
      "[Console]::Out.Write($p.Id)"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status !== 0) fail(`Failed to launch background worker: ${result.stderr || result.stdout}`);
    return { pid: Number(String(result.stdout || "").trim()) || null };
  }
  const child = spawn(process.execPath, args, {
    cwd: project.projectRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return { pid: child.pid };
}

function copyWorkerOption(args, opts, key, flag = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)) {
  if (opts[key] === undefined || opts[key] === null || opts[key] === "") return;
  args.push(`--${flag}`, String(opts[key]));
}

function finishDryRun(project, run, round) {
  round.dryRun = true;
  saveRun(project, run);
  const report = inspectReport(round.reportFile);
  updateReportIndex(project, run, round, report, "dry_run");
  printJson(baseOutput(run, { status: "dry_run", round: round.round, report }));
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
  const round = run.rounds.find((item) => item.reportFile === run.reportFile) || run.rounds[run.rounds.length - 1];
  const report = inspectReport(run.reportFile);
  const workerAlive = round?.workerPid ? processAlive(Number(round.workerPid)) : false;
  printJson(baseOutput(run, { status: workerAlive && !report.reportExists ? "running" : "checked", round: round?.round || null, workerPid: round?.workerPid || null, workerAlive, report }));
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
    model: project.model || null,
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
    assistant: project.assistant,
    assistantModel: project.model || (project.assistant === "claude" ? "external default (cc switch or Claude Code config)" : "not specified"),
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
  ];
  if (project.model) args.push("--model", project.model);
  args.push("--name", run.windowTitle);
  const prompt = fs.readFileSync(round.promptFile, "utf8");
  const result = spawnCmd(claude.path || claude.command, args, {
    cwd: project.projectRoot,
    input: prompt,
    encoding: "utf8",
    windowsHide: true,
    timeout: assistantTimeoutMs(opts),
    maxBuffer: 1024 * 1024 * 20
  });
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stdout.txt`), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stderr.txt`), result.stderr || "", "utf8");
  round.exitCode = result.status;
  round.signal = result.signal || null;
  round.errorCode = result.error?.code || null;
  saveRun(project, run);
  const reportExists = waitForReportWithResends(run, round, opts);
  return assistantRunResult(result, reportExists);
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
    permission
  ];
  if (project.model) args.push("--model", project.model);
  args.push(
    prompt,
    "--add-dir",
    project.projectRoot
  );
  args.push("--max-turns", String(opts.maxTurns || defaultWorkBuddyMaxTurns));
  const result = spawnAssistant(workbuddy, args, {
    cwd: project.projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: assistantTimeoutMs(opts),
    maxBuffer: 1024 * 1024 * 20
  });
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stdout.txt`), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(run.sessionDir, `round-${round.round}.stderr.txt`), result.stderr || "", "utf8");
  round.exitCode = result.status;
  round.signal = result.signal || null;
  round.errorCode = result.error?.code || null;
  saveRun(project, run);
  const reportExists = waitForReportWithResends(run, round, opts);
  return assistantRunResult(result, reportExists);
}

function assistantTimeoutMs(opts) {
  return Number(opts.timeoutMs || opts.assistantTimeoutMs || 10 * 60 * 1000);
}

function assistantRunResult(result, reportExists) {
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  const ok = result.status === 0 && reportExists;
  return {
    ok,
    status: ok ? "completed" : timedOut ? "timed_out" : reportExists ? "report_written_with_error" : "no_report",
    exitCode: result.status,
    signal: result.signal || null,
    errorCode: result.error?.code || null,
    reportExists
  };
}

function withProjectLock(project, work) {
  fs.mkdirSync(project.stateRoot, { recursive: true });
  const lockFile = path.join(project.stateRoot, "agent-commander.lock");
  const start = Date.now();
  while (fs.existsSync(lockFile)) {
    if (archiveStaleLock(lockFile)) continue;
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

function archiveStaleLock(lockFile) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return renameStaleLock(lockFile, "invalid");
  }
  const pid = Number(lock.pid);
  if (!pid || !processAlive(pid)) return renameStaleLock(lockFile, "stale");
  return false;
}

function renameStaleLock(lockFile, reason) {
  const archived = `${lockFile}.${reason}.${stamp()}.bak`;
  try {
    fs.renameSync(lockFile, archived);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

function updateReportIndex(project, run, round, report, runStatus) {
  fs.mkdirSync(project.reportDir, { recursive: true });
  const indexFile = path.join(project.reportDir, "index.json");
  const current = fs.existsSync(indexFile) ? readJsonIfExists(indexFile) : [];
  const entries = Array.isArray(current) ? current : [];
  const nextEntry = {
    runId: run.runId,
    round: round.round,
    assistant: run.assistant,
    model: run.model || null,
    title: round.title || run.title,
    status: runStatus,
    reportStatus: report.reportStatus,
    reportFile: round.reportFile,
    instructionFile: round.instructionFile,
    projectRoot: run.projectRoot,
    createdAt: run.createdAt,
    updatedAt: new Date().toISOString()
  };
  const filtered = entries.filter((entry) => !(entry.runId === nextEntry.runId && entry.round === nextEntry.round));
  filtered.push(nextEntry);
  fs.writeFileSync(indexFile, JSON.stringify(filtered, null, 2), "utf8");
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
    model: run.model || null,
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

function psLiteral(value) {
  return `'${psQuote(value)}'`;
}

function printJson(value) {
  fs.writeSync(1, `${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  fs.writeSync(1, `Codex Agent Commander

Commands:
  run-hidden --assistant claude|workbuddy --project-root <folder> --title <title> --body <text> [--wait]
  dry-run --assistant claude|workbuddy --project-root <folder> --title <title> --body <text>
  doctor --assistant claude|workbuddy --project-root <folder> [--doctor-run]
  continue-hidden --assistant claude|workbuddy --project-root <folder> --run <run_id> --body <text> [--wait]
  check --run <run_id>

Defaults:
  run-hidden and continue-hidden launch a background worker and return immediately.
  Add --wait when a synchronous blocking run is required.
  WorkBuddy runs use --max-turns ${defaultWorkBuddyMaxTurns} unless overridden.
`);
}

function fail(message) {
  process.stderr.write(`codex-agent-commander: ${message}\n`);
  process.exit(1);
}
