const { spawn } = require("node:child_process");

const [, , tsxCli, runnerPath, pidFile] = process.argv;
spawn(process.execPath, [tsxCli, runnerPath, pidFile], {
  stdio: "ignore",
  windowsHide: true,
});
setInterval(() => undefined, 1_000);
