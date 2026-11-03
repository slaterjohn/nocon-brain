import { cn } from "@/lib/utils";

/** Where the source of this version lives. AGPL-3.0 section 13: people who use the app over a network must be offered the source. */
export const SOURCE_URL = "https://github.com/slaterjohn/nocon-brain";

/** One line at the foot of every page: the version, the licence and a link to the source. No request is made unless the link is followed. */
export function SourceNotice({ className }: { className?: string }) {
  const version = process.env.NEXT_PUBLIC_NCB_VERSION;
  return (
    <footer className={cn("shrink-0 border-t px-4 py-2 text-center text-xs text-muted-foreground", className)} data-testid="source-notice">
      NoConBrain{version ? ` ${version}` : ""} is free software under the{" "}
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        GNU AGPL v3
      </a>
      .{" "}
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        Source code
      </a>
    </footer>
  );
}
