import type { Db } from "@ncb/db";
import type { PriorityNumber } from "@ncb/shared";

/** The collection half of the reference model (data-model.md 5.1): a collection with `priority_floor` references its members. */
export interface CollectionReference {
  collectionId: number;
  collectionPublicId: string;
  priority: PriorityNumber;
  addedBy: "user" | "rule" | "source";
}

/**
 * Every active collection reference to a page. Only collections with a floor create one; plain membership protects nothing.
 * The reference retains the latest version only and permits automatic eviction (the priority class decides, rules 5.2.5 and 5.2.6).
 */
export function collectionReferences(db: Db, pageId: number): CollectionReference[] {
  return db
    .all<{ id: number; public_id: string; priority_floor: number; added_by: string }>(
      `SELECT c.id, c.public_id, c.priority_floor, m.added_by FROM collection_memberships m JOIN collections c ON c.id = m.collection_id
       WHERE m.page_id = ? AND c.deleted_at IS NULL AND c.priority_floor IS NOT NULL ORDER BY c.id`,
      [pageId],
    )
    .map((r) => ({ collectionId: r.id, collectionPublicId: r.public_id, priority: r.priority_floor as PriorityNumber, addedBy: r.added_by as CollectionReference["addedBy"] }));
}
