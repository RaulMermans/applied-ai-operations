import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadControlPlaneConfig } from "../src/index.js";

describe("loadControlPlaneConfig", () => {
  it("applies documented defaults for an empty environment", () => {
    const config = loadControlPlaneConfig({});

    expect(config).toEqual({
      env: "development",
      logLevel: "info",
      host: "127.0.0.1",
      port: 4000,
    });
  });

  it("honors explicit overrides", () => {
    const config = loadControlPlaneConfig({
      AAO_ENV: "production",
      AAO_LOG_LEVEL: "warn",
      AAO_CONTROL_PLANE_HOST: "0.0.0.0",
      AAO_CONTROL_PLANE_PORT: "8080",
    });

    expect(config).toEqual({
      env: "production",
      logLevel: "warn",
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadControlPlaneConfig({ AAO_CONTROL_PLANE_PORT: "0" })).toThrow(ConfigValidationError);
    expect(() => loadControlPlaneConfig({ AAO_CONTROL_PLANE_PORT: "70000" })).toThrow(ConfigValidationError);
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadControlPlaneConfig({ AAO_CONTROL_PLANE_PORT: "not-a-port" })).toThrow(ConfigValidationError);
  });

  it("rejects an unrecognized environment", () => {
    expect(() => loadControlPlaneConfig({ AAO_ENV: "staging" })).toThrow(ConfigValidationError);
  });

  it("rejects an unrecognized log level", () => {
    expect(() => loadControlPlaneConfig({ AAO_LOG_LEVEL: "verbose" })).toThrow(ConfigValidationError);
  });

  it("does not read or mutate process.env", () => {
    const isolatedEnv = { AAO_CONTROL_PLANE_PORT: "9000" };
    const config = loadControlPlaneConfig(isolatedEnv);

    expect(config.port).toBe(9000);
    expect(isolatedEnv).toEqual({ AAO_CONTROL_PLANE_PORT: "9000" });
  });
});
