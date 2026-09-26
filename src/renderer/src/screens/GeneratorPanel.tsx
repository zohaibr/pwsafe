import { useEffect, useId, useState } from 'react'
import { LOOK_ALIKES } from '@shared/generator'
import { GENERATOR_MAX_LENGTH, GENERATOR_MIN_LENGTH } from '@shared/limits'
import type { GeneratorOptions, Settings } from '@shared/types'
import { useApi, useGenerator } from '../api'
import { entropyBits, strengthLabel } from '../strength'
import { Icon } from '../components/Icons'
import { DEFAULT_GENERATOR } from '../defaults'

type SetKey = 'upper' | 'lower' | 'digits' | 'symbols'
const SETS: Array<{ key: SetKey; label: string }> = [
  { key: 'upper', label: 'Uppercase (A–Z)' },
  { key: 'lower', label: 'Lowercase (a–z)' },
  { key: 'digits', label: 'Digits (0–9)' },
  { key: 'symbols', label: 'Symbols (!#$%…)' },
]

/**
 * Password generator (§B1). The preview and strength label always come from the options shown;
 * at least one character type stays on; the options are remembered through settings.
 */
export function GeneratorPanel(props: { onUse: (password: string) => void }) {
  const api = useApi()
  const generate = useGenerator()
  const hintId = useId()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [options, setOptions] = useState<GeneratorOptions>(DEFAULT_GENERATOR)
  const [preview, setPreview] = useState(() => generate(DEFAULT_GENERATOR))

  useEffect(() => {
    let live = true
    void api.getSettings().then((r) => {
      if (!live || !r.ok) return
      setSettings(r.value)
      setOptions(r.value.generator)
      setPreview(generate(r.value.generator))
    })
    return () => {
      live = false
    }
  }, [api, generate])

  const update = (patch: Partial<GeneratorOptions>) => {
    const next = { ...options, ...patch }
    setOptions(next)
    setPreview(generate(next))
    if (settings) {
      const nextSettings = { ...settings, generator: next }
      setSettings(nextSettings)
      void api.setSettings(nextSettings)
    }
  }

  const onCount = SETS.filter((s) => options[s.key]).length
  const strength = strengthLabel(options)

  return (
    <fieldset className="generator" aria-describedby={hintId}>
      <legend>Generate a password</legend>
      <div className="generator-preview">
        {preview.ok ? (
          <p className="mono preview-value" data-testid="generated-preview">
            <span className="visually-hidden">Generated password: </span>
            {preview.value}
          </p>
        ) : (
          <p className="preview-value field-error" role="alert">
            {preview.error.message}
          </p>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Generate another"
          title="Generate another"
          onClick={() => setPreview(generate(options))}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <p className="strength" data-strength={strength} data-testid="strength">
        Strength: <strong>{strength}</strong>{' '}
        <span className="muted">({Math.round(entropyBits(options))} bits)</span>
      </p>
      <div className="field inline">
        <label htmlFor="gen-length">Length</label>
        <input
          id="gen-length"
          type="range"
          min={GENERATOR_MIN_LENGTH}
          max={GENERATOR_MAX_LENGTH}
          value={options.length}
          onChange={(e) => update({ length: Number(e.target.value) })}
        />
        <span className="length-value" aria-hidden="true">
          {options.length}
        </span>
      </div>
      <div className="checks">
        {SETS.map((s) => {
          const lastOn = options[s.key] && onCount === 1
          return (
            <label key={s.key} className="check">
              <input
                type="checkbox"
                checked={options[s.key]}
                disabled={lastOn}
                aria-describedby={lastOn ? hintId : undefined}
                onChange={(e) => update({ [s.key]: e.target.checked })}
              />
              {s.label}
            </label>
          )
        })}
        <label className="check">
          <input
            type="checkbox"
            checked={options.avoidLookAlikes}
            onChange={(e) => update({ avoidLookAlikes: e.target.checked })}
          />
          Avoid look-alike characters ({[...LOOK_ALIKES].join(' ')})
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={options.requireEachSelected}
            onChange={(e) => update({ requireEachSelected: e.target.checked })}
          />
          Use at least one of each selected type
        </label>
      </div>
      <p id={hintId} className="muted small">
        At least one character type must stay on.
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="button"
          disabled={!preview.ok}
          onClick={() => {
            if (preview.ok) props.onUse(preview.value)
          }}
        >
          Use this password
        </button>
      </div>
    </fieldset>
  )
}
