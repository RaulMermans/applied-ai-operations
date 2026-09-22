import { z, type ZodType } from "zod";
import { ConfigValidationError } from "./errors.js";

/** The process environment shape every loader reads from. Callers pass an
 * explicit object rather than relying on global `process.env` so tests can
 * exercise isolated environments without mutating shared state. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

export const aaoEnvSchema = z.enum(["development", "test", "production"]);
export type AaoEnv = z.infer<typeof aaoEnvSchema>;

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const portSchema = z.coerce.number().int().min(1).max(65535);

export function parseEnv<Schema extends ZodType>(
  schema: Schema,
  env: EnvRecord,
  description: string,
): z.infer<Schema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigValidationError(`Invalid ${description}: ${issues}`);
  }
  return result.data;
}
