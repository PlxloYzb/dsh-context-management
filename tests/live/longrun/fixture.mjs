// Deterministic multi-episode synthetic corpus, private oracle and public manifest
// for the frozen muse-longrun-v1 protocol (work package W1).
//
// Everything in the generated material derives from
//   HMAC-SHA256(hiddenSalt, `${seed}|${namespace}|${ordinal}`)
// with no Math.random / Date.now anywhere in generated content. Pages are inert
// data: they never address the model, never mention the oracle and never contain
// the literal role prefixes that would make them look like chat messages.
import { createHash, createHmac } from 'node:crypto'

export const PAGES_PER_EPISODE = 12
export const PROTOCOL_ID = 'muse-longrun-v1'
export const CORPUS_SCHEMA_VERSION = 1
export const ORACLE_SCHEMA_VERSION = 1
export const TARGET_PAGE_CODE_POINTS = 7000
export const MIN_PAGE_CODE_POINTS = 6200
export const MAX_PAGE_CODE_POINTS = 7800
export const MIN_INDEPENDENT_RECORD_FRACTION = 0.6
export const ALLOWED_ENDPOINTS = Object.freeze([24, 30, 36, 42, 48])
export const BASE_EPISODES = 24
export const EXTENSION_EPISODES = 6
export const MAXIMUM_EPISODES = 48
export const CATEGORIES = Object.freeze(['state', 'exact', 'source_existence_ambiguity', 'timeline_dependency'])
export const CATEGORY_ORDER = CATEGORIES
export const QUESTIONS_PER_CATEGORY_PER_QUARTILE = 6
export const QUESTIONS_PER_QUARTILE = 24
export const QUESTION_COUNT = 96
export const BATCH_COUNT = 12
export const QUESTIONS_PER_BATCH = 8
export const REQUIRED_LATEST_USER_COUNT = 16
export const LONG_TAIL_REQUIRED_COUNT = 12
export const ISLAND_EPISODE_COUNT = 6
export const SIX_EPISODE_WORK_PACKAGE = Object.freeze([
  'read/diagnose', 'read/diagnose', 'correction',
  'three-file code change', 'dependency action', 'merge validation',
])

// Page text must stay inert. Any hit here is a hard failure of the generator.
export const FORBIDDEN_PAGE_SUBSTRINGS = Object.freeze([
  'system:', 'user:', 'assistant:', 'oracle', 'ignore previous', 'ignore all previous',
  'you must', 'you should', 'as an ai', 'assistant message', 'system prompt', 'instruction:',
])

const SCORED_FIELDS = Object.freeze({
  state: Object.freeze(['value']),
  exact: Object.freeze(['value']),
  source_existence_ambiguity: Object.freeze(['present', 'recordId']),
  timeline_dependency: Object.freeze(['order']),
})

const STATES = ['ready', 'draining', 'retrying', 'healthy', 'warming', 'sealed', 'degraded', 'quiesced']
const SERVICES = ['aperture', 'beacon', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'iris', 'juniper', 'kestrel', 'lumen']
const LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'NOTICE']
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const CURRENCIES = ['TST-A', 'TST-B', 'TST-C', 'TST-D']
const REGIONS = ['north', 'south', 'east', 'west', 'central']
const RELEASES = ['canary', 'shadow', 'staged', 'locked']
const CJK_AREAS = ['华东', '华北', '华南', '西南', '东北']

const EXACT_KINDS = ['checksum', 'path', 'phrase', 'unit']
const SAME_SHORT_ID_EPISODES = Object.freeze([1, 2, 4, 5, 7, 8])
const NEAR_MISS_EXISTENCE_EPISODES = Object.freeze([10, 11, 13, 14, 16, 17])
const SUMMARY_ECHO_EPISODES = Object.freeze([3, 6, 9, 12, 15, 18])
const ABSENT_EPISODES = Object.freeze([19, 20, 21, 22, 23, 24])
const NEAR_MISS_SLOTS = Object.freeze([
  [2, 0], [4, 1], [6, 0], [8, 1], [10, 0], [12, 1],
  [14, 0], [16, 1], [18, 0], [20, 1], [22, 0], [24, 1],
])
const ISLAND_EXACT_KINDS = Object.freeze(['checksum', 'path', 'phrase', 'unit', 'checksum', 'path'])
const ISLAND_EXISTENCE_KINDS = Object.freeze(['absent', 'near_miss', 'same_short_id', 'summary_echo', 'near_miss', 'summary_echo'])
// Mid-run sentinel episodes and their dedicated evidence pages. These offsets
// are reserved: no final-probe material is ever placed on them and they are
// excluded from every bounded existence collection, so sentinel evidence can
// never overlap the sealed 96-question probe at any endpoint.
export const SENTINEL_EPISODES = Object.freeze([6, 12, 18])
export const SENTINEL_OFFSETS = Object.freeze(new Map([
  [6, Object.freeze([4, 7, 9, 10])],
  [12, Object.freeze([4, 7, 11, 12])],
  [18, Object.freeze([4, 7, 11, 12])],
]))
const PACK_FALLBACK_OFFSETS = Object.freeze([5, 6, 3, 8, 1, 2])

const hex = (salt, seed, namespace, ordinal, length = 64) => {
  const digest = createHmac('sha256', String(salt)).update(`${seed}|${namespace}|${ordinal}`).digest('hex')
  return length >= digest.length ? digest : digest.slice(0, length)
}

export function deriveHex(salt, seed, namespace, ordinal, length = 64) {
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('A non-empty hidden salt is required')
  if (!Number.isSafeInteger(seed)) throw new Error('A safe-integer seed is required')
  return hex(salt, seed, String(namespace), String(ordinal), length)
}

const sha256 = value => createHash('sha256').update(value).digest('hex')
const cpLength = value => Array.from(value).length
const asNumber = (value, modulo, base) => (parseInt(value, 16) % modulo) + base
const pick = (list, value, offset = 0) => list[parseInt(value.slice(offset, offset + 4), 16) % list.length]
const chunk = (list, size) => {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

export function quartileOfPage(page, totalPages) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid page number ${page}`)
  if (!Number.isSafeInteger(totalPages) || totalPages % 4 !== 0) throw new Error(`Invalid total page count ${totalPages}`)
  if (page > totalPages) throw new Error(`Page ${page} is past the endpoint's ${totalPages} pages`)
  return Math.floor(((page - 1) * 4) / totalPages)
}

export function episodeCountForEndpoint(endpoint) {
  if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
    throw new Error(`Endpoint ${endpoint} is not one of the precommitted endpoints ${ALLOWED_ENDPOINTS.join('/')}`)
  }
  if ((endpoint * PAGES_PER_EPISODE) % 4 !== 0) throw new Error(`Endpoint ${endpoint} has an indivisible page count`)
  return endpoint
}

// ---------------------------------------------------------------------------
// Material generation
// ---------------------------------------------------------------------------

function entityValue(salt, seed, index, variant, shape) {
  const value = hex(salt, seed, `entity/${index}/value/${variant}`, 0, 16)
  if (shape === 0) return `value-${value.slice(0, 10)}`
  if (shape === 1) return `/srv/release-${value.slice(0, 8)}/config.yaml`
  return `${asNumber(value.slice(0, 4), 900, 100)}ms`
}

function entityValueShape(index) {
  return index % 3
}

function flipHexDigit(value, salt, seed, namespace) {
  const marker = value.indexOf('-')
  const prefix = marker === -1 ? '' : value.slice(0, marker + 1)
  const body = marker === -1 ? value : value.slice(marker + 1)
  const position = asNumber(hex(salt, seed, `${namespace}/position`, 0, 4), body.length, 0)
  const delta = asNumber(hex(salt, seed, `${namespace}/delta`, 0, 4), 15, 1)
  const current = parseInt(body[position], 16)
  const next = (current + delta) % 16
  return prefix + body.slice(0, position) + next.toString(16) + body.slice(position + 1)
}

function exactValue(salt, seed, namespace, kind) {
  const value = hex(salt, seed, `${namespace}/value`, 0, 64)
  if (kind === 'checksum') return `sha256-${value.slice(0, 32)}`
  if (kind === 'path') {
    return `/srv/${CJK_AREAS[asNumber(value.slice(0, 4), CJK_AREAS.length, 0)]}/release-${value.slice(4, 12)}/file-${value.slice(12, 20)}.yaml`
  }
  if (kind === 'phrase') return `冻结窗口-${value.slice(20, 28)} release-${value.slice(28, 36)}`
  return `maxRisk=${asNumber(value.slice(36, 40), 13, 11)};unitFee=${asNumber(value.slice(40, 44), 7, 2)}`
}

function timelineKind(episode) {
  const mapped = ((episode - 1) % BASE_EPISODES) + 1
  if ([7, 9, 11, 13, 15, 17, 19, 21].includes(mapped)) return 'span'
  if ([8, 12, 16, 20].includes(mapped)) return 'fan_in'
  if ([2, 10, 14, 22].includes(mapped)) return 'exclusive'
  return 'ordered'
}

function existenceKind(episode) {
  if (SAME_SHORT_ID_EPISODES.includes(episode)) return 'same_short_id'
  if (NEAR_MISS_EXISTENCE_EPISODES.includes(episode)) return 'near_miss'
  if (SUMMARY_ECHO_EPISODES.includes(episode)) return 'summary_echo'
  if (ABSENT_EPISODES.includes(episode)) return 'absent'
  const cycle = ['absent', 'near_miss', 'summary_echo']
  return cycle[(episode - (BASE_EPISODES + 1)) % cycle.length]
}

function generateMaterial({ salt, seed, episodes }) {
  const pageLines = new Map()
  const pageCollections = new Map()
  const addPageLine = (page, line) => {
    if (!pageLines.has(page)) pageLines.set(page, [])
    pageLines.get(page).push(line)
  }
  const addCollection = (page, collectionId) => {
    if (pageCollections.has(page)) {
      const list = pageCollections.get(page)
      if (!list.includes(collectionId)) list.push(collectionId)
    } else pageCollections.set(page, [collectionId])
  }
  const recordId = (namespace, ordinal) => `REC-${hex(salt, seed, `${namespace}/record`, ordinal, 12)}`
  const pageOf = (episode, offset) => (episode - 1) * PAGES_PER_EPISODE + offset

  const entities = []
  const timelines = []
  const exacts = []
  const existences = []
  const actions = []
  const similarIdPairs = []
  const shortIdCollisions = []
  const briefs = []
  const workItems = []
  const islandPages = new Set()
  const islandExact = []
  const islandExistence = []
  const sentinels = []
  const entityIds = new Set()
  const nearMissIds = new Set()
  const emittedValues = new Set()

  const nearMissSlots = new Set(NEAR_MISS_SLOTS.map(([episode, slot]) => `${episode}:${slot}`))

  // Entity identifiers are precomputed for the whole corpus so near-miss
  // variants can be checked against every real identifier, not just the ones
  // generated before them.
  const entityIdByIndex = []
  for (let index = 0; index < episodes * 2; index += 1) {
    let entityId = `ENT-${hex(salt, seed, `entity/${index}/id`, 0, 12)}`
    let attempt = 0
    while (entityIds.has(entityId)) {
      attempt += 1
      entityId = `ENT-${hex(salt, seed, `entity/${index}/id`, attempt, 12)}`
    }
    entityIds.add(entityId)
    entityIdByIndex.push(entityId)
  }

  for (let episode = 1; episode <= episodes; episode += 1) {
    const episodeBriefLines = []
    const episodeEntities = []
    const reservedOffsets = SENTINEL_OFFSETS.get(episode) ?? []
    // Regular evidence never occupies a reserved sentinel page; records that
    // would land there are packed onto other pages of the same episode.
    const packOffset = preferred => {
      if (!reservedOffsets.includes(preferred)) return preferred
      return PACK_FALLBACK_OFFSETS.find(offset => !reservedOffsets.includes(offset)) ?? preferred
    }
    const regularPage = offset => (episode - 1) * PAGES_PER_EPISODE + packOffset(offset)
    const islandArchivePage = offset => (episode - 1) * PAGES_PER_EPISODE + offset

    // --- two state entities per episode -----------------------------------
    for (let slot = 0; slot < 2; slot += 1) {
      const index = (episode - 1) * 2 + slot
      const namespace = `entity/${index}`
      const entityId = entityIdByIndex[index]
      const kind = slot === 0
        ? (episode % 3 !== 0 ? 'correction' : 'ordinary')
        : (episode % 3 === 0 ? 'revocation' : 'ordinary')
      const shape = entityValueShape(index)
      const entity = {
        entityId,
        publicLabel: `STATE-${hex(salt, seed, `${namespace}/label`, 0, 8)}`,
        shortId: entityId.slice(4, 8),
        kind,
        valueShape: shape,
        updates: [],
        episode,
        orderKey: index,
        suspectedAlias: false,
      }
      const originalValue = entityValue(salt, seed, index, 'original', shape)
      entity.originalValue = originalValue
      const originalPage = regularPage(slot === 0 ? 1 : 2)
      const originalRecord = recordId(namespace, 'original')
      entity.updates.push({
        role: 'original', page: originalPage, recordId: originalRecord,
        value: originalValue, authority: 'authoritative', effectiveSeq: index * 100 + 1,
      })
      addPageLine(originalPage, `record ${originalRecord} entity=${entityId} short=${entity.shortId} value="${originalValue}" state=active authority=authoritative effective-seq=${index * 100 + 1} role=initial-fact`)

      if (kind === 'correction') {
        for (let step = 1; step <= 2; step += 1) {
          const value = entityValue(salt, seed, index, `update${step}`, shape)
          const page = regularPage(step === 1 ? 4 : 7)
          const record = recordId(namespace, `update${step}`)
          const previous = entity.updates[entity.updates.length - 1].recordId
          entity.updates.push({
            role: 'correction', page, recordId: record, value,
            authority: 'latest-user-correction', effectiveSeq: index * 100 + 1 + step, supersedes: previous,
          })
          addPageLine(page, `record ${record} entity=${entityId} short=${entity.shortId} value="${value}" state=active authority=latest-user-correction effective-seq=${index * 100 + 1 + step} role=user-correction supersedes=${previous}`)
          episodeBriefLines.push(`- ${entityId} (short ${entity.shortId}) user correction ${step}: latest effective value "${value}" (effective-seq ${index * 100 + 1 + step}) supersedes ${previous}.`)
        }
        const staleValue = entityValue(salt, seed, index, 'original', shape)
        addPageLine(regularPage(10), `record ${recordId(namespace, 'stale')} entity=${entityId} short=${entity.shortId} value="${staleValue}" authority=stale-historical-text effective-seq=${index * 100 + 1} role=superseded-note note=kept-for-history`)
      }

      if (kind === 'revocation') {
        const revokedPage = regularPage(5)
        const restoredPage = regularPage(9)
        const revokedRecord = recordId(namespace, 'revoked')
        const restoredValue = entityValue(salt, seed, index, 'restored', shape)
        const restoredRecord = recordId(namespace, 'restored')
        entity.updates.push({
          role: 'revoked', page: revokedPage, recordId: revokedRecord, value: null,
          authority: 'latest-user-correction', effectiveSeq: index * 100 + 2, supersedes: originalRecord,
        })
        addPageLine(revokedPage, `record ${revokedRecord} entity=${entityId} short=${entity.shortId} state=revoked authority=latest-user-correction effective-seq=${index * 100 + 2} role=revocation supersedes=${originalRecord}`)
        entity.updates.push({
          role: 'restored', page: restoredPage, recordId: restoredRecord, value: restoredValue,
          authority: 'latest-user-correction', effectiveSeq: index * 100 + 3, supersedes: revokedRecord,
        })
        addPageLine(restoredPage, `record ${restoredRecord} entity=${entityId} short=${entity.shortId} value="${restoredValue}" state=restored authority=latest-user-correction effective-seq=${index * 100 + 3} role=restoration supersedes=${revokedRecord}`)
        addPageLine(regularPage(10), `record ${recordId(namespace, 'stale')} entity=${entityId} short=${entity.shortId} value="${originalValue}" authority=stale-historical-text effective-seq=${index * 100 + 1} role=superseded-note note=pre-revocation-value`)
        episodeBriefLines.push(`- ${entityId} (short ${entity.shortId}) user revocation then restoration: state revoked at effective-seq ${index * 100 + 2}, restored effective value "${restoredValue}" at effective-seq ${index * 100 + 3}.`)
      }

      entity.latestRecord = entity.updates[entity.updates.length - 1]
      entity.latestValue = entity.latestRecord.value
      entity.latestPage = entity.latestRecord.page
      entity.twiceUpdated = kind === 'correction'
      entity.revocationRestoration = kind === 'revocation'
      entity.nearMiss = null
      episodeEntities.push(entity)
      entities.push(entity)

      emittedValues.add(originalValue)
      for (const update of entity.updates) if (typeof update.value === 'string') emittedValues.add(update.value)
    }

    // --- shared short identifier collisions --------------------------------
    if (SAME_SHORT_ID_EPISODES.includes(episode)) {
      const [first, second] = episodeEntities
      second.shortId = first.shortId
      second.suspectedAlias = true
      const page = second.updates[0].page
      const record = second.updates[0].recordId
      addPageLine(page, `record ${record} alias-record entity=${second.entityId} short=${second.shortId} value="${second.originalValue}" authority=suspected-alias role=ambiguous-short-id note=same-short-different-entity authoritative=${first.entityId}`)
      shortIdCollisions.push({
        episode,
        shortId: first.shortId,
        authoritativeEntityId: first.entityId,
        authoritativeRecordId: first.latestRecord.recordId,
        aliasEntityId: second.entityId,
        aliasRecordId: record,
      })
    }

    // --- 12 similar-ID pairs (single hex digit apart) ----------------------
    for (let slot = 0; slot < 2; slot += 1) {
      if (!nearMissSlots.has(`${episode}:${slot}`)) continue
      const entity = episodeEntities[slot]
      let nearMissId = flipHexDigit(entity.entityId, salt, seed, `nearmiss/${entity.entityId}`)
      let attempt = 0
      while (entityIds.has(nearMissId) || nearMissIds.has(nearMissId)) {
        attempt += 1
        nearMissId = flipHexDigit(entity.entityId, salt, seed, `nearmiss/${entity.entityId}/${attempt}`)
      }
      nearMissIds.add(nearMissId)
      const page = regularPage(3)
      addPageLine(page, `record ${recordId(`nearmiss/${entity.entityId}`, 'suspect')} entity=${nearMissId} short=${nearMissId.slice(4, 8)} value="${entityValue(salt, seed, entity.orderKey, 'suspect', entity.valueShape)}" authority=suspected-near-miss role=similar-id-candidate note=not-authoritative close-to=${entity.entityId}`)
      entity.nearMiss = { nearMissId, page }
      similarIdPairs.push({
        pairId: `NEAR-${hex(salt, seed, `nearmiss/${entity.entityId}/pair`, 0, 8)}`,
        episode,
        authoritativeEntityId: entity.entityId,
        nearMissId,
        sourcePage: page,
        hammingDistance: 1,
      })
    }

    // --- timeline / dependency relation ------------------------------------
    const relationKind = timelineKind(episode)
    const relationId = `REL-${hex(salt, seed, `timeline/${episode}/id`, 0, 8)}`
    const label = `TML-${hex(salt, seed, `timeline/${episode}/label`, 0, 8)}`
    const eventId = ordinal => `EV-${hex(salt, seed, `timeline/${episode}/event/${ordinal}`, 0, 8)}`
    const relation = { relationId, label, kind: relationKind, episode, events: [], sourcePages: [] }
    if (relationKind === 'span') {
      const startEpisode = episode - 6
      const first = { id: eventId('a'), page: pageOf(startEpisode, 3), seq: 1, episode: startEpisode }
      const second = { id: eventId('b'), page: pageOf(startEpisode, 6), seq: 2, episode: startEpisode }
      const third = { id: eventId('c'), page: regularPage(9), seq: 3, episode }
      relation.events = [first, second, third]
      addPageLine(first.page, `event ${first.id} relation=${label} seq=1 occurs-after=none episode=${startEpisode}`)
      addPageLine(second.page, `event ${second.id} relation=${label} seq=2 occurs-after=${first.id} episode=${startEpisode}`)
      addPageLine(third.page, `event ${third.id} relation=${label} seq=3 occurs-after=${second.id} episode=${episode}`)
    } else if (relationKind === 'fan_in') {
      const predecessors = [1, 2, 3].map(seq => ({ id: eventId(`p${seq}`), page: regularPage(seq * 3), seq, episode }))
      const result = { id: eventId('r'), page: regularPage(12), seq: 4, episode }
      relation.events = [...predecessors, result]
      relation.resultId = result.id
      for (const predecessor of predecessors) {
        addPageLine(predecessor.page, `event ${predecessor.id} relation=${label} seq=${predecessor.seq} occurs-after=none fan-in-target=${result.id} episode=${episode}`)
      }
      addPageLine(result.page, `event ${result.id} relation=${label} seq=4 occurs-after=${predecessors.map(p => p.id).join(',')} fan-in-of=${predecessors.map(p => p.id).join(',')} episode=${episode}`)
    } else if (relationKind === 'exclusive') {
      const options = [1, 2, 3].map(seq => {
        const approved = seq === asNumber(hex(salt, seed, `timeline/${episode}/approved`, 0, 4), 3, 1)
        return { id: eventId(`o${seq}`), page: regularPage(seq * 3), seq, approved, episode }
      })
      relation.events = options
      relation.approvedId = options.find(option => option.approved).id
      for (const option of options) {
        addPageLine(option.page, `event ${option.id} relation=${label} seq=${option.seq} mutually-exclusive-group=${label} approved=${option.approved} episode=${episode}`)
      }
    } else {
      const events = [1, 2, 3].map(seq => ({ id: eventId(`s${seq}`), page: regularPage(seq * 3), seq, episode }))
      relation.events = events
      for (const event of events) {
        addPageLine(event.page, `event ${event.id} relation=${label} seq=${event.seq} occurs-after=${event.seq === 1 ? 'none' : events[event.seq - 2].id} episode=${episode}`)
      }
    }
    relation.sourcePages = [...new Set(relation.events.map(event => event.page))].sort((a, b) => a - b)
    relation.finalPage = relation.sourcePages[relation.sourcePages.length - 1]
    relation.answer = relationKind === 'exclusive'
      ? [relation.approvedId]
      : relation.events.map(event => event.id)
    timelines.push(relation)

    // --- two regular exact targets per episode -----------------------------
    for (let slot = 0; slot < 2; slot += 1) {
      const globalIndex = (episode - 1) * 2 + slot
      const kind = EXACT_KINDS[globalIndex % EXACT_KINDS.length]
      const targetLabel = `EXACT-${hex(salt, seed, `exact/${episode}/${slot}/label`, 0, 8)}`
      const namespace = `exact/${episode}/${slot}`
      const multiSource = (episode + slot) % 2 === 1
      const target = {
        targetLabel, kind, episode, slot, multiSource,
        sourcePages: [], recordIds: [], value: null, island: false,
      }
      if (multiSource) {
        const partA = exactValue(salt, seed, `${namespace}/partA`, kind === 'unit' ? 'unit' : 'path')
        const partB = exactValue(salt, seed, `${namespace}/partB`, kind === 'unit' ? 'path' : 'unit')
        const pageA = regularPage(3)
        const pageB = regularPage(8)
        const recordA = recordId(namespace, 'partA')
        const recordB = recordId(namespace, 'partB')
        target.value = `${partA}|${partB}`
        target.sourcePages = [pageA, pageB]
        target.recordIds = [recordA, recordB]
        addPageLine(pageA, `target ${targetLabel} part=1 order=1 value="${partA}" authority=authoritative record=${recordA} assemble-separator="|" assemble-order=1,2`)
        addPageLine(pageB, `target ${targetLabel} part=2 order=2 value="${partB}" authority=authoritative record=${recordB} assemble-separator="|" assemble-order=1,2`)
      } else {
        const value = exactValue(salt, seed, namespace, kind)
        const page = regularPage(slot === 0 ? 5 : 10)
        const record = recordId(namespace, 'single')
        target.value = value
        target.sourcePages = [page]
        target.recordIds = [record]
        addPageLine(page, `target ${targetLabel} value="${value}" authority=authoritative kind=${kind} record=${record}`)
      }
      target.finalPage = target.sourcePages[target.sourcePages.length - 1]
      exacts.push(target)
      emittedValues.add(target.value)
    }

    // --- existence / ambiguity group ---------------------------------------
    const regularCollection = `COL-${hex(salt, seed, `existence/${episode}/collection`, 0, 8)}`
    const regularOffsets = (episode <= ISLAND_EPISODE_COUNT
      ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    ).filter(offset => !reservedOffsets.includes(offset))
    const regularPages = regularOffsets.map(offset => regularPage(offset))
    for (const page of regularPages) addCollection(page, regularCollection)
    const regularKind = existenceKind(episode)
    const existenceGroup = {
      groupId: `EXIST-${hex(salt, seed, `existence/${episode}/id`, 0, 8)}`,
      kind: regularKind,
      episode,
      collectionId: regularCollection,
      sourcePages: regularPages.slice(),
      field: null,
      queryValue: null,
      island: false,
      answerPresent: false,
      answerRecordId: null,
      authoritativeEntityId: null,
      aliasEntityId: null,
    }
    if (regularKind === 'same_short_id') {
      const collision = shortIdCollisions.find(entry => entry.episode === episode)
      existenceGroup.field = 'short'
      existenceGroup.queryValue = collision.shortId
      existenceGroup.answerPresent = true
      existenceGroup.answerRecordId = collision.authoritativeRecordId
      existenceGroup.authoritativeEntityId = collision.authoritativeEntityId
      existenceGroup.aliasEntityId = collision.aliasEntityId
    } else if (regularKind === 'near_miss') {
      const anchorValue = `sha256-${hex(salt, seed, `existence/${episode}/anchor`, 0, 32)}`
      const anchorRecord = recordId(`existence/${episode}`, 'anchor')
      const anchorPage = regularPage(6)
      addPageLine(anchorPage, `record ${anchorRecord} checksum=${anchorValue} authority=authoritative role=checksum-anchor collection=${regularCollection}`)
      emittedValues.add(anchorValue)
      existenceGroup.field = 'checksum'
      existenceGroup.queryValue = flipHexDigit(anchorValue, salt, seed, `existence/${episode}/nearmiss`)
    } else if (regularKind === 'summary_echo') {
      const echoValue = `value-${hex(salt, seed, `existence/${episode}/echo`, 0, 10)}`
      const echoRecord = recordId(`existence/${episode}`, 'echo')
      addPageLine(regularPage(10), `echo-record ${echoRecord} recalled-summary-value="${echoValue}" authority=echo role=summary-echo archived-window=prior note=not-authoritative collection=${regularCollection}`)
      existenceGroup.field = 'value'
      existenceGroup.queryValue = echoValue
    } else {
      existenceGroup.field = 'checksum'
      existenceGroup.queryValue = `sha256-${hex(salt, seed, `existence/${episode}/absent`, 0, 32)}`
    }
    existenceGroup.finalPage = existenceGroup.sourcePages[existenceGroup.sourcePages.length - 1]
    existences.push(existenceGroup)

    // --- synthetic action with a fixed idempotency key ---------------------
    const previous = index => (index >= 1 ? actions.find(action => action.episode === index) : null)
    const preconditions = [1, 2, 3].map(offset => {
      const prior = previous(episode - offset)
      return prior ? prior.actionId : 'state:baseline'
    })
    const action = {
      actionId: `ACT-${hex(salt, seed, `action/${episode}/id`, 0, 8)}`,
      idempotencyKey: hex(salt, seed, `action/${episode}/key`, 0, 16),
      episode,
      page: regularPage(8),
      preconditions,
      finalState: {
        release: `release-${hex(salt, seed, `action/${episode}/release`, 0, 8)}`,
        status: 'applied',
        revision: episode,
      },
    }
    addPageLine(action.page, `action ${action.actionId} idempotency-key=${action.idempotencyKey} precondition-1=${preconditions[0]} precondition-2=${preconditions[1]} precondition-3=${preconditions[2]} final-state=${JSON.stringify(action.finalState)} role=workflow-step applies-once=true`)
    actions.push(action)

    // --- island material for the earliest quartile -------------------------
    if (episode <= ISLAND_EPISODE_COUNT) {
      const exactPage = islandArchivePage(11)
      const existencePage = islandArchivePage(12)
      islandPages.add(exactPage)
      islandPages.add(existencePage)

      const islandKind = ISLAND_EXACT_KINDS[episode - 1]
      const islandLabel = `EXACT-ISL-${hex(salt, seed, `exact/island/${episode}/label`, 0, 8)}`
      const islandNamespace = `exact/island/${episode}`
      const islandValue = exactValue(salt, seed, islandNamespace, islandKind)
      const islandRecord = recordId(islandNamespace, 'single')
      addPageLine(exactPage, `target ${islandLabel} value="${islandValue}" authority=authoritative kind=${islandKind} record=${islandRecord} island=${episode}`)
      const islandTarget = {
        targetLabel: islandLabel, kind: islandKind, episode, slot: 2, multiSource: false,
        sourcePages: [exactPage], recordIds: [islandRecord], value: islandValue, island: true,
        finalPage: exactPage,
      }
      exacts.push(islandTarget)
      islandExact.push(islandTarget)
      emittedValues.add(islandValue)

      const islandCollection = `COL-ISL-${hex(salt, seed, `existence/island/${episode}/collection`, 0, 8)}`
      addCollection(existencePage, islandCollection)
      const islandExistenceKind = ISLAND_EXISTENCE_KINDS[episode - 1]
      const islandGroup = {
        groupId: `EXIST-ISL-${hex(salt, seed, `existence/island/${episode}/id`, 0, 8)}`,
        kind: islandExistenceKind,
        episode,
        collectionId: islandCollection,
        sourcePages: [existencePage],
        field: null,
        queryValue: null,
        island: true,
        answerPresent: false,
        answerRecordId: null,
        finalPage: existencePage,
      }
      if (islandExistenceKind === 'near_miss') {
        const anchor = `sha256-${hex(salt, seed, `existence/island/${episode}/anchor`, 0, 32)}`
        addPageLine(existencePage, `record ${recordId(`existence/island/${episode}`, 'anchor')} checksum=${anchor} authority=authoritative role=checksum-anchor island=${episode}`)
        emittedValues.add(anchor)
        islandGroup.field = 'checksum'
        islandGroup.queryValue = flipHexDigit(anchor, salt, seed, `existence/island/${episode}/nearmiss`)
      } else if (islandExistenceKind === 'same_short_id') {
        const sharedShort = `S${episode}${hex(salt, seed, `existence/island/${episode}/short`, 0, 4)}`
        const authoritativeId = `ENT-ISL-${hex(salt, seed, `existence/island/${episode}/entityA`, 0, 8)}`
        const aliasId = `ENT-ISL-${hex(salt, seed, `existence/island/${episode}/entityB`, 0, 8)}`
        const authoritativeRecord = recordId(`existence/island/${episode}`, 'entityA')
        const authoritativeValue = `value-${hex(salt, seed, `existence/island/${episode}/valueA`, 0, 10)}`
        addPageLine(existencePage, `record ${authoritativeRecord} entity=${authoritativeId} short=${sharedShort} value="${authoritativeValue}" authority=authoritative role=short-id-owner island=${episode}`)
        addPageLine(existencePage, `record ${recordId(`existence/island/${episode}`, 'entityB')} entity=${aliasId} short=${sharedShort} value="value-${hex(salt, seed, `existence/island/${episode}/valueB`, 0, 10)}" authority=suspected-alias role=ambiguous-short-id note=same-short-different-entity authoritative=${authoritativeId} island=${episode}`)
        emittedValues.add(authoritativeValue)
        islandGroup.field = 'short'
        islandGroup.queryValue = sharedShort
        islandGroup.answerPresent = true
        islandGroup.answerRecordId = authoritativeRecord
        islandGroup.authoritativeEntityId = authoritativeId
        islandGroup.aliasEntityId = aliasId
      } else if (islandExistenceKind === 'summary_echo') {
        const echo = `value-${hex(salt, seed, `existence/island/${episode}/echo`, 0, 10)}`
        addPageLine(existencePage, `echo-record ${recordId(`existence/island/${episode}`, 'echo')} recalled-summary-value="${echo}" authority=echo role=summary-echo archived-window=prior note=not-authoritative island=${episode}`)
        islandGroup.field = 'value'
        islandGroup.queryValue = echo
      } else {
        islandGroup.field = 'checksum'
        islandGroup.queryValue = `sha256-${hex(salt, seed, `existence/island/${episode}/absent`, 0, 32)}`
      }
      existences.push(islandGroup)
      islandExistence.push(islandGroup)
    }

    // --- mid-run sentinel material on reserved pages -----------------------
    if (SENTINEL_EPISODES.includes(episode)) {
      const sentinelQuestionsForEpisode = []
      const sentinelEntityId = `ENT-S${episode}-1`
      const sentinelValue = `sentinel-value-${hex(salt, seed, `sentinel/${episode}/state`, 0, 10)}`
      const sentinelNamespace = `sentinel/${episode}`
      const sentinelRecord = recordId(sentinelNamespace, 'state')
      const statePage = pageOf(episode, reservedOffsets[0])
      addPageLine(statePage, `record ${sentinelRecord} entity=${sentinelEntityId} short=S${episode}1 value="${sentinelValue}" state=active authority=authoritative effective-seq=1 sentinel=${episode}`)
      sentinelQuestionsForEpisode.push({
        queryId: `S${episode}-Q1`,
        category: 'state',
        subtype: 'sentinel_state',
        requiredLatestUser: false,
        longTailRequired: false,
        targetLabel: `STATE-S${episode}-1`,
        question: `[S${episode}-Q1] Mid-campaign check: report the current authoritative value of state entity STATE-S${episode}-1. Answer with one JSON object of the shape {"value": "<verbatim string>"}.`,
        oracle: { expected: { value: sentinelValue }, answerKind: 'value', notes: `mid-run sentinel for episode ${episode}` },
        evidence: { sourcePages: [statePage], recordIds: [sentinelRecord] },
        sourcePosition: { finalSourcePage: statePage, lastSourceEventPage: statePage },
        island: true,
        sentinel: true,
        sentinelEpisode: episode,
      })

      const sentinelTargetLabel = `EXACT-S${episode}-2`
      const sentinelTargetValue = exactValue(salt, seed, `${sentinelNamespace}/exact`, 'path')
      const sentinelTargetRecord = recordId(sentinelNamespace, 'exact')
      const exactPage = pageOf(episode, reservedOffsets[1])
      addPageLine(exactPage, `target ${sentinelTargetLabel} value="${sentinelTargetValue}" authority=authoritative kind=path record=${sentinelTargetRecord} sentinel=${episode}`)
      sentinelQuestionsForEpisode.push({
        queryId: `S${episode}-Q2`,
        category: 'exact',
        subtype: 'sentinel_exact',
        requiredLatestUser: false,
        longTailRequired: false,
        targetLabel: sentinelTargetLabel,
        question: `[S${episode}-Q2] Mid-campaign check: report the exact archive value recorded for target ${sentinelTargetLabel}. Answer with one JSON object of the shape {"value": "<verbatim string>"}.`,
        oracle: { expected: { value: sentinelTargetValue }, answerKind: 'value', notes: `mid-run sentinel for episode ${episode}` },
        evidence: { sourcePages: [exactPage], recordIds: [sentinelTargetRecord] },
        sourcePosition: { finalSourcePage: exactPage, lastSourceEventPage: exactPage },
        island: true,
        sentinel: true,
        sentinelEpisode: episode,
      })

      const sentinelCollection = `COL-S${episode}-3`
      const sentinelAbsentValue = `sha256-${hex(salt, seed, `${sentinelNamespace}/absent`, 0, 32)}`
      const existencePage = pageOf(episode, reservedOffsets[2])
      addCollection(existencePage, sentinelCollection)
      addPageLine(existencePage, `record ${recordId(sentinelNamespace, 'present')} checksum=sha256-${hex(salt, seed, `${sentinelNamespace}/present`, 0, 32)} authority=authoritative role=checksum-anchor sentinel=${episode}`)
      sentinelQuestionsForEpisode.push({
        queryId: `S${episode}-Q3`,
        category: 'source_existence_ambiguity',
        subtype: 'sentinel_absent',
        requiredLatestUser: false,
        longTailRequired: false,
        targetLabel: `EXIST-S${episode}-3`,
        question: `[S${episode}-Q3] Mid-campaign check: restrict the lookup to the precommitted archive collection ${sentinelCollection}. Does an authoritative record with checksum=${sentinelAbsentValue} exist inside that collection? Answer with one JSON object of the shape {"present": true|false, "recordId": "<record id>"|null}.`,
        oracle: { expected: { present: false, recordId: null }, answerKind: 'absent', notes: `mid-run sentinel for episode ${episode}` },
        evidence: { sourcePages: [existencePage], recordIds: [] },
        sourcePosition: { finalSourcePage: existencePage, lastSourceEventPage: existencePage },
        island: true,
        sentinel: true,
        sentinelEpisode: episode,
        sourceScope: sentinelCollection,
      })

      const sentinelLabel = `TML-S${episode}-4`
      const sentinelEvents = [1, 2, 3].map(seq => ({
        id: `EV-S${episode}-4-${seq}`,
        page: pageOf(episode, reservedOffsets[3]),
        seq,
      }))
      for (const event of sentinelEvents) {
        addPageLine(event.page, `event ${event.id} relation=${sentinelLabel} seq=${event.seq} occurs-after=${event.seq === 1 ? 'none' : sentinelEvents[event.seq - 2].id} sentinel=${episode}`)
      }
      sentinelQuestionsForEpisode.push({
        queryId: `S${episode}-Q4`,
        category: 'timeline_dependency',
        subtype: 'sentinel_ordered',
        requiredLatestUser: false,
        longTailRequired: false,
        targetLabel: sentinelLabel,
        question: `[S${episode}-Q4] Mid-campaign check: report the complete ordered event sequence for dependency relation ${sentinelLabel}, earliest event first. Answer with one JSON object of the shape {"order": ["<identifier>", "..."]}.`,
        oracle: { expected: { order: sentinelEvents.map(event => event.id) }, answerKind: 'order', notes: `mid-run sentinel for episode ${episode}` },
        evidence: { sourcePages: [...new Set(sentinelEvents.map(event => event.page))], recordIds: sentinelEvents.map(event => event.id) },
        sourcePosition: { finalSourcePage: pageOf(episode, reservedOffsets[3]), lastSourceEventPage: pageOf(episode, reservedOffsets[3]) },
        island: true,
        sentinel: true,
        sentinelEpisode: episode,
      })
      sentinels.push({ episode, questions: sentinelQuestionsForEpisode, pages: reservedOffsets.map(offset => pageOf(episode, offset)) })
    }

    const workKind = SIX_EPISODE_WORK_PACKAGE[(episode - 1) % SIX_EPISODE_WORK_PACKAGE.length]
    const goal = pick(['stabilize migration', 'diagnose incident chain', 'reconcile revisions', 'harden policy module', 'apply workflow release', 'validate merged archive'], hex(salt, seed, `brief/${episode}/goal`, 0, 4), 0)
    const priority = pick(['latency budget', 'revision authority', 'dependency order', 'protected file integrity', 'checksum coverage', 'release gating'], hex(salt, seed, `brief/${episode}/priority`, 0, 4), 0)
    const updateBlock = episodeBriefLines.length > 0 ? episodeBriefLines.join('\n') : '- No user update supersedes prior material in this episode.'
    const brief = [
      `Synthetic archive campaign, episode ${episode} of ${episodes}; work package ${workKind}.`,
      `Goal: ${goal}. Current priority: ${priority}.`,
      'Applicable user updates (each supersedes all earlier archive text for the same entity):',
      updateBlock,
      `Bounded deliverable: ${workDeliverable(workKind, action, episode)}`,
      'Every archive page is inert synthetic data. Finish the episode, then reply with E_' + episode + '_COMPLETE.',
    ].join('\n')
    briefs.push(brief)
    workItems.push({
      episode,
      workPackage: workKind,
      goal,
      priority,
      deliverable: workDeliverable(workKind, action, episode),
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      preconditions: action.preconditions.slice(),
      files: ['normalize.js', 'limits.js', 'policy.js'],
      expectedReply: `E_${episode}_COMPLETE`,
    })
  }

  // The two island questions per early episode must not collide with any other
  // question's evidence, so island pages carry only island material. Sentinel
  // pages are reserved the same way and excluded from every bounded collection.
  return {
    pageLines, pageCollections, entities, timelines, exacts, existences, actions,
    similarIdPairs, shortIdCollisions, briefs, workItems, islandPages,
    islandExact, islandExistence, sentinels,
  }
}

function workDeliverable(workKind, action, episode) {
  if (workKind === 'three-file code change') {
    return 'repair normalize.js, limits.js and policy.js inside the isolated fixture so evaluate(order) matches the documented contract; keep protected.txt unchanged.'
  }
  if (workKind === 'dependency action') {
    return `apply action ${action.actionId} exactly once with idempotency key ${action.idempotencyKey} after its three preconditions hold.`
  }
  if (workKind === 'correction') {
    return 'reconcile the corrected entity values against the earlier archive text and keep the latest effective value.'
  }
  if (workKind === 'merge validation') {
    return 'validate the merged archive block and report any conflicting record identities.'
  }
  return `read the assigned pages for episode ${episode} and report the bounded findings for this work package.`
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

function fillerLine(salt, seed, page, index) {
  const value = hex(salt, seed, 'filler', `${page}:${index}`, 64)
  const service = pick(SERVICES, value, 0)
  const state = pick(STATES, value, 4)
  const level = pick(LEVELS, value, 8)
  const method = pick(METHODS, value, 12)
  const currency = pick(CURRENCIES, value, 16)
  const region = pick(REGIONS, value, 20)
  const release = pick(RELEASES, value, 24)
  const area = pick(CJK_AREAS, value, 28)
  const number = asNumber(value.slice(32, 36), 900, 10)
  const quantity = asNumber(value.slice(36, 40), 500, 1)
  const flag = asNumber(value.slice(40, 44), 2, 0) === 1
  switch (index % 9) {
    case 0:
      return `observation ${page}.${index}: service=${service} trace=${value.slice(0, 12)} checksum=${value.slice(12, 22)} latency=${number}ms state=${state} previous=${value.slice(22, 32)} replicas=${(number % 7) + 1}`
    case 1:
      return `log ${page}.${index}: level=${level} component=${service} event=EV-${value.slice(0, 8)} seq=${number} duration=${(number % 300) + 5}ms message=stage-${release}-${region}`
    case 2:
      return `api ${method} /v1/${service}/${value.slice(4, 12)} status=${[200, 201, 202, 204, 400, 404, 409, 429, 500, 503][number % 10]} duration=${(number % 480) + 20}ms request-id=${value.slice(12, 24)}`
    case 3:
      return `workflow WF-${value.slice(0, 8)} step=${(number % 9) + 1} depends-on=WF-${value.slice(8, 16)} state=${state} retries=${number % 4} release=${release}`
    case 4:
      return `记录 path=${page}.${index} 路径=/数据/${area}/发布-${value.slice(0, 8)}/配置-${value.slice(8, 16)}.yaml 字节=${number * 13} 校验和=${value.slice(16, 32)} 区域=${region}`
    case 5:
      return `unit ${page}.${index}: quantity=${quantity} currency=${currency} region=zone-${value.slice(0, 6)} unit-fee=${(number % 40) + 3} tier=${release}`
    case 6:
      return `metric ${page}.${index}: name=cpu_${service}_${number % 64} value=${(number % 100)}.${value.slice(0, 3)} window=${(number % 300) + 30}s region=${region}`
    case 7:
      return `dependency DEP-${value.slice(0, 8)} requires=DEP-${value.slice(8, 16)} must-precede=DEP-${value.slice(16, 24)} satisfied=${flag} component=${service}`
    default:
      return `index ${page}.${index}: block=${value.slice(0, 8)} start-seq=${number * 7} end-seq=${number * 7 + 63} parent=${value.slice(8, 16)} archive-role=history source=${release}`
  }
}

function renderPage({ salt, seed, episode, offset, page, partition, collections, evidence }) {
  const headerParts = [`synthetic-archive`, `page=${page}`, `episode=${episode}`, `offset=${offset}`, `partition=${partition}`, `authority=data-only`]
  for (const collectionId of collections) headerParts.push(`collection=${collectionId}`)
  const lines = [headerParts.join(' '), ...evidence]
  let length = cpLength(lines.join('\n')) + 1
  let index = 0
  while (length < TARGET_PAGE_CODE_POINTS) {
    const line = fillerLine(salt, seed, page, index)
    index += 1
    lines.push(line)
    length += cpLength(line) + 1
  }
  while (lines.length > 1 && cpLength(lines.join('\n')) + 1 > MAX_PAGE_CODE_POINTS) lines.pop()
  return { text: lines.join('\n') + '\n', evidenceCount: evidence.length, fillerCount: index }
}

export function independentRecordFraction(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('synthetic-archive '))
  if (lines.length === 0) return 1
  return new Set(lines).size / lines.length
}

export function pageSafetyIssues(text) {
  const issues = []
  const lowered = String(text).toLowerCase()
  for (const forbidden of FORBIDDEN_PAGE_SUBSTRINGS) {
    if (lowered.includes(forbidden)) issues.push(`forbidden substring: ${forbidden}`)
  }
  return issues
}

function buildPages({ salt, seed, episodes, material }) {
  const pages = []
  const pageStats = []
  for (let episode = 1; episode <= episodes; episode += 1) {
    for (let offset = 1; offset <= PAGES_PER_EPISODE; offset += 1) {
      const page = (episode - 1) * PAGES_PER_EPISODE + offset
      const island = episode <= ISLAND_EPISODE_COUNT && offset >= 11
      const partition = island
        ? `PART-ISL-${episode}-${offset - 10}`
        : `PART-${episode}-${Math.floor((offset - 1) / 2) + 1}`
      const collections = material.pageCollections.get(page) ?? []
      const rendered = renderPage({
        salt, seed, episode, offset, page, partition, collections,
        evidence: material.pageLines.get(page) ?? [],
      })
      pages.push(rendered.text)
      const lines = rendered.text.split('\n').map(line => line.trim()).filter(Boolean)
      const records = lines.filter(line => !line.startsWith('synthetic-archive '))
      pageStats.push({
        page,
        episode,
        offset,
        island,
        codePoints: cpLength(rendered.text),
        records: records.length,
        distinctRecords: new Set(records).size,
        evidenceRecords: rendered.evidenceCount,
        fillerRecords: rendered.fillerCount,
      })
    }
  }
  return { pages, pageStats }
}

// ---------------------------------------------------------------------------
// Code fixture
// ---------------------------------------------------------------------------

const CODE_PROBE_ORDERS = [
  { label: 'valid-minimal', order: { region: 'PLACEHOLDER', status: 'PLACEHOLDER', currency: 'PLACEHOLDER', quantity: 2, risk: 0 } },
  { label: 'valid-upper', order: { region: 'PLACEHOLDER', status: 'PLACEHOLDER', currency: 'PLACEHOLDER', quantity: 'MAXQ', risk: 'MAXR' } },
  { label: 'string-quantity', order: { region: 'PLACEHOLDER', status: 'PLACEHOLDER', currency: 'PLACEHOLDER', quantity: '3', risk: 4 } },
  { label: 'array-input', order: [] },
  { label: 'null-input', order: null },
  { label: 'bad-region', order: { region: 'zone-other', status: 'PLACEHOLDER', currency: 'PLACEHOLDER', quantity: 3, risk: 1 } },
  { label: 'quantity-zero', order: { region: 'PLACEHOLDER', status: 'PLACEHOLDER', currency: 'PLACEHOLDER', quantity: 0, risk: 1 } },
  { label: 'risk-negative', order: { region: 'PLACEHOLDER', status: 'PLACEHOLDER', currency: 'PLACEHOLDER', quantity: 3, risk: -1 } },
]

function buildCodeFixture(salt, seed) {
  const policy = {
    region: `zone-${hex(salt, seed, 'code/policy/region', 0, 6)}`,
    status: `approved-${hex(salt, seed, 'code/policy/status', 0, 6)}`,
    currency: `TEST-${hex(salt, seed, 'code/policy/currency', 0, 6)}`,
    maxQuantity: asNumber(hex(salt, seed, 'code/policy/maxQuantity', 0, 4), 17, 8),
    maxRisk: asNumber(hex(salt, seed, 'code/policy/maxRisk', 0, 4), 13, 11),
    unitFee: asNumber(hex(salt, seed, 'code/policy/unitFee', 0, 4), 7, 2),
  }
  const referenceEvaluate = order => {
    if (order === null || typeof order !== 'object' || Array.isArray(order)) return { allowed: false, charge: 0 }
    const { region, status, currency, quantity, risk } = order
    if (region !== policy.region || status !== policy.status || currency !== policy.currency) return { allowed: false, charge: 0 }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > policy.maxQuantity) return { allowed: false, charge: 0 }
    if (!Number.isInteger(risk) || risk < 0 || risk > policy.maxRisk) return { allowed: false, charge: 0 }
    return { allowed: true, charge: quantity * policy.unitFee }
  }
  const materialize = order => {
    if (order === null || Array.isArray(order)) return order
    if (typeof order !== 'object') return order
    const out = { ...order }
    for (const [key, value] of Object.entries(out)) {
      if (value === 'PLACEHOLDER') out[key] = policy[key]
      if (value === 'MAXQ') out[key] = policy.maxQuantity
      if (value === 'MAXR') out[key] = policy.maxRisk
    }
    return out
  }
  const probeOrders = CODE_PROBE_ORDERS.map(entry => {
    const order = materialize(entry.order)
    return { label: entry.label, order, expected: referenceEvaluate(order) }
  })
  const files = {
    'normalize.js': "export function normalize(order) {\n  return { ...order, quantity: Number(order?.quantity), risk: Number(order?.risk) };\n}\n",
    'limits.js': `export const limits = ${JSON.stringify(policy, null, 2)};\n`,
    'policy.js': "import { normalize } from './normalize.js';\nimport { limits } from './limits.js';\n\nexport function evaluate(input) {\n  const order = normalize(input);\n  const allowed = order.quantity <= limits.maxQuantity;\n  return { allowed, charge: allowed ? order.quantity * limits.unitFee : 0 };\n}\n",
    'protected.txt': 'Synthetic protected fixture file: must remain unchanged by the experiment.\n',
  }
  return {
    files,
    writable: ['normalize.js', 'limits.js', 'policy.js'],
    protected: 'protected.txt',
    policy,
    probeOrders,
    contract: 'evaluate(order) returns {allowed, charge}; allow only a non-array object with exactly matching region/status/currency, integer quantity 1..maxQuantity and integer risk 0..maxRisk; charge quantity*unitFee when allowed, else 0; never coerce string numbers.',
  }
}

// ---------------------------------------------------------------------------
// Public manifest and corpus
// ---------------------------------------------------------------------------

export function fixtureManifest(corpus) {
  if (!corpus || typeof corpus !== 'object') throw new Error('A corpus is required')
  return JSON.parse(JSON.stringify(corpus.manifest))
}

function materialCountsFor(material, episodes, endpoint) {
  const inScope = entry => entry.episode <= endpoint
  const totalPages = endpoint * PAGES_PER_EPISODE
  const entities = material.entities.filter(inScope)
  const exacts = material.exacts.filter(inScope)
  const timelines = material.timelines.filter(inScope)
  return {
    episodes: endpoint,
    stateEntities: entities.length,
    entitiesWithTwoUpdates: entities.filter(entity => entity.twiceUpdated).length,
    revocationRestorationEntities: entities.filter(entity => entity.revocationRestoration).length,
    similarIdPairs: material.similarIdPairs.filter(inScope).length,
    timelineDependencyRelations: timelines.length,
    crossSixEpisodeRelations: timelines.filter(relation => relation.kind === 'span').length,
    threeWayFanIn: timelines.filter(relation => relation.kind === 'fan_in').length,
    mutuallyExclusiveGroups: timelines.filter(relation => relation.kind === 'exclusive').length,
    exactHistoryTargets: exacts.length,
    earliestQuartileExactTargets: exacts.filter(target => quartileOfPage(target.finalPage, totalPages) === 0).length,
    multiSourceExactTargets: exacts.filter(target => target.multiSource).length,
    existenceAmbiguityGroups: material.existences.filter(inScope).length,
    syntheticActions: material.actions.filter(inScope).length,
  }
}

export function materialCounts(corpus, endpoint = corpus.episodes) {
  return materialCountsFor(corpus.material, corpus.episodes, endpoint)
}

export function generateCorpus({ seed, salt, episodes }) {
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('generateCorpus requires a non-empty hidden salt')
  if (!Number.isSafeInteger(seed)) throw new Error('generateCorpus requires a safe-integer seed')
  episodeCountForEndpoint(episodes)
  const material = generateMaterial({ salt, seed, episodes })
  const { pages, pageStats } = buildPages({ salt, seed, episodes, material })
  // Absence must be real: a negative query value may not occur anywhere in the
  // rendered archive, and a summary-echo value may occur only in echo records.
  const joined = pages.join('\n')
  const joinedLines = joined.split('\n')
  for (const group of material.existences) {
    if (group.kind === 'same_short_id') continue
    if (group.kind === 'summary_echo') {
      for (const line of joinedLines) {
        if (line.includes(group.queryValue) && !line.includes('authority=echo')) {
          throw new Error(`ABSENCE_VIOLATION: echo value ${group.queryValue} appears outside an echo record`)
        }
      }
      if (!joined.includes(group.queryValue)) throw new Error(`MATERIAL_VIOLATION: echo value ${group.queryValue} was never rendered`)
      continue
    }
    if (joined.includes(group.queryValue)) throw new Error(`ABSENCE_VIOLATION: negative query value ${group.queryValue} occurs in the archive`)
  }
  for (const sentinel of material.sentinels) {
    for (const question of sentinel.questions) {
      if (question.category !== 'source_existence_ambiguity') continue
      const queryValue = String(question.question).match(/checksum=(\S+?) exist/)?.[1]
      if (queryValue && joined.includes(queryValue)) {
        throw new Error(`ABSENCE_VIOLATION: sentinel negative query value ${queryValue} occurs in the archive`)
      }
    }
  }
  const pageHashes = pages.map(page => sha256(page))
  const manifest = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
    seed,
    episodes,
    pagesPerEpisode: PAGES_PER_EPISODE,
    targetPageCodePoints: TARGET_PAGE_CODE_POINTS,
    maxPageCodePoints: MAX_PAGE_CODE_POINTS,
    minIndependentRecordFraction: MIN_INDEPENDENT_RECORD_FRACTION,
    pageCodePoints: pageStats.map(stat => stat.codePoints),
    pageHashes,
    briefHashes: material.briefs.map(brief => sha256(brief)),
    islandPages: [...material.islandPages].sort((a, b) => a - b),
    sentinelPages: material.sentinels.flatMap(sentinel => sentinel.pages).sort((a, b) => a - b),
    materialCounts: materialCountsFor(material, episodes, episodes),
  }
  const corpus = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
    seed,
    episodes,
    pagesPerEpisode: PAGES_PER_EPISODE,
    manifest,
    hash: sha256(JSON.stringify(manifest)),
    pages,
    pageHashes,
    pageStats,
    episodeQuartile: page => quartileOfPage(page, episodes * PAGES_PER_EPISODE),
    briefs: material.briefs,
    workItems: material.workItems,
    state: {
      entities: material.entities,
      nearMissPairs: material.similarIdPairs,
      shortIdCollisions: material.shortIdCollisions,
    },
    timeline: material.timelines,
    exact: material.exacts,
    existence: material.existences,
    actions: material.actions,
    islandPages: [...material.islandPages].sort((a, b) => a - b),
    sentinelPages: material.sentinels.flatMap(sentinel => sentinel.pages).sort((a, b) => a - b),
    sentinels: material.sentinels,
    codeFixture: buildCodeFixture(salt, seed),
    material: material,
  }
  return corpus
}

// Per-page heuristic token counts using the pinned host estimator for a single
// text block: `Math.ceil(codePointLength / 4) + 4`, i.e. CHARS_PER_TOKEN=4 plus
// BLOCK_OVERHEAD=4 plus the 4-token role framing added by
// @deepseek-ai/dsh-token-meter estimateMessage for one text block.
export function pageTokens(corpus) {
  if (!corpus || !Array.isArray(corpus.pages)) throw new Error('pageTokens requires a corpus')
  return corpus.pages.map(text => Math.ceil(cpLength(text) / 4) + 4)
}

// Exactly four mid-run sentinel questions for episodes 6, 12 and 18. Sentinel
// evidence lives on reserved pages and reserved identifiers, so it is disjoint
// from every final 96-question probe at every endpoint. Accepts either a corpus
// or a sealed oracle (both carry `sentinels`). Other episodes return [].
export function sentinelQuestions(source, episode) {
  if (!source || !Array.isArray(source.sentinels)) throw new Error('sentinelQuestions requires a corpus or oracle with sentinels')
  const group = source.sentinels.find(sentinel => sentinel.episode === episode)
  if (!group) return []
  if (group.questions.length !== 4) throw new Error(`SENTINEL_INVALID: episode ${episode} has ${group.questions.length} questions`)
  return group.questions.map(question => JSON.parse(JSON.stringify(question)))
}

export function pageText(corpus, pageNumber) {
  if (!corpus || !Array.isArray(corpus.pages)) throw new Error('pageText requires a corpus')
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > corpus.pages.length) {
    throw new Error(`Page ${pageNumber} is outside 1..${corpus.pages.length}`)
  }
  const text = corpus.pages[pageNumber - 1]
  if (typeof text !== 'string') throw new Error(`Page ${pageNumber} has no text`)
  if (cpLength(text) > MAX_PAGE_CODE_POINTS) throw new Error(`Page ${pageNumber} exceeds ${MAX_PAGE_CODE_POINTS} code points`)
  return text
}

export function episodeBrief(corpus, episode) {
  assertEpisode(corpus, episode)
  return corpus.briefs[episode - 1]
}

export function episodeWorkItem(corpus, episode) {
  assertEpisode(corpus, episode)
  const item = corpus.workItems[episode - 1]
  return { ...item, preconditions: item.preconditions.slice(), files: item.files.slice() }
}

function assertEpisode(corpus, episode) {
  if (!corpus) throw new Error('A corpus is required')
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > corpus.episodes) {
    throw new Error(`Episode ${episode} is outside 1..${corpus.episodes}`)
  }
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

function questionId(endpoint, ordinal) {
  return `N${endpoint}-Q${String(ordinal).padStart(3, '0')}`
}

function selectBucket(items, bucket, endpoint, sourcePageOf, needed, what) {
  const totalPages = endpoint * PAGES_PER_EPISODE
  const candidates = items
    .filter(item => item.episode <= endpoint && quartileOfPage(sourcePageOf(item), totalPages) === bucket)
    .sort((a, b) => sourcePageOf(a) - sourcePageOf(b) || a.episode - b.episode)
  if (candidates.length < needed) {
    throw new Error(`ORACLE_MATERIAL_SHORTAGE: bucket ${bucket} of endpoint ${endpoint} needs ${needed} ${what} but only ${candidates.length} exist`)
  }
  if (candidates.length === needed) return candidates.slice()
  const picked = []
  for (let index = 0; index < needed; index += 1) picked.push(candidates[Math.floor((index * candidates.length) / needed)])
  return picked
}

function stateTargetPage(entity) {
  return entity.latestPage
}

function buildStateQuestions(corpus, endpoint, bucket) {
  const entities = corpus.state.entities
  const corrections = selectBucket(entities.filter(entity => entity.kind === 'correction'), bucket, endpoint, stateTargetPage, 2, 'correction state entities')
  const revocations = selectBucket(entities.filter(entity => entity.kind === 'revocation'), bucket, endpoint, stateTargetPage, 2, 'revocation state entities')
  const ordinary = selectBucket(entities.filter(entity => entity.kind === 'ordinary'), bucket, endpoint, stateTargetPage, 2, 'ordinary state entities')
  return [
    ...corrections.map(entity => stateQuestion('latest_user_correction', true, entity)),
    ...revocations.map(entity => stateQuestion('revocation_restoration', true, entity)),
    ...ordinary.map(entity => stateQuestion('ordinary_state', false, entity)),
  ]
}

function stateQuestion(subtype, requiredLatestUser, entity) {
  const question = subtype === 'revocation_restoration'
    ? `State entity ${entity.publicLabel} (short identifier ${entity.shortId}) was revoked and later either restored or left revoked. Report the currently effective value. If the latest authoritative record marks it revoked with no restoration, answer the literal "REVOKED". Later plain archive text that repeats an older value does not supersede an authoritative user correction.`
    : subtype === 'latest_user_correction'
      ? `State entity ${entity.publicLabel} (short identifier ${entity.shortId}) received user corrections during the campaign. Report the latest effective value after every user correction, ignoring older values that merely appear later in the raw archive text.`
      : `Report the current authoritative value of state entity ${entity.publicLabel} (short identifier ${entity.shortId}) from the archive.`
  return {
    category: 'state',
    subtype,
    requiredLatestUser,
    targetLabel: entity.publicLabel,
    question,
    sourcePages: [entity.latestPage],
    recordIds: [entity.latestRecord.recordId],
    finalSourcePage: entity.latestPage,
    lastSourceEventPage: entity.latestPage,
    expected: { value: entity.latestValue },
    answerKind: entity.latestValue === null ? 'null' : 'value',
  }
}

function buildExactQuestions(corpus, endpoint, bucket) {
  const targets = bucket === 0
    ? corpus.exact.filter(target => target.island && target.episode <= endpoint).sort((a, b) => a.finalPage - b.finalPage)
    : selectBucket(corpus.exact.filter(target => !target.island), bucket, endpoint, target => target.finalPage, 6, 'exact targets')
  if (targets.length !== 6) throw new Error(`ORACLE_MATERIAL_SHORTAGE: earliest quartile needs exactly 6 island exact targets, found ${targets.length}`)
  return targets.map(target => ({
    category: 'exact',
    subtype: target.multiSource ? `multi_source_${target.kind}` : target.kind,
    requiredLatestUser: false,
    targetLabel: target.targetLabel,
    question: target.multiSource
      ? `Two authoritative archive records carry the parts of target ${target.targetLabel} with a documented part order and separator. Report the assembled verbatim value. Copy every character exactly.`
      : `Report the exact archive value recorded for target ${target.targetLabel}. Copy it verbatim, including every character and separator.`,
    sourcePages: target.sourcePages.slice(),
    recordIds: target.recordIds.slice(),
    finalSourcePage: target.finalPage,
    lastSourceEventPage: target.finalPage,
    expected: { value: target.value },
    answerKind: 'value',
    multiSource: target.multiSource,
    island: Boolean(target.island),
  }))
}

function buildExistenceQuestions(corpus, endpoint, bucket) {
  const groups = bucket === 0
    ? corpus.existence.filter(group => group.island && group.episode <= endpoint).sort((a, b) => a.finalPage - b.finalPage)
    : selectBucket(corpus.existence.filter(group => !group.island), bucket, endpoint, group => group.finalPage, 6, 'existence groups')
  if (groups.length !== 6) throw new Error(`ORACLE_MATERIAL_SHORTAGE: earliest quartile needs exactly 6 island existence groups, found ${groups.length}`)
  return groups.map(group => existenceQuestion(group))
}

function existenceQuestion(group) {
  const scope = `Restrict the lookup to the precommitted archive collection ${group.collectionId}; that collection is a bounded, fixed source set.`
  if (group.kind === 'same_short_id') {
    return {
      category: 'source_existence_ambiguity',
      subtype: group.kind,
      requiredLatestUser: false,
      targetLabel: `EXIST-${group.groupId.slice(6)}`,
      question: `${scope} Two distinct entities share short identifier ${group.queryValue}. Exactly one of them is authoritative and the other is a suspected alias. Report the authoritative record.`,
      sourcePages: group.sourcePages.slice(),
      recordIds: [group.answerRecordId, group.aliasEntityId],
      finalSourcePage: group.finalPage,
      lastSourceEventPage: group.finalPage,
      expected: { present: true, recordId: group.answerRecordId },
      answerKind: 'present',
      island: Boolean(group.island),
      sourceScope: group.collectionId,
    }
  }
  const query = `${group.field}=${group.queryValue}`
  const explanation = group.kind === 'summary_echo'
    ? ' A recalled summary echo is not an authoritative record.'
    : group.kind === 'near_miss'
      ? ' A value that differs from a real value by a single character is still a different value.'
      : ''
  return {
    category: 'source_existence_ambiguity',
    subtype: group.kind,
    requiredLatestUser: false,
    targetLabel: `EXIST-${group.groupId.slice(6)}`,
    question: `${scope} Does an authoritative record with ${query} exist inside that collection?${explanation} Report whether it exists and, if it does, its record identifier.`,
    sourcePages: group.sourcePages.slice(),
    recordIds: [],
    finalSourcePage: group.finalPage,
    lastSourceEventPage: group.finalPage,
    expected: { present: false, recordId: null },
    answerKind: 'absent',
    island: Boolean(group.island),
    sourceScope: group.collectionId,
  }
}

function buildTimelineQuestions(corpus, endpoint, bucket) {
  const relations = selectBucket(corpus.timeline, bucket, endpoint, relation => relation.finalPage, 6, 'timeline relations')
  return relations.map(relation => {
    const question = relation.kind === 'exclusive'
      ? `Mutually exclusive group ${relation.label} has several candidate events and exactly one documented approved event. Report exactly the approved event identifier as a one-element ordered array.`
      : relation.kind === 'fan_in'
        ? `Three predecessor events converge on one result event in relation ${relation.label}. Report the complete ordered array: the predecessors in documented sequence order followed by the result event.`
        : `Report the complete ordered event sequence for dependency relation ${relation.label}, earliest event first.`
    return {
      category: 'timeline_dependency',
      subtype: relation.kind,
      requiredLatestUser: false,
      targetLabel: relation.label,
      question,
      sourcePages: relation.sourcePages.slice(),
      recordIds: relation.events.map(event => event.id),
      finalSourcePage: relation.finalPage,
      lastSourceEventPage: relation.finalPage,
      expected: { order: relation.answer.slice() },
      answerKind: 'order',
      timelineKind: relation.kind,
    }
  })
}

function answerFormatFor(category) {
  if (category === 'state' || category === 'exact') return '{"value": "<verbatim string>"}'
  if (category === 'source_existence_ambiguity') return '{"present": true|false, "recordId": "<record id>"|null}'
  return '{"order": ["<identifier>", "..."]}'
}

/**
 * Every reason an oracle question cannot be answered from its corpus.
 *
 * This is checked at PREPARE time, not just in a unit test: a sealed oracle whose
 * questions name identifiers or values the corpus never contains makes the whole
 * quality gate meaningless, and that is exactly what happened to the first
 * executed campaign. A per-campaign salt cannot be exercised from a unit test, so
 * the real guard has to run where the real salt is.
 *
 * Two legitimate designs are respected rather than flagged: an absence question
 * names a value that MUST NOT be present, so its absence is asserted positively;
 * and an assembled question splits a documented composite across records, so its
 * parts must be present rather than the joined string.
 */
export function oracleAnswerabilityProblems(corpus, oracle) {
  const pages = corpus.pages.join('\n')
  const problems = []
  for (const question of oracle.questions ?? []) {
    const expected = question.oracle?.expected ?? {}
    const query = /\b(short|checksum|value)=([A-Za-z0-9-]+)/.exec(question.question)
    const namedShort = /short identifier ([A-Za-z0-9]+)/.exec(question.question)?.[1]
    if (question.category === 'source_existence_ambiguity') {
      if (question.sourceScope && !pages.includes(question.sourceScope)) problems.push(`${question.queryId} collection ${question.sourceScope} is not in the corpus`)
      const literal = query !== null ? `${query[1]}=${query[2]}` : namedShort !== undefined ? `short=${namedShort}` : null
      if (literal === null) problems.push(`${question.queryId} has no recognisable query value`)
      else if (expected.present === true && !pages.includes(literal)) problems.push(`${question.queryId} present query ${literal} is not in the corpus`)
      else if (expected.present !== true && pages.includes(literal)) problems.push(`${question.queryId} absence query ${literal} is unexpectedly in the corpus`)
      if (expected.present === true && typeof expected.recordId === 'string' && !pages.includes(expected.recordId)) problems.push(`${question.queryId} answer record ${expected.recordId} is not in the corpus`)
    } else if (question.category === 'state') {
      if (namedShort === undefined || !pages.includes(`short=${namedShort}`)) problems.push(`${question.queryId} short identifier ${namedShort} is not in the corpus`)
    } else if (question.targetLabel && !pages.includes(question.targetLabel)) {
      problems.push(`${question.queryId} targetLabel ${question.targetLabel} is not in the corpus`)
    }
    for (const value of Object.values(expected)) {
      for (const scalar of Array.isArray(value) ? value : [value]) {
        if (typeof scalar !== 'string' || scalar.length < 8) continue
        for (const part of scalar.split(/[|;]/).filter(piece => piece.length >= 8)) {
          if (!pages.includes(part)) problems.push(`${question.queryId} expected part ${part} is not in the corpus`)
        }
      }
    }
  }
  return problems
}

export function generateOracle({ corpus, endpoint }) {
  if (!corpus || !corpus.state) throw new Error('generateOracle requires a generated corpus')
  episodeCountForEndpoint(endpoint)
  if (endpoint > corpus.episodes) throw new Error(`Endpoint ${endpoint} exceeds the generated ${corpus.episodes}-episode corpus`)
  const byBucket = []
  const ordinalByCategory = { state: [], exact: [], source_existence_ambiguity: [], timeline_dependency: [] }
  for (let bucket = 0; bucket < 4; bucket += 1) {
    const bucketQuestions = {
      state: buildStateQuestions(corpus, endpoint, bucket),
      exact: buildExactQuestions(corpus, endpoint, bucket),
      source_existence_ambiguity: buildExistenceQuestions(corpus, endpoint, bucket),
      timeline_dependency: buildTimelineQuestions(corpus, endpoint, bucket),
    }
    byBucket.push(bucketQuestions)
  }
  // Number questions in the frozen natural order: bucket, then state/exact/existence/timeline.
  const questions = []
  const queryIdByDraft = new Map()
  let ordinal = 0
  for (let bucket = 0; bucket < 4; bucket += 1) {
    for (const category of CATEGORIES) {
      for (const draft of byBucket[bucket][category]) {
        ordinal += 1
        const queryId = questionId(endpoint, ordinal)
        queryIdByDraft.set(draft, queryId)
        const longTailRequired = bucket === 0 && (category === 'exact' || category === 'source_existence_ambiguity')
        questions.push({
          queryId,
          endpoint,
          category,
          subtype: draft.subtype,
          requiredLatestUser: Boolean(draft.requiredLatestUser),
          longTailRequired,
          quartile: bucket,
          promptVisibleFields: category === 'source_existence_ambiguity'
            ? ['queryId', 'question', 'targetLabel', 'sourceScope']
            : ['queryId', 'question', 'targetLabel'],
          scoredFields: [...SCORED_FIELDS[category]],
          question: `[${queryId}] ${draft.question} Answer with one JSON object of the shape ${answerFormatFor(category)}.`,
          oracle: {
            expected: { ...draft.expected },
            answerKind: draft.answerKind,
            notes: draft.island ? 'earliest-quartile long-tail evidence island' : 'campaign material',
          },
          evidence: {
            sourcePages: draft.sourcePages.slice(),
            recordIds: draft.recordIds.slice(),
          },
          sourcePosition: {
            finalSourcePage: draft.finalSourcePage,
            lastSourceEventPage: draft.lastSourceEventPage,
          },
          multiSource: Boolean(draft.multiSource),
          island: Boolean(draft.island),
          sourceScope: draft.sourceScope ?? null,
          targetLabel: draft.targetLabel,
        })
      }
    }
  }
  // Batch layout is frozen by the plan: bucket 0 is asked as exact, existence,
  // state, timeline; later buckets keep the natural query order.
  const askOrder = []
  const ask = drafts => {
    for (const draft of drafts) {
      const queryId = queryIdByDraft.get(draft)
      if (typeof queryId !== 'string') throw new Error('ORACLE_INTERNAL: question draft without a queryId')
      askOrder.push(queryId)
    }
  }
  ask(byBucket[0].exact)
  ask(byBucket[0].source_existence_ambiguity)
  ask(byBucket[0].state)
  ask(byBucket[0].timeline_dependency)
  for (let bucket = 1; bucket < 4; bucket += 1) {
    for (const category of CATEGORIES) ask(byBucket[bucket][category])
  }
  if (askOrder.length !== QUESTION_COUNT) throw new Error(`ORACLE_IMPOSSIBLE_COUNT: ${askOrder.length} questions`)
  const batches = chunk(askOrder, QUESTIONS_PER_BATCH)
  const longTailRequiredIds = questions.filter(question => question.longTailRequired).map(question => question.queryId)
  const requiredLatestUserIds = questions.filter(question => question.requiredLatestUser).map(question => question.queryId)
  const actionPlan = corpus.actions
    .filter(action => action.episode <= endpoint)
    .map(action => ({
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      episode: action.episode,
      preconditions: action.preconditions.slice(),
      finalState: { ...action.finalState },
      page: action.page,
    }))
  const oracle = {
    schemaVersion: ORACLE_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
    endpoint,
    episodes: endpoint,
    pagesPerEpisode: PAGES_PER_EPISODE,
    totalPages: endpoint * PAGES_PER_EPISODE,
    corpusHash: corpus.hash,
    questionCount: questions.length,
    quartiles: 4,
    questions,
    batches,
    requiredLatestUserIds,
    longTailRequiredIds,
    actionPlan,
    codeFixture: JSON.parse(JSON.stringify(corpus.codeFixture)),
    sentinels: JSON.parse(JSON.stringify(corpus.sentinels)),
    materials: materialCounts(corpus, endpoint),
    answerFormat: {
      objectShape: '{ "<queryId>": { <scored field>: <value>, ... }, ... }',
      rules: [
        'Return exactly one JSON object, optionally inside one fenced block.',
        'Every scored field must be present; required arrays must not be empty.',
        'null is legal only for a scored field whose expected value is null.',
        'Non-empty text outside the fence, more than one candidate object or a duplicate queryId fails the whole answer.',
      ],
    },
  }
  const problems = oracleShapeProblems(oracle)
  if (problems.length > 0) {
    const detail = process.env.DSH_FIXTURE_DEBUG
      ? ` [longTail=${oracle.longTailRequiredIds.join(',')} firstTwo=${oracle.batches[0].concat(oracle.batches[1]).join(',')}]`
      : ''
    throw new Error(`ORACLE_INVALID: ${problems.join('; ')}${detail}`)
  }
  return oracle
}

export function probeInstructions(oracle) {
  const lines = [
    'Final blind probe over the synthetic archive campaign.',
    `Answer all ${oracle.questionCount} questions in one JSON object keyed by queryId.`,
    `Object shape: ${oracle.answerFormat.objectShape}`,
    ...oracle.answerFormat.rules.map(rule => `- ${rule}`),
    'No correctness feedback is provided. Missing answers count as wrong.',
  ]
  return lines.join('\n')
}

// Strict schema validation of a sealed oracle. Unknown fields, duplicate ids and
// impossible counts are rejected loudly instead of being silently tolerated.
const ORACLE_TOP_KEYS = new Set(['schemaVersion', 'protocolId', 'endpoint', 'episodes', 'pagesPerEpisode', 'totalPages', 'corpusHash', 'questionCount', 'quartiles', 'questions', 'batches', 'requiredLatestUserIds', 'longTailRequiredIds', 'actionPlan', 'codeFixture', 'sentinels', 'materials', 'answerFormat'])
const QUESTION_KEYS = new Set(['queryId', 'endpoint', 'category', 'subtype', 'requiredLatestUser', 'longTailRequired', 'quartile', 'promptVisibleFields', 'scoredFields', 'question', 'oracle', 'evidence', 'sourcePosition', 'multiSource', 'island', 'sourceScope', 'targetLabel'])
const ORACLE_INNER_KEYS = new Set(['expected', 'answerKind', 'notes'])
const EVIDENCE_KEYS = new Set(['sourcePages', 'recordIds'])
const POSITION_KEYS = new Set(['finalSourcePage', 'lastSourceEventPage'])

export function oracleShapeProblems(oracle) {
  const problems = []
  if (!oracle || typeof oracle !== 'object') return ['oracle is not an object']
  for (const key of Object.keys(oracle)) if (!ORACLE_TOP_KEYS.has(key)) problems.push(`unknown oracle field ${key}`)
  if (oracle.questionCount !== QUESTION_COUNT) problems.push(`questionCount is ${oracle.questionCount}`)
  if (!Array.isArray(oracle.questions) || oracle.questions.length !== QUESTION_COUNT) problems.push('question list is not 96 entries')
  if (!Array.isArray(oracle.batches) || oracle.batches.length !== BATCH_COUNT) problems.push('batches are not 12 entries')
  else for (const [index, batch] of oracle.batches.entries()) if (batch.length !== QUESTIONS_PER_BATCH) problems.push(`batch ${index} has ${batch.length} questions`)
  if (!Array.isArray(oracle.requiredLatestUserIds) || oracle.requiredLatestUserIds.length !== REQUIRED_LATEST_USER_COUNT) problems.push('requiredLatestUserIds is not 16 entries')
  if (!Array.isArray(oracle.longTailRequiredIds) || oracle.longTailRequiredIds.length !== LONG_TAIL_REQUIRED_COUNT) problems.push('longTailRequiredIds is not 12 entries')
  const seen = new Set()
  const perQuartile = [0, 0, 0, 0]
  const perBucketCategory = new Map()
  const totalPages = oracle.endpoint * PAGES_PER_EPISODE
  for (const question of oracle.questions ?? []) {
    if (!question || typeof question !== 'object') { problems.push('non-object question'); continue }
    for (const key of Object.keys(question)) if (!QUESTION_KEYS.has(key)) problems.push(`unknown question field ${key} in ${question.queryId}`)
    if (seen.has(question.queryId)) problems.push(`duplicate queryId ${question.queryId}`)
    seen.add(question.queryId)
    if (!/^N\d{2}-Q\d{3}$/.test(question.queryId ?? '')) problems.push(`invalid queryId ${question.queryId}`)
    if (!CATEGORIES.includes(question.category)) problems.push(`invalid category ${question.category} in ${question.queryId}`)
    if (!Number.isSafeInteger(question.quartile) || question.quartile < 0 || question.quartile > 3) problems.push(`invalid quartile in ${question.queryId}`)
    else perQuartile[question.quartile] += 1
    const key = `${question.quartile}:${question.category}`
    perBucketCategory.set(key, (perBucketCategory.get(key) ?? 0) + 1)
    if (question.scoredFields.join(',') !== SCORED_FIELDS[question.category].join(',')) problems.push(`scoredFields mismatch in ${question.queryId}`)
    if (!Number.isSafeInteger(question.sourcePosition?.finalSourcePage)) problems.push(`missing finalSourcePage in ${question.queryId}`)
    else if (quartileOfPage(question.sourcePosition.finalSourcePage, totalPages) !== question.quartile) {
      problems.push(`quartile ${question.quartile} disagrees with page ${question.sourcePosition.finalSourcePage} in ${question.queryId}`)
    }
    if (!question.oracle || typeof question.oracle !== 'object') problems.push(`missing oracle in ${question.queryId}`)
    else {
      for (const inner of Object.keys(question.oracle)) if (!ORACLE_INNER_KEYS.has(inner)) problems.push(`unknown oracle field ${inner} in ${question.queryId}`)
      for (const field of question.scoredFields) if (!Object.hasOwn(question.oracle.expected ?? {}, field)) problems.push(`oracle is missing ${field} in ${question.queryId}`)
    }
    if (!question.evidence || typeof question.evidence !== 'object') problems.push(`missing evidence in ${question.queryId}`)
    else {
      for (const evidenceKey of Object.keys(question.evidence)) if (!EVIDENCE_KEYS.has(evidenceKey)) problems.push(`unknown evidence field ${evidenceKey} in ${question.queryId}`)
      if (!Array.isArray(question.evidence.sourcePages) || question.evidence.sourcePages.length === 0) problems.push(`empty sourcePages in ${question.queryId}`)
      if (!Array.isArray(question.evidence.recordIds)) problems.push(`recordIds is not an array in ${question.queryId}`)
    }
    for (const positionKey of Object.keys(question.sourcePosition ?? {})) if (!POSITION_KEYS.has(positionKey)) problems.push(`unknown sourcePosition field ${positionKey} in ${question.queryId}`)
    if (typeof question.question !== 'string' || question.question.length === 0) problems.push(`empty question text in ${question.queryId}`)
  }
  for (let bucket = 0; bucket < 4; bucket += 1) if (perQuartile[bucket] !== QUESTIONS_PER_QUARTILE) problems.push(`quartile ${bucket} has ${perQuartile[bucket]} questions`)
  for (let bucket = 0; bucket < 4; bucket += 1) {
    for (const category of CATEGORIES) {
      const count = perBucketCategory.get(`${bucket}:${category}`) ?? 0
      if (count !== QUESTIONS_PER_CATEGORY_PER_QUARTILE) problems.push(`quartile ${bucket} category ${category} has ${count} questions`)
    }
  }
  const expectedLongTail = oracle.questions?.filter(question => question.longTailRequired).map(question => question.queryId) ?? []
  if (JSON.stringify(expectedLongTail) !== JSON.stringify(oracle.longTailRequiredIds)) problems.push('longTailRequiredIds do not match the flagged questions')
  // The plan asks the long-tail questions first: the 12 required ids must be the
  // leading entries of the first two batches, in order.
  const firstTwo = (oracle.batches?.[0] ?? []).concat(oracle.batches?.[1] ?? [])
  if (JSON.stringify(firstTwo.slice(0, LONG_TAIL_REQUIRED_COUNT)) !== JSON.stringify(oracle.longTailRequiredIds)) {
    problems.push('longTailRequiredIds must lead the first two batches in order')
  }
  return problems
}
