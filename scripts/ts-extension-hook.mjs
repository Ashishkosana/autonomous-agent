/**
 * Node 22.14 type-stripping loads `.ts` files but does not map a `.js`
 * specifier onto the sibling `.ts` file. This hook does only that, for
 * relative imports, so `npm run agent` can execute the TypeScript sources.
 */
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // The compiled `.js` file exists, or the specifier is not TypeScript.
    }
  }
  return nextResolve(specifier, context);
}
