import { z } from "zod";
import { aaoEnvSchema, logLevelSchema, parseEnv, type AaoEnv, type EnvRecord, type LogLevel } from "./env.js";

const workerEnvSchema = z.object({
  AAO_ENV: aaoEnvSchema.default("development"),
  AAO_LOG_LEVEL: logLevelSchema.default("info"),
  AAO_WORKER_ID: z.string().min(1).default("aao-worker-local"),
});

export type WorkerConfig = {
  env: AaoEnv;
  logLevel: LogLevel;
  workerId: string;
};

export function loadWorkerConfig(env: EnvRecord): WorkerConfig {
  const parsed = parseEnv(workerEnvSchema, env, "worker configuration");
  return {
    env: parsed.AAO_ENV,
    logLevel: parsed.AAO_LOG_LEVEL,
    workerId: parsed.AAO_WORKER_ID,
  };
}
