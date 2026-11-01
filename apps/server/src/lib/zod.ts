import type { FastifyTypeProvider, FastifySchemaCompiler } from "fastify";
import { z } from "zod";

/**
 * A small zod 4 type provider (no extra dependency). Routes declare `schema: { body, querystring, params }`
 * with zod schemas; Fastify validates with `validatorCompiler`, handlers get the parsed (typed) value, and
 * unknown fields are stripped because zod objects strip by default.
 */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends z.ZodType ? z.output<this["schema"]> : unknown;
}

export interface FieldIssue {
  in: "body" | "query" | "params" | "headers";
  path: string;
  message: string;
}

/** Thrown by the validator. The error handler turns it into a 400 `bad_request` with field errors. */
export class RequestValidationError extends Error {
  readonly fields: FieldIssue[];
  constructor(fields: FieldIssue[]) {
    super("Some values are not valid.");
    this.name = "RequestValidationError";
    this.fields = fields;
  }
}

export function issuesToFields(error: z.ZodError, where: FieldIssue["in"], prefix = ""): FieldIssue[] {
  return error.issues.map((i) => ({
    in: where,
    path: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    message: i.message,
  }));
}

export const validatorCompiler: FastifySchemaCompiler<z.ZodType> = ({ schema, httpPart }) => {
  const where = (httpPart === "body" || httpPart === "querystring" || httpPart === "params" || httpPart === "headers"
    ? httpPart === "querystring" ? "query" : httpPart
    : "body") as FieldIssue["in"];
  return (data) => {
    const r = schema.safeParse(data ?? (where === "body" ? {} : data));
    if (r.success) return { value: r.data };
    return { error: new RequestValidationError(issuesToFields(r.error, where)) };
  };
};

/** Parses with a schema and throws the same error the validator throws. For code that validates by hand. */
export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown, where: FieldIssue["in"] = "body", prefix = ""): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new RequestValidationError(issuesToFields(r.error, where, prefix));
  return r.data;
}
