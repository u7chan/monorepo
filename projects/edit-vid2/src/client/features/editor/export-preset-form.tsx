import type { ExportPreset } from '#/shared/schemas'

interface ExportPresetFormProps {
  preset: ExportPreset
  onChange: (preset: ExportPreset) => void
}

const videoCodecLabels: Record<string, string> = {
  libx264: 'H.264',
  libx265: 'H.265',
}

const speedLabels: Record<string, string> = {
  ultrafast: '超高速',
  fast: '高速',
  medium: '標準',
  slow: '低速 (高圧縮)',
}

export function ExportPresetForm({ preset, onChange }: ExportPresetFormProps) {
  return (
    <div className='space-y-3'>
      <div>
        <label className='block text-xs text-gray-500 dark:text-gray-400'>ビデオコーデック</label>
        <select
          value={preset.videoCodec}
          onChange={(e) => onChange({ ...preset, videoCodec: e.target.value as ExportPreset['videoCodec'] })}
          className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
        >
          <option value='libx264'>{videoCodecLabels.libx264}</option>
          <option value='libx265'>{videoCodecLabels.libx265}</option>
        </select>
      </div>
      <div>
        <label className='block text-xs text-gray-500 dark:text-gray-400'>品質 (CRF: 0-51, 低いほど高品質)</label>
        <input
          type='range'
          min={0}
          max={51}
          value={preset.crf}
          onChange={(e) => onChange({ ...preset, crf: Number(e.target.value) })}
          className='w-full'
        />
        <span className='text-xs text-gray-400'>{preset.crf}</span>
      </div>
      <div>
        <label className='block text-xs text-gray-500 dark:text-gray-400'>エンコード速度</label>
        <select
          value={preset.preset}
          onChange={(e) => onChange({ ...preset, preset: e.target.value as ExportPreset['preset'] })}
          className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
        >
          <option value='ultrafast'>{speedLabels.ultrafast}</option>
          <option value='fast'>{speedLabels.fast}</option>
          <option value='medium'>{speedLabels.medium}</option>
          <option value='slow'>{speedLabels.slow}</option>
        </select>
      </div>
    </div>
  )
}

export function ExportPresetSummary({ preset }: { preset: ExportPreset }) {
  return (
    <span className='text-xs text-gray-500 dark:text-gray-400'>
      {videoCodecLabels[preset.videoCodec] ?? preset.videoCodec} · CRF {preset.crf} ·{' '}
      {speedLabels[preset.preset] ?? preset.preset}
    </span>
  )
}
