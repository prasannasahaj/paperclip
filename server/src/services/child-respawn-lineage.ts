import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { CHILD_RESPAWN_ORIGIN_KIND } from "@paperclipai/shared";

export const CHILD_RESPAWN_LINEAGE_CAP = 3;
const RESPAWN_ORIGIN_ID_PREFIX = "respawn:";

type LineageIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "originKind" | "originId">;

export type RespawnAllowance = { available: boolean; generation: number; remaining: number };

export function respawnOriginId(predecessorId: string) {
  return `${RESPAWN_ORIGIN_ID_PREFIX}${predecessorId}`;
}

export async function loadRespawnLineage(db: Db, predecessor: LineageIssue) {
  const lineage = [predecessor.id];
  let current: Pick<LineageIssue, "originKind" | "originId"> = predecessor;
  while (
    current.originKind === CHILD_RESPAWN_ORIGIN_KIND
    && current.originId?.startsWith(RESPAWN_ORIGIN_ID_PREFIX)
    && lineage.length <= CHILD_RESPAWN_LINEAGE_CAP
  ) {
    const earlierId = current.originId.slice(RESPAWN_ORIGIN_ID_PREFIX.length);
    const [earlier] = await db.select({ id: issues.id, originKind: issues.originKind, originId: issues.originId }).from(issues)
      .where(and(eq(issues.companyId, predecessor.companyId), eq(issues.id, earlierId)));
    if (!earlier) break;
    lineage.unshift(earlier.id);
    current = earlier;
  }
  return lineage;
}

export async function readRespawnAllowance(db: Db, issue: LineageIssue): Promise<RespawnAllowance> {
  const generation = (await loadRespawnLineage(db, issue)).length;
  const remaining = Math.max(0, CHILD_RESPAWN_LINEAGE_CAP - generation + 1);
  return { available: remaining > 0, generation, remaining };
}
