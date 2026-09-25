// Everything a file preview needs once it is on the page (the file page, the 整理台's side panel).
import { initTextPreviews } from './text-preview';
import { initWaveforms } from './waveform';

export function initPreviews(root: ParentNode) {
  initTextPreviews(root);
  initWaveforms(root);
}
