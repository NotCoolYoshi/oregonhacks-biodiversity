// Exercises getUserId()'s Clerk-vs-anonymous precedence and
// ensureDisplayName()'s GET-before-POST orchestration, without a browser.
//
// session.js reads globalThis.window / globalThis.localStorage rather than
// the bare identifiers specifically so this is possible — see the comment at
// the top of that file. ensureDisplayName() takes its network calls as
// injectable deps for the same reason routes.test.mjs stubs globalThis.fetch
// instead of pulling in a mocking library: this codebase's tests are plain
// scripts, and DI is the plain-script way to swap out a real network call.

globalThis.window = {}

function makeFakeStorage() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
}
globalThis.localStorage = makeFakeStorage()

const {
  getUserId,
  getDisplayName,
  setDisplayName,
  ensureDisplayName,
  resetUserId,
} = await import('../src/session.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

/** Simulates a signed-in Clerk session, or removes it entirely. */
const setClerkUser = (user) => {
  globalThis.window.Clerk = user === undefined ? undefined : { user }
}

// A spy that resolves to `result` (or rejects with it, if `reject`) and
// records every call it received.
const spy = (result, { reject = false } = {}) => {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return reject ? Promise.reject(result) : Promise.resolve(result)
  }
  fn.calls = calls
  return fn
}

// ---------------------------------------------------------------------------

console.log('\n-- getUserId(): anonymous fallback --')
resetUserId()
setClerkUser(undefined)

const anon1 = getUserId()
check('an anonymous id is minted', typeof anon1 === 'string' && anon1.startsWith('usr_'), anon1)
const anon2 = getUserId()
check('...and is stable across calls', anon2 === anon1, `${anon1} vs ${anon2}`)

console.log('\n-- getUserId(): Clerk takes precedence --')
setClerkUser({ id: 'user_clerk_abc' })
check('a signed-in Clerk session wins over the anonymous id', getUserId() === 'user_clerk_abc',
  getUserId())

setClerkUser(null) // Clerk loaded, but nobody is signed in
check('Clerk loaded-but-signed-out falls back to the anonymous id', getUserId() === anon1,
  getUserId())

setClerkUser(undefined) // Clerk not present at all (no key configured)
check('no Clerk instance at all falls back to the anonymous id too', getUserId() === anon1,
  getUserId())

console.log('\n-- display name cache is keyed per id --')
setDisplayName('usr_a', 'Fern Hunter')
check('a cached name is returned for its own id', getDisplayName('usr_a') === 'Fern Hunter',
  getDisplayName('usr_a'))
check('a different id sees no cached name', getDisplayName('usr_b') === null, getDisplayName('usr_b'))
check('an id that was never cached sees null, not undefined',
  getDisplayName('usr_never_seen') === null)

console.log('\n-- ensureDisplayName(): an existing server name is used, never overwritten --')
resetUserId()
setClerkUser({ id: 'user_existing', fullName: 'Should Not Be Sent' })

const getCurrentUserExisting = spy({ displayName: 'Already Named' })
const updateDisplayNameShouldNotRun = spy({ displayName: 'IMPOSTER' })

const nameExisting = await ensureDisplayName({
  getCurrentUserFn: getCurrentUserExisting,
  updateDisplayNameFn: updateDisplayNameShouldNotRun,
})
check('resolves to the name already on the server', nameExisting === 'Already Named', nameExisting)
check('GET was checked first', getCurrentUserExisting.calls.length === 1,
  getCurrentUserExisting.calls.length)
check('POST/rename was never called — an existing name must not be overwritten',
  updateDisplayNameShouldNotRun.calls.length === 0, updateDisplayNameShouldNotRun.calls.length)
check('the resolved name is now cached', getDisplayName('user_existing') === 'Already Named',
  getDisplayName('user_existing'))

console.log('\n-- ensureDisplayName(): no server name yet, Clerk supplies one --')
resetUserId()
setClerkUser({ id: 'user_new', fullName: 'Fresh Sign-in', username: 'freshbie' })

const getCurrentUserNone = spy({ displayName: null })
const updateDisplayNameFromClerk = spy({ displayName: 'Fresh Sign-in' })

const nameFromClerk = await ensureDisplayName({
  getCurrentUserFn: getCurrentUserNone,
  updateDisplayNameFn: updateDisplayNameFromClerk,
})
check('resolves to the name the server echoed back', nameFromClerk === 'Fresh Sign-in', nameFromClerk)
check('fullName is preferred and sent to the rename endpoint',
  updateDisplayNameFromClerk.calls[0]?.[1] === 'Fresh Sign-in',
  JSON.stringify(updateDisplayNameFromClerk.calls))
check('...for the Clerk userId, not the anonymous one',
  updateDisplayNameFromClerk.calls[0]?.[0] === 'user_new', updateDisplayNameFromClerk.calls[0])

console.log('\n-- ensureDisplayName(): fullName absent, username used instead --')
resetUserId()
setClerkUser({ id: 'user_username_only', fullName: null, username: 'plantpal' })

const updateDisplayNameUsername = spy({ displayName: 'plantpal' })
await ensureDisplayName({
  getCurrentUserFn: spy({ displayName: null }),
  updateDisplayNameFn: updateDisplayNameUsername,
})
check('username is used when fullName is empty',
  updateDisplayNameUsername.calls[0]?.[1] === 'plantpal', updateDisplayNameUsername.calls[0])

console.log('\n-- ensureDisplayName(): neither Clerk nor a server name — the server default kicks in --')
resetUserId()
setClerkUser(undefined) // anonymous: no Clerk name to prefer

const updateDisplayNameDefault = spy({ displayName: 'Explorer 4821' })
const nameDefault = await ensureDisplayName({
  getCurrentUserFn: spy({ displayName: null }),
  updateDisplayNameFn: updateDisplayNameDefault,
})
check('resolves to whatever the server generated', nameDefault === 'Explorer 4821', nameDefault)
check('no name was invented client-side and sent',
  updateDisplayNameDefault.calls[0]?.[1] === undefined, updateDisplayNameDefault.calls[0])

console.log('\n-- ensureDisplayName(): a cached name short-circuits both calls --')
resetUserId()
setClerkUser({ id: 'user_cached' })
setDisplayName('user_cached', 'Already Cached')

const getCurrentUserShouldNotRun = spy({ displayName: 'server says something else' })
const updateDisplayNameShouldNotRun2 = spy({ displayName: 'nope' })
const nameCached = await ensureDisplayName({
  getCurrentUserFn: getCurrentUserShouldNotRun,
  updateDisplayNameFn: updateDisplayNameShouldNotRun2,
})
check('resolves to the cached name without touching the network', nameCached === 'Already Cached',
  nameCached)
check('GET was never called', getCurrentUserShouldNotRun.calls.length === 0)
check('POST was never called', updateDisplayNameShouldNotRun2.calls.length === 0)

console.log('\n-- ensureDisplayName(): concurrent callers for the same id share one request --')
resetUserId()
setClerkUser({ id: 'user_concurrent' })

let getCurrentUserRunCount = 0
const getCurrentUserSlow = async (...args) => {
  getCurrentUserRunCount += 1
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { displayName: 'Resolved Once' }
}

const [first, second] = await Promise.all([
  ensureDisplayName({ getCurrentUserFn: getCurrentUserSlow, updateDisplayNameFn: spy({}) }),
  ensureDisplayName({ getCurrentUserFn: getCurrentUserSlow, updateDisplayNameFn: spy({}) }),
])
check('both callers resolve to the same name', first === 'Resolved Once' && second === 'Resolved Once',
  `${first} / ${second}`)
check('...from exactly one GET, not two (StrictMode-safe)', getCurrentUserRunCount === 1,
  getCurrentUserRunCount)

console.log('\n-- ensureDisplayName(): network failures degrade to null, never reject --')
resetUserId()
setClerkUser({ id: 'user_broken' })

const nameBothFail = await ensureDisplayName({
  getCurrentUserFn: spy(new Error('network down'), { reject: true }),
  updateDisplayNameFn: spy(new Error('network down'), { reject: true }),
})
check('resolves to null rather than throwing', nameBothFail === null, nameBothFail)

console.log('\n-- resetUserId() --')
setClerkUser(undefined)
const beforeReset = getUserId()
setDisplayName(beforeReset, 'Temporary Name')
resetUserId()
const afterReset = getUserId()
check('a new anonymous id is minted', afterReset !== beforeReset, `${beforeReset} -> ${afterReset}`)
check("the old id's cached name is gone", getDisplayName(beforeReset) === null,
  getDisplayName(beforeReset))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
