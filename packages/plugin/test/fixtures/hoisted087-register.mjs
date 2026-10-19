/**
 * Loader registration for the hoisted-pi-ai-087 drive: hooks the ESM resolver
 * so every '@earendil-works/pi-ai' import in the child process resolves to the
 * 0.87.1 copy pinned by the test-only alias devDependency
 * (@opencode2dsh/pi-ai-0.87). That emulates the DSH profile layout
 * (nodeLinker: hoisted) where the plugin has no nested pi-ai copy and loads
 * whatever single copy the profile hoisted — the layout that exposed #77.
 */
import { register } from 'node:module'

register('./hoisted087-loader.mjs', import.meta.url)
