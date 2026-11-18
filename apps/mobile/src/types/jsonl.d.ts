// Pliki `.jsonl` zamienia na tablicę `metro/jsonl-transformer.js`.
declare module '*.jsonl' {
  const rows: unknown[];
  export default rows;
}
