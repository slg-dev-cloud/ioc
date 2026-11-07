// Placeholder for commands whose milestone hasn't been built yet.
const [command, milestone] = process.argv.slice(2);
console.error(`\`pnpm ${command}\` is not implemented yet. It arrives in milestone ${milestone} (docs/PHASE1_SPEC.md §11).`);
process.exit(1);
