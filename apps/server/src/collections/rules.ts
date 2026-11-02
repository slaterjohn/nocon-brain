import { z } from "zod";

/**
 * An auto collection's rule (docs/data-model.md `collections.rule_json`). Conditions are combined with `match`:
 * "all" (every condition) or "any" (at least one).
 *  - domain: the page's host is the domain or a subdomain of it.
 *  - source: the page was captured for the source (public id `src_...`).
 *  - title: the page title contains the text (case-insensitive).
 */
export const conditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("domain"), value: z.string().trim().toLowerCase().min(1, "Enter a domain").max(253).regex(/^[a-z0-9.-]+$/, "Use a domain such as example.com") }),
  z.object({ field: z.literal("source"), value: z.string().trim().min(1, "Choose a source").max(64) }),
  z.object({ field: z.literal("title"), value: z.string().trim().min(1, "Enter a keyword").max(200) }),
]);
export const ruleSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(conditionSchema).min(1, "Add at least one condition").max(10),
});
export type Rule = z.infer<typeof ruleSchema>;
export type Condition = z.infer<typeof conditionSchema>;

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** SQL for "page `p` matches the rule", with its parameters. `p` is the alias of the pages table. */
export function ruleToSql(rule: Rule, alias = "p"): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const c of rule.conditions) {
    switch (c.field) {
      case "domain":
        parts.push(`(${alias}.host = ? OR ${alias}.host LIKE ? ESCAPE '\\')`);
        params.push(c.value, `%.${likeEscape(c.value)}`);
        break;
      case "source":
        parts.push(`EXISTS (SELECT 1 FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ${alias}.id AND s.public_id = ? AND s.deleted_at IS NULL)`);
        params.push(c.value);
        break;
      case "title":
        parts.push(`LOWER(COALESCE(${alias}.title, '')) LIKE ? ESCAPE '\\'`);
        params.push(`%${likeEscape(c.value.toLowerCase())}%`);
        break;
    }
  }
  return { sql: `(${parts.join(rule.match === "any" ? " OR " : " AND ")})`, params };
}
