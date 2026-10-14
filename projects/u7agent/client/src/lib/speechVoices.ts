/**
 * 音声ボイスの表示属性（性別と 1 語のスタイル語）と、ボイス欄の表示順。
 * 表は表示専用で、上流へ送る名前・宣言による検証・お試し再生の要求には関与しない。
 * 属性の出所・取得日・更新責任は docs/speech-generation.md を正とする。
 */

/** 表示用の属性。`gender` は候補を絞る軸、`style` は名前から読み取れない声色の手掛かり */
export type SpeechVoiceTag = { gender: "female" | "male"; style: string };

/** ボイス欄の選択肢。`value` は上流へ送る名前、`label` は表示だけの加工 */
export type SpeechVoiceOption = { value: string; label: string };

/** 表示用のグループ。`label: null` は性別を引けない声（並べ替えの根拠が無いもの）を出す */
export type SpeechVoiceGroup = { label: "女性" | "男性" | null; options: SpeechVoiceOption[] };

/**
 * 属性の写し。キーは上流（OpenRouter の `supported_voices`）が宣言する綴りに限る。
 * 日本語ページのカタカナ表記は使わない（上流に存在しない名前になって送信時に 400 になる）。
 */
const SPEECH_VOICE_TAGS: Record<string, SpeechVoiceTag> = {
  Zephyr: { gender: "female", style: "Bright" },
  Puck: { gender: "male", style: "Upbeat" },
  Charon: { gender: "male", style: "Informative" },
  Kore: { gender: "female", style: "Firm" },
  Fenrir: { gender: "male", style: "Excitable" },
  Leda: { gender: "female", style: "Youthful" },
  Orus: { gender: "male", style: "Firm" },
  Aoede: { gender: "female", style: "Breezy" },
  Callirrhoe: { gender: "female", style: "Easy-going" },
  Autonoe: { gender: "female", style: "Bright" },
  Enceladus: { gender: "male", style: "Breathy" },
  Iapetus: { gender: "male", style: "Clear" },
  Umbriel: { gender: "male", style: "Easy-going" },
  Algieba: { gender: "male", style: "Smooth" },
  Despina: { gender: "female", style: "Smooth" },
  Erinome: { gender: "female", style: "Clear" },
  Algenib: { gender: "male", style: "Gravelly" },
  Rasalgethi: { gender: "male", style: "Informative" },
  Laomedeia: { gender: "female", style: "Upbeat" },
  Achernar: { gender: "female", style: "Soft" },
  Alnilam: { gender: "male", style: "Firm" },
  Schedar: { gender: "male", style: "Even" },
  Gacrux: { gender: "female", style: "Mature" },
  Pulcherrima: { gender: "female", style: "Forward" },
  Achird: { gender: "male", style: "Friendly" },
  Zubenelgenubi: { gender: "male", style: "Casual" },
  Vindemiatrix: { gender: "female", style: "Gentle" },
  Sadachbia: { gender: "male", style: "Lively" },
  Sadaltager: { gender: "male", style: "Knowledgeable" },
  Sulafat: { gender: "female", style: "Warm" },
};

/**
 * 属性を引くモデルの条件。他のプロバイダが同名のボイスを宣言しても誤った属性を付けないため、
 * 表を引く判定はこの module の 1 箇所に閉じる（呼び出し側へ条件を散らさない）。
 */
const GOOGLE_MODEL_ID_PREFIX = "google/";

/** ボイスの属性。表に無い名前は undefined（live で顔ぶれが増えてもラベル無しで出せる） */
export function speechVoiceTag(name: string): SpeechVoiceTag | undefined {
  return SPEECH_VOICE_TAGS[name];
}

/**
 * ボイス欄の表示用グループ。`google/` のモデルで属性を引ける声があるときだけ
 * 女性 → 男性 →（属性を引けない声）の順に分け、引けない声は上流の宣言順のまま 1 グループで返す。
 * 並べ替える根拠が無い一覧（他プロバイダ / 未知だけ）の選択肢は消さない。
 */
export function speechVoiceGroups(modelId: string, voices: readonly string[] | undefined): SpeechVoiceGroup[] {
  if (voices === undefined || voices.length === 0) return [];
  if (!modelId.startsWith(GOOGLE_MODEL_ID_PREFIX)) return [ungrouped(voices)];

  const tagged: Record<SpeechVoiceTag["gender"], { name: string; style: string }[]> = { female: [], male: [] };
  const unknown: string[] = [];
  for (const voice of voices) {
    const tag = speechVoiceTag(voice);
    if (tag) tagged[tag.gender].push({ name: voice, style: tag.style });
    else unknown.push(voice);
  }
  if (tagged.female.length === 0 && tagged.male.length === 0) return [ungrouped(voices)];

  const groups: SpeechVoiceGroup[] = [];
  for (const gender of ["female", "male"] as const) {
    // 宣言に片方の性別しか無いときは、空のグループを返さない
    if (tagged[gender].length === 0) continue;
    groups.push({
      label: gender === "female" ? "女性" : "男性",
      options: [...tagged[gender]]
        .sort((a, b) => compareVoiceNames(a.name, b.name))
        .map(({ name, style }) => ({ value: name, label: `${name}（${style}）` })),
    });
  }
  if (unknown.length > 0) groups.push(ungrouped([...unknown].sort(compareVoiceNames)));
  return groups;
}

/** 属性を引けない声のグループ。入力順のまま、ラベルは名前だけにする */
function ungrouped(voices: readonly string[]): SpeechVoiceGroup {
  return { label: null, options: voices.map((voice) => ({ value: voice, label: voice })) };
}

/** 名前の昇順。`localeCompare` はロケール依存を持ち込むため使わず、ASCII の単純比較にする */
function compareVoiceNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
