#!/usr/bin/env node
// The `aao` executable (package bin). All behavior lives in `runCli`; this
// entry only writes its result and sets the exit code.
import process from "node:process";
import { runCli } from "./run.js";

const result = await runCli(process.argv.slice(2), { cwd: process.cwd() });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
