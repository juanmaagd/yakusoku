'use client'

import { useMemo, useState } from 'react'
import { formatUnits, toHex } from 'viem'
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
} from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import {
  TASK_INTENT_DOMAIN,
  TASK_INTENT_TYPES,
  USDC_DECIMALS,
  stringifyWithBigint,
  type TaskIntentMessage,
} from '@yakusoku/shared'

const FIREWALL_URL = process.env.NEXT_PUBLIC_FIREWALL_URL ?? 'http://localhost:4001'

const DEFAULTS = {
  task: "Buy a $25 Amazon gift card for my sister's birthday",
  budgetUsdc: 25,
  categories: 'gift_card:amazon',
  hours: 24,
}

type Stage = 'idle' | 'signing' | 'submitting' | 'fetching' | 'done'

interface StoredIntent {
  id: string
  message: { task: string; budget: string; categories: string[]; expiry: string; nonce: string }
  signer: string
  createdAt: string
  remainingBudget: string
}

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

async function postIntent(body: string): Promise<{ id: string; remainingBudget: string }> {
  let res: Response
  try {
    res = await fetch(`${FIREWALL_URL}/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch {
    throw new Error(`Could not reach the firewall at ${FIREWALL_URL}. Is it running?`)
  }
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`
    throw new Error(`Firewall rejected the intent: ${detail}`)
  }
  return parsed as { id: string; remainingBudget: string }
}

async function fetchIntent(id: string): Promise<StoredIntent> {
  let res: Response
  try {
    res = await fetch(`${FIREWALL_URL}/intents/${id}`)
  } catch {
    throw new Error(`Could not reach the firewall at ${FIREWALL_URL}. Is it running?`)
  }
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok || !parsed) {
    throw new Error('Intent was stored, but could not be read back from the firewall.')
  }
  return parsed as StoredIntent
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — the
      // command text is still selectable, so this is a soft failure.
    }
  }

  return (
    <div className="copyable">
      <code>{command}</code>
      <button type="button" onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}

export default function Page() {
  const connection = useConnection()
  const { connect, status: connectStatus, error: connectError } = useConnect()
  const connectors = useConnectors()
  const { disconnect } = useDisconnect()
  const { switchChain, status: switchStatus, error: switchError } = useSwitchChain()
  const { signTypedDataAsync } = useSignTypedData()

  const [task, setTask] = useState(DEFAULTS.task)
  const [budgetUsdc, setBudgetUsdc] = useState(DEFAULTS.budgetUsdc)
  const [categoriesInput, setCategoriesInput] = useState(DEFAULTS.categories)
  const [hours, setHours] = useState(DEFAULTS.hours)

  const [stage, setStage] = useState<Stage>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [storedIntent, setStoredIntent] = useState<StoredIntent | null>(null)

  const categories = useMemo(
    () =>
      categoriesInput
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    [categoriesInput],
  )
  const expiryDate = useMemo(() => new Date(Date.now() + hours * 3_600_000), [hours])
  const isWrongChain = connection.status === 'connected' && connection.chainId !== baseSepolia.id
  const isBusy = stage === 'signing' || stage === 'submitting' || stage === 'fetching'

  async function handleSign() {
    setErrorMessage(null)
    setStoredIntent(null)

    if (connection.status !== 'connected') {
      setErrorMessage('Connect your wallet first.')
      return
    }
    if (categories.length === 0) {
      setErrorMessage('Enter at least one category.')
      return
    }
    if (!Number.isFinite(budgetUsdc) || budgetUsdc <= 0) {
      setErrorMessage('Budget must be greater than zero.')
      return
    }

    const message: TaskIntentMessage = {
      task,
      budget: BigInt(Math.round(budgetUsdc * 10 ** USDC_DECIMALS)),
      categories,
      expiry: BigInt(Math.floor(expiryDate.getTime() / 1000)),
      nonce: randomNonce(),
    }

    try {
      setStage('signing')
      const signature = await signTypedDataAsync({
        domain: TASK_INTENT_DOMAIN,
        types: TASK_INTENT_TYPES,
        primaryType: 'TaskIntent',
        message: { ...message, nonce: message.nonce as `0x${string}` },
      })

      setStage('submitting')
      const { id } = await postIntent(
        stringifyWithBigint({ message, signature, signer: connection.address }),
      )

      setStage('fetching')
      const intent = await fetchIntent(id)

      setStoredIntent(intent)
      setStage('done')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setStage('idle')
    }
  }

  return (
    <main className="page">
      <header>
        <h1>Yakusoku</h1>
        <p className="tagline">Every payment your agent makes keeps the promise you signed — or it does not happen.</p>
        {/* Live dashboard link lands here in WU10. */}
      </header>

      <section className="card">
        <h2>Wallet</h2>
        {connection.status === 'connected' ? (
          <div className="wallet-status">
            <p>
              Connected: <code>{connection.address}</code>
            </p>
            <p>{isWrongChain ? `Wrong network (chain ${connection.chainId})` : 'Base Sepolia'}</p>
            {isWrongChain && (
              <button type="button" onClick={() => switchChain({ chainId: baseSepolia.id })} disabled={switchStatus === 'pending'}>
                {switchStatus === 'pending' ? 'Switching…' : 'Switch to Base Sepolia'}
              </button>
            )}
            {switchError && <p className="error">{switchError.message}</p>}
            <button type="button" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        ) : (
          <div className="wallet-status">
            {connectors.length < 1 && <p>No injected wallet detected. Install MetaMask and reload this page.</p>}
            {connectors.map((connector) => (
              <button key={connector.uid} type="button" onClick={() => connect({ connector })}>
                Connect {connector.name}
              </button>
            ))}
            {connectStatus === 'pending' && <p>Connecting…</p>}
            {connectError && <p className="error">{connectError.message}</p>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>1. Define your intent</h2>
        <label>
          Task
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} />
        </label>
        <label>
          Budget (USDC)
          <input
            type="number"
            min="0"
            step="0.01"
            value={budgetUsdc}
            onChange={(e) => setBudgetUsdc(e.target.valueAsNumber)}
          />
        </label>
        <label>
          Categories (comma-separated)
          <input type="text" value={categoriesInput} onChange={(e) => setCategoriesInput(e.target.value)} />
        </label>
        <label>
          Valid for (hours)
          <input
            type="number"
            min="1"
            step="1"
            value={hours}
            onChange={(e) => setHours(e.target.valueAsNumber)}
          />
        </label>
      </section>

      <section className="card">
        <h2>2. Review before you sign</h2>
        <p className="hint">This is exactly what your wallet will sign. Yakusoku will only pay for purchases that match it.</p>
        <dl className="summary">
          <dt>Task</dt>
          <dd>{task || '—'}</dd>
          <dt>Budget</dt>
          <dd>{Number.isFinite(budgetUsdc) ? budgetUsdc : 0} USDC</dd>
          <dt>Categories</dt>
          <dd>{categories.length > 0 ? categories.join(', ') : '—'}</dd>
          <dt>Expires</dt>
          <dd>{expiryDate.toLocaleString()}</dd>
        </dl>
        <button type="button" onClick={handleSign} disabled={connection.status !== 'connected' || isWrongChain || isBusy}>
          {stage === 'signing' && 'Waiting for wallet signature…'}
          {stage === 'submitting' && 'Sending to firewall…'}
          {stage === 'fetching' && 'Confirming…'}
          {(stage === 'idle' || stage === 'done') && 'Sign intent'}
        </button>
        {errorMessage && (
          <p role="alert" className="error">
            {errorMessage}
          </p>
        )}
      </section>

      {storedIntent && (
        <section className="card">
          <h2>Intent signed and stored</h2>
          <dl className="summary">
            <dt>Intent ID</dt>
            <dd>
              <code>{storedIntent.id}</code>
            </dd>
            <dt>Signer</dt>
            <dd>
              <code>{storedIntent.signer}</code>
            </dd>
            <dt>Remaining budget</dt>
            <dd>{formatUnits(BigInt(storedIntent.remainingBudget), USDC_DECIMALS)} USDC</dd>
            <dt>Expires</dt>
            <dd>{new Date(Number(storedIntent.message.expiry) * 1000).toLocaleString()}</dd>
          </dl>
          <p className="hint">Run the agent against this intent:</p>
          <CopyableCommand command={`bun run agent -- --intent ${storedIntent.id} "${storedIntent.message.task}"`} />
        </section>
      )}
    </main>
  )
}
