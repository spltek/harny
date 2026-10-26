/**
 * Minimal ambient typings for the `prismjs` core API we use (the package ships
 * no types). Full grammar typings are not needed: grammars are plain objects.
 */
declare module "prismjs" {
  export interface PrismGrammar {
    [key: string]: unknown;
  }
  export interface PrismStatic {
    languages: Record<string, PrismGrammar>;
    highlight(text: string, grammar: PrismGrammar, language: string): string;
  }
  const Prism: PrismStatic;
  export default Prism;
}
