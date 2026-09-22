import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

describe("control plane app", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("constructs successfully", () => {
    app = buildApp();
    expect(app).toBeDefined();
  });

  it("answers /health/live", async () => {
    app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "aao-control-plane", status: "ok" });
  });

  it("answers /health/ready", async () => {
    app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "aao-control-plane", status: "ok" });
  });

  it("does not report health success for an unknown route", async () => {
    app = buildApp();
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(response.statusCode).toBe(404);
  });

  it("closes cleanly", async () => {
    app = buildApp();
    await expect(app.close()).resolves.toBeUndefined();
    app = undefined;
  });
});
