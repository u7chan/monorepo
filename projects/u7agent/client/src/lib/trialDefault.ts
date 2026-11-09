/**
 * 試行の結果から、その試行のモデル（音声はボイスも）を既定として保存する導線。表示条件と PUT の本文を
 * `client/src/lib/contentSettings.ts` の純関数に寄せ、保存の進行と失敗の注記は UI から切り離して持つ。
 */
import {
  imageDefaultBody,
  imageDefaultModelId,
  imageModelOptions,
  imageModelSelection,
  imageModelValue,
  speechModelOptions,
  speechModelValue,
  speechSelection,
} from "./contentSettings";
import { imageModelParameterDeclarations, imageParameterDraftOf, imageParameterFields } from "./imageParameters";
import type {
  ContentSettingsResponse,
  ImageParameterValues,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../types";

/**
 * 画像の試行のモデルとパラメータを既定にする対象。試行と同じ（モデルもパラメータも保存値と同じ）ときと、
 * カタログから本文を作れない（選択肢に無い・宣言の外の値）ときは null にして導線を出さない
 * （押しても保存できないボタンを作らない）。
 */
export function imageTrialDefaultTarget(input: {
  settings: Pick<ContentSettingsResponse, "provider" | "image">;
  /** 試行に使ったモデル（`provider/id` 表記） */
  trialModel: string;
  /** 試行で明示したパラメータ。null は未指定（provider の既定で生成した） */
  trialParameters: ImageParameterValues | null;
}): UpdateContentImageBody | null {
  if (input.trialModel === "") return null;
  const options = imageModelOptions(input.settings);
  const selection = imageModelSelection(options, input.trialModel);
  if (selection === null) return null;
  const modelId = imageDefaultModelId(options, input.trialModel);
  const saved = modelId === null ? {} : (input.settings.image.parametersByModel[modelId] ?? {});
  const fields = imageParameterFields(imageModelParameterDeclarations(input.settings.image.models, input.trialModel));
  // 宣言が変わって送れない値になった試行は、そのまま送ると 400 になるため導線を出さない
  const body = imageDefaultBody(fields, imageParameterDraftOf(input.trialParameters), saved);
  if (!body.ok) return null;
  if (input.trialModel === imageModelValue(input.settings) && body.unchanged) return null;
  // 値ありはそのモデルの既定を丸ごと置き換える。試行が未指定で走っていたなら `{}` で「既定なし」に揃える
  return { ...selection, parameters: body.parameters };
}

/**
 * 音声の試行のモデルとボイスを既定にする対象。どちらも保存値と同じときは null。
 * ボイス未指定（試行の `voice` が null）は保存値の空文字と同じ「指定なし」として比べる。
 */
export function speechTrialDefaultTarget(input: {
  settings: Pick<ContentSettingsResponse, "provider" | "speech">;
  trialModel: string;
  trialVoice: string | null;
}): UpdateContentSpeechBody | null {
  if (input.trialModel === "") return null;
  const voice = input.trialVoice ?? "";
  if (input.trialModel === speechModelValue(input.settings) && voice === input.settings.speech.voice) return null;
  return speechSelection(speechModelOptions(input.settings), input.trialModel, voice);
}

export interface TrialDefaultState {
  saving: boolean;
  /** 保存できなかった。成功と同じ見た目にしないための印 */
  failed: boolean;
}

export const INITIAL_TRIAL_DEFAULT_STATE: TrialDefaultState = { saving: false, failed: false };

/**
 * 「このモデルと設定を既定にする」の押下。保存できたら `failed` を立てず、呼び出し側は下書きを捨てて
 * 画面を保存値へ追随させる。失敗（例外を含む）は印だけを立て、文言は呼び出し側が写す。
 */
export function createTrialDefaultAction(deps: { onChange: (state: TrialDefaultState) => void }) {
  let state = INITIAL_TRIAL_DEFAULT_STATE;
  // 破棄フラグは持たず世代だけを進める。StrictMode の effect 再実行 (mount → cleanup → mount) でも
  // その後の押下は普通に動き、unmount 後に届いた結果だけを捨てられる
  let generation = 0;
  let inFlight = false;

  const update = (patch: Partial<TrialDefaultState>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };

  const run = async <Target>(target: Target, save: (input: Target) => Promise<boolean>): Promise<boolean> => {
    if (inFlight) return false;
    inFlight = true;
    const token = ++generation;
    update({ saving: true, failed: false });
    try {
      const saved = await save(target);
      // 待機中に破棄された / 別の押下が始まったら、古い結果は表示しない
      if (token !== generation) return false;
      update({ saving: false, failed: !saved });
      return saved;
    } catch {
      if (token !== generation) return false;
      update({ saving: false, failed: true });
      return false;
    } finally {
      // 破棄済みのときは invalidate が既に解除しているので、新しい押下の状態を壊さない
      if (token === generation) inFlight = false;
    }
  };

  return {
    run,
    /**
     * 押下の待機を捨てる（所有部品の unmount）。以後に届いた保存結果は適用しない。
     * 世代を進めるだけなので、続く押下は普通に動く
     */
    invalidate: () => {
      generation += 1;
      inFlight = false;
    },
  };
}

export type TrialDefaultAction = ReturnType<typeof createTrialDefaultAction>;
