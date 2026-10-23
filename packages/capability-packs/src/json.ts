import { createHash } from "node:crypto";
import { canonicalJsonStringify, type JsonValue } from "@aao/contracts";

export function hasPrototypePollutionKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasPrototypePollutionKey);
  }

  const obj = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(obj, "__proto__") ||
    Object.prototype.hasOwnProperty.call(obj, "constructor") ||
    Object.prototype.hasOwnProperty.call(obj, "prototype")
  ) {
    return true;
  }

  for (const key of Object.keys(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return true;
    }
    if (hasPrototypePollutionKey(obj[key])) {
      return true;
    }
  }

  return false;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value as Readonly<T>;
  }

  const keys = Reflect.ownKeys(value as object);
  for (const key of keys) {
    const prop = (value as Record<string | symbol, unknown>)[key];
    if (prop !== null && typeof prop === "object") {
      deepFreeze(prop);
    }
  }

  return Object.freeze(value) as Readonly<T>;
}

export function sha256Hex(value: JsonValue): string {
  const serialized = canonicalJsonStringify(value);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
