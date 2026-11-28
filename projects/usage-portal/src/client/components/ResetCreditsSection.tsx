import type { ResetCreditsView } from "../lib/format";

/** リセット枠は使用率の推移ではないため、メーターの列に混ぜず区切ったセクションにする。 */
export function ResetCreditsSection(props: { view: ResetCreditsView }) {
  const view = props.view;

  return (
    <section class="up-reset">
      <div class="up-reset-head">
        <span class="up-reset-title">リセット枠</span>
        {view.count === null ? null : <span class="up-reset-count">{view.count} 回</span>}
      </div>
      {view.rows.length === 0 ? null : (
        <ul class="up-reset-list" role="list">
          {view.rows.map((row, index) => (
            <li class="up-reset-row" key={`${row.date}:${index}`} data-expired={row.expired ? "true" : undefined}>
              <span class="up-reset-remaining">{row.remaining}</span>
              <span class="up-reset-date">{row.date}</span>
            </li>
          ))}
        </ul>
      )}
      {view.notes.map((note) => (
        <p class="up-reset-meta" key={note}>
          {note}
        </p>
      ))}
      {view.captured === null ? null : <p class="up-reset-meta">{view.captured}</p>}
    </section>
  );
}
