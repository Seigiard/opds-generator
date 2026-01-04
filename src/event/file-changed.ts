const [path, event] = Bun.argv.slice(2);

console.log(`[file-changed] path=${path} event=${event}`);
