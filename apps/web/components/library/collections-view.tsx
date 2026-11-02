"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, FolderPlus, MoveRight, RefreshCw, Trash2 } from "lucide-react";
import { del, errorMessage, patch, post, useApi } from "@/lib/api";
import type { Collection, CollectionItem, Page } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { priorityLabel } from "@/lib/library-copy";
import { formatDate } from "./format";
import { LibraryNav } from "./library-nav";
import { CollectionIcon } from "./collection-icon";
import { CollectionForm } from "./collection-form";
import { useCollections } from "./hooks";

/*
 * The tree follows the WAI-ARIA tree pattern: one tab stop (roving tabindex), Up and Down move through visible items, Right opens
 * a branch or goes to its first child, Left closes it or goes to the parent, Home and End jump to the ends, Enter or Space selects.
 * Dragging an item onto another moves it, for people with a mouse; "Move to" in the details panel does the same by keyboard.
 */

function sortTree(nodes: Collection[]): Collection[] {
  return [...nodes]
    .sort((a, b) => (a.kind === "favourites" ? -1 : b.kind === "favourites" ? 1 : a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)))
    .map((n) => ({ ...n, children: n.children ? sortTree(n.children) : undefined }));
}

interface Visible { c: Collection; level: number; parent: string | null }

function visibleNodes(nodes: Collection[], expanded: Set<string>, level = 1, parent: string | null = null, out: Visible[] = []) {
  for (const c of nodes) {
    out.push({ c, level, parent });
    if (c.children?.length && expanded.has(c.id)) visibleNodes(c.children, expanded, level + 1, c.id, out);
  }
  return out;
}

function descendants(c: Collection, out = new Set<string>()) {
  for (const k of c.children ?? []) {
    out.add(k.id);
    descendants(k, out);
  }
  return out;
}

function TreeNode({
  c, level, expanded, selectedId, focusId, onSelect, onToggle, onFocus, onDrop, dragId, setDragId, dropId, setDropId,
}: {
  c: Collection; level: number; expanded: Set<string>; selectedId: string | null; focusId: string | null;
  onSelect: (id: string) => void; onToggle: (id: string) => void; onFocus: (id: string) => void; onDrop: (target: string) => void;
  dragId: string | null; setDragId: (id: string | null) => void; dropId: string | null; setDropId: (id: string | null) => void;
}) {
  const hasKids = !!c.children?.length;
  const open = hasKids && expanded.has(c.id);
  return (
    <li
      role="treeitem"
      id={`tree-${c.id}`}
      aria-level={level}
      aria-expanded={hasKids ? open : undefined}
      aria-selected={selectedId === c.id}
      tabIndex={focusId === c.id ? 0 : -1}
      data-testid="collection-node"
      data-name={c.name}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocus(c.id); }}
      className="outline-none"
    >
      <div
        className={cn(
          "flex items-center gap-1 rounded-md px-1 py-1 text-sm hover:bg-accent [li:focus-visible>&]:outline-2 [li:focus-visible>&]:outline-offset-1 [li:focus-visible>&]:outline-[var(--ring)]",
          selectedId === c.id && "bg-accent font-medium",
          dropId === c.id && "outline-2 outline-primary",
        )}
        style={{ paddingLeft: `${(level - 1) * 1.25 + 0.25}rem` }}
        draggable={c.kind !== "favourites"}
        onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); }}
        onDragEnd={() => { setDragId(null); setDropId(null); }}
        onDragOver={(e) => { if (dragId && dragId !== c.id) { e.preventDefault(); setDropId(c.id); } }}
        onDragLeave={() => setDropId(null)}
        onDrop={(e) => { e.preventDefault(); setDropId(null); onDrop(c.id); }}
        onClick={() => onSelect(c.id)}
      >
        {hasKids ? (
          <span aria-hidden="true" className="flex size-5 items-center justify-center rounded hover:bg-muted" onClick={(e) => { e.stopPropagation(); onToggle(c.id); }}>
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </span>
        ) : <span className="size-5" aria-hidden="true" />}
        <CollectionIcon name={c.icon} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {c.kind === "auto" ? <span className="text-xs text-muted-foreground">auto</span> : null}
        <span className="text-xs text-muted-foreground tabular-nums"><span className="sr-only">, </span>{c.itemCount}<span className="sr-only"> {c.itemCount === 1 ? "page" : "pages"}</span></span>
      </div>
      {hasKids && open ? (
        <ul role="group">
          {c.children!.map((k) => (
            <TreeNode key={k.id} c={k} level={level + 1} expanded={expanded} selectedId={selectedId} focusId={focusId} onSelect={onSelect} onToggle={onToggle} onFocus={onFocus} onDrop={onDrop} dragId={dragId} setDragId={setDragId} dropId={dropId} setDropId={setDropId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Items({ c }: { c: Collection }) {
  const { toast } = useToast();
  const [limit, setLimit] = React.useState(25);
  const items = useApi<Page<CollectionItem>>(`/api/collections/${c.id}/items?limit=${limit}`);
  async function remove(p: CollectionItem) {
    try {
      await post(`/api/collections/${c.id}/items`, { add: [], remove: [{ pageId: p.pageId }] });
      toast({ title: "Removed from the collection", description: p.title ?? p.url });
      void items.mutate();
    } catch (e) {
      toast({ title: "Couldn't remove it", description: errorMessage(e), variant: "error" });
    }
  }
  if (items.isLoading) return <LoadingSkeleton rows={3} label="Loading the pages in this collection" />;
  if (items.error) return <ErrorState title="Couldn't load the pages" message={items.error.message} onRetry={() => void items.mutate()} />;
  if (!items.data?.items.length) return <p className="text-sm text-muted-foreground" data-testid="collection-empty">{c.kind === "auto" ? "No pages match the rule yet." : "No pages yet. Select pages in the Library and choose Add to collection."}</p>;
  return (
    <>
      <Table aria-label={`Pages in ${c.name}`}>
        <caption className="sr-only">Pages in {c.name}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead><TableHead>Priority</TableHead><TableHead>Added</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.data.items.map((p) => (
            <TableRow key={p.pageId} data-testid="collection-item">
              <TableCell className="max-w-sm">
                <Link href={`/library/pages/${p.pageId}`} className="block truncate font-medium text-primary underline-offset-4 hover:underline">{p.title || p.url}</Link>
                <div className="truncate text-xs text-muted-foreground">{p.url}</div>
              </TableCell>
              <TableCell>{priorityLabel(p.effectivePriority)}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(p.addedAt)}</TableCell>
              <TableCell className="text-right">
                {c.kind === "manual" || c.kind === "favourites" ? <Button size="sm" variant="ghost" onClick={() => void remove(p)}>Remove<span className="sr-only"> {p.title || p.url} from {c.name}</span></Button> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-2 text-sm text-muted-foreground" role="status">Showing {items.data.items.length} of {items.data.total ?? items.data.items.length}.</p>
      {items.data.nextCursor ? <div className="mt-2"><Button variant="outline" onClick={() => setLimit((n) => n + 25)}>Show more</Button></div> : null}
    </>
  );
}

export function CollectionsView() {
  const cols = useCollections();
  const { toast } = useToast();
  const tree = React.useMemo(() => sortTree(cols.tree), [cols.tree]);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropId, setDropId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Collection | null>(null);
  const [moveTo, setMoveTo] = React.useState("");
  const [live, setLive] = React.useState("");
  const treeRef = React.useRef<HTMLUListElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const initialised = React.useRef(false);

  // First load: open every branch, and select the collection named in ?c= (from a page's details) or the first one.
  React.useEffect(() => {
    if (initialised.current || !tree.length) return;
    initialised.current = true;
    setExpanded(new Set(cols.flat.filter((c) => c.children?.length).map((c) => c.id)));
    const wanted = new URLSearchParams(window.location.search).get("c");
    const first = cols.byId.has(wanted ?? "") ? wanted! : tree[0]!.id;
    setSelectedId(first);
    setFocusId(first);
  }, [tree, cols.flat, cols.byId]);

  const vis = React.useMemo(() => visibleNodes(tree, expanded), [tree, expanded]);
  const selected = selectedId ? cols.byId.get(selectedId) : undefined;
  React.useEffect(() => { setMoveTo(selected?.parentId ?? ""); }, [selected?.id, selected?.parentId]);

  function focusNode(id: string) {
    setFocusId(id);
    requestAnimationFrame(() => document.getElementById(`tree-${id}`)?.focus());
  }
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function onKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const id = target.id.replace(/^tree-/, "");
    const i = vis.findIndex((v) => v.c.id === id);
    if (i < 0) return;
    const cur = vis[i]!;
    const hasKids = !!cur.c.children?.length;
    let handled = true;
    switch (e.key) {
      case "ArrowDown": if (vis[i + 1]) focusNode(vis[i + 1]!.c.id); break;
      case "ArrowUp": if (vis[i - 1]) focusNode(vis[i - 1]!.c.id); break;
      case "Home": focusNode(vis[0]!.c.id); break;
      case "End": focusNode(vis[vis.length - 1]!.c.id); break;
      case "ArrowRight":
        if (hasKids && !expanded.has(id)) toggle(id);
        else if (hasKids && vis[i + 1]) focusNode(vis[i + 1]!.c.id);
        break;
      case "ArrowLeft":
        if (hasKids && expanded.has(id)) toggle(id);
        else if (cur.parent) focusNode(cur.parent);
        break;
      case "Enter":
      case " ": setSelectedId(id); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  async function move(id: string, parentId: string | null) {
    const c = cols.byId.get(id);
    if (!c) return;
    try {
      await patch(`/api/collections/${id}`, { parentId });
      const to = parentId ? cols.byId.get(parentId)?.name : "the top level";
      setLive(`${c.name} moved into ${to}.`);
      toast({ title: `${c.name} moved`, description: `Now inside ${to}.`, variant: "success" });
      if (parentId) setExpanded((s) => new Set(s).add(parentId));
      await cols.mutate();
    } catch (e) {
      setLive(`Could not move ${c.name}. ${errorMessage(e)}`);
      toast({ title: "Couldn't move it", description: errorMessage(e), variant: "error" });
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      const r = await del<{ reparented: number; membershipsRemoved: number }>(`/api/collections/${deleting.id}`);
      toast({ title: "Collection deleted", description: `${deleting.name}. ${r.reparented} nested ${r.reparented === 1 ? "collection moved" : "collections moved"} up. The pages stay in the Library.` });
      setSelectedId(null);
      setFocusId(null);
      initialised.current = false;
      setDeleting(null);
      await cols.mutate();
    } catch (e) {
      toast({ title: "Couldn't delete it", description: errorMessage(e), variant: "error" });
    }
  }

  const blocked = selected ? new Set([selected.id, ...descendants(cols.byId.get(selected.id) ?? selected)]) : new Set<string>();
  const moveChoices = cols.flat.filter((c) => !blocked.has(c.id) && c.kind !== "auto" && c.kind !== "favourites");

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages you have saved. They open without internet." />
      <LibraryNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Collections</h2>
          <p className="text-sm text-muted-foreground">Group pages your own way. A page can be in many collections and is never copied.</p>
        </div>
        <Button onClick={() => setCreating(true)} data-testid="new-collection"><FolderPlus aria-hidden="true" /> New collection</Button>
      </div>

      {cols.isLoading ? <LoadingSkeleton label="Loading collections" /> : null}
      {cols.error ? <ErrorState title="Couldn't load collections" message={cols.error.message} onRetry={() => void cols.mutate()} /> : null}
      {cols.data && tree.length === 0 ? <EmptyState title="No collections yet" description="Create one to start grouping pages." /> : null}

      {tree.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <div>
            <p id="tree-help" className="mb-2 text-xs text-muted-foreground">Use the arrow keys to move through the list, Right and Left to open and close, Enter to select. Drag a collection onto another to nest it, or use Move to in the details.</p>
            <ul ref={treeRef} role="tree" aria-label="Collections" aria-describedby="tree-help" onKeyDown={onKeyDown} className="rounded-lg border p-1" data-testid="collection-tree">
              {tree.map((c) => (
                <TreeNode
                  key={c.id} c={c} level={1} expanded={expanded} selectedId={selectedId} focusId={focusId ?? tree[0]!.id}
                  onSelect={(id) => { setSelectedId(id); setFocusId(id); }} onToggle={toggle} onFocus={setFocusId}
                  onDrop={(target) => { if (dragId && dragId !== target && !descendants(cols.byId.get(dragId)!).has(target)) void move(dragId, target); }}
                  dragId={dragId} setDragId={setDragId} dropId={dropId} setDropId={setDropId}
                />
              ))}
            </ul>
            <div role="status" aria-live="polite" className="sr-only" data-testid="tree-live">{live}</div>
          </div>

          <section aria-labelledby="col-detail-h" className="min-w-0 space-y-6" data-testid="collection-detail">
            {selected ? (
              <>
                <div>
                  <h2 id="col-detail-h" className="flex items-center gap-2 text-xl font-semibold"><CollectionIcon name={selected.icon} className="size-5" /> {selected.name}</h2>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary">{selected.kind === "auto" ? "Automatic" : selected.kind === "favourites" ? "Favourites" : "Manual"}</Badge>
                    <span>{selected.itemCount} {selected.itemCount === 1 ? "page" : "pages"}</span>
                    {selected.priorityFloor ? <span>Priority floor: {priorityLabel(selected.priorityFloor)}</span> : null}
                  </p>
                  {selected.description ? <p className="mt-2 text-sm">{selected.description}</p> : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {selected.kind === "auto" ? (
                    <Button variant="outline" size="sm" onClick={async () => {
                      try { const r = await post<{ added: number; removed: number }>(`/api/collections/${selected.id}/rebuild`); toast({ title: "Rule checked again", description: `${r.added} added, ${r.removed} removed.`, variant: "success" }); void cols.mutate(); } catch (e) { toast({ title: "Couldn't rebuild", description: errorMessage(e), variant: "error" }); }
                    }}><RefreshCw aria-hidden="true" /> Check the rule again</Button>
                  ) : null}
                  {selected.kind !== "favourites" ? (
                    <Button variant="ghost" size="sm" onClick={(e) => { opener.current = e.currentTarget; setDeleting(selected); }} data-testid="delete-collection"><Trash2 aria-hidden="true" /> Delete<span className="sr-only"> {selected.name}</span></Button>
                  ) : null}
                </div>

                {selected.kind !== "favourites" ? (
                  <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
                    <div className="min-w-48 flex-1">
                      <Label htmlFor="move-to" className="mb-1 block text-sm">Move to</Label>
                      <Select id="move-to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} data-testid="move-to">
                        <option value="">Top level</option>
                        {moveChoices.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth)}{c.name}</option>)}
                      </Select>
                    </div>
                    <Button variant="outline" onClick={() => void move(selected.id, moveTo || null)} disabled={(selected.parentId ?? "") === moveTo} data-testid="move-button"><MoveRight aria-hidden="true" /> Move<span className="sr-only"> {selected.name}</span></Button>
                  </div>
                ) : null}

                <details className="rounded-lg border" data-testid="edit-details">
                  <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium hover:bg-accent">Edit name, icon, priority floor{selected.kind === "auto" ? " and rule" : ""}</summary>
                  <div className="border-t p-4">
                    <CollectionForm idPrefix="edit-col" initial={selected} onSaved={(c) => { toast({ title: "Collection saved", description: c.name, variant: "success" }); void cols.mutate(); }} />
                  </div>
                </details>

                <div>
                  <h3 className="mb-2 text-base font-semibold">Pages in this collection</h3>
                  <Items key={selected.id + selected.itemCount} c={selected} />
                </div>
              </>
            ) : <p className="text-sm text-muted-foreground">Select a collection to see its pages and settings.</p>}
          </section>
        </div>
      ) : null}

      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent aria-describedby="new-col-desc" className="max-w-xl">
          <div><DialogTitle>New collection</DialogTitle><DialogDescription id="new-col-desc" className="mt-1">Give it a name. You can nest it inside another collection.</DialogDescription></div>
          <CollectionForm
            idPrefix="new-col"
            parentId={selected && selected.kind !== "auto" && selected.kind !== "favourites" ? selected.id : null}
            parentChoices={cols.flat.filter((c) => c.kind !== "auto" && c.kind !== "favourites")}
            onCancel={() => setCreating(false)}
            onSaved={(c) => { setCreating(false); toast({ title: "Collection created", description: c.name, variant: "success" }); initialised.current = false; void cols.mutate().then(() => { setSelectedId(c.id); setFocusId(c.id); }); }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent
          aria-describedby="del-col-desc"
          onCloseAutoFocus={(e) => { if (opener.current?.isConnected) { e.preventDefault(); opener.current.focus(); } }}
        >
          <div><DialogTitle>Delete this collection?</DialogTitle><DialogDescription id="del-col-desc" className="mt-1">{deleting?.name}</DialogDescription></div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>The {deleting?.itemCount ?? 0} {deleting?.itemCount === 1 ? "page stays" : "pages stay"} in the Library. Nothing is deleted from storage.</li>
            {deleting?.children?.length ? <li>Its {deleting.children.length} nested {deleting.children.length === 1 ? "collection moves" : "collections move"} up one level.</li> : null}
            {deleting?.priorityFloor ? <li>Its priority floor ({deleting.priorityFloor}) stops applying to those pages.</li> : null}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} data-testid="confirm-delete-collection"><Trash2 aria-hidden="true" /> Delete collection</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
