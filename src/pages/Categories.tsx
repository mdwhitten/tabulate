import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Trash2, Plus, Check, Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useCategoryList, useCreateCategory, useUpdateCategory, useDeleteCategory } from '../hooks/useCategories'
import type { Category } from '../types'

// ── Constants ────────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#b04f70', '#4f7ab0', '#7ab04f', '#b08a4f',
  '#e06060', '#50b090', '#8068c0', '#c08850',
  '#5898b8', '#a0607a', '#609848', '#d08040',
]

// ── Types ────────────────────────────────────────────────────────────────────

interface EditDraft {
  name: string
  icon: string
  color: string
}

// ── Color Swatches ────────────────────────────────────────────────────────────

function ColorSwatches({ selected, onSelect }: { selected: string; onSelect: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {PRESET_COLORS.map(color => (
        <button key={color} type="button" onClick={() => onSelect(color)}
          className={cn(
            'w-5 h-5 rounded-full transition-all',
            selected === color ? 'ring-2 ring-offset-1 ring-gray-800 scale-110' : 'hover:scale-110'
          )}
          style={{ backgroundColor: color }} title={color}>
          {selected === color && <Check className="w-3 h-3 text-white mx-auto" strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}

// ── Emoji Picker ─────────────────────────────────────────────────────────────

const EMOJI_OPTIONS: Record<string, [string, string][]> = {
  'Produce':     [['🥬','leafy greens lettuce'],['🍎','apple fruit'],['🥕','carrot'],['🍌','banana'],['🍇','grapes'],['🍓','strawberry berry'],['🥑','avocado'],['🌽','corn'],['🍋','lemon citrus'],['🥦','broccoli'],['🍅','tomato'],['🌶️','pepper chili spicy'],['🥒','cucumber'],['🍑','peach'],['🫐','blueberry berry'],['🥭','mango']],
  'Meat & Deli': [['🥩','steak beef meat'],['🍗','chicken poultry leg'],['🥓','bacon pork'],['🌭','hot dog sausage'],['🍖','meat bone ribs'],['🐔','chicken poultry'],['🐄','beef cow'],['🐖','pork pig'],['🦃','turkey'],['🥪','sandwich deli sub']],
  'Seafood':     [['🐟','fish'],['🦐','shrimp prawn'],['🦞','lobster'],['🐙','octopus'],['🦀','crab'],['🍣','sushi']],
  'Dairy & Eggs':[['🥛','milk'],['🧀','cheese'],['🥚','egg'],['🧈','butter'],['🍦','ice cream'],['🍶','yogurt']],
  'Bakery':      [['🍞','bread loaf'],['🥐','croissant pastry'],['🥖','baguette french'],['🧁','cupcake muffin'],['🎂','cake birthday'],['🍰','cake slice pie'],['🥯','bagel'],['🥞','pancake waffle'],['🍩','donut doughnut'],['🍪','cookie biscuit']],
  'Beverages':   [['🥤','soda drink cup'],['☕','coffee'],['🍷','wine'],['🍺','beer'],['🧃','juice box'],['🥂','champagne sparkling'],['🍵','tea'],['🧋','boba bubble tea'],['💧','water'],['🥃','whiskey liquor']],
  'Snacks':      [['🍿','popcorn'],['🍫','chocolate candy bar'],['🥜','peanut nuts'],['🍬','candy sweet'],['🍭','lollipop'],['🧂','salt seasoning'],['🥨','pretzel'],['🍘','rice cracker']],
  'Pantry':      [['🥫','canned can soup'],['🍝','pasta noodle spaghetti'],['🍚','rice grain'],['🫘','beans legume'],['🍯','honey'],['🥣','cereal oatmeal bowl'],['🫒','olive oil'],['🧄','garlic'],['📦','box package']],
  'Frozen':      [['🧊','ice frozen'],['🍕','pizza'],['🥟','dumpling'],['🍨','ice cream frozen']],
  'Household':   [['🧹','broom clean sweep'],['🧴','soap lotion bottle'],['🧻','toilet paper tissue'],['🧽','sponge'],['🪣','bucket mop'],['💡','light bulb'],['🕯️','candle'],['🧺','laundry basket']],
  'Health':      [['💊','pill medicine vitamin'],['🩹','bandaid bandage'],['🪥','toothbrush dental'],['🧪','pharmacy lab']],
  'Baby & Pets': [['👶','baby infant'],['🍼','bottle formula'],['🐾','pet paw'],['🐕','dog puppy']],
  'Other':       [['🏷️','tag label price'],['🛒','cart shopping'],['💰','money cost'],['🎁','gift present'],['✨','sparkle special'],['⭐','star favorite']],
}

function EmojiPicker({ selected, onSelect, initialOpen = false }: { selected: string; onSelect: (e: string) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const dropHeight = 320 // matches max-h-[320px]
  const gap = 6

  const calcPos = useCallback(() => {
    if (!btnRef.current) return null
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - gap
    const top = spaceBelow >= dropHeight ? r.bottom + gap : r.top - gap - dropHeight
    return { top, left: r.left }
  }, [])

  function handleOpen() {
    if (open) { setOpen(false); setPos(null); setSearch(''); return }
    setPos(calcPos())
    setSearch('')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false); setPos(null); setSearch('')
    }
    function handleScroll() { setPos(calcPos()) }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, calcPos])

  // For initialOpen, compute position on mount
  useEffect(() => {
    if (initialOpen && !pos) setPos(calcPos())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-shrink-0">
      <button ref={btnRef} type="button" onClick={handleOpen}
        className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center overflow-hidden hover:bg-gray-200 hover:ring-2 hover:ring-[#03a9f4]/30 transition-all cursor-pointer">
        <span className="text-xl leading-none">{selected || '📦'}</span>
      </button>
      {open && pos && createPortal(
        <div ref={dropRef} style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-xl shadow-lg w-[280px] max-h-[320px] flex flex-col">
          <div className="p-2 pb-0 flex-shrink-0">
            <input ref={searchRef} type="text" value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search emojis..."
              className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]" />
          </div>
          <div className="p-3 pt-2 overflow-y-auto">
            {(() => {
              const q = search.toLowerCase().trim()
              const filtered = Object.entries(EMOJI_OPTIONS).map(([group, items]) => {
                const matched = q
                  ? items.filter(([, kw]) => kw.includes(q) || group.toLowerCase().includes(q))
                  : items
                return [group, matched] as const
              }).filter(([, items]) => items.length > 0)

              if (filtered.length === 0) {
                return <div className="text-xs text-gray-400 text-center py-4">No emojis found</div>
              }

              return filtered.map(([group, items]) => (
                <div key={group} className="mb-2 last:mb-0">
                  <div className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold mb-1">{group}</div>
                  <div className="flex flex-wrap gap-0.5">
                    {items.map(([emoji]) => (
                      <button key={emoji} type="button"
                        onClick={() => { onSelect(emoji); setOpen(false); setSearch('') }}
                        className={cn(
                          'w-7 h-7 rounded-lg flex items-center justify-center text-base hover:bg-gray-100 transition-colors',
                          selected === emoji && 'bg-blue-100 ring-1 ring-[#03a9f4]'
                        )}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            })()}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Inline Edit Row ───────────────────────────────────────────────────────────

interface EditRowProps {
  draft: EditDraft
  isBuiltin: boolean
  saveLabel: string
  saving?: boolean
  initialIconPickerOpen?: boolean
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  onChange: (d: EditDraft) => void
  onSave: () => void
  onCancel: () => void
}

function EditRow({ draft, isBuiltin, saveLabel, saving, initialIconPickerOpen, nameInputRef, onChange, onSave, onCancel }: EditRowProps) {
  return (
    <div className="px-5 py-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {!isBuiltin ? (
          <EmojiPicker selected={draft.icon} onSelect={icon => onChange({ ...draft, icon })} initialOpen={initialIconPickerOpen} />
        ) : (
          <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
            <span className="text-xl leading-none">{draft.icon || '📦'}</span>
          </div>
        )}

        <input type="text" value={draft.name}
          ref={nameInputRef}
          onChange={e => onChange({ ...draft, name: e.target.value })}
          disabled={isBuiltin}
          placeholder="Category name"
          className={cn(
            'flex-1 text-sm font-medium text-gray-900 bg-white border border-gray-200 rounded-lg px-3 py-1.5',
            'focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]',
            isBuiltin && 'opacity-50 cursor-not-allowed bg-gray-50'
          )} />

        <div className="flex items-center gap-2 flex-shrink-0">
          <button type="button" onClick={onSave} disabled={!draft.name.trim() || saving}
            className={cn(
              'text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors',
              'bg-[#03a9f4] text-white hover:bg-[#0290d1]',
              'disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1'
            )}>
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {saveLabel}
          </button>
          <button type="button" onClick={onCancel}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors text-gray-500 hover:bg-gray-100">
            Cancel
          </button>
        </div>
      </div>

      {!isBuiltin && (
        <div className="flex items-center gap-3 pl-13">
          <span className="text-[11px] uppercase tracking-widest text-gray-400 font-semibold w-10 flex-shrink-0">Color</span>
          <ColorSwatches selected={draft.color} onSelect={color => onChange({ ...draft, color })} />
        </div>
      )}
    </div>
  )
}

// ── Active Row ────────────────────────────────────────────────────────────────

interface ActiveRowProps {
  cat: Category
  isEditing: boolean
  editDraft: EditDraft | null
  onEditStart: (openIconPicker?: boolean) => void
  onEditChange: (d: EditDraft) => void
  onEditSave: () => void
  onEditCancel: () => void
  onDisable: () => void
  onDelete: () => void
  saving?: boolean
  iconPickerOpen?: boolean
}

function ActiveRow({ cat, isEditing, editDraft, onEditStart, onEditChange, onEditSave, onEditCancel, onDisable, onDelete, saving, iconPickerOpen }: ActiveRowProps) {
  if (isEditing && editDraft) {
    return (
      <div className="border-b border-gray-50 bg-blue-50/30">
        <EditRow draft={editDraft} isBuiltin={cat.is_builtin} saveLabel="Save"
          saving={saving} initialIconPickerOpen={iconPickerOpen} onChange={onEditChange} onSave={onEditSave} onCancel={onEditCancel} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 rounded-xl group border-b border-gray-50 transition-colors">
      <button type="button" onClick={cat.is_builtin ? undefined : () => onEditStart(true)}
        className={cn(
          'w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0',
          !cat.is_builtin && 'hover:bg-gray-200 hover:ring-2 hover:ring-[#03a9f4]/30 transition-all cursor-pointer'
        )}
        title={cat.is_builtin ? undefined : 'Click to change icon'}>
        <span className="text-xl leading-none">{cat.icon}</span>
      </button>
      <div className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
      <span className="text-sm font-medium text-gray-900">{cat.name}</span>
      {cat.is_builtin ? (
        <span className="text-[10px] uppercase font-semibold tracking-wide px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Built-in</span>
      ) : (
        <span className="text-[10px] uppercase font-semibold tracking-wide px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">Custom</span>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-1">
        {cat.is_builtin ? (
          <button type="button" onClick={onDisable}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors text-gray-500 hover:bg-gray-100">
            Disable
          </button>
        ) : (
          <>
            <button type="button" onClick={() => onEditStart(false)}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors text-gray-500 hover:bg-gray-100">
              <Pencil className="w-3 h-3" /> Edit
            </button>
            <button type="button" onClick={onDelete}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors text-red-400 hover:bg-red-50 opacity-0 group-hover:opacity-100">
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── Disabled Row ──────────────────────────────────────────────────────────────

function DisabledRow({ cat, onEnable }: { cat: Category; onEnable: () => void }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 rounded-xl border-b border-gray-50 last:border-b-0 transition-colors">
      <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0 opacity-50">
        <span className="text-xl leading-none">{cat.icon}</span>
      </div>
      <div className="w-3.5 h-3.5 rounded-full flex-shrink-0 opacity-50" style={{ backgroundColor: cat.color }} />
      <span className="text-sm font-medium text-gray-900 opacity-50">{cat.name}</span>
      {cat.is_builtin ? (
        <span className="text-[10px] uppercase font-semibold tracking-wide px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">Built-in</span>
      ) : (
        <span className="text-[10px] uppercase font-semibold tracking-wide px-2 py-0.5 rounded-full bg-blue-50 text-blue-400">Custom</span>
      )}
      <div className="flex-1" />
      <button type="button" onClick={onEnable}
        className="text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors text-gray-500 hover:bg-gray-100">
        Enable
      </button>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function Categories() {
  const { data: categories = [], isLoading } = useCategoryList()
  const createMut = useCreateCategory()
  const updateMut = useUpdateCategory()
  const deleteMut = useDeleteCategory()

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [showNew, setShowNew]     = useState(false)
  const [newDraft, setNewDraft]   = useState<EditDraft>({
    name: '', icon: '📦', color: PRESET_COLORS[0],
  })
  const newRowRef  = useRef<HTMLDivElement>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  // Scroll to and focus the new category name input when shown
  useEffect(() => {
    if (showNew) {
      // Use requestAnimationFrame to wait for the DOM to render
      requestAnimationFrame(() => {
        newRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        newNameRef.current?.focus()
      })
    }
  }, [showNew])

  const activeCats   = categories.filter(c => !c.is_disabled)
  const disabledCats = categories.filter(c => c.is_disabled)

  function startEdit(cat: Category, openIconPicker = false) {
    setEditingId(cat.id)
    setIconPickerOpen(openIconPicker)
    setShowNew(false)
    setEditDraft({ name: cat.name, icon: cat.icon, color: cat.color })
  }

  function cancelEdit() { setEditingId(null); setEditDraft(null); setIconPickerOpen(false) }

  async function saveEdit() {
    if (!editDraft || !editDraft.name.trim() || editingId == null) return
    await updateMut.mutateAsync({ id: editingId, name: editDraft.name.trim(), icon: editDraft.icon, color: editDraft.color })
    setEditingId(null)
    setEditDraft(null)
  }

  async function toggleDisable(id: number, is_disabled: boolean) {
    await updateMut.mutateAsync({ id, is_disabled })
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this category?')) return
    await deleteMut.mutateAsync(id)
  }

  function startNew() {
    setShowNew(true)
    setEditingId(null)
    setNewDraft({ name: '', icon: '📦', color: PRESET_COLORS[0] })
  }

  async function createCategory() {
    if (!newDraft.name.trim()) return
    await createMut.mutateAsync({ name: newDraft.name.trim(), icon: newDraft.icon || '📦', color: newDraft.color })
    setShowNew(false)
  }

  if (isLoading) {
    return (
      <div className="max-w-3xl flex items-center justify-center py-32 gap-2 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading categories…</span>
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <p className="text-[11px] uppercase tracking-widest font-semibold text-gray-400 mb-0.5">Manage</p>
            <h2 className="text-base font-bold text-gray-900">Categories</h2>
          </div>
          <button type="button" onClick={startNew} disabled={showNew}
            className={cn(
              'flex items-center gap-1.5 bg-[#03a9f4] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#0290d1] transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}>
            <Plus className="w-4 h-4" />
            New Category
          </button>
        </div>

        {/* Active list */}
        <div>
          {activeCats.map(cat => (
            <ActiveRow key={cat.id} cat={cat}
              isEditing={editingId === cat.id}
              editDraft={editingId === cat.id ? editDraft : null}
              iconPickerOpen={editingId === cat.id ? iconPickerOpen : false}
              onEditStart={(openPicker) => startEdit(cat, openPicker)}
              onEditChange={setEditDraft}
              onEditSave={saveEdit}
              onEditCancel={cancelEdit}
              onDisable={() => toggleDisable(cat.id, true)}
              onDelete={() => handleDelete(cat.id)}
              saving={updateMut.isPending} />
          ))}

          {showNew && (
            <div ref={newRowRef} className="border-b border-gray-50 bg-blue-50/30">
              <EditRow draft={newDraft} isBuiltin={false} saveLabel="Create"
                saving={createMut.isPending}
                nameInputRef={newNameRef}
                onChange={setNewDraft} onSave={createCategory} onCancel={() => setShowNew(false)} />
            </div>
          )}
        </div>

        {/* Disabled section */}
        {disabledCats.length > 0 && (
          <>
            <div className="text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-5 py-2 bg-gray-50 border-t border-gray-100">
              Disabled
            </div>
            <div>
              {disabledCats.map(cat => (
                <DisabledRow key={cat.id} cat={cat} onEnable={() => toggleDisable(cat.id, false)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
