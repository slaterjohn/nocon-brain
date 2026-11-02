import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { AppError } from "@ncb/shared";
import type { ServerState } from "../context.js";
import { admin } from "../lib/http.js";
import type { ZodTypeProvider } from "../lib/zod.js";
import { ACCEPTED_TYPES_TEXT, ImportRefused } from "./detect.js";

const priority = z.union([z.enum(["P1", "P2", "P3", "P4"]).transform((p) => Number(p.slice(1))), z.coerce.number().int().min(1).max(4)]);

/** Content types the original is served as. Never `text/html`: an uploaded page must not run on the API origin. */
const SERVE_AS: Record<string, string> = {
  pdf: "application/pdf",
  markdown: "text/plain; charset=utf-8",
  text: "text/plain; charset=utf-8",
  html: "application/octet-stream",
};

const MULTIPART_OVERHEAD = 256 * 1024;

/** `Content-Disposition` with an ASCII fallback and the UTF-8 name (RFC 6266). */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** docs/api.md section 4: `POST /api/archive/import` and the routes that read an import back. */
export function importRoutes(app: FastifyInstance, state: ServerState, o: { maxBytes: number }): void {
  const limit = o.maxBytes;
  const mb = Math.round(limit / 1048576);

  void app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: limit, files: 1, fields: 8, parts: 10, fieldSize: 1024, headerPairs: 40 } });
    const r = scope.withTypeProvider<ZodTypeProvider>();

    r.get("/api/archive/import/limits", { config: { auth: "guest" } }, async () => ({
      maxBytes: limit, accepted: ["html", "pdf", "markdown", "text"], extensions: [".html", ".htm", ".xhtml", ".pdf", ".md", ".markdown", ".txt"], description: ACCEPTED_TYPES_TEXT,
    }));

    r.post(
      "/api/archive/import",
      {
        config: { auth: "session" },
        bodyLimit: limit + MULTIPART_OVERHEAD,
        schema: { querystring: z.object({ sourceId: z.string().max(64).optional(), priority: priority.optional() }) },
        // Say "too large" in plain words before Fastify refuses the body with a generic 413.
        onRequest: async (req) => {
          const len = Number(req.headers["content-length"]);
          if (Number.isFinite(len) && len > limit + MULTIPART_OVERHEAD) throw new ImportRefused("file_too_large", `That file is larger than the ${mb} MB limit.`);
        },
      },
      async (req, reply) => {
        const svc = state.svc;
        admin(req);
        if (!req.isMultipart()) throw new ImportRefused("no_file", "Send the file as multipart form data, in a field named file.");
        const part = await req.file();
        if (!part) throw new ImportRefused("no_file", "Choose a file to import.");
        let data: Buffer;
        try {
          data = await part.toBuffer();
        } catch (e) {
          if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new ImportRefused("file_too_large", `That file is larger than the ${mb} MB limit.`);
          throw e;
        }
        if (part.file.truncated) throw new ImportRefused("file_too_large", `That file is larger than the ${mb} MB limit.`);
        const field = (n: string): string | undefined => {
          const f = (part.fields as Record<string, { value?: unknown } | undefined>)[n];
          return typeof f?.value === "string" ? f.value : undefined;
        };
        const sourceId = req.query.sourceId ?? field("sourceId");
        const prio = req.query.priority ?? (field("priority") ? priority.safeParse(field("priority")).data : undefined);
        const out = await svc.imports.importFile({ filename: part.filename, mime: part.mimetype, data, sourceId, priority: prio as 1 | 2 | 3 | 4 | undefined });
        void reply.code(out.duplicate ? 200 : 202);
        return { ...out, links: { original: `/api/archive/versions/${out.versionId}/original`, capture: `/api/archive/captures/${out.downloadId}` } };
      },
    );

    r.get("/api/archive/versions/:id/import", { config: { auth: "guest" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req) => {
      const info = state.svc.imports.info(req.params.id);
      if (!info) throw new AppError("not_found", "That saved copy was not imported from a file.");
      const { originalSha256: _sha, ...rest } = info;
      return { ...rest, importedAt: new Date(info.importedAt).toISOString(), downloadUrl: `/api/archive/versions/${info.versionId}/original` };
    });

    r.get("/api/archive/versions/:id/original", { config: { auth: "guest" }, schema: { params: z.object({ id: z.string().max(64) }) } }, async (req, reply) => {
      const got = await state.svc.imports.original(req.params.id);
      if (!got) throw new AppError("not_found", "That saved copy was not imported from a file, so there is no original to download.");
      void reply
        .header("content-type", SERVE_AS[got.info.kind] ?? "application/octet-stream")
        .header("content-disposition", attachment(got.info.filename))
        .header("x-content-type-options", "nosniff")
        .header("content-length", String(got.data.length))
        .header("cache-control", "private, max-age=0, must-revalidate");
      return reply.send(got.data);
    });
  });
}
