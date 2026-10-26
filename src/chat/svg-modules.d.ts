/**
 * SVG imports are TEXT, not files: esbuild inlines them with `loader: {".svg":
 * "text"}` and vitest through the svg-as-text plugin, so an icon arrives as a
 * plain markup string (see src/chat/icons.ts and media/icons/README.md).
 */
declare module "*.svg" {
  const markup: string;
  export default markup;
}
