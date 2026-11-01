declare module "css-tree/parser" {
  import type { parse } from "css-tree";
  const p: typeof parse;
  export default p;
}
declare module "css-tree/walker" {
  import type { walk } from "css-tree";
  const w: typeof walk;
  export default w;
}
