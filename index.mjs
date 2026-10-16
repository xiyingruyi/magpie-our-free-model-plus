/**
 * magpie-our-free-model-plus — host half.
 *
 * A magpie provider plugin that serves the dsh-our-free-model free pools and account
 * channels. Unlike the community port, no Node sidecar is spawned: the upstream
 * standalone slice runs in-process, inside the Bun that magpie already loads plugins
 * with (verified on Bun 1.4.3 — the channel Worker registers all 13 channels there).
 *
 * The shape magpie sees is one provider whose loader points at a loopback service this
 * module starts on first use.
 *
 * @module index.mjs
 */

import { createPlusPlugin } from './src/plugin.mjs'

/**
 * magpie loads every exported function as a plugin, so this file must export exactly one.
 * Helper code lives under ./src and is reached through this function only.
 */
export async function OurFreeModelPlus(input, options = {}) {
  return createPlusPlugin(input, options)
}
