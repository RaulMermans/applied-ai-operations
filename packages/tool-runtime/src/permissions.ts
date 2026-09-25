import type { PermissionClass, ToolSpec } from "@aao/contracts";

/**
 * The permission classes Tool Runtime V1 is able to execute safely. This is
 * an execution *support gate*, not authorization: it says which kinds of
 * Tool this runtime version may run at all, and says nothing about whether a
 * given actor, Agent, or workflow is permitted to invoke a given Tool. Actor
 * / policy / approval enforcement is the next governance sprint's job.
 *
 * `external_side_effect`, `destructive`, and `sensitive_data` are refused
 * until AAO has authorization, approval, idempotency, and data-handling
 * controls for them (see docs/security/permission-model.md).
 */
export const SUPPORTED_TOOL_PERMISSION_CLASSES: readonly PermissionClass[] = ["read_only", "write_draft"];

/**
 * Every permission class a Tool requires must be supported — not just the
 * first. `["read_only", "sensitive_data"]` is therefore unsupported.
 * Registering a Tool does not bypass this: registration means trusted code
 * exists, never that V1 may execute it.
 */
export function checkToolPermissionSupport(spec: Pick<ToolSpec, "permissionClasses">): { supported: true } | { supported: false; unsupported: PermissionClass[] } {
  const unsupported = spec.permissionClasses.filter((permissionClass) => !SUPPORTED_TOOL_PERMISSION_CLASSES.includes(permissionClass));
  return unsupported.length === 0 ? { supported: true } : { supported: false, unsupported };
}
