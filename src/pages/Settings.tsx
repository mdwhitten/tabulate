import { useEffect, useRef, useState } from 'react'
import { Loader2, Check, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'
import { useCategoryList } from '../hooks/useCategories'
import {
  useYnabConfig,
  useYnabBudgets,
  useYnabAccounts,
  useYnabCategories,
  useSaveYnabConfig,
} from '../hooks/useYnab'
import type { YnabCategoryGroup } from '../types'

// ── YNAB category <select> (grouped) ──────────────────────────────────────────

function YnabCategorySelect({
  value, onChange, groups, disabled, placeholder,
}: {
  value: string
  onChange: (v: string) => void
  groups: YnabCategoryGroup[]
  disabled?: boolean
  placeholder: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        'text-sm bg-white border border-gray-200 rounded-lg px-3 py-1.5 min-w-[200px]',
        'focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
      )}
    >
      <option value="">{placeholder}</option>
      {groups.map(g => (
        <optgroup key={g.id} label={g.name}>
          {g.categories.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function Settings() {
  const { data: config, isLoading: configLoading } = useYnabConfig()
  const { data: categories = [] } = useCategoryList()
  const saveMut = useSaveYnabConfig()

  const tokenPresent = config?.token_present ?? false

  // ── Local form state ─────────────────────────────────────────────────────────
  const [enabled, setEnabled] = useState(false)
  const [budgetId, setBudgetId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [defaultCategoryId, setDefaultCategoryId] = useState('')
  const [mappings, setMappings] = useState<Record<number, string>>({})
  const [saved, setSaved] = useState(false)
  const hydrated = useRef(false)

  // Seed form from server config once.
  useEffect(() => {
    if (!config || hydrated.current) return
    hydrated.current = true
    setEnabled(config.enabled)
    setBudgetId(config.budget_id ?? '')
    setAccountId(config.account_id ?? '')
    setDefaultCategoryId(config.default_category_id ?? '')
    const m: Record<number, string> = {}
    for (const row of config.mappings) m[row.category_id] = row.ynab_category_id
    setMappings(m)
  }, [config])

  const budgetsQ = useYnabBudgets(tokenPresent)
  const accountsQ = useYnabAccounts(budgetId, tokenPresent)
  const categoriesQ = useYnabCategories(budgetId, tokenPresent)
  const ynabGroups = categoriesQ.data ?? []

  function handleBudgetChange(next: string) {
    if (next === budgetId) return
    setBudgetId(next)
    // Categories/accounts belong to a budget — reset dependent selections.
    setAccountId('')
    setDefaultCategoryId('')
    setMappings({})
  }

  async function handleSave() {
    setSaved(false)
    await saveMut.mutateAsync({
      enabled,
      budget_id: budgetId || null,
      account_id: accountId || null,
      default_category_id: defaultCategoryId || null,
      mappings: Object.entries(mappings)
        .filter(([, ycat]) => !!ycat)
        .map(([catId, ycat]) => ({ category_id: Number(catId), ynab_category_id: ycat })),
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (configLoading) {
    return (
      <div className="max-w-3xl flex items-center justify-center py-32 gap-2 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading settings…</span>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">

        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100">
          <p className="text-[11px] uppercase tracking-widest font-semibold text-gray-400 mb-0.5">Integrations</p>
          <h2 className="text-base font-bold text-gray-900">YNAB</h2>
          <p className="text-xs text-gray-500 mt-1">
            Sync approved receipts to YNAB as transactions. Approved receipts are created as
            unapproved, uncleared transactions so YNAB matches them to your bank feed automatically.
          </p>
        </div>

        {/* Token status */}
        <div className="px-5 py-4 border-b border-gray-100">
          {tokenPresent ? (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <Check className="w-4 h-4" />
              YNAB access token detected
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                No access token configured. Set the <code className="font-mono text-xs bg-amber-100 px-1 py-0.5 rounded">YNAB_API_TOKEN</code>{' '}
                environment variable (a YNAB Personal Access Token) and restart the backend to enable this integration.
              </div>
            </div>
          )}
        </div>

        {/* Enable toggle */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Enable YNAB sync</p>
            <p className="text-xs text-gray-500">When on, approving a receipt sends it to YNAB.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable YNAB sync"
            disabled={!tokenPresent}
            onClick={() => setEnabled(v => !v)}
            className={cn(
              'relative w-11 h-6 rounded-full transition-colors flex-shrink-0',
              enabled ? 'bg-[#03a9f4]' : 'bg-gray-300',
              !tokenPresent && 'opacity-40 cursor-not-allowed',
            )}
          >
            <span className={cn(
              'absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform',
              enabled && 'translate-x-5',
            )} />
          </button>
        </div>

        {/* Budget / account / default category */}
        <div className="px-5 py-4 space-y-4 border-b border-gray-100">
          <div className="flex items-center justify-between gap-4">
            <label className="text-sm font-medium text-gray-700">Budget</label>
            <div className="flex items-center gap-2">
              {budgetsQ.isFetching && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
              <select
                value={budgetId}
                onChange={e => handleBudgetChange(e.target.value)}
                disabled={!tokenPresent}
                className={cn(
                  'text-sm bg-white border border-gray-200 rounded-lg px-3 py-1.5 min-w-[200px]',
                  'focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                <option value="">Select a budget…</option>
                {(budgetsQ.data ?? []).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <label className="text-sm font-medium text-gray-700">Account</label>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              disabled={!tokenPresent || !budgetId}
              className={cn(
                'text-sm bg-white border border-gray-200 rounded-lg px-3 py-1.5 min-w-[200px]',
                'focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              <option value="">Select an account…</option>
              {(accountsQ.data ?? []).map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.closed ? ' (closed)' : ''}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <label className="text-sm font-medium text-gray-700">Default category</label>
              <p className="text-xs text-gray-500">Every transaction starts here; unmapped items land here too.</p>
            </div>
            <YnabCategorySelect
              value={defaultCategoryId}
              onChange={setDefaultCategoryId}
              groups={ynabGroups}
              disabled={!tokenPresent || !budgetId}
              placeholder="Select a category…"
            />
          </div>
        </div>

        {/* Category mapping */}
        <div className="px-5 py-4">
          <p className="text-sm font-medium text-gray-900 mb-1">Category mapping</p>
          <p className="text-xs text-gray-500 mb-3">
            Optionally map each Tabulate category to a YNAB category. When a receipt spans multiple
            mapped categories, the YNAB transaction is split. Unmapped categories fall back to the default.
          </p>
          <div className="space-y-2">
            {categories.filter(c => !c.is_disabled).map(cat => (
              <div key={cat.id} className="flex items-center justify-between gap-4">
                <span className="text-sm text-gray-800 flex items-center gap-2">
                  <span className="text-base leading-none">{cat.icon}</span>
                  {cat.name}
                </span>
                <YnabCategorySelect
                  value={mappings[cat.id] ?? ''}
                  onChange={v => setMappings(m => ({ ...m, [cat.id]: v }))}
                  groups={ynabGroups}
                  disabled={!tokenPresent || !budgetId}
                  placeholder="— Default —"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Save */}
        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-end gap-3">
          {saved && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <Check className="w-4 h-4" /> Saved
            </span>
          )}
          {saveMut.isError && (
            <span className="text-sm text-red-500 flex items-center gap-1">
              <AlertTriangle className="w-4 h-4" /> Save failed
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saveMut.isPending}
            className={cn(
              'flex items-center gap-1.5 bg-[#03a9f4] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#0290d1] transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Save settings
          </button>
        </div>
      </div>
    </div>
  )
}
