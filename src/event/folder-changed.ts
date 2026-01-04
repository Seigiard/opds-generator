const [parent, name, events] = Bun.argv.slice(2);

console.log(`[folder-changed] parent=${parent} name=${name} events=${events}`);
