/**
 * Stop-word lists (S-07). They are used at query time to drop filler words from bare terms (never from phrases),
 * and to guess a document's language when the page does not say. The lists are deliberately short: the common
 * function words only. The index still contains every word, so phrases such as "to be or not to be" match.
 */
export const STOPWORDS: Record<string, string[]> = {
  en: "a about after all also am an and any are as at be been but by can could did do does for from had has have he her his how i if in into is it its just me more most my no not of on one or our out over she so some than that the their them then there these they this to up us was we were what when where which who why will with would you your".split(" "),
  de: "aber alle als also am an auch auf aus bei bin bis da das dass dem den der des die doch du ein eine einem einen einer er es für hat ich ihr im in ist ja kann mit nach nicht noch nur oder ohne sich sie sind so über um und uns von vor war was wenn wer wie wir wird zu zum zur".split(" "),
  fr: "à au aux avec ce ces dans de des du elle en et est il je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou où par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous".split(" "),
  es: "a al algo como con de del el ella ellos en entre era es esa ese eso esta este esto la las le les lo los más mi muy no nos o para pero por que se si sin sobre su sus te tu un una uno y ya yo".split(" "),
  it: "a ad al alla anche che chi ci come con cui da dal del della di e ed è gli ha ho i il in io la le lo ma mi ne nel non o per più qui se si su sul tra tu un una uno è".split(" "),
  pt: "a ao aos as com como da das de do dos e ela ele em entre era essa esse esta este eu foi há isso já mais mas me meu na nas nem no nos não o os ou para pela pelo por que se sem seu sua são um uma você".split(" "),
  nl: "aan al als bij dat de den der die dit door een en er ge geen had heb het hij hoe ik in is je kan maar me met mij na niet nog nu of om ons op over te toch tot uit van voor was wat we wel wij zal ze zij zijn zo".split(" "),
};

/** Languages for which the English group (Porter stemmer) is used. Everything else goes to the unicode61 group. */
export function groupForLang(lang: string | null | undefined): "en" | "default" {
  if (!lang) return "en";
  return /^en($|[-_])/i.test(lang) ? "en" : "default";
}

const SETS = new Map<string, Set<string>>(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

export function isStopword(term: string, lang = "en"): boolean {
  return (SETS.get(lang) ?? SETS.get("en")!).has(term);
}

/** True when the term is a stop word of any bundled language that shares the Latin script with English. */
export function isAnyStopword(term: string): boolean {
  for (const s of SETS.values()) if (s.has(term)) return true;
  return false;
}

/**
 * Cheap language guess for pages whose metadata has no language (S-07). Script first (CJK, Cyrillic, Arabic, Greek,
 * Hebrew, Thai, Hangul and so on go to the default group), then the share of stop words per bundled language.
 * Returns an ISO 639-1 code or null when there is not enough text to say.
 */
export function guessLanguage(text: string): string | null {
  const sample = text.slice(0, 4000);
  if (sample.length < 40) return null;
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return null;
  const count = (re: RegExp) => (sample.match(re) ?? []).length;
  const n = letters.length;
  const scripts: [string, RegExp][] = [
    ["zh", /[一-鿿]/gu], ["ja", /[぀-ヿ]/gu], ["ko", /[가-힯]/gu], ["ru", /[Ѐ-ӿ]/gu],
    ["ar", /[؀-ۿ]/gu], ["el", /[Ͱ-Ͽ]/gu], ["he", /[֐-׿]/gu], ["th", /[฀-๿]/gu], ["hi", /[ऀ-ॿ]/gu],
  ];
  for (const [code, re] of scripts) if (count(re) / n > 0.3) return code;
  const words = sample.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (words.length < 8) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, set] of SETS) {
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    const score = hits / words.length;
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return bestScore >= 0.08 ? best : null;
}
