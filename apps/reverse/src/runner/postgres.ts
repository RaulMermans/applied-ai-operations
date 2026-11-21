import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";

/** Version- and digest-pinned PostgreSQL 16 image. */
export const POSTGRES_IMAGE = "postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297";

export type Database = {
  connectionUri: string;
  containerId: string | null;
  /** Stops the database and returns whether removal was verified (null = cannot be verified). */
  stop(): Promise<boolean | null>;
};
export type StartDatabase = () => Promise<Database>;

/** Publishes 5432 on 127.0.0.1 only; testcontainers' default publishes on every host interface. */
class LoopbackPostgreSqlContainer extends PostgreSqlContainer {
  override start(): Promise<StartedPostgreSqlContainer> {
    for (const bindings of Object.values(this.hostConfig.PortBindings ?? {})) {
      for (const binding of bindings as { HostIp?: string }[]) binding.HostIp = "127.0.0.1";
    }
    return super.start();
  }
}

async function containerRemoved(id: string): Promise<boolean> {
  const client = await getContainerRuntimeClient();
  try {
    await client.container.inspect(client.container.getById(id));
    return false;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode === 404;
  }
}

/**
 * Ephemeral, synthetic-only database. Not a security sandbox: a container
 * is not an isolation boundary for hostile code, and Sprint 0 executes only
 * allowlisted in-repo SQL. Code under test (SQL) never sees the Docker socket.
 */
export async function startEphemeralPostgres(): Promise<Database> {
  const started = await new LoopbackPostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("rollbackproof")
    .withUsername("rehearsal")
    .withPassword(randomBytes(16).toString("hex"))
    .withTmpFs({ "/var/lib/postgresql/data": "rw,size=256m" })
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withLabels({ "dev.reverse.purpose": "rollbackproof-rehearsal" })
    .withStartupTimeout(60_000)
    .start();
  const id = started.getId();
  return {
    connectionUri: started.getConnectionUri(),
    containerId: id,
    async stop() {
      await started.stop({ remove: true, removeVolumes: true });
      return containerRemoved(id);
    },
  };
}
