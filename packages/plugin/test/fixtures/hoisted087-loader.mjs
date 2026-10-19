/**
 * Resolve hook backing hoisted087-register.mjs. The target URL arrives via
 * OPENCODE2DSH_PI_AI_HOISTED_URL (computed by the parent test through its own
 * alias devDependency, so the child needs no network and no node_modules
 * surgery). Every specifier under the package — the main entry AND the
 * `api/openai-completions` / `api/openai-responses` subpaths the adapter
 * imports — must come from the same hoisted copy: in a real DSH profile both
 * resolve to the one root copy, and mixing the Models layer from 0.87.1 with
 * an 0.82.x API module silently re-introduces the tool drop (the normalized
 * transcript's `toolsAdded` is invisible to the old transport).
 */
export async function resolve(specifier, context, nextResolve) {
  const target = process.env.OPENCODE2DSH_PI_AI_HOISTED_URL
  if (target && (specifier === '@earendil-works/pi-ai' || specifier.startsWith('@earendil-works/pi-ai/'))) {
    if (specifier === '@earendil-works/pi-ai') return { url: target, shortCircuit: true }
    const suffix = specifier.slice('@earendil-works/pi-ai'.length)
    // The target is the package's dist/index.js; map subpaths onto the same
    // package root so every module comes from the one copy.
    const packageRoot = new URL('../', target)
    return { url: new URL(`dist${suffix}.js`, packageRoot).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
