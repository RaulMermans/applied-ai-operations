import { z } from "zod";
import { aaoEnvSchema, logLevelSchema, parseEnv, portSchema, type AaoEnv, type EnvRecord, type LogLevel } from "./env.js";

const controlPlaneEnvSchema = z.object({
  AAO_ENV: aaoEnvSchema.default("development"),
  AAO_LOG_LEVEL: logLevelSchema.default("info"),
  AAO_CONTROL_PLANE_HOST: z.string().min(1).default("127.0.0.1"),
  AAO_CONTROL_PLANE_PORT: portSchema.default(4000),
});

export type ControlPlaneConfig = {
  env: AaoEnv;
  logLevel: LogLevel;
  host: string;
  port: number;
};

export function loadControlPlaneConfig(env: EnvRecord): ControlPlaneConfig {
  const parsed = parseEnv(controlPlaneEnvSchema, env, "control plane configuration");
  return {
    env: parsed.AAO_ENV,
    logLevel: parsed.AAO_LOG_LEVEL,
    host: parsed.AAO_CONTROL_PLANE_HOST,
    port: parsed.AAO_CONTROL_PLANE_PORT,
  };
}
