import type { SubtitleSettings as SubtitleSettingsType } from '@/types';

interface SubtitleSettingsProps {
  settings: SubtitleSettingsType;
  onChange: (settings: SubtitleSettingsType) => void;
}

export function SubtitleSettings({ settings, onChange }: SubtitleSettingsProps) {
  const handleChange = <K extends keyof SubtitleSettingsType>(
    key: K,
    value: SubtitleSettingsType[K]
  ) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div id="subtitle-settings-container">
      <h3 className="text-lg font-bold mb-2.5">テロップ設定</h3>

      <label className="block mt-2.5 mb-1.5 font-bold text-sm">
        テキストサイズ:
      </label>
      <input
        type="number"
        min={1}
        value={settings.fontSize}
        onChange={(e) => handleChange('fontSize', parseInt(e.target.value, 10) || 1)}
        className="w-full p-2 border border-gray-300 rounded text-sm box-border"
      />

      <label className="block mt-2.5 mb-1.5 font-bold text-sm">
        テキスト色:
      </label>
      <input
        type="color"
        value={settings.fontColor}
        onChange={(e) => handleChange('fontColor', e.target.value)}
        className="w-full p-1 h-10 border border-gray-300 rounded cursor-pointer"
      />

      <label className="block mt-2.5 mb-1.5 font-bold text-sm">
        背景色:
      </label>
      <input
        type="color"
        value={settings.boxColor}
        onChange={(e) => handleChange('boxColor', e.target.value)}
        className="w-full p-1 h-10 border border-gray-300 rounded cursor-pointer"
      />

      <label className="block mt-2.5 mb-1.5 font-bold text-sm">
        背景の不透明度: {settings.boxOpacity}
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.1}
        value={settings.boxOpacity}
        onChange={(e) => handleChange('boxOpacity', parseFloat(e.target.value))}
        className="w-full cursor-pointer"
      />
    </div>
  );
}
