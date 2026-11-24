/**
 * Concurrency primitives: a fair serial queue, a per-model dispatch gate, and the
 * queue-aware rotation wrapper.
 *
 * ## Why three primitives and not one
 *
 * They solve different problems and must not block each other:
 *
 * | Primitive | Enforces | Triggered by |
 * |---|---|---|
 * | {@link SerialQueue} | one task at a time, first-come-first-served | our own choice (e.g. captcha minting) |
 * | {@link ModelGate} | one upstream request in flight, plus a per-model minimum gap | our own choice (self-protection) |
 * | {@link withQueueRotation} | what to do once the *server* says "queued" | the upstream's verdict |
 *
 * The gate deliberately wraps only the upstream fetch, never captcha acquisition:
 * serialising the mint behind a queue of fetches turns a 200-500 ms mint into seconds,
 * because it now waits for everyone else's request first.
 *
 * ## The invariant that matters most
 *
 * **Nothing is replayed after the caller has seen output.** The rotation wrapper marks
 * a turn as delivered immediately before yielding the first chunk, and thereafter only
 * a queue error can retry — and even then only if nothing was delivered. Any chunk
 * counts, including a reasoning delta or a partial tool call. A retry after visible
 * output would duplicate text the user already read.
 *
 * @module src/accounts/core/queue
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { ACCOUNT_ERROR_CODES, AccountError, ModelQueuedError, SlotAbortedError } from './errors.js'

/** How many queue retries one turn may make before giving up. */
export const QUEUE_MAX_ATTEMPTS = 180

/** Cap on a single queue wait, so the UI cannot sit in "running" indefinitely. */
export const QUEUE_MAX_DELAY_MS = 10_000

/** Total time one turn may spend waiting in queues. */
export const QUEUE_DEADLINE_MS = 30 * 60_000

/** Rotate to another account after this many queue hits... */
const QUEUE_HITS_BEFORE_ROTATE = 3

/** ...or after this long spent queueing on the current one. */
const QUEUE_MS_BEFORE_ROTATE = 20_000

/**
 * A first-come-first-served serial queue.
 *
 * Fairness is by *call order*, not completion order, because the tail pointer is
 * captured at call time. The `finally` block releases the tail unconditionally: a
 * failed task that welded the queue shut would be worse than the failure itself, since
 * everything behind it would hang with no error at all.
 */
export class SerialQueue {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled] false makes `run` execute directly, for the
   *   "turn this off and see if the queue was the problem" path
   * @param {(signal?: AbortSignal) => void} [options.onAbort] diagnostic hook
   */
  constructor({ enabled = true, onAbort } = {}) {
    this.enabled = enabled
    this.onAbort = onAbort
    this.tail = Promise.resolve()
    this.pending = 0
    this.completed = 0
  }

  /** @returns {{ pending: number, completed: number }} */
  stats() {
    return { pending: this.pending, completed: this.completed }
  }

  /**
   * Run `task` once every earlier task has finished.
   *
   * Waiting is abortable. Without that, one task stuck until its timeout — a browser
   * that froze, say — would hold every later caller in the same silent wait, which is
   * the same defect class as an unresponsive stream reader.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async run(task, { signal } = {}) {
    if (!this.enabled) {
      signal?.throwIfAborted?.()
      return task()
    }
    this.pending += 1
    const previous = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    try {
      await awaitAbortable(previous, signal)
      signal?.throwIfAborted?.()
      return await task()
    } finally {
      this.pending -= 1
      this.completed += 1
      release()
    }
  }
}

/**
 * A per-provider dispatch gate: one request in flight, plus a per-model minimum gap.
 *
 * Two mechanisms because one is not enough. Serialising prevents overlap but not
 * back-to-back dispatch — two calls can leave milliseconds apart and still collide with
 * a provider's concurrency window. The gap is measured from the previous *dispatch*
 * rather than on a fixed cadence, because requests themselves take seconds and a fixed
 * cadence would fight the request duration.
 *
 * Stateful by design: create one per provider and keep it. Constructing one per request
 * would make both mechanisms no-ops.
 */
export class ModelGate {
  /**
   * @param {object} [options]
   * @param {boolean} [options.serialize]
   * @param {Readonly<Record<string, number>>} [options.gaps] per-model minimum gap, keyed lowercase
   * @param {number} [options.defaultGapMs]
   * @param {() => number} [options.now]
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
   */
  constructor({ serialize = true, gaps = {}, defaultGapMs = 0, now = () => Date.now(), sleep = defaultSleep } = {}) {
    this.serialize = serialize
    this.gaps = gaps
    this.defaultGapMs = defaultGapMs
    this.now = now
    this.sleep = sleep
    this.tail = Promise.resolve()
    this.depth = 0
    /** @type {Map<string, number>} */
    this.lastDispatchAt = new Map()
  }

  /** @returns {number} */
  queueDepth() {
    return this.depth
  }

  /**
   * @template T
   * @param {string} modelKey
   * @param {() => Promise<T>} task - should be the single fetch, nothing longer
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async run(modelKey, task, { signal } = {}) {
    const key = modelKey.toLowerCase()
    if (!this.serialize) {
      await this.waitGap(key, signal)
      this.markDispatch(key)
      return task()
    }
    this.depth += 1
    const previous = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    try {
      await awaitAbortable(previous, signal)
      await this.waitGap(key, signal)
      this.markDispatch(key)
      return await task()
    } finally {
      this.depth -= 1
      release()
    }
  }

  /**
   * @param {string} modelKey
   * @param {AbortSignal} [signal]
   */
  async waitGap(modelKey, signal) {
    const gap = this.gaps[modelKey] ?? this.defaultGapMs
    if (gap <= 0) return
    const last = this.lastDispatchAt.get(modelKey)
    if (last === undefined) return
    const remaining = gap - (this.now() - last)
    if (remaining <= 0) return
    await this.sleep(remaining, signal)
  }

  /** @param {string} modelKey */
  markDispatch(modelKey) {
    this.lastDispatchAt.set(modelKey, this.now())
  }
}

/**
 * Wait for `promise`, but abandon the wait if the caller aborts.
 *
 * The distinction from a plain `await` is the whole point: the caller must learn it was
 * cancelled, not sit behind a task that may never finish.
 *
 * @param {Promise<void>} promise
 * @param {AbortSignal} [signal]
 */
async function awaitAbortable(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) throw new SlotAbortedError()
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new SlotAbortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => { signal.removeEventListener('abort', onAbort); resolve() },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * Sleep that honours a signal.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleepWithSignal(ms, signal) {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new SlotAbortedError())
    return Promise.resolve()
  }
  if (signal?.aborted) return Promise.reject(new SlotAbortedError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new SlotAbortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** @param {number} ms @param {AbortSignal} [signal] */
const defaultSleep = (ms, signal) => sleepWithSignal(ms, signal)

/**
 * Per-turn state, carried through async calls without threading a parameter through
 * every adapter signature.
 */
const turnStorage = new AsyncLocalStorage()

/**
 * Wrap an adapter so that queue errors rotate accounts and queue waits are bounded.
 *
 * The wrapper owns five pieces of per-turn state: which accounts were tried, which
 * credential refreshes happened, which auth refreshes happened, the currently selected
 * account, and whether output has been delivered. All five reset per turn, because
 * leaking them across turns would permanently blacklist accounts after enough usage.
 *
 * ## Credential refreshes are budgeted per account, per kind
 *
 * A credential refresh (the stored token looked expired) and an auth refresh (the
 * server rejected it) each get one attempt per account per turn. Without the budget, a
 * provider that always answers 401 turns into an unbounded refresh loop; with it, the
 * second attempt reports AUTH and the user learns the truth.
 *
 * @template {object} O
 * @template {object} A
 * @param {object} spec
 * @param {string} spec.provider
 * @param {O} spec.options - the adapter's own options, plus the hooks below
 * @param {(options: O) => A} spec.create - builds the adapter
 * @param {(model: string) => AsyncIterable<unknown>} spec.open - starts one attempt
 * @param {object} [spec.timing]
 * @returns {A}
 */
export function withQueueRotation({ provider, options, create, timing = {} }) {
  const now = timing.now ?? (() => Date.now())
  const sleep = timing.sleep ?? sleepWithSignal
  const onAccountSelected = timing.onAccountSelected ?? (() => {})

  const currentTurn = () => turnStorage.getStore()

  /** Pin the chosen account and remember it as tried. */
  const remember = (turn, entry, credential) => {
    turn.account = { entry, credential }
    turn.tried.add(entry.id)
    onAccountSelected(provider, entry.id)
  }

  const scoped = { ...options }

  if (options.accountPool !== undefined) {
    const pool = options.accountPool
    scoped.accountPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'getAvailableAccount') {
          return async (id, model, excluded) => {
            const turn = currentTurn()
            const relevant = turn !== undefined && id === provider && model === turn.model
            const skip = relevant ? new Set([...turn.tried, ...(excluded ?? [])]) : excluded
            const found = await target.getAvailableAccount(id, model, skip)
            if (found !== null && found !== undefined && relevant) remember(turn, found.entry, found.credential)
            return found
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    if (options.nextAccount !== undefined) {
      const nextAccount = options.nextAccount
      scoped.nextAccount = async (model, tried) => {
        const turn = currentTurn()
        const relevant = turn !== undefined && model === turn.model
        const skip = relevant ? new Set([...tried, ...turn.tried]) : tried
        const next = await nextAccount(model, skip)
        if (next !== undefined && relevant) {
          const entry = pool.listAccountsByProvider(provider).find(row => row.id === next.accountId)
          if (entry !== undefined) remember(turn, entry, next.credential)
        }
        return next
      }
    }

    if (options.resolveCredential !== undefined) {
      const resolveCredential = options.resolveCredential
      scoped.resolveCredential = async model => {
        const turn = currentTurn()
        if (turn?.account !== undefined) {
          // Re-validate the pinned account through the provider's own strategy so that
          // policy living in `nextAccount` (Loomy's balance tiers, say) is not bypassed
          // by falling back to the generic pool.
          const others = new Set(pool.listAccountsByProvider(provider)
            .filter(row => row.id !== turn.account.entry.id)
            .map(row => row.id))
          if (options.nextAccount !== undefined) {
            const next = await options.nextAccount(turn.model, others)
              ?? await options.nextAccount(turn.model, turn.tried)
            if (next === undefined) {
              throw new AccountError(
                `${provider}: the current account is unusable or its balance is unknown, and no fallback satisfies the channel policy`,
                ACCOUNT_ERROR_CODES.QUEUE,
              )
            }
            const entry = pool.listAccountsByProvider(provider).find(row => row.id === next.accountId
              && row.enabled !== false
              && !(row.modelRateLimits?.[turn.model] > now()))
            if (entry === undefined) {
              throw new AccountError(`${provider}: the account for this request was removed, disabled or limited`, ACCOUNT_ERROR_CODES.QUEUE)
            }
            remember(turn, entry, next.credential)
            return next.credential
          }
          const next = await pool.getAvailableAccount(provider, turn.model, others)
            ?? await pool.getAvailableAccount(provider, turn.model, turn.tried)
          if (next === null || next === undefined) {
            throw new AccountError(`${provider}: the current account is unusable and there is no fallback`, ACCOUNT_ERROR_CODES.QUEUE)
          }
          remember(turn, next.entry, next.credential)
          return next.credential
        }
        const credential = await resolveCredential(model)
        if (turn !== undefined && typeof credential === 'object' && credential !== null) {
          // Attribute the resolved credential back to an account so the ledger and
          // rotation bookkeeping know which row served this turn.
          const field = provider === 'zcode' ? 'zcode_jwt' : 'access_token'
          const token = credential[field]
          if (typeof token === 'string' && token.length > 0) {
            const id = await pool.findAccountIdByIdentityField(provider, field, token).catch(() => '')
            const entry = pool.listAccountsByProvider(provider).find(row => row.id === id && row.enabled !== false)
            if (entry !== undefined) remember(turn, entry, credential)
          }
        }
        return credential
      }
    }

    if (options.currentAccountId !== undefined) {
      const fallback = options.currentAccountId
      scoped.currentAccountId = () => currentTurn()?.account?.entry.id ?? fallback()
    }
  }

  if (options.refresh !== undefined) {
    const refresh = options.refresh
    scoped.refresh = async (accountId, reason) => {
      const turn = currentTurn()
      const id = accountId ?? turn?.account?.entry.id
      if (turn !== undefined) {
        const budget = reason === 'auth' ? turn.authRefreshes : turn.credentialRefreshes
        if (budget.has(id)) {
          throw new AccountError(
            `${provider}: this account already attempted ${reason === 'auth' ? 'an auth refresh' : 'a credential refresh'}`,
            ACCOUNT_ERROR_CODES.AUTH,
          )
        }
        budget.add(id)
      }
      return refresh(id, reason)
    }
  }

  const adapter = create(scoped)

  /**
   * Drive one turn: open, yield, and on a queue error decide whether to wait or rotate.
   */
  const drive = async function* (input, open) {
    const { model, signal } = input
    /** @type {any} */
    const turn = {
      provider,
      model,
      tried: new Set(),
      credentialRefreshes: new Set(),
      authRefreshes: new Set(),
      account: undefined,
      delivered: false,
    }
    const deadline = now() + QUEUE_DEADLINE_MS
    let attempts = 0
    let queueHits = 0
    let queueingSince

    for (;;) {
      signal?.throwIfAborted?.()
      if (now() >= deadline) throw new AccountError(`${provider}: queue wait timed out`, ACCOUNT_ERROR_CODES.QUEUE)
      const iterator = open()[Symbol.asyncIterator]()
      try {
        for (;;) {
          const step = await turnStorage.run(turn, () => iterator.next())
          if (step.done === true) return
          // Marked before yielding: from the caller's perspective the chunk is
          // delivered the moment it is yielded, so the flag must already be set.
          turn.delivered = true
          yield step.value
        }
      } catch (error) {
        if (!(error instanceof ModelQueuedError) || turn.delivered) throw error
        signal?.throwIfAborted?.()
        attempts += 1
        if (attempts > QUEUE_MAX_ATTEMPTS || now() >= deadline) {
          throw new AccountError(`${provider}: queue retries or wait time exhausted`, ACCOUNT_ERROR_CODES.QUEUE)
        }
        queueHits += 1
        queueingSince ??= now()
        if (queueHits >= QUEUE_HITS_BEFORE_ROTATE || now() - queueingSince >= QUEUE_MS_BEFORE_ROTATE) {
          queueHits = 0
          queueingSince = now()
          const rotated = await turnStorage.run(turn, () => rotate(turn))
          if (rotated) continue
        }
        const waitMs = Math.min(
          Math.max(100, error.retryAfterMs ?? 1_000),
          QUEUE_MAX_DELAY_MS,
          deadline - now(),
        )
        await sleep(waitMs, signal)
      } finally {
        await turnStorage.run(turn, () => iterator.return?.())
      }
    }
  }

  /**
   * Try to move this turn onto a different account.
   *
   * Order of preference: the provider's own strategy, then the generic pool. The
   * provider hook goes first because channel-specific policy (Loomy's permanent-credit
   * lock) lives there, and reaching past it to the pool would spend credits the user
   * asked us to protect.
   *
   * @param {any} turn
   * @returns {Promise<boolean>}
   */
  const rotate = async turn => {
    if (scoped.nextAccount !== undefined) {
      const next = await scoped.nextAccount(turn.model, turn.tried)
      return next !== undefined
    }
    if (options.accountPool !== undefined) {
      const next = await options.accountPool.getAvailableAccount(provider, turn.model, turn.tried)
      if (next !== null && next !== undefined) {
        remember(turn, next.entry, next.credential)
        return true
      }
    }
    return false
  }

  return new Proxy(adapter, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'stream' && typeof value === 'function') {
        return input => drive(input, () => value.call(target, input))
      }
      if (prop === 'prepareCall' && typeof value === 'function') {
        return async (...args) => {
          const call = await value.apply(target, args)
          return { ...call, stream: input => drive(input, () => call.stream(input)) }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
