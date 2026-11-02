/**
 * The icons a collection can use: names from the lucide set (the web app renders them with lucide-react). A fixed list keeps the
 * stored value safe to render and the picker small. Add a name here and the picker gets it.
 */
export const COLLECTION_ICONS = [
  "folder", "folder-open", "star", "heart", "bookmark", "book", "book-open", "library", "newspaper", "graduation-cap", "flask-conical",
  "microscope", "atom", "globe", "map", "compass", "landmark", "building", "home", "briefcase", "wrench", "hammer", "code", "terminal",
  "cpu", "database", "server", "cloud", "shield", "lock", "key", "lightbulb", "rocket", "plane", "car", "bike", "utensils", "coffee",
  "leaf", "tree-pine", "sun", "moon", "music", "film", "camera", "image", "palette", "pen-tool", "file-text", "archive", "inbox",
  "tag", "flag", "pin", "clock", "calendar", "users", "user", "message-square", "mail", "link", "layers", "package",
] as const;
export type CollectionIcon = (typeof COLLECTION_ICONS)[number];
export const DEFAULT_ICON: CollectionIcon = "folder";
export const FAVOURITES_ICON: CollectionIcon = "star";
export const isIcon = (s: string): s is CollectionIcon => (COLLECTION_ICONS as readonly string[]).includes(s);
