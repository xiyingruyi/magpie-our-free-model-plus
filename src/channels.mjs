/**
 * The channels this plugin serves — the entire scope.
 *
 * Shared by the hook surface (which lists models) and the service (which strips anything
 * outside this list from the data it starts against), so both agree on what "in scope"
 * means. Kept dependency-free and separate from either, because both import it.
 *
 * Everything else the upstream slice can do — the anonymous free pool, Kilo, the EAC lane,
 * the 76-provider aggregate registry, combos, token savers, the update checker — is
 * deliberately out of scope. Gemini is excluded on request.
 *
 * @module src/channels.mjs
 */

export const CHANNELS = [
  { id: 'codearts', name: 'CodeArts' },
  { id: 'buddy', name: 'CodeBuddy' },
  { id: 'workbuddy', name: 'WorkBuddy' },
  { id: 'lobsterai', name: 'LobsterAI' },
  { id: 'qoder', name: 'Qoder' },
  { id: 'qodercn', name: 'Qoder 中国版' },
  { id: 'trae', name: 'TRAE' },
  { id: 'cline', name: 'Cline' },
  { id: 'loomy', name: 'Loomy' },
  { id: 'raccoon', name: 'Raccoon' },
  { id: 'minimax', name: 'MiniMax Code' },
  { id: 'zcode', name: 'ZCode' },
]

/** Channel ids as a lookup set. */
export const CHANNEL_IDS = new Set(CHANNELS.map(channel => channel.id))

/**
 * Channels the pack refuses to check in automatically, so this plugin must not either.
 *
 * `zcode` is the pack's own `isAutoCheckinExcluded` — its credits are only given inside the
 * ZCode app, and the pack answers "需手动签到" for it. Asking anyway would put a failure on
 * the provider's card every single day for something that is working exactly as intended.
 */
export const NO_AUTO_CHECKIN = new Set(['zcode'])

/** The channels a daily check-in should actually be attempted on. */
export const CHECKIN_CHANNELS = CHANNELS.map(channel => channel.id).filter(id => !NO_AUTO_CHECKIN.has(id))

/** Is this a model id belonging to one of our account channels? */
export function isChannelModel(id) {
  if (typeof id !== 'string') return false
  const slash = id.indexOf('/')
  return slash > 0 && CHANNEL_IDS.has(id.slice(0, slash))
}

/** The channel a model belongs to, or undefined. */
export function channelOf(id) {
  return isChannelModel(id) ? id.slice(0, id.indexOf('/')) : undefined
}