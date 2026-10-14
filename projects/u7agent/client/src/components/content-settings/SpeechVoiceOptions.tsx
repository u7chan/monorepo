import { speechVoiceGroups, type SpeechVoiceOption } from "../../lib/speechVoices";

export type SpeechVoiceOptionsProps = {
  /** 表示順を決めるモデル id。表を引く条件（`google/` だけ）は `speechVoiceGroups` が持つ */
  modelId: string;
  /** 選択中モデルが宣言するボイス。宣言が無いときは空になり、自由記述の欄へ切り替わる */
  voices: readonly string[] | undefined;
};

/** ボイス欄の選択肢。性別は `optgroup` で出し、引けない声はグループの外へラベル無しで並べる */
export function SpeechVoiceOptions({ modelId, voices }: SpeechVoiceOptionsProps) {
  return speechVoiceGroups(modelId, voices).flatMap((group) =>
    group.label === null
      ? group.options.map(voiceOption)
      : [
          <optgroup key={group.label} label={group.label}>
            {group.options.map(voiceOption)}
          </optgroup>,
        ],
  );
}

/** 1 件の選択肢。`value` は送る名前のまま、`label` だけ表示用に加工する */
function voiceOption(option: SpeechVoiceOption) {
  return (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  );
}
