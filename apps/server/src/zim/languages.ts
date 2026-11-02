/** ZIM files name a language with ISO 639-3 codes (`eng`, possibly several: `eng,fra`); the search filter and the browser use 639-1 (`en`). */
const TWO_TO_THREE: Record<string, string> = {
  en: "eng", fr: "fra", de: "deu", es: "spa", it: "ita", pt: "por", nl: "nld", ru: "rus", zh: "zho", ja: "jpn", ko: "kor", ar: "ara", pl: "pol",
  sv: "swe", da: "dan", no: "nor", nb: "nob", fi: "fin", cs: "ces", el: "ell", he: "heb", hi: "hin", tr: "tur", uk: "ukr", vi: "vie", id: "ind",
  th: "tha", hu: "hun", ro: "ron", bg: "bul", ca: "cat", cy: "cym", ga: "gle", la: "lat", eo: "epo",
};
const FIVE = /^([a-z]{2,3})(?:[-_][A-Za-z0-9]+)?$/i;

/** All forms (639-1 and 639-3) a filter value stands for. */
export function languageForms(code: string): string[] {
  const m = FIVE.exec(code.trim());
  if (!m) return [];
  const base = m[1]!.toLowerCase();
  const three = TWO_TO_THREE[base];
  const two = Object.entries(TWO_TO_THREE).find(([, v]) => v === base)?.[0];
  return [...new Set([base, three, two].filter((x): x is string => !!x))];
}

/** True when a package's language field matches any wanted code. An empty wanted list matches everything; a package without a language never matches a filter. */
export function languageMatches(zimLanguage: string | null | undefined, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  const have = new Set((zimLanguage ?? "").split(/[,;\s]+/).filter(Boolean).flatMap((c) => languageForms(c)));
  return wanted.some((w) => languageForms(w).some((f) => have.has(f)));
}
