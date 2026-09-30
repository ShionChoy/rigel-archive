// Pages with several forms that are saved one at a time (the 作品 page: 曲目条目, 基本信息, 译名与介绍):
// a form marked data-unsaved="<its name>" remembers that it was changed. Saving another form, or leaving
// the page, asks first — the changes in the others would be lost.
import { t } from './i18n';

export function guardForms() {
  const forms = [...document.querySelectorAll<HTMLFormElement>('form[data-unsaved]')];
  const dirty = new Set<HTMLFormElement>();
  let leaving = false;
  for (const form of forms) {
    const mark = () => dirty.add(form);
    form.addEventListener('input', mark);
    form.addEventListener('change', mark);
    form.addEventListener('submit', (e) => {
      const others = forms.filter((f) => f !== form && dirty.has(f));
      if (others.length && !confirm(t('「{names}」有未保存的改动：只保存这一栏的话，那些改动会丢失。继续吗？', { names: others.map((f) => f.dataset.unsaved).join('、') }))) {
        e.preventDefault();
        return;
      }
      leaving = true;
    });
  }
  addEventListener('beforeunload', (e) => {
    if (!leaving && dirty.size) e.preventDefault();
  });
}
