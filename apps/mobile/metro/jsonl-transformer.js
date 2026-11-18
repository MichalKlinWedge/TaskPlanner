// Plik JSON Lines → `module.exports = [wiersze]`; reszta bez zmian przez transformator Expo.
const upstream = require('@expo/metro-config/babel-transformer');

module.exports.transform = (props) => {
  if (!props.filename.endsWith('.jsonl')) return upstream.transform(props);
  const rows = props.src
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return upstream.transform({ ...props, src: `module.exports = ${JSON.stringify(rows)};` });
};
