/**
 * Harny's formatting contract.
 *
 * It DESCRIBES the style the code was already written in by hand — 120 columns,
 * double quotes, semicolons, two-space indent — rather than imposing a new one.
 * Without this file prettier ran on its defaults (80 columns) and every single
 * file in the tree failed `--check`, which is why the old `format` script was a
 * footgun nobody used.
 *
 * `npm run check` runs `prettier --check` on `src/**` so the contract holds.
 * It is a JS config (not .prettierrc) only so this comment can live next to the
 * values: prettier warns about unknown keys in JSON on every single run.
 */
export default {
  printWidth: 120,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  arrowParens: "always",
  endOfLine: "lf",
};
