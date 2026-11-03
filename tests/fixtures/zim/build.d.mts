export const CHEM_UUID: string;
export const NOTITLE_UUID: string;
export const OTHER_UUID: string;
export const BIG_UUID: string;
export const WIKI_UUID: string;
export const XSS_TEXT: string;
export const XSS_BODY: string;
export function buildFixtures(outDir?: string, opts?: { force?: boolean }): Promise<{ wiki: string; chem: string; notitle: string; other: string; bad: string; big: string }>;
